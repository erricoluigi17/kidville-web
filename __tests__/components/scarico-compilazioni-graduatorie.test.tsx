import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import itModulistica from '../../messages/it/adminModulistica.json'
import type { SubmissionRow } from '@/components/features/admin/forms/submissions/SubmissionDetailSidebar'

/**
 * NAT3f — COMPILAZIONI E GRADUATORIE: gli scarichi passano dall'helper unico.
 *
 * Prima: `<a download href="/api/forms/export/…">` cliccata a mano (compilazioni) e un
 * `<a href>` nudo sul PDF della delibera (graduatorie). Nella WebView dell'app nessuno dei
 * due scaricava niente, e nessuno dei due lo diceva.
 *
 * Questo file misura tre cose, tutte ROSSE senza la modifica:
 *  · l'INDIRIZZO, il NOME, il MIME e l'ETICHETTA che arrivano a `scaricaDocumento` — cioè
 *    che il file giusto parte dalla route giusta, e che nel log va un token e non un nome;
 *  · che un esito NON consegnato (binario 1.0, route in errore) si DICE a schermo, e che
 *    uno consegnato non lo dice;
 *  · che il link della delibera resta un LINK sul web (nessun `preventDefault`, helper mai
 *    chiamato) e passa dall'helper SOLO nell'app.
 *
 * L'helper è finto ma non piatto: il suo esito cambia fra i casi, e il componente deve
 * comportarsi in modo diverso. `fileConsegnato` resta quello vero.
 */

const h = vi.hoisted(() => ({
  scarica: vi.fn(),
  nativo: false,
  query: '',
}))

vi.mock('@/lib/native/scarica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/native/scarica')>()),
  scaricaDocumento: h.scarica,
}))
vi.mock('@/lib/push/native-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push/native-register')>()),
  isNativeApp: () => h.nativo,
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/admin/forms',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

const ID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const ID_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const MODELLO = 'cccccccc-3333-4333-8333-cccccccccccc'
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Una compilazione di prova. Lo schema è ridotto al minimo che la tabella legge. */
function riga(id: string): SubmissionRow {
  const r = {
    id,
    model_id: MODELLO,
    user_id: null,
    data: { campo: 'valore di prova' },
    status: 'completed' as const,
    signed_at: null,
    created_at: '2026-09-01T10:00:00Z',
    gestita_il: null,
    gestita_da: null,
    form_model: { id: MODELLO, title: 'Modulo di prova', schema: { pages: [] } },
  }
  return r as unknown as SubmissionRow
}

function fetchFinto(input: RequestInfo | URL) {
  const url = String(input)
  if (url.includes('/api/admin/forms/models')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => [{ id: MODELLO, title: 'Modulo di prova' }] })
  }
  if (url.includes('/api/admin/forms/submissions')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => [riga(ID_A), riga(ID_B)] })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => [] })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.nativo = false
  h.query = ''
  h.scarica.mockResolvedValue({ esito: 'web-blob' })
  vi.stubGlobal('fetch', vi.fn(fetchFinto))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

import {
  scaricaCompilazionePdf,
  scaricaCompilazioniXlsx,
} from '@/components/features/admin/forms/submissions/scarica-compilazioni'
import { SubmissionsTable } from '@/components/features/admin/forms/submissions/SubmissionsTable'
import { SubmissionDetailSidebar } from '@/components/features/admin/forms/submissions/SubmissionDetailSidebar'
import { RankingTable } from '@/components/features/admin/forms/rankings/RankingTable'

describe('scarica-compilazioni — il contratto con l’helper', () => {
  it('il PDF di una compilazione: route, nome, mime, etichetta', async () => {
    await expect(scaricaCompilazionePdf(ID_A)).resolves.toBe(true)
    expect(h.scarica).toHaveBeenCalledWith({
      sorgente: `/api/forms/export/pdf?id=${ID_A}`,
      nomeFile: 'compilazione-aaaaaaaa.pdf',
      mime: 'application/pdf',
      etichetta: 'modulo-compilazione-pdf',
    })
  })

  it('l’XLSX di una sola compilazione porta il suo nome; di più, quello dell’export massivo', async () => {
    await scaricaCompilazioniXlsx([ID_A])
    expect(h.scarica).toHaveBeenLastCalledWith({
      sorgente: `/api/forms/export/xlsx?ids=${ID_A}`,
      nomeFile: 'compilazione-aaaaaaaa.xlsx',
      mime: MIME_XLSX,
      etichetta: 'modulo-compilazione-xlsx',
    })

    await scaricaCompilazioniXlsx([ID_A, ID_B])
    expect(h.scarica).toHaveBeenLastCalledWith({
      sorgente: `/api/forms/export/xlsx?ids=${ID_A},${ID_B}`,
      nomeFile: 'compilazioni.xlsx',
      mime: MIME_XLSX,
      etichetta: 'modulo-compilazioni-xlsx',
    })
  })

  it('«consegnato» lo decide l’esito: il ripiego o il fallimento NON sono un file arrivato', async () => {
    h.scarica.mockResolvedValueOnce({ esito: 'nativo-file' })
    await expect(scaricaCompilazionePdf(ID_A)).resolves.toBe(true)
    h.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' })
    await expect(scaricaCompilazionePdf(ID_A)).resolves.toBe(false)
    h.scarica.mockResolvedValueOnce({ esito: 'ripiego-condivisione', motivo: 'http-500' })
    await expect(scaricaCompilazioniXlsx([ID_A])).resolves.toBe(false)
  })
})

describe('SubmissionsTable — i tre scarichi della tabella', () => {
  async function monta() {
    render(<SubmissionsTable />)
    await waitFor(() => expect(screen.getAllByTitle(itModulistica.subScaricaPdf)).toHaveLength(2))
  }

  it('PDF e XLSX di riga, ed «Esporta tutto» con gli id della tabella filtrata', async () => {
    await monta()

    fireEvent.click(screen.getAllByTitle(itModulistica.subScaricaPdf)[1])
    await waitFor(() =>
      expect(h.scarica).toHaveBeenLastCalledWith(
        expect.objectContaining({ sorgente: `/api/forms/export/pdf?id=${ID_B}`, etichetta: 'modulo-compilazione-pdf' }),
      ),
    )

    fireEvent.click(screen.getAllByTitle(itModulistica.subEsportaXlsx)[0])
    await waitFor(() =>
      expect(h.scarica).toHaveBeenLastCalledWith(
        expect.objectContaining({ sorgente: `/api/forms/export/xlsx?ids=${ID_A}`, nomeFile: 'compilazione-aaaaaaaa.xlsx' }),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: /Esporta tutto \(2\)/ }))
    await waitFor(() =>
      expect(h.scarica).toHaveBeenLastCalledWith(
        expect.objectContaining({ sorgente: `/api/forms/export/xlsx?ids=${ID_A},${ID_B}`, nomeFile: 'compilazioni.xlsx' }),
      ),
    )
    // Tre gesti, tre chiamate: nessuna ancora cliccata a mano accanto all'helper.
    expect(h.scarica).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(itModulistica.scaricoNonRiuscito)).toBeNull()
  })

  it('un file che non arriva si DICE, e il gesto successivo riuscito toglie l’avviso', async () => {
    await monta()
    h.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-500' })
    fireEvent.click(screen.getAllByTitle(itModulistica.subScaricaPdf)[0])
    expect(await screen.findByRole('alert')).toHaveTextContent(itModulistica.scaricoNonRiuscito)

    fireEvent.click(screen.getAllByTitle(itModulistica.subScaricaPdf)[0])
    await waitFor(() => expect(h.scarica).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(itModulistica.scaricoNonRiuscito)).toBeNull())
  })
})

describe('SubmissionDetailSidebar — PDF e XLSX dal dettaglio', () => {
  function monta(id = ID_A) {
    return render(
      <SubmissionDetailSidebar submission={riga(id)} onClose={vi.fn()} onToggleGestita={vi.fn(async () => true)} />,
    )
  }

  it('i due bottoni chiamano l’helper con la compilazione aperta', async () => {
    monta()
    fireEvent.click(screen.getByRole('button', { name: itModulistica.subScaricaPdf }))
    await waitFor(() =>
      expect(h.scarica).toHaveBeenLastCalledWith(expect.objectContaining({ sorgente: `/api/forms/export/pdf?id=${ID_A}` })),
    )
    fireEvent.click(screen.getByRole('button', { name: itModulistica.subEsportaXlsx }))
    await waitFor(() =>
      expect(h.scarica).toHaveBeenLastCalledWith(expect.objectContaining({ sorgente: `/api/forms/export/xlsx?ids=${ID_A}` })),
    )
  })

  it('l’avviso di un file non arrivato resta della SUA compilazione: aprendone un’altra sparisce', async () => {
    const { rerender } = monta(ID_A)
    h.scarica.mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' })
    fireEvent.click(screen.getByRole('button', { name: itModulistica.subScaricaPdf }))
    expect(await screen.findByRole('alert')).toHaveTextContent(itModulistica.scaricoNonRiuscito)

    rerender(
      <SubmissionDetailSidebar submission={riga(ID_B)} onClose={vi.fn()} onToggleGestita={vi.fn(async () => true)} />,
    )
    await waitFor(() => expect(screen.queryByText(itModulistica.scaricoNonRiuscito)).toBeNull())
  })
})

describe('RankingTable — il PDF della delibera', () => {
  async function montaConModello() {
    render(<RankingTable />)
    const tendina = await screen.findByRole('combobox')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Modulo di prova' })).toBeInTheDocument())
    fireEvent.change(tendina, { target: { value: MODELLO } })
    return screen.findByRole('link', { name: new RegExp(itModulistica.rnkEsportaPdf) })
  }

  it('sul WEB resta un link: stesso indirizzo di sempre, nessun preventDefault, helper mai chiamato', async () => {
    h.query = 'userId=utente-finto'
    const link = await montaConModello()
    expect(link).toHaveAttribute('href', `/api/forms/export/delibera?modelId=${MODELLO}&userId=utente-finto`)

    // Si intercetta la navigazione di jsdom dopo il gestore del componente: se il
    // componente avesse chiamato `preventDefault`, qui lo si vedrebbe.
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

  it('nell’APP il clic passa dall’helper, con lo stesso indirizzo e un nome col suo .pdf', async () => {
    h.nativo = true
    h.query = 'userId=utente-finto'
    const link = await montaConModello()

    const nonPrevenuto = fireEvent.click(link)
    expect(nonPrevenuto).toBe(false)
    await waitFor(() =>
      expect(h.scarica).toHaveBeenCalledWith({
        sorgente: `/api/forms/export/delibera?modelId=${MODELLO}&userId=utente-finto`,
        nomeFile: 'delibera-cccccccc.pdf',
        mime: 'application/pdf',
        etichetta: 'graduatoria-delibera',
      }),
    )
    expect(screen.queryByText(itModulistica.scaricoNonRiuscito)).toBeNull()
  })

  it('nell’APP un file non arrivato (binario 1.0) si dice sotto il bottone', async () => {
    h.nativo = true
    h.scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile', binarioDaAggiornare: true })
    const link = await montaConModello()
    fireEvent.click(link)
    expect(await screen.findByRole('alert')).toHaveTextContent(itModulistica.scaricoNonRiuscito)
  })
})
