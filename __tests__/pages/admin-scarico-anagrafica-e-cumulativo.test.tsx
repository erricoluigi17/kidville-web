import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import itStudents from '../../messages/it/adminStudents.json'
import itModulistica from '../../messages/it/adminModulistica.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * NAT3f — L'EXPORT DELL'ANAGRAFICA (CSV) e IL PDF CUMULATIVO della modulistica passano
 * dall'helper unico. Prima: ancora cliccata a mano su un `blob:` (anagrafica) e `doc.save()`
 * di jsPDF (cumulativo) — nella WebView dell'app nessuno dei due scaricava niente, e
 * TUTTI E DUE mostravano lo stesso il toast di successo.
 *
 * Rosso senza la modifica:
 *  · l'helper riceve il Blob del CSV (col BOM e le righe dell'elenco filtrato) / il Blob di
 *    `doc.output('blob')`, e `doc.save` NON si chiama;
 *  · il toast segue l'ESITO: con un file non consegnato dice l'errore, non «Esportati».
 *
 * ⚠️ Nessun nome vero nei dati di prova: il repository è pubblico.
 */

const h = vi.hoisted(() => ({
  scarica: vi.fn(),
  query: '',
  save: vi.fn(),
  output: vi.fn(),
}))

vi.mock('@/lib/native/scarica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/native/scarica')>()),
  scaricaDocumento: h.scarica,
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.query),
  useParams: () => ({}),
  usePathname: () => '/admin',
}))
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    selezionate: [],
    effettive: [SEDE_A],
    sedeCorrente: SEDE_A,
    reFetchKey: SEDE_A,
    epocaSede: 0,
    errore: false,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
  SedeNotice: () => null,
}))
// Il jsPDF finto registra ciò che conta: `save` (la strada vecchia) e `output` (la nuova).
vi.mock('jspdf', () => ({
  jsPDF: class {
    setFont() {}
    setFontSize() {}
    text() {}
    setDrawColor() {}
    setLineWidth() {}
    line() {}
    addPage() {}
    setTextColor() {}
    save = h.save
    output = h.output
  },
}))
// I pannelli delle altre linguette della modulistica non sono sotto esame.
vi.mock('@/components/features/admin/iscrizioni/ModuliInviabili', () => ({ ModuliInviabili: () => null }))
vi.mock('@/components/features/admin/iscrizioni/ModuliRicevuti', () => ({ ModuliRicevuti: () => null }))
vi.mock('@/components/features/admin/iscrizioni/ElencoClassi', () => ({ ElencoClassi: () => null }))
vi.mock('@/components/features/admin/iscrizioni/RinviaCredenziali', () => ({ RinviaCredenziali: () => null }))
vi.mock('@/components/features/admin/iscrizioni/CandidatureInsegnanti', () => ({ CandidatureInsegnanti: () => null }))
vi.mock('@/components/features/admin/personale/PratichePersonale', () => ({ PratichePersonale: () => null }))
vi.mock('@/components/features/prestampati/PrestampatiSegreteria', () => ({ PrestampatiSegreteria: () => null }))

const ALUNNO = {
  id: 'aaaa1111-0000-4000-8000-000000000001',
  nome: 'Prova', cognome: 'Alunno', codice_fiscale: 'AAAAAA00A00A000A',
  classe_sezione: 'TEST 3 ANNI', stato: 'iscritto',
}

const MODULO = {
  id: 'modulo-1',
  title: 'Uscita di prova',
  description: '',
  form_type: 'autorizzazione',
  fields: [],
  target_scope: 'class' as const,
  target_classes: ['PRIMAVERA A'],
  expiration_date: null,
  created_at: '2026-01-15T10:00:00Z',
  sempre_firmabile: false,
}

function fetchFinto(input: RequestInfo | URL) {
  const u = new URL(String(input), 'http://t.test')
  const p = u.pathname
  const ok = (corpo: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => corpo })
  if (p.includes('/api/admin/sections/scoped')) return ok({ success: true, data: [] })
  if (p.includes('/api/admin/sections')) return ok([{ id: 's1', name: 'PRIMAVERA A' }])
  if (p.includes('/api/admin/gruppi-mensa')) return ok({ success: true, data: [] })
  if (p.includes('/api/admin/students')) return ok(u.searchParams.get('scuola_id') ? [] : [ALUNNO])
  if (p.includes('/api/admin/documents-merge')) {
    return ok({ results: [{ nome_alunno: 'Prova', cognome_alunno: 'Alunno', signed: false }] })
  }
  if (p.includes('/api/admin/forms')) return ok([MODULO])
  return ok({})
}

/** Il testo di un Blob col `FileReader` di jsdom. `readAsText` toglie il BOM in lettura. */
function testoDi(blob: Blob): Promise<string> {
  return new Promise((risolvi, rifiuta) => {
    const lettore = new FileReader()
    lettore.onerror = () => rifiuta(lettore.error)
    lettore.onload = () => risolvi(String(lettore.result))
    lettore.readAsText(blob)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.query = ''
  h.scarica.mockResolvedValue({ esito: 'web-blob' })
  h.output.mockImplementation(() => new Blob(['%PDF-finto'], { type: 'application/pdf' }))
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import AdminStudentsPage from '@/app/(dashboard)/admin/students/page'
import AdminModulisticaPage from '@/app/(dashboard)/admin/modulistica/page'

describe('Anagrafica — «Esporta» passa il CSV all’helper', () => {
  async function esporta() {
    h.query = 'tab=child'
    render(<AdminStudentsPage />)
    // Si aspetta la RIGA dell'alunno (la sua classe), non una parola che compare anche nei titoli.
    await waitFor(() => expect(screen.getAllByText('TEST 3 ANNI').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${itStudents.azioneEsporta}$`, 'i') }))
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    return h.scarica.mock.calls[0][0]
  }

  it('il Blob porta intestazioni e righe dell’elenco, col BOM; nome, mime ed etichetta', async () => {
    const arg = await esporta()
    expect(arg.sorgente).toBeInstanceOf(Blob)
    const testo = await testoDi(arg.sorgente)
    expect(testo.split('\n')[0]).toBe(
      [itStudents.csvCognome, itStudents.csvNome, itStudents.csvCodiceFiscale, itStudents.csvClasse, itStudents.csvStato].join(','),
    )
    expect(testo).toContain('Alunno,Prova,AAAAAA00A00A000A,TEST 3 ANNI,iscritto')
    // Il BOM c'è (Excel lo vuole per gli accenti): `readAsText` lo toglie, la dimensione lo conta.
    expect(arg.sorgente.size).toBe(new Blob(['﻿' + testo]).size)
    expect(arg.nomeFile).toMatch(/^anagrafica-child-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(arg).toMatchObject({ mime: 'text/csv', etichetta: 'anagrafica-export' })
    expect(await screen.findByText(/Esportato 1 record in CSV/)).toBeInTheDocument()
  })

  it('un file non consegnato NON dice «Esportato»: dice che non è riuscito', async () => {
    h.scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' })
    await esporta()
    expect(await screen.findByText(new RegExp(itStudents.toastExportNonRiuscito))).toBeInTheDocument()
    expect(screen.queryByText(/Esportato 1 record in CSV/)).toBeNull()
  })
})

describe('Modulistica — il PDF cumulativo di una classe', () => {
  async function esportaCumulativo() {
    h.query = 'tab=moduli-genitori'
    window.history.replaceState(null, '', '/admin/modulistica?tab=moduli-genitori')
    render(<AdminModulisticaPage />)
    const bottone = await screen.findByRole('button', { name: /Merge PRIMAVERA A/ })
    fireEvent.click(bottone)
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(1))
    return h.scarica.mock.calls[0][0]
  }

  it('il Blob di `output(\'blob\')` va all’helper; `doc.save` non si chiama più', async () => {
    const arg = await esportaCumulativo()
    expect(h.output).toHaveBeenCalledWith('blob')
    expect(h.save).not.toHaveBeenCalled()
    expect(arg.sorgente).toBe(h.output.mock.results[0].value)
    expect(arg).toMatchObject({
      nomeFile: 'Cumulative_Uscita_di_prova_PRIMAVERA A.pdf',
      mime: 'application/pdf',
      etichetta: 'modulistica-cumulativo',
    })
    expect(await screen.findByText(itModulistica.modToastReportScaricato)).toBeInTheDocument()
  })

  it('un file non consegnato non dice «scaricato»', async () => {
    h.scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' })
    await esportaCumulativo()
    expect(await screen.findByText(new RegExp(itModulistica.modErroreEsportazione))).toBeInTheDocument()
    expect(screen.queryByText(itModulistica.modToastReportScaricato)).toBeNull()
  })
})
