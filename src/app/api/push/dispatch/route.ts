import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/http'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { eseguiDispatch, JOB_DISPATCH } from '@/lib/push/dispatch'

const postQuerySchema = z.object({}) // nessun parametro in ingresso (il body eventuale del cron non viene letto)

/**
 * IL BATTITO CARDIACO DEL CRON — la spiegazione sta qui, gli altri quattro job la
 * richiamano in breve.
 *
 * pg_net invoca questa route in fire-and-forget, dentro un `EXCEPTION WHEN OTHERS THEN
 * null`. Conseguenza: se il secret è sbagliato, se il job non è schedulato o se l'URL
 * salvato nel Vault è vecchio, **non arriva niente** — e ciò che non arriva non si logga.
 * Un errore lo si vede; un job che non parte, no. L'unico modo di sorvegliare un guasto
 * così è sorvegliare l'ASSENZA: il job dichiara «sono partito» e «ho finito», e il giorno
 * in cui quelle righe non compaiono più è il silenzio stesso il sintomo.
 *
 * TRE DECISIONI, tutte e tre obbligate (e tutte e tre diverse da come verrebbe naturale):
 *
 * 1. `operazione`, NON `job`. `redact()` è a lista bianca PER CHIAVE: `operazione` è in
 *    lista, `job` no — in tabella uscirebbe come `[redatto:str/13]` e la riga non direbbe
 *    più QUALE job. È anche la stessa chiave con cui `withRoute` nomina le rotte, quindi
 *    una query sola le trova tutte.
 *
 * 2. Il nome del job sta ANCHE nel `msg`, e non è ridondanza. `app_log` deduplica per
 *    (fingerprint, giorno), e l'impronta è livello+evento+route+messaggio+codice+utente:
 *    `contesto` NON ne fa parte. Finché queste route non sono avvolte da `withRoute` la
 *    colonna `route` è NULL → i battiti «ok» dei cinque cron avrebbero impronta IDENTICA,
 *    collasserebbero in una riga sola con il `contesto` del primo arrivato, e il battito
 *    di quattro job su cinque semplicemente non esisterebbe. `msg` finisce nella colonna
 *    `messaggio` (via `testoEvento`), che è vera, in chiaro e dentro l'impronta.
 *
 * 3. Il battito di chiusura va su OGNI return di successo, non solo sull'ultimo. La
 *    notte in cui non c'è niente da inviare è il caso NORMALE: se lì mancasse l'«ok», la
 *    sorveglianza vedrebbe un job partito e mai finito e griderebbe al lupo ogni notte —
 *    finendo per essere ignorata proprio quando il lupo arriva davvero.
 *
 * `cron` è in `EVENTI_PERSISTITI`: anche i successi finiscono in `app_log`. È voluto —
 * con i soli errori, «nessun log» non distingue «tutto ok» da «non è mai partito niente».
 */
// Dal 24/09 (PS2) i battiti «avviato» e «ok» e le righe d'errore del giro li scrive
// `eseguiDispatch` in `src/lib/push/dispatch.ts`, con questo stesso nome di job; qui resta solo
// la riga del secret sbagliato.
//
// IL NOME RESTA SCRITTO QUI IN LETTERE, e non è una copia distratta di `JOB_DISPATCH`. È il punto
// in cui chi legge le route trova i job che `/api/health` sorveglia: il lock «i job sorvegliati
// esistono davvero» in `__tests__/api/health.test.ts` cerca il letterale nelle `route.ts`, e senza
// di esso `push-dispatch` risulterebbe un job che non esiste. Che sia lo STESSO nome con cui la lib
// scrive il battito del cron lo garantisce `satisfies`: `JOB_DISPATCH` ha il tipo letterale
// `'push-dispatch'`, e se qualcuno lo rinomina `tsc` si ferma qui invece di lasciare `/api/health`
// a cercare un battito che nessuno scrive più (o a rincorrere quello della chat, che batte sotto
// `push-dispatch-chat` proprio per non passare per il cron).
const JOB = 'push-dispatch' satisfies typeof JOB_DISPATCH

/**
 * LA DURATA DELLA FUNZIONE È LA TERZA DIFESA DELLA PRESA (vedi «IL PREZZO DELLA PRESA» in
 * `src/lib/push/dispatch.ts`). Il giro PRENDE le notifiche prima di spedirle: se la piattaforma
 * lo tronca dopo la presa, restano marcate e non partono più, e non resta nemmeno una riga di
 * log. Il tetto del giro (`TETTO_GIRO_MS`, 40 s) le rimette in coda, ma solo se la funzione vive
 * abbastanza da arrivarci: al default della piattaforma (10 s, vedi
 * `src/app/api/pagamenti/riconciliazione/route.ts`) non scatterebbe mai.
 *
 * IL CASO PEGGIORE non è «il tetto più una notifica»: il tetto si guarda solo prima di
 * cominciare una notifica, e il budget dei ritentativi (`BUDGET_RITENTATIVI_MS`, 20 s) per
 * dispositivo. Un invio nativo che comincia a 19,9 s ha ancora tutti i ritentativi: token OAuth,
 * tre `messages:send` al tetto di 10 s di `externalFetch` e due attese fino a 10 s (il
 * `Retry-After` di un `429`) fanno 60 s. Poi ogni altro dispositivo della stessa notifica ne
 * aggiunge fino a 20 senza ritentativi, e alla fine c'è il ritorno in coda, a blocchi, più la
 * rimozione dei dispositivi morti. E il tetto del giro, dentro il ciclo, non copre ciò che viene
 * PRIMA. Le letture (notifiche e dispositivi) sono GET, che postgrest-js ritenta da solo su
 * 503/520 e sugli errori di rete, con attese fino al `Retry-After` senza limite superiore: il loro
 * tempo non ha un tetto, e per questo il giro guarda l'orologio SUBITO PRIMA della presa
 * (`SOGLIA_PRESA_MS`) e oltre non prende niente. Dopo quel controllo restano la presa a blocchi e
 * il badge (scritture e RPC, non ritentate) e il ritorno in coda di tutte le prese. Il conto
 * intero, ricavato dai tetti veri e dai blocchi che `LIMITE_LETTURA` e `ID_PER_QUERY` impongono, è
 * `DURATA_MINIMA_FUNZIONE_S` in `src/lib/push/durata-dispatch.ts` (250 s con i valori di oggi e 5
 * dispositivi per utente).
 *
 * 300 s è il valore delle altre route cron lunghe del repo (`pagamenti/fattura/coda/giro`,
 * `pagamenti/riconciliazione`). Il lock in `__tests__/lib/push-dispatch-durata.test.ts` pretende
 * da ogni route che chiama `eseguiDispatch` un `maxDuration` di almeno `DURATA_MINIMA_FUNZIONE_S`:
 * chi alza un tetto alza anche la soglia. Il valore resta un numero scritto qui, perché Next legge
 * la configurazione del segmento senza eseguire il codice.
 */
export const maxDuration = 300

// POST /api/push/dispatch — invio Web Push delle notifiche non ancora inviate.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret`. NON chiamabile dal browser.
// Lo invoca il cron (pg_net) dopo aver inserito le notifiche, oppure manualmente.
export const POST = withRoute('push/dispatch:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!segretoCronValido(secret)) {
      // SI GRIDA SOLO SE L'HEADER C'È MA NON TORNA. Quello è un cron che bussa con la chiave
      // sbagliata: il guasto invisibile, e il motivo per cui questa riga esiste (da fuori è
      // indistinguibile da un cron che non gira). Il POST ANONIMO, invece, tace: la route è
      // pubblica e senza rate-limit, e un `curl -X POST /api/push/dispatch` scriverebbe una
      // riga `error` in tabella — cioè fabbricherebbe dal nulla il segnale «il cron è rotto»,
      // che è precisamente il segnale che questa riga porta. Un bot che bussa 10.000 volte
      // renderebbe l'allarme vero indistinguibile dal rumore, e l'unico modo di difendersi da
      // un allarme rumoroso è smettere di guardarlo.
      // (Il caso «CRON_SECRET non configurato» è coperto a monte dal preflight di
      // `src/instrumentation.ts`, che lo grida all'avvio: qui resta nel messaggio perché
      // separa i due incidenti veri, che si riparano in due posti diversi — la chiave nel
      // Vault del DB, la env var su Vercel.)
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET
            ? `${JOB}: x-cron-secret non corrispondente`
            : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
        })
      }
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }
    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    // Tutto il giro (lettura, presa atomica, invii, ritorno in coda, battito) sta in
    // `src/lib/push/dispatch.ts`, riusabile da chi deve spedire subito (la chat). Non lancia mai:
    // un guasto è già loggato là dentro, e qui diventa il 500 che vede il cron.
    const esito = await eseguiDispatch({ origine: 'cron' })
    if (esito.stato === 500) return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    return NextResponse.json({ success: true, data: esito.data })
  } catch (err) {
    // La rete sotto il controllo del secret: `eseguiDispatch` non lancia, ma qui sopra ci sono
    // header e query. `evento: 'cron'`, perché chi sorveglia i cron interroga quel flusso.
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
