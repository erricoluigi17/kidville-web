import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

// Fonte di verità del legame docente↔sezione: tabella utenti_sezioni
// (utenti.id ↔ sections.id). Sostituisce educator-sections.json e le mappe
// email→sezione hardcoded.

const OPERAZIONE_DOCENTI = 'sezioni/docenti:docentiDiSezione'

export interface OpzioniDocentiDiSezione {
  /**
   * Scarta i docenti disattivati (`utenti.attivo = false`). Default: `true`.
   *
   * L'eccezione esiste per un chiamante solo, e non è un capriccio:
   * `admin/sections/[id]/teachers:GET` usa questa funzione per popolare
   * l'elenco «assegnati» della UI di gestione. Lì un docente cessato ma ancora
   * legato alla sezione DEVE restare visibile, altrimenti il legame diventa
   * invisibile — e quindi non più rimovibile — proprio a chi deve toglierlo.
   * ⚠️ Quella route oggi NON passa l'opzione: va fatto (fuori dal perimetro di
   * questo intervento). Impatto attuale misurato su produzione il 2026-08-07:
   * nessuno, 12 legami su 12 con utente attivo, 0 disattivati, 0 `attivo` NULL.
   */
  soloAttivi?: boolean
}

/**
 * Id degli utenti (docenti) assegnati a una sezione.
 *
 * IL DIFETTO CHE QUESTA FUNZIONE AVEVA, ed è quello che il repo ha già pagato
 * altrove: `const { data } = await supabase.from('utenti_sezioni')…`. **PostgREST
 * non lancia**, ritorna `{ data: null, error }` — quindi una lettura negata dalla
 * RLS, una tabella che il DB E2E non ha, un pool esaurito uscivano da qui come
 * `[]`, cioè come «questa sezione non ha docenti». Indistinguibili.
 *
 * Sotto ci sono sette punti di chiamata (assenze, giustifiche, giustifiche
 * didattiche, firma della pagella, armadietto, mensa, notifiche della primaria) e
 * sotto ancora `notificaEvento`/`enqueueNotifiche`, che sulla lista vuota escono
 * con un `warn` «nessun-destinatario» e lasciano rispondere 200 alla route. Il
 * genitore comunica l'assenza, il sistema dice «fatto», e la maestra non riceve
 * niente. Il valore di ritorno SI CONTROLLA.
 */
export async function docentiDiSezione(
  supabase: SupabaseClient,
  sectionId?: string | null,
  opzioni: OpzioniDocentiDiSezione = {},
): Promise<string[]> {
  // Ramo legittimo e muto: l'alunno senza `section_id` è una condizione prevista
  // (decisione del titolare: si registra in silenzio), non un guasto da contare.
  if (!sectionId) return []
  try {
    const { data, error } = await supabase
      .from('utenti_sezioni')
      .select('utente_id')
      .eq('section_id', sectionId)
    if (error) {
      // `error` e non `warn`, con lo stesso criterio di `enqueueNotifiche`
      // (insert perso = `error`) e di `notificaEvento` (debounce saltato =
      // `warn`): la differenza è se qualcuno a valle rimedia. Qui NESSUNO
      // rimedia — la notifica non viene accodata, il cron non ha niente da
      // drenare, e la route risponde comunque 2xx. È un avviso PERSO, non un
      // contorno degradato.
      //
      // L'errore va INTERO come 4° argomento, mai `String(e)`: `code`,
      // `details` e `hint` di PostgREST sono ciò che dice *perché* (`42501` la
      // RLS, `42P01`/`42703` lo schema non migrato, `PGRST301` il token). Uno
      // status senza corpo è un `403` senza corpo, cioè niente.
      logEvento('notifica', 'error', {
        operazione: OPERAZIONE_DOCENTI,
        esito: 'docenti-non-letti',
        sezione_id: sectionId,
      }, error)
      return []
    }
    const ids = (data ?? []).map(r => r.utente_id as string)
    if (ids.length === 0 || opzioni.soloAttivi === false) return ids
    return await soloDocentiAttivi(supabase, ids, sectionId)
  } catch (e) {
    // Il ramo che resta possibile davvero: un guasto di TRASPORTO (fetch che
    // esplode prima di arrivare a PostgREST). Prima non c'era alcun `try`, e
    // l'eccezione RISALIVA fino al `catch` generico della route, che la
    // travestiva da 500 «Errore interno del server» — perdendo il fatto che il
    // salvataggio era riuscito e solo la notifica era saltata.
    logEvento('notifica', 'error', {
      operazione: OPERAZIONE_DOCENTI,
      esito: 'docenti-non-letti',
      sezione_id: sectionId,
    }, e)
    return []
  }
}

/**
 * Tiene solo i docenti con `utenti.attivo` diverso da `false`.
 *
 * PERCHÉ UNA SECONDA QUERY E NON UN JOIN ANNIDATO. Con
 * `select('utente_id, utenti!inner(attivo)').eq('utenti.attivo', true)` il costo
 * è una sola andata e ritorno, ma il modo di fallire è pessimo ed è esattamente
 * quello che questo file esiste per evitare: se PostgREST non risolve la
 * relazione (`PGRST200`) o la colonna non c'è, l'intera lettura fallisce e i
 * destinatari diventano ZERO. Un contorno che si rompe porterebbe giù il piatto.
 * Con due query, invece, il guasto della seconda degrada alla lista NON filtrata:
 * si notifica anche un docente cessato — un fastidio — invece di non notificare
 * nessuno. Il risultato è salvo, e resta una riga per dirlo.
 * (Verificato il 2026-08-07: la FK `utenti_sezioni_utente_id_fkey` e la colonna
 * `utenti.attivo` esistono su entrambi i progetti, produzione e CI. La scelta non
 * nasce da una mancanza dello schema, ma dal modo di fallire.)
 *
 * `attivo !== false` E NON `attivo === true`: la colonna è `boolean DEFAULT true`
 * **nullable**. Un NULL non è un docente disattivato, è un docente su cui non è
 * mai stata scritta la colonna, e un `.eq('attivo', true)` lo scarterebbe in
 * silenzio — cioè rifarebbe, in un punto nuovo, il difetto di partenza.
 */
async function soloDocentiAttivi(
  supabase: SupabaseClient,
  ids: string[],
  sectionId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('utenti')
    .select('id, attivo')
    .in('id', ids)
  if (error) {
    // `warn`: la notifica parte lo stesso, con la lista intera. Nessun
    // destinatario è andato perso — al più ce n'è uno di troppo.
    logEvento('notifica', 'warn', {
      operazione: OPERAZIONE_DOCENTI,
      esito: 'attivi-non-verificati',
      sezione_id: sectionId,
      n: ids.length,
    }, error)
    return ids
  }
  const attivi = new Set(
    (data ?? []).filter(u => u.attivo !== false).map(u => u.id as string),
  )
  const tenuti = ids.filter(id => attivi.has(id))
  if (tenuti.length !== ids.length) {
    // `warn`: è il comportamento voluto (un cessato non deve più ricevere il
    // nome di un minore), ma «la maestra non riceve più niente» deve avere una
    // spiegazione leggibile senza aprire il database. Nel conteggio finiscono
    // anche i legami ORFANI — `utente_id` senza riga in `utenti` — che vanno
    // scartati comunque: sarebbero una violazione di FK sull'insert in
    // `notifiche`, cioè l'intero lotto di destinatari perso, non uno solo.
    logEvento('notifica', 'warn', {
      operazione: OPERAZIONE_DOCENTI,
      esito: 'docenti-non-attivi',
      sezione_id: sectionId,
      n: ids.length,
      n_scartati: ids.length - tenuti.length,
    })
  }
  return tenuti
}

/**
 * LA STESSA LEZIONE, PER LE ALTRE QUATTRO FUNZIONI DI QUESTO FILE.
 *
 * `docentiDiSezione` è stata corretta il 2026-08-07; le quattro qui sotto no, e
 * il collaudo le ha ritrovate identiche: `const { data } = await supabase…`,
 * `{ error }` buttato via. **PostgREST non lancia** (AGENTS.md, regola 7): una
 * lettura negata dalla RLS, una tabella che il DB E2E non ha, un pool esaurito
 * escono da qui come `[]` — cioè come «questo docente non ha nessuna sezione».
 *
 * E qui pesa più che altrove, perché `sezioniDiUtente` alimenta
 * `assertAlunnoInScope`, cioè il GATE che decide se un educator può leggere il
 * fascicolo di un minore: un guasto travestito da «nessuna sezione» chiude la
 * porta in faccia al docente giusto senza lasciare una riga per dirlo.
 *
 * `error` e non `warn`, con lo stesso criterio della funzione gemella: nessuno a
 * valle rimedia. La lista vuota diventa un permesso negato o un elenco vuoto, e
 * la route risponde comunque 2xx.
 */
function segnalaLetturaFallita(esito: string, campi: Record<string, string | number>, errore: unknown): void {
  logEvento('notifica', 'error', { operazione: OPERAZIONE_DOCENTI, esito, ...campi }, errore)
}

// Id delle sezioni assegnate a un utente (docente).
export async function sezioniDiUtente(supabase: SupabaseClient, utenteId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('utenti_sezioni')
    .select('section_id')
    .eq('utente_id', utenteId)
  // L'errore va INTERO come 4° argomento: `code`, `details` e `hint` di
  // PostgREST sono ciò che dice *perché* (`42501` la RLS, `42P01`/`42703` lo
  // schema non migrato, `PGRST301` il token).
  if (error) segnalaLetturaFallita('sezioni-non-lette', { utente_id: utenteId }, error)
  return (data ?? []).map(r => r.section_id as string)
}

// Nomi (sections.name) delle sezioni assegnate a un utente — fonte canonica
// utenti_sezioni → sections. Nessun fallback euristico: senza legami → [].
export async function nomiSezioniDiUtente(supabase: SupabaseClient, utenteId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('utenti_sezioni')
    .select('sections(name)')
    .eq('utente_id', utenteId)
  if (error) segnalaLetturaFallita('sezioni-non-lette', { utente_id: utenteId }, error)
  type Row = { sections: { name?: string | null }[] | { name?: string | null } | null }
  return [...new Set(
    ((data ?? []) as Row[]).flatMap((r) => {
      const s = r.sections
      if (!s) return []
      return (Array.isArray(s) ? s : [s]).map((x) => x.name)
    }).filter((n): n is string => Boolean(n))
  )]
}

// Sezioni di un docente filtrate per grado scolastico (es. solo 'primaria').
// Restituisce le righe sections complete (id, name, school_type, scholastic_year).
export interface SezioneInfo {
  id: string
  name: string
  school_type: 'nido' | 'infanzia' | 'primaria'
  scholastic_year?: string | null
}

export async function sezioniDiUtentePerGrado(
  supabase: SupabaseClient,
  utenteId: string,
  schoolType: 'nido' | 'infanzia' | 'primaria'
): Promise<SezioneInfo[]> {
  const ids = await sezioniDiUtente(supabase, utenteId)
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('sections')
    .select('id, name, school_type')
    .in('id', ids)
    .eq('school_type', schoolType)
  // La prima lettura ha già la sua riga (dentro `sezioniDiUtente`): questa è la
  // seconda, e senza il controllo un docente con le sue sezioni in tabella
  // uscirebbe da qui come «nessuna sezione di quel grado» — che a schermo è un
  // registro vuoto, non un errore.
  if (error) segnalaLetturaFallita('sezioni-non-lette', { utente_id: utenteId, grado: schoolType }, error)
  return (data ?? []) as SezioneInfo[]
}

// Materie insegnate da un docente in una specifica sezione (contitolarità +
// isolamento per disciplina). Fonte: utenti_sezioni_materie.
export async function materieDiDocenteInSezione(
  supabase: SupabaseClient,
  utenteId: string,
  sectionId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('utenti_sezioni_materie')
    .select('materia_id')
    .eq('utente_id', utenteId)
    .eq('section_id', sectionId)
  // Qui la lista vuota significa «non insegna nessuna materia in questa
  // sezione», che è l'isolamento per disciplina: un guasto letto come tale
  // toglie a un docente le sue materie senza dire niente a nessuno.
  if (error) {
    segnalaLetturaFallita('materie-non-lette', { utente_id: utenteId, sezione_id: sectionId }, error)
  }
  return (data ?? []).map(r => r.materia_id as string)
}
