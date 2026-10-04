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
 *
 * «Tutte le classi» si decide su `user.role`, la veste ATTIVA, come fa
 * `assertAlunnoInScope`, e non sui ruoli reali. Per chi lavora in una classe la veste
 * non allarga e non restringe niente: l'insegnante che guarda l'app da genitore
 * continua a vedere le classi a cui è assegnata, perché le assegnazioni si leggono per
 * `user.id`. Dove la veste può sbagliare (la segretaria in veste di genitore) sbaglia
 * nel verso restrittivo: vede solo le classi assegnate, mai di più.
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

/** Un rifiuto già pronto: chi lo riceve lo restituisce così com'è. */
export type Rifiuto = { ok: false; response: NextResponse }

export type EsitoScope = { ok: true; alunno: AlunnoInScope } | Rifiuto

export type EsitoSedi = { ok: true; plessi: string[] } | Rifiuto

/**
 * I codici dei cinque rifiuti che nascono qui, dichiarati in `CODICI_ERRORE`
 * (`src/lib/ui/esito-fetch.ts`) e tradotti in `messages/{it,en}/shared.json`.
 *
 * Costanti LOCALI e letterali, e un helper per codice con il corpo scritto per
 * esteso: il lock `errori-con-codice` legge `codice: X` solo se `X` è una stringa o
 * un `const X = '…'` di questo file. Un codice passato come parametro è un codice
 * che nessuno controlla.
 */
const CODICE_SCOPE_NON_RISOLTO = 'ANAGRAFICA_SCOPE_NON_RISOLTO'
const CODICE_NON_TROVATA = 'ANAGRAFICA_NON_TROVATA'
const CODICE_FUORI_SEDE = 'ANAGRAFICA_FUORI_SEDE'
const CODICE_FUORI_SEZIONE = 'ANAGRAFICA_FUORI_SEZIONE'
const CODICE_SENZA_SEDE = 'ANAGRAFICA_SENZA_SEDE'

const scopeNonRisolto = (): Rifiuto => ({
  ok: false,
  response: NextResponse.json(
    { error: 'Verifica di accesso non riuscita', codice: CODICE_SCOPE_NON_RISOLTO },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  ),
})

const nonTrovata = (): Rifiuto => ({
  ok: false,
  response: NextResponse.json(
    { error: 'Alunno non trovato', codice: CODICE_NON_TROVATA },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  ),
})

const fuoriSede = (): Rifiuto => ({
  ok: false,
  response: NextResponse.json(
    { error: 'Alunno fuori dalla tua sede', codice: CODICE_FUORI_SEDE },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  ),
})

const fuoriSezione = (): Rifiuto => ({
  ok: false,
  response: NextResponse.json(
    { error: 'Alunno non nella tua classe', codice: CODICE_FUORI_SEZIONE },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  ),
})

const senzaSede = (): Rifiuto => ({
  ok: false,
  response: NextResponse.json(
    { error: 'Profilo non associato a nessuna sede', codice: CODICE_SENZA_SEDE },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  ),
})

/**
 * LE SEDI DI CHI CONSULTA L'ANAGRAFICA — una regola sola, per l'elenco e per la scheda.
 *
 * Nessuna sede non è mai «nessun bambino» né «fuori sede». Per un admin le sedi vuote
 * sono quasi sempre una lettura di `utenti_scuole` fallita (`scuoleDiUtente` la logga
 * già): è un guasto, 500. Per gli altri ruoli la sede è `utenti.scuola_id`, e se manca
 * è il profilo a essere incompleto: 403. Prima che l'elenco la usasse, questa regola
 * viveva dentro la scheda soltanto, e l'elenco rispondeva al guasto con un 200 vuoto.
 */
export async function sediAnagrafica(supabase: SupabaseClient, user: AppUser): Promise<EsitoSedi> {
  const plessi = await scuoleDiUtente(supabase, user)
  if (plessi.length > 0) return { ok: true, plessi }
  if (user.role === 'admin') {
    logEvento(
      'auth',
      'error',
      { tipo: 'anagrafica-sedi-non-risolte', azione: 'sediAnagrafica', utente: user.id, ruolo: user.role },
    )
    return scopeNonRisolto()
  }
  logEvento(
    'auth',
    'warn',
    { tipo: 'anagrafica-profilo-senza-sede', azione: 'sediAnagrafica', utente: user.id, ruolo: user.role },
  )
  return senzaSede()
}

/**
 * Il controllo della scheda. L'ordine conta: si legge solo la riga minima del
 * bambino (colonne del baseline), si risponde 404 a ciò che non è un iscritto vivo,
 * poi sedi dell'utente (nessuna sede è un rifiuto a sé, mai «fuori sede»), poi sede
 * del bambino, poi sezione. Nessun dato anagrafico si legge prima che tutto sia passato.
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
    return scopeNonRisolto()
  }
  const riga = data as {
    id: string
    section_id: string | null
    scuola_id: string | null
    stato: string | null
    anonimizzato_il: string | null
  } | null
  if (!riga || riga.stato !== STATO_ISCRITTO || riga.anonimizzato_il) {
    return nonTrovata()
  }

  // Nessuna sede non è «fuori sede»: senza questo rifiuto il controllo di sede si
  // poteva saltare (`plessi.length > 0 && …`) senza che nessun test se ne accorgesse.
  const sedi = await sediAnagrafica(supabase, user)
  if (!sedi.ok) return sedi
  const plessi = sedi.plessi
  if (!riga.scuola_id || !plessi.includes(riga.scuola_id)) {
    // Il segnale più forte dei due: un uuid di un bambino di un'altra sede non arriva
    // da nessun elenco dell'app. Una riga per (utente, bambino, giorno).
    // Qui e nel log del «fuori sezione» va `riga.id`, l'uuid come lo scrive il
    // database, e non `alunnoId` arrivato dal client: le righe dello stesso bambino
    // devono distinguersi e sommarsi sullo stesso valore.
    logEvento(
      'auth',
      'warn',
      { tipo: 'anagrafica-fuori-sede', azione: 'assertAlunnoAnagraficaInScope', utente: user.id, alunno_id: riga.id },
      undefined,
      { distingui: ['alunno_id'] },
    )
    return fuoriSede()
  }

  const visibili = await sezioniAnagraficaVisibili(supabase, user)
  if (visibili.esito === 'errore') {
    return scopeNonRisolto()
  }
  if (visibili.esito === 'sezioni' && (!riga.section_id || !visibili.sezioni.includes(riga.section_id))) {
    // Una riga per (utente, bambino, giorno): è la traccia di chi prova ad aprire
    // schede non sue. Il volume lo limita il gesto stesso (un tocco per scheda).
    logEvento(
      'auth',
      'warn',
      { tipo: 'anagrafica-fuori-sezione', azione: 'assertAlunnoAnagraficaInScope', utente: user.id, alunno_id: riga.id },
      undefined,
      { distingui: ['alunno_id'] },
    )
    return fuoriSezione()
  }

  return { ok: true, alunno: { id: riga.id, sectionId: riga.section_id, scuolaId: riga.scuola_id } }
}
