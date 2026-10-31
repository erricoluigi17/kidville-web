import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import shared from '../../../messages/it/shared.json'
import { AgendaSettimana } from '@/components/features/crm/agenda/AgendaSettimana'
import { FissaVisita } from '@/components/features/crm/agenda/FissaVisita'
import { DisponibilitaPersona } from '@/components/features/crm/disponibilita/DisponibilitaPersona'

/**
 * CRM della segreteria · Compito 3.3 — l'agenda della settimana, il dialogo «Fissa una visita» e la
 * disponibilità di chi riceve.
 *
 * ── COME SI PROVA ───────────────────────────────────────────────────────────────────
 * `fetch` è finto e risponde in base a metodo e percorso; ogni chiamata viene REGISTRATA col suo corpo, perché
 * il comportamento che conta è quello che la schermata MANDA al server (chi ha svolto la visita, quale ora,
 * quale persona), non solo quello che mostra. Una chiamata a una rotta non prevista fa fallire il test: un
 * `fetch` che risponde a tutto sarebbe verde anche con l'indirizzo sbagliato.
 *
 * ── L'OROLOGIO ──────────────────────────────────────────────────────────────────────
 * Si congela solo `Date` (i timer restano veri, `findBy`/`waitFor` continuano a funzionare). Il «oggi» sta a
 * metà settimana, dopo la fine dell'ora legale (domenica 25/10/2026): gli orari di Roma sono UTC+1. I casi che
 * attraversano il cambio d'ora spostano l'orologio apposta.
 *
 * ── I TESTI ─────────────────────────────────────────────────────────────────────────
 * Il mock di next-intl dei test risolve solo le chiavi di primo livello: i vocabolari annidati di `crmShell`
 * (stati, motivi) compaiono col nome della chiave. Qui non si asserisce sul loro testo.
 */

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const P_ESTRANEA = '99999999-9999-4999-8999-999999999999'
const S1 = '33333333-3333-4333-8333-333333333333'
const V1 = '44444444-4444-4444-8444-444444444444'
const V2 = '55555555-5555-4555-8555-555555555555'
const F1 = '66666666-6666-4666-8666-666666666666'
const F2 = '77777777-7777-4777-8777-777777777777'
const A1 = '88888888-8888-4888-8888-888888888888'
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const PERSONE = [
  { id: P1, nome: 'Prima', cognome: 'Prova', ruolo: 'segreteria' },
  { id: P2, nome: 'Seconda', cognome: 'Prova', ruolo: 'admin' },
]

// ── fetch finto ──────────────────────────────────────────────────────────────────────

interface Chiamata {
  metodo: string
  percorso: string
  query: URLSearchParams
  corpo: Record<string, unknown> | undefined
}
type Rotta = { metodo: string; percorso: RegExp; risposta: (c: Chiamata) => Response }

let chiamate: Chiamata[] = []
let rotte: Rotta[] = []
let nonPreviste: string[] = []

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } })
const errore = (status: number, codice: string) => json({ error: 'Errore del server', codice }, status)

function rotta(metodo: string, percorso: RegExp, risposta: (c: Chiamata) => Response | unknown) {
  rotte.push({
    metodo,
    percorso,
    risposta: (c) => {
      const r = risposta(c)
      return r instanceof Response ? r : json(r)
    },
  })
}

const quante = (metodo: string, percorso: RegExp) => chiamate.filter((c) => c.metodo === metodo && percorso.test(c.percorso))
const ultima = (metodo: string, percorso: RegExp) => quante(metodo, percorso).at(-1)

beforeEach(() => {
  chiamate = []
  rotte = []
  nonPreviste = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T09:00:00Z')) // mercoledì 4 novembre, 10:00 a Roma
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const metodo = init?.method ?? 'GET'
      const c: Chiamata = {
        metodo,
        percorso: url.pathname,
        query: url.searchParams,
        corpo: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      }
      if (url.pathname.startsWith('/api/logs')) return json({ ok: true })
      chiamate.push(c)
      const r = rotte.find((x) => x.metodo === metodo && x.percorso.test(url.pathname))
      if (!r) {
        nonPreviste.push(`${metodo} ${url.pathname}`)
        return json({ error: 'rotta non prevista nel test' }, 500)
      }
      return r.risposta(c)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // Una chiamata a una rotta che il test non ha previsto è un test scritto male o un indirizzo sbagliato.
  expect(nonPreviste).toEqual([])
})

// ── dati ─────────────────────────────────────────────────────────────────────────────

function visita(o: Record<string, unknown> = {}) {
  return {
    id: V1,
    scuola_id: SEDE_A,
    scheda_id: S1,
    inizio: '2026-11-03T09:00:00.000Z', // martedì 3 novembre, 10:00 a Roma
    fine: '2026-11-03T09:45:00.000Z',
    durata_min: 45,
    assegnata_a: P2,
    fissato_da: P1,
    fissato_via: 'segreteria',
    stato: 'in_programma',
    svolto_da: null,
    segnato_da: null,
    segnato_il: null,
    creato_il: '2026-10-30T09:00:00.000Z',
    aggiornato_il: '2026-10-30T09:00:00.000Z',
    scheda: { id: S1, genitore_nome: 'Famiglia Prova' },
    fuori_disponibilita: false,
    da_chiudere: false,
    ...o,
  }
}

/** Lo slot libero di giovedì 5 novembre alle 09:45 (08:45 UTC) per la prima persona. */
const SLOT = { utenteId: P1, inizio: '2026-11-05T08:45:00.000Z', fine: '2026-11-05T09:30:00.000Z' }

function preparaAgenda(settimana: { appuntamenti?: unknown[]; slot?: unknown[] } = {}) {
  rotta('GET', /\/api\/admin\/crm\/appuntamenti$/, () => ({
    appuntamenti: settimana.appuntamenti ?? [visita()],
    slot: settimana.slot ?? [SLOT],
    persone: PERSONE,
  }))
  rotta('GET', /\/api\/admin\/crm\/persone$/, () => ({ data: PERSONE }))
}

async function montaAgenda(onApriScheda: (id: string) => void = () => {}) {
  render(<AgendaSettimana scuolaId={SEDE_A} onApriScheda={onApriScheda} />)
  await screen.findByRole('table')
}

const richiesteAgenda = () => quante('GET', /\/api\/admin\/crm\/appuntamenti$/)

// ═════════════════════════════════════════════════════════════════════════════════════
// L'agenda della settimana
// ═════════════════════════════════════════════════════════════════════════════════════

describe('AgendaSettimana · la settimana', () => {
  it('mostra da lunedì a sabato, con una colonna per persona, e chiede la settimana giusta', async () => {
    preparaAgenda()
    await montaAgenda()

    const giorni = screen.getAllByRole('rowheader').map((r) => r.textContent?.match(/^[^\d]+/)?.[0])
    expect(giorni).toEqual(['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'])
    expect(screen.getByRole('columnheader', { name: 'Prima Prova' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Seconda Prova' })).toBeTruthy()

    const richiesta = richiesteAgenda()[0]
    expect(richiesta.query.get('scuolaId')).toBe(SEDE_A)
    expect(richiesta.query.get('dal')).toBe('2026-11-02') // il lunedì di mercoledì 4
    expect(richiesta.query.get('al')).toBe('2026-11-07') // il sabato
  })

  it.each([
    ['di domenica a Roma guarda già la settimana che viene', '2026-11-08T10:00:00Z', '2026-11-09'],
    // Sabato 23:30 UTC è già domenica 00:30 a Roma: con la data UTC si aprirebbe la settimana che finisce.
    ['sabato notte (già domenica a Roma) idem', '2026-11-07T23:30:00Z', '2026-11-09'],
    // Domenica 25/10 alle 02:30 a Roma (ora legale, prima del cambio): domenica, quindi la settimana dopo.
    ['domenica del cambio d’ora, prima del cambio', '2026-10-25T00:30:00Z', '2026-10-26'],
    // Lunedì 00:30 a Roma = domenica 23:30 UTC: è lunedì, la settimana è questa.
    ['lunedì dopo mezzanotte a Roma (ancora domenica in UTC)', '2026-10-25T23:30:00Z', '2026-10-26'],
  ])('%s', async (_nome, adesso, lunedi) => {
    vi.setSystemTime(new Date(adesso))
    preparaAgenda({ appuntamenti: [], slot: [] })
    await montaAgenda()
    expect(richiesteAgenda()[0].query.get('dal')).toBe(lunedi)
  })

  it('le frecce portano alla settimana prima e dopo, anche attraverso il cambio dell’ora legale', async () => {
    preparaAgenda({ appuntamenti: [], slot: [] })
    await montaAgenda()

    fireEvent.click(screen.getByRole('button', { name: 'Settimana precedente' }))
    await waitFor(() => expect(richiesteAgenda().at(-1)?.query.get('dal')).toBe('2026-10-26'))
    fireEvent.click(screen.getByRole('button', { name: 'Settimana precedente' }))
    // 19 ottobre: prima del cambio d'ora del 25. Sommare 7×24 ore avrebbe sbagliato giorno.
    await waitFor(() => expect(richiesteAgenda().at(-1)?.query.get('dal')).toBe('2026-10-19'))
    expect(richiesteAgenda().at(-1)?.query.get('al')).toBe('2026-10-24')

    fireEvent.click(screen.getByRole('button', { name: 'Settimana successiva' }))
    await waitFor(() => expect(richiesteAgenda().at(-1)?.query.get('dal')).toBe('2026-10-26'))

    fireEvent.click(screen.getByRole('button', { name: 'Questa settimana' }))
    await waitFor(() => expect(richiesteAgenda().at(-1)?.query.get('dal')).toBe('2026-11-02'))
  })

  it('una visita sta nel giorno di Roma, non nel giorno UTC (dopo il cambio dell’ora legale)', async () => {
    vi.setSystemTime(new Date('2026-10-28T09:00:00Z'))
    preparaAgenda({
      slot: [],
      appuntamenti: [
        // Domenica 25 alle 23:30 UTC = lunedì 26 alle 00:30 a Roma (ora solare).
        visita({ id: V1, inizio: '2026-10-25T23:30:00.000Z', fine: '2026-10-26T00:15:00.000Z', assegnata_a: P1 }),
        // Sabato 31 alle 22:30 UTC = sabato 31 alle 23:30 a Roma.
        visita({ id: V2, inizio: '2026-10-31T22:30:00.000Z', fine: '2026-10-31T23:15:00.000Z', assegnata_a: P1, scheda: { id: S1, genitore_nome: 'Famiglia Prova' } }),
      ],
    })
    await montaAgenda()

    const riga = (nome: RegExp) => screen.getByRole('rowheader', { name: nome }).closest('tr') as HTMLElement
    expect(within(riga(/^Lunedì/)).getByText('00:30')).toBeTruthy()
    expect(within(riga(/^Sabato/)).getByText('23:30')).toBeTruthy()
  })

  it('una richiesta fallita lo dice e permette di riprovare', async () => {
    rotte.push({ metodo: 'GET', percorso: /\/appuntamenti$/, risposta: () => errore(500, 'ERRORE_INTERNO') })
    render(<AgendaSettimana scuolaId={SEDE_A} onApriScheda={() => {}} />)
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('AgendaSettimana · le visite', () => {
  it('mostra la famiglia e il suo clic apre la scheda', async () => {
    const onApri = vi.fn()
    preparaAgenda()
    await montaAgenda(onApri)
    fireEvent.click(screen.getByRole('button', { name: 'Apri la scheda di Famiglia Prova' }))
    expect(onApri).toHaveBeenCalledWith(S1)
  })

  it('segna «fuori disponibilità» e «da chiudere», e conta le visite da chiudere', async () => {
    preparaAgenda({
      slot: [],
      appuntamenti: [
        visita({ id: V1, fuori_disponibilita: true }),
        visita({ id: V2, inizio: '2026-11-02T09:00:00.000Z', fine: '2026-11-02T09:45:00.000Z', da_chiudere: true, assegnata_a: P1 }),
      ],
    })
    await montaAgenda()
    expect(screen.getByText('Fuori disponibilità')).toBeTruthy()
    expect(screen.getByText('Da chiudere')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(
      'C’è 1 visita già passata da chiudere: segna se è stata svolta o se la famiglia non si è presentata.',
    )
  })

  it('con più visite da chiudere il conteggio va al plurale', async () => {
    preparaAgenda({
      slot: [],
      appuntamenti: [
        visita({ id: V1, da_chiudere: true }),
        visita({ id: V2, inizio: '2026-11-02T09:00:00.000Z', fine: '2026-11-02T09:45:00.000Z', da_chiudere: true, assegnata_a: P1 }),
      ],
    })
    await montaAgenda()
    expect(screen.getByRole('status').textContent).toMatch(/^Ci sono 2 visite già passate da chiudere/)
  })

  it('una visita di chi non è più della sede non sparisce: ha una colonna sua', async () => {
    preparaAgenda({ slot: [], appuntamenti: [visita({ assegnata_a: P_ESTRANEA })] })
    await montaAgenda()
    expect(screen.getByRole('columnheader', { name: 'Persona non più della sede' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apri la scheda di Famiglia Prova' })).toBeTruthy()
  })

  it('una visita già chiusa non offre i comandi rapidi', async () => {
    preparaAgenda({ slot: [], appuntamenti: [visita({ stato: 'svolto' })] })
    await montaAgenda()
    expect(screen.getByRole('button', { name: 'Apri la scheda di Famiglia Prova' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Svolta:/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Sposta:/ })).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════
// Slot libero → Fissa visita
// ═════════════════════════════════════════════════════════════════════════════════════

describe('AgendaSettimana · gli slot liberi', () => {
  it('clic su uno slot libero → FissaVisita con quell’ora e quella persona', async () => {
    preparaAgenda()
    await montaAgenda()

    fireEvent.click(screen.getByRole('button', { name: /^Fissa una visita Giovedì 5 novembre, ore 09:45, con Prima Prova$/ }))

    const dialogo = await screen.findByRole('dialog', { name: 'Fissa una visita' })
    expect((within(dialogo).getByLabelText('Ora') as HTMLInputElement).value).toBe('09:45')
    expect((within(dialogo).getByLabelText('Giorno') as HTMLInputElement).value).toBe('05/11/2026')
    // La persona arriva dall'elenco della sede: si aspetta che le opzioni ci siano, poi si guarda la scelta.
    await waitFor(() => expect((within(dialogo).getByLabelText('Persona') as HTMLSelectElement).value).toBe(P1))
  })

  it('senza una famiglia scelta non fissa niente e lo dice', async () => {
    preparaAgenda()
    await montaAgenda()
    fireEvent.click(screen.getByRole('button', { name: /ore 09:45/ }))
    const dialogo = await screen.findByRole('dialog', { name: 'Fissa una visita' })
    await waitFor(() => expect((within(dialogo).getByLabelText('Persona') as HTMLSelectElement).value).toBe(P1))

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Fissa la visita' }))
    expect((await within(dialogo).findByRole('alert')).textContent).toBe('Scegli la famiglia, il giorno, l’ora e la persona.')
    expect(quante('POST', /appuntamenti$/)).toHaveLength(0)
  })

  it('«Fissa una visita» in alto apre il dialogo senza ora né persona decise', async () => {
    preparaAgenda()
    await montaAgenda()
    fireEvent.click(screen.getByRole('button', { name: 'Fissa una visita' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Fissa una visita' })
    // Proposta: domani (giovedì 5) alle 10:00 di Roma.
    expect((within(dialogo).getByLabelText('Giorno') as HTMLInputElement).value).toBe('05/11/2026')
    expect((within(dialogo).getByLabelText('Ora') as HTMLInputElement).value).toBe('10:00')
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════
// Il dialogo Fissa visita
// ═════════════════════════════════════════════════════════════════════════════════════

function montaDialogo(props: Partial<React.ComponentProps<typeof FissaVisita>> = {}) {
  const onFatto = vi.fn()
  const onAnnulla = vi.fn()
  rotta('GET', /\/api\/admin\/crm\/persone$/, () => ({ data: PERSONE }))
  render(<FissaVisita scuolaId={SEDE_A} onFatto={onFatto} onAnnulla={onAnnulla} {...props} />)
  return { onFatto, onAnnulla }
}

describe('FissaVisita · fissare', () => {
  it('manda scheda, ora, durata e persona, e a riuscita avvisa chi l’ha aperto', async () => {
    rotta('POST', /appuntamenti$/, () => json({ id: V1, fuori_disponibilita: false }, 201))
    const { onFatto } = montaDialogo({ schedaId: S1, inizioProposto: SLOT.inizio, assegnataProposta: P1 })

    fireEvent.click(screen.getByRole('button', { name: 'Fissa la visita' }))
    await waitFor(() => expect(onFatto).toHaveBeenCalledTimes(1))

    expect(ultima('POST', /appuntamenti$/)?.corpo).toEqual({
      schedaId: S1,
      inizio: '2026-11-05T08:45:00.000Z',
      durataMin: 45,
      assegnataA: P1,
    })
  })

  it('409 SLOT_OCCUPATO → messaggio e il dialogo resta aperto', async () => {
    rotta('POST', /appuntamenti$/, () => errore(409, 'SLOT_OCCUPATO'))
    const { onFatto, onAnnulla } = montaDialogo({ schedaId: S1, inizioProposto: SLOT.inizio, assegnataProposta: P1 })

    fireEvent.click(screen.getByRole('button', { name: 'Fissa la visita' }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain(shared.erroreCrmSlotOccupato)
    // Il dialogo non si è chiuso, nessuno è stato avvisato di una visita fissata, e l'ora è ancora lì da cambiare.
    expect(screen.getByRole('dialog', { name: 'Fissa una visita' })).toBeTruthy()
    expect(onFatto).not.toHaveBeenCalled()
    expect(onAnnulla).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Ora') as HTMLInputElement).value).toBe('09:45')
    // E il pulsante è di nuovo premibile: si cambia l'ora e si riprova.
    expect((screen.getByRole('button', { name: 'Fissa la visita' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('un altro rifiuto del server mostra il testo del catalogo e non chiude', async () => {
    rotta('POST', /appuntamenti$/, () => errore(403, 'PERSONA_NON_DELLA_SEDE'))
    const { onFatto } = montaDialogo({ schedaId: S1, inizioProposto: SLOT.inizio, assegnataProposta: P1 })
    fireEvent.click(screen.getByRole('button', { name: 'Fissa la visita' }))
    expect((await screen.findByRole('alert')).textContent).toContain(shared.erroreCrmPersonaNonDellaSede)
    expect(onFatto).not.toHaveBeenCalled()
  })

  it('senza ora proposta, «domani alle 10» è l’ora di Roma anche a cavallo del cambio d’ora', async () => {
    // Sabato 24/10 alle 10:00 a Roma (ora legale, 08:00 UTC): domani, domenica 25, il cambio è già avvenuto.
    vi.setSystemTime(new Date('2026-10-24T08:00:00Z'))
    rotta('POST', /appuntamenti$/, () => json({ id: V1, fuori_disponibilita: false }, 201))
    const { onFatto } = montaDialogo({ schedaId: S1, assegnataProposta: P1 })

    expect((screen.getByLabelText('Giorno') as HTMLInputElement).value).toBe('25/10/2026')
    expect((screen.getByLabelText('Ora') as HTMLInputElement).value).toBe('10:00')
    fireEvent.click(screen.getByRole('button', { name: 'Fissa la visita' }))
    await waitFor(() => expect(onFatto).toHaveBeenCalled())
    // 10:00 del 25/10 a Roma è ora solare: 09:00 UTC. Sommare 24 ore a «adesso» darebbe le 08:00 UTC.
    expect(ultima('POST', /appuntamenti$/)?.corpo?.inizio).toBe('2026-10-25T09:00:00.000Z')
  })

  it('una proposta come orologio a muro (senza fuso) è letta come ora di Roma, anche su un dispositivo in un altro fuso', () => {
    // Un dispositivo a New York leggerebbe `2026-10-25T10:00` come le 10 di New York (15:00 a Roma).
    const prima = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      montaDialogo({ schedaId: S1, inizioProposto: '2026-10-25T10:00', assegnataProposta: P1 })
      expect((screen.getByLabelText('Ora') as HTMLInputElement).value).toBe('10:00')
      expect((screen.getByLabelText('Giorno') as HTMLInputElement).value).toBe('25/10/2026')
    } finally {
      if (prima === undefined) delete process.env.TZ
      else process.env.TZ = prima
    }
  })

  it('con una sola persona nella sede la propone da sé', async () => {
    rotta('GET', /\/api\/admin\/crm\/persone$/, () => ({ data: [PERSONE[0]] }))
    render(<FissaVisita scuolaId={SEDE_A} schedaId={S1} onFatto={() => {}} onAnnulla={() => {}} />)
    await waitFor(() => expect((screen.getByLabelText('Persona') as HTMLSelectElement).value).toBe(P1))
  })

  it('«Annulla» chiude senza chiamare il server', async () => {
    const { onAnnulla } = montaDialogo({ schedaId: S1, assegnataProposta: P1 })
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))
    expect(onAnnulla).toHaveBeenCalledTimes(1)
    expect(quante('POST', /appuntamenti$/)).toHaveLength(0)
  })
})

describe('FissaVisita · la famiglia', () => {
  it('cerca la famiglia, la sceglie e fissa per quella scheda', async () => {
    rotta('GET', /\/api\/admin\/crm\/schede$/, () => ({
      data: [{ id: S1, genitore_nome: 'Famiglia Prova', origine: 'sito', creata_il: '2026-10-01T00:00:00Z', bambini: [{ id: 'b1', nome: 'Bambino Prova', esito: 'in_valutazione', domanda_id: null }], prossima_visita: null, prossima_azione: null }],
      totale: 1,
    }))
    rotta('POST', /appuntamenti$/, () => json({ id: V1, fuori_disponibilita: false }, 201))
    const { onFatto } = montaDialogo({ inizioProposto: SLOT.inizio, assegnataProposta: P1 })

    fireEvent.change(screen.getByLabelText('Cerca una famiglia'), { target: { value: 'Prova' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }))
    const trovata = await screen.findByRole('button', { name: /Famiglia Prova/ })
    expect(ultima('GET', /schede$/)?.query.get('q')).toBe('Prova')
    expect(ultima('GET', /schede$/)?.query.get('scuolaId')).toBe(SEDE_A)
    fireEvent.click(trovata)

    fireEvent.click(screen.getByRole('button', { name: 'Fissa la visita' }))
    await waitFor(() => expect(onFatto).toHaveBeenCalled())
    expect(ultima('POST', /appuntamenti$/)?.corpo?.schedaId).toBe(S1)
  })

  it('una ricerca troppo corta non chiama il server', async () => {
    montaDialogo({ assegnataProposta: P1 })
    fireEvent.change(screen.getByLabelText('Cerca una famiglia'), { target: { value: 'P' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Scrivi almeno due lettere.')
    expect(quante('GET', /schede$/)).toHaveLength(0)
  })

  it('nessun risultato: lo dice e lascia creare una famiglia nuova', async () => {
    rotta('GET', /\/api\/admin\/crm\/schede$/, () => ({ data: [], totale: 0 }))
    montaDialogo({ assegnataProposta: P1 })
    fireEvent.change(screen.getByLabelText('Cerca una famiglia'), { target: { value: 'Nessuno' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerca' }))
    expect((await screen.findByText('Nessuna famiglia trovata. Puoi crearne una nuova.'))).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nuova famiglia' })).toBeTruthy()
  })
})

describe('FissaVisita · spostare', () => {
  it('parte dalla visita, e manda lo spostamento (non una visita nuova)', async () => {
    rotta('PATCH', new RegExp(`/appuntamenti/${V1}$`), () => json({ id: V1, fuori_disponibilita: false }))
    const visitaDaSpostare = visita({ assegnata_a: P1 })
    const { onFatto } = montaDialogo({ appuntamento: visitaDaSpostare as never })

    expect(screen.getByRole('dialog', { name: 'Sposta la visita' })).toBeTruthy()
    expect((screen.getByLabelText('Ora') as HTMLInputElement).value).toBe('10:00')
    expect((screen.getByLabelText('Giorno') as HTMLInputElement).value).toBe('03/11/2026')

    fireEvent.change(screen.getByLabelText('Ora'), { target: { value: '11:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sposta la visita' }))
    await waitFor(() => expect(onFatto).toHaveBeenCalled())

    expect(quante('POST', /appuntamenti$/)).toHaveLength(0)
    expect(ultima('PATCH', /appuntamenti\//)?.corpo).toEqual({
      azione: 'sposta',
      inizio: '2026-11-03T10:30:00.000Z', // 11:30 a Roma, ora solare
      durataMin: 45,
      assegnataA: P1,
    })
  })

  it('spostare la visita di chi non è più della sede non la riassegna di nascosto', async () => {
    rotta('PATCH', new RegExp(`/appuntamenti/${V1}$`), () => json({ id: V1, fuori_disponibilita: false }))
    const { onFatto } = montaDialogo({ appuntamento: visita({ assegnata_a: P_ESTRANEA }) as never })
    await waitFor(() => expect((screen.getByLabelText('Persona') as HTMLSelectElement).value).toBe(P_ESTRANEA))
    fireEvent.click(screen.getByRole('button', { name: 'Sposta la visita' }))
    await waitFor(() => expect(onFatto).toHaveBeenCalled())
    expect(ultima('PATCH', /appuntamenti\//)?.corpo?.assegnataA).toBe(P_ESTRANEA)
  })

  it('anche lo spostamento, su un orario occupato, resta aperto e lo spiega', async () => {
    rotta('PATCH', new RegExp(`/appuntamenti/${V1}$`), () => errore(409, 'SLOT_OCCUPATO'))
    const { onFatto } = montaDialogo({ appuntamento: visita({ assegnata_a: P1 }) as never })
    fireEvent.click(screen.getByRole('button', { name: 'Sposta la visita' }))
    expect((await screen.findByRole('alert')).textContent).toContain(shared.erroreCrmSlotOccupato)
    expect(onFatto).not.toHaveBeenCalled()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════
// I comandi rapidi dell'agenda
// ═════════════════════════════════════════════════════════════════════════════════════

describe('AgendaSettimana · i comandi rapidi', () => {
  it('svolto dall’agenda chiede chi l’ha svolto, proponendo l’assegnataria', async () => {
    preparaAgenda({ slot: [] }) // la visita è assegnata alla SECONDA persona (P2)
    rotta('PATCH', new RegExp(`/appuntamenti/${V1}$`), () => json({ id: V1, azione_id: 'x' }))
    await montaAgenda()

    fireEvent.click(screen.getByRole('button', { name: 'Svolta: Famiglia Prova, ore 10:00' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Visita svolta' })
    const scelta = within(dialogo).getByLabelText('Svolta da') as HTMLSelectElement
    expect(scelta.value).toBe(P2) // proposta: chi era assegnata, non chi sta cliccando

    // Chi segna può essere un'altra: la responsabile del richiamo è chi l'ha svolta.
    fireEvent.change(scelta, { target: { value: P1 } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Segna come svolta' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ultima('PATCH', /appuntamenti\//)?.corpo).toEqual({ azione: 'svolto', svoltoDa: P1 })
    // L'agenda si è ricaricata: la visita ora è chiusa.
    expect(richiesteAgenda().length).toBeGreaterThanOrEqual(2)
  })

  it('svolto senza una assegnataria fra le persone della sede non indovina: il pulsante resta spento', async () => {
    preparaAgenda({ slot: [], appuntamenti: [visita({ assegnata_a: P_ESTRANEA })] })
    await montaAgenda()
    fireEvent.click(screen.getByRole('button', { name: 'Svolta: Famiglia Prova, ore 10:00' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Visita svolta' })
    expect((within(dialogo).getByLabelText('Svolta da') as HTMLSelectElement).value).toBe('')
    expect((within(dialogo).getByRole('button', { name: 'Segna come svolta' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([
    ['non presentato', 'Non presentato: Famiglia Prova, ore 10:00', 'Famiglia non presentata', 'Segna come non presentata', { azione: 'non_presentato' }],
    ['annulla', 'Annulla la visita: Famiglia Prova, ore 10:00', 'Annullare la visita?', 'Sì, annulla la visita', { azione: 'annulla' }],
  ])('%s chiede conferma e poi manda il gesto', async (_nome, comando, titolo, conferma, corpo) => {
    preparaAgenda({ slot: [] })
    rotta('PATCH', new RegExp(`/appuntamenti/${V1}$`), () => json({ id: V1 }))
    await montaAgenda()

    fireEvent.click(screen.getByRole('button', { name: comando }))
    const dialogo = await screen.findByRole('dialog', { name: titolo })
    // Finché non si conferma, il server non sa niente.
    expect(quante('PATCH', /appuntamenti\//)).toHaveLength(0)
    fireEvent.click(within(dialogo).getByRole('button', { name: conferma }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ultima('PATCH', /appuntamenti\//)?.corpo).toEqual(corpo)
  })

  it('«Sposta» apre il dialogo di spostamento su quella visita', async () => {
    preparaAgenda({ slot: [], appuntamenti: [visita({ assegnata_a: P1 })] })
    await montaAgenda()
    fireEvent.click(screen.getByRole('button', { name: 'Sposta: Famiglia Prova, ore 10:00' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Sposta la visita' })
    expect((within(dialogo).getByLabelText('Ora') as HTMLInputElement).value).toBe('10:00')
  })

  it('se la visita è già stata chiusa da una collega lo dice, ricarica e non lascia riprovare', async () => {
    preparaAgenda({ slot: [] })
    rotta('PATCH', new RegExp(`/appuntamenti/${V1}$`), () => errore(409, 'STATO_NON_AMMESSO'))
    await montaAgenda()
    const prima = richiesteAgenda().length

    fireEvent.click(screen.getByRole('button', { name: 'Svolta: Famiglia Prova, ore 10:00' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Visita svolta' })
    fireEvent.change(within(dialogo).getByLabelText('Svolta da'), { target: { value: P1 } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Segna come svolta' }))

    expect((await within(dialogo).findByRole('alert')).textContent).toContain(shared.erroreCrmStatoNonAmmesso)
    expect(within(dialogo).queryByRole('button', { name: 'Segna come svolta' })).toBeNull()
    expect(within(dialogo).getByRole('button', { name: 'Chiudi' })).toBeTruthy()
    await waitFor(() => expect(richiesteAgenda().length).toBeGreaterThan(prima))
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════
// La disponibilità
// ═════════════════════════════════════════════════════════════════════════════════════

const FASCIA_P1 = {
  id: F1, scuola_id: SEDE_A, utente_id: P1, giorno_settimana: 1, ora_inizio: '09:00:00', ora_fine: '13:00:00',
  durata_slot_min: 45, valida_al: null, creata_il: '2026-09-01T00:00:00Z',
}
const FASCIA_P2 = { ...FASCIA_P1, id: F2, utente_id: P2, giorno_settimana: 2, ora_inizio: '15:00:00', ora_fine: '18:00:00' }

function preparaDisponibilita(o: { io?: { id: string; ruolo: string }; assenze?: unknown[]; fasce?: unknown[] } = {}) {
  rotta('GET', /\/api\/admin\/crm\/disponibilita$/, () => ({
    data: o.fasce ?? [FASCIA_P1, FASCIA_P2],
    io: o.io ?? { id: P1, ruolo: 'segreteria' },
  }))
  rotta('GET', /\/api\/admin\/crm\/indisponibilita$/, () => ({ data: o.assenze ?? [] }))
  rotta('GET', /\/api\/admin\/crm\/persone$/, () => ({ data: PERSONE }))
}

async function montaDisponibilita() {
  render(<DisponibilitaPersona scuolaId={SEDE_A} />)
  await screen.findByRole('heading', { name: 'Disponibilità' })
}

describe('DisponibilitaPersona · la settimana tipo', () => {
  it('la segreteria vede la PROPRIA settimana e non può scegliere un’altra persona', async () => {
    preparaDisponibilita()
    await montaDisponibilita()
    expect(screen.getByText('09:00–13:00')).toBeTruthy()
    expect(screen.queryByText('15:00–18:00')).toBeNull() // è della collega
    expect(screen.queryByLabelText('Persona')).toBeNull()
    expect(screen.getByRole('heading', { name: 'La mia settimana tipo' })).toBeTruthy()
  })

  it('l’admin può scegliere la persona e vede la sua settimana', async () => {
    preparaDisponibilita({ io: { id: P2, ruolo: 'admin' } })
    await montaDisponibilita()
    expect(screen.getByText('15:00–18:00')).toBeTruthy() // la propria, di default
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: P1 } })
    expect(screen.getByText('09:00–13:00')).toBeTruthy()
    expect(screen.queryByText('15:00–18:00')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Settimana tipo della persona' })).toBeTruthy()
  })

  it('aggiunge una fascia per sé: manda la sede, la persona e gli orari', async () => {
    preparaDisponibilita()
    rotta('POST', /\/disponibilita$/, () => json({ id: F1 }, 201))
    await montaDisponibilita()

    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi una fascia' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Nuova fascia' })
    fireEvent.change(within(dialogo).getByLabelText('Giorno'), { target: { value: '3' } })
    fireEvent.change(within(dialogo).getByLabelText('Dalle'), { target: { value: '14:30' } })
    fireEvent.change(within(dialogo).getByLabelText('Alle'), { target: { value: '17:00' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ultima('POST', /\/disponibilita$/)?.corpo).toEqual({
      scuolaId: SEDE_A,
      utenteId: P1,
      giornoSettimana: 3,
      oraInizio: '14:30',
      oraFine: '17:00',
      durataSlotMin: 45,
      validaAl: null,
    })
    // E la settimana si è riletta.
    expect(quante('GET', /\/disponibilita$/).length).toBeGreaterThanOrEqual(2)
  })

  it('l’admin che aggiunge una fascia a una collega manda quella persona', async () => {
    preparaDisponibilita({ io: { id: P2, ruolo: 'admin' } })
    rotta('POST', /\/disponibilita$/, () => json({ id: F1 }, 201))
    await montaDisponibilita()
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: P1 } })
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi una fascia' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Nuova fascia' })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    await waitFor(() => expect(quante('POST', /\/disponibilita$/)).toHaveLength(1))
    expect(ultima('POST', /\/disponibilita$/)?.corpo?.utenteId).toBe(P1)
  })

  it('un’ora di fine che non segue quella di inizio non parte', async () => {
    preparaDisponibilita()
    await montaDisponibilita()
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi una fascia' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Nuova fascia' })
    fireEvent.change(within(dialogo).getByLabelText('Alle'), { target: { value: '08:00' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    expect((await within(dialogo).findByRole('alert')).textContent).toBe('L’ora di fine deve essere dopo quella di inizio.')
    expect(quante('POST', /\/disponibilita$/)).toHaveLength(0)
  })

  it('modifica una fascia esistente con una PATCH', async () => {
    preparaDisponibilita()
    rotta('PATCH', new RegExp(`/disponibilita/${F1}$`), () => json({ id: F1 }))
    await montaDisponibilita()
    fireEvent.click(screen.getByRole('button', { name: 'Modifica la fascia Lunedì 09:00–13:00' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Modifica la fascia' })
    expect((within(dialogo).getByLabelText('Dalle') as HTMLInputElement).value).toBe('09:00')
    fireEvent.change(within(dialogo).getByLabelText('Alle'), { target: { value: '12:00' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ultima('PATCH', /\/disponibilita\//)?.corpo).toEqual({
      giornoSettimana: 1, oraInizio: '09:00', oraFine: '12:00', durataSlotMin: 45, validaAl: null,
    })
  })

  it('toglie una fascia solo dopo la conferma', async () => {
    preparaDisponibilita()
    rotta('DELETE', new RegExp(`/disponibilita/${F1}$`), () => json({ id: F1 }))
    await montaDisponibilita()
    fireEvent.click(screen.getByRole('button', { name: 'Elimina la fascia Lunedì 09:00–13:00' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Togliere la fascia?' })
    expect(quante('DELETE', /\/disponibilita\//)).toHaveLength(0)
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Togli' }))
    await waitFor(() => expect(quante('DELETE', /\/disponibilita\//)).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('un rifiuto del server (403) si legge nel dialogo e il dialogo resta', async () => {
    preparaDisponibilita()
    rotta('POST', /\/disponibilita$/, () => errore(403, 'SOLO_LA_PROPRIA'))
    await montaDisponibilita()
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi una fascia' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Nuova fascia' })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    expect((await within(dialogo).findByRole('alert')).textContent).toContain(shared.erroreCrmSoloLaPropria)
    expect(screen.getByRole('dialog', { name: 'Nuova fascia' })).toBeTruthy()
  })
})

describe('DisponibilitaPersona · assenze e chiusure', () => {
  // Il server memorizza gli intervalli con l'estremo finale ESCLUSO (mezzanotte del giorno dopo, a Roma).
  const FERIE = {
    id: A1, scuola_id: SEDE_A, utente_id: P1, motivo: 'ferie',
    dal: '2026-11-02T23:00:00.000Z', // 3 novembre 00:00 a Roma
    al: '2026-11-05T23:00:00.000Z', // 6 novembre 00:00 a Roma → ultimo giorno compreso: il 5
    creata_da: P1, creata_il: '2026-10-30T00:00:00Z',
  }
  const CHIUSURA = {
    id: C1, scuola_id: SEDE_A, utente_id: null, motivo: 'chiusura',
    dal: '2026-10-23T22:00:00.000Z', // 24 ottobre 00:00 (ora legale)
    al: '2026-10-26T23:00:00.000Z', // 27 ottobre 00:00 (ora solare) → ultimo giorno compreso: il 26
    creata_da: P2, creata_il: '2026-10-01T00:00:00Z',
  }

  it('mostra l’ultimo giorno COMPRESO, non la mezzanotte che chiude l’intervallo', async () => {
    preparaDisponibilita({ assenze: [FERIE] })
    await montaDisponibilita()
    expect(screen.getByText(/03\/11\/2026 – 05\/11\/2026/)).toBeTruthy()
    expect(screen.queryByText(/06\/11\/2026/)).toBeNull()
  })

  it('una chiusura a cavallo del cambio d’ora mostra comunque i giorni giusti', async () => {
    preparaDisponibilita({ assenze: [CHIUSURA] })
    await montaDisponibilita()
    expect(screen.getByText(/24\/10\/2026 – 26\/10\/2026/)).toBeTruthy()
  })

  it('le assenze delle colleghe non compaiono fra le proprie, le chiusure della sede sì', async () => {
    preparaDisponibilita({ assenze: [{ ...FERIE, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', utente_id: P2 }, CHIUSURA] })
    await montaDisponibilita()
    expect(screen.getByText('Nessuna assenza in programma.')).toBeTruthy()
    expect(screen.getByText(/24\/10\/2026 – 26\/10\/2026/)).toBeTruthy()
  })

  it('aggiunge un’assenza: giorni interi, per sé, con il motivo scelto', async () => {
    preparaDisponibilita()
    rotta('POST', /\/indisponibilita$/, () => json({ id: A1 }, 201))
    await montaDisponibilita()

    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi un’assenza' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Nuova assenza' })
    fireEvent.change(within(dialogo).getByLabelText('Dal'), { target: { value: '03/11/2026' } })
    fireEvent.change(within(dialogo).getByLabelText('Al'), { target: { value: '05/11/2026' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ultima('POST', /\/indisponibilita$/)?.corpo).toEqual({
      scuolaId: SEDE_A, utenteId: P1, motivo: 'ferie', dal: '2026-11-03', al: '2026-11-05',
    })
  })

  it('aggiunge una chiusura della sede: nessuna persona, motivo «chiusura»', async () => {
    preparaDisponibilita()
    rotta('POST', /\/indisponibilita$/, () => json({ id: C1 }, 201))
    await montaDisponibilita()

    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi una chiusura' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Nuova chiusura della sede' })
    expect(within(dialogo).queryByLabelText('Motivo')).toBeNull()
    fireEvent.change(within(dialogo).getByLabelText('Dal'), { target: { value: '24/12/2026' } })
    fireEvent.change(within(dialogo).getByLabelText('Al'), { target: { value: '06/01/2027' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ultima('POST', /\/indisponibilita$/)?.corpo).toEqual({
      scuolaId: SEDE_A, utenteId: null, motivo: 'chiusura', dal: '2026-12-24', al: '2027-01-06',
    })
  })

  it('un «al» prima del «dal» non parte', async () => {
    preparaDisponibilita()
    await montaDisponibilita()
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi un’assenza' }))
    const dialogo = await screen.findByRole('dialog', { name: 'Nuova assenza' })
    fireEvent.change(within(dialogo).getByLabelText('Dal'), { target: { value: '05/11/2026' } })
    fireEvent.change(within(dialogo).getByLabelText('Al'), { target: { value: '03/11/2026' } })
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Salva' }))
    expect((await within(dialogo).findByRole('alert')).textContent).toBe('L’ultimo giorno non può precedere il primo.')
    expect(quante('POST', /\/indisponibilita$/)).toHaveLength(0)
  })

  it('toglie un’assenza solo dopo la conferma', async () => {
    preparaDisponibilita({ assenze: [FERIE] })
    rotta('DELETE', new RegExp(`/indisponibilita/${A1}$`), () => json({ id: A1 }))
    await montaDisponibilita()
    fireEvent.click(screen.getByRole('button', { name: /^Elimina: .*03\/11\/2026 – 05\/11\/2026$/ }))
    const dialogo = await screen.findByRole('dialog', { name: 'Togliere l’assenza?' })
    expect(quante('DELETE', /\/indisponibilita\//)).toHaveLength(0)
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Togli' }))
    await waitFor(() => expect(quante('DELETE', /\/indisponibilita\//)).toHaveLength(1))
  })
})

describe('DisponibilitaPersona · quando qualcosa non va', () => {
  it('se la lettura fallisce lo dice e permette di riprovare', async () => {
    rotta('GET', /\/disponibilita$/, () => errore(500, 'ERRORE_INTERNO'))
    rotta('GET', /\/indisponibilita$/, () => ({ data: [] }))
    rotta('GET', /\/persone$/, () => ({ data: PERSONE }))
    render(<DisponibilitaPersona scuolaId={SEDE_A} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Non riesco a leggere la disponibilità')
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy()
  })
})
