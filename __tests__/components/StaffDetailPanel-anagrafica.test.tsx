import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import fs from 'node:fs'
import path from 'node:path'

import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'

expect.extend(toHaveNoViolations)

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LA SCHEDA STAFF, DA CINQUE CAMPI A UN FASCICOLO                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Questo file sorveglia CINQUE difetti reali, e ognuno è qui per una ragione che
 * si può raccontare senza guardare il codice.
 *
 *  1. LO STATO DEL DOCUMENTO SI VEDE SENZA SCORRERE. Il fatto nuovo di tutto il
 *     modulo è che la carta d'identità di una persona in servizio può essere
 *     scaduta: è ciò per cui esistono la colonna `document_expiry`, il cron
 *     notturno e le quattro soglie. Se quel fatto vivesse in fondo al terzo tab,
 *     la funzionalità sarebbe stata costruita e non consegnata. Il badge sta in
 *     testata, porta ICONA E TESTO — il colore da solo non informa (WCAG 1.4.1) —
 *     e legge le STESSE funzioni del cron: un badge che dicesse «in regola»
 *     mentre di notte parte l'email «scade fra 30 giorni» sarebbe la peggiore
 *     delle due risposte, perché è quella che si guarda per prima.
 *
 *  2. ⚠️ IL TEMPO È CONGELATO, E NON È PRUDENZA. Un test che scrivesse date fisse
 *     nel futuro diventerebbe rosso DA SOLO il giorno in cui quelle date passano,
 *     senza che nessuno abbia toccato una riga: è successo il 12/08 a
 *     `parent-attendance-elenco`, rosso su `main` per il calendario. Qui `oggi` è
 *     `2026-08-12` e ci resta.
 *
 *  3. LA RIGA VUOTA NON SI OMETTE. «Non indicato» in grigio è più lavoro del
 *     nulla, ed è il punto: l'ASSENZA di un dato è la notizia. È la misura già
 *     pagata su questo repo — 18 alunni su 33 e 27 genitori su 50 senza codice
 *     fiscale — e una scheda che nasconde le righe vuote sembra completa a
 *     chiunque non abbia in mente l'elenco dei 32 campi, cioè a chiunque.
 *
 *  4. LO STATO VUOTO È L'AZIONE. Misurato l'11/08/2026: dieci insegnanti con un
 *     account e ZERO anagrafiche. Cioè la schermata «non c'è niente» è la PRIMA
 *     che la segreteria vedrà, dieci volte su dieci. Deve offrire il link del
 *     modulo, non essere un vicolo cieco. E NON deve comparire quando la lettura
 *     FALLISCE: mandare a richiedere dati che la persona ha già consegnato è il
 *     modo peggiore in cui questo pannello possa mentire.
 *
 *  5. IL TAB «INCARICO» NON REGREDISCE. I cinque campi di prima — email, ruolo,
 *     sede, gradi, classi — e le due azioni della Direzione restano dov'erano.
 *     Un rifacimento che perde per strada «Rigenera credenziali» non si vede in
 *     nessun typecheck.
 */

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u-admin', role: ruoloCorrente, ready: true }),
}))

/**
 * ⚠️ QUI next-intl RENDE DAVVERO L'ICU, e il mock globale no.
 *
 * `test/setup.ts` risolve la chiave e restituisce la stringa GREZZA: comodo per
 * il 99% dei test, inutilizzabile per questo. Il badge della scadenza è un
 * `plural` ICU, e con il mock globale a schermo comparirebbe
 * `{giorni, plural, =0 {…}}` — cioè le asserzioni sarebbero verdi su un testo
 * che nessuno leggerà mai, ed è la stessa trappola che il lock dei plurali
 * descrive («nessun unit test può accorgersene»). Qui si passa dal formattatore
 * vero (`use-intl`, la libreria che sta sotto next-intl) sui cataloghi VERI:
 * quello che il test legge è quello che legge la segreteria.
 */
vi.mock('next-intl', async () => {
  const { createTranslator } = await import('use-intl')
  const cataloghi: Record<Lingua, Record<string, Record<string, string>>> = {
    it: {
      adminStudents: (await import('../../messages/it/adminStudents.json')).default as Record<string, string>,
      shared: (await import('../../messages/it/shared.json')).default as Record<string, string>,
      etichette: (await import('../../messages/it/etichette.json')).default as Record<string, string>,
    },
    // ⚠️ IL CATALOGO INGLESE C'È PERCHÉ IL PANNELLO SI DEVE POTER MISURARE IN
    // INGLESE. Fino al giro 4 questo mock conosceva solo l'italiano, e con un
    // mock monolingue la domanda «che cosa legge chi ha l'interfaccia in
    // inglese?» non era formulabile: le 27 righe italiane dentro un guscio
    // inglese erano invisibili a QUALUNQUE test di questo file. Un mock che
    // conosce una lingua sola non è comodo, è cieco per metà.
    en: {
      adminStudents: (await import('../../messages/en/adminStudents.json')).default as Record<string, string>,
      shared: (await import('../../messages/en/shared.json')).default as Record<string, string>,
      etichette: (await import('../../messages/en/etichette.json')).default as Record<string, string>,
    },
  }
  const useTranslations = (ns?: string) => {
    const gruppo = (ns && cataloghi[linguaCorrente][ns]) || undefined
    const vero = gruppo && ns
      ? (createTranslator({ locale: linguaCorrente, messages: { [ns]: gruppo } as never, namespace: ns as never }) as unknown as (k: string, v?: Record<string, unknown>) => string)
      : null
    const t = (key: string, valori?: Record<string, unknown>) =>
      vero && gruppo && key in gruppo ? vero(key, valori) : (ns ? `${ns}.${key}` : key)
    return Object.assign(t, {
      rich: t,
      markup: t,
      raw: t,
      has: (k: string) => Boolean(gruppo && k in gruppo),
    })
  }
  return {
    useTranslations,
    useLocale: () => linguaCorrente,
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

type Lingua = 'it' | 'en'

let ruoloCorrente = 'admin'
/** La lingua dell'interfaccia. Si rimette a `it` in `beforeEach`. */
let linguaCorrente: Lingua = 'it'

/** `dataCivile()` in Europe/Rome è il 2026-08-12: le 09:00 UTC sono le 11:00. */
const ADESSO = new Date('2026-08-12T09:00:00Z')

const STAFF_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

const RISPOSTA_STAFF = {
  success: true,
  data: [
    {
      id: STAFF_ID,
      nome: 'Maria',
      cognome: 'Bianchi',
      email: 'maria.bianchi@example.test',
      ruolo: 'educator',
      scuola_id: 'sc-giugliano',
      gradi: ['infanzia'],
    },
  ],
  schools: [{ id: 'sc-giugliano', nome: 'Kidville Giugliano' }],
  sections: [{ id: 'sez-1', name: '3 ANNI', scuola_id: 'sc-giugliano' }],
  assegnazioni: [{ utente_id: STAFF_ID, section_id: 'sez-1' }],
}

/**
 * Un'anagrafica PARZIALE, e di proposito: `birth_place`, tutto il domicilio, il
 * contatto d'emergenza e il dettaglio del titolo sono vuoti. È la forma che
 * avranno quasi tutte — il modulo rende facoltativi undici campi su trentadue —
 * ed è l'unica su cui la regola «la riga non si omette» si può misurare.
 */
function anagraficaCompleta(sovrascritture: Record<string, unknown> = {}) {
  return {
    utente_id: STAFF_ID,
    gender: 'F',
    birth_date: '1988-04-23',
    birth_place: null,
    birth_province: 'NA',
    codice_belfiore_nascita: 'H501',
    birth_nation: 'Italia',
    fiscal_code: 'BNCMRA88D63H501X',
    citizenship: 'Italiana',
    address: 'Via Roma',
    residence_street_number: '12',
    residence_city: 'Giugliano in Campania',
    residence_province: 'NA',
    zip_code: '80014',
    domicilio_address: null,
    domicilio_street_number: null,
    domicilio_city: null,
    domicilio_province: null,
    domicilio_zip_code: null,
    document_type: 'CI',
    document_number: 'AB1234567',
    document_expiry: '2030-01-31',
    // ⚠️ DUE FACCE DAL 12/08/2026. Qui c'era `documento_path`, e quella colonna non
    // esiste più: la migrazione `20260812194501` l'ha rinominata in
    // `documento_fronte_path` e ne ha aggiunta una seconda. Un banco di prova che
    // continua a seminare il nome vecchio non diventa rosso — `valoreTesto` su una
    // chiave assente restituisce `null` — diventa VERDE su una scheda che dichiara
    // «Nessuna scansione allegata» a tutti.
    documento_fronte_path: 'documenti/aaaaaaaa-0000-4000-8000-00000000000a/fronte.pdf',
    documento_retro_path: 'documenti/aaaaaaaa-0000-4000-8000-00000000000a/retro.pdf',
    titolo_studio: 'laurea_magistrale',
    titolo_dettaglio: null,
    emergenza_nome: null,
    emergenza_telefono: null,
    emergenza_relazione: null,
    cessato_il: null,
    aggiornata_il: '2026-08-11T10:00:00Z',
    ...sovrascritture,
  }
}

const fetchMock = vi.fn()

/** Una finta scheda del browser: serve per il collaudo di «Apri la scansione». */
function finestraFinta() {
  return { closed: false, opener: {}, close: vi.fn(), location: { replace: vi.fn() } }
}
type FinestraFinta = ReturnType<typeof finestraFinta>
let finestraAperta: FinestraFinta | null = null
const openMock = vi.fn((): FinestraFinta | null => {
  finestraAperta = finestraFinta()
  return finestraAperta
})

const scriviAppunti = vi.fn(async () => {})

function ok(corpo: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => corpo })
}

/**
 * Il finto server. `anagrafica` pilota la sola risposta di
 * `/api/admin/anagrafica-personale`: `undefined` = 404 (nessuna anagrafica),
 * `'errore'` = 500, altrimenti la proiezione.
 */
let rispostaAnagrafica: Record<string, unknown> | undefined | 'errore' | 'mai' = undefined

function serverPredefinito(url: string) {
  const u = String(url)
  if (u.includes('/api/admin/anagrafica-personale')) {
    if (u.includes('doc=')) return ok({ url: 'https://storage.example.test/firmata' })
    if (rispostaAnagrafica === 'mai') return new Promise<never>(() => {})
    if (rispostaAnagrafica === 'errore') return ok({ success: false, error: 'x' }, 500)
    if (rispostaAnagrafica === undefined) return ok({ success: false, error: 'non trovata' }, 404)
    return ok({
      success: true,
      data: {
        // ⚠️ `cellulare`, che è il nome VERO della colonna su `utenti` (misurato
        // sullo schema di produzione): nel modulo lo stesso dato si chiama
        // `telefono`, ed è il punto in cui un nome scritto d'istinto legge
        // `undefined` per sempre senza che niente diventi rosso.
        utente: { id: STAFF_ID, nome: 'Maria', cognome: 'Bianchi', ruolo: 'educator', cellulare: '+39 333 1234567' },
        anagrafica: rispostaAnagrafica,
      },
    })
  }
  /**
   * ⚠️ LA TENDINA DELLA SEDE NON SI RIEMPIE PIÙ DA `RISPOSTA_STAFF.schools`.
   *
   * Dal 2026-09-04 le destinazioni le decide `GET /api/admin/sedi/destinazioni`:
   * `j.schools` porta le sedi in cui l'utente LAVORA, e per un trasferimento
   * quello è per definizione l'insieme sbagliato — la sede d'arrivo è quella in
   * cui la persona NON è ancora. Senza questa riga il finto server risponde
   * `{ success: true }` senza `data`, il pannello legge un GUASTO (che è la
   * risposta giusta a un corpo illeggibile: «vuoto» e «rotto» non sono la stessa
   * cosa) e la tendina non compare affatto — non un difetto della scheda, un
   * buco di questo mock.
   */
  if (u.includes('/api/admin/sedi/destinazioni')) {
    return ok({
      success: true,
      // Due sedi: senza una destinazione DIVERSA da quella attuale la scheda
      // spiegherebbe che non c'è dove spostare, invece di offrire la tendina.
      data: [
        { id: 'sc-giugliano', nome: 'Kidville Giugliano' },
        { id: 'sc-aversa', nome: 'Kidville Aversa' },
      ],
      motivo: 'ok',
    })
  }
  if (u.includes('/api/admin/staff')) return ok(RISPOSTA_STAFF)
  return ok({ success: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
  ruoloCorrente = 'admin'
  linguaCorrente = 'it'
  rispostaAnagrafica = undefined
  finestraAperta = null
  fetchMock.mockImplementation((url: string) => serverPredefinito(url))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('open', openMock)
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('confirm', vi.fn(() => true))
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: scriviAppunti },
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

import { StaffDetailPanel, GRUPPI_ANAGRAFICA_PERSONALE, CAMPI_MOSTRATI_FUORI_DAI_GRUPPI, RIGHE_FUSE, statoDocumento, statoScansioni } from '@/components/features/admin/StaffDetailPanel'
import { logClient } from '@/lib/logging/client'

/** Monta la scheda e aspetta che la testata ci sia. */
/**
 * `ruoloBersaglio` serve da quando il piede azioni dipende da CHI è aperto nella
 * scheda e non solo da chi guarda: la Segreteria rigenera le credenziali di una
 * maestra ma non quelle della Direzione.
 */
async function montaScheda(opzioni?: { ruoloBersaglio?: string }) {
  if (opzioni?.ruoloBersaglio) {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/api/admin/staff') && !u.includes('anagrafica')) {
        return ok({ ...RISPOSTA_STAFF, data: [{ ...RISPOSTA_STAFF.data[0], ruolo: opzioni.ruoloBersaglio }] })
      }
      return serverPredefinito(url)
    })
  }
  const utils = render(<StaffDetailPanel staffId={STAFF_ID} onClose={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('heading', { name: /Bianchi Maria/i })).toBeInTheDocument())
  return utils
}

/** Apre un tab per nome esatto e restituisce il pannello aggiornato. */
async function apriTab(nome: string) {
  fireEvent.click(screen.getByRole('button', { name: nome }))
  await waitFor(() => expect(screen.getByRole('button', { name: nome })).toHaveAttribute('aria-pressed', 'true'))
}

/**
 * I comandi di UNA faccia. Il nome accessibile porta la faccia in coda (`sr-only`),
 * che è ciò che rende distinguibili due bottoni con la stessa etichetta visibile.
 */
const apriFaccia = (faccia: 'Fronte' | 'Retro') =>
  screen.getByRole('button', { name: new RegExp(`Apri la scansione\\s+${faccia}`) })
/**
 * Il controllo di caricamento è una `<label>` con dentro l'`<input type="file">`,
 * quindi lo si trova dal NOME del campo — che è ciò che uno screen reader annuncia,
 * ed è anche il modo di verificare che quel nome esista davvero.
 */
const caricaFaccia = (faccia: 'Fronte' | 'Retro') =>
  screen.getByLabelText(new RegExp(`Carica la scansione\\s+${faccia}`)).closest('label') as HTMLLabelElement
const sostituisciFaccia = (faccia: 'Fronte' | 'Retro') =>
  screen.getByRole('button', { name: new RegExp(`Sostituisci la scansione\\s+${faccia}`) })

/** L'`<input type="file">` dentro un controllo di caricamento. */
const campoFile = (dentro: HTMLElement) => dentro.querySelector('input[type="file"]') as HTMLInputElement

/** Sceglie un file su un controllo di caricamento, come farebbe il browser. */
function scegli(controllo: HTMLElement, file: File) {
  const input = campoFile(controllo)
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

const fileFinto = (nome = 'ci-fronte.jpg', tipo = 'image/jpeg', byte = 64) =>
  new File([new Uint8Array(byte)], nome, { type: tipo })

describe('scheda staff · lo stato del documento in TESTATA', () => {
  it('documento scaduto: badge «Scaduto», e si vede senza aprire nessun tab', async () => {
    rispostaAnagrafica = anagraficaCompleta({ document_expiry: '2026-08-11' })
    await montaScheda()
    await waitFor(() => expect(screen.getByText('Scaduto')).toBeInTheDocument())
    // In testata, non dentro un tab: il tab attivo resta «Incarico».
    expect(screen.getByRole('button', { name: 'Incarico' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('documento in scadenza: il badge CONTA i giorni, e il singolare non è «1 giorni»', async () => {
    rispostaAnagrafica = anagraficaCompleta({ document_expiry: '2026-09-11' })
    await montaScheda()
    // 12 agosto → 11 settembre = 30 giorni: la soglia dei 30 del cron.
    await waitFor(() => expect(screen.getByText('Scade fra 30 giorni')).toBeInTheDocument())
  })

  it('scade domani: la forma plurale ICU evita «Scade fra 1 giorni»', async () => {
    rispostaAnagrafica = anagraficaCompleta({ document_expiry: '2026-08-13' })
    await montaScheda()
    await waitFor(() => expect(screen.getByText('Scade domani')).toBeInTheDocument())
    expect(screen.queryByText(/Scade fra 1 giorni/)).not.toBeInTheDocument()
  })

  it('documento valido: badge «In regola»', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await waitFor(() => expect(screen.getByText('In regola')).toBeInTheDocument())
  })

  it('nessuna anagrafica: badge «Documento mancante», non un badge verde', async () => {
    rispostaAnagrafica = undefined // 404
    await montaScheda()
    await waitFor(() => expect(screen.getByText('Documento mancante')).toBeInTheDocument())
    expect(screen.queryByText('In regola')).not.toBeInTheDocument()
  })

  it('finché la lettura è in volo NON si disegna nessun badge: un verde che diventa rosso è peggio dell’attesa', async () => {
    rispostaAnagrafica = 'mai'
    await montaScheda()
    expect(screen.queryByText('In regola')).not.toBeInTheDocument()
    expect(screen.queryByText('Documento mancante')).not.toBeInTheDocument()
    expect(screen.queryByText('Scaduto')).not.toBeInTheDocument()
  })

  it('il badge porta un TESTO oltre all’icona (il colore da solo non informa)', async () => {
    rispostaAnagrafica = anagraficaCompleta({ document_expiry: '2026-08-11' })
    await montaScheda()
    const badge = await waitFor(() => document.querySelector('[data-stato-documento="scaduto"]'))
    // Il nome parlato dice anche DI CHE COSA: «scaduto» accanto a un cognome,
    // da solo, non si capisce.
    expect(badge?.textContent).toContain('Documento d’identità:')
    expect(badge?.textContent).toContain('Scaduto')
  })
})

describe('scheda staff · il conteggio dei giorni ha una forma singolare, in ENTRAMBE le lingue', () => {
  /**
   * Perché qui e non nel lock dei plurali: il riconoscitore di forma di
   * `messaggi-plurali-e-glossario` SALTA le stringhe che aprono un blocco
   * `plural` — giustamente, perché il caso è già gestito — e la lista `CONTATORI`
   * è a mano. Un ICU scritto male («other {Scade fra # giorni}» senza il ramo
   * `=1`) passerebbe entrambi i controlli e produrrebbe «Scade fra 1 giorni» in
   * italiano, cioè esattamente il difetto per cui quel lock è nato. Le due lingue
   * si rendono qui, sul catalogo vero.
   */
  it.each([
    ['it', 0, 'Scade oggi'],
    ['it', 1, 'Scade domani'],
    ['it', 2, 'Scade fra 2 giorni'],
    ['en', 0, 'Expires today'],
    ['en', 1, 'Expires tomorrow'],
    ['en', 2, 'Expires in 2 days'],
  ] as const)('%s con %i giorni → «%s»', async (lingua, giorni, atteso) => {
    const { createTranslator } = await import('use-intl')
    const catalogo = lingua === 'it'
      ? (await import('../../messages/it/adminStudents.json')).default
      : (await import('../../messages/en/adminStudents.json')).default
    const t = createTranslator({
      locale: lingua,
      messages: { adminStudents: catalogo } as never,
      namespace: 'adminStudents' as never,
      onError: (e) => { throw e },
    }) as unknown as (k: string, v: Record<string, unknown>) => string
    expect(t('staffDocInScadenza', { giorni })).toBe(atteso)
  })
})

describe('scheda staff · la funzione pura che decide lo stato', () => {
  // Le funzioni sono già collaudate in `documenti-scadenza.test.ts`: qui si
  // misurano i due confini che il PANNELLO aggiunge — la data illeggibile e la
  // cessazione — perché sono le due decisioni prese in questo file e in nessun
  // altro.
  it('scade OGGI non è «scaduto»: il documento è valido fino al giorno di scadenza compreso', () => {
    expect(statoDocumento('2026-08-12', null, '2026-08-12').stato).toBe('inScadenza')
    expect(statoDocumento('2026-08-11', null, '2026-08-12').stato).toBe('scaduto')
  })

  it('una data illeggibile è «mancante», mai «in regola»', () => {
    expect(statoDocumento('2026-02-30', null, '2026-08-12').stato).toBe('mancante')
    expect(statoDocumento('domani', null, '2026-08-12').stato).toBe('mancante')
  })

  it('rapporto cessato: il documento scaduto di chi non lavora più qui non è un allarme', () => {
    expect(statoDocumento('2020-01-01', '2026-07-31', '2026-08-12').stato).toBe('cessato')
    // Una cessazione FUTURA (preavviso registrato) lascia la persona in servizio.
    expect(statoDocumento('2020-01-01', '2026-09-30', '2026-08-12').stato).toBe('scaduto')
  })
})

describe('scheda staff · il tab Anagrafica è in SOLA LETTURA', () => {
  it('non contiene nessun campo compilabile: la correzione passa dall’approvazione', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriTab('Anagrafica')
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0)
    expect(screen.getByText(/Sola lettura/)).toBeInTheDocument()
  })

  it('mostra i valori con la loro ETICHETTA, non con il codice di colonna', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Anagrafica')
    // `F` → «Femmina», `CI` → «Carta d’identità», `laurea_magistrale` → il titolo.
    expect(screen.getByText('Femmina')).toBeInTheDocument()
    expect(screen.getByText('Carta d’identità')).toBeInTheDocument()
    expect(screen.getByText('Laurea magistrale')).toBeInTheDocument()
    expect(screen.queryByText('laurea_magistrale')).not.toBeInTheDocument()
    // Le date si leggono, non si trascrivono da Postgres.
    expect(screen.getByText('23 aprile 1988')).toBeInTheDocument()
    expect(screen.queryByText('1988-04-23')).not.toBeInTheDocument()
  })

  it('un valore mancante scrive «Non indicato»: la riga NON sparisce', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Anagrafica')
    // Nove campi vuoti nell'anagrafica finta + il telefono d'emergenza ecc.
    const vuoti = screen.getAllByText('Non indicato')
    expect(vuoti.length).toBeGreaterThanOrEqual(9)
    // E l'etichetta del campo vuoto c'è comunque: senza, l'omissione sarebbe
    // invisibile proprio a chi deve accorgersene.
    expect(screen.getByText('Comune di domicilio')).toBeInTheDocument()
    expect(screen.getByText('Persona da avvisare in caso di urgenza')).toBeInTheDocument()
  })

  it('i recapiti dell’account arrivano da `utenti`, non dall’anagrafica (che non li ha)', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getAllByText('maria.bianchi@example.test').length).toBeGreaterThan(0)
    expect(screen.getByText('+39 333 1234567')).toBeInTheDocument()
  })

  it('nessuna violazione axe', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriTab('Anagrafica')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('scheda staff · i gruppi coprono TUTTI i campi del modulo', () => {
  /**
   * IL LOCK. Un campo che non sta in nessun gruppo non si vede, e non se ne
   * accorge nessuno: è la stessa omissione invisibile che «Non indicato» esiste
   * per impedire, un livello più su. `PERSONALE_FIELDS` è il contratto del
   * modulo pubblico; se qualcuno gli aggiunge una domanda, questo test diventa
   * rosso finché non le si dà un posto — nei gruppi, oppure dichiarandola fra
   * quelle mostrate altrove.
   */
  it('ogni campo di PERSONALE_FIELDS sta in ESATTAMENTE un gruppo, o è dichiarato altrove', () => {
    // Le SORGENTI delle righe fuse contano come collocate: non sono una riga a
    // sé, ma sono ciò che quella riga mostra (vedi `RIGHE_FUSE`).
    const neiGruppi = [...GRUPPI_ANAGRAFICA_PERSONALE.flatMap((g) => g.campi), ...Object.values(RIGHE_FUSE)]
    const senzaPosto = PERSONALE_FIELDS
      .map((c) => c.id)
      .filter((id) => !neiGruppi.includes(id) && !(id in CAMPI_MOSTRATI_FUORI_DAI_GRUPPI))
    expect(
      senzaPosto,
      'Campi del modulo che questa scheda non mostrerebbe da nessuna parte: ' +
      'aggiungili a un gruppo di GRUPPI_ANAGRAFICA_PERSONALE, oppure dichiarali in ' +
      'CAMPI_MOSTRATI_FUORI_DAI_GRUPPI con il posto in cui si vedono.',
    ).toEqual([])
  })

  it('nessun campo compare in due gruppi (sarebbe la stessa riga scritta due volte)', () => {
    const neiGruppi = GRUPPI_ANAGRAFICA_PERSONALE.flatMap((g) => g.campi)
    const doppi = neiGruppi.filter((id, i) => neiGruppi.indexOf(id) !== i)
    expect(doppi).toEqual([])
  })

  it('ogni id dei gruppi esiste davvero in PERSONALE_FIELDS: nessuna etichetta inventata', () => {
    const noti = new Set(PERSONALE_FIELDS.map((c) => c.id))
    const ignoti = [...GRUPPI_ANAGRAFICA_PERSONALE.flatMap((g) => g.campi), ...Object.values(RIGHE_FUSE)]
      .filter((id) => !noti.has(id))
    expect(ignoti).toEqual([])
  })

  /**
   * IL LOCK DELLA RIGA FUSA. La sorgente di una riga fusa NON deve essere anche
   * una riga sua: se lo fosse, lo stesso fatto tornerebbe a comparire due volte,
   * che è precisamente il difetto da cui `RIGHE_FUSE` nasce — «Comune di nascita
   * (per esteso): Napoli» sopra «Comune di nascita: H501», con «Provincia di
   * nascita» in mezzo a separarle.
   */
  it('la sorgente di una riga FUSA non è anche una riga a sé: un fatto, una riga', () => {
    const neiGruppi = GRUPPI_ANAGRAFICA_PERSONALE.flatMap((g) => g.campi)
    for (const [riga, sorgente] of Object.entries(RIGHE_FUSE)) {
      expect(neiGruppi, `la riga «${riga}» dovrebbe stare in un gruppo`).toContain(riga)
      expect(
        neiGruppi,
        `«${sorgente}» è la SORGENTE della riga «${riga}»: se compare anche come riga propria, ` +
        'lo stesso fatto si legge due volte con due etichette diverse.',
      ).not.toContain(sorgente)
    }
  })
})

describe('scheda staff · lo STATO VUOTO, che il primo giorno è il più comune', () => {
  it('offre il link del modulo invece di essere un vicolo cieco', async () => {
    rispostaAnagrafica = undefined // 404 = anagrafica assente
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getByText('Anagrafica non ancora compilata')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copia il link del modulo/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Invia per email/ })).toBeInTheDocument()
  })

  it('«Copia il link del modulo» mette negli appunti la URL ASSOLUTA di /anagrafica-personale', async () => {
    rispostaAnagrafica = undefined
    await montaScheda()
    await apriTab('Anagrafica')
    fireEvent.click(screen.getByRole('button', { name: /Copia il link del modulo/ }))
    await waitFor(() => expect(scriviAppunti).toHaveBeenCalledWith(`${window.location.origin}/anagrafica-personale`))
    await waitFor(() => expect(screen.getByText('Link copiato')).toBeInTheDocument())
  })

  it('«Invia per email» è un mailto verso la persona, col link nel corpo', async () => {
    rispostaAnagrafica = undefined
    await montaScheda()
    await apriTab('Anagrafica')
    const href = screen.getByRole('link', { name: /Invia per email/ }).getAttribute('href') ?? ''
    expect(href.startsWith('mailto:')).toBe(true)
    expect(decodeURIComponent(href)).toContain('maria.bianchi@example.test')
    expect(decodeURIComponent(href)).toContain('/anagrafica-personale')
  })

  it('⚠️ una lettura FALLITA non è uno stato vuoto: non si va a chiedere dati già consegnati', async () => {
    rispostaAnagrafica = 'errore' // 500
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.queryByText('Anagrafica non ancora compilata')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/Non è stato possibile leggere l’anagrafica/)
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeInTheDocument()
  })

  it('«Riprova» rilegge davvero, e la seconda risposta buona riempie la scheda', async () => {
    rispostaAnagrafica = 'errore'
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeInTheDocument()
    rispostaAnagrafica = anagraficaCompleta()
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(screen.getByText('Italiana')).toBeInTheDocument())
  })

  it('nessuna violazione axe sullo stato vuoto', async () => {
    rispostaAnagrafica = undefined
    const { container } = await montaScheda()
    await apriTab('Anagrafica')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('scheda staff · il tab Documento', () => {
  it('mostra il banner di stato con la data per esteso', async () => {
    rispostaAnagrafica = anagraficaCompleta({ document_expiry: '2026-08-11' })
    await montaScheda()
    await apriTab('Documento')
    expect(screen.getByText(/Il documento è scaduto il 11 agosto 2026/)).toBeInTheDocument()
  })

  it('«Apri la scansione» apre la finestra DENTRO il gesto, PRIMA della fetch', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Documento')
    openMock.mockClear()

    fireEvent.click(apriFaccia('Fronte'))
    // Sincrono: se l'apertura fosse in continuazione di promise, qui `open` non
    // sarebbe ancora stata chiamata — ed è esattamente il caso che Safari e la
    // WebView Capacitor bloccano.
    expect(openMock).toHaveBeenCalledWith('', '_blank')

    await waitFor(() => expect(finestraAperta?.location.replace).toHaveBeenCalledWith('https://storage.example.test/firmata'))
    // La scheda del documento non deve poter toccare il cockpit da cui è nata.
    expect(finestraAperta?.opener).toBeNull()

    // ⚠️ E LA RICHIESTA HA UN TETTO. Qui la scheda VUOTA è già aperta: una rete
    // che accetta e tace lascerebbe la segreteria davanti a una pagina bianca per
    // sempre — cioè lo stesso «pulsante che non fa niente e non dice niente» che
    // `apriDocumentoFirmato` esiste per eliminare, rientrato da un'altra porta.
    // Col tetto la scadenza scatta, il `catch` chiude la scheda e il pannello
    // mostra il suo errore. Lock repo-wide: `__tests__/lib/logging-tetto.test.ts`.
    const chiamata = fetchMock.mock.calls.find((args: unknown[]) => String(args[0]).includes('doc='))
    const init = chiamata?.[1] as RequestInit | undefined
    expect(init?.signal, 'la richiesta della URL firmata non porta nessuna scadenza').toBeInstanceOf(AbortSignal)
  })

  it('finestra bloccata dal browser: si offre la URL firmata come link', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Documento')
    openMock.mockImplementation(() => null)

    fireEvent.click(apriFaccia('Fronte'))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Aprilo a mano' })).toHaveAttribute('href', 'https://storage.example.test/firmata'))
  })

  /**
   * ⚠️ I DUE COMANDI «APRI» HANNO NOMI DIVERSI, e non è una finezza: per chi
   * ascolta, due bottoni chiamati entrambi «Apri la scansione» sono due comandi
   * identici che fanno cose diverse — e la cosa diversa è aprire la faccia
   * sbagliata del documento d'identità di una persona (WCAG 2.4.4/2.5.3). Il nome
   * accessibile CONTIENE l'etichetta visibile, così la regola «Label in Name»
   * regge: si aggiunge la faccia, non la si sostituisce.
   */
  it('ogni faccia ha il suo «Apri», e ognuno chiede il PROPRIO percorso', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Documento')

    fireEvent.click(apriFaccia('Retro'))
    await waitFor(() => expect(fetchMock.mock.calls.some((a: unknown[]) => String(a[0]).includes('doc='))).toBe(true))
    const chiesto = fetchMock.mock.calls.map((a: unknown[]) => String(a[0])).filter((u) => u.includes('doc='))
    expect(chiesto.at(-1), 'il pulsante del retro ha chiesto la firma del FRONTE').toContain(
      encodeURIComponent('documenti/aaaaaaaa-0000-4000-8000-00000000000a/retro.pdf'),
    )
  })

  it('senza una faccia il suo pulsante non c’è, e si dice perché — l’altra resta apribile', async () => {
    rispostaAnagrafica = anagraficaCompleta({ documento_retro_path: null })
    await montaScheda()
    await apriTab('Documento')
    expect(apriFaccia('Fronte')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Apri la scansione.*Retro/ })).not.toBeInTheDocument()
    expect(screen.getByText('Nessuna scansione allegata.')).toBeInTheDocument()
  })

  it('«Richiedi l’aggiornamento» offre lo stesso link del modulo', async () => {
    rispostaAnagrafica = anagraficaCompleta({ document_expiry: '2026-08-11' })
    await montaScheda()
    await apriTab('Documento')
    fireEvent.click(screen.getByRole('button', { name: /Copia il link del modulo/ }))
    await waitFor(() => expect(scriviAppunti).toHaveBeenCalledWith(`${window.location.origin}/anagrafica-personale`))
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * IL TAB «DOCUMENTO» A DUE FACCE — e la porta di caricamento
 *
 * Dal 12/08/2026 il documento d'identità si conserva fronte E retro (migrazione
 * `20260812194501`), e la Segreteria può caricare le scansioni da qui invece di
 * chiedere a ogni dipendente di ricompilare il modulo pubblico. Il perché è una
 * misura, non un'opinione: in produzione `anagrafica_personale` ha ZERO righe e
 * gli account non-genitore sono VENTI.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('scheda staff · `statoScansioni` — la funzione pura, quattro casi', () => {
  /**
   * ⚠️ È UNA FUNZIONE NUOVA E NON UN QUINTO STATO DI `statoDocumento`, che invece
   * NON si tocca: quella usa le stesse due funzioni del cron notturno, e due
   * definizioni della parola «in scadenza» darebbero a chi guarda la scheda una
   * risposta e a chi riceve la notifica l'altra.
   */
  it('risponde a «quante facce ci sono», e la stringa vuota vale «non c’è»', () => {
    expect(statoScansioni('documenti/a/f.pdf', 'documenti/a/r.pdf')).toBe('complete')
    expect(statoScansioni('documenti/a/f.pdf', null)).toBe('soloFronte')
    expect(statoScansioni(null, 'documenti/a/r.pdf')).toBe('soloRetro')
    expect(statoScansioni(null, null)).toBe('assenti')
    // Un percorso azzerato può restare `''` in colonna: trattarlo come presente
    // farebbe dire «archiviata» a una faccia che «Apri» non potrebbe firmare.
    expect(statoScansioni('   ', '')).toBe('assenti')
  })
})

describe('scheda staff · il tab Documento dice quante facce ci sono', () => {
  const RIGA_STATO = () => screen.getByRole('status')

  it.each([
    ['complete', {}, /Fronte e retro del documento sono archiviati/],
    ['soloFronte', { documento_retro_path: null }, /Manca il RETRO/],
    ['soloRetro', { documento_fronte_path: null }, /Manca il FRONTE/],
    ['assenti', { documento_fronte_path: null, documento_retro_path: null }, /Nessuna delle due facce/],
  ] as const)('%s: la riga lo dice a parole', async (_nome, sovrascritture, atteso) => {
    rispostaAnagrafica = anagraficaCompleta(sovrascritture)
    await montaScheda()
    await apriTab('Documento')
    expect(RIGA_STATO().textContent).toMatch(atteso)
  })

  it('è `role="status"` e NON `role="alert"`: un’incompletezza non è un guasto', async () => {
    // `alert` è assertivo: taglia la parola a uno screen reader. In questa scheda è
    // già speso per le cose davvero rotte (la fascia rossa, l'errore di apertura);
    // spenderlo anche qui insegna a ignorarlo.
    rispostaAnagrafica = anagraficaCompleta({ documento_retro_path: null })
    const { container } = await montaScheda()
    await apriTab('Documento')
    const riga = RIGA_STATO()
    expect(riga.getAttribute('role')).toBe('status')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('scheda staff · caricare e sostituire una scansione', () => {
  /** Le chiamate al POST della porta di caricamento. */
  const invii = () => fetchMock.mock.calls.filter((a: unknown[]) => String(a[0]).includes('/scansione?'))

  it('la SEGRETERIA vede il comando: non sta dietro `canEdit` (che è il gate dell’Incarico)', async () => {
    // È la stessa ragione scritta nella testata della route gemella: la scansione la
    // consegna chi sta al banco. Un pannello che la nasconde alla segreteria
    // costringe a girare il documento a qualcun altro il giorno dopo.
    ruoloCorrente = 'segreteria'
    rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null, documento_retro_path: null })
    await montaScheda()
    await apriTab('Documento')
    expect(caricaFaccia('Fronte')).toBeInTheDocument()
    expect(caricaFaccia('Retro')).toBeInTheDocument()
    // …e resta vero che l'INCARICO non lo tocca.
    expect(screen.queryByRole('button', { name: /^Modifica$/ })).not.toBeInTheDocument()
  })

  it('il primo caricamento NON chiede conferma: non c’è niente da distruggere', async () => {
    rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
    await montaScheda()
    await apriTab('Documento')

    scegli(caricaFaccia('Fronte'), fileFinto())
    await waitFor(() => expect(invii()).toHaveLength(1))
    expect(screen.queryByText(/verrà cancellata definitivamente/)).not.toBeInTheDocument()
  })

  it('la richiesta porta utenteId e lato in QUERY, e nel corpo il solo file', async () => {
    // Gli identificativi in query sono ciò che permette al server di negare PRIMA di
    // bufferizzare 4 MB (lock `corpo-letto-dopo-il-gate`).
    rispostaAnagrafica = anagraficaCompleta({ documento_retro_path: null })
    await montaScheda()
    await apriTab('Documento')

    scegli(caricaFaccia('Retro'), fileFinto('retro.jpg'))
    await waitFor(() => expect(invii()).toHaveLength(1))

    const [url, init] = invii()[0] as [string, RequestInit]
    expect(String(url)).toContain(`utenteId=${STAFF_ID}`)
    expect(String(url)).toContain('lato=retro')
    expect(init.method).toBe('POST')
    const corpo = init.body as FormData
    expect(corpo.get('file')).toBeInstanceOf(File)
    expect(corpo.get('utenteId'), 'l’identificativo viaggia nel multipart: il gate di sede girerebbe DOPO').toBeNull()
    // L'identità dell'operatore viaggia come sempre nel cockpit.
    expect((init.headers as Record<string, string>)['x-user-id']).toBe('u-admin')
  })

  it('dopo un caricamento riuscito la scheda RILEGGE dal server, non indovina', async () => {
    // Il percorso NON torna dalla risposta — è la chiave che apre un documento
    // d'identità — quindi inventarlo in stato produrrebbe un «Apri» che non funziona.
    rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
    await montaScheda()
    await apriTab('Documento')
    const lettureIniziali = fetchMock.mock.calls.filter((a: unknown[]) => String(a[0]).includes('utenteId=') && !String(a[0]).includes('/scansione?')).length

    scegli(caricaFaccia('Fronte'), fileFinto())
    await waitFor(() => expect(invii()).toHaveLength(1))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((a: unknown[]) => String(a[0]).includes('utenteId=') && !String(a[0]).includes('/scansione?')).length,
        'il fascicolo non è stato riletto: la scheda sta mostrando uno stato indovinato',
      ).toBeGreaterThan(lettureIniziali),
    )
  })

  it('«Sostituisci» chiede conferma IN PAGINA, e `confirm()` nativo non si usa mai', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Documento')

    fireEvent.click(sostituisciFaccia('Fronte'))
    expect(screen.getByText(/verrà cancellata definitivamente/)).toBeInTheDocument()
    expect(window.confirm, 'la conferma è passata dalla finestra di sistema: nella WebView interrompe il gesto').not.toHaveBeenCalled()
    // Finché non si conferma, niente parte.
    expect(invii()).toHaveLength(0)
  })

  it('la conferma si può ANNULLARE, e allora non parte niente', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Documento')

    fireEvent.click(sostituisciFaccia('Fronte'))
    fireEvent.click(screen.getByRole('button', { name: /Annulla\s+Fronte/ }))
    await waitFor(() => expect(screen.queryByText(/verrà cancellata definitivamente/)).not.toBeInTheDocument())
    expect(invii()).toHaveLength(0)
  })

  it('confermata, la sostituzione parte con il lato giusto', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Documento')

    fireEvent.click(sostituisciFaccia('Retro'))
    const conferma = screen.getByRole('group', { name: /Sostituisci la scansione\s+Retro/ })
    scegli(conferma.querySelector('label') as HTMLElement, fileFinto('retro.jpg'))

    await waitFor(() => expect(invii()).toHaveLength(1))
    expect(String(invii()[0][0])).toContain('lato=retro')
  })

  it('il 409 del server si legge dal CATALOGO, non nella prosa cruda', async () => {
    // Il codice `SCANSIONE_SOSTITUITA_ALTROVE` esiste perché quella frase, nata sul
    // server dove il locale non c'è, sarebbe italiana per costruzione: mostrarla a
    // chi ha l'interfaccia in inglese è il fallimento F2 del collaudo del 31/07.
    rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/scansione?')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ error: 'prosa del server', codice: 'SCANSIONE_SOSTITUITA_ALTROVE' }),
        })
      }
      return serverPredefinito(url)
    })
    await montaScheda()
    await apriTab('Documento')

    scegli(caricaFaccia('Fronte'), fileFinto())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/sostituita da qualcun altro/))
    expect(screen.queryByText('prosa del server')).not.toBeInTheDocument()
  })

  // ── I DUE 503 DICONO LA FRASE DI QUESTA SCHERMATA, non quella di un'altra ─────
  //
  // Fino al 13/08/2026 questa porta rispondeva con i codici della rotta gemella, e
  // il difetto era invisibile da parte server: `messaggioDaCorpo` mostra il testo di
  // CATALOGO e BUTTA la prosa che la route scrive (solo i codici in
  // `CODICI_CON_DETTAGLIO` la conservano, e sono uno). Quindi chi premeva «Carica il
  // fronte» e incappava nel 503 leggeva, parola per parola, «le scadenze dei
  // documenti non sono consultabili… qui sotto non compare nessuna riga» — un elenco
  // che sullo schermo non c'è — oppure «la correzione non è stata registrata», senza
  // aver corretto niente.
  //
  // Le asserzioni NEGATIVE sono il cuore del collaudo: senza, rimettere il codice
  // vecchio resterebbe verde, perché anche quello un testo lo produce.
  it.each([
    [
      503,
      'SCANSIONE_ARCHIVIO_NON_DISPONIBILE',
      /non è stata caricata|non riusciamo a leggere/i,
      /scadenz|nessuna riga|correzione/i,
    ],
    [
      503,
      'SCANSIONE_NON_REGISTRATA',
      /non è stata archiviata|non è stato conservato/i,
      /scadenz|nessuna riga|correzione/i,
    ],
  ])(
    'il %i con codice %s dice che il file NON è stato archiviato, e non parla di elenchi né di correzioni',
    async (stato, codice, attesa, vietata) => {
      rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
      fetchMock.mockImplementation((url: string) => {
        if (String(url).includes('/scansione?')) {
          return Promise.resolve({
            ok: false,
            status: stato,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ error: 'prosa del server', codice }),
          })
        }
        return serverPredefinito(url)
      })
      await montaScheda()
      await apriTab('Documento')

      scegli(caricaFaccia('Fronte'), fileFinto())
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(attesa))
      // La frase di un'ALTRA schermata: è precisamente ciò che i due codici propri
      // esistono per non far leggere.
      expect(screen.getByRole('alert').textContent).not.toMatch(vietata)
      expect(screen.queryByText('prosa del server')).not.toBeInTheDocument()
    },
  )

  it('un guasto senza codice non lascia la scheda muta: c’è un ripiego, e un log', async () => {
    rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/scansione?')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers({ 'content-type': 'text/plain' }),
          json: async () => { throw new Error('non è json') },
        })
      }
      return serverPredefinito(url)
    })
    await montaScheda()
    await apriTab('Documento')

    scegli(caricaFaccia('Fronte'), fileFinto())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Non è stato possibile caricare/))
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'anagrafica-personale-scansione-non-caricata' }),
    )
  })

  it('il fuoco non cade su `<body>` quando «Carica» smonta se stesso', async () => {
    // Un caricamento riuscito trasforma «Carica» in «Apri»+«Sostituisci»: la
    // `<label>` con dentro l'`<input>` sparisce, e chi ha scelto il file da tastiera
    // ripartirebbe dall'inizio della scheda (WCAG 2.4.3). È lo stesso difetto già
    // misurato su «Riprova», trenta righe più su nel sorgente.
    let caricata = false
    rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/scansione?')) {
        caricata = true
        return Promise.resolve({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ success: true, path: 'x' }) })
      }
      if (String(url).includes('utenteId=') && caricata) {
        rispostaAnagrafica = anagraficaCompleta()
      }
      return serverPredefinito(url)
    })
    await montaScheda()
    await apriTab('Documento')

    const controllo = caricaFaccia('Fronte')
    campoFile(controllo).focus()
    scegli(controllo, fileFinto())

    await waitFor(() => expect(apriFaccia('Fronte')).toBeInTheDocument())
    expect(document.activeElement?.tagName, 'il fuoco è finito su <body>').not.toBe('BODY')
    expect(document.activeElement?.textContent).toMatch(/Fronte/)
  })

  it('nessuna violazione axe sul tab Documento, conferma aperta compresa', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriTab('Documento')
    expect(await axe(container)).toHaveNoViolations()

    fireEvent.click(sostituisciFaccia('Fronte'))
    expect(await axe(container)).toHaveNoViolations()
  })

  it('l’`<input type="file">` è `sr-only` e MAI `hidden`: senza mouse resta raggiungibile', async () => {
    // Con `display:none` l'input non è focalizzabile, non entra nel Tab e NON ESISTE
    // nell'albero di accessibilità: la `<label>` sembra un bottone e non lo è.
    // `jest-axe` non lo vede — dà 0 violazioni — quindi va misurato qui.
    rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
    await montaScheda()
    await apriTab('Documento')
    const input = campoFile(caricaFaccia('Fronte'))
    expect(input.className).toContain('sr-only')
    expect(input.hasAttribute('hidden')).toBe(false)
    // …e non è `disabled`: la guardia contro il doppio invio sta nel GESTORE,
    // perché disabilitare un elemento che ha il fuoco lo fa cadere su `<body>`.
    // ⚠️ QUESTA RIGA MISURA L'ASSENZA DELL'ALTERNATIVA, non la presenza della
    // difesa — ed è esattamente il rilievo del 13/08/2026. La difesa vera si misura
    // nel blocco «una richiesta per volta» qui sotto; qui resta solo la metà
    // negativa, che senza l'altra sarebbe un commento che promette un presidio.
    expect(input.disabled).toBe(false)
  })

  /**
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║  UNA RICHIESTA PER VOLTA — misurata, non promessa da un commento         ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * ── PERCHÉ ESISTE QUESTO BLOCCO, e la misura che l'ha reso necessario ──────
   *
   * Il 13/08/2026 la guardia contro il doppio invio era documentata DUE VOLTE e per
   * esteso — nella testata di `caricaScansione` e nel punto 2 della testata di
   * `BloccoFaccia` — e **provata da nessuna riga**. Le mutazioni, sul file finale:
   *
   *   · `if (!file || inVolo || bloccato) return` → `if (!file) return`  → 135/135 VERDI
   *   · tolta la sola guardia `bloccato`                                  → 135/135 VERDI
   *   · tolto anche `if (inVolo) return` da `caricaScansione`             → 135/135 VERDI
   *   · tolto `e.target.value = ''`                                       → 135/135 VERDI
   *
   * L'unico test che sfiorava l'argomento asseriva `input.disabled === false` e poi
   * COMMENTAVA «la guardia sta sull'`onChange`»: cioè misurava l'assenza
   * dell'alternativa e non la presenza della difesa. In un repo la cui regola scritta
   * è che «un documento che descrive una protezione che non c'è è peggio di nessun
   * documento», quel commento era il difetto.
   *
   * ── COSA COSTA IL DOPPIO INVIO, in concreto ────────────────────────────────
   *
   * Due `change` ravvicinati sulla stessa faccia mandano due POST. Il primo scrive la
   * colonna; il SECONDO trova il compare-and-swap (`.eq(colonna, attuale)`) già
   * scaduto, non tocca nessuna riga e risponde **409 «questa scansione è stata
   * sostituita da qualcun altro nel frattempo»**. Cioè l'operatore viene accusato di
   * una corsa che ha corso da solo, contro se stesso — e il suo file resta nel bucket
   * finché il ritiro non lo toglie.
   *
   * ── PERCHÉ IL POST RESTA APPESO, e non si sblocca ──────────────────────────
   *
   * La finestra «in volo» esiste solo fra la partenza e la risposta: con un finto che
   * risponde subito, `inVolo` torna `null` prima che il secondo gesto arrivi, e il
   * test sarebbe verde anche senza nessuna guardia. È lo stesso motivo per cui il
   * finto della rotta gemella tiene una cronologia invece dello stato finale.
   */
  describe('una richiesta per volta', () => {
    /** Il POST non risponde mai: è l'unico modo di tenere aperta la finestra «in volo». */
    function postAppeso() {
      fetchMock.mockImplementation((url: string) => {
        if (String(url).includes('/scansione?')) return new Promise<never>(() => {})
        return serverPredefinito(url)
      })
    }

    /**
     * Sceglie un file su un `<input>` GIÀ TROVATO, e non sul controllo.
     *
     * ⚠️ Non si può riusare `caricaFaccia()` per il secondo gesto: appena la prima
     * richiesta parte, l'etichetta visibile diventa «Caricamento in corso», quindi
     * `getByLabelText(/Carica la scansione Fronte/)` non troverebbe più niente e il
     * test morirebbe di ricerca fallita invece di misurare la guardia. Il nodo DOM è
     * lo stesso: React aggiorna le props dell'input, non lo rimonta.
     */
    const scegliSu = (input: HTMLInputElement, file: File) => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      fireEvent.change(input)
    }

    /**
     * Lascia girare microtask E un giro di macrotask.
     *
     * Serve perché qui si asserisce un NEGATIVO: un `waitFor(() => expect(…).toBe(1))`
     * passerebbe al primo giro senza dare al secondo POST il tempo di partire, cioè
     * sarebbe verde anche a guardia rimossa. I timer finti fingono solo `Date`
     * (`toFake: ['Date']`), quindi `setTimeout` qui è quello vero.
     */
    const lasciaPartire = () => new Promise<void>((r) => setTimeout(r, 0))

    it('🔴 due `change` ravvicinati sulla STESSA faccia: parte UN SOLO POST', async () => {
      rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
      postAppeso()
      await montaScheda()
      await apriTab('Documento')

      const input = campoFile(caricaFaccia('Fronte'))
      scegliSu(input, fileFinto())
      await waitFor(() => expect(invii()).toHaveLength(1))

      // Il secondo gesto, mentre il primo è ancora in volo.
      scegliSu(input, fileFinto('ci-fronte-bis.jpg'))
      await lasciaPartire()

      expect(
        invii(),
        'due POST sulla stessa faccia: il secondo perde il compare-and-swap e l’operatore ' +
          'legge un 409 che accusa un collega — che è lui stesso, un istante prima',
      ).toHaveLength(1)
    })

    it('🔴 mentre il FRONTE è in volo, il RETRO non parte: la regola vale fra le due facce', async () => {
      // Non è simmetria per eleganza: le due facce scrivono righe della STESSA
      // tabella e il server serializza col compare-and-swap sulla propria colonna.
      // Due POST insieme non si corrompono a vicenda, ma il secondo arriverebbe con
      // un testimone letto prima del primo — ed è la classe di corsa che la rotta
      // gemella chiude a costo di un 409. Meglio non aprirla dal client.
      rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null, documento_retro_path: null })
      postAppeso()
      await montaScheda()
      await apriTab('Documento')

      const retro = campoFile(caricaFaccia('Retro'))
      scegliSu(campoFile(caricaFaccia('Fronte')), fileFinto())
      await waitFor(() => expect(invii()).toHaveLength(1))

      scegliSu(retro, fileFinto('ci-retro.jpg'))
      await lasciaPartire()

      expect(invii(), 'due caricamenti in volo insieme sulla stessa persona').toHaveLength(1)
      expect(String(invii()[0][0]), 'è partito il retro invece del fronte').toContain('lato=fronte')
    })

    it('🔴 il campo si AZZERA a ogni scelta: senza, il secondo tentativo dopo un errore non partirebbe', async () => {
      // Il browser emette `change` solo se il valore CAMBIA: riscegliere lo stesso
      // file dopo un errore non emetterebbe niente, e il comando sembrerebbe rotto.
      // jsdom non riproduce quella regola — `fireEvent.change` parte comunque — quindi
      // l'unica misura possibile è l'AZZERAMENTO stesso: si spia la scrittura su
      // `value`, che è ciò che il gestore fa e che il browser vero usa.
      rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null })
      postAppeso()
      await montaScheda()
      await apriTab('Documento')

      const input = campoFile(caricaFaccia('Fronte'))
      const azzeramenti: string[] = []
      Object.defineProperty(input, 'value', {
        get: () => '',
        set: (v: string) => { azzeramenti.push(v) },
        configurable: true,
      })

      scegliSu(input, fileFinto())
      await waitFor(() => expect(invii()).toHaveLength(1))

      expect(
        azzeramenti,
        'il gestore non azzera il campo: riscegliere lo STESSO file non emetterebbe nessun ' +
          '`change`, e dopo un errore il pulsante sembrerebbe rotto',
      ).toContain('')
    })
  })
})

describe('scheda staff · il tab Incarico NON regredisce', () => {
  it('i cinque campi di prima ci sono ancora', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    expect(screen.getByText('maria.bianchi@example.test')).toBeInTheDocument()
    expect(screen.getByText('Kidville Giugliano')).toBeInTheDocument()
    expect(screen.getByText('infanzia')).toBeInTheDocument()
    expect(screen.getByText('3 ANNI')).toBeInTheDocument()
    // Il ruolo compare due volte: pillola in testata e riga «Ruolo e Sede».
    expect(screen.getAllByText('Docente').length).toBe(2)
  })

  it('le due azioni della Direzione restano, e «Modifica» apre davvero i controlli', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    expect(screen.getByRole('button', { name: /Rigenera credenziali/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Modifica$/ }))
    await waitFor(() => expect(container.querySelectorAll('select').length).toBe(2))
    expect(screen.getByRole('button', { name: /Salva/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Annulla/ })).toBeInTheDocument()
  })

  /**
   * ⚠️ QUESTO TEST DICEVA «alla Segreteria le azioni restano NASCOSTE», ed è
   * cambiato il 2026-09-03 perché è cambiata la regola, non perché fosse comodo.
   *
   * Le azioni erano DUE dietro un interruttore solo. Adesso sono due poteri
   * distinti: la modifica di ruolo/sede/classi resta della Direzione — è ciò che
   * impedisce a una segreteria di promuovere un collega ad `admin` e prendersi
   * per via indiretta ciò che le si nega — mentre la rigenerazione delle
   * credenziali segue il BERSAGLIO. Qui il bersaglio è una `educator`.
   */
  it('alla Segreteria «Modifica» resta nascosta, «Rigenera credenziali» no', async () => {
    ruoloCorrente = 'segreteria'
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    expect(screen.queryByRole('button', { name: /^Modifica$/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Rigenera credenziali/i })).toBeInTheDocument()
    // Il motivo scritto è per chi NON ha nessuno dei due poteri: qui uno ce l'ha.
    expect(screen.queryByText('Modifiche riservate alla Direzione')).not.toBeInTheDocument()
  })

  /**
   * L'ALTRA METÀ, e senza di lei il test qui sopra proverebbe solo che il
   * pulsante è comparso — non che sia comparso per la ragione giusta.
   */
  it('alla Segreteria che guarda un ACCOUNT DI DIREZIONE non resta nessuna delle due azioni', async () => {
    ruoloCorrente = 'segreteria'
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda({ ruoloBersaglio: 'admin' })
    expect(screen.queryByRole('button', { name: /^Modifica$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rigenera credenziali/i })).not.toBeInTheDocument()
    expect(screen.getByText('Modifiche riservate alla Direzione')).toBeInTheDocument()
  })

  it("una cuoca non vede nessuna delle due azioni, su nessuno", async () => {
    ruoloCorrente = 'cuoca'
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    expect(screen.queryByRole('button', { name: /^Modifica$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rigenera credenziali/i })).not.toBeInTheDocument()
  })

  it('il piede azioni NON segue chi guarda l’anagrafica: comanderebbe su ciò che non si vede', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.queryByRole('button', { name: /^Modifica$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rigenera credenziali/i })).not.toBeInTheDocument()
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * I QUATTRO RILIEVI DEL CRITICO VISIVO (giro 1) — ognuno con il proprio lock
 * ──────────────────────────────────────────────────────────────────────────── */

describe('scheda staff · l’inchiostro del fascicolo si legge (WCAG 1.4.3)', () => {
  /**
   * IL DIFETTO, MISURATO. Le 28 etichette e le 10 righe «Non indicato» del tab
   * Anagrafica erano dipinte con `text-kidville-muted`: **2,51:1** su bianco
   * contro i 4,5:1 di AA, e l'URL dello stato vuoto 2,37:1 sulla crema. Cioè il
   * contenuto del tab NUOVO era il testo meno leggibile dell'intera scheda — su
   * un fascicolo del personale che si guarda anche dal telefono, al sole.
   *
   * E l'Alto Contrasto non lo rimediava: i tre rimedi HC di `globals.css` sono
   * agganciati a `.kv-admin-nav`, `.kv-admin-sheet` e `.kv-admin-rowcard`, e
   * questo pannello vive dentro `CockpitPage`, che non emette nessuna delle tre.
   *
   * PERCHÉ QUI E NON SOLO NEL LOCK REPO-WIDE. `testo-muted-allowlist` conta le
   * occorrenze sul SORGENTE e ammette un debito dichiarato: finché il file
   * restava in allowlist con 13, tredici usi sarebbero rimasti verdi per sempre.
   * Questo test guarda il DOM RESO e non ammette nessun numero: nel pannello
   * quel grigio non c'è più, e non può rientrare da nessuna delle tre schermate.
   */
  it.each(['Anagrafica', 'Documento'] as const)(
    'il tab %s non dipinge NIENTE con `text-kidville-muted`',
    async (nomeTab) => {
      rispostaAnagrafica = anagraficaCompleta()
      const { container } = await montaScheda()
      await apriTab(nomeTab)
      expect(container.querySelectorAll('[class*="text-kidville-muted"]')).toHaveLength(0)
    },
  )

  it('lo stato vuoto — la schermata più comune del primo giorno — non ce l’ha nemmeno sulla URL', async () => {
    rispostaAnagrafica = undefined // 404
    const { container } = await montaScheda()
    await apriTab('Anagrafica')
    expect(container.querySelectorAll('[class*="text-kidville-muted"]')).toHaveLength(0)
    // La URL del modulo era a 2,37:1 su crema/60: è l'unica riga della card che
    // si può leggere ad alta voce a una collega al telefono.
    const url = screen.getByText(`${window.location.origin}/anagrafica-personale`)
    expect(url.className).toContain('text-kidville-sub')
  })

  it('l’etichetta e il «Non indicato» portano `sub` (6,46:1), non `muted` (2,51:1)', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Anagrafica')
    // `Comune di domicilio` è vuoto nell'anagrafica finta: etichetta E valore.
    const etichetta = screen.getByText('Comune di domicilio')
    expect(etichetta.className).toContain('text-kidville-sub')
    for (const vuoto of screen.getAllByText('Non indicato')) {
      expect(vuoto.className).toContain('text-kidville-sub')
    }
  })

  it('e nemmeno il tab Incarico, che il grigio ce l’aveva da prima', async () => {
    // Il rilievo riguardava le tre righe NUOVE, ma le etichette «Email»,
    // «Ruolo» e «Sede» stavano allo stesso 2,51:1 da mesi: bonificare metà
    // pannello avrebbe lasciato due grigi diversi nella stessa scheda.
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    expect(container.querySelectorAll('[class*="text-kidville-muted"]')).toHaveLength(0)
  })
})

describe('scheda staff · i comandi nuovi arrivano a 44px', () => {
  /**
   * IL DIFETTO, MISURATO in Chrome con `getBoundingClientRect()` sul DOM vero:
   * «Copia il link del modulo» 195×**40**, «Invia per email» 144×43, «Apri la
   * scansione» 172×**39**, «Riprova» 75×**39**. I due comandi del piede
   * «Incarico», scritti mesi fa, stanno a 828×44.
   *
   * ⚠️ QUI SI MISURA LA CLASSE, NON IL PIXEL, e va detto: jsdom non impagina —
   * `getBoundingClientRect()` restituisce zeri, quindi un test che «misurasse»
   * sarebbe verde su qualunque cosa. Il pixel è stato misurato in Chrome una
   * volta; questo lock sorveglia che la dichiarazione che lo produce non sparisca
   * dai quattro comandi, che è l'unica cosa che un test in jsdom può fare
   * onestamente.
   *
   * Perché importa davvero: questa scheda si apre da `/admin/students/[id]`
   * anche dentro la WebView Capacitor, cioè da un telefono. 39 px su 44 sono
   * l'11% di bersaglio in meno su un comando che, se manca, o non apre niente o
   * apre il documento d'identità di qualcun altro.
   */
  const BERSAGLIO = 'min-h-[44px]'

  it('stato vuoto: «Copia il link del modulo» e «Invia per email»', async () => {
    rispostaAnagrafica = undefined
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getByRole('button', { name: /Copia il link del modulo/ }).className).toContain(BERSAGLIO)
    expect(screen.getByRole('link', { name: /Invia per email/ }).className).toContain(BERSAGLIO)
  })

  it('tab Documento: «Apri la scansione» e i due comandi di «Richiedi l’aggiornamento»', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Documento')
    expect(apriFaccia('Fronte').className).toContain(BERSAGLIO)
    expect(apriFaccia('Retro').className).toContain(BERSAGLIO)
    expect(sostituisciFaccia('Fronte').className).toContain(BERSAGLIO)
    expect(screen.getByRole('button', { name: /Copia il link del modulo/ }).className).toContain(BERSAGLIO)
    expect(screen.getByRole('link', { name: /Invia per email/ }).className).toContain(BERSAGLIO)
  })

  it('anche il comando di CARICAMENTO, che è una `<label>` e non un `<button>`', async () => {
    // Su un telefono è il bersaglio con cui la segreteria popola l'archivio da zero:
    // 20 persone × 2 facce. 39 px su 44 sono l'11% di bersaglio in meno.
    rispostaAnagrafica = anagraficaCompleta({ documento_fronte_path: null, documento_retro_path: null })
    await montaScheda()
    await apriTab('Documento')
    expect(caricaFaccia('Fronte').className).toContain(BERSAGLIO)
  })

  it('pannello d’errore: «Riprova»', async () => {
    rispostaAnagrafica = 'errore'
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getByRole('button', { name: 'Riprova' }).className).toContain(BERSAGLIO)
  })
})

describe('scheda staff · «Riprova» non lascia il fuoco su `<body>`', () => {
  /**
   * IL DIFETTO, MISURATO in jsdom prima del rimedio: `riprova.focus()` →
   * `document.activeElement === riprova`; dopo il clic e la rilettura riuscita,
   * `document.activeElement.tagName === 'BODY'`.
   *
   * «Riprova» è l'unico comando di questa scheda che DISTRUGGE il proprio
   * contenitore: il pannello d'errore si smonta portandosi via il bottone che ha
   * appena ricevuto il clic. Chi naviga da tastiera riparte dall'inizio della
   * scheda per tornare dove già era — cioè il percorso «errore → riprova → leggo
   * i dati» non si chiude (WCAG 2.4.3).
   *
   * I tre esiti si collaudano TUTTI E TRE perché il ricovero è il contenitore
   * del tab e non l'`h3` dei dati: un ricovero legato al solo esito felice
   * lascerebbe il fuoco su `<body>` proprio nel caso in cui è più probabile che
   * qualcuno prema il bottone una seconda volta.
   */
  async function premiRiprova() {
    rispostaAnagrafica = 'errore'
    await montaScheda()
    await apriTab('Anagrafica')
    const riprova = screen.getByRole('button', { name: 'Riprova' })
    riprova.focus()
    expect(document.activeElement).toBe(riprova)
    return riprova
  }

  /** Il ricovero: il contenitore del tab, riconoscibile dall'anello condiviso. */
  function ricovero() {
    return document.activeElement as HTMLElement
  }

  it('rilettura RIUSCITA: il fuoco va sul contenuto, non sul documento', async () => {
    await premiRiprova()
    rispostaAnagrafica = anagraficaCompleta()
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(screen.getByText('Italiana')).toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(ricovero().className).toContain('kv-fuoco-esito')
    expect(ricovero()).toHaveAttribute('tabindex', '-1')
    expect(ricovero().textContent).toContain('Italiana')
  })

  it('rilettura che dice «anagrafica assente»: stesso ricovero, non `<body>`', async () => {
    await premiRiprova()
    rispostaAnagrafica = undefined // 404
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(screen.getByText('Anagrafica non ancora compilata')).toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(ricovero().className).toContain('kv-fuoco-esito')
  })

  it('rilettura che fallisce DI NUOVO: il fuoco non si perde al secondo tentativo', async () => {
    await premiRiprova()
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Riprova' })).toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(ricovero().className).toContain('kv-fuoco-esito')
  })

  it('⚠️ senza gesto il fuoco NON si muove: la prima lettura non lo ruba a chi sta guardando', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriTab('Anagrafica')
    await waitFor(() => expect(screen.getByText('Italiana')).toBeInTheDocument())
    // Il ricovero riceve il fuoco SOLO dopo «Riprova». Se lo prendesse a ogni
    // arrivo di dati, lo strapperebbe a chi sta scorrendo la scheda mentre la
    // prima fetch atterra — e nessuno ha premuto niente.
    const ricoveri = [...container.querySelectorAll('.kv-fuoco-esito')]
    expect(ricoveri.length).toBe(1)
    expect(ricoveri).not.toContain(document.activeElement)
  })

  it('il ricovero non entra nell’ordine di tabulazione', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriTab('Anagrafica')
    for (const el of container.querySelectorAll('.kv-fuoco-esito')) {
      expect(el.getAttribute('tabindex')).toBe('-1')
    }
  })
})

describe('scheda staff · il «Numero di cellulare» non è una riga condannata a «Non indicato»', () => {
  /**
   * IL DIFETTO, MISURATO leggendo le due proiezioni: `admin/anagrafica-personale`
   * selezionava `id, nome, cognome, ruolo, scuola_id, email` e `admin/staff`
   * `id, nome, cognome, email, ruolo, scuola_id, gradi`. Nessuna delle due
   * conteneva `cellulare` — mentre l'approvazione della pratica quella colonna la
   * SCRIVE (`admin/pratiche-personale`, `cellulare: testo(riga.telefono)`).
   *
   * Cioè: dal primo «Approva» il numero esiste su `utenti`, e la riga «Numero di
   * cellulare» del gruppo Recapiti continuava a dire «Non indicato» per chiunque
   * e per sempre. Non era «l'assenza è la notizia»: era mandare la segreteria a
   * richiedere un dato già consegnato — la bugia esatta che il perimetro in testa
   * al pannello dichiara di voler evitare, un campo alla volta invece che
   * sull'intera anagrafica. E nessun test poteva vederla, perché `undefined` è
   * indistinguibile da «vuoto».
   *
   * Il lock è sul SORGENTE della route perché il difetto vive lì: il pannello era
   * già corretto (legge `cellulare`, col fallback su `telefono`), e un test che
   * montasse solo il componente con una risposta finta sarebbe stato verde per
   * tutto il tempo in cui la riga mentiva in produzione.
   */
  it('la route del dettaglio PROIETTA `cellulare`, altrimenti la riga mente', () => {
    const sorgente = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/admin/anagrafica-personale/route.ts'),
      'utf8',
    )
    // ⚠️ La route ha DUE proiezioni di `utenti` — l'elenco e il dettaglio — e
    // solo la seconda alimenta questa scheda. Un `match` non globale prenderebbe
    // la prima e il test sarebbe rosso su una route corretta: si cerca quella
    // che porta anche `email`, cioè il dettaglio.
    const proiezioni = [...sorgente.matchAll(/\.select\('(id, nome, cognome[^']*)'\)/g)].map((m) => m[1])
    expect(proiezioni.length, 'le proiezioni di `utenti` non si trovano più: rileggi il test').toBeGreaterThan(0)
    const dettaglio = proiezioni.find((p) => p.includes('email'))
    expect(dettaglio, 'la proiezione del DETTAGLIO non si trova più: rileggi il test').toBeTruthy()
    expect(
      dettaglio!,
      'La proiezione di `utenti` non contiene `cellulare`: la riga «Numero di cellulare» ' +
        'della scheda staff dirà «Non indicato» anche per chi il numero l’ha consegnato ' +
        'col modulo e la Segreteria ha già approvato.',
    ).toContain('cellulare')
    // E il campo esce davvero dalla risposta, non solo dalla query.
    expect(sorgente).toMatch(/cellulare:\s*\(utente as/)
  })

  it('quando il numero c’è, la scheda lo mostra invece di dichiararlo mancante', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getByText('Numero di cellulare')).toBeInTheDocument()
    expect(screen.getByText('+39 333 1234567')).toBeInTheDocument()
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * I TRE RILIEVI DEL CRITICO VISIVO (giro 2) — ognuno con il proprio lock
 * ──────────────────────────────────────────────────────────────────────────── */

describe('scheda staff · le righe di prosa hanno una MISURA', () => {
  /**
   * IL DIFETTO, MISURATO in Chrome (canale `chrome`) su una replica della scheda
   * col CSS vero e i font veri di `:3100`, con un `Range` carattere per carattere
   * sui nodi di testo — non in unità `ch`, e alla larghezza VERA della pagina
   * (`CockpitPage max={960}` in `admin/students/[id]` → card 896 px, contenuto
   * 848 px). Caratteri della riga più lunga, PRIMA:
   *
   *   «Richiedi l'aggiornamento», il corpo ........ 127   →  74
   *   banner «documento scaduto» .................. 118   →  69
   *   banner «documento mancante» ................. 114   →  66
   *   banner «in scadenza» ........................ 106   →  69
   *   «Sola lettura» ...............................  95   →  74
   *   stato vuoto (aveva già `max-w-md`) ...........  73   →  73
   *
   * Contro le ~75 oltre cui l'occhio perde il rientro fra una riga e la
   * successiva. Sono le frasi che portano l'unico fatto nuovo del modulo, e il
   * banner dello scaduto — la sola riga della scheda che va letta fino in fondo —
   * era anche la più lunga. Nella stessa card lo stato vuoto stava già a 73
   * perché portava `max-w-md`: la regola era nota, e applicata in un punto solo.
   *
   * ⚠️ QUI SI MISURA LA CLASSE, NON IL PIXEL, ed è un limite dichiarato: jsdom
   * non impagina (`getBoundingClientRect()` restituisce zeri), quindi un test che
   * «misurasse» sarebbe verde su qualunque cosa. I caratteri sono stati contati
   * nel browser una volta — in Chrome e, con gli stessi identici numeri, in
   * WebKit, cioè nel motore della WebView Capacitor. Questo lock sorveglia che la
   * dichiarazione che li produce non sparisca.
   */
  const SM = 'max-w-[28rem]'  // 448 px, per il corpo `text-sm` (14 px)
  const XS = 'max-w-[25rem]'  // 400 px, per il corpo `text-xs` (12 px)

  it('il banner del documento e l’avviso di sola lettura portano la misura', async () => {
    rispostaAnagrafica = anagraficaCompleta({ document_expiry: '2026-08-11' })
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getByText(/^Sola lettura/).className).toContain(XS)
    await apriTab('Documento')
    expect(screen.getByText(/Il documento è scaduto il/).className).toContain(SM)
    expect(screen.getByText(/Manda alla persona il link del modulo/).className).toContain(XS)
  })

  it('lo stato vuoto tiene la misura che aveva: stesso valore, una definizione sola', async () => {
    rispostaAnagrafica = undefined // 404
    await montaScheda()
    await apriTab('Anagrafica')
    const corpo = screen.getByText(/Di questa persona il registro conosce solo/)
    expect(corpo.className).toContain(SM)
    // Il `max-w-md` di prima valeva 28rem: se qualcuno rimette la classe vecchia
    // la resa non cambia, ma il numero torna a vivere in due posti.
    expect(corpo.className).not.toContain('max-w-md')
  })

  /**
   * ⚠️ IL PEZZO NON OVVIO, e il solo motivo per cui questo test esiste separato:
   * `max-width` NON si applica agli elementi inline non rimpiazzati. Le due righe
   * dentro un `<p class="flex">` sono vincolate solo perché lo `<span>` è FIGLIO
   * DIRETTO del contenitore flex — cioè un flex item, cioè blockified. Spostare
   * quel testo dentro un `<p>` normale, o infilare un livello in mezzo, lascerebbe
   * la classe scritta e la misura senza alcun effetto: il difetto tornerebbe
   * intero, con il lock qui sopra ancora verde.
   */
  it('la misura sta su un flex item, altrimenti su un inline non farebbe NIENTE', async () => {
    rispostaAnagrafica = anagraficaCompleta({ document_expiry: '2026-08-11' })
    await montaScheda()
    await apriTab('Anagrafica')
    const solaLettura = screen.getByText(/^Sola lettura/)
    expect(solaLettura.parentElement?.className).toContain('flex')
    expect(solaLettura.parentElement?.tagName).toBe('P')
    await apriTab('Documento')
    const banner = screen.getByText(/Il documento è scaduto il/)
    expect(banner.parentElement?.className).toContain('flex')
  })
})

describe('scheda staff · anche le LINGUETTE arrivano a 44px', () => {
  /**
   * IL DIFETTO, MISURATO con `getBoundingClientRect()` in Chrome coi font veri:
   * «Incarico» 103,7×**36**, «Anagrafica» 121,3×**36**, «Documento» 117,8×**36**.
   * L'altezza è deterministica e non dipende dalla lingua (`py-2` = 16 px +
   * interlinea `text-sm` = 20 px).
   *
   * Le linguette sono l'UNICO modo di raggiungere i due tab nuovi: sono il
   * comando che si preme PRIMA di tutti gli altri, ed erano l'ultimo rimasto
   * sotto la soglia di WCAG 2.5.5 dopo che i quattro comandi nuovi erano stati
   * portati a 44. Alzare i bersagli in fondo al percorso e lasciare a 36 px
   * quello all'inizio annulla il motivo per cui si sono alzati.
   *
   * RIMISURATO dopo: 103,7×**44** · 121,3×**44** · 117,8×**44**, identici in
   * Chrome e in WebKit.
   */
  it('la barra dei tab dichiara il bersaglio da 44px', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    const barra = screen.getByRole('button', { name: 'Anagrafica' }).parentElement
    expect(barra?.className).toContain('[&>button]:min-h-[44px]')
  })

  /**
   * ⚠️ IL PEZZO NON OVVIO. `Tabs` è condiviso da sette schermate e il suo
   * `className` finisce sul CONTENITORE, non sui bottoni: l'unica via per alzare
   * i bersagli solo qui è la variante `[&>button]`, che però ha un `>` — funziona
   * SOLO se le linguette sono figlie DIRETTE del nodo che porta la classe. Il
   * giorno in cui `Tabs` avvolgesse i bottoni in un livello in più (una barra
   * scorrevole, un gruppo), la classe resterebbe scritta e le linguette
   * tornerebbero a 36 px senza che niente diventi rosso.
   */
  it('le linguette sono figlie DIRETTE del nodo che porta la classe, o la variante `>` non le tocca', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    const barra = screen.getByRole('button', { name: 'Anagrafica' }).parentElement!
    const figlieDirette = [...barra.children].filter((n) => n.tagName === 'BUTTON')
    expect(figlieDirette).toHaveLength(3)
    expect(figlieDirette.map((b) => b.textContent)).toEqual(['Incarico', 'Anagrafica', 'Documento'])
  })
})

describe('scheda staff · «Comune di nascita» è UNA riga, e non è un codice catastale', () => {
  /**
   * IL DIFETTO, MISURATO leggendo le etichette di `PERSONALE_FIELDS` sul DOM
   * reso: il gruppo «Dati anagrafici» mostrava DUE righe sullo stesso fatto, e
   * quella dall'etichetta più corta e più autorevole portava un codice. `rendi()`
   * traduce in italiano solo i valori da elenco chiuso (`campo.options`) e le
   * date; `codice_belfiore_nascita` è un `text` con `pattern: '^[A-Z][0-9]{3}$'`
   * e nessuna `options`, quindi si stampava grezzo. Riga 3 = «Comune di nascita
   * (per esteso)» → «Giugliano in Campania», riga 5 = «Comune di nascita» →
   * **«H501»**, con «Provincia di nascita» in mezzo a separarle. Nel banco di
   * prova `birth_place` è `null`, quindi ciò che si leggeva era «Comune di
   * nascita (per esteso): Non indicato» sopra «Comune di nascita: H501» — e 54
   * test su 54 erano verdi.
   *
   * È il difetto che il commento di `rendi()` dichiara di impedire e che
   * `personale-template.ts` dice di aver già risolto a monte: `birth_place` si
   * archivia «perché il pannello dev'essere leggibile senza risolvere un codice
   * catastale». Chi legge un dato apparentemente sbagliato accanto a uno
   * apparentemente mancante fa la cosa ragionevole — chiede alla persona di
   * ricompilare il modulo per un dato che ha già consegnato.
   */
  it('una riga sola: l’etichetta «(per esteso)» non esiste più accanto a una gemella', async () => {
    rispostaAnagrafica = anagraficaCompleta({ birth_place: 'Giugliano in Campania' })
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getByText('Comune di nascita')).toBeInTheDocument()
    expect(screen.queryByText('Comune di nascita (per esteso)')).not.toBeInTheDocument()
  })

  it('il valore della riga è il NOME del comune, non il codice', async () => {
    rispostaAnagrafica = anagraficaCompleta({ birth_place: 'Giugliano in Campania' })
    await montaScheda()
    await apriTab('Anagrafica')
    const dd = screen.getByText('Comune di nascita').nextElementSibling!
    expect(dd.tagName).toBe('DD')
    // Il primo nodo del valore è il testo leggibile: «H501» non prende il suo posto.
    expect(dd.firstChild?.textContent).toBe('Giugliano in Campania')
  })

  it('il Belfiore non si perde: resta accanto, come CODICE e con un nome parlato', async () => {
    rispostaAnagrafica = anagraficaCompleta({ birth_place: 'Giugliano in Campania' })
    await montaScheda()
    await apriTab('Anagrafica')
    // I quattro caratteri finiscono dentro il codice fiscale: chi verifica un CF
    // li vuole vedere. Ma letti ad alta voce «H501» non significano niente, e il
    // prefisso `sr-only` dice di che cosa si tratta.
    const pillola = screen.getByText('H501')
    expect(pillola.querySelector('.sr-only')?.textContent?.trim()).toBe('Codice catastale:')
    const dd = screen.getByText('Comune di nascita').nextElementSibling!
    expect(dd).toContainElement(pillola)
    // ⚠️ Fra il nome del comune e la pillola NON c'è nessun nodo di testo: senza
    // lo spazio dentro il nome parlato uno screen reader legge «CampaniaCodice».
    expect(dd.textContent).toContain('Campania Codice catastale:')
  })

  it('⚠️ senza il nome per esteso la riga dice «Non indicato» — e NON stampa il codice al suo posto', async () => {
    rispostaAnagrafica = anagraficaCompleta() // `birth_place: null`, come in produzione
    await montaScheda()
    await apriTab('Anagrafica')
    const dd = screen.getByText('Comune di nascita').nextElementSibling!
    expect(dd.firstChild?.textContent).toBe('Non indicato')
    // Il codice resta comunque leggibile: nessun dato archiviato si perde.
    expect(dd.textContent).toContain('H501')
  })

  it('nessuna violazione axe con la riga fusa a schermo', async () => {
    rispostaAnagrafica = anagraficaCompleta({ birth_place: 'Giugliano in Campania' })
    const { container } = await montaScheda()
    await apriTab('Anagrafica')
    expect(await axe(container)).toHaveNoViolations()
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * I QUATTRO RILIEVI DEL CRITICO VISIVO (giro 4) — ognuno con il proprio lock
 * ──────────────────────────────────────────────────────────────────────────── */

describe('scheda staff · in inglese il FASCICOLO è inglese, non solo il guscio', () => {
  /**
   * IL DIFETTO, MISURATO rendendo il pannello col catalogo `messages/en` e
   * contando le etichette sul DOM: **27 `<dt>` su 27 in italiano** («Sesso»,
   * «Data di nascita», «Comune di nascita», «Codice fiscale», «Che rapporto ha
   * con te»…) dentro titoli di gruppo inglesi («Personal details», «Residence»,
   * «Contacts», «ID document», «Professional profile»), con l'avviso di sola
   * lettura, il ruolo, la data e il piede già tradotti. Italiani anche i valori a
   * elenco: «Femmina», «Carta d'identità», «Laurea magistrale». Cioè restava in
   * italiano l'unica cosa per cui il tab esiste.
   *
   * ⚠️ E IL LOCK DELLA PARITÀ ERA VERDE: 555/555 su `adminStudents`, perché le 39
   * chiavi del CONTORNO erano state aggiunte in tutte e due le lingue e le 27
   * stringhe del CONTENUTO non erano mai diventate chiavi. Un confronto fra due
   * cataloghi non può vedere il testo che nessuno dei due contiene — è il caso in
   * cui il lock esiste e il difetto gli passa accanto.
   *
   * Perché si misura QUI e non nel lock dei cataloghi: la domanda non è «le due
   * lingue hanno le stesse chiavi», è «che cosa legge chi ha l'interfaccia in
   * inglese». Ha una risposta sola, ed è il DOM reso in inglese.
   */
  const chiaviMostrate = GRUPPI_ANAGRAFICA_PERSONALE.flatMap((g) => g.campi)

  const catalogo = (lingua: 'it' | 'en'): Record<string, string> =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'messages', lingua, 'etichette.json'), 'utf8'))

  it('le 27 righe hanno la loro chiave in ENTRAMBE le lingue', () => {
    const it = catalogo('it')
    const en = catalogo('en')
    const senzaChiave = chiaviMostrate.filter((id) => !(`campoPersonale_${id}` in it) || !(`campoPersonale_${id}` in en))
    expect(
      senzaChiave,
      'Ogni campo mostrato dal fascicolo deve avere `campoPersonale_<id>` in messages/it ' +
      'e in messages/en: senza, la riga esce in italiano dentro un guscio inglese — e la ' +
      'parità dei cataloghi resta verde, perché la chiave non esiste da nessuna delle due parti.',
    ).toEqual([])
    expect(chiaviMostrate).toHaveLength(27)
  })

  /**
   * ⚠️ IL LOCK CHE RENDE INNOCUA LA DUPLICAZIONE. Portare le etichette in
   * catalogo riapre il timore per cui `GRUPPI_ANAGRAFICA_PERSONALE` porta gli
   * `id` e non le etichette: «il giorno in cui una domanda cambia formulazione la
   * scheda continua a mostrare la vecchia — due nomi per lo stesso dato, uno dei
   * quali sbagliato». La stessa frase ora vive in due file; questa prova è ciò
   * che le impedisce di divergere in silenzio.
   */
  it('la voce ITALIANA coincide con l’etichetta di PERSONALE_FIELDS, carattere per carattere', () => {
    const it = catalogo('it')
    const divergenti = chiaviMostrate
      .map((id) => ({ id, catalogo: it[`campoPersonale_${id}`], contratto: PERSONALE_FIELDS.find((c) => c.id === id)?.label }))
      .filter((r) => r.contratto !== undefined && r.catalogo !== r.contratto)
    expect(
      divergenti,
      'Il catalogo italiano e `PERSONALE_FIELDS` devono dire la STESSA cosa: se hai ' +
      'riformulato una domanda del modulo, aggiorna anche `campoPersonale_<id>` in ' +
      'messages/it e messages/en. Due nomi per lo stesso dato è il difetto da cui questa ' +
      'scheda legge gli id invece delle etichette.',
    ).toEqual([])
  })

  it('anche i valori a ELENCO hanno la loro chiave nelle due lingue', () => {
    const it = catalogo('it')
    const en = catalogo('en')
    const mancanti: string[] = []
    for (const id of chiaviMostrate) {
      const campo = PERSONALE_FIELDS.find((c) => c.id === id)
      for (const o of campo?.options ?? []) {
        const chiave = `opzPersonale_${id}_${o.value}`
        if (!(chiave in it) || !(chiave in en)) mancanti.push(chiave)
        else if (it[chiave] !== o.label) mancanti.push(`${chiave} (it «${it[chiave]}» ≠ contratto «${o.label}»)`)
      }
    }
    expect(mancanti, 'I valori a elenco sono testo a schermo quanto le etichette: «Femmina», «Carta d’identità», «Laurea magistrale».').toEqual([])
  })

  it('il rilevatore vede DAVVERO una chiave mancante (o le tre prove qui sopra sarebbero vuote)', () => {
    const it = catalogo('it')
    // Controllo POSITIVO sul metodo, non sui dati: la stessa espressione su un id
    // inventato deve accusare. Senza, un giorno in cui `chiaviMostrate` tornasse
    // vuoto i tre `toEqual([])` passerebbero senza guardare niente.
    expect(['campo_inventato'].filter((id) => !(`campoPersonale_${id}` in it))).toEqual(['campo_inventato'])
    expect(chiaviMostrate.length).toBeGreaterThan(0)
  })

  it('⚠️ IL DOM IN INGLESE: nessuna delle 27 righe resta in italiano', async () => {
    linguaCorrente = 'en'
    rispostaAnagrafica = anagraficaCompleta({ birth_place: 'Giugliano in Campania' })
    const { container } = await montaScheda()
    await apriTab('Personal record')

    const it = catalogo('it')
    const en = catalogo('en')
    const etichette = [...container.querySelectorAll('dt')].map((n) => n.textContent?.trim() ?? '')
    expect(etichette).toHaveLength(27)

    // Una riga è «rimasta indietro» quando porta la voce ITALIANA e l'inglese è
    // un'altra cosa. «Email» è legittimamente identica nelle due lingue e non
    // conta come residuo: il confronto lo dice, invece di dedurlo.
    const rimasteInItaliano = chiaviMostrate.filter((id) => {
      const chiave = `campoPersonale_${id}`
      return it[chiave] !== en[chiave] && etichette.includes(it[chiave])
    })
    expect(
      rimasteInItaliano,
      'Queste righe del fascicolo si leggono in italiano con l’interfaccia in inglese.',
    ).toEqual([])

    // …e il controllo positivo: le inglesi ci sono per davvero.
    expect(etichette).toContain('Date of birth')
    expect(etichette).toContain('Italian tax code')
    expect(etichette).toContain('Their relationship to the employee')
  })

  it('⚠️ anche i VALORI a elenco sono inglesi: «Female», non «Femmina»', async () => {
    linguaCorrente = 'en'
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Personal record')
    expect(screen.getByText('Female')).toBeInTheDocument()
    expect(screen.getByText('ID card')).toBeInTheDocument()
    expect(screen.getByText('Master’s degree')).toBeInTheDocument()
    expect(screen.queryByText('Femmina')).not.toBeInTheDocument()
    expect(screen.queryByText('Carta d’identità')).not.toBeInTheDocument()
    expect(screen.queryByText('Laurea magistrale')).not.toBeInTheDocument()
  })

  it('nessuna chiave GREZZA a schermo: se una traduzione manca non si legge «etichette.campoX»', async () => {
    linguaCorrente = 'en'
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriTab('Personal record')
    // È ciò che next-intl mostra quando la chiave non c'è (`getMessageFallback`),
    // ed è il modo in cui una traduzione mancante arriva a schermo senza nessun log.
    expect(container.textContent).not.toMatch(/\b(etichette|adminStudents|shared)\.[A-Za-z_]/)
  })

  /**
   * Lo stesso difetto un tab più in là, e trovato mentre si chiudeva questo:
   * `RUOLI_ASSEGNABILI` porta cinque etichette italiane cablate, e la tendina di
   * «Modifica» le stampava così com'erano — mentre la pillola in sola lettura, due
   * righe più su, le traduce con `useLabelRuolo` da mesi. In inglese la stessa
   * scheda diceva «Teacher» sopra e «Docente» dentro il menu: non una schermata
   * mezza tradotta, una schermata che si contraddice sul dato che si sta cambiando.
   */
  it('anche la tendina del RUOLO parla la lingua della scheda', async () => {
    linguaCorrente = 'en'
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }))
    await waitFor(() => expect(container.querySelectorAll('select').length).toBe(2))
    const opzioni = [...screen.getByLabelText('Role').querySelectorAll('option')].map((o) => o.textContent)
    expect(opzioni).toContain('Teacher')
    expect(opzioni).toContain('Management')
    expect(opzioni).not.toContain('Docente')
  })

  it('in italiano non cambia NIENTE: le etichette restano quelle del contratto', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    await apriTab('Anagrafica')
    expect(screen.getByText('Codice fiscale')).toBeInTheDocument()
    expect(screen.getByText('Che rapporto ha con te')).toBeInTheDocument()
    expect(screen.getByText('Femmina')).toBeInTheDocument()
  })
})

describe('scheda staff · la fascia che SOSTITUISCE la scheda si legge, e parla', () => {
  /**
   * IL DIFETTO, MISURATO due volte e indipendentemente: axe-core in Chrome sul DOM
   * vero («insufficient color contrast of 3.7, foreground #e53935, background
   * #fdecec») e col calcolo WCAG su `getComputedStyle`. **3,70:1** contro i 4,5:1
   * di AA, e senza `role="alert"` — cioè muta per uno screen reader.
   *
   * È la sola schermata che dice alla segreteria che la scheda non si è caricata,
   * e nasconde tutto il resto del pannello. Trenta righe più giù, nello stesso
   * file, il pannello d'errore dell'anagrafica faceva già la cosa giusta
   * (`error-strong`, 4,92:1, `role="alert"`): due rossi diversi nella stessa card,
   * e quello rimasto indietro era l'unico a schermo intero.
   */
  it('errore di caricamento della scheda: `role="alert"` e inchiostro forte', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/admin/staff')) return ok({ success: false, error: 'boom' }, 500)
      return serverPredefinito(String(url))
    })
    render(<StaffDetailPanel staffId={STAFF_ID} onClose={vi.fn()} />)
    const fascia = await waitFor(() => {
      const n = document.querySelector('[role="alert"]')
      expect(n).not.toBeNull()
      return n as HTMLElement
    })
    expect(fascia.className).toContain('bg-kidville-error-soft')
    expect(fascia.className).toContain('text-kidville-error-strong')
    // `error` da solo è il token a 3,70:1: non deve tornare, nemmeno accanto al forte.
    expect(fascia.className.split(/\s+/)).not.toContain('text-kidville-error')
  })

  /**
   * IL TERZO ROSSO, trovato mentre si cercavano i due. `hover:text-kidville-error`
   * sul «Annulla» del piede misura **4,23:1** su bianco — sotto AA, e proprio
   * nello stato in cui il bottone si sta per premere. Si guarda il SORGENTE e non
   * il DOM perché uno stato `:hover` in jsdom non esiste: una prova che lo
   * «misurasse» sarebbe verde su qualunque cosa.
   */
  it('nella scheda non resta nessun inchiostro `error` debole: i rossi sono uno solo', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/components/features/admin/StaffDetailPanel.tsx'), 'utf8')
    // Controllo POSITIVO: il file usa davvero il token forte, altrimenti la
    // ricerca negativa qui sotto passerebbe su un file rinominato o svuotato.
    expect(src).toContain('text-kidville-error-strong')
    const deboli = [...src.matchAll(/[\w:]*text-kidville-error\b(?!-)/g)].map((m) => m[0])
    expect(deboli, 'Su fondo chiaro `error` sta a 4,23:1 (bianco) e 3,70:1 (error-soft): si usa `error-strong`.').toEqual([])
  })

  it('e le DUE fasce rosse della scheda dicono la stessa cosa nello stesso modo', async () => {
    rispostaAnagrafica = 'errore'
    const { container } = await montaScheda()
    await apriTab('Anagrafica')
    const fasce = [...container.querySelectorAll('[role="alert"]')].filter((n) => n.className.includes('bg-kidville-error-soft'))
    expect(fasce.length).toBeGreaterThan(0)
    for (const f of fasce) {
      expect(f.className).toContain('text-kidville-error-strong')
      expect(f.className.split(/\s+/)).not.toContain('text-kidville-error')
    }
  })
})

describe('scheda staff · in modalità MODIFICA i comandi hanno un nome e uno stato', () => {
  /** Apre «Modifica» e aspetta che i due menu ci siano. */
  async function apriModifica(container: HTMLElement) {
    fireEvent.click(screen.getByRole('button', { name: /^Modifica$/ }))
    await waitFor(() => expect(container.querySelectorAll('select').length).toBe(2))
  }

  /**
   * IL DIFETTO, MISURATO con axe-core nel browser vero sullo stato
   * `incarico-editmode`: regola `label`, impatto **critical**, 2 nodi — «Form
   * element does not have an explicit <label>». Le `<label>` erano elementi
   * FRATELLI senza `for` e i `<select>` non avevano né `id` né `aria-label`: uno
   * screen reader annunciava «menu» due volte, per due comandi di cui uno cambia
   * il RUOLO e l'altro la SEDE.
   *
   * Ed era invisibile ai test: i tre `axe()` del giro precedente coprivano
   * Anagrafica pronta, stato vuoto e riga fusa — mai la modalità di modifica.
   * «Nessuna violazione axe» valeva su tre schermate su otto.
   */
  it('le due tendine hanno un nome accessibile, e sono DUE nomi diversi', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriModifica(container)
    const ruolo = screen.getByLabelText('Ruolo')
    const sede = screen.getByLabelText('Sede')
    expect(ruolo.tagName).toBe('SELECT')
    expect(sede.tagName).toBe('SELECT')
    expect(ruolo).not.toBe(sede)
  })

  it('nessuna violazione axe in modalità modifica (la schermata che nessun test guardava)', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriModifica(container)
    expect(await axe(container)).toHaveNoViolations()
  })

  /**
   * IL DIFETTO, MISURATO sul DOM: le pillole con cui la Direzione assegna
   * un'insegnante a una classe portavano lo stato nel SOLO riempimento —
   * assegnata `bg-kidville-green text-kidville-white`, non assegnata
   * `bg-kidville-white text-kidville-sub`, testo identico, **0 attributi ARIA**.
   * Chi non distingue i colori, o chi ascolta, non aveva modo di sapere quali
   * classi fossero assegnate mentre le stava cambiando: WCAG 1.4.1 e 4.1.2, su un
   * comando che decide chi entra in quale classe.
   */
  it('le pillole delle classi espongono lo stato: `aria-pressed`, non solo il colore', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriModifica(container)
    const pillola = screen.getByRole('button', { name: /3 ANNI/ })
    // `sez-1` è assegnata nel banco di prova: lo stato di partenza è «premuta».
    expect(pillola).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(pillola)
    await waitFor(() => expect(screen.getByRole('button', { name: /3 ANNI/ })).toHaveAttribute('aria-pressed', 'false'))
    expect(container.querySelectorAll('button[aria-pressed]').length).toBeGreaterThan(3) // 3 linguette + le pillole
  })

  it('e portano un’ICONA che cambia forma, perché il colore da solo non informa', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriModifica(container)
    const pillola = screen.getByRole('button', { name: /3 ANNI/ })
    // Due forme diverse — spunta e più — non due tinte dello stesso segno.
    const assegnata = pillola.querySelector('svg')?.getAttribute('class') ?? ''
    expect(assegnata).toContain('lucide-check')
    fireEvent.click(pillola)
    await waitFor(() => {
      const dopo = screen.getByRole('button', { name: /3 ANNI/ }).querySelector('svg')?.getAttribute('class') ?? ''
      expect(dopo).toContain('lucide-plus')
    })
  })

  it('il bersaglio della pillola arriva a 44px come gli altri comandi della scheda', async () => {
    // ⚠️ Si misura la CLASSE e non il pixel: jsdom non impagina. Il pixel è stato
    // misurato in Chrome una volta (54,5×**26,5**, il comando più piccolo della
    // scheda); questo lock sorveglia che la dichiarazione che lo alza non sparisca.
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriModifica(container)
    expect(screen.getByRole('button', { name: /3 ANNI/ }).className).toContain('min-h-[44px]')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// IL PERIMETRO DELLA PILLOLA — si RISOLVE la cascata di `globals.css` e si MISURA
// il rapporto, invece di guardare le classi.
//
// IL DIFETTO, misurato nel browser vero (pannello reso a 1024 px, calcolo WCAG su
// `getComputedStyle`): la pillola NON assegnata aveva riempimento identico alla
// card — `bg-kidville-white` su `bg-kidville-white`, **1,00:1** — e come unico
// confine un bordo `#EFE7DC` da 1 px, **1,23:1** su bianco. Soglia WCAG 2.2 AA
// §1.4.11 = 3:1. La pillola assegnata, piena di verde, misurava 6,51:1: il
// perimetro serviva solo a quella che NON ce l'aveva.
//
// ⚠️ PERCHÉ UN TEST SULLE CLASSI NON POTEVA VEDERLO, ed è il motivo per cui questo
// blocco pesa più degli altri. Le classi erano GIUSTE: `border-kidville-line` è il
// token del repo, scritto come lo scrive ogni altro componente. A mancare era una
// regola in `globals.css` — il rimedio che questo repo ha già scritto DUE volte,
// per `input|select|textarea` (2026-08-08) e per la `label` delle card di scelta
// (2026-08-11), e che non ha mai elencato `button`. La prova che la cascata
// funzionava e che mancava solo l'elemento sta due sezioni sopra NELLA STESSA
// SCHERMATA: il `<select>` del ruolo prende il suo contorno da quelle stesse
// regole. Perciò qui si legge il CSS vero, si chiede a jsdom quali regole
// colpiscono l'elemento vero, si ordina come fa un browser e si misura.
// ═══════════════════════════════════════════════════════════════════════════════

const CSS_GLOBALS = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')

/** WCAG 2.x — rapporto di contrasto fra due colori opachi. */
const canale = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const luminanza = (hex: string) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
}
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)]
  const [alto, basso] = x > y ? [x, y] : [y, x]
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}

type Regola = { sel: string; corpo: string; ordine: number }

/**
 * Le regole di PRIMO LIVELLO del foglio. I commenti si tolgono PRIMA di
 * scandire le graffe: `globals.css` è per due terzi prosa, e un `{` dentro un
 * commento sposterebbe ogni regola successiva di un blocco — un parser che
 * sbaglia in silenzio è peggio di nessun parser.
 */
function blocchiTopLevel(css: string): Regola[] {
  const pulito = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Regola[] = []
  let i = 0
  while (i < pulito.length) {
    const apre = pulito.indexOf('{', i)
    if (apre === -1) break
    // ⚠️ Le istruzioni di primo livello (`@import "tailwindcss";`) restano
    // incollate al selettore che segue: senza questo taglio il primo blocco del
    // foglio si chiamerebbe `@import …; @theme inline` e i token non si
    // troverebbero — il modo silenzioso in cui un parser sbaglia tutto.
    const sel = (pulito.slice(i, apre).split(';').pop() ?? '').trim()
    let d = 1
    let j = apre + 1
    while (j < pulito.length && d > 0) {
      if (pulito[j] === '{') d++
      else if (pulito[j] === '}') d--
      j++
    }
    if (sel) out.push({ sel, corpo: pulito.slice(apre + 1, j - 1), ordine: out.length })
    i = j
  }
  return out
}

/** Le sole regole vere: le at-rule (`@media`, `@layer`, `@theme`) non colpiscono nessuno. */
const regoleTopLevel = (css: string) => blocchiTopLevel(css).filter((r) => !r.sel.startsWith('@'))

/**
 * La specificità di un selettore semplice, nella forma `[id, classi, elementi]`.
 * `:not(X)`/`:is(X)` valgono quanto il loro argomento (qui sempre un selettore
 * singolo, quindi il conto è esatto), `:where(X)` vale zero.
 */
function specificita(sel: string): [number, number, number] {
  let s = sel.trim()
  s = s.replace(/:where\([^()]*\)/g, ' ')
  s = s.replace(/:(?:not|is|has)\(([^()]*)\)/g, ' $1 ')
  let a = 0
  let b = 0
  let c = 0
  s = s.replace(/\[[^\]]*\]/g, () => { b++; return ' ' })
  s = s.replace(/#[\w-]+/g, () => { a++; return ' ' })
  s = s.replace(/\.[\w-]+/g, () => { b++; return ' ' })
  s = s.replace(/::[\w-]+/g, () => { c++; return ' ' })
  s = s.replace(/:[\w-]+/g, () => { b++; return ' ' })
  for (const t of s.match(/[a-zA-Z][\w-]*/g) ?? []) if (t) c++
  return [a, b, c]
}

const piuSpecifico = (x: [number, number, number], y: [number, number, number]) =>
  x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2]

/**
 * I token del tema BASE, per sciogliere le `var()`. Stanno in `@theme inline` —
 * non in `:root` — ed è proprio quello il motivo per cui il repo ha dovuto
 * scrivere queste regole invece di rimappare un token: `@theme inline` INLINA
 * l'hex dentro ogni utility, quindi cambiare il token non raggiungerebbe le 783
 * `border-kidville-line` già scritte. Il blocco `[data-contrast="high"]` è
 * escluso di proposito: qui si misura la luce normale.
 */
function tokenBase(css: string): Record<string, string> {
  const fuori: Record<string, string> = {}
  for (const r of blocchiTopLevel(css)) {
    if (r.sel !== ':root' && !/^@theme\b/.test(r.sel)) continue
    for (const m of r.corpo.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) fuori[m[1]] = m[2].trim()
  }
  return fuori
}

/**
 * Il `border-color` che VINCE su questo elemento, risolto come farebbe un
 * browser: si tengono le regole che lo colpiscono davvero (`Element.matches`,
 * cioè il matcher CSS reale di jsdom), si ordinano per specificità e poi per
 * posizione nel file, e si scioglie la `var()`. `null` = nessuna regola del
 * foglio lo tocca, quindi resta quello che dice la utility Tailwind.
 */
function bordoRisolto(el: Element, css: string, stato: 'riposo' | 'hover' = 'riposo'): string | null {
  const token = tokenBase(css)
  let vincitore: { spec: [number, number, number]; ordine: number; val: string } | null = null
  for (const r of regoleTopLevel(css)) {
    const dich = [...r.corpo.matchAll(/border-color\s*:\s*([^;]+);/g)].pop()
    if (!dich) continue
    for (const s of r.sel.split(',').map((x) => x.trim())) {
      /**
       * ⚠️ LO STATO SI DICHIARA, PERCHÉ jsdom NON LO SA.
       *
       * MISURATO scrivendo questa sonda: `el.matches('button[…]:hover')` in jsdom
       * torna **true** su un elemento che nessun mouse ha mai sfiorato, e la
       * prima versione del test ha risolto **#006A5F** — il verde dell'hover — su
       * una pillola a riposo. Se non ci fosse stata l'asserzione sul VALORE
       * esatto, «≥ 3:1» sarebbe passato lo stesso: verde su bianco è 6,51:1, e il
       * test avrebbe dichiarato verde una cosa che non stava misurando. Perciò lo
       * stato è un parametro, e a riposo le pseudo-classi dinamiche si escludono.
       */
      const dinamica = /:(?:hover|active|focus-visible|focus-within)\b/.test(s)
      if (stato === 'riposo' && dinamica) continue
      let colpisce = false
      try { colpisce = el.matches(s) } catch { colpisce = false }
      if (!colpisce) continue
      const spec = specificita(s)
      if (!vincitore || piuSpecifico(spec, vincitore.spec) || (!piuSpecifico(vincitore.spec, spec) && r.ordine >= vincitore.ordine)) {
        vincitore = { spec, ordine: r.ordine, val: dich[1].trim() }
      }
    }
  }
  if (!vincitore) return null
  const v = vincitore.val.match(/var\((--[\w-]+)\)/)
  return (v ? token[v[1]] : vincitore.val).toUpperCase()
}

/** Il CSS senza il blocco nuovo: è il controllo negativo, cioè il difetto. */
const CSS_SENZA_RIMEDIO = (() => {
  const pulito = CSS_GLOBALS.replace(/\/\*[\s\S]*?\*\//g, '')
  return pulito.replace(/(^|\})[^{}]*button\[class\*="border-kidville-[^{}]*\{[^{}]*\}/g, '$1')
})()

describe('scheda staff · il PERIMETRO della pillola che assegna una classe', () => {
  /** Apre «Modifica» e restituisce la pillola NON assegnata (si sgancia `3 ANNI`). */
  async function pillolaNonAssegnata(container: HTMLElement) {
    fireEvent.click(screen.getByRole('button', { name: /^Modifica$/ }))
    await waitFor(() => expect(container.querySelectorAll('select').length).toBe(2))
    const pillola = screen.getByRole('button', { name: /3 ANNI/ })
    fireEvent.click(pillola)
    await waitFor(() => expect(screen.getByRole('button', { name: /3 ANNI/ })).toHaveAttribute('aria-pressed', 'false'))
    return screen.getByRole('button', { name: /3 ANNI/ })
  }

  it('su una card bianca il contorno passa i 3:1 di WCAG 1.4.11', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    const pillola = await pillolaNonAssegnata(container)
    // Il riempimento NON aiuta e non può aiutare: la pillola è bianca sulla card
    // bianca. Il contorno è l'unica cosa che dice dove comincia il comando.
    expect(pillola.className).toContain('bg-kidville-white')
    const bordo = bordoRisolto(pillola, CSS_GLOBALS)
    expect(bordo, 'nessuna regola di globals.css tocca il bordo della pillola').not.toBeNull()
    // Il numero, non la soglia: `neutral` #8A958F su bianco. Era #EFE7DC → 1,23:1.
    expect(bordo).toBe('#7B8582')
    expect(contrasto(bordo as string, '#FFFFFF')).toBe(3.8)
    expect(contrasto(bordo as string, '#FFFFFF')).toBeGreaterThanOrEqual(3)
  })

  it('e sulla superficie CREMA della pagina admin vera, dove il rimedio bianco non basterebbe', async () => {
    // `admin/layout.tsx:32` avvolge il cockpit in `min-h-screen bg-kidville-cream`:
    // la scheda vive lì dentro. `neutral` su crema vale 2,79:1 — sotto soglia — ed
    // è esattamente il motivo per cui il blocco della crema esiste.
    rispostaAnagrafica = anagraficaCompleta()
    const guscio = document.createElement('div')
    guscio.className = 'min-h-screen bg-kidville-cream'
    document.body.appendChild(guscio)
    const { container } = render(<StaffDetailPanel staffId={STAFF_ID} onClose={vi.fn()} />, { container: guscio })
    await waitFor(() => expect(screen.getByRole('heading', { name: /Bianchi Maria/i })).toBeInTheDocument())
    const pillola = await pillolaNonAssegnata(container as HTMLElement)
    const bordo = bordoRisolto(pillola, CSS_GLOBALS)
    // `sub` #55615C, cioè lo stesso colore che il `<select>` due sezioni sopra
    // prende già da questa cascata — ed è il 6,46:1 con cui il critico ha
    // dimostrato che la regola funzionava e che mancava solo `button`.
    expect(bordo).toBe('#55615C')
    // Contro il riempimento bianco della pillola E contro la crema della pagina:
    // il confine si deve vedere da tutti e due i lati.
    expect(contrasto(bordo as string, '#FFFFFF')).toBe(6.46)
    expect(contrasto(bordo as string, '#FEF1E4')).toBe(5.82)
    expect(contrasto(bordo as string, '#FEF1E4')).toBeGreaterThanOrEqual(3)
  })

  it('⚠️ CONTROLLO NEGATIVO: togliendo il blocco nuovo la sonda torna a leggere 1,23:1', async () => {
    // Senza questa prova, «≥ 3:1» direbbe soltanto che la sonda non ha trovato
    // niente. Con il blocco tolto NESSUNA regola del foglio colpisce la pillola:
    // resta la utility Tailwind `border-kidville-line`, il cui hex è inlinato da
    // `@theme inline` — cioè il difetto, misurato dal test stesso.
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    const pillola = await pillolaNonAssegnata(container)
    expect(bordoRisolto(pillola, CSS_SENZA_RIMEDIO)).toBeNull()
    const line = tokenBase(CSS_GLOBALS)['--color-kidville-line']
    expect(line.toUpperCase()).toBe('#EFE7DC')
    expect(contrasto(line, '#FFFFFF')).toBe(1.23)
    expect(contrasto(line, '#FFFFFF')).toBeLessThan(3)
    // …e il riempimento non poteva aiutare: bianco su bianco è 1,00:1.
    expect(contrasto('#FFFFFF', '#FFFFFF')).toBe(1)
  })

  it('il comando resta REATTIVO: la regola dell’hover pesa più della utility del componente', async () => {
    // ⚠️ È l'inciampo già pagato dai 19 select del cockpit, raccontato in
    // `globals.css`: una regola non-layered a (0,2,1) batte
    // `.hover\:border-kidville-green:hover` (0,2,0), e il bordo smette di
    // rispondere al mouse. In jsdom lo stato `:hover` non esiste — un test che
    // «lo provasse» sarebbe verde su qualunque cosa — quindi si misura la sola
    // cosa misurabile e che è anche quella che decide: il peso dei due selettori.
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    const pillola = await pillolaNonAssegnata(container)
    expect(pillola.className).toContain('hover:border-kidville-green')
    const utility = specificita('.hover\\:border-kidville-green:hover')
    const regola = specificita('button[class*="border-kidville-line"]:hover:not(:focus)')
    expect(piuSpecifico(regola, utility)).toBe(true)
    expect(CSS_GLOBALS).toContain('button[class*="border-kidville-line"]:hover:not(:focus)')
    // E col mouse sopra il contorno MIGLIORA invece di peggiorare: verde pieno,
    // 6,51:1 su bianco. È la stessa uscita che il repo aveva già scelto per i 19
    // select del cockpit, quando la regola gliel'aveva spenta.
    const inHover = bordoRisolto(pillola, CSS_GLOBALS, 'hover')
    expect(inHover).toBe('#006A5F')
    expect(contrasto(inHover as string, '#FFFFFF')).toBe(6.51)
  })

  it('⚠️ e NON tocca ciò che non è un comando: le pillole dei gradi restano `<span>`', async () => {
    // Il perimetro del rimedio è stretto apposta. Due sezioni sopra, i gradi
    // portano lo stesso `border border-kidville-line` su uno `<span>`: non sono
    // controlli, e 1.4.11 parla di componenti d'interfaccia. Se un giorno il
    // selettore diventasse `[class*="border-kidville-line"]` senza elemento,
    // questo test lo direbbe.
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    const grado = [...container.querySelectorAll('span')].find((s) => s.textContent === 'infanzia')
    expect(grado, 'la pillola del grado «infanzia» non è più a schermo').toBeTruthy()
    expect(bordoRisolto(grado as Element, CSS_GLOBALS)).toBeNull()
  })
})

describe('scheda staff · le TENDINE e la X arrivano a 44px, come tutto il resto', () => {
  /**
   * IL DIFETTO, MISURATO con `getBoundingClientRect()` sul pannello vivo a
   * 1440 px DOPO che il resto era già stato alzato: `<select>` Ruolo
   * **418×34,5**, `<select>` Sede **418×34,5**, «Chiudi» **32×32**. Nella stessa
   * schermata: pillole 81,5×44, linguette 44, «Salva» 44, «Annulla» 44, «Copia il
   * link del modulo» 44. Cioè i 44 px erano stati messi ovunque tranne che sulle
   * due tendine che decidono RUOLO e SEDE — il campo su cui questo repo ha già
   * pagato «una route che indovina la sede archivia i dati nel plesso sbagliato in
   * silenzio» — e sul comando con cui si ESCE dal fascicolo di una persona.
   *
   * ⚠️ Si misura la CLASSE e non il pixel: jsdom non impagina,
   * `getBoundingClientRect()` restituisce zeri e un test che «misurasse» sarebbe
   * verde su qualunque cosa. Il pixel è stato misurato in Chrome; qui si sorveglia
   * che la dichiarazione che lo produce non sparisca.
   */
  async function apriModifica(container: HTMLElement) {
    fireEvent.click(screen.getByRole('button', { name: /^Modifica$/ }))
    await waitFor(() => expect(container.querySelectorAll('select').length).toBe(2))
  }

  it('le due tendine hanno il pavimento da 44px', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriModifica(container)
    for (const nome of ['Ruolo', 'Sede']) {
      const tendina = screen.getByLabelText(nome)
      expect(tendina.className, `la tendina «${nome}» è tornata sotto i 44px`).toContain('min-h-[44px]')
    }
  })

  it('e sono la STESSA stringa, non due copie che divergeranno', async () => {
    // Erano due `className` ribattuti a mano, identici carattere per carattere.
    // La prossima tendina scritta a mano nascerebbe di nuovo a 34,5 px.
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriModifica(container)
    expect(screen.getByLabelText('Ruolo').className).toBe(screen.getByLabelText('Sede').className)
    const src = fs.readFileSync(path.join(process.cwd(), 'src/components/features/admin/StaffDetailPanel.tsx'), 'utf8')
    expect(src).toContain('const TENDINA_44')
    expect([...src.matchAll(/className=\{TENDINA_44\}/g)]).toHaveLength(2)
  })

  it('la X di chiusura ha un nome accessibile che non è solo il `title`', async () => {
    // `title` non compare MAI su un touch e come nome accessibile è l'ultimo
    // ripiego dell'algoritmo: il repo ha già un lock che lo dice
    // (`nome-bottoni-icona.test.tsx`), solo che questa scheda non era nel suo
    // elenco. `getByRole` con `name` risolve l'accname vero.
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    const chiudi = screen.getByRole('button', { name: 'Chiudi' })
    expect(chiudi).toHaveAttribute('aria-label', 'Chiudi')
    expect(chiudi.className).toContain('h-11')
    expect(chiudi.className).toContain('w-11')
    expect(chiudi.className).not.toContain('h-8')
  })

  it('e la X chiama davvero `onClose` (il bersaglio è cresciuto, il comando è lo stesso)', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const chiudiSpy = vi.fn()
    render(<StaffDetailPanel staffId={STAFF_ID} onClose={chiudiSpy} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: /Bianchi Maria/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(chiudiSpy).toHaveBeenCalledTimes(1)
  })

  it('⚠️ nessun comando della scheda resta sotto la soglia: il pavimento vale per TUTTI', async () => {
    // Il controllo d'insieme, che è quello che il giro precedente non aveva: un
    // principio applicato dove non costava e sospeso dove costava non è un
    // principio. `Btn` e i comandi del cockpit hanno il proprio pavimento e non
    // si contano qui; si contano i comandi scritti in QUESTO file.
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    await apriModifica(container)
    const piccoli = [...container.querySelectorAll('button, select')].filter((el) => {
      const c = el.className
      // Le tre linguette prendono il pavimento dal CONTENITORE (`LINGUETTE_44`,
      // `[&>button]:min-h-[44px]`): `Tabs` è condiviso da sette schermate e il suo
      // `className` finisce sul contenitore, non sui bottoni. Vale lo stesso.
      const dalPadre = el.parentElement?.className.includes('[&>button]:min-h-[44px]') ?? false
      return !c.includes('min-h-[44px]') && !/\bh-11\b/.test(c) && !dalPadre
    })
    expect(piccoli.map((el) => `${el.tagName}:${el.textContent?.slice(0, 24)}`)).toEqual([])
  })
})

describe('scheda staff · a schermo non finisce MAI la prosa del database', () => {
  /**
   * IL DIFETTO, MISURATO nel sorgente: `admin/staff/route.ts:81` risponde
   * `{ error: error.message }` su 500 — cioè il testo di PostgREST/Supabase — e il
   * pannello scriveva `setErrore(j?.error || t('staffErrCaricamento'))`. Il primo
   * ramo vinceva SEMPRE, quindi il ripiego tradotto non si vedeva mai, e quella
   * fascia SOSTITUISCE l'intera scheda. Questo stesso lavoro l'aveva appena
   * portata da 3,70:1 a 4,92:1 e le aveva dato `role="alert"`: il risultato era
   * che il messaggio del database si leggeva meglio di prima e ora si sentiva
   * anche a voce.
   *
   * Non è teoria: sul DB E2E della CI, che non è migrato, un `42703` NOMINA
   * tabella e colonna. E in inglese la fascia restava comunque nella lingua del
   * database — sui 556+556 messaggi dei due cataloghi non può esistere una chiave
   * per quel testo.
   */
  function serverStaffRotto(messaggioDb: string, stato = 500) {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/admin/staff')) return ok({ success: false, error: messaggioDb }, stato)
      return serverPredefinito(String(url))
    })
  }

  it('la fascia rossa dice «Errore nel caricamento dello staff», non il nome di una colonna', async () => {
    serverStaffRotto('column utenti.ruolo_x does not exist')
    render(<StaffDetailPanel staffId={STAFF_ID} onClose={vi.fn()} />)
    const fascia = await waitFor(() => {
      const n = document.querySelector('[role="alert"]')
      expect(n).not.toBeNull()
      return n as HTMLElement
    })
    expect(fascia).toHaveTextContent('Errore nel caricamento dello staff')
    expect(fascia.textContent).not.toContain('column')
    expect(document.body.textContent).not.toContain('utenti.ruolo_x')
  })

  it('e in inglese è inglese, che con la stringa del database era impossibile', async () => {
    linguaCorrente = 'en'
    serverStaffRotto('column utenti.ruolo_x does not exist')
    render(<StaffDetailPanel staffId={STAFF_ID} onClose={vi.fn()} />)
    const fascia = await waitFor(() => {
      const n = document.querySelector('[role="alert"]')
      expect(n).not.toBeNull()
      return n as HTMLElement
    })
    expect(fascia).toHaveTextContent('Error loading staff')
  })

  it('il motivo non si BUTTA: si logga lo stato — e non il corpo, che può citare un dato personale', async () => {
    serverStaffRotto('duplicate key value violates unique constraint (email)=(maria.bianchi@example.test)')
    render(<StaffDetailPanel staffId={STAFF_ID} onClose={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull())
    const chiamate = vi.mocked(logClient).mock.calls.map(([a]) => a as unknown as Record<string, unknown>)
    const riga = chiamate.find((c) => c.messaggio === 'staff-scheda-non-letta')
    expect(riga, 'un errore che non si logga è un errore che non è successo').toBeTruthy()
    expect(riga?.stato).toBe(500)
    // La regola 8 di AGENTS.md, misurata invece che dichiarata.
    expect(JSON.stringify(chiamate)).not.toContain('maria.bianchi@example.test')
  })

  /**
   * ⚠️ IL RIFIUTO DEL SALVATAGGIO NON STA PIÙ IN UN `alert()`, dal 2026-09-04.
   *
   * La regola misurata qui non è cambiata di una virgola — «a schermo non finisce
   * MAI la prosa del database» — è cambiato DOVE si legge, e in meglio: una
   * finestra modale si chiude e non lascia niente, mentre il riquadro resta sotto
   * gli occhi di chi ha premuto, dentro un `role="alert"`. Il motivo del cambio è
   * un terzo fatto: il server manda un CODICE (`INCARICO_STAFF_RISERVATO`,
   * `SEDE_NON_ACCESSIBILE`) e i due `alert()` lo buttavano via, mostrando la stessa
   * frase per rifiuti diversi.
   */
  it('anche il rifiuto del SALVATAGGIO è tradotto, e sta in pagina: la Direzione non legge PostgREST', async () => {
    rispostaAnagrafica = anagraficaCompleta()
    const { container } = await montaScheda()
    fireEvent.click(screen.getByRole('button', { name: /^Modifica$/ }))
    await waitFor(() => expect(container.querySelectorAll('select').length).toBe(2))
    fetchMock.mockImplementation((url: string, opzioni?: { method?: string }) => {
      if (String(url).includes('/api/admin/staff') && opzioni?.method === 'PATCH') {
        return ok({ error: 'null value in column "scuola_id" violates not-null constraint' }, 500)
      }
      return serverPredefinito(String(url))
    })
    fireEvent.click(screen.getByRole('button', { name: /Salva/i }))
    const riquadro = await screen.findByTestId('staff-sede-errore')
    expect(riquadro.getAttribute('role')).toBe('alert')
    expect(riquadro).toHaveTextContent('Errore nel salvataggio')
    expect(riquadro.textContent).not.toContain('not-null constraint')
    expect(document.body.textContent).not.toContain('not-null constraint')
    // E il motivo non si butta: lo stato va nel log, il corpo no.
    const chiamate = vi.mocked(logClient).mock.calls.map(([a]) => a as unknown as Record<string, unknown>)
    expect(chiamate.some((c) => c.messaggio === 'staff-salvataggio-non-riuscito' && c.stato === 500)).toBe(true)
  })

  it('e quello delle CREDENZIALI: «l’email non è partita» resta scritto, il testo del provider no', async () => {
    // ⚠️ Il quarto esito era l'unico scritto dal server: `regenerate-credentials`
    // risponde `warning: "Email non inviata: <testo grezzo del provider>. …"` e il
    // pannello lo mostrava così com'era. Tre esiti su quattro passavano dal
    // catalogo; il quarto — cioè quello che si legge quando qualcosa è andato
    // storto — no. L'informazione non si perde: si traduce.
    rispostaAnagrafica = anagraficaCompleta()
    await montaScheda()
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/admin/regenerate-credentials')) {
        return ok({ warning: 'Email non inviata: the maria.bianchi@example.test domain is not verified. Comunicare le credenziali manualmente (PDF disponibile).' })
      }
      return serverPredefinito(String(url))
    })
    fireEvent.click(screen.getByRole('button', { name: /Rigenera credenziali/i }))
    await waitFor(() => expect(vi.mocked(globalThis.alert)).toHaveBeenCalled())
    const detto = vi.mocked(globalThis.alert).mock.calls.map(([m]) => String(m)).join(' | ')
    expect(detto).toContain('l’email non è partita')
    expect(detto).toContain('centro notifiche')
    expect(detto).not.toContain('domain is not verified')
    // Il caso resta tracciato, senza il testo del provider (che cita l'indirizzo).
    const chiamate = vi.mocked(logClient).mock.calls.map(([a]) => a as unknown as Record<string, unknown>)
    expect(chiamate.some((c) => c.messaggio === 'staff-credenziali-email-non-inviata')).toBe(true)
    expect(JSON.stringify(chiamate)).not.toContain('maria.bianchi@example.test')
  })

  it('⚠️ nel file non resta nessun `alert`/`setErrore` alimentato dalla risposta del server', () => {
    // Il lock d'insieme: i tre punti erano tre, e il quarto (`b.warning`) non era
    // nell'elenco di nessuno. Una ricerca sul sorgente è l'unica forma che vede
    // anche il quinto, il giorno in cui qualcuno lo scriverà.
    // ⚠️ I COMMENTI SI TOLGONO PRIMA. Il riquadro che spiega il difetto CITA la
    // riga sbagliata (`setErrore(j?.error || …)`) perché è l'unico modo di
    // raccontarlo: una ricerca sul file grezzo troverebbe la citazione e
    // resterebbe rossa per sempre — cioè il test smetterebbe di parlare del
    // codice e comincerebbe a parlare della sua documentazione.
    const src = fs
      .readFileSync(path.join(process.cwd(), 'src/components/features/admin/StaffDetailPanel.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const sospetti = [...src.matchAll(/(?:alert|setErrore)\([^)]*\b(?:j|b|body|corpo)\??\.(?:error|warning|message)/g)].map((m) => m[0])
    expect(sospetti, 'la prosa del server non si mostra: si traduce e si logga lo stato').toEqual([])
  })
})
