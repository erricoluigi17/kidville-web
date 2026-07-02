import type { FormField, FormPage, ConsentoSnapshot } from '@/types/database.types'

/**
 * Blocchi Consensi (DL-029). Helper puri per:
 *  - produrre lo SNAPSHOT legale dei consensi accettati in una submission
 *    (testo autoritativo dal modello + valore spuntato + timestamp);
 *  - validare lato server che i consensi OBBLIGATORI siano stati accettati.
 *
 * Modello: 1 blocco `consent` = 1 consenso, reso come una singola checkbox.
 * Il valore in `submission.data[field.id]` è un boolean.
 */

function campiConsenso(pages: FormPage[]): FormField[] {
  return pages.flatMap(p => p.fields).filter(f => f.type === 'consent')
}

/** Lo snapshot di TUTTI i consensi del modello, per archiviazione in `consents_log`. */
export function estraiConsensi(
  pages: FormPage[],
  data: Record<string, unknown>,
  acceptedAt: string
): ConsentoSnapshot[] {
  return campiConsenso(pages).map(f => {
    const snap: ConsentoSnapshot = {
      field_id: f.id,
      label: f.label,
      accepted: data[f.id] === true,
      accepted_at: acceptedAt,
    }
    if (f.text) snap.text = f.text
    if (f.link) snap.link = f.link
    return snap
  })
}

/** Id dei consensi `required` non accettati (`!== true`). Vuoto = tutto ok. */
export function consensiObbligatoriMancanti(
  pages: FormPage[],
  data: Record<string, unknown>
): string[] {
  return campiConsenso(pages)
    .filter(f => f.required && data[f.id] !== true)
    .map(f => f.id)
}
