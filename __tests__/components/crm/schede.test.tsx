import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import { ElencoSchede } from '@/components/features/crm/schede/ElencoSchede'
import { DettaglioScheda } from '@/components/features/crm/schede/DettaglioScheda'
import { NuovaScheda } from '@/components/features/crm/schede/NuovaScheda'
import { linkTelefono, linkWhatsApp } from '@/components/features/crm/schede/contatti-link'

/**
 * CRM della segreteria · Compito 2.2 — l'elenco delle schede, la scheda di una famiglia, «Nuova famiglia».
 *
 * `fetch` è finto e risponde in base a METODO + INDIRIZZO: le schermate parlano con le route del 2.1 e
 * con `GET /api/admin/crm/persone`, e qui si misura ciò che mandano e ciò che disegnano con ciò che
 * ricevono. Una chiamata che nessuna regola riconosce NON passa in silenzio: `afterEach` la elenca.
 *
 * ── Il catalogo si legge da disco, e una chiave che non c'è fa cadere il test ──────────────────
 * Il mock globale di next-intl (`test/setup.ts`) risolve le sole chiavi di primo livello, quindi
 * `t('esiti.perso')` uscirebbe come `crmShell.esiti.perso` e ogni asserzione sul testo sarebbe verde
 * su una stringa che nessuno leggerà. Qui il mock risolve anche le chiavi annidate e LANCIA su quelle
 * che non esistono: un nome di chiave sbagliato nel componente è un test rosso, non un testo finto.
 *
 * Le schermate degli ALTRI compiti (collegamento, richiami, fissa visita) sono sostituite da
 * marcatori: qui si prova che la scheda le monti con le props giuste, non cosa fanno.
 */

vi.mock('next-intl', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { IntlMessageFormat } = await import('intl-messageformat')
  const cartella = join(process.cwd(), 'messages/it')
  const catalogo: Record<string, unknown> = {}
  for (const file of readdirSync(cartella)) {
    if (file.endsWith('.json')) catalogo[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'))
  }
  const risolvi = (ns: string | undefined, chiave: string): string => {
    let v: unknown = ns ? catalogo[ns] : catalogo
    for (const pezzo of chiave.split('.')) v = (v as Record<string, unknown> | undefined)?.[pezzo]
    if (typeof v !== 'string') throw new Error(`Chiave di catalogo inesistente: ${ns ?? ''}.${chiave}`)
    return v
  }
  const useTranslations = (ns?: string) => {
    const t = (chiave: string, valori?: Record<string, unknown>) => {
      const testo = risolvi(ns, chiave)
      return valori === undefined ? testo : String(new IntlMessageFormat(testo, 'it').format(valori))
    }
    return Object.assign(t, {
      rich: (chiave: string) => risolvi(ns, chiave),
      markup: (chiave: string) => risolvi(ns, chiave),
      raw: (chiave: string) => risolvi(ns, chiave),
      has: (chiave: string) => {
        try {
          risolvi(ns, chiave)
          return true
        } catch {
          return false
        }
      },
    })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

interface Chiamata {
  url: string
  metodo: string
  corpo: Record<string, unknown> | null
}
interface Risposta {
  stato?: number
  corpo?: unknown
}
interface Rotta {
  metodo: string
  url: RegExp
  risposta: (c: Chiamata) => Risposta
}

const h = vi.hoisted(() => ({
  query: '',
  chiamate: [] as { url: string; metodo: string; corpo: Record<string, unknown> | null }[],
  rotte: [] as { metodo: string; url: RegExp; risposta: (c: { url: string; metodo: string; corpo: Record<string, unknown> | null }) => { stato?: number; corpo?: unknown } }[],
  nonGestite: [] as string[],
  logClient: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/admin/crm',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Errore'),
}))

// ── le schermate di altri compiti: marcatori che espongono le props ricevute ─────
vi.mock('@/components/features/crm/collegamento/BadgeCollegamento', () => ({
  BadgeCollegamento: ({ bambino }: { bambino: { id: string } }) => <span data-testid="badge-collegamento" data-bambino-id={bambino.id} />,
}))
vi.mock('@/components/features/crm/collegamento/AssociaDomanda', () => ({
  AssociaDomanda: (p: { scuolaId: string; schedaId: string; bambino: { id: string } }) => (
    <span data-testid="associa-domanda" data-scuola-id={p.scuolaId} data-scheda-id={p.schedaId} data-bambino-id={p.bambino.id} />
  ),
}))
vi.mock('@/components/features/crm/collegamento/AvvisoDomandaDaAssociare', () => ({
  AvvisoDomandaDaAssociare: ({ scheda }: { scheda: { id: string; domanda_da_associare: string } }) => (
    <span data-testid="avviso-domanda" data-scheda-id={scheda.id} data-domanda={scheda.domanda_da_associare} />
  ),
}))
vi.mock('@/components/features/crm/follow-up/AzioniScheda', () => ({
  AzioniScheda: (p: { scuolaId: string; schedaId: string }) => (
    <span data-testid="azioni-scheda" data-scuola-id={p.scuolaId} data-scheda-id={p.schedaId} />
  ),
}))
vi.mock('@/components/features/crm/agenda/FissaVisita', () => ({
  FissaVisita: (p: { scuolaId: string; schedaId?: string; appuntamento?: { id: string }; onFatto: () => void; onAnnulla: () => void }) => (
    <div data-testid="fissa-visita" data-scuola-id={p.scuolaId} data-scheda-id={p.schedaId} data-appuntamento-id={p.appuntamento?.id}>
      <button type="button" onClick={p.onFatto}>
        visita-fatta
      </button>
      <button type="button" onClick={p.onAnnulla}>
        visita-annullata
      </button>
    </div>
  ),
}))

// ── fetch finto ───────────────────────────────────────────────────────────────────
/** Registra una regola. L'ULTIMA registrata vince: un test può correggere ciò che ha messo `beforeEach`. */
function rispondi(metodo: string, url: RegExp, risposta: Risposta | ((c: Chiamata) => Risposta)) {
  const regola: Rotta = { metodo, url, risposta: typeof risposta === 'function' ? risposta : () => risposta }
  h.rotte.unshift(regola)
}

const chiamateA = (metodo: string, url: RegExp) => h.chiamate.filter((c) => c.metodo === metodo && url.test(c.url))

beforeEach(() => {
  h.query = ''
  h.chiamate.length = 0
  h.rotte.length = 0
  h.nonGestite.length = 0
  h.logClient.mockClear()
  window.history.replaceState(null, '', '/admin/crm?tab=schede')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const metodo = (init?.method ?? 'GET').toUpperCase()
      const chiamata: Chiamata = { url, metodo, corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null }
      h.chiamate.push(chiamata)
      const rotta = h.rotte.find((r) => r.metodo === metodo && r.url.test(url))
      if (!rotta) {
        h.nonGestite.push(`${metodo} ${url}`)
        return new Response('{}', { status: 599 })
      }
      const { stato = 200, corpo = {} } = rotta.risposta(chiamata)
      return new Response(JSON.stringify(corpo), { status: stato, headers: { 'content-type': 'application/json' } })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Una chiamata senza regola è una schermata che parla con una route che il test non conosce.
  expect(h.nonGestite).toEqual([])
})

// ── le fixture: sempre «Famiglia Prova», mai una famiglia vera ─────────────────────
const ID_SCHEDA = 'scheda-1'
const URL_DETTAGLIO = /\/api\/admin\/crm\/schede\/scheda-1(\?|$)/

function scheda(over: Record<string, unknown> = {}) {
  return {
    id: ID_SCHEDA,
    scuola_id: SEDE_A,
    genitore_nome: 'Famiglia Prova',
    telefono1: '333 000 0001',
    telefono2: null,
    email1: 'prova@example.com',
    email2: null,
    telefoni_norm: ['3330000001'],
    email_norm: ['prova@example.com'],
    origine: 'telefonata',
    routine: null,
    paura: null,
    desiderio: null,
    domanda_da_associare: null,
    creato_da: null,
    creato_via: 'segreteria',
    creata_il: '2026-10-01T09:00:00.000Z',
    aggiornata_il: '2026-10-01T09:00:00.000Z',
    anonimizzata_il: null,
    ...over,
  }
}

function bambino(over: Record<string, unknown> = {}) {
  return {
    id: 'bambino-1',
    scuola_id: SEDE_A,
    scheda_id: ID_SCHEDA,
    nome: 'Bambino Prova',
    data_nascita: '2024-03-05',
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
    quota_saldata_il: null,
    quota_segnata_da: null,
    creata_il: '2026-10-01T09:00:00.000Z',
    aggiornata_il: '2026-10-01T09:00:00.000Z',
    ...over,
  }
}

const EVENTO_NOTA = {
  id: 'evento-2',
  scuola_id: SEDE_A,
  scheda_id: ID_SCHEDA,
  tipo: 'nota',
  autore: 'utente-1',
  autore_via: 'segreteria',
  dati: {},
  testo: 'Nota di prova due',
  creato_il: '2026-10-02T10:00:00.000Z',
  autore_persona: { id: 'utente-1', nome: 'Prova', cognome: 'Segreteria' },
}
const EVENTO_CREATA = {
  id: 'evento-1',
  scuola_id: SEDE_A,
  scheda_id: ID_SCHEDA,
  tipo: 'creata',
  autore: 'utente-1',
  autore_via: 'segreteria',
  dati: { bambini: 1 },
  testo: null,
  creato_il: '2026-10-01T09:00:00.000Z',
  autore_persona: { id: 'utente-1', nome: 'Prova', cognome: 'Segreteria' },
}

function dettaglio(over: Record<string, unknown> = {}) {
  return {
    scheda: scheda(),
    bambini: [bambino()],
    appuntamenti: [],
    azioni_aperte: [],
    eventi: [EVENTO_NOTA, EVENTO_CREATA],
    eventi_totale: 2,
    ...over,
  }
}

const apriDettaglio = async () => {
  render(<DettaglioScheda schedaId={ID_SCHEDA} onChiudi={vi.fn()} />)
  return screen.findByRole('region', { name: 'Storico' })
}

// ════════════════════════════════════════════════════════════════════════════════
describe('link di contatto', () => {
  it('tel: porta le sole cifre; senza un numero valido non c’è link', () => {
    expect(linkTelefono('333 000 0001')).toBe('tel:3330000001')
    expect(linkTelefono('+39 333 000 0001')).toBe('tel:+393330000001')
    expect(linkTelefono('12')).toBeNull()
    expect(linkTelefono('')).toBeNull()
  })

  it('WhatsApp: numero normalizzato con il prefisso 39; un numero già internazionale resta com’è', () => {
    expect(linkWhatsApp('333 000 0001')).toBe('https://wa.me/393330000001')
    expect(linkWhatsApp('081 123 4567')).toBe('https://wa.me/390811234567')
    expect(linkWhatsApp('+39 333 000 0001')).toBe('https://wa.me/393330000001')
    expect(linkWhatsApp('0039 333 000 0001')).toBe('https://wa.me/393330000001')
    expect(linkWhatsApp('39 333 000 0001')).toBe('https://wa.me/393330000001')
    // Un numero estero NON riceve un 39 davanti: si scriverebbe a un altro paese.
    expect(linkWhatsApp('+44 7700 900123')).toBe('https://wa.me/447700900123')
    expect(linkWhatsApp('abc')).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('DettaglioScheda', () => {
  it('il dettaglio si apre con lo storico visibile', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    const storico = await apriDettaglio()

    // Si aspetta la PRESENZA del primo evento: «non c’è lo spinner» sarebbe vero anche a fetch in volo.
    expect(await within(storico).findByText('Nota di prova due')).toBeTruthy()
    const voci = within(storico).getAllByRole('listitem')
    expect(voci).toHaveLength(2)
    // Il più recente per primo, con chi l'ha scritto.
    expect(voci[0].textContent).toContain('Nota di prova due')
    expect(voci[0].textContent).toContain('Prova Segreteria')
    expect(voci[1].textContent).toContain('Scheda creata')
    // La famiglia sta sopra lo storico, nella stessa colonna.
    expect(screen.getByText('Famiglia Prova')).toBeTruthy()
  })

  it('monta i pezzi degli altri compiti con le props giuste', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ bambini: [bambino(), bambino({ id: 'bambino-2', nome: 'Altro Bambino' })] }) })
    await apriDettaglio()

    const badge = screen.getAllByTestId('badge-collegamento').map((e) => e.getAttribute('data-bambino-id'))
    expect(badge).toEqual(['bambino-1', 'bambino-2'])
    const associa = screen.getAllByTestId('associa-domanda')
    expect(associa.map((e) => e.getAttribute('data-bambino-id'))).toEqual(['bambino-1', 'bambino-2'])
    // La sede viene dalla SCHEDA (la risposta), non da una prop che il pannello non ha.
    for (const e of associa) {
      expect(e.getAttribute('data-scuola-id')).toBe(SEDE_A)
      expect(e.getAttribute('data-scheda-id')).toBe(ID_SCHEDA)
    }
    expect(screen.getByTestId('azioni-scheda').getAttribute('data-scuola-id')).toBe(SEDE_A)
    expect(screen.getByTestId('azioni-scheda').getAttribute('data-scheda-id')).toBe(ID_SCHEDA)
    // Nessun avviso se la scheda non ha una domanda da associare.
    expect(screen.queryByTestId('avviso-domanda')).toBeNull()
  })

  it('aggiunge un bambino a una scheda esistente: POST con nome, nascita e ingresso, poi rilegge', async () => {
    let letture = 0
    rispondi('GET', URL_DETTAGLIO, () => {
      letture++
      return { corpo: dettaglio() }
    })
    rispondi('POST', /\/api\/admin\/crm\/schede\/scheda-1\/bambini$/, { stato: 201, corpo: { id: 'bambino-2' } })
    await apriDettaglio()
    const primaLettura = letture

    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi un bambino' }))
    const conferma = screen.getByRole('button', { name: 'Aggiungi il bambino' })
    // Senza il nome non parte niente.
    expect((conferma as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Nome del bambino'), { target: { value: '  Secondo Prova ' } })
    fireEvent.change(screen.getByLabelText('Quando vorrebbe iniziare?'), { target: { value: 'in_corso' } })
    fireEvent.click(conferma)

    await waitFor(() => expect(chiamateA('POST', /\/bambini$/)).toHaveLength(1))
    expect(chiamateA('POST', /\/bambini$/)[0].corpo).toEqual({ nome: 'Secondo Prova', annoIngresso: 'in_corso' })
    // La scheda si rilegge e il modulo si chiude.
    await waitFor(() => expect(letture).toBeGreaterThan(primaLettura))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Aggiungi il bambino' })).toBeNull())
  })

  it('aggiungere un bambino: un rifiuto del server resta nel modulo con il suo messaggio', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    rispondi('POST', /\/api\/admin\/crm\/schede\/scheda-1\/bambini$/, { stato: 500, corpo: { error: 'x', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' } })
    await apriDettaglio()

    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi un bambino' }))
    fireEvent.change(screen.getByLabelText('Nome del bambino'), { target: { value: 'Secondo Prova' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi il bambino' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    // Il modulo resta aperto, con quello che si era scritto.
    expect((screen.getByLabelText('Nome del bambino') as HTMLInputElement).value).toBe('Secondo Prova')
  })

  it('l’avviso «domanda da associare» compare solo se la scheda ne ha una', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ scheda: scheda({ domanda_da_associare: 'domanda-9' }) }) })
    await apriDettaglio()
    const avviso = screen.getByTestId('avviso-domanda')
    expect(avviso.getAttribute('data-scheda-id')).toBe(ID_SCHEDA)
    expect(avviso.getAttribute('data-domanda')).toBe('domanda-9')
  })

  it('il link WhatsApp usa il numero normalizzato con 39', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ scheda: scheda({ telefono2: '+44 7700 900123' }) }) })
    await apriDettaglio()

    const chiamata = screen.getByRole('link', { name: '333 000 0001' })
    expect(chiamata.getAttribute('href')).toBe('tel:3330000001')
    const whatsapp = screen.getAllByRole('link', { name: /WhatsApp/ })
    expect(whatsapp.map((a) => a.getAttribute('href'))).toEqual(['https://wa.me/393330000001', 'https://wa.me/447700900123'])
    // L'email è un collegamento mailto.
    expect(screen.getByRole('link', { name: 'prova@example.com' }).getAttribute('href')).toBe('mailto:prova@example.com')
  })

  it('perso senza motivo: il pulsante salva resta disattivato', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    rispondi('PATCH', /\/schede\/scheda-1\/bambini\/bambino-1$/, { corpo: { id: 'bambino-1', modificato: true } })
    await apriDettaglio()

    const card = screen.getByRole('article', { name: 'Bambino Prova' })
    const salva = within(card).getByRole('button', { name: 'Salva' }) as HTMLButtonElement
    // Niente è cambiato: niente da salvare.
    expect(salva.disabled).toBe(true)

    fireEvent.change(within(card).getByLabelText('Esito'), { target: { value: 'perso' } })
    expect(within(card).getByText('Per segnare un bambino come perso serve il motivo.')).toBeTruthy()
    expect((within(card).getByRole('button', { name: 'Salva' }) as HTMLButtonElement).disabled).toBe(true)
    // Anche cliccando, niente parte.
    fireEvent.click(within(card).getByRole('button', { name: 'Salva' }))
    expect(chiamateA('PATCH', /bambini/)).toHaveLength(0)

    fireEvent.change(within(card).getByLabelText('Motivo'), { target: { value: 'prezzo' } })
    expect((within(card).getByRole('button', { name: 'Salva' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(card).getByRole('button', { name: 'Salva' }))

    await waitFor(() => expect(chiamateA('PATCH', /bambini/)).toHaveLength(1))
    // Solo ciò che è cambiato: esito e motivo. Niente nota vuota, niente quota.
    expect(chiamateA('PATCH', /bambini/)[0].corpo).toEqual({ esito: 'perso', motivoPerdita: 'prezzo' })
    // Dopo il salvataggio la scheda si rilegge.
    await waitFor(() => expect(chiamateA('GET', URL_DETTAGLIO)).toHaveLength(2))
  })

  it('tornando da «perso» ad aperto il motivo non parte', async () => {
    rispondi('GET', URL_DETTAGLIO, {
      corpo: dettaglio({ bambini: [bambino({ esito: 'perso', motivo_perdita: 'distanza', motivo_nota: 'Troppo lontano' })] }),
    })
    rispondi('PATCH', /\/bambini\/bambino-1$/, { corpo: { id: 'bambino-1', modificato: true } })
    await apriDettaglio()

    const card = screen.getByRole('article', { name: 'Bambino Prova' })
    expect((within(card).getByLabelText('Motivo') as HTMLSelectElement).value).toBe('distanza')
    fireEvent.change(within(card).getByLabelText('Esito'), { target: { value: 'aperto' } })
    // Il motivo non si vede più: non descrive un esito che non c'è.
    expect(within(card).queryByLabelText('Motivo')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Salva' }))

    await waitFor(() => expect(chiamateA('PATCH', /bambini/)).toHaveLength(1))
    expect(chiamateA('PATCH', /bambini/)[0].corpo).toEqual({ esito: 'aperto' })
  })

  it('un «perso» già registrato: toccare solo la quota non rimanda il motivo', async () => {
    rispondi('GET', URL_DETTAGLIO, {
      corpo: dettaglio({ bambini: [bambino({ esito: 'perso', motivo_perdita: 'distanza', motivo_nota: 'Troppo lontano' })] }),
    })
    rispondi('PATCH', /\/bambini\/bambino-1$/, { corpo: { id: 'bambino-1', modificato: true } })
    await apriDettaglio()

    const card = screen.getByRole('article', { name: 'Bambino Prova' })
    fireEvent.click(within(card).getByLabelText('Quota di iscrizione saldata'))
    fireEvent.click(within(card).getByRole('button', { name: 'Salva' }))

    await waitFor(() => expect(chiamateA('PATCH', /bambini/)).toHaveLength(1))
    expect(chiamateA('PATCH', /bambini/)[0].corpo).toEqual({ quotaSaldata: true })
  })

  it('un «perso» vecchio, senza motivo, non blocca la correzione della quota', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ bambini: [bambino({ esito: 'perso', motivo_perdita: null })] }) })
    rispondi('PATCH', /\/bambini\/bambino-1$/, { corpo: { id: 'bambino-1', modificato: true } })
    await apriDettaglio()

    const card = screen.getByRole('article', { name: 'Bambino Prova' })
    fireEvent.click(within(card).getByLabelText('Quota di iscrizione saldata'))
    expect((within(card).getByRole('button', { name: 'Salva' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(within(card).getByRole('button', { name: 'Salva' }))

    await waitFor(() => expect(chiamateA('PATCH', /bambini/)).toHaveLength(1))
    expect(chiamateA('PATCH', /bambini/)[0].corpo).toEqual({ quotaSaldata: true })
  })

  it('la quota si segna con la data, e solo quella parte', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    rispondi('PATCH', /\/bambini\/bambino-1$/, { corpo: { id: 'bambino-1', modificato: true } })
    await apriDettaglio()

    const card = screen.getByRole('article', { name: 'Bambino Prova' })
    fireEvent.click(within(card).getByLabelText('Quota di iscrizione saldata'))
    fireEvent.click(within(card).getByRole('button', { name: 'Salva' }))

    await waitFor(() => expect(chiamateA('PATCH', /bambini/)).toHaveLength(1))
    expect(chiamateA('PATCH', /bambini/)[0].corpo).toEqual({ quotaSaldata: true })
  })

  it('un errore del server nel salvataggio si dice, e la scheda non si ricarica', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    rispondi('PATCH', /\/bambini\/bambino-1$/, { stato: 409, corpo: { error: 'x', codice: 'STATO_NON_AMMESSO' } })
    await apriDettaglio()

    const card = screen.getByRole('article', { name: 'Bambino Prova' })
    fireEvent.change(within(card).getByLabelText('Esito'), { target: { value: 'ci_pensa' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Salva' }))

    expect((await within(card).findByRole('alert')).textContent).toBeTruthy()
    expect(chiamateA('GET', URL_DETTAGLIO)).toHaveLength(1)
  })

  it('aggiungere una nota: la route riceve tipo e testo, poi lo storico si rilegge', async () => {
    let lette = 0
    rispondi('GET', URL_DETTAGLIO, () => {
      lette++
      return {
        corpo:
          lette === 1
            ? dettaglio()
            : dettaglio({
                eventi: [{ ...EVENTO_NOTA, id: 'evento-3', testo: 'Richiamare giovedì' }, EVENTO_NOTA, EVENTO_CREATA],
                eventi_totale: 3,
              }),
      }
    })
    rispondi('POST', /\/schede\/scheda-1\/eventi$/, { stato: 201, corpo: { id: 'evento-3' } })
    const storico = await apriDettaglio()

    const aggiungi = screen.getByRole('button', { name: 'Aggiungi' }) as HTMLButtonElement
    expect(aggiungi.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Testo'), { target: { value: '  Richiamare giovedì ' } })
    fireEvent.change(screen.getByLabelText('Che cosa vuoi registrare?'), { target: { value: 'telefonata' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi' }))

    await waitFor(() => expect(chiamateA('POST', /eventi/)).toHaveLength(1))
    expect(chiamateA('POST', /eventi/)[0].corpo).toEqual({ tipo: 'telefonata', testo: 'Richiamare giovedì' })
    expect(await within(storico).findByText('Richiamare giovedì')).toBeTruthy()
    // Il campo si svuota: la stessa nota non parte due volte.
    expect((screen.getByLabelText('Testo') as HTMLTextAreaElement).value).toBe('')
  })

  it('modifica dei contatti: parte solo ciò che è cambiato', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    rispondi('PATCH', /\/schede\/scheda-1$/, { corpo: { id: ID_SCHEDA, modificata: true } })
    await apriDettaglio()

    fireEvent.click(screen.getByRole('button', { name: 'Modifica i dati' }))
    const salva = screen.getByRole('button', { name: 'Salva i dati' }) as HTMLButtonElement
    expect(salva.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Secondo telefono'), { target: { value: '333 000 0002' } })
    fireEvent.change(screen.getByLabelText('Com’è la giornata tipo del bambino?'), { target: { value: 'Tranquilla' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salva i dati' }))

    await waitFor(() => expect(chiamateA('PATCH', /schede\/scheda-1$/)).toHaveLength(1))
    expect(chiamateA('PATCH', /schede\/scheda-1$/)[0].corpo).toEqual({ telefono2: '333 000 0002', routine: 'Tranquilla' })
    await waitFor(() => expect(chiamateA('GET', URL_DETTAGLIO)).toHaveLength(2))
  })

  it('tolti tutti i contatti il salvataggio non parte', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ scheda: scheda({ email1: null, email_norm: [] }) }) })
    await apriDettaglio()

    fireEvent.click(screen.getByRole('button', { name: 'Modifica i dati' }))
    fireEvent.change(screen.getByLabelText('Telefono'), { target: { value: '' } })

    expect(screen.getByText('Inserisci almeno un telefono o un’email.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Salva i dati' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('«Fissa una visita» apre FissaVisita con la sede della scheda; a visita fatta la scheda si rilegge', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    await apriDettaglio()
    expect(screen.queryByTestId('fissa-visita')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Fissa una visita' }))
    const fissa = screen.getByTestId('fissa-visita')
    expect(fissa.getAttribute('data-scuola-id')).toBe(SEDE_A)
    expect(fissa.getAttribute('data-scheda-id')).toBe(ID_SCHEDA)
    expect(fissa.getAttribute('data-appuntamento-id')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'visita-fatta' }))
    await waitFor(() => expect(chiamateA('GET', URL_DETTAGLIO)).toHaveLength(2))
    expect(screen.queryByTestId('fissa-visita')).toBeNull()
  })

  it('una visita in programma si può spostare: FissaVisita riceve quell’appuntamento', async () => {
    rispondi('GET', URL_DETTAGLIO, {
      corpo: dettaglio({
        appuntamenti: [
          {
            id: 'app-1',
            scuola_id: SEDE_A,
            scheda_id: ID_SCHEDA,
            inizio: '2026-11-05T09:30:00.000Z',
            fine: '2026-11-05T10:15:00.000Z',
            durata_min: 45,
            assegnata_a: 'utente-1',
            stato: 'in_programma',
            svolto_da: null,
            assegnata_a_persona: { id: 'utente-1', nome: 'Prova', cognome: 'Segreteria' },
            svolto_da_persona: null,
          },
        ],
      }),
    })
    await apriDettaglio()

    // 09:30 UTC sono le 10:30 a Roma: la data si legge nel fuso della scuola.
    expect(screen.getByText(/05\/11\/2026, 10:30/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sposta' }))
    expect(screen.getByTestId('fissa-visita').getAttribute('data-appuntamento-id')).toBe('app-1')
    fireEvent.click(screen.getByRole('button', { name: 'visita-annullata' }))
    expect(screen.queryByTestId('fissa-visita')).toBeNull()
  })

  it('uno storico più lungo di quello mostrato lo dice', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio({ eventi_totale: 731 }) })
    const storico = await apriDettaglio()
    expect(within(storico).getByText(/\(2\/731\)/)).toBeTruthy()
  })

  it('se la scheda non si legge, lo dice e offre di riprovare', async () => {
    let lette = 0
    rispondi('GET', URL_DETTAGLIO, () => {
      lette++
      return lette === 1 ? { stato: 500, corpo: { error: 'x', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' } } : { corpo: dettaglio() }
    })
    render(<DettaglioScheda schedaId={ID_SCHEDA} onChiudi={vi.fn()} />)

    expect(await screen.findByText('Non è stato possibile aprire la scheda.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(await screen.findByRole('region', { name: 'Storico' })).toBeTruthy()
    // L'errore è nel log del browser, senza testo di famiglie.
    expect(h.logClient).toHaveBeenCalled()
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Famiglia Prova')
  })

  it('il pulsante di chiusura chiama onChiudi', async () => {
    rispondi('GET', URL_DETTAGLIO, { corpo: dettaglio() })
    const onChiudi = vi.fn()
    render(<DettaglioScheda schedaId={ID_SCHEDA} onChiudi={onChiudi} />)
    await screen.findByRole('region', { name: 'Storico' })
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi la scheda' }))
    expect(onChiudi).toHaveBeenCalledTimes(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('NuovaScheda', () => {
  const compila = () => {
    fireEvent.change(screen.getByLabelText('Nome del genitore'), { target: { value: 'Famiglia Prova' } })
    fireEvent.change(screen.getByLabelText('Telefono'), { target: { value: '333 000 0001' } })
    fireEvent.change(screen.getByLabelText('Nome del bambino'), { target: { value: 'Bambino Prova' } })
  }

  it('nuova scheda: 409 → mostra Apri la scheda esistente', async () => {
    rispondi('POST', /\/api\/admin\/crm\/schede$/, (c) =>
      c.corpo?.forza === true
        ? { stato: 201, corpo: { id: 'scheda-nuova' } }
        : { stato: 409, corpo: { error: 'x', codice: 'SCHEDA_ESISTENTE', schedaId: 'scheda-esistente' } },
    )
    const onCreata = vi.fn()
    render(<NuovaScheda scuolaId={SEDE_A} onCreata={onCreata} onAnnulla={vi.fn()} />)
    compila()
    fireEvent.click(screen.getByRole('button', { name: 'Crea la scheda' }))

    const apri = await screen.findByRole('button', { name: 'Apri la scheda esistente' })
    expect(screen.getByRole('button', { name: 'Crea comunque' })).toBeTruthy()
    expect(onCreata).not.toHaveBeenCalled()
    // Il primo tentativo non forza.
    expect(chiamateA('POST', /schede$/)[0].corpo).not.toHaveProperty('forza')

    fireEvent.click(apri)
    expect(onCreata).toHaveBeenCalledWith('scheda-esistente')
    // Aprire quella che c'è non crea niente.
    expect(chiamateA('POST', /schede$/)).toHaveLength(1)
  })

  it('«Crea comunque» rimanda la stessa scheda con forza, poi chiama onCreata col nuovo id', async () => {
    rispondi('POST', /\/api\/admin\/crm\/schede$/, (c) =>
      c.corpo?.forza === true
        ? { stato: 201, corpo: { id: 'scheda-nuova' } }
        : { stato: 409, corpo: { error: 'x', codice: 'SCHEDA_ESISTENTE', schedaId: 'scheda-esistente' } },
    )
    const onCreata = vi.fn()
    render(<NuovaScheda scuolaId={SEDE_A} onCreata={onCreata} onAnnulla={vi.fn()} />)
    compila()
    fireEvent.click(screen.getByRole('button', { name: 'Crea la scheda' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Crea comunque' }))

    await waitFor(() => expect(onCreata).toHaveBeenCalledWith('scheda-nuova'))
    const [prima, seconda] = chiamateA('POST', /schede$/)
    expect(seconda.corpo).toEqual({ ...prima.corpo, forza: true })
  })

  it('manda la sede dichiarata e solo i campi compilati', async () => {
    rispondi('POST', /\/api\/admin\/crm\/schede$/, { stato: 201, corpo: { id: 'scheda-nuova' } })
    const onCreata = vi.fn()
    render(<NuovaScheda scuolaId={SEDE_A} onCreata={onCreata} onAnnulla={vi.fn()} />)
    compila()
    fireEvent.click(screen.getByRole('button', { name: 'Crea la scheda' }))

    await waitFor(() => expect(onCreata).toHaveBeenCalledWith('scheda-nuova'))
    expect(chiamateA('POST', /schede$/)[0].corpo).toEqual({
      scuolaId: SEDE_A,
      genitoreNome: 'Famiglia Prova',
      telefono1: '333 000 0001',
      origine: 'telefonata',
      bambini: [{ nome: 'Bambino Prova', annoIngresso: 'non_indicato' }],
    })
  })

  it('senza nemmeno un telefono o un’email il pulsante resta spento e dice perché', () => {
    render(<NuovaScheda scuolaId={SEDE_A} onCreata={vi.fn()} onAnnulla={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Nome del genitore'), { target: { value: 'Famiglia Prova' } })
    fireEvent.change(screen.getByLabelText('Nome del bambino'), { target: { value: 'Bambino Prova' } })

    expect(screen.getByText('Inserisci almeno un telefono o un’email.')).toBeTruthy()
    const crea = screen.getByRole('button', { name: 'Crea la scheda' }) as HTMLButtonElement
    expect(crea.disabled).toBe(true)
    fireEvent.click(crea)
    expect(chiamateA('POST', /schede$/)).toHaveLength(0)

    // Un telefono che non è un numero (troppo corto) non conta come contatto.
    fireEvent.change(screen.getByLabelText('Telefono'), { target: { value: '12' } })
    expect((screen.getByRole('button', { name: 'Crea la scheda' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'prova@example.com' } })
    expect((screen.getByRole('button', { name: 'Crea la scheda' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('si possono aggiungere bambini, fino a sei', () => {
    render(<NuovaScheda scuolaId={SEDE_A} onCreata={vi.fn()} onAnnulla={vi.fn()} />)
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: 'Aggiungi un bambino' }))
    expect(screen.getAllByLabelText('Nome del bambino')).toHaveLength(6)
    expect(screen.queryByRole('button', { name: 'Aggiungi un bambino' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Togli il bambino 6' }))
    expect(screen.getAllByLabelText('Nome del bambino')).toHaveLength(5)
  })

  it('un guasto del server si dice e il modulo resta com’era', async () => {
    rispondi('POST', /\/api\/admin\/crm\/schede$/, { stato: 500, corpo: { error: 'x', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' } })
    const onCreata = vi.fn()
    render(<NuovaScheda scuolaId={SEDE_A} onCreata={onCreata} onAnnulla={vi.fn()} />)
    compila()
    fireEvent.click(screen.getByRole('button', { name: 'Crea la scheda' }))

    expect((await screen.findByRole('alert')).textContent).toBeTruthy()
    expect(onCreata).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Nome del genitore') as HTMLInputElement).value).toBe('Famiglia Prova')
  })

  it('Annulla chiama onAnnulla senza mandare niente', () => {
    const onAnnulla = vi.fn()
    render(<NuovaScheda scuolaId={SEDE_A} onCreata={vi.fn()} onAnnulla={onAnnulla} />)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))
    expect(onAnnulla).toHaveBeenCalledTimes(1)
    expect(h.chiamate).toHaveLength(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════
describe('ElencoSchede', () => {
  const URL_ELENCO = /\/api\/admin\/crm\/schede\?/
  const URL_PERSONE = /\/api\/admin\/crm\/persone\?/

  const riga = (n: number, over: Record<string, unknown> = {}) => ({
    id: `scheda-${n}`,
    genitore_nome: `Famiglia Prova ${n}`,
    origine: 'telefonata',
    creata_il: '2026-10-01T09:00:00.000Z',
    bambini: [{ id: `bambino-${n}`, nome: `Bambino Prova ${n}`, esito: 'aperto', domanda_id: null }],
    prossima_visita: null,
    prossima_azione: null,
    ...over,
  })
  const pagina = (da: number, a: number, totale: number) => ({
    data: Array.from({ length: a - da + 1 }, (_, i) => riga(da + i)),
    totale,
    pagina: 1,
    perPagina: 50,
  })

  beforeEach(() => {
    rispondi('GET', URL_PERSONE, { corpo: { data: [{ id: 'persona-1', nome: 'Prova', cognome: 'Segreteria', ruolo: 'segreteria' }] } })
  })

  it('disegna le famiglie con i bambini, la prossima visita e il prossimo richiamo', async () => {
    rispondi('GET', URL_ELENCO, {
      corpo: {
        data: [
          riga(1, {
            bambini: [
              { id: 'b1', nome: 'Bambino Prova 1', esito: 'aperto', domanda_id: null },
              { id: 'b2', nome: null, esito: 'perso', domanda_id: null },
            ],
            prossima_visita: '2026-11-05T09:30:00.000Z',
            prossima_azione: '2026-11-06T09:30:00.000Z',
          }),
          riga(2),
        ],
        totale: 2,
        pagina: 1,
        perPagina: 50,
      },
    })
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)

    const prima = (await screen.findByText('Famiglia Prova 1')).closest('li') as HTMLElement
    expect(within(prima).getByText('Bambino Prova 1')).toBeTruthy()
    expect(within(prima).getByText('Bambino senza nome')).toBeTruthy()
    expect(within(prima).getByText('Aperto')).toBeTruthy()
    expect(within(prima).getByText('Perso')).toBeTruthy()
    expect(within(prima).getByText(/Visita: 05\/11\/2026, 10:30/)).toBeTruthy()
    expect(within(prima).getByText(/Richiamo: 06\/11\/2026, 10:30/)).toBeTruthy()
    const seconda = screen.getByText('Famiglia Prova 2').closest('li') as HTMLElement
    expect(within(seconda).getByText('Nessuna visita fissata')).toBeTruthy()
    expect(within(seconda).getByText('Nessun richiamo')).toBeTruthy()
  })

  it('chiede l’elenco della sede dichiarata, senza filtri', async () => {
    rispondi('GET', URL_ELENCO, { corpo: pagina(1, 2, 2) })
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)
    await screen.findByText('Famiglia Prova 1')

    const elenco = chiamateA('GET', URL_ELENCO)
    expect(elenco).toHaveLength(1)
    const parametri = new URL(elenco[0].url, 'http://localhost').searchParams
    expect(parametri.get('scuolaId')).toBe(SEDE_A)
    expect([...parametri.keys()].sort()).toEqual(['scuolaId'])
    expect(new URL(chiamateA('GET', URL_PERSONE)[0].url, 'http://localhost').searchParams.get('scuolaId')).toBe(SEDE_A)
  })

  it('una persona scelta nell’indirizzo sopravvive: la tendina è già piena quando l’elenco parte', async () => {
    h.query = 'tab=schede&persona=persona-1'
    window.history.replaceState(null, '', '/admin/crm?tab=schede&persona=persona-1')
    rispondi('GET', URL_ELENCO, { corpo: pagina(1, 1, 1) })
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)
    await screen.findByText('Famiglia Prova 1')

    // Le persone si leggono PRIMA di montare l'elenco: lo screening dei valori dell'indirizzo le trova.
    const prima = chiamateA('GET', URL_ELENCO)[0]
    expect(new URL(prima.url, 'http://localhost').searchParams.get('persona')).toBe('persona-1')
  })

  it('una persona che la sede non ha viene scartata, non spedita al server', async () => {
    h.query = 'tab=schede&persona=persona-altrui'
    window.history.replaceState(null, '', '/admin/crm?tab=schede&persona=persona-altrui')
    rispondi('GET', URL_ELENCO, { corpo: pagina(1, 1, 1) })
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)
    await screen.findByText('Famiglia Prova 1')

    expect(new URL(chiamateA('GET', URL_ELENCO)[0].url, 'http://localhost').searchParams.has('persona')).toBe(false)
  })

  it('un clic su una famiglia la apre', async () => {
    rispondi('GET', URL_ELENCO, { corpo: pagina(1, 2, 2) })
    const onApri = vi.fn()
    render(<ElencoSchede scuolaId={SEDE_A} onApri={onApri} />)

    fireEvent.click((await screen.findByText('Famiglia Prova 2')).closest('button') as HTMLElement)
    expect(onApri).toHaveBeenCalledWith('scheda-2')
  })

  it('il filtro per esito parte al server, e a chi cerca «perso» non resta una pagina bugiarda', async () => {
    rispondi('GET', URL_ELENCO, (c) =>
      new URL(c.url, 'http://localhost').searchParams.get('esito') === 'perso' ? { corpo: pagina(7, 7, 1) } : { corpo: pagina(1, 3, 3) },
    )
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)
    await screen.findByText('Famiglia Prova 1')

    fireEvent.click(screen.getByRole('button', { name: 'Perso' }))

    expect(await screen.findByText('Famiglia Prova 7')).toBeTruthy()
    expect(screen.queryByText('Famiglia Prova 1')).toBeNull()
    // La lettura FILTRATA (c'è anche quella senza filtri, che serve solo a contare le famiglie della sede).
    const filtrate = chiamateA('GET', URL_ELENCO).filter((c) => new URL(c.url, 'http://localhost').searchParams.has('esito'))
    expect(filtrate).toHaveLength(1)
    expect(new URL(filtrate[0].url, 'http://localhost').searchParams.get('esito')).toBe('perso')
    const senzaFiltri = chiamateA('GET', URL_ELENCO).filter((c) => !new URL(c.url, 'http://localhost').searchParams.has('esito'))
    expect(senzaFiltri.at(-1)).toBeDefined()
    expect(new URL((senzaFiltri.at(-1) as Chiamata).url, 'http://localhost').searchParams.get('pagina')).toBe('100000')
  })

  it('la persona del filtro viene dalla sede, e un filtro senza risultati non è un elenco vuoto', async () => {
    rispondi('GET', URL_ELENCO, (c) =>
      new URL(c.url, 'http://localhost').searchParams.get('esito') === 'ci_pensa' ? { corpo: pagina(1, 0, 0) } : { corpo: pagina(1, 3, 3) },
    )
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)
    await screen.findByText('Famiglia Prova 1')

    fireEvent.click(screen.getByRole('button', { name: 'Ci sta pensando' }))

    // Ci sono 3 famiglie in sede: «nessun risultato con questi filtri», non «non c'è ancora nessuna famiglia».
    expect(await screen.findByText('Nessun risultato con questi filtri')).toBeTruthy()
    expect(screen.queryByText('Non c’è ancora nessuna famiglia')).toBeNull()
  })

  it('«Mostra altre famiglie» aggiunge la pagina dopo, senza perdere le prime', async () => {
    rispondi('GET', URL_ELENCO, (c) => {
      const p = new URL(c.url, 'http://localhost').searchParams.get('pagina')
      return { corpo: p === '2' ? { ...pagina(51, 60, 60), pagina: 2 } : pagina(1, 50, 60) }
    })
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)
    await screen.findByText('Famiglia Prova 1')
    expect(screen.getAllByRole('listitem')).toHaveLength(50)

    fireEvent.click(screen.getByRole('button', { name: 'Mostra altre famiglie' }))

    expect(await screen.findByText('Famiglia Prova 60')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(60)
    expect(screen.getByText('Famiglia Prova 1')).toBeTruthy()
    // Sono tutte: il pulsante sparisce.
    expect(screen.queryByRole('button', { name: 'Mostra altre famiglie' })).toBeNull()
    const seconda = chiamateA('GET', URL_ELENCO).at(-1) as Chiamata
    expect(new URL(seconda.url, 'http://localhost').searchParams.get('pagina')).toBe('2')
  })

  it('senza nessuna famiglia dice che non c’è ancora nulla, e «Nuova famiglia» resta a portata', async () => {
    rispondi('GET', URL_ELENCO, { corpo: { data: [], totale: 0, pagina: 1, perPagina: 50 } })
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)

    expect(await screen.findByText('Non c’è ancora nessuna famiglia')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nuova famiglia' })).toBeTruthy()
  })

  it('se l’elenco non si legge lo dice e offre di riprovare', async () => {
    let lette = 0
    rispondi('GET', URL_ELENCO, () => {
      lette++
      return lette === 1 ? { stato: 500, corpo: { error: 'x', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' } } : { corpo: pagina(1, 1, 1) }
    })
    render(<ElencoSchede scuolaId={SEDE_A} onApri={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Riprova' }))
    expect(await screen.findByText('Famiglia Prova 1')).toBeTruthy()
    expect(h.logClient).toHaveBeenCalled()
  })

  it('«Nuova famiglia» apre il modulo; creata la scheda, l’elenco si rilegge e la scheda si apre', async () => {
    rispondi('GET', URL_ELENCO, { corpo: pagina(1, 1, 1) })
    rispondi('POST', /\/api\/admin\/crm\/schede$/, { stato: 201, corpo: { id: 'scheda-nuova' } })
    const onApri = vi.fn()
    render(<ElencoSchede scuolaId={SEDE_A} onApri={onApri} />)
    await screen.findByText('Famiglia Prova 1')

    fireEvent.click(screen.getByRole('button', { name: 'Nuova famiglia' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Nuova famiglia' })
    fireEvent.change(within(dialogo).getByLabelText('Nome del genitore'), { target: { value: 'Famiglia Prova' } })
    fireEvent.change(within(dialogo).getByLabelText('Telefono'), { target: { value: '333 000 0001' } })
    fireEvent.change(within(dialogo).getByLabelText('Nome del bambino'), { target: { value: 'Bambino Prova' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Crea la scheda' }))

    await waitFor(() => expect(onApri).toHaveBeenCalledWith('scheda-nuova'))
    await waitFor(() => expect(chiamateA('GET', URL_ELENCO)).toHaveLength(2))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(chiamateA('POST', /schede$/)[0].corpo?.scuolaId).toBe(SEDE_A)
  })
})
