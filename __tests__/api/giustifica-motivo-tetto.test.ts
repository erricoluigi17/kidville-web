import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { MOTIVO_MAX_CARATTERI } from '@/lib/presenze/limiti-testo'

/**
 * IL TETTO SUL MOTIVO VALE ANCHE SULLA SECONDA PORTA.
 *
 * Rilievo M14 del collaudo del 2026-08-07: «il motivo dell'assenza non ha limite di lunghezza
 * — 200 KB di testo libero accettati e memorizzati in `presenze.giustificazione_testo`, dato
 * sanitario di un minore». Il tetto è stato messo su `comunica-assenza`, ma il rilievo diceva
 * anche l'altra metà: *«il tetto va anche sul gemello `parent/presenze/giustifica`, che scrive
 * la stessa colonna»*. Quella metà era rimasta aperta, e da lì la colonna si scrive lo stesso
 * — con in più una firma elettronica appesa.
 *
 * PERCHÉ IL CONTROLLO NON STA IN ZOD, come sul gemello: lo schema decide PRIMA di
 * `requireParentOfStudent`, e un 400 emesso lì scavalcherebbe il 403 sul figlio altrui, che è
 * ciò che la prova adversarial pretende. Il confine vive nell'handler, dopo il gate.
 *
 * E STA PRIMA DELL'OTP, che è la parte che si vede solo provandola: un motivo fuori misura non
 * deve consumare un tentativo di verifica del codice a sei cifre — il budget di quei tentativi
 * è un presidio di sicurezza (`limitaVerificaOtp`), e bruciarlo con un errore di forma
 * significherebbe far pagare a un genitore distratto la protezione pensata per chi indovina.
 */

const STUDENT = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const PARENT = 'u1u1u1u1-0000-4000-8000-000000000001'
const TODAY = new Date().toISOString().slice(0, 10)

const h = vi.hoisted(() => {
    const state = {
        queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
        used: {} as Record<string, number>,
        updateCalled: 0,
        /** Il testo davvero passato all'UPDATE: quello che finirebbe in tabella. */
        testoScritto: null as unknown,
        /**
         * L'INTERA riga passata all'UPDATE. Serve a distinguere «la colonna è
         * stata scritta a null» da «la colonna non è stata nominata affatto»:
         * su PostgREST la prima azzera, la seconda lascia stare, e `testoScritto`
         * da solo vale `undefined` in entrambi i casi.
         */
        rigaScritta: null as Record<string, unknown> | null,
    }
    function take(table: string) {
        const q = state.queues[table] || []
        const i = state.used[table] ?? 0
        state.used[table] = i + 1
        return q[i] ?? { data: null, error: null }
    }
    function makeClient() {
        return {
            from(table: string) {
                const qb: Record<string, unknown> = {}
                for (const m of ['select', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
                qb.update = (riga: Record<string, unknown>) => {
                    state.updateCalled++
                    state.testoScritto = riga.giustificazione_testo
                    state.rigaScritta = riga
                    return qb
                }
                qb.single = () => Promise.resolve(take(table))
                qb.maybeSingle = () => Promise.resolve(take(table))
                qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
                    Promise.resolve(take(table)).then(res, rej)
                return qb
            },
        }
    }
    return { state, makeClient, requireParent: vi.fn(), assertGenitore: vi.fn() }
})

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: vi.fn().mockResolvedValue(h.makeClient()) }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
const otp = vi.hoisted(() => ({ getUserEmail: vi.fn(), verifyTicket: vi.fn(), codeHash: vi.fn() }))
vi.mock('@/lib/auth/otp-ticket', () => otp)
const tetto = vi.hoisted(() => ({ limitaVerificaOtp: vi.fn() }))
vi.mock('@/lib/security/otp-rate-limit', () => tetto)
const cfg = vi.hoisted(() => ({ getModuleConfig: vi.fn() }))
vi.mock('@/lib/settings/module-config', () => cfg)
vi.mock('@/lib/fea/slots', () => ({ recordSignerSlot: vi.fn() }))
vi.mock('@/lib/fea/audit', () => ({ logFeaEvent: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: vi.fn().mockResolvedValue([]) }))

const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
    logEvento: (...a: unknown[]) => logEvento(...a),
    logErrore: (...a: unknown[]) => logErrore(...a),
    logOk: vi.fn(),
}))

import { POST } from '@/app/api/parent/presenze/giustifica/route'

const req = (body: unknown): NextRequest =>
    new NextRequest('http://localhost/api/parent/presenze/giustifica', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    })

const codaBuona = () => ({
    alunni: [{ data: { id: STUDENT, section_id: 'sec-1', scuola_id: 'sc-1' }, error: null }],
    sections: [{ data: { school_type: 'primaria' }, error: null }],
    // DUE letture su `presenze`, in quest'ordine:
    //  1. il testo ARCHIVIATO, che la rotta ora legge prima di scrivere — serve
    //     a decidere se la presa visione del docente decade (rilievo Q5);
    //  2. l'esito dell'UPDATE.
    // Senza la prima voce la coda si sfasa e ogni caso «buono» esce 404: un
    // rosso che non parla del merito.
    presenze: [
        { data: { giustificazione_testo: null }, error: null },
        { data: { id: 'p-1', giustificata: true }, error: null },
    ],
})

beforeEach(() => {
    vi.clearAllMocks()
    h.state.queues = codaBuona()
    h.state.used = {}
    h.state.updateCalled = 0
    h.state.testoScritto = null
    h.state.rigaScritta = null
    h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
    h.assertGenitore.mockResolvedValue(null)
    otp.getUserEmail.mockResolvedValue('genitore@example.it')
    otp.verifyTicket.mockReturnValue({ ok: true })
    otp.codeHash.mockReturnValue('SHA256-MOCKEDHASH')
    tetto.limitaVerificaOtp.mockResolvedValue(null)
    cfg.getModuleConfig.mockResolvedValue({ giustifica_max_giorni_retroattivi: 5, giustifica_richiede_firma_otp: true })
})

const invia = (motivo: unknown) =>
    POST(req({ studentId: STUDENT, data: TODAY, motivo, code: '424242', expiry: 999, ticket: 't' }))

describe('POST /api/parent/presenze/giustifica — il motivo ha una misura massima (M14)', () => {
    it(`oltre ${MOTIVO_MAX_CARATTERI} caratteri: 400 col codice, e NIENTE in tabella`, async () => {
        const res = await invia('x'.repeat(MOTIVO_MAX_CARATTERI + 1))
        expect(res.status).toBe(400)
        expect((await res.json()).codice).toBe('ASSENZA_MOTIVO_TROPPO_LUNGO')
        expect(h.state.updateCalled, 'il rifiuto deve precedere la scrittura').toBe(0)
    })

    it('il rifiuto non consuma un tentativo di verifica dell’OTP', async () => {
        await invia('x'.repeat(MOTIVO_MAX_CARATTERI + 1))
        expect(tetto.limitaVerificaOtp).not.toHaveBeenCalled()
        expect(otp.verifyTicket).not.toHaveBeenCalled()
    })

    it('il log del rifiuto porta la LUNGHEZZA, mai il testo: è un dato sanitario di un minore', async () => {
        const motivo = `varicella ${'x'.repeat(MOTIVO_MAX_CARATTERI)}`
        await invia(motivo)
        const riga = logEvento.mock.calls.find(
            (c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_MOTIVO_TROPPO_LUNGO'),
        )
        expect(riga, 'un rifiuto che nessuno può contare è un rifiuto che nessuno scopre').toBeTruthy()
        expect(riga?.[2]).toMatchObject({
            operazione: 'parent/presenze/giustifica:POST',
            error_code: 'ASSENZA_MOTIVO_TROPPO_LUNGO',
            n: motivo.length,
        })
        expect(JSON.stringify(logEvento.mock.calls)).not.toContain('varicella')
    })

    it(`esattamente ${MOTIVO_MAX_CARATTERI} caratteri passano: il confine è dove è scritto`, async () => {
        const motivo = 'x'.repeat(MOTIVO_MAX_CARATTERI)
        const res = await invia(motivo)
        expect(res.status).toBe(200)
        expect(h.state.testoScritto).toBe(motivo)
    })

    it('si misura il testo NORMALIZZATO: gli spazi in coda non fanno rifiutare', async () => {
        // Rifiutare per gli spazi che il genitore non vede sarebbe un rifiuto che non può
        // capire guardando ciò che ha scritto. È la stessa regola del gemello.
        const res = await invia('x'.repeat(MOTIVO_MAX_CARATTERI) + '   ')
        expect(res.status).toBe(200)
        expect(h.state.testoScritto).toBe('x'.repeat(MOTIVO_MAX_CARATTERI))
    })

    it('un motivo che non è una stringa resta ammesso, e vale come ASSENTE', async () => {
        // Lo schema è volutamente permissivo sul TIPO: la permissività non doveva estendersi
        // alla DIMENSIONE, ma non va nemmeno stretta oltre ciò che il rilievo chiedeva.
        //
        // ⚠️ QUESTA ASSERZIONE È CAMBIATA, e non per far tacere un rosso. Diceva
        // «diventa null»: era vero, ed era il difetto M21 — su un UPDATE scrivere
        // `null` AZZERA il motivo sanitario già archiviato. Un corpo malformato è
        // la forma più probabile di client vecchio o rotto, cioè esattamente il
        // caso in cui non si deve distruggere niente. Ora la colonna non viene
        // nominata: non «scritta a null», proprio non scritta.
        const res = await invia({ oggetto: 'qualunque' })
        expect(res.status).toBe(200)
        expect(Object.keys(h.state.rigaScritta ?? {})).not.toContain('giustificazione_testo')
    })
})


// ═══════════════════════════════════════════════════════════════════════════════
// LA PORTA GEMELLA AVEVA LA STESSA FAMIGLIA DI DIFETTI, E NESSUNO L'AVEVA APERTA
//
// L'onda 1 di questo ciclo ha chiuso su `comunica-assenza` tre cose: la risposta
// che restituiva l'intera riga (firma compresa: email, IP e user agent), il
// messaggio grezzo di PostgREST mostrato a un genitore, e il motivo azzerato da un
// campo vuoto. `giustifica` scrive LA STESSA COLONNA della stessa tabella, e le
// aveva tutte e tre — con in più una firma elettronica appesa.
//
// È la lezione già scritta nella memoria di questo repo dopo il ciclo 2: «una
// regola valida per due strade deve vivere in un posto solo». Qui le strade sono
// due e la regola era su una sola.
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /api/parent/presenze/giustifica — ciò che la porta gemella aveva già imparato', () => {
    it('il motivo VUOTO non azzera quello archiviato: la colonna non viene proprio nominata', async () => {
        const res = await invia('')
        expect(res.status).toBe(200)
        expect(h.state.updateCalled, 'la giustifica deve comunque essere registrata').toBe(1)
        // Non basta che `testoScritto` sia `undefined`: lo sarebbe anche se la
        // chiave ci fosse con valore `undefined`, che PostgREST serializza.
        expect(Object.keys(h.state.rigaScritta ?? {})).not.toContain('giustificazione_testo')
        // …e il resto della giustifica dev'esserci: la firma è il punto di questa rotta.
        expect(h.state.rigaScritta).toHaveProperty('giustificazione_firma')
        expect(h.state.rigaScritta).toHaveProperty('giustificata', true)
    })

    it('un motivo VERO si scrive: correggere il testo resta possibile', async () => {
        await invia('visita medica')
        expect(Object.keys(h.state.rigaScritta ?? {})).toContain('giustificazione_testo')
        expect(h.state.testoScritto).toBe('visita medica')
    })

    it('la risposta non riporta la firma né la nota del docente', async () => {
        h.state.queues.presenze = [
            {
                data: {
                    id: 'p-1',
                    giustificata: true,
                    note_appello: 'la maestra ha annotato qualcosa sul bambino',
                    registrato_da: 'd0000000-0000-4000-8000-000000000001',
                    giustificazione_firma: {
                        method: 'OTP_EMAIL',
                        email: 'genitore@example.it',
                        ip: '203.0.113.9',
                        userAgent: 'Mozilla/5.0 (iPhone)',
                    },
                },
                error: null,
            },
        ]
        const res = await invia('febbre')
        const corpo = JSON.stringify(await res.json())
        expect(corpo).not.toContain('giustificazione_firma')
        expect(corpo).not.toContain('203.0.113.9')
        expect(corpo).not.toContain('Mozilla')
        expect(corpo).not.toContain('note_appello')
        expect(corpo).not.toContain('registrato_da')
    })

    it('un guasto di scrittura non manda al genitore la prosa di PostgREST, e non resta muto nel log', async () => {
        h.state.queues.presenze = [
            // 1ª lettura: il testo archiviato (rilievo Q5), qui va a buon fine.
            { data: { giustificazione_testo: null }, error: null },
            // 2ª: l'UPDATE, che è quello che deve fallire in questo caso.
            {
                data: null,
                error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "unique_presenza_giornaliera"',
                },
            },
        ]
        const res = await invia('febbre')
        expect(res.status).toBe(500)
        const corpo = await res.json()
        expect(JSON.stringify(corpo)).not.toContain('duplicate key')
        expect(JSON.stringify(corpo)).not.toContain('unique_presenza_giornaliera')
        expect(corpo.codice, 'ogni rifiuto di questa rotta porta un codice traducibile').toBeTruthy()
        // E il messaggio intero deve restare DOVE dice perché.
        expect(JSON.stringify(logErrore.mock.calls)).toContain('duplicate key')
    })
})
