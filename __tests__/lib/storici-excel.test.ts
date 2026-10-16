// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import type { DocumentoStorico } from '@/lib/storici/tipi'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }))
import { creaExcelStorico } from '@/lib/storici/render'

const documento: DocumentoStorico = {
  titolo: 'Classe di prova', scuolaNome: 'Sede fittizia', dal: '2026-09-01', al: '2026-10-16', generatoIl: '2026-10-16T10:00:00Z', avvisi: [],
  sezioni: [{ categoria: 'primaria_registro', titolo: 'Registro delle lezioni',
    colonne: [{ chiave: 'data', titolo: 'Data' }, { chiave: 'ora', titolo: 'Ora' }, { chiave: 'argomento', titolo: 'Argomento' }, { chiave: 'compiti', titolo: 'Compiti' }],
    righe: [{ data: '2026-10-16', ora: 2, argomento: 'Attività con parole e accenti. '.repeat(40), compiti: '=1+2' }], allegati: [], avvisi: [] }],
}

describe('Excel degli storici leggibile', () => {
  it('salva stili, testo a capo, righe dimensionate, filtri e intestazione fissa nel file effettivo', async () => {
    const bytes = await creaExcelStorico(documento)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer)
    const ws = wb.worksheets[1]
    expect(ws.getCell('A1').font?.bold).toBe(true)
    expect(ws.getCell('C2').font.size).toBeGreaterThanOrEqual(11)
    expect(ws.getCell('C2').alignment).toMatchObject({ wrapText: true, vertical: 'top' })
    expect(ws.getColumn(3).width).toBeGreaterThan(ws.getColumn(2).width!)
    expect(ws.getRow(2).height).toBeGreaterThan(40)
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(ws.autoFilter).toBeTruthy()
    expect(ws.pageSetup).toMatchObject({ paperSize: 9, orientation: 'landscape', fitToWidth: 0, fitToHeight: 0, printTitlesRow: '1:1' })
  })

  it('conserva date e numeri tipizzati e non esegue formule provenienti dal testo', async () => {
    const bytes = await creaExcelStorico(documento)
    const wb = XLSX.read(bytes, { type: 'array', cellNF: true })
    const ws = wb.Sheets[wb.SheetNames[1]]
    expect(ws.A2.t).toBe('n')
    expect(XLSX.SSF.parse_date_code(ws.A2.v)).toMatchObject({ y: 2026, m: 10, d: 16 })
    expect(ws.A2.z).toBe('dd/mm/yyyy')
    expect(ws.B2).toMatchObject({ t: 'n', v: 2 })
    expect(XLSX.utils.sheet_to_json<{ Argomento: string }>(ws).map(r => r.Argomento ?? '').join('')).toBe(documento.sezioni[0].righe[0].argomento)
    expect(ws.D2).toMatchObject({ t: 's', v: '=1+2' })
    expect(ws.D2.f).toBeUndefined()
  })

  it('rende leggibile il testo oltre il limite di altezza Excel senza ripetere gli importi', async () => {
    const copia = structuredClone(documento)
    const lungo = ('Prima riga con spazi.\nSeconda riga molto lunga ' + 'Parole '.repeat(45) + '\n').repeat(25)
    copia.sezioni[0].colonne.push({ chiave: 'importo', titolo: 'Importo' })
    copia.sezioni[0].righe = [{ data: '2026-10-16', ora: 2, argomento: lungo, compiti: '=1+2', importo: 125.50 }]
    const bytes = await creaExcelStorico(copia)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer)
    const ws = wb.worksheets[1]
    const intestazioni = ws.getRow(1).values as string[]
    expect(intestazioni).toContain('Record')
    expect(intestazioni).toContain('Parte')
    expect(ws.rowCount).toBeGreaterThan(2)
    let ricomposto = ''
    let importi = 0
    ws.eachRow((riga, i) => {
      if (i === 1) return
      ricomposto += String(riga.getCell(3).value ?? '')
      if (riga.getCell(5).value !== null) importi++
      expect(riga.height).toBeLessThanOrEqual(409)
      expect(riga.getCell(6).value).toBe(1)
    })
    expect(ricomposto).toBe(lungo)
    expect(importi).toBe(1)
    expect(ws.getCell('E2').value).toBe(125.50)
  })

  it('dimensiona le continuazioni anche per caratteri larghi e mantiene il riepilogo sulla larghezza A4', async () => {
    const copia = structuredClone(documento)
    copia.sezioni[0].righe[0].argomento = 'W'.repeat(100) + '\n' + ('W'.repeat(46) + '\n').repeat(80)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await creaExcelStorico(copia) as unknown as ExcelJS.Buffer)
    const riepilogo = wb.worksheets[0]
    // 95 caratteri standard entrano nell'area stampabile A4 verticale a 100%.
    expect(riepilogo.columns.reduce((sum, col) => sum + (col.width ?? 0), 0)).toBeLessThanOrEqual(95)
    wb.worksheets[1].eachRow((riga, i) => {
      if (i === 1) return
      const testo = String(riga.getCell(3).value ?? '')
      // Su una colonna64, i glifi W del carattere11 richiedono almeno2 righe ogni46.
      const linee = testo.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 33)), 0)
      expect(riga.height).toBeGreaterThanOrEqual(linee * 14)
    })
  })
})
