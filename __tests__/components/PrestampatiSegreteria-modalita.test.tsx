import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import itPrestampati from '../../messages/it/prestampatiSegreteria.json'
import enPrestampati from '../../messages/en/prestampatiSegreteria.json'

/**
 * IL BANCO DEI PRESTAMPATI — le TRE MODALITÀ sui moduli di famiglia, dalla parte dello
 * schermo.
 *
 * 🔴 LA COSA CHE QUESTO FILE ESISTE PER TENERE FERMA: **il pannello non promette una firma
 * elettronica che non ci sarà.** Il catalogo ha una riga che descrive il MODELLO — «Firma la
 * famiglia, con un codice usa e getta» — ed è vera del modulo firmato nell'app. Su una copia
 * vuota e su un modulo tornato di carta quella riga prometterebbe una firma che non avviene:
 * è, in piccolo, lo stesso difetto che il documento non deve avere, e a schermo si vede
 * prima che sul foglio.
 *
 * E le altre tre:
 *
 *  · **la modalità viene PRIMA dei campi.** Sceglierla dopo significherebbe far compilare
 *    otto risposte per poi buttarle via — la copia firmata e quella vuota non ne chiedono
 *    nessuna;
 *  · **i campi obbligatori non bloccano un foglio che deve uscire in bianco.** La scheda
 *    sanitaria ne pretende otto: pretenderli sulla copia vuota renderebbe impossibile
 *    stampare proprio il modulo da consegnare a chi non usa l'app;
 *  · **il MOTIVO lo traduce il pannello.** Il 422 «copia firmata assente» porta un enumerato
 *    e una prosa italiana: a schermo deve arrivare la frase del catalogo, non quella del
 *    server, o l'interfaccia inglese mostra italiano.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl')
  const prestampatiSegreteria = (await import('../../messages/it/prestampatiSegreteria.json'))
    .default
  const shared = (await import('../../messages/it/shared.json')).default
  const cataloghi = { prestampatiSegreteria, shared }
  // Un `t` solo per namespace: il pannello lo mette fra le dipendenze di un `useCallback`,
  // e un'identità nuova a ogni render farebbe ricaricare la scheda all'infinito.
  const memoria = new Map<string, unknown>()
  const useTranslations = (ns?: string) => {
    const chiave = ns ?? 'prestampatiSegreteria'
    const gia = memoria.get(chiave)
    if (gia) return gia
    const tradotto = createTranslator({
      locale: 'it',
      messages: cataloghi as never,
      namespace: chiave as never,
    }) as unknown as (k: string, valori?: Record<string, unknown>) => string
    const t = (k: string, valori?: Record<string, unknown>) => tradotto(k, valori)
    const conForme = Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
    memoria.set(chiave, conForme)
    return conForme
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

const SEDE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: SEDE, nome: 'Kidville Giugliano' }],
    errore: false,
    selezionate: [],
    effettive: [SEDE],
    sedeCorrente: SEDE,
    reFetchKey: SEDE,
    epocaSede: 0,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
}))

const SLUG = 'scheda_sanitaria'
const NOME_MODELLO = itPrestampati.modelli.schedaSanitaria

/** Un modulo di famiglia: le tre modalità arrivano dal SERVER, non le deduce il pannello. */
const MODELLO = {
  slug: SLUG,
  etichetta: 'Scheda sanitaria',
  soggetto: 'alunno',
  firma: 'otp_genitore',
  protocollo: 'nessuno',
  archiviazione: 'student_documents',
  generabile: true,
  modalita: ['copia_firmata', 'copia_vuota', 'su_carta'],
}

/** Un SECONDO modulo di famiglia: serve a provare che la modalità non attraversa i modelli. */
const SLUG_DUE = 'delega_ritiro'
const NOME_MODELLO_DUE = itPrestampati.modelli.delegaRitiro
const MODELLO_DUE = { ...MODELLO, slug: SLUG_DUE, etichetta: 'Delega al ritiro' }

const CLASSI = [{ id: 'cl-1', name: 'Sezione Gialla' }]
const ALUNNI = [{ id: 'al-1', nome: 'Prova', cognome: 'Iscritta', stato: 'iscritto' }]

/** Un campo obbligatorio: è quanto basta perché «non blocca la copia vuota» si misuri. */
const CAMPO = {
  nome: 'pediatraNome',
  etichetta: 'Pediatra — nome e cognome',
  tipo: 'testo',
  obbligatorio: true,
}

function scheda(slug = SLUG) {
  return {
    success: true,
    data: {
      modello: { ...(slug === SLUG_DUE ? MODELLO_DUE : MODELLO), campi: [CAMPO] },
      prefill: {
        soggetto: 'alunno',
        alunnoId: 'al-1',
        scuolaId: SEDE,
        sezioneId: 'cl-1',
        legaleRappresentante: 'Legale Rappresentante',
        dati: {
          alunno: {
            nome: 'Prova',
            cognome: 'Iscritta',
            dataNascita: '2021-03-04',
            // Un codice fiscale palesemente finto: il repository è pubblico.
            codiceFiscale: 'AAAAAA00A00A000A',
            sezione: 'Sezione Gialla',
          },
          annoScolastico: '2026/2027',
        },
      },
    },
  }
}

const fetchMock = vi.fn()

function ok(corpo: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => corpo })
}

function rispostaPdf(intestazioni: Record<string, string>) {
  const mappa = Object.fromEntries(
    Object.entries(intestazioni).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return Promise.resolve({
    ok: true,
    status: 201,
    headers: { get: (nome: string) => mappa[nome.toLowerCase()] ?? null },
    blob: async () => new Blob(['%PDF-finto'], { type: 'application/pdf' }),
    json: async () => null,
  })
}

function rispostaPredefinita(url: string) {
  const u = String(url)
  if (u.startsWith('/api/admin/sections')) return CLASSI
  if (u.startsWith('/api/admin/students')) return ALUNNI
  if (u.includes('alunnoId=')) return scheda(u.includes(`modello=${SLUG_DUE}`) ? SLUG_DUE : SLUG)
  return { success: true, data: { modelli: [MODELLO, MODELLO_DUE] } }
}

/**
 * Il testo dell'intera schermata.
 *
 * La riga della firma è spezzata fra un `<span>` e il testo che segue — «Firma» ` — `
 * «Nessuna firma elettronica…» — e `getByText` cerca dentro un nodo solo: chiederglielo
 * darebbe rosso su una frase che a schermo c'è, scritta esattamente così.
 */
const testoDiTutto = () => document.body.textContent ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => ok(rispostaPredefinita(String(url))))
  vi.stubGlobal('fetch', fetchMock)
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:prestampato'),
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

import { PrestampatiSegreteria } from '@/components/features/prestampati/PrestampatiSegreteria'

/** Il percorso fino alla scheda del modello: classe → bambino → modello. */
async function finoAlModello() {
  const utils = render(<PrestampatiSegreteria />)
  fireEvent.change(await screen.findByLabelText(itPrestampati.scegliClasse), {
    target: { value: 'cl-1' },
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Iscritta Prova' }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(NOME_MODELLO) }))
  await waitFor(() => expect(screen.getByText(itPrestampati.modalitaTitolo)).toBeInTheDocument())
  return utils
}

const corpoDelPost = () => {
  const chiamata = fetchMock.mock.calls.find(
    (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'POST',
  )
  return JSON.parse(String((chiamata?.[1] as RequestInit).body)) as Record<string, unknown>
}

describe('PrestampatiSegreteria — le tre modalità', () => {
  it('le tre scelte ci sono, e finché non se ne fa una non si compila niente', async () => {
    await finoAlModello()

    expect(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaCopiaFirmata) })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaCopiaVuota) })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaSuCarta) })).toBeInTheDocument()

    // Nessun campo e nessun comando: la modalità decide cosa viene dopo.
    expect(screen.getByText(itPrestampati.modalitaDaScegliere)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Pediatra/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itPrestampati.genera })).not.toBeInTheDocument()
  })

  it('🔴 la copia vuota NON promette una firma elettronica', async () => {
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaCopiaVuota) }))

    expect(testoDiTutto()).toContain(itPrestampati.modalitaFirmaCopiaVuota)
    // La riga che descrive il MODELLO non deve comparire: il foglio che sta per uscire non
    // si firma con un codice usa e getta, si firma a penna.
    expect(testoDiTutto()).not.toContain(itPrestampati.firmaGenitore)
  })

  it('🔴 nemmeno il modulo tornato su carta la promette', async () => {
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaSuCarta) }))

    expect(testoDiTutto()).toContain(itPrestampati.modalitaFirmaSuCarta)
    expect(testoDiTutto()).not.toContain(itPrestampati.firmaGenitore)
  })

  it('la copia firmata sì, e lo dice: quella firma c’è stata davvero', async () => {
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaCopiaFirmata) }))

    expect(testoDiTutto()).toContain(itPrestampati.modalitaFirmaCopiaFirmata)
  })

  it('copia vuota: nessun campo da compilare, e i campi obbligatori non fermano il foglio', async () => {
    // La scheda sanitaria pretende il pediatra. Su questo foglio nessuno risponde niente —
    // lo compilerà la famiglia a penna — e pretendere una risposta renderebbe impossibile
    // stampare proprio il modulo che serve a chi non usa l'app.
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaCopiaVuota) }))

    expect(screen.queryByLabelText(/Pediatra/)).not.toBeInTheDocument()
    expect(screen.getByText(itPrestampati.modalitaSenzaCampiVuota)).toBeInTheDocument()

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return rispostaPdf({
          'X-Prestampato-Modalita': 'copia_vuota',
          'X-Prestampato-Archiviato': 'non-previsto',
          'Content-Disposition': 'attachment; filename="Scheda.pdf"',
        })
      }
      return ok(rispostaPredefinita(String(url)))
    })
    fireEvent.click(screen.getByRole('button', { name: itPrestampati.genera }))

    await screen.findByText(itPrestampati.confermaGenerato)
    expect(corpoDelPost()).toMatchObject({ modello: SLUG, modalita: 'copia_vuota', risposte: {} })
    // E il pannello non dichiara un'archiviazione che non c'è stata.
    expect(screen.getByText(itPrestampati.archiviazioneNonPrevista)).toBeInTheDocument()
  })

  it('modulo tornato su carta: chiede i campi E la data di consegna, e li manda entrambi', async () => {
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaSuCarta) }))

    fireEvent.change(await screen.findByLabelText(/Pediatra/), {
      target: { value: 'Rossi Dottoressa Inventata' },
    })
    fireEvent.change(screen.getByLabelText(itPrestampati.modalitaConsegnatoIl), {
      target: { value: '10/08/2026' },
    })

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return rispostaPdf({
          'X-Prestampato-Modalita': 'su_carta',
          'X-Prestampato-Archiviato': 'archiviato',
          'Content-Disposition': 'attachment; filename="Scheda.pdf"',
        })
      }
      return ok(rispostaPredefinita(String(url)))
    })
    fireEvent.click(screen.getByRole('button', { name: itPrestampati.genera }))

    await screen.findByText(itPrestampati.confermaGenerato)
    expect(corpoDelPost()).toMatchObject({
      modalita: 'su_carta',
      consegnatoIl: '2026-08-10',
      risposte: { pediatraNome: 'Rossi Dottoressa Inventata' },
    })
  })

  it('modulo tornato su carta senza la data: si ferma prima di partire, e lo dice sul campo', async () => {
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaSuCarta) }))
    fireEvent.change(await screen.findByLabelText(/Pediatra/), {
      target: { value: 'Rossi Dottoressa Inventata' },
    })

    fireEvent.click(screen.getByRole('button', { name: itPrestampati.genera }))

    // Nessun POST: la data è il dato che la dicitura STAMPA sul foglio.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'POST'),
      ).toBe(false),
    )
    expect(screen.getAllByText(itPrestampati.campoObbligatorio).length).toBeGreaterThan(0)
  })

  it('copia firmata assente: a schermo la frase del CATALOGO, non la prosa del server', async () => {
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaCopiaFirmata) }))

    const PROSA_DEL_SERVER = 'Nel fascicolo di questo bambino non c’è una copia firmata.'
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return ok(
          {
            error: PROSA_DEL_SERVER,
            codice: 'PRESTAMPATO_DATI_MANCANTI',
            motivo: 'copia_firmata_assente',
          },
          422,
        )
      }
      return ok(rispostaPredefinita(String(url)))
    })
    fireEvent.click(screen.getByRole('button', { name: itPrestampati.genera }))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itPrestampati.motivoCopiaFirmataAssente)
    expect(screen.queryByText(PROSA_DEL_SERVER)).not.toBeInTheDocument()
    expect(screen.queryByText(itPrestampati.confermaGenerato)).not.toBeInTheDocument()
  })

  it('🔴 il rifiuto «copia non elettronica» NON dichiara un originale di carta che nessuno ha visto', async () => {
    // ⚠️ FINO AL 2026-08-16 LA FRASE CHIUDEVA CON «L'originale firmato è quello di carta,
    // agli atti.» La route quel fatto non lo sa: sa soltanto che nessuna impronta ha
    // combaciato, e il suo stesso commento elenca i casi possibili — trascrizioni `su_carta`,
    // scansioni caricate a mano, fogli rigenerati. Negli ultimi due un originale di carta
    // agli atti **non esiste**.
    //
    // Era, in piccolo, il difetto che tutta questa catena esiste per impedire: un pannello
    // che dichiara alla segreteria come avvenuto un fatto che nessuno ha misurato.
    const VIETATE = ['originale firmato', 'agli atti', 'signed original', 'on file']
    for (const [lingua, frase] of [
      ['it', itPrestampati.motivoCopiaFirmataNonElettronica],
      ['en', enPrestampati.motivoCopiaFirmataNonElettronica],
      ['it', itPrestampati.motivoCopiaFirmataNonEsaminata],
      ['en', enPrestampati.motivoCopiaFirmataNonEsaminata],
    ] as const) {
      expect(frase, `${lingua} — la frase manca dal catalogo`).toBeTruthy()
      for (const vietata of VIETATE) {
        expect(frase.toLowerCase(), `${lingua} — «${vietata}»`).not.toContain(vietata)
      }
    }

    // E il presidio simmetrico: la frase deve comunque dire che QUALCOSA nel fascicolo c'è —
    // altrimenti non si distinguerebbe da `copia_firmata_assente`, e la segreteria andrebbe a
    // far firmare di nuovo un modulo che la famiglia ha già firmato.
    expect(itPrestampati.motivoCopiaFirmataNonElettronica).toContain('ci sono documenti di questo tipo')
    // Quella «esaminata» dichiara il limite invece di nasconderlo.
    expect(itPrestampati.motivoCopiaFirmataNonEsaminata).toContain('fra quelli esaminati')
  })

  it('il pannello traduce anche il rifiuto «non li ho guardati tutti»', async () => {
    // Senza la chiave nella tabella dei motivi, il pannello mostrerebbe la prosa del server:
    // il motivo esiste proprio perché a tradurlo sia il catalogo.
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaCopiaFirmata) }))

    const PROSA_DEL_SERVER = 'Nel fascicolo ci sono più documenti di questo tipo di quanti…'
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return ok(
          {
            error: PROSA_DEL_SERVER,
            codice: 'PRESTAMPATO_DATI_MANCANTI',
            motivo: 'copia_firmata_non_esaminata',
          },
          422,
        )
      }
      return ok(rispostaPredefinita(String(url)))
    })
    fireEvent.click(screen.getByRole('button', { name: itPrestampati.genera }))

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itPrestampati.motivoCopiaFirmataNonEsaminata)
    expect(screen.queryByText(PROSA_DEL_SERVER)).not.toBeInTheDocument()
  })

  it('passando a un ALTRO modulo la modalità di prima non si porta dietro niente', async () => {
    // Senza la chiave, un «modulo tornato su carta» resterebbe scelto sul modulo dopo — e con
    // lui la data di una consegna che riguardava un altro foglio, stampata su questo.
    await finoAlModello()
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(itPrestampati.modalitaSuCarta) }))
    fireEvent.change(screen.getByLabelText(itPrestampati.modalitaConsegnatoIl), {
      target: { value: '10/08/2026' },
    })
    expect(screen.getByLabelText(itPrestampati.modalitaConsegnatoIl)).toHaveValue('10/08/2026')

    fireEvent.click(screen.getByRole('button', { name: new RegExp(NOME_MODELLO_DUE) }))

    await waitFor(() =>
      expect(screen.getByText(itPrestampati.modalitaDaScegliere)).toBeInTheDocument(),
    )
    expect(screen.queryByLabelText(itPrestampati.modalitaConsegnatoIl)).not.toBeInTheDocument()
  })
})
