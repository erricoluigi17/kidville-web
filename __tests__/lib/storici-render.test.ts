// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }))
import { creaExcelStorico, creaPdfStorico } from '@/lib/storici/render'
import type { DocumentoStorico } from '@/lib/storici/tipi'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
const documento: DocumentoStorico = { titolo: 'Classe di prova', scuolaNome: 'Scuola di prova', dal: '2026-09-01', al: '2026-10-15', generatoIl: '2026-10-15T12:00:00Z', avvisi: [], sezioni: [{ categoria: 'diario_note', titolo: 'Note individuali e di sezione', colonne: [{ chiave: 'data', titolo: 'Data' }, { chiave: 'nota', titolo: 'Nota' }], righe: [{ data: '15/10/2026', nota: '=1+2' }], allegati: [], avvisi: [] }] }
describe('file degli storici', () => {
  it('produce un vero Excel e conserva il testo libero senza formule eseguibili', () => {
    const bytes = creaExcelStorico(documento)
    const wb = XLSX.read(bytes, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[1]]
    expect(ws.B2.v).toBe('=1+2')
    expect(ws.B2.t).toBe('s')
    expect(ws.B2.f).toBeUndefined()
  })
  it('impagina testi lunghi su più pagine e dichiara originali mancanti', async () => {
    const copia = structuredClone(documento)
    copia.sezioni[0].righe = Array.from({ length: 90 }, () => ({ data: '15/10/2026', nota: 'Una nota lunga con accenti: attività, perché, città. '.repeat(12) }))
    copia.sezioni[0].allegati = [{ bucket: 'sensitive_documents', percorso: 'prova/originale.pdf', nome: 'Originale mancante.pdf' }]
    const db = { storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'not found' } }) }) } } as unknown as SupabaseClient
    const r = await creaPdfStorico(copia, db)
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBeGreaterThan(4)
    expect(r.avvisi).toEqual(expect.arrayContaining([expect.stringContaining('Originale non incorporato')]))
    if (process.env.STORICI_PDF_VISIVO_DIR) {
      await mkdir(process.env.STORICI_PDF_VISIVO_DIR, { recursive: true })
      await writeFile(join(process.env.STORICI_PDF_VISIVO_DIR, 'diario-lungo.pdf'), r.bytes)
    }
  })
  it('incorpora il PDF generato da uno snapshot senza nuove emissioni', async () => {
    const originale = await PDFDocument.create(); originale.addPage()
    const copia = structuredClone(documento)
    copia.sezioni[0].generati = [{ nome: 'Ricevuta.pdf', mime: 'application/pdf', base64: Buffer.from(await originale.save()).toString('base64') }]
    const db = { storage: { from: vi.fn(() => { throw new Error('Non deve leggere storage') }) } } as unknown as SupabaseClient
    const r = await creaPdfStorico(copia, db)
    expect(r.avvisi).toHaveLength(0)
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBeGreaterThanOrEqual(4)
  })
  it('stampa un originale WebP conservando intatti i byte della fonte', async () => {
    const webp = await sharp({ create: { width: 100, height: 60, channels: 3, background: '#1b5a41' } }).webp().toBuffer()
    const prima = Buffer.from(webp)
    const copia = structuredClone(documento)
    copia.sezioni[0].allegati = [{ bucket: 'gallery', percorso: 'prova/immagine.webp', nome: 'Immagine.webp', mime: 'image/webp' }]
    const download = vi.fn(async () => ({ data: new Blob([new Uint8Array(webp)]), error: null }))
    const db = { storage: { from: () => ({ download }) } } as unknown as SupabaseClient
    const r = await creaPdfStorico(copia, db)
    expect(r.avvisi).toEqual([])
    expect(download).toHaveBeenCalledWith('prova/immagine.webp')
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(4)
    expect(webp).toEqual(prima)
  })
  it('rappresenta il video con una scheda stampabile senza tentare il download o dichiararlo mancante', async () => {
    const copia = structuredClone(documento)
    copia.sezioni[0].allegati = [{ bucket: 'gallery', percorso: 'prova/video.mp4', nome: 'Galleria-video-fittizio.mp4', mime: 'video/mp4' }]
    const download = vi.fn(() => { throw new Error('Il video non deve essere scaricato dal generatore PDF') })
    const db = { storage: { from: () => ({ download }) } } as unknown as SupabaseClient
    const r = await creaPdfStorico(copia, db)
    expect(download).not.toHaveBeenCalled()
    expect(r.avvisi).toEqual([])
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(4)
    if (process.env.STORICI_PDF_VISIVO_DIR) await writeFile(join(process.env.STORICI_PDF_VISIVO_DIR, 'video-riferimento.pdf'), r.bytes)
  })
  it('impagina una tabella oltre mille righe, un’immagine e un originale senza omissioni', async () => {
    const copia = structuredClone(documento)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
    copia.sezioni[0] = { categoria: 'presenze_registro', titolo: 'Presenze — oltre mille registrazioni', colonne: ['Alunno', 'Data', 'Stato', 'Entrata', 'Uscita', 'Note'].map((titolo, i) => ({ chiave: `c${i}`, titolo })), righe: Array.from({ length: 1254 }, (_, i) => ({ c0: `Alunno fittizio ${i + 1}`, c1: '15/10/2026', c2: 'Presente', c3: '08:30', c4: '16:00', c5: 'Attività didattiche regolari.' })), allegati: [], generati: [{ nome: 'Immagine stampabile.png', mime: 'image/png', base64: png }], avvisi: [] }
    const db = { storage: { from: vi.fn() } } as unknown as SupabaseClient
    const r = await creaPdfStorico(copia, db)
    expect(r.avvisi).toEqual([])
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBeGreaterThan(20)
    const wb = XLSX.read(creaExcelStorico(copia), { type: 'array' })
    expect(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]])).toHaveLength(1254)
    if (process.env.STORICI_PDF_VISIVO_DIR) await writeFile(join(process.env.STORICI_PDF_VISIVO_DIR, 'presenze-estese.pdf'), r.bytes)
  })
})
