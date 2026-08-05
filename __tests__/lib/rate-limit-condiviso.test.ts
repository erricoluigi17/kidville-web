import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * IL TETTO DI FREQUENZA VALE COMPLESSIVAMENTE, NON PER ISTANZA.
 *
 * ─── PERCHÉ QUESTO FILE È SCRITTO COSÌ ──────────────────────────────────────
 *
 * Un test che importa `rateLimit` una volta sola e conta i `429` **non prova
 * niente di ciò che conta qui**: resterebbe verde parola per parola anche se il
 * contatore tornasse a essere la `Map` nella memoria del processo, cioè
 * esattamente il difetto che questo lavoro esiste per chiudere. Il vecchio
 * `__tests__/lib/rate-limit.test.ts` è quel test, ed è giusto che continui a
 * esistere: verifica la SEMANTICA (la finestra scorrevole, le chiavi separate).
 * Non verifica DOVE vive il contatore.
 *
 * Qui si verifica dove vive, e l'unico modo onesto è simulare la produzione:
 * **due istanze del modulo** — `vi.resetModules()` + due `import()` dinamici,
 * che è la cosa più vicina a due lambda concorrenti che si possa avere in
 * process — **e un solo Postgres finto**, che vive fuori dal registro dei moduli
 * (`vi.hoisted`) e quindi sopravvive al reset. Con lo store condiviso le due
 * istanze si passano il conto; con la `Map` ognuna ricomincia da zero e la prova
 * cade. È la definizione operativa di «il tetto non è più N × limite».
 *
 * ─── L'ALTRA METÀ: LA CORSA CRITICA ─────────────────────────────────────────
 *
 * Uno store condiviso non basta: conta COME lo si usa. «Leggi il contatore,
 * decidi, scrivi il contatore» è una corsa critica con le parole giuste — dieci
 * richieste simultanee leggono tutte lo stesso valore e passano tutte. Perciò il
 * finto Postgres di questo file offre DUE strade: la RPC atomica e una strada a
 * due query (`.from()`) fedelmente NON atomica, con un vero confine di attesa
 * fra lettura e scrittura. Un'implementazione che usasse la seconda ammetterebbe
 * 20 richieste su un tetto di 5, e la prova qui sotto lo direbbe.
 *
 * ─── E LA DOMANDA CHE VIENE PRIMA DI TUTTE ──────────────────────────────────
 *
 * Da questa porta arrivano domande d'iscrizione di famiglie vere. Se il database
 * è lento o irraggiungibile il tetto NON deve chiudere la porta (§ «degrado»
 * qui sotto e la testata di `rate-limit.ts`): deve ricadere sul conteggio
 * locale — che è il comportamento di oggi, non il vuoto — e lasciare una riga.
 * Queste due cose si provano, perché una scelta di sicurezza che nessun test
 * misura è un'opinione scritta in un commento.
 */

// ─────────────────────────────────────────────────────────────────────────────
// IL FINTO POSTGRES — vive in `vi.hoisted`, cioè FUORI dal registro dei moduli.
// È il perno di tutto il file: `vi.resetModules()` azzera i moduli e NON tocca
// questo oggetto, che è appunto ciò che un database condiviso fa in produzione.
// ─────────────────────────────────────────────────────────────────────────────
const pg = vi.hoisted(() => {
    /** `chiave → istanti dei colpi vivi`, la stessa forma della colonna `colpi`. */
    const righe = new Map<string, number[]>()
    const conteggi = { rpc: 0, from: 0 }
    /** Guasti simulati: `null` = tutto bene. */
    const guasto: { modo: null | 'errore' | 'eccezione' | 'appeso' | 'malformato' | 'scaduto' } = {
        modo: null,
    }
    /** Orologio del "server": monotono, indipendente dal `now` passato al client. */
    let orologio = 1_000_000

    function reset() {
        righe.clear()
        conteggi.rpc = 0
        conteggi.from = 0
        guasto.modo = null
        orologio = 1_000_000
    }

    /** La semantica della funzione SQL, tradotta: leggi-decidi-scrivi senza interruzioni. */
    function consuma(chiave: string, limite: number, finestraMs: number) {
        const ora = ++orologio
        const vivi = (righe.get(chiave) ?? []).filter((t) => t > ora - finestraMs)
        const consentito = vivi.length < limite
        if (consentito) vivi.push(ora)
        righe.set(chiave, vivi)
        return {
            consentito,
            rimanenti: consentito ? Math.max(0, limite - vivi.length) : 0,
            riprova_fra_ms: consentito ? 0 : Math.max(1, vivi[0] + finestraMs - ora),
        }
    }

    /** Il builder di `@supabase/postgrest-js`: thenable e con `.abortSignal()`. */
    function builder(p: Promise<unknown>): Record<string, unknown> {
        const b: Record<string, unknown> = {
            abortSignal: () => builder(p),
            then: (ok: unknown, ko: unknown) => p.then(ok as never, ko as never),
            catch: (ko: unknown) => p.catch(ko as never),
            finally: (f: unknown) => p.finally(f as never),
        }
        return b
    }

    const client = {
        rpc(nome: string, args: Record<string, unknown>) {
            conteggi.rpc++
            if (guasto.modo === 'eccezione') throw new Error('finto: il client è esploso')
            if (guasto.modo === 'appeso') return builder(new Promise(() => {}))
            if (guasto.modo === 'errore') {
                return builder(
                    Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'funzione assente' } }),
                )
            }
            /**
             * LA SCADENZA, COM'È DAVVERO QUANDO ARRIVA QUI — e non come si immaginerebbe.
             *
             * Il tetto di `consumaCondiviso` è un `AbortSignal.timeout`: quando scatta,
             * `supabase-fetch` rietichetta l'errore e postgrest-js NON lancia, consegna un
             * `{ error }` normale con `code` **vuoto** e il nome dentro al `message`.
             * Misurato in produzione il 2026-08-05: `error_code` era `''` su tutte le righe,
             * ed è il motivo per cui il riconoscimento guarda il messaggio e non il codice.
             */
            if (guasto.modo === 'scaduto') {
                return builder(
                    Promise.resolve({
                        data: null,
                        error: {
                            code: '',
                            message:
                                'SupabaseTimeoutError: nessuna risposta da Supabase entro il tetto del chiamante (interrotta dopo 191 ms)',
                        },
                    }),
                )
            }
            if (guasto.modo === 'malformato') {
                return builder(Promise.resolve({ data: [{ boh: 1 }], error: null }))
            }
            if (nome !== 'tetto_frequenza_consuma') {
                return builder(Promise.resolve({ data: null, error: { code: 'PGRST202', message: nome } }))
            }
            const riga = consuma(
                args.p_chiave as string,
                args.p_limite as number,
                args.p_finestra_ms as number,
            )
            return builder(Promise.resolve({ data: [riga], error: null }))
        },
        /**
         * La strada a DUE QUERY, riprodotta con il difetto che ha davvero: fra il
         * `select` e la scrittura c'è un confine di attesa, quindi N chiamate
         * concorrenti leggono tutte lo stesso valore. Esiste per far FALLIRE una
         * implementazione non atomica, non per essere usata.
         */
        from() {
            conteggi.from++
            return {
                select: () => ({
                    eq: () => ({
                        maybeSingle: async () => {
                            await Promise.resolve()
                            return { data: null, error: null }
                        },
                    }),
                }),
                upsert: async () => {
                    await Promise.resolve()
                    return { data: null, error: null }
                },
            }
        },
    }

    return { client, righe, conteggi, guasto, reset }
})

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => pg.client,
    createClient: async () => pg.client,
    createLogClient: async () => pg.client,
}))

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
    const vero = await originale<Record<string, unknown>>()
    return { ...vero, ...log }
})

type Modulo = typeof import('@/lib/security/rate-limit')

/** Un'ISTANZA del modulo: registro dei moduli azzerato, quindi `Map` nuova di zecca. */
async function istanza(): Promise<Modulo> {
    vi.resetModules()
    return import('@/lib/security/rate-limit')
}

beforeEach(() => {
    pg.reset()
    log.logEvento.mockClear()
    log.logErrore.mockClear()
})

describe('tetto di frequenza · il contatore è CONDIVISO, non per istanza', () => {
    it('due istanze del modulo si passano il conto (con la Map in memoria questa prova cade)', async () => {
        const A = await istanza()
        const B = await istanza()

        // Autocontrollo: se i due import restituissero lo stesso modulo, la prova
        // sarebbe verde per il motivo peggiore — non aver simulato niente.
        expect(A.rateLimit, 'i due import sono lo stesso modulo: `vi.resetModules()` non ha fatto niente')
            .not.toBe(B.rateLimit)

        const opzioni = { limit: 5, windowMs: 10 * 60 * 1000 }
        const chiave = 'iscrizione:203.0.113.7'

        // Tre richieste sulla prima lambda, due sulla seconda: cinque in tutto,
        // che è esattamente il tetto. Nessuna delle due, da sola, lo raggiunge.
        expect((await A.rateLimit(chiave, opzioni)).ok).toBe(true)
        expect((await A.rateLimit(chiave, opzioni)).ok).toBe(true)
        expect((await A.rateLimit(chiave, opzioni)).ok).toBe(true)
        expect((await B.rateLimit(chiave, opzioni)).ok).toBe(true)
        expect((await B.rateLimit(chiave, opzioni)).ok).toBe(true)

        // La sesta è oltre il tetto COMPLESSIVO, e non importa su quale lambda cade.
        const seiA = await A.rateLimit(chiave, opzioni)
        expect(seiA.ok, 'la 6ª richiesta è passata: il contatore è tornato per-istanza').toBe(false)
        expect(seiA.remaining).toBe(0)
        expect(seiA.retryAfterMs).toBeGreaterThan(0)

        const seiB = await B.rateLimit(chiave, opzioni)
        expect(seiB.ok, "l'altra lambda non vede il tetto già raggiunto").toBe(false)
    })

    it('ogni istanza conta sullo stesso Postgres, non ne ha uno suo', async () => {
        const A = await istanza()
        const B = await istanza()
        const opzioni = { limit: 3, windowMs: 60_000 }

        await A.rateLimit('otp-invio:u1', opzioni)
        await B.rateLimit('otp-invio:u1', opzioni)

        // Una riga sola per la chiave, con due colpi: se ogni istanza avesse il
        // proprio store, qui ci sarebbero due storie separate.
        expect(pg.righe.get('otp-invio:u1')).toHaveLength(2)
        expect(pg.conteggi.rpc).toBe(2)
    })

    it('le chiavi restano separate anche sullo store condiviso', async () => {
        const A = await istanza()
        const opzioni = { limit: 1, windowMs: 60_000 }
        expect((await A.rateLimit('a', opzioni)).ok).toBe(true)
        expect((await A.rateLimit('b', opzioni)).ok).toBe(true)
        expect((await A.rateLimit('a', opzioni)).ok).toBe(false)
    })
})

describe('tetto di frequenza · la corsa critica', () => {
    it('venti richieste simultanee sulla stessa chiave producono ESATTAMENTE `limit` passaggi', async () => {
        const A = await istanza()
        const opzioni = { limit: 5, windowMs: 60_000 }

        const esiti = await Promise.all(
            Array.from({ length: 20 }, () => A.rateLimit('otp-verifica:u9', opzioni)),
        )
        const passate = esiti.filter((e) => e.ok).length

        expect(
            passate,
            'più di `limit` passaggi in concorrenza: incremento e decisione non sono lo stesso statement',
        ).toBe(5)
    })

    it('una sola andata e ritorno per richiesta, e mai la strada a due query', async () => {
        const A = await istanza()
        const opzioni = { limit: 30, windowMs: 60_000 }

        await A.rateLimit('iscrizione-sedi:198.51.100.4', opzioni)
        await A.rateLimit('iscrizione-sedi:198.51.100.4', opzioni)

        // Il COSTO, misurato invece che stimato: 1 round-trip in più per richiesta.
        expect(pg.conteggi.rpc, 'più di una chiamata al DB per richiesta').toBe(2)
        // E la strada non atomica non viene nemmeno sfiorata.
        expect(pg.conteggi.from, 'il limitatore sta usando select+upsert invece della RPC atomica').toBe(0)
    })
})

describe('tetto di frequenza · il degrado quando il database non risponde', () => {
    /**
     * La scelta è FAIL-OPEN VERSO IL DATABASE, non verso il vuoto: si ricade sul
     * contatore locale, che è il tetto di ieri (N × limite). Le prove qui sotto
     * misurano tutte e due le metà — che passi, e che non passi troppo.
     */
    it('se la RPC risponde con un errore, il tetto LOCALE continua a valere', async () => {
        const A = await istanza()
        pg.guasto.modo = 'errore'
        const opzioni = { limit: 3, windowMs: 60_000 }

        const esiti = []
        for (let i = 0; i < 5; i++) esiti.push(await A.rateLimit('iscrizione:203.0.113.9', opzioni))

        expect(esiti.slice(0, 3).map((e) => e.ok), 'il degrado ha chiuso la porta alle iscrizioni').toEqual([
            true, true, true,
        ])
        expect(esiti.slice(3).map((e) => e.ok), 'il degrado ha aperto un varco senza tetto').toEqual([
            false, false,
        ])
    })

    it('lo stesso vale se il client lancia invece di rispondere', async () => {
        const A = await istanza()
        pg.guasto.modo = 'eccezione'
        const opzioni = { limit: 2, windowMs: 60_000 }
        expect((await A.rateLimit('k', opzioni)).ok).toBe(true)
        expect((await A.rateLimit('k', opzioni)).ok).toBe(true)
        expect((await A.rateLimit('k', opzioni)).ok).toBe(false)
    })

    it('una risposta MALFORMATA non vale come «consentito»: si degrada, non si crede', async () => {
        const A = await istanza()
        pg.guasto.modo = 'malformato'
        const opzioni = { limit: 2, windowMs: 60_000 }
        expect((await A.rateLimit('k', opzioni)).ok).toBe(true)
        expect((await A.rateLimit('k', opzioni)).ok).toBe(true)
        // Se una riga senza i campi attesi fosse letta come `consentito`, questa
        // passerebbe: il tetto sarebbe scomparso senza che nulla lo dicesse.
        expect((await A.rateLimit('k', opzioni)).ok).toBe(false)
    })

    it('il tetto che non ha potuto decidere LASCIA UNA RIGA', async () => {
        const A = await istanza()
        pg.guasto.modo = 'errore'
        await A.rateLimit('k', { limit: 5, windowMs: 60_000 })

        const righe = [...log.logEvento.mock.calls, ...log.logErrore.mock.calls]
        expect(righe.length, 'degrado silenzioso: nessuno saprà mai che il tetto era cieco').toBeGreaterThan(0)
        const [evento, livello] = log.logEvento.mock.calls[0] ?? []
        expect(evento, "l'evento deve stare nel vocabolario chiuso di `EVENTI_NOTI`").toBe('db')
        expect(livello, 'un tetto cieco non è una nota a piè di pagina').toBe('error')
    })

    /**
     * ─── UNA SCADENZA NON È UN ERRORE DEL DATABASE, E IL LOG DEVE SAPERLO ────────
     *
     * Fino al 2026-08-05 non lo sapeva, e il conto è stato salato. In produzione, fra il 4 e il
     * 5 agosto, **113 degradazioni: tutte `rpc_errore`, nessuna `rpc_scaduta`** — perché il ramo
     * `esito.scaduto` di `consumaCondiviso` non scatta mai (l'abort del signal vince la corsa
     * contro il `setTimeout` e fa risolvere la promise con `{ error }`). La riga di log diceva
     * quindi «il database ha risposto un errore» mentre la verità era «il database non ha
     * risposto in tempo»: due guasti che si riparano in modi opposti.
     *
     * Il livello conta quanto la classificazione: `error` su un comportamento progettato è il
     * modo in cui si insegna a ignorare gli errori.
     */
    it('una SCADENZA si distingue da un errore del DB: motivo `rpc_scaduta`, livello `warn`', async () => {
        const A = await istanza()
        pg.guasto.modo = 'scaduto'
        await A.rateLimit('iscrizione-upload:203.0.113.7', { limit: 5, windowMs: 60_000 })

        const [evento, livello, campi] = log.logEvento.mock.calls[0] ?? []
        expect(evento).toBe('db')
        expect(
            livello,
            'una scadenza è il degrado PROGETTATO: a `error` scatta durante il funzionamento normale',
        ).toBe('warn')
        expect(
            (campi as Record<string, unknown>)?.azione,
            'etichettata come errore del DB, manda a cercare un guasto che non c’è',
        ).toBe('rpc_scaduta')
    })

    it('un errore VERO del database resta `rpc_errore` a livello `error`', async () => {
        const A = await istanza()
        pg.guasto.modo = 'errore'
        await A.rateLimit('iscrizione:203.0.113.8', { limit: 5, windowMs: 60_000 })

        const [, livello, campi] = log.logEvento.mock.calls[0] ?? []
        expect(livello, 'qui qualcosa è rotto davvero: la funzione non esiste').toBe('error')
        expect((campi as Record<string, unknown>)?.azione).toBe('rpc_errore')
    })

    it('la riga del degrado non si ripete a ogni richiesta (un DB giù non deve accecare i log)', async () => {
        const A = await istanza()
        pg.guasto.modo = 'errore'
        for (let i = 0; i < 20; i++) await A.rateLimit(`k${i}`, { limit: 50, windowMs: 60_000 })
        expect(log.logEvento.mock.calls.length).toBe(1)
    })

    it('una RPC che non risponde MAI non appende la richiesta', async () => {
        const A = await istanza()
        pg.guasto.modo = 'appeso'
        const partenza = Date.now()
        const esito = await A.rateLimit('k', { limit: 5, windowMs: 60_000 })
        const durata = Date.now() - partenza

        expect(esito.ok, 'la richiesta è stata respinta per colpa di una lentezza del DB').toBe(true)
        expect(
            durata,
            `il limitatore è rimasto appeso ${durata}ms: un rate-limiter che si appende è peggio di nessun rate-limiter`,
        ).toBeLessThan(A.ATTESA_MASSIMA_DB_MS + 500)
    })
})

describe('tetto di frequenza · lo store locale non è più una perdita di memoria', () => {
    it('le chiavi scadute vengono potate invece di restare per sempre', async () => {
        const A = await istanza()
        pg.guasto.modo = 'errore' // si conta in locale: è lì che stava la perdita
        const opzioni = { limit: 1, windowMs: 1_000 }

        // Mille IP diversi che bussano una volta sola e non tornano mai più: è il
        // traffico vero di una rotta pubblica, ed è ciò che faceva crescere la
        // `Map` senza che niente la svuotasse.
        for (let i = 0; i < 1_000; i++) await A.rateLimit(`ip:${i}`, opzioni, 1_000)

        // Un'ora dopo, una richiesta qualunque.
        await A.rateLimit('ip:nuovo', opzioni, 1_000 + 3_600_000)

        expect(
            A.dimensioneStoreLocale(),
            'le chiavi morte sono ancora tutte lì: la Map cresce e non si svuota mai',
        ).toBeLessThan(50)
    })

    it('la potatura non cancella una chiave ancora VIVA', async () => {
        const A = await istanza()
        pg.guasto.modo = 'errore'
        const opzioni = { limit: 1, windowMs: 600_000 }

        await A.rateLimit('vivo', opzioni, 1_000)
        for (let i = 0; i < 1_000; i++) await A.rateLimit(`ip:${i}`, opzioni, 1_000)

        // Ancora dentro la finestra di dieci minuti: deve restare bloccato.
        expect((await A.rateLimit('vivo', opzioni, 2_000)).ok).toBe(false)
    })
})
