import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { scuoleDiUtente, vedeTutteLeClassi } from '@/lib/auth/scope'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { logEvento } from '@/lib/logging/logger'
import { COLONNE_GATE } from './colonne'

/**
 * «QUESTO BAMBINO È UNO DEI TUOI?» — una risposta sola, per l'elenco e per la scheda.
 *
 * Perché non `assertAlunnoInScope`: per l'educator conta solo `utenti_sezioni`, e il
 * docente assegnato a una classe della primaria per una sola materia (inglese,
 * religione, motoria) ne resterebbe fuori. Il titolare ha deciso (2026-10-04) che
 * l'anagrafica la vedono TUTTI i docenti della classe: è la regola di
 * `puoAccedereFascicolo` / `sezioniContitolari`, che leggono le stesse due tabelle.
 * Il lock `__tests__/architecture/assegnazioni-docente-coerenti.test.ts` tiene le tre
 * funzioni d'accordo.
 *
 * Perché non quelle due: non controllano l'`error` di PostgREST, e un guasto esce
 * come «nessuna sezione» — cioè come un permesso negato o un elenco vuoto, senza
 * traccia. Su un dato di minori «non sono riuscito a leggere» e «non è tuo» non
 * possono avere la stessa risposta: qui il primo è un 500 con log `error`.
 */

export type SezioniVisibili =
  | { esito: 'tutte' }
  | { esito: 'sezioni'; sezioni: string[] }
  | { esito: 'errore' }

export async function sezioniAnagraficaVisibili(
  supabase: SupabaseClient,
  user: AppUser,
): Promise<SezioniVisibili> {
  if (vedeTutteLeClassi(user)) return { esito: 'tutte' }
  const [dirette, perMateria] = await Promise.all([
    supabase.from('utenti_sezioni').select('section_id').eq('utente_id', user.id),
    supabase.from('utenti_sezioni_materie').select('section_id').eq('utente_id', user.id),
  ])
  const guasto = dirette.error ?? perMateria.error
  if (guasto) {
    logEvento(
      'auth',
      'error',
      { tipo: 'anagrafica-sezioni-non-lette', azione: 'sezioniAnagraficaVisibili', utente: user.id },
      guasto,
    )
    return { esito: 'errore' }
  }
  const sezioni = new Set<string>()
  for (const riga of [...(dirette.data ?? []), ...(perMateria.data ?? [])]) {
    const id = (riga as { section_id?: string | null }).section_id
    if (id) sezioni.add(id)
  }
  return { esito: 'sezioni', sezioni: [...sezioni] }
}

export interface AlunnoInScope {
  id: string
  sectionId: string | null
  scuolaId: string
}

export type EsitoScope = { ok: true; alunno: AlunnoInScope } | { ok: false; response: NextResponse }

const rifiuto = (status: number, error: string, codice: string): EsitoScope => ({
  ok: false,
  response: NextResponse.json({ error, codice }, { status, headers: { 'Cache-Control': 'no-store' } }),
})

/**
 * Il controllo della scheda. L'ordine conta: si legge solo la riga minima del
 * bambino (colonne del baseline), si risponde 404 a ciò che non è un iscritto vivo,
 * poi sede, poi sezione. Nessun dato anagrafico si legge prima che tutto sia passato.
 * Il nome segue il contratto `assert…InScope` che il lock dell'isolamento per sede
 * riconosce.
 */
export async function assertAlunnoAnagraficaInScope(
  supabase: SupabaseClient,
  user: AppUser,
  alunnoId: string,
): Promise<EsitoScope> {
  const { data, error } = await supabase.from('alunni').select(COLONNE_GATE).eq('id', alunnoId).maybeSingle()
  if (error) {
    logEvento(
      'auth',
      'error',
      { tipo: 'anagrafica-alunno-non-letto', azione: 'assertAlunnoAnagraficaInScope', utente: user.id },
      error,
    )
    return rifiuto(500, 'Verifica di accesso non riuscita', 'ANAGRAFICA_SCOPE_NON_RISOLTO')
  }
  const riga = data as {
    id: string
    section_id: string | null
    scuola_id: string | null
    stato: string | null
    anonimizzato_il: string | null
  } | null
  if (!riga || riga.stato !== STATO_ISCRITTO || riga.anonimizzato_il) {
    return rifiuto(404, 'Alunno non trovato', 'ANAGRAFICA_NON_TROVATA')
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!riga.scuola_id || !plessi.includes(riga.scuola_id)) {
    return rifiuto(403, 'Alunno fuori dalla tua sede', 'ANAGRAFICA_FUORI_SEDE')
  }

  const visibili = await sezioniAnagraficaVisibili(supabase, user)
  if (visibili.esito === 'errore') {
    return rifiuto(500, 'Verifica di accesso non riuscita', 'ANAGRAFICA_SCOPE_NON_RISOLTO')
  }
  if (visibili.esito === 'sezioni' && (!riga.section_id || !visibili.sezioni.includes(riga.section_id))) {
    // Una riga per (utente, bambino, giorno): è la traccia di chi prova ad aprire
    // schede non sue. Il volume lo limita il gesto stesso (un tocco per scheda).
    logEvento(
      'auth',
      'warn',
      { tipo: 'anagrafica-fuori-sezione', azione: 'assertAlunnoAnagraficaInScope', utente: user.id, alunno_id: alunnoId },
      undefined,
      { distingui: ['alunno_id'] },
    )
    return rifiuto(403, 'Alunno non nella tua classe', 'ANAGRAFICA_FUORI_SEZIONE')
  }

  return { ok: true, alunno: { id: riga.id, sectionId: riga.section_id, scuolaId: riga.scuola_id } }
}
