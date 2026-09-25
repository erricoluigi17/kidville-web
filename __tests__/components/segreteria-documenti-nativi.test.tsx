import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

import itAltro from '../../messages/it/adminAltro.json'
import itContabilita from '../../messages/it/adminContabilita.json'
import itStudents from '../../messages/it/adminStudents.json'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// NAT3g1 — protocolli, merchandise e competenze: i documenti della Segreteria
// passano dall'helper unico (`apriDocumento` / `scaricaDocumento`).
//
// IL DIFETTO: ogni punto faceva `window.open(url, '_blank')` (o un link con
// `target` a scheda nuova). Nella WebView Capacitor le finestre multiple non
// sono abilitate: la chiamata ritorna `null`, non lancia, e il bottone non fa
// niente — senza una riga di log.
//
// COSA SI MISURA qui, oltre al «ha chiamato l'helper»: QUALE indirizzo (la route
// giusta con i filtri, l'URL firmato restituito dalla route), CON QUALE nome di
// file (lo stesso che la route mette nel download firmato, mai il nome di un
// bambino), QUALE dei due gesti (esportare nell'app = foglio «Salva su File»,
// sul web = scheda nuova come prima), e che un esito non consegnato AVVISA chi
// ha premuto invece di tacere.
// =============================================================================

const h = vi.hoisted(() => ({
  apriDocumento: vi.fn(),
  scaricaDocumento: vi.fn(),
  nativo: { valore: false },
}))

vi.mock('@/lib/native/scarica', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/native/scarica')>()
  return {
    ...vero,
    apriDocumento: (...a: unknown[]) => h.apriDocumento(...a),
    scaricaDocumento: (...a: unknown[]) => h.scaricaDocumento(...a),
  }
})
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => h.nativo.valore }))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

const USER = 'aaaabbbb-1111-4111-8111-ffffffffffff'
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'aaaabbbb-1111-4111-8111-ffffffffffff', role: 'admin', ready: true }),
}))
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'aaaabbbb-1111-4111-8111-ffffffffffff', ruolo: 'admin', withUser: (x: string) => x }),
}))

const nav = vi.hoisted(() => ({ vista: 'ordini' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`vista=${nav.vista}`),
  usePathname: () => '/admin/merchandise',
}))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'aaaaaaaa-0000-4000-8000-00000000000a', nome: 'Sede di prova' }],
    selezionate: [],
    effettive: ['aaaaaaaa-0000-4000-8000-00000000000a'],
    sedeCorrente: 'aaaaaaaa-0000-4000-8000-00000000000a',
    reFetchKey: 'aaaaaaaa-0000-4000-8000-00000000000a',
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
  }),
}))

import ProtocolliPage from '@/app/(dashboard)/admin/protocolli/page'
import MerchandisePage from '@/app/(dashboard)/admin/merchandise/page'
import { CompetenzePanel } from '@/components/features/admin/CompetenzePanel'
import { avvisoDocumento, baseNomeProtocollo, documentoNonConsegnato, esportaDocumento, nomeFileProtocollo } from '@/lib/ui/documento-segreteria'
import { avvisoDocumento as avvisoDocumentoGenitore, esitoDaSegnalare } from '@/lib/native/documento-genitore'
import { logClient } from '@/lib/logging/client'

/** Indirizzo firmato FINTO (dominio riservato agli esempi, mai un bucket vero). */
const FIRMATO = 'https://storage.example.test/object/sign/protocolli/finto.pdf?token=t'
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ANNO = new Date().getFullYear()

/**
 * L'esito che l'helper NAT2 dà sul binario 1.0 (niente plugin Filesystem): con un
 * URL relativo non c'è ripiego possibile, e riprovare non riuscirà MAI.
 */
const BINARIO_1_0 = { esito: 'non-riuscito', motivo: 'plugin-assenti:Filesystem|link-non-condivisibile', binarioDaAggiornare: true } as const

const fetchMock = vi.fn()
const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body })

let finestra: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  h.nativo.valore = false
  h.apriDocumento.mockResolvedValue({ esito: 'web-scheda' })
  h.scaricaDocumento.mockResolvedValue({ esito: 'nativo-file' })
  vi.stubGlobal('fetch', fetchMock)
  finestra = vi.spyOn(window, 'open').mockReturnValue(null)
})

/** Un giro di microtask: la `.then` dopo l'helper ha avuto modo di girare. */
async function assesta() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

// =============================================================================
describe('documento-segreteria · la scelta del gesto e il verdetto', () => {
  it('ESPORTARE sul web = scheda nuova come prima (apriDocumento), mai il foglio', async () => {
    h.nativo.valore = false
    const input = { sorgente: '/api/x', nomeFile: 'a.xlsx' }
    await esportaDocumento(input)
    expect(h.apriDocumento).toHaveBeenCalledWith(input)
    expect(h.scaricaDocumento).not.toHaveBeenCalled()
  })

  it('ESPORTARE nell\'app = foglio «Salva su File» (scaricaDocumento), mai l\'anteprima', async () => {
    h.nativo.valore = true
    const input = { sorgente: '/api/x', nomeFile: 'a.xlsx' }
    await esportaDocumento(input)
    expect(h.scaricaDocumento).toHaveBeenCalledWith(input)
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })

  it.each([
    [{ esito: 'nativo-file' }, null],
    [{ esito: 'nativo-anteprima' }, null],
    [{ esito: 'web-scheda' }, null],
    [{ esito: 'web-blob' }, null],
    [{ esito: 'ripiego-condivisione', motivo: 'http-500' }, null],
    [{ esito: 'non-riuscito', motivo: 'annullato' }, null],
    // Il gesto annullato resta muto anche sul binario vecchio: l'ha chiuso chi ha premuto.
    [{ esito: 'non-riuscito', motivo: 'annullato', binarioDaAggiornare: true }, null],
    [{ esito: 'ripiego-appunti', motivo: 'http-403' }, 'riprova'],
    [{ esito: 'non-riuscito', motivo: 'http-500' }, 'riprova'],
    [{ esito: 'non-riuscito', motivo: 'http-500', binarioDaAggiornare: false }, 'riprova'],
    [BINARIO_1_0, 'aggiorna'],
    [{ esito: 'ripiego-appunti', motivo: 'plugin-assenti:Share', binarioDaAggiornare: true }, 'aggiorna'],
  ] as const)('%o → avviso: %s', (risultato, atteso) => {
    expect(avvisoDocumento(risultato)).toBe(atteso)
  })

  it('il verdetto è la regola UNICA del ramo, non una terza copia locale', () => {
    // La stessa funzione di `documento-genitore` (e quindi di `LinkDocumento`):
    // quando cambia l'elenco degli esiti, si aggiorna in un posto solo.
    expect(avvisoDocumento).toBe(avvisoDocumentoGenitore)
    // Il nome vecchio a due valori, per chi lo importa ancora, è un alias della
    // regola `esitoDaSegnalare`, non una riscrittura.
    expect(documentoNonConsegnato).toBe(esitoDaSegnalare)
  })

  it('nomeFileProtocollo: il nome del download firmato, senza barra; numero vuoto → ripiego', () => {
    // La stessa convenzione delle route del registro (`Prot-NNNNNNN-AAAA.pdf`),
    // in UNA copia per protocolli e competenze.
    expect(nomeFileProtocollo('0000042/2026')).toBe('Prot-0000042-2026.pdf')
    expect(nomeFileProtocollo('0000042/2026')).not.toContain('/')
    expect(nomeFileProtocollo('')).toBe('protocollo-timbrato.pdf')
    expect(nomeFileProtocollo('   ')).toBe('protocollo-timbrato.pdf')
    // La base (senza estensione) è la stessa da cui nasce il nome del timbrato.
    expect(baseNomeProtocollo('0000042/2026')).toBe('Prot-0000042-2026')
    expect(baseNomeProtocollo('  ')).toBeNull()
  })
})

// =============================================================================
const PROTOCOLLO = {
  id: 'prot-1', anno: 2026, numero: 42, tipo: 'ingresso' as const,
  data_registrazione: '2026-03-04T09:30:00.000Z',
  oggetto: 'Comunicazione di prova', mittente: 'Ente Finto', destinatario: null,
  mezzo: 'PEC', rif_prot_mittente: null, rif_data_mittente: null,
  impronta_sha256: 'a'.repeat(64), categoria_id: null, collegato_a_id: null,
  note_interne: null, emergenza: false, emergenza_dichiarata_il: null,
  annullata_at: null, annullo_motivo: null,
  file_nome_originale: 'documento-uno.pdf', allegati_descrizione: null,
  categoria: null,
  allegati: [{ id: 'all-1', nome: 'allegato-finto.png', mime: 'image/png', size: 10, ordine: 0 }],
}

function fetchProtocolli(prot: typeof PROTOCOLLO | (Omit<typeof PROTOCOLLO, 'file_nome_originale'> & { file_nome_originale: string | null }) = PROTOCOLLO) {
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://localhost')
    if (u.pathname.endsWith('/protocolli/categorie')) return json({ success: true, data: [] })
    if (u.pathname.endsWith('/protocolli/file')) return json({ success: true, data: { url: FIRMATO } })
    const id = u.searchParams.get('id')
    if (id) return json({ success: true, data: prot })
    return json({ success: true, data: [prot], stats: { totale: 1, ingresso: 1, uscita: 0, interno: 0, annullate: 0, ultimoNumero: 42 } })
  })
}

async function apriRegistro(prot?: Parameters<typeof fetchProtocolli>[0]) {
  fetchProtocolli(prot)
  const utils = render(<ProtocolliPage />)
  await waitFor(() => expect(utils.container.querySelectorAll('tbody tr')).toHaveLength(1))
  return utils
}

describe('Protocolli · export e PDF dall\'helper', () => {
  it('WEB: «Excel» apre la route di export coi filtri (scheda nuova, come prima)', async () => {
    await apriRegistro()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protBtnExcel, 'i') }))
    expect(h.apriDocumento).toHaveBeenCalledTimes(1)
    const arg = h.apriDocumento.mock.calls[0][0]
    const u = new URL(arg.sorgente, 'http://localhost')
    expect(u.pathname).toBe('/api/admin/protocolli/export')
    expect(u.searchParams.get('formato')).toBe('xlsx')
    expect(u.searchParams.get('anno')).toBe(String(ANNO))
    expect(u.searchParams.get('userId')).toBe(USER)
    expect(arg).toMatchObject({ nomeFile: `registro-protocollo-${ANNO}.xlsx`, mime: MIME_XLSX, etichetta: 'protocolli-export' })
    expect(h.scaricaDocumento).not.toHaveBeenCalled()
    expect(finestra).not.toHaveBeenCalled()
  })

  it('APP: «PDF registro» va nel foglio «Salva su File» (scaricaDocumento), non in anteprima', async () => {
    h.nativo.valore = true
    await apriRegistro()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protBtnPdfRegistro, 'i') }))
    expect(h.scaricaDocumento).toHaveBeenCalledTimes(1)
    const arg = h.scaricaDocumento.mock.calls[0][0]
    expect(new URL(arg.sorgente, 'http://localhost').searchParams.get('formato')).toBe('pdf')
    expect(arg).toMatchObject({ nomeFile: `registro-protocollo-${ANNO}.pdf`, mime: 'application/pdf' })
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })

  it('APP 1.0: «Excel» sul binario senza plugin dice «aggiorna l\'app», NON «download non riuscito»', async () => {
    // L'URL dell'export è relativo: sul binario 1.0 l'helper non ha ripieghi e
    // risponde `binarioDaAggiornare: true`. Dire «riprova» manderebbe la
    // Segreteria dalla parte sbagliata: non riuscirebbe mai.
    h.nativo.valore = true
    h.scaricaDocumento.mockResolvedValue(BINARIO_1_0)
    await apriRegistro()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protBtnExcel, 'i') }))
    expect(h.scaricaDocumento).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('status')).toHaveTextContent(itAltro.protAggiornaApp)
    expect(screen.getByRole('status')).not.toHaveTextContent(itAltro.protDownloadFallito)
  })

  it('APP: un esito da riprovare (500) resta «download non riuscito», non «aggiorna»', async () => {
    h.nativo.valore = true
    h.scaricaDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-500' })
    await apriRegistro()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protBtnPdfRegistro, 'i') }))
    expect(await screen.findByRole('status')).toHaveTextContent(itAltro.protDownloadFallito)
    expect(screen.getByRole('status')).not.toHaveTextContent(itAltro.protAggiornaApp)
  })

  it('«Timbrato» della riga sul binario 1.0: «aggiorna l\'app»', async () => {
    h.apriDocumento.mockResolvedValue(BINARIO_1_0)
    const { container } = await apriRegistro()
    const riga = container.querySelector('tbody tr') as HTMLElement
    fireEvent.click(within(riga).getByRole('button', { name: new RegExp(itAltro.protBtnTimbrato, 'i') }))
    expect(await screen.findByRole('status')).toHaveTextContent(itAltro.protAggiornaApp)
    expect(screen.getByRole('status')).not.toHaveTextContent(itAltro.protDownloadFallito)
  })

  it('«Timbrato» della riga apre l\'URL FIRMATO dato dalla route, col nome del registro', async () => {
    const { container } = await apriRegistro()
    const riga = container.querySelector('tbody tr') as HTMLElement
    fireEvent.click(within(riga).getByRole('button', { name: new RegExp(itAltro.protBtnTimbrato, 'i') }))
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    // La route chiesta è quella del file TIMBRATO di QUESTA registrazione.
    const chiesta = fetchMock.mock.calls.map((c) => new URL(String(c[0]), 'http://localhost')).find((u) => u.pathname.endsWith('/file'))
    expect(chiesta?.searchParams.get('id')).toBe('prot-1')
    expect(chiesta?.searchParams.get('versione')).toBe('timbrato')
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({
      sorgente: FIRMATO, nomeFile: 'Prot-0000042-2026.pdf', mime: 'application/pdf', etichetta: 'protocollo-timbrato',
    })
    // Un'ASSENZA si controlla solo dopo che la catena è finita davvero: prima
    // la promessa dell'helper, poi la `.then` che deciderebbe il toast. Il
    // segnale positivo dello stesso ramo (il toast che DEVE comparire) è nel
    // test qui sotto.
    await act(async () => { await h.apriDocumento.mock.results[0].value })
    await assesta()
    expect(screen.queryByRole('status')).toBeNull()
    expect(finestra).not.toHaveBeenCalled()
  })

  it('un esito NON consegnato avvisa (prima il bottone taceva)', async () => {
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-500' })
    const { container } = await apriRegistro()
    const riga = container.querySelector('tbody tr') as HTMLElement
    fireEvent.click(within(riga).getByRole('button', { name: new RegExp(itAltro.protBtnTimbrato, 'i') }))
    expect(await screen.findByRole('status')).toHaveTextContent(itAltro.protDownloadFallito)
  })

  it('nel dettaglio «Originale» e l\'allegato portano il LORO nome e il LORO tipo', async () => {
    await apriRegistro()
    fireEvent.click(screen.getByRole('button', { name: /0000042\/2026/ }))
    const originale = await screen.findByRole('button', { name: new RegExp(`^${itAltro.protOriginale}$`, 'i') })
    fireEvent.click(originale)
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({ sorgente: FIRMATO, nomeFile: 'documento-uno.pdf', etichetta: 'protocollo-originale' })

    fireEvent.click(screen.getByRole('button', { name: /allegato-finto\.png/ }))
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(2))
    expect(h.apriDocumento.mock.calls[1][0]).toMatchObject({ nomeFile: 'allegato-finto.png', mime: 'image/png', etichetta: 'protocollo-allegato' })
    const chiesta = fetchMock.mock.calls.map((c) => new URL(String(c[0]), 'http://localhost')).filter((u) => u.pathname.endsWith('/file')).pop()
    expect(chiesta?.searchParams.get('allegatoId')).toBe('all-1')
  })

  it('nel dettaglio il timbrato e l\'originale SENZA nome prendono la base del registro (una sola convenzione)', async () => {
    // Il nome si ricava dal numero con la stessa funzione dei drawer e delle
    // Competenze: `Prot-0000042-2026`, mai una seconda formula scritta a mano.
    await apriRegistro({ ...PROTOCOLLO, file_nome_originale: null })
    fireEvent.click(screen.getByRole('button', { name: /0000042\/2026/ }))
    const timbrato = await screen.findByRole('button', { name: new RegExp(`^${itAltro.protPdfTimbrato}$`, 'i') })
    fireEvent.click(timbrato)
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({ sorgente: FIRMATO, nomeFile: 'Prot-0000042-2026.pdf', mime: 'application/pdf', etichetta: 'protocollo-timbrato' })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${itAltro.protOriginale}$`, 'i') }))
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(2))
    expect(h.apriDocumento.mock.calls[1][0]).toMatchObject({ sorgente: FIRMATO, nomeFile: 'Prot-0000042-2026-originale', etichetta: 'protocollo-originale' })
  })
})

// =============================================================================
// I due drawer che producono un numero: al passo finale «Scarica il PDF
// timbrato» era un `<a target>` (Registra) o un `window.open` (Genera).
const SIGNED_PUT = 'https://storage.example.test/object/upload/sign/staging/finto.pdf?token=u'
const ESITO_REGISTRAZIONE = { numeroFormattato: '0000042/2026', downloadTimbrato: FIRMATO }

/** Il registro di prima, più le scritture dei due drawer (upload, analisi, registrazione, generazione). */
function fetchProtocolliConScritture() {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const u = new URL(String(url), 'http://localhost')
    const metodo = init?.method ?? 'GET'
    if (String(url) === SIGNED_PUT && metodo === 'PUT') return json({})
    if (metodo === 'POST') {
      if (u.pathname === '/api/admin/protocolli/upload-url') return json({ success: true, data: { signedUrl: SIGNED_PUT, path: 'staging/finto.pdf' } })
      if (u.pathname === '/api/admin/protocolli/analizza') return json({ success: true, data: { duplicato: null, suggerimenti: {} } })
      if (u.pathname === '/api/admin/protocolli' || u.pathname === '/api/admin/protocolli/genera-documento') {
        return json({ success: true, data: ESITO_REGISTRAZIONE })
      }
    }
    if (u.pathname === '/api/admin/students') return json([{ id: 'alu-1', nome: 'Nomefinto', cognome: 'Cognomefinto', classe_sezione: null }])
    if (u.pathname.endsWith('/protocolli/categorie')) return json({ success: true, data: [] })
    return json({ success: true, data: [PROTOCOLLO], stats: { totale: 1, ingresso: 1, uscita: 0, interno: 0, annullate: 0, ultimoNumero: 42 } })
  })
}

/** «Protocolla documento» fino al passo 3: file → dati → «Registra e timbra». */
async function registraFinoAlPasso3() {
  fetchProtocolliConScritture()
  const { container } = render(<ProtocolliPage />)
  await waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protBtnProtocolla, 'i') }))
  const input = await waitFor(() => {
    const i = document.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(i).not.toBeNull()
    return i as HTMLInputElement
  })
  fireEvent.change(input, { target: { files: [new File(['%PDF-1.4'], 'finto.pdf', { type: 'application/pdf' })] } })
  fireEvent.change(await screen.findByPlaceholderText(itAltro.protOggettoPlaceholder), { target: { value: 'Oggetto finto' } })
  fireEvent.change(screen.getByPlaceholderText(itAltro.protMittentePlaceholder), { target: { value: 'Ente finto' } })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protRegistraTimbra, 'i') }))
  return screen.findByRole('button', { name: new RegExp(itAltro.protScaricaTimbrato, 'i') })
}

describe('Protocolli · «Scarica il PDF timbrato» a fine drawer', () => {
  it('REGISTRA: apre l\'URL firmato col nome del registro (barra tolta), senza window.open', async () => {
    const bottone = await registraFinoAlPasso3()
    // Era un `<a>`: ora è un bottone, e il clic passa dall'helper.
    expect(bottone.tagName).toBe('BUTTON')
    fireEvent.click(bottone)
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({
      sorgente: FIRMATO, nomeFile: 'Prot-0000042-2026.pdf', mime: 'application/pdf', etichetta: 'protocollo-timbrato',
    })
    expect(finestra).not.toHaveBeenCalled()
  })

  it('REGISTRA: se non si apre, lo dice il banner del drawer — con un testo SENZA emoji', async () => {
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-500' })
    fireEvent.click(await registraFinoAlPasso3())
    expect(await screen.findByText(itAltro.protTimbratoNonAperto)).toBeInTheDocument()
    // La chiave dei toast porta «❌»: accanto all'icona del banner sarebbero due.
    expect(screen.queryByText(itAltro.protDownloadFallito)).toBeNull()
  })

  it('REGISTRA sul binario 1.0: il banner dice «aggiorna l\'app» (senza emoji), non «riprova»', async () => {
    h.apriDocumento.mockResolvedValue(BINARIO_1_0)
    fireEvent.click(await registraFinoAlPasso3())
    expect(await screen.findByText(itAltro.protAggiornaApp)).toBeInTheDocument()
    expect(screen.queryByText(itAltro.protTimbratoNonAperto)).toBeNull()
    expect(itAltro.protAggiornaApp).not.toMatch(/❌/)
  })

  it('GENERA: apre l\'URL firmato col nome del registro, e se non si apre avvisa col toast', async () => {
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-500' })
    fetchProtocolliConScritture()
    const { container } = render(<ProtocolliPage />)
    await waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protBtnGenera, 'i') }))
    fireEvent.click(await screen.findByRole('button', { name: /Cognomefinto Nomefinto/ }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAltro.protGeneraProtocolla, 'i') }))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itAltro.protScaricaTimbrato, 'i') }))
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({
      sorgente: FIRMATO, nomeFile: 'Prot-0000042-2026.pdf', mime: 'application/pdf', etichetta: 'protocollo-timbrato',
    })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(itAltro.protDownloadFallito))
    expect(finestra).not.toHaveBeenCalled()
  })
})

// =============================================================================
const PO_APERTO = {
  id: 'po-1', fornitore_nome: 'Fornitore Finto', numero: 'PO-2026-001', stato: 'aperto',
  creato_il: '2026-03-01T10:00:00.000Z', chiuso_il: null,
  righe: [{ id: 'r-1', articolo_nome: 'Maglietta', taglia: 'M', quantita: 1, stato: 'ordinato', ordine_id: 'o-1' }],
}

/**
 * Il giorno UTC (come `toISOString` della route) prima e dopo il gesto: il nome
 * atteso è esatto, e non diventa rosso se il test gira a cavallo della mezzanotte.
 */
function giorniAttorno(gesto: () => void): string[] {
  const prima = new Date().toISOString().slice(0, 10)
  gesto()
  const dopo = new Date().toISOString().slice(0, 10)
  return [prima, dopo]
}

function fetchMerch() {
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://localhost')
    if (u.pathname.endsWith('/merch/ordini-fornitore')) return json({ success: true, data: [PO_APERTO] })
    return json({ success: true, data: [] })
  })
}

describe('Merchandise · export XLSX e PDF dell\'ordine al fornitore', () => {
  it('WEB: «Esporta XLSX» apre la route di export (scheda nuova, come prima)', async () => {
    nav.vista = 'ordini'
    fetchMerch()
    render(<MerchandisePage />)
    const bottone = await screen.findByRole('button', { name: new RegExp(itContabilita.merchEsportaXLSX, 'i') })
    const giorni = giorniAttorno(() => fireEvent.click(bottone))
    expect(h.apriDocumento).toHaveBeenCalledTimes(1)
    const arg = h.apriDocumento.mock.calls[0][0]
    const u = new URL(arg.sorgente, 'http://localhost')
    expect(u.pathname).toBe('/api/admin/merch/export')
    expect(u.searchParams.get('userId')).toBe(USER)
    expect(arg).toMatchObject({ mime: MIME_XLSX, etichetta: 'merch-export' })
    expect(arg.nomeFile).toMatch(/^merchandise-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(giorni.map((g) => `merchandise-${g}.xlsx`)).toContain(arg.nomeFile)
    expect(finestra).not.toHaveBeenCalled()
  })

  it('APP: «Esporta XLSX» va nel foglio «Salva su File»', async () => {
    h.nativo.valore = true
    nav.vista = 'ordini'
    fetchMerch()
    render(<MerchandisePage />)
    const bottone = await screen.findByRole('button', { name: new RegExp(itContabilita.merchEsportaXLSX, 'i') })
    const giorni = giorniAttorno(() => fireEvent.click(bottone))
    expect(h.scaricaDocumento).toHaveBeenCalledTimes(1)
    // Nell'app il nome è quello del `Content-Disposition` della route
    // («merchandise-AAAA-MM-GG.xlsx»): due export di giorni diversi non si
    // scontrano nel foglio «Salva su File».
    const nome = h.scaricaDocumento.mock.calls[0][0].nomeFile
    expect(nome).toMatch(/^merchandise-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(giorni.map((g) => `merchandise-${g}.xlsx`)).toContain(nome)
    expect(h.apriDocumento).not.toHaveBeenCalled()
  })

  it('APP 1.0: «Esporta XLSX» sul binario senza plugin dice «aggiorna l\'app», NON «riprova»', async () => {
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    h.nativo.valore = true
    h.scaricaDocumento.mockResolvedValue(BINARIO_1_0)
    nav.vista = 'ordini'
    fetchMerch()
    render(<MerchandisePage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itContabilita.merchEsportaXLSX, 'i') }))
    await waitFor(() => expect(avviso).toHaveBeenCalledTimes(1))
    expect(avviso).toHaveBeenCalledWith(itContabilita.docNativoAggiornaApp)
    expect(avviso).not.toHaveBeenCalledWith(itContabilita.merchDownloadNonRiuscito)
  })

  it('«Ristampa PDF» APRE il PDF di QUELL\'ordine, col suo numero come nome', async () => {
    nav.vista = 'arrivi'
    fetchMerch()
    render(<MerchandisePage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itContabilita.merchRistampaPDF, 'i') }))
    expect(h.apriDocumento).toHaveBeenCalledTimes(1)
    const arg = h.apriDocumento.mock.calls[0][0]
    const u = new URL(arg.sorgente, 'http://localhost')
    expect(u.pathname).toBe('/api/admin/merch/ordini-fornitore/pdf')
    expect(u.searchParams.get('id')).toBe('po-1')
    expect(arg).toMatchObject({ nomeFile: 'PO-2026-001.pdf', mime: 'application/pdf', etichetta: 'merch-ordine-fornitore' })
    expect(finestra).not.toHaveBeenCalled()
  })

  it('un esito NON consegnato avvisa con il messaggio del catalogo', async () => {
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    h.apriDocumento.mockResolvedValue({ esito: 'ripiego-appunti', motivo: 'http-403' })
    nav.vista = 'arrivi'
    fetchMerch()
    render(<MerchandisePage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itContabilita.merchRistampaPDF, 'i') }))
    await waitFor(() => expect(avviso).toHaveBeenCalledWith(itContabilita.merchDownloadNonRiuscito))
  })

  it('«Da ordinare»: dopo l\'invio apre il PDF del NUOVO ordine (id e numero dalla risposta POST)', async () => {
    nav.vista = 'da_ordinare'
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const u = new URL(String(url), 'http://localhost')
      if (u.pathname === '/api/admin/merch/ordini-fornitore' && init?.method === 'POST') {
        return json({ success: true, data: { po: { id: 'po-9', numero: 'PO-2026-009' } } })
      }
      if (u.pathname === '/api/admin/merch/da-ordinare') {
        return json({ success: true, data: { gruppi: [{
          fornitore: { id: 'forn-1', nome: 'Fornitore Finto' }, quantita: 1,
          articoli: [{ articolo_id: 'art-1', nome: 'Maglietta', quantita: 1, taglie: [{ taglia: 'M', quantita: 1, righe_ids: ['r-1'] }] }],
        }] } })
      }
      return json({ success: true, data: [] })
    })
    render(<MerchandisePage />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(itContabilita.merchGeneraOrdinePDF.replace(/[()]/g, '\\$&'), 'i') }))
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    const arg = h.apriDocumento.mock.calls[0][0]
    const u = new URL(arg.sorgente, 'http://localhost')
    expect(u.pathname).toBe('/api/admin/merch/ordini-fornitore/pdf')
    expect(u.searchParams.get('id')).toBe('po-9')
    expect(arg).toMatchObject({ nomeFile: 'PO-2026-009.pdf', mime: 'application/pdf', etichetta: 'merch-ordine-fornitore' })
    expect(finestra).not.toHaveBeenCalled()
  })
})

// =============================================================================
const SEZIONE = { id: 'sez-5', name: '5 A', school_type: 'primaria', scuola_id: SEDE_A }
const CERT = {
  id: 'cert-1', stato: 'generato', anno_scolastico: '2025/26',
  alunni: { nome: 'Alunnofinto', cognome: 'Cognomefinto' },
  certificato_competenza_livelli: [],
}

function fetchCompetenze() {
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const u = new URL(String(url), 'http://localhost')
    if (u.pathname === '/api/admin/sections') return json([SEZIONE])
    if (u.pathname === '/api/admin/competenze/download') return json({ success: true, url: FIRMATO })
    if (u.pathname === '/api/admin/protocolli/da-documento' && init?.method === 'POST') {
      return json({ success: true, data: { numeroFormattato: '0000042/2026', downloadTimbrato: FIRMATO } })
    }
    if (u.pathname === '/api/admin/competenze') return json({ data: [CERT] })
    return json({ data: [] })
  })
}

async function apriCertificato() {
  fetchCompetenze()
  render(<CompetenzePanel userId={USER} />)
  const tendina = await waitFor(() => {
    const s = document.querySelector('select') as HTMLSelectElement
    expect(s.options.length).toBe(2)
    return s
  })
  fireEvent.change(tendina, { target: { value: 'sez-5' } })
  return screen.findByRole('button', { name: new RegExp(itStudents.compScaricaPdf, 'i') })
}

describe('Competenze · certificato e PDF timbrato dall\'helper', () => {
  it('«Scarica PDF» apre l\'URL firmato della route, e nel nome NON c\'è il bambino', async () => {
    fireEvent.click(await apriCertificato())
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    const chiesta = fetchMock.mock.calls.map((c) => new URL(String(c[0]), 'http://localhost')).find((u) => u.pathname === '/api/admin/competenze/download')
    expect(chiesta?.searchParams.get('certificatoId')).toBe('cert-1')
    const arg = h.apriDocumento.mock.calls[0][0]
    expect(arg).toMatchObject({
      sorgente: FIRMATO, nomeFile: 'certificato-competenze-2025-26.pdf', mime: 'application/pdf', etichetta: 'competenze-certificato',
    })
    expect(JSON.stringify(arg)).not.toMatch(/Alunnofinto|Cognomefinto/)
    expect(finestra).not.toHaveBeenCalled()
  })

  it('un esito NON consegnato lo dice sotto la barra (prima: niente)', async () => {
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-404' })
    fireEvent.click(await apriCertificato())
    expect(await screen.findByText(itStudents.compDownloadNonRiuscito)).toBeInTheDocument()
  })

  it('«Scarica PDF» sul binario 1.0: «aggiorna l\'app», non «riprova»', async () => {
    h.apriDocumento.mockResolvedValue(BINARIO_1_0)
    fireEvent.click(await apriCertificato())
    expect(await screen.findByText(itStudents.compAggiornaApp)).toBeInTheDocument()
    expect(screen.queryByText(itStudents.compDownloadNonRiuscito)).toBeNull()
  })

  it('«Protocolla» sul binario 1.0: numero detto, «aggiorna l\'app», e mai «riprova»', async () => {
    h.apriDocumento.mockResolvedValue(BINARIO_1_0)
    await apriCertificato()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itStudents.compProtocolla, 'i') }))
    const atteso = itStudents.compTimbratoAggiornaApp.replace('{numero}', '0000042/2026')
    expect(await screen.findByText(atteso)).toBeInTheDocument()
    expect(screen.queryByText(itStudents.compTimbratoNonAperto.replace('{numero}', '0000042/2026'))).toBeNull()
  })

  it('«Protocolla» apre il PDF TIMBRATO restituito, col nome del registro', async () => {
    await apriCertificato()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itStudents.compProtocolla, 'i') }))
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(1))
    expect(h.apriDocumento.mock.calls[0][0]).toMatchObject({
      sorgente: FIRMATO, nomeFile: 'Prot-0000042-2026.pdf', etichetta: 'competenze-timbrato',
    })
    expect(finestra).not.toHaveBeenCalled()
  })

  it('«Protocolla» col timbrato NON aperto rimanda al registro e NON invita a riprovare', async () => {
    // Riprovare = ripremere «Protocolla» = un SECONDO numero per lo stesso
    // certificato: la route non è idempotente, e un numero si annulla, non si cancella.
    h.apriDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-500' })
    await apriCertificato()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itStudents.compProtocolla, 'i') }))
    const atteso = itStudents.compTimbratoNonAperto.replace('{numero}', '0000042/2026')
    expect(await screen.findByText(atteso)).toBeInTheDocument()
    expect(screen.queryByText(new RegExp(itStudents.compDownloadNonRiuscito))).toBeNull()
  })

  it('elenco delle sezioni respinto (500): «nessuna quinta» MA un log con lo status (prima: silenzio)', async () => {
    // Una risposta d'errore non passa dal `.catch`: senza il ramo `!r.ok` la
    // tendina vuota era identica a «nessuna quinta», e nessuna riga lo diceva.
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(String(url), 'http://localhost')
      if (u.pathname === '/api/admin/sections') return json({ error: 'x' }, false)
      return json({ data: [] })
    })
    render(<CompetenzePanel userId={USER} />)
    await waitFor(() => expect(logClient).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'warn', evento: 'fetch', messaggio: 'competenze-sezioni-non-caricate', stato: 500, route: '/admin/competenze',
    })))
    // Lo schermo resta quello di sempre («nessuna quinta»): la differenza sta nel log.
    expect(await screen.findByText(itStudents.compNessunaQuinta)).toBeInTheDocument()
    expect(document.querySelector('select')).toBeNull()
  })

  it('«Scarica PDF»: un tentativo riuscito toglie l\'avviso del tentativo fallito prima', async () => {
    h.apriDocumento
      .mockResolvedValueOnce({ esito: 'non-riuscito', motivo: 'http-500' })
      .mockResolvedValueOnce({ esito: 'web-scheda' })
    const bottone = await apriCertificato()
    fireEvent.click(bottone)
    expect(await screen.findByText(itStudents.compDownloadNonRiuscito)).toBeInTheDocument()
    fireEvent.click(bottone)
    await waitFor(() => expect(h.apriDocumento).toHaveBeenCalledTimes(2))
    await act(async () => { await h.apriDocumento.mock.results[1].value })
    await assesta()
    expect(screen.queryByText(itStudents.compDownloadNonRiuscito)).toBeNull()
  })
})

// =============================================================================
describe('Lock · nei tre file della Segreteria non torna la scheda nuova a mano', () => {
  const FILE = [
    'src/app/(dashboard)/admin/protocolli/page.tsx',
    'src/app/(dashboard)/admin/merchandise/page.tsx',
    'src/components/features/admin/CompetenzePanel.tsx',
  ]
  it.each(FILE)('%s: nessuna apertura diretta di finestre, e l\'helper è importato', (rel) => {
    const testo = fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
    expect(testo.length).toBeGreaterThan(1000)
    expect(testo).not.toMatch(/window\s*\.\s*open\s*\(/)
    expect(testo).not.toMatch(/target\s*=\s*["'{]\s*["']?_blank/)
    expect(testo).toMatch(/from '@\/lib\/native\/scarica'|from '@\/lib\/ui\/documento-segreteria'/)
  })
})
