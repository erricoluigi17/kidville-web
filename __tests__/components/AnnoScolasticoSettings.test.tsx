import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itSettings from '../../messages/it/adminSettings.json'
import { SEDE_A } from '../fixtures/sedi'
import type { RigaCalendario } from '@/lib/anno-scolastico'
import type { StatoAnno } from '@/lib/anno/tipi'

// =============================================================================
// PR 4.2 · compito 4.2.7 · LA SEZIONE «ANNO SCOLASTICO» NELLE IMPOSTAZIONI.
//
// È la schermata che la segreteria usa davvero per spostare il confine fra due anni, fissare le date del
// registro e aprire le iscrizioni (le domande dal sito hanno solo una riga informativa fino alla 4.5). Le regole stanno nel database e nelle
// route (4.2.4): qui si prova che la schermata le DICA invece di nasconderle — il rifiuto con i numeri, il
// 403 con le parole, ciò che si digitava ancora lì — e che non scriva mai quando non deve.
//
// Il calendario è finto (stati e date scritti a mano: nessun test dipende da «oggi»); le route sono una
// `fetch` finta che registra ogni chiamata.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore-di-rete' }))

const h = vi.hoisted(() => ({
  perSede: {} as Record<string, readonly unknown[]>,
  loading: false,
  errore: false,
  ricarica: vi.fn(),
  anno: null as null | { selezionato: string | null },
}))

// Il selettore dell'anno (4.2): qui basta la sua scelta, `selezionato`. `null` = fuori dal provider.
vi.mock('@/lib/context/anno-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context/anno-context')>()),
  useAnnoOpzionale: () => h.anno,
}))

vi.mock('@/lib/context/calendario-context', () => ({
  useCalendario: () => ({ perSede: h.perSede, loading: h.loading, errore: h.errore, ricarica: h.ricarica }),
  useCalendarioDi: (sede?: string | null) => (sede ? (h.perSede[sede] ?? null) : null),
}))

import { logClient } from '@/lib/logging/client'
import { AnnoScolasticoSettings } from '@/components/features/admin/settings/AnnoScolasticoSettings'

const USER = 'aaaabbbb-1111-4111-8111-dddddddddddd'
const A25 = '22222222-2222-4222-8222-222222222025'
const A26 = '22222222-2222-4222-8222-222222222026'
const A27 = '22222222-2222-4222-8222-222222222027'
const S25 = '5ed00000-0000-4000-8000-000000002025'
const S26 = '5ed00000-0000-4000-8000-000000002026'
const S27 = '5ed00000-0000-4000-8000-000000002027'

function riga(anno: number, stato: StatoAnno, extra: Partial<RigaCalendario> = {}): RigaCalendario {
  const id = { 2025: A25, 2026: A26, 2027: A27 }[anno as 2025 | 2026 | 2027]
  const sede = { 2025: S25, 2026: S26, 2027: S27 }[anno as 2025 | 2026 | 2027]
  return {
    annoId: id,
    annoSedeId: sede,
    annoInizio: anno,
    inizio: `${anno}-09-01`,
    fine: `${anno + 1}-08-31`,
    ultimoGiornoAperto: `${anno + 1}-07-31`,
    preparaSuccessivoDal: `${anno + 1}-03-01`,
    stato,
    domandeAperte: false,
    ...extra,
  }
}

const treAnni = (extra26: Partial<RigaCalendario> = {}) => [
  riga(2025, 'chiuso'),
  riga(2026, 'corrente', extra26),
  riga(2027, 'in_preparazione'),
]

type Risposta = { status: number; body: unknown }
const ok = (data: Record<string, unknown>): Risposta => ({ status: 200, body: { success: true, data } })

let rispostaPatch: Risposta
let rispostaPost: Risposta
let rispostaGet: Risposta
let retePatch: boolean
const fetchMock = vi.fn()

const tutti = ['quota_conferma', 'quota_nuova', 'moduli_conferma', 'moduli_nuova']

beforeEach(() => {
  vi.clearAllMocks()
  h.perSede = { [SEDE_A]: treAnni() }
  h.loading = false
  h.errore = false
  h.anno = null
  rispostaPatch = ok({ cambiato: true })
  rispostaPost = ok({ cambiato: true })
  rispostaGet = ok({ mancano: tutti })
  retePatch = false
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    const metodo = init?.method ?? 'GET'
    if (retePatch && metodo !== 'GET') return Promise.reject(new TypeError('rete'))
    const r = metodo === 'PATCH' ? rispostaPatch : metodo === 'POST' ? rispostaPost : rispostaGet
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function chiamate(metodo: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === metodo)
}
function ultima(metodo: string): { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null {
  const c = chiamate(metodo)
  const u = c[c.length - 1]
  return u ? { url: String(u[0]), body: u[1]?.body ? JSON.parse(String(u[1].body)) : {}, headers: u[1]?.headers ?? {} } : null
}

function monta() {
  return render(<AnnoScolasticoSettings userId={USER} scuolaId={SEDE_A} />)
}

/** Sceglie un anno dall'elenco (il nome accessibile della riga comincia con l'etichetta breve). */
function scegli(etichettaBreve: string) {
  const elenco = screen.getByRole('list', { name: itSettings.annoElencoAria })
  fireEvent.click(within(elenco).getByRole('button', { name: new RegExp(`^${etichettaBreve}`) }))
}
const gruppo = (nome: string) => screen.getByRole('group', { name: nome })
const salvaDi = (nome: string) => within(gruppo(nome)).getByRole('button', { name: itSettings.salva })

describe('Impostazioni → Anno scolastico: l’elenco', () => {
  it('una riga per anno: etichetta, stato in parole, inizio e fine', async () => {
    monta()
    const elenco = await screen.findByRole('list', { name: itSettings.annoElencoAria })
    const righe = within(elenco).getAllByRole('listitem')
    expect(righe).toHaveLength(3)
    // Dal più recente: 2027/28 in preparazione, 2026/27 in corso, 2025/26 chiuso.
    expect(righe[0]).toHaveTextContent('2027/28')
    expect(righe[0]).toHaveTextContent('in preparazione')
    expect(righe[1]).toHaveTextContent('2026/27')
    expect(righe[1]).toHaveTextContent('in corso')
    expect(righe[1]).toHaveTextContent('da 1/9/2026 a 31/8/2027')
    expect(righe[2]).toHaveTextContent('2025/26')
    expect(righe[2]).toHaveTextContent('chiuso')
  })

  it('all’apertura è scelto l’anno in corso, e la riga lo dice con aria-pressed', async () => {
    monta()
    const elenco = await screen.findByRole('list', { name: itSettings.annoElencoAria })
    expect(within(elenco).getByRole('button', { name: /^2026\/27/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(elenco).getByRole('button', { name: /^2027\/28/ })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('Impostazioni → Anno scolastico: parte dall’anno scelto nel selettore', () => {
  const premuto = async (etichetta: string) => {
    const elenco = await screen.findByRole('list', { name: itSettings.annoElencoAria })
    return within(elenco).getByRole('button', { name: new RegExp(`^${etichetta}`) })
  }

  it('se il selettore è sul 2027/28 la sezione si apre sul 2027/28', async () => {
    h.anno = { selezionato: A27 }
    monta()
    expect(await premuto('2027/28')).toHaveAttribute('aria-pressed', 'true')
    expect(await premuto('2026/27')).toHaveAttribute('aria-pressed', 'false')
  })

  it('se l’anno scelto non esiste per questa sede si apre sull’anno in corso, come oggi', async () => {
    h.anno = { selezionato: '99999999-9999-4999-8999-999999999999' }
    monta()
    expect(await premuto('2026/27')).toHaveAttribute('aria-pressed', 'true')
  })

  it('senza una scelta (o fuori dal provider) si apre sull’anno in corso', async () => {
    h.anno = { selezionato: null }
    monta()
    expect(await premuto('2026/27')).toHaveAttribute('aria-pressed', 'true')
  })

  it('è solo la scelta iniziale: si può aprire un altro anno dall’elenco', async () => {
    h.anno = { selezionato: A27 }
    monta()
    await premuto('2027/28')
    scegli('2026/27')
    expect(await premuto('2026/27')).toHaveAttribute('aria-pressed', 'true')
    expect(await premuto('2027/28')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('Impostazioni → Anno scolastico: la fine dell’anno (il confine)', () => {
  it('il campo parte dalla fine in calendario e sotto dice quando comincia l’anno dopo', async () => {
    monta()
    const campo = (await screen.findByLabelText(itSettings.annoFineTitolo)) as HTMLInputElement
    expect(campo.value).toBe('2027-08-31')
    expect(screen.getByText('L’anno successivo (2027/28) comincerà il 1/9/2027')).toBeInTheDocument()
    fireEvent.change(campo, { target: { value: '2027-08-30' } })
    expect(screen.getByText('L’anno successivo (2027/28) comincerà il 31/8/2027')).toBeInTheDocument()
  })

  it('Salva manda il confine all’anno scelto, con l’identità di sessione, e poi rilegge il calendario', async () => {
    monta()
    fireEvent.change(await screen.findByLabelText(itSettings.annoFineTitolo), { target: { value: '2027-08-30' } })
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    await waitFor(() => expect(ultima('PATCH')).not.toBeNull())
    const p = ultima('PATCH')!
    expect(p.url).toBe(`/api/admin/anni/${S26}`)
    expect(p.body).toEqual({ azione: 'confine', nuova_fine: '2027-08-30' })
    expect(p.headers['x-user-id']).toBe(USER)
    expect(await screen.findByText(itSettings.salvato)).toBeInTheDocument()
    expect(h.ricarica).toHaveBeenCalledTimes(1)
  })

  it('salvare senza cambiare la data non è un errore: «Nessuna modifica»', async () => {
    rispostaPatch = ok({ cambiato: false })
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByText(itSettings.annoNessunaModifica)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(h.ricarica).not.toHaveBeenCalled()
  })

  it('CONFINE_CON_RIGHE: dice quante righe e dove, e ciò che si stava digitando resta lì', async () => {
    rispostaPatch = {
      status: 409,
      body: {
        error: 'x', codice: 'CONFINE_CON_RIGHE', righe: 52,
        tabelle: { presenze: 12, eventi_diario: 40 }, dal: '2027-08-29', al: '2027-08-31',
      },
    }
    monta()
    const campo = (await screen.findByLabelText(itSettings.annoFineTitolo)) as HTMLInputElement
    fireEvent.change(campo, { target: { value: '2027-08-28' } })
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    const allarme = await screen.findByRole('alert')
    expect(allarme).toHaveTextContent('Non si può: ci sono già 52 righe in quei giorni (presenze 12, diario 40)')
    expect(allarme).not.toHaveTextContent(itSettings.errore + '.')
    // Il rifiuto non cancella ciò che si digitava, e non rilegge niente.
    expect((screen.getByLabelText(itSettings.annoFineTitolo) as HTMLInputElement).value).toBe('2027-08-28')
    expect(h.ricarica).not.toHaveBeenCalled()
  })

  it('con UNA riga sola il testo dice «1 riga»; una tabella senza etichetta resta col nome tecnico', async () => {
    rispostaPatch = {
      status: 409,
      body: { error: 'x', codice: 'CONFINE_CON_RIGHE', righe: 1, tabelle: { student_documents: 1 } },
    }
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent('Non si può: ci sono già 1 riga in quei giorni (student_documents 1)')
  })

  it('le tabelle del registro dell’anno hanno un’etichetta leggibile: galleria, foto caricate, chat, avvisi, valutazioni, pagamenti', async () => {
    rispostaPatch = {
      status: 409,
      body: {
        error: 'x', codice: 'CONFINE_CON_RIGHE', righe: 21,
        tabelle: {
          avvisi: 1, chat_messages: 2, galleria_media_v2: 3, gallery_photo_uploads: 4, pagamenti: 5, valutazioni: 6,
        },
      },
    }
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Non si può: ci sono già 21 righe in quei giorni (avvisi 1, chat 2, galleria 3, foto caricate 4, pagamenti 5, valutazioni 6)',
    )
  })

  it('CONFINE_NON_VALIDO con un motivo noto dice quel motivo, non la frase generica', async () => {
    rispostaPatch = { status: 422, body: { error: 'x', codice: 'CONFINE_NON_VALIDO', motivo: 'ultimo_giorno_aperto_fuori' } }
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent(itSettings.annoConfineUltimoGiornoFuori)
  })

  it('senza un anno dopo, la fine non si sposta e la schermata spiega perché', async () => {
    h.perSede = { [SEDE_A]: [riga(2026, 'corrente')] }
    monta()
    const campo = (await screen.findByLabelText(itSettings.annoFineTitolo)) as HTMLInputElement
    expect(campo).toBeDisabled()
    expect(screen.getByText(itSettings.annoFineSenzaSuccessivo)).toBeInTheDocument()
    expect(within(gruppo(itSettings.annoFineTitolo)).queryByRole('button', { name: itSettings.salva })).toBeNull()
  })

  it('un campo svuotato non parte: si chiede una data', async () => {
    monta()
    fireEvent.change(await screen.findByLabelText(itSettings.annoFineTitolo), { target: { value: '' } })
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent(itSettings.annoDataMancante)
    expect(chiamate('PATCH')).toHaveLength(0)
  })
})

describe('Impostazioni → Anno scolastico: le date del registro', () => {
  it('i due campi mostrano il predefinito accanto, e un solo Salva li manda insieme', async () => {
    monta()
    const ultimo = (await screen.findByLabelText(itSettings.annoUltimoGiorno)) as HTMLInputElement
    const prepara = screen.getByLabelText(itSettings.annoPreparaDal) as HTMLInputElement
    expect(ultimo.value).toBe('2027-07-31')
    expect(prepara.value).toBe('2027-03-01')
    expect(screen.getByText(itSettings.annoUltimoGiornoPredefinito)).toBeInTheDocument()
    expect(screen.getByText(itSettings.annoPreparaPredefinito)).toBeInTheDocument()
    fireEvent.change(ultimo, { target: { value: '2027-07-15' } })
    fireEvent.change(prepara, { target: { value: '2027-04-01' } })
    fireEvent.click(salvaDi(itSettings.annoDateTitolo))
    await waitFor(() => expect(ultima('PATCH')).not.toBeNull())
    expect(ultima('PATCH')!.body).toEqual({
      azione: 'date', ultimo_giorno_aperto: '2027-07-15', prepara_successivo_dal: '2027-04-01',
    })
    expect(ultima('PATCH')!.url).toBe(`/api/admin/anni/${S26}`)
    expect(await screen.findByText(itSettings.salvato)).toBeInTheDocument()
    expect(h.ricarica).toHaveBeenCalledTimes(1)
  })

  it('DATE_NON_VALIDE fuori periodo: dice entro quali date, e il valore digitato resta', async () => {
    rispostaPatch = { status: 422, body: { error: 'x', codice: 'DATE_NON_VALIDE', motivo: 'fuori_periodo', campo: 'ultimo_giorno_aperto' } }
    monta()
    const ultimo = await screen.findByLabelText(itSettings.annoUltimoGiorno)
    fireEvent.change(ultimo, { target: { value: '2028-01-10' } })
    fireEvent.click(salvaDi(itSettings.annoDateTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent('La data deve stare dentro l’anno, fra il 1/9/2026 e il 31/8/2027.')
    expect((screen.getByLabelText(itSettings.annoUltimoGiorno) as HTMLInputElement).value).toBe('2028-01-10')
  })

  it('DATE_NON_VALIDE per un giorno già passato ha la sua frase', async () => {
    rispostaPatch = { status: 422, body: { error: 'x', codice: 'DATE_NON_VALIDE', motivo: 'ultimo_giorno_nel_passato', campo: 'ultimo_giorno_aperto' } }
    monta()
    await screen.findByLabelText(itSettings.annoUltimoGiorno)
    fireEvent.click(salvaDi(itSettings.annoDateTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent(itSettings.annoDateNelPassato)
  })

  it('in chiusura l’ultimo giorno aperto non si tocca, e non parte nel PATCH', async () => {
    h.perSede = { [SEDE_A]: [riga(2025, 'chiuso'), riga(2026, 'in_chiusura'), riga(2027, 'in_preparazione')] }
    monta()
    const ultimo = await screen.findByLabelText(itSettings.annoUltimoGiorno)
    expect(ultimo).toBeDisabled()
    expect(screen.getByText(itSettings.annoUltimoGiornoBloccato)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(itSettings.annoPreparaDal), { target: { value: '2027-04-01' } })
    fireEvent.click(salvaDi(itSettings.annoDateTitolo))
    await waitFor(() => expect(ultima('PATCH')).not.toBeNull())
    expect(ultima('PATCH')!.body).toEqual({ azione: 'date', prepara_successivo_dal: '2027-04-01' })
  })
})

describe('Impostazioni → Anno scolastico: aprire le iscrizioni', () => {
  const apri = () => screen.getByRole('button', { name: itSettings.annoIscrizioniTitolo })

  it('se mancano i prerequisiti il pulsante è aria-disabled e sotto dice che cosa manca', async () => {
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    scegli('2027/28')
    expect(await screen.findByText(/^Mancano: quota di conferma, quota di nuova iscrizione, moduli per la conferma, moduli per la nuova iscrizione$/)).toBeInTheDocument()
    expect(screen.getByText(itSettings.annoListinoNelleRette)).toBeInTheDocument()
    expect(apri()).toHaveAttribute('aria-disabled', 'true')
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/anni/${S27}`, expect.objectContaining({ headers: expect.objectContaining({ 'x-user-id': USER }) }))
    fireEvent.click(apri())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(chiamate('POST')).toHaveLength(0)
  })

  it('dice solo ciò che manca davvero', async () => {
    rispostaGet = ok({ mancano: ['moduli_nuova'] })
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    scegli('2027/28')
    expect(await screen.findByText('Mancano: moduli per la nuova iscrizione')).toBeInTheDocument()
  })

  it('mentre controlla non si può aprire, e lo dice', async () => {
    let sciogli: (r: unknown) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise((res) => { sciogli = res }))
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    scegli('2027/28')
    expect(await screen.findByText(itSettings.annoMancanoControllo)).toBeInTheDocument()
    expect(apri()).toHaveAttribute('aria-disabled', 'true')
    sciogli({ ok: true, status: 200, json: async () => ({ success: true, data: { mancano: [] } }) })
    await waitFor(() => expect(apri()).toHaveAttribute('aria-disabled', 'false'))
  })

  it('con tutto pronto il pulsante apre un dialogo: i genitori vedranno la quota; Escape lo chiude senza scrivere', async () => {
    rispostaGet = ok({ mancano: [] })
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    scegli('2027/28')
    await waitFor(() => expect(apri()).toHaveAttribute('aria-disabled', 'false'))
    expect(screen.getByText(itSettings.annoIscrizioniPronte)).toBeInTheDocument()
    fireEvent.click(apri())
    const dialogo = await screen.findByRole('dialog')
    expect(dialogo).toHaveTextContent('I genitori vedranno la quota di iscrizione')
    expect(dialogo).toHaveTextContent('Aprire le iscrizioni del 2027/28?')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(chiamate('POST')).toHaveLength(0)
  })

  it('confermando parte il POST sull’anno scelto, e si rilegge il calendario', async () => {
    rispostaGet = ok({ mancano: [] })
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    scegli('2027/28')
    await waitFor(() => expect(apri()).toHaveAttribute('aria-disabled', 'false'))
    fireEvent.click(apri())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: itSettings.annoApriConferma }))
    await waitFor(() => expect(ultima('POST')).not.toBeNull())
    expect(ultima('POST')!.url).toBe(`/api/admin/anni/${S27}/apri-iscrizioni`)
    expect(ultima('POST')!.headers['x-user-id']).toBe(USER)
    await waitFor(() => expect(h.ricarica).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('se il server rifiuta perché nel frattempo manca qualcosa, la schermata lo aggiorna', async () => {
    rispostaGet = ok({ mancano: [] })
    rispostaPost = { status: 409, body: { error: 'x', codice: 'PREREQUISITI_MANCANTI', mancano: ['quota_conferma'] } }
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    scegli('2027/28')
    await waitFor(() => expect(apri()).toHaveAttribute('aria-disabled', 'false'))
    fireEvent.click(apri())
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: itSettings.annoApriConferma }))
    expect(await screen.findByText('Mancano: quota di conferma')).toBeInTheDocument()
    expect(apri()).toHaveAttribute('aria-disabled', 'true')
    expect(h.ricarica).not.toHaveBeenCalled()
  })

  it('se non si riesce a leggere che cosa manca, lo dice e non lascia aprire', async () => {
    rispostaGet = { status: 503, body: { error: 'x', codice: 'CALENDARIO_NON_DISPONIBILE' } }
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    scegli('2027/28')
    expect(await screen.findByRole('alert')).toHaveTextContent('Le impostazioni dell’anno scolastico non sono ancora disponibili')
    expect(apri()).toHaveAttribute('aria-disabled', 'true')
  })

  it('un anno in corso non ha il pulsante «Apri le iscrizioni»', async () => {
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    expect(screen.queryByRole('button', { name: itSettings.annoIscrizioniTitolo })).toBeNull()
    expect(chiamate('GET')).toHaveLength(0)
  })
})

describe('Impostazioni → Anno scolastico: le domande dal sito', () => {
  // Fino alla 4.5 il modulo pubblico non guarda l'interruttore: le domande arrivano sempre nell'anno in corso.
  // La schermata non deve far credere il contrario, quindi dice la verità e non offre nessun comando.
  it('una sola riga che dice la verità, e nessun pulsante per le domande, per ogni anno non chiuso', async () => {
    h.perSede = { [SEDE_A]: treAnni({ domandeAperte: true }) }
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    for (const anno of ['2026/27', '2027/28']) {
      scegli(anno)
      const nota = await screen.findByRole('note')
      expect(nota).toHaveTextContent(itSettings.annoDomandeNota)
      expect(screen.getAllByRole('note')).toHaveLength(1)
      const nomi = screen.queryAllByRole('button').map((x) => x.textContent ?? '')
      expect(nomi.some((n) => /domande/i.test(n))).toBe(false)
    }
    expect(chiamate('PATCH')).toHaveLength(0)
  })

  it('non c’è più il vecchio stato «aperte»/«sospese»: la riga non dipende da domande_aperte', async () => {
    for (const aperte of [true, false]) {
      h.perSede = { [SEDE_A]: treAnni({ domandeAperte: aperte }) }
      const { unmount } = monta()
      expect(await screen.findByRole('note')).toHaveTextContent(itSettings.annoDomandeNota)
      expect(screen.queryByText(/sospese|sono aperte/i)).toBeNull()
      unmount()
    }
  })
})

describe('Impostazioni → Anno scolastico: un anno chiuso è in sola lettura', () => {
  it('nessun campo scrivibile, nessun Salva, una riga che spiega perché', async () => {
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    scegli('2025/26')
    expect(await screen.findByText(itSettings.annoChiusoSolaLettura)).toBeInTheDocument()
    expect(screen.queryByLabelText(itSettings.annoFineTitolo)).toBeNull()
    expect(screen.queryByLabelText(itSettings.annoUltimoGiorno)).toBeNull()
    expect(screen.queryByRole('button', { name: itSettings.salva })).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    expect(document.querySelectorAll('input')).toHaveLength(0)
  })
})

describe('Impostazioni → Anno scolastico: errori che si dicono', () => {
  it('a chi non può, il 403 si dice (e non si cancella ciò che aveva digitato)', async () => {
    rispostaPatch = { status: 403, body: { error: 'Accesso negato', codice: 'SEDE_NON_ACCESSIBILE' } }
    monta()
    const campo = await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.change(campo, { target: { value: '2027-08-20' } })
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent(itSettings.annoPermesso)
    expect((screen.getByLabelText(itSettings.annoFineTitolo) as HTMLInputElement).value).toBe('2027-08-20')
  })

  it('un errore di rete si dice e si registra con logClient, senza dati nel messaggio', async () => {
    retePatch = true
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent(itSettings.annoErroreRete)
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', evento: 'fetch' }))
    const messaggio = String((logClient as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].messaggio)
    expect(messaggio).not.toContain(S26)
  })

  it('un errore del server senza codice noto non lascia la schermata muta', async () => {
    rispostaPatch = { status: 500, body: {} }
    monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByRole('alert')).toHaveTextContent(itSettings.errore)
    expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ stato: 500 }))
  })
})

describe('Impostazioni → Anno scolastico: quando non c’è un calendario', () => {
  it('database senza lo schema dell’anno: lo dice e non mostra campi né chiama nessuna route', async () => {
    h.perSede = {}
    monta()
    expect(await screen.findByText(itSettings.annoCalendarioNonDisponibile)).toBeInTheDocument()
    expect(document.querySelectorAll('input')).toHaveLength(0)
    expect(screen.queryByRole('button')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('finché il calendario arriva: caricamento', () => {
    h.perSede = {}
    h.loading = true
    monta()
    expect(screen.getByText(itSettings.caricamento)).toBeInTheDocument()
    expect(screen.queryByText(itSettings.annoCalendarioNonDisponibile)).toBeNull()
  })

  it('lettura del calendario fallita: lo dice, e non lo scambia per «non disponibile»', () => {
    h.perSede = {}
    h.errore = true
    monta()
    expect(screen.getByText(itSettings.annoCalendarioErrore)).toBeInTheDocument()
    expect(screen.queryByText(itSettings.annoCalendarioNonDisponibile)).toBeNull()
  })

  it('mentre il calendario si rilegge dopo un salvataggio, il modulo resta com’è (e i comandi si fermano)', async () => {
    const { rerender } = monta()
    const campo = await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.change(campo, { target: { value: '2027-08-25' } })
    h.loading = true
    rerender(<AnnoScolasticoSettings userId={USER} scuolaId={SEDE_A} />)
    expect((screen.getByLabelText(itSettings.annoFineTitolo) as HTMLInputElement).value).toBe('2027-08-25')
    expect(salvaDi(itSettings.annoFineTitolo)).toBeDisabled()
  })
})

describe('Impostazioni → Anno scolastico: scrittura in volo e pannello smontato', () => {
  /** Tiene la prossima fetch (la PATCH) in sospeso finché il test non la scioglie. */
  function patchInSospeso() {
    let sciogli: (r: unknown) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise((res) => { sciogli = res }))
    return (cambiato: boolean) =>
      sciogli({ ok: true, status: 200, json: async () => ({ success: true, data: { cambiato } }) })
  }

  it('una scrittura riuscita rilegge il calendario anche se il pannello si smonta mentre è in volo', async () => {
    const errori = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rispondi = patchInSospeso()
    const { unmount } = monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1))
    unmount()
    rispondi(true)
    await waitFor(() => expect(h.ricarica).toHaveBeenCalledTimes(1))
    expect(errori).not.toHaveBeenCalled()
    errori.mockRestore()
  })

  it('«nessuna modifica» con il pannello smontato non rilegge niente', async () => {
    const errori = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rispondi = patchInSospeso()
    const { unmount } = monta()
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1))
    unmount()
    rispondi(false)
    await new Promise((r) => setTimeout(r, 30))
    expect(h.ricarica).not.toHaveBeenCalled()
    expect(errori).not.toHaveBeenCalled()
    errori.mockRestore()
  })

  it('in StrictMode (effetti montati due volte) una scrittura riuscita aggiorna ancora l’esito a schermo', async () => {
    render(
      <StrictMode>
        <AnnoScolasticoSettings userId={USER} scuolaId={SEDE_A} />
      </StrictMode>,
    )
    await screen.findByLabelText(itSettings.annoFineTitolo)
    fireEvent.click(salvaDi(itSettings.annoFineTitolo))
    expect(await screen.findByText(itSettings.salvato)).toBeInTheDocument()
  })
})
