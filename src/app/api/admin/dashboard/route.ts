import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// Etichette mesi brevi (IT) per l'asse del grafico trend incassi.
const MESI_IT = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic']

function ymKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * GET /api/admin/dashboard
 * Aggrega i KPI della direzione/segreteria leggendo dalle tabelle reali
 * (alunni, pagamenti, incassi, enrollment_submissions, mensa_prenotazioni,
 * form_submissions). Riservato allo staff via requireStaff. Vedi piano in
 * .claude/plans per i contratti.
 */
export const GET = withRoute('admin/dashboard:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()

  // Scope multi-sede: aggreghiamo solo sui plessi attivi/accessibili (mai cross-tenant).
  const sedi = await resolveScuoleAttive(request, supabase, auth.user)

  const now = new Date()
  const today = now.toISOString().slice(0, 10) // YYYY-MM-DD
  const curMonthKey = ymKey(now)
  // Primo giorno di 5 mesi fa => finestra di 6 mesi inclusa quella corrente.
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1)
  const sixMonthsAgoIso = sixMonthsAgo.toISOString().slice(0, 10)

  const [
    alunniRes,
    scadutiRes,
    fattureRes,
    incassiRes,
    iscrizioniRes,
    iscrizioniListRes,
    mensaOggiRes,
    moduliTotRes,
    moduliPendingRes,
  ] = await Promise.all([
    // Studenti iscritti (per totale + distribuzione per classe/sezione)
    supabase
      .from('alunni')
      .select('id, classe_sezione, stato')
      .in('scuola_id', sedi)
      .eq('stato', 'iscritto'),
    // Pagamenti scaduti (non saldati con scadenza passata) + dato per gli alert.
    // Esclude i contenitori rateali 'padre' (gli incassi stanno sulle rate figlie:
    // contarlo raddoppierebbe residuo/conteggio/alert), coerente con
    // calcolaTotaliPagamenti/aging/export/solleciti.
    supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, scadenza, stato, alunni ( nome, cognome )')
      .in('scuola_id', sedi)
      .neq('tipo', 'padre')
      .neq('stato', 'pagato')
      .lt('scadenza', today)
      .order('scadenza', { ascending: true }),
    // Fatture in attesa di emissione
    supabase
      .from('pagamenti')
      .select('id', { count: 'exact', head: true })
      .in('scuola_id', sedi)
      .eq('fattura_stato', 'in_attesa'),
    // Incassi ultimi 6 mesi (trend + incassato mese corrente)
    supabase
      .from('incassi')
      .select('importo, data_incasso')
      .gte('data_incasso', sixMonthsAgoIso),
    // Iscrizioni in attesa (conteggio)
    supabase
      .from('enrollment_submissions')
      .select('id', { count: 'exact', head: true })
      .in('scuola_id', sedi)
      .eq('status', 'pending'),
    // Iscrizioni in attesa (lista per alert)
    supabase
      .from('enrollment_submissions')
      .select('id, data, status, created_at')
      .in('scuola_id', sedi)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(5),
    // Prenotazioni mensa di oggi
    supabase
      .from('mensa_prenotazioni')
      .select('id', { count: 'exact', head: true })
      .in('scuola_id', sedi)
      .eq('data', today),
    // Submission moduli totali
    supabase.from('form_submissions').select('id', { count: 'exact', head: true }),
    // Submission moduli da firmare/evadere
    supabase
      .from('form_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_signature'),
  ])

  // --- Studenti ---
  const alunni = alunniRes.data ?? []
  const perClasseMap = new Map<string, number>()
  for (const a of alunni) {
    const k = (a.classe_sezione as string | null)?.trim() || 'Non assegnati'
    perClasseMap.set(k, (perClasseMap.get(k) ?? 0) + 1)
  }
  const perClasse = Array.from(perClasseMap.entries())
    .map(([classe, count]) => ({ classe, count }))
    .sort((a, b) => b.count - a.count)

  // --- Pagamenti scaduti ---
  const scaduti = scadutiRes.data ?? []
  let scadutoImporto = 0
  const alertScaduti = scaduti.slice(0, 5).map((p) => {
    const residuo = Number(p.importo ?? 0) - Number(p.importo_pagato ?? 0)
    const al = Array.isArray(p.alunni) ? p.alunni[0] : (p.alunni as { nome?: string; cognome?: string } | null)
    return {
      id: p.id as string,
      alunno: al ? `${al.nome ?? ''} ${al.cognome ?? ''}`.trim() : '—',
      importo: residuo,
      scadenza: p.scadenza as string,
    }
  })
  for (const p of scaduti) {
    scadutoImporto += Number(p.importo ?? 0) - Number(p.importo_pagato ?? 0)
  }

  // --- Incassi: trend 6 mesi + mese corrente ---
  const incassi = incassiRes.data ?? []
  const trendMap = new Map<string, number>()
  // Inizializza gli ultimi 6 mesi a 0 così il grafico ha sempre tutte le colonne.
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    trendMap.set(ymKey(d), 0)
  }
  let incassatoMese = 0
  for (const inc of incassi) {
    const d = new Date(inc.data_incasso as string)
    const key = ymKey(d)
    if (trendMap.has(key)) trendMap.set(key, (trendMap.get(key) ?? 0) + Number(inc.importo ?? 0))
    if (key === curMonthKey) incassatoMese += Number(inc.importo ?? 0)
  }
  const trend = Array.from(trendMap.entries()).map(([key, incassato]) => {
    const [, m] = key.split('-')
    return { mese: key, label: MESI_IT[Number(m) - 1], incassato }
  })

  // --- Iscrizioni alert ---
  const alertIscrizioni = (iscrizioniListRes.data ?? []).map((e) => ({
    id: e.id as string,
    data: (e.data ?? e.created_at) as string | null,
  }))

  return NextResponse.json({
    studenti: {
      iscritti: alunni.length,
      perClasse,
    },
    pagamenti: {
      scadutoImporto,
      scadutoCount: scaduti.length,
      incassatoMese,
      fattureInAttesa: fattureRes.count ?? 0,
    },
    iscrizioni: {
      pending: iscrizioniRes.count ?? 0,
    },
    mensa: {
      oggiPrenotazioni: mensaOggiRes.count ?? 0,
    },
    moduli: {
      submissionTotale: moduliTotRes.count ?? 0,
      daFirmare: moduliPendingRes.count ?? 0,
    },
    trend,
    alert: {
      scaduti: alertScaduti,
      iscrizioni: alertIscrizioni,
    },
  })
})
