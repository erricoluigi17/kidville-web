import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { ambienteCorrente } from '@/lib/logging/ambiente'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import type { Salute, StatoSalute } from '@/lib/health/controlli'

/**
 * LA PORTA DEI TRE ENDPOINT DI SALUTE (`/api/health/vivo`, `/api/health`, `/api/health/qualita`).
 *
 * La MISURA sta in `@/lib/health/controlli`, con lì la spiegazione di ogni controllo e i numeri
 * misurati in produzione. Qui c'è solo ciò che i tre endpoint hanno in comune: tetto per IP,
 * traduzione dello stato in codice HTTP, riga di log quando qualcosa non va, risposta senza cache.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * PERCHÉ SONO PUBBLICI, E COSA QUESTO OBBLIGA
 *
 * Un monitor esterno non ha sessione: se l'endpoint richiedesse un'autenticazione, l'unico modo di
 * sorvegliarlo sarebbe depositare una credenziale a lunga vita dentro un servizio terzo. Il prezzo
 * di essere pubblici lo si paga in due modi, entrambi qui:
 *
 *  1. il CORPO non dice mai più del necessario — nomi di controllo, nomi di job, nomi di tabella,
 *     codici d'errore, numeri, la regione e lo sha del deploy. Mai il `message` di PostgREST (può
 *     contenere il valore che ha violato un vincolo, cioè su questo database il codice fiscale di
 *     un minore), mai il valore di una variabile d'ambiente, mai un conteggio di alunni;
 *  2. c'è un TETTO PER IP, distinto per endpoint. Non è formalità: ogni chiamata fa da una a
 *     otto query. Senza tetto sarebbe un amplificatore di carico verso il database puntabile da
 *     chiunque — un endpoint di salute che diventa la causa del guasto.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * I TRE CASI, E PERCHÉ `degraded` RISPONDE 200
 *
 *   ok        → 200
 *   degraded  → 200, con `stato: "degraded"` nel corpo e l'header `X-Kv-Salute`
 *   down      → 503
 *
 * `degraded` significa «l'applicazione serve i genitori correttamente, ma qualcosa che nessuno
 * vedrebbe è rotto»: un cron fermo da 26 ore, una `RESEND_API_KEY` sparita da un deploy. Rispondere
 * 503 lì significherebbe dire a un load balancer di togliere dalla rotazione un'istanza sana — cioè
 * trasformare in interruzione di servizio un avviso su un guasto che interruzione non è.
 *
 * I tre casi restano distinguibili a tre livelli di sofisticazione del monitor: il codice HTTP
 * («giù» da «non giù»), l'header `X-Kv-Salute` (tutti e tre, senza parsare niente), il corpo (QUALE
 * controllo è caduto e da quanto).
 *
 * `Cache-Control: no-store` non è un dettaglio: una risposta di salute messa in cache da una CDN è
 * un 200 fossile che continuerebbe a dire «tutto bene» a servizio spento.
 */

/** Un monitor serio interroga ogni 30-60 secondi (2 al minuto): il tetto è quindici volte il
 *  bisogno legittimo, e non inciampa mai un uso reale nemmeno con quattro monitor sullo stesso
 *  URL. Il contatore è per istanza (vedi `@/lib/security/rate-limit`): il tetto effettivo è N × 30. */
const TETTO_PER_IP = { limit: 30, windowMs: 60_000 }

export interface OpzioniPorta {
    /** Nome del livello: chiave del tetto per IP e operazione nel log. */
    nome: 'health' | 'health-vivo' | 'health-qualita'
    /**
     * Come si ottiene il client service role. Lo passa OGNI route (`() => createAdminClient()`) e non
     * si importa qui, di proposito: il lock `isolamento-sede-coverage` riconosce le route che usano il
     * service role dal `createAdminClient(` scritto NEL FILE della route. Importarlo qui farebbe
     * sparire i tre endpoint dall'inventario senza cambiare niente di ciò che fanno.
     */
    creaClient: () => Promise<SupabaseClient>
    esegui: (supabase: SupabaseClient, ambiente: string) => Promise<Salute>
    /** Stato → codice HTTP. */
    http: Record<StatoSalute, number>
    /** Codice HTTP se la misura stessa lancia (quasi sempre: `SUPABASE_SERVICE_ROLE_KEY` assente). */
    httpSuEccezione: number
    /** Livello del log quando lo stato è `degraded`. La qualità dei dati non deve sporcare i
     *  livelli persistiti: `info` non finisce in `app_log`. */
    livelloDegradato: 'warn' | 'info'
}

export async function rispondiConSalute(request: Request, opz: OpzioniPorta): Promise<Response> {
    const t0 = Date.now()
    try {
        const ip = clientIp(request)
        const tetto = await rateLimit(`${opz.nome}:${ip}`, TETTO_PER_IP)
        if (!tetto.ok) {
            // Non si logga: `withRoute` registra già i 429 a livello `warn` (e li persiste). Una riga
            // in più qui vorrebbe dire che chiunque può riempire `app_log` bussando — cioè
            // fabbricare rumore dentro lo strumento con cui si cercano i guasti veri.
            return NextResponse.json(
                { stato: 'sconosciuto', errore: 'Troppe richieste' },
                {
                    status: 429,
                    headers: {
                        'Retry-After': String(Math.ceil(tetto.retryAfterMs / 1000)),
                        'Cache-Control': 'no-store',
                    },
                },
            )
        }

        const ambiente = ambienteCorrente()
        const supabase = await opz.creaClient()
        const salute = await opz.esegui(supabase, ambiente)

        // ─────────────────────────────────────────────────────────────────────
        // COSA SI LOGGA, E COSA NO.
        //
        // Lo stato `ok` NON produce una riga propria: `withRoute` emette già il suo `KV_OK` per ogni
        // chiamata, quindi «l'health-check gira» è registrato. Una riga applicativa in più, a
        // migliaia di chiamate al giorno, sarebbe solo rumore dentro lo strumento che serve a
        // trovare il segnale.
        //
        // `degraded` e `down` invece sì, e a livello `warn`/`error` perché è il livello che
        // `vaPersistito` porta in tabella: senza, un degrado visto da un monitor alle 3 di notte non
        // lascerebbe NESSUNA traccia interrogabile il mattino dopo.
        //
        // `evento: 'config'`: `EVENTI_NOTI` è un vocabolario CHIUSO (lock
        // `__tests__/architecture/eventi-log.test.ts`) e non contiene `health`. `config` è la voce
        // esistente più vicina (è quella del preflight d'avvio) ed è persistita.
        //
        // I `dettaglio` finiscono nel `msg`, che è una colonna VERA di `app_log`: sono nomi di
        // controllo, nomi di job e codici — mai dati personali. Non passano come campi perché
        // `redact()` è a lista bianca PER CHIAVE e in tabella uscirebbero come `[redatto:str/…]`.
        // ─────────────────────────────────────────────────────────────────────
        if (salute.stato !== 'ok') {
            const rotti = salute.controlli.filter((c) => c.esito !== 'ok')
            const livello = salute.stato === 'down' ? 'error' : opz.livelloDegradato
            logEvento('config', livello, {
                operazione: opz.nome,
                esito: salute.stato,
                ms: Date.now() - t0,
                n: rotti.length,
                msg:
                    `${opz.nome}: ${salute.stato} — ` +
                    rotti.map((c) => `${c.nome}(${c.esito})${c.dettaglio ? `: ${c.dettaglio}` : ''}`).join(' | '),
            })
        }

        return NextResponse.json(salute, {
            status: opz.http[salute.stato],
            headers: { 'X-Kv-Salute': salute.stato, 'Cache-Control': 'no-store' },
        })
    } catch (err) {
        // Un'eccezione qui è quasi sempre `createAdminClient()` senza `SUPABASE_SERVICE_ROLE_KEY`,
        // cioè un deploy che nasce rotto. `logErrore` porta lo stack VERO e il corpo dell'errore in
        // tabella. Al chiamante, che è il mondo, esce solo lo stato.
        logErrore({ operazione: `${opz.nome}:GET`, ms: Date.now() - t0, stato: opz.httpSuEccezione }, err)
        return NextResponse.json(
            { stato: 'down', ms: Date.now() - t0, controlli: [] },
            { status: opz.httpSuEccezione, headers: { 'X-Kv-Salute': 'down', 'Cache-Control': 'no-store' } },
        )
    }
}
