import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logErrore } from '@/lib/logging/logger'
import {
  ARCHIVIAZIONE_MANTIENE,
  TRACCE_DOCENTE,
  VOCI_CHE_PESANO,
  decisioneEliminazione,
} from './tracce-docente-voci'
import type {
  AzioneFk,
  ConteggioVoce,
  Decisione,
  EsitoTracce,
  Verdetto,
  VoceTraccia,
} from './tracce-docente-voci'

// Il registro vive in `tracce-docente-voci.ts` (il pannello è un componente client
// e non può tirarsi dietro il logger: vedi la testata di quel file). Si ri-esporta
// da qui perché route, pannello e lock importino da un posto solo.
export { ARCHIVIAZIONE_MANTIENE, TRACCE_DOCENTE, VOCI_CHE_PESANO, decisioneEliminazione }
export type { AzioneFk, ConteggioVoce, Decisione, EsitoTracce, Verdetto, VoceTraccia }

// ─────────────────────────────────────────────────────────────────────────────
// I CONTEGGI — sole `SELECT`, nessuna scrittura.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * C'è almeno una riga? E la risposta è ATTENDIBILE?
 *
 * PostgREST non lancia: ritorna `{ error }`. Senza controllare il valore di
 * ritorno una lettura fallita diventerebbe una lista vuota — cioè «nessuna
 * traccia» — e l'anteprima direbbe «si cancella» su un docente che ha scritto
 * il registro per un anno. Il `try/catch` attorno all'`await` non scatterebbe mai.
 *
 * ⚠️ Si seleziona LA COLONNA DELLA CHIAVE ESTERNA, non `id` e tantomeno `*`.
 * Due ragioni: non tutte queste tabelle hanno una colonna `id` (`utenti_sezioni`
 * non ce l'ha), e un `select('*')` su `presenze` o `eventi_diario` si porterebbe
 * in memoria — e a un passo dai log — il motivo di un'assenza o una nota su un
 * bambino. La colonna della FK è un uuid che già conosciamo: non aggiunge niente.
 *
 * Lo schema assente (DB E2E della CI non migrato) è l'unico caso in cui il vuoto
 * è la risposta GIUSTA e non un guasto: se la tabella non esiste, di righe non ce
 * n'è nessuna. Si tace, e si conta zero.
 */
async function esiste(
  supabase: SupabaseClient,
  voce: VoceTraccia,
  utenteId: string,
  op: string,
): Promise<{ ce: boolean; letto: boolean }> {
  const { data, error } = await supabase
    .from(voce.tabella)
    .select(voce.colonna)
    .eq(voce.colonna, utenteId)
    .limit(1)
  if (error) {
    if (schemaAssente(error)) return { ce: false, letto: true }
    logErrore(
      { operazione: op, evento: `tracce_esiste_${voce.tabella}_${voce.colonna}` },
      error,
    )
    return { ce: false, letto: false }
  }
  return { ce: ((data ?? []) as unknown[]).length > 0, letto: true }
}

/**
 * Quante sono, esattamente. Si chiama SOLO sulle voci che si sono accese.
 *
 * La separazione fra «c'è?» e «quante?» non è un vezzo: per DECIDERE basta
 * sapere se esiste una riga, e un `limit(1)` si ferma alla prima. Un
 * `count: 'exact'` su `presenze` — 51 docenti su 80 ne hanno — deve invece
 * contarle tutte, su una colonna senza indice. Con la separazione, l'anteprima
 * fa 46 sonde che si fermano subito e conta per esteso solo le tre o quattro
 * voci che finiranno davvero a schermo.
 *
 * Un conteggio fallito NON è zero: torna `null`, e a schermo si legge «non
 * misurato». La voce resta comunque fra i motivi, perché la sua ESISTENZA era
 * già stata accertata dalla sonda.
 */
async function quante(
  supabase: SupabaseClient,
  voce: VoceTraccia,
  utenteId: string,
  op: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from(voce.tabella)
    .select(voce.colonna, { count: 'exact', head: true })
    .eq(voce.colonna, utenteId)
  if (error) {
    if (schemaAssente(error)) return 0
    logErrore(
      { operazione: op, evento: `tracce_conta_${voce.tabella}_${voce.colonna}` },
      error,
    )
    return null
  }
  return count ?? null
}

/**
 * Conta che cosa un docente ha lasciato dietro di sé, e se il suo account è
 * anche l'accesso di una famiglia.
 *
 * SOLE `SELECT`: questa funzione gira PRIMA della conferma, su un'operazione che
 * per metà dei casi non ha un annulla. Nessuna `update`, nessuna `delete`,
 * nessuna `remove()` sullo Storage.
 *
 * ⚠️ FAIL-CLOSED. Una sola lettura fallita e l'esito diventa `non-deciso`: non si
 * offre nessun comando, e si dice perché. È l'opposto del riflesso comodo — «sarà
 * vuoto» — ed è la ragione per cui `ConteggioVoce.n` è `number | null` invece che
 * `number`: il tipo stesso impedisce di confondere «zero» con «non lo so».
 *
 * ⚠️ QUESTA FUNZIONE E L'ESECUZIONE DEVONO CONCORDARE, e non è affidato al
 * commento: `__tests__/architecture/tracce-docente-dichiarate.test.ts` le fa
 * girare sullo stesso client finto e confronta. Se l'anteprima dicesse «si
 * cancella» e la route archiviasse (o viceversa), chi ha confermato avrebbe letto
 * una cosa e ottenuto un'altra.
 */
export async function contaTracceDocente(
  supabase: SupabaseClient,
  utenteId: string,
  op: string,
): Promise<EsitoTracce> {
  // 1. Il ponte genitore. Si legge per primo perché è l'unica lettura che può
  //    togliere di mezzo ogni comando di eliminazione, e perché è una sola riga.
  const { data: ponte, error: errPonte } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', utenteId)
    .maybeSingle()
  let ponteGenitore: boolean | null = ponte != null
  if (errPonte) {
    if (schemaAssente(errPonte)) ponteGenitore = false
    else {
      logErrore({ operazione: op, evento: 'tracce_ponte_genitore' }, errPonte)
      ponteGenitore = null
    }
  }

  // 2. Le 46 sonde. In sequenza e non in parallelo: sono letture su un client
  //    service-role condiviso, e un `Promise.all` da 46 rami su PostgREST è il
  //    modo di prendersi un 503 proprio mentre si sta decidendo di cancellare.
  const voci: ConteggioVoce[] = []
  for (const voce of VOCI_CHE_PESANO) {
    const { ce, letto } = await esiste(supabase, voce, utenteId, op)
    const testa = { tabella: voce.tabella, colonna: voce.colonna }
    if (!letto) {
      // La sonda è fallita: non sappiamo niente di questa voce, e `ce: null`
      // porterà l'intero esito a `non-deciso`.
      voci.push({ ...testa, ce: null, n: null })
      continue
    }
    if (!ce) {
      voci.push({ ...testa, ce: false, n: 0 })
      continue
    }
    // La traccia c'è: questo basta a decidere `archivia`, anche se il conteggio
    // esatto non riuscisse. In quel caso a schermo si legge «non misurato».
    voci.push({ ...testa, ce: true, n: await quante(supabase, voce, utenteId, op) })
  }

  return { voci, ponteGenitore }
}
