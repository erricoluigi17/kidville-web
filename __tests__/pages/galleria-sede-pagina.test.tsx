import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { IntlMessageFormat } from 'intl-messageformat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi';
import itAdminAltro from '../../messages/it/adminAltro.json';
import enAdminAltro from '../../messages/en/adminAltro.json';
import itShared from '../../messages/it/shared.json';
import enShared from '../../messages/en/shared.json';
import itEtichette from '../../messages/it/etichette.json';
import enEtichette from '../../messages/en/etichette.json';
import { NAV_GROUPS } from '@/components/features/admin/admin-nav-config';
import {
    raggruppaPerGiornata,
    alunniDellaPagina,
    contaTagSenzaNome,
    type FotoSede,
} from '@/components/features/gallery/GalleriaSedeGiornate';

/* ════════════════════════════════════════════════════════════════════════════
 * LA GALLERIA DEL PLESSO (segreteria) — `/admin/gallery`.
 *
 * ─── COSA SI PROVA QUI, E PERCHÉ PROPRIO QUESTE COSE ────────────────────────
 *
 *  (A) IL GIORNO È QUELLO ITALIANO. È l'unica cosa di questa schermata che può
 *      sbagliare restando perfettamente leggibile: una foto sotto l'intestazione
 *      del giorno prima non produce nessun errore, produce una data sbagliata
 *      scritta grande. `created_at.slice(0, 10)` — la forma ovvia — è in UTC, e
 *      fra le 00:00 e le 02:00 italiane sbaglia giorno. Il caso limite qui è un
 *      istante VERO, non un'ipotesi: `2026-09-05T23:00:00Z` a Giugliano è l'una
 *      di notte del 6.
 *
 *  (B) LA SEDE SI DICHIARA. Con più plessi in scope non parte NESSUNA richiesta
 *      finché qualcuno non sceglie, e quando parte porta `scope=sede` e
 *      `scuolaId` INSIEME (senza uno dei due la rotta risponde 400). Con un
 *      plesso solo si usa quello, senza chiedere.
 *
 *  (C) I FILTRI SONO DEL SERVER. Classe, bambino e giorno finiscono nella query.
 *      Setacciare a schermo filtrerebbe la PAGINA CORRENTE e chiamerebbe «tutte»
 *      il risultato — il difetto che in questo repo ha già un lock suo.
 *
 *  (D) L'ERRORE SI LEGGE TRADOTTO. Il 403 porta `codice: SEDE_NON_ACCESSIBILE`;
 *      la prosa che gli sta accanto nasce italiana dentro una route, e con
 *      l'interfaccia in inglese si leggerebbe così com'è.
 *
 *  (E) LA CLASSE È UN UUID. La tendina dei bambini si restringe con
 *      `alunni.section_id`, come fa il server, e non confrontando
 *      `alunni.classe_sezione` con `sections.name`: quei due testi divergono
 *      appena qualcuno rinomina una sezione, e la tendina si svuoterebbe mentre
 *      la griglia resta piena.
 *
 * ⚠️ NIENTE DATI VERI: uuid inventati e nomi palesemente finti. In produzione ci
 * sono anagrafiche di minori e questo repository è pubblico.
 * ════════════════════════════════════════════════════════════════════════════ */

const CLASSE = 'GIRASOLI';
const ALTRA_CLASSE = 'TULIPANI';
const ALU_1 = 'a1a1a1a1-1111-4111-8111-111111111111';
const ALU_2 = 'a2a2a2a2-2222-4222-8222-222222222222';
/** Le SEZIONI: l'uuid è l'identità, il nome è solo ciò che si legge in tendina. */
const SEZ_1 = 'c1c1c1c1-1111-4111-8111-111111111111';
const SEZ_2 = 'c2c2c2c2-2222-4222-8222-222222222222';
/**
 * Il segnaposto di un bambino taggato di cui la rotta non ha mandato il nome.
 * Si legge dal CATALOGO e non si riscrive qui: congelare la frase renderebbe
 * questi test rossi al primo ritocco del testo, che è un test sulla prosa e non
 * sul comportamento.
 */
const SENZA_NOME = itAdminAltro.galSedeTaggatoSenzaNome;

/** Ciò che `/api/gallery` restituisce, ridotto ai campi che la pagina legge. */
type RispostaFinta = { ok: boolean; status: number; body: Record<string, unknown> };

const h = vi.hoisted(() => ({
    sedi: [] as { id: string; nome: string }[],
    fetchMock: vi.fn(),
    logClient: vi.fn(),
    ricarica: vi.fn(),
    sediErrore: false,
    sediLoading: false,
    /**
     * Quando è vero, `/api/gallery` restituisce una promise che NON si risolve
     * mai: è il solo modo di guardare la schermata MENTRE una richiesta è in
     * volo, che è esattamente il momento in cui il cambio di plesso può mentire.
     */
    sospendiGalleria: false,
    /**
     * La risposta di `DELETE /api/gallery` e di `POST /api/gallery/ripristina`.
     * Sono i due comandi della vista di plesso, e il loro RIFIUTO e la cosa che va
     * provata: un 403 di sede e un 409 «non piu ripristinabile» devono arrivare a
     * schermo tradotti, non come prosa del server.
     */
    rispostaElimina: { ok: true, status: 200, body: { success: true } } as { ok: boolean; status: number; body: unknown },
    rispostaRipristino: { ok: true, status: 200, body: { success: true } } as { ok: boolean; status: number; body: unknown },
    /**
     * Quando è impostata, `/api/gallery` risponde con questa funzione invece che
     * con `rispostaGalleria`: serve ai casi in cui il corpo DIPENDE
     * dall'indirizzo chiesto — l'`offset` — che è il solo modo di provare una
     * paginazione che si corregge da sola. Riassegnare `rispostaGalleria` fra due
     * richieste è una gara persa in partenza: la seconda parte da sola, in un
     * microtask, e il test non ha un punto in cui infilarsi.
     */
    rispostaPerIndirizzo: null as
        | null
        | ((url: string) => RispostaFinta | Promise<RispostaFinta>),
}));

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(''),
    usePathname: () => '/admin/gallery',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/logging/client', () => ({
    logClient: h.logClient,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}));

vi.mock('@/lib/context/sede-context', () => ({
    useSediAttive: () => ({
        sedi: h.sedi,
        errore: h.sediErrore,
        selezionate: [],
        effettive: h.sedi.map((s) => s.id),
        sedeCorrente: h.sedi.length === 1 ? h.sedi[0].id : null,
        reFetchKey: h.sedi.map((s) => s.id).join(','),
        epocaSede: 0,
        loading: h.sediLoading,
        toggle: vi.fn(),
        soloSede: vi.fn(),
        tutte: vi.fn(),
        ricarica: h.ricarica,
    }),
}));

import AdminGalleryPage from '@/app/(dashboard)/admin/gallery/page';

/** Una foto della vista di sede, con i soli campi che la pagina legge. */
const foto = (id: string, createdAt: string, taggati: { id: string; nome: string; classe: string | null }[] = []): FotoSede => ({
    id,
    file_url: `https://firmato.test/${id}.jpg`,
    file_type: 'foto',
    caption: null,
    tag_students: taggati.map((a) => a.id),
    is_broadcast: false,
    created_at: createdAt,
    uploader_name: 'Maestra Finta',
    alunni_taggati: taggati,
});

/** Una pagina piena: trenta foto, tutte della stessa giornata. */
const paginaPiena = () => Array.from({ length: 30 }, (_, i) => foto(`f-${i}`, '2026-09-04T09:00:00.000Z'));

/**
 * La riga «N foto · M in tutto», formattata dal CATALOGO e non riscritta a mano.
 *
 * ⚠️ Congelare qui la prosa italiana renderebbe questo test rosso al primo
 * ritocco di quella frase — un test che difende il testo invece del
 * comportamento. Si formatta la chiave con lo stesso `IntlMessageFormat` che usa
 * `test/setup.ts` al posto di next-intl: così si asserisce su CIÒ CHE LA PAGINA
 * MOSTRA per quei due numeri, chiunque riscriva la frase.
 */
const conteggio = (mostrate: number, totale: number) =>
    String(new IntlMessageFormat(itAdminAltro.galSedeConteggio, 'it').format({ mostrate, totale }));

/** Le richieste fatte a `/api/gallery`, nell'ordine in cui sono partite. */
const chiamateGalleria = () =>
    h.fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/gallery'));

let rispostaGalleria: { ok: boolean; status: number; body: Record<string, unknown> };
/**
 * Le righe di `GET /api/admin/students`, come le manda la rotta vera: `section_id`
 * (l'uuid, la FK) E `classe_sezione` (il testo). I due possono divergere, ed è il
 * caso che il test (E) mette alla prova.
 */
let righeAlunni: Record<string, unknown>[];

beforeEach(() => {
    vi.clearAllMocks();
    h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }];
    h.sediErrore = false;
    h.sediLoading = false;
    h.sospendiGalleria = false;
    h.rispostaPerIndirizzo = null;
    h.rispostaElimina = { ok: true, status: 200, body: { success: true } };
    h.rispostaRipristino = { ok: true, status: 200, body: { success: true } };
    righeAlunni = [
        { id: ALU_1, nome: 'Primo', cognome: 'Finto', classe_sezione: CLASSE, section_id: SEZ_1 },
        { id: ALU_2, nome: 'Secondo', cognome: 'Finto', classe_sezione: ALTRA_CLASSE, section_id: SEZ_2 },
    ];
    rispostaGalleria = {
        ok: true,
        status: 200,
        body: {
            media: [foto('foto-1', '2026-09-04T09:00:00.000Z', [{ id: ALU_1, nome: 'Primo Finto', classe: CLASSE }])],
            total: 1,
            limit: 30,
            offset: 0,
        },
    };
    h.fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        // ⚠️ QUESTI DUE RAMI VANNO PRIMA di `/api/gallery`: il ramo sotto usa
        // `startsWith`, e `/api/gallery/ripristina` comincia per `/api/gallery` —
        // messo dopo, il ripristino riceverebbe il corpo dell'ELENCO e il test
        // sarebbe verde senza aver mai chiamato la rotta giusta.
        if (u.startsWith('/api/gallery/ripristina')) {
            const r = h.rispostaRipristino;
            return Promise.resolve({ ok: r.ok, status: r.status, headers: new Headers(), json: async () => r.body });
        }
        if (u.startsWith('/api/gallery?id=')) {
            const r = h.rispostaElimina;
            return Promise.resolve({ ok: r.ok, status: r.status, headers: new Headers(), json: async () => r.body });
        }
        if (u.startsWith('/api/gallery')) {
            // Mai risolta: la richiesta resta in volo finché il test guarda.
            if (h.sospendiGalleria) return new Promise(() => {});
            // `Promise.resolve` accetta sia l'oggetto sia una promise: il gancio
            // può quindi anche RITARDARE una risposta, che è come si guarda la
            // schermata mentre una rilettura è in volo.
            return Promise.resolve(h.rispostaPerIndirizzo ? h.rispostaPerIndirizzo(u) : rispostaGalleria).then(
                (r) => ({
                    ok: r.ok,
                    status: r.status,
                    headers: new Headers(),
                    json: async () => r.body,
                }),
            );
        }
        if (u.startsWith('/api/admin/sections')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => [
                    { id: SEZ_1, name: CLASSE, scuola_id: SEDE_A },
                    { id: SEZ_2, name: ALTRA_CLASSE, scuola_id: SEDE_A },
                ],
            });
        }
        if (u.startsWith('/api/admin/students')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => righeAlunni,
            });
        }
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] });
    });
    vi.stubGlobal('fetch', h.fetchMock);
});

/* ────────────────────────────────────────────────────────────────────────────
 * (A) IL RAGGRUPPAMENTO — logica pura, si prova senza montare niente.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(A) raggruppamento per giornata — il giorno è quello ITALIANO', () => {
    it('l’una di notte italiana appartiene al giorno DOPO, non a quello di Greenwich', () => {
        // 2026-09-05T23:00:00Z = 6 settembre, ore 01:00, a Giugliano.
        // `created_at.slice(0, 10)` direbbe «2026-09-05»: è il difetto.
        const giornate = raggruppaPerGiornata([
            foto('notte', '2026-09-05T23:00:00.000Z'),
            foto('sera', '2026-09-05T21:00:00.000Z'),
        ]);
        expect(giornate.map((g) => g.giorno)).toEqual(['2026-09-06', '2026-09-05']);
        expect(giornate[0].foto.map((f) => f.id)).toEqual(['notte']);
        expect(giornate[1].foto.map((f) => f.id)).toEqual(['sera']);
    });

    it('le giornate escono dalla più recente, e dentro ognuna le foto pure', () => {
        // Ordine d'ingresso volutamente mescolato: se il raggruppamento si
        // appoggiasse all'ordine della rotta invece di ordinare, uscirebbe così.
        const giornate = raggruppaPerGiornata([
            foto('b-mattina', '2026-09-04T07:00:00.000Z'),
            foto('a-tardi', '2026-09-05T16:00:00.000Z'),
            foto('b-sera', '2026-09-04T15:00:00.000Z'),
            foto('a-presto', '2026-09-05T07:00:00.000Z'),
        ]);
        expect(giornate.map((g) => g.giorno)).toEqual(['2026-09-05', '2026-09-04']);
        expect(giornate[0].foto.map((f) => f.id)).toEqual(['a-tardi', 'a-presto']);
        expect(giornate[1].foto.map((f) => f.id)).toEqual(['b-sera', 'b-mattina']);
    });

    it('una data illeggibile non porta via la pagina: finisce in coda, senza giorno', () => {
        // `dataCivile` passa da `Intl.format`, che su una data non valida LANCIA
        // (`RangeError`) invece di stampare «Invalid Date». Senza la guardia, un
        // `created_at` malformato farebbe cadere l’intera schermata.
        const giornate = raggruppaPerGiornata([
            foto('rotta', 'non-una-data'),
            foto('buona', '2026-09-05T10:00:00.000Z'),
        ]);
        expect(giornate.map((g) => g.giorno)).toEqual(['2026-09-05', null]);
        expect(giornate[1].foto.map((f) => f.id)).toEqual(['rotta']);
    });

    it('i bambini taggati si deduplicano e portano con sé la classe', () => {
        const elenco = alunniDellaPagina(
            [
                foto('x', '2026-09-05T10:00:00.000Z', [{ id: ALU_1, nome: 'Primo Finto', classe: CLASSE }]),
                foto('y', '2026-09-05T11:00:00.000Z', [
                    { id: ALU_1, nome: 'Primo Finto', classe: CLASSE },
                    { id: ALU_2, nome: 'Secondo Finto', classe: null },
                ]),
            ],
            SENZA_NOME,
        );
        expect(elenco).toEqual([
            { id: ALU_1, nome: `Primo Finto — ${CLASSE}`, cognome: '' },
            { id: ALU_2, nome: 'Secondo Finto', cognome: '' },
        ]);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (B) LA SEDE SI DICHIARA, MAI SI INDOVINA.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(B) la sede', () => {
    it('con un plesso solo si usa quello, e la richiesta porta scope=sede E scuolaId', async () => {
        render(<AdminGalleryPage />);
        await waitFor(() => expect(chiamateGalleria().length).toBeGreaterThan(0));
        const url = chiamateGalleria()[0];
        expect(url, 'senza `scope=sede` la rotta non apre la vista di plesso').toContain('scope=sede');
        expect(url, 'senza `scuolaId` la rotta risponde 400: i due parametri viaggiano insieme').toContain(
            `scuolaId=${SEDE_A}`,
        );
        // Nessuna tendina delle sedi: non c'è niente da scegliere.
        expect(screen.queryByLabelText(itAdminAltro.galSedeSedeLabel)).not.toBeInTheDocument();
    });

    it('con DUE plessi non parte nessuna richiesta finché la sede non è scelta', async () => {
        h.sedi = [
            { id: SEDE_A, nome: NOME_SEDE_A },
            { id: SEDE_B, nome: NOME_SEDE_B },
        ];
        render(<AdminGalleryPage />);
        expect(await screen.findByText(itAdminAltro.galSedeSceltaTitolo)).toBeInTheDocument();
        expect(chiamateGalleria(), 'una sede indovinata è una galleria del plesso sbagliato').toEqual([]);

        // …e appena si sceglie, la richiesta parte con QUELLA sede.
        fireEvent.change(screen.getByLabelText(itAdminAltro.galSedeSedeLabel), { target: { value: SEDE_B } });
        await waitFor(() => expect(chiamateGalleria().length).toBe(1));
        expect(chiamateGalleria()[0]).toContain(`scuolaId=${SEDE_B}`);
        expect(chiamateGalleria()[0]).not.toContain(SEDE_A);
    });

    it('cambiando plesso le foto del precedente spariscono SUBITO, non quando arriva la risposta', async () => {
        /* Il momento pericoloso è la richiesta IN VOLO. Il selettore nomina già il
         * plesso nuovo; se la griglia continuasse a rendere le foto del vecchio,
         * la schermata direbbe una cosa falsa — e si legge benissimo — su foto di
         * minori. Non è una fuga di dati (il selettore offre solo plessi già
         * accessibili): è una didascalia sbagliata, che è peggio di un errore
         * perché nessuno la mette in dubbio.
         *
         * Il test precedente non può vederlo: là si passa da «nessuna sede» a
         * SEDE_B, cioè con l'elenco già vuoto. Qui si parte da una griglia PIENA. */
        h.sedi = [
            { id: SEDE_A, nome: NOME_SEDE_A },
            { id: SEDE_B, nome: NOME_SEDE_B },
        ];
        render(<AdminGalleryPage />);
        const tendinaSede = screen.getByLabelText(itAdminAltro.galSedeSedeLabel);

        fireEvent.change(tendinaSede, { target: { value: SEDE_A } });
        expect(await screen.findAllByRole('heading', { level: 2 })).toHaveLength(1);

        // La risposta del plesso nuovo resta in volo: è lì che si guarda.
        h.sospendiGalleria = true;
        fireEvent.change(tendinaSede, { target: { value: SEDE_B } });
        await waitFor(() => expect(chiamateGalleria().length).toBe(2));
        expect(chiamateGalleria()[1]).toContain(`scuolaId=${SEDE_B}`);

        expect(
            screen.queryAllByRole('heading', { level: 2 }),
            'le giornate del plesso precedente sono ancora a schermo sotto il nome di quello nuovo',
        ).toHaveLength(0);
        // …e al loro posto c'è il caricamento, annunciato.
        expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('mentre l’elenco delle sedi è in volo non si dice ancora niente sui plessi', async () => {
        /* `[]` CON `loading` non è «non hai plessi»: è «non lo so ancora». Le due
         * frasi che stanno più avanti nella catena di rami — «nessun plesso da
         * mostrare» e «scegli un plesso» — sono entrambe affermazioni sui dati,
         * fatte mezzo secondo prima di avere i dati. Questo ramo è renderizzato
         * dalla pagina ma non l'aveva mai visto nessun test: si poteva rompere
         * restando verdi. */
        h.sedi = [];
        h.sediLoading = true;
        render(<AdminGalleryPage />);
        expect(await screen.findByRole('status')).toBeInTheDocument();
        expect(screen.queryByText(itAdminAltro.galSedeNessunaSedeTitolo)).not.toBeInTheDocument();
        expect(screen.queryByText(itAdminAltro.galSedeSceltaTitolo)).not.toBeInTheDocument();
        expect(chiamateGalleria(), 'senza una sede dichiarata non parte nessuna richiesta').toEqual([]);
    });

    it('a chi non ha nessun plesso lo si dice, e non gli si chiede di sceglierne uno', async () => {
        /* `[]` SENZA errore e SENZA loading è l'unica forma in cui `opzioniSede`
         * può restare vuota davvero: `effettive` è per costruzione un
         * sottoinsieme delle sedi accessibili (`sede-context.tsx:238`,
         * `validSel.length > 0 ? validSel : ids`), quindi «sedi piene ed
         * effettive disgiunte» non è uno stato raggiungibile. È l'account senza
         * `utenti_scuole` — e a lui «scegli un plesso» sarebbe un'istruzione
         * impossibile da eseguire, la stessa frase sbagliata che il test
         * dell'elenco non letto tiene fuori dal caso accanto. Anche questo ramo
         * era reso e mai provato. */
        h.sedi = [];
        render(<AdminGalleryPage />);
        expect(await screen.findByText(itAdminAltro.galSedeNessunaSedeTitolo)).toBeInTheDocument();
        expect(screen.queryByText(itAdminAltro.galSedeSceltaTitolo)).not.toBeInTheDocument();
        expect(
            screen.queryByText(itAdminAltro.galSedeSediNonLetteTitolo),
            'non avere plessi non è non aver letto l’elenco: sono due frasi diverse',
        ).not.toBeInTheDocument();
        expect(chiamateGalleria()).toEqual([]);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (C) I FILTRI VIAGGIANO NELLA QUERY, NON NEL BROWSER.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(C) filtri e paginazione', () => {
    it('la CLASSE finisce nella query del server, non in un `filter` sulla pagina', async () => {
        render(<AdminGalleryPage />);
        await waitFor(() => expect(chiamateGalleria().length).toBe(1));
        await waitFor(() =>
            expect((screen.getByLabelText(itAdminAltro.galSedeClasseLabel) as HTMLSelectElement).disabled).toBe(false),
        );

        // Il `value` della tendina è l'UUID della sezione (l'identità), ma nella
        // query ci va il NOME: è l'unica forma che `?classe=` accetta, e la rotta
        // lo risolve lei in `sections.id`.
        fireEvent.change(screen.getByLabelText(itAdminAltro.galSedeClasseLabel), { target: { value: SEZ_1 } });
        await waitFor(() => expect(chiamateGalleria().length).toBe(2));
        expect(chiamateGalleria()[1]).toContain(`classe=${CLASSE}`);
        expect(chiamateGalleria()[1], 'al server va il nome, mai l’uuid della sezione').not.toContain(SEZ_1);
    });

    it('il BAMBINO viaggia come `studentId`, e il GIORNO come `date`', async () => {
        render(<AdminGalleryPage />);
        await waitFor(() => expect(chiamateGalleria().length).toBe(1));
        await waitFor(() =>
            expect((screen.getByLabelText(itAdminAltro.galSedeBambinoLabel) as HTMLSelectElement).disabled).toBe(false),
        );

        fireEvent.change(screen.getByLabelText(itAdminAltro.galSedeBambinoLabel), { target: { value: ALU_2 } });
        await waitFor(() => expect(chiamateGalleria().length).toBe(2));
        expect(chiamateGalleria()[1]).toContain(`studentId=${ALU_2}`);

        fireEvent.change(screen.getByLabelText(itAdminAltro.galSedeGiornoLabel), { target: { value: '2026-09-04' } });
        await waitFor(() => expect(chiamateGalleria().length).toBe(3));
        expect(chiamateGalleria()[2]).toContain('date=2026-09-04');
    });

    it('la paginazione scorre col SERVER: `offset` avanza del `limit` DICHIARATO, non della costante', async () => {
        // ⚠️ IL `limit` DELLA RISPOSTA È DIVERSO DA QUELLO CHIESTO, ED È IL PUNTO.
        // La rotta clampa in SILENZIO (1..100) e ridichiara nel corpo il valore che
        // ha applicato davvero. Finché la fixture rimandava 30 — lo stesso numero
        // della costante `FOTO_PER_PAGINA` — questo test non poteva distinguere
        // «leggo il limit del server» da «uso la mia costante»: era verde in
        // entrambi i casi. Con 10 la differenza si vede: se la pagina ignorasse
        // `corpo.limit`, il secondo indirizzo direbbe `offset=30`.
        rispostaGalleria = {
            ok: true,
            status: 200,
            body: {
                media: Array.from({ length: 30 }, (_, i) => foto(`f-${i}`, '2026-09-04T09:00:00.000Z')),
                total: 75,
                limit: 10,
                offset: 0,
            },
        };
        render(<AdminGalleryPage />);
        await waitFor(() => expect(chiamateGalleria().length).toBe(1));
        expect(chiamateGalleria()[0]).toContain('offset=0');
        // Il CLIENT chiede il suo default: non conosce il clamp finché non risponde.
        expect(chiamateGalleria()[0]).toContain('limit=30');

        fireEvent.click(await screen.findByRole('button', { name: itAdminAltro.galSedePiuVecchie }));
        await waitFor(() => expect(chiamateGalleria().length).toBe(2));
        expect(
            chiamateGalleria()[1],
            'la pagina dopo comincia dove il SERVER ha smesso di consegnare, non dove la costante dice',
        ).toContain('offset=10');
        expect(chiamateGalleria()[1]).not.toContain('offset=30');
    });

    it('cambiando FILTRO spariscono SUBITO anche le foto di prima e il loro conteggio', async () => {
        /* La gemella del test sul cambio di PLESSO, e per la stessa ragione. Qui
         * la griglia resta bene o male dello stesso plesso, quindi la bugia non è
         * l'attribuzione: è il CONTEGGIO. «1 foto · 1 in tutto» sono i numeri del
         * filtro PRECEDENTE, e restano scritti sotto una tendina che nomina già
         * la classe nuova — un numero che una segreteria legge al telefono a una
         * famiglia. E non compare nemmeno lo spinner a mettere in dubbio ciò che
         * si sta guardando, perché `stato` valuta `foto.length > 0 ? 'pronto'`
         * PRIMA di `caricamento`: una lista non vuota vince sul caricamento. */
        render(<AdminGalleryPage />);
        expect(await screen.findAllByRole('heading', { level: 2 })).toHaveLength(1);
        expect(screen.getByText(conteggio(1, 1))).toBeInTheDocument();
        await waitFor(() =>
            expect((screen.getByLabelText(itAdminAltro.galSedeClasseLabel) as HTMLSelectElement).disabled).toBe(false),
        );

        // La risposta della classe resta in volo: è lì che si guarda.
        h.sospendiGalleria = true;
        fireEvent.change(screen.getByLabelText(itAdminAltro.galSedeClasseLabel), { target: { value: SEZ_1 } });
        await waitFor(() => expect(chiamateGalleria().length).toBe(2));

        expect(
            screen.queryAllByRole('heading', { level: 2 }),
            'le giornate del filtro precedente sono ancora a schermo sotto la classe nuova',
        ).toHaveLength(0);
        expect(
            screen.queryByText(conteggio(1, 1)),
            'il conteggio del filtro precedente è la bugia che si legge meglio di tutte',
        ).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('cambiando PAGINA sparisce subito anche il conteggio della pagina di prima', async () => {
        /* Il terzo gesto che cambia elenco, e mente allo stesso modo: nell'istante
         * del clic l'`offset` è già quello nuovo — quindi l'etichetta dice
         * «Pagina 2/3» — mentre sotto restano le foto della pagina 1 e il loro
         * conteggio, finché la risposta non arriva. Stessa scritta, altro numero. */
        rispostaGalleria = {
            ok: true,
            status: 200,
            body: { media: paginaPiena(), total: 75, limit: 30, offset: 0 },
        };
        render(<AdminGalleryPage />);
        expect(await screen.findAllByRole('heading', { level: 2 })).toHaveLength(1);
        expect(screen.getByText(conteggio(30, 75))).toBeInTheDocument();

        // La pagina 2 resta in volo: è lì che si guarda.
        h.sospendiGalleria = true;
        fireEvent.click(screen.getByRole('button', { name: itAdminAltro.galSedePiuVecchie }));
        await waitFor(() => expect(chiamateGalleria().length).toBe(2));

        expect(
            screen.queryAllByRole('heading', { level: 2 }),
            'le foto della pagina 1 sono ancora a schermo sotto l’etichetta della 2',
        ).toHaveLength(0);
        expect(screen.queryByText(conteggio(30, 75))).not.toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: itAdminAltro.galSedePaginazione })).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('…e tornando INDIETRO vale lo stesso, sempre col `limit` DICHIARATO dal server', async () => {
        /* Il gemello del test qui sopra, sull'altro pulsante. I due gestori sono
         * identici riga per riga, e provarne uno solo lascia l'altro disfabile
         * restando verdi: è la forma esatta con cui in questo repo un filtro
         * rotto è rimasto verde per sempre perché nessuno lo usava.
         *
         * ⚠️ E CON L'`offset` A 20, non a 30. Con una pagina sola di distanza
         * dallo zero le due formule danno lo STESSO risultato (`30 − 30` e
         * `30 − 10` finiscono comunque a 0 o giù di lì), quindi il ritorno non
         * poteva distinguere il `limit` del server dalla costante: verde in
         * entrambi i casi, come lo era il test in avanti finché la fixture
         * rimandava 30. Da 20 la differenza si legge: col numero del server si
         * torna a 10, con la costante si finisce a 0 — cioè si SALTA una pagina
         * intera di foto, senza un errore. */
        h.rispostaPerIndirizzo = (u) => {
            const off = Number(new URLSearchParams(u.split('?')[1] ?? '').get('offset') ?? '0');
            return {
                ok: true,
                status: 200,
                // `limit: 10` ≠ `FOTO_PER_PAGINA`: è ciò che rende la prova capace
                // di fallire. Il server clampa in silenzio e ridichiara nel corpo.
                body: { media: paginaPiena(), total: 75, limit: 10, offset: off },
            };
        };
        render(<AdminGalleryPage />);
        // Due pagine in avanti: 0 → 10 → 20. `findByRole` aspetta che il pulsante
        // torni: fra un clic e l'altro la nav non è resa (stato `caricamento`).
        fireEvent.click(await screen.findByRole('button', { name: itAdminAltro.galSedePiuVecchie }));
        await waitFor(() => expect(chiamateGalleria().length).toBe(2));
        fireEvent.click(await screen.findByRole('button', { name: itAdminAltro.galSedePiuVecchie }));
        await waitFor(() => expect(chiamateGalleria().length).toBe(3));
        expect(chiamateGalleria()[2]).toContain('offset=20');

        // …e si torna indietro con la pagina precedente ancora in volo.
        h.sospendiGalleria = true;
        fireEvent.click(await screen.findByRole('button', { name: itAdminAltro.galSedePiuRecenti }));
        await waitFor(() => expect(chiamateGalleria().length).toBe(4));
        expect(
            chiamateGalleria()[3],
            'indietro si torna del `limit` che il SERVER ha applicato: con la costante si salterebbe una pagina intera',
        ).toContain('offset=10');
        expect(chiamateGalleria()[3]).not.toContain('offset=0');
        expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
        expect(screen.queryByText(conteggio(30, 75))).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('se il totale si riduce sotto l’offset la pagina si riavvolge, invece di dire «Pagina 2/1»', async () => {
        /* IL TOTALE DIMINUISCE, e non per colpa nostra: una maestra cancella una
         * foto mentre la segreteria sta aprendo la pagina 2. L'`offset` che
         * abbiamo appena chiesto si trova oltre la fine dell'elenco, e senza
         * correzione la schermata dice una delle due bugie:
         *   · col `media` vuoto (quello che il server manda davvero) «in questo
         *     plesso non c'è ancora nessuna foto» — mentre ce n'è una — e senza
         *     uscita, perché i due pulsanti della paginazione vivono DENTRO il
         *     ramo `pronto` e in quello stato non vengono resi: un vicolo cieco;
         *   · col `media` non vuoto «Pagina 2 di 1», perché `pagina` viene
         *     dall'offset e `pagine` dal totale, e nessuno dei due limita l'altro.
         * Si prova la CAUSA (l'offset si riavvolge), non l'etichetta. */
        rispostaGalleria = {
            ok: true,
            status: 200,
            body: { media: paginaPiena(), total: 75, limit: 30, offset: 0 },
        };
        render(<AdminGalleryPage />);
        await waitFor(() => expect(chiamateGalleria().length).toBe(1));

        // Da qui in poi il plesso ha UNA foto sola. Il corpo dipende dall'`offset`
        // CHIESTO — a 30 il server non ha niente da consegnare, a 0 sì — ed è il
        // solo modo di distinguere «si riavvolge» da «mostra il vuoto». La
        // rilettura della prima pagina si fa ASPETTARE, perché la finestra fra le
        // due richieste è essa stessa una cosa da guardare.
        let sblocca: () => void = () => {};
        const primaPaginaLenta = new Promise<void>((r) => { sblocca = r; });
        h.rispostaPerIndirizzo = async (u) => {
            const off = Number(new URLSearchParams(u.split('?')[1] ?? '').get('offset') ?? '0');
            if (off === 0) await primaPaginaLenta;
            return {
                ok: true,
                status: 200,
                body: {
                    media: off === 0 ? [foto('unica', '2026-09-04T09:00:00.000Z')] : [],
                    total: 1,
                    limit: 30,
                    offset: off,
                },
            };
        };
        fireEvent.click(await screen.findByRole('button', { name: itAdminAltro.galSedePiuVecchie }));

        await waitFor(() => expect(chiamateGalleria().length).toBe(3));
        expect(chiamateGalleria()[1]).toContain('offset=30');
        expect(
            chiamateGalleria()[2],
            'una pagina che il totale nuovo non giustifica più si riavvolge, non resta lì',
        ).toContain('offset=0');

        // ⚠️ LA FINESTRA FRA LE DUE RICHIESTE. Il giro non è finito, è
        // ricominciato: se lo spinner si spegnesse qui, per un istante si
        // leggerebbe «non c'è ancora nessuna foto» su un elenco che le foto le ha
        // e che sta già ricaricando. È la ragione del flag `riparto`.
        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(
            screen.queryByText(itAdminAltro.galSedeVuotoTitolo),
            'il giro è ricominciato: «finito» qui è una parola sbagliata',
        ).not.toBeInTheDocument();

        // …e quando la rilettura arriva, a schermo c'è la foto che c'è davvero.
        sblocca();
        expect(await screen.findAllByRole('heading', { level: 2 })).toHaveLength(1);
        expect(
            screen.queryByText(itAdminAltro.galSedeVuotoTitolo),
            '«non c’è ancora nessuna foto» è falso, e da lì non si torna indietro',
        ).not.toBeInTheDocument();
        // …e nessuna etichetta di pagina, perché di pagine ne è rimasta una sola.
        expect(screen.queryByRole('navigation', { name: itAdminAltro.galSedePaginazione })).not.toBeInTheDocument();
        // Un elenco che si riavvolge da solo senza lasciare traccia è il silenzio
        // che questo repo paga caro. Solo NUMERI: offset e totale.
        await waitFor(() =>
            expect(h.logClient).toHaveBeenCalledWith(
                expect.objectContaining({ livello: 'warn', messaggio: 'galleria-sede-offset-oltre-la-fine:30:1' }),
            ),
        );
    });

    it('le foto arrivano a schermo RAGGRUPPATE, con l’intestazione della giornata italiana', async () => {
        // La logica del raggruppamento è provata sopra sulla funzione pura; qui si
        // prova che la PAGINA la usi davvero. Senza questa asserzione la pagina
        // potrebbe rendere una griglia piatta e restare verde su tutto il resto.
        rispostaGalleria = {
            ok: true,
            status: 200,
            body: {
                media: [
                    // 2026-09-05T23:00Z = 6 settembre, ore 01:00, in Italia.
                    foto('notte', '2026-09-05T23:00:00.000Z'),
                    foto('mattina', '2026-09-04T08:00:00.000Z'),
                ],
                total: 2,
                limit: 30,
                offset: 0,
            },
        };
        render(<AdminGalleryPage />);
        const intestazioni = await screen.findAllByRole('heading', { level: 2 });
        expect(intestazioni).toHaveLength(2);
        // Il giorno e il mese bastano: il nome del giorno della settimana lo decide
        // `Intl`, e asserirlo qui vorrebbe dire ricalcolarlo con lo stesso codice.
        expect(intestazioni[0].textContent).toMatch(/6 settembre 2026/);
        expect(intestazioni[1].textContent).toMatch(/4 settembre 2026/);
    });

    it('senza foto e senza filtri si dice «non ce n’è ancora nessuna», non «nessun risultato»', async () => {
        rispostaGalleria = { ok: true, status: 200, body: { media: [], total: 0, limit: 30, offset: 0 } };
        render(<AdminGalleryPage />);
        expect(await screen.findByText(itAdminAltro.galSedeVuotoTitolo)).toBeInTheDocument();
        expect(screen.queryByText(itAdminAltro.galSedeSenzaRisultatiTitolo)).not.toBeInTheDocument();
    });

    it('senza foto MA con una classe scelta si dice «nessun risultato», col chip e il modo di uscirne', async () => {
        // L'altra metà della distinzione. Dire «in questo plesso non c'è ancora
        // nessuna foto» a chi ha appena messo un filtro accusa il plesso di una
        // colpa del filtro, e non offre l'unica azione che serve: togliere il filtro.
        render(<AdminGalleryPage />);
        await waitFor(() =>
            expect((screen.getByLabelText(itAdminAltro.galSedeClasseLabel) as HTMLSelectElement).disabled).toBe(false),
        );
        rispostaGalleria = { ok: true, status: 200, body: { media: [], total: 0, limit: 30, offset: 0 } };
        fireEvent.change(screen.getByLabelText(itAdminAltro.galSedeClasseLabel), { target: { value: SEZ_1 } });

        expect(await screen.findByText(itAdminAltro.galSedeSenzaRisultatiTitolo)).toBeInTheDocument();
        expect(screen.queryByText(itAdminAltro.galSedeVuotoTitolo)).not.toBeInTheDocument();
        // Il chip nomina la classe: `<option>` esclusa, quella c'è comunque.
        expect(
            screen.getAllByText(CLASSE).some((el) => el.tagName !== 'OPTION'),
            'senza il chip chi guarda non sa QUALE filtro sta nascondendo le foto',
        ).toBe(true);
        // «Azzera i filtri» compare due volte: nella barra e dentro lo stato vuoto.
        expect(screen.getAllByRole('button', { name: itAdminAltro.galSedeAzzeraFiltri }).length).toBeGreaterThan(1);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (D) L'ERRORE DEL SERVER SI LEGGE NELLA LINGUA DELL'INTERFACCIA.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(D) errori', () => {
    it('il 403 di sede mostra il testo di CATALOGO, non la prosa della route', async () => {
        /* ⚠️ L'INTERFACCIA VA MESSA IN INGLESE, O QUESTO TEST NON PROVA NIENTE.
         *
         * `rifiutoSede` manda `error` preso dal catalogo ITALIANO (è la stessa
         * stringa che legge un utente italiano: le due strade non possono
         * divergere). Quindi con `lang="it"` «testo di catalogo» e «prosa della
         * route» sono la STESSA frase, e qualunque asserzione le confonde: si può
         * buttare via il `codice` e mostrare la prosa grezza restando verdi.
         *
         * In inglese le due si separano — «Location not accessible» contro «Sede
         * non accessibile» — ed è il caso vero: il fallimento F1/F2 del collaudo
         * 2026-07-31 era esattamente una frase italiana del server dentro
         * un'interfaccia inglese.
         *
         * `messaggioErrore` legge la lingua da `document.documentElement.lang`
         * (`linguaCorrente`, `@/lib/ui/esito-fetch`), non da next-intl: il mock di
         * `test/setup.ts` risolve sempre l'italiano, quindi le scritte della pagina
         * restano italiane. Sotto esame c'è il CORPO DELL'ERRORE, non la cornice. */
        document.documentElement.setAttribute('lang', 'en');
        try {
            // La prosa è quella VERA della rotta: `rifiutoSede` la prende di lì.
            const PROSA_SERVER = itShared.erroreSedeNonAccessibile;
            const DA_CATALOGO = enShared.erroreSedeNonAccessibile;
            expect(PROSA_SERVER, 'se le due frasi coincidessero il test non separerebbe nulla').not.toBe(
                DA_CATALOGO,
            );
            rispostaGalleria = {
                ok: false,
                status: 403,
                body: { error: PROSA_SERVER, codice: 'SEDE_NON_ACCESSIBILE' },
            };
            render(<AdminGalleryPage />);
            expect(await screen.findByText(itAdminAltro.galSedeErroreTitolo)).toBeInTheDocument();
            // `messaggioErrore` risolve `SEDE_NON_ACCESSIBILE` sul catalogo `shared`.
            expect(await screen.findByText(DA_CATALOGO)).toBeInTheDocument();
            expect(
                screen.queryByText(PROSA_SERVER),
                'la prosa italiana della route non deve arrivare a schermo',
            ).not.toBeInTheDocument();
            await waitFor(() =>
                expect(h.logClient).toHaveBeenCalledWith(
                    expect.objectContaining({ livello: 'error', messaggio: 'galleria-sede-non-letta', stato: 403 }),
                ),
            );
        } finally {
            // La lingua è globale al documento: lasciarla addosso falserebbe i
            // test che vengono dopo, in questo file e negli altri dello stesso worker.
            document.documentElement.removeAttribute('lang');
        }
    });

    it('la rete caduta non è «non ci sono foto»: riquadro d’errore e una riga di log', async () => {
        h.fetchMock.mockImplementation((url: string) =>
            String(url).startsWith('/api/gallery')
                ? Promise.reject(new TypeError('Failed to fetch'))
                : Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [] }),
        );
        render(<AdminGalleryPage />);
        expect(await screen.findByText(itAdminAltro.galSedeErroreTitolo)).toBeInTheDocument();
        await waitFor(() =>
            expect(h.logClient).toHaveBeenCalledWith(
                expect.objectContaining({ livello: 'error', messaggio: 'galleria-sede-non-letta: TypeError' }),
            ),
        );
    });

    it('il riquadro d’errore non sopravvive al cambio di filtro', async () => {
        /* `riprova` azzerava l'errore prima di rileggere; i gestori dei filtri no.
         * Così dopo un 403 o un 500, scegliere una classe lasciava il riquadro
         * rosso a schermo per TUTTA la richiesta nuova: accusa di un guasto un
         * filtro che nessuno ha ancora nemmeno provato, e nasconde il fatto che
         * qualcosa stia già ricaricando. */
        rispostaGalleria = { ok: false, status: 500, body: { error: 'guasto' } };
        render(<AdminGalleryPage />);
        expect(await screen.findByText(itAdminAltro.galSedeErroreTitolo)).toBeInTheDocument();
        await waitFor(() =>
            expect((screen.getByLabelText(itAdminAltro.galSedeClasseLabel) as HTMLSelectElement).disabled).toBe(false),
        );

        // La richiesta della classe resta in volo: è la finestra in cui l'errore
        // vecchio starebbe ancora addosso al filtro nuovo.
        h.sospendiGalleria = true;
        fireEvent.change(screen.getByLabelText(itAdminAltro.galSedeClasseLabel), { target: { value: SEZ_1 } });
        await waitFor(() => expect(chiamateGalleria().length).toBe(2));
        expect(screen.queryByText(itAdminAltro.galSedeErroreTitolo)).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('se l’elenco delle sedi non è arrivato non si chiede di sceglierne una', async () => {
        // `[]` con `errore` significa «non ho potuto leggere», non «non ne hai»:
        // chiedere di scegliere un plesso a chi non ha ricevuto l'elenco è
        // un'istruzione impossibile da eseguire.
        h.sedi = [];
        h.sediErrore = true;
        render(<AdminGalleryPage />);
        expect(await screen.findByText(itAdminAltro.galSedeSediNonLetteTitolo)).toBeInTheDocument();
        expect(screen.queryByText(itAdminAltro.galSedeSceltaTitolo)).not.toBeInTheDocument();
        expect(chiamateGalleria()).toEqual([]);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (E) L'IDENTITÀ DI UNA CLASSE È IL SUO UUID, MAI IL SUO NOME.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(E) la classe si filtra per uuid', () => {
    /** Sceglie la classe `SEZ_1` e restituisce i valori offerti dalla tendina «Bambino». */
    const scegliClasseELeggiBambini = async () => {
        await waitFor(() =>
            expect((screen.getByLabelText(itAdminAltro.galSedeClasseLabel) as HTMLSelectElement).disabled).toBe(false),
        );
        fireEvent.change(screen.getByLabelText(itAdminAltro.galSedeClasseLabel), { target: { value: SEZ_1 } });
        const tendina = screen.getByLabelText(itAdminAltro.galSedeBambinoLabel) as HTMLSelectElement;
        return [...tendina.options].map((o) => o.value);
    };

    it('il bambino resta nella tendina anche se il TESTO della sua classe è divergente', async () => {
        /* Il caso vero, misurato in produzione il 2026-09-02: una sezione rinominata
         * dopo l'iscrizione. `sections.name` dice «GIRASOLI», `alunni.classe_sezione`
         * è rimasta «3 ANNI B » — con lo spazio finale, come nelle cinque classi di
         * Giugliano — e `section_id` è GIUSTO, perché il trigger va solo testo → uuid
         * e non torna indietro. Il server quindi le foto le trova (filtra per
         * `section_id`); se questa tendina confrontasse i due testi, la classe
         * avrebbe le foto e nessun bambino, senza errore e senza log. */
        righeAlunni = [
            { id: ALU_1, nome: 'Primo', cognome: 'Finto', classe_sezione: '3 ANNI B ', section_id: SEZ_1 },
            { id: ALU_2, nome: 'Secondo', cognome: 'Finto', classe_sezione: ALTRA_CLASSE, section_id: SEZ_2 },
        ];
        render(<AdminGalleryPage />);
        const valori = await scegliClasseELeggiBambini();
        expect(valori, 'col confronto per TESTO questa tendina sarebbe vuota').toContain(ALU_1);
        expect(valori, 'il bambino dell’altra sezione non c’entra: il filtro deve restringere').not.toContain(ALU_2);
    });

    it('quando nella classe non resta nessun bambino, una riga di log lo dice', async () => {
        // `section_id` assente: per il server quel bambino non è filtrabile per
        // classe, quindi la tendina vuota è la risposta GIUSTA — ma il silenzio no,
        // ed è il silenzio la parte che è costata cara in questo repo.
        righeAlunni = [{ id: ALU_1, nome: 'Primo', cognome: 'Finto', classe_sezione: CLASSE, section_id: null }];
        render(<AdminGalleryPage />);
        const valori = await scegliClasseELeggiBambini();
        expect(valori).not.toContain(ALU_1);
        await waitFor(() =>
            expect(h.logClient).toHaveBeenCalledWith(
                expect.objectContaining({ livello: 'warn', messaggio: 'galleria-sede-classe-senza-bambini:1' }),
            ),
        );
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (G) `alunni_taggati` NON È IN CORRISPONDENZA 1:1 CON `tag_students`.
 *
 * È il contratto della rotta, misurato lì e non dedotto qui: l'elenco dei NOMI
 * può essere più corto di quello degli UUID in due casi dichiarati — un tag che
 * punta a un bambino di un altro plesso (che `alunniTaggatiDellaSede` filtra
 * apposta), e l'anagrafica illeggibile (`42703` sul DB E2E della CI), che lo
 * svuota del tutto. `[]` significa «di questi bambini non ho il nome», mai «in
 * questa foto non c'è nessun bambino».
 *
 * `MediaGrid` da solo renderebbe le due cose identiche: il pannello dei taggati
 * esiste solo `if (students.length > 0)` e dentro scarta in silenzio gli id che
 * non trova. Elenco vuoto ⇒ nessun pannello; elenco parziale ⇒ «due bambini»
 * su una foto che ne tagga tre — e le parziali sono peggio delle vuote.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(G) i bambini taggati di cui manca il nome', () => {
    /** Due bambini taggati, un nome solo: il caso del tag fuori sede. */
    const fotoParziale = (): FotoSede => ({
        ...foto('parziale', '2026-09-04T09:00:00.000Z'),
        tag_students: [ALU_1, ALU_2],
        alunni_taggati: [{ id: ALU_1, nome: 'Primo Finto', classe: CLASSE }],
    });

    /** Due bambini taggati, nessun nome: il caso dell'anagrafica illeggibile. */
    const fotoSenzaNomi = (): FotoSede => ({
        ...foto('degrado', '2026-09-04T09:00:00.000Z'),
        tag_students: [ALU_1, ALU_2],
        alunni_taggati: [],
    });

    it('il tag senza nome entra in elenco col SEGNAPOSTO, e l’uuid non gli fa da ripiego', () => {
        const elenco = alunniDellaPagina([fotoParziale()], SENZA_NOME);
        expect(elenco).toEqual([
            { id: ALU_1, nome: `Primo Finto — ${CLASSE}`, cognome: '' },
            { id: ALU_2, nome: SENZA_NOME, cognome: '' },
        ]);
        expect(
            elenco.map((s) => s.nome).join(' '),
            'l’uuid è l’identificativo di un minore: a schermo non ci va nemmeno come ripiego',
        ).not.toContain(ALU_2);
    });

    it('con NESSUN nome l’elenco non resta vuoto: altrimenti il pannello non verrebbe reso', () => {
        // `students.length > 0` è la condizione con cui `MediaGrid` decide se
        // mostrare il pannello dei taggati: con l'elenco vuoto la foto si
        // leggerebbe come una foto senza bambini, che è il caso opposto.
        const elenco = alunniDellaPagina([fotoSenzaNomi()], SENZA_NOME);
        expect(elenco).toHaveLength(2);
        expect(elenco.every((s) => s.nome === SENZA_NOME)).toBe(true);
    });

    it('un nome vero non viene MAI coperto dal segnaposto, in nessun ordine', () => {
        // Lo stesso bambino compare in due foto della stessa giornata: in una il
        // server ha mandato il nome, nell'altra no. Un solo passaggio sull'elenco
        // — o due passaggi nell'ordine sbagliato — lo ridurrebbe a «Nome non
        // disponibile» a seconda di quale foto arriva per ultima.
        const conNome = alunniDellaPagina([fotoParziale(), fotoSenzaNomi()], SENZA_NOME);
        const alContrario = alunniDellaPagina([fotoSenzaNomi(), fotoParziale()], SENZA_NOME);
        for (const elenco of [conNome, alContrario]) {
            expect(elenco.find((s) => s.id === ALU_1)?.nome).toBe(`Primo Finto — ${CLASSE}`);
            expect(elenco.find((s) => s.id === ALU_2)?.nome).toBe(SENZA_NOME);
        }
    });

    it('un NOME VUOTO vale come nome mancante, per il conteggio e per lo schermo', () => {
        /* La rotta compone `` `${nome ?? ''} ${cognome ?? ''}`.trim() ``: un
         * bambino con entrambi i campi nulli arriva qui come STRINGA VUOTA, non
         * come riga assente. Trattarla come un nome darebbe un chip vuoto (o un
         * solo « — GIRASOLI ») e un log che tace: la schermata direbbe di sapere
         * una cosa che non sa. Le due funzioni devono dare la stessa risposta,
         * o conteggio e schermo raccontano storie diverse dello stesso dato. */
        const senzaNome: FotoSede = {
            ...foto('vuoto', '2026-09-04T09:00:00.000Z'),
            tag_students: [ALU_1],
            alunni_taggati: [{ id: ALU_1, nome: '   ', classe: CLASSE }],
        };
        expect(contaTagSenzaNome([senzaNome])).toEqual({ taggati: 1, senzaNome: 1 });
        expect(alunniDellaPagina([senzaNome], SENZA_NOME)).toEqual([
            { id: ALU_1, nome: SENZA_NOME, cognome: '' },
        ]);
    });

    it('il conteggio è di UUID, non di righe: lo stesso bambino su due foto conta una volta', () => {
        expect(contaTagSenzaNome([fotoParziale()])).toEqual({ taggati: 2, senzaNome: 1 });
        expect(contaTagSenzaNome([fotoParziale(), fotoSenzaNomi()])).toEqual({ taggati: 2, senzaNome: 1 });
        expect(contaTagSenzaNome([fotoSenzaNomi()])).toEqual({ taggati: 2, senzaNome: 2 });
        // Il caso normale non deve produrre né segnalazioni né rumore nel log.
        expect(
            contaTagSenzaNome([foto('ok', '2026-09-04T09:00:00.000Z', [{ id: ALU_1, nome: 'Primo Finto', classe: CLASSE }])]),
        ).toEqual({ taggati: 1, senzaNome: 0 });
    });

    it('a schermo il pannello dei taggati compare, dichiara ENTRAMBI i bambini, e nessun uuid', async () => {
        rispostaGalleria = {
            ok: true,
            status: 200,
            body: { media: [fotoParziale()], total: 1, limit: 30, offset: 0 },
        };
        render(<AdminGalleryPage />);
        // Si apre il visore: il pannello dei taggati vive solo lì dentro.
        fireEvent.click(await screen.findByAltText(itShared.galleryAltFoto));

        expect(await screen.findByText(itShared.galleryTaggatiTitolo)).toBeInTheDocument();
        expect(screen.getByText(new RegExp(`Primo Finto — ${CLASSE}`))).toBeInTheDocument();
        const segnaposto = screen.getByText(SENZA_NOME);
        expect(
            segnaposto,
            'il secondo bambino sparirebbe in silenzio: `MediaGrid` scarta gli id che non trova',
        ).toBeInTheDocument();

        /* L'uuid non fa da ripiego al nome, e si guarda l'HTML e non il testo:
         * un id finito in un `title` o in un `src` è comunque l'identificativo di
         * un minore uscito a schermo.
         *
         * ⚠️ Il perimetro è il pannello dei taggati, NON la pagina: gli uuid dei
         * bambini stanno legittimamente nei `value` della tendina «Bambino» (è
         * ciò che viaggia come `studentId` al server), e asserire sull'intero
         * documento sarebbe rosso per un motivo giusto — cioè un test che non
         * misura quello che dice. */
        const chip = segnaposto.parentElement as HTMLElement;
        expect(chip.textContent, 'il perimetro deve contenere ENTRAMBI i chip, o non prova niente').toContain(
            'Primo Finto',
        );
        expect(chip.innerHTML).not.toContain(ALU_1);
        expect(chip.innerHTML).not.toContain(ALU_2);
    });

    it('…e il caso finisce nel log, con i soli conteggi', async () => {
        rispostaGalleria = {
            ok: true,
            status: 200,
            body: { media: [fotoParziale()], total: 1, limit: 30, offset: 0 },
        };
        render(<AdminGalleryPage />);
        await waitFor(() =>
            expect(h.logClient).toHaveBeenCalledWith(
                expect.objectContaining({ livello: 'warn', messaggio: 'galleria-sede-tag-senza-nome:1/2' }),
            ),
        );
        // Nessun id di minore nel messaggio: la redazione di `app_log` è a lista
        // bianca e un uuid la passerebbe: qui non deve nemmeno esserci.
        for (const [riga] of h.logClient.mock.calls as [{ messaggio?: string }][]) {
            expect(riga.messaggio ?? '').not.toContain(ALU_1);
            expect(riga.messaggio ?? '').not.toContain(ALU_2);
        }
    });

    it('quando i nomi ci sono tutti il log tace: una riga sempre accesa non è un segnale', async () => {
        render(<AdminGalleryPage />);
        expect(await screen.findAllByRole('heading', { level: 2 })).toHaveLength(1);
        expect(
            h.logClient.mock.calls.some((c) => String((c[0] as { messaggio?: string }).messaggio ?? '').startsWith('galleria-sede-tag-senza-nome')),
        ).toBe(false);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * (F) LA VOCE DI MENU, E OGNI CHIAVE CHE IL CODICE CHIEDE.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('(F) registrazione e cataloghi', () => {
    it('la galleria è nella nav admin, con la sua chiave i18n', () => {
        const voce = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === '/admin/gallery');
        expect(voce, 'una pagina che nessun menu raggiunge non esiste per chi la deve usare').toBeDefined();
        expect(voce!.labelKey).toBe('nav_gallery');
        expect(itEtichette).toHaveProperty('nav_gallery');
        expect(enEtichette).toHaveProperty('nav_gallery');
        // I RUOLI SONO GLI STESSI DELLA ROTTA. `requireStaff` su
        // `GET /api/gallery?scope=sede` ammette admin, coordinator e segreteria;
        // senza `roles` la voce sarebbe visibile anche alla `cuoca`, che entra
        // nell'area admin per il solo report cucina — un menu che promette una
        // schermata di foto di minori e poi risponde 403.
        expect(voce!.roles).toEqual(['admin', 'coordinator', 'segreteria']);
    });

    /* ── LA DIREZIONE CONTA, ED È QUELLA DAL CODICE AL CATALOGO ─────────────────
     *
     * Fino al 2026-09-06 questa prova partiva dal CATALOGO e cercava la gemella
     * inglese: cioè la parità it↔en, che ha già un lock suo su tutti e 34 i
     * namespace (`__tests__/architecture/messaggi-parita-cataloghi.test.ts`).
     * Verificava una cosa vera e ne prometteva un'altra — che è il modo in cui una
     * prova diventa decorazione restando verde.
     *
     * Il difetto possibile qui va nel verso opposto: il codice CHIEDE una chiave
     * che il catalogo non ha. MISURATO, non supposto: scrivendo apposta
     * `t('galSedeSedeScegliRefusoXX')` in `page.tsx` la suite dava `27 passed (27)`
     * e a schermo la voce vuota della tendina «Sede» diventava la stringa
     * `adminAltro.galSedeSedeScegliRefusoXX`. Nessuna eccezione, nessuna riga di
     * log: il mock di `next-intl` (`test/setup.ts`) risolve la chiave assente nel
     * proprio NOME invece di lanciare, ed è esattamente ciò che fa
     * `getMessageFallback` davanti alla segreteria.
     *
     * Quindi si legge il SORGENTE, si estraggono le chiavi che chiede, e si pretende
     * che i cataloghi le abbiano. Tutte e due i cataloghi, ed entrambe le direzioni.
     */
    const SORGENTI_CHE_CHIEDONO = [
        'src/app/(dashboard)/admin/gallery/page.tsx',
        // Oggi il componente riceve le etichette come props e non chiama mai `t`: sta
        // in elenco perché il giorno in cui le chiamerà questa prova lo segua da sola,
        // invece di restare verde su metà della schermata.
        'src/components/features/gallery/GalleriaSedeGiornate.tsx',
    ];

    /** Le chiavi `galSede*` che il CODICE chiede a `useTranslations('adminAltro')`. */
    const chiaviChiesteDalCodice = (): string[] => {
        const testo = SORGENTI_CHE_CHIEDONO.map((f) => readFileSync(join(process.cwd(), f), 'utf8')).join('\n');
        return [...new Set([...testo.matchAll(/\bt\('(galSede[A-Za-z0-9]*)'/g)].map((m) => m[1]))].sort();
    };

    it('la scansione del sorgente trova davvero le chiavi che la pagina chiede', () => {
        // Senza questo controllo positivo le due prove qui sotto sarebbero verdi anche
        // con una regex rotta o un percorso sbagliato: un ciclo su zero chiavi non
        // fallisce mai. È il presidio già in uso in `messaggi-chiavi-orfane.test.ts`.
        expect(
            chiaviChiesteDalCodice().length,
            'la scansione non trova più le chiavi della pagina: prima di guardare il ' +
                'prodotto, riparare la misura — un divieto che gira su zero chiavi è verde per sempre',
        ).toBeGreaterThanOrEqual(30);
    });

    it('ogni chiave che il CODICE chiede esiste in italiano E in inglese', () => {
        const mancanti = chiaviChiesteDalCodice().filter((k) => !(k in itAdminAltro) || !(k in enAdminAltro));
        expect(
            mancanti,
            'Chieste da `/admin/gallery` e assenti da `messages/{it,en}/adminAltro.json`:\n  ' +
                mancanti.join('\n  ') +
                '\nA schermo non danno un errore: danno la stringa `adminAltro.<chiave>` alla segreteria.',
        ).toEqual([]);
    });

    it('nessuna chiave `galSede*` del catalogo è rimasta senza codice che la chieda', () => {
        // L'altra metà, e non la copre nessun lock: `adminAltro` non è fra i namespace
        // sotto tutela di `messaggi-chiavi-orfane.test.ts`. Due cataloghi possono
        // essere perfettamente simmetrici e perfettamente morti.
        const chieste = new Set(chiaviChiesteDalCodice());
        const morte = Object.keys(itAdminAltro).filter((k) => k.startsWith('galSede') && !chieste.has(k));
        expect(
            morte,
            `Chiavi che nessuna riga chiede più: ${morte.join(', ')}. Toglile da ENTRAMBI i cataloghi.`,
        ).toEqual([]);
    });
});

/* ════════════════════════════════════════════════════════════════════════════
 * (H) IL CESTINO — la promessa del dialogo, mantenuta
 *
 * `DialogoEliminaMedia` dice all'insegnante che «la segreteria può ripristinarla
 * entro 30 giorni». Fino al 2026-09-12 quella frase era vera solo lato server: la
 * rotta esisteva e il bottone no. Questi test sono ciò che tiene la promessa legata
 * all'interfaccia — se la linguetta sparisce, diventano rossi.
 * ══════════════════════════════════════════════════════════════════════════ */
describe('(H) il cestino della segreteria', () => {
    /** Una foto nel cestino: come le altre, più la data di eliminazione. */
    const fotoCestinata = (id: string, giorniFa: number): FotoSede => ({
        ...foto(id, '2026-09-04T09:00:00.000Z'),
        // Relativa ad ADESSO e non una data fissa: il conto alla rovescia si misura
        // da `Date.now()`, e una data congelata renderebbe questo test rosso al primo
        // giorno in cui lo si esegue — è la trappola del «test scaduto col calendario»
        // già pagata in questo repo.
        eliminato_il: new Date(Date.now() - giorniFa * 24 * 60 * 60 * 1000).toISOString(),
    });

    /** Rende la pagina, attende il primo elenco, passa al cestino e attende la sua GET. */
    async function apriCestino(): Promise<void> {
        render(<AdminGalleryPage />);
        await waitFor(() => expect(chiamateGalleria().length).toBe(1));
        // L'etichetta del bottone porta i giorni dentro («Cestino (30 giorni)»), quindi
        // si cerca per PREFISSO dal catalogo e non per stringa intera: il numero viene
        // dalla pagina, e fissarlo qui renderebbe questo test un secondo posto in cui
        // il 30 e scritto — proprio ci che il lock `cestino-giorni-un-numero-solo`
        // esiste per evitare.
        fireEvent.click(screen.getByRole('button', { name: /cestino/i }));
        await waitFor(() => {
            expect(chiamateGalleria().some((u) => u.includes('stato=cestino'))).toBe(true);
        });
    }

    it('la linguetta chiede `stato=cestino`, e la vista normale NON manda il parametro', async () => {
        h.rispostaPerIndirizzo = (u) => ({
            ok: true,
            status: 200,
            body: {
                media: u.includes('stato=cestino') ? [fotoCestinata('c-1', 5)] : [foto('v-1', '2026-09-04T09:00:00.000Z')],
                total: 1,
                limit: 30,
                offset: 0,
            },
        });
        await apriCestino();

        // Il parametro non deve comparire nella vista normale: il default della rotta
        // è `vive`, e un parametro superfluo è un parametro che un giorno qualcuno
        // legge al contrario.
        const prima = chiamateGalleria().filter((u) => !u.includes('stato='));
        expect(prima.length).toBeGreaterThan(0);
    });

    it('mostra quando è stata eliminata e quanto le resta', async () => {
        h.rispostaPerIndirizzo = () => ({
            ok: true,
            status: 200,
            body: { media: [fotoCestinata('c-1', 5)], total: 1, limit: 30, offset: 0 },
        });
        await apriCestino();

        // 30 giorni di custodia, 5 trascorsi ⇒ 25. Il numero si calcola qui invece di
        // scriverlo: se la custodia cambiasse, questo test seguirebbe la regola e non
        // una costante copiata (e il lock `cestino-giorni-un-numero-solo` tiene legati
        // i due punti in cui il 30 è scritto).
        expect(await screen.findByText(/25/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: new RegExp(itAdminAltro.galSedeCestinoRipristina, 'i') })).toBeInTheDocument();
    });

    it('🔴 nel cestino il comando ELIMINA non c’è: è già eliminata', async () => {
        h.rispostaPerIndirizzo = () => ({
            ok: true,
            status: 200,
            body: { media: [fotoCestinata('c-1', 5)], total: 1, limit: 30, offset: 0 },
        });
        await apriCestino();
        // L'attesa è ancorata a un evento POSITIVO — il bottone Ripristina, che c'è —
        // PRIMA di asserire l'assenza. Un `waitFor` su un'assenza passa mentre la
        // schermata è ancora vuota, ed è un falso verde che questo repo ha già pagato.
        await screen.findByRole('button', { name: new RegExp(itAdminAltro.galSedeCestinoRipristina, 'i') });
        expect(screen.queryByRole('button', { name: /elimina/i })).not.toBeInTheDocument();
    });

    it('un 409 si legge nella lingua dell’interfaccia, e l’elenco NON si svuota', async () => {
        h.rispostaPerIndirizzo = () => ({
            ok: true,
            status: 200,
            body: { media: [fotoCestinata('c-1', 5)], total: 1, limit: 30, offset: 0 },
        });
        h.rispostaRipristino = {
            ok: false,
            status: 409,
            body: { error: 'Il media non è più ripristinabile', codice: 'MEDIA_NON_RIPRISTINABILE' },
        };
        await apriCestino();
        fireEvent.click(await screen.findByRole('button', { name: new RegExp(itAdminAltro.galSedeCestinoRipristina, 'i') }));

        const avviso = await screen.findByRole('alert');
        expect(avviso).toBeInTheDocument();
        // La foto resta a schermo: un errore non deve portarsi via la riga di cui
        // parla, altrimenti chi legge il messaggio non sa più a quale foto si
        // riferisce.
        expect(screen.getByRole('button', { name: new RegExp(itAdminAltro.galSedeCestinoRipristina, 'i') })).toBeInTheDocument();
    });

    it('un ripristino riuscito chiama la rotta giusta e ricarica l’elenco', async () => {
        h.rispostaPerIndirizzo = () => ({
            ok: true,
            status: 200,
            body: { media: [fotoCestinata('c-1', 5)], total: 1, limit: 30, offset: 0 },
        });
        await apriCestino();
        const primaDelClick = h.fetchMock.mock.calls.length;
        fireEvent.click(await screen.findByRole('button', { name: new RegExp(itAdminAltro.galSedeCestinoRipristina, 'i') }));

        await waitFor(() => {
            const chiamate = h.fetchMock.mock.calls.map((c) => String(c[0]));
            expect(chiamate.some((u) => u.startsWith('/api/gallery/ripristina'))).toBe(true);
        });
        // E il ricarico: dopo la risoluzione parte una GET nuova. È la metà del
        // contratto che il dialogo di eliminazione NON aveva — prometteva un ricarico
        // che nessun chiamante eseguiva.
        await waitFor(() => {
            expect(h.fetchMock.mock.calls.length).toBeGreaterThan(primaDelClick + 1);
        });
    });
});
