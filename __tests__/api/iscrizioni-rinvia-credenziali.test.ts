import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * RIMANDARE UNA PASSWORD È UN GESTO CHE NON SI PUÒ DISFARE.
 *
 * Il 2026-08-22 il cron ha spedito 67 credenziali. 37 famiglie sono entrate, 30 no.
 * Questa route rimanda le credenziali ai secondi, nel formato nuovo — e nel farlo
 * **invalida** quella che avevano in mano. Da qui l'elenco di ciò che va sbagliato
 * zero volte, che è esattamente l'elenco di questi test.
 *
 * Il caso che dà il nome a tutto è il primo: fra il momento in cui si sceglie la
 * lista e il momento in cui si tocca la password possono passare minuti, e in quei
 * minuti un genitore può entrare. Se succede, la password NON si tocca: gliela si
 * strapperebbe di mano mentre la sta usando. È la ragione per cui questa route
 * esiste invece di una `UPDATE` sul registro — una SQL non può ricontrollare.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ ...log, EVENTI_PERSISTITI: new Set(['iscrizione']) }))

const h = vi.hoisted(() => ({
    ruolo: 'admin' as string,
    /** Le righe del registro degli inviti. */
    registro: [] as Array<Record<string, unknown>>,
    /** `last_sign_in_at` per auth user id: `null` = non è mai entrato. */
    ultimoAccesso: {} as Record<string, string | null>,
    /** `utenti.ruolo` per auth user id. */
    ruoloUtente: {} as Record<string, string>,
    /** Quante righe risponde il compare-and-swap del claim. */
    righeClaim: 1,
    emailOk: true,
    // diario delle operazioni, in ordine: serve alle asserzioni sull'ORDINE
    diario: [] as string[],
    updateRegistro: [] as Array<Record<string, unknown>>,
    rigenerata: vi.fn(),
    inviata: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
    requireStaff: vi.fn(async () => ({ user: { id: 'op-1', role: h.ruolo } })),
}))

vi.mock('@/lib/auth/password-invito', () => ({
    rigeneraPasswordPerInvito: vi.fn(async (_c: unknown, id: string) => {
        h.diario.push(`rigenera:${id}`)
        h.rigenerata(id)
        return { ok: true, password: 'Pe5b-s67n-sgy3-tnhd' }
    }),
}))

vi.mock('@/lib/email/send', () => ({
    sendEmailDetailed: vi.fn(async () => {
        h.inviata()
        return h.emailOk
            ? { ok: true, messageId: 'msg-1' }
            : { ok: false, error: 'destinatario rifiutato' }
    }),
}))

vi.mock('@/lib/email/contesto', () => ({
    risolviContestoSede: vi.fn(async () => ({
        nome: 'Kidville Giugliano', indirizzo: 'Via X', email: 'g@k.it',
        telefono: null, app: 'https://app.kidville.it', privacy: 'https://app.kidville.it/privacy',
    })),
}))
vi.mock('@/lib/email/ritmo', () => ({ pausaFraEmail: vi.fn(async () => {}) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => {}) }))

const supa = vi.hoisted(() => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

function client() {
    const filtri: Record<string, unknown> = {}
    const costruisci = (tabella: string) => ({
        select: () => costruisci(tabella),
        eq: (col: string, val: unknown) => { filtri[col] = val; return costruisci(tabella) },
        lt: () => costruisci(tabella),
        in: () => costruisci(tabella),
        order: () => Promise.resolve({ data: h.registro, error: null }),
        maybeSingle: async () => {
            if (tabella === 'utenti') {
                const id = String(filtri.id)
                return { data: h.ruoloUtente[id] ? { ruolo: h.ruoloUtente[id] } : null, error: null }
            }
            return { data: null, error: null }
        },
        update: (valori: Record<string, unknown>) => {
            const conClaim = 'rigenerazioni' in valori
            return {
                eq: (col: string, val: unknown) => {
                    filtri[col] = val
                    return {
                        eq: () => ({
                            select: async () => {
                                h.diario.push(`claim:${filtri.auth_user_id}`)
                                return { data: h.righeClaim > 0 ? [{ auth_user_id: filtri.auth_user_id }] : [], error: null }
                            },
                        }),
                        select: async () => ({ data: [], error: null }),
                        then: (ok: (v: unknown) => unknown) => {
                            if (!conClaim) { h.updateRegistro.push(valori); h.diario.push('update-registro') }
                            return Promise.resolve({ data: null, error: null }).then(ok)
                        },
                    }
                },
            }
        },
    })
    return {
        from: (t: string) => costruisci(t),
        auth: {
            admin: {
                getUserById: async (id: string) => ({
                    data: { user: { id, last_sign_in_at: h.ultimoAccesso[id] ?? null } },
                    error: null,
                }),
            },
        },
    }
}

import { POST } from '@/app/api/admin/iscrizioni/rinvia-credenziali/route'

function req(body: unknown) {
    return new Request('http://x/api/admin/iscrizioni/rinvia-credenziali', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    h.ruolo = 'admin'
    h.registro = [{ auth_user_id: 'u1', email: 'mamma@example.test', parent_id: 'p1', inviato_il: '2026-08-22T08:10:00Z', rigenerazioni: 0 }]
    h.ultimoAccesso = { u1: null }
    h.ruoloUtente = { u1: 'genitore' }
    h.righeClaim = 1
    h.emailOk = true
    h.diario = []
    h.updateRegistro = []
    supa.createAdminClient.mockResolvedValue(client())
})

describe('rinvio credenziali — chi NON si tocca', () => {
    it('chi è entrato nel frattempo NON si tocca: la password gli sta funzionando', async () => {
        // Il caso che dà il nome a tutto. La lista diceva «mai entrato», ma fra la
        // lista e adesso questa persona ha aperto una sessione.
        h.ultimoAccesso = { u1: '2026-08-23T07:00:00Z' }

        const res = await POST(req({}))
        const corpo = await res.json()

        expect(res.status).toBe(200)
        expect(h.rigenerata).not.toHaveBeenCalled()
        expect(h.inviata).not.toHaveBeenCalled()
        expect(corpo.entratiNelFrattempo).toBe(1)
        expect(corpo.rimandate).toBe(0)
    })

    it('un account che NON è di un genitore si salta (anti-lockout)', async () => {
        // Un'email che coincide con quella di una collega non deve poter essere
        // resettata da questa strada: `regenerate-credentials` quella lezione l'ha
        // già pagata, e qui il gesto è in blocco, quindi peggiore.
        h.ruoloUtente = { u1: 'educator' }

        const corpo = await (await POST(req({}))).json()

        expect(h.rigenerata).not.toHaveBeenCalled()
        expect(corpo.saltatiNonGenitore).toBe(1)
    })

    it('se il claim non prende, la password NON si tocca', async () => {
        // Due richieste concorrenti — un doppio clic, due operatrici — non devono
        // consegnare due password alla stessa famiglia: la seconda invaliderebbe
        // la prima, e nessuna delle due lo saprebbe.
        h.righeClaim = 0

        const corpo = await (await POST(req({}))).json()

        expect(h.rigenerata).not.toHaveBeenCalled()
        expect(h.inviata).not.toHaveBeenCalled()
        expect(corpo.giaInCorso).toBe(1)
    })

    it('la prova a vuoto non scrive NIENTE, e dice quanti sarebbero', async () => {
        const corpo = await (await POST(req({ dry_run: true }))).json()

        expect(corpo.candidati).toBe(1)
        expect(corpo.rimandate).toBe(0)
        expect(h.rigenerata).not.toHaveBeenCalled()
        expect(h.inviata).not.toHaveBeenCalled()
        expect(h.diario.filter((d) => d.startsWith('claim:'))).toHaveLength(0)
    })

    it('la Segreteria non può: è un gesto della Direzione', async () => {
        h.ruolo = 'segreteria'
        const res = await POST(req({}))
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('RINVIO_CREDENZIALI_RISERVATO')
    })
})

describe('rinvio credenziali — quando si fa davvero', () => {
    it('il claim viene PRIMA di toccare la password', async () => {
        await POST(req({}))
        const iClaim = h.diario.findIndex((d) => d.startsWith('claim:'))
        const iRigenera = h.diario.findIndex((d) => d.startsWith('rigenera:'))
        expect(iClaim).toBeGreaterThanOrEqual(0)
        expect(iRigenera).toBeGreaterThan(iClaim)
    })

    it('va a buon fine: una rimandata, e il registro porta il nuovo message id', async () => {
        const corpo = await (await POST(req({}))).json()

        expect(corpo.rimandate).toBe(1)
        expect(h.inviata).toHaveBeenCalledTimes(1)
        expect(h.updateRegistro.some((u) => u.rigenerazione_message_id === 'msg-1')).toBe(true)
    })

    it('NON riscrive `inviato_il` né `resend_message_id`: sono la prova del PRIMO recapito', async () => {
        // È la sola risposta possibile a «non mi è mai arrivato niente»: *è stata
        // consegnata al provider il 22/08 alle 08:11 con il messaggio X*. Perderla
        // significa non poter più distinguere «mai spedita» da «spedita e non letta».
        await POST(req({}))
        for (const scritto of h.updateRegistro) {
            expect(scritto).not.toHaveProperty('inviato_il')
            expect(scritto).not.toHaveProperty('resend_message_id')
        }
    })

    it('se l\'email NON parte, la password torna all\'operatore: è viva e non la sa nessuno', async () => {
        // Il rischio che non si può eliminare — non esiste un ordine in cui
        // l'invalidazione segua la consegna — reso RIMEDIABILE: chi ha premuto il
        // bottone ha la famiglia al telefono in quel momento.
        h.emailOk = false

        const corpo = await (await POST(req({}))).json()

        expect(corpo.falliti).toBe(1)
        expect(corpo.rimandate).toBe(0)
        expect(corpo.daConsegnareAMano).toHaveLength(1)
        expect(corpo.daConsegnareAMano[0].password).toBe('Pe5b-s67n-sgy3-tnhd')
    })

    it('il successo si LOGGA (regola 5): senza, «nessun log» non distingue ok da mai partito', async () => {
        await POST(req({}))
        const esiti = log.logEvento.mock.calls.map((c) => (c[2] as { esito?: string })?.esito)
        expect(esiti).toContain('credenziali-rimandate')
    })
})
