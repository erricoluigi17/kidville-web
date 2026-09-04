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
    /** `utenti.scuola_id` di chi preme: la sede PROPRIA dell'operatore. */
    sedeOperatore: 'sede-1' as string | null,
    /** Il ponte `utenti_scuole`: solo l'admin può essere multi-plesso. */
    pontiAdmin: [] as string[],
    /** I legami figlio↔genitore, con la sede del FIGLIO: è da lì che si deduce la sede di un genitore. */
    legami: [] as Array<{ parent_id: string; scuola_id: string }>,
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
    // `scuola_id` c'è perché da qui in avanti il PERIMETRO si costruisce dalle
    // sedi dell'operatore, non dal corpo della richiesta: senza, `scuoleDiUtente`
    // non avrebbe niente da cui partire.
    requireStaff: vi.fn(async () => ({ user: { id: 'op-1', role: h.ruolo, scuola_id: h.sedeOperatore } })),
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

/**
 * ⚠️ QUESTO FINTO FILTRA DAVVERO, e non è pignoleria.
 *
 * Un finto che risponde uguale a ogni tabella e ignora i filtri renderebbe VERDE
 * la prova «la segreteria vede solo il proprio plesso» anche col confinamento
 * rimosso — cioè proprio la prova per cui esiste. In questo repo un difetto delle
 * classi vuote è passato con 13.254 test verdi esattamente così.
 *
 * Le tre tabelle che contano:
 *  · `utenti_scuole`   → il ponte multi-plesso, letto SOLO per l'admin
 *  · `student_parents` → i legami col figlio: è da qui che si deduce la sede di
 *                        un genitore, perché `parents` la colonna NON CE L'HA
 *  · `iscrizioni_inviti_credenziali` → il registro, filtrato per `parent_id`
 */
function client() {
    const filtri: Record<string, unknown> = {}
    /** Gli `in(...)` visti, per colonna: è il filtro che il finto deve rispettare. */
    const dentro: Record<string, unknown[]> = {}
    const risolvi = (tabella: string) => {
        if (tabella === 'utenti_scuole') {
            return { data: h.pontiAdmin.map((s) => ({ scuola_id: s })), error: null }
        }
        if (tabella === 'student_parents') {
            const scope = (dentro['alunni.scuola_id'] ?? []) as string[]
            return {
                data: h.legami.filter((l) => scope.includes(l.scuola_id)).map((l) => ({ parent_id: l.parent_id })),
                error: null,
            }
        }
        if (tabella === 'iscrizioni_inviti_credenziali') {
            const ammessi = dentro['parent_id'] as string[] | undefined
            const righe = ammessi ? h.registro.filter((r) => ammessi.includes(String(r.parent_id))) : h.registro
            return { data: righe, error: null }
        }
        return { data: null, error: null }
    }
    const costruisci = (tabella: string): Record<string, unknown> => ({
        select: () => costruisci(tabella),
        eq: (col: string, val: unknown) => { filtri[col] = val; return costruisci(tabella) },
        lt: () => costruisci(tabella),
        in: (col: string, vals: unknown[]) => { dentro[col] = vals; return costruisci(tabella) },
        // `order` NON chiude più la catena: la route ci aggancia un `.in()` dopo,
        // ed è il passo che confina il rinvio al plesso di chi lo chiede.
        order: () => costruisci(tabella),
        // Il costruttore è THENABLE: `await query` risolve qui, con i filtri visti.
        then: (ok: (v: unknown) => unknown) => Promise.resolve(risolvi(tabella)).then(ok),
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
    h.sedeOperatore = 'sede-1'
    h.pontiAdmin = ['sede-1']
    h.legami = [{ parent_id: 'p1', scuola_id: 'sede-1' }]
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

    /**
     * ⚠️ QUI STAVA «la Segreteria non può: è un gesto della Direzione».
     *
     * Non è stato cancellato per far passare il codice nuovo: il titolare ha
     * deciso il 2026-09-03 di aprire il rinvio in blocco anche alla Segreteria.
     * La riserva è stata SOSTITUITA da un confinamento — vedi il blocco «il
     * perimetro non arriva più dal client» in fondo al file — e quel confinamento
     * è più stretto della riserva che toglie: prima l'admin poteva rimandare le
     * credenziali a TUTTE le famiglie di TUTTE le sedi, adesso a quelle dei
     * propri plessi.
     */
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

/**
 * IL PERIMETRO NON ARRIVA PIÙ DAL CLIENT.
 *
 * Fino al 2026-09-03 questa route aveva un filtro di sede che faceva
 * `parents.eq('scuola_id', …)` — e `parents` quella colonna NON CE L'HA (27
 * colonne, verificate sullo schema di produzione). PostgREST rispondeva `42703`,
 * la route dava 500. Il difetto era invisibile perché l'unico che poteva
 * chiamarla era l'admin multi-sede, che la sede non la passa mai.
 *
 * Aprirla alla Segreteria senza ripararlo avrebbe mandato una segreteria di Cesa
 * a riscrivere 528 password invece di 156 (misurate il 2026-09-03).
 *
 * Un genitore non HA una sede: ce l'hanno i suoi figli, e possono averne due
 * diverse. Da qui la join `student_parents → alunni.scuola_id`, la stessa che
 * `assertParentInScope` usa da sempre.
 */
describe('rinvio in blocco — il perimetro non arriva più dal client', () => {
    /** Tre famiglie: due a sede-1, una a sede-2. */
    function treFamiglieDueSedi() {
        h.registro = [
            { auth_user_id: 'u1', email: 'a@example.test', parent_id: 'p1', inviato_il: '2026-08-22T08:10:00Z', rigenerazioni: 0 },
            { auth_user_id: 'u2', email: 'b@example.test', parent_id: 'p2', inviato_il: '2026-08-22T08:11:00Z', rigenerazioni: 0 },
            { auth_user_id: 'u3', email: 'c@example.test', parent_id: 'p3', inviato_il: '2026-08-22T08:12:00Z', rigenerazioni: 0 },
        ]
        h.legami = [
            { parent_id: 'p1', scuola_id: 'sede-1' },
            { parent_id: 'p2', scuola_id: 'sede-1' },
            { parent_id: 'p3', scuola_id: 'sede-2' },
        ]
        h.ultimoAccesso = { u1: null, u2: null, u3: null }
        h.ruoloUtente = { u1: 'genitore', u2: 'genitore', u3: 'genitore' }
    }

    it('la Segreteria non riceve più 403: il gate la ammette', async () => {
        h.ruolo = 'segreteria'
        const res = await POST(req({ dry_run: true }))
        expect(res.status).toBe(200)
    })

    it('una segreteria vede SOLO i genitori con figli nel proprio plesso', async () => {
        h.ruolo = 'segreteria'
        h.sedeOperatore = 'sede-1'
        treFamiglieDueSedi()

        const corpo = await (await POST(req({ dry_run: true }))).json()

        // Due su tre. La terza famiglia è di sede-2 e non deve nemmeno essere contata.
        expect(corpo.candidati).toBe(2)
    })

    it('una segreteria che chiede un ALTRO plesso: 403, e non tocca niente', async () => {
        h.ruolo = 'segreteria'
        h.sedeOperatore = 'sede-1'
        treFamiglieDueSedi()

        const res = await POST(req({ dry_run: true, scuola_id: '22222222-2222-4222-8222-222222222222' }))

        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
        expect(h.rigenerata).not.toHaveBeenCalled()
    })

    /**
     * LA CONTROPROVA DI `formaConfronto`. In Postgres `uuid` è un TIPO: due
     * stringhe con maiuscole diverse sono lo STESSO valore, e la riga si trova.
     * In JavaScript no — ed è il difetto che il 2026-07-31 fece rispondere «403
     * sulla PROPRIA sede» a una segreteria che la scriveva in maiuscolo.
     * `restringiSedi` confronta in forma canonica: qui si verifica che quel
     * difetto non sia ricresciuto passando da questa strada.
     */
    it('la PROPRIA sede scritta in MAIUSCOLO è ancora la propria sede', async () => {
        h.ruolo = 'segreteria'
        h.sedeOperatore = '11111111-1111-4111-8111-111111111111'
        h.legami = [{ parent_id: 'p1', scuola_id: '11111111-1111-4111-8111-111111111111' }]

        const res = await POST(req({ dry_run: true, scuola_id: '11111111-1111-4111-8111-111111111111'.toUpperCase() }))

        expect(res.status).toBe(200)
        expect((await res.json()).candidati).toBe(1)
    })

    it('un operatore senza plesso: 403, e nessuna password riscritta', async () => {
        h.ruolo = 'segreteria'
        h.sedeOperatore = null

        const res = await POST(req({}))

        expect(res.status).toBe(403)
        expect((await res.json()).codice).toBe('RINVIO_NESSUN_PLESSO')
        expect(h.rigenerata).not.toHaveBeenCalled()
    })

    /**
     * L'admin cambia comportamento e va detto: prima «nessuna sede nel corpo»
     * voleva dire TUTTE le famiglie esistenti, adesso vuol dire tutte quelle dei
     * plessi a cui ha diritto. Per l'admin reale i due insiemi coincidono — i 528
     * candidati stanno tutti in Giugliano, Cesa e Aversa — ma la coincidenza è un
     * fatto di oggi, non una garanzia.
     */
    it("l'admin multi-sede copre i PROPRI plessi, non tutto il database", async () => {
        h.ruolo = 'admin'
        h.sedeOperatore = 'sede-1'
        h.pontiAdmin = ['sede-1', 'sede-2']
        treFamiglieDueSedi()

        const corpo = await (await POST(req({ dry_run: true }))).json()

        expect(corpo.candidati).toBe(3)
    })

    it("l'admin che NON ha il ponte su sede-2 non tocca le famiglie di sede-2", async () => {
        h.ruolo = 'admin'
        h.sedeOperatore = 'sede-1'
        h.pontiAdmin = ['sede-1']
        treFamiglieDueSedi()

        const corpo = await (await POST(req({ dry_run: true }))).json()

        expect(corpo.candidati).toBe(2)
    })
})
