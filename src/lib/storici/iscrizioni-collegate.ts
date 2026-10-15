import { createHash } from 'node:crypto'
type Riga = Record<string, unknown>
const record = (v: unknown): Riga => v && typeof v === 'object' && !Array.isArray(v) ? v as Riga : {}
const elenco = (v: unknown): Riga[] => Array.isArray(v) ? v.map(record) : []
function canonico(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonico)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonico(x)]))
  return v
}
/** Attribuzione umana esplicita: mai confronti con nome o codice fiscale. */
export function contenutoIscrizione(data: unknown, indice: number | null, adulti: number[]): { figlio: Riga; adulti: Riga[]; impronta: string } | null {
  const d = record(data), figli = elenco(d.children), persone = elenco(d.adults)
  if (indice === null || !Number.isInteger(indice) || indice < 0 || indice >= figli.length || adulti.some(i => !Number.isInteger(i) || i < 0 || i >= persone.length)) return null
  const scelta = { figlio: figli[indice], adulti: [...new Set(adulti)].sort((a, b) => a - b).map(i => persone[i]) }
  return { ...scelta, impronta: createHash('sha256').update(JSON.stringify(canonico(scelta))).digest('hex') }
}
export function personeIscrizione(data: unknown) {
  const d = record(data)
  const descrivi = (v: Riga, indice: number) => ({ indice, nome: [v.nome ?? v.first_name, v.cognome ?? v.last_name].filter(x => typeof x === 'string').join(' '), ruolo: typeof v.ruolo === 'string' ? v.ruolo : '' })
  return { figli: elenco(d.children).map(descrivi), adulti: elenco(d.adults).map(descrivi) }
}
