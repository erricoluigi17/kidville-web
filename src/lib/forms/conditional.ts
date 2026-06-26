/**
 * Motore di logica condizionale dei form (DL-024) — funzioni PURE.
 *
 * Il modello resta a **singola condizione** per campo (`FormField.condition`,
 * già presente nello schema): un campo è visibile se la sua condizione è
 * soddisfatta dai valori correnti. I campi nascosti non vanno validati e i loro
 * valori vanno rimossi dalla submission.
 */
import type { FormField, FormFieldCondition, FormPage } from '@/types/database.types'

export type FormValues = Record<string, unknown>

function norm(x: unknown): string {
  if (x == null) return ''
  if (typeof x === 'boolean') return x ? 'true' : 'false'
  return String(x)
}

function toNum(x: unknown): number {
  const n = typeof x === 'number' ? x : parseFloat(norm(x))
  return Number.isNaN(n) ? NaN : n
}

function valoriUguali(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b)
}

/** Valuta una singola condizione contro i valori del form. */
export function valutaCondizione(cond: FormFieldCondition, values: FormValues): boolean {
  const v = values[cond.field_id]
  const target = cond.value
  switch (cond.operator) {
    case 'eq':
      return valoriUguali(v, target)
    case 'neq':
      return !valoriUguali(v, target)
    case 'contains': {
      const t = norm(target)
      if (Array.isArray(v)) return v.some((x) => norm(x) === t)
      return norm(v).includes(t)
    }
    case 'gt': {
      const nv = toNum(v)
      return !Number.isNaN(nv) && nv > toNum(target)
    }
    case 'lt': {
      const nv = toNum(v)
      return !Number.isNaN(nv) && nv < toNum(target)
    }
    default:
      return true
  }
}

/** True se il campo va mostrato (nessuna condizione → sempre visibile). */
export function campoVisibile(field: FormField, values: FormValues): boolean {
  if (!field.condition) return true
  return valutaCondizione(field.condition, values)
}

/** Filtra i campi visibili dato lo stato corrente del form. */
export function campiVisibili(fields: FormField[], values: FormValues): FormField[] {
  return fields.filter((f) => campoVisibile(f, values))
}

/** Rimuove dalla submission i valori dei campi attualmente nascosti. */
export function pulisciNascosti(pages: FormPage[], values: FormValues): FormValues {
  const out: FormValues = { ...values }
  for (const page of pages) {
    for (const field of page.fields) {
      if (!campoVisibile(field, values)) delete out[field.id]
    }
  }
  return out
}
