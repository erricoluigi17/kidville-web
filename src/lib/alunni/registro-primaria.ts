import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAssente } from '@/lib/news/schema-assente'

// =============================================================================
// IL REGISTRO DELLA PRIMARIA NON SI CANCELLA E NON SI ANONIMIZZA.
//
// Decisione del titolare (2026-10-08): voti, pagelle, scrutini, note
// disciplinari e certificati delle competenze sono il registro ufficiale della
// scuola, che la legge obbliga a conservare — ed è la stessa eccezione che il
// GDPR scrive per l'oblio (art. 17 §3 lett. b). Vale per TRE porte:
// l'eliminazione definitiva (`admin/students/elimina`), l'oblio
// (`admin/gdpr/erase`) e l'elenco dei suoi candidati (`admin/gdpr/candidates`).
//
// L'elenco vive QUI e in nessun altro file TypeScript. La funzione SQL
// `elimina_alunno_definitivo` lo ripete (in SQL non si importa), e il test
// `__tests__/lib/elimina-alunno-definitivo-sql.test.ts` pretende che le due
// copie coincidano: aggiungere una tabella qui senza aggiungerla là fa rosso.
//
// «NON CI SONO RIGHE» E «NON LE HO POTUTE LEGGERE» NON SONO LA STESSA RISPOSTA:
// la seconda, qui, aprirebbe la porta a una cancellazione irreversibile del
// registro. Per questo l'esito non è un booleano: senza guardare `ok` non si
// arriva a `presente`. Una tabella che NON ESISTE (DB E2E della CI non migrato:
// 42P01/PGRST205) vale invece «nessuna riga», che su quel database è la verità.
// =============================================================================

export const TABELLE_REGISTRO_PRIMARIA = [
  'valutazioni',
  'pagelle',
  'scrutinio_giudizi',
  'scrutinio_comportamento',
  'note_disciplinari',
  'certificati_competenze',
] as const

export type TabellaRegistroPrimaria = (typeof TABELLE_REGISTRO_PRIMARIA)[number]

export type EsitoRegistroPrimaria =
  | { ok: true; presente: boolean }
  | { ok: false; errore: unknown }

export type EsitoRegistroPrimariaInBlocco =
  | { ok: true; conRegistro: Set<string> }
  | { ok: false; errore: unknown }

/** C'è almeno una riga del registro della primaria per questo alunno? */
export async function leggiRegistroPrimaria(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<EsitoRegistroPrimaria> {
  for (const tabella of TABELLE_REGISTRO_PRIMARIA) {
    const { count, error } = await supabase
      .from(tabella)
      .select('alunno_id', { count: 'exact', head: true })
      .eq('alunno_id', alunnoId)
    if (error) {
      if (schemaAssente(error)) continue
      return { ok: false, errore: error }
    }
    if ((count ?? 0) > 0) return { ok: true, presente: true }
  }
  return { ok: true, presente: false }
}

/**
 * Gli alunni, fra quelli dati, che hanno il registro della primaria.
 *
 * Un `count` per alunno e non una `select … in(…)` per tabella: la seconda è
 * troncata dal tetto di righe di PostgREST, e un bambino con molti voti in
 * fondo all'elenco sparirebbe dal risultato — cioè risulterebbe «senza
 * registro». Gli elenchi su cui si chiama sono corti (i candidati all'oblio).
 */
export async function alunniConRegistroPrimaria(
  supabase: SupabaseClient,
  alunnoIds: (string | null | undefined)[],
): Promise<EsitoRegistroPrimariaInBlocco> {
  const ids = [...new Set(alunnoIds.filter((v): v is string => typeof v === 'string' && v.length > 0))]
  const conRegistro = new Set<string>()
  for (const id of ids) {
    const esito = await leggiRegistroPrimaria(supabase, id)
    if (!esito.ok) return esito
    if (esito.presente) conRegistro.add(id)
  }
  return { ok: true, conRegistro }
}
