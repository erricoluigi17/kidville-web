import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { CARTA, fasceVietate } from '@/lib/carta/geometria'
import type { CellaStorico, ColonnaStorico, DocumentoStorico, SezioneStorico } from './tipi'

export const testoPdf = (v: unknown) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

/** Le date archiviate restano intatte; solo la loro rappresentazione è italiana. */
export function valorePdf(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Sì' : 'No'
  const s = testoPdf(v)
  const giorno = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (giorno) return `${giorno[3]}/${giorno[2]}/${giorno[1]}`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s)
    if (Number.isFinite(d.getTime())) return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  }
  const date = s.split(/\s*;\s*/)
  if (date.length > 1 && date.every(d => /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(d))) return date.map(valorePdf).join('; ')
  return s
}

/** La carta orizzontale ha logo e piede ai lati, non in testa e in fondo. */
export function areaPdf(orizzontale: boolean) {
  const { marchio, piede } = fasceVietate(297, 210)
  return orizzontale
    ? { sx: marchio.sinistra + marchio.larghezza + 4, dx: piede.sinistra - 4, titoloY: 16, fondo: 195, altezza: 210, servizio: 201 }
    : { sx: CARTA.margineSx, dx: CARTA.margineDx, titoloY: CARTA.contenutoInizio, fondo: CARTA.contenutoFine, altezza: 297, servizio: CARTA.rigaServizio }
}

type RigaStampa = Record<string, CellaStorico>
export interface ColonneStampa { colonne: ColonnaStorico[]; righe: RigaStampa[]; costanti: string[] }

/** Testo descrittivo: va a capo nella cella e non sale mai in testata. */
const CHIAVI_LUNGHE = /^(argomento|compiti|testo|nota|note|notaIndividuale|contenuto|corpo|descrizione|dettaglio|obiettivi|allegati)$/i
/** Colonne brevi a larghezza fissa, in mm: il resto del foglio va al testo. */
const LARGHEZZE: Record<string, number> = { _n: 10, ora: 12, orario: 26, consegna: 24, _altri: 50 }
const VERDE: [number, number, number] = [27, 90, 65]
const NUMERO: ColonnaStorico = { chiave: '_n', titolo: 'N.' }
const ALTRI: ColonnaStorico = { chiave: '_altri', titolo: 'Altri dati' }
const MASSIMO_COLONNE = 7
const RIEMPIMENTO = 1.8

const estesa = (c: ColonnaStorico, righe: RigaStampa[]) => righe.some(r => { const v = valorePdf(r[c.chiave]); return v.length > 120 || /[\r\n]/.test(v) })
const lunga = (c: ColonnaStorico, righe: RigaStampa[]) => CHIAVI_LUNGHE.test(c.chiave) || estesa(c, righe)
const massimo = (valori: number[]) => valori.reduce((a, b) => Math.max(a, b), 0)
const somma = (valori: number[]) => valori.reduce((a, b) => a + b, 0)

/**
 * Oltre sette colonne il testo finisce in strisce di un carattere: le prime colonne brevi e
 * quelle di testo restano, gli altri dati brevi si leggono «Titolo: valore» in una colonna sola.
 */
export function compattaColonne(colonne: ColonnaStorico[], righe: RigaStampa[]): { colonne: ColonnaStorico[]; righe: RigaStampa[] } {
  if (colonne.length <= MASSIMO_COLONNE) return { colonne, righe }
  const lunghe = colonne.filter(c => lunga(c, righe))
  const brevi = colonne.filter(c => !lunghe.includes(c))
  const restano = Math.max(1, MASSIMO_COLONNE - 1 - lunghe.length)
  const tenute = new Set([...brevi.slice(0, restano), ...lunghe])
  const raccolte = brevi.slice(restano)
  return {
    colonne: [...colonne.filter(c => tenute.has(c)), ALTRI],
    righe: righe.map(r => ({ ...r, _altri: raccolte.flatMap(c => { const v = valorePdf(r[c.chiave]); return v ? [`${testoPdf(c.titolo)}: ${v}`] : [] }).join('\n') })),
  }
}

/** Niente colonne vuote, inizio e fine in un orario solo, valori comuni a tutte le righe in testata. */
export function preparaColonne(colonne: ColonnaStorico[], righe: RigaStampa[], perGiorno = false): ColonneStampa {
  let cols = [...colonne], rows = righe
  if (cols.some(c => c.chiave === 'inizio') && cols.some(c => c.chiave === 'fine')) {
    rows = rows.map(r => ({ ...r, orario: [valorePdf(r.inizio), valorePdf(r.fine)].filter(Boolean).join('–') }))
    cols = cols.flatMap(c => c.chiave === 'inizio' ? [{ chiave: 'orario', titolo: 'Orario' }] : c.chiave === 'fine' ? [] : [c])
  }
  cols = cols.filter(c => rows.some(r => valorePdf(r[c.chiave]).trim() !== ''))
  const costanti: string[] = []
  if (rows.length >= 2) cols = cols.filter(c => {
    if ((perGiorno && c.chiave === 'data') || lunga(c, rows)) return true
    const primo = valorePdf(rows[0][c.chiave])
    if (rows.some(r => valorePdf(r[c.chiave]) !== primo)) return true
    costanti.push(`${testoPdf(c.titolo)}: ${primo}`)
    return false
  })
  return { colonne: cols, righe: rows, costanti }
}

const chiaveGiorno = (v: unknown) => { const s = testoPdf(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s }

/** «Lunedì 5 ottobre 2026»: il giorno si legge, non si decifra. */
export function titoloGiorno(data: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data)
  if (!m) return data ? valorePdf(data) : 'Senza data'
  const s = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))))
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Flusso dei contenuti: un titolo per giorno e tabelle a corpo fisso, nessun taglio. */
export class ImpaginazioneStoricoPdf {
  readonly doc = new jsPDF({ unit: 'mm', format: 'a4' })
  private y = 0
  private titolo = ''

  constructor(private documento: Pick<DocumentoStorico, 'scuolaNome' | 'dal' | 'al'>) {}

  private orizzontale(): boolean { return this.doc.internal.pageSize.getWidth() > this.doc.internal.pageSize.getHeight() }

  private testata(titolo: string, disegna = true): number {
    const area = areaPdf(this.orizzontale())
    const larghezza = area.dx - area.sx
    this.doc.setFont('helvetica', 'bold').setFontSize(15)
    const righe = this.doc.splitTextToSize(testoPdf(titolo), larghezza) as string[]
    if (disegna) this.doc.text(righe, area.sx, area.titoloY, { lineHeightFactor: 1.2 })
    const y = area.titoloY + righe.length * 6.35
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    const contesto = this.doc.splitTextToSize(`${this.documento.scuolaNome} · ${valorePdf(this.documento.dal)} / ${valorePdf(this.documento.al)}`, larghezza) as string[]
    if (disegna) this.doc.text(contesto, area.sx, y, { lineHeightFactor: 1.2 })
    return y + contesto.length * 4.24 + 5
  }

  nuovaPagina(titolo: string, prima = false) {
    if (!prima) this.doc.addPage('a4', 'portrait')
    this.titolo = titolo
    this.y = this.testata(titolo)
  }

  /** Foglio successivo con lo stesso orientamento e la stessa testata. */
  private continua() {
    this.doc.addPage('a4', this.orizzontale() ? 'landscape' : 'portrait')
    this.y = this.testata(this.titolo)
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
  }

  testo(valore: unknown, titolo?: string) {
    const area = areaPdf(this.orizzontale())
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    const righe = this.doc.splitTextToSize(valorePdf(valore) || '—', area.dx - area.sx) as string[]
    // L'etichetta e le prime righe del blocco restano sullo stesso foglio.
    if (this.y + (titolo ? 6 : 0) + Math.min(2, righe.length) * 5 > area.fondo) this.continua()
    if (titolo) {
      this.doc.setFont('helvetica', 'bold').setFontSize(10)
      const etichetta = this.doc.splitTextToSize(testoPdf(titolo), area.dx - area.sx) as string[]
      for (const riga of etichetta) {
        if (this.y + 5 > area.fondo) this.continua()
        this.doc.text(riga, area.sx, this.y)
        this.y += 5
      }
    }
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    for (const riga of righe) {
      if (this.y + 5 > area.fondo) {
        this.continua()
        if (titolo) {
          this.doc.setFont('helvetica', 'bold').setFontSize(10)
          this.doc.text(`${titolo} (continua)`, area.sx, this.y)
          this.y += 6
          this.doc.setFont('helvetica', 'normal').setFontSize(10)
        }
      }
      this.doc.text(riga, area.sx, this.y)
      this.y += 5
    }
    this.y += 3
  }

  /** Apre la sezione; i valori uguali su tutte le righe si leggono una volta sotto il titolo. */
  private apriSezione(titolo: string, costanti: string[], orizzontale: boolean) {
    this.doc.addPage('a4', orizzontale ? 'landscape' : 'portrait')
    this.titolo = titolo
    this.y = this.testata(titolo)
    if (!costanti.length) return
    const area = areaPdf(orizzontale)
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    const righe = this.doc.splitTextToSize(costanti.join(' · '), area.dx - area.sx) as string[]
    this.doc.text(righe, area.sx, this.y, { lineHeightFactor: 1.2 })
    this.y += righe.length * 4.24 + 3
  }

  private titoloDelGiorno(etichetta: string) {
    const area = areaPdf(this.orizzontale())
    // Titolo, intestazione e almeno una riga sullo stesso foglio.
    if (this.y + 25 > area.fondo) this.continua()
    this.doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...VERDE)
    this.doc.text(etichetta, area.sx, this.y)
    this.doc.setTextColor(0).setFont('helvetica', 'normal').setFontSize(10)
    this.y += 6
  }

  /**
   * Le brevi prendono quanto serve al contenuto (al massimo 40 mm), le colonne di testo il resto,
   * in proporzione a quanto testo portano e mai sotto la loro parola più lunga.
   */
  private larghezze(colonne: ColonnaStorico[], righe: RigaStampa[], disponibile: number): Record<number, { cellWidth: number }> {
    const lunghe = colonne.filter(c => !LARGHEZZE[c.chiave] && lunga(c, righe))
    if (!lunghe.length) return {}
    const misura = (s: string, grassetto = false) => { this.doc.setFont('helvetica', grassetto ? 'bold' : 'normal').setFontSize(10); return this.doc.getTextWidth(s) }
    const parola = (c: ColonnaStorico) => massimo([
      ...testoPdf(c.titolo).split(/\s+/).map(p => misura(p, true)),
      ...righe.flatMap(r => valorePdf(r[c.chiave]).split(/\s+/)).map(p => misura(p)),
    ])
    const larghezza = new Map<ColonnaStorico, number>()
    for (const c of colonne) if (!lunghe.includes(c)) larghezza.set(c, LARGHEZZE[c.chiave]
      ?? Math.min(40, Math.max(parola(c), massimo(righe.map(r => misura(valorePdf(r[c.chiave])))))) + 2 * RIEMPIMENTO + .5)
    const minimi = lunghe.map(c => Math.min(70, parola(c) + 2 * RIEMPIMENTO + .5))
    const extra = Math.max(0, disponibile - somma([...larghezza.values()]) - somma(minimi))
    const pesi = lunghe.map(c => Math.sqrt(10 + somma(righe.map(r => valorePdf(r[c.chiave]).length)) / Math.max(1, righe.length)))
    lunghe.forEach((c, i) => larghezza.set(c, minimi[i] + extra * pesi[i] / somma(pesi)))
    return Object.fromEntries(colonne.map((c, i) => [i, { cellWidth: larghezza.get(c) ?? 30 }]))
  }

  private tabella(colonne: ColonnaStorico[], righe: RigaStampa[], giorno = '') {
    const orizzontale = this.orizzontale()
    const area = areaPdf(orizzontale)
    if (this.y + 18 > area.fondo) {
      this.continua()
      if (giorno) this.titoloDelGiorno(`${giorno} (continua)`)
    }
    const titolo = this.titolo
    const primaPagina = this.doc.getCurrentPageInfo().pageNumber
    autoTable(this.doc, {
      startY: this.y,
      head: [colonne.map(c => testoPdf(c.titolo))],
      body: righe.map(r => colonne.map(c => valorePdf(r[c.chiave]))),
      margin: { left: area.sx, right: (orizzontale ? 297 : 210) - area.dx, top: this.testata(titolo, false) + (giorno ? 6 : 0), bottom: area.altezza - area.fondo },
      styles: { fontSize: 10, cellPadding: 1.8, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: VERDE, fontSize: 10 },
      columnStyles: this.larghezze(colonne, righe, area.dx - area.sx),
      showHead: 'everyPage',
      // Una riga lunga continua sul foglio dopo: nessun testo tagliato.
      rowPageBreak: 'auto',
      willDrawPage: () => {
        if (this.doc.getCurrentPageInfo().pageNumber === primaPagina) return
        const y = this.testata(titolo)
        if (!giorno) return
        this.doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...VERDE)
        this.doc.text(`${giorno} (continua)`, area.sx, y)
        this.doc.setTextColor(0).setFont('helvetica', 'normal').setFontSize(10)
      },
    })
    const fine = (this.doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY
    this.y = (fine ?? this.y) + 6
  }

  /** Un titolo per giorno, la nota di sezione una volta, poi la tabella delle registrazioni. */
  private perGiorno(titolo: string, colonne: ColonnaStorico[], righe: RigaStampa[], costanti: string[] = []) {
    const note = righe.filter(r => r._nota_giorno === true)
    const pronte = preparaColonne(colonne, righe.filter(r => r._nota_giorno !== true), true)
    const { colonne: tabella, righe: registrazioni } = compattaColonne(pronte.colonne.filter(c => c.chiave !== 'data'), pronte.righe)
    this.apriSezione(titolo, [...costanti, ...pronte.costanti], tabella.length > 5)
    if (!note.length && !pronte.colonne.some(c => c.chiave === 'data')) {
      if (tabella.length) this.tabella(tabella, registrazioni)
      return
    }
    // Le fonti arrivano in ordine cronologico: i giorni seguono l'ordine di comparsa.
    const giorni = new Map<string, { note: RigaStampa[]; righe: RigaStampa[] }>()
    const gruppo = (data: unknown) => {
      const chiave = chiaveGiorno(data)
      const g = giorni.get(chiave) ?? { note: [], righe: [] }
      giorni.set(chiave, g)
      return g
    }
    for (const r of righe) gruppo(r.data)
    for (const n of note) gruppo(n.data).note.push(n)
    for (const r of registrazioni) gruppo(r.data).righe.push(r)
    for (const [giorno, g] of giorni) {
      const etichetta = titoloGiorno(giorno)
      this.titoloDelGiorno(etichetta)
      for (const n of g.note) this.testo(n.dettaglio, 'Nota di sezione')
      if (g.righe.length && tabella.length) this.tabella(tabella, g.righe, etichetta)
    }
  }

  sezione(sezione: SezioneStorico) {
    if (!sezione.righe.length || !sezione.colonne.length) {
      this.nuovaPagina(sezione.titolo)
      this.testo(sezione.allegati.length || sezione.generati?.length
        ? 'Nessuna registrazione tabellare; gli allegati sono inclusi nella raccolta, con eventuali avvertenze di completezza nell’indice.'
        : 'Nessuna registrazione disponibile nel periodo scelto.')
      return
    }
    const narrativa = sezione.categoria.startsWith('diario_') || sezione.colonne.some(c => /^(argomento|compiti)$/.test(c.chiave)) || sezione.categoria === 'primaria_note'
    if (narrativa) { this.perGiorno(sezione.titolo, sezione.colonne, sezione.righe); return }
    const pronte = preparaColonne(sezione.colonne, sezione.righe)
    const estese = pronte.colonne.filter(c => estesa(c, pronte.righe))
    const compatte = pronte.colonne.filter(c => !estese.includes(c))
    const tabella = compatte.slice(0, 7)
    const dettagli = [...compatte.slice(7), ...estese]
    if (!tabella.length) { this.perGiorno(sezione.titolo, pronte.colonne, pronte.righe, pronte.costanti); return }
    const righe = dettagli.length ? pronte.righe.map((r, i) => ({ ...r, _n: String(i + 1) })) : pronte.righe
    this.apriSezione(sezione.titolo, pronte.costanti, true)
    this.tabella([...(dettagli.length ? [NUMERO] : []), ...tabella], righe)
    if (dettagli.length) this.perGiorno(`${sezione.titolo} · Dettagli delle registrazioni`, [NUMERO, tabella[0], ...dettagli], righe)
  }
}
