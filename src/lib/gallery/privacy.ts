// P4/DL-041 — Privacy Lock (Galleria): regola "foto privata".
// Un bambino può essere taggato DA SOLO in una foto anche SENZA liberatoria:
// una foto con un unico tag è visibile esclusivamente ai genitori di quel
// bambino (single tag = visibilità parents-only), quindi non c'è esposizione
// verso terzi e il consenso non serve. Le foto di GRUPPO (≥2 taggati)
// richiedono invece la liberatoria foto (consenso_privacy === true) per OGNI
// bambino taggato. Le foto broadcast (comunicazioni istituzionali) bypassano
// il tagging e quindi il consenso.

/**
 * Ritorna gli ID degli alunni in `tagStudents` che bloccano la pubblicazione
 * perché privi del consenso privacy (liberatoria foto).
 *
 * Regola "foto privata": broadcast oppure un solo bambino taggato → sempre
 * consentito ([]). Il vincolo scatta solo sulle foto di gruppo (≥2 taggati
 * distinti), dove ognuno deve avere `consenso_privacy === true`.
 *
 * @param consentById mappa alunnoId → consenso (true = liberatoria presente).
 * @param isBroadcast se true (foto istituzionale) il tagging è bypassato → [].
 */
export function studentiSenzaConsenso(
  tagStudents: string[] | null | undefined,
  consentById: Record<string, boolean>,
  isBroadcast = false,
): string[] {
  const uniqueTags = [...new Set(tagStudents ?? [])]
  // Foto privata (≤1 taggato) o broadcast: nessun blocco.
  if (isBroadcast || uniqueTags.length <= 1) return []
  return uniqueTags.filter((id) => consentById[id] !== true)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any }

/**
 * Carica il consenso degli alunni taggati e ritorna chi blocca la pubblicazione
 * (id + nome leggibile per il messaggio 422). [] per la "foto privata"
 * (broadcast o ≤1 taggato): in quel caso la query di consenso è pure superflua,
 * quindi si esce prima di toccare il DB.
 */
export async function alunniSenzaConsenso(
  supabase: Db,
  tagStudents: string[] | null | undefined,
  isBroadcast = false,
): Promise<{ id: string; nome: string }[]> {
  const ids = [...new Set(tagStudents ?? [])]
  // Foto privata (≤1 taggato) o broadcast → consentito senza interrogare il DB.
  if (isBroadcast || ids.length <= 1) return []
  const { data: rows } = await supabase
    .from('alunni')
    .select('id, nome, cognome, consenso_privacy')
    .in('id', ids)
  const list = (rows ?? []) as Array<{ id: string; nome?: string; cognome?: string; consenso_privacy?: boolean }>
  const consentById = Object.fromEntries(list.map((r) => [r.id, r.consenso_privacy === true]))
  const nameById = new Map(list.map((r) => [r.id, `${r.nome ?? ''} ${r.cognome ?? ''}`.trim()]))
  return studentiSenzaConsenso(ids, consentById, isBroadcast).map((id) => ({ id, nome: nameById.get(id) || id }))
}
