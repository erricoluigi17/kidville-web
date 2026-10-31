import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'
import { DaRichiamare } from '@/components/features/crm/follow-up/DaRichiamare'
import { AzioniScheda } from '@/components/features/crm/follow-up/AzioniScheda'
import { dataCivile } from '@/i18n/config'
import { istanteCivile } from '@/lib/format/confini-giorno'
import { addGiorni } from '@/lib/format/data'

/**
 * CRM della segreteria · Compito 5.2 — «Da richiamare» e «Richiami» dentro la scheda.
 *
 * Il server è un finto che risponde per URL e metodo; il test misura ciò che la schermata CHIEDE
 * (l'indirizzo, il corpo) e ciò che MOSTRA di quanto torna. L'orologio non è congelato: i giorni
 * si calcolano da `dataCivile()` come fa il codice, e le ore sono ore di Roma.
 *
 * ⚠️ Il mock di next-intl in `test/setup.ts` legge i cataloghi veri ma risolve solo le chiavi di primo
 * livello: per questo il namespace `crmFollowUp` ha chiavi PIATTE (`tipo_follow_up_2`, `esito_ci_pensa`).
 * Se una chiave diventasse annidata, qui comparirebbe `crmFollowUp.tipi.follow_up_2` e le asserzioni sui
 * testi cadrebbero: è un segnale, non un difetto del test.
 */

const h = vi.hoisted(() => ({
  userId: null as string | null,
  persone: [] as Record<string, unknown>[],
  personeStato: 200,
  azioni: [] as Record<string, unknown>[],
  azioniStato: 200,
  /** Risposta al PATCH: di default un 200 con la prossima azione. */
  rispostaPatch: null as null | ((id: string, corpo: Record<string, unknown>) => Response | Promise<Response>),
  chiamate: [] as { metodo: string; url: string; corpo: Record<string, unknown> | null }[],
}))

vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: h.userId, ruolo: 'segreteria', withUser: (x: string) => x }),
}))

const SEG_1 = '20000000-0000-4000-8000-000000000001'
const SEG_2 = '20000000-0000-4000-8000-000000000002'
const SCHEDA_1 = '40000000-0000-4000-8000-000000000001'
const SCHEDA_2 = '40000000-0000-4000-8000-000000000002'
const AZ_1 = '50000000-0000-4000-8000-000000000001'
const AZ_2 = '50000000-0000-4000-8000-000000000002'
const AZ_3 = '50000000-0000-4000-8000-000000000003'

const oggi = () => dataCivile()
const alle = (n: number, ora = '10:30') => istanteCivile(addGiorni(oggi(), n), ora) as string

function azione(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    scuola_id: SEDE_A,
    scheda_id: SCHEDA_1,
    tipo: 'follow_up_1',
    scadenza: alle(0),
    responsabile: SEG_1,
    appuntamento_id: null,
    esito: null,
    fatta_da: null,
    fatta_il: null,
    cancellata_il: null,
    cancellata_da: null,
    creata_il: '2026-10-01T08:00:00.000Z',
    in_ritardo: false,
    scheda: { id: SCHEDA_1, genitore_nome: 'Famiglia Prova', telefono1: '333 000 0001' },
    ...over,
  }
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } })

/** Una promessa che si risolve quando lo dice il test: per i clic che arrivano mentre la richiesta è in volo. */
function differita<T>() {
  let risolvi!: (v: T) => void
  const promessa = new Promise<T>((r) => {
    risolvi = r
  })
  return { promessa, risolvi }
}

const prossima = (tipo = 'follow_up_2') => ({
  id: AZ_3,
  tipo,
  giorno: addGiorni(oggi(), 3),
  scadenza: alle(3),
  responsabile: SEG_1,
})

const esitoOk = (over: Record<string, unknown> = {}) => (id: string, corpo: Record<string, unknown>) =>
  json({
    data: { id, esito: corpo.esito, prossima: prossima(), bambini_aggiornati: 0, avvisi: [], ...over },
  })

const chiamate = (metodo: string, parte = '') =>
  h.chiamate.filter((c) => c.metodo === metodo && c.url.includes(parte))
const letture = (parte: string) => chiamate('GET', parte)
const scritture = (metodo: 'PATCH' | 'POST') => chiamate(metodo)

beforeEach(() => {
  h.userId = SEG_1
  h.persone = [
    { id: SEG_1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria' },
    { id: SEG_2, nome: 'Elena', cognome: 'Prova', ruolo: 'segreteria' },
  ]
  h.personeStato = 200
  h.azioni = []
  h.azioniStato = 200
  h.rispostaPatch = null
  h.chiamate = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const metodo = init?.method ?? 'GET'
      const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      h.chiamate.push({ metodo, url: url.pathname + url.search, corpo })

      if (url.pathname === '/api/admin/crm/persone') {
        return h.personeStato === 200 ? json({ data: h.persone }) : json({ error: 'x' }, h.personeStato)
      }
      if (url.pathname === '/api/admin/crm/azioni' && metodo === 'GET') {
        if (h.azioniStato !== 200) return json({ error: 'x' }, h.azioniStato)
        const resp = url.searchParams.get('responsabile')
        const scheda = url.searchParams.get('schedaId')
        return json({
          data: h.azioni.filter(
            (a) => (!resp || a.responsabile === resp) && (!scheda || a.scheda_id === scheda),
          ),
        })
      }
      if (url.pathname === '/api/admin/crm/azioni' && metodo === 'POST') {
        return json({ data: { id: AZ_3 } }, 201)
      }
      const m = url.pathname.match(/^\/api\/admin\/crm\/azioni\/([^/]+)$/)
      if (m && metodo === 'PATCH') {
        const cosa = corpo ?? {}
        if (h.rispostaPatch) return h.rispostaPatch(m[1], cosa)
        if (cosa.azione === 'fatta') return esitoOk()(m[1], cosa)
        if (cosa.azione === 'sposta') return json({ data: { id: m[1], scadenza: alle(5), responsabile: SEG_1 } })
        return json({ data: { id: m[1] } })
      }
      return json({ error: 'non previsto' }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const mostraRighe = () => Array.from(document.querySelectorAll('li[data-azione-id]'))
const idRighe = () => mostraRighe().map((r) => r.getAttribute('data-azione-id'))

// ─────────────────────────────────────────────────────────────────────────────
describe('DaRichiamare', () => {
  const monta = (scuolaId = SEDE_A, onApriScheda = vi.fn()) => ({
    onApriScheda,
    ...render(<DaRichiamare scuolaId={scuolaId} onApriScheda={onApriScheda} />),
  })

  it('le scadute hanno il segno di ritardo e stanno in cima', async () => {
    // Messe in ordine SBAGLIATO apposta: l'ordine in cima alle scadute lo deve garantire la schermata.
    h.azioni = [
      azione(AZ_1, { scadenza: alle(0), in_ritardo: false }),
      azione(AZ_2, { scadenza: alle(-3), in_ritardo: true, scheda: { id: SCHEDA_2, genitore_nome: 'Famiglia Seconda', telefono1: null } }),
    ]
    monta()

    await screen.findByText('Famiglia Seconda')
    expect(idRighe()).toEqual([AZ_2, AZ_1])

    const scaduta = mostraRighe()[0]
    expect(scaduta.getAttribute('data-in-ritardo')).toBe('true')
    expect(within(scaduta as HTMLElement).getByText('In ritardo')).toBeTruthy()
    // Il segno c'è solo sulla scaduta: quella di oggi non è in ritardo.
    expect(mostraRighe()[1].getAttribute('data-in-ritardo')).toBe('false')
    expect(screen.getAllByText('In ritardo')).toHaveLength(1)
  })

  it('la persona predefinita è chi la usa: la lista parte già filtrata, mai prima «per tutti»', async () => {
    h.azioni = [azione(AZ_1, { responsabile: SEG_1 }), azione(AZ_2, { responsabile: SEG_2 })]
    monta()

    await waitFor(() => expect(idRighe()).toEqual([AZ_1]))
    const richieste = letture('/api/admin/crm/azioni?')
    // Una sola lettura dell'elenco, e già con la persona: nessuna partenza con «tutte» da correggere dopo.
    expect(richieste).toHaveLength(1)
    expect(richieste[0].url).toContain(`responsabile=${SEG_1}`)
    expect(richieste[0].url).toContain(`scuolaId=${SEDE_A}`)
    expect((screen.getByLabelText('Persona') as HTMLSelectElement).value).toBe(SEG_1)
  })

  it('chi non è fra le persone della sede vede tutti i richiami', async () => {
    h.userId = '20000000-0000-4000-8000-0000000000ff'
    h.azioni = [azione(AZ_1, { responsabile: SEG_1 }), azione(AZ_2, { responsabile: SEG_2 })]
    monta()

    await waitFor(() => expect(idRighe().sort()).toEqual([AZ_1, AZ_2]))
    expect(letture('/api/admin/crm/azioni?')[0].url).not.toContain('responsabile=')
    expect((screen.getByLabelText('Persona') as HTMLSelectElement).value).toBe('')
  })

  it('cambiare persona rilegge con la persona scelta, e «Tutte le persone» toglie il filtro', async () => {
    h.azioni = [azione(AZ_1, { responsabile: SEG_1 }), azione(AZ_2, { responsabile: SEG_2, scheda: { id: SCHEDA_2, genitore_nome: 'Famiglia Seconda', telefono1: null } })]
    monta()
    await waitFor(() => expect(idRighe()).toEqual([AZ_1]))

    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: SEG_2 } })
    await waitFor(() => expect(idRighe()).toEqual([AZ_2]))
    expect(letture('/api/admin/crm/azioni?').at(-1)?.url).toContain(`responsabile=${SEG_2}`)

    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: '' } })
    await waitFor(() => expect(idRighe().sort()).toEqual([AZ_1, AZ_2]))
    expect(letture('/api/admin/crm/azioni?').at(-1)?.url).not.toContain('responsabile=')
  })

  it('mentre arriva la lettura della nuova persona non restano a schermo i richiami della precedente', async () => {
    h.azioni = [azione(AZ_1, { responsabile: SEG_1 }), azione(AZ_2, { responsabile: SEG_2 })]
    monta()
    await waitFor(() => expect(idRighe()).toEqual([AZ_1]))

    // La prossima lettura dell'elenco resta in sospeso finché non la sblocco io.
    const sblocco = differita<void>()
    const vero = globalThis.fetch as unknown as (i: RequestInfo | URL, o?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', async (i: RequestInfo | URL, o?: RequestInit) => {
      if (String(i).includes('/azioni?')) await sblocco.promessa
      return vero(i, o)
    })

    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: SEG_2 } })

    expect(await screen.findByRole('status')).toBeTruthy() // il caricamento
    expect(idRighe()).toEqual([]) // …e nessun richiamo della persona di prima
    sblocco.risolvi()
    await waitFor(() => expect(idRighe()).toEqual([AZ_2]))
  })

  it('se l’elenco delle persone non si carica, si vede tutto e lo si dice', async () => {
    h.personeStato = 500
    h.azioni = [azione(AZ_1, { responsabile: SEG_1 }), azione(AZ_2, { responsabile: SEG_2 })]
    monta()

    await waitFor(() => expect(idRighe().sort()).toEqual([AZ_1, AZ_2]))
    expect(screen.getByText('L’elenco delle persone non si è caricato: vedi i richiami di tutti.')).toBeTruthy()
  })

  it('cambiando sede rilegge per la nuova sede e dimentica la persona scelta nella vecchia', async () => {
    h.azioni = [azione(AZ_1, { responsabile: SEG_1 }), azione(AZ_2, { responsabile: SEG_2 })]
    const { rerender, onApriScheda } = monta()
    await waitFor(() => expect(idRighe()).toEqual([AZ_1]))
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: SEG_2 } })
    await waitFor(() => expect(idRighe()).toEqual([AZ_2]))

    rerender(<DaRichiamare scuolaId={SEDE_B} onApriScheda={onApriScheda} />)

    await waitFor(() => expect(letture('/api/admin/crm/azioni?').at(-1)?.url).toContain(`scuolaId=${SEDE_B}`))
    // La persona SEG_2 era stata scelta per la sede A: nella B si riparte da chi guarda.
    expect(letture('/api/admin/crm/azioni?').at(-1)?.url).toContain(`responsabile=${SEG_1}`)
    expect(letture('/api/admin/crm/persone').at(-1)?.url).toContain(`scuolaId=${SEDE_B}`)
  })

  it('il telefono è un link tel: senza spazi, e senza numero lo dice', async () => {
    h.azioni = [
      azione(AZ_1),
      azione(AZ_2, { scheda: { id: SCHEDA_2, genitore_nome: 'Famiglia Seconda', telefono1: null }, scadenza: alle(0, '11:30') }),
    ]
    monta()

    const link = await screen.findByRole('link', { name: 'Chiama 333 000 0001' })
    expect(link.getAttribute('href')).toBe('tel:3330000001')
    expect(screen.getByText('Nessun telefono')).toBeTruthy()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('«Apri scheda» passa l’id della scheda', async () => {
    h.azioni = [azione(AZ_1)]
    const { onApriScheda } = monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Apri scheda' }))

    expect(onApriScheda).toHaveBeenCalledTimes(1)
    expect(onApriScheda).toHaveBeenCalledWith(SCHEDA_1)
  })

  it('dopo l’esito compare la prossima azione restituita dalla route', async () => {
    h.azioni = [azione(AZ_1)]
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Ci sta pensando' }))

    const riga = mostraRighe()[0] as HTMLElement
    await within(riga).findByText('Segnato: Ci sta pensando.')
    // La prossima azione è quella che la ROUTE ha restituito (qui: il secondo richiamo, tra tre giorni alle 10:30).
    const prossimo = within(riga).getByText(/^Prossimo richiamo: Secondo richiamo · /)
    expect(prossimo.textContent).toContain('10:30')
    expect(scritture('PATCH')).toHaveLength(1)
    expect(scritture('PATCH')[0].url).toBe(`/api/admin/crm/azioni/${AZ_1}`)
    expect(scritture('PATCH')[0].corpo).toEqual({ azione: 'fatta', esito: 'ci_pensa' })
    // La riga resta, ma i quattro pulsanti non ci sono più: non si segna due volte.
    expect(within(riga).queryByRole('button', { name: 'Non risponde' })).toBeNull()
  })

  it('un altro tipo di prossima azione si legge dal tipo restituito, non da un testo fisso', async () => {
    h.azioni = [azione(AZ_1)]
    h.rispostaPatch = esitoOk({ prossima: prossima('riprova_1') })
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Non risponde' }))

    await screen.findByText(/^Prossimo richiamo: Primo nuovo tentativo · /)
    expect(screen.queryByText(/Secondo richiamo/)).toBeNull()
  })

  it('senza prossima azione dice che non ce ne sono altre', async () => {
    h.azioni = [azione(AZ_1)]
    h.rispostaPatch = esitoOk({ prossima: null })
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Vuole iscriversi' }))

    await screen.findByText('Nessun altro richiamo in programma.')
    expect(screen.queryByText(/Prossimo richiamo/)).toBeNull()
  })

  it('se la prossima azione non è stata creata lo dice, e non scrive che non ce ne sono', async () => {
    h.azioni = [azione(AZ_1)]
    h.rispostaPatch = esitoOk({ prossima: null, avvisi: ['PROSSIMA_NON_PIANIFICATA'] })
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Ci sta pensando' }))

    await screen.findByText('Il richiamo successivo non è stato creato: aggiungilo a mano dalla scheda.')
    expect(screen.queryByText('Nessun altro richiamo in programma.')).toBeNull()
  })

  it('non interessato apre la scelta del motivo prima di inviare', async () => {
    h.azioni = [azione(AZ_1)]
    h.rispostaPatch = esitoOk({ prossima: null, bambini_aggiornati: 2 })
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Non interessata' }))

    // Il clic apre la scelta del motivo e NON invia niente.
    expect(screen.getByText('Perché non è interessata?')).toBeTruthy()
    expect(scritture('PATCH')).toHaveLength(0)

    // Confermare senza motivo non è possibile: lo dice e non invia.
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Scegli un motivo per continuare.')
    expect(scritture('PATCH')).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'prezzo' } })
    fireEvent.change(screen.getByLabelText('Nota (facoltativa)'), { target: { value: '  Costa troppo  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }))

    await screen.findByText('Segnato: Non interessata.')
    expect(scritture('PATCH')).toHaveLength(1)
    expect(scritture('PATCH')[0].corpo).toEqual({
      azione: 'fatta',
      esito: 'non_interessato',
      motivoPerdita: 'prezzo',
      motivoNota: 'Costa troppo',
    })
    expect(screen.getByText('2 bambini aggiornati')).toBeTruthy()
  })

  it('«Annulla» nella scelta del motivo torna ai quattro esiti senza inviare', async () => {
    h.azioni = [azione(AZ_1)]
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Non interessata' }))
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))

    expect(screen.getByRole('button', { name: 'Ci sta pensando' })).toBeTruthy()
    expect(screen.queryByText('Perché non è interessata?')).toBeNull()
    expect(scritture('PATCH')).toHaveLength(0)
  })

  it('gli altri esiti non mandano né motivo né nota', async () => {
    h.azioni = [azione(AZ_1)]
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Vuole iscriversi' }))

    await screen.findByText('Segnato: Vuole iscriversi.')
    expect(scritture('PATCH')[0].corpo).toEqual({ azione: 'fatta', esito: 'vuole_iscriversi' })
  })

  it('un doppio clic invia UNA sola richiesta', async () => {
    h.azioni = [azione(AZ_1)]
    const risposta = differita<Response>()
    h.rispostaPatch = () => risposta.promessa
    monta()

    const pulsante = await screen.findByRole('button', { name: 'Ci sta pensando' })
    fireEvent.click(pulsante)
    fireEvent.click(pulsante)
    fireEvent.click(pulsante)

    expect(scritture('PATCH')).toHaveLength(1)
    // Mentre la richiesta è in volo i pulsanti sono spenti.
    expect((screen.getByRole('button', { name: 'Non risponde' }) as HTMLButtonElement).disabled).toBe(true)

    risposta.risolvi(esitoOk()(AZ_1, { esito: 'ci_pensa' }))
    await screen.findByText('Segnato: Ci sta pensando.')
    expect(scritture('PATCH')).toHaveLength(1)
  })

  it('due clic nello STESSO istante (prima che la riga si spenga) inviano una sola richiesta', async () => {
    h.azioni = [azione(AZ_1)]
    const risposta = differita<Response>()
    h.rispostaPatch = () => risposta.promessa
    monta()

    const pulsante = await screen.findByRole('button', { name: 'Ci sta pensando' })
    // Dentro un solo `act` React non ridisegna fra un clic e l'altro: il pulsante è ancora attivo al secondo.
    // È la guardia sull'operazione in corso (non l'attributo `disabled`) a tenere la linea.
    act(() => {
      pulsante.click()
      pulsante.click()
    })

    expect(scritture('PATCH')).toHaveLength(1)
    risposta.risolvi(esitoOk()(AZ_1, { esito: 'ci_pensa' }))
    await screen.findByText('Segnato: Ci sta pensando.')
    expect(scritture('PATCH')).toHaveLength(1)
  })

  it('se un collega l’aveva già segnata (409 GIA_FATTA) lo dice con le parole del catalogo e non mostra una prossima azione', async () => {
    h.azioni = [azione(AZ_1)]
    h.rispostaPatch = () => json({ error: 'già fatta', codice: 'GIA_FATTA' }, 409)
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Ci sta pensando' }))

    await screen.findByText('Questo richiamo è già stato segnato come fatto. Aggiorna la pagina.')
    expect(screen.queryByText(/Prossimo richiamo/)).toBeNull()
    expect(screen.queryByText(/Segnato:/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Non risponde' })).toBeNull()
  })

  it('un guasto non chiude la riga: l’errore si legge e si può riprovare', async () => {
    h.azioni = [azione(AZ_1)]
    h.rispostaPatch = () => json({ error: 'boom' }, 500)
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Ci sta pensando' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Non è stato possibile salvare. Riprova fra poco.')
    // Nessuna conferma finta, e i pulsanti tornano attivi.
    expect(screen.queryByText(/Segnato:/)).toBeNull()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Ci sta pensando' }) as HTMLButtonElement).disabled).toBe(false))

    h.rispostaPatch = null
    fireEvent.click(screen.getByRole('button', { name: 'Ci sta pensando' }))
    await screen.findByText('Segnato: Ci sta pensando.')
    expect(scritture('PATCH')).toHaveLength(2)
  })

  it('senza rete si legge che non è stato salvato, e la riga resta com’era', async () => {
    h.azioni = [azione(AZ_1)]
    monta()
    const vero = globalThis.fetch as unknown as (i: RequestInfo | URL, o?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', async (i: RequestInfo | URL, o?: RequestInit) => {
      if (o?.method === 'PATCH') throw new TypeError('Failed to fetch')
      return vero(i, o)
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Ci sta pensando' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Non è stato possibile salvare. Riprova fra poco.')
    expect(screen.queryByText(/Segnato:/)).toBeNull()
  })

  it('nessun richiamo: lo stato vuoto, non una pagina muta', async () => {
    monta()

    expect(await screen.findByText('Nessun richiamo da fare')).toBeTruthy()
    expect(screen.getByText('Non ci sono richiami per oggi né richiami rimasti indietro.')).toBeTruthy()
  })

  it('una lettura fallita è un errore con «Riprova», mai «nessun richiamo»', async () => {
    h.azioniStato = 500
    h.azioni = [azione(AZ_1)]
    monta()

    const riprova = await screen.findByRole('button', { name: 'Riprova' })
    expect(screen.queryByText('Nessun richiamo da fare')).toBeNull()

    h.azioniStato = 200
    fireEvent.click(riprova)
    await waitFor(() => expect(idRighe()).toEqual([AZ_1]))
  })

  it('«Aggiorna» rilegge e toglie le righe già trattate', async () => {
    h.azioni = [azione(AZ_1)]
    monta()
    fireEvent.click(await screen.findByRole('button', { name: 'Ci sta pensando' }))
    await screen.findByText('Segnato: Ci sta pensando.')

    // Dal server, ora, quel richiamo non c'è più.
    h.azioni = []
    fireEvent.click(screen.getByRole('button', { name: 'Aggiorna' }))

    await screen.findByText('Nessun richiamo da fare')
    expect(screen.queryByText(/Segnato:/)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('AzioniScheda', () => {
  const monta = (onAggiornata = vi.fn()) => ({
    onAggiornata,
    ...render(<AzioniScheda scuolaId={SEDE_A} schedaId={SCHEDA_1} onAggiornata={onAggiornata} />),
  })

  it('legge i richiami di QUELLA scheda e li mostra con la persona che li ha, senza il telefono', async () => {
    h.azioni = [
      azione(AZ_1, { scadenza: alle(5), tipo: 'follow_up_2', responsabile: SEG_2 }),
      azione(AZ_2, { scheda_id: SCHEDA_2 }),
    ]
    monta()

    await screen.findByText(/Secondo richiamo/)
    expect(idRighe()).toEqual([AZ_1])
    const lettura = letture('/api/admin/crm/azioni?')[0].url
    expect(lettura).toContain(`schedaId=${SCHEDA_1}`)
    expect(lettura).toContain(`scuolaId=${SEDE_A}`)
    expect(lettura).not.toContain('responsabile=')
    // Chi richiama si legge col nome (le persone arrivano a parte).
    await screen.findByText('Responsabile: Elena Prova')
    // Nella scheda il telefono c'è già: la riga non lo ripete.
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sposta' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancella' })).toBeTruthy()
  })

  it('senza richiami lo dice', async () => {
    monta()
    expect(await screen.findByText('Nessun richiamo in programma per questa famiglia.')).toBeTruthy()
  })

  it('un esito mostra la prossima azione, rilegge la lista senza svuotarla e avvisa la scheda', async () => {
    h.azioni = [azione(AZ_1, { tipo: 'follow_up_1', scadenza: alle(0) })]
    const { onAggiornata } = monta()
    fireEvent.click(await screen.findByRole('button', { name: 'Ci sta pensando' }))

    // Dal server la lista ora ha la NUOVA azione al posto di quella fatta.
    h.azioni = [azione(AZ_3, { tipo: 'follow_up_2', scadenza: alle(3) })]
    await screen.findByText(/^Prossimo richiamo: Secondo richiamo · /)

    await waitFor(() => expect(idRighe()).toEqual([AZ_3]))
    expect(onAggiornata).toHaveBeenCalledTimes(1)
    expect(letture('/api/admin/crm/azioni?')).toHaveLength(2)
    // Il riquadro resta anche dopo la rilettura.
    expect(screen.getByText('Segnato: Ci sta pensando.')).toBeTruthy()
  })

  it('un 409 GIA_FATTA nella scheda rilegge la lista e lo dice', async () => {
    h.azioni = [azione(AZ_1)]
    h.rispostaPatch = () => json({ error: 'già fatta', codice: 'GIA_FATTA' }, 409)
    const { onAggiornata } = monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Ci sta pensando' }))

    await screen.findByText('Questo richiamo è già stato segnato come fatto. Aggiorna la pagina.')
    expect(onAggiornata).toHaveBeenCalledTimes(1)
    expect(letture('/api/admin/crm/azioni?')).toHaveLength(2)
  })

  it('sposta: propone il giorno e l’ora di adesso, manda quelli scelti e dice dove è finito', async () => {
    h.azioni = [azione(AZ_1, { scadenza: alle(2, '09:15') })]
    const { onAggiornata } = monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Sposta' }))

    // Il giorno è quello di Roma della scadenza, l'ora quella di Roma: nessun fuso del dispositivo.
    expect((screen.getByLabelText('Ora') as HTMLInputElement).value).toBe('09:15')
    expect((screen.getByLabelText('Nuovo giorno') as HTMLInputElement).value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)

    fireEvent.change(screen.getByLabelText('Nuovo giorno'), { target: { value: '05/12/2030' } })
    fireEvent.change(screen.getByLabelText('Ora'), { target: { value: '16:45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sposta il richiamo' }))

    await screen.findByText(/^Richiamo spostato a /)
    expect(scritture('PATCH')).toHaveLength(1)
    expect(scritture('PATCH')[0].corpo).toEqual({ azione: 'sposta', giorno: '2030-12-05', ora: '16:45' })
    expect(onAggiornata).toHaveBeenCalledTimes(1)
  })

  it('sposta: cambiare persona la manda, lasciare la stessa no', async () => {
    h.azioni = [azione(AZ_1, { responsabile: SEG_1 })]
    monta()
    fireEvent.click(await screen.findByRole('button', { name: 'Sposta' }))
    await screen.findByRole('option', { name: 'Elena Prova' })

    fireEvent.change(screen.getByLabelText('Responsabile'), { target: { value: SEG_2 } })
    fireEvent.click(screen.getByRole('button', { name: 'Sposta il richiamo' }))

    await screen.findByText(/^Richiamo spostato a /)
    expect(scritture('PATCH')[0].corpo).toMatchObject({ azione: 'sposta', responsabile: SEG_2 })
  })

  it('sposta: un giorno incompleto non parte', async () => {
    h.azioni = [azione(AZ_1)]
    monta()
    fireEvent.click(await screen.findByRole('button', { name: 'Sposta' }))

    fireEvent.change(screen.getByLabelText('Nuovo giorno'), { target: { value: '05/12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sposta il richiamo' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Scegli un giorno valido.')
    expect(scritture('PATCH')).toHaveLength(0)
  })

  it('sposta: un rifiuto del server si legge e il modulo resta aperto', async () => {
    h.azioni = [azione(AZ_1)]
    h.rispostaPatch = () => json({ error: 'x', codice: 'STATO_NON_AMMESSO' }, 409)
    const { onAggiornata } = monta()
    fireEvent.click(await screen.findByRole('button', { name: 'Sposta' }))

    fireEvent.click(screen.getByRole('button', { name: 'Sposta il richiamo' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Questa operazione non è possibile nello stato attuale')
    expect(screen.getByRole('button', { name: 'Sposta il richiamo' })).toBeTruthy()
    expect(onAggiornata).not.toHaveBeenCalled()
  })

  it('cancella chiede conferma: «No, tienilo» non cancella, «Sì, cancella» sì', async () => {
    h.azioni = [azione(AZ_1)]
    const { onAggiornata } = monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancella' }))
    expect(screen.getByText('Cancellare questo richiamo?')).toBeTruthy()
    expect(scritture('PATCH')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'No, tienilo' }))
    expect(screen.queryByText('Cancellare questo richiamo?')).toBeNull()
    expect(scritture('PATCH')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Cancella' }))
    h.azioni = []
    fireEvent.click(screen.getByRole('button', { name: 'Sì, cancella' }))

    await screen.findByText('Richiamo cancellato.')
    expect(scritture('PATCH')).toHaveLength(1)
    expect(scritture('PATCH')[0].corpo).toEqual({ azione: 'cancella' })
    expect(onAggiornata).toHaveBeenCalledTimes(1)
    await screen.findByText('Nessun richiamo in programma per questa famiglia.')
  })

  it('aggiungi richiamo: manda scheda, giorno e persona (chi guarda), poi rilegge e avvisa la scheda', async () => {
    const { onAggiornata } = monta()
    await screen.findByText('Nessun richiamo in programma per questa famiglia.')
    const aggiungi = screen.getByRole('button', { name: 'Aggiungi richiamo' })
    await waitFor(() => expect((aggiungi as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(aggiungi)
    // Chi guarda è la persona proposta; il giorno proposto è domani.
    await waitFor(() => expect((screen.getByLabelText('Responsabile') as HTMLSelectElement).value).toBe(SEG_1))
    fireEvent.change(screen.getByLabelText('Giorno'), { target: { value: '12/12/2030' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi' }))

    await screen.findByText(/^Richiamo aggiunto per /)
    expect(scritture('POST')).toHaveLength(1)
    expect(scritture('POST')[0].corpo).toEqual({ schedaId: SCHEDA_1, giorno: '2030-12-12', responsabile: SEG_1 })
    expect(onAggiornata).toHaveBeenCalledTimes(1)
    expect(letture('/api/admin/crm/azioni?')).toHaveLength(2)
    // Il modulo si chiude.
    expect(screen.queryByRole('button', { name: 'Aggiungi' })).toBeNull()
  })

  it('aggiungi richiamo: il giorno proposto è domani, di Roma', async () => {
    monta()
    const aggiungi = await screen.findByRole('button', { name: 'Aggiungi richiamo' })
    await waitFor(() => expect((aggiungi as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(aggiungi)

    const [anno, mese, giorno] = addGiorni(oggi(), 1).split('-')
    expect((screen.getByLabelText('Giorno') as HTMLInputElement).value).toBe(`${giorno}/${mese}/${anno}`)
  })

  it('aggiungi richiamo: senza una persona scelta non parte', async () => {
    h.userId = '20000000-0000-4000-8000-0000000000ff' // non è fra le persone della sede
    monta()
    const aggiungi = await screen.findByRole('button', { name: 'Aggiungi richiamo' })
    await waitFor(() => expect((aggiungi as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(aggiungi)
    fireEvent.click(screen.getByRole('button', { name: 'Aggiungi' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Scegli chi richiama.')
    expect(scritture('POST')).toHaveLength(0)
  })

  it('aggiungi richiamo: un doppio clic crea UN solo richiamo', async () => {
    monta()
    const aggiungi = await screen.findByRole('button', { name: 'Aggiungi richiamo' })
    await waitFor(() => expect((aggiungi as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(aggiungi)
    await waitFor(() => expect((screen.getByLabelText('Responsabile') as HTMLSelectElement).value).toBe(SEG_1))

    const conferma = screen.getByRole('button', { name: 'Aggiungi' })
    fireEvent.click(conferma)
    fireEvent.click(conferma)

    await screen.findByText(/^Richiamo aggiunto per /)
    expect(scritture('POST')).toHaveLength(1)
  })

  it('aggiungi richiamo: due clic nello stesso istante creano UN solo richiamo', async () => {
    monta()
    const aggiungi = await screen.findByRole('button', { name: 'Aggiungi richiamo' })
    await waitFor(() => expect((aggiungi as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(aggiungi)
    await waitFor(() => expect((screen.getByLabelText('Responsabile') as HTMLSelectElement).value).toBe(SEG_1))

    const conferma = screen.getByRole('button', { name: 'Aggiungi' })
    act(() => {
      conferma.click()
      conferma.click()
    })

    await screen.findByText(/^Richiamo aggiunto per /)
    expect(scritture('POST')).toHaveLength(1)
  })

  it('sposta: il giorno proposto è quello di ROMA anche se in UTC la scadenza cade il giorno prima', async () => {
    // 00:30 di Roma = 22:30 o 23:30 UTC del giorno PRIMA: tagliare l'ISO in UTC proporrebbe il giorno sbagliato.
    h.azioni = [azione(AZ_1, { scadenza: alle(2, '00:30') })]
    monta()

    fireEvent.click(await screen.findByRole('button', { name: 'Sposta' }))

    const [anno, mese, giorno] = addGiorni(oggi(), 2).split('-')
    expect((screen.getByLabelText('Nuovo giorno') as HTMLInputElement).value).toBe(`${giorno}/${mese}/${anno}`)
    expect((screen.getByLabelText('Ora') as HTMLInputElement).value).toBe('00:30')
  })

  it('una lettura fallita è un errore con «Riprova», non «nessun richiamo»', async () => {
    h.azioniStato = 500
    monta()

    const riprova = await screen.findByRole('button', { name: 'Riprova' })
    expect(screen.queryByText('Nessun richiamo in programma per questa famiglia.')).toBeNull()

    h.azioniStato = 200
    h.azioni = [azione(AZ_1)]
    fireEvent.click(riprova)
    await waitFor(() => expect(idRighe()).toEqual([AZ_1]))
  })
})
