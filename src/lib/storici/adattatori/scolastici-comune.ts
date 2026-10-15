import { CATALOGO_STORICI, type CategoriaStorico } from '../catalogo'
import { leggiTutte } from '../db'
import { appartieneNelGiorno } from '../scope'
import type { AllegatoStorico, ContestoStorico, SezioneStorico } from '../tipi'

export type Riga = Record<string, unknown>
/** Interfaccia strutturale: evita di istanziare il parser di select su nomi di tabella dinamici. */
export interface Query extends PromiseLike<{ data: unknown; error: unknown }> {
  eq(colonna: string, valore: unknown): Query
  in(colonna: string, valori: readonly unknown[]): Query
  is(colonna: string, valore: boolean | null): Query
  not(colonna: string, operatore: string, valore: unknown): Query
  gte(colonna: string, valore: unknown): Query
  lte(colonna: string, valore: unknown): Query
  or(filtro: string): Query
  order(colonna: string): Query
  range(dal: number, al: number): Query
}
export const testo = (v: unknown): string => typeof v === 'string' ? v.trim() : ''
export const oggetto = (v: unknown): Riga => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Riga : {}
export const elenco = (v: unknown): Riga[] => Array.isArray(v) ? v.map(oggetto) : []
export const numero = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
export const cella = (v: unknown): string | number | boolean | null => typeof v === 'string' || typeof v === 'boolean' ? v : numero(v)
export const stringhe = (v: unknown): string => Array.isArray(v) ? v.map(testo).filter(Boolean).join(', ') : testo(v)

/** Le date pure restano date; gli istanti si leggono nel giorno civile italiano. */
export function giorno(v: unknown): string {
  const s = testo(v)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (!s) return ''
  const d = new Date(s)
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' }) : ''
}
export function nelPeriodo(ctx: ContestoStorico, data: string): boolean {
  return Boolean(data && ctx.richiesta.dal <= data && data <= ctx.richiesta.al)
}
export function ammesso(ctx: ContestoStorico, alunnoId: string, data: string, sectionId?: string, scuolaIdFonte?: string): boolean {
  const alunno = ctx.alunni.find(a => a.id === alunnoId)
  if (!alunno || !nelPeriodo(ctx, data)) return false
  if (scuolaIdFonte && scuolaIdFonte !== ctx.richiesta.scuolaId) return false
  const appartenenze = ctx.appartenenze.filter(a => a.scuola_id === ctx.richiesta.scuolaId)
  if (ctx.richiesta.sectionId) return (!sectionId || sectionId === ctx.richiesta.sectionId)
    && appartieneNelGiorno(appartenenze, alunnoId, data, ctx.richiesta.sectionId)
  if (sectionId) return appartieneNelGiorno(appartenenze, alunnoId, data, sectionId)
  // La sede attuale dell'alunno non attribuisce alla stessa sede i fatti degli anni precedenti.
  return scuolaIdFonte === ctx.richiesta.scuolaId || appartieneNelGiorno(appartenenze, alunnoId, data)
}
export function avvisaCoperturaAppartenenze(ctx: ContestoStorico, sezione: SezioneStorico): void {
  const incompleta = ctx.alunni.some(a => {
    let copertoFino = ctx.richiesta.dal
    const intervalli = ctx.appartenenze.filter(p => p.alunno_id === a.id && p.scuola_id === ctx.richiesta.scuolaId
      && (!ctx.richiesta.sectionId || p.section_id === ctx.richiesta.sectionId)).sort((a, b) => a.dal.localeCompare(b.dal))
    for (const p of intervalli) {
      if (p.al && p.al <= copertoFino) continue
      if (p.dal > copertoFino) return true
      if (!p.al || p.al > ctx.richiesta.al) return false
      copertoFino = p.al
    }
    return copertoFino <= ctx.richiesta.al
  })
  if (incompleta) sezione.avvisi.push('La copertura delle appartenenze alla sede è incompleta: gli eventi privi di una sede propria sono esclusi nei giorni senza appartenenza documentata.')
}
export function nome(ctx: ContestoStorico, alunnoId: string): string {
  const a = ctx.alunni.find(a => a.id === alunnoId)
  return a ? `${a.cognome} ${a.nome}` : ''
}
export function nomePersona(r: Riga): string {
  return [testo(r.cognome) || testo(r.last_name), testo(r.nome) || testo(r.first_name)].filter(Boolean).join(' ')
}
export function nuovaSezione(categoria: CategoriaStorico, colonne: Record<string, string>): SezioneStorico {
  return { categoria, titolo: CATALOGO_STORICI.find(c => c.id === categoria)?.titolo ?? categoria,
    colonne: Object.entries(colonne).map(([chiave, titolo]) => ({ chiave, titolo })), righe: [], allegati: [], avvisi: [] }
}
export const idsAlunni = (ctx: ContestoStorico): string[] => ctx.alunni.map(a => a.id)

/** Ogni lotto ha paginazione e ordinamento stabile: nessun tetto implicito di PostgREST. */
export async function perIds(ctx: ContestoStorico, tabella: string, campo: string, ids: string[],
  filtra: (q: Query) => Query = q => q, colonne = '*', ordine = 'id'): Promise<Riga[]> {
  const righe: Riga[] = []
  const unici = [...new Set(ids)].sort()
  for (let i = 0; i < unici.length; i += 100) {
    const lotto = unici.slice(i, i + 100)
    righe.push(...await leggiTutte<Riga>((dal, al) => filtra((ctx.db.from(tabella).select(colonne) as unknown as Query).in(campo, lotto))
      .order(ordine).range(dal, al), `scolastici/${tabella}`))
  }
  return righe
}
export async function sezioni(ctx: ContestoStorico): Promise<Riga[]> {
  const ids = ctx.richiesta.sectionId ? [ctx.richiesta.sectionId] : ctx.appartenenze.map(a => a.section_id)
  const correnti = await perIds(ctx, 'sections', 'id', ids, q => q.eq('scuola_id', ctx.richiesta.scuolaId), 'id,name,school_type')
  const note = new Set(correnti.map(c => testo(c.id)))
  for (const p of ctx.appartenenze.filter(p => p.scuola_id === ctx.richiesta.scuolaId && ids.includes(p.section_id))) {
    if (note.has(p.section_id)) continue
    correnti.push({ id: p.section_id, name: p.section_nome || 'Classe archiviata', school_type: null })
    note.add(p.section_id)
  }
  return correnti
}
export async function persone(ctx: ContestoStorico, ids: string[]): Promise<Map<string, string>> {
  const righe = await perIds(ctx, 'utenti', 'id', ids.filter(Boolean), q => q, 'id,nome,cognome')
  return new Map(righe.map(r => [testo(r.id), nomePersona(r)]))
}

/** Si conservano solo riferimenti del bucket atteso; un URL esterno non diventa un file privato. */
export function allegato(bucket: string, riferimento: unknown, nomeFile: string, alunnoId?: string, mime?: string): AllegatoStorico | null {
  let percorso = testo(riferimento)
  if (!percorso) return null
  if (/^https?:\/\//i.test(percorso)) {
    if (!URL.canParse(percorso)) return null
    const url = new URL(percorso)
    const prefisso = `/storage/v1/object/`
    const parti = url.pathname.split(prefisso)[1]?.split('/')
    if (!parti || !['public', 'sign', 'authenticated'].includes(parti[0]) || parti[1] !== bucket) return null
    if (/%(?![0-9a-f]{2})/i.test(parti.slice(2).join('/'))) return null
    percorso = parti.slice(2).map(decodeURIComponent).join('/')
  } else if (percorso.startsWith(`${bucket}/`)) percorso = percorso.slice(bucket.length + 1)
  if (!percorso || percorso.startsWith('/') || /[\\\u0000-\u001f?#]/.test(percorso) || percorso.split('/').includes('..')) return null
  return { bucket, percorso, nome: nomeFile || percorso.split('/').at(-1) || 'documento', ...(alunnoId ? { alunnoId } : {}), ...(mime ? { mime } : {}) }
}
export function aggiungiAllegato(s: SezioneStorico, a: AllegatoStorico | null): void {
  if (a && !s.allegati.some(x => x.bucket === a.bucket && x.percorso === a.percorso && x.alunnoId === a.alunnoId)) s.allegati.push(a)
}
