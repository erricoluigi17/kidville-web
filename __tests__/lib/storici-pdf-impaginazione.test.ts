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
  // Valori che cambiano da riga a riga: una colonna tutta uguale salirebbe in testata e
  // l'intestazione ripetuta non misurerebbe più niente.
  righe: Array.from({ length: 90 }, (_, i) => ({ c0: `Alunno sintetico ${i + 1}`, c1: i % 2 ? '2026-10-15' : '2026-10-16', c2: i % 3 ? 'Presente' : 'Assente',
    c3: i % 3 ? '08:30' : '', c4: i % 3 ? `16:0${i % 10}` : '', c5: i % 3 ? 'Attività regolare' : 'Giustificata' })),
}
const argomento = Array.from({ length: 90 }, (_, i) => `Passaggio${i + 1} della lezione con attività e osservazioni.`).join(' ')
const lezione: SezioneStorico = {
  categoria: 'primaria_registro', titolo: 'Registro delle lezioni sintetico', avvisi: [], allegati: [],
  colonne: Object.entries({ data: 'Data', alunno: 'Alunno', classe: 'Classe', ora: 'Ora', materia: 'Materia', ambito: 'Destinazione', argomento: 'Argomento', compiti: 'Compiti', consegna: 'Consegna', docente: 'Docente', tipoFirma: 'Tipo firma', firmatoIl: 'Firmato il', allegati: 'Allegati', richiedeFirma: 'Richiede firma' }).map(([chiave, titolo]) => ({ chiave, titolo })),
  righe: [{ _ambito: 'classe', _registro_id: 'registro-sintetico', data: '2026-10-15', alunno: '', classe: 'Terza A', ora: 2, materia: 'Italiano', ambito: 'Classe', argomento, compiti: 'Leggere le pagine indicate e annotare le parole nuove.', consegna: '2026-10-19', docente: 'Docente sintetico', tipoFirma: 'Compresenza', firmatoIl: '2026-10-15T12:30:00Z', allegati: 'Esercitazione-sintetica.pdf', richiedeFirma: false }],
}

function nelleAreeSicure(pagine: Awaited<ReturnType<typeof leggi>>) {
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
}
const giorni = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
const materie = ['Italiano', 'Matematica', 'Storia', 'Inglese', 'Scienze']
const registroDiClasse: SezioneStorico = { ...lezione, titolo: 'Registro di classe sintetico',
  righe: giorni.flatMap(data => materie.map((materia, i) => ({ _ambito: 'classe', data, alunno: '', classe: 'Terza A', ora: i + 1, materia, ambito: 'Classe',
    argomento: `Lettura e comprensione del brano di ${materia.toLowerCase()}, discussione guidata in classe.`, compiti: i % 2 ? 'Esercizi pag. 42 n. 1-5' : '',
    consegna: i % 2 ? '2026-10-19' : '', docente: 'Docente sintetico', tipoFirma: '', firmatoIl: '', allegati: '', richiedeFirma: false }))) }

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

  it('rende lezione e diario in tabella con testo integro e tutti i metadati', async () => {
    const documento = base(lezione)
    documento.sezioni.push({ categoria: 'diario_note', titolo: 'Diario sintetico', colonne: [{ chiave: 'data', titolo: 'Data' }, { chiave: 'nota', titolo: 'Nota' }, { chiave: 'firmata', titolo: 'Firmata' }], righe: [{ data: '2026-10-14', nota: 'Una nota integrale con accenti: attività, perché, città. '.repeat(30), firmata: true }], allegati: [], avvisi: [] })
    const { bytes } = await creaPdfStorico(documento, db)
    const pagine = await leggi(bytes)
    const tutto = pagine.map(p => p.testo).join(' ')
    for (let i = 1; i <= 90; i++) expect(tutto).toContain(`Passaggio${i} della lezione`)
    for (const valore of ['Terza A', 'Italiano', 'Classe', '19/10/2026', 'Docente sintetico', 'Compresenza', '15/10/2026, 14:30', 'Esercitazione-sintetica.pdf', 'Richiede firma', 'No', 'Firmata', 'Sì']) expect(tutto).toContain(valore)
    expect(tutto).not.toContain('2026-10-15T')
    expect(tutto).not.toMatch(/Registrazione \d/)
    expect(tutto).toContain('Giovedì 15 ottobre 2026')
    // Dodici colonne in tabella: l'argomento resta la colonna che prende lo spazio.
    const corpo = pagine.flatMap(p => p.items).filter(i => i.str.includes('Passaggio'))
    expect(Math.max(...corpo.map(i => i.width))).toBeGreaterThan(60 * MM)
    await salva('lezione-13-colonne-diario-sintetici.pdf', bytes)
    await salva('registro-lezioni.xlsx', await creaExcelStorico(documento))
  })

  it('mantiene corpo almeno 10 pt e inchiostro e numerazione nelle aree sicure della carta', async () => {
    const { bytes } = await creaPdfStorico(base(presenze), db)
    nelleAreeSicure(await leggi(bytes))
  })

  it('impagina il registro di classe per giorno: poche pagine, niente colonne vuote, valori comuni in testata', async () => {
    const { bytes } = await creaPdfStorico(base(registroDiClasse), db)
    const pagine = await leggi(bytes)
    const tutto = pagine.map(p => p.testo).join(' ')
    // Con le schede «Registrazione N» le stesse 50 lezioni occupavano 34 pagine.
    expect(pagine.length).toBeLessThanOrEqual(8)
    expect(tutto).not.toMatch(/Registrazione \d/)
    for (const titolo of ['Tipo firma', 'Firmato il', 'Alunno', 'Allegati']) expect(pagine.flatMap(p => p.items).some(i => i.str === titolo)).toBe(false)
    expect(tutto.match(/Classe: Terza A/g)).toHaveLength(1)
    for (const g of ['Lunedì 5 ottobre 2026', 'Venerdì 16 ottobre 2026']) expect(tutto).toContain(g)
    expect((tutto.match(/Lettura e comprensione del brano/g) ?? []).length).toBe(50)
    nelleAreeSicure(pagine)
    await salva('registro-di-classe-per-giorno.pdf', bytes)
  })

  it('stampa una volta per giorno la nota di sezione e fuori dalla tabella', async () => {
    const diario: SezioneStorico = { categoria: 'diario_attivita', titolo: 'Attività sintetiche', allegati: [], avvisi: [],
      colonne: Object.entries({ data: 'Data', alunno: 'Alunno', tipo: 'Voce', inizio: 'Inizio', fine: 'Fine', dettaglio: 'Dettaglio', valore: 'Valore registrato', notaIndividuale: 'Nota individuale', autore: 'Registrato da' }).map(([chiave, titolo]) => ({ chiave, titolo })),
      righe: giorni.flatMap(data => [
        { _ambito: 'classe', _nota_giorno: true, data, alunno: '', tipo: 'Nota di sezione', dettaglio: `Nota del ${data}`, autore: 'Educatrice sintetica' },
        ...['Pittura con le dita', 'Canzoni in cerchio'].map((tipo, i) => ({ _ambito: 'classe', data, alunno: '', tipo, inizio: i ? '11:00' : '10:00', fine: i ? '11:30' : '10:45',
          dettaglio: `${tipo}: colori e suoni`, valore: 'Ha partecipato: 15 bambini · Con entusiasmo: Alunno uno, Alunno due', notaIndividuale: '', autore: 'Educatrice sintetica' })),
      ]) }
    const { bytes } = await creaPdfStorico(base(diario), db)
    const pagine = await leggi(bytes)
    const tutto = pagine.map(p => p.testo).join(' ')
    for (const data of giorni) expect(tutto.split(`Nota del ${data}`)).toHaveLength(2)
    expect(tutto.match(/Registrato da: Educatrice sintetica/g)).toHaveLength(1)
    expect(pagine.flatMap(p => p.items).some(i => i.str === 'Orario')).toBe(true)
    expect((tutto.match(/Pittura con le dita: colori e suoni/g) ?? []).length).toBe(10)
    expect(pagine.length).toBeLessThanOrEqual(8)
    nelleAreeSicure(pagine)
    await salva('diario-attivita-per-giorno.pdf', bytes)
  })

  it('su un giorno che continua al foglio dopo ripete titolo del giorno e intestazione', async () => {
    const lungo: SezioneStorico = { ...registroDiClasse, righe: Array.from({ length: 40 }, (_, i) => ({ ...registroDiClasse.righe[i % 5], data: '2026-10-05', ora: i + 1, argomento: `${argomento.slice(0, 600)} ${i}` })) }
    const pagine = await leggi((await creaPdfStorico(base(lungo), db)).bytes)
    const continua = pagine.filter(p => p.testo.includes('Lunedì 5 ottobre 2026 (continua)'))
    expect(continua.length).toBeGreaterThan(0)
    for (const p of continua) for (const titolo of ['Ora', 'Materia', 'Argomento']) expect(p.items.some(i => i.str === titolo)).toBe(true)
    nelleAreeSicure(pagine)
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
