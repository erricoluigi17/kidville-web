import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import itPrimaria from '../../messages/it/parentPrimaria.json'
import itShared from '../../messages/it/shared.json'

/**
 * PAGINA VOTI DEL GENITORE — impreparati e «Dichiara impreparato» (compito G2,
 * spec 2026-09-24 «2 Primaria»).
 *
 *  · gli impreparati stanno TRA i voti, nella card della loro materia (o in
 *    «Senza materia»), con l'etichetta del tipo e il motivo;
 *  · il modulo «Dichiara impreparato» è montato qui (era in un componente che
 *    nessuna pagina importava) e ne esiste UNA copia sola;
 *  · «Modifica» e «Annulla» solo dove il server dice `modificabile_dal_genitore`,
 *    e l'annullamento chiede conferma prima di partire;
 *  · ogni rifiuto si legge dal CODICE (catalogo), mai dalla prosa del server,
 *    e il successo si dichiara solo su una risposta positiva.
 */

// next-intl che INTERPOLA davvero (il mock globale non passa i valori): i nomi
// accessibili «…del {giorno}» devono distinguere due dichiarazioni.
vi.mock('next-intl', async () => {
  const cataloghi: Record<string, Record<string, string>> = {
    parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
    shared: (await import('../../messages/it/shared.json')).default,
  }
  const risolvi = (ns: string | undefined, key: string): string =>
    (ns ? cataloghi[ns]?.[key] : undefined) ?? (ns ? `${ns}.${key}` : key)
  const rendi = (modello: string, valori: Record<string, unknown> = {}): string =>
    modello.replace(/\{(\w+)\}/g, (intero, k: string) => (k in valori ? String(valori[k]) : intero))
  const useTranslations = (ns?: string) => {
    const t = (key: string, valori?: Record<string, unknown>) => rendi(risolvi(ns, key), valori)
    return Object.assign(t, { rich: t, markup: t, raw: (key: string) => risolvi(ns, key), has: () => true })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

const GENITORE = 'aaaabbbb-1111-4111-8111-eeeeeeeeeeee'
const ALUNNO = 'ccccdddd-2222-4222-8222-ffffffffffff'
vi.mock('@/lib/auth/use-parent-identity', () => ({
  useParentIdentity: () => ({ parentId: GENITORE, studentId: ALUNNO, ready: true }),
}))

import ValutazioniGenitorePage from '@/app/(dashboard)/parent/primaria/valutazioni/page'

// ── Dati di prova ────────────────────────────────────────────────────────────
// Le 10:00 UTC del 25/09/2026 = le 12:00 a Roma: «oggi» è il 25 in entrambi i fusi.
const ADESSO = new Date('2026-09-25T10:00:00Z')
const MAT = '0a0a0a0a-0000-4000-8000-0000000000aa'
const MAT_ITA = '0b0b0b0b-0000-4000-8000-0000000000bb'
const MAT_SCI = '0e0e0e0e-0000-4000-8000-0000000000ee'
const I_DOCENTE = '11111111-0000-4000-8000-000000000001'
const I_MIA = '11111111-0000-4000-8000-000000000002'
const I_PASSATA = '11111111-0000-4000-8000-000000000003'

const impreparatiBase = () => [
  // Segnato dal DOCENTE, sulla materia che ha voti: non modificabile.
  {
    id: I_DOCENTE, tipo: 'impreparato', motivo: null, materiaId: MAT, materiaNome: 'Matematica',
    data: '2026-09-23', origine: 'docente', creato_il: '2026-09-23T08:00:00Z', modificabile_dal_genitore: false,
  },
  // La MIA, senza materia, per dopodomani: modificabile.
  {
    id: I_MIA, tipo: 'giustificato', motivo: 'Visita dal dentista', materiaId: null, materiaNome: null,
    data: '2026-09-27', origine: 'genitore', creato_il: '2026-09-24T18:00:00Z', modificabile_dal_genitore: true,
  },
  // Mia ma di un giorno PASSATO, su una materia senza voti: non più modificabile.
  {
    id: I_PASSATA, tipo: 'giustificato', motivo: 'Febbre', materiaId: MAT_ITA, materiaNome: 'Italiano',
    data: '2026-09-22', origine: 'genitore', creato_il: '2026-09-21T18:00:00Z', modificabile_dal_genitore: false,
  },
]

interface Risposta { ok: boolean; status: number; body: unknown }
const finge = (r: Risposta) => ({ ok: r.ok, status: r.status, json: async () => r.body })

const fetchMock = vi.fn()
let esitoGet: Risposta
let esitoPost: Risposta
let esitoPatch: Risposta
let esitoDelete: Risposta

function chiamate(metodo: string): { url: string; init?: RequestInit }[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .map(([url, init]) => ({ url, init }))
    .filter(({ init }) => (init?.method ?? 'GET') === metodo)
}
const corpoDi = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
  esitoGet = {
    ok: true,
    status: 200,
    body: {
      success: true,
      data: [{
        materiaId: MAT, nome: 'Matematica',
        valutazioni: [{
          id: 'v-1', tipo: 'orale', modalita: 'giudizio', giudizio_sintetico: 'Buono',
          giudizio_testo: null, creato_il: '2026-09-24T09:00:00Z', argomento: 'Frazioni',
        }],
      }],
      impreparati: impreparatiBase(),
      materieClasse: [
        { id: MAT, nome: 'Matematica' },
        { id: MAT_ITA, nome: 'Italiano' },
        { id: MAT_SCI, nome: 'Scienze' },
      ],
    },
  }
  esitoPost = { ok: true, status: 201, body: { success: true } }
  esitoPatch = { ok: true, status: 200, body: { success: true } }
  esitoDelete = { ok: true, status: 200, body: { success: true } }
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET'
    if (metodo === 'POST') return Promise.resolve(finge(esitoPost))
    if (metodo === 'PATCH') return Promise.resolve(finge(esitoPatch))
    if (metodo === 'DELETE') return Promise.resolve(finge(esitoDelete))
    return Promise.resolve(finge(esitoGet))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Apre la card di una materia (il suo bottone porta il nome della materia). */
async function apriCard(nome: string) {
  const bottone = await screen.findByRole('button', { name: new RegExp(`^${nome}`) })
  if (bottone.getAttribute('aria-expanded') !== 'true') fireEvent.click(bottone)
  return bottone.closest('div.rounded-card') as HTMLElement
}

const t = itPrimaria as Record<string, string>
const ts = itShared as Record<string, string>

describe('impreparati tra i voti', () => {
  it('ogni impreparato sta nella card della sua materia, con tipo, origine e motivo', async () => {
    render(<ValutazioniGenitorePage />)

    // Matematica: il voto E l'impreparato del docente, nella stessa card.
    const mat = await apriCard('Matematica')
    expect(within(mat).getByText('Buono')).toBeTruthy()
    expect(within(mat).getByText(t.impreparatoTipo_impreparato)).toBeTruthy()
    expect(within(mat).getByText(t.impreparatoOrigine_docente)).toBeTruthy()

    // Italiano non ha voti: la card esiste lo stesso, per l'impreparato.
    const ita = await apriCard('Italiano')
    expect(within(ita).getByText(t.impreparatoTipo_giustificato)).toBeTruthy()
    expect(within(ita).getByText('Motivo: Febbre')).toBeTruthy()

    // Senza materia: la card propria.
    const senza = await apriCard(t.impreparatoSenzaMateria)
    expect(within(senza).getByText(t.impreparatoTipo_giustificato)).toBeTruthy()
    expect(within(senza).getByText(t.impreparatoOrigine_genitore)).toBeTruthy()
    expect(within(senza).getByText('Motivo: Visita dal dentista')).toBeTruthy()
  })

  // La pagina è una FISARMONICA: una card aperta alla volta, e le righe di una
  // card chiusa non sono nel DOM. Ogni card si controlla quindi MENTRE è aperta
  // (aria-expanded="true" e la riga presente), mai contando i pulsanti su tutta
  // la pagina dopo averne aperte tre di fila: resterebbe aperta solo l'ultima.
  it('«Modifica» e «Annulla» solo sulla dichiarazione modificabile dal genitore', async () => {
    // Una quarta riga chiude la famiglia: del GENITORE, per un giorno FUTURO,
    // ma col flag spento (per esempio dichiarata dall'altro genitore). Né
    // l'origine né la data bastano: decide solo `modificabile_dal_genitore`.
    const I_ALTRO = '11111111-0000-4000-8000-000000000004'
    esitoGet = {
      ...esitoGet,
      body: {
        ...(esitoGet.body as object),
        impreparati: [
          ...impreparatiBase(),
          {
            id: I_ALTRO, tipo: 'impreparato', motivo: null, materiaId: MAT_SCI, materiaNome: 'Scienze',
            data: '2026-09-29', origine: 'genitore', creato_il: '2026-09-24T19:00:00Z', modificabile_dal_genitore: false,
          },
        ],
      },
    }
    render(<ValutazioniGenitorePage />)

    const nessunPulsante = async (nomeCard: string, idRiga: string) => {
      const card = await apriCard(nomeCard)
      const bottone = within(card).getByRole('button', { name: new RegExp(`^${nomeCard}`) })
      expect(bottone.getAttribute('aria-expanded')).toBe('true')
      // La riga è DAVVERO renderizzata: l'assenza dei pulsanti non è quella di una card chiusa.
      const riga = await waitFor(() => {
        const r = card.querySelector(`[data-impreparato="${idRiga}"]`)
        expect(r).not.toBeNull()
        return r as HTMLElement
      })
      expect(within(card).queryAllByRole('button', { name: /^Modifica la dichiarazione/ })).toHaveLength(0)
      expect(within(card).queryAllByRole('button', { name: /^Annulla la dichiarazione/ })).toHaveLength(0)
      expect(within(riga).queryAllByRole('button')).toHaveLength(0)
    }

    // (1) Caso chiave: del genitore, giorno PASSATO, flag spento.
    await nessunPulsante('Italiano', I_PASSATA)
    // (2) Segnato dal docente.
    await nessunPulsante('Matematica', I_DOCENTE)
    // (4) Del genitore, giorno FUTURO, flag spento.
    await nessunPulsante('Scienze', I_ALTRO)

    // (3) L'unica col permesso: un pulsante per tipo, col SUO giorno.
    const senza = await apriCard(t.impreparatoSenzaMateria)
    expect(within(senza).getByRole('button', { name: new RegExp(`^${t.impreparatoSenzaMateria}`) }).getAttribute('aria-expanded')).toBe('true')
    const riga = senza.querySelector(`[data-impreparato="${I_MIA}"]`) as HTMLElement
    expect(riga).not.toBeNull()
    expect(within(senza).getAllByRole('button', { name: /^Modifica la dichiarazione/ })).toHaveLength(1)
    expect(within(senza).getAllByRole('button', { name: /^Annulla la dichiarazione/ })).toHaveLength(1)
    expect(within(riga).getByRole('button', { name: 'Modifica la dichiarazione del 27/09/2026' })).toBeTruthy()
    expect(within(riga).getByRole('button', { name: 'Annulla la dichiarazione del 27/09/2026' })).toBeTruthy()
  })

  it('una lettura rifiutata si dice col codice, non come «nessuna valutazione»', async () => {
    esitoGet = { ok: false, status: 500, body: { error: 'PROSA-DEL-SERVER', codice: 'LETTURA_FALLITA' } }
    render(<ValutazioniGenitorePage />)
    expect(await screen.findByText(ts.erroreLetturaFallita)).toBeTruthy()
    expect(screen.queryByText(t.valutazioniVuoto)).toBeNull()
    expect(screen.queryByText('PROSA-DEL-SERVER')).toBeNull()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 500 }))
  })
})

describe('annullare la propria dichiarazione', () => {
  it('chiede conferma: senza il «Sì» non parte nessuna DELETE', async () => {
    render(<ValutazioniGenitorePage />)
    await apriCard(t.impreparatoSenzaMateria)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla la dichiarazione del 27/09/2026' }))
    expect(await screen.findByText(/Annullare la dichiarazione del 27\/09\/2026\?/)).toBeTruthy()
    expect(chiamate('DELETE')).toHaveLength(0)

    // «No, tienila» torna indietro senza scrivere.
    fireEvent.click(screen.getByRole('button', { name: t.impreparatoAnnullaNo }))
    expect(chiamate('DELETE')).toHaveLength(0)
    expect(screen.queryByText(/Annullare la dichiarazione/)).toBeNull()
  })

  it('con la conferma manda la DELETE di QUELLA dichiarazione e rilegge i voti', async () => {
    render(<ValutazioniGenitorePage />)
    const card = await apriCard(t.impreparatoSenzaMateria)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla la dichiarazione del 27/09/2026' }))
    // Dopo la DELETE il server non la rimanda più: era l'UNICA voce della card.
    esitoGet = {
      ...esitoGet,
      body: { ...(esitoGet.body as object), impreparati: impreparatiBase().filter((i) => i.id !== I_MIA) },
    }
    // La rilettura resta IN VOLO finché il test non la sblocca (vedi la PATCH).
    let sbloccaRilettura!: () => void
    const rilettura = new Promise<void>((res) => { sbloccaRilettura = res })
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const metodo = init?.method ?? 'GET'
      if (metodo === 'DELETE') return Promise.resolve(finge(esitoDelete))
      return rilettura.then(() => finge(esitoGet))
    })
    fireEvent.click(await screen.findByRole('button', { name: t.impreparatoAnnullaSi }))

    // La conferma sta DOVE stava la riga, nella sua card, e prende il fuoco —
    // già PRIMA della rilettura: il pulsante premuto non esiste più.
    const conferma = await within(card).findByRole('status')
    expect(conferma.textContent).toBe(t.impreparatoAnnullata)
    await waitFor(() => expect(document.activeElement).toBe(conferma))
    expect(card.querySelector(`[data-impreparato="${I_MIA}"]`)).toBeNull()
    sbloccaRilettura()
    const del = chiamate('DELETE')
    expect(del).toHaveLength(1)
    const url = new URL(del[0].url, 'http://x')
    expect(url.pathname).toBe('/api/parent/giustifiche-didattiche')
    expect(url.searchParams.get('id')).toBe(I_MIA)
    await waitFor(() => expect(chiamate('GET')).toHaveLength(2))
    // Dopo la rilettura la card resta, col solo segnaposto: la riga non torna.
    await waitFor(() => expect(card.querySelector(`[data-impreparato="${I_MIA}"]`)).toBeNull())
    expect(within(card).getByText(t.impreparatoAnnullata)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Annulla la dichiarazione del 27/09/2026' })).toBeNull()
  })

  it('mentre la DELETE è in volo «Sì, annulla» dice che sta lavorando', async () => {
    let rispondi!: (r: unknown) => void
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise((res) => { rispondi = res })
      return Promise.resolve(finge(esitoGet))
    })
    render(<ValutazioniGenitorePage />)
    await apriCard(t.impreparatoSenzaMateria)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla la dichiarazione del 27/09/2026' }))
    fireEvent.click(await screen.findByRole('button', { name: t.impreparatoAnnullaSi }))

    const inCorso = await screen.findByRole('button', { name: t.impreparatoAnnullamento })
    expect(inCorso.getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByRole('button', { name: t.impreparatoAnnullaSi })).toBeNull()
    // Un secondo tocco non manda una seconda DELETE.
    fireEvent.click(inCorso)
    expect(chiamate('DELETE')).toHaveLength(1)
    esitoGet = {
      ...esitoGet,
      body: { ...(esitoGet.body as object), impreparati: impreparatiBase().filter((i) => i.id !== I_MIA) },
    }
    rispondi(finge({ ok: true, status: 200, body: { success: true } }))
    expect(await screen.findByText(t.impreparatoAnnullata)).toBeTruthy()
    await waitFor(() => expect(chiamate('GET')).toHaveLength(2))
  })

  it('un rifiuto si legge dal codice (catalogo), non dalla prosa, e non dichiara successo', async () => {
    esitoDelete = { ok: false, status: 409, body: { error: 'PROSA-DEL-SERVER', codice: 'IMPREPARATO_DATA_PASSATA' } }
    render(<ValutazioniGenitorePage />)
    await apriCard(t.impreparatoSenzaMateria)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla la dichiarazione del 27/09/2026' }))
    fireEvent.click(await screen.findByRole('button', { name: t.impreparatoAnnullaSi }))

    // Il rifiuto sta DENTRO il riquadro di conferma, sotto «Sì, annulla / No,
    // tienila» — nel punto in cui il genitore sta guardando — e non altrove.
    const riquadro = screen.getByRole('group', { name: 'Annulla la dichiarazione del 27/09/2026' })
    const avviso = await within(riquadro).findByRole('alert')
    expect(avviso.textContent).toBe(ts.erroreImpreparatoDataPassata)
    expect(screen.getAllByText(ts.erroreImpreparatoDataPassata)).toHaveLength(1)
    expect(screen.queryByText('PROSA-DEL-SERVER')).toBeNull()
    expect(screen.queryByText(t.impreparatoAnnullata)).toBeNull()
    // Il riquadro resta aperto e si può riprovare.
    expect(within(riquadro).getByRole('button', { name: t.impreparatoAnnullaSi })).toBeTruthy()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 409 }))
  })

  it('il fuoco entra nel riquadro di conferma e, con «No, tienila», torna su «Annulla» di QUELLA riga', async () => {
    render(<ValutazioniGenitorePage />)
    const card = await apriCard(t.impreparatoSenzaMateria)
    fireEvent.click(within(card).getByRole('button', { name: 'Annulla la dichiarazione del 27/09/2026' }))

    const riquadro = await screen.findByRole('group', { name: 'Annulla la dichiarazione del 27/09/2026' })
    expect(riquadro.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.textContent).toMatch(/^Annullare la dichiarazione del 27\/09\/2026\?/)

    fireEvent.click(within(riquadro).getByRole('button', { name: t.impreparatoAnnullaNo }))
    const annulla = await within(card).findByRole('button', { name: 'Annulla la dichiarazione del 27/09/2026' })
    expect(document.activeElement).toBe(annulla)
  })
})

describe('modificare la propria dichiarazione', () => {
  it('la PATCH porta id, giorno, materia e motivo modificati', async () => {
    render(<ValutazioniGenitorePage />)
    const card = await apriCard(t.impreparatoSenzaMateria)
    fireEvent.click(screen.getByRole('button', { name: 'Modifica la dichiarazione del 27/09/2026' }))
    // Il server, riletto, rimanda la dichiarazione coi valori nuovi.
    esitoGet = {
      ...esitoGet,
      body: {
        ...(esitoGet.body as object),
        impreparati: impreparatiBase().map((i) =>
          i.id === I_MIA ? { ...i, data: '2026-09-28', materiaId: MAT_SCI, materiaNome: 'Scienze', motivo: 'Visita medica' } : i,
        ),
      },
    }

    // Il modulo parte dai valori ATTUALI della dichiarazione.
    const motivo = within(card).getByRole('textbox', { name: t.viewMotivoFacoltativo }) as HTMLInputElement
    expect(motivo.value).toBe('Visita dal dentista')
    fireEvent.change(motivo, { target: { value: 'Visita medica' } })
    fireEvent.change(within(card).getByRole('combobox', { name: t.viewMateriaFacoltativa }), { target: { value: MAT_SCI } })
    fireEvent.change(within(card).getByRole('textbox', { name: t.viewImpreparatoDataAria }), { target: { value: '28/09/2026' } })
    // La rilettura resta IN VOLO finché il test non la sblocca: in un browser
    // arriva dopo il render che segue il salvataggio, non insieme.
    let sbloccaRilettura!: () => void
    const rilettura = new Promise<void>((res) => { sbloccaRilettura = res })
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const metodo = init?.method ?? 'GET'
      if (metodo === 'PATCH') return Promise.resolve(finge(esitoPatch))
      return rilettura.then(() => finge(esitoGet))
    })
    fireEvent.click(within(card).getByRole('button', { name: t.impreparatoSalva }))

    // PRIMA della rilettura: la riga è già nella card di Scienze, col fuoco sul
    // suo «Modifica» (se restasse nella vecchia card fino alla rilettura, il
    // suo spostamento smonterebbe il pulsante e il fuoco cadrebbe su <body>).
    const sciPrima = (await screen.findByRole('button', { name: /^Scienze/ })).closest('div.rounded-card') as HTMLElement
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(sciPrima).getByRole('button', { name: 'Modifica la dichiarazione del 28/09/2026' }),
      ),
    )
    expect(chiamate('GET')).toHaveLength(2)
    sbloccaRilettura()

    const p = chiamate('PATCH')
    expect(p).toHaveLength(1)
    expect(p[0].url.startsWith('/api/parent/giustifiche-didattiche')).toBe(true)
    expect(corpoDi(p[0])).toEqual({ id: I_MIA, data: '2026-09-28', materiaId: MAT_SCI, motivo: 'Visita medica' })

    // La conferma sta sulla RIGA, che ora vive nella card di Scienze; il fuoco
    // torna sul «Modifica» di quella riga.
    const sci = (await screen.findByRole('button', { name: /^Scienze/ })).closest('div.rounded-card') as HTMLElement
    const riga = sci.querySelector(`[data-impreparato="${I_MIA}"]`) as HTMLElement
    expect(riga).not.toBeNull()
    expect(within(riga).getByRole('status').textContent).toBe(t.impreparatoModificata)
    const modifica = within(riga).getByRole('button', { name: 'Modifica la dichiarazione del 28/09/2026' })
    expect(document.activeElement).toBe(modifica)
  })

  it('il fuoco va sul modulo all\'apertura e torna su «Modifica» con «Chiudi»', async () => {
    render(<ValutazioniGenitorePage />)
    const card = await apriCard(t.impreparatoSenzaMateria)
    fireEvent.click(within(card).getByRole('button', { name: 'Modifica la dichiarazione del 27/09/2026' }))

    const titolo = await within(card).findByText(t.impreparatoModificaTitolo)
    expect(document.activeElement).toBe(titolo)

    fireEvent.click(within(card).getByRole('button', { name: t.impreparatoChiudi }))
    const modifica = await within(card).findByRole('button', { name: 'Modifica la dichiarazione del 27/09/2026' })
    expect(document.activeElement).toBe(modifica)
    expect(chiamate('PATCH')).toHaveLength(0)
  })

  it('svuotare il motivo lo toglie (null), e un rifiuto per codice non chiude il modulo', async () => {
    esitoPatch = { ok: false, status: 400, body: { error: 'PROSA', codice: 'IMPREPARATO_MATERIA_NON_VALIDA' } }
    render(<ValutazioniGenitorePage />)
    const card = await apriCard(t.impreparatoSenzaMateria)
    fireEvent.click(screen.getByRole('button', { name: 'Modifica la dichiarazione del 27/09/2026' }))
    fireEvent.change(within(card).getByRole('textbox', { name: t.viewMotivoFacoltativo }), { target: { value: '   ' } })
    fireEvent.click(within(card).getByRole('button', { name: t.impreparatoSalva }))

    expect(await within(card).findByText(ts.erroreImpreparatoMateriaNonValida)).toBeTruthy()
    expect(corpoDi(chiamate('PATCH')[0])).toEqual({ id: I_MIA, data: '2026-09-27', materiaId: null, motivo: null })
    expect(screen.queryByText(t.impreparatoModificata)).toBeNull()
    expect(within(card).getByRole('button', { name: t.impreparatoSalva })).toBeTruthy()
  })
})

describe('«Dichiara impreparato» montato nella pagina', () => {
  it('offre anche le materie senza voti, e la POST porta alunno, giorno, materia e motivo', async () => {
    render(<ValutazioniGenitorePage />)
    await screen.findByRole('button', { name: /^Matematica/ })
    const modulo = screen.getByRole('heading', { name: t.viewDichiaraImpreparato }).closest('section') as HTMLElement
    const select = within(modulo).getByRole('combobox', { name: t.viewMateriaFacoltativa })
    expect(within(select).getByRole('option', { name: 'Scienze' })).toBeTruthy()

    fireEvent.change(select, { target: { value: MAT_SCI } })
    fireEvent.change(within(modulo).getByRole('textbox', { name: t.viewMotivoFacoltativo }), { target: { value: 'Gita' } })
    fireEvent.click(within(modulo).getByRole('button', { name: t.viewInviaDichiarazione }))

    expect(await within(modulo).findByText(t.viewDichiarazioneInviata)).toBeTruthy()
    const post = chiamate('POST')
    expect(post).toHaveLength(1)
    expect(post[0].url.startsWith('/api/parent/giustifiche-didattiche')).toBe(true)
    // Il giorno predefinito è OGGI in data di Roma.
    expect(corpoDi(post[0])).toEqual({ studentId: ALUNNO, data: '2026-09-25', motivo: 'Gita', materiaId: MAT_SCI })
    await waitFor(() => expect(chiamate('GET')).toHaveLength(2))
  })

  it('un rifiuto senza codice mostra la frase del modulo, mai «inviata»', async () => {
    esitoPost = { ok: false, status: 403, body: { error: 'Disponibile solo per la scuola primaria' } }
    render(<ValutazioniGenitorePage />)
    await screen.findByRole('button', { name: /^Matematica/ })
    const modulo = screen.getByRole('heading', { name: t.viewDichiaraImpreparato }).closest('section') as HTMLElement
    fireEvent.click(within(modulo).getByRole('button', { name: t.viewInviaDichiarazione }))

    expect(await within(modulo).findByText(t.impreparatoInvioNonRiuscito)).toBeTruthy()
    expect(within(modulo).queryByText(t.viewDichiarazioneInviata)).toBeNull()
    expect(screen.queryByText('Disponibile solo per la scuola primaria')).toBeNull()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }))
  })

  it('un giorno passato si ferma sul dispositivo: nessuna POST', async () => {
    render(<ValutazioniGenitorePage />)
    await screen.findByRole('button', { name: /^Matematica/ })
    const modulo = screen.getByRole('heading', { name: t.viewDichiaraImpreparato }).closest('section') as HTMLElement
    fireEvent.change(within(modulo).getByRole('textbox', { name: t.viewImpreparatoDataAria }), { target: { value: '24/09/2026' } })
    fireEvent.click(within(modulo).getByRole('button', { name: t.viewInviaDichiarazione }))

    expect(await within(modulo).findByText(t.impreparatoDataPassata)).toBeTruthy()
    expect(chiamate('POST')).toHaveLength(0)
  })

  // Alle 22:30 UTC del 25/09 a Roma è già il 26 (00:30, ora legale). Con «oggi»
  // calcolato in UTC il modulo proporrebbe il 25 e lo accetterebbe: un giorno
  // che a Roma è GIÀ passato.
  describe('a cavallo della mezzanotte di Roma', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2026-09-25T22:30:00Z'))
    })

    it('il giorno predefinito è il 26 (Roma), non il 25 (UTC)', async () => {
      render(<ValutazioniGenitorePage />)
      await screen.findByRole('button', { name: /^Matematica/ })
      const modulo = screen.getByRole('heading', { name: t.viewDichiaraImpreparato }).closest('section') as HTMLElement
      fireEvent.click(within(modulo).getByRole('button', { name: t.viewInviaDichiarazione }))

      expect(await within(modulo).findByText(t.viewDichiarazioneInviata)).toBeTruthy()
      const post = chiamate('POST')
      expect(post).toHaveLength(1)
      expect(corpoDi(post[0]).data).toBe('2026-09-26')
    })

    it('il 25 è già passato: si ferma sul dispositivo, nessuna POST', async () => {
      render(<ValutazioniGenitorePage />)
      await screen.findByRole('button', { name: /^Matematica/ })
      const modulo = screen.getByRole('heading', { name: t.viewDichiaraImpreparato }).closest('section') as HTMLElement
      fireEvent.change(within(modulo).getByRole('textbox', { name: t.viewImpreparatoDataAria }), { target: { value: '25/09/2026' } })
      fireEvent.click(within(modulo).getByRole('button', { name: t.viewInviaDichiarazione }))

      expect(await within(modulo).findByText(t.impreparatoDataPassata)).toBeTruthy()
      expect(chiamate('POST')).toHaveLength(0)
    })
  })
})

describe('un modulo solo', () => {
  // Il modulo stava dentro `PrimariaParentView` (mai montato). Estratto, non copiato:
  // in `src/` la sua definizione esiste UNA volta, nel file suo. Si cercano
  // DICHIARAZIONI (`function ImpreparatoForm` / `const ImpreparatoForm =`), che un
  // commento non scrive.
  it('`ImpreparatoForm` è definito una sola volta, in ImpreparatoForm.tsx', () => {
    const definizioni: string[] = []
    const cammina = (dir: string) => {
      for (const voce of readdirSync(dir)) {
        const p = join(dir, voce)
        if (statSync(p).isDirectory()) cammina(p)
        else if (/\.tsx?$/.test(voce) && /(?:function\s+ImpreparatoForm\b|const\s+ImpreparatoForm\s*=)/.test(readFileSync(p, 'utf8'))) {
          definizioni.push(p.slice(process.cwd().length + 1))
        }
      }
    }
    cammina(join(process.cwd(), 'src'))
    expect(definizioni).toEqual(['src/components/features/parent/ImpreparatoForm.tsx'])
  })
})
