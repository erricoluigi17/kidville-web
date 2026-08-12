import { expect, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import { SEDE_A, SEDE_B, SEDE_C } from './sedi'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * GLI ATTREZZI DEI COLLAUDI DI `/anagrafica-personale`, in un posto solo.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ NON è un file di test: non contiene nessun `it()`, e vitest non lo raccoglie
 * (il pattern predefinito vuole `*.test.*`). Sta qui perché i sei collaudi del
 * modulo devono attraversare gli STESSI cinque passi per arrivare al riepilogo, e
 * cinque copie di quella traversata sono cinque occasioni perché un collaudo
 * misuri un modulo compilato in modo diverso dagli altri — cioè perché uno resti
 * verde su un difetto che un altro vede.
 *
 * ── DENTRO NON C'È NESSUN DATO DI PERSONA VERA ─────────────────────────────
 *
 * Il repository è pubblico. L'anagrafica di prova è inventata, l'email è del
 * dominio riservato agli esempi (`example.test`), il codice fiscale è una stringa
 * di forma valida che non appartiene a nessuno, e i toponimi con i loro codici
 * catastali sono dati aperti dell'Agenzia delle Entrate — non dati personali.
 *
 * ── E IL TEMPO NON SI LEGGE MAI DALL'OROLOGIO ──────────────────────────────
 *
 * Il wizard riceve `oggi` come parametro (vedi la sua firma), quindi i collaudi
 * che dipendono da una data la INIETTANO invece di costruirla rispetto
 * all'istante in cui girano. È la stessa disciplina di `scadenze.ts`, e chiude
 * per costruzione il difetto pagato il 12/08 su `parent-attendance-elenco`: un
 * test con date fisse nel futuro diventa rosso da solo il giorno in cui quel
 * futuro arriva.
 */

/** Il giorno civile con cui girano i collaudi. Iniettato, mai letto dall'orologio. */
export const OGGI = '2026-08-12'

/** Le tre sedi finte, coi nomi nella forma vera: marchio + comune. */
export const ALFA = { id: SEDE_A, nome: 'Kidville Aversa' }
export const BETA = { id: SEDE_B, nome: 'Kidville Cesa' }
export const GAMMA = { id: SEDE_C, nome: 'Kidville Giugliano' }
export const TRE_SEDI = [ALFA, BETA, GAMMA]

/** Toponimi e codici catastali: dati aperti dell'Agenzia, non dati di persone. */
export const COMUNI_NA = {
  comuni: [
    { belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true },
    { belfiore: 'E054', nome: 'GIUGLIANO IN CAMPANIA', sigla: 'NA', attivo: true },
  ],
}

/** Il percorso che la rotta di caricamento restituisce: due uuid, nessun nome di file. */
export const PERCORSO_SCANSIONE =
  'documenti/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf'

/** Come risponde `GET /api/iscrizione/sedi` a un tentativo. */
export type RispostaSedi =
  | { tipo: 'ok'; sedi: { id: string; nome: string }[] }
  | { tipo: 'corpo-strano' }
  | { tipo: 'http'; stato: number }
  | { tipo: 'rete' }

/** Come risponde `POST /api/iscrizione/personale` a un invio. */
export type EsitoInvio = { tipo: 'ok' } | { tipo: 'http'; stato: number; corpo: unknown }

/**
 * La firma con cui i collaudi chiamano la rete finta.
 *
 * È dichiarata perché un collaudo possa AVVOLGERLA — ritardare l'invio, guastare
 * il solo caricamento — e poi ricadere su di essa per tutto il resto: senza un
 * tipo, `rete.fetch(input, init)` è un `Mock` non chiamabile e `tsc` lo rifiuta.
 */
export type FintaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>

export interface ReteFinta {
  fetch: ReturnType<typeof vi.fn<FintaFetch>>
  /** I corpi JSON di ogni POST di invio, nell'ordine in cui sono partiti. */
  inviati: unknown[]
  /** Ogni URL chiamato: serve a dimostrare che nessun terzo viene interpellato. */
  chiamate: string[]
}

/**
 * La rete finta del modulo: elenco sedi, elenco comuni, caricamento e invio.
 *
 * `sedi[i]` è l'esito dell'i-esimo tentativo e l'ultimo vale per tutti i
 * successivi (serve a collaudare il «Riprova»); idem `invii`.
 */
export function reteFinta({
  sedi = [{ tipo: 'ok', sedi: TRE_SEDI }] as RispostaSedi[],
  invii = [{ tipo: 'ok' }] as EsitoInvio[],
  comuni = COMUNI_NA as unknown,
  caricamentoOk = true,
}: {
  sedi?: RispostaSedi[]
  invii?: EsitoInvio[]
  comuni?: unknown
  caricamentoOk?: boolean
} = {}): ReteFinta {
  const inviati: unknown[] = []
  const chiamate: string[] = []
  let tentativoSedi = 0
  let tentativoInvio = 0

  const risposta = (corpo: unknown, stato = 200) =>
    Promise.resolve({
      ok: stato >= 200 && stato < 300,
      status: stato,
      headers: { get: () => 'application/json' },
      json: async () => corpo,
    })

  const finta = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    chiamate.push(url)

    if (url.includes('/api/iscrizione/sedi')) {
      const r = sedi[Math.min(tentativoSedi, sedi.length - 1)]
      tentativoSedi += 1
      if (r.tipo === 'rete') return Promise.reject(new TypeError('Failed to fetch'))
      if (r.tipo === 'http') return risposta({ error: 'no' }, r.stato)
      if (r.tipo === 'corpo-strano') return risposta({ success: true })
      return risposta({ success: true, data: r.sedi })
    }

    if (url.includes('/api/anagrafiche/comuni')) return risposta(comuni)

    if (url.includes('/api/iscrizione/personale/upload')) {
      return caricamentoOk
        ? risposta({ path: PERCORSO_SCANSIONE })
        : risposta({ error: 'no', codice: 'ALLEGATO_NON_CARICATO' }, 500)
    }

    if (url.includes('/api/iscrizione/personale') && init?.method === 'POST') {
      inviati.push(JSON.parse(String(init.body)))
      const e = invii[Math.min(tentativoInvio, invii.length - 1)]
      tentativoInvio += 1
      if (e.tipo === 'http') return risposta(e.corpo, e.stato)
      return risposta({ id: 'pratica-finta', avvisi: [] }, 201)
    }

    return risposta({})
  })

  return { fetch: finta, inviati, chiamate }
}

// ── I comandi della schermata ────────────────────────────────────────────────

export const avanti = () => fireEvent.click(screen.getByRole('button', { name: itPublic.persAvanti }))
export const invia = () => fireEvent.click(screen.getByRole('button', { name: itPublic.persInvia }))
export const indietro = () =>
  fireEvent.click(screen.getByRole('button', { name: itPublic.persIndietro }))

/** Apre la tendina di un `Combobox` dal suo pulsante. */
export function apriTendina(campo: HTMLElement): void {
  const contenitore = campo.closest('div')?.parentElement as HTMLElement
  fireEvent.click(within(contenitore).getByRole('button', { name: /^Mostra o nascondi l’elenco/ }))
}

/**
 * Il campo della scansione.
 *
 * ⚠️ Dal 12/08/2026 è un controllo VERO e raggiungibile: `sr-only` invece di
 * `hidden`, con `id`, etichetta e `ref` (prima era `display:none`, cioè fuori
 * dalla tastiera e fuori dall'albero di accessibilità — vedi `FileField`). Qui
 * resta preso per selettore perché è il gesto di CARICAMENTO che serve a
 * dodici collaudi; che sia raggiungibile e nominato lo asserisce
 * `anagrafica-personale-a11y`, che è il posto in cui quella proprietà si difende.
 */
export function campoFile(): HTMLInputElement {
  const el = document.querySelector('input[type="file"]')
  if (el === null) throw new Error('il campo della scansione non è in pagina')
  return el as HTMLInputElement
}

// ── I cinque passi ───────────────────────────────────────────────────────────

/** Sceglie la sede (la prima, se non se ne indica un'altra) e prosegue. */
export async function passoSede(id: string = ALFA.id): Promise<void> {
  await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))
  fireEvent.click(document.getElementById(`pers-sede-${id}`) as HTMLElement)
  avanti()
}

/** Compila «I tuoi dati», luogo di nascita compreso, e prosegue. */
export async function passoDati({
  codiceFiscale = 'SPRMRA85C47F839K',
}: { codiceFiscale?: string } = {}): Promise<void> {
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Esempio' } })
  fireEvent.change(screen.getByLabelText(/^Sesso/), { target: { value: 'F' } })
  fireEvent.change(screen.getByLabelText(/^Data di nascita/), { target: { value: '1985-03-07' } })

  await scegliNapoli()

  fireEvent.change(screen.getByLabelText(/^Codice fiscale/), { target: { value: codiceFiscale } })
  fireEvent.change(screen.getByLabelText(/^Cittadinanza/), { target: { value: 'Italiana' } })
  fireEvent.change(screen.getByLabelText(/^Titolo di studio/), { target: { value: 'laurea_triennale' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Infanzia (3-6)' }))
  avanti()
}

/** La cascata del luogo di nascita: è l'unico modo di ottenere un codice catastale. */
export async function scegliNapoli(): Promise<void> {
  // ⚠️ Non `{ name: 'Provincia di nascita' }` esatto: dal 12/08/2026 l'etichetta
  // porta l'asterisco dell'obbligatorietà, che entra nel nome accessibile. Era
  // l'ultimo campo obbligatorio del passo a non averlo — vedi `obbligatori` nel
  // wizard e il vicolo cieco che quel segno esiste per chiudere.
  const provincia = screen.getByRole('combobox', { name: /^Provincia di nascita/ })
  apriTendina(provincia)
  fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
  const comune = () => screen.getByRole('combobox', { name: /Comune di nascita/ })
  await waitFor(() => expect(comune()).toBeEnabled())
  apriTendina(comune())
  fireEvent.click(screen.getByRole('option', { name: 'NAPOLI' }))
}

/** Compila «Residenza e recapiti» e prosegue. */
export async function passoResidenza({
  email = 'prova.esempio@example.test',
}: { email?: string } = {}): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText(/^Indirizzo di residenza/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/^Indirizzo di residenza/), { target: { value: 'Via Roma' } })
  fireEvent.change(screen.getByLabelText(/^Numero civico\s*\*?$/), { target: { value: '12' } })
  fireEvent.change(screen.getByLabelText(/^Comune di residenza/), { target: { value: 'Giugliano in Campania' } })
  fireEvent.change(screen.getByLabelText(/^Provincia di residenza/), { target: { value: 'NA' } })
  fireEvent.change(screen.getByLabelText(/^CAP\s*\*?$/), { target: { value: '80014' } })
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: email } })
  fireEvent.change(screen.getByLabelText(/^Numero di cellulare/), { target: { value: '+39 333 1234567' } })
  avanti()
}

/** Compila «Documento d'identità», scansione compresa, e prosegue. */
export async function passoDocumento({
  scadenza = '01/01/2030',
  prosegui = true,
}: { scadenza?: string; prosegui?: boolean } = {}): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText(/^Tipo di documento/)).toBeInTheDocument())
  fireEvent.change(screen.getByLabelText(/^Tipo di documento/), { target: { value: 'CI' } })
  fireEvent.change(screen.getByLabelText(/^Numero del documento/), { target: { value: 'AB1234567' } })
  fireEvent.change(screen.getByLabelText(/^Scadenza del documento/), { target: { value: scadenza } })
  await caricaScansione()
  if (prosegui) avanti()
}

/** Il nome del file finto: è anche il segnale che il caricamento è FINITO. */
export const NOME_SCANSIONE = 'documento.pdf'

/** Carica la scansione: il file è un PDF finto di tre byte. */
export async function caricaScansione(): Promise<void> {
  const file = new File(['%PD'], NOME_SCANSIONE, { type: 'application/pdf' })
  fireEvent.change(campoFile(), { target: { files: [file] } })
  // ⚠️ Si aspetta il NOME DEL FILE, non il percorso nel bucket — che dal
  // 12/08/2026 non si stampa più in pagina (era un doppio uuid del bucket
  // privato, illeggibile e da non far uscire: vedi `FileField`).
  // Il segnale è stretto identico: la riga del caricamento mostra
  // «Caricamento…» finché la richiesta è in volo e «Seleziona un file» se
  // fallisce — il nome del file compare SOLO quando il valore è arrivato nel
  // modulo.
  await waitFor(() => expect(screen.getByText(NOME_SCANSIONE)).toBeInTheDocument())
}

/** Spunta le tre prese visione obbligatorie e prosegue. */
export async function passoConsensi(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /informativa sulla privacy/i })).toBeInTheDocument(),
  )
  for (const nome of [
    /informativa sulla privacy/i,
    /dati sono veri/i,
    /copia del documento/i,
  ]) {
    fireEvent.click(screen.getByRole('checkbox', { name: nome }))
  }
  avanti()
}

/** I cinque passi in fila: si esce fermi sul riepilogo. */
export async function compilaFinoAlRiepilogo(opzioni: {
  sede?: string
  scadenza?: string
  codiceFiscale?: string
  email?: string
} = {}): Promise<void> {
  await passoSede(opzioni.sede)
  await passoDati({ codiceFiscale: opzioni.codiceFiscale })
  await passoResidenza({ email: opzioni.email })
  await passoDocumento({ scadenza: opzioni.scadenza })
  await passoConsensi()
  await waitFor(() => expect(screen.getByText(itPublic.persRiepilogoSede)).toBeInTheDocument())
}

/** Il valore mostrato nel riepilogo sotto una certa etichetta. */
export function valoreNelRiepilogo(etichetta: string): string {
  const nodo = screen.getByText(etichetta)
  const riga = nodo.parentElement as HTMLElement
  return (riga.querySelector('p:nth-of-type(2)') ?? riga.querySelector('ul'))?.textContent ?? ''
}
