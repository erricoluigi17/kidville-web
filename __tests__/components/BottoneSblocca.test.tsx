import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// =============================================================================
// «SBLOCCA» — il comando della Direzione per scrivere oltre il termine.
//
// Sostituisce `SbloccaOraButton` (che sbloccava solo l'ora mai firmata) e ne
// eredita i casi, più i due modi nuovi: la VOCE e il GIORNO della classe.
// Fissa:
//  · si mostra SOLO alla Direzione (admin/coordinator) — non alla maestra, non
//    alla Segreteria: il gate vero è sul server, qui si evita un 403 offerto;
//  · non parte SENZA motivazione (`sblocchi_audit.motivazione` è NOT NULL);
//  · per ogni modo manda ESATTAMENTE il corpo che la route accetta;
//  · un rifiuto del server si legge a schermo e si logga, senza il motivo.
//
// next-intl è finto con il FORMATTATORE VERO sui cataloghi veri: il mock globale
// restituisce la chiave grezza, e «/sblocca/i» sarebbe verde anche su una chiave
// mai tradotta.
// =============================================================================

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl')
  const teacherPrimaria = (await import('../../messages/it/teacherPrimaria.json')).default as Record<string, string>
  const useTranslations = (ns?: string) => {
    const tradotto = createTranslator({
      locale: 'it',
      messages: { teacherPrimaria } as never,
      namespace: (ns ?? 'teacherPrimaria') as never,
    }) as unknown as (chiave: string, valori?: Record<string, unknown>) => string
    const t = (chiave: string, valori?: Record<string, unknown>) => tradotto(chiave, valori)
    return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient }))

import {
  BottoneSblocca,
  corpoSblocco,
  nomeAccessibileSblocco,
  puoSbloccare,
  type BersaglioSblocco,
} from '@/components/features/primaria/BottoneSblocca'
import { MOTIVAZIONE_SBLOCCO_MAX } from '@/lib/primaria/sblocco-motivazione'
import { createTranslator } from 'use-intl'
import teacherPrimariaIt from '../../messages/it/teacherPrimaria.json'
import teacherPrimariaEn from '../../messages/en/teacherPrimaria.json'

const SEZIONE = 'aaaa1111-0000-4000-8000-0000000000a1'
const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000001'
const VOCE = 'e9157200-0000-4000-8000-000000000009'
const LUNEDI = '2026-09-07'

const SLOT: BersaglioSblocco = { modo: 'slot', sectionId: SEZIONE, data: LUNEDI, oraLezione: 3 }

const fetchMock = vi.fn()

function monta(bersaglio: BersaglioSblocco = SLOT, ruolo: string | null = 'admin') {
  const onSbloccato = vi.fn()
  render(<BottoneSblocca bersaglio={bersaglio} userId={DIRIGENTE} ruolo={ruolo} onSbloccato={onSbloccato} />)
  return { onSbloccato }
}

/** Apre la modale e scrive la motivazione. Ritorna il comando di conferma. */
function apriEScrivi(motivazione: string, bottone: RegExp = /sblocca l’ora/i) {
  fireEvent.click(screen.getByRole('button', { name: bottone }))
  fireEvent.change(screen.getByLabelText('Motivo dello sblocco'), { target: { value: motivazione } })
  return screen.getByRole('button', { name: 'Autorizza' })
}

beforeEach(() => {
  fetchMock.mockReset()
  h.logClient.mockReset()
  fetchMock.mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // La lingua dell'interfaccia la legge `messaggioDaCorpo`: un caso in inglese non
  // deve trascinarsi nei successivi.
  document.documentElement.removeAttribute('lang')
})

describe('BottoneSblocca — chi lo vede', () => {
  it.each(['educator', 'segreteria', 'genitore', null])('il ruolo %s NON lo vede', (ruolo) => {
    monta(SLOT, ruolo)
    expect(screen.queryByRole('button', { name: /sblocca/i })).toBeNull()
  })

  it('la Direzione (admin e coordinator) lo vede, col testo tradotto', () => {
    expect(puoSbloccare('admin')).toBe(true)
    expect(puoSbloccare('coordinator')).toBe(true)
    expect(puoSbloccare('segreteria')).toBe(false)
    expect(puoSbloccare(undefined)).toBe(false)

    monta(SLOT, 'coordinator')
    expect(screen.getByRole('button', { name: 'Sblocca l’ora' })).toBeInTheDocument()
  })

  it('ogni modo ha la sua etichetta', () => {
    monta({ modo: 'voce', entitaTipo: 'valutazione', entitaId: VOCE })
    expect(screen.getByRole('button', { name: 'Sblocca' })).toBeInTheDocument()
    cleanup()
    monta({ modo: 'giorno', sectionId: SEZIONE, data: LUNEDI })
    expect(screen.getByRole('button', { name: 'Sblocca il giorno' })).toBeInTheDocument()
  })

  it('la motivazione si chiede in una MODALE accessibile, con titolo', () => {
    monta({ modo: 'giorno', sectionId: SEZIONE, data: LUNEDI })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sblocca il giorno' }))
    const dialogo = screen.getByRole('dialog', { name: 'Sblocca il giorno della classe' })
    expect(dialogo).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByLabelText('Motivo dello sblocco')).toBeInTheDocument()
  })
})

describe('BottoneSblocca — il contesto per lo screen reader', () => {
  // In un elenco di voci bloccate ci sono N bottoni «Sblocca» uguali: senza il
  // contesto chi usa uno screen reader non sa a quale voce si riferisce ciascuno.
  const DESCRIZIONE = 'Sblocca la valutazione di Matematica del 07/09'

  function montaConDescrizione(descrizione: string | undefined, entitaId = VOCE) {
    render(
      <BottoneSblocca
        bersaglio={{ modo: 'voce', entitaTipo: 'valutazione', entitaId }}
        userId={DIRIGENTE}
        ruolo="admin"
        onSbloccato={vi.fn()}
        descrizioneAccessibile={descrizione}
      />,
    )
  }

  it('con la descrizione, il nome accessibile del bottone è la descrizione', () => {
    montaConDescrizione(DESCRIZIONE)
    expect(screen.getByRole('button', { name: DESCRIZIONE })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sblocca' })).toBeNull()
  })

  it('senza descrizione il nome resta «Sblocca»', () => {
    montaConDescrizione(undefined)
    const b = screen.getByRole('button', { name: 'Sblocca' })
    expect(b).not.toHaveAttribute('aria-label')
  })

  it('due voci nello stesso elenco: due bottoni distinguibili', () => {
    montaConDescrizione('Sblocca la nota del 07/09')
    montaConDescrizione('Sblocca l’impreparato del 04/09', 'e9157200-0000-4000-8000-000000000010')
    expect(screen.getByRole('button', { name: 'Sblocca la nota del 07/09' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sblocca l’impreparato del 04/09' })).toBeInTheDocument()
  })

  it('se la descrizione non contiene l’etichetta visibile, la antepone (WCAG 2.5.3)', () => {
    expect(nomeAccessibileSblocco('Sblocca', 'Valutazione di Matematica del 07/09')).toBe(
      'Sblocca: Valutazione di Matematica del 07/09',
    )
    expect(nomeAccessibileSblocco('Sblocca', DESCRIZIONE)).toBe(DESCRIZIONE)
    expect(nomeAccessibileSblocco('Sblocca', '   ')).toBeUndefined()
    montaConDescrizione('Valutazione di Matematica del 07/09')
    expect(screen.getByRole('button', { name: 'Sblocca: Valutazione di Matematica del 07/09' })).toBeInTheDocument()
  })

  it('la descrizione è il sottotitolo della modale', () => {
    montaConDescrizione(DESCRIZIONE)
    fireEvent.click(screen.getByRole('button', { name: DESCRIZIONE }))
    const dialogo = screen.getByRole('dialog')
    expect(screen.getByTestId('sblocca-contesto')).toHaveTextContent(DESCRIZIONE)
    expect(dialogo).toContainElement(screen.getByTestId('sblocca-contesto'))
  })

  it('senza descrizione la modale non ha il sottotitolo di contesto', () => {
    montaConDescrizione(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Sblocca' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('sblocca-contesto')).toBeNull()
  })

  it('il bottone dichiara se la modale è aperta (`aria-expanded`)', () => {
    montaConDescrizione(DESCRIZIONE)
    const b = screen.getByRole('button', { name: DESCRIZIONE })
    expect(b).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(b)
    expect(b).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))
    expect(b).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('BottoneSblocca — il tetto della motivazione', () => {
  // Il numero è UNO solo, importato da entrambi i lati: lo schema zod della route e
  // la textarea. Se la textarea non l'avesse, oltre il tetto il server risponderebbe
  // un 400 senza codice («Dati non validi») che non dice «troppo lungo».
  it('la textarea ha `maxLength` pari al tetto della route', () => {
    monta({ modo: 'giorno', sectionId: SEZIONE, data: LUNEDI })
    fireEvent.click(screen.getByRole('button', { name: 'Sblocca il giorno' }))
    const campo = screen.getByLabelText('Motivo dello sblocco') as HTMLTextAreaElement
    expect(campo.maxLength).toBe(MOTIVAZIONE_SBLOCCO_MAX)
    expect(campo).toHaveAttribute('maxlength', String(MOTIVAZIONE_SBLOCCO_MAX))
  })

  it('il conteggio dei caratteri si vede, è tradotto, ed è legato al campo', () => {
    monta({ modo: 'giorno', sectionId: SEZIONE, data: LUNEDI })
    fireEvent.click(screen.getByRole('button', { name: 'Sblocca il giorno' }))
    const campo = screen.getByLabelText('Motivo dello sblocco')
    fireEvent.change(campo, { target: { value: 'gita' } })
    const conteggio = screen.getByText(`4 di ${MOTIVAZIONE_SBLOCCO_MAX} caratteri`)
    expect(campo).toHaveAttribute('aria-describedby', conteggio.id)
  })

  // Il denominatore sta in un blocco `plural`, e `#` passa da Intl.NumberFormat; un
  // numeratore `{usati}` semplice passa invece da String(). Col campo pieno l'inglese
  // leggeva «1000 of 1,000 characters»: due formati diversi nella stessa frase.
  // Il caso a 5 cifre copre l'italiano, dove il separatore compare solo da 10.000.
  it('numeratore e denominatore hanno lo STESSO formato numerico, in ogni lingua', () => {
    const conteggio = (locale: 'it' | 'en', catalogo: Record<string, string>, usati: number, max: number) =>
      (createTranslator({
        locale,
        messages: { teacherPrimaria: catalogo } as never,
        namespace: 'teacherPrimaria' as never,
      }) as unknown as (chiave: string, valori: Record<string, unknown>) => string)('sbloccaMotivoConteggio', {
        usati,
        max,
      })

    expect(conteggio('en', teacherPrimariaEn, 1000, 1000)).toBe('1,000 of 1,000 characters')
    expect(conteggio('en', teacherPrimariaEn, 4, 1000)).toBe('4 of 1,000 characters')
    expect(conteggio('en', teacherPrimariaEn, 12345, 12345)).toBe('12,345 of 12,345 characters')
    expect(conteggio('it', teacherPrimariaIt, 1000, 1000)).toBe('1000 di 1000 caratteri')
    expect(conteggio('it', teacherPrimariaIt, 12345, 12345)).toBe('12.345 di 12.345 caratteri')
  })
})

describe('BottoneSblocca — che cosa manda', () => {
  it('SLOT: le coordinate dell’ora, tipo `registro`, nessun `entitaId`', async () => {
    const { onSbloccato } = monta(SLOT)
    fireEvent.click(apriEScrivi('La maestra era assente: recupero autorizzato'))

    await waitFor(() => expect(onSbloccato).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/primaria/sblocca?userId=${DIRIGENTE}`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-user-id']).toBe(DIRIGENTE)
    expect(JSON.parse(String(init.body))).toEqual({
      entitaTipo: 'registro',
      sectionId: SEZIONE,
      data: LUNEDI,
      oraLezione: 3,
      motivazione: 'La maestra era assente: recupero autorizzato',
    })
    // Chiusa la modale dopo il successo.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('VOCE: tipo e id della riga, nient’altro', async () => {
    const { onSbloccato } = monta({ modo: 'voce', entitaTipo: 'impreparato', entitaId: VOCE })
    fireEvent.click(apriEScrivi('correzione autorizzata', /^sblocca$/i))

    await waitFor(() => expect(onSbloccato).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      entitaTipo: 'impreparato',
      entitaId: VOCE,
      motivazione: 'correzione autorizzata',
    })
  })

  it('GIORNO: tipo `giorno`, classe e data, SENZA ora', async () => {
    const { onSbloccato } = monta({ modo: 'giorno', sectionId: SEZIONE, data: LUNEDI })
    fireEvent.click(apriEScrivi('uscita didattica', /sblocca il giorno/i))

    await waitFor(() => expect(onSbloccato).toHaveBeenCalledTimes(1))
    const corpo = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))
    expect(corpo).toEqual({ entitaTipo: 'giorno', sectionId: SEZIONE, data: LUNEDI, motivazione: 'uscita didattica' })
    expect('oraLezione' in corpo).toBe(false)
  })

  it('corpoSblocco: la motivazione passa com’è (la ripulitura la fa il bottone)', () => {
    expect(corpoSblocco({ modo: 'voce', entitaTipo: 'nota', entitaId: VOCE }, 'x')).toEqual({
      entitaTipo: 'nota',
      entitaId: VOCE,
      motivazione: 'x',
    })
  })

  it('senza motivazione NON parte niente: l’audit non si firma a vuoto', async () => {
    const { onSbloccato } = monta(SLOT)
    fireEvent.click(screen.getByRole('button', { name: /sblocca l’ora/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Autorizza' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Scrivi il motivo dello sblocco')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onSbloccato).not.toHaveBeenCalled()
  })

  it('una motivazione di soli spazi vale come nessuna motivazione', async () => {
    const { onSbloccato } = monta(SLOT)
    fireEvent.click(apriEScrivi('    '))

    expect(await screen.findByRole('alert')).toHaveTextContent('Scrivi il motivo dello sblocco')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onSbloccato).not.toHaveBeenCalled()
  })

  it('la motivazione si manda ripulita dagli spazi ai lati', async () => {
    const { onSbloccato } = monta(SLOT)
    fireEvent.click(apriEScrivi('  recupero  '))
    await waitFor(() => expect(onSbloccato).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).motivazione).toBe('recupero')
  })
})

describe('BottoneSblocca — quando il server dice di no', () => {
  it('un rifiuto si legge a schermo, si logga, e NON chiama `onSbloccato`', async () => {
    // RIPIEGO: la prosa del server compare SOLO perché la risposta non porta un
    // codice. Con un codice dichiarato vince il catalogo (vedi i casi più sotto).
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 403, json: async () => ({ error: 'Accesso negato: classe fuori dal tuo plesso' }) }),
    )
    const { onSbloccato } = monta(SLOT)
    fireEvent.click(apriEScrivi('recupero'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Accesso negato: classe fuori dal tuo plesso')
    expect(onSbloccato).not.toHaveBeenCalled()
    // La modale resta aperta: il motivo scritto non si perde.
    expect(screen.getByLabelText('Motivo dello sblocco')).toHaveValue('recupero')
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
    )
  })

  it('un rifiuto CON CODICE si legge dal catalogo nella lingua dell’interfaccia, non dalla prosa italiana', async () => {
    document.documentElement.lang = 'en'
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Sblocco non registrato', codice: 'SBLOCCO_NON_REGISTRATO' }),
      }),
    )
    const { onSbloccato } = monta(SLOT)
    fireEvent.click(apriEScrivi('recupero'))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Unlock not recorded. Please try again shortly.')
    expect(avviso).not.toHaveTextContent('Sblocco non registrato')
    expect(onSbloccato).not.toHaveBeenCalled()
  })

  it('409 VOCE_SENZA_LEZIONE: il testo di catalogo, non la prosa del server', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({ error: 'prosa-del-server-che-non-deve-comparire', codice: 'VOCE_SENZA_LEZIONE' }),
      }),
    )
    monta({ modo: 'voce', entitaTipo: 'allegato', entitaId: VOCE })
    fireEvent.click(apriEScrivi('recupero', /^sblocca$/i))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent('Questa voce non è più legata a nessuna lezione: non c’è niente da sbloccare.')
    expect(avviso).not.toHaveTextContent('prosa-del-server')
  })

  it('un rifiuto senza testo mostra il messaggio generico tradotto', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => { throw new SyntaxError('no json') } }),
    )
    monta(SLOT)
    fireEvent.click(apriEScrivi('recupero'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sblocco non riuscito. Riprova.')
  })

  it('la rete che cade non è un silenzio: avviso a schermo e riga di log', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
    const { onSbloccato } = monta(SLOT)
    fireEvent.click(apriEScrivi('recupero'))

    expect(await screen.findByRole('alert')).toHaveTextContent('controlla la connessione')
    expect(onSbloccato).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch' }))
  })

  it('la MOTIVAZIONE non finisce nei log del client', async () => {
    const segreto = 'ZZ-motivazione-che-non-deve-comparire-ZZ'
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Sblocco non registrato' }) }),
    )
    monta(SLOT)
    fireEvent.click(apriEScrivi(segreto))

    await screen.findByRole('alert')
    expect(h.logClient).toHaveBeenCalled()
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain(segreto)
  })

  it('un secondo tentativo riuscito cancella l’avviso del primo', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Sblocco non registrato' }) }),
    )
    const { onSbloccato } = monta(SLOT)
    fireEvent.click(apriEScrivi('recupero'))
    await screen.findByRole('alert')

    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Autorizza' }))

    await waitFor(() => expect(onSbloccato).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
