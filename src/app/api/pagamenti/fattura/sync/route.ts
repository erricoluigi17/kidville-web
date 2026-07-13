import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'
import {
  arubaSignin,
  arubaGetByFilename,
  resolveArubaCredentials,
  type ArubaConfig,
} from '@/lib/aruba/client'
import { mapStatoAruba, aggregaFatturaStato, type RigaFatturaAgg } from '@/lib/aruba/stato'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'

// POST /api/pagamenti/fattura/sync — polling stato SDI delle fatture in volo.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret` (pattern push/dispatch).
// Lo invoca il cron pg_cron (vedi migrazione). Per ogni fattura non terminale
// interroga Aruba, mappa lo stato (DL-020) e, su scarto, notifica la Segreteria.
const STATI_IN_VOLO = [1, 3, 5]

const postQuerySchema = z.object({}) // nessun parametro in ingresso

// Battito cardiaco del cron: pg_net chiama in fire-and-forget con `EXCEPTION WHEN OTHERS
// THEN null`, quindi un job che non parte non lascia traccia — si sorveglia l'ASSENZA.
// `operazione` e non `job` (lista bianca di `redact`), e il nome nel `msg` perché
// `app_log` deduplica per (fingerprint, giorno) e il `contesto` NON è nell'impronta.
// La spiegazione per esteso è in `src/app/api/push/dispatch/route.ts`.
const JOB = 'fattura-sync'

/**
 * Query fallita → riga d'errore parlante + 500, e NESSUN battito «ok».
 *
 * PostgREST non lancia, ritorna `{ error }` (regola 7 di AGENTS.md): il `try/catch` di questo
 * handler non scatta mai su una query rotta. Qui il ramo non controllato è particolarmente
 * insidioso perché la route ha già una nozione legittima di «salto questa scuola»
 * (`credenziali-mancanti`): una lettura fallita ci si travestirebbe dentro, e il giro
 * chiuderebbe «ok» mentre uno scarto SDI resta invisibile. La spiegazione per esteso è in
 * `src/app/api/push/dispatch/route.ts`.
 */
function queryFallita(azione: string, error: unknown, t0: number, scuolaId?: string): NextResponse {
  // `scuola_id` è un uuid: `redact` lascia in chiaro i valori auto-descrittivi, quindi anche
  // nella riga persistita si legge QUALE scuola stava fallendo.
  logEvento(
    'cron',
    'error',
    {
      operazione: JOB,
      esito: 'query-fallita',
      azione,
      scuola_id: scuolaId,
      ms: Date.now() - t0,
      msg: `${JOB}: ${azione} fallita`,
    },
    error,
  )
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
}

export const POST = withRoute('pagamenti/fattura/sync:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      // Si grida SOLO se l'header c'è ma non torna: quello è un cron che bussa con la chiave
      // sbagliata, ed è il guasto invisibile (se questo giro non parte, le fatture restano «in
      // volo» per sempre e nessuno si accorge di uno scarto SDI). Sul POST ANONIMO si tace: la
      // route è pubblica e senza rate-limit, e una riga `error` per ogni `curl` fabbricherebbe
      // dal nulla proprio il segnale «il cron è rotto» che questa riga serve a portare.
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

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const { data: pendenti, error: errPendenti } = await supabase
      .from('fatture_emesse')
      .select('id, pagamento_id, scuola_id, numero, aruba_filename, sdi_stato')
      .in('sdi_stato', STATI_IN_VOLO)
      .not('aruba_filename', 'is', null)
      .limit(200)
    // Senza questo controllo «la query è fallita» e «nessuna fattura in volo» sono lo stesso
    // ramo — e il secondo chiude con un «ok».
    if (errPendenti) return queryFallita('lettura fatture_emesse', errPendenti, t0)

    const righe = (pendenti ?? []) as {
      id: string
      pagamento_id: string
      scuola_id: string
      numero: number
      aruba_filename: string
      sdi_stato: number
    }[]
    if (righe.length === 0) {
      // Nessuna fattura in volo: è il caso normale, e ha comunque bisogno del suo «ok» —
      // senza, il giro più frequente sembrerebbe partito e mai finito.
      logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'ok',
        ms: Date.now() - t0,
        processate: 0,
        scartate: 0,
        skipped: 0,
        msg: `${JOB}: ok`,
      })
      return NextResponse.json({ success: true, data: { processate: 0, scartate: 0, skipped: 0 } })
    }

    const configCache = new Map<string, ArubaConfig | null>()
    const tokenCache = new Map<string, string>()
    // Scuole saltate per gating credenziali: MAI in silenzio (M2.4) — contate,
    // loggate e riportate nella risposta con il motivo.
    const scuoleSkipped = new Set<string>()
    let processate = 0
    let scartate = 0

    for (const f of righe) {
      // config + credenziali per scuola
      if (!configCache.has(f.scuola_id)) {
        const { data: settings, error } = await supabase
          .from('admin_settings')
          .select('aruba_config')
          .eq('scuola_id', f.scuola_id)
          .maybeSingle()
        // Una lettura fallita darebbe `cfg = null` → la scuola verrebbe saltata con il `warn`
        // `credenziali-mancanti`, cioè con una DIAGNOSI SBAGLIATA: chi legge quella riga va a
        // configurare Aruba per una scuola che Aruba ce l'ha già. Un log che accusa il posto
        // sbagliato fa perdere più tempo di un log che manca.
        if (error) return queryFallita('lettura admin_settings', error, t0, f.scuola_id)
        configCache.set(f.scuola_id, (settings?.aruba_config ?? null) as ArubaConfig | null)
      }
      const cfg = configCache.get(f.scuola_id)
      const creds = cfg ? resolveArubaCredentials(cfg) : null
      if (!cfg?.abilitato || !creds) {
        if (!scuoleSkipped.has(f.scuola_id)) {
          scuoleSkipped.add(f.scuola_id)
          // `warn` e non `error`: una scuola con Aruba deliberatamente spento è la
          // normalità, non un incidente. Ma non può sparire in silenzio (M2.4) — le sue
          // fatture restano in volo per sempre e il giro chiude comunque «ok».
          // `scuola_id` è un uuid: `redact` lascia in chiaro i valori auto-descrittivi,
          // quindi si legge QUALE scuola anche nella riga persistita.
          logEvento('cron', 'warn', {
            operazione: JOB,
            esito: 'credenziali-mancanti',
            scuola_id: f.scuola_id,
            abilitato: Boolean(cfg?.abilitato),
            msg: `${JOB}: scuola saltata, credenziali Aruba non configurate`,
          })
        }
        continue
      }

      // token (uno per scuola)
      let token = tokenCache.get(f.scuola_id)
      if (!token) {
        try {
          token = (await arubaSignin(cfg.ambiente, creds)).accessToken
          tokenCache.set(f.scuola_id, token)
        } catch (e) {
          // Era un `catch { continue }` MUTO, ed è il divieto n° 6 di AGENTS.md: se il
          // login ad Aruba fallisce (password ruotata, ambiente sbagliato, SDI giù) le
          // fatture di questa scuola non vengono più interrogate — e la route risponde
          // 200 con `processate: 0`, che si legge come «niente da fare».
          logEvento('cron', 'error', { operazione: JOB, esito: 'aruba-signin-fallita', scuola_id: f.scuola_id }, e)
          continue
        }
      }

      // stato Aruba
      let stato: { stato: number; pdfBase64?: string | null }
      try {
        stato = await arubaGetByFilename(cfg.ambiente, token, f.aruba_filename, { includePdf: true })
      } catch (e) {
        // Stesso argomento del signin: senza questa riga, una fattura che Aruba non sa più
        // rileggere resta in volo all'infinito senza che nessuno sappia perché.
        logEvento('cron', 'error', { operazione: JOB, esito: 'aruba-stato-fallito', scuola_id: f.scuola_id }, e)
        continue
      }
      if (stato.stato === f.sdi_stato) continue // nessun cambiamento

      const m = mapStatoAruba(stato.stato)
      const nowIso = new Date().toISOString()

      // copia di cortesia PDF (best-effort) su stato valido. Chiave PER RIGA
      // (${pagamento}-${numero}.pdf): con più quote la 2ª non sovrascrive la 1ª.
      let pdfPath: string | null = null
      if (!m.isScarto && stato.pdfBase64) {
        pdfPath = `${f.pagamento_id}-${f.numero}.pdf` // chiave relativa al bucket "fatture"
        try {
          const storage = (supabase as { storage?: { from: (b: string) => { upload: (p: string, d: Buffer, o?: unknown) => Promise<unknown> } } }).storage
          await storage?.from('fatture').upload(pdfPath, Buffer.from(stato.pdfBase64, 'base64'), {
            contentType: 'application/pdf',
            upsert: true,
          })
        } catch (e) {
          pdfPath = null
          // Copia di CORTESIA: il suo fallimento non blocca la sincronizzazione dello
          // stato SDI, che è il dato che conta — per questo resta `warn` e non `error`.
          // Ma un genitore che non trova la fattura da scaricare arriva in segreteria, e
          // senza questa riga nessuno saprebbe collegare le due cose.
          logEvento('cron', 'warn', {
            operazione: JOB,
            esito: 'pdf-copia-fallita',
            scuola_id: f.scuola_id,
            bucket: 'fatture',
          }, e)
        }
      }

      const { error: errUpdFattura } = await supabase
        .from('fatture_emesse')
        .update({
          sdi_stato: stato.stato,
          sdi_stato_label: m.label,
          sdi_scarto_motivo: m.isScarto ? m.label : null,
          ...(pdfPath ? { pdf_path: pdfPath } : {}),
          aggiornata_il: nowIso,
        })
        .eq('id', f.id)
      // Se questa UPDATE salta in silenzio, la fattura resta «in volo» e il giro dopo la
      // ripesca: si ripete all'infinito senza che nessuno sappia perché.
      if (errUpdFattura) return queryFallita('aggiornamento fatture_emesse', errUpdFattura, t0, f.scuola_id)

      // Stato aggregato del pagamento dalle sue quote. Rileggo tutte le righe e
      // sostituisco in memoria quella appena aggiornata (la SELECT potrebbe non
      // riflettere ancora l'update appena fatto).
      const { data: tutte, error: errTutte } = await supabase
        .from('fatture_emesse')
        .select('id, numero, sdi_stato, quota_adult_id, pdf_path')
        .eq('pagamento_id', f.pagamento_id)
      // LA LETTURA PIÙ VELENOSA DEL FILE, perché il suo fallimento non si limita a tacere: SCRIVE
      // IL FALSO. Con `tutte` a `null`, `righeAgg` è `[]` → `aggregaFatturaStato([])` vale
      // `in_attesa` → il pagamento verrebbe riscritto «in attesa» anche per una fattura appena
      // CONSEGNATA o SCARTATA, con una conseguenza fiscale. Un aggregato calcolato su una lettura
      // fallita non è un aggregato: è un'invenzione. Si esce prima di scrivere.
      if (errTutte) return queryFallita('rilettura quote fattura', errTutte, t0, f.scuola_id)
      const righeAgg = ((tutte ?? []) as (RigaFatturaAgg & { id: string; pdf_path: string | null })[]).map((r) =>
        r.id === f.id ? { ...r, sdi_stato: stato.stato, pdf_path: pdfPath ?? r.pdf_path } : r
      )
      const statoAgg = aggregaFatturaStato(righeAgg)
      // fattura_pdf_path resta sul pagamento SOLO per fattura singola (compat legacy);
      // con più quote il download è per-fattura (vedi /api/pagamenti/fattura?fattura_id=).
      const pdfSingola = righeAgg.length <= 1 ? righeAgg[0]?.pdf_path ?? null : null

      const { error: errUpdPagamento } = await supabase
        .from('pagamenti')
        .update({ fattura_stato: statoAgg, ...(pdfSingola ? { fattura_pdf_path: pdfSingola } : {}) })
        .eq('id', f.pagamento_id)
      // La fattura è già stata marcata terminale qui sopra: se questa UPDATE salta e tace, il
      // pagamento resta «in attesa» per sempre — e il giro successivo NON lo ripesca (la fattura
      // non è più in volo). Divergenza permanente fra le due tabelle, e nessuno lo saprebbe.
      if (errUpdPagamento) return queryFallita('aggiornamento pagamenti', errUpdPagamento, t0, f.scuola_id)
      processate++

      if (m.isScarto) {
        scartate++
        const { data: staff, error: errStaff } = await supabase
          .from('utenti')
          .select('id')
          .eq('scuola_id', f.scuola_id)
          .in('ruolo', ['admin', 'coordinator', 'segreteria'])
        // Stesso schema del `push_subscriptions` di `push/dispatch`: se questa lettura fallisce e
        // si tira dritto, `utenteIds` è vuoto → `enqueueNotifiche` non avvisa NESSUNO dello
        // scarto, e la fattura è ormai in stato terminale → il giro dopo non la ripesca. L'avviso
        // di uno scarto SDI andrebbe perso per sempre, con il battito che dice «ok».
        if (errStaff) return queryFallita('lettura staff scuola', errStaff, t0, f.scuola_id)
        const utenteIds = ((staff ?? []) as { id: string }[]).map((u) => u.id)
        await enqueueNotifiche(supabase, {
          utenteIds,
          tipo: 'fattura_scartata',
          titolo: 'Fattura scartata dallo SDI',
          corpo: `Fattura n. ${f.numero}: ${m.label}. Verifica i dati e reinvia.`,
          link: '/admin/pagamenti',
          entitaTipo: 'fattura',
          entitaId: f.id,
          scuolaId: f.scuola_id,
        })
      }
    }

    // I contatori sono NUMERI: passano in chiaro anche in tabella. `scartate` soprattutto —
    // è l'unico numero di questo giro che ha una conseguenza fiscale.
    logEvento('cron', 'info', {
      operazione: JOB,
      esito: 'ok',
      ms: Date.now() - t0,
      esaminate: righe.length,
      processate,
      scartate,
      skipped: scuoleSkipped.size,
      msg: `${JOB}: ok`,
    })
    return NextResponse.json({
      success: true,
      data: {
        processate,
        scartate,
        skipped: scuoleSkipped.size,
        ...(scuoleSkipped.size > 0 ? { motivo: 'credenziali_non_configurate' } : {}),
      },
    })
  } catch (err) {
    // `evento: 'cron'`: il fallimento totale del job resta nello stesso flusso dei battiti
    // (`where evento = 'cron'`). `logErrore` emette anche l'Error nativo con lo stack VERO.
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
