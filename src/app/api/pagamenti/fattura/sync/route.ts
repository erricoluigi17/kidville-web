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

// POST /api/pagamenti/fattura/sync — polling stato SDI delle fatture in volo.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret` (pattern push/dispatch).
// Lo invoca il cron pg_cron (vedi migrazione). Per ogni fattura non terminale
// interroga Aruba, mappa lo stato (DL-020) e, su scarto, notifica la Segreteria.
const STATI_IN_VOLO = [1, 3, 5]

const postQuerySchema = z.object({}) // nessun parametro in ingresso

export async function POST(request: Request) {
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const { data: pendenti } = await supabase
      .from('fatture_emesse')
      .select('id, pagamento_id, scuola_id, numero, aruba_filename, sdi_stato')
      .in('sdi_stato', STATI_IN_VOLO)
      .not('aruba_filename', 'is', null)
      .limit(200)

    const righe = (pendenti ?? []) as {
      id: string
      pagamento_id: string
      scuola_id: string
      numero: number
      aruba_filename: string
      sdi_stato: number
    }[]
    if (righe.length === 0) {
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
        const { data: settings } = await supabase
          .from('admin_settings')
          .select('aruba_config')
          .eq('scuola_id', f.scuola_id)
          .maybeSingle()
        configCache.set(f.scuola_id, (settings?.aruba_config ?? null) as ArubaConfig | null)
      }
      const cfg = configCache.get(f.scuola_id)
      const creds = cfg ? resolveArubaCredentials(cfg) : null
      if (!cfg?.abilitato || !creds) {
        if (!scuoleSkipped.has(f.scuola_id)) {
          scuoleSkipped.add(f.scuola_id)
          console.warn(
            `[ARUBA] sync fatture saltato per scuola ${f.scuola_id}: credenziali_non_configurate (abilitato=${Boolean(cfg?.abilitato)})`
          )
        }
        continue
      }

      // token (uno per scuola)
      let token = tokenCache.get(f.scuola_id)
      if (!token) {
        try {
          token = (await arubaSignin(cfg.ambiente, creds)).accessToken
          tokenCache.set(f.scuola_id, token)
        } catch {
          continue
        }
      }

      // stato Aruba
      let stato: { stato: number; pdfBase64?: string | null }
      try {
        stato = await arubaGetByFilename(cfg.ambiente, token, f.aruba_filename, { includePdf: true })
      } catch {
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
        } catch {
          pdfPath = null
        }
      }

      await supabase
        .from('fatture_emesse')
        .update({
          sdi_stato: stato.stato,
          sdi_stato_label: m.label,
          sdi_scarto_motivo: m.isScarto ? m.label : null,
          ...(pdfPath ? { pdf_path: pdfPath } : {}),
          aggiornata_il: nowIso,
        })
        .eq('id', f.id)

      // Stato aggregato del pagamento dalle sue quote. Rileggo tutte le righe e
      // sostituisco in memoria quella appena aggiornata (la SELECT potrebbe non
      // riflettere ancora l'update appena fatto).
      const { data: tutte } = await supabase
        .from('fatture_emesse')
        .select('id, numero, sdi_stato, quota_adult_id, pdf_path')
        .eq('pagamento_id', f.pagamento_id)
      const righeAgg = ((tutte ?? []) as (RigaFatturaAgg & { id: string; pdf_path: string | null })[]).map((r) =>
        r.id === f.id ? { ...r, sdi_stato: stato.stato, pdf_path: pdfPath ?? r.pdf_path } : r
      )
      const statoAgg = aggregaFatturaStato(righeAgg)
      // fattura_pdf_path resta sul pagamento SOLO per fattura singola (compat legacy);
      // con più quote il download è per-fattura (vedi /api/pagamenti/fattura?fattura_id=).
      const pdfSingola = righeAgg.length <= 1 ? righeAgg[0]?.pdf_path ?? null : null

      await supabase
        .from('pagamenti')
        .update({ fattura_stato: statoAgg, ...(pdfSingola ? { fattura_pdf_path: pdfSingola } : {}) })
        .eq('id', f.pagamento_id)
      processate++

      if (m.isScarto) {
        scartate++
        const { data: staff } = await supabase
          .from('utenti')
          .select('id')
          .eq('scuola_id', f.scuola_id)
          .in('ruolo', ['admin', 'coordinator', 'segreteria'])
        const utenteIds = ((staff ?? []) as { id: string }[]).map((u) => u.id)
        await enqueueNotifiche(supabase, {
          utenteIds,
          tipo: 'fattura_scartata',
          titolo: 'Fattura scartata dallo SDI',
          corpo: `Fattura n. ${f.numero}: ${m.label}. Verifica i dati e reinvia.`,
          link: '/admin/pagamenti',
          entitaTipo: 'fattura',
          entitaId: f.id,
        })
      }
    }

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
    console.error('Errore API POST fattura/sync:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
