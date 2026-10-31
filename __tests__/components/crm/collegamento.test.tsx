import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import type { BambinoRow, SchedaRow } from '@/lib/crm/tipi'
import { BadgeCollegamento } from '@/components/features/crm/collegamento/BadgeCollegamento'
import { AssociaDomanda } from '@/components/features/crm/collegamento/AssociaDomanda'
import { AvvisoDomandaDaAssociare } from '@/components/features/crm/collegamento/AvvisoDomandaDaAssociare'

/**
 * CRM della segreteria · Compito 4.3 — il badge del collegamento, l'associazione a mano e l'avviso
 * «è arrivata una domanda».
 *
 * La rete è finta ma ESIGENTE: ogni chiamata deve avere una rotta preparata, e una chiamata che non
 * ne ha fa fallire il test (`afterEach`). Un finto che risponde sempre «ok» sarebbe verde anche con
 * un componente che non chiama niente.
 *
 * I dati sono tutti di prova («Famiglia Prova»): nessun nome vero, nessun codice fiscale.
 */

const SCHEDA = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c'
const BAMBINO = '7d7d7d7d-7d7d-47d7-87d7-7d7d7d7d7d7d'
const BAMBINO_2 = '8e8e8e8e-8e8e-48e8-88e8-8e8e8e8e8e8e'
const DOMANDA = '9f9f9f9f-9f9f-49f9-89f9-9f9f9f9f9f9f'
const ALTRA_DOMANDA = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1'

type Chiamata = { url: string; metodo: string; corpo: unknown }
type Rotta = { metodo: string; contiene: string; risposta: () => Promise<Response> | Response }

const h = vi.hoisted(() => ({
  chiamate: [] as { url: string; metodo: string; corpo: unknown }[],
  rotte: [] as { metodo: string; contiene: string; risposta: () => Promise<Response> | Response }[],
  nonPreviste: [] as string[],
}))

const json = (stato: number, corpo: unknown) => () =>
  new Response(JSON.stringify(corpo), { status: stato, headers: { 'content-type': 'application/json' } })

/** Prepara una risposta per la prima chiamata `metodo` il cui indirizzo contiene `contiene`. */
function rotta(metodo: string, contiene: string, risposta: Rotta['risposta']) {
  h.rotte.push({ metodo, contiene, risposta })
}

const chiamate = (metodo: string, contiene = '') =>
  h.chiamate.filter((c) => c.metodo === metodo && c.url.includes(contiene))

const riga = (extra: Record<string, unknown> = {}) => ({
  domandaId: DOMANDA,
  figlio: 0,
  nome: 'Bimbo',
  cognome: 'Prova',
  dataNascita: '2023-04-12',
  genitore: 'Famiglia Prova',
  ricevutaIl: '2026-10-20T09:30:00.000Z',
  stato: 'pending',
  giaCollegato: false,
  ...extra,
})

const bambino = (extra: Partial<BambinoRow> = {}): BambinoRow => ({
  id: BAMBINO,
  scuola_id: SEDE_A,
  scheda_id: SCHEDA,
  nome: 'Bimbo Prova',
  data_nascita: '2023-04-12',
  anno_ingresso: 'prossimo',
  esito: 'aperto',
  motivo_perdita: null,
  motivo_nota: null,
  esito_origine: null,
  esito_da: null,
  esito_il: null,
  domanda_id: null,
  domanda_figlio: null,
  domanda_collegata_il: null,
  nota_collegamento: null,
  da_verificare: false,
  quota_saldata: false,
  quota_importo: null,
  quota_metodo: null,
  quota_anno: null,
  quota_stato: null,
  quota_blocco_motivo: null,
  quota_saldata_il: null,
  quota_segnata_da: null,
  quota_cassa_movimento_id: null,
  quota_pagamento_id: null,
  alunno_id: null,
  alunno_collegato_il: null,
  creata_il: '2026-10-01T08:00:00.000Z',
  aggiornata_il: '2026-10-01T08:00:00.000Z',
  ...extra,
})

const scheda = (extra: Partial<SchedaRow> = {}): SchedaRow => ({
  id: SCHEDA,
  scuola_id: SEDE_A,
  genitore_nome: 'Famiglia Prova',
  telefono1: '333 000 0001',
  telefono2: null,
  email1: 'prova@example.com',
  email2: null,
  telefoni_norm: [],
  email_norm: [],
  origine: 'sito',
  routine: null,
  paura: null,
  desiderio: null,
  domanda_da_associare: null,
  creato_da: null,
  creato_via: 'segreteria',
  creata_il: '2026-10-01T08:00:00.000Z',
  aggiornata_il: '2026-10-01T08:00:00.000Z',
  anonimizzata_il: null,
  ...extra,
})

beforeEach(() => {
  h.chiamate.length = 0
  h.rotte.length = 0
  h.nonPreviste.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const metodo = (init?.method ?? 'GET').toUpperCase()
      const corpo = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      h.chiamate.push({ url, metodo, corpo } satisfies Chiamata)
      // L'ultima rotta preparata che combacia vince: una più specifica si aggiunge DOPO quella larga.
      let i = -1
      for (let k = h.rotte.length - 1; k >= 0; k--) {
        if (h.rotte[k].metodo === metodo && url.includes(h.rotte[k].contiene)) {
          i = k
          break
        }
      }
      if (i === -1) {
        h.nonPreviste.push(`${metodo} ${url}`)
        return new Response('{}', { status: 599 })
      }
      return h.rotte[i].risposta()
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Una chiamata senza rotta è un componente che parla con qualcuno che il test non ha previsto.
  expect(h.nonPreviste).toEqual([])
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// BadgeCollegamento · una riga della tabella, un test
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('BadgeCollegamento · un solo badge, nell’ordine della tabella', () => {
  const badge = (container: HTMLElement) => Array.from(container.querySelectorAll('[data-collegamento]'))

  it('da_verificare → «Domanda respinta — da verificare»', () => {
    const { container } = render(<BadgeCollegamento bambino={bambino({ da_verificare: true })} />)
    expect(badge(container).map((b) => b.textContent)).toEqual(['Domanda respinta — da verificare'])
    expect(badge(container)[0].getAttribute('data-collegamento')).toBe('da_verificare')
  })

  it('iscritto con domanda_id → «Iscritto · domanda collegata»', () => {
    const { container } = render(
      <BadgeCollegamento bambino={bambino({ esito: 'iscritto', domanda_id: DOMANDA, domanda_figlio: 0 })} />,
    )
    expect(badge(container).map((b) => b.textContent)).toEqual(['Iscritto · domanda collegata'])
  })

  it('iscritto, domanda_id nullo e domanda_collegata_il valorizzato → «Iscritto · domanda non più presente»', () => {
    const { container } = render(
      <BadgeCollegamento
        bambino={bambino({ esito: 'iscritto', domanda_id: null, domanda_collegata_il: '2026-10-05T10:00:00.000Z' })}
      />,
    )
    expect(badge(container).map((b) => b.textContent)).toEqual(['Iscritto · domanda non più presente'])
  })

  it('iscritto senza domanda → «Iscritto a mano · nessuna domanda collegata»', () => {
    const { container } = render(<BadgeCollegamento bambino={bambino({ esito: 'iscritto' })} />)
    expect(badge(container).map((b) => b.textContent)).toEqual(['Iscritto a mano · nessuna domanda collegata'])
  })

  it('nota_collegamento altra_domanda → «È arrivata un’altra domanda»', () => {
    const { container } = render(<BadgeCollegamento bambino={bambino({ nota_collegamento: 'altra_domanda' })} />)
    expect(badge(container).map((b) => b.textContent)).toEqual(['È arrivata un’altra domanda'])
  })

  it('l’ordine: da_verificare vince su «iscritto · domanda collegata» e il badge resta UNO', () => {
    const { container } = render(
      <BadgeCollegamento
        bambino={bambino({ da_verificare: true, esito: 'iscritto', domanda_id: DOMANDA, domanda_figlio: 0 })}
      />,
    )
    expect(badge(container)).toHaveLength(1)
    expect(badge(container)[0].textContent).toBe('Domanda respinta — da verificare')
  })

  it('l’ordine: «iscritto» vince su «un’altra domanda» (è la tabella del piano)', () => {
    const { container } = render(
      <BadgeCollegamento bambino={bambino({ esito: 'iscritto', nota_collegamento: 'altra_domanda' })} />,
    )
    expect(badge(container).map((b) => b.textContent)).toEqual(['Iscritto a mano · nessuna domanda collegata'])
  })

  it('un bambino aperto, senza note, non porta nessun badge', () => {
    const { container } = render(<BadgeCollegamento bambino={bambino()} />)
    expect(badge(container)).toHaveLength(0)
    expect(container.textContent).toBe('')
  })

  it('un bambino aperto con una domanda collegata non dice «Iscritto»: non lo è', () => {
    const { container } = render(
      <BadgeCollegamento bambino={bambino({ esito: 'aperto', domanda_id: DOMANDA, domanda_figlio: 0 })} />,
    )
    expect(container.textContent).not.toContain('Iscritto')
  })

  it('i cinque testi del badge esistono anche in inglese, e diversi dall’italiano', async () => {
    const it = (await import('../../../messages/it/crmCollegamento.json')).default as Record<string, string>
    const en = (await import('../../../messages/en/crmCollegamento.json')).default as Record<string, string>
    const chiavi = Object.keys(it).filter((k) => k.startsWith('badge'))
    expect(chiavi).toHaveLength(5)
    expect(Object.keys(en).filter((k) => k.startsWith('badge')).sort()).toEqual([...chiavi].sort())
    for (const k of chiavi) expect(en[k]).not.toBe(it[k])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AssociaDomanda
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('AssociaDomanda · il pulsante giusto per lo stato del bambino', () => {
  it('senza domanda collegata: «Associa al bambino» e niente «Scollega»', () => {
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Associa al bambino' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Scollega' })).toBeNull()
  })

  it('con una domanda collegata: «Scollega» e niente «Associa al bambino»', () => {
    render(
      <AssociaDomanda
        scuolaId={SEDE_A}
        schedaId={SCHEDA}
        bambino={bambino({ domanda_id: DOMANDA, domanda_figlio: 0 })}
        onCollegato={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Scollega' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Associa al bambino' })).toBeNull()
  })

  it('finché non si clicca non parte nessuna chiamata', () => {
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)
    expect(h.chiamate).toHaveLength(0)
  })
})

describe('AssociaDomanda · la ricerca', () => {
  it('apre la ricerca e legge GET /domande con la sede dichiarata', async () => {
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))

    expect(await screen.findByText('Bimbo Prova')).toBeTruthy()
    const letture = chiamate('GET', '/api/admin/crm/domande')
    expect(letture).toHaveLength(1)
    const url = new URL(letture[0].url, 'http://localhost')
    expect(url.searchParams.get('scuolaId')).toBe(SEDE_A)
    expect(url.searchParams.get('domandaId')).toBeNull()
    // La ricerca libera non porta il filtro su una domanda sola.
    expect(url.searchParams.get('q')).toBeNull()
  })

  it('mostra il minimo per scegliere: nome, nascita, genitore, ricevimento', async () => {
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))

    const dialogo = await screen.findByRole('dialog')
    await within(dialogo).findByText('Bimbo Prova')
    expect(dialogo.textContent).toContain('12/04/2023')
    expect(dialogo.textContent).toContain('Famiglia Prova')
    expect(dialogo.textContent).toContain('20/10/2026')
  })

  it('cerca: il testo digitato va in ?q= e l’elenco si rilegge', async () => {
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    rotta('GET', 'q=Prova', json(200, { data: [riga({ nome: 'Altro', cognome: 'Prova', figlio: 1 })] }))
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))
    await screen.findByText('Bimbo Prova')

    fireEvent.change(screen.getByLabelText('Cerca per nome del bambino o del genitore'), { target: { value: ' Prova ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }))

    expect(await screen.findByText('Altro Prova')).toBeTruthy()
    expect(screen.queryByText('Bimbo Prova')).toBeNull()
    const ricerca = chiamate('GET', 'q=').at(-1)!
    expect(new URL(ricerca.url, 'http://localhost').searchParams.get('q')).toBe('Prova')
  })

  it('nessuna domanda → lo dice', async () => {
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [] }))
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))
    expect(await screen.findByText('Nessuna domanda trovata.')).toBeTruthy()
  })

  it('lettura fallita → un avviso, mai una lista vuota che sembra «nessuna domanda»', async () => {
    rotta('GET', '/api/admin/crm/domande', json(500, { error: 'boom', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }))
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('L’operazione non è riuscita. Riprova fra poco.')
    expect(screen.queryByText('Nessuna domanda trovata.')).toBeNull()
  })

  it('una risposta lenta di una ricerca vecchia non copre quella nuova', async () => {
    let sblocca: (r: Response) => void = () => {}
    // La PRIMA lettura (senza q) resta appesa; la seconda (q=Nuova) risponde subito.
    rotta('GET', '/api/admin/crm/domande', () => new Promise<Response>((ok) => (sblocca = ok)))
    rotta('GET', 'q=Nuova', json(200, { data: [riga({ nome: 'Nuovo', cognome: 'Prova' })] }))
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))
    await waitFor(() => expect(chiamate('GET')).toHaveLength(1))

    fireEvent.change(screen.getByLabelText('Cerca per nome del bambino o del genitore'), { target: { value: 'Nuova' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }))
    await screen.findByText('Nuovo Prova')

    // Ora arriva la risposta vecchia: non deve sostituire l'elenco.
    sblocca(new Response(JSON.stringify({ data: [riga({ nome: 'Vecchio', cognome: 'Prova' })] }), { status: 200 }))
    await new Promise((ok) => setTimeout(ok, 20))
    expect(screen.queryByText('Vecchio Prova')).toBeNull()
    expect(screen.getByText('Nuovo Prova')).toBeTruthy()
  })
})

describe('AssociaDomanda · associa', () => {
  it('associa: sceglie il figlio e chiama PUT con domandaId e figlio', async () => {
    rotta(
      'GET',
      '/api/admin/crm/domande',
      json(200, { data: [riga({ nome: 'Primo', figlio: 0 }), riga({ nome: 'Secondo', figlio: 1 })] }),
    )
    rotta('PUT', `/api/admin/crm/schede/${SCHEDA}/bambini/${BAMBINO}/collegamento`, json(200, { ok: true }))
    const onCollegato = vi.fn()
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={onCollegato} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))
    await screen.findByText('Primo Prova')

    fireEvent.click(screen.getByRole('button', { name: 'Collega la domanda di Secondo Prova' }))

    await waitFor(() => expect(onCollegato).toHaveBeenCalledTimes(1))
    const put = chiamate('PUT')
    expect(put).toHaveLength(1)
    expect(put[0].url).toBe(`/api/admin/crm/schede/${SCHEDA}/bambini/${BAMBINO}/collegamento`)
    // Il corpo è ESATTAMENTE questo: né la sede né altro, la sede la decide il server dalla scheda.
    expect(put[0].corpo).toEqual({ domandaId: DOMANDA, figlio: 1 })
    // E la finestra si chiude.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('un figlio già collegato a un altro bambino non si può scegliere', async () => {
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga({ giaCollegato: true })] }))
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))
    await screen.findByText('Bimbo Prova')

    const scelta = screen.getByRole('button', { name: 'Collega la domanda di Bimbo Prova' }) as HTMLButtonElement
    expect(scelta.disabled).toBe(true)
    expect(screen.getByText('Già collegata a un altro bambino')).toBeTruthy()
    fireEvent.click(scelta)
    expect(chiamate('PUT')).toHaveLength(0)
  })

  it('PUT respinto con GIA_COLLEGATO → il testo del catalogo, la finestra resta, onCollegato no', async () => {
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    rotta(
      'PUT',
      '/collegamento',
      json(409, { error: 'La domanda è già collegata', codice: 'GIA_COLLEGATO' }),
    )
    const onCollegato = vi.fn()
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={onCollegato} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))
    await screen.findByText('Bimbo Prova')

    fireEvent.click(screen.getByRole('button', { name: 'Collega la domanda di Bimbo Prova' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('Questa domanda di iscrizione è già collegata a un altro bambino.')
    expect(onCollegato).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('PUT che non risponde (rete) → l’avviso generico e il pulsante torna libero', async () => {
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    rotta('PUT', '/collegamento', () => Promise.reject(new TypeError('Failed to fetch')))
    const onCollegato = vi.fn()
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={onCollegato} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))
    await screen.findByText('Bimbo Prova')

    fireEvent.click(screen.getByRole('button', { name: 'Collega la domanda di Bimbo Prova' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('Non sono riuscito a collegare la domanda. Riprova fra qualche istante.')
    expect(onCollegato).not.toHaveBeenCalled()
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Collega la domanda di Bimbo Prova' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
  })

  it('un secondo clic mentre il PUT è in volo non ne fa partire un secondo', async () => {
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    let finisci: (r: Response) => void = () => {}
    rotta('PUT', '/collegamento', () => new Promise<Response>((ok) => (finisci = ok)))
    const onCollegato = vi.fn()
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={bambino()} onCollegato={onCollegato} />)
    fireEvent.click(screen.getByRole('button', { name: 'Associa al bambino' }))
    await screen.findByText('Bimbo Prova')

    const scelta = screen.getByRole('button', { name: 'Collega la domanda di Bimbo Prova' })
    fireEvent.click(scelta)
    fireEvent.click(scelta)
    fireEvent.click(scelta)

    expect(chiamate('PUT')).toHaveLength(1)
    finisci(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await waitFor(() => expect(onCollegato).toHaveBeenCalledTimes(1))
  })
})

describe('AssociaDomanda · scollega', () => {
  const collegato = () => bambino({ esito: 'iscritto', domanda_id: DOMANDA, domanda_figlio: 0 })

  it('«Scollega» prima chiede conferma: finché non si conferma la rete non si tocca', () => {
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={collegato()} onCollegato={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scollega' }))

    expect(screen.getByText('Scollegare la domanda da questo bambino?')).toBeTruthy()
    expect(h.chiamate).toHaveLength(0)
  })

  it('«Annulla» chiude la domanda di conferma senza chiamare niente', () => {
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={collegato()} onCollegato={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scollega' }))
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))

    expect(screen.queryByText('Scollegare la domanda da questo bambino?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Scollega' })).toBeTruthy()
    expect(h.chiamate).toHaveLength(0)
  })

  it('confermando chiama DELETE sul collegamento di QUEL bambino e poi onCollegato()', async () => {
    rotta('DELETE', `/api/admin/crm/schede/${SCHEDA}/bambini/${BAMBINO}/collegamento`, json(200, { ok: true }))
    const onCollegato = vi.fn()
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={collegato()} onCollegato={onCollegato} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scollega' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, scollega' }))

    await waitFor(() => expect(onCollegato).toHaveBeenCalledTimes(1))
    const del = chiamate('DELETE')
    expect(del).toHaveLength(1)
    expect(del[0].url).toBe(`/api/admin/crm/schede/${SCHEDA}/bambini/${BAMBINO}/collegamento`)
    expect(del[0].corpo).toBeUndefined()
  })

  it('DELETE respinto → il testo del catalogo e onCollegato non scatta', async () => {
    rotta('DELETE', '/collegamento', json(404, { error: 'x', codice: 'SCHEDA_NON_TROVATA' }))
    const onCollegato = vi.fn()
    render(<AssociaDomanda scuolaId={SEDE_A} schedaId={SCHEDA} bambino={collegato()} onCollegato={onCollegato} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scollega' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, scollega' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent?.length).toBeGreaterThan(0)
    expect(avviso.textContent).not.toContain('SCHEDA_NON_TROVATA')
    expect(onCollegato).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// AvvisoDomandaDaAssociare
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('AvvisoDomandaDaAssociare', () => {
  const conAvviso = () => scheda({ domanda_da_associare: DOMANDA })

  it('senza domanda_da_associare non si vede niente', () => {
    const { container } = render(<AvvisoDomandaDaAssociare scheda={scheda()} onAggiornata={vi.fn()} />)
    expect(container.textContent).toBe('')
    expect(h.chiamate).toHaveLength(0)
  })

  it('con domanda_da_associare dice «È arrivata una domanda: associa il bambino»', () => {
    render(<AvvisoDomandaDaAssociare scheda={conAvviso()} onAggiornata={vi.fn()} />)
    expect(screen.getByText('È arrivata una domanda: associa il bambino')).toBeTruthy()
    // Solo a vederlo non si legge niente: la rete parte al clic.
    expect(h.chiamate).toHaveLength(0)
  })

  it('un solo bambino libero: apre la ricerca già filtrata su QUELLA domanda, con la sede della scheda', async () => {
    rotta('GET', `/api/admin/crm/schede/${SCHEDA}`, json(200, { scheda: conAvviso(), bambini: [bambino()] }))
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    rotta('PUT', `/bambini/${BAMBINO}/collegamento`, json(200, { ok: true }))
    const onAggiornata = vi.fn()
    render(<AvvisoDomandaDaAssociare scheda={conAvviso()} onAggiornata={onAggiornata} />)

    fireEvent.click(screen.getByRole('button', { name: 'Scegli la domanda' }))

    await screen.findByText('Bimbo Prova')
    const lettura = new URL(chiamate('GET', '/api/admin/crm/domande')[0].url, 'http://localhost')
    expect(lettura.searchParams.get('domandaId')).toBe(DOMANDA)
    expect(lettura.searchParams.get('scuolaId')).toBe(SEDE_A)
    // La domanda è già decisa: niente campo di testo.
    expect(screen.queryByLabelText('Cerca per nome del bambino o del genitore')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Collega la domanda di Bimbo Prova' }))

    await waitFor(() => expect(onAggiornata).toHaveBeenCalledTimes(1))
    expect(chiamate('PUT')[0].corpo).toEqual({ domandaId: DOMANDA, figlio: 0 })
    expect(chiamate('PUT')[0].url).toBe(`/api/admin/crm/schede/${SCHEDA}/bambini/${BAMBINO}/collegamento`)
  })

  it('due bambini liberi: chiede per quale, e il PUT va a quello scelto', async () => {
    rotta(
      'GET',
      `/api/admin/crm/schede/${SCHEDA}`,
      json(200, {
        scheda: conAvviso(),
        bambini: [
          bambino({ id: BAMBINO, nome: 'Primo Prova' }),
          bambino({ id: BAMBINO_2, nome: 'Secondo Prova' }),
        ],
      }),
    )
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    rotta('PUT', `/bambini/${BAMBINO_2}/collegamento`, json(200, { ok: true }))
    const onAggiornata = vi.fn()
    render(<AvvisoDomandaDaAssociare scheda={conAvviso()} onAggiornata={onAggiornata} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scegli la domanda' }))

    expect(await screen.findByText('Per quale bambino?')).toBeTruthy()
    // Finché non si sceglie, la ricerca delle domande non parte.
    expect(chiamate('GET', '/api/admin/crm/domande')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Secondo Prova' }))
    await screen.findByText('Bimbo Prova')
    fireEvent.click(screen.getByRole('button', { name: 'Collega la domanda di Bimbo Prova' }))

    await waitFor(() => expect(onAggiornata).toHaveBeenCalledTimes(1))
    expect(chiamate('PUT')).toHaveLength(1)
    expect(chiamate('PUT')[0].url).toContain(`/bambini/${BAMBINO_2}/collegamento`)
  })

  it('i bambini che hanno già una domanda non si offrono', async () => {
    rotta(
      'GET',
      `/api/admin/crm/schede/${SCHEDA}`,
      json(200, {
        scheda: conAvviso(),
        bambini: [
          bambino({ id: BAMBINO, nome: 'Collegato Prova', domanda_id: ALTRA_DOMANDA, domanda_figlio: 0 }),
          bambino({ id: BAMBINO_2, nome: 'Libero Prova' }),
        ],
      }),
    )
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [riga()] }))
    render(<AvvisoDomandaDaAssociare scheda={conAvviso()} onAggiornata={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scegli la domanda' }))

    // Uno solo libero → si va dritti alla ricerca, senza chiedere «per quale».
    await screen.findByText('Bimbo Prova')
    expect(screen.queryByText('Per quale bambino?')).toBeNull()
    expect(screen.queryByText('Collegato Prova')).toBeNull()
  })

  it('nessun bambino libero → lo dice e non cerca domande', async () => {
    rotta(
      'GET',
      `/api/admin/crm/schede/${SCHEDA}`,
      json(200, { scheda: conAvviso(), bambini: [bambino({ domanda_id: ALTRA_DOMANDA, domanda_figlio: 0 })] }),
    )
    render(<AvvisoDomandaDaAssociare scheda={conAvviso()} onAggiornata={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scegli la domanda' }))

    expect(
      await screen.findByText(
        'Tutti i bambini di questa scheda hanno già una domanda collegata. Aggiungi un bambino alla scheda e riprova.',
      ),
    ).toBeTruthy()
    expect(chiamate('GET', '/api/admin/crm/domande')).toHaveLength(0)
  })

  it('lettura della scheda fallita → un avviso, e nessuna ricerca', async () => {
    rotta('GET', `/api/admin/crm/schede/${SCHEDA}`, json(500, { error: 'x', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }))
    render(<AvvisoDomandaDaAssociare scheda={conAvviso()} onAggiornata={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scegli la domanda' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain('L’operazione non è riuscita. Riprova fra poco.')
    expect(chiamate('GET', '/api/admin/crm/domande')).toHaveLength(0)
  })

  it('la domanda non c’è più (elenco vuoto) → lo dice con parole sue, non «nessuna domanda»', async () => {
    rotta('GET', `/api/admin/crm/schede/${SCHEDA}`, json(200, { scheda: conAvviso(), bambini: [bambino()] }))
    rotta('GET', '/api/admin/crm/domande', json(200, { data: [] }))
    render(<AvvisoDomandaDaAssociare scheda={conAvviso()} onAggiornata={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scegli la domanda' }))

    expect(await screen.findByText('Quella domanda non c’è più o non è di questa sede.')).toBeTruthy()
  })
})
