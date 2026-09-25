import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import itAvvisi from '../../messages/it/avvisi.json'
import itSettings from '../../messages/it/adminSettings.json'
import itModulistica from '../../messages/it/adminModulistica.json'

/**
 * NAT3f — ADESIONI, ANAGRAFICHE (strumenti) ed ELENCO CLASSI: gli scarichi passano
 * dall'helper unico, e i Blob di XLSX ci arrivano INVECE di `XLSX.writeFile`.
 *
 * Cosa diventa rosso senza la modifica:
 *  · `EsportaAdesioni` cliccava un'ancora su un `blob:` → qui l'helper riceve il BLOB della
 *    risposta, col nome dall'header, e un esito non consegnato mostra l'errore;
 *  · `ImportExportClient` chiamava `XLSX.writeFile` (ancora interna di SheetJS) → qui
 *    `writeFile` NON si chiama, e all'helper arriva un Blob col mime di Excel costruito da
 *    `XLSX.write(…, { type: 'array' })`; il prestampato CSV arriva col suo contenuto vero;
 *  · `ElencoClassi` aveva un `<a href>` nudo → sul web resta tale, nell'app passa dall'helper.
 *
 * `fileConsegnato` è quello vero: l'esito finto cambia fra i casi.
 */

const h = vi.hoisted(() => ({
  scarica: vi.fn(),
  nativo: false,
  write: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('@/lib/native/scarica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/native/scarica')>()),
  scaricaDocumento: h.scarica,
}))
vi.mock('@/lib/push/native-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/native-register')>()),
  isNativeApp: () => h.nativo,
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: () => ({
    from: () => ({ select: async () => ({ data: [{ id: 'x', nome: 'Prova' }], error: null }) }),
  }),
}))
vi.mock('xlsx', () => ({
  utils: {
    json_to_sheet: () => ({}),
    book_new: () => ({}),
    book_append_sheet: () => undefined,
  },
  write: h.write,
  writeFile: h.writeFile,
}))

const SEDE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const AVVISO = 'dddddddd-4444-4444-8444-dddddddddddd'
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', nome: 'Sede di prova' }],
    selezionate: [],
    effettive: ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'],
    sedeCorrente: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    reFetchKey: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    epocaSede: 0,
    errore: false,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
  // L'import non è sotto esame qui: la sua scheda non si monta.
  SedeRequired: () => null,
}))

/** Il testo di un Blob, con il `FileReader` di jsdom (il `Blob` di jsdom non ha `text()` ovunque). */
function testoDi(blob: Blob): Promise<string> {
  return new Promise((risolvi, rifiuta) => {
    const lettore = new FileReader()
    lettore.onerror = () => rifiuta(lettore.error)
    lettore.onload = () => risolvi(String(lettore.result))
    lettore.readAsText(blob)
  })
}

let alertSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  h.nativo = false
  h.scarica.mockResolvedValue({ esito: 'web-blob' })
  h.write.mockReturnValue(new Uint8Array([80, 75, 3, 4]).buffer)
  alertSpy = vi.fn()
  vi.stubGlobal('alert', alertSpy)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import { EsportaAdesioni } from '@/components/features/avvisi/dettaglio/EsportaAdesioni'
import { ImportExportClient } from '@/components/features/admin/ImportExportClient'
import { ElencoClassi } from '@/components/features/admin/iscrizioni/ElencoClassi'
import { buildTemplateCsv } from '@/lib/import/template'

describe('EsportaAdesioni — il CSV del server passa all’helper come Blob', () => {
  function rispostaCsv() {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-disposition' ? 'attachment; filename="adesioni-prova.csv"' : null) },
      blob: async () => new Blob(['Alunno;Risposta\n'], { type: 'text/csv' }),
    })
  }

  it('Blob, nome dall’header, mime e etichetta; nessuna ancora del componente', async () => {
    vi.stubGlobal('fetch', vi.fn(rispostaCsv))
    const creaUrl = vi.fn(() => 'blob:finto')
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: creaUrl, revokeObjectURL: vi.fn() }))

    render(<EsportaAdesioni avvisoId={AVVISO} nAdesioni={3} />)
    fireEvent.click(screen.getByRole('button', { name: itAvvisi.esportaElenco }))

    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    const arg = h.scarica.mock.calls[0][0]
    expect(arg.sorgente).toBeInstanceOf(Blob)
    expect(await testoDi(arg.sorgente)).toBe('Alunno;Risposta\n')
    expect(arg).toMatchObject({ nomeFile: 'adesioni-prova.csv', mime: 'text/csv', etichetta: 'avviso-adesioni' })
    // L'ancora sul `blob:` del componente non c'è più: il gesto lo fa l'helper.
    expect(creaUrl).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('un file che non arriva (binario 1.0) mostra l’errore dell’esportazione', async () => {
    vi.stubGlobal('fetch', vi.fn(rispostaCsv))
    h.scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' })
    render(<EsportaAdesioni avvisoId={AVVISO} nAdesioni={3} />)
    fireEvent.click(screen.getByRole('button', { name: itAvvisi.esportaElenco }))
    expect(await screen.findByRole('alert')).toHaveTextContent(itAvvisi.esportaErrore)
  })

  it('una risposta d’errore del server non arriva all’helper (il controllo di `res.ok` resta qui)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 403 })))
    render(<EsportaAdesioni avvisoId={AVVISO} nAdesioni={3} />)
    fireEvent.click(screen.getByRole('button', { name: itAvvisi.esportaElenco }))
    expect(await screen.findByRole('alert')).toHaveTextContent(itAvvisi.esportaErrore)
    expect(h.scarica).not.toHaveBeenCalled()
  })
})

describe('ImportExportClient — l’XLSX degli alunni e il prestampato CSV', () => {
  it('l’export NON usa `XLSX.writeFile`: il Blob di `XLSX.write` va all’helper', async () => {
    render(<ImportExportClient />)
    fireEvent.click(screen.getByRole('button', { name: itSettings.ieGeneraEsportazione }))

    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    expect(h.writeFile).not.toHaveBeenCalled()
    expect(h.write).toHaveBeenCalledWith(expect.anything(), { type: 'array', bookType: 'xlsx' })
    const arg = h.scarica.mock.calls[0][0]
    expect(arg.sorgente).toBeInstanceOf(Blob)
    expect(arg.sorgente.type).toBe(MIME_XLSX)
    expect(arg.sorgente.size).toBe(4)
    expect(arg.nomeFile).toMatch(/^Esportazione_Alunni_\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(arg).toMatchObject({ mime: MIME_XLSX, etichetta: 'anagrafica-alunni-xlsx' })
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('un export che non arriva sul dispositivo si dice', async () => {
    h.scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' })
    render(<ImportExportClient />)
    fireEvent.click(screen.getByRole('button', { name: itSettings.ieGeneraEsportazione }))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(itSettings.ieErroreEsportazione))
  })

  it('il prestampato CSV arriva all’helper col suo contenuto, non un’ancora', async () => {
    render(<ImportExportClient />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itSettings.ieScaricaPrestampato) }))

    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    const arg = h.scarica.mock.calls[0][0]
    expect(arg).toMatchObject({
      nomeFile: 'prestampato_anagrafiche_kidville.csv',
      mime: 'text/csv',
      etichetta: 'anagrafica-prestampato-csv',
    })
    // `readAsText` toglie il BOM in lettura (lo prevede la decodifica UTF-8): il contenuto si
    // confronta senza, e il BOM si verifica sulla DIMENSIONE, che lo conta (3 byte).
    expect(await testoDi(arg.sorgente)).toBe(buildTemplateCsv().replace(/^﻿/, ''))
    expect(arg.sorgente.size).toBe(new Blob([buildTemplateCsv()]).size)
    expect(buildTemplateCsv().startsWith('﻿')).toBe(true)
    expect(alertSpy).not.toHaveBeenCalled()
  })
})

describe('ElencoClassi — «Scarica con gli esiti»', () => {
  const ELENCO = {
    id: 'el-1',
    scuolaId: SEDE_A,
    nomeFile: 'classi.xlsx',
    righeTotali: 2,
    caricatoIl: '2026-08-30T09:00:00Z',
    perClasse: [{ classe: 'PRIMAVERA A', alunni: 2 }],
    anomalie: [],
  }

  async function monta() {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ elenchi: [ELENCO] }) })))
    render(<ElencoClassi />)
    return screen.findByRole('link', { name: /Scarica con gli esiti/ })
  }

  it('sul WEB resta il link di sempre: nessun preventDefault, helper mai chiamato', async () => {
    const link = await monta()
    expect(link).toHaveAttribute('href', `/api/admin/iscrizioni/elenco/export?scuola_id=${SEDE_A}`)
    let prevenuto: boolean | null = null
    const osserva = (ev: Event) => {
      prevenuto = ev.defaultPrevented
      ev.preventDefault()
    }
    window.addEventListener('click', osserva)
    try {
      fireEvent.click(link)
    } finally {
      window.removeEventListener('click', osserva)
    }
    expect(prevenuto).toBe(false)
    expect(h.scarica).not.toHaveBeenCalled()
  })

  it('nell’APP il clic passa dall’helper con la sede nell’indirizzo e il nome della route', async () => {
    h.nativo = true
    const link = await monta()
    expect(fireEvent.click(link)).toBe(false)
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    const arg = h.scarica.mock.calls[0][0]
    expect(arg).toMatchObject({
      sorgente: `/api/admin/iscrizioni/elenco/export?scuola_id=${SEDE_A}`,
      mime: MIME_XLSX,
      etichetta: 'elenco-classi-esiti',
    })
    // Mai il nome del file caricato (porta plesso e anno): quello che dà la route.
    expect(arg.nomeFile).toMatch(/^elenco-classi-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(screen.queryByText(itModulistica.scaricoNonRiuscito)).toBeNull()
  })

  it('nell’APP un file non arrivato si dice nel riquadro d’errore', async () => {
    h.nativo = true
    h.scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-500' })
    const link = await monta()
    fireEvent.click(link)
    expect(await screen.findByText(itModulistica.scaricoNonRiuscito)).toBeInTheDocument()
  })
})
