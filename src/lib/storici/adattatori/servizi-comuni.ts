import type { ContestoStorico, SezioneStorico, AllegatoStorico } from '../tipi'
import { CATALOGO_STORICI, type CategoriaStorico } from '../catalogo'
import { leggiTutte } from '../db'
import { appartieneNelGiorno } from '../scope'
import { percorsoNelBucket } from '@/lib/allegati/storage'
import { intervalloGiornoRoma } from '../retroattivita'

export type Riga = Record<string, unknown>
export type Query = ReturnType<ReturnType<ContestoStorico['db']['from']>['select']>
export const testo = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
export const numero = (v: unknown): number => Number.isFinite(Number(v)) ? Number(v) : 0
export const lista = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
export const oggetto = (v: unknown): Riga => v && typeof v === 'object' && !Array.isArray(v) ? v as Riga : {}
export function relazione(v: unknown): Riga { return oggetto(Array.isArray(v) ? v[0] : v) }
export const euro = (v: unknown): number => Math.round(numero(v) * 100) / 100
export function giorno(v: unknown): string {
  const s = testo(v)
  if (!s.includes('T')) return s.slice(0, 10)
  const d = new Date(s)
  if (!Number.isFinite(d.getTime())) return ''
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  return `${p.find(x => x.type === 'year')?.value}-${p.find(x => x.type === 'month')?.value}-${p.find(x => x.type === 'day')?.value}`
}
export function giornoDopo(data: string): string { return new Date(new Date(`${data}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10) }
const mezzanotteRoma = (data: string): string => intervalloGiornoRoma(data).startOfDay
export function periodo(q: Query, ctx: ContestoStorico, campo: string, timestamp = false): Query {
  return timestamp
    ? q.gte(campo, mezzanotteRoma(ctx.richiesta.dal)).lt(campo, mezzanotteRoma(giornoDopo(ctx.richiesta.al)))
    : q.gte(campo, ctx.richiesta.dal).lte(campo, ctx.richiesta.al)
}
/** OR applicato PRIMA di range: competenza esplicita, altrimenti il timestamp legacy. */
export function filtroPeriodoCompetenza(ctx: ContestoStorico, campoFallback: string): string {
  return `and(giorno_competenza.gte.${ctx.richiesta.dal},giorno_competenza.lte.${ctx.richiesta.al}),and(giorno_competenza.is.null,${campoFallback}.gte.${mezzanotteRoma(ctx.richiesta.dal)},${campoFallback}.lt.${mezzanotteRoma(giornoDopo(ctx.richiesta.al))})`
}
export function periodoCompetenza(q: Query, ctx: ContestoStorico, campoFallback: string): Query {
  return q.or(filtroPeriodoCompetenza(ctx, campoFallback))
}
export function dataCompetenza(riga: Riga, campoFallback: string): string { return giorno(riga.giorno_competenza ?? riga[campoFallback]) }
export function filtroDateEvento(ctx: ContestoStorico, campi: string[]): string {
  const inizio = mezzanotteRoma(ctx.richiesta.dal), fine = mezzanotteRoma(giornoDopo(ctx.richiesta.al))
  return campi.map(campo => `and(${campo}.gte.${inizio},${campo}.lt.${fine})`).join(',')
}
export function nelPeriodo(ctx: ContestoStorico, data: unknown): boolean { const d = giorno(data); return !!d && d >= ctx.richiesta.dal && d <= ctx.richiesta.al }
export function ammessa(ctx: ContestoStorico, id: unknown, data: unknown): boolean {
  const alunnoId = testo(id), d = giorno(data)
  const alunno = ctx.alunni.find(a => a.id === alunnoId)
  if (!alunno || !nelPeriodo(ctx, d)) return false
  const appartenenze = ctx.appartenenze.filter(a => a.scuola_id === ctx.richiesta.scuolaId)
  // Un trasferimento non deve cancellare lo storico della sede precedente.
  // Per una sede diversa da quella corrente, serve la prova nel giorno richiesto;
  // per l'estrazione classe la prova serve sempre. La fonte mantiene il suo filtro sede.
  return ctx.richiesta.sectionId || alunno.scuola_id !== ctx.richiesta.scuolaId
    ? appartieneNelGiorno(appartenenze, alunnoId, d, ctx.richiesta.sectionId)
    : true
}
export function nome(ctx: ContestoStorico, id: unknown): string {
  const a = ctx.alunni.find(a => a.id === id)
  return a ? `${a.cognome} ${a.nome}` : 'Alunno non disponibile'
}
export async function tutte(ctx: ContestoStorico, tabella: string, colonne: string, filtra: (q: Query) => Query, ordine = 'id'): Promise<Riga[]> {
  return leggiTutte<Riga>((da, a) => filtra(ctx.db.from(tabella).select(colonne)).order(ordine).range(da, a), `servizi/${tabella}`)
}
export async function perIds(ctx: ContestoStorico, tabella: string, colonne: string, campo: string, ids: string[], filtra: (q: Query) => Query = q => q): Promise<Riga[]> {
  const risultato: Riga[] = [], unici = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < unici.length; i += 100) risultato.push(...await tutte(ctx, tabella, colonne, q => filtra(q.in(campo, unici.slice(i, i + 100)))))
  return risultato
}
export async function perAlunni(ctx: ContestoStorico, tabella: string, colonne: string, data: string, timestamp = false): Promise<Riga[]> {
  const righe = await perIds(ctx, tabella, colonne, 'alunno_id', ctx.alunni.map(a => a.id), q => periodo(q.eq('scuola_id', ctx.richiesta.scuolaId), ctx, data, timestamp))
  return righe.filter(r => ammessa(ctx, r.alunno_id, r[data]))
}
export function sezione(categoria: CategoriaStorico, colonne: [string, string][]): SezioneStorico {
  return { categoria, titolo: CATALOGO_STORICI.find(c => c.id === categoria)?.titolo ?? categoria, colonne: colonne.map(([chiave, titolo]) => ({ chiave, titolo })), righe: [], allegati: [], avvisi: [] }
}
export function allegato(bucket: string, valore: unknown, nomeFile: string, alunnoId?: string, mime?: string): AllegatoStorico | null {
  const originale = testo(valore).trim()
  if (/^[a-z][a-z\d+.-]*:/i.test(originale) && !/^https?:\/\//i.test(originale) || originale.startsWith('//')) return null
  const percorso = percorsoNelBucket(bucket, testo(valore))
  if (!percorso || percorso.split('/').some(p => p === '..' || p === '.') || percorso.startsWith('/')) return null
  return { bucket, percorso, nome: nomeFile, ...(mime ? { mime } : {}), ...(alunnoId ? { alunnoId } : {}) }
}
export function aggiungiAllegato(s: SezioneStorico, a: AllegatoStorico | null): void {
  if (a && !s.allegati.some(x => x.bucket === a.bucket && x.percorso === a.percorso && x.alunnoId === a.alunnoId)) s.allegati.push(a)
}
export function aggiungiGenerato(s: SezioneStorico, nome: string, bytes: Uint8Array, alunnoId: string): void {
  s.generati ??= []
  s.generati.push({ nome, mime: 'application/pdf', base64: Buffer.from(bytes).toString('base64'), alunnoId })
}
