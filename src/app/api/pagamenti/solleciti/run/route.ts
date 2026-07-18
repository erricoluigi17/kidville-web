import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sollecitaPagamenti } from '@/lib/pagamenti/solleciti-invio'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import type { SollecitiConfig } from '@/lib/pagamenti/solleciti'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'

// Corpo vuoto ammesso: la route è service-to-service (zod per il lock di copertura).
const bodySchema = z.object({}).passthrough().optional()

// Battito cardiaco del cron: pg_net chiama in fire-and-forget con `EXCEPTION WHEN OTHERS
// THEN null`, quindi un job che non parte non lascia traccia — si sorveglia l'ASSENZA.
// `operazione` e non `job` (lista bianca di `redact`), e il nome nel `msg` perché
// `app_log` deduplica per (fingerprint, giorno) e il `contesto` NON è nell'impronta.
// La spiegazione per esteso è in `src/app/api/push/dispatch/route.ts`.
const JOB = 'pagamenti-solleciti'

/**
 * Query fallita → riga d'errore parlante + 500, e NESSUN battito «ok».
 *
 * PostgREST non lancia, ritorna `{ error }` (regola 7 di AGENTS.md): il `try/catch` di questo
 * handler non scatta mai su una query rotta. La lettura di `admin_settings`, poche righe più in
 * basso, `error` lo controllava già — quella dei candidati no: la stessa incoerenza dentro lo
 * stesso file, e il ramo non controllato è quello che chiude con «ok, inviati 0». La
 * spiegazione per esteso è in `src/app/api/push/dispatch/route.ts`.
 */
function queryFallita(azione: string, error: unknown, t0: number): NextResponse {
  logEvento(
    'cron',
    'error',
    { operazione: JOB, esito: 'query-fallita', azione, ms: Date.now() - t0, msg: `${JOB}: ${azione} fallita` },
    error,
  )
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
}

// POST /api/pagamenti/solleciti/run — giro automatico dei solleciti.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret` (pattern fattura/sync).
// Sostituisce integralmente la vecchia genera_solleciti() SQL (deprecata,
// mai schedulata): prima aggiorna gli stati `scaduto`, poi invia i solleciti
// SOLO per le scuole con solleciti_config.enabled (default off), livelli 1-2
// (il 3° resta manuale), pagamenti obbligatori.
export const POST = withRoute('pagamenti/solleciti/run:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      // Si grida SOLO se l'header c'è ma non torna: quello è un cron che bussa con la chiave
      // sbagliata, ed è il guasto invisibile (un sollecito che non parte non lo reclama
      // nessuno: il moroso tace, e il silenzio sembra «tutto pagato»). Sul POST ANONIMO si
      // tace: la route è pubblica e senza rate-limit, e una riga `error` per ogni `curl`
      // fabbricherebbe dal nulla proprio il segnale che questa riga serve a portare.
      // Il messaggio separa i due incidenti veri (secret sbagliato nel Vault del DB;
      // `CRON_SECRET` assente su Vercel — quest'ultimo già gridato dal preflight di
      // `src/instrumentation.ts`).
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
    logEvento('cron', 'info', { operazione: JOB, esito: 'avviato', msg: `${JOB}: avviato` })

    // il body, se presente, non è usato: validato solo per coerenza
    bodySchema.parse(await request.json().catch(() => ({})))

    const supabase = await createAdminClient()
    const oggi = new Date().toISOString().slice(0, 10)

    // 1) refresh stati: gli aperti oltre scadenza diventano `scaduto`
    // Anche una UPDATE ritorna `{ error }` senza lanciare. Se salta, le morosità non compaiono
    // negli scadenziari e nella vista morosi: il giro dopo la si ritenta, ma solo se qualcuno
    // sa che è saltata — motivo per cui non può finire in `void`.
    const { error: errStati } = await supabase
      .from('pagamenti')
      .update({ stato: 'scaduto' })
      .in('stato', ['da_pagare', 'parziale'])
      .lt('scadenza', oggi)
    if (errStati) return queryFallita('aggiornamento stati scaduti', errStati, t0)

    // 1b) SAFETY-NET revoca automatica morosità: dopo il refresh degli stati,
    // individua i sospesi per morosità e revoca chi ha saldato TUTTO lo scaduto
    // famiglia. È un rete di sicurezza: la revoca scatta già dagli hook su
    // incassi/storno/transazioni, ma se un pagamento è arrivato fuori da quei
    // percorsi (bonifica, correzione manuale) qui la si recupera. Mai un crash del
    // cron: PostgREST non lancia (si controlla `{ error }`) e verificaRevoca è
    // best-effort. Retry 42703: colonna assente sul DB non migrato → nessuna revoca.
    try {
      const sel = await supabase
        .from('alunni')
        .select('id')
        .eq('sospeso', true)
        .eq('sospeso_causa', 'morosita')
      if (sel.error) {
        if (['42703', 'PGRST204'].includes((sel.error as { code?: string }).code ?? '')) {
          logEvento('cron', 'warn', { operazione: JOB, esito: 'revoca-morosita-non-disponibile' }, sel.error)
        } else {
          logEvento('cron', 'error', { operazione: JOB, esito: 'lettura-sospesi-fallita' }, sel.error)
        }
      } else {
        const idsSospesi = ((sel.data ?? []) as { id: string }[]).map((r) => r.id)
        if (idsSospesi.length > 0) {
          const { revocati } = await verificaRevocaSospensioneMorosita(supabase, idsSospesi)
          if (revocati.length > 0) {
            logEvento('cron', 'info', { operazione: JOB, esito: 'revoca-morosita', revocati: revocati.length, msg: `${JOB}: revoca-morosita` })
          }
        }
      }
    } catch (e) {
      // La safety-net non deve MAI abbattere il giro dei solleciti.
      logEvento('cron', 'error', { operazione: JOB, esito: 'revoca-morosita-errore' }, e)
    }

    // 2) scuole con invio automatico attivo
    const { data: settingsRows, error } = await supabase
      .from('admin_settings')
      .select('scuola_id, solleciti_config')
    if (error) {
      // colonna assente (DB non migrato): niente da fare, mai crash.
      // Ma qui ci finisce QUALUNQUE errore — un 503, un timeout, una RLS cambiata — e fino
      // a ieri usciva tutto come «zero solleciti da inviare», con un 200. Il 4° argomento
      // porta il codice e il messaggio di PostgREST nella riga: `disponibile: false` da
      // solo non ha mai detto PERCHÉ.
      logEvento('cron', 'warn', { operazione: JOB, esito: 'config-non-leggibile', ms: Date.now() - t0 }, error)
      return NextResponse.json({ success: true, inviati: 0, disponibile: false })
    }
    const abilitate = ((settingsRows || []) as { scuola_id: string; solleciti_config?: SollecitiConfig | null }[])
      .filter((r) => r.solleciti_config?.enabled)
      .map((r) => r.scuola_id)
    if (abilitate.length === 0) {
      // Nessuna scuola con l'invio automatico attivo: è la configurazione di default
      // (`enabled` off), non un guasto. Ma il battito di chiusura ci vuole lo stesso —
      // altrimenti il caso NORMALE sembrerebbe un job partito e mai finito.
      logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'ok',
        ms: Date.now() - t0,
        scuole_attive: 0,
        inviati: 0,
        esaminati: 0,
        msg: `${JOB}: ok`,
      })
      return NextResponse.json({ success: true, inviati: 0 })
    }

    // 3) candidati: aperti oltre scadenza, obbligatori, niente contenitori padre
    const { data: candidati, error: errCandidati } = await supabase
      .from('pagamenti')
      .select('id')
      .in('scuola_id', abilitate)
      .in('stato', ['da_pagare', 'parziale', 'scaduto'])
      .lt('scadenza', oggi)
      .neq('tipo', 'padre')
      .eq('obbligatorio', true)
      .limit(500)
    // Il ramo `ids.length === 0` qui sotto scrive «ok, esaminati 0»: senza questo controllo una
    // query fallita si travestirebbe da «nessun moroso» — la notizia più bella e più falsa che
    // un log possa dare a una segreteria.
    if (errCandidati) return queryFallita('lettura pagamenti candidati', errCandidati, t0)
    const ids = ((candidati || []) as { id: string }[]).map((c) => c.id)
    if (ids.length === 0) {
      logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'ok',
        ms: Date.now() - t0,
        scuole_attive: abilitate.length,
        inviati: 0,
        esaminati: 0,
        msg: `${JOB}: ok`,
      })
      return NextResponse.json({ success: true, inviati: 0 })
    }

    const esiti = await sollecitaPagamenti(supabase, ids, { automatico: true })
    const inviati = esiti.filter((e) => e.ok).length
    // `esaminati` e `inviati` insieme: se divergono di molto, i solleciti partono ma non
    // arrivano — ed è esattamente il guasto (silenzioso) che è già costato mesi di email
    // di credenziali mai consegnate.
    logEvento('cron', 'info', {
      operazione: JOB,
      esito: 'ok',
      ms: Date.now() - t0,
      scuole_attive: abilitate.length,
      inviati,
      esaminati: ids.length,
      msg: `${JOB}: ok`,
    })
    return NextResponse.json({ success: true, inviati, esaminati: ids.length })
  } catch (err) {
    // `evento: 'cron'`: il fallimento totale del job resta nello stesso flusso dei battiti
    // (`where evento = 'cron'`). `logErrore` emette anche l'Error nativo con lo stack VERO.
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
