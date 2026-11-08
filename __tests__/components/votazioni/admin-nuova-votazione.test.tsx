import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react'
import { SEDE_A, SEDE_B } from '../../fixtures/sedi'
import { NuovaVotazioneForm } from '@/components/features/votazioni/admin/NuovaVotazioneForm'
import { titoloPredefinito } from '@/lib/votazioni/tipi'
import { CalendarioProvider } from '@/lib/context/calendario-context'
import { annoDelGiorno } from '@/lib/anno-scolastico'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import shared from '../../../messages/it/shared.json'

/**
 * Votazioni dei rappresentanti · Task 7 — il modulo «Apri una votazione» della segreteria.
 *
 * Il server è un finto che risponde per URL e metodo; il test misura ciò che il modulo CHIEDE (indirizzo e
 * corpo, esatti) e ciò che MOSTRA di quanto torna. Nessuna asserzione su un'ASSENZA precede la presenza di
 * qualcosa che dimostri che i dati sono arrivati.
 *
 * ⚠️ Il mock di next-intl in `test/setup.ts` risolve solo le chiavi di primo livello: `votazioniAdmin` ha
 * chiavi PIATTE. I testi attesi sono quelli che legge la segreteria, scritti per esteso.
 */

const S_NIDO = '11111111-0000-4000-8000-000000000001'
const S_INF_3 = '11111111-0000-4000-8000-000000000002'
const S_INF_4 = '11111111-0000-4000-8000-000000000003'
const S_PRIM = '11111111-0000-4000-8000-000000000004'
const S_ALTRA_SEDE = '11111111-0000-4000-8000-000000000009'
const G_ROSSI = '22222222-0000-4000-8000-000000000001'
const G_BIANCHI = '22222222-0000-4000-8000-000000000002'
const NUOVA = '33333333-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({
  sezioniStato: 200,
  /** Il POST: di default 201 con l'id della nuova votazione. */
  rispostaPost: null as null | (() => Response | Promise<Response>),
  genitoriStato: 200,
  genitori: [] as { utenteId: string; nome: string }[],
  chiamate: [] as { metodo: string; url: string; corpo: Record<string, unknown> | null }[],
  /** `GET /api/anno/calendario`: la promessa da cui il test decide QUANDO arriva la risposta. */
  calendario: null as null | Promise<Response>,
}))

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

const chiamate = (metodo: string, parte = '') =>
  h.chiamate.filter((c) => c.metodo === metodo && c.url.includes(parte))
const scritture = () => chiamate('POST', '/api/admin/votazioni')
const ricerche = () => chiamate('GET', '/api/admin/votazioni/genitori')

beforeEach(() => {
  h.sezioniStato = 200
  h.rispostaPost = null
  h.genitoriStato = 200
  h.genitori = [
    { utenteId: G_ROSSI, nome: 'Rossi Mario' },
    { utenteId: G_BIANCHI, nome: 'Bianchi Anna' },
  ]
  h.chiamate = []
  h.calendario = null

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const metodo = init?.method ?? 'GET'
      const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
      h.chiamate.push({ metodo, url: url.pathname + url.search, corpo })

      if (url.pathname === '/api/anno/calendario') {
        return h.calendario ?? json({ success: true, data: [] })
      }
      if (url.pathname === '/api/admin/sections/scoped') {
        if (h.sezioniStato !== 200) return json({ error: 'x' }, h.sezioniStato)
        // La forma VERA della route: avvolta in `{ success, data }`, un gruppo per sede.
        return json({
          success: true,
          data: [
            {
              scuolaId: SEDE_A,
              scuolaNome: 'Sede A',
              sezioni: [
                { id: S_NIDO, name: '1 ANNO', school_type: 'nido' },
                { id: S_INF_3, name: '3 ANNI', school_type: 'infanzia' },
                { id: S_INF_4, name: '4 ANNI', school_type: 'infanzia' },
                { id: S_PRIM, name: 'I A', school_type: 'primaria' },
              ],
            },
            {
              scuolaId: SEDE_B,
              scuolaNome: 'Sede B',
              sezioni: [{ id: S_ALTRA_SEDE, name: 'CLASSE DELL’ALTRA SEDE', school_type: 'infanzia' }],
            },
          ],
        })
      }
      if (url.pathname === '/api/admin/votazioni/genitori' && metodo === 'GET') {
        if (h.genitoriStato !== 200) return json({ error: 'x' }, h.genitoriStato)
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        return json({ genitori: h.genitori.filter((g) => g.nome.toLowerCase().includes(q)) })
      }
      if (url.pathname === '/api/admin/votazioni' && metodo === 'POST') {
        return h.rispostaPost ? h.rispostaPost() : json({ id: NUOVA }, 201)
      }
      return json({ error: 'non previsto' }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function monta(scuolaId = SEDE_A) {
  const onCreata = vi.fn()
  const onAnnulla = vi.fn()
  render(<NuovaVotazioneForm scuolaId={scuolaId} onCreata={onCreata} onAnnulla={onAnnulla} />)
  return { onCreata, onAnnulla }
}

/** Aspetta che le classi siano arrivate: da qui in poi le asserzioni sull'assenza non sono vuote. */
async function classiPronte() {
  await screen.findByRole('checkbox', { name: '3 ANNI' })
}

const apri = () => screen.getByRole('button', { name: 'Apri votazione' }) as HTMLButtonElement
const spunta = (nome: string) => screen.getByRole('checkbox', { name: nome }) as HTMLInputElement

function impostaScadenza(giorno = '05/12/2030', ora = '16:45') {
  fireEvent.change(screen.getByLabelText('Giorno'), { target: { value: giorno } })
  fireEvent.change(screen.getByLabelText('Ora'), { target: { value: ora } })
}

/** Accende l'istituto e sceglie un candidato dalla ricerca (Rossi Mario). */
async function conCandidato(testo = 'ro', nome = 'Rossi Mario') {
  fireEvent.click(screen.getByRole('switch', { name: 'Anche rappresentante d’istituto' }))
  fireEvent.change(screen.getByLabelText('Cerca un genitore'), { target: { value: testo } })
  fireEvent.click(await screen.findByRole('button', { name: nome }))
}

// ─────────────────────────────────────────────────────────────────────────────
describe('NuovaVotazioneForm · le classi', () => {
  it('chiede le classi e mostra solo quelle della SEDE, raggruppate per grado (nido, infanzia, primaria)', async () => {
    monta()
    await classiPronte()

    expect(chiamate('GET', '/api/admin/sections/scoped')).toHaveLength(1)
    const nido = screen.getByRole('group', { name: 'Nido' })
    const infanzia = screen.getByRole('group', { name: 'Infanzia' })
    const primaria = screen.getByRole('group', { name: 'Primaria' })
    expect(within(nido).getAllByRole('checkbox')).toHaveLength(1)
    expect(within(nido).getByRole('checkbox', { name: '1 ANNO' })).toBeTruthy()
    expect(within(infanzia).getAllByRole('checkbox').map((c) => (c as HTMLInputElement).closest('label')?.textContent)).toEqual(['3 ANNI', '4 ANNI'])
    expect(within(primaria).getAllByRole('checkbox')).toHaveLength(1)
    expect(within(primaria).getByRole('checkbox', { name: 'I A' })).toBeTruthy()
    // L'ordine sulla pagina è quello dei gradi, non quello di arrivo.
    expect(nido.compareDocumentPosition(infanzia) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(infanzia.compareDocumentPosition(primaria) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Una classe di un'altra sede non si offre MAI: una votazione scritta lì finirebbe nel plesso sbagliato.
    expect(screen.queryByRole('checkbox', { name: 'CLASSE DELL’ALTRA SEDE' })).toBeNull()
  })

  it('con un’altra sede in mano elenca le classi di QUELLA', async () => {
    monta(SEDE_B)
    await screen.findByRole('checkbox', { name: 'CLASSE DELL’ALTRA SEDE' })
    expect(screen.queryByRole('checkbox', { name: '3 ANNI' })).toBeNull()
  })

  it('«Seleziona tutte le classi» spunta tutte, e diventa «Deseleziona» per toglierle', async () => {
    monta()
    await classiPronte()

    fireEvent.click(screen.getByRole('button', { name: 'Seleziona tutte le classi' }))
    expect(['1 ANNO', '3 ANNI', '4 ANNI', 'I A'].map((n) => spunta(n).checked)).toEqual([true, true, true, true])

    fireEvent.click(screen.getByRole('button', { name: 'Deseleziona tutte le classi' }))
    expect(['1 ANNO', '3 ANNI', '4 ANNI', 'I A'].map((n) => spunta(n).checked)).toEqual([false, false, false, false])
  })

  it('«Seleziona tutte» di un gruppo spunta solo quel gruppo', async () => {
    monta()
    await classiPronte()

    fireEvent.click(screen.getByRole('button', { name: 'Seleziona tutte le classi: Infanzia' }))
    expect(['1 ANNO', '3 ANNI', '4 ANNI', 'I A'].map((n) => spunta(n).checked)).toEqual([false, true, true, false])

    // Il pulsante del gruppo, ora tutto spuntato, passa a «Deseleziona» e toglie solo le sue.
    fireEvent.click(screen.getByRole('button', { name: 'Deseleziona tutte le classi: Infanzia' }))
    expect(['3 ANNI', '4 ANNI'].map((n) => spunta(n).checked)).toEqual([false, false])
  })

  it('se le classi non si leggono lo dice, e l’istituto da solo resta possibile', async () => {
    h.sezioniStato = 500
    monta()

    expect((await screen.findByRole('alert')).textContent).toBe('Non è stato possibile leggere le classi della sede.')
    expect(screen.queryByRole('checkbox')).toBeNull()

    await conCandidato()
    impostaScadenza()
    expect(apri().disabled).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('NuovaVotazioneForm · quando «Apri votazione» è spento', () => {
  it('parte con il titolo predefinito, l’istituto spento e il pulsante spento', async () => {
    monta()
    await classiPronte()

    // L'anno di OGGI senza calendario caricato = il predefinito: il test non dipende dalla data in cui gira.
    expect((screen.getByLabelText('Titolo') as HTMLInputElement).value).toBe(
      titoloPredefinito(annoDelGiorno(oggiFiscaleISO()).etichettaBreve),
    )
    expect(screen.getByRole('switch', { name: 'Anche rappresentante d’istituto' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByLabelText('Cerca un genitore')).toBeNull()
    expect(apri().disabled).toBe(true)
  })

  it('nessuna classe e istituto spento: spento, e dice perché', async () => {
    monta()
    await classiPronte()
    impostaScadenza()

    expect(apri().disabled).toBe(true)
    expect(screen.getByText('Scegli almeno una classe o il rappresentante d’istituto.')).toBeTruthy()
    expect(apri().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('istituto acceso con 0 candidati: spento, anche con una classe e la scadenza', async () => {
    monta()
    await classiPronte()
    fireEvent.click(spunta('3 ANNI'))
    impostaScadenza()
    expect(apri().disabled).toBe(false)

    fireEvent.click(screen.getByRole('switch', { name: 'Anche rappresentante d’istituto' }))

    expect(apri().disabled).toBe(true)
    expect(screen.getByText('Per il rappresentante d’istituto aggiungi almeno un candidato.')).toBeTruthy()
  })

  it('istituto acceso con un candidato, senza classi: acceso', async () => {
    monta()
    await classiPronte()
    impostaScadenza()
    await conCandidato()

    expect(apri().disabled).toBe(false)
  })

  it('senza scadenza resta spento, anche con una classe', async () => {
    monta()
    await classiPronte()
    fireEvent.click(spunta('3 ANNI'))

    expect(apri().disabled).toBe(true)
    expect(screen.getByText('Indica giorno e ora della scadenza.')).toBeTruthy()
  })

  it('con il titolo svuotato resta spento', async () => {
    monta()
    await classiPronte()
    fireEvent.click(spunta('3 ANNI'))
    impostaScadenza()
    expect(apri().disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Titolo'), { target: { value: '   ' } })

    expect(apri().disabled).toBe(true)
    expect(screen.getByText('Scrivi il titolo.')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('NuovaVotazioneForm · i candidati dell’istituto', () => {
  it('cerca sul server con la sede e il testo, una richiesta sola per una digitazione veloce', async () => {
    monta()
    await classiPronte()
    fireEvent.click(screen.getByRole('switch', { name: 'Anche rappresentante d’istituto' }))

    const campo = screen.getByLabelText('Cerca un genitore')
    // Una lettera sola non parte: lo dice il suggerimento (presenza), e la prova che NON è partita sta
    // nell'elenco finale delle richieste, che conterrà solo `ro`/`ros`.
    fireEvent.change(campo, { target: { value: 'r' } })
    expect(screen.getByText('Scrivi almeno due lettere.')).toBeTruthy()
    fireEvent.change(campo, { target: { value: 'ro' } })
    fireEvent.change(campo, { target: { value: 'ros' } })

    expect((await screen.findByRole('button', { name: 'Rossi Mario' })).textContent).toContain('Rossi Mario')
    expect(ricerche().map((r) => r.url)).toEqual([`/api/admin/votazioni/genitori?scuolaId=${SEDE_A}&q=ros`])
    // Il risultato non pretende di essere altro: «Bianchi Anna» non contiene «ros».
    expect(screen.queryByRole('button', { name: 'Bianchi Anna' })).toBeNull()
  })

  it('aspetta una pausa nella scrittura: chi digita piano non fa partire una richiesta per ogni lettera', async () => {
    monta()
    await classiPronte()
    fireEvent.click(screen.getByRole('switch', { name: 'Anche rappresentante d’istituto' }))
    const campo = screen.getByLabelText('Cerca un genitore')

    // Solo i timer sono finti: le richieste e i `findBy` restano veri. 100 ms fra una lettera e l'altra sono
    // MENO della pausa, quindi la prima richiesta non deve nemmeno partire.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.change(campo, { target: { value: 'ro' } })
      act(() => {
        vi.advanceTimersByTime(100)
      })
      fireEvent.change(campo, { target: { value: 'ros' } })
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(ricerche()).toHaveLength(0)
      act(() => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    await screen.findByRole('button', { name: 'Rossi Mario' })
    expect(ricerche().map((r) => r.url)).toEqual([`/api/admin/votazioni/genitori?scuolaId=${SEDE_A}&q=ros`])
  })

  it('il candidato scelto è un chip con «Rimuovi» e sparisce dai risultati; rimuoverlo spegne di nuovo il pulsante', async () => {
    monta()
    await classiPronte()
    impostaScadenza()
    await conCandidato()

    expect(apri().disabled).toBe(false)
    const rimuovi = screen.getByRole('button', { name: 'Rimuovi Rossi Mario' })
    // Lo stesso nome non resta fra i risultati da scegliere.
    expect(screen.queryByRole('button', { name: 'Rossi Mario' })).toBeNull()

    fireEvent.click(rimuovi)

    expect(screen.queryByRole('button', { name: 'Rimuovi Rossi Mario' })).toBeNull()
    expect(screen.getByText('Nessun candidato scelto.')).toBeTruthy()
    expect(apri().disabled).toBe(true)
  })

  it('nessun risultato lo dice; una ricerca fallita lo dice', async () => {
    monta()
    await classiPronte()
    fireEvent.click(screen.getByRole('switch', { name: 'Anche rappresentante d’istituto' }))
    const campo = screen.getByLabelText('Cerca un genitore')

    fireEvent.change(campo, { target: { value: 'zz' } })
    await screen.findByText('Nessun genitore trovato.')

    h.genitoriStato = 500
    fireEvent.change(campo, { target: { value: 'ro' } })
    expect((await screen.findByText('La ricerca non è riuscita. Riprova.')).textContent).toBe('La ricerca non è riuscita. Riprova.')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('NuovaVotazioneForm · l’invio', () => {
  it('manda il corpo ESATTO: sede, titolo, scadenza come cifre locali, classi, istituto spento', async () => {
    const { onCreata } = monta()
    await classiPronte()
    fireEvent.change(screen.getByLabelText('Titolo'), { target: { value: '  Elezioni di prova  ' } })
    // L'ordine di arrivo delle spunte non conta: nel corpo le classi stanno nell'ordine della pagina.
    fireEvent.click(spunta('I A'))
    fireEvent.click(spunta('3 ANNI'))
    impostaScadenza('05/12/2030', '16:45')

    fireEvent.click(apri())

    await waitFor(() => expect(onCreata).toHaveBeenCalledTimes(1))
    expect(onCreata).toHaveBeenCalledWith(NUOVA)
    expect(scritture()).toHaveLength(1)
    expect(scritture()[0].corpo).toEqual({
      scuolaId: SEDE_A,
      titolo: 'Elezioni di prova',
      // L'ora di un muro di Roma, senza fuso e senza secondi: la conversione in istante la fa il server.
      scadenza: '2030-12-05T16:45',
      sectionIds: [S_INF_3, S_PRIM],
      rappresentanteIstituto: false,
      candidatiIstituto: [],
    })
  })

  it('con l’istituto: corpo con i candidati, e anche senza classi', async () => {
    const { onCreata } = monta()
    await classiPronte()
    impostaScadenza()
    await conCandidato('ro', 'Rossi Mario')
    fireEvent.change(screen.getByLabelText('Cerca un genitore'), { target: { value: 'bi' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Bianchi Anna' }))

    fireEvent.click(apri())

    await waitFor(() => expect(onCreata).toHaveBeenCalledTimes(1))
    expect(scritture()[0].corpo).toMatchObject({
      sectionIds: [],
      rappresentanteIstituto: true,
      candidatiIstituto: [G_ROSSI, G_BIANCHI],
    })
  })

  it('spegnere l’istituto dopo aver scelto i candidati NON li manda: nessun candidato senza istituto', async () => {
    const { onCreata } = monta()
    await classiPronte()
    fireEvent.click(spunta('3 ANNI'))
    impostaScadenza()
    await conCandidato()
    fireEvent.click(screen.getByRole('switch', { name: 'Anche rappresentante d’istituto' }))

    fireEvent.click(apri())

    await waitFor(() => expect(onCreata).toHaveBeenCalledTimes(1))
    expect(scritture()[0].corpo).toMatchObject({ rappresentanteIstituto: false, candidatiIstituto: [] })
  })

  it('un doppio clic apre UNA votazione sola', async () => {
    const lenta = differita<Response>()
    h.rispostaPost = () => lenta.promessa
    const { onCreata } = monta()
    await classiPronte()
    fireEvent.click(spunta('3 ANNI'))
    impostaScadenza()

    fireEvent.click(apri())
    // Mentre la richiesta è in volo il pulsante è un messaggio, non un controllo spento.
    const inVolo = await screen.findByRole('button', { name: 'Apertura in corso…' })
    expect(inVolo.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(inVolo)
    fireEvent.click(inVolo)

    lenta.risolvi(json({ id: NUOVA }, 201))
    await waitFor(() => expect(onCreata).toHaveBeenCalledTimes(1))
    expect(scritture()).toHaveLength(1)
  })

  it.each([
    ['VOTAZIONE_CLASSE_GIA_APERTA', 409, shared.erroreVotazioneClasseGiaAperta],
    ['VOTAZIONE_ISTITUTO_GIA_APERTA', 409, shared.erroreVotazioneIstitutoGiaAperta],
    ['VOTAZIONE_SCADENZA_PASSATA', 400, shared.erroreVotazioneScadenzaPassata],
    ['VOTAZIONE_CLASSE_FUORI_SEDE', 400, shared.erroreVotazioneClasseFuoriSede],
    ['VOTAZIONE_CANDIDATO_NON_VALIDO', 400, shared.erroreVotazioneCandidatoNonValido],
  ])('l’errore %s del server si legge TRADOTTO e il modulo resta com’è', async (codice, stato, testo) => {
    h.rispostaPost = () => json({ error: 'testo grezzo del server', codice }, stato)
    const { onCreata } = monta()
    await classiPronte()
    fireEvent.click(spunta('3 ANNI'))
    impostaScadenza()

    fireEvent.click(apri())

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toBe(testo)
    expect(avviso.textContent).not.toContain('grezzo')
    expect(onCreata).not.toHaveBeenCalled()
    // I campi sono rimasti: si cambia e si riprova.
    expect(spunta('3 ANNI').checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Apri votazione' })).toBeTruthy()
    expect((screen.getByLabelText('Giorno') as HTMLInputElement).value).toBe('05/12/2030')
  })

  it('un guasto senza codice dice il testo di ripiego; la rete caduta pure', async () => {
    h.rispostaPost = () => new Response('', { status: 500 })
    monta()
    await classiPronte()
    fireEvent.click(spunta('3 ANNI'))
    impostaScadenza()
    fireEvent.click(apri())
    expect((await screen.findByRole('alert')).textContent).toBe('Non è stato possibile aprire la votazione. Riprova.')

    h.rispostaPost = () => Promise.reject(new TypeError('Failed to fetch'))
    fireEvent.click(apri())
    await waitFor(() => expect(scritture()).toHaveLength(2))
    expect((await screen.findByRole('alert')).textContent).toBe('Non è stato possibile aprire la votazione. Riprova.')
  })

  it('«Annulla» chiude senza scrivere niente', async () => {
    const { onAnnulla, onCreata } = monta()
    await classiPronte()
    fireEvent.click(spunta('3 ANNI'))

    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))

    expect(onAnnulla).toHaveBeenCalledTimes(1)
    expect(onCreata).not.toHaveBeenCalled()
    expect(scritture()).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('NuovaVotazioneForm · il titolo proposto segue l’anno della sede (4.1.P)', () => {
  // Una riga che contiene OGGI e porta un anno che il predefinito non darebbe mai: se il titolo la mostra,
  // l'etichetta viene dal calendario della sede e non da una costante.
  const rigaSede = {
    annoId: 'a2031',
    annoSedeId: 'r2031',
    annoInizio: 2031,
    inizio: '2020-01-01',
    fine: '2040-12-31',
    ultimoGiornoAperto: '2040-12-31',
    preparaSuccessivoDal: '2020-01-01',
    stato: 'corrente',
    domandeAperte: false,
  }
  const risposta = () => json({ success: true, data: [{ scuola_id: SEDE_A, righe: [rigaSede] }], fonte: 'database' })

  function montaConCalendario() {
    render(
      <CalendarioProvider>
        <NuovaVotazioneForm scuolaId={SEDE_A} onCreata={vi.fn()} onAnnulla={vi.fn()} />
      </CalendarioProvider>,
    )
  }

  it('propone il titolo con l’etichetta del calendario della sede, appena arriva', async () => {
    h.calendario = Promise.resolve(risposta())
    montaConCalendario()
    await waitFor(() =>
      expect((screen.getByLabelText('Titolo') as HTMLInputElement).value).toBe(titoloPredefinito('2031/32')),
    )
  })

  it('un titolo scritto a mano prima dell’arrivo del calendario resta', async () => {
    const d = differita<Response>()
    h.calendario = d.promessa
    montaConCalendario()
    await classiPronte()
    fireEvent.change(screen.getByLabelText('Titolo'), { target: { value: 'Elezione di prova mia' } })

    await act(async () => {
      d.risolvi(risposta())
    })
    await waitFor(() => expect(h.chiamate.some((c) => c.url === '/api/anno/calendario')).toBe(true))
    expect((screen.getByLabelText('Titolo') as HTMLInputElement).value).toBe('Elezione di prova mia')
  })
})
