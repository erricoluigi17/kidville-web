import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { eseguiGiroCoda, type EsitoGiro } from '@/lib/fatture-coda/giro'

/**
 * POST /api/pagamenti/fattura/coda/giro — un giro del lavoratore della coda fatture.
 *
 * SERVICE-TO-SERVICE: lo chiamano il cron `fatture-coda-tick` (ogni cinque minuti, fuori
 * dai minuti della sync) e la «sveglia» dopo un accodamento, entrambi via
 * `public.fatture_coda_tick_http()` con l'header `x-cron-secret`. Nessun utente: il gate è
 * il segreto, e il client è il service role — la coda non ha policy, si scrive solo dalle
 * RPC. Tutto il lavoro sta in `src/lib/fatture-coda/giro.ts`; qui c'è la porta e il battito.
 *
 * ⚠️ Il giro legge e scrive la coda di TUTTE le sedi, ed è voluto (nucleo, decisione 6):
 * le tre sedi escono con UNA sola utenza Aruba e un solo secchio orario, quindi il
 * lavoratore è uno per tutti. Il gate di sede di ogni voce è stato fatto all'accodamento.
 */

/**
 * ⚠️ 300 SCRITTO A MANO: Next legge la configurazione di segmento STATICAMENTE, e un valore
 * importato fa fallire il build («Invalid segment configuration export detected»). Il
 * budget del blocco (`MAX_DURATION_BLOCCO_S` in `lotto-fatture.ts`) è tarato su questo
 * muro, e un test legge questo sorgente per tenere insieme i due numeri.
 */
export const maxDuration = 300

// Battito cardiaco del cron: pg_net chiama in fire-and-forget, quindi un job che non parte
// non lascia traccia — si sorveglia l'ASSENZA. `operazione` e non `job` (lista bianca di
// `redact`), e il nome nel `msg` perché `app_log` deduplica per (fingerprint, giorno) e il
// `contesto` NON è nell'impronta. La spiegazione per esteso è in
// `src/app/api/push/dispatch/route.ts`.
const JOB = 'fatture-coda-tick'

const postQuerySchema = z.object({}) // nessun parametro in ingresso

/**
 * ⚠️ `esito` È IL VOCABOLARIO DI `/api/health`, NON QUELLO DEL GIRO. Il controllo del battito
 * (`controlloBattitoCron` in `src/lib/health/controlli.ts`) conta come vivo un job solo se
 * trova `esito` in `ESITI_BATTITO` — cioè `ok` o `ok-parziale`. Scrivere lì
 * `niente-da-fare` o `finestra-sync` farebbe dare «senza battito» a un cron che gira
 * benissimo, ora che `fatture-coda-tick` è entrato in `JOB_CRON` (dal 2026-09-23, PR-B della
 * coda, finestra di 30 minuti): l'allarme che suona da solo, e che quindi viene spento.
 * Per questo ogni esito che non sia `errore` batte `esito: 'ok'` a livello info, e l'esito
 * del giro va in `tipo` (lista bianca di `redact`).
 * Il `tipo` sta anche nel `msg`, perché l'impronta di `app_log` non guarda il contesto:
 * una riga al giorno per tipo, ciascuna col proprio `contesto` coerente.
 */
function battito(tipo: EsitoGiro['esito'], t0: number, giro?: EsitoGiro, err?: unknown): void {
  const fallito = tipo === 'errore'
  logEvento(
    'cron',
    fallito ? 'error' : 'info',
    {
      operazione: JOB,
      esito: fallito ? 'errore' : 'ok',
      tipo,
      emesse: giro?.emesse ?? 0,
      errori: giro?.errori ?? 0,
      riprova: giro?.riprova ?? 0,
      pausa_minuti: giro?.pausaMinuti ?? 0,
      ms: Date.now() - t0,
      msg: `${JOB}: ${tipo}`,
    },
    err,
  )
}

export const POST = withRoute('pagamenti/fattura/coda/giro:POST', async (request: Request) => {
  const t0 = Date.now()
  const secret = request.headers.get('x-cron-secret')
  if (!segretoCronValido(secret)) {
    // Si grida SOLO se l'header c'è ma non torna: quello è un cron che bussa con la chiave
    // sbagliata, ed è il guasto invisibile — la coda smetterebbe di svuotarsi e la
    // segreteria, a PC spento, non lo saprebbe. Sul POST ANONIMO si tace: la route è
    // pubblica, e una riga `error` per ogni `curl` fabbricherebbe dal nulla proprio il
    // segnale «il cron è rotto». Stesso ragionamento di `fattura/sync`.
    if (secret) {
      logEvento('cron', 'error', {
        operazione: JOB,
        esito: 'secret-errato',
        msg: process.env.CRON_SECRET
          ? `${JOB}: x-cron-secret non corrispondente`
          : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
      })
    }
    // Col codice (lock `errori-con-codice`): lo stesso della porta cron di `iscrizione/import-massivo`.
    return NextResponse.json({ error: 'Non autorizzato', codice: 'CRON_NON_AUTORIZZATO' }, { status: 401 })
  }

  const q = parseQuery(request, postQuerySchema)
  if ('response' in q) return q.response

  let giro: EsitoGiro
  try {
    const supabase = await createAdminClient()
    giro = await eseguiGiroCoda(supabase)
  } catch (err) {
    // Il giro non lancia per progetto; se succede lo stesso, il battito c'è comunque —
    // di livello `error`, con l'eccezione attaccata.
    battito('errore', t0, undefined, err)
    return NextResponse.json({ ok: false, esito: 'errore', emesse: 0, errori: 0, riprova: 0 }, { status: 500 })
  }

  // Il battito in OGNI esito, anche «niente da fare» e «finestra della sync»: con i soli
  // errori, nessuna riga non distingue «la coda è vuota» da «il cron non parte più».
  const fallito = giro.esito === 'errore'
  battito(giro.esito, t0, giro)

  return NextResponse.json(
    { ok: !fallito, esito: giro.esito, emesse: giro.emesse, errori: giro.errori, riprova: giro.riprova },
    { status: fallito ? 500 : 200 },
  )
})
