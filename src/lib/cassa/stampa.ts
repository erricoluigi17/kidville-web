import { jsPDF } from 'jspdf'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import { formatEuro } from '@/lib/format/valuta'

export interface TotaliConteggio { entrate: number; uscite: number; prelievi: number; rettifiche: number; netto: number }
export interface RigaConteggio extends TotaliConteggio { scuola_id: string; cassa_categoria_id: string | null; cassa_nome: string | null }
export interface ConteggioCassa { righe: RigaConteggio[]; totali: TotaliConteggio }
export interface StampaConteggioInput {
  conteggio: ConteggioCassa
  raggruppamento: 'totale' | 'categoria'
  categoriaId?: string
  categoriaNome?: string
  da?: string
  a?: string
  sedi: { id: string; nome: string }[]
}
const VOCI = ['entrate', 'uscite', 'prelievi', 'rettifiche', 'netto'] as const
const vuoti = (): TotaliConteggio => ({ entrate: 0, uscite: 0, prelievi: 0, rettifiche: 0, netto: 0 })
const centesimi = (n: number) => Math.round(n * 100)
const netto = (r: TotaliConteggio) => centesimi(r.entrate) - centesimi(r.uscite) - centesimi(r.prelievi) + centesimi(r.rettifiche)
function somma(righe: TotaliConteggio[]): TotaliConteggio {
  const totale = vuoti()
  for (const r of righe) for (const voce of VOCI) totale[voce] = (centesimi(totale[voce]) + centesimi(r[voce])) / 100
  return totale
}

/** La RPC deve quadrare sia per colonna sia per formula, anche se due errori si compensano. */
export function differenzeConteggio(conteggio: ConteggioCassa): string[] {
  const differenze: string[] = []
  const calcolati = somma(conteggio.righe)
  for (const voce of VOCI) if (centesimi(calcolati[voce]) !== centesimi(conteggio.totali[voce])) differenze.push(`totali:${voce}`)
  for (const [n, r] of conteggio.righe.entries()) if (netto(r) !== centesimi(r.netto)) differenze.push(`riga:${n}:netto`)
  if (netto(conteggio.totali) !== centesimi(conteggio.totali.netto)) differenze.push('totali:formula')
  return differenze
}

/** Solo contenuto: la route applica la carta intestata prima di consegnare il PDF. */
export function costruisciConteggioPdf(i: StampaConteggioInput): Buffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  let y: number = CARTA.contenutoInizio
  const larghezza = CARTA.margineDx - CARTA.margineSx
  const spazio = (altezza: number) => {
    if (ingombroTesto(y + altezza, 10).fondo <= CARTA.contenutoFine) return false
    doc.addPage()
    y = CARTA.contenutoInizio
    return true
  }
  const testo = (s: string, corpo = 10, grassetto = false) => {
    doc.setFont('helvetica', grassetto ? 'bold' : 'normal')
    doc.setFontSize(corpo)
    const righe = doc.splitTextToSize(s, larghezza) as string[]
    for (const riga of righe) {
      spazio(0)
      doc.text(riga, CARTA.margineSx, y)
      y += corpo >= 13 ? 7 : 5
    }
  }
  const data = (s: string) => s.split('-').reverse().join('/')
  const periodo = i.da && i.a ? `${data(i.da)} - ${data(i.a)}` : i.da ? `Dal ${data(i.da)}` : i.a ? `Fino al ${data(i.a)}` : 'Tutto lo storico'
  testo(i.raggruppamento === 'totale' ? 'CONTEGGIO TOTALE' : 'CONTEGGIO PER CATEGORIA', 15, true)
  testo(`Periodo: ${periodo}`)
  testo(`Sedi: ${i.sedi.length ? i.sedi.map((s) => s.nome).join(', ') : 'Nessuna sede selezionata'}`)
  testo('Movimenti contanti nel periodo, escluso fondo iniziale. Il netto non è il saldo fisico della cassa: non comprende il fondo iniziale o il denaro già presente prima del periodo.', 9)
  y += 3

  const selezionate = i.raggruppamento === 'categoria' && i.categoriaId ? i.conteggio.righe.filter((r) => r.cassa_categoria_id === i.categoriaId) : i.conteggio.righe
  const generale = i.conteggio.righe.filter((r) => r.cassa_categoria_id === null)
  if (i.raggruppamento === 'categoria' && i.categoriaId) {
    const nome = i.categoriaNome ?? selezionate.find((r) => r.cassa_nome)?.cassa_nome ?? i.categoriaId
    testo(`Categoria selezionata: ${nome}`, 11, true)
    testo('Il filtro riguarda entrate e uscite contanti attribuite alla stessa cassa. La cassa generale è riportata separatamente, non inclusa nel totale della categoria.', 9)
  }

  const colonne = [CARTA.margineSx, 132, 160, CARTA.margineDx - 0.5]
  type RigaTabella = [string, number, number, number]
  const tabella = (titolo: string, intestazioni: [string, string, string, string], righe: RigaTabella[]) => {
    spazio(20)
    testo(titolo, 11, true)
    const testata = () => {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
      intestazioni.forEach((s, n) => doc.text(s, colonne[n], y, n ? { align: 'right' } : undefined))
      y += 2
      doc.setDrawColor(190)
      doc.line(CARTA.margineSx, y, CARTA.margineDx, y)
      y += 5
    }
    testata()
    for (const r of righe) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      const nome = doc.splitTextToSize(r[0], 78) as string[]
      for (const [n, riga] of nome.entries()) {
        if (spazio(0)) testata()
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(9)
        doc.text(riga, colonne[0], y)
        if (n === 0) for (let k = 1; k < 4; k++) doc.text(formatEuro(r[k] as number), colonne[k], y, { align: 'right' })
        y += 5
      }
      y += 1
    }
    if (!righe.length) testo('Nessun movimento nel periodo.', 9)
    y += 5
  }
  const riepilogo = (titolo: string, righe: RigaConteggio[]) => {
    const totali = somma(righe)
    spazio(43)
    testo(titolo, 11, true)
    for (const [etichetta, voce] of [['Entrate', 'entrate'], ['Uscite', 'uscite'], ['Prelievi / chiusure', 'prelievi'], ['Rettifiche', 'rettifiche'], ['Netto dei movimenti', 'netto']] as const) {
      testo(`${etichetta}: ${formatEuro(totali[voce])}`, 10, voce === 'netto')
    }
    y += 5
  }
  riepilogo('Riepilogo contanti della selezione', selezionate)
  if (i.raggruppamento === 'categoria') {
    const gruppi = new Map<string | null, RigaConteggio>()
    for (const r of selezionate) {
      const precedente = gruppi.get(r.cassa_categoria_id)
      gruppi.set(r.cassa_categoria_id, { ...r, ...somma(precedente ? [precedente, r] : [r]) })
    }
    const nomeFonte = (r: RigaConteggio) => {
      if (r.cassa_categoria_id === null) return 'Cassa generale (incluse uscite storiche)'
      const nome = r.cassa_nome ?? r.cassa_categoria_id
      const omonima = [...gruppi.values()].some((altra) => altra.cassa_categoria_id !== r.cassa_categoria_id && altra.cassa_nome === r.cassa_nome)
      if (!omonima) return nome
      const sediFonte = new Set(selezionate.filter((riga) => riga.cassa_categoria_id === r.cassa_categoria_id).map((riga) => riga.scuola_id))
      return `${nome} - ${i.sedi.filter((s) => sediFonte.has(s.id)).map((s) => s.nome).join(', ')}`
    }
    const dettaglioFonte = (r: RigaConteggio) => `${nomeFonte(r)}${r.prelievi || r.rettifiche ? `\nPrelievi: ${formatEuro(r.prelievi)}; rettifiche: ${formatEuro(r.rettifiche)}` : ''}`
    tabella('Casse di provenienza', ['Cassa / categoria', 'Entrate', 'Uscite', 'Netto'], [...gruppi.values()].map((r) => [dettaglioFonte(r), r.entrate, r.uscite, r.netto]))
    if (i.categoriaId) riepilogo('Cassa generale - separata dalla categoria', generale)
  }
  if (i.sedi.length > 1) {
    for (const sede of i.sedi) riepilogo(sede.nome, selezionate.filter((r) => r.scuola_id === sede.id))
  }
  const pagine = doc.getNumberOfPages()
  for (let p = 1; p <= pagine; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.text(`Pagina ${p} di ${pagine}`, CARTA.margineDx - 0.5, CARTA.rigaServizio, { align: 'right' })
  }
  return Buffer.from(doc.output('arraybuffer'))
}
