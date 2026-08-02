// P4/DL-041 — Privacy Lock (Galleria): regola "foto privata".
// Un bambino può essere taggato DA SOLO in una foto anche SENZA liberatoria:
// una foto con un unico tag è mostrata solo ai genitori di quel bambino
// (single tag = visibilità parents-only). Le foto di GRUPPO (≥2 taggati)
// richiedono invece la liberatoria foto (consenso_privacy === true) per OGNI
// bambino taggato.
//
// ⚠️ Questa regola vale su ciò che l'applicazione MOSTRA. Fino al 2026-07-31
// valeva solo su quello, e qui c'era scritto che il bucket restava pubblico
// «con hardening a signed-URL in un follow-up»: nel frattempo chiunque avesse
// (o indovinasse) l'indirizzo di un file vedeva la foto senza login, e la
// «foto privata» era privata solo dentro l'app. Il follow-up è stato fatto —
// bucket `gallery` PRIVATO e link firmati a tempo, vedi `./storage.ts`.
//
// ⚠️ 2026-07-31 — IL BROADCAST NON È PIÙ UN LASCIAPASSARE (collaudo privacy, F5).
// Fino a oggi la prima riga di entrambe le funzioni diceva
// `if (isBroadcast || uniqueTags.length <= 1) return []`: con `is_broadcast:true`
// il consenso non veniva verificato, e nemmeno LETTO — si usciva prima della
// query. Il vincolo «broadcast ⇒ nessun tag», che quel ramo dava per scontato,
// viveva soltanto nel client (`teacher/gallery/page.tsx:304`,
// `tag_students: f.is_broadcast ? [] : f.tag_students`): chi chiamava l'API
// direttamente pubblicava una foto di gruppo di bambini senza liberatoria
// verso l'intera sede. **Una regola di privacy applicata dal client non è una
// regola, è un suggerimento** — e il broadcast è il canale con la platea più
// ampia, cioè quello che del consenso ha più bisogno, non meno.
//
// Il parametro `isBroadcast` è stato TOLTO dalla firma, non lasciato lì
// ignorato: un argomento capace di spegnere un controllo di privacy, prima o
// poi, qualcuno lo passa. Ora il compilatore non permette nemmeno di provarci.
// Il vincolo «broadcast ⇒ nessun tag» lo impone il server, con un 400 esplicito
// in POST e PATCH di `/api/gallery`.

import { logEvento } from '@/lib/logging/logger'

/**
 * Ritorna gli ID degli alunni in `tagStudents` che bloccano la pubblicazione
 * perché privi del consenso privacy (liberatoria foto).
 *
 * Regola "foto privata": un solo bambino taggato → sempre consentito ([]),
 * perché la foto è visibile ai soli genitori di quel bambino. Il vincolo scatta
 * sulle foto di gruppo (≥2 taggati distinti), dove ognuno deve avere
 * `consenso_privacy === true`. Il canale di pubblicazione (broadcast o no) NON
 * entra in questo calcolo: vedi la nota in testa al file.
 *
 * @param consentById mappa alunnoId → consenso (true = liberatoria presente).
 */
export function studentiSenzaConsenso(
  tagStudents: string[] | null | undefined,
  consentById: Record<string, boolean>,
): string[] {
  const uniqueTags = [...new Set(tagStudents ?? [])]
  // Foto privata (≤1 taggato): nessun blocco.
  if (uniqueTags.length <= 1) return []
  return uniqueTags.filter((id) => consentById[id] !== true)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any }

/**
 * Carica il consenso degli alunni taggati e ritorna chi blocca la pubblicazione
 * (id + nome leggibile per il messaggio 422). [] per la "foto privata"
 * (≤1 taggato): in quel caso la query di consenso è pure superflua, quindi si
 * esce prima di toccare il DB.
 *
 * ⚠️ Il chiamante deve aver già verificato che quegli alunni siano nei propri
 * plessi: il nome che esce di qui è di un minore (vedi `gallery/route.ts:348`).
 */
export async function alunniSenzaConsenso(
  supabase: Db,
  tagStudents: string[] | null | undefined,
): Promise<{ id: string; nome: string }[]> {
  const ids = [...new Set(tagStudents ?? [])]
  // Foto privata (≤1 taggato) → consentito senza interrogare il DB.
  if (ids.length <= 1) return []
  const { data: rows, error } = await supabase
    .from('alunni')
    .select('id, nome, cognome, consenso_privacy')
    .in('id', ids)
  // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo una
  // lettura fallita si travestiva da «nessun consenso trovato» — che qui è
  // fail-CLOSED (la pubblicazione viene negata, e va bene così) ma MUTO: chi
  // legge i log vedeva un 422 «manca la liberatoria» su bambini che invece ce
  // l'hanno, senza un solo indizio su cosa fosse successo davvero.
  if (error) {
    logEvento('galleria', 'error', {
      operazione: 'alunniSenzaConsenso',
      esito: 'lettura-consensi-fallita',
      // Solo il conteggio: gli id sono di minori e non servono a diagnosticare.
      taggati: ids.length,
    }, error)
  }
  const list = (rows ?? []) as Array<{ id: string; nome?: string; cognome?: string; consenso_privacy?: boolean }>
  const consentById = Object.fromEntries(list.map((r) => [r.id, r.consenso_privacy === true]))
  const nameById = new Map(list.map((r) => [r.id, `${r.nome ?? ''} ${r.cognome ?? ''}`.trim()]))
  return studentiSenzaConsenso(ids, consentById).map((id) => ({ id, nome: nameById.get(id) || id }))
}
