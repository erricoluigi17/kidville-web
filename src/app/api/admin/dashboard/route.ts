import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { dataCivile } from '@/i18n/config'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

/**
 * GET /api/admin/dashboard
 * Aggrega i KPI della direzione/segreteria leggendo dalle tabelle reali
 * (alunni, pagamenti, enrollment_submissions, mensa_prenotazioni,
 * form_submissions). Riservato allo staff via requireStaff.
 *
 * NESSUN IMPORTO IN EURO ESCE DA QUI, a nessun ruolo, Direzione compresa
 * (decisione del titolare, 2026-10-07): la home mostra solo conteggi. Gli importi
 * si leggono in Contabilità. Per questo la route non interroga nemmeno `incassi`
 * e non seleziona `importo`/`importo_pagato` dei pagamenti.
 */
export const GET = withRoute('admin/dashboard:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()

  // Scope multi-sede: aggreghiamo solo sui plessi attivi/accessibili (mai cross-tenant).
  const sedi = await resolveScuoleAttive(request, supabase, auth.user)

  // Tutte le date di questa route sono date CIVILI ITALIANE, non date del
  // processo: le tre sedi sono in Campania e «oggi» è oggi per loro. Su Vercel
  // il processo gira in UTC, quindi fra mezzanotte e le due `toISOString()`
  // restituirebbe il giorno prima — e per due ore al giorno la dashboard
  // parlerebbe di ieri chiamandolo oggi.
  const today = dataCivile()

  const [
    alunniRes,
    scadutiRes,
    fattureRes,
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
      .select('id, scadenza, stato, alunni ( nome, cognome )')
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
    // Iscrizioni in attesa (conteggio)
    supabase
      .from('enrollment_submissions')
      .select('id', { count: 'exact', head: true })
      .in('scuola_id', sedi)
      .eq('status', 'pending'),
    // Iscrizioni in attesa (lista per alert) — SOLO l'id e la data d'arrivo.
    //
    // `enrollment_submissions.data` NON è una data: è la colonna JSONB con il
    // MODULO D'ISCRIZIONE INTERO (19 campi per adulto, fra cui tipo e numero
    // del documento d'identità e `documento_path`; 17 per minore, fra cui
    // codice fiscale, data di nascita, residenza, `allergies` e `note_mediche`).
    // Fino al 2026-07-31 stava in questa proiezione e finiva in risposta, così
    // ogni caricamento della dashboard consegnava per intero le 5 domande
    // pending più recenti. Il widget mostra «Richiesta N · da gestire» e una
    // data: `created_at` è tutto ciò che gli serve.
    supabase
      .from('enrollment_submissions')
      .select('id, created_at')
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
    // Submission moduli totali — filtrate per sede: senza `.in()` il contatore
    // includeva anche la riga della sede FINTA E2E, cioè un KPI di produzione
    // già sbagliato oggi.
    supabase.from('form_submissions').select('id', { count: 'exact', head: true }).in('scuola_id', sedi),
    // Submission moduli da firmare/evadere
    supabase
      .from('form_submissions')
      .select('id', { count: 'exact', head: true })
      .in('scuola_id', sedi)
      .eq('status', 'pending_signature'),
  ])

  // PostgREST non lancia: ogni aggregato si legge con `?? 0` / `?? []`, quindi
  // un guasto diventa uno ZERO indistinguibile da «non ci sono dati». Con i
  // filtri di sede aggiunti il 2026-07-31 il caso è concreto: sul DB E2E della
  // CI, che non è migrato, `form_submissions.scuola_id` non esiste e PostgREST
  // risponde `42703` sulla SELECT. La dashboard deve reggere — ma il motivo
  // dello zero deve restare leggibile nei log, non sparire.
  for (const [nome, res] of [
    ['form_submissions:totale', moduliTotRes],
    ['form_submissions:da_firmare', moduliPendingRes],
  ] as const) {
    if (res.error) {
      // Il nome dell'aggregato va in `evento`: è l'unico campo libero del
      // contesto, ed è ciò che distingue «quale KPI è a zero e perché».
      logErrore({ operazione: 'admin/dashboard:GET', stato: 200, evento: `db:${nome}` }, res.error)
    }
  }

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
  const alertScaduti = scaduti.slice(0, 5).map((p) => {
    const al = Array.isArray(p.alunni) ? p.alunni[0] : (p.alunni as { nome?: string; cognome?: string } | null)
    return {
      id: p.id as string,
      alunno: al ? `${al.nome ?? ''} ${al.cognome ?? ''}`.trim() : '—',
      scadenza: p.scadenza as string,
    }
  })

  // --- Iscrizioni alert ---
  // La variabile si chiama `invio`, non `e`: `e.data` si leggeva come «la data»
  // ed era invece la colonna JSONB col fascicolo della famiglia. Qui `data` è
  // la CHIAVE della risposta (in italiano: la data d'arrivo, quella che il
  // widget formatta), e il valore viene solo da `created_at` — l'unico campo
  // che la query chiede.
  const alertIscrizioni = (iscrizioniListRes.data ?? []).map((invio) => ({
    id: invio.id as string,
    data: (invio.created_at as string | null) ?? null,
  }))

  return NextResponse.json({
    studenti: {
      iscritti: alunni.length,
      perClasse,
    },
    pagamenti: {
      scadutoCount: scaduti.length,
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
    alert: {
      scaduti: alertScaduti,
      iscrizioni: alertIscrizioni,
    },
  })
})
