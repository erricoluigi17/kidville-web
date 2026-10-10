import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { dataCivile } from '@/i18n/config'
import { descriviTetto, leggiABlocchi } from '@/lib/pagamenti/leggi-a-blocchi'

/**
 * Codici «lo schema non c'è» (DB E2E della CI, non migrato): lì il KPI degrada a
 * zero CON una riga di log, come faceva già `form_submissions`. Ogni altro errore è
 * un guasto vero e la risposta è un 500: uno zero che sembra un dato è il difetto
 * S6 della roadmap («report che mentono»).
 */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205'])
const codiceDi = (e: unknown) => (e as { code?: string } | null | undefined)?.code ?? ''

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
    iscrittiRes,
    perClasseRes,
    scadutiRes,
    scadutiListRes,
    fattureRes,
    iscrizioniRes,
    iscrizioniListRes,
    mensaOggiRes,
    moduliTotRes,
    moduliPendingRes,
  ] = await Promise.all([
    // Studenti iscritti: il TOTALE lo conta il database. Fino al 2026-10-10 era la
    // lunghezza di un elenco di righe, e PostgREST taglia ogni risposta a 1000 senza
    // dirlo: il 10/10 gli iscritti delle tre sedi erano 750, a 250 dal taglio.
    supabase
      .from('alunni')
      .select('id', { count: 'exact', head: true })
      .in('scuola_id', sedi)
      .eq('stato', 'iscritto'),
    // La distribuzione per classe ha bisogno delle righe: si leggono TUTTE, a blocchi,
    // e la loro somma si confronta qui sotto con il conteggio del database.
    leggiABlocchi<{ classe_sezione: string | null }>(() =>
      supabase.from('alunni').select('id, classe_sezione').in('scuola_id', sedi).eq('stato', 'iscritto'),
    ),
    // Pagamenti scaduti (non saldati con scadenza passata): il conteggio lo fa il
    // database (il 10/10 erano 506); l'elenco per gli alert ne vuole solo 5.
    // Esclude i contenitori rateali 'padre' (gli incassi stanno sulle rate figlie:
    // contarlo raddoppierebbe conteggio/alert), coerente con
    // calcolaTotaliPagamenti/aging/export/solleciti.
    supabase
      .from('pagamenti')
      .select('id', { count: 'exact', head: true })
      .in('scuola_id', sedi)
      .neq('tipo', 'padre')
      .neq('stato', 'pagato')
      .lt('scadenza', today),
    supabase
      .from('pagamenti')
      .select('id, scadenza, stato, alunni ( nome, cognome )')
      .in('scuola_id', sedi)
      .neq('tipo', 'padre')
      .neq('stato', 'pagato')
      .lt('scadenza', today)
      .order('scadenza', { ascending: true })
      .limit(5),
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

  // PostgREST non lancia: un `{ error }` non controllato diventava uno ZERO
  // indistinguibile da «non ci sono dati». Ogni lettura si controlla: schema assente
  // (DB E2E non migrato) → zero e una riga di log; ogni altro errore → 500.
  const guasti: string[] = []
  for (const [nome, res] of [
    ['alunni:iscritti', iscrittiRes],
    ['pagamenti:scaduti', scadutiRes],
    ['pagamenti:scaduti_elenco', scadutiListRes],
    ['pagamenti:fatture_in_attesa', fattureRes],
    ['enrollment_submissions:pending', iscrizioniRes],
    ['enrollment_submissions:elenco', iscrizioniListRes],
    ['mensa_prenotazioni:oggi', mensaOggiRes],
    ['form_submissions:totale', moduliTotRes],
    ['form_submissions:da_firmare', moduliPendingRes],
  ] as const) {
    if (!res.error) continue
    // Il nome dell'aggregato va in `evento`: è l'unico campo libero del
    // contesto, ed è ciò che distingue «quale KPI è a zero e perché».
    if (SCHEMA_ASSENTE.has(codiceDi(res.error))) {
      logErrore({ operazione: 'admin/dashboard:GET', stato: 200, evento: `db:${nome}` }, res.error)
    } else {
      logErrore({ operazione: 'admin/dashboard:GET', stato: 500, evento: `db:${nome}` }, res.error)
      guasti.push(nome)
    }
  }
  if (!perClasseRes.ok) {
    if (perClasseRes.motivo === 'tetto') {
      logErrore({ operazione: 'admin/dashboard:GET', stato: 500, evento: 'lettura-troncata' },
        new Error(`${descriviTetto('dashboard-alunni-per-classe', perClasseRes)}, rifiutata per intero`))
      guasti.push('alunni:per_classe')
    } else if (SCHEMA_ASSENTE.has(codiceDi(perClasseRes.error))) {
      logErrore({ operazione: 'admin/dashboard:GET', stato: 200, evento: 'db:alunni:per_classe' }, perClasseRes.error)
    } else {
      logErrore({ operazione: 'admin/dashboard:GET', stato: 500, evento: 'db:alunni:per_classe' }, perClasseRes.error)
      guasti.push('alunni:per_classe')
    }
  }
  if (guasti.length > 0) {
    return NextResponse.json(
      { error: 'Non è stato possibile leggere i dati della dashboard', codice: 'DASHBOARD_NON_LETTA' },
      { status: 500 },
    )
  }

  // --- Studenti ---
  const iscritti = iscrittiRes.count ?? 0
  const righeClasse = perClasseRes.ok ? perClasseRes.righe : []
  const perClasseMap = new Map<string, number>()
  for (const a of righeClasse) {
    const k = a.classe_sezione?.trim() || 'Non assegnati'
    perClasseMap.set(k, (perClasseMap.get(k) ?? 0) + 1)
  }
  const perClasse = Array.from(perClasseMap.entries())
    .map(([classe, count]) => ({ classe, count }))
    .sort((a, b) => b.count - a.count)
  // La distribuzione deve sommare al conteggio del database. Due letture separate
  // possono differire per un'iscrizione arrivata fra l'una e l'altra: si registra,
  // e il KPI resta quello del database.
  if (perClasseRes.ok && righeClasse.length !== iscritti) {
    logEvento('anagrafica', 'warn', {
      operazione: 'admin/dashboard:GET',
      esito: 'per-classe-non-quadra',
      atteso: iscritti,
      trovato: righeClasse.length,
    })
  }

  // --- Pagamenti scaduti ---
  const alertScaduti = (scadutiListRes.data ?? []).map((p) => {
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
      iscritti,
      perClasse,
    },
    pagamenti: {
      scadutoCount: scadutiRes.count ?? 0,
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
