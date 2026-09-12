import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import itShared from '../../messages/it/shared.json';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * IL DIALOGO CHE ELIMINA UNA FOTO — e perché non è un `confirm()`.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── COM'ERA ────────────────────────────────────────────────────────────────
 * `MediaGrid` faceva `onDelete(id); handleCloseLightbox();` su due righe: la
 * seconda non aspetta la prima. Il visore si chiudeva PRIMA che il server
 * rispondesse, e se il server rifiutava (403 di sede, 500) l'errore arrivava su
 * una schermata che non mostrava più la foto di cui parlava. Non c'era nessuna
 * conferma: un tocco cancellava.
 *
 * ─── PERCHÉ NON `window.confirm` + `alert` ──────────────────────────────────
 * Sarebbero DUE dialoghi nativi bloccanti in fila nella WebView, e `MediaGrid`
 * stesso documenta che `alert()` blocca il thread e fa perdere i log spediti
 * dopo. E un `confirm` nativo non può dire le due cose che qui contano:
 * «sparisce SUBITO dalla galleria dei genitori» e «la segreteria la può
 * ripristinare entro 30 giorni».
 *
 * ─── LA RIGA DEI 30 GIORNI NON È COSMESI ────────────────────────────────────
 * L'insegnante NON ha una schermata di cestino. Senza quella frase crede di aver
 * distrutto la foto e non chiama nessuno: il cestino in `galleria_media_v2`
 * (colonne `eliminato_il`/`eliminato_da`/`file_rimosso_il`, migrazione
 * 20260911214752) esisterebbe e non servirebbe a nessuno. Per questo il primo
 * test di questo file guarda le PAROLE, non la forma.
 *
 * ─── ATTENZIONE AL `waitFor` SU UN'ASSENZA ──────────────────────────────────
 * Tre test qui dentro asseriscono che qualcosa NON c'è (il comando dopo un 403,
 * il comando quando `eliminabile` è falso, l'uuid a schermo). Un'attesa su
 * un'assenza passa PRIMA che i dati arrivino — è una trappola già pagata in
 * questo repo. Ognuna di quelle tre asserzioni è quindi ancorata a un evento
 * POSITIVO che deve essere già avvenuto: il riquadro d'errore reso, oppure la
 * colonna del visore montata.
 */

// ─── Il logger del browser: si spia, non si spedisce ────────────────────────
const logClientMock = vi.fn();
vi.mock('@/lib/logging/client', () => ({
    logClient: (...a: unknown[]) => logClientMock(...a),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}));

import { DialogoEliminaMedia, erroreElimina } from '@/components/features/gallery/DialogoEliminaMedia';
import { MediaGrid, type MediaItem } from '@/components/features/gallery/MediaGrid';

/** Una promise che si risolve/rigetta quando vuole il test. */
function differita<T>() {
    let risolvi!: (v: T) => void;
    let rigetta!: (e: unknown) => void;
    const promessa = new Promise<T>((res, rej) => {
        risolvi = res;
        rigetta = rej;
    });
    // Un rigetto mai gestito farebbe rumore su stderr: lo consuma il dialogo.
    return { promessa, risolvi, rigetta };
}

/**
 * L'uuid non è finto per caso: è il valore che NON deve comparire a schermo.
 * Non è un uuid vero di produzione — in questo repo non entrano dati reali.
 */
const UUID_MEDIA = '11111111-2222-3333-4444-555555555555';

const FOTO: MediaItem = {
    id: UUID_MEDIA,
    file_url: 'https://firmato.test/uploads/a.jpg',
    file_type: 'foto',
    // Didascalia di fantasia: qui non entrano nomi veri di bambini.
    caption: 'Laboratorio dei colori',
    tag_students: [],
    is_broadcast: false,
    created_at: new Date().toISOString(),
    uploader_name: 'Insegnante',
    uploaded_by: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
};

/** Apre il visore dalla miniatura (il click risale al comando che lo apre). */
function apriVisore(): void {
    fireEvent.click(screen.getByAltText('Laboratorio dei colori'));
}

/** Apre il dialogo dal visore. */
function apriDialogo(): void {
    apriVisore();
    fireEvent.click(screen.getByRole('button', { name: NOME_ELIMINA }));
}

const CONFERMA = itShared.galleryEliminaConferma;

/**
 * IL NOME ACCESSIBILE DEL COMANDO NEL VISORE, PER INTERO.
 *
 * Il bottone è `🗑️ {t('galleryEliminaMedia')}`: il suo nome accessibile si calcola
 * dal contenuto, emoji compresa. Si scrive intero e non come prefisso per la
 * lezione già pagata in `MediaGrid-impaginazione`: cancellando l'`aria-label`
 * dalle card, ventun test ancorati a un PREFISSO rimasero verdi.
 */
const NOME_ELIMINA = `🗑️ ${itShared.galleryEliminaMedia}`;

beforeEach(() => {
    logClientMock.mockClear();
});
afterEach(() => cleanup());

// ════════════════════════════════════════════════════════════════════════════
describe('DialogoEliminaMedia — che cosa dice', () => {
    function rendi(over: Partial<Parameters<typeof DialogoEliminaMedia>[0]> = {}) {
        const onElimina = vi.fn(() => Promise.resolve());
        const onEliminato = vi.fn();
        const onChiudi = vi.fn();
        render(
            <DialogoEliminaMedia
                tipoMedia="foto"
                didascalia="Laboratorio dei colori"
                onElimina={onElimina}
                onEliminato={onEliminato}
                onChiudi={onChiudi}
                {...over}
            />,
        );
        return { onElimina, onEliminato, onChiudi };
    }

    it('dice che sparisce SUBITO dalla galleria dei genitori', () => {
        rendi();
        const testo = screen.getByRole('dialog').textContent ?? '';
        expect(testo).toContain(itShared.galleryEliminaSubito);
        // …e la frase parla davvero di genitori e di «subito»: se il catalogo
        // cambiasse in «Eliminare?» il test sopra resterebbe verde.
        expect(itShared.galleryEliminaSubito.toLowerCase()).toMatch(/genitor/);
        expect(itShared.galleryEliminaSubito.toLowerCase()).toMatch(/subito/);
    });

    it('nomina i 30 GIORNI e il RIPRISTINO della segreteria', () => {
        rendi();
        const testo = screen.getByRole('dialog').textContent ?? '';
        expect(
            testo,
            'senza questa riga l’insegnante crede di aver distrutto la foto e non chiama nessuno: ' +
                'il cestino esisterebbe e non servirebbe',
        ).toContain(itShared.galleryEliminaRipristino);
        const frase = itShared.galleryEliminaRipristino.toLowerCase();
        expect(frase, 'la frase non nomina i 30 giorni').toMatch(/30 giorni/);
        expect(frase, 'la frase non nomina il ripristino').toMatch(/ripristin/);
        expect(frase, 'la frase non dice CHI può ripristinare').toMatch(/segreteria/);
    });

    it('mostra la didascalia (che l’utente vede già) e MAI l’uuid', () => {
        rendi();
        const dialogo = screen.getByRole('dialog');
        expect(dialogo.textContent).toContain('Laboratorio dei colori');
        expect(dialogo.textContent ?? '').not.toContain(UUID_MEDIA);
    });

    it('senza didascalia la riga della didascalia non c’è (non stampa «null»)', () => {
        rendi({ didascalia: null });
        // ⚠️ Ancora positiva prima dell'assenza: il dialogo è reso per davvero.
        expect(screen.getByRole('dialog').textContent).toContain(itShared.galleryEliminaTitoloFoto);
        expect(screen.queryByTestId('elimina-media-didascalia')).toBeNull();
        // …e il controllo positivo: con la didascalia, quella riga c'è.
        cleanup();
        rendi();
        expect(screen.getByTestId('elimina-media-didascalia').textContent).toContain('Laboratorio dei colori');
    });

    it('il titolo distingue una foto da un video', () => {
        const { unmount } = render(
            <DialogoEliminaMedia
                tipoMedia="video"
                didascalia={null}
                onElimina={() => Promise.resolve()}
                onEliminato={() => {}}
                onChiudi={() => {}}
            />,
        );
        expect(screen.getByRole('dialog').textContent).toContain(itShared.galleryEliminaTitoloVideo);
        unmount();
        rendi();
        expect(screen.getByRole('dialog').textContent).toContain(itShared.galleryEliminaTitoloFoto);
    });

    it('non si chiude cliccando sullo sfondo: una conferma non si annulla per distrazione', () => {
        const { onChiudi } = rendi();
        // Il velo è il fratello `aria-hidden` del dialogo (vedi `Modal`).
        const contenitore = screen.getByRole('dialog').parentElement!;
        fireEvent.mouseDown(contenitore);
        expect(onChiudi).not.toHaveBeenCalled();
    });

    it('«Annulla» non elimina niente', () => {
        const { onElimina, onChiudi } = rendi();
        fireEvent.click(screen.getByRole('button', { name: itShared.galleryAnnulla }));
        expect(onChiudi).toHaveBeenCalledTimes(1);
        expect(onElimina).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DialogoEliminaMedia — la richiesta in volo', () => {
    it('RESTA APERTO mentre la richiesta è in volo, e dice che sta lavorando', async () => {
        const { promessa, risolvi } = differita<void>();
        const onElimina = vi.fn(() => promessa);
        const onEliminato = vi.fn();
        render(
            <DialogoEliminaMedia
                tipoMedia="foto"
                didascalia={null}
                onElimina={onElimina}
                onEliminato={onEliminato}
                onChiudi={() => {}}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: CONFERMA }));

        // ⚠️ L'ANCORA È POSITIVA: si aspetta che comparga la scritta «sto
        // lavorando», e solo DOPO si afferma che il dialogo non è sparito. Con
        // l'ordine inverso l'asserzione passerebbe prima che React abbia reso
        // qualunque cosa.
        await screen.findByText(itShared.galleryEliminaInCorso);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(onEliminato, 'chiude prima che il server abbia risposto').not.toHaveBeenCalled();

        risolvi();
        await waitFor(() => expect(onEliminato).toHaveBeenCalledTimes(1));
    });

    it('due pressioni fanno UNA sola richiesta', async () => {
        const { promessa, risolvi } = differita<void>();
        const onElimina = vi.fn(() => promessa);
        render(
            <DialogoEliminaMedia
                tipoMedia="foto"
                didascalia={null}
                onElimina={onElimina}
                onEliminato={() => {}}
                onChiudi={() => {}}
            />,
        );
        const conferma = screen.getByRole('button', { name: CONFERMA });
        fireEvent.click(conferma);
        fireEvent.click(conferma);
        await screen.findByText(itShared.galleryEliminaInCorso);
        expect(onElimina).toHaveBeenCalledTimes(1);
        risolvi();
    });

    it('a esito positivo chiede il ricarico (e non chiama `onChiudi`, che è l’annullamento)', async () => {
        const onEliminato = vi.fn();
        const onChiudi = vi.fn();
        render(
            <DialogoEliminaMedia
                tipoMedia="foto"
                didascalia={null}
                onElimina={() => Promise.resolve()}
                onEliminato={onEliminato}
                onChiudi={onChiudi}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: CONFERMA }));
        await waitFor(() => expect(onEliminato).toHaveBeenCalledTimes(1));
        expect(onChiudi).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DialogoEliminaMedia — i tre esiti di rifiuto restano distinguibili', () => {
    function rendiConRigetto(errore: unknown) {
        const onEliminato = vi.fn();
        const onElimina = vi.fn(() => Promise.reject(errore));
        render(
            <DialogoEliminaMedia
                tipoMedia="foto"
                didascalia={null}
                onElimina={onElimina}
                onEliminato={onEliminato}
                onChiudi={() => {}}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: CONFERMA }));
        return { onElimina, onEliminato };
    }

    it('il messaggio del server si vede DENTRO il dialogo, che NON si chiude', async () => {
        const { onEliminato } = rendiConRigetto(erroreElimina('Sede non accessibile', 403));

        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toContain('Sede non accessibile');
        expect(
            screen.getByRole('dialog').contains(avviso),
            'l’errore è fuori dal dialogo: chiudendolo non ne resterebbe traccia a schermo',
        ).toBe(true);
        expect(onEliminato).not.toHaveBeenCalled();
    });

    it('403: il comando SPARISCE, perché ripremerlo darebbe lo stesso rifiuto', async () => {
        rendiConRigetto(erroreElimina('Sede non accessibile', 403));

        // Ancora positiva PRIMA dell'assenza: il riquadro d'errore è reso.
        await screen.findByRole('alert');
        expect(
            screen.queryByRole('button', { name: CONFERMA }),
            'il comando è ancora lì: un rifiuto di permessi si trasforma in un pulsante che sembra rotto',
        ).toBeNull();
        // …e resta il modo di uscire.
        expect(screen.getByRole('button', { name: itShared.chiudi })).toBeInTheDocument();
    });

    it('500: il comando RESTA, perché riprovare è il rimedio', async () => {
        const { onElimina } = rendiConRigetto(erroreElimina('Errore del server', 500));

        await screen.findByRole('alert');
        const ancora = screen.getByRole('button', { name: CONFERMA });
        fireEvent.click(ancora);
        await waitFor(() => expect(onElimina).toHaveBeenCalledTimes(2));
    });

    it('un rigetto senza stato (rete caduta) è trattato come ritentabile, non come divieto', async () => {
        rendiConRigetto(new Error('Connessione assente'));
        await screen.findByRole('alert');
        expect(screen.getByRole('button', { name: CONFERMA })).toBeInTheDocument();
    });

    it('un `TypeError` di `fetch` NON mostra il proprio messaggio inglese', async () => {
        // `fetch` che muore lancia `TypeError: Failed to fetch` — testo del motore,
        // non del catalogo. A schermo va la frase italiana, non quella.
        rendiConRigetto(new TypeError('Failed to fetch'));
        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toContain(itShared.galleryEliminaErroreGenerico);
        expect(avviso.textContent ?? '').not.toContain('Failed to fetch');
    });

    /**
     * ⚠️ IL NOME DICE ESATTAMENTE CIÒ CHE MISURA, e prima non era così: si chiamava
     * «si chiude e SI RICARICA» mentre l'unica asserzione è che `onEliminato` è
     * stata chiamata. `onEliminato` non ricarica niente — è `handleCloseLightbox`,
     * che chiude —, e su questo ramo l'elenco resta indietro per davvero (il
     * chiamante ha LANCIATO invece di ricaricare). Un nome che promette più di
     * quanto misura è la forma di difetto che questo repo ha già pagato.
     */
    it('404: l’esito voluto è raggiunto, quindi si chiude senza dipingere un errore', async () => {
        const { onEliminato } = rendiConRigetto(erroreElimina('Media non trovato', 404));

        await waitFor(() => expect(onEliminato).toHaveBeenCalledTimes(1));
        expect(
            screen.queryByRole('alert'),
            'un 404 mostrato come errore accusa l’utente di un esito che ha ottenuto',
        ).toBeNull();
    });

    it('404 si logga `warn`, un 500 si logga `error`, e lo stato viaggia nei CAMPI', async () => {
        rendiConRigetto(erroreElimina('Media non trovato', 404));
        await waitFor(() => expect(logClientMock).toHaveBeenCalled());
        const perIl404 = logClientMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
        expect(perIl404.some((e) => e.livello === 'warn')).toBe(true);
        expect(perIl404.every((e) => e.livello !== 'error'), 'un 404 non è un guasto').toBe(true);

        cleanup();
        logClientMock.mockClear();
        rendiConRigetto(erroreElimina('Errore del server', 500));
        await screen.findByRole('alert');
        const perIl500 = logClientMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
        const guasto = perIl500.find((e) => e.livello === 'error');
        expect(guasto, 'un 500 non lascia traccia in `app_log`').toBeDefined();
        // ⚠️ LO STATO STA NEI `campi`, NON IN `stato`: `livelloEvento` applica a
        // ogni `stato` fra 400 e 599 la politica di `livelloFetch`, che per un 403
        // e un 404 risponde «non spedire» — cioè scarterebbe in silenzio proprio
        // la riga che si sta aggiungendo.
        expect(guasto!.stato, 'lo stato in `stato` fa scartare la riga').toBeUndefined();
        expect((guasto!.campi as Record<string, unknown>).stato_http).toBe(500);
    });

    it('nessun log porta la didascalia: è il nome di un file, cioè un dato di un minore', async () => {
        const onElimina = vi.fn(() => Promise.reject(erroreElimina('Errore del server', 500)));
        render(
            <DialogoEliminaMedia
                tipoMedia="foto"
                didascalia="Laboratorio dei colori"
                onElimina={onElimina}
                onEliminato={() => {}}
                onChiudi={() => {}}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: CONFERMA }));
        await screen.findByRole('alert');
        const serializzato = JSON.stringify(logClientMock.mock.calls);
        expect(serializzato).not.toContain('Laboratorio');
        // …e nemmeno il messaggio del server, che può riecheggiare filtri e valori.
        expect(serializzato).not.toContain('Errore del server');
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MediaGrid — il comando del visore apre il dialogo', () => {
    it('premere «Elimina Media» NON elimina: chiede conferma', async () => {
        const onDelete = vi.fn(() => Promise.resolve());
        render(<MediaGrid items={[FOTO]} onDelete={onDelete} />);
        apriDialogo();

        expect(await screen.findByText(itShared.galleryEliminaTitoloFoto)).toBeInTheDocument();
        expect(onDelete, 'un tocco solo cancellava la foto di un minore').not.toHaveBeenCalled();
    });

    it('l’uuid del media non compare MAI a schermo, dialogo aperto compreso', async () => {
        render(<MediaGrid items={[FOTO]} onDelete={() => Promise.resolve()} />);
        apriDialogo();
        // Ancora positiva: il dialogo è reso. Solo dopo si guarda l'assenza.
        await screen.findByText(itShared.galleryEliminaTitoloFoto);
        expect(document.body.textContent ?? '').not.toContain(UUID_MEDIA);
    });

    it('confermando si passa l’id del media a `onDelete`', async () => {
        const onDelete = vi.fn(() => Promise.resolve());
        render(<MediaGrid items={[FOTO]} onDelete={onDelete} />);
        apriDialogo();
        fireEvent.click(await screen.findByRole('button', { name: CONFERMA }));
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(UUID_MEDIA));
    });

    it('a esito positivo chiude il dialogo E il visore', async () => {
        render(<MediaGrid items={[FOTO]} onDelete={() => Promise.resolve()} />);
        apriDialogo();
        fireEvent.click(await screen.findByRole('button', { name: CONFERMA }));

        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());
        expect(screen.queryByText(itShared.galleryEliminaTitoloFoto)).toBeNull();
    });

    it('IL DIFETTO VERO: un rigetto NON lascia il visore chiuso con l’errore invisibile', async () => {
        // Com'era: `onDelete(id); handleCloseLightbox();` — la seconda riga non
        // aspetta la prima, quindi il rifiuto arrivava su una schermata che non
        // mostrava più la foto di cui parlava.
        render(
            <MediaGrid
                items={[FOTO]}
                onDelete={() => Promise.reject(erroreElimina('Sede non accessibile', 403))}
            />,
        );
        apriDialogo();
        fireEvent.click(await screen.findByRole('button', { name: CONFERMA }));

        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toContain('Sede non accessibile');
        expect(
            screen.getByTestId('visore-colonna'),
            'il visore si è chiuso: l’errore parla di una foto che non si vede più',
        ).toBeInTheDocument();
    });

    it('le frecce non cambiano il media sotto un dialogo aperto', async () => {
        const SECONDA: MediaItem = { ...FOTO, id: 'm2', caption: 'Merenda in giardino' };
        render(<MediaGrid items={[FOTO, SECONDA]} onDelete={() => Promise.resolve()} />);
        apriDialogo();
        await screen.findByText(itShared.galleryEliminaTitoloFoto);

        fireEvent.keyDown(window, { key: 'ArrowRight' });
        // Il dialogo tiene la foto che si stava eliminando: se la freccia passasse,
        // dietro comparirebbe l'altra e si cancellerebbe quella che non si vede.
        expect(screen.getByTestId('visore-colonna').textContent).toContain('Laboratorio dei colori');
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('MediaGrid — chi può eliminare', () => {
    it('senza `onDelete` il comando non esiste (il genitore, mai)', () => {
        render(<MediaGrid items={[FOTO]} showActions />);
        apriVisore();
        expect(screen.queryByRole('button', { name: NOME_ELIMINA })).toBeNull();
    });

    it('con `eliminabile` falso il comando non c’è, pur essendoci `onDelete`', async () => {
        render(<MediaGrid items={[FOTO]} onDelete={() => Promise.resolve()} eliminabile={() => false} />);
        apriVisore();
        // Ancora positiva PRIMA dell'assenza: il visore è montato per davvero.
        await screen.findByTestId('visore-colonna');
        expect(
            screen.queryByRole('button', { name: NOME_ELIMINA }),
            'un’insegnante può cancellare il caricamento di una collega',
        ).toBeNull();
    });

    it('`eliminabile` riceve il media, non il suo id: decide su `uploaded_by`', async () => {
        const eliminabile = vi.fn((m: MediaItem) => m.uploaded_by === FOTO.uploaded_by);
        render(<MediaGrid items={[FOTO]} onDelete={() => Promise.resolve()} eliminabile={eliminabile} />);
        apriVisore();
        await screen.findByTestId('visore-colonna');
        expect(eliminabile).toHaveBeenCalledWith(FOTO);
        expect(screen.getByRole('button', { name: NOME_ELIMINA })).toBeInTheDocument();
    });

    it('con `eliminabile` vero il comando c’è (il predicato non è un interruttore spento)', async () => {
        render(<MediaGrid items={[FOTO]} onDelete={() => Promise.resolve()} eliminabile={() => true} />);
        apriVisore();
        await screen.findByTestId('visore-colonna');
        expect(screen.getByRole('button', { name: NOME_ELIMINA })).toBeInTheDocument();
    });
});

// ════════════════════════════════════════════════════════════════════════════
/**
 * IL CASO PEGGIORE: LEGGERE LA DIDASCALIA DI UNA FOTO E CANCELLARNE UN'ALTRA.
 *
 * Le frecce erano già chiuse (l'effetto della tastiera si ferma quando la
 * conferma è aperta). Restava la strada che passa dal VISORE: lo scroller porta
 * `onClick={handleCloseLightbox}` e vive SOTTO il dialogo, quindi in teoria è
 * coperto da `inert`. Solo che `inert` è di Safari 15.5 e
 * `IPHONEOS_DEPLOYMENT_TARGET` è 15.0: su iOS 15.0–15.4 `rendiInerteFuoriDa`
 * ripiega su `aria-hidden`, che NON blocca i click (sta scritto nel commento di
 * `src/lib/accessibility/inerti.ts`). jsdom è lo stesso ambiente: nessun `inert`.
 *
 * Da lì: visore chiuso (e `closeOnBackdrop={false}` scavalcato, perché quel
 * click non è sul velo del dialogo ma su un nodo del visore), `daEliminare`
 * ancora impostato, e alla riapertura di un ALTRO media la conferma ricompare
 * nominando il media di prima.
 *
 * La correzione non è una guardia in più: è azzerare il media catturato
 * nell'unico imbuto che smonta il visore, così il caso torna impossibile PER
 * COSTRUZIONE invece di dipendere dal supporto di `inert`.
 */
describe('MediaGrid — chiudere il visore porta via anche la conferma', () => {
    const SECONDA: MediaItem = { ...FOTO, id: 'm2', caption: 'Merenda in giardino' };

    it('velo del VISORE cliccato con la conferma aperta: riaprendo un ALTRO media la conferma NON c’è', async () => {
        const onDelete = vi.fn(() => Promise.resolve());
        render(<MediaGrid items={[FOTO, SECONDA]} onDelete={onDelete} />);
        apriDialogo();
        await screen.findByText(itShared.galleryEliminaTitoloFoto);

        // Lo scroller del visore: `inert` non è implementato in jsdom, come su
        // iOS 15.0–15.4, quindi il click arriva a `handleCloseLightbox`.
        fireEvent.click(screen.getByTestId('visore-scorrimento'));
        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());

        // Si riapre la SECONDA foto. ⚠️ Ancora positiva prima dell'assenza: il
        // visore è montato per davvero, altrimenti «la conferma non c'è» sarebbe
        // vero anche a schermo vuoto.
        fireEvent.click(screen.getByAltText('Merenda in giardino'));
        await screen.findByTestId('visore-colonna');

        expect(
            screen.queryByText(itShared.galleryEliminaTitoloFoto),
            'la conferma è ricomparsa da sola su un media che nessuno ha scelto di eliminare',
        ).toBeNull();
        expect(
            screen.queryByTestId('elimina-media-didascalia'),
            'si legge la didascalia di una foto e si cancella un’altra',
        ).toBeNull();
    });

    it('la ✕ del visore fa lo stesso: è lo stesso imbuto', async () => {
        render(<MediaGrid items={[FOTO, SECONDA]} onDelete={() => Promise.resolve()} />);
        apriDialogo();
        await screen.findByText(itShared.galleryEliminaTitoloFoto);

        // ⚠️ NON `getByRole`: col dialogo aperto `Modal` marca `aria-hidden` tutto
        // ciò che gli sta fuori (è il ripiego di `rendiInerteFuoriDa` dove `inert`
        // non c'è), quindi per i ruoli la ✕ non esiste già più. Resta cliccabile,
        // ed è precisamente il difetto: si trova per testo.
        fireEvent.click(screen.getByText('✕'));
        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());

        fireEvent.click(screen.getByAltText('Merenda in giardino'));
        await screen.findByTestId('visore-colonna');
        expect(screen.queryByText(itShared.galleryEliminaTitoloFoto)).toBeNull();
    });

    it('riaprendo LO STESSO media la conferma non è comunque già aperta', async () => {
        render(<MediaGrid items={[FOTO]} onDelete={() => Promise.resolve()} />);
        apriDialogo();
        await screen.findByText(itShared.galleryEliminaTitoloFoto);

        fireEvent.click(screen.getByTestId('visore-scorrimento'));
        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());

        apriVisore();
        // ⚠️ L'ancora positiva è il TESTID e non il ruolo: col dialogo (ancora)
        // aperto il visore è `aria-hidden`, quindi un'ancora per ruolo mancherebbe
        // il bersaglio per il motivo sbagliato. `visore-colonna` c'è comunque.
        await screen.findByTestId('visore-colonna');
        expect(screen.queryByText(itShared.galleryEliminaTitoloFoto)).toBeNull();
        // …e il comando è di nuovo raggiungibile: se restasse `aria-hidden`,
        // qualcosa lo starebbe ancora coprendo.
        expect(screen.getByRole('button', { name: NOME_ELIMINA })).toBeInTheDocument();
    });

    it('IL CASO PEGGIORE: la conferma riaperta cancella il media NUOVO, non quello di prima', async () => {
        const onDelete = vi.fn(() => Promise.resolve());
        render(<MediaGrid items={[FOTO, SECONDA]} onDelete={onDelete} />);
        apriDialogo();
        await screen.findByText(itShared.galleryEliminaTitoloFoto);

        fireEvent.click(screen.getByTestId('visore-scorrimento'));
        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());

        fireEvent.click(screen.getByAltText('Merenda in giardino'));
        fireEvent.click(await screen.findByRole('button', { name: NOME_ELIMINA }));
        fireEvent.click(await screen.findByRole('button', { name: CONFERMA }));

        await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
        expect(
            onDelete,
            'si è letta la didascalia di una foto e se n’è cancellata un’altra',
        ).toHaveBeenCalledWith(SECONDA.id);
    });
});

// ════════════════════════════════════════════════════════════════════════════
/**
 * L'ANNULLAMENTO MENTRE LA DELETE È IN VOLO — il silenzio che restava.
 *
 * `closeOnBackdrop={false}` ferma il click fuori, ma `Modal` chiude su `Escape`
 * SEMPRE (`onCloseRef.current()`, nessuna condizione) e il tasto Indietro di
 * Android passa dalla stessa `onClose`. Anche «Annulla» era senza guardia.
 * Conseguenza: premuto Escape durante la DELETE il dialogo si smonta; se poi la
 * richiesta rigetta con un 500, `setErrore` gira su un componente smontato —
 * no-op silenzioso in React — e il rifiuto non si vede da nessuna parte. La foto
 * resta e l'insegnante non sa perché: è esattamente il silenzio per cui questo
 * componente esiste.
 */
describe('DialogoEliminaMedia — non si annulla mentre la richiesta è in volo', () => {
    function rendiInVolo() {
        const { promessa, risolvi, rigetta } = differita<void>();
        const onChiudi = vi.fn();
        render(
            <DialogoEliminaMedia
                tipoMedia="foto"
                didascalia={null}
                onElimina={() => promessa}
                onEliminato={() => {}}
                onChiudi={onChiudi}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: CONFERMA }));
        return { onChiudi, risolvi, rigetta };
    }

    it('Escape in volo NON smonta la conferma, e il rifiuto si vede ancora', async () => {
        const { onChiudi, rigetta } = rendiInVolo();
        // ⚠️ Ancora positiva: la richiesta è davvero partita.
        await screen.findByText(itShared.galleryEliminaInCorso);

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(onChiudi, 'Escape ha chiuso la conferma con la DELETE in volo').not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // …e il 500 che arriva dopo trova ancora un posto in cui dirsi.
        rigetta(erroreElimina('Errore del server', 500));
        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toContain('Errore del server');
    });

    it('«Annulla» in volo non smonta la conferma (stessa guardia, stessa ragione)', async () => {
        const { onChiudi, rigetta } = rendiInVolo();
        await screen.findByText(itShared.galleryEliminaInCorso);

        fireEvent.click(screen.getByRole('button', { name: itShared.galleryAnnulla }));
        expect(onChiudi).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        rigetta(erroreElimina('Errore del server', 500));
        await screen.findByRole('alert');
    });

    it('a riposo Escape chiude: la guardia vale solo in volo, non spegne l’uscita', async () => {
        const onChiudi = vi.fn();
        render(
            <DialogoEliminaMedia
                tipoMedia="foto"
                didascalia={null}
                onElimina={() => Promise.resolve()}
                onEliminato={() => {}}
                onChiudi={onChiudi}
            />,
        );
        // Ancora positiva: il dialogo è reso e in ascolto.
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(onChiudi).toHaveBeenCalledTimes(1));
    });

    it('finita la richiesta l’annullamento torna possibile (la guardia non resta incastrata)', async () => {
        const { onChiudi, rigetta } = rendiInVolo();
        await screen.findByText(itShared.galleryEliminaInCorso);
        rigetta(erroreElimina('Errore del server', 500));
        await screen.findByRole('alert');

        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(onChiudi).toHaveBeenCalledTimes(1));
    });
});

// ════════════════════════════════════════════════════════════════════════════
/**
 * LE DUE STRADE CHE RESTAVANO: LA ✕ DEL VISORE E LO SCROLLER.
 *
 * Il blocco qui sopra chiude l'annullamento in volo per le TRE strade che passano
 * dal dialogo — `Escape`, il tasto Indietro di Android (entrambi via `onClose` di
 * `Modal`) e «Annulla». Ne restavano DUE, e sono nel visore: la ✕ e lo scroller
 * chiamano `handleCloseLightbox` DIRETTAMENTE, e `handleCloseLightbox` azzera
 * `daEliminare` — cioè smonta il dialogo. Con la DELETE in volo:
 *
 *   · il dialogo sparisce mentre la richiesta è ancora in aria;
 *   · il 403 (o il 500) che arriva dopo fa girare `setErrore` su un componente
 *     smontato: no-op silenzioso in React, senza nemmeno un avviso in console;
 *   · la foto RESTA nella galleria e chi ha premuto non vede niente.
 *
 * È lo stesso silenzio per cui `DialogoEliminaMedia` esiste invece di un
 * `confirm()`, entrato dalla porta di servizio. E sono precisamente le due strade
 * che su iOS 15.0–15.4 restano raggiungibili col dialogo aperto: `inert` è di
 * Safari 15.5, `IPHONEOS_DEPLOYMENT_TARGET` è 15.0, quindi `rendiInerteFuoriDa`
 * ripiega su `aria-hidden`, che NON blocca i click. La stessa finestra di
 * dispositivi con cui si giustifica l'azzeramento di `daEliminare`: non può
 * contare per una strada e non per la sua gemella. jsdom è nello stesso caso
 * (`supportaInert()` è `false`), quindi qui il click arriva per davvero.
 *
 * ⚠️ LA GUARDIA NON PUÒ VIVERE NEL DIALOGO: chi smonta è il PADRE, e un
 * componente non può impedire al padre di smontarlo. Perciò la notizia sale —
 * `onInVolo` — e `handleCloseLightbox` esce finché è vera. Gli ultimi due test di
 * questo blocco sono la rete sull'ORDINE: la bandiera deve cadere PRIMA di
 * `onEliminato`, altrimenti la guardia mangia la chiusura che serve.
 */
describe('MediaGrid — il visore non si chiude con la DELETE in volo', () => {
    const SECONDA: MediaItem = { ...FOTO, id: 'm2', caption: 'Merenda in giardino' };

    /** Apre il dialogo, preme «Elimina» e torna i comandi della promise. */
    async function confermaInVolo() {
        const { promessa, risolvi, rigetta } = differita<void>();
        const onDelete = vi.fn(() => promessa);
        render(<MediaGrid items={[FOTO, SECONDA]} onDelete={onDelete} />);
        apriDialogo();
        fireEvent.click(await screen.findByRole('button', { name: CONFERMA }));
        // ⚠️ ANCORA POSITIVA: la richiesta è DAVVERO in volo. Senza, ogni
        // asserzione qui sotto sarebbe vera anche a dialogo mai partito.
        await screen.findByText(itShared.galleryEliminaInCorso);
        return { onDelete, risolvi, rigetta };
    }

    it('la ✕ del visore in volo NON smonta la conferma, e il 403 che arriva dopo si VEDE', async () => {
        const { rigetta } = await confermaInVolo();

        // ⚠️ NON `getByRole`: col dialogo aperto la ✕ è dentro un ramo
        // `aria-hidden` (ripiego di `rendiInerteFuoriDa` dove `inert` non c'è),
        // quindi per i ruoli non esiste già più. Resta CLICCABILE, ed è il difetto.
        fireEvent.click(screen.getByText('✕'));

        expect(
            screen.queryByText(itShared.galleryEliminaTitoloFoto),
            'la ✕ ha smontato la conferma con la DELETE in volo: il rifiuto non avrà più dove dirsi',
        ).not.toBeNull();
        expect(screen.getByTestId('visore-colonna')).toBeInTheDocument();

        rigetta(erroreElimina('Sede non accessibile', 403));
        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toContain('Sede non accessibile');
        expect(
            screen.getByTestId('elimina-media-vietato'),
            'il 403 è arrivato su un componente smontato: no-op silenzioso, la foto resta e nessuno lo sa',
        ).toBeInTheDocument();
    });

    it('lo scroller del visore in volo NON smonta la conferma, e il 500 che arriva dopo si VEDE', async () => {
        const { rigetta } = await confermaInVolo();

        fireEvent.click(screen.getByTestId('visore-scorrimento'));

        expect(screen.queryByText(itShared.galleryEliminaTitoloFoto)).not.toBeNull();
        expect(screen.getByTestId('visore-colonna')).toBeInTheDocument();

        rigetta(erroreElimina('Errore del server', 500));
        const avviso = await screen.findByRole('alert');
        expect(avviso.textContent).toContain('Errore del server');
        // …e il comando resta, perché riprovare è il rimedio: il dialogo è vivo e
        // funzionante, non solo montato.
        expect(screen.getByRole('button', { name: CONFERMA })).toBeInTheDocument();
    });

    it('finita la richiesta la ✕ torna a chiudere tutto: la guardia non resta incastrata', async () => {
        const { rigetta } = await confermaInVolo();
        rigetta(erroreElimina('Errore del server', 500));
        await screen.findByRole('alert');

        fireEvent.click(screen.getByText('✕'));
        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());
        expect(screen.queryByText(itShared.galleryEliminaTitoloFoto)).toBeNull();
    });

    it('lo scroller, finita la richiesta, chiude anche lui (stessa guardia, stesso imbuto)', async () => {
        const { rigetta } = await confermaInVolo();
        rigetta(erroreElimina('Errore del server', 500));
        await screen.findByRole('alert');

        fireEvent.click(screen.getByTestId('visore-scorrimento'));
        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());
    });

    it('L’ORDINE: a esito positivo il visore si chiude, cioè la bandiera cade PRIMA di `onEliminato`', async () => {
        const { risolvi } = await confermaInVolo();
        risolvi();
        // `onEliminato` È `handleCloseLightbox`, che ora ha la guardia: se la
        // bandiera cadesse DOPO (o vivesse in uno `useState`, che nella chiusura
        // già creata resterebbe al valore vecchio), la guardia mangerebbe proprio
        // la chiusura richiesta dall'esito positivo — e il visore non si chiuderebbe
        // più mai.
        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());
        expect(screen.queryByText(itShared.galleryEliminaTitoloFoto)).toBeNull();
    });

    it('L’ORDINE, dal ramo del RIGETTO: un 404 chiude il visore lo stesso', async () => {
        const { rigetta } = await confermaInVolo();
        // Il 404 passa dal `catch` e chiama `onEliminato`: l'altra strada in cui la
        // bandiera deve essere già caduta.
        rigetta(erroreElimina('Media non trovato', 404));
        await waitFor(() => expect(screen.queryByTestId('visore-colonna')).toBeNull());
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
