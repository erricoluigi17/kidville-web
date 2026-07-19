import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/**
 * scuola_id opzionale: qualunque valore falsy ('', null, assente) viene trattato
 * come "non fornito" così la scuola viene risolta dallo scope reale dell'admin
 * (resolveScuolaScrittura), usando l'eventuale scuola_id come sede preferita.
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
  'fiscale_config',
  'solleciti_config',
  'notifiche_config',
  'rette_config',
  'causali_config',
] as const

// Configurazione rette (sconto fratelli + pro-rata iscrizione) — shape S6.
// Validazione conservativa: la shape è quella di `@/lib/pagamenti/rette-config`.
// zod scarta le chiavi ignote; i valori vengono comunque risanificati dalla SQL
// (`genera_rette_mensili` v2) e dal client (`normalizzaRetteConfig`).
const zScaglioneFratelli = z.object({
  posizione: z.coerce.number().int().min(2).max(50),
  valore: z.coerce.number().min(0).max(1_000_000),
})
const zScaglioneProRata = z.object({
  dal_giorno: z.coerce.number().int().min(1).max(31),
  percentuale: z.coerce.number().min(0).max(100),
})
const zRetteConfig = z.object({
  sconto_fratelli: z
    .object({
      enabled: z.boolean().optional(),
      modo: z.enum(['percentuale', 'importo']).optional(),
      scaglioni: z.array(zScaglioneFratelli).max(50).optional(),
    })
    .optional(),
  pro_rata_iscrizione: z
    .object({
      enabled: z.boolean().optional(),
      scaglioni: z.array(zScaglioneProRata).max(31).optional(),
    })
    .optional(),
})

const patchBodySchema = z.object({
  scuola_id: zScuolaId,
  ...Object.fromEntries(ALLOWED_FIELDS.map((f) => [f, z.unknown().optional()])),
  // Override della validazione permissiva: rette_config ha una shape nota.
  rette_config: zRetteConfig.optional(),
})

// GET /api/admin/settings?userId=&scuola_id=  (staff) — impostazioni della scuola
export const GET = withRoute('admin/settings:GET', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response

      const supabase = await createAdminClient()
      const sw = await resolveScuolaScrittura(
        request,
        supabase,
        auth.user,
        (q.data.scuola_id as string | undefined) ?? undefined,
      )
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId as string

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
      logErrore({ operazione: 'admin/settings:GET', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})

// PATCH /api/admin/settings  (staff) — upsert impostazioni
// Body: { userId, scuola_id?, retta_default_importo?, retta_giorno_scadenza?,
//         retta_auto_enabled?, insoluto_tolleranza_giorni?, ticket_pacchetti? }
// NB: aruba_config si gestisce dalla route dedicata /api/admin/settings/aruba
export const PATCH = withRoute('admin/settings:PATCH', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const b = await parseBody(request, patchBodySchema)
      if ('response' in b) return b.response
      const body = b.data as Record<string, unknown>

      const supabase = await createAdminClient()
      const sw = await resolveScuolaScrittura(
        request,
        supabase,
        auth.user,
        (body.scuola_id as string | undefined) ?? undefined,
      )
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId as string

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
        'fiscale_config',
        'solleciti_config',
        'notifiche_config',
        'rette_config',
        'causali_config',
      ]
      const updates: Record<string, unknown> = { scuola_id: scuolaId }
      for (const f of ALLOWED_FIELDS) if (body[f] !== undefined) updates[f] = body[f]

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
            if (k === 'causali_config') {
              // Solo stringhe NON vuote: una stringa vuota = reset al Predefinito
              // (si rimuove la chiave — lo shallow-merge da solo non potrebbe), e
              // nessun valore non-stringa (che farebbe esplodere renderCausale → 500).
              updates[k] = Object.fromEntries(
                Object.entries(updates[k] as Record<string, unknown>)
                  .filter(([, val]) => typeof val === 'string' && (val as string).trim() !== ''),
              )
            }
          }
        }
      }
      let { data, error } = await supabase
        .from('admin_settings')
        .upsert(updates, { onConflict: 'scuola_id' })
        .select()
        .single()

      // Degradazione: sul DB E2E CI (NON migrato) alcune colonne JSONB recenti
      // (rette_config, causali_config) non esistono ancora → PostgREST risponde
      // PGRST204. Si rimuovono e si ritenta, salvando tutto il resto best-effort
      // (il flusso base resta invariato) con un warn. In produzione le colonne
      // esistono, quindi questo ramo non scatta mai.
      const COLONNE_RECENTI = ['rette_config', 'causali_config']
      if (error && error.code === 'PGRST204' && COLONNE_RECENTI.some((c) => c in updates)) {
        logEvento('config', 'warn', {
          operazione: 'admin/settings:PATCH',
          esito: 'colonna_recente_non_disponibile_pgrst204',
          stato: 200,
        })
        const ridotto = { ...updates }
        for (const c of COLONNE_RECENTI) delete ridotto[c]
        ;({ data, error } = await supabase
          .from('admin_settings')
          .upsert(ridotto, { onConflict: 'scuola_id' })
          .select()
          .single())
      }
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      return NextResponse.json({ success: true, data })
    } catch (err) {
      logErrore({ operazione: 'admin/settings:PATCH', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})
