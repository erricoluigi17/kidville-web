import type { SupabaseClient } from '@supabase/supabase-js'
import { eAncoraIscritto } from '@/lib/alunni/stato'

/**
 * L'esito della domanda «questo genitore ha ancora un figlio a scuola?».
 *
 * ⚠️ NON è un booleano, e il motivo è tutto qui: **PostgREST non lancia**. Una
 * lettura fallita ritorna `{ data: null, error }`, e con `data ?? []` diventa
 * «nessun figlio» — cioè «genitore orfano», cioè **da anonimizzare**. Un
 * booleano non ha modo di distinguere «non ha altri figli» da «non sono riuscito
 * a chiederlo», e il chiamante non ha modo di accorgersene.
 *
 * Con questo tipo il guasto non si traveste da risposta: TypeScript non lascia
 * leggere `haAltriFigli` senza aver prima guardato `ok`.
 */
export type EsitoAltriFigli =
  | { ok: true; haAltriFigli: boolean }
  | { ok: false; errore: unknown }

/**
 * Il genitore ha ALMENO un altro figlio ancora iscritto (≠ alunno escluso e non
 * anonimizzato)? Usato dall'oblio per decidere se anonimizzare anche l'adulto
 * (solo se "orfano": nessun figlio iscritto residuo).
 *
 * Qui si sta dal lato che PROTEGGE, quindi vale `eAncoraIscritto` — cioè «non è
 * fra i non più iscritti», `sospeso` compreso. Fino al 2026-08-12 il confronto
 * era `f.stato === 'iscritto'`: con un fratello soltanto sospeso questa funzione
 * rispondeva «nessun altro figlio», e l'oblio anonimizzava il genitore di un
 * bambino che frequenta ancora, lasciandolo senza un adulto di riferimento in
 * anagrafica. È lo stesso difetto della negazione, visto dall'altra parte.
 *
 * ⚠️ E PER UN GIORNO LO STESSO DIFETTO È STATO QUI IN UNA FORMA PEGGIORE.
 * Le due letture buttavano via l'`error`: `const { data: links } = await …`.
 * Un JWT scaduto, un timeout, una RLS che cambia — e la funzione rispondeva
 * «orfano» per un adulto con un figlio iscritto, mandando all'anonimizzazione
 * irreversibile nome, codice fiscale e documento d'identità di quella persona.
 * Nessun log, nemmeno `info`. La stessa trappola che la route chiamante descrive
 * per esteso tredici righe più sopra («un oblio eseguito a metà è peggio di un
 * oblio fallito»), sul percorso che non ha un annulla.
 *
 * Adesso un guasto di lettura ESCE come guasto, e il chiamante risponde 500: la
 * richiesta si ripete, l'adulto resta in anagrafica.
 */
export async function leggiAltriFigliIscritti(
  supabase: SupabaseClient,
  parentId: string,
  excludeAlunnoId: string
): Promise<EsitoAltriFigli> {
  const { data: links, error: linksErr } = await supabase
    .from('student_parents')
    .select('student_id')
    .eq('parent_id', parentId)
  if (linksErr) return { ok: false, errore: linksErr }

  const altri = (links ?? [])
    .map((l: { student_id: string }) => l.student_id)
    .filter((sid: string) => sid !== excludeAlunnoId)
  // Nessun altro legame è un FATTO letto, non una lista vuota per guasto: qui la
  // lettura è andata a buon fine e il genitore ha davvero un figlio solo.
  if (altri.length === 0) return { ok: true, haAltriFigli: false }

  const { data: figli, error: figliErr } = await supabase
    .from('alunni')
    .select('id, stato, anonimizzato_il')
    .in('id', altri)
  if (figliErr) return { ok: false, errore: figliErr }

  return {
    ok: true,
    haAltriFigli: (figli ?? []).some(
      (f: { stato: string | null; anonimizzato_il: string | null }) =>
        eAncoraIscritto(f.stato) && !f.anonimizzato_il
    ),
  }
}
