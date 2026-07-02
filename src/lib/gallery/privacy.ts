// P4/DL-041 — Privacy Lock (Galleria): un alunno può essere taggato in una foto
// SOLO se ha il consenso privacy (liberatoria foto). Le foto broadcast
// (comunicazioni istituzionali) bypassano il tagging e quindi il consenso.

/**
 * Ritorna gli ID degli alunni in `tagStudents` che NON hanno il consenso privacy.
 * @param consentById mappa alunnoId → consenso (true = liberatoria presente).
 * @param isBroadcast se true (foto istituzionale) il tagging è bypassato → [].
 */
export function studentiSenzaConsenso(
  tagStudents: string[] | null | undefined,
  consentById: Record<string, boolean>,
  isBroadcast = false,
): string[] {
  if (isBroadcast) return []
  return [...new Set(tagStudents ?? [])].filter((id) => consentById[id] !== true)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any }

/**
 * Carica il consenso degli alunni taggati e ritorna chi NON può essere taggato
 * (id + nome leggibile per il messaggio 422). [] se broadcast o nessun tag.
 */
export async function alunniSenzaConsenso(
  supabase: Db,
  tagStudents: string[] | null | undefined,
  isBroadcast = false,
): Promise<{ id: string; nome: string }[]> {
  const ids = [...new Set(tagStudents ?? [])]
  if (isBroadcast || ids.length === 0) return []
  const { data: rows } = await supabase
    .from('alunni')
    .select('id, nome, cognome, consenso_privacy')
    .in('id', ids)
  const list = (rows ?? []) as Array<{ id: string; nome?: string; cognome?: string; consenso_privacy?: boolean }>
  const consentById = Object.fromEntries(list.map((r) => [r.id, r.consenso_privacy === true]))
  const nameById = new Map(list.map((r) => [r.id, `${r.nome ?? ''} ${r.cognome ?? ''}`.trim()]))
  return studentiSenzaConsenso(ids, consentById, isBroadcast).map((id) => ({ id, nome: nameById.get(id) || id }))
}
