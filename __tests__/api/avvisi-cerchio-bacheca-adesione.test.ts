import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// 🔑 L'INVARIANTE: CIÒ CHE LA BACHECA OFFRE, IL SERVER ACCETTA.
//
// ─── IL DIFETTO, E DA DOVE NASCE ────────────────────────────────────────────
//
// Il 2026-09-19 `POST /api/avvisi/[id]/risposte` ha chiuso un buco di
// isolamento: un genitore con due figli in due plessi poteva rispondere a un
// avviso di UNA sede mandando lo `student_id` del figlio dell'ALTRA. Da quel
// giorno quell'accoppiamento è un **403 `ADESIONE_ALUNNO_FUORI_AVVISO`**.
//
// La bacheca, però, continuava a offrirlo. In `GET /api/avvisi`, ramo genitore,
// il ramo `target_scope === 'globale'` faceva `figliRiferiti = figli` — TUTTI i
// figli, senza nessun filtro sulla sede dell'avviso. Il feed è ristretto
// all'UNIONE delle sedi dei figli (`.in('scuola_id', scuoleFigli)`), quindi il
// genitore riceve i globali di entrambi i plessi: su quello di Giugliano si
// vedeva offrire anche il figlio di Aversa, toccava quel nome e leggeva
// «Questo avviso non riguarda il bambino indicato».
//
// ⚠️ L'argomento con cui il gate era stato approvato — «non è più stretto della
// bacheca, nessuno perde un bottone che vedeva» — valeva per il caso analizzato
// allora (l'uuid in `target_classes`, che già non compariva a nessuno) e NON per
// questo: qui il bottone c'era davvero, e il server ha smesso di onorarlo.
//
// ─── PERCHÉ UN TEST SULL'INVARIANTE E NON SUL CASO ──────────────────────────
//
// Un `it` che dicesse «il globale di SEDE_A non offre il figlio di SEDE_B»
// misurerebbe questo difetto e nessun altro: la prossima volta che le due regole
// divergeranno — su un `target_scope` nuovo, su una classe omonima fra plessi,
// su un figlio archiviato — sarebbe verde mentre il bottone rifiutato è tornato.
//
// Qui invece si ENUMERA ciò che la bacheca offre davvero (ogni avviso × ogni
// figlio nel suo `figli[]`) e si chiede al server, uno per uno, se lo accetta.
// È la stessa forma del test del «cerchio» già scritto per le due letture
// (`avvisi-risposte-cerchio-sede.test.ts`, «la stessa riga esce UGUALE dalle due
// letture»), applicata alle due regole che ora devono dire la stessa cosa:
// quella che DISEGNA i bottoni e quella che li ONORA.
//
// ─── LE DUE PROVE DI ROTTURA, ESEGUITE (2026-09-19) ─────────────────────────
//
//  1. tolto il `.filter` sulla sede dal ramo globale di `GET /api/avvisi`
//     (`? figli` com'era fino a ieri) → ROSSO l'`it` dell'invariante: la bacheca
//     offre 2 coppie che il server rifiuta con 403 `ADESIONE_ALUNNO_FUORI_AVVISO`.
//  2. rimesso il filtro → VERDE.
//
// ⚠️ E LA CONTROPROVA POSITIVA NON È DECORAZIONE: un filtro che non offrisse
// NIENTE passerebbe l'invariante a mani basse (zero coppie, zero rifiuti). Per
// questo l'invariante pretende che le coppie ci siano, e l'`it` che segue
// pretende che ogni figlio resti offerto sul globale del PROPRIO plesso.
// =============================================================================

const PARENT_ID = '33333333-3333-3333-3333-333333333333'
/** Il figlio iscritto a SEDE_A, sezione 1A. */
const ALU_A = '44444444-4444-4444-4444-444444444444'
/** Il fratello, iscritto a SEDE_B, sezione 2B. */
const ALU_B = '55555555-5555-5555-5555-555555555555'

const AV_GLOB_A = '11111111-1111-1111-1111-11111111000a'
const AV_GLOB_B = '11111111-1111-1111-1111-11111111000b'
const AV_CLASSE_1A = '11111111-1111-1111-1111-1111111100c1'

/**
 * Scadenza RELATIVA, mai una data scritta a mano: il feed toglie gli avvisi
 * scaduti con `.gte('scadenza_avviso', adesso)`, e una costante renderebbe questo
 * file rosso un giorno a caso per un motivo che non c'entra niente con ciò che
 * prova. La lezione del test scaduto col calendario: non si congela l'orologio,
 * si rende il test indipendente dalla data.
 */
const FRA_TRENTA_GIORNI = new Date(Date.now() + 30 * 86_400_000).toISOString()

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    requireDocente: vi.fn(),
    resolveScuoleAttive: vi.fn(),
    resolveScuolaScrittura: vi.fn(),
    getFigliDiGenitore: vi.fn(),
    genitoreHasFiglio: vi.fn(),
    assertGenitoreNonSospeso: vi.fn(),
    db: {} as Record<string, Riga[]>,
    /** Le RPC arrivate, per provare che una scrittura rifiutata non è partita. */
    rpc: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireUser: (...a: unknown[]) => h.requireUser(...a),
    requireDocente: (...a: unknown[]) => h.requireDocente(...a),
}))
vi.mock('@/lib/auth/scope', async (originale) => ({
    ...(await originale<typeof import('@/lib/auth/scope')>()),
    resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
    resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
    getFigliDiGenitore: (...a: unknown[]) => h.getFigliDiGenitore(...a),
    genitoreHasFiglio: (...a: unknown[]) => h.genitoreHasFiglio(...a),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
    assertGenitoreNonSospeso: (...a: unknown[]) => h.assertGenitoreNonSospeso(...a),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
    staffScuola: vi.fn(async () => []),
    genitoriDiScuola: vi.fn(async () => []),
    genitoriDiClassi: vi.fn(async () => []),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: vi.fn(async () => ({})) }))
vi.mock('@/lib/avvisi/target-gate', () => ({ verificaTargetAvvisoDocente: vi.fn(async () => null) }))
/**
 * Statistiche e autori: sostituiti perché sono I/O di contorno (conteggi
 * paginati, nomi degli autori) e qui non si misura nessuno dei due. Con
 * `importOriginal` restano veri `AUTORE_IGNOTO` e `STATS_ZERO`, che il payload
 * usa davvero.
 */
vi.mock('@/lib/avvisi/statistiche', async (originale) => ({
    ...(await originale<typeof import('@/lib/avvisi/statistiche')>()),
    statistichePerAvviso: vi.fn(async () => new Map()),
    autoriDegliAvvisi: vi.fn(async () => new Map()),
    rispostePerAvvisoDelGenitore: vi.fn(async () => new Map()),
}))
/** La firma degli allegati è un giro allo Storage: qui il payload passa intatto. */
vi.mock('@/lib/allegati/storage', async (originale) => ({
    ...(await originale<typeof import('@/lib/allegati/storage')>()),
    firmaAllegatiAvvisi: vi.fn(async (_c: unknown, righe: unknown) => righe),
}))

/**
 * UN POSTGREST CHE APPLICA DAVVERO `.eq`, `.in` E `.gte`.
 *
 * 🔑 È il punto su cui poggia tutto il file: se `.in('scuola_id', …)` non
 * togliesse righe, il feed sarebbe lo stesso con e senza l'isolamento e
 * l'invariante sarebbe verde per il motivo sbagliato — la prima delle cinque
 * forme di verde falso.
 */
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        rpc(nome: string, args: Record<string, unknown>) {
            if (nome !== 'avviso_adesione_registra') {
                throw new Error(`rpc non emulata in questo finto: ${nome}`)
            }
            h.rpc.push(args)
            return Promise.resolve({
                data: {
                    ok: true,
                    stato: args.p_risposta === 'si' ? 'ammessa' : null,
                    numero: args.p_numero ?? null,
                    prima_lettura: true,
                    prima_risposta: args.p_risposta != null,
                    posti_liberati: 0,
                    in_attesa: 0,
                    riga: { id: 'r-nuova', avviso_id: args.p_avviso_id, student_id: args.p_student_id },
                },
                error: null,
            })
        },
        from(tabella: string) {
            const filtri: Array<(r: Riga) => boolean> = []
            const righe = () => (h.db[tabella] ?? []).filter((r) => filtri.every((f) => f(r)))
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.order = () => b
            b.limit = () => b
            b.eq = (c: string, v: unknown) => { filtri.push((r) => r[c] === v); return b }
            b.in = (c: string, v: unknown[]) => { filtri.push((r) => v.includes(r[c])); return b }
            b.gte = (c: string, v: unknown) => {
                filtri.push((r) => typeof r[c] === 'string' && String(r[c]) >= String(v))
                return b
            }
            b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
            b.single = b.maybeSingle
            b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                Promise.resolve({ data: righe(), error: null }).then(ok, ko)
            return b
        },
    }),
}))

import { GET as BACHECA } from '@/app/api/avvisi/route'
import { POST as ADERISCI } from '@/app/api/avvisi/[id]/risposte/route'

const reqBacheca = () => ({
    url: 'http://test/api/avvisi',
    method: 'GET',
    headers: new Headers(),
    nextUrl: { searchParams: new URLSearchParams() },
    cookies: { get: () => undefined },
}) as never

const ctx = (avvisoId: string) => ({ params: Promise.resolve({ id: avvisoId }) })
const reqAdesione = (avvisoId: string, studentId: string) => ({
    url: `http://test/api/avvisi/${avvisoId}/risposte`,
    method: 'POST',
    headers: new Headers(),
    json: async () => ({ student_id: studentId, risposta: 'si', numero_partecipanti: 1 }),
}) as never

type AvvisoOfferto = { id: string; figli: Array<{ student_id: string; nome: string }> }

/** La bacheca del genitore, come la riceve il telefono. */
async function bacheca(): Promise<AvvisoOfferto[]> {
    const res = await BACHECA(reqBacheca())
    expect(res.status).toBe(200)
    return (await res.json()) as AvvisoOfferto[]
}

/** Ogni bottone «aderisci» che la bacheca disegna: un avviso e un bambino. */
function bottoni(feed: AvvisoOfferto[]): Array<{ avviso: string; alunno: string }> {
    return feed.flatMap((a) => a.figli.map((f) => ({ avviso: a.id, alunno: f.student_id })))
}

beforeEach(() => {
    vi.clearAllMocks()
    h.rpc = []
    h.db = {
        avvisi: [
            {
                id: AV_GLOB_A, author_id: 'aut-x', titolo: 'Chiusura Alfa', contenuto: 'x',
                tipo: 'adesione', target_scope: 'globale', target_classes: null,
                scadenza: null, scadenza_avviso: FRA_TRENTA_GIORNI, scadenza_adesione: FRA_TRENTA_GIORNI,
                attachment_url: null, created_at: '2026-09-03', scuola_id: SEDE_A,
            },
            {
                id: AV_GLOB_B, author_id: 'aut-x', titolo: 'Chiusura Beta', contenuto: 'y',
                tipo: 'adesione', target_scope: 'globale', target_classes: null,
                scadenza: null, scadenza_avviso: FRA_TRENTA_GIORNI, scadenza_adesione: FRA_TRENTA_GIORNI,
                attachment_url: null, created_at: '2026-09-02', scuola_id: SEDE_B,
            },
            {
                id: AV_CLASSE_1A, author_id: 'aut-x', titolo: 'Gita 1A', contenuto: 'z',
                tipo: 'adesione', target_scope: 'classe', target_classes: ['1A'],
                scadenza: null, scadenza_avviso: FRA_TRENTA_GIORNI, scadenza_adesione: FRA_TRENTA_GIORNI,
                attachment_url: null, created_at: '2026-09-01', scuola_id: SEDE_A,
            },
        ],
        // DUE FRATELLI IN DUE PLESSI: è il caso reale che il commento della rotta
        // di esportazione dichiara, ed è l'unico in cui il difetto si manifesta.
        // Con i figli in una sede sola il ramo globale offrirebbe gli stessi nomi
        // con e senza il filtro.
        alunni: [
            { id: ALU_A, nome: 'Bruna', cognome: 'Alfa', classe_sezione: '1A', scuola_id: SEDE_A },
            { id: ALU_B, nome: 'Nicola', cognome: 'Beta', classe_sezione: '2B', scuola_id: SEDE_B },
        ],
        avvisi_risposte: [],
        utenti: [{ id: 'aut-x', role: 'segreteria', ruolo: 'segreteria' }],
    }
    h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: SEDE_A }, response: null })
    h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
    h.getFigliDiGenitore.mockResolvedValue([ALU_A, ALU_B])
    h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
    h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE_A })
    // Il legame di famiglia C'È per entrambi: è esattamente il caso che
    // `genitoreHasFiglio` da solo lasciava passare.
    h.genitoreHasFiglio.mockResolvedValue(true)
    h.assertGenitoreNonSospeso.mockResolvedValue(null)
})

// ═════════════════════════════════════════════════════════════════════════════
describe('avvisi — LE DUE REGOLE NON POSSONO DIVERGERE', () => {
    it('🔑 ciò che la bacheca OFFRE, il server ACCETTA: ogni avviso × ogni figlio offerto', async () => {
        const feed = await bacheca()
        const coppie = bottoni(feed)

        // CONTROPROVA POSITIVA, e va PRIMA: senza, una bacheca che non offrisse
        // niente passerebbe l'invariante con zero coppie e zero rifiuti — cioè un
        // verde su un test che non ha provato niente.
        expect(
            coppie.length,
            'la bacheca non offre nessun bottone: l’invariante qui sotto non misurerebbe niente',
        ).toBeGreaterThan(0)

        const rifiutati: Array<Record<string, unknown>> = []
        for (const c of coppie) {
            const res = await ADERISCI(reqAdesione(c.avviso, c.alunno), ctx(c.avviso))
            if (res.status !== 200) {
                const corpo = (await res.json()) as { codice?: string }
                rifiutati.push({ ...c, status: res.status, codice: corpo.codice ?? null })
            }
        }

        expect(
            rifiutati,
            'la bacheca offre un bottone che il server rifiuta: il genitore tocca il nome di suo ' +
                'figlio e legge «questo avviso non riguarda il bambino indicato»',
        ).toEqual([])
    })

    it('il filtro toglie UNA riga, non tutte: ciascun figlio resta offerto dove gli spetta', async () => {
        const feed = await bacheca()
        const per = (id: string) => feed.find((a) => a.id === id)!.figli.map((f) => f.student_id).sort()

        // I due globali arrivano ENTRAMBI — il feed è l'unione delle sedi dei
        // figli — ma ciascuno offre il bambino del PROPRIO plesso e basta.
        expect(per(AV_GLOB_A)).toEqual([ALU_A])
        expect(per(AV_GLOB_B)).toEqual([ALU_B])
        // E il ramo per classe non è stato toccato: continua a rispondere per nome.
        expect(per(AV_CLASSE_1A)).toEqual([ALU_A])
    })

    it('🔴 il nome del figlio dell’altro plesso non compare sul globale di questa sede', async () => {
        // Il difetto come si vedeva a schermo, tenuto accanto all'invariante: è
        // l'`it` che dice COSA è successo il giorno in cui l'invariante diventa
        // rosso, e costa tre righe.
        const feed = await bacheca()
        const globA = feed.find((a) => a.id === AV_GLOB_A)!
        expect(globA.figli.map((f) => f.nome)).toEqual(['Bruna'])
        expect(JSON.stringify(globA)).not.toContain('Nicola')
    })

    it('la sede non esce nel payload del genitore: è letta per filtrare, non per essere mostrata', async () => {
        // `scuola_id` è entrata nella proiezione del ramo genitore per decidere i
        // figli di un globale. Una colonna letta per un uso interno non diventa un
        // campo pubblico per inerzia: è così che `posti_totali` era entrato una
        // volta, e da lì si ricavavano i posti liberi.
        const feed = await bacheca()
        for (const a of feed) {
            expect(Object.keys(a)).not.toContain('scuola_id')
            expect(Object.keys(a)).not.toContain('posti_totali')
        }
    })

    it('il server rifiuta ancora la coppia che la bacheca NON offre più', async () => {
        // L'altra metà dell'invariante: il filtro della bacheca non ha sostituito
        // il gate del server, che resta l'unica difesa contro una POST costruita a
        // mano. Senza questo `it`, togliere il gate e lasciare il filtro passerebbe
        // tutto il resto di questo file.
        const res = await ADERISCI(reqAdesione(AV_GLOB_A, ALU_B), ctx(AV_GLOB_A))

        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('ADESIONE_ALUNNO_FUORI_AVVISO')
        expect(h.rpc, 'la riga è stata scritta lo stesso: il gate non ferma niente').toEqual([])
    })
})
