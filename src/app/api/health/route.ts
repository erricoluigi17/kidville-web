import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { ambienteCorrente } from '@/lib/logging/ambiente'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { eseguiControlli, type StatoSalute } from '@/lib/health/controlli'

/**
 * GET /api/health — l'endpoint di salute. PUBBLICO.
 *
 * La MISURA sta tutta in `@/lib/health/controlli`, con lì la spiegazione di ogni
 * controllo e i numeri misurati in produzione. Qui c'è solo la porta: tetto per IP,
 * traduzione dello stato in codice HTTP, e la riga di log quando qualcosa non va.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * PERCHÉ È PUBBLICA, E COSA QUESTO OBBLIGA
 *
 * Un monitor esterno non ha sessione: se l'endpoint richiedesse un'autenticazione,
 * l'unico modo di sorvegliarlo sarebbe depositare una credenziale a lunga vita dentro
 * un servizio terzo. Il prezzo di essere pubblica lo si paga in due modi, entrambi qui:
 *
 *  1. il CORPO non dice mai più del necessario — nomi di controllo, nomi di job, nomi
 *     di tabella, codici d'errore, numeri. Mai il `message` di PostgREST (può contenere
 *     il valore che ha violato un vincolo, cioè su questo database il codice fiscale di
 *     un minore), mai il valore di una variabile d'ambiente, mai un conteggio di alunni;
 *  2. c'è un TETTO PER IP. Non è formalità: questo endpoint fa otto query a ogni
 *     chiamata. Senza tetto sarebbe un amplificatore di carico verso il database
 *     puntabile da chiunque — un endpoint di salute che diventa la causa del guasto.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * I TRE CASI, E PERCHÉ `degraded` RISPONDE 200
 *
 *   ok        → 200
 *   degraded  → 200, con `stato: "degraded"` nel corpo e l'header `X-Kv-Salute`
 *   down      → 503
 *
 * La domanda vera è se `degraded` debba essere 503, e la risposta è no. `degraded`
 * significa «l'applicazione serve i genitori correttamente, ma qualcosa che nessuno
 * vedrebbe è rotto»: un cron fermo da 26 ore, una `RESEND_API_KEY` sparita da un deploy.
 * Rispondere 503 lì significa dire a un load balancer di togliere dalla rotazione
 * un'istanza sana — cioè trasformare in interruzione di servizio un avviso su un guasto
 * che interruzione non è. Il contrario di ciò che serve.
 *
 * I tre casi restano distinguibili a tre livelli di sofisticazione del monitor:
 *  · chi legge solo il codice HTTP distingue «giù» da «non giù», che è il minimo utile;
 *  · chi legge l'header `X-Kv-Salute` distingue tutti e tre senza parsare niente;
 *  · chi legge il corpo ottiene anche QUALE controllo è caduto e da quanto.
 * L'header esiste proprio per il livello di mezzo: molti uptime monitor sanno cercare
 * una stringa in un header o nel corpo, e nessuno di loro deve dover fare del JSON.
 *
 * `Cache-Control: no-store` non è un dettaglio: una risposta di salute messa in cache
 * da una CDN è un 200 fossile che continuerebbe a dire «tutto bene» a servizio spento.
 */

// Nessun parametro in ingresso. Lo schema c'è comunque, e non è cerimonia: senza,
// `/api/health?scuola_id=…` accetterebbe in silenzio qualunque cosa, e la prima volta
// che qualcuno aggiunge un filtro a questo endpoint lo aggiungerebbe su una porta senza
// validazione. `z.object({})` non è strict: un monitor può appendere il suo `?t=` per
// bucare le cache senza prendersi un 400.
const querySchema = z.object({})

/** L'endpoint misura lo stato ADESSO: non deve essere prerenderizzato né rivalidato. */
export const dynamic = 'force-dynamic'

/**
 * 30 richieste al minuto per IP. Un monitor serio interroga ogni 30-60 secondi (2 al
 * minuto), quindi il tetto è quindici volte il bisogno legittimo: non inciampa mai un
 * uso reale, nemmeno con quattro monitor diversi puntati sullo stesso URL.
 *
 * Il contatore è per istanza (vedi la testata di `@/lib/security/rate-limit`): il tetto
 * effettivo è N × 30. Qui va bene — serve ad alzare il costo di un abuso, non a
 * contarlo, e non c'è nulla di segreto da proteggere con un tetto esatto.
 */
const TETTO_PER_IP = { limit: 30, windowMs: 60_000 }

const HTTP: Record<StatoSalute, number> = { ok: 200, degraded: 200, down: 503 }

export const GET = withRoute('health:GET', async (request: Request) => {
    const t0 = Date.now()
    try {
        const q = parseQuery(request, querySchema)
        if ('response' in q) return q.response

        const ip = clientIp(request)
        const tetto = rateLimit(`health:${ip}`, TETTO_PER_IP)
        if (!tetto.ok) {
            // Non si logga: `withRoute` registra già i 429 a livello `warn` (e li
            // persiste). Una riga in più qui vorrebbe dire che chiunque può riempire
            // `app_log` bussando — cioè fabbricare rumore dentro lo strumento con cui si
            // cercano i guasti veri.
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
        const supabase = await createAdminClient()
        const salute = await eseguiControlli(supabase, { ambiente })

        // ─────────────────────────────────────────────────────────────────────
        // COSA SI LOGGA, E COSA NO.
        //
        // Lo stato `ok` NON produce una riga propria: `withRoute` emette già il suo
        // `KV_OK` per ogni chiamata, quindi «l'health-check gira» è registrato. Una riga
        // applicativa in più, a 2880 chiamate al giorno, sarebbe solo rumore dentro lo
        // strumento che serve a trovare il segnale.
        //
        // `degraded` e `down` invece sì, e a livello `warn`/`error` perché è il livello
        // che `vaPersistito` porta in tabella: senza, un degrado visto da un monitor alle
        // 3 di notte non lascerebbe NESSUNA traccia interrogabile il mattino dopo — e
        // l'endpoint di salute non sarebbe osservabile lui stesso.
        //
        // `evento: 'config'`: `EVENTI_NOTI` è un vocabolario CHIUSO (lock
        // `__tests__/architecture/eventi-log.test.ts`) e non contiene `health`. Un nome
        // nuovo si aggiunge deliberatamente in `logger.ts`, non lo si inventa in una
        // route — è così che sono nati i sinonimi che spezzavano le query. `config` è la
        // voce esistente più vicina (è quella del preflight d'avvio) ed è persistita.
        //
        // I `dettaglio` finiscono nel `msg`, che è una colonna VERA di `app_log`: sono
        // nomi di controllo, nomi di job e codici — mai dati personali. Non passano come
        // campi perché `redact()` è a lista bianca PER CHIAVE e in tabella uscirebbero
        // come `[redatto:str/…]`, cioè la riga non direbbe più COSA è caduto.
        // ─────────────────────────────────────────────────────────────────────
        if (salute.stato !== 'ok') {
            const rotti = salute.controlli.filter((c) => c.esito !== 'ok')
            logEvento('config', salute.stato === 'down' ? 'error' : 'warn', {
                operazione: 'health',
                esito: salute.stato,
                ms: Date.now() - t0,
                n: rotti.length,
                msg:
                    `health: ${salute.stato} — ` +
                    rotti.map((c) => `${c.nome}(${c.esito})${c.dettaglio ? `: ${c.dettaglio}` : ''}`).join(' | '),
            })
        }

        return NextResponse.json(salute, {
            status: HTTP[salute.stato],
            headers: { 'X-Kv-Salute': salute.stato, 'Cache-Control': 'no-store' },
        })
    } catch (err) {
        // Un'eccezione qui è quasi sempre `createAdminClient()` senza
        // `SUPABASE_SERVICE_ROLE_KEY`, cioè un deploy che nasce rotto. La risposta è 503
        // — «down» è esattamente ciò che è — e `logErrore` porta lo stack VERO e il corpo
        // dell'errore in tabella. Al chiamante, che è il mondo, esce solo lo stato.
        logErrore({ operazione: 'health:GET', ms: Date.now() - t0, stato: 503 }, err)
        return NextResponse.json(
            { stato: 'down', ms: Date.now() - t0, controlli: [] },
            { status: 503, headers: { 'X-Kv-Salute': 'down', 'Cache-Control': 'no-store' } },
        )
    }
})
