import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import AdminVotazioniPage from '@/app/(dashboard)/admin/votazioni/page'
import type { DettaglioVotazione, RiepilogoVotazione } from '@/lib/votazioni/tipi'

/**
 * Votazioni dei rappresentanti · Task 7 — la pagina `/admin/votazioni`.
 *
 * La sede è UNA e si dichiara (AGENTS.md, Note): la pagina sta dentro `SedeRequired`. Con più sedi attive e
 * nessuna scelta non deve partire niente — né una schermata né una richiesta. Il server è un finto che risponde
 * per URL e metodo e che TIENE lo stato (crea, chiude, elimina): così si prova anche che l'elenco, dopo
 * un'azione nel pannello, mostra la verità nuova e non quella di prima.
 *
 * `?id=` nell'indirizzo apre il pannello; il `useSearchParams` del finto è fermo, quindi l'indirizzo che il
 * codice SCRIVE si legge da `window.location`.
 */

const VOT_1 = '88888888-0000-4000-8000-000000000001'
const VOT_2 = '88888888-0000-4000-8000-000000000002'
const NUOVA = '88888888-0000-4000-8000-000000000003'
const S_INF_3 = '11111111-0000-4000-8000-000000000002'
const S_INF_4 = '11111111-0000-4000-8000-000000000003'
const G_ROSSI = '22222222-0000-4000-8000-000000000001'
const SCADENZA = '2026-07-15T16:00:00.000Z' // 18:00 a Roma (ora legale)

const h = vi.hoisted(() => ({
  stato: {
    sedi: [] as { id: string; nome: string }[],
    sedeCorrente: null as string | null,
    loading: false,
  },
  ricerca: '',
  disponibile: true,
  listaStato: 200,
  lista: [] as unknown[],
  dettagli: {} as Record<string, unknown>,
  chiamate: [] as { metodo: string; url: string; corpo: Record<string, unknown> | null }[],
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.ricerca),
  usePathname: () => '/admin/votazioni',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

// Riproduzione fedele del guard vero (sede-context.tsx): senza UNA sede risolta non rende i figli.
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ sedi: h.stato.sedi, sedeCorrente: h.stato.sedeCorrente, loading: h.stato.loading }),
  SedeRequired: ({ cosa, children }: { cosa?: string; children: (id: string) => React.ReactNode }) =>
    h.stato.loading ? (
      <div>attendi</div>
    ) : h.stato.sedeCorrente ? (
      <>{children(h.stato.sedeCorrente)}</>
    ) : (
      <div data-testid="sede-notice">{cosa}</div>
    ),
}))

function riepilogo(over: Partial<RiepilogoVotazione> = {}): RiepilogoVotazione {
  return {
    id: VOT_1,
    scuolaId: SEDE_A,
    titolo: 'Elezioni 2026',
    scadenza: SCADENZA,
    chiusaIl: null,
    stato: 'aperta',
    rappresentanteIstituto: true,
    classi: [
      { sectionId: S_INF_3, nome: '3 ANNI', grado: 'infanzia' },
      { sectionId: S_INF_4, nome: '4 ANNI', grado: 'infanzia' },
    ],
    votanti: 12,
    creataIl: '2026-06-01T08:00:00.000Z',
    ...over,
  }
}

function dettaglio(r: RiepilogoVotazione): DettaglioVotazione {
  return {
    ...r,
    candidatiIstituto: [],
    schede: r.classi.map((c) => ({
      ambito: 'classe' as const,
      sectionId: c.sectionId,
      nome: c.nome,
      aventiDiritto: 30,
      votanti: r.votanti,
      candidati: [],
      eletti: [],
      voti: [],
    })),
  }
}

/** Mette una votazione nel finto server: nell'elenco e nel dettaglio. */
function inserisci(r: RiepilogoVotazione) {
  h.lista = [...h.lista.filter((x) => (x as RiepilogoVotazione).id !== r.id), r]
  h.dettagli[r.id] = dettaglio(r)
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } })

const letture = (parte: string) => h.chiamate.filter((c) => c.metodo === 'GET' && c.url.startsWith(parte))
const elenco = () => letture('/api/admin/votazioni?')
const idNellIndirizzo = () => new URLSearchParams(window.location.search).get('id')

beforeEach(() => {
  h.stato.sedi = [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ]
  h.stato.sedeCorrente = SEDE_A
  h.stato.loading = false
  h.ricerca = ''
  h.disponibile = true
  h.listaStato = 200
  h.lista = []
  h.dettagli = {}
  h.chiamate = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const metodo = init?.method ?? 'GET'
      const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      h.chiamate.push({ metodo, url: url.pathname + url.search, corpo })

      if (url.pathname === '/api/admin/votazioni' && metodo === 'GET') {
        if (h.listaStato !== 200) return json({ error: 'x' }, h.listaStato)
        return json({ disponibile: h.disponibile, votazioni: h.disponibile ? h.lista : [] })
      }
      if (url.pathname === '/api/admin/votazioni' && metodo === 'POST') {
        const nuova = riepilogo({
          id: NUOVA,
          titolo: String(corpo?.titolo ?? ''),
          rappresentanteIstituto: corpo?.rappresentanteIstituto === true,
          classi: [{ sectionId: S_INF_3, nome: '3 ANNI', grado: 'infanzia' }],
          votanti: 0,
        })
        inserisci(nuova)
        return json({ id: NUOVA }, 201)
      }
      if (url.pathname === '/api/admin/sections/scoped') {
        return json({
          success: true,
          data: [{ scuolaId: SEDE_A, scuolaNome: 'Sede A', sezioni: [{ id: S_INF_3, name: '3 ANNI', school_type: 'infanzia' }] }],
        })
      }
      if (url.pathname === '/api/admin/votazioni/genitori') {
        return json({ genitori: [{ utenteId: G_ROSSI, nome: 'Rossi Mario' }] })
      }
      const m = url.pathname.match(/^\/api\/admin\/votazioni\/([^/]+)$/)
      if (m) {
        const esistente = h.dettagli[m[1]] as DettaglioVotazione | undefined
        if (!esistente) return json({ error: 'x', codice: 'VOTAZIONE_NON_TROVATA' }, 404)
        if (metodo === 'GET') return json({ votazione: esistente })
        if (metodo === 'PATCH' && corpo?.azione === 'chiudi') {
          inserisci({ ...riepilogo({ ...esistente }), stato: 'chiusa', chiusaIl: '2026-07-12T10:00:00.000Z' })
          return json({ ok: true })
        }
        if (metodo === 'DELETE') {
          h.lista = h.lista.filter((x) => (x as RiepilogoVotazione).id !== m[1])
          delete h.dettagli[m[1]]
          return json({ ok: true })
        }
      }
      return json({ error: 'non previsto' }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

const nuovaVotazione = () => screen.queryAllByRole('button', { name: 'Nuova votazione' })
const rigaDi = (titolo: string) => screen.getByRole('button', { name: titolo }).closest('tr') as HTMLElement
const celle = (riga: HTMLElement) => within(riga).getAllByRole('cell').map((c) => c.textContent)

// ─────────────────────────────────────────────────────────────────────────────
describe('/admin/votazioni · la sede', () => {
  it('con più sedi attive e nessuna scelta mostra l’invito e NON chiede niente al server', () => {
    h.stato.sedeCorrente = null
    render(<AdminVotazioniPage />)

    expect(screen.getByTestId('sede-notice').textContent).toBe('le votazioni')
    expect(nuovaVotazione()).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('mentre le sedi si caricano non monta niente', () => {
    h.stato.loading = true
    render(<AdminVotazioniPage />)

    expect(fetch).not.toHaveBeenCalled()
  })

  it('con una sede risolta mostra il titolo e chiede l’elenco PER QUELLA sede', async () => {
    h.stato.sedeCorrente = SEDE_B
    inserisci(riepilogo())
    render(<AdminVotazioniPage />)

    expect(screen.getByRole('heading', { name: 'Votazioni dei rappresentanti' })).toBeTruthy()
    await screen.findByRole('button', { name: 'Elezioni 2026' })
    expect(elenco().map((c) => c.url)).toEqual([`/api/admin/votazioni?scuolaId=${SEDE_B}`])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('/admin/votazioni · l’elenco', () => {
  it('lo schema assente (`disponibile: false`) mostra l’avviso e NESSUN pulsante per aprirne una', async () => {
    h.disponibile = false
    render(<AdminVotazioniPage />)

    await screen.findByText('Le votazioni non sono ancora disponibili')
    expect(nuovaVotazione()).toHaveLength(0)
  })

  it('senza votazioni: «Nessuna votazione» e UN solo «Nuova votazione»', async () => {
    render(<AdminVotazioniPage />)

    await screen.findByText('Nessuna votazione')
    expect(nuovaVotazione()).toHaveLength(1)
  })

  it('ogni riga: titolo (un vero pulsante), stato, scadenza di Roma, classi con «+ istituto», votanti', async () => {
    inserisci(riepilogo())
    inserisci(
      riepilogo({
        id: VOT_2,
        titolo: 'Elezioni d’istituto',
        stato: 'chiusa',
        chiusaIl: '2026-07-12T10:00:00.000Z',
        classi: [],
        votanti: 0,
        rappresentanteIstituto: true,
      }),
    )
    render(<AdminVotazioniPage />)

    await screen.findByRole('button', { name: 'Elezioni 2026' })
    expect(celle(rigaDi('Elezioni 2026'))).toEqual(['Elezioni 2026', 'Aperta', '15/07/2026, 18:00', '3 ANNI, 4 ANNI + istituto', '12'])
    expect(celle(rigaDi('Elezioni d’istituto'))).toEqual(['Elezioni d’istituto', 'Chiusa', '15/07/2026, 18:00', 'Solo istituto', '0'])
    // Con l'elenco pieno il pulsante è nella barra, e uno solo.
    expect(nuovaVotazione()).toHaveLength(1)
  })

  it('una lettura fallita non è un elenco vuoto: lo dice, offre «Riprova» e non offre «Nuova votazione»', async () => {
    h.listaStato = 500
    inserisci(riepilogo())
    render(<AdminVotazioniPage />)

    await screen.findByText('Non è stato possibile leggere l’elenco')
    expect(nuovaVotazione()).toHaveLength(0)
    expect(screen.queryByText('Nessuna votazione')).toBeNull()

    h.listaStato = 200
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))

    await screen.findByRole('button', { name: 'Elezioni 2026' })
    expect(elenco()).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('/admin/votazioni · il pannello e l’indirizzo', () => {
  it('cliccare una riga apre il dettaglio e scrive `?id=` nell’indirizzo; chiudere lo toglie', async () => {
    inserisci(riepilogo())
    render(<AdminVotazioniPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Elezioni 2026' }))

    await screen.findByRole('heading', { name: 'Elezioni 2026' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(idNellIndirizzo()).toBe(VOT_1)
    expect(letture(`/api/admin/votazioni/${VOT_1}`)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(idNellIndirizzo()).toBeNull()
  })

  it('arrivando con `?id=` valido il pannello è già aperto su quella votazione', async () => {
    inserisci(riepilogo())
    h.ricerca = `id=${VOT_1}`
    render(<AdminVotazioniPage />)

    await screen.findByRole('heading', { name: 'Elezioni 2026' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('un `?id=` che non è un uuid si ignora: nessun pannello, nessuna lettura del dettaglio', async () => {
    inserisci(riepilogo())
    h.ricerca = 'id=../../etc/passwd'
    render(<AdminVotazioniPage />)

    await screen.findByRole('button', { name: 'Elezioni 2026' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.chiamate.filter((c) => c.url.startsWith('/api/admin/votazioni/'))).toHaveLength(0)
  })

  it('un `?id=` di una votazione che non c’è lo dice nel pannello, senza rompere la pagina', async () => {
    inserisci(riepilogo())
    h.ricerca = `id=${VOT_2}`
    render(<AdminVotazioniPage />)

    await screen.findByText('Questa votazione non esiste più o non è della tua sede.')
    expect(screen.getByRole('button', { name: 'Elezioni 2026' })).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('/admin/votazioni · dopo un’azione nel pannello l’elenco dice la verità nuova', () => {
  it('«Chiudi ora»: la riga dell’elenco passa a «Chiusa» senza ricaricare la pagina', async () => {
    inserisci(riepilogo())
    render(<AdminVotazioniPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Elezioni 2026' }))
    await screen.findByRole('heading', { name: 'Elezioni 2026' })
    expect(within(rigaDi('Elezioni 2026')).getByText('Aperta')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi ora' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, chiudi' }))

    // La riga dell'elenco, non il badge del pannello.
    await within(rigaDi('Elezioni 2026')).findByText('Chiusa')
    expect(elenco()).toHaveLength(2)
    // Il pannello resta aperto sulla stessa votazione.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(idNellIndirizzo()).toBe(VOT_1)
  })

  it('«Elimina»: il pannello si chiude, `?id=` se ne va e la riga sparisce dall’elenco', async () => {
    inserisci(riepilogo({ id: VOT_2, titolo: 'Elezioni d’istituto', classi: [], votanti: 0 }))
    inserisci(riepilogo())
    render(<AdminVotazioniPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Elezioni d’istituto' }))
    await screen.findByRole('heading', { name: 'Elezioni d’istituto' })

    fireEvent.click(screen.getByRole('button', { name: 'Elimina' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }))

    // La riga c'era: la sua scomparsa è la prova che l'elenco è stato riletto.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Elezioni d’istituto' })).toBeNull())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(idNellIndirizzo()).toBeNull()
    expect(screen.getByRole('button', { name: 'Elezioni 2026' })).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('/admin/votazioni · aprire una votazione', () => {
  it('«Nuova votazione» apre il modulo; creata, il modulo si chiude, l’elenco si rilegge e si apre il dettaglio', async () => {
    inserisci(riepilogo())
    render(<AdminVotazioniPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Nuova votazione' }))

    expect(await screen.findByRole('dialog', { name: 'Apri una votazione' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('checkbox', { name: '3 ANNI' }))
    fireEvent.change(screen.getByLabelText('Titolo'), { target: { value: 'Elezioni di novembre' } })
    fireEvent.change(screen.getByLabelText('Giorno'), { target: { value: '05/12/2030' } })
    fireEvent.change(screen.getByLabelText('Ora'), { target: { value: '16:45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apri votazione' }))

    // Si apre il dettaglio di QUELLA votazione, con il suo titolo.
    await screen.findByRole('heading', { name: 'Elezioni di novembre' })
    expect(screen.queryByRole('dialog', { name: 'Apri una votazione' })).toBeNull()
    expect(idNellIndirizzo()).toBe(NUOVA)
    const post = h.chiamate.filter((c) => c.metodo === 'POST')
    expect(post).toHaveLength(1)
    expect(post[0].corpo).toMatchObject({ scuolaId: SEDE_A, titolo: 'Elezioni di novembre', scadenza: '2030-12-05T16:45', sectionIds: [S_INF_3] })
    // L'elenco è stato riletto e la riga nuova c'è.
    await waitFor(() => expect(elenco()).toHaveLength(2))
    await screen.findByRole('button', { name: 'Elezioni di novembre' })
  })

  it('«Annulla» richiude il modulo senza scrivere', async () => {
    render(<AdminVotazioniPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Nuova votazione' }))
    await screen.findByRole('dialog', { name: 'Apri una votazione' })

    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.chiamate.filter((c) => c.metodo === 'POST')).toHaveLength(0)
  })
})
