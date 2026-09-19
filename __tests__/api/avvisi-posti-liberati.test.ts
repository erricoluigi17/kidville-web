import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/avvisi/[id]/risposte — LA NOTIFICA «SI SONO LIBERATI DEI POSTI».
 *
 * Decisione n. 28 del committente: quando un ritiro libera posti su un avviso con
 * gente in lista d'attesa, la segreteria riceve una notifica. Il tipo
 * `posti_liberati` era DICHIARATO (`src/lib/notifiche/tipi.ts`) e tradotto in
 * entrambe le lingue, ma `grep -rn "posti_liberati" src/` trovava una sola
 * occorrenza: la dichiarazione. Nessuno la emetteva — una funzione promessa al
 * committente, con le etichette già a posto, che non esisteva.
 *
 * COSA SORVEGLIA QUESTO FILE
 *  1. il ritiro di una riga AMMESSA con gente in coda emette, una volta sola, ai
 *     destinatari di `staffScuola` (segreteria della sede dell'avviso);
 *  2. senza coda NON emette — è il testo stesso dell'etichetta: se nessuno
 *     aspetta, non c'è niente da decidere;
 *  3. 🔴 asserzione NEGATIVA: nella notifica non entra nessun nome — né della
 *     famiglia, né del bambino — e nemmeno il TITOLO dell'avviso. Quel testo si
 *     legge a schermo bloccato, e «Marco Rossi si è ritirato dalla gita al museo»
 *     racconta a chiunque guardi il telefono che esiste un minore di nome Marco
 *     Rossi e dove doveva andare;
 *  4. `debounce: true` + `entitaId`: dieci ritiri sullo stesso avviso collassano
 *     in una riga sola invece di dieci notifiche.
 *
 * ⚠️ I DUE NUMERI ARRIVANO DALLA RPC, non da una query di questa route:
 * `posti_liberati` e `in_attesa` li calcola `avviso_adesione_registra` DOPO la
 * scrittura e DENTRO il proprio `FOR UPDATE` su `avvisi`. Il finto qui sotto li
 * restituisce come farebbe la funzione, ed è il motivo per cui ogni caso può
 * essere disegnato senza inventare una concorrenza che in un test non c'è.
 */

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'
const STUDENT_ID = '22222222-2222-2222-2222-222222222222'
const PARENT_ID = '33333333-3333-3333-3333-333333333333'
const SCUOLA_ID = '44444444-4444-4444-4444-444444444444'

/**
 * I dati personali che NON devono comparire nella notifica. Sono finti (il repo è
 * pubblico) ma stanno esattamente dove starebbero quelli veri: il titolo
 * dell'avviso è l'unico dei tre che un'implementazione distratta metterebbe nel
 * corpo «per far capire di quale avviso si parla».
 */
const TITOLO_AVVISO = 'Gita al museo di Capodimonte — sezione Primavera'
const NOME_ALUNNO = 'Nomefinto Cognomefinto'
const NOME_GENITORE = 'Genitorefinto Cognomefinto'

const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    requireDocente: vi.fn(),
    genitoreHasFiglio: vi.fn(),
    assertGenitoreNonSospeso: vi.fn(),
    notificaEvento: vi.fn(),
    staffScuola: vi.fn(),
    // L'esito della RPC, disegnato caso per caso dai test.
    esito: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireUser: h.requireUser,
    requireDocente: h.requireDocente,
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitoreNonSospeso }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: h.staffScuola }))
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => ({
        rpc(nome: string, args: Record<string, unknown>) {
            if (nome !== 'avviso_adesione_registra') {
                throw new Error(`rpc non emulata in questo finto: ${nome}`)
            }
            return Promise.resolve({
                data: {
                    riga: { id: 'r1', avviso_id: args.p_avviso_id, student_id: args.p_student_id },
                    ...h.esito,
                },
                error: null,
            })
        },
        from(table: string) {
            const b: Record<string, unknown> = {}
            b.select = () => b
            b.eq = () => b
            b.maybeSingle = async () => {
                // La riga dell'avviso porta il TITOLO: è lì che un'emissione
                // distratta andrebbe a pescarlo.
                if (table === 'avvisi') {
                    return { data: { author_id: 'aut-x', titolo: TITOLO_AVVISO, scuola_id: SCUOLA_ID }, error: null }
                }
                if (table === 'utenti') return { data: { role: 'segreteria', nome: NOME_GENITORE }, error: null }
                // ⚠️ `scuola_id` e `classe_sezione` dal 2026-09-19: prima della
                // RPC la route verifica che l'alunno sia destinatario di QUESTO
                // avviso (stessa sede, e classe fra le `target_classes` quando
                // l'avviso è di classe). Senza queste due colonne il finto
                // risponderebbe 403 e questo file misurerebbe il gate invece
                // delle notifiche. Il gate ha i suoi casi in
                // `avvisi-risposte-cerchio-sede.test.ts`.
                if (table === 'alunni') return { data: { nome: NOME_ALUNNO, scuola_id: SCUOLA_ID, classe_sezione: '1A' }, error: null }
                return { data: null, error: null }
            }
            return b
        },
    }),
}))

import { POST } from '@/app/api/avvisi/[id]/risposte/route'

const ctx = () => ({ params: Promise.resolve({ id: AVVISO_ID }) })
const req = (body: unknown) => ({
    url: `http://test/api/avvisi/${AVVISO_ID}/risposte`,
    method: 'POST',
    headers: new Headers(),
    json: async () => body,
}) as never

/** L'esito di un RITIRO che libera 4 persone su un avviso con 2 in coda. */
const RITIRO_CON_CODA = {
    ok: true,
    stato: null,
    numero: 4,
    // Chi si ritira aveva già risposto «sì»: NON è né la prima lettura né la
    // prima risposta, quindi la notifica all'autore non parte e l'unica chiamata
    // a `notificaEvento` che resta è quella sotto esame.
    prima_lettura: false,
    prima_risposta: false,
    posti_liberati: 4,
    in_attesa: 2,
}

beforeEach(() => {
    vi.clearAllMocks()
    h.esito = { ...RITIRO_CON_CODA }
    h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: SCUOLA_ID } })
    h.genitoreHasFiglio.mockResolvedValue(true)
    h.assertGenitoreNonSospeso.mockResolvedValue(null)
    h.staffScuola.mockResolvedValue(['seg-1', 'seg-2'])
    h.notificaEvento.mockResolvedValue(undefined)
})

describe('POST /api/avvisi/[id]/risposte — notifica posti_liberati', () => {
    it('un ritiro che libera posti CON gente in coda notifica la segreteria della sede', async () => {
        const res = await POST(req({ student_id: STUDENT_ID, risposta: 'no' }), ctx())
        expect(res.status).toBe(200)

        expect(h.staffScuola).toHaveBeenCalledWith(
            expect.anything(),
            SCUOLA_ID,
            ['admin', 'coordinator', 'segreteria'],
        )

        expect(h.notificaEvento).toHaveBeenCalledTimes(1)
        const params = h.notificaEvento.mock.calls[0][1] as Record<string, unknown>
        expect(params.tipo).toBe('posti_liberati')
        expect(params.utenteIds).toEqual(['seg-1', 'seg-2'])
        expect(params.scuolaId).toBe(SCUOLA_ID)
        expect(params.link).toBe(`/admin/avvisi/${AVVISO_ID}`)
    })

    it('NON notifica quando la lista d’attesa è VUOTA (niente coda, niente da decidere)', async () => {
        h.esito = { ...RITIRO_CON_CODA, in_attesa: 0 }
        const res = await POST(req({ student_id: STUDENT_ID, risposta: 'no' }), ctx())
        expect(res.status).toBe(200)
        expect(
            h.notificaEvento,
            'notifica mandata senza nessuno in coda: è un invito a decidere dove non c’è niente da decidere',
        ).not.toHaveBeenCalled()
    })

    it('NON notifica quando la chiamata non ha liberato NIENTE', async () => {
        // Un «sì» che entra: occupa, non libera. `in_attesa` resta pieno apposta —
        // se la condizione guardasse solo la coda, questo caso emetterebbe.
        h.esito = { ...RITIRO_CON_CODA, stato: 'ammessa', posti_liberati: 0, in_attesa: 2 }
        const res = await POST(req({ student_id: STUDENT_ID, risposta: 'si' }), ctx())
        expect(res.status).toBe(200)
        expect(h.notificaEvento).not.toHaveBeenCalled()
    })

    it('🔴 la notifica non porta NESSUN nome, e nemmeno il titolo dell’avviso', async () => {
        const res = await POST(req({ student_id: STUDENT_ID, risposta: 'no' }), ctx())
        expect(res.status).toBe(200)
        expect(h.notificaEvento).toHaveBeenCalled()

        // Si guarda TUTTO ciò che è stato passato, non solo il corpo: il titolo
        // potrebbe infilarsi nel `titolo`, nel `link` o in un campo aggiunto
        // domani, e un'asserzione sul solo `corpo` non lo vedrebbe.
        const tutto = JSON.stringify(h.notificaEvento.mock.calls)
        expect(tutto, 'il titolo dell’avviso è finito nella notifica').not.toContain(TITOLO_AVVISO)
        expect(tutto, 'il nome di un minore è finito nella notifica').not.toContain(NOME_ALUNNO)
        expect(tutto, 'il nome di un genitore è finito nella notifica').not.toContain(NOME_GENITORE)
        expect(tutto, 'anche solo il cognome basta a identificare la famiglia').not.toContain('Cognomefinto')
    })

    it('si accoda con debounce sull’avviso: dieci ritiri fanno una riga, non dieci', async () => {
        await POST(req({ student_id: STUDENT_ID, risposta: 'no' }), ctx())
        const params = h.notificaEvento.mock.calls[0][1] as Record<string, unknown>
        expect(params.debounce).toBe(true)
        expect(params.bufferMin).toBe(60)
        expect(params.entitaTipo).toBe('avviso')
        expect(params.entitaId).toBe(AVVISO_ID)
    })

    it('una RPC VECCHIA (migrazione non applicata) non fa partire niente e non rompe la risposta', async () => {
        // Il DB E2E della CI non è migrato: senza i due campi la notifica non ha
        // su cosa decidere, e «non lo so» non vale «sì». La risposta al genitore
        // resta 200 — la sua adesione è registrata comunque.
        h.esito = { ok: true, stato: null, numero: 4, prima_lettura: false, prima_risposta: false }
        const res = await POST(req({ student_id: STUDENT_ID, risposta: 'no' }), ctx())
        expect(res.status).toBe(200)
        expect(h.notificaEvento).not.toHaveBeenCalled()
    })
})
