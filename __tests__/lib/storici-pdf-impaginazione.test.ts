// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { getDocumentProxy } from 'unpdf'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }))
import { creaExcelStorico, creaPdfStorico } from '@/lib/storici/render'
import { CARTA, fasceVietate } from '@/lib/carta/geometria'
import type { DocumentoStorico, SezioneStorico } from '@/lib/storici/tipi'

const MM = 72 / 25.4
const db = { storage: { from: vi.fn() } } as unknown as SupabaseClient
const base = (sezione: SezioneStorico): DocumentoStorico => ({ titolo: 'Dossier sintetico', scuolaNome: 'Scuola di prova', dal: '2026-09-01', al: '2026-10-15', generatoIl: '2026-10-15T12:00:00Z', avvisi: [], sezioni: [sezione] })
async function leggi(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(bytes.slice())
  return await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => {
      const pagina = await pdf.getPage(i + 1)
      const { width, height } = pagina.getViewport({ scale: 1 })
      const contenuto = await pagina.getTextContent()
      const items = contenuto.items.filter(i => 'str' in i).filter(i => !!i.str.trim())
      return { width, height, items, testo: items.map(i => i.str).join(' ').replace(/\s+/g, ' ') }
  }))
}
async function salva(nome: string, bytes: Uint8Array) {
  if (!process.env.STORICI_PDF_VISIVO_DIR) return
  await mkdir(process.env.STORICI_PDF_VISIVO_DIR, { recursive: true })
  await writeFile(join(process.env.STORICI_PDF_VISIVO_DIR, nome), bytes)
}
const presenze: SezioneStorico = {
  categoria: 'presenze_registro', titolo: 'Presenze sintetiche', avvisi: [], allegati: [],
  colonne: ['Alunno', 'Data', 'Stato', 'Entrata', 'Uscita', 'Note'].map((titolo, i) => ({ chiave: `c${i}`, titolo })),
  righe: Array.from({ length: 90 }, (_, i) => ({ c0: `Alunno sintetico ${i + 1}`, c1: '2026-10-15', c2: 'Presente', c3: '08:30', c4: '16:00', c5: 'Attività regolare' })),
}
const argomento = Array.from({ length: 90 }, (_, i) => `Passaggio${i + 1} della lezione con attività e osservazioni.`).join(' ')
const lezione: SezioneStorico = {
  categoria: 'primaria_registro', titolo: 'Registro delle lezioni sintetico', avvisi: [], allegati: [],
  colonne: Object.entries({ data: 'Data', alunno: 'Alunno', classe: 'Classe', ora: 'Ora', materia: 'Materia', ambito: 'Destinazione', argomento: 'Argomento', compiti: 'Compiti', consegna: 'Consegna', docente: 'Docente', tipoFirma: 'Tipo firma', firmatoIl: 'Firmato il', allegati: 'Allegati', richiedeFirma: 'Richiede firma' }).map(([chiave, titolo]) => ({ chiave, titolo })),
  righe: [{ _ambito: 'classe', _registro_id: 'registro-sintetico', data: '2026-10-15', alunno: '', classe: 'Terza A', ora: 2, materia: 'Italiano', ambito: 'Classe', argomento, compiti: 'Leggere le pagine indicate e annotare le parole nuove.', consegna: '2026-10-19', docente: 'Docente sintetico', tipoFirma: 'Compresenza', firmatoIl: '2026-10-15T12:30:00Z', allegati: 'Esercitazione-sintetica.pdf', richiedeFirma: false }],
}

describe('impaginazione leggibile PDF storici', () => {
  it('stampa le tabelle su A4 orizzontale con intestazioni ripetute e titolo singolo', async () => {
    const { bytes } = await creaPdfStorico(base(presenze), db)
    const dimensioni = (await PDFDocument.load(bytes)).getPages().map(p => p.getSize())
    const pagine = await leggi(bytes)
    expect(dimensioni[0].width).toBeCloseTo(210 * MM, 1)
    const tabelle = pagine.filter(p => p.testo.includes('Alunno sintetico'))
    expect(tabelle.length).toBeGreaterThan(1)
    for (const pagina of tabelle) {
      expect(pagina.width).toBeCloseTo(297 * MM, 1)
      expect(pagina.height).toBeCloseTo(210 * MM, 1)
      expect(pagina.testo.match(/Presenze sintetiche/g)).toHaveLength(1)
      for (const titolo of ['Alunno', 'Data', 'Stato', 'Entrata', 'Uscita', 'Note']) expect(pagina.items.some(i => i.str === titolo)).toBe(true)
    }
    expect(pagine.map(p => p.testo).join(' ')).toContain('Alunno sintetico 90')
    await salva('presenze-landscape-sintetiche.pdf', bytes)
  })

  it('rende lezioni e diario come schede con testo a larghezza piena e tutti i metadati', async () => {
    const documento = base(lezione)
    documento.sezioni.push({ categoria: 'diario_note', titolo: 'Diario sintetico', colonne: [{ chiave: 'data', titolo: 'Data' }, { chiave: 'nota', titolo: 'Nota' }, { chiave: 'firmata', titolo: 'Firmata' }], righe: [{ data: '2026-10-14', nota: 'Una nota integrale con accenti: attività, perché, città. '.repeat(30), firmata: true }], allegati: [], avvisi: [] })
    const { bytes } = await creaPdfStorico(documento, db)
    const pagine = await leggi(bytes)
    const tutto = pagine.map(p => p.testo).join(' ')
    for (let i = 1; i <= 90; i++) expect(tutto).toContain(`Passaggio${i} della lezione`)
    for (const valore of ['Terza A', 'Italiano', 'Classe', '19/10/2026', 'Docente sintetico', 'Compresenza', '15/10/2026, 14:30', 'Esercitazione-sintetica.pdf', 'Richiede firma', 'No', 'Firmata', 'Sì']) expect(tutto).toContain(valore)
    expect(tutto).not.toContain('2026-10-15T')
    const corpo = pagine.flatMap(p => p.items).filter(i => i.str.includes('Passaggio'))
    expect(Math.max(...corpo.map(i => i.width))).toBeGreaterThan(140 * MM)
    for (const p of pagine.filter(p => p.items.some(i => i.str.includes('Passaggio')))) expect(p.width).toBeLessThan(p.height)
    await salva('lezione-13-colonne-diario-sintetici.pdf', bytes)
    await salva('registro-lezioni.xlsx', await creaExcelStorico(documento))
  })

  it('mantiene corpo almeno 10 pt e inchiostro e numerazione nelle aree sicure della carta', async () => {
    const { bytes } = await creaPdfStorico(base(presenze), db)
    const pagine = await leggi(bytes)
    for (const p of pagine) {
      const orizzontale = p.width > p.height
      const { marchio, piede } = fasceVietate(297, 210)
      const sx = orizzontale ? marchio.sinistra + marchio.larghezza + 4 : CARTA.margineSx
      const dx = orizzontale ? piede.sinistra - 4 : CARTA.margineDx
      for (const item of p.items) {
        const footer = /^\d+ \/ \d+$/.test(item.str)
        const corpo = Math.hypot(item.transform[0], item.transform[1])
        if (!footer) expect(corpo).toBeGreaterThanOrEqual(10)
        expect(item.transform[4] / MM).toBeGreaterThanOrEqual(sx - .2)
        expect((item.transform[4] + item.width) / MM).toBeLessThanOrEqual(dx + .2)
        const y = (p.height - item.transform[5]) / MM
        if (footer) expect(y).toBeCloseTo(orizzontale ? 201 : CARTA.rigaServizio, 1)
        else expect(y).toBeLessThanOrEqual(orizzontale ? 195 : CARTA.contenutoFine)
      }
    }
  })

  it('conserva le colonne larghe nei dettagli e rende italiane anche le date multiple delle firme', async () => {
    const sezione: SezioneStorico = {
      categoria: 'documenti_consensi', titolo: 'Consensi sintetici', allegati: [], avvisi: [],
      colonne: Object.entries({ alunno: 'Alunno', tipo: 'Tipo', versione: 'Versione', data: 'Data', confermato: 'Confermato', stato: 'Stato', fonte: 'Fonte', firmatario: 'Firmatario', firme: 'Prese visione', testo: 'Testo conservato' }).map(([chiave, titolo]) => ({ chiave, titolo })),
      righe: [{ alunno: 'Alunno sintetico', tipo: 'Consenso', versione: 3, data: '2026-10-15', confermato: true, stato: 'Attivo', fonte: 'Portale', firmatario: 'Tutore sintetico', firme: '2026-10-15T12:30:00Z; 2026-10-16T09:15:00Z', testo: 'CONTENUTO INTEGRALE '.repeat(80) + 'FINE DEL CONSENSO' }],
    }
    const { bytes } = await creaPdfStorico(base(sezione), db)
    const pagine = await leggi(bytes)
    const tutto = pagine.map(p => p.testo).join(' ')
    expect(pagine.some(p => p.width > p.height && p.testo.includes('Alunno sintetico'))).toBe(true)
    for (const valore of ['Tutore sintetico', 'Prese visione', '15/10/2026, 14:30; 16/10/2026, 11:15', 'Testo conservato', 'FINE DEL CONSENSO', 'Sì']) expect(tutto).toContain(valore)
    expect((tutto.match(/CONTENUTO INTEGRALE/g) ?? []).length).toBe(80)
    await salva('consensi-larghi-sintetici.pdf', bytes)
  })

  it('preserva dimensioni e contenuto degli originali e numera anche pagine di formato ridotto dentro il foglio', async () => {
    const originale = await PDFDocument.create()
    originale.addPage([300, 200]).drawText('CONTENUTO ORIGINALE', { x: 30, y: 150, size: 14 })
    const copia = base({ ...lezione, righe: [], generati: [{ nome: 'Originale-sintetico.pdf', mime: 'application/pdf', base64: Buffer.from(await originale.save()).toString('base64') }] })
    const { bytes } = await creaPdfStorico(copia, db)
    const pagine = await leggi(bytes)
    const allegato = pagine.find(p => p.testo.includes('CONTENUTO ORIGINALE'))!
    expect(allegato.width).toBe(300)
    expect(allegato.height).toBe(200)
    const contenuto = allegato.items.find(i => i.str === 'CONTENUTO ORIGINALE')!
    expect(contenuto.transform[4]).toBe(30)
    expect(contenuto.transform[5]).toBe(150)
    const numero = allegato.items.find(i => /^\d+ \/ \d+$/.test(i.str))!
    expect(numero).toBeDefined()
    expect(numero.transform[4]).toBeGreaterThan(0)
    expect(numero.transform[4] + numero.width).toBeLessThan(allegato.width)
    expect(numero.transform[5]).toBeGreaterThan(0)
    expect(numero.transform[5]).toBeLessThan(allegato.height)
    expect(pagine.map(p => p.testo).join(' ')).toContain('Nessuna registrazione tabellare')
  })
})
