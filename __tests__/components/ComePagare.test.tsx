import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Solo `logClient` è finto: `nomeErrore` resta quello vero, perché è LUI la cosa
// misurata — un mock che restituisse il nome giusto proverebbe solo sé stesso.
vi.mock('@/lib/logging/client', async (importActual) => {
    const actual = await importActual<typeof import('@/lib/logging/client')>();
    return { ...actual, logClient: vi.fn() };
});

import { logClient } from '@/lib/logging/client';
import { ComePagare, type SedeBonifico } from '@/components/features/parent/pagamenti/ComePagare';
import type { VoceCausale } from '@/components/features/parent/pagamenti/CausaleBonifico';

/**
 * «Come pagare» — la card del genitore in /parent/pagamenti (E4).
 *
 * Il difetto che chiude, misurato nello spec del 2026-09-05: la pagina mostrava la
 * causale del bonifico e NON diceva né dove mandare i soldi (IBAN) né a chi è
 * intestato il conto, né che si può pagare anche in contanti. L'IBAN esisteva già
 * in Impostazioni → Fiscale e usciva solo nelle email di sollecito.
 *
 * ⚠️ DATI SINTETICI, repo pubblico. L'IBAN è l'esempio PUBBLICO della Banca
 * d'Italia (IT60X0542811101000000123456) nella forma leggibile a gruppi di quattro
 * che il server già produce; il secondo è lo stesso con due cifre cambiate (non è
 * un conto di nessuno). Nomi, cognomi e intestatario sono inventati.
 */

const IBAN_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456';
const IBAN_COMPATTO = 'IT60X0542811101000000123456';
/** Coordinate DIVERSE: due cifre cambiate sull'esempio pubblico. Nessun conto reale. */
const IBAN_ALTRO = 'IT60 X054 2811 1010 0000 0987 654';

const INTESTATARIO = 'Cooperativa Esempio soc. coop.';

const SEDE_UNO: SedeBonifico = {
    id: 'sede-1',
    nome: 'Plesso Uno',
    iban: IBAN_LEGGIBILE,
    intestatario: INTESTATARIO,
};
const SEDE_DUE: SedeBonifico = {
    id: 'sede-2',
    nome: 'Plesso Due',
    iban: IBAN_LEGGIBILE,
    intestatario: INTESTATARIO,
};

const VOCE_UNO: VoceCausale = {
    id: 'p1',
    scuola_id: 'sede-1',
    causale: 'Retta Settembre 2026 - per il minore Mara Bianchi - PLESSO UNO',
    descrizione: 'Retta Settembre 2026',
    importo: 250,
    nome: 'Mara',
    cognome: 'Bianchi',
    hasCf: true,
};
const VOCE_DUE: VoceCausale = {
    id: 'p2',
    scuola_id: 'sede-2',
    causale: 'Retta Settembre 2026 - per il minore Ugo Verdi - PLESSO DUE',
    descrizione: 'Retta Settembre 2026 (Ugo)',
    importo: 90.5,
    nome: 'Ugo',
    cognome: 'Verdi',
    hasCf: true,
};

/**
 * Il campo di una causale, cercato PER CONTENUTO — vedi `CausaleBonifico.test.tsx`.
 * A schermo la causale è spezzata in gruppi non spezzabili (`whitespace-nowrap`), e
 * `getByText` guarda solo i figli-testo diretti: il `textContent` è insieme il modo
 * di trovarla e la proprietà da misurare (si legge ciò che si copia).
 */
function campoCausale(causale: string): HTMLElement {
    const campi = [...document.querySelectorAll<HTMLElement>('.kv-campo-copiabile')];
    const trovato = campi.find((c) => c.textContent === causale);
    if (!trovato) {
        throw new Error(`nessun campo con la causale «${causale}» fra i ${campi.length} presenti`);
    }
    return trovato;
}

const scrivi = vi.fn(() => Promise.resolve());

beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: scrivi },
        configurable: true,
    });
});

describe('ComePagare — bonifico o contanti, con intestatario e IBAN', () => {
    it('rende i due metodi come tab, con «Bonifico» attivo di default', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        expect(screen.getByText('Come pagare')).toBeInTheDocument();
        // La lista dei metodi ha un nome proprio: «tablist» senza nome è un gruppo
        // anonimo per chi naviga a voce.
        expect(screen.getByRole('tablist', { name: 'Metodo di pagamento' })).toBeInTheDocument();

        const bonifico = screen.getByRole('tab', { name: 'Bonifico' });
        const contanti = screen.getByRole('tab', { name: 'Contanti' });
        expect(screen.getAllByRole('tab')).toHaveLength(2);

        // Selezione E fuoco tabulabile stanno insieme (tabIndex roving).
        expect(bonifico).toHaveAttribute('aria-selected', 'true');
        expect(bonifico).toHaveAttribute('tabindex', '0');
        expect(contanti).toHaveAttribute('aria-selected', 'false');
        expect(contanti).toHaveAttribute('tabindex', '-1');

        // Un solo pannello nell'albero accessibile: quello del tab attivo.
        const pannelli = screen.getAllByRole('tabpanel');
        expect(pannelli).toHaveLength(1);
        expect(pannelli[0]).toHaveAttribute('aria-labelledby', bonifico.id);
        expect(pannelli[0]).toHaveTextContent(IBAN_LEGGIBILE);
    });

    it('le frecce e Home/End spostano fuoco e selezione', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const bonifico = screen.getByRole('tab', { name: 'Bonifico' });
        const contanti = screen.getByRole('tab', { name: 'Contanti' });

        bonifico.focus();
        fireEvent.keyDown(bonifico, { key: 'ArrowRight' });
        expect(contanti).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(contanti);
        // Il pannello dei contanti dice anche la regola fiscale: non è un dettaglio.
        expect(screen.getByText(/non sono detraibili/)).toBeInTheDocument();

        fireEvent.keyDown(contanti, { key: 'ArrowLeft' });
        expect(bonifico).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(bonifico);

        fireEvent.keyDown(bonifico, { key: 'End' });
        expect(contanti).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(contanti);

        fireEvent.keyDown(contanti, { key: 'Home' });
        expect(bonifico).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(bonifico);
    });

    it('«Copia l’IBAN» mette negli appunti l’IBAN e conferma «Copiato»', async () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        expect(screen.getByText('Intestato a')).toBeInTheDocument();
        expect(screen.getByText(INTESTATARIO)).toBeInTheDocument();

        const copia = screen.getByRole('button', { name: 'Copia l’IBAN' });
        fireEvent.click(copia);

        // Negli appunti va la forma ELETTRONICA (senza spazi): è quella che ogni
        // home banking accetta. A schermo resta quella a gruppi di quattro.
        expect(scrivi).toHaveBeenCalledWith(IBAN_COMPATTO);
        // DUE riscontri, ed è voluto: l'etichetta del bottone e la regione viva che lo
        // dice a chi non vede il bottone cambiare (vedi il caso dedicato più sotto).
        //
        // ⚠️ NON DICONO LA STESSA COSA, dal 2026-09-06 (rilievo 4 del collaudo): il
        // bottone si è già identificato da sé — è quello che la persona ha premuto —
        // mentre la regione parla da sola, e «Copiato» in una card con più comandi di
        // copia non dice QUALE ha risposto. L'asserzione contava due nodi con lo
        // stesso testo; ora nomina i due testi, che è la cosa che conta davvero.
        expect(await screen.findByRole('button', { name: 'Copiato: IBAN' })).toHaveTextContent('Copiato');
        expect(screen.getAllByRole('status').some((r) => r.textContent === 'Copiato: IBAN')).toBe(true);
        // La strada felice non scrive niente: un log a ogni copia riuscita
        // seppellirebbe le poche righe che raccontano il guasto.
        expect(logClient).not.toHaveBeenCalled();
    });

    // ─── QUANDO GLI APPUNTI DICONO DI NO (collaudo 2026-09-05, rilievo e) ────
    // `navigator.clipboard.writeText` fallisce per motivi diversi e distinguibili:
    // `NotAllowedError` (permesso negato o gesto utente non riconosciuto),
    // `SecurityError` (contesto non sicuro: http, iframe senza permesso), o
    // l'assenza dell'API dentro una WebView. Il `catch` senza binding buttava via
    // proprio la parola che distingue i tre casi — e sono tre correzioni diverse.
    it('appunti negati: la CAUSA finisce nel log, l’IBAN mai', () => {
        scrivi.mockRejectedValueOnce(
            Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' }),
        );
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN' }));

        return Promise.resolve().then(() => {
            expect(logClient).toHaveBeenCalledTimes(1);
            const riga = vi.mocked(logClient).mock.calls[0][0];
            expect(riga.livello).toBe('warn');
            expect(riga.messaggio).toContain('NotAllowedError');
            // Nessuna coordinata bancaria nel log, in nessuna delle due forme.
            const testo = JSON.stringify(riga);
            expect(testo).not.toContain(IBAN_COMPATTO);
            expect(testo).not.toContain(IBAN_LEGGIBILE);
        });
    });

    it('appunti assenti del tutto (WebView senza API): la riga esce lo stesso', () => {
        // `nomeErrore` ripiega su `errore` quando ciò che è stato lanciato non è un
        // `Error`: la riga resta, e resta distinguibile da quella con il nome vero.
        scrivi.mockRejectedValueOnce('undefined is not an object');
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN' }));

        return Promise.resolve().then(() => {
            expect(logClient).toHaveBeenCalledTimes(1);
            expect(vi.mocked(logClient).mock.calls[0][0].messaggio).toContain('errore');
        });
    });

    it('senza IBAN configurato: nota di ripiego e nessun bottone di copia', () => {
        render(<ComePagare sedi={[{ ...SEDE_UNO, iban: null }]} voci={[VOCE_UNO]} />);

        expect(
            screen.getByText('Le coordinate bancarie non sono ancora disponibili: chiedile in segreteria.'),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Copia l’IBAN' })).toBeNull();
        // La card NON sparisce: le causali restano, ed è il senso del ripiego.
        expect(campoCausale(VOCE_UNO.causale)).toBeInTheDocument();
    });

    it('senza intestatario configurato: lo dice invece di lasciare il vuoto', () => {
        render(<ComePagare sedi={[{ ...SEDE_UNO, intestatario: null }]} voci={[VOCE_UNO]} />);
        expect(screen.getByText('Intestatario non disponibile')).toBeInTheDocument();
    });

    it('due sedi con LE STESSE coordinate: un blocco solo, che le nomina entrambe', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);

        // Un solo IBAN a schermo, un solo «Intestato a», un solo bottone di copia.
        expect(screen.getAllByText(IBAN_LEGGIBILE)).toHaveLength(1);
        expect(screen.getAllByText('Intestato a')).toHaveLength(1);
        // Un comando solo — ed è il nome accessibile a dire per quali plessi vale
        // (rilievo 4, 2026-09-06): il testo visibile resta «Copia l'IBAN», il nome lo
        // contiene e aggiunge i plessi, così due comandi non possono più confondersi.
        expect(screen.getAllByRole('button', { name: /^Copia l’IBAN/ })).toHaveLength(1);
        expect(
            screen.getByRole('button', { name: 'Copia l’IBAN delle sedi Plesso Uno · Plesso Due' }),
        ).toHaveTextContent('Copia l’IBAN');
        // …ma il blocco dice per quali plessi vale, al plurale giusto.
        // Scopata al pannello VISIBILE: la stessa frase vive anche nel pannello dei
        // contanti, che è nel DOM ma nascosto — è lo stesso fatto detto una volta sola
        // in ciascuno dei due percorsi, mai due volte sullo schermo.
        expect(within(screen.getByRole('tabpanel')).getByText('Per le sedi Plesso Uno · Plesso Due')).toBeInTheDocument();
        // Le causali di entrambe le sedi restano, sotto lo stesso conto.
        expect(campoCausale(VOCE_UNO.causale)).toBeInTheDocument();
        expect(campoCausale(VOCE_DUE.causale)).toBeInTheDocument();
    });

    it('due sedi con coordinate DIVERSE: due blocchi, ciascuno col proprio conto', () => {
        render(
            <ComePagare
                sedi={[SEDE_UNO, { ...SEDE_DUE, iban: IBAN_ALTRO, intestatario: 'Altra Cooperativa soc. coop.' }]}
                voci={[VOCE_UNO, VOCE_DUE]}
            />,
        );

        expect(screen.getByText(IBAN_LEGGIBILE)).toBeInTheDocument();
        expect(screen.getByText(IBAN_ALTRO)).toBeInTheDocument();
        // Due comandi, e da qui in avanti con DUE nomi diversi: prima erano due
        // bottoni con lo stesso identico nome accessibile, cioè indistinguibili per
        // chi naviga a voce (rilievo 4, 2026-09-06).
        expect(screen.getAllByRole('button', { name: /^Copia l’IBAN/ })).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Copia l’IBAN della sede Plesso Uno' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Copia l’IBAN della sede Plesso Due' })).toBeInTheDocument();
        // Un blocco per plesso ⇒ singolare, nella stessa pagina in cui l'altro caso
        // di prova ha il plurale: il `count` non è decorativo.
        expect(screen.getByText('Per la sede Plesso Uno')).toBeInTheDocument();
        expect(screen.getByText('Per la sede Plesso Due')).toBeInTheDocument();
    });

    it('una sede sola: nessuna riga di plesso, sarebbe rumore', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        expect(screen.queryByText(/^Per l[ae] sed/)).toBeNull();
    });

    it('nessuna voce aperta: non rende niente', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('le voci di una sede che il server non ha descritto restano visibili col ripiego', () => {
        // Contratto degradato (DB della CI senza `fiscale_config`, o risposta vecchia
        // senza `sedi`): la causale è l'unica cosa che resta, e deve restare.
        const { container } = render(<ComePagare sedi={[]} voci={[VOCE_UNO]} />);
        expect(container.firstChild).not.toBeNull();
        expect(campoCausale(VOCE_UNO.causale)).toBeInTheDocument();
        expect(
            screen.getByText('Le coordinate bancarie non sono ancora disponibili: chiedile in segreteria.'),
        ).toBeInTheDocument();
    });

    it('token: il CTA è bianco su verde (AA), nessun testo `muted` né giallo', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        const copia = screen.getByRole('button', { name: 'Copia l’IBAN' });
        expect(copia.className).toContain('bg-kidville-green');
        expect(copia.className).toContain('text-kidville-white');
        expect(copia.className).not.toContain('text-kidville-yellow');

        const html = container.innerHTML;
        expect(html).not.toContain('text-kidville-muted');
        expect(html).toContain('text-kidville-sub');
        // L'ancora dell'Alto Contrasto sta SUL CONTENITORE: le regole di
        // `globals.css` sono `[data-contrast="high"] .kv-come-pagare …` e senza
        // di lei la card resta bianca sul body nero (`@theme inline` inlina l'hex,
        // il rimappaggio dei token non tocca nessuna utility).
        expect(container.firstElementChild).toHaveClass('kv-come-pagare');
    });

    it('a11y: ogni comando della card arriva a 44px di lato', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const comandi = [...container.querySelectorAll('button')];
        // Tab (2) + «Copia l'IBAN» + una causale: nessuno sotto la soglia del dito.
        expect(comandi.length).toBeGreaterThanOrEqual(4);
        for (const c of comandi) expect(c.className).toContain('min-h-[44px]');
    });

    /* ────────────────────────────────────────────────────────────────────────
       Il secondo giro (2026-09-05): quello che le schermate hanno mostrato.
       ──────────────────────────────────────────────────────────────────────── */

    it('l’IBAN non si spezza dentro un gruppo di quattro', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const iban = screen.getByText(IBAN_LEGGIBILE);
        // Misurato sulla schermata a 390px: con `break-all` l'IBAN andava a capo
        // in mezzo a un gruppo («…1010 0000 / 0123 456» e, col bottone accanto più
        // largo, «…1010 00 / 00 0123 456») — cioè la riga cambiava PREMENDO
        // «Copia». Senza `break-all` il ritorno a capo cade solo sugli spazi, che
        // nell'IBAN stanno esattamente fra un gruppo di quattro e l'altro.
        expect(iban.className).not.toContain('break-all');
        expect(iban.className).toContain('font-mono');
    });

    it('il bottone dice CHE COSA copia e prende tutta la riga sotto l’IBAN', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const copia = screen.getByRole('button', { name: 'Copia l’IBAN' });
        // Il testo visibile È il nome accessibile: niente `aria-label` che dica una
        // cosa diversa da quella scritta (WCAG 2.5.3).
        expect(copia).toHaveTextContent('Copia l’IBAN');
        expect(copia).not.toHaveAttribute('aria-label');
        // A tutta larghezza, su una riga sua: così premerlo non rimpicciolisce lo
        // spazio dell'IBAN e non lo fa andare a capo in un punto diverso.
        expect(copia.className).toContain('w-full');
    });

    it('il bonifico è raccontato in due passi numerati', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        // L'introduzione del pannello annuncia i due passi invece di ripetere, cinque
        // righe più in basso, la stessa frase sulla causale.
        expect(screen.getByText(/servono due cose: il conto e la causale/i)).toBeInTheDocument();
        expect(screen.getByText('Il conto')).toBeInTheDocument();
        expect(screen.getByText('La causale')).toBeInTheDocument();
        expect(screen.getByText('1')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('la riga dei plessi sta DENTRO il riquadro del conto, non appesa sopra', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);
        const sedi = within(screen.getByRole('tabpanel')).getByText('Per le sedi Plesso Uno · Plesso Due');
        const iban = screen.getByText(IBAN_LEGGIBILE);
        const riquadro = iban.closest('.rounded-input');
        expect(riquadro).not.toBeNull();
        expect(riquadro?.contains(sedi)).toBe(true);
    });

    it('nessun movimento gratuito: la pressione è condizionata a `motion-safe`', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        for (const b of container.querySelectorAll('button')) {
            if (b.className.includes('scale-95')) {
                expect(b.className).toContain('motion-safe:active:scale-95');
            }
        }
    });

    /* ────────────────────────────────────────────────────────────────────────
       IL TERZO GIRO (2026-09-05) — quello che le MISURE hanno mostrato.

       Le schermate a 390px erano tutte sopra soglia di contrasto e senza un solo
       bersaglio piccolo, e proprio per questo il difetto più grave era invisibile
       ai numeri: la TAGLIA. Il corpo del testo stava a 11–12px, e la riga che
       dice PER QUALI SEDI vale il conto — il perno della famiglia con due plessi —
       era il testo più piccolo della card. Gerarchia rovesciata: l'informazione
       che discrimina era quella che si vedeva meno.
       ──────────────────────────────────────────────────────────────────────── */

    it('nessun testo della card scende sotto i 12px', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);
        // `text-[11px]` e `text-[10px]` sono l'unico modo, in questo repo, di
        // scendere sotto `text-xs`: le utility di serie si fermano a 12px. Il lock
        // guarda le CLASSI e non i px calcolati perché in jsdom il CSS non c'è —
        // ma è la stessa cosa: la classe È la misura.
        // `getAttribute('class')` e non `.className`: su un `<svg>` quest'ultimo è un
        // `SVGAnimatedString`, non una stringa — e l'assunto sbagliato faceva fallire
        // il lock prima ancora di guardare una classe.
        for (const el of container.querySelectorAll('*')) {
            expect(el.getAttribute('class') ?? '').not.toMatch(/text-\[1[01]px\]/);
        }
    });

    it('le introduzioni e i due campi da copiare stanno a 14px', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        expect(screen.getByText(/servono due cose: il conto e la causale/i).className).toContain('text-sm');
        // L'IBAN è la stringa che il genitore rilegge carattere per carattere: è la
        // ragione per cui la card esiste, e non può essere il testo più piccolo.
        expect(screen.getByText(IBAN_LEGGIBILE).className).toContain('text-sm');
        expect(campoCausale(VOCE_UNO.causale).className).toContain('text-sm');
    });

    it('l’IBAN ha la FORMA del campo da cui si copia, non è testo nudo', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const iban = screen.getByText(IBAN_LEGGIBILE);
        // Nella card ci sono due sole cose da copiare. Finché una sola aveva
        // l'aspetto di un campo — la causale — chi guardava per tre secondi non
        // riconosceva l'IBAN come «il rettangolo da prendere».
        expect(iban.className).toContain('kv-campo-copiabile');
        // BIANCO dentro la chip crema, ESATTAMENTE come il campo della causale: i due
        // testi da copiare non hanno più due pelli diverse perché stanno in due
        // contenitori diversi — adesso il contenitore è lo stesso.
        expect(iban.className).toContain('bg-kidville-white');
        expect(iban.className).toContain('font-mono');
        // Raggio INTERNO più stretto dell'esterno (`rounded-input`, 12px): un campo
        // incassato, non un adesivo appoggiato.
        expect(iban.className).toContain('rounded-[8px]');
        expect(iban.className).not.toContain('rounded-input');
    });

    it('la riga dei plessi è contenuto, non didascalia', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);
        // Il testo sta in uno `span` dentro la riga: colore e taglia li porta la riga.
        const riga = within(screen.getByRole('tabpanel')).getByText('Per le sedi Plesso Uno · Plesso Due').closest('p');
        // Compare SOLO quando i plessi sono più d'uno: quando compare, è la riga
        // che dice su quale conto va il bonifico. Inchiostro pieno, non `sub`.
        expect(riga?.className).toContain('text-kidville-ink');
        expect(riga?.className).toContain('text-xs');
        expect(riga?.className).not.toContain('text-kidville-sub');
    });

    it('i titoli dei passi non si travestono da comandi', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const titolo = screen.getByText('Il conto');
        // Erano `text-[13px] font-extrabold uppercase` come i tab e come i bottoni:
        // tre livelli tipograficamente IDENTICI, e a colpo d'occhio la card sembrava
        // avere sei pulsanti invece di quattro. Il maiuscolo resta a occhiello di
        // card, tab e bottoni: tre livelli, non cinque.
        expect(titolo.className).not.toContain('uppercase');
        expect(titolo.className).toContain('font-bold');
        expect(titolo.className).toContain('text-kidville-ink');
        // …e i comandi il maiuscolo lo tengono: è la loro voce.
        expect(screen.getByRole('tab', { name: 'Bonifico' }).className).toContain('uppercase');
        expect(screen.getByRole('button', { name: 'Copia l’IBAN' }).className).toContain('uppercase');
    });

    it('un solo CTA pieno nella card: quello dell’IBAN', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        // La classe si cerca INTERA e non come sottostringa: `hover:bg-kidville-green/10`
        // contiene le stesse lettere ma è un'altra utility, e dipinge solo il passaggio
        // del mouse.
        const pieno = (el: Element) => el.className.split(/\s+/).includes('bg-kidville-green');
        const pieni = [...container.querySelectorAll('button')].filter(pieno);
        // Il tab attivo (che è uno STATO, non un comando da premere di nuovo) e
        // «Copia l'IBAN». I tre «Copia» della causale sono secondari: quattro
        // macchie verdi identiche non hanno nessun punto focale.
        expect(pieni.map((b) => b.textContent?.trim())).toEqual(['Bonifico', 'Copia l’IBAN']);
        const copiaCausale = screen.getByRole('button', { name: /Copia la causale/ });
        expect(pieno(copiaCausale)).toBe(false);
        expect(copiaCausale.className).toContain('text-kidville-green');
        // Il contorno segue l'inchiostro (`border-current`): in Alto Contrasto
        // `.text-kidville-green` diventa giallo e il bordo ci va dietro da solo.
        expect(copiaCausale.className).toContain('border-current');
    });

    it('tutti i comandi della card dividono lo stesso margine', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        // Su desktop «Copia l'IBAN» era a bandiera SINISTRA e i «Copia» a bandiera
        // destra: quattro bottoni, due allineamenti. Sul telefono i «Copia»
        // galleggiavano su una riga occupata per un terzo.
        for (const b of container.querySelectorAll<HTMLElement>('button:not([role="tab"])')) {
            expect(b.className).toContain('w-full');
            expect(b.className).toContain('sm:w-auto');
            expect(b.parentElement?.className).toContain('sm:justify-end');
        }
    });

    it('la copia riuscita la annuncia anche una regione viva', async () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        // Le regioni esistono GIÀ da spente: montarle insieme al testo le fa perdere
        // ai lettori di schermo, che annunciano i cambi dentro una regione viva già
        // presente nell'albero. Il ritorno «Copiato» cambiava soltanto l'etichetta
        // del bottone: a 13px, su un telefono, per l'azione che è tutto lo scopo
        // della card.
        const regioni = screen.getAllByRole('status');
        expect(regioni.length).toBeGreaterThanOrEqual(1);
        for (const r of regioni) expect(r.textContent).toBe('');

        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN' }));
        // «Copiato: IBAN» e non «Copiato» (rilievo 4, 2026-09-06): la regione parla da
        // sola, e in una card con più comandi di copia deve dire quale ha risposto.
        expect(await screen.findByRole('button', { name: 'Copiato: IBAN' })).toBeInTheDocument();
        expect(screen.getAllByRole('status').some((r) => r.textContent === 'Copiato: IBAN')).toBe(true);
    });

    it('contanti: le due righe icona+testo condividono UNA colonna', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Contanti' }));
        const pannello = screen.getByRole('tabpanel');

        // Con due plessi il pannello dice ANCHE dove: «in segreteria» da solo, per
        // una famiglia con figli in due sedi, non è un'indicazione. È la STESSA frase
        // dell'altro pannello, non una seconda formulazione dello stesso fatto.
        expect(within(pannello).getByText('Per le sedi Plesso Uno · Plesso Due')).toBeInTheDocument();

        // Le icone stanno in una scatola di larghezza FISSA: due misure diverse con
        // lo stesso `gap` sfalsavano di 2px il margine sinistro del testo fra una
        // riga e l'altra (misurato: testo a x84 contro x80).
        const scatole = [...pannello.querySelectorAll<HTMLElement>('span.shrink-0')];
        expect(scatole.length).toBeGreaterThanOrEqual(3);
        for (const s of scatole) expect(s.className).toContain('w-4');
    });

    it('una sede sola: il pannello contanti non elenca nessun plesso', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Contanti' }));
        expect(within(screen.getByRole('tabpanel')).queryByText(/^Per l[ae] sed/)).toBeNull();
    });

    /* ────────────────────────────────────────────────────────────────────────
       IL QUARTO GIRO (2026-09-05) — quello che restava dopo le misure.
       ──────────────────────────────────────────────────────────────────────── */

    it('l’introduzione parla di bonifico DENTRO il pannello del bonifico, e solo lì', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        // Sopra i tab non c'è più nessuna didascalia: fra l'occhiello e la barra dei
        // metodi si passa diretti. «Scegli il metodo» lo dicevano già i due tab, che
        // si chiamano «Bonifico» e «Contanti».
        const tablist = screen.getByRole('tablist');
        const primaDeiTab = [...container.querySelectorAll('.kv-come-pagare > *')].slice(
            0,
            [...container.querySelectorAll('.kv-come-pagare > *')].indexOf(tablist),
        );
        expect(primaDeiTab.map((el) => el.textContent)).toEqual(['Come pagare']);

        // La frase sui due passi è la prima riga DEL PANNELLO del bonifico…
        const pannello = screen.getByRole('tabpanel');
        expect(within(pannello).getByText(/servono due cose: il conto e la causale/i)).toBeVisible();

        fireEvent.click(screen.getByRole('tab', { name: 'Contanti' }));
        // …e con lui si nasconde. Prima restava in testa alla card mentre sotto si
        // leggeva «In segreteria, negli orari di apertura»: metà dell'introduzione
        // descriveva un pannello in quel momento invisibile.
        expect(screen.getByText(/servono due cose: il conto e la causale/i)).not.toBeVisible();
    });

    /* ────────────────────────────────────────────────────────────────────────
       IL QUINTO GIRO (2026-09-05) — misurato SUI PIXEL della pagina intera.

       Il bordo superiore di ogni card della pagina passa di netto dal crema
       (254,241,228) al filetto (239,231,220): «Totale famiglia» a y=735, le quattro
       card dell'elenco a y=3567/3763/4039/4307. «Come pagare» invece sfumava su SEI
       pixel: era l'unica card sollevata della pagina, e il commento che giustificava
       l'ombra («la stessa delle altre card del genitore») era smentito dai pixel.
       Dentro, poi, il riquadro del conto era sollevato e i tre blocchi della causale
       no: due contenitori-passo fratelli con due elevazioni diverse.
       ──────────────────────────────────────────────────────────────────────── */

    it('la card non è sollevata: nessuna ombra, come tutte le altre della pagina', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        // Le card sorelle di `StoricoPagamenti` sono `rounded-card border
        // border-kidville-line bg-white p-4`, senz'ombra: questa deve esserlo anche lei.
        expect(container.firstElementChild?.className).toContain('rounded-card');
        expect(container.firstElementChild?.className).toContain('border-kidville-line');
        // NIENTE ombra, da nessuna parte nella card: se il filetto #EFE7DC è troppo
        // debole si cambia il TOKEN per tutte le card della pagina, non si aggiunge
        // qui un'elevazione che il resto della pagina non ha.
        expect(container.innerHTML).not.toContain('shadow-');
    });

    it('i due passi sono contenitori GEMELLI: stessa scatola, stessa quota', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const conto = screen.getByText(IBAN_LEGGIBILE).closest('.rounded-input');
        const causale = campoCausale(VOCE_UNO.causale).closest('.rounded-input');
        expect(conto).not.toBeNull();
        expect(causale).not.toBeNull();
        // Stessa identica pelle: raggio, fondo, bordo e margini interni. Prima erano
        // un riquadro bianco bordato e sollevato accanto a tre chip crema piatte —
        // e il bordo da 1px del primo spostava di un pixel per lato la colonna dei
        // comandi (misurato: «COPIA L'IBAN» x[60..655], i tre «COPIA» x[58..657]).
        for (const scatola of [conto, causale]) {
            expect(scatola?.className).toContain('bg-kidville-cream');
            expect(scatola?.className).toContain('border-transparent');
            expect(scatola?.className).toContain('p-3');
            expect(scatola?.className).not.toContain('shadow');
        }
    });

    it('i numeri dei passi non si travestono da comandi in Alto Contrasto', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        const pastiglia = screen.getByText('1');
        // `[data-contrast="high"] .kv-come-pagare .bg-kidville-green` riempie di
        // GIALLO con inchiostro nero: è il segnale di «questo si preme». Con le due
        // pastiglie verdi, in Alto Contrasto il giallo lo portavano anche due dischi
        // che non si toccano. Crema con filetto: in HC diventano grigio scurissimo
        // col contorno bianco, cioè struttura — la stessa voce dei tab non attivi.
        expect(pastiglia.className.split(/\s+/)).not.toContain('bg-kidville-green');
        expect(pastiglia.className).toContain('bg-kidville-cream');
        expect(pastiglia.className).toContain('border-kidville-line');
        expect(pastiglia.className).toContain('text-kidville-ink');
    });

    it('in tutta la card il verde lo portano SOLO i comandi', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);
        // In Alto Contrasto `.text-kidville-green` e `.bg-kidville-green` diventano
        // #FFE500: ogni elemento che li porta accende il giallo. Se lo accendono anche
        // l'occhiello, le pastiglie, gli importi e due icone, il giallo smette di
        // voler dire «premibile» — è il difetto che questo repo ha corretto sul popup
        // della riconciliazione il giorno prima.
        const verdi = [...container.querySelectorAll<HTMLElement>('*')].filter((el) => {
            const classi = (el.getAttribute('class') ?? '').split(/\s+/);
            return classi.includes('text-kidville-green') || classi.includes('bg-kidville-green');
        });
        for (const el of verdi) {
            const premibile = el.tagName === 'BUTTON' || el.closest('button') !== null;
            // L'unica eccezione è l'occhiello della card, che è verde in TUTTE le card
            // della pagina: cambiarlo qui scollerebbe «Come pagare» dalle sorelle, e la
            // sua resa in Alto Contrasto si governa da `globals.css`, non da qui.
            const occhiello = el.textContent === 'Come pagare';
            expect(premibile || occhiello).toBe(true);
        }
    });

    it('contanti: le icone non accendono il giallo, sono decorazione', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_DUE]} voci={[VOCE_UNO, VOCE_DUE]} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Contanti' }));
        const pannello = screen.getByRole('tabpanel');
        // Erano verdi qui e nere nel pannello del bonifico, per la stessa identica
        // riga («Per le sedi …»): due pannelli della stessa card che dicevano lo
        // stesso fatto con due colori.
        for (const s of pannello.querySelectorAll<HTMLElement>('span.shrink-0')) {
            expect(s.className).not.toContain('text-kidville-green');
        }
    });
});

/* ════════════════════════════════════════════════════════════════════════════
   IL SESTO GIRO (2026-09-06) — i cinque rilievi dei collaudi frontend e
   accessibilità. Sono minori uno per uno, ma tre riguardano chi non vede e uno
   contraddice una promessa scritta nello spec.
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * RILIEVO 1 — la card spariva TUTTA quando il server non produceva la causale.
 *
 * Lo spec del 2026-09-05 promette il contrario, e con parole sue: «Come pagare» è
 * una card sola, e NON SPARISCE MAI; con un residuo aperto la card c'è, e senza
 * IBAN «resta e dice di chiederlo in segreteria». La causale mancante non era
 * prevista da nessuna parte, e portava via con sé l'IBAN e l'intestatario — cioè
 * proprio le due cose per cui la card è nata.
 */
const VOCE_SENZA_CAUSALE: VoceCausale = { ...VOCE_UNO, causale: '' };

describe('ComePagare — senza causale la card RESTA (rilievo 1)', () => {
    it('il conto resta a schermo, e al posto della causale c’è una riga che dice cosa scrivere', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_SENZA_CAUSALE]} />);

        expect(container.firstChild).not.toBeNull();
        expect(screen.getByText('Come pagare')).toBeInTheDocument();
        expect(screen.getByText(IBAN_LEGGIBILE)).toBeInTheDocument();
        expect(screen.getByText(INTESTATARIO)).toBeInTheDocument();
        // Un vuoto non è un ripiego: la riga dice al genitore che cosa scrivere lui.
        expect(
            screen.getByText(
                'Causale non disponibile: nel bonifico indica il nome e il cognome del bambino e la voce da pagare.',
            ),
        ).toBeInTheDocument();
        // …e non resta un comando che copierebbe una stringa vuota.
        expect(screen.queryByRole('button', { name: /Copia la causale/ })).toBeNull();
    });

    it('con una causale su due, l’altra riga resta esattamente dov’era', () => {
        render(
            <ComePagare
                sedi={[SEDE_UNO]}
                voci={[VOCE_UNO, { ...VOCE_UNO, id: 'p3', descrizione: 'Mensa Settembre 2026', causale: '' }]}
            />,
        );

        expect(campoCausale(VOCE_UNO.causale)).toBeInTheDocument();
        expect(screen.getByText('Mensa Settembre 2026')).toBeInTheDocument();
        // Un solo «Copia»: quello della voce che una causale ce l'ha.
        expect(screen.getAllByRole('button', { name: /Copia la causale/ })).toHaveLength(1);
    });
});

/**
 * RILIEVO 2 — due riquadri «1 Il conto / 2 La causale» identici, e nessuna riga
 * che dica a quale plesso appartengano.
 *
 * Succede con UNA sede descritta e delle voci di una sede che il server non ha
 * descritto: i blocchi diventano due, ma i NOMI restano uno solo — e la condizione
 * di allora (`nomiSedi.length > 1`) guardava i nomi, non i blocchi.
 */
describe('ComePagare — ogni blocco dice di quale plesso parla (rilievo 2)', () => {
    const VOCE_ORFANA: VoceCausale = { ...VOCE_DUE, id: 'p9', scuola_id: 'sede-che-il-server-non-descrive' };

    it('una sede descritta e una no: due blocchi, e nessuno dei due è anonimo', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO, VOCE_ORFANA]} />);
        const pannello = screen.getByRole('tabpanel');

        expect(within(pannello).getAllByText('Il conto')).toHaveLength(2);
        expect(within(pannello).getByText('Per la sede Plesso Uno')).toBeInTheDocument();
        // Il plesso dell'altro blocco non si sa: lo si DICE, invece di tacere.
        expect(within(pannello).getByText('Sede non indicata')).toBeInTheDocument();
    });

    it('un blocco solo: il nome del plesso non compare, sarebbe rumore', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        expect(screen.queryByText(/^Per l[ae] sed/)).toBeNull();
        expect(screen.queryByText('Sede non indicata')).toBeNull();
    });

    it('nei contanti il plesso resta taciuto se il secondo blocco non ha un nome', () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO, VOCE_ORFANA]} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Contanti' }));
        // «Per la sede Plesso Uno» qui sarebbe una mezza verità: le voci dell'altro
        // blocco non sono di quel plesso, e quale sia non lo sa nessuno. La domanda
        // dei contanti è «in quale segreteria vado», e ha una risposta utile solo
        // quando i plessi NOMINATI sono più d'uno.
        expect(within(screen.getByRole('tabpanel')).queryByText(/^Per l[ae] sed/)).toBeNull();
    });
});

/**
 * RILIEVO 3 — l'IBAN a gruppi di quattro è illeggibile per chi ascolta: i lettori
 * di schermo pronunciano «2811» come «duemilaottocentoundici», e chi trascrive a
 * mano deve ricostruire le cifre. La resa a gruppi resta giusta per chi guarda.
 *
 * Il repo lo ha già risolto una volta, per i nomi dei file (`FieldRenderer`): la
 * stringa INTERA in un nodo `sr-only`, i pezzi impaginati in `aria-hidden`.
 *
 * ⚠️ QUI IL NODO `sr-only` STA FUORI DAL CAMPO DA COPIARE, e non è un dettaglio:
 * `sr-only` è `clip`-ato, non `display:none` (e2e/fixtures.ts lo documenta), quindi
 * dentro il campo finirebbe nella SELEZIONE — cioè negli appunti di chi il campo lo
 * seleziona col dito invece di premere il bottone. È lo stesso prezzo che questa
 * card ha già rifiutato di pagare sulla causale, quando ha buttato via la versione
 * coi caratteri sostituiti.
 */
describe('ComePagare — l’IBAN si può anche ASCOLTARE (rilievo 3)', () => {
    it('chi ascolta riceve la forma elettronica, chi guarda i gruppi di quattro', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        const perAscolto = [...container.querySelectorAll('.sr-only')].map((n) => n.textContent);
        expect(perAscolto).toContain(IBAN_COMPATTO);

        // I gruppi di quattro sono impaginazione: fuori dall'albero accessibile,
        // altrimenti l'IBAN si sente DUE volte, e la seconda coi numeri cardinali.
        const visibile = screen.getByText(IBAN_LEGGIBILE);
        expect(visibile).toHaveAttribute('aria-hidden', 'true');
    });

    it('nel campo da copiare non entra la copia per chi ascolta', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        // Il campo si cerca PER CLASSE e non col testo: se un giorno lo `sr-only`
        // finisse dentro, `getByText` pescherebbe lo `span` interno e il rosso
        // parlerebbe di una classe mancante invece che del difetto vero. Così il
        // messaggio mostra i due IBAN incollati uno all'altro, che è la cosa che il
        // genitore si ritroverebbe nell'home banking.
        const campo = container.querySelector<HTMLElement>('.kv-campo-copiabile.font-mono');
        expect(campo).not.toBeNull();
        // La prova che vale: chi seleziona il campo col dito — invece di premere il
        // bottone — incolla in banca l'IBAN e NIENT'ALTRO. Non l'IBAN due volte, in
        // due forme diverse, perché `sr-only` è `clip`-ato e non `display:none`.
        expect(campo?.textContent).toBe(IBAN_LEGGIBILE);
    });

    it('si sente ESATTAMENTE ciò che il bottone copia', () => {
        const { container } = render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);
        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN' }));

        // Una stringa sola, usata per tutti e due: se un giorno divergessero, chi
        // ascolta detterebbe al telefono un IBAN diverso da quello degli appunti.
        expect(scrivi).toHaveBeenCalledWith(IBAN_COMPATTO);
        expect([...container.querySelectorAll('.sr-only')].map((n) => n.textContent)).toContain(IBAN_COMPATTO);
    });
});

/**
 * RILIEVO 4 — con due conti c'erano due bottoni con lo STESSO nome accessibile
 * («Copia l'IBAN»), e la conferma diceva solo «Copiato». Il comando fratello,
 * nella stessa card, distingue già («Copiato: causale di Mara Bianchi»).
 */
describe('ComePagare — due conti, due comandi distinguibili (rilievo 4)', () => {
    const SEDE_ALTRO_CONTO: SedeBonifico = {
        ...SEDE_DUE,
        iban: IBAN_ALTRO,
        intestatario: 'Altra Cooperativa soc. coop.',
    };

    it('i due «Copia l’IBAN» dicono di quale conto sono', () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_ALTRO_CONTO]} voci={[VOCE_UNO, VOCE_DUE]} />);

        const uno = screen.getByRole('button', { name: 'Copia l’IBAN della sede Plesso Uno' });
        const due = screen.getByRole('button', { name: 'Copia l’IBAN della sede Plesso Due' });
        // Il nome accessibile CONTIENE il testo visibile (WCAG 2.5.3): chi comanda a
        // voce dice «copia l'IBAN» e il comando risponde.
        expect(uno).toHaveTextContent('Copia l’IBAN');
        expect(due).toHaveTextContent('Copia l’IBAN');
    });

    it('la conferma dice QUALE conto è finito negli appunti', async () => {
        render(<ComePagare sedi={[SEDE_UNO, SEDE_ALTRO_CONTO]} voci={[VOCE_UNO, VOCE_DUE]} />);

        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN della sede Plesso Due' }));

        expect(scrivi).toHaveBeenCalledWith(IBAN_ALTRO.replace(/\s+/g, ''));
        expect(await screen.findByRole('button', { name: 'Copiato: IBAN della sede Plesso Due' })).toBeInTheDocument();
        expect(screen.getAllByRole('status').some((r) => r.textContent === 'Copiato: IBAN della sede Plesso Due')).toBe(true);
    });

    it('con un conto solo il nome resta il testo visibile, e la conferma dice cosa', async () => {
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        const copia = screen.getByRole('button', { name: 'Copia l’IBAN' });
        // Nessun `aria-label` a riposo: il testo visibile È il nome (WCAG 2.5.3), e
        // con un conto solo il plesso sarebbe rumore.
        expect(copia).not.toHaveAttribute('aria-label');

        fireEvent.click(copia);
        // A copia avvenuta il nome dice ancora CHE COSA è stato copiato, come fa il
        // fratello della causale: «Copiato» da solo, in una card con due comandi,
        // non dice quale dei due ha risposto.
        expect(await screen.findByRole('button', { name: 'Copiato: IBAN' })).toBeInTheDocument();
    });
});

/**
 * RILIEVO 5 — se la copia fallisce non succedeva NIENTE di percepibile: il bottone
 * non cambiava etichetta e la regione viva restava vuota. Restava solo la riga nel
 * log, che il genitore non legge.
 *
 * Il fallimento è la regola dentro una WebView senza `navigator.clipboard`, cioè
 * nell'app nativa: il posto da cui questa card viene letta di più.
 */
describe('ComePagare — la copia che non riesce non resta muta (rilievo 5)', () => {
    it('l’esito negativo esce dalla regione viva e dice cosa fare', async () => {
        scrivi.mockRejectedValueOnce(
            Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' }),
        );
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN' }));

        const avviso = await screen.findByText('Copia non riuscita: seleziona l’IBAN qui sopra e copialo a mano.');
        const regione = avviso.closest('[role="status"]');
        expect(regione).not.toBeNull();
        // La stessa riga la LEGGE anche chi guarda: un bottone che non fa niente non
        // è un riscontro per nessuno. Una sola riga, due destinatari.
        expect(regione?.className).not.toContain('sr-only');
    });

    it('la causa del fallimento sta nel log, l’IBAN non ci entra in nessuna forma', async () => {
        scrivi.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'SecurityError' }));
        render(<ComePagare sedi={[SEDE_UNO]} voci={[VOCE_UNO]} />);

        fireEvent.click(screen.getByRole('button', { name: 'Copia l’IBAN' }));
        await screen.findByText('Copia non riuscita: seleziona l’IBAN qui sopra e copialo a mano.');

        const riga = JSON.stringify(vi.mocked(logClient).mock.calls[0][0]);
        expect(riga).toContain('SecurityError');
        expect(riga).not.toContain(IBAN_COMPATTO);
        expect(riga).not.toContain(IBAN_LEGGIBILE);
    });
});
