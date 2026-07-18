/**
 * Sospensione account moroso (DL-021 · Contabilità v2) — granularità FAMIGLIA.
 *
 * Il flag `alunni.sospeso` (+ `sospeso_causa` 'morosita'|'altro') è impostato dalla
 * Direzione su TUTTI i figli del genitore moroso. La sospensione **non blocca login
 * né letture** (sicurezza del minore preservata): inibisce solo le *azioni di
 * servizio* del genitore tramite questi guard riusabili.
 *
 * FONTE UNICA DEI LEGAMI: i guard risalgono ai figli via `getFigliDiGenitore`
 * (unione runtime `legame_genitori_alunni` + anagrafica `student_parents` via ponte
 * `parents.auth_user_id`). Prima si leggeva SOLO `legame_genitori_alunni`: un legame
 * presente unicamente in `student_parents` sfuggiva al blocco (finding #4).
 *
 * REVOCA AUTOMATICA: quando TUTTO lo scaduto della famiglia è saldato, `sospeso` si
 * azzera da sé — ma SOLO dove `sospeso_causa='morosita'` (le sospensioni per «altro»
 * restano manuali). Degrada pulito sul DB E2E CI non migrato (colonna assente → non
 * si revoca nulla, si logga warn).
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami'
import { residuoEffettivo, statoEffettivo, type AgingPagamento } from '@/lib/pagamenti/aging'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { logEvento } from '@/lib/logging/logger'

function negato(): NextResponse {
  return NextResponse.json(
    {
      error: 'Account sospeso per morosità: contatta la Segreteria per regolarizzare.',
      motivo: 'account_sospeso',
    },
    { status: 403 }
  )
}

/** True se l'alunno risulta sospeso. */
export async function alunnoSospeso(supabase: SupabaseClient, alunnoId: string): Promise<boolean> {
  const { data } = await supabase.from('alunni').select('sospeso').eq('id', alunnoId).maybeSingle()
  return data?.sospeso === true
}

/** 403 se l'alunno è sospeso, altrimenti null. */
export async function assertAlunnoNonSospeso(
  supabase: SupabaseClient,
  alunnoId: string
): Promise<NextResponse | null> {
  return (await alunnoSospeso(supabase, alunnoId)) ? negato() : null
}

/** True se ALMENO un figlio dell'account genitore (unione legami) è sospeso. */
async function qualcheFiglioSospeso(supabase: SupabaseClient, genitoreId: string): Promise<boolean> {
  const figli = await getFigliDiGenitore(supabase, genitoreId)
  if (figli.length === 0) return false
  const { data } = await supabase.from('alunni').select('id, sospeso').in('id', figli)
  return (data ?? []).some((a) => (a as { sospeso?: boolean }).sospeso === true)
}

/**
 * 403 se ALMENO un figlio del genitore è sospeso, altrimenti null.
 * Risolve i figli sull'UNIONE canonica dei legami (runtime + anagrafica).
 */
export async function assertGenitoreNonSospeso(
  supabase: SupabaseClient,
  genitoreId: string
): Promise<NextResponse | null> {
  return (await qualcheFiglioSospeso(supabase, genitoreId)) ? negato() : null
}

/**
 * Come `assertGenitoreNonSospeso`, ma SALTA il blocco quando il modulo in
 * lavorazione è flaggato «essenziale: sempre firmabile» (salute/sicurezza).
 * Il flag va letto a monte (`leggiSempreFirmabile`): qui si riceve già il booleano.
 */
export async function assertGenitoreNonSospesoSalvoEssenziale(
  supabase: SupabaseClient,
  genitoreId: string,
  opts: { sempreFirmabile?: boolean | null }
): Promise<NextResponse | null> {
  if (opts?.sempreFirmabile === true) return null
  return assertGenitoreNonSospeso(supabase, genitoreId)
}

// ── Scaduto di famiglia (fonte unica: aging.ts) ──────────────────────────────

const COLS_PAG_FULL = 'alunno_id, importo, importo_pagato, sconto, scadenza, stato, tipo'
const COLS_PAG_BASE = 'alunno_id, importo, importo_pagato, scadenza, stato, tipo'

function colonnaAssente(err: { code?: string } | null | undefined): boolean {
  return err?.code === '42703' || err?.code === 'PGRST204'
}

/**
 * Σ dei residui EFFETTIVI (importo−sconto−pagato, clampato) delle SOLE voci con
 * stato effettivo 'scaduto' degli alunni dati. Legge `sconto` con retry 42703
 * (DB non migrato → sconto assente = 0). Ritorna 0 su lista vuota o su errore.
 */
export async function totaleScadutoAlunni(
  supabase: SupabaseClient,
  alunnoIds: string[],
): Promise<number> {
  if (!alunnoIds || alunnoIds.length === 0) return 0
  const oggi = new Date().toISOString().slice(0, 10)
  let res = await supabase.from('pagamenti').select(COLS_PAG_FULL).in('alunno_id', alunnoIds)
  if (res.error && colonnaAssente(res.error)) {
    res = (await supabase.from('pagamenti').select(COLS_PAG_BASE).in('alunno_id', alunnoIds)) as typeof res
  }
  if (res.error) {
    logEvento('db', 'error', { operazione: 'totaleScadutoAlunni', esito: 'lettura-pagamenti-fallita' }, res.error)
    return 0
  }
  let totale = 0
  for (const p of (res.data ?? []) as AgingPagamento[]) {
    if (p.tipo === 'padre') continue
    if (statoEffettivo(p, oggi) !== 'scaduto') continue
    totale += residuoEffettivo(p)
  }
  return Math.round(totale * 100) / 100
}

/**
 * Sintesi per il genitore (banner): è sospeso? quanto scaduto ha la famiglia?
 * Solo dati dell'account chiamante (accountId = utenti.id).
 */
export async function infoSospensioneFamiglia(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ sospeso: boolean; totaleScaduto: number }> {
  const figli = await getFigliDiGenitore(supabase, accountId)
  if (figli.length === 0) return { sospeso: false, totaleScaduto: 0 }
  const { data } = await supabase.from('alunni').select('id, sospeso').in('id', figli)
  const sospeso = (data ?? []).some((a) => (a as { sospeso?: boolean }).sospeso === true)
  const totaleScaduto = await totaleScadutoAlunni(supabase, figli)
  return { sospeso, totaleScaduto }
}

/**
 * Famiglia (figli) a partire da UN alunno, per la conferma della Direzione prima
 * di sospendere: un account genitore coinvolto + tutti i figli dell'unione legami
 * con nome e stato sospeso. Staff-only (i nomi tornano in risposta, non nei log).
 */
export async function famigliaDiAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<{ parentAccountId: string | null; figli: { id: string; nome: string | null; cognome: string | null; sospeso: boolean }[] }> {
  const accounts = await accountGenitoriDiAlunni(supabase, [alunnoId])
  const ids = new Set<string>([alunnoId])
  for (const acc of accounts) {
    for (const f of await getFigliDiGenitore(supabase, acc)) ids.add(f)
  }
  const figliIds = [...ids]
  const { data } = await supabase.from('alunni').select('id, nome, cognome, sospeso').in('id', figliIds)
  const figli = ((data ?? []) as { id: string; nome?: string | null; cognome?: string | null; sospeso?: boolean }[])
    .map((a) => ({ id: a.id, nome: a.nome ?? null, cognome: a.cognome ?? null, sospeso: a.sospeso === true }))
  return { parentAccountId: accounts[0] ?? null, figli }
}

// ── Reverse: da alunni → account genitori coinvolti (unione legami) ───────────

export async function accountGenitoriDiAlunni(supabase: SupabaseClient, alunnoIds: string[]): Promise<string[]> {
  const accounts = new Set<string>()
  const { data: runtime } = await supabase
    .from('legame_genitori_alunni')
    .select('genitore_id')
    .in('alunno_id', alunnoIds)
  for (const r of runtime ?? []) if (r.genitore_id) accounts.add(r.genitore_id as string)

  const { data: sp } = await supabase
    .from('student_parents')
    .select('parent_id')
    .in('student_id', alunnoIds)
  const parentIds = [...new Set((sp ?? []).map((r) => r.parent_id as string).filter(Boolean))]
  if (parentIds.length > 0) {
    const { data: parents } = await supabase
      .from('parents')
      .select('auth_user_id')
      .in('id', parentIds)
    for (const p of parents ?? []) if (p.auth_user_id) accounts.add(p.auth_user_id as string)
  }
  return [...accounts]
}

/**
 * Revoca AUTOMATICA della sospensione per morosità. A partire dagli `alunnoIds`
 * i cui pagamenti sono cambiati, risale ai genitori/famiglie coinvolte, ricalcola
 * il totale scaduto sull'UNIONE dei figli e — se è 0 — azzera `sospeso` SOLO dove
 * `sospeso_causa='morosita'`, con audit in `registro_modifiche`, notifica al
 * genitore e log di successo. Mai revoca su causa 'altro'.
 *
 * DEGRADAZIONE: se `sospeso_causa` non esiste (DB non migrato, 42703) NON revoca
 * nulla e logga warn — non si può distinguere morosità da «altro» senza la colonna.
 * Best-effort: non lancia (usata anche dal cron); PostgREST ritorna `{ error }`.
 */
export async function verificaRevocaSospensioneMorosita(
  supabase: SupabaseClient,
  alunnoIds: string[],
): Promise<{ revocati: string[] }> {
  const revocati: string[] = []
  try {
    if (!alunnoIds || alunnoIds.length === 0) return { revocati }

    // 1) alunni → account genitori → tutti i figli (famiglia allargata).
    const accounts = await accountGenitoriDiAlunni(supabase, alunnoIds)
    const family = new Set<string>(alunnoIds)
    for (const acc of accounts) {
      for (const f of await getFigliDiGenitore(supabase, acc)) family.add(f)
    }
    const familyIds = [...family]

    // 2) se resta anche 1€ scaduto in famiglia → nessuna revoca.
    const totaleScaduto = await totaleScadutoAlunni(supabase, familyIds)
    if (totaleScaduto > 0) return { revocati }

    // 3) sospesi della famiglia PER CAUSA (retry-less: se la colonna manca → warn+stop).
    const sel = await supabase
      .from('alunni')
      .select('id, scuola_id, sospeso, sospeso_causa')
      .in('id', familyIds)
      .eq('sospeso', true)
    if (sel.error) {
      if (colonnaAssente(sel.error)) {
        logEvento('pagamento', 'warn', {
          operazione: 'verificaRevocaSospensioneMorosita',
          esito: 'sospeso_causa-assente-no-revoca',
        }, sel.error)
        return { revocati }
      }
      logEvento('db', 'error', {
        operazione: 'verificaRevocaSospensioneMorosita',
        esito: 'lettura-sospesi-fallita',
      }, sel.error)
      return { revocati }
    }

    const daRevocare = ((sel.data ?? []) as { id: string; scuola_id?: string | null; sospeso_causa?: string | null }[])
      .filter((a) => a.sospeso_causa === 'morosita')

    for (const a of daRevocare) {
      const { error } = await supabase
        .from('alunni')
        .update({ sospeso: false, sospeso_motivo: null, sospeso_il: null })
        .eq('id', a.id)
      if (error) {
        logEvento('db', 'error', {
          operazione: 'verificaRevocaSospensioneMorosita',
          esito: 'revoca-update-fallita',
        }, error)
        continue
      }
      revocati.push(a.id)

      // Audit immutabile (utente_id null = sistema). PostgREST non lancia → { error }.
      const { error: auditErr } = await supabase.from('registro_modifiche').insert({
        azione: 'revoca_sospensione_morosita',
        tabella_interessata: 'alunni',
        record_id: a.id,
        vecchio_valore: { sospeso: true, sospeso_causa: 'morosita' },
        nuovo_valore: { sospeso: false, motivo: 'scaduto famiglia saldato' },
        utente_id: null,
      })
      if (auditErr) {
        logEvento('db', 'warn', {
          operazione: 'verificaRevocaSospensioneMorosita',
          esito: 'audit-non-scritto',
        }, auditErr)
      }

      // Notifica formale al genitore (best-effort, testo neutro in push).
      await notificaEvento(supabase, {
        tipo: 'sospensione_morosita',
        scuolaId: (a.scuola_id as string | undefined) ?? null,
        alunnoIds: [a.id],
        titolo: 'Avviso amministrativo',
        corpo: 'Il servizio è stato riattivato. Dettagli nella sezione Pagamenti.',
        link: '/parent/pagamenti',
        entitaTipo: 'sospensione',
        entitaId: a.id,
        bufferMin: 0,
      })
    }

    if (revocati.length > 0) {
      // Evento critico → SUCCESSO loggato (conteggi/uuid, MAI nomi).
      logEvento('pagamento', 'info', {
        operazione: 'verificaRevocaSospensioneMorosita',
        esito: 'revoca-automatica',
        revocati: revocati.length,
        famiglia: familyIds.length,
      })
    }
    return { revocati }
  } catch (err) {
    // Usata anche dal cron: un guasto non deve mai propagarsi come crash.
    logEvento('pagamento', 'error', {
      operazione: 'verificaRevocaSospensioneMorosita',
      esito: 'errore-inatteso',
    }, err)
    return { revocati }
  }
}
