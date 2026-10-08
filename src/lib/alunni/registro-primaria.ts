import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// IL REGISTRO DELLA PRIMARIA NON SI CANCELLA E NON SI ANONIMIZZA.
//
// Decisione del titolare (2026-10-08): voti, pagelle, scrutini, note
// disciplinari e certificati delle competenze sono il registro ufficiale della
// scuola, che la legge obbliga a conservare — ed è la stessa eccezione che il
// GDPR scrive per l'oblio (art. 17 §3 lett. b). Vale per QUATTRO porte:
// l'eliminazione definitiva (`admin/students/elimina`), l'oblio
// (`admin/gdpr/erase`), l'elenco dei suoi candidati (`admin/gdpr/candidates`) e
// l'evasione delle richieste di cancellazione delle famiglie
// (`admin/gdpr/richieste`, che salta i figli col registro e lo scrive nell'esito).
// Il lock `__tests__/architecture/anonimizza-alunno-controlla-registro.test.ts`
// pretende che ogni gestore che chiama `anonimizzaAlunno` passi prima di qui.
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
// 42P01/PGRST205) vale invece «nessuna riga», che su quel database è la verità —
// ma si LOGGA: in produzione non deve mai succedere, e se succede la protezione
// è cieca. Una COLONNA assente (42703, PGRST204) invece è un guasto.
//
// Si legge con una GET (`select().eq().limit(1)`) e NON con una HEAD con
// `count: 'exact'`: in postgrest-js (2.112, `dist/index.cjs` ~488-503) una HEAD
// non ha corpo, quindi un 404 (tabella assente, gateway) torna `error: null,
// count: null` — letto come «nessuna riga» — e gli altri errori arrivano senza
// `code`, così il ramo «tabella assente» non scatterebbe mai.
// =============================================================================

// Solo «la tabella non esiste». Non si usa l'insieme delle news (tollera anche
// colonne e funzioni assenti, e appartiene a un altro dominio).
const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

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
  // Le sei letture partono INSIEME: in fila il tempo era la somma delle sei, e
  // sull'elenco dei candidati all'oblio si paga per ogni bambino. Le risposte si
  // leggono però NELL'ORDINE dell'elenco, come prima: lo stesso insieme di
  // risposte dà lo stesso esito di quando si leggevano una alla volta.
  const risposte = await Promise.all(
    TABELLE_REGISTRO_PRIMARIA.map(async (tabella) => {
      const { data, error } = await supabase
        .from(tabella)
        .select('alunno_id')
        .eq('alunno_id', alunnoId)
        .limit(1)
      return { tabella, data, error }
    }),
  )
  for (const { tabella, data, error } of risposte) {
    if (error) {
      const code = (error as { code?: string }).code
      if (code && TABELLA_ASSENTE.has(code)) {
        logEvento('db', 'warn', {
          operazione: 'registro-primaria',
          esito: 'tabella-assente-trattata-come-vuota',
          tipo: tabella,
        })
        continue
      }
      return { ok: false, errore: error }
    }
    if (!Array.isArray(data)) return { ok: false, errore: { message: 'risposta senza righe' } }
    if (data.length > 0) return { ok: true, presente: true }
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
