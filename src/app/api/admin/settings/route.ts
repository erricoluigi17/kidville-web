import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const DEFAULT_SCUOLA = '11111111-1111-1111-1111-111111111111'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/**
 * scuola_id opzionale: qualunque valore falsy ('', null, assente) viene trattato
 * come "non fornito" così il codice applica il fallback storico
 * `?scuola_id= || auth.user.scuola_id || DEFAULT_SCUOLA`, come prima.
 */
const zScuolaId = z.preprocess((v) => v || undefined, zUuid.optional())

const getQuerySchema = z.object({ scuola_id: zScuolaId })

// Campi ammessi nel PATCH (upsert selettivo). Oggi sono accettati senza vincoli
// di tipo (tipi/CHECK li fa rispettare il DB): schema volutamente permissivo
// (z.unknown().optional() — l'.optional() è OBBLIGATORIO: in zod v4 z.unknown()
// nudo renderebbe la chiave required a runtime).
const ALLOWED_FIELDS = [
  'retta_default_importo',
  'retta_giorno_scadenza',
  'retta_giorno_visibilita',
  'retta_auto_enabled',
  'insoluto_tolleranza_giorni',
  'ticket_pacchetti',
  'fattura_causale_template',
  'mensa_cutoff_ora',
  'mensa_giorni_attivi',
  'mensa_settimane_rotazione',
  'mensa_soglia_saldo_basso',
  'timelock_giorni_classe_orale',
  'timelock_giorni_scritto_pratico',
  'notif_buffer_valutazioni_min',
  'funzioni_matrice',
  'diario_config',
  'presenze_config',
  'note_config',
  'avvisi_config',
  'chat_config',
  'galleria_config',
  'armadietto_config',
  'modulistica_config',
  'segreteria_config',
] as const

const patchBodySchema = z.object({
  scuola_id: zScuolaId,
  ...Object.fromEntries(ALLOWED_FIELDS.map((f) => [f, z.unknown().optional()])),
})

// GET /api/admin/settings?userId=&scuola_id=  (staff) — impostazioni della scuola
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const scuolaId =
      (q.data.scuola_id as string | undefined) || auth.user.scuola_id || DEFAULT_SCUOLA
    const supabase = await createAdminClient()

    const { data, error } = await supabase
      .from('admin_settings')
      .select('*')
      .eq('scuola_id', scuolaId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // default se non esiste ancora
    const settings = data ?? {
      scuola_id: scuolaId,
      retta_default_importo: 150,
      retta_giorno_scadenza: 5,
      retta_giorno_visibilita: 25,
      retta_auto_enabled: true,
      insoluto_tolleranza_giorni: 7,
      ticket_pacchetti: [],
      fattura_causale_template: '{descrizione} - {alunno}',
      aruba_config: {},
      mensa_cutoff_ora: '09:30',
      mensa_giorni_attivi: [1, 2, 3, 4, 5],
      mensa_settimane_rotazione: 4,
      mensa_soglia_saldo_basso: 5,
    }
    return NextResponse.json({ success: true, data: settings })
  } catch (err) {
    console.error('Errore API GET settings:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/admin/settings  (staff) — upsert impostazioni
// Body: { userId, scuola_id?, retta_default_importo?, retta_giorno_scadenza?,
//         retta_auto_enabled?, insoluto_tolleranza_giorni?, ticket_pacchetti? }
// NB: aruba_config si gestisce dalla route dedicata /api/admin/settings/aruba
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data as Record<string, unknown>
    const scuolaId =
      (body.scuola_id as string | undefined) || auth.user.scuola_id || DEFAULT_SCUOLA

    // Chiavi JSONB salvate in shallow-merge con l'esistente, così pannelli
    // diversi possono salvare indipendentemente senza sovrascriversi.
    const mergedKeys = [
      'funzioni_matrice',
      'diario_config',
      'presenze_config',
      'note_config',
      'avvisi_config',
      'chat_config',
      'galleria_config',
      'armadietto_config',
      'modulistica_config',
      'segreteria_config',
    ]
    const updates: Record<string, unknown> = { scuola_id: scuolaId }
    for (const f of ALLOWED_FIELDS) if (body[f] !== undefined) updates[f] = body[f]

    const supabase = await createAdminClient()

    const incomingMerged = mergedKeys.filter((k) => updates[k] !== undefined)
    if (incomingMerged.length > 0) {
      const { data: existing } = await supabase
        .from('admin_settings')
        .select(incomingMerged.join(','))
        .eq('scuola_id', scuolaId)
        .maybeSingle()
      const existingRow = (existing ?? {}) as Record<string, unknown>
      for (const k of incomingMerged) {
        const prev = (existingRow[k] ?? {}) as Record<string, unknown>
        const next = updates[k] as Record<string, unknown>
        if (k === 'funzioni_matrice') {
          // merge per-grado: {primaria: {...prev, ...next}, ...}
          const merged: Record<string, unknown> = { ...prev }
          for (const grado of Object.keys(next)) {
            merged[grado] = {
              ...((prev[grado] as Record<string, unknown>) ?? {}),
              ...((next[grado] as Record<string, unknown>) ?? {}),
            }
          }
          updates[k] = merged
        } else {
          updates[k] = { ...prev, ...next }
        }
      }
    }
    const { data, error } = await supabase
      .from('admin_settings')
      .upsert(updates, { onConflict: 'scuola_id' })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API PATCH settings:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
