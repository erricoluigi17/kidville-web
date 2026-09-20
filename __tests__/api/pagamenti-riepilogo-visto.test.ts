import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * «HO GUARDATO IL RIEPILOGO E NON HO ANNULLATO» → ORA SI AVVISANO LE FAMIGLIE.
 *
 * `POST /api/pagamenti/riconciliazione/riepilogo-visto`
 *
 * ─── PERCHÉ QUESTA ROTTA ESISTE, in una riga ────────────────────────────────
 * La fase automatica NON avvisa nessuno, per decisione esplicita del titolare:
 * «un avviso mandato non si disfa». Se la macchina sbaglia e la segreteria
 * annulla in blocco, la famiglia avrebbe già ricevuto «Pagamento registrato»
 * per un incasso che sta per sparire. L'avviso aspetta quindi il gesto umano —
 * qualcuno ha guardato l'elenco e l'ha lasciato stare.
 *
 * ─── LE QUATTRO COSE CHE QUESTI TEST TENGONO FERME ──────────────────────────
 *  1. **Idempotenza vera**, non il `debounce`: due chiamate non avvisano due
 *     volte. Il confronto è fra `notifiche.creato_il` e `abbinato_auto_il` —
 *     la marca stessa — così un avviso di MESI FA per un'altra rata non blocca
 *     questo, e questo non si ripete.
 *  2. **Fail-CLOSED**: se non si può sapere chi è già stato avvisato, non si
 *     manda niente. Un avviso doppio non si ritira; uno non ancora partito si
 *     manda riaprendo il riepilogo.
 *  3. **La composita avvisa TUTTI i figli**, non solo quello della voce àncora:
 *     le voci vere si leggono dagli incassi della transazione, come fa il
 *     percorso manuale.
 *  4. **Le stesse due frasi del percorso manuale**: la famiglia non deve poter
 *     distinguere un incasso registrato a mano da uno riconosciuto
 *     dall'applicazione.
 *  5. **LA FINESTRA DI LETTURA COPRE L'IMPORT INTERO**, e non il bersaglio
 *     dell'annullo. È il difetto che il quinto blocco di test chiude: finché
 *     questa rotta riusava il tetto dell'annullo (200) su un import che la fase
 *     automatica può chiudere fino a 500, gli avvisi partivano sempre per le
 *     PRIME 200 righe — le stesse a ogni riapertura, perché l'ordine è stabile e
 *     notificare non cambia lo stato della riga — e dalla 201ª in poi le famiglie
 *     non venivano avvisate mai. In silenzio, e senza rimedio: su quell'import
 *     anche l'annullo in blocco rifiuta.
 */

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(),
    logErrore: vi.fn(),
    logEvento: vi.fn(),
    logOk: vi.fn(),
    notificaEvento: vi.fn(),
    righe: [] as Record<string, unknown>[],
    righeError: null as { code: string; message: string } | null,
    incassi: [] as Record<string, unknown>[],
    incassiError: null as { code: string; message: string } | null,
    pagamenti: [] as Record<string, unknown>[],
    pagamentiError: null as { code: string; message: string } | null,
    notifiche: [] as Record<string, unknown>[],
    notificheError: null as { code: string; message: string } | null,
    letture: [] as { table: string; filtri: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/logging/logger', () => ({ logOk: h.logOk, logErrore: h.logErrore, logEvento: h.logEvento }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => finto() }))

function finto() {
    return {
        from: (table: string) => {
            const filtri: Record<string, unknown> = {}
            const b: Record<string, unknown> = {}
            b.select = (cols?: string) => { b._cols = cols ?? ''; return b }
            b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
            b.in = (c: string, v: unknown) => { filtri[c] = v; return b }
            b.not = (c: string, op: string, v: unknown) => { filtri[`not:${c}`] = `${op}:${String(v)}`; return b }
            b.order = () => b
            b.range = (da: number, a: number) => { filtri.range = [da, a]; return b }
            b.then = (resolve: (v: unknown) => unknown) => {
                h.letture.push({ table, filtri: { ...filtri } })
                if (table === 'riconciliazione_movimenti') {
                    if (h.righeError) return resolve({ data: null, error: h.righeError })
                    const [da, a] = (filtri.range as number[]) ?? [0, 99]
                    return resolve({ data: h.righe.slice(da, a + 1), error: null })
                }
                if (table === 'incassi') return resolve({ data: h.incassiError ? null : h.incassi, error: h.incassiError })
                if (table === 'pagamenti') return resolve({ data: h.pagamentiError ? null : h.pagamenti, error: h.pagamentiError })
                if (table === 'notifiche') return resolve({ data: h.notificheError ? null : h.notifiche, error: h.notificheError })
                return resolve({ data: [], error: null })
            }
            return b
        },
    }
}

import { POST } from '@/app/api/pagamenti/riconciliazione/riepilogo-visto/route'
import { TETTO_ANNULLO, TETTO_FINESTRA } from '@/lib/pagamenti/righe-automatiche'

const IMP = 'ffffffff-ffff-4fff-8fff-fffffffffff0'
const M1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const P2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const TX = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
const AL1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const AL2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
/** La marca dell'abbinamento automatico: è il perno dell'idempotenza. */
const MARCA = '2026-09-20T08:00:00.000Z'

const post = (body: unknown) =>
    POST(
        new Request('http://localhost/api/pagamenti/riconciliazione/riepilogo-visto', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }) as never,
    )

const riga = (over: Record<string, unknown> = {}) => ({
    id: M1,
    scuola_id: 'sc-1',
    data_operazione: '2026-09-18',
    importo: 150,
    causale: 'BONIFICO RETTA',
    controparte: 'MARIO ROSSI',
    pagamento_id: P1,
    incasso_id: 'inc-1',
    transazione_id: null,
    abbinato_auto_il: MARCA,
    ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    h.letture = []
    h.righe = [riga()]
    h.righeError = null
    h.incassi = []
    h.incassiError = null
    h.pagamenti = [{ id: P1, alunno_id: AL1, stato: 'pagato', descrizione: 'Retta ottobre' }]
    h.pagamentiError = null
    h.notifiche = []
    h.notificheError = null
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('l’avviso parte, con le frasi del percorso manuale', () => {
    it('una voce singola SALDATA: «Pagamento registrato», entità `pagamento`', async () => {
        const res = await post({ import_id: IMP })
        expect(res.status).toBe(200)
        const j = (await res.json()) as { data: { notificati: number; gia_notificati: number } }
        expect(j.data.notificati).toBe(1)
        expect(j.data.gia_notificati).toBe(0)
        expect(h.notificaEvento).toHaveBeenCalledTimes(1)
        const arg = h.notificaEvento.mock.calls[0][1] as Record<string, unknown>
        expect(arg.tipo).toBe('pagamento_registrato')
        expect(arg.titolo).toBe('Pagamento registrato')
        expect(arg.entitaTipo).toBe('pagamento')
        expect(arg.entitaId).toBe(P1)
        expect(arg.alunnoIds).toEqual([AL1])
        expect(arg.scuolaId).toBe('sc-1')
    })

    it('una voce ancora PARZIALE: «Acconto registrato», come sul pulsante singolo', async () => {
        h.pagamenti = [{ id: P1, alunno_id: AL1, stato: 'parziale', descrizione: 'Retta ottobre' }]
        await post({ import_id: IMP })
        const arg = h.notificaEvento.mock.calls[0][1] as Record<string, unknown>
        expect(arg.titolo).toBe('Acconto registrato')
    })

    it('🔴 una COMPOSITA avvisa tutti i figli, non solo quello della voce àncora', async () => {
        h.righe = [riga({ transazione_id: TX })]
        // Le voci vere della transazione: due bambini diversi.
        h.incassi = [
            { pagamento_id: P1, transazione_id: TX },
            { pagamento_id: P2, transazione_id: TX },
        ]
        h.pagamenti = [
            { id: P1, alunno_id: AL1, stato: 'pagato', descrizione: 'Retta Anna' },
            { id: P2, alunno_id: AL2, stato: 'pagato', descrizione: 'Retta Luca' },
        ]
        await post({ import_id: IMP })
        expect(h.notificaEvento).toHaveBeenCalledTimes(1)
        const arg = h.notificaEvento.mock.calls[0][1] as Record<string, unknown>
        expect(arg.entitaTipo).toBe('transazione')
        expect(arg.entitaId).toBe(TX)
        expect(arg.alunnoIds).toEqual([AL1, AL2])
    })

    it('una riga senza alunno non avvisa nessuno, e il fatto si CONTA', async () => {
        h.pagamenti = [{ id: P1, alunno_id: null, stato: 'pagato', descrizione: 'Retta' }]
        const res = await post({ import_id: IMP })
        const j = (await res.json()) as { data: { notificati: number; senza_alunno: number } }
        expect(j.data.notificati).toBe(0)
        expect(j.data.senza_alunno).toBe(1)
        expect(h.notificaEvento).not.toHaveBeenCalled()
    })
})

describe('l’idempotenza — la tabella `notifiche`, non il debounce', () => {
    it('🔴 un avviso già creato DOPO la marca ⇒ non si manda niente', async () => {
        h.notifiche = [{ entita_id: P1, creato_il: '2026-09-20T08:05:00.000Z' }]
        const res = await post({ import_id: IMP })
        const j = (await res.json()) as { data: { notificati: number; gia_notificati: number } }
        expect(j.data.notificati).toBe(0)
        expect(j.data.gia_notificati).toBe(1)
        expect(h.notificaEvento).not.toHaveBeenCalled()
    })

    it('un avviso PRECEDENTE alla marca non blocca: è un’altra rata, non questa', async () => {
        h.notifiche = [{ entita_id: P1, creato_il: '2026-08-01T10:00:00.000Z' }]
        const res = await post({ import_id: IMP })
        const j = (await res.json()) as { data: { notificati: number; gia_notificati: number } }
        expect(j.data.notificati).toBe(1)
        expect(j.data.gia_notificati).toBe(0)
    })

    it('un avviso creato nello STESSO istante della marca vale come già mandato', async () => {
        // `creato_il` ha default `now()`, e la marca è scritta nello stesso
        // istante logico: il confronto è `>=`, non `>`, o il secondo giro
        // rimanderebbe l'avviso appena partito.
        h.notifiche = [{ entita_id: P1, creato_il: MARCA }]
        const res = await post({ import_id: IMP })
        const j = (await res.json()) as { data: { gia_notificati: number } }
        expect(j.data.gia_notificati).toBe(1)
    })

    it('si guarda il tipo giusto e le entità giuste: la query lo dice', async () => {
        await post({ import_id: IMP })
        const q = h.letture.find((l) => l.table === 'notifiche')
        expect(q?.filtri.tipo).toBe('pagamento_registrato')
        expect(q?.filtri.entita_id).toEqual([P1])
    })
})

describe('fail-CLOSED: nel dubbio non si manda niente', () => {
    it('`notifiche` non letta ⇒ 503 e ZERO avvisi', async () => {
        h.notificheError = { code: '57014', message: 'statement timeout' }
        const res = await post({ import_id: IMP })
        expect(res.status).toBe(503)
        const j = (await res.json()) as { codice: string }
        expect(j.codice).toBe('RIEPILOGO_NOTIFICHE_NON_INVIATE')
        expect(h.notificaEvento).not.toHaveBeenCalled()
        expect(h.logErrore).toHaveBeenCalled()
    })

    it('`pagamenti` non letti ⇒ 503 e ZERO avvisi', async () => {
        h.pagamentiError = { code: '57014', message: 'statement timeout' }
        const res = await post({ import_id: IMP })
        expect(res.status).toBe(503)
        expect(h.notificaEvento).not.toHaveBeenCalled()
    })

    it('gli INCASSI di una composita non letti ⇒ 503: avvisare il solo àncora sarebbe peggio', async () => {
        // ⚠️ Peggio, e non «meno completo»: quell'avviso parziale verrebbe
        // registrato, e al secondo giro l'idempotenza lo troverebbe — rendendo
        // DEFINITIVA l'omissione degli altri figli.
        h.righe = [riga({ transazione_id: TX })]
        h.incassiError = { code: '57014', message: 'statement timeout' }
        const res = await post({ import_id: IMP })
        expect(res.status).toBe(503)
        expect(h.notificaEvento).not.toHaveBeenCalled()
    })

    it('marca assente (DB non migrato) ⇒ 200 a zero: non c’è niente da notificare', async () => {
        h.righeError = { code: '42703', message: 'column does not exist' }
        const res = await post({ import_id: IMP })
        expect(res.status).toBe(200)
        const j = (await res.json()) as { disponibile: boolean }
        expect(j.disponibile).toBe(false)
        expect(h.notificaEvento).not.toHaveBeenCalled()
    })

    it('nessuna riga automatica ⇒ 200 a zero, col log di SUCCESSO (regola 5)', async () => {
        h.righe = []
        const res = await post({ import_id: IMP })
        expect(res.status).toBe(200)
        const ok = h.logEvento.mock.calls.filter(
            (c) => (c[2] as { esito?: string })?.esito === 'riepilogo_visto_notifiche',
        )
        expect(ok).toHaveLength(1)
    })

    it('un `import_id` che non è un uuid è un 400, prima di ogni lettura', async () => {
        const res = await post({ import_id: 'non-un-uuid' })
        expect(res.status).toBe(400)
        expect(h.letture).toEqual([])
    })

    it('senza gate di ruolo non si legge niente', async () => {
        h.requireStaff.mockResolvedValue({ response: new Response('no', { status: 403 }) })
        const res = await post({ import_id: IMP })
        expect(res.status).toBe(403)
        expect(h.letture).toEqual([])
    })
})

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 LA FINESTRA: OLTRE IL TETTO DELL'ANNULLO NON SI PERDE NESSUNA FAMIGLIA.
 *
 * Il difetto chiuso qui aveva una forma precisa e silenziosa. La rotta leggeva
 * con il tetto dell'ANNULLO (200) un insieme che la fase automatica può
 * riempire fino a 500 (`MAX_AUTO_PER_IMPORT`). L'ordine di lettura è stabile
 * (`data_operazione, id`) e notificare NON cambia lo stato della riga: ogni
 * riapertura del riepilogo ripescava quindi le stesse prime righe — già
 * avvisate, quindi contate come «già notificate» — e quelle oltre la finestra
 * non entravano MAI fra i bersagli. Nessun errore, nessuna riga rossa: solo
 * famiglie che non ricevono un avviso che non sanno di aspettare.
 *
 * ⚠️ IL PRIMO TEST È QUELLO CHE MORDE, e il numero è scelto apposta: 350 righe
 * stanno oltre il tetto dell'annullo e dentro la finestra della notifica. Col
 * codice difettoso il primo giro ne avvisa 201 (il tetto più uno) e il secondo
 * zero — le ultime 149 famiglie non vengono raggiunte in nessuno dei due.
 */
describe('la finestra della notifica è quella dell’import, non quella dell’annullo', () => {
    const molte = (n: number) =>
        Array.from({ length: n }, (_, i) => riga({ id: `m${i}`, pagamento_id: `p${i}` }))
    const vociDi = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
            id: `p${i}`,
            alunno_id: `al${i}`,
            stato: 'pagato',
            descrizione: 'Retta ottobre',
        }))
    const avvisate = () =>
        new Set(h.notificaEvento.mock.calls.map((c) => String((c[1] as { entitaId: string }).entitaId)))

    it('🔴 350 righe: le avvisa TUTTE, comprese quelle oltre il tetto dell’annullo', async () => {
        const N = 350
        h.righe = molte(N)
        h.pagamenti = vociDi(N)

        const res = await post({ import_id: IMP })
        expect(res.status).toBe(200)
        const j = (await res.json()) as { data: { notificati: number; letti: number; troncato: boolean } }
        expect(j.data.letti).toBe(N)
        expect(j.data.notificati).toBe(N)
        // Dentro la finestra strutturale: non è un troncamento, ed è la
        // differenza fra «non ho potuto» e «non ho voluto».
        expect(j.data.troncato).toBe(false)

        const primo = avvisate()
        expect(primo.size).toBe(N)
        // Le righe che il tetto dell'annullo lasciava fuori: sono queste a
        // rendere rosso il test sul codice difettoso.
        expect(primo.has(`p${TETTO_ANNULLO}`)).toBe(true)
        expect(primo.has(`p${N - 1}`)).toBe(true)
    })

    it('🔴 il secondo giro non ripesca gli stessi: nessuno due volte, nessuno mai', async () => {
        const N = 350
        h.righe = molte(N)
        h.pagamenti = vociDi(N)

        await post({ import_id: IMP })
        const primo = avvisate()

        // Il server registra gli avvisi appena mandati: è ciò che l'idempotenza
        // rilegge al giro dopo (la tabella `notifiche`, non il debounce).
        h.notifiche = [...primo].map((id) => ({ entita_id: id, creato_il: '2026-09-20T09:00:00.000Z' }))
        h.notificaEvento.mockClear()

        const res = await post({ import_id: IMP })
        const j = (await res.json()) as { data: { notificati: number; gia_notificati: number } }
        const secondo = avvisate()

        // 1. Il secondo giro NON rimanda gli stessi avvisi.
        expect([...secondo].filter((x) => primo.has(x))).toEqual([])
        expect(j.data.notificati).toBe(0)
        expect(j.data.gia_notificati).toBe(N)
        // 2. E fra i due giri non è rimasto fuori nessuno: è l'altra metà, e
        //    quella che il difetto violava — col tetto dell'annullo l'unione dei
        //    due giri restava ferma a 201 su 350.
        expect(new Set([...primo, ...secondo]).size).toBe(N)
    })

    it('oltre la finestra STRUTTURALE il troncamento si grida: `error` nel log e nella risposta', async () => {
        // L'unico modo di uscire troncati da questa rotta: duemila righe
        // automatiche in un import, quattro volte ciò che la fase automatica può
        // chiudere. Non è un `info` a piè di pagina — quelle famiglie non
        // verranno avvisate riaprendo il riepilogo, perché la lettura ripesca
        // sempre le stesse righe.
        const N = TETTO_FINESTRA + 1
        h.righe = molte(N)
        h.pagamenti = vociDi(N)

        const res = await post({ import_id: IMP })
        const j = (await res.json()) as { data: { letti: number; troncato: boolean } }
        expect(j.data.troncato).toBe(true)
        expect(j.data.letti).toBe(TETTO_FINESTRA)
        const gridato = h.logEvento.mock.calls.filter(
            (c) => c[1] === 'error' && (c[2] as { esito?: string })?.esito === 'riepilogo-visto-finestra-troncata',
        )
        expect(gridato).toHaveLength(1)
    })

    it('🔴 la finestra copre l’intera fase automatica, e il tetto dell’annullo no', () => {
        // Il rapporto fra le due costanti è il cuore del difetto, e un numero
        // scritto a mano qui sarebbe una copia che diverge: `MAX_AUTO_PER_IMPORT`
        // si legge dal file che lo dichiara.
        const src = fs.readFileSync(
            path.join(process.cwd(), 'src', 'lib', 'pagamenti', 'riconciliazione-auto-import.ts'),
            'utf8',
        )
        const m = /export\s+const\s+MAX_AUTO_PER_IMPORT\s*=\s*(\d+)/.exec(src)
        expect(m, '`MAX_AUTO_PER_IMPORT` non si legge più: il tetto della fase automatica è cambiato forma').not.toBeNull()
        const maxAuto = Number(m![1])

        expect(
            TETTO_FINESTRA,
            'La finestra della notifica non copre più ciò che la fase automatica può chiudere in un ' +
                'import: le righe oltre resterebbero senza avviso per sempre, e riaprire il riepilogo ' +
                'non le recupera.',
        ).toBeGreaterThan(maxAuto)
        expect(
            TETTO_ANNULLO,
            'Il tetto dell’annullo ha smesso di essere più basso di `MAX_AUTO_PER_IMPORT`: se fosse ' +
                'diventato abbastanza largo, le due finestre potrebbero tornare una sola — ma allora ' +
                'questa rotta va rivista, non lasciata a un parametro che non serve più.',
        ).toBeLessThan(maxAuto)
    })
})

describe('il perimetro NON si restringe: è la coda della deroga cross-sede', () => {
    it('avvisa anche le famiglie di una sede che chi opera non gestisce', async () => {
        // L'abbinamento automatico ha lavorato su tutte e tre le sedi. Se qui si
        // restringesse, quelle famiglie non riceverebbero l'avviso MAI — nessun
        // altro aprirà il riepilogo di quell'import.
        h.righe = [riga({ scuola_id: 'sc-3' })]
        const res = await post({ import_id: IMP })
        const j = (await res.json()) as { data: { notificati: number } }
        expect(j.data.notificati).toBe(1)
        const arg = h.notificaEvento.mock.calls[0][1] as Record<string, unknown>
        // Il toggle si valuta sulla sede in cui il denaro è stato registrato.
        expect(arg.scuolaId).toBe('sc-3')
    })
})
