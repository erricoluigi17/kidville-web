import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { SEDE_A } from '../../fixtures/sedi'
import { DettaglioVotazione } from '@/components/features/votazioni/admin/DettaglioVotazione'
import type { DettaglioVotazione as DettaglioDati, RisultatoScheda } from '@/lib/votazioni/tipi'
import shared from '../../../messages/it/shared.json'

/**
 * Votazioni dei rappresentanti · Task 7 — il dettaglio di una votazione nel pannello laterale.
 *
 * Il server è un finto che risponde per URL e metodo. Le date sono istanti ESTIVI apposta: a Roma
 * (UTC+2) un orario scritto in UTC e uno scritto a Roma differiscono, e un dettaglio che formattasse
 * nel fuso del dispositivo o in UTC lo direbbe subito.
 *
 * Regola di questo file: un'asserzione su un'ASSENZA viene SEMPRE dopo la presenza di qualcosa che
 * dimostri che i dati sono arrivati (`findBy…` sul titolo o sul testo che cambia).
 */

const VOT = '44444444-0000-4000-8000-000000000001'
const ALTRA = '44444444-0000-4000-8000-000000000002'
const CL_A = '55555555-0000-4000-8000-000000000001'
const U_ROSSI = '66666666-0000-4000-8000-000000000001'
const U_BIANCHI = '66666666-0000-4000-8000-000000000002'
const U_VERDI = '66666666-0000-4000-8000-000000000003'
const E_1 = '77777777-0000-4000-8000-000000000001'
const E_2 = '77777777-0000-4000-8000-000000000002'

/** 15 luglio 2026, 16:00 UTC = 18:00 a Roma (ora legale). */
const SCADENZA = '2026-07-15T16:00:00.000Z'
const CHIUSA_IL = '2026-07-12T10:00:00.000Z'

function schedaClasse(over: Partial<RisultatoScheda> = {}): RisultatoScheda {
  return {
    ambito: 'classe',
    sectionId: CL_A,
    nome: '3 ANNI',
    aventiDiritto: 30,
    votanti: 12,
    candidati: [
      { utenteId: U_ROSSI, nome: 'Rossi Maria', voti: 7 },
      { utenteId: U_BIANCHI, nome: 'Bianchi Anna', voti: 3 },
      { utenteId: U_VERDI, nome: 'Verdi Lucia', voti: 2 },
    ],
    eletti: [U_ROSSI],
    voti: [
      { elettoreId: E_1, elettoreNome: 'Neri Paolo', candidatoId: U_ROSSI, candidatoNome: 'Rossi Maria', votatoIl: '2026-07-10T08:30:00.000Z', aggiornatoIl: null },
      { elettoreId: E_2, elettoreNome: 'Gialli Sara', candidatoId: U_BIANCHI, candidatoNome: 'Bianchi Anna', votatoIl: '2026-07-10T09:00:00.000Z', aggiornatoIl: '2026-07-11T07:15:00.000Z' },
    ],
    ...over,
  }
}

function votazione(over: Partial<DettaglioDati> = {}): DettaglioDati {
  return {
    id: VOT,
    scuolaId: SEDE_A,
    titolo: 'Elezioni 2026',
    scadenza: SCADENZA,
    chiusaIl: null,
    stato: 'aperta',
    rappresentanteIstituto: false,
    classi: [{ sectionId: CL_A, nome: '3 ANNI', grado: 'infanzia' }],
    votanti: 12,
    creataIl: '2026-06-01T08:00:00.000Z',
    candidatiIstituto: [],
    schede: [schedaClasse()],
    ...over,
  }
}

const h = vi.hoisted(() => ({
  votazione: null as unknown,
  letturaStato: 200,
  letturaCodice: null as string | null,
  /** Risposta a PATCH/DELETE: di default 200, applicando l'effetto alla votazione finta. */
  rispostaPatch: null as null | ((corpo: Record<string, unknown>) => Response | Promise<Response>),
  rispostaDelete: null as null | (() => Response | Promise<Response>),
  chiamate: [] as { metodo: string; url: string; corpo: Record<string, unknown> | null }[],
}))

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } })

const percorso = `/api/admin/votazioni/${VOT}`
const letture = () => h.chiamate.filter((c) => c.metodo === 'GET' && c.url === percorso)
const scritture = (metodo: 'PATCH' | 'DELETE') => h.chiamate.filter((c) => c.metodo === metodo)

beforeEach(() => {
  h.votazione = votazione()
  h.letturaStato = 200
  h.letturaCodice = null
  h.rispostaPatch = null
  h.rispostaDelete = null
  h.chiamate = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const metodo = init?.method ?? 'GET'
      const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      h.chiamate.push({ metodo, url: url.pathname + url.search, corpo })

      if (url.pathname === `/api/admin/votazioni/${ALTRA}` && metodo === 'GET') {
        return json({ votazione: votazione({ id: ALTRA, titolo: 'Altra votazione' }) })
      }
      if (url.pathname !== percorso) return json({ error: 'non previsto' }, 404)

      if (metodo === 'GET') {
        if (h.letturaStato !== 200) return json({ error: 'x', codice: h.letturaCodice ?? undefined }, h.letturaStato)
        return json({ votazione: h.votazione })
      }
      if (metodo === 'PATCH') {
        if (h.rispostaPatch) return h.rispostaPatch(corpo ?? {})
        if (corpo?.azione === 'chiudi') {
          h.votazione = votazione({ stato: 'chiusa', chiusaIl: CHIUSA_IL })
        } else if (corpo?.azione === 'proroga') {
          h.votazione = votazione({ scadenza: '2030-12-31T17:00:00.000Z' })
        }
        return json({ ok: true })
      }
      if (metodo === 'DELETE') {
        return h.rispostaDelete ? h.rispostaDelete() : json({ ok: true })
      }
      return json({ error: 'non previsto' }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function monta(votazioneId = VOT) {
  const onChiudi = vi.fn()
  const onCambiata = vi.fn()
  const onEliminata = vi.fn()
  const r = render(
    <DettaglioVotazione votazioneId={votazioneId} onChiudi={onChiudi} onCambiata={onCambiata} onEliminata={onEliminata} />,
  )
  return { onChiudi, onCambiata, onEliminata, ...r }
}

/** Il dettaglio è arrivato: da qui in poi le asserzioni sull'assenza non sono vuote. */
const arrivato = (titolo = 'Elezioni 2026') => screen.findByRole('heading', { name: titolo })

const comando = (nome: string) => screen.queryByRole('button', { name: nome })

/** Il testo di ogni cella, riga per riga (intestazioni comprese): la forma della tabella, non il suo aspetto. */
const contenutoTabella = (tabella: HTMLElement) =>
  within(tabella)
    .getAllByRole('row')
    .map((riga) => Array.from(riga.children).map((cella) => cella.textContent))

// ─────────────────────────────────────────────────────────────────────────────
describe('DettaglioVotazione · la testata', () => {
  it('chiede la votazione per id e mostra titolo, stato e scadenza (ora di Roma)', async () => {
    monta()
    await arrivato()

    expect(letture()).toHaveLength(1)
    expect(screen.getByText('Aperta')).toBeTruthy()
    // 16:00 UTC di luglio sono le 18:00 a Roma.
    expect(screen.getByText('Scadenza: 15/07/2026, 18:00')).toBeTruthy()
  })

  it('una votazione chiusa a mano lo dice, con l’ora di Roma', async () => {
    h.votazione = votazione({ stato: 'chiusa', chiusaIl: CHIUSA_IL })
    monta()
    await arrivato()

    expect(screen.getByText('Chiusa')).toBeTruthy()
    expect(screen.getByText('Chiusa a mano il 12/07/2026, 12:00')).toBeTruthy()
  })

  it('una votazione scaduta da sola è «Chiusa» ma NON «chiusa a mano»', async () => {
    h.votazione = votazione({ stato: 'chiusa', chiusaIl: null })
    monta()
    await arrivato()

    expect(screen.getByText('Chiusa')).toBeTruthy()
    expect(screen.queryByText(/^Chiusa a mano/)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DettaglioVotazione · le schede', () => {
  it('per la classe: nome, affluenza «12 su 30», candidati con i voti, eletto', async () => {
    monta()
    await arrivato()

    expect(screen.getByRole('heading', { name: 'Classe 3 ANNI' })).toBeTruthy()
    expect(screen.getByText('12 su 30 hanno votato')).toBeTruthy()

    const tabella = screen.getByRole('table', { name: 'Classe 3 ANNI' })
    expect(contenutoTabella(tabella)).toEqual([
      ['Candidato', 'Voti'],
      ['Rossi Maria', '7'],
      ['Bianchi Anna', '3'],
      ['Verdi Lucia', '2'],
    ])
    expect(screen.getByText('Eletto: Rossi Maria')).toBeTruthy()
  })

  it('un solo votante su trenta si legge al singolare', async () => {
    h.votazione = votazione({ schede: [schedaClasse({ votanti: 1 })] })
    monta()
    await arrivato()

    expect(screen.getByText('1 su 30 ha votato')).toBeTruthy()
  })

  it('la parità dice chi sono i pari e che decide la segreteria — e non dice «Eletto»', async () => {
    h.votazione = votazione({
      schede: [
        schedaClasse({
          candidati: [
            { utenteId: U_BIANCHI, nome: 'Bianchi Anna', voti: 5 },
            { utenteId: U_ROSSI, nome: 'Rossi Maria', voti: 5 },
            { utenteId: U_VERDI, nome: 'Verdi Lucia', voti: 1 },
          ],
          eletti: [U_BIANCHI, U_ROSSI],
        }),
      ],
    })
    monta()
    await arrivato()

    expect(screen.getByText('Parità fra Bianchi Anna e Rossi Maria: decide la segreteria')).toBeTruthy()
    expect(screen.queryByText(/^Eletto:/)).toBeNull()
  })

  it('una parità a tre elenca i nomi con la virgola e la «e» finale', async () => {
    h.votazione = votazione({
      schede: [
        schedaClasse({
          candidati: [
            { utenteId: U_BIANCHI, nome: 'Bianchi Anna', voti: 4 },
            { utenteId: U_ROSSI, nome: 'Rossi Maria', voti: 4 },
            { utenteId: U_VERDI, nome: 'Verdi Lucia', voti: 4 },
          ],
          eletti: [U_BIANCHI, U_ROSSI, U_VERDI],
        }),
      ],
    })
    monta()
    await arrivato()

    expect(screen.getByText('Parità fra Bianchi Anna, Rossi Maria e Verdi Lucia: decide la segreteria')).toBeTruthy()
  })

  it('una classe senza genitori (0 su 0) non divide per zero: niente NaN, «Nessun voto», niente tabelle', async () => {
    h.votazione = votazione({
      votanti: 0,
      schede: [schedaClasse({ aventiDiritto: 0, votanti: 0, candidati: [], eletti: [], voti: [] })],
    })
    monta()
    await arrivato()

    expect(screen.getByText('0 su 0 hanno votato')).toBeTruthy()
    expect(screen.getByText('Nessun voto')).toBeTruthy()
    expect(document.body.textContent).not.toContain('NaN')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('l’istituto elenca TUTTI i candidati anche a zero voti, e senza voti dice «Nessun voto»', async () => {
    h.votazione = votazione({
      rappresentanteIstituto: true,
      votanti: 0,
      schede: [
        {
          ambito: 'istituto',
          sectionId: null,
          nome: 'Kidville Giugliano',
          aventiDiritto: 80,
          votanti: 0,
          candidati: [
            { utenteId: U_ROSSI, nome: 'Rossi Maria', voti: 0 },
            { utenteId: U_VERDI, nome: 'Verdi Lucia', voti: 0 },
          ],
          eletti: [],
          voti: [],
        },
      ],
    })
    monta()
    await arrivato()

    expect(screen.getByRole('heading', { name: 'Rappresentante d’istituto — Kidville Giugliano' })).toBeTruthy()
    const tabella = screen.getByRole('table', { name: 'Rappresentante d’istituto — Kidville Giugliano' })
    expect(contenutoTabella(tabella)).toEqual([
      ['Candidato', 'Voti'],
      ['Rossi Maria', '0'],
      ['Verdi Lucia', '0'],
    ])
    expect(screen.getByText('Nessun voto')).toBeTruthy()
    expect(screen.getByText('0 su 80 hanno votato')).toBeTruthy()
  })

  it('più schede: ciascuna ha il suo titolo, la sua affluenza e il suo esito', async () => {
    h.votazione = votazione({
      rappresentanteIstituto: true,
      schede: [
        schedaClasse(),
        {
          ambito: 'istituto',
          sectionId: null,
          nome: 'Kidville Giugliano',
          aventiDiritto: 80,
          votanti: 40,
          candidati: [{ utenteId: U_VERDI, nome: 'Verdi Lucia', voti: 40 }],
          eletti: [U_VERDI],
          voti: [],
        },
      ],
    })
    monta()
    await arrivato()

    expect(screen.getAllByRole('heading', { level: 3 }).map((e) => e.textContent)).toEqual([
      'Classe 3 ANNI',
      'Rappresentante d’istituto — Kidville Giugliano',
    ])
    expect(screen.getByText('Eletto: Rossi Maria')).toBeTruthy()
    expect(screen.getByText('Eletto: Verdi Lucia')).toBeTruthy()
    expect(screen.getByText('40 su 80 hanno votato')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DettaglioVotazione · «Chi ha votato chi»', () => {
  it('elenca elettore, scelta e ora di Roma; «modificato» solo dove c’è `aggiornatoIl`', async () => {
    monta()
    await arrivato()

    const tabella = screen.getByRole('table', { name: 'Chi ha votato chi — Classe 3 ANNI' })
    const intestazioni = within(tabella).getAllByRole('columnheader').map((c) => c.textContent)
    expect(intestazioni).toEqual(['Elettore', 'Scelta', 'Ora'])

    const righe = within(tabella).getAllByRole('row').slice(1)
    expect(righe).toHaveLength(2)

    const [primo, secondo] = righe.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent ?? ''))
    // 08:30 UTC di luglio = 10:30 a Roma. Nessun «modificato» sul voto mai cambiato.
    expect(primo[0]).toBe('Neri Paolo')
    expect(primo[1]).toBe('Rossi Maria')
    expect(primo[2]).toContain('10/07/2026, 10:30')
    expect(primo[2]).not.toContain('modificato')
    // Il voto cambiato mostra l'ora dell'ULTIMA scelta (07:15 UTC = 09:15 a Roma) e lo dice.
    expect(secondo[0]).toBe('Gialli Sara')
    expect(secondo[1]).toBe('Bianchi Anna')
    expect(secondo[2]).toContain('11/07/2026, 09:15')
    expect(secondo[2]).toContain('modificato')

    // Una sola etichetta in tutta la pagina, e sta nella riga giusta.
    const etichette = screen.getAllByText('modificato')
    expect(etichette).toHaveLength(1)
    expect(righe[1].contains(etichette[0])).toBe(true)
  })

  it('senza voti non c’è la tabella', async () => {
    h.votazione = votazione({ schede: [schedaClasse({ voti: [], votanti: 0, eletti: [], candidati: [] })] })
    monta()
    await arrivato()

    expect(screen.queryByRole('table', { name: 'Chi ha votato chi — Classe 3 ANNI' })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DettaglioVotazione · quali comandi si vedono', () => {
  const CHIUSA = { stato: 'chiusa', chiusaIl: CHIUSA_IL } as const

  it.each([
    ['aperta, con voti', { stato: 'aperta', chiusaIl: null, votanti: 12 }, { chiudi: true, proroga: true, elimina: false }],
    ['aperta, senza voti', { stato: 'aperta', chiusaIl: null, votanti: 0 }, { chiudi: true, proroga: true, elimina: true }],
    // Scaduta da sola: non si «chiude» (lo è già), ma si può RIAPRIRE con una proroga.
    ['scaduta da sola, con voti', { stato: 'chiusa', chiusaIl: null, votanti: 12 }, { chiudi: false, proroga: true, elimina: false }],
    // Chiusa a mano: una scelta della segreteria, che il server non lascia annullare con una proroga.
    ['chiusa a mano, con voti', { ...CHIUSA, votanti: 12 }, { chiudi: false, proroga: false, elimina: false }],
    ['chiusa a mano, senza voti', { ...CHIUSA, votanti: 0 }, { chiudi: false, proroga: false, elimina: true }],
  ] as const)('%s', async (_nome, dati, atteso) => {
    h.votazione = votazione({ ...dati })
    monta()
    await arrivato()

    expect(comando('Chiudi ora') !== null).toBe(atteso.chiudi)
    expect(comando('Proroga') !== null).toBe(atteso.proroga)
    expect(comando('Elimina') !== null).toBe(atteso.elimina)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DettaglioVotazione · «Chiudi ora»', () => {
  it('chiede conferma; «No» non scrive niente; «Sì» manda `chiudi`, rilegge e avvisa l’elenco', async () => {
    const { onCambiata } = monta()
    await arrivato()

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi ora' }))
    expect(screen.getByText('Chiudere ora la votazione? I genitori non potranno più votare.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'No, lascia aperta' }))
    expect(screen.queryByText('Chiudere ora la votazione? I genitori non potranno più votare.')).toBeNull()
    expect(scritture('PATCH')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi ora' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, chiudi' }))

    await screen.findByText('Votazione chiusa.')
    expect(scritture('PATCH')).toHaveLength(1)
    expect(scritture('PATCH')[0]).toMatchObject({ url: percorso, corpo: { azione: 'chiudi' } })
    expect(onCambiata).toHaveBeenCalledTimes(1)
    // La rilettura porta lo stato nuovo: il badge passa a «Chiusa» e «Chiudi ora» sparisce.
    await screen.findByText('Chiusa')
    expect(letture()).toHaveLength(2)
    expect(comando('Chiudi ora')).toBeNull()
  })

  it('un doppio clic su «Sì, chiudi» manda UNA scrittura sola', async () => {
    let sblocca!: () => void
    const bloccata = new Promise<void>((r) => {
      sblocca = r
    })
    h.rispostaPatch = async () => {
      await bloccata
      return json({ ok: true })
    }
    monta()
    await arrivato()

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi ora' }))
    const si = screen.getByRole('button', { name: 'Sì, chiudi' })
    fireEvent.click(si)
    fireEvent.click(si)
    sblocca()

    await screen.findByText('Votazione chiusa.')
    expect(scritture('PATCH')).toHaveLength(1)
  })

  it('un 409 «già chiusa» lo dice con parole da segreteria, rilegge lo stato e avvisa l’elenco', async () => {
    h.rispostaPatch = () => {
      h.votazione = votazione({ stato: 'chiusa', chiusaIl: CHIUSA_IL })
      return json({ error: 'x', codice: 'VOTAZIONE_CHIUSA' }, 409)
    }
    const { onCambiata } = monta()
    await arrivato()

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi ora' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, chiudi' }))

    expect((await screen.findByRole('alert')).textContent).toBe('La votazione era già chiusa. Ecco lo stato aggiornato.')
    await screen.findByText('Chiusa')
    expect(letture()).toHaveLength(2)
    expect(onCambiata).toHaveBeenCalledTimes(1)
  })

  it('un guasto del server dice il testo del catalogo e lascia il comando per riprovare', async () => {
    h.rispostaPatch = () => json({ error: 'x', codice: 'VOTAZIONE_OPERAZIONE_NON_RIUSCITA' }, 500)
    const { onCambiata } = monta()
    await arrivato()

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi ora' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, chiudi' }))

    expect((await screen.findByRole('alert')).textContent).toBe(shared.erroreVotazioneOperazioneNonRiuscita)
    expect(onCambiata).not.toHaveBeenCalled()
    expect(letture()).toHaveLength(1)
    expect(comando('Chiudi ora')).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DettaglioVotazione · «Proroga»', () => {
  it('apre la scadenza attuale (ora di Roma); si conferma solo dopo averla cambiata; manda cifre locali', async () => {
    const { onCambiata } = monta()
    await arrivato()

    fireEvent.click(screen.getByRole('button', { name: 'Proroga' }))
    // Mentre il pannello è aperto gli altri comandi non ci sono.
    expect(comando('Chiudi ora')).toBeNull()
    expect(screen.getByRole('group', { name: 'Nuova scadenza' })).toBeTruthy()
    expect((screen.getByLabelText('Giorno') as HTMLInputElement).value).toBe('15/07/2026')
    expect((screen.getByLabelText('Ora') as HTMLInputElement).value).toBe('18:00')
    // Uguale a quella di prima: non c'è niente da prorogare.
    const conferma = screen.getByRole('button', { name: 'Conferma la proroga' }) as HTMLButtonElement
    expect(conferma.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Giorno'), { target: { value: '31/12/2030' } })
    expect(conferma.disabled).toBe(false)
    fireEvent.click(conferma)

    await screen.findByText('Scadenza prorogata.')
    expect(scritture('PATCH')).toHaveLength(1)
    expect(scritture('PATCH')[0]).toMatchObject({ url: percorso, corpo: { azione: 'proroga', scadenza: '2030-12-31T18:00' } })
    expect(onCambiata).toHaveBeenCalledTimes(1)
    // Rilegge, e la scadenza mostrata è quella nuova (31/12/2030, 17:00 UTC = 18:00 a Roma).
    await screen.findByText('Scadenza: 31/12/2030, 18:00')
    expect(letture()).toHaveLength(2)
  })

  it('una scadenza nel passato è rifiutata: l’errore è tradotto e il pannello resta aperto coi suoi valori', async () => {
    h.rispostaPatch = () => json({ error: 'x', codice: 'VOTAZIONE_SCADENZA_PASSATA' }, 400)
    const { onCambiata } = monta()
    await arrivato()
    fireEvent.click(screen.getByRole('button', { name: 'Proroga' }))
    fireEvent.change(screen.getByLabelText('Giorno'), { target: { value: '01/01/2020' } })

    fireEvent.click(screen.getByRole('button', { name: 'Conferma la proroga' }))

    expect((await screen.findByRole('alert')).textContent).toBe(shared.erroreVotazioneScadenzaPassata)
    expect((screen.getByLabelText('Giorno') as HTMLInputElement).value).toBe('01/01/2020')
    expect(screen.getByRole('button', { name: 'Conferma la proroga' })).toBeTruthy()
    expect(onCambiata).not.toHaveBeenCalled()
    expect(letture()).toHaveLength(1)
  })

  it('«Annulla» richiude il pannello senza scrivere', async () => {
    monta()
    await arrivato()
    fireEvent.click(screen.getByRole('button', { name: 'Proroga' }))
    fireEvent.change(screen.getByLabelText('Giorno'), { target: { value: '31/12/2030' } })

    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))

    expect(screen.queryByRole('group', { name: 'Nuova scadenza' })).toBeNull()
    expect(comando('Proroga')).not.toBeNull()
    expect(scritture('PATCH')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DettaglioVotazione · «Elimina»', () => {
  beforeEach(() => {
    h.votazione = votazione({ votanti: 0, schede: [schedaClasse({ votanti: 0, candidati: [], eletti: [], voti: [] })] })
  })

  it('chiede conferma; «No» non scrive; «Sì» manda DELETE e avvisa che la votazione non c’è più', async () => {
    const { onEliminata, onCambiata } = monta()
    await arrivato()

    fireEvent.click(screen.getByRole('button', { name: 'Elimina' }))
    expect(screen.getByText('Eliminare questa votazione? Non ha voti e non si può recuperare.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'No, tienila' }))
    expect(screen.queryByText('Eliminare questa votazione? Non ha voti e non si può recuperare.')).toBeNull()
    expect(scritture('DELETE')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Elimina' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }))

    await waitFor(() => expect(onEliminata).toHaveBeenCalledTimes(1))
    expect(scritture('DELETE')).toHaveLength(1)
    expect(scritture('DELETE')[0]).toMatchObject({ url: percorso, corpo: null })
    // Non c'è niente da rileggere: la votazione non esiste più.
    expect(letture()).toHaveLength(1)
    expect(onCambiata).not.toHaveBeenCalled()
  })

  it('se nel frattempo qualcuno ha votato il server rifiuta: lo dice, rilegge e «Elimina» sparisce', async () => {
    h.rispostaDelete = () => {
      h.votazione = votazione({ votanti: 3, schede: [schedaClasse({ votanti: 3 })] })
      return json({ error: 'x', codice: 'VOTAZIONE_CON_VOTI' }, 409)
    }
    const { onEliminata, onCambiata } = monta()
    await arrivato()
    expect(comando('Elimina')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Elimina' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }))

    expect((await screen.findByRole('alert')).textContent).toBe(shared.erroreVotazioneConVoti)
    // Il dato nuovo è arrivato quando compare l'affluenza nuova: SOLO da qui l'assenza dice qualcosa.
    await screen.findByText('3 su 30 hanno votato')
    expect(comando('Elimina')).toBeNull()
    expect(onEliminata).not.toHaveBeenCalled()
    expect(onCambiata).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DettaglioVotazione · quando la lettura non va', () => {
  it('un guasto lo dice, non mostra un pannello vuoto, e «Riprova» rilegge', async () => {
    h.letturaStato = 500
    monta()

    await screen.findByText('Non è stato possibile leggere la votazione')
    expect(screen.queryByRole('heading', { name: 'Elezioni 2026' })).toBeNull()
    expect(comando('Chiudi ora')).toBeNull()

    h.letturaStato = 200
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))

    await arrivato()
    expect(letture()).toHaveLength(2)
  })

  it('una votazione che non c’è (404) o non è della sede lo dice, e non offre il «Riprova»', async () => {
    h.letturaStato = 404
    h.letturaCodice = 'VOTAZIONE_NON_TROVATA'
    monta()

    await screen.findByText('Questa votazione non esiste più o non è della tua sede.')
    expect(comando('Riprova')).toBeNull()
  })

  it('cambiando votazione non resta in vista la vecchia', async () => {
    const { rerender } = monta()
    await arrivato()

    rerender(<DettaglioVotazione votazioneId={ALTRA} onChiudi={vi.fn()} onCambiata={vi.fn()} onEliminata={vi.fn()} />)

    // SUBITO, prima che la risposta arrivi: la vecchia non è più in vista (la lettura è di un'altra
    // votazione) e al suo posto c'è il caricamento. Subito dopo l'arrivo l'assenza non proverebbe niente.
    expect(screen.queryByRole('heading', { name: 'Elezioni 2026' })).toBeNull()
    expect(comando('Chiudi ora')).toBeNull()
    expect(screen.getByText('Caricamento in corso…')).toBeTruthy()

    await arrivato('Altra votazione')
    expect(screen.queryByRole('heading', { name: 'Elezioni 2026' })).toBeNull()
    expect(h.chiamate.filter((c) => c.metodo === 'GET').map((c) => c.url)).toEqual([percorso, `/api/admin/votazioni/${ALTRA}`])
  })

  it('il tasto «Chiudi» del pannello avvisa chi lo ha aperto', async () => {
    const { onChiudi } = monta()
    await arrivato()

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }))

    expect(onChiudi).toHaveBeenCalledTimes(1)
  })
})
