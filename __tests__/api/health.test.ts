import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { creaFintoSupabase, type DBFinto, type Riga, type ErrorePostgrest } from '../fixtures/finto-supabase'

/**
 * L'ENDPOINT DI SALUTE DEVE POTER DIRE DI NO.
 *
 * Il difetto che questi test bloccano non è «manca l'endpoint»: è «c'è un endpoint che
 * risponde sempre 200». Un `return Response.json({ ok: true })` supera qualunque test
 * scritto come «GET /api/health → 200», che è il motivo per cui qui dentro NON c'è un
 * test scritto così. Ogni caso FORZA un guasto e pretende il verdetto giusto.
 *
 * Il criterio con cui sono stati scelti: se qualcuno riducesse `eseguiControlli` a
 * `{ stato: 'ok' }`, o buttasse via il verdetto di un controllo, questi test devono
 * diventare ROSSI. È stato verificato manomettendo davvero il codice, non supponendolo.
 */

// ── Le spie sul logger ───────────────────────────────────────────────────────
// Il logger è SILENZIOSO sotto vitest (`.env.local` punta al DB di PRODUZIONE: una suite
// che scrive righe di log in produzione è un incidente, non un test), e un logger muto non
// si può ispezionare. Si mocka e si asserisce sulle CHIAMATE.
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

const supa = vi.hoisted(() => ({ createAdminClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => supa)

import { GET } from '@/app/api/health/route'
import { resetRateLimit } from '@/lib/security/rate-limit'
import {
    VARIABILI_CRITICHE,
    JOB_CRON,
    SOGLIA_IMPRONTE_ERRORE,
    type Salute,
    type Controllo,
} from '@/lib/health/controlli'

/** La forma di `contesto` che `logEvento` scrive: i campi del chiamante sotto `campi`. */
interface RigaLogFinta extends Riga {
    livello: string
    ambiente: string
    visto_l_ultima: string
    contesto: { campi: { operazione?: string; esito?: string } }
}

function jobDi(r: Riga): string | undefined {
    return (r as RigaLogFinta).contesto?.campi?.operazione
}

const MIN = 60_000
const ORA = 60 * MIN

/** Istante di `ms` millisecondi fa, in ISO — la forma in cui PostgREST rende i timestamp. */
function fa(ms: number): string {
    return new Date(Date.now() - ms).toISOString()
}

/** Una riga di battito così come la scrive `logEvento('cron', 'info', { operazione, esito })`. */
function battito(job: string, quandoMs: number, extra: Record<string, unknown> = {}) {
    return {
        id: `log-${job}`,
        evento: 'cron',
        livello: 'info',
        ambiente: 'production',
        creato_il: fa(quandoMs),
        visto_l_ultima: fa(quandoMs),
        contesto: { campi: { operazione: job, esito: 'ok' } },
        ...extra,
    }
}

/** Il database SANO: tutte le tabelle attese, tutti e sei i job che hanno battuto da poco. */
function dbSano(): DBFinto {
    return {
        utenti: [{ id: 'u1' }],
        alunni: [{ id: 'a1' }],
        avvisi: [{ id: 'v1' }],
        notifiche: [{ id: 'n1' }],
        pagamenti: [{ id: 'p1' }],
        // DERIVATI da `JOB_CRON`, non elencati a mano: un elenco cablato qui dentro dice
        // «tutto sano» finché qualcuno non aggiunge un job sorvegliato — e da quel momento
        // il fixture descrive un mondo che non esiste più, e il test rosso parla del
        // fixture invece che del codice. Un battito a un terzo della propria finestra è
        // fresco per definizione, qualunque sia la cadenza.
        app_log: JOB_CRON.map((j) => battito(j.nome, Math.floor(j.finestraMs / 3))),
    }
}

function montaDb(db: DBFinto, errori: Record<string, ErrorePostgrest> = {}): void {
    supa.createAdminClient.mockResolvedValue(creaFintoSupabase(db, [], { errori }))
}

async function chiama(): Promise<{ stato: number; header: string | null; corpo: Salute; grezzo: string }> {
    const res = await GET(new Request('https://app.kidville.it/api/health'))
    const grezzo = await res.text()
    return {
        stato: res.status,
        header: res.headers.get('X-Kv-Salute'),
        corpo: JSON.parse(grezzo) as Salute,
        grezzo,
    }
}

/** LANCIA se il controllo non c'è: un `undefined` renderebbe verdi asserzioni che non
 *  hanno guardato niente — il modo più silenzioso di scrivere un test finto. */
function controllo(corpo: Salute, nome: string): Controllo {
    const c = corpo.controlli.find((x) => x.nome === nome)
    if (!c) throw new Error(`controllo "${nome}" assente dalla risposta`)
    return c
}

beforeEach(() => {
    vi.clearAllMocks()
    resetRateLimit()
    // `ambienteCorrente()` legge `VERCEL_ENV`: senza, l'ambiente sarebbe 'locale' e il
    // filtro su `app_log` non troverebbe le righe del fixture, che sono di 'production'.
    vi.stubEnv('VERCEL_ENV', 'production')
    for (const nome of VARIABILI_CRITICHE) vi.stubEnv(nome, 'valore-di-prova')
    montaDb(dbSano())
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('GET /api/health', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * (c) IL CASO SANO — la linea di base senza cui gli altri non provano niente
     * ═══════════════════════════════════════════════════════════════════════ */

    it('con tutto sano risponde 200 e stato ok, e ogni controllo è ok', async () => {
        const { stato, header, corpo } = await chiama()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('ok')
        expect(header).toBe('ok')
        // Non basta lo stato aggregato: se un controllo sparisse dall'elenco,
        // l'aggregato resterebbe 'ok' e nessuno se ne accorgerebbe.
        expect(corpo.controlli.map((c) => c.nome).sort()).toEqual([
            'config',
            'cron-battito',
            'db-lettura',
            'schema-atteso',
            'tasso-errore',
        ])
        for (const c of corpo.controlli) expect([c.nome, c.esito]).toEqual([c.nome, 'ok'])
        // Ogni controllo dichiara la propria durata: un controllo lento è già un segnale.
        for (const c of corpo.controlli) expect(typeof c.ms).toBe('number')
        // Una risposta di salute in cache è un 200 fossile che dice «tutto bene» a
        // servizio spento.
        expect((await GET(new Request('https://app.kidville.it/api/health'))).headers.get('Cache-Control')).toBe(
            'no-store',
        )
    })

    /* ═══════════════════════════════════════════════════════════════════════
     * (a) IL DATABASE NON RISPONDE → down, 503
     * ═══════════════════════════════════════════════════════════════════════ */

    it("con `utenti` che risponde PGRST205 lo stato è down e l'HTTP è 503", async () => {
        montaDb(dbSano(), {
            utenti: {
                code: 'PGRST205',
                message: "Could not find the table 'public.utenti' in the schema cache",
            },
        })

        const { stato, header, corpo } = await chiama()

        expect(stato).toBe(503)
        expect(corpo.stato).toBe('down')
        expect(header).toBe('down')
        expect(controllo(corpo, 'db-lettura').esito).toBe('giu')
        // Il codice dell'errore è nel dettaglio: chi riceve l'allarme deve sapere se è
        // una migrazione mancante o un database in affanno, che si riparano altrove.
        expect(controllo(corpo, 'db-lettura').dettaglio).toContain('utenti')
        expect(controllo(corpo, 'db-lettura').dettaglio).toContain('PGRST205')
        // Il guasto è PERSISTITO a livello error: un down visto alle 3 di notte deve
        // lasciare una traccia interrogabile il mattino dopo.
        expect(log.logEvento).toHaveBeenCalledWith(
            'config',
            'error',
            expect.objectContaining({ operazione: 'health', esito: 'down' }),
        )
    })

    it('una tabella dello schema atteso assente porta lo stato a down, non a degraded', async () => {
        // `avvisi` non è letta da `db-lettura`: se questo test è verde, è `schema-atteso`
        // ad averla trovata — cioè il controllo nominale esiste e funziona da solo.
        montaDb(dbSano(), { avvisi: { code: 'PGRST205', message: 'not found' } })

        const { stato, corpo } = await chiama()

        expect(stato).toBe(503)
        expect(corpo.stato).toBe('down')
        expect(controllo(corpo, 'db-lettura').esito).toBe('ok')
        expect(controllo(corpo, 'schema-atteso').esito).toBe('giu')
        expect(controllo(corpo, 'schema-atteso').dettaglio).toContain('avvisi')
    })

    /* ═══════════════════════════════════════════════════════════════════════
     * (b) UN CRON MUTO → degraded, con il NOME del job
     * ═══════════════════════════════════════════════════════════════════════ */

    it("senza battito 'ok' di notifiche-promemoria nelle ultime 26h lo stato è degraded e il job è nominato", async () => {
        const db = dbSano()
        // La riga c'è, ma è VECCHIA: è il caso che conta. Un controllo che si limitasse a
        // chiedere «esiste una riga per questo job?» sarebbe verde qui, con il job fermo
        // da più di un giorno.
        db.app_log = db.app_log.filter(
            (r) => jobDi(r) !== 'notifiche-promemoria',
        )
        db.app_log.push(battito('notifiche-promemoria', 27 * ORA))
        montaDb(db)

        const { stato, header, corpo } = await chiama()

        // Un cron fermo non impedisce a un genitore di aprire l'app: è un avviso, non
        // un'interruzione. 503 qui toglierebbe dalla rotazione un'istanza sana.
        expect(stato).toBe(200)
        expect(corpo.stato).toBe('degraded')
        expect(header).toBe('degraded')
        expect(controllo(corpo, 'cron-battito').esito).toBe('degradato')
        // IL NOME DEL JOB. «un cron è fermo» non è un allarme, è un enigma:
        // `push-dispatch` fermo significa nessuna notifica, `fattura-sync` fermo significa
        // fatture non riconciliate — due urgenze diverse e due persone da svegliare.
        expect(controllo(corpo, 'cron-battito').dettaglio).toContain('notifiche-promemoria')
        // …e SOLO quello: se il dettaglio nominasse tutti i job, non direbbe niente.
        expect(controllo(corpo, 'cron-battito').dettaglio).not.toContain('push-dispatch')
        expect(log.logEvento).toHaveBeenCalledWith(
            'config',
            'warn',
            expect.objectContaining({ operazione: 'health', esito: 'degraded' }),
        )
    })

    /* ═══════════════════════════════════════════════════════════════════════
     * IL BATTITO «ok-parziale» — il difetto che teneva l'endpoint rosso per
     * sette giorni su un lavoro che non aveva saltato una notte.
     *
     * MISURATO in produzione il 2026-08-11: `notifiche-promemoria` gira ogni
     * notte alle 06:00 UTC (`cron.job_run_details`: sette `succeeded` di fila),
     * risponde 200 — ma dal 2026-08-05 non scrive più `esito: 'ok'`. Scrive
     * `ok-parziale` a livello `warn`, perché in produzione `locker_requests` non
     * esiste e la scansione dell'armadietto viene saltata. Ultimo `ok`:
     * 2026-08-04.
     *
     * Il controllo filtrava `.eq('livello','info')` e pretendeva `esito === 'ok'`:
     * quel battito non lo vedeva né per livello né per esito, e `/api/health`
     * rispondeva «job senza battito: notifiche-promemoria» da una settimana. Un
     * allarme che suona da solo viene spento — ed è la frase scritta in testa a
     * `controlli.ts`, che il rilevatore aveva finito per applicare a se stesso.
     *
     * I due test qui sotto tengono ferme le DUE metà della correzione: che il
     * parziale conti come battito, e che si continui a leggerlo nel dettaglio.
     * ═══════════════════════════════════════════════════════════════════════ */

    it("un battito 'ok-parziale' (livello warn) vale come battito: il job ha girato, non è muto", async () => {
        const db = dbSano()
        db.app_log = db.app_log.filter((r) => jobDi(r) !== 'notifiche-promemoria')
        // La riga ESATTA che la produzione scrive: `warn` + `ok-parziale`. Se il
        // filtro tornasse a `.eq('livello','info')`, o l'esito tornasse a valere solo
        // `ok`, questa riga sparirebbe e il test diventerebbe rosso.
        db.app_log.push({
            id: 'log-parziale',
            evento: 'cron',
            livello: 'warn',
            ambiente: 'production',
            creato_il: fa(2 * ORA),
            visto_l_ultima: fa(2 * ORA),
            contesto: {
                campi: {
                    operazione: 'notifiche-promemoria',
                    esito: 'ok-parziale',
                    azione: 'armadietto',
                },
            },
        })
        montaDb(db)

        const { stato, corpo } = await chiama()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('ok')
        expect(controllo(corpo, 'cron-battito').esito).toBe('ok')
        // …e soprattutto NON deve comparire fra i muti: è il difetto misurato.
        expect(controllo(corpo, 'cron-battito').dettaglio).not.toContain('job senza battito')
    })

    it("il job che ha girato in modo parziale viene comunque NOMINATO nel dettaglio", async () => {
        // L'informazione non deve andare persa insieme al falso allarme: «ha girato
        // saltando una scansione» resta scritto, solo senza tingere di rosso. Senza
        // questa asserzione la correzione precedente si ridurrebbe a nascondere il
        // parziale, che è l'altro modo di sbagliare.
        const db = dbSano()
        db.app_log = db.app_log.filter((r) => jobDi(r) !== 'notifiche-promemoria')
        db.app_log.push({
            id: 'log-parziale',
            evento: 'cron',
            livello: 'warn',
            ambiente: 'production',
            creato_il: fa(2 * ORA),
            visto_l_ultima: fa(2 * ORA),
            contesto: { campi: { operazione: 'notifiche-promemoria', esito: 'ok-parziale' } },
        })
        montaDb(db)

        const { corpo } = await chiama()

        expect(controllo(corpo, 'cron-battito').dettaglio).toContain('parziale')
        expect(controllo(corpo, 'cron-battito').dettaglio).toContain('notifiche-promemoria')
    })

    it("un 'ok' più fresco cancella il marchio di parziale della notte prima", async () => {
        // Un job riparato stanotte non deve restare marchiato: il dettaglio descrive
        // ADESSO, non la storia.
        //
        // ⚠️ ONESTÀ SU COSA QUESTO TEST TIENE FERMO, verificato manomettendo il codice
        // e non supponendolo: la proprietà è garantita da DUE meccanismi indipendenti —
        // l'`.order('visto_l_ultima', desc)` della query e il `parziali.delete()` nel
        // ramo `else` — e togliendone UNO il test resta verde, perché l'altro basta da
        // solo. Non è quindi un lock sul singolo ramo: è un lock sul COMPORTAMENTO
        // osservabile, che diventa rosso solo se cadono entrambi. È il caso che conta,
        // perché è quello in cui il dettaglio comincerebbe a mentire.
        const db = dbSano()
        db.app_log = db.app_log.filter((r) => jobDi(r) !== 'notifiche-promemoria')
        db.app_log.push({
            id: 'log-parziale-vecchio',
            evento: 'cron',
            livello: 'warn',
            ambiente: 'production',
            creato_il: fa(25 * ORA),
            visto_l_ultima: fa(25 * ORA),
            contesto: { campi: { operazione: 'notifiche-promemoria', esito: 'ok-parziale' } },
        })
        db.app_log.push(battito('notifiche-promemoria', 2 * ORA))
        montaDb(db)

        const { corpo } = await chiama()

        expect(controllo(corpo, 'cron-battito').esito).toBe('ok')
        expect(controllo(corpo, 'cron-battito').dettaglio).not.toContain('parziale')
    })

    it("un livello 'error' non vale come battito nemmeno con un esito che somiglia", async () => {
        // Il filtro si è allargato a `warn`, e l'allargamento poteva scappare di mano:
        // `url-assente` e `post-fallito` sono righe `error` scritte DAL DATABASE quando
        // il lavoro NON è partito. Se finissero fra i battiti, il guasto più grave —
        // «il cron non chiama nessuno» — si presenterebbe come un job sano.
        const db = dbSano()
        db.app_log = db.app_log.filter((r) => jobDi(r) !== 'candidature-retention')
        db.app_log.push({
            id: 'log-url-assente',
            evento: 'cron',
            livello: 'error',
            ambiente: 'production',
            creato_il: fa(1 * ORA),
            visto_l_ultima: fa(1 * ORA),
            contesto: { campi: { operazione: 'candidature-retention', esito: 'url-assente' } },
        })
        montaDb(db)

        const { corpo } = await chiama()

        expect(corpo.stato).toBe('degraded')
        expect(controllo(corpo, 'cron-battito').dettaglio).toContain('candidature-retention')
    })

    it("una riga cron con esito diverso da 'ok' non vale come battito", async () => {
        const db = dbSano()
        // Il job è PARTITO (`avviato`) ma non ha mai dichiarato di aver finito: è
        // esattamente il guasto a metà — un job che muore ogni notte a metà lavoro. Se il
        // controllo guardasse solo `operazione`, questo sarebbe verde.
        db.app_log = db.app_log.filter((r) => jobDi(r) !== 'fattura-sync')
        db.app_log.push({
            id: 'log-avviato',
            evento: 'cron',
            livello: 'info',
            ambiente: 'production',
            creato_il: fa(1 * MIN),
            visto_l_ultima: fa(1 * MIN),
            contesto: { campi: { operazione: 'fattura-sync', esito: 'avviato' } },
        })
        montaDb(db)

        const { corpo } = await chiama()

        expect(corpo.stato).toBe('degraded')
        expect(controllo(corpo, 'cron-battito').dettaglio).toContain('fattura-sync')
    })

    /* ═══════════════════════════════════════════════════════════════════════
     * `visto_l_ultima` E NON `creato_il` — la riga più facile da sbagliare
     * ═══════════════════════════════════════════════════════════════════════ */

    it('un battito deduplicato (riga creata a inizio giornata, ultima occorrenza adesso) vale come fresco', async () => {
        // `app_log` DEDUPLICA per (fingerprint, giorno): il battito di `push-dispatch`
        // (ogni 5 minuti) è UNA riga al giorno — `creato_il` fissato al primo giro dopo la
        // mezzanotte, `visto_l_ultima` che avanza a ogni giro. Misurato in produzione il
        // 2026-08-04: 7 righe e 1848 occorrenze in sette giorni.
        //
        // Un controllo scritto su `creato_il` con finestra di 20 minuti sarebbe quindi
        // verde per venti minuti al giorno e rosso per le altre 23 ore e 40, con il job
        // perfettamente funzionante — cioè un allarme che suona sempre, e che quindi
        // verrebbe spento. Questo test è ciò che tiene la colonna giusta al suo posto.
        const db = dbSano()
        db.app_log = db.app_log.filter((r) => jobDi(r) !== 'push-dispatch')
        db.app_log.push({
            ...battito('push-dispatch', 2 * MIN),
            creato_il: fa(20 * ORA),
        })
        montaDb(db)

        const { stato, corpo } = await chiama()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('ok')
        expect(controllo(corpo, 'cron-battito').esito).toBe('ok')
    })

    /* ═══════════════════════════════════════════════════════════════════════
     * TASSO D'ERRORE
     * ═══════════════════════════════════════════════════════════════════════ */

    function conImpronteErrore(n: number, quandoMs: number): DBFinto {
        const db = dbSano()
        for (let i = 0; i < n; i++) {
            db.app_log.push({
                id: `err-${i}`,
                evento: 'route',
                livello: 'error',
                ambiente: 'production',
                creato_il: fa(quandoMs),
                visto_l_ultima: fa(quandoMs),
                contesto: { campi: {} },
            })
        }
        return db
    }

    /**
     * NUMERI LETTERALI, NON `SOGLIA_IMPRONTE_ERRORE + 1`. È una correzione fatta dopo
     * averlo sbagliato: la prima versione di questi due test costruiva il fixture DALLA
     * COSTANTE, e quindi restava verde anche portando la soglia a 1.000.000 — perché
     * cresceva insieme a lei anche il numero di righe. Provava che il confronto `>`
     * esiste, non che la soglia sia sana: un test che si adatta al difetto invece di
     * scoprirlo. La manomissione «tetto a un estremo assurdo mantenendo l'ordine
     * relativo» l'ha smascherato, e questo commento è qui perché non venga rifatto.
     *
     * Con 6 e 4 scritti a mano il confine è INCHIODATO: alzare la soglia rende rosso il
     * primo test, abbassarla rende rosso il secondo.
     */
    it("6 impronte d'errore attive negli ultimi 15 minuti portano a degraded", async () => {
        montaDb(conImpronteErrore(6, 2 * MIN))

        const { stato, corpo } = await chiama()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('degraded')
        expect(controllo(corpo, 'tasso-errore').esito).toBe('degradato')
    })

    it("4 impronte d'errore attive — il massimo osservato in produzione — restano ok", async () => {
        montaDb(conImpronteErrore(4, 2 * MIN))

        const { corpo } = await chiama()

        expect(corpo.stato).toBe('ok')
        expect(controllo(corpo, 'tasso-errore').esito).toBe('ok')
    })

    it("la soglia sta appena sopra il massimo misurato in produzione", () => {
        // MISURATO il 2026-08-04 su 7 giorni (672 finestre da 15 minuti): solo 40 finestre
        // con errori attivi, massimo 4 impronte, p99 = 4, media 2.
        //
        // Sotto 5 l'allarme suonerebbe su traffico normale e verrebbe spento entro una
        // settimana; molto sopra 5 non suonerebbe mai. Questo è l'unico test che guarda il
        // VALORE della soglia invece del confronto: senza, un numero assurdo passerebbe.
        expect(SOGLIA_IMPRONTE_ERRORE).toBeGreaterThanOrEqual(5)
        expect(SOGLIA_IMPRONTE_ERRORE).toBeLessThanOrEqual(10)
    })

    it("le stesse impronte d'errore fuori dalla finestra di 15 minuti non contano", async () => {
        // Senza questo caso, un controllo che ignorasse del tutto la finestra temporale
        // sarebbe verde nel test precedente e qui — cioè non proverebbe niente sul tempo.
        montaDb(conImpronteErrore(6, 40 * MIN))

        const { corpo } = await chiama()

        expect(corpo.stato).toBe('ok')
        expect(controllo(corpo, 'tasso-errore').esito).toBe('ok')
    })

    it("gli errori di un altro ambiente non contano come errori di questo", async () => {
        const db = conImpronteErrore(6, 2 * MIN)
        for (const r of db.app_log) if (r.livello === 'error') r.ambiente = 'preview'
        montaDb(db)

        const { corpo } = await chiama()

        expect(corpo.stato).toBe('ok')
    })

    /* ═══════════════════════════════════════════════════════════════════════
     * CONFIGURAZIONE
     * ═══════════════════════════════════════════════════════════════════════ */

    it('una variabile critica assente porta a degraded e la nomina, senza mai stampare un valore', async () => {
        vi.stubEnv('RESEND_API_KEY', '')

        const { stato, corpo, grezzo } = await chiama()

        expect(stato).toBe(200)
        expect(corpo.stato).toBe('degraded')
        expect(controllo(corpo, 'config').esito).toBe('degradato')
        expect(controllo(corpo, 'config').dettaglio).toContain('RESEND_API_KEY')
        // Il NOME sì, il VALORE mai: la rotta è pubblica, e un endpoint che stampasse
        // anche solo un prefisso di `SUPABASE_SERVICE_ROLE_KEY` sarebbe una consegna di chiavi.
        expect(grezzo).not.toContain('valore-di-prova')
    })

    it("una variabile impostata a stringa vuota è assente: `''` non configura niente", async () => {
        vi.stubEnv('CRON_SECRET', '   ')

        const { corpo } = await chiama()

        expect(controllo(corpo, 'config').esito).toBe('degradato')
        expect(controllo(corpo, 'config').dettaglio).toContain('CRON_SECRET')
    })

    /* ═══════════════════════════════════════════════════════════════════════
     * PRIVACY E TETTO PER IP — il prezzo di essere una rotta pubblica
     * ═══════════════════════════════════════════════════════════════════════ */

    it("il messaggio dell'errore PostgREST non esce nel corpo pubblico (esce solo il codice)", async () => {
        // Un messaggio di Postgres può contenere il VALORE che ha violato un vincolo:
        // su questo database, il codice fiscale di un minore. In `app_log` ci va (con la
        // redazione a proteggerlo); nel corpo di una rotta pubblica, mai.
        const SEGRETO_FINTO = 'RSSMRA10A01H501U'
        montaDb(dbSano(), {
            utenti: {
                code: '23505',
                message: `duplicate key value violates unique constraint: (codice_fiscale)=(${SEGRETO_FINTO})`,
                details: `Key (codice_fiscale)=(${SEGRETO_FINTO}) already exists.`,
            },
        })

        const { stato, corpo, grezzo } = await chiama()

        expect(stato).toBe(503)
        expect(grezzo).not.toContain(SEGRETO_FINTO)
        expect(grezzo).not.toContain('codice_fiscale')
        expect(controllo(corpo, 'db-lettura').dettaglio).toContain('23505')
    })

    it('oltre il tetto per IP risponde 429 con Retry-After e senza toccare il database', async () => {
        const req = () =>
            new Request('https://app.kidville.it/api/health', { headers: { 'x-forwarded-for': '203.0.113.9' } })
        for (let i = 0; i < 30; i++) expect((await GET(req())).status).toBe(200)

        const chiamateDbPrima = supa.createAdminClient.mock.calls.length
        const res = await GET(req())

        expect(res.status).toBe(429)
        expect(res.headers.get('Retry-After')).toBeTruthy()
        // Un endpoint di salute fa otto query a chiamata: se il tetto scattasse DOPO
        // averle fatte, sarebbe un amplificatore di carico verso il database puntabile
        // da chiunque — cioè la causa del guasto che dovrebbe rilevare.
        expect(supa.createAdminClient.mock.calls.length).toBe(chiamateDbPrima)
    })

    it('IP diversi hanno tetti diversi', async () => {
        const con = (ip: string) =>
            new Request('https://app.kidville.it/api/health', { headers: { 'x-forwarded-for': ip } })
        for (let i = 0; i < 30; i++) await GET(con('203.0.113.1'))

        expect((await GET(con('203.0.113.1'))).status).toBe(429)
        expect((await GET(con('198.51.100.7'))).status).toBe(200)
    })

    /* ═══════════════════════════════════════════════════════════════════════
     * LOCK — contro la deriva della lista duplicata
     * ═══════════════════════════════════════════════════════════════════════ */

    it("l'elenco delle variabili critiche coincide con quello del preflight di instrumentation.ts", () => {
        // `variabiliCritiche()` non è esportata da `instrumentation.ts` (un export
        // impedirebbe al bundler di eliminarla dal bundle Edge), quindi la lista è
        // duplicata. Questo lock è ciò che rende la duplicazione difendibile: il giorno in
        // cui qualcuno aggiunge una variabile critica al preflight e non qui, l'endpoint
        // di salute smetterebbe in silenzio di sorvegliarla.
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'instrumentation.ts'), 'utf8')
        const blocco = /function variabiliCritiche\(\)[\s\S]*?\n\}/.exec(src)
        expect(blocco, 'variabiliCritiche() non trovata in instrumentation.ts').not.toBeNull()
        const nomi = [...blocco![0].matchAll(/\[\s*'([A-Z0-9_]+)'\s*,/g)].map((m) => m[1])
        expect(nomi.length).toBeGreaterThan(0)
        expect([...nomi].sort()).toEqual([...VARIABILI_CRITICHE].sort())
    })

    it('la password Aruba è sorvegliata, e l\'utenza deliberatamente NO', () => {
        // Il lock qui sopra pretende che le DUE copie coincidano — ma resterebbe verde
        // anche se qualcuno togliesse una variabile da entrambe. Per la fatturazione
        // elettronica quel silenzio costa caro: senza `ARUBA_PASSWORD` nessun documento
        // parte, e non lo si scopre finché la segreteria non preme «Fattura», cioè quando
        // sta già cercando di emettere. Questa riga è ciò che impedisce di perderla.
        expect(
            VARIABILI_CRITICHE,
            'senza ARUBA_PASSWORD nessuna fattura elettronica può essere emessa',
        ).toContain('ARUBA_PASSWORD')

        // E l'assenza dell'utenza è voluta, non una dimenticanza: `resolveArubaCredentials`
        // legge `config.username || ARUBA_USERNAME`, e lo username sta già in
        // `admin_settings.aruba_config.username`. Sorvegliare un ripiego significherebbe
        // suonare l'allarme per una configurazione che funziona — e un allarme che suona a
        // torto è un allarme che qualcuno spegne.
        expect(
            VARIABILI_CRITICHE,
            "ARUBA_USERNAME ha un ripiego in banca dati: sorvegliarlo produrrebbe un falso allarme",
        ).not.toContain('ARUBA_USERNAME')
    })

    it('i job sorvegliati esistono davvero: una route HTTP, oppure una funzione SQL che batte', () => {
        // Un nome di job sbagliato produce un allarme permanente su un job che non
        // esiste: rumore che porta a spegnere l'allarme. I nomi vengono da `app_log` in
        // produzione, ma la loro sorgente è la costante `JOB` delle route —
        // O una funzione SQL che scrive il battito con quel `fingerprint`.
        //
        // La seconda forma è entrata con `presenze-giustificazioni-retention` (rilievo Q3):
        // è un lavoro di sola SQL, non passa da nessuna route, e il suo battito lo scrive
        // `INSERT INTO public.app_log … 'cron:<nome>'` dentro la migrazione. Pretendere una
        // route lo escluderebbe dalla sorveglianza per una ragione puramente formale — cioè
        // rimetterebbe fuori dal radar proprio il lavoro che fa scadere un dato sanitario
        // di un minore.
        const root = path.join(process.cwd(), 'src', 'app', 'api')
        const trovati = new Set<string>()
        const scandisci = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name)
                if (e.isDirectory()) scandisci(full)
                else if (e.name === 'route.ts') {
                    for (const m of fs.readFileSync(full, 'utf8').matchAll(/const JOB = '([^']+)'/g)) {
                        trovati.add(m[1])
                    }
                }
            }
        }
        scandisci(root)

        const migrazioni = path.join(process.cwd(), 'supabase', 'migrations')
        const sql = fs.readdirSync(migrazioni)
            .filter((f) => f.endsWith('.sql'))
            .map((f) => fs.readFileSync(path.join(migrazioni, f), 'utf8'))
            .join('\n')

        const inesistenti = JOB_CRON.map((j) => j.nome)
            .filter((n) => !trovati.has(n) && !sql.includes(`'cron:${n}'`))
        expect(
            inesistenti,
            'job sorvegliati che non corrispondono né a una route né a un battito SQL',
        ).toEqual([])
    })
})
