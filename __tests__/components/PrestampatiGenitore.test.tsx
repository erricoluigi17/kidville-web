import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itGenitore from '../../messages/it/prestampatiGenitore.json'
import enGenitore from '../../messages/en/prestampatiGenitore.json'
import itShared from '../../messages/it/shared.json'

/**
 * I PRESTAMPATI DELLA FAMIGLIA — le quattro cose che, se si rompono, non se ne accorge
 * nessuno finché non lo dice un genitore.
 *
 * ─── PERCHÉ QUESTO FILE ─────────────────────────────────────────────────────────
 *
 * `PrestampatiGenitore` è nato con milleottocento righe e zero banchi di prova, e il
 * primo difetto trovato dal critico si dimostra con quaranta: i due «Riprova» non
 * riprovavano niente. `caricaElenco` è una `useCallback` con deps `[ready, userId,
 * alunnoId, t]`, e il gesto che c'era prima — rimettere nella tendina l'id che c'è già —
 * non ne cambia nessuna: `setAlunnoId(stesso valore)` è un bail-out di React e `t` è
 * memoizzato da `use-intl`. L'effetto non ripartiva; i due setState del gesto (errore
 * cancellato, caricamento acceso) sì. Restava uno spinner che mente, e con un figlio solo
 * l'unica via d'uscita era ricaricare la pagina.
 *
 * Le quattro cose sotto misura, nell'ordine in cui un genitore le incontra:
 *
 *  1. con DUE figli non si chiede niente al server finché non si sa di chi si parla — da
 *     qui si firma una scheda sanitaria, e un valore predefinito sarebbe la firma sul
 *     fascicolo del figlio sbagliato;
 *  2. «Riprova», sull'elenco e sul modulo, RICHIAMA la rotta (`fetch` da 1 a 2);
 *  3. i tre rami dell'esito della firma — archiviato, in attesa della Direzione, firmato
 *     ma non archiviato — dicono tre cose diverse e nessuno si traveste da un altro;
 *  4. l'esito non-erroneo dell'OTP viene ANNUNCIATO (`role="status"`), perché è l'unico
 *     modo in cui chi usa uno screen reader sa che il codice non risulta consegnato.
 *
 * ⚠️ SU COSA SI ASSERISCE. Il mock di `next-intl` di `test/setup.ts` non conosce il
 * namespace `prestampatiGenitore` e ignora i valori dei segnaposto: a schermo comparirebbe
 * il NOME della chiave, e ogni asserzione sarebbe verde su una stringa che nessun genitore
 * leggerà mai. Qui si risolve sul catalogo italiano vero — chiavi annidate comprese
 * (`modelli.schedaSanitaria`) — e si sostituiscono i `{segnaposto}` semplici, come fa
 * `CandidaturaInsegnanteWizard-forma-visiva.test.tsx`.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

const UTENTE = 'f0000000-0000-4000-8000-000000000001'

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: UTENTE, role: 'genitore', ready: true }),
}))

vi.mock('next-intl', async () => {
  const cataloghi: Record<string, Record<string, unknown>> = {
    prestampatiGenitore: (await import('../../messages/it/prestampatiGenitore.json')).default,
    common: (await import('../../messages/it/common.json')).default,
    shared: (await import('../../messages/it/shared.json')).default,
  }
  /** La foglia di un percorso puntato: `datiApp.titolo` sta due livelli sotto. */
  const foglia = (gruppo: Record<string, unknown> | undefined, chiave: string): string | undefined => {
    let corrente: unknown = gruppo
    for (const pezzo of chiave.split('.')) {
      if (typeof corrente !== 'object' || corrente === null) return undefined
      corrente = (corrente as Record<string, unknown>)[pezzo]
    }
    return typeof corrente === 'string' ? corrente : undefined
  }
  const risolvi = (ns: string | undefined, chiave: string, valori?: Record<string, unknown>): string => {
    const grezza = foglia(ns ? cataloghi[ns] : undefined, chiave) ?? (ns ? `${ns}.${chiave}` : chiave)
    if (!valori) return grezza
    // Solo i segnaposto semplici: le forme ICU (`{n, plural, …}`) restano com'è, e nessun
    // test qui asserisce su quelle.
    return grezza.replace(/\{(\w+)\}/g, (intero, nome: string) =>
      nome in valori ? String(valori[nome]) : intero,
    )
  }
  /**
   * ⚠️ IL TRADUTTORE VA MEMOIZZATO, e non è un dettaglio del finto.
   *
   * `use-intl` restituisce lo STESSO `t` fra un render e l'altro (`useMemo`), e questo
   * pannello ci conta: `caricaElenco` e `caricaDettaglio` sono `useCallback` con `t` fra le
   * dipendenze. Un finto che ne costruisce uno nuovo a ogni render cambia l'identità della
   * callback, l'effetto che la guarda riparte, chiama la rotta, aggiorna lo stato, ri-renderizza
   * — misurato: DUE chiamate per un caricamento solo, e la convergenza dipendeva solo dal fatto
   * che il secondo giro scrivesse gli stessi valori. Sarebbe stato un difetto del banco di
   * prova travestito da difetto del prodotto (o, peggio, viceversa).
   */
  const memorizzati = new Map<string, ReturnType<typeof crea>>()
  const crea = (ns?: string) => {
    const t = (chiave: string, valori?: Record<string, unknown>) => risolvi(ns, chiave, valori)
    return Object.assign(t, {
      rich: (chiave: string) => risolvi(ns, chiave),
      markup: (chiave: string) => risolvi(ns, chiave),
      raw: (chiave: string) => risolvi(ns, chiave),
      has: () => true,
    })
  }
  const useTranslations = (ns?: string) => {
    const chiave = ns ?? ''
    const gia = memorizzati.get(chiave)
    if (gia) return gia
    const nuovo = crea(ns)
    memorizzati.set(chiave, nuovo)
    return nuovo
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

import { PrestampatiGenitore } from '@/components/features/prestampati/PrestampatiGenitore'

// ─── Le fixture: nessun dato vero, nessun uuid di produzione ─────────────────────

const FIGLIO_A = { id: 'a1000000-0000-4000-8000-00000000000a', nome: 'Bimba', cognome: 'Di Prova' }
const FIGLIO_B = { id: 'b1000000-0000-4000-8000-00000000000b', nome: 'Bimbo', cognome: 'Di Prova' }

/** La voce d'elenco della scheda sanitaria, com'è dopo `motivoNonFirmabile()`: firmabile. */
const MODELLO_SANITARIO = {
  slug: 'scheda_sanitaria',
  etichetta: 'Scheda sanitaria',
  chiaveEtichetta: 'modelli.schedaSanitaria',
  firma: 'otp_genitore',
  soggetto: 'alunno',
  protocollo: 'nessuno',
  archiviazione: 'student_documents',
  firmabileOra: true,
  motivoNonFirmabile: null,
}

/** Il certificato di iscrizione e frequenza: lo firma la Scuola, e consuma un protocollo. */
const MODELLO_CERTIFICATO = {
  slug: 'certificato_iscrizione_frequenza',
  etichetta: 'Certificato di iscrizione e frequenza',
  chiaveEtichetta: 'modelli.certificatoIscrizioneFrequenza',
  firma: 'legale_rappresentante',
  soggetto: 'alunno',
  protocollo: 'uscita',
  archiviazione: 'student_documents',
  firmabileOra: false,
  motivoNonFirmabile: 'firma-della-scuola',
  documentoArchiviatoId: null,
  documentoArchiviatoIl: null,
}

/** Un campo solo, obbligatorio: quel che basta a percorrere compila → rivedi → firma. */
const CAMPO_PEDIATRA = {
  nome: 'pediatraNome',
  etichetta: 'Pediatra — nome e cognome',
  tipo: 'testo',
  obbligatorio: true,
}

/** Il n. 10: compare nell'elenco SOLO quando una gita esiste, e la scheda la descrive. */
const MODELLO_USCITA = {
  slug: 'autorizzazione_uscita',
  etichetta: 'Autorizzazione uscita didattica / gita',
  chiaveEtichetta: 'modelli.autorizzazioneUscita',
  firma: 'otp_genitore',
  soggetto: 'alunno',
  protocollo: 'nessuno',
  archiviazione: 'student_documents',
  firmabileOra: true,
  motivoNonFirmabile: null,
}

function elencoServito(
  alunnoId: string,
  modelli: unknown[] = [MODELLO_SANITARIO],
  uscita: unknown = null,
) {
  return {
    success: true,
    alunno: {
      id: alunnoId,
      cognome: 'Di Prova',
      nome: 'Bimba',
      dataNascita: '2021-03-04',
      luogoNascita: 'Città di Prova',
      // Il codice fiscale di un minore non entra in un repo pubblico nemmeno finto: la
      // schermata su `null` mostra «Non indicato», che è un ramo vero.
      codiceFiscale: null,
      sezione: 'Sezione di prova',
    },
    sede: { nome: 'Sede di prova', citta: 'Città di Prova' },
    annoScolastico: '2026/2027',
    uscita,
    modelli,
    modello: null,
    delegati: null,
    delegatiNonLetti: false,
  }
}

function dettaglioServito(alunnoId: string) {
  return {
    ...elencoServito(alunnoId),
    modello: {
      slug: MODELLO_SANITARIO.slug,
      etichetta: MODELLO_SANITARIO.etichetta,
      chiaveEtichetta: MODELLO_SANITARIO.chiaveEtichetta,
      firma: MODELLO_SANITARIO.firma,
      campi: [CAMPO_PEDIATRA],
    },
  }
}

/** Il 503 della rotta di lettura, col `codice` che il client traduce dal catalogo. */
const ELENCO_CADUTO = {
  ok: false,
  status: 503,
  corpo: {
    error: 'Non è stato possibile preparare la modulistica. Riprova fra qualche minuto.',
    codice: 'PRESTAMPATO_ANAGRAFICA_NON_LETTA',
  },
}

// ─── Il banco: `fetch` finto, una coda di risposte per porta ─────────────────────

interface Risposta {
  ok: boolean
  status: number
  corpo: unknown
}

const fetchMock = vi.fn()

function comeRisposta(r: Risposta) {
  return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.corpo })
}

/**
 * Le quattro porte che questo pannello tocca. Elenco e dettaglio accettano una SEQUENZA:
 * è il modo di provare che «Riprova» chiede davvero un'altra volta — la seconda risposta
 * arriva solo se la seconda chiamata parte. Esaurita la sequenza, si ripete l'ultima.
 */
function armaFetch(banco: {
  elenco?: Risposta[]
  dettaglio?: Risposta[]
  otp?: Risposta
  firma?: Risposta
  documento?: Risposta
}): void {
  const contati: Record<'elenco' | 'dettaglio', number> = { elenco: 0, dettaglio: 0 }
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    // La firma sta sotto lo stesso prefisso dell'elenco: si guarda per prima, o ogni POST
    // finirebbe nella coda delle letture.
    if (url.startsWith('/api/parent/prestampati/firma')) {
      const scelta = (init?.method ?? 'GET') === 'POST' ? banco.otp : banco.firma
      return comeRisposta(scelta ?? { ok: true, status: 200, corpo: { success: true } })
    }
    // Il POST sull'elenco è la porta del certificato: stesso URL della lettura, metodo
    // diverso. Si guarda PRIMA del ramo delle letture, o finirebbe nella loro coda.
    if (url.startsWith('/api/parent/prestampati') && (init?.method ?? 'GET') === 'POST') {
      return comeRisposta(
        banco.documento ?? { ok: true, status: 201, corpo: { success: true, url: null } },
      )
    }
    if (url.startsWith('/api/parent/prestampati')) {
      const quale = url.includes('&slug=') ? 'dettaglio' : 'elenco'
      const coda = (quale === 'elenco' ? banco.elenco : banco.dettaglio) ?? []
      const r = coda[Math.min(contati[quale], coda.length - 1)]
      contati[quale] += 1
      return comeRisposta(r ?? { ok: true, status: 200, corpo: { success: true } })
    }
    return comeRisposta({ ok: true, status: 200, corpo: {} })
  })
}

/** Le chiamate fatte a una delle due letture, per distinguerle nei conteggi. */
function chiamate(filtro: 'elenco' | 'dettaglio' | 'firma'): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((url) => {
      if (filtro === 'firma') return url.startsWith('/api/parent/prestampati/firma')
      if (url.startsWith('/api/parent/prestampati/firma')) return false
      return filtro === 'dettaglio' ? url.includes('&slug=') : !url.includes('&slug=')
    })
}

const OTP_INVIATO: Risposta = {
  ok: true,
  status: 200,
  corpo: { success: true, email: 'genitore@example.test', expiry: 0, ticket: 'biglietto-finto', sent: true },
}

/** L'`expiry` va nel futuro al momento del test, non a un istante scritto a mano. */
function otpInviato(sent = true): Risposta {
  return {
    ok: true,
    status: 200,
    corpo: { ...(OTP_INVIATO.corpo as object), expiry: Date.now() + 10 * 60 * 1000, sent },
  }
}

// ─── I percorsi, scritti una volta ──────────────────────────────────────────────

/** Dall'elenco fino al passo «Firma»: modulo scelto, campo compilato, codice chiesto. */
async function finoAlCodice(): Promise<void> {
  fireEvent.click(
    (await screen.findByText(itGenitore.modelli.schedaSanitaria)).closest('button') as HTMLElement,
  )

  const campo = await screen.findByLabelText(new RegExp(CAMPO_PEDIATRA.etichetta.split(' —')[0]))
  fireEvent.change(campo, { target: { value: 'Dottoressa di prova' } })

  fireEvent.click(screen.getByRole('button', { name: itGenitore.rivedi }))
  await screen.findByText(itGenitore.riepilogoTitolo)

  fireEvent.click(screen.getByRole('button', { name: itGenitore.otpInvia }))
  await screen.findByText(itGenitore.otpTitolo)
}

/** …e fino in fondo: sei cifre e «Firma il modulo». */
async function firmaFinoAllEsito(): Promise<void> {
  await finoAlCodice()
  fireEvent.change(screen.getByLabelText(itGenitore.otpCodice), { target: { value: '123456' } })
  fireEvent.click(screen.getByRole('button', { name: itGenitore.otpConferma }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

describe('PrestampatiGenitore — con due figli non si indovina di chi si parla', () => {
  it('due figli e nessuno scelto: nessuna chiamata finché il genitore non lo dice', async () => {
    armaFetch({ elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_B.id) }] })
    render(<PrestampatiGenitore figli={[FIGLIO_A, FIGLIO_B]} />)

    // La tendina è sul segnaposto, non sul primo figlio: è il punto di tutto il selettore.
    const tendina = screen.getByLabelText(itGenitore.scegliFiglio) as HTMLSelectElement
    expect(tendina.value).toBe('')
    expect(screen.getByText(itGenitore.scegliFiglioSegnaposto)).toBeInTheDocument()
    // E soprattutto: al server non è stato chiesto niente, perché non c'è ancora niente da
    // chiedere. Da qui si firma: un valore predefinito qui è una firma sul fascicolo
    // sbagliato, non una comodità.
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.change(tendina, { target: { value: FIGLIO_B.id } })

    await waitFor(() => expect(chiamate('elenco')).toHaveLength(1))
    expect(chiamate('elenco')[0]).toContain(encodeURIComponent(FIGLIO_B.id))
    expect(chiamate('elenco')[0]).not.toContain(encodeURIComponent(FIGLIO_A.id))
  })

  it('un figlio solo: la scelta è già fatta e l’elenco parte da sé', async () => {
    armaFetch({ elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id) }] })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    await screen.findByText(itGenitore.modelli.schedaSanitaria)
    expect(chiamate('elenco')).toHaveLength(1)
    // Chiedere un tocco in più a chi non ha alternative è solo attrito: l'ambiguità da
    // risolvere nasce da due figli in su.
    expect((screen.getByLabelText(itGenitore.scegliFiglio) as HTMLSelectElement).value).toBe(
      FIGLIO_A.id,
    )
  })
})

describe('PrestampatiGenitore — «Riprova» richiama la rotta', () => {
  it('elenco caduto: il clic fa partire una SECONDA chiamata, e l’elenco compare', async () => {
    armaFetch({
      elenco: [ELENCO_CADUTO, { ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id) }],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    // Il testo dell'errore viene dal CODICE, non dalla prosa italiana del server: l'app è
    // bilingue e il server no.
    await screen.findByText(itShared.errorePrestampatoAnagraficaNonLetta)
    expect(chiamate('elenco')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: itGenitore.riprova }))

    // ⚠️ È QUI CHE IL DIFETTO SI VEDEVA: prima il conteggio restava a 1, l'errore spariva e
    // la schermata si piantava su «Caricamento…» per sempre.
    await waitFor(() => expect(chiamate('elenco')).toHaveLength(2))
    await screen.findByText(itGenitore.modelli.schedaSanitaria)
    expect(screen.queryByText(itShared.errorePrestampatoAnagraficaNonLetta)).not.toBeInTheDocument()
    expect(screen.queryByText(itGenitore.caricamento)).not.toBeInTheDocument()
  })

  it('modulo caduto: stessa cosa sul dettaglio, senza uscire dal modulo scelto', async () => {
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id) }],
      dettaglio: [ELENCO_CADUTO, { ok: true, status: 200, corpo: dettaglioServito(FIGLIO_A.id) }],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    fireEvent.click(
      (await screen.findByText(itGenitore.modelli.schedaSanitaria)).closest('button') as HTMLElement,
    )

    await screen.findByText(itShared.errorePrestampatoAnagraficaNonLetta)
    expect(chiamate('dettaglio')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: itGenitore.riprova }))

    await waitFor(() => expect(chiamate('dettaglio')).toHaveLength(2))
    // Il campo del modulo c'è: la seconda risposta è arrivata dove doveva.
    await screen.findByLabelText(new RegExp(CAMPO_PEDIATRA.etichetta.split(' —')[0]))
    expect(screen.queryByText(itGenitore.caricamento)).not.toBeInTheDocument()
    // E lo slug non si è perso per strada: la seconda chiamata è dello stesso modulo.
    expect(chiamate('dettaglio')[1]).toContain(`slug=${MODELLO_SANITARIO.slug}`)
  })
})

describe('PrestampatiGenitore — i tre rami dell’esito, e nessuno si traveste da un altro', () => {
  /** Il banco completo, con l'esito del PATCH che il singolo caso vuole provare. */
  function armaPercorsoDiFirma(esito: unknown, stato = 201): void {
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id) }],
      dettaglio: [{ ok: true, status: 200, corpo: dettaglioServito(FIGLIO_A.id) }],
      otp: otpInviato(),
      firma: { ok: true, status: stato, corpo: esito },
    })
  }

  it('archiviato: la scuola ce l’ha, e il PDF si apre dal collegamento firmato', async () => {
    armaPercorsoDiFirma({
      success: true,
      documentoId: 'd0000000-0000-4000-8000-000000000001',
      archiviato: true,
      inAttesaAccettazione: false,
      riferimentoFirma: 'firma-finta-0001',
      titolo: 'Scheda sanitaria',
      url: 'https://esempio.test/prestampato.pdf',
      signature_log: { signed_at: '2026-08-14T09:30:00.000Z' },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)
    await firmaFinoAllEsito()

    await screen.findByText(itGenitore.confermaTitolo)
    expect(screen.getByText(itGenitore.confermaTesto)).toBeInTheDocument()
    // Il ramo felice NON deve nominare né l'attesa né il mancato archivio.
    expect(screen.queryByText(itGenitore.inAttesaDirezioneTitolo)).not.toBeInTheDocument()
    expect(screen.queryByText(itGenitore.mancatoArchivioTitolo)).not.toBeInTheDocument()
    // `url` presente: il download è un collegamento, non un bottone che decodifica base64.
    const scarica = screen.getByRole('link', { name: itGenitore.scarica })
    expect(scarica).toHaveAttribute('href', 'https://esempio.test/prestampato.pdf')
    expect(screen.getByText('firma-finta-0001')).toBeInTheDocument()
  })

  it('in attesa della Direzione: lo dice, e insiste sul PDF che è l’unica copia', async () => {
    armaPercorsoDiFirma({
      success: true,
      documentoId: null,
      archiviato: false,
      inAttesaAccettazione: true,
      motivoMancatoArchivio: null,
      riferimentoFirma: 'firma-finta-0002',
      titolo: 'Autorizzazione somministrazione farmaci',
      url: null,
      pdfBase64: 'JVBERi0xLjQK',
      signature_log: { signed_at: '2026-08-14T09:31:00.000Z' },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)
    await firmaFinoAllEsito()

    await screen.findByText(itGenitore.inAttesaDirezioneTitolo)
    expect(screen.getByText(itGenitore.inAttesaDirezioneTesto)).toBeInTheDocument()
    // ⚠️ «Firmato» non è «archiviato»: se comparisse la frase del ramo felice, la famiglia
    // crederebbe che il farmaco si possa già somministrare.
    expect(screen.queryByText(itGenitore.confermaTitolo)).not.toBeInTheDocument()
    expect(screen.queryByText(itGenitore.confermaTesto)).not.toBeInTheDocument()
    // Il PDF viaggia solo dentro la risposta: il comando c'è ed è un bottone, non un link.
    expect(screen.getByRole('button', { name: itGenitore.scarica })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: itGenitore.scarica })).not.toBeInTheDocument()
  })

  it('firmato ma non archiviato: si legge il motivo esatto, non una frase generica', async () => {
    armaPercorsoDiFirma({
      success: true,
      documentoId: null,
      archiviato: false,
      inAttesaAccettazione: false,
      motivoMancatoArchivio: 'schema-non-pronto',
      riferimentoFirma: 'firma-finta-0003',
      titolo: 'Scheda sanitaria',
      url: null,
      pdfBase64: 'JVBERi0xLjQK',
      signature_log: { signed_at: '2026-08-14T09:32:00.000Z' },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)
    await firmaFinoAllEsito()

    await screen.findByText(itGenitore.mancatoArchivioTitolo)
    expect(screen.getByText(itGenitore.mancatoArchivioSchemaNonPronto)).toBeInTheDocument()
    // L'enumerato si traduce nella sua voce, non nel ripiego generico dell'ultimo caso.
    expect(screen.queryByText(itGenitore.mancatoArchivioArchivioNonScritto)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: itGenitore.scarica })).toBeInTheDocument()
  })

  it('il codice sbagliato non manda avanti: si resta al passo della firma, con il perché', async () => {
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id) }],
      dettaglio: [{ ok: true, status: 200, corpo: dettaglioServito(FIGLIO_A.id) }],
      otp: otpInviato(),
      firma: { ok: false, status: 401, corpo: { error: 'no', motivo: 'non-valido' } },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)
    await firmaFinoAllEsito()

    await screen.findByText(itGenitore.otpErrato)
    expect(screen.queryByText(itGenitore.confermaTitolo)).not.toBeInTheDocument()
    // Il campo del codice è ancora lì: si corregge senza rifare tutto il modulo.
    expect(screen.getByLabelText(itGenitore.otpCodice)).toBeInTheDocument()
  })
})

describe('PrestampatiGenitore — quello che va detto, si dice anche a chi non guarda', () => {
  it('il codice non consegnato viene ANNUNCIATO, non solo dipinto', async () => {
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id) }],
      dettaglio: [{ ok: true, status: 200, corpo: dettaglioServito(FIGLIO_A.id) }],
      otp: otpInviato(false),
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)
    await finoAlCodice()

    // `role="status"`: senza, chi usa uno screen reader preme «rimandamelo» e non sente
    // nulla — nemmeno che il codice non risulta consegnato, che è l'avviso che cambia il
    // da farsi (si scrive alla segreteria invece di aspettare).
    const annuncio = await screen.findByRole('status')
    expect(annuncio).toHaveTextContent(itGenitore.otpNonConsegnato)
  })

  it('il modulo sanitario avverte PRIMA che il genitore scriva', async () => {
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id) }],
      dettaglio: [{ ok: true, status: 200, corpo: dettaglioServito(FIGLIO_A.id) }],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    fireEvent.click(
      (await screen.findByText(itGenitore.modelli.schedaSanitaria)).closest('button') as HTMLElement,
    )

    const avviso = await screen.findByText(itGenitore.avvisoSanitario)
    const campo = await screen.findByLabelText(new RegExp(CAMPO_PEDIATRA.etichetta.split(' —')[0]))
    // `DOCUMENT_POSITION_FOLLOWING` = il campo viene DOPO l'avviso: chi legge dall'alto lo
    // incontra prima di digitare, e chi tabula lo incontra prima di arrivarci.
    expect(avviso.compareDocumentPosition(campo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('PrestampatiGenitore — il certificato si riprende, non si riemette', () => {
  /** Il certificato già emesso una volta: nel fascicolo c'è, con la sua data. */
  const CERTIFICATO_IN_ARCHIVIO = {
    ...MODELLO_CERTIFICATO,
    documentoArchiviatoId: 'c0000000-0000-4000-8000-00000000000c',
    documentoArchiviatoIl: '2026-08-15T09:00:00.000Z',
  }

  /** Il corpo di una richiesta al POST dell'elenco, per leggere `nuovo`. */
  function corpoDocumento(i: number): Record<string, unknown> {
    const chiamata = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST' && !String(c[0]).includes('/firma'),
    )[i]
    return JSON.parse(String((chiamata?.[1] as RequestInit).body))
  }

  it('mai emesso: il pulsante GENERA, e «Generane uno nuovo» non esiste', async () => {
    // Prima della prima emissione non c'è niente da riscaricare, e offrire «generane uno
    // nuovo» chiederebbe di scegliere fra due cose di cui una non esiste.
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id, [MODELLO_CERTIFICATO]) }],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    expect(await screen.findByRole('button', { name: itGenitore.certificatoGenera })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itGenitore.certificatoNuovo })).toBeNull()
  })

  it('già emesso: il gesto normale RISCARICA, e «uno nuovo» è un secondo comando esplicito', async () => {
    // La regola del titolare: «quando lo va a riprendere riscarica sempre lo stesso». Il
    // pulsante grande manda quindi `nuovo: false` — e il registro di protocollo è WORM,
    // quindi un numero consumato per sbaglio non torna indietro.
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id, [CERTIFICATO_IN_ARCHIVIO]) }],
      documento: { ok: true, status: 200, corpo: { success: true, riuso: true, url: null } },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    fireEvent.click(await screen.findByRole('button', { name: itGenitore.certificatoScarica }))
    await waitFor(() => expect(corpoDocumento(0)).toMatchObject({ nuovo: false }))

    fireEvent.click(screen.getByRole('button', { name: itGenitore.certificatoNuovo }))
    await waitFor(() => expect(corpoDocumento(1)).toMatchObject({ nuovo: true }))
  })

  it('«Generane uno nuovo» pesa MENO del riscarico, e il peso è la difesa', async () => {
    // ⚠️ NON È UNA PREFERENZA DI STILE. Quel comando emette un numero di protocollo su un
    // registro WORM: con lo stesso peso visivo del riscarico, il genitore ne brucerebbe uno
    // ogni volta che vuole rivedere il proprio certificato, e il registro finirebbe per
    // contare i clic invece dei documenti. Si misura sulle classi, che sono ciò che l'occhio
    // vede: il riscarico è pieno (fondo verde), «uno nuovo» è un collegamento sottolineato.
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id, [CERTIFICATO_IN_ARCHIVIO]) }],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    const riscarico = await screen.findByRole('button', { name: itGenitore.certificatoScarica })
    const nuovo = screen.getByRole('button', { name: itGenitore.certificatoNuovo })

    expect(riscarico.className).toMatch(/bg-kidville-green/)
    expect(nuovo.className).not.toMatch(/bg-kidville-green/)
    expect(nuovo.className).toMatch(/underline/)
    // E la differenza è anche DETTA, non solo dipinta: chi non vede il colore legge perché
    // esistono due comandi.
    expect(screen.getByText(itGenitore.certificatoNuovoAiuto)).toBeInTheDocument()
  })

  it('il modulo firmato si riscarica dall’elenco, con parole sue', async () => {
    // 🔴 IL DIFETTO CHE CHIUDE: il PDF della scheda sanitaria firmata viveva solo dentro la
    // risposta della firma, e chi chiudeva la pagina lo perdeva. E l'etichetta non dice
    // «certificato»: su una scheda sanitaria sarebbe la parola sbagliata.
    armaFetch({
      elenco: [
        {
          ok: true,
          status: 200,
          corpo: elencoServito(FIGLIO_A.id, [
            {
              ...MODELLO_SANITARIO,
              documentoArchiviatoId: 'd0000000-0000-4000-8000-00000000000d',
              documentoArchiviatoIl: '2026-08-15T09:00:00.000Z',
            },
          ]),
        },
      ],
      documento: { ok: true, status: 200, corpo: { success: true, riuso: true, url: null } },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    const scarica = await screen.findByRole('button', { name: itGenitore.documentoScarica })
    expect(screen.queryByRole('button', { name: itGenitore.certificatoNuovo })).toBeNull()
    fireEvent.click(scarica)
    await waitFor(() =>
      expect(corpoDocumento(0)).toMatchObject({ slug: 'scheda_sanitaria', nuovo: false }),
    )
  })

  it('il certificato in archivio dice anche QUALE numero riconsegna', async () => {
    // «Riscarica sempre lo stesso, con lo stesso numero di protocollo» e poi non diceva
    // quale: per sapere se il foglio che sta per mandare all'INPS è il 5 o il 6, il genitore
    // doveva aprire il PDF. Il numero sta accanto a «Nel fascicolo dal …», che è dove lo cerca.
    armaFetch({
      elenco: [
        {
          ok: true,
          status: 200,
          corpo: elencoServito(FIGLIO_A.id, [
            { ...CERTIFICATO_IN_ARCHIVIO, protocolloArchiviato: '0000005/2026' },
          ]),
        },
      ],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    expect(
      await screen.findByText(itGenitore.certificatoNumero.replace('{numero}', '0000005/2026')),
    ).toBeInTheDocument()
  })

  it('un certificato che per QUESTO bambino non si può emettere non offre nessun pulsante', async () => {
    /**
     * 🔴 Il Bonus Nido offriva a chiunque un pulsante `primary` che per la maggioranza dei
     * bambini non poteva funzionare, e il rifiuto del server compariva 777 px fuori dallo
     * schermo di un telefono: al genitore sembrava che il clic non avesse fatto niente.
     * Ora il verdetto arriva col GET (`generabileOra`), e la scheda non promette il gesto.
     */
    armaFetch({
      elenco: [
        {
          ok: true,
          status: 200,
          corpo: elencoServito(FIGLIO_A.id, [
            {
              ...MODELLO_CERTIFICATO,
              slug: 'certificato_bonus_nido',
              chiaveEtichetta: 'modelli.certificatoBonusNido',
              generabileOra: false,
              motivoNonGenerabile: 'livello-non-nido',
            },
          ]),
        },
      ],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    // La frase c'è, ed è quella del catalogo — non la prosa italiana del server.
    expect(await screen.findByText(itGenitore.certificatoLivelloNonNido)).toBeInTheDocument()
    // E il pulsante no: un gesto offerto e destinato a fallire è peggio di nessun gesto.
    expect(screen.queryByRole('button', { name: itGenitore.certificatoGenera })).toBeNull();
    expect(screen.queryByRole('button', { name: itGenitore.certificatoScarica })).toBeNull();
  })

  it('il certificato uscito ma NON archiviato lo DICE: il clic dopo brucerebbe un altro numero', async () => {
    /**
     * 🔴 Il difetto misurato in produzione: la rotta rispondeva 201 con `archiviato: false`
     * (il bucket del fascicolo non esisteva), e il client guardava solo `success` — quindi
     * consegnava il PDF e ripresentava «Genera il certificato», cioè invitava al clic che
     * avrebbe bruciato il numero dopo. Il registro è WORM: quei numeri non tornano.
     */
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id, [MODELLO_CERTIFICATO]) }],
      documento: {
        ok: true,
        status: 201,
        corpo: {
          success: true,
          riuso: false,
          archiviato: false,
          documentoId: null,
          protocollo: '0000003/2026',
          url: null,
          pdfBase64: null,
        },
      },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    fireEvent.click(await screen.findByRole('button', { name: itGenitore.certificatoGenera }))
    expect(await screen.findByText(itGenitore.certificatoNonArchiviato)).toBeInTheDocument()
  })

  it('il certificato che non si può emettere lo dice con le parole del catalogo', async () => {
    // Il server risponde in italiano e l'app è bilingue: la frase la sceglie il `motivo`
    // enumerato, non la prosa del server (difetto F1 del collaudo del 2026-07-31).
    armaFetch({
      elenco: [{ ok: true, status: 200, corpo: elencoServito(FIGLIO_A.id, [MODELLO_CERTIFICATO]) }],
      documento: {
        ok: false,
        status: 422,
        corpo: {
          error: 'Gli estremi dell’autorizzazione al funzionamento del nido non sono configurati…',
          codice: 'PRESTAMPATO_DATI_MANCANTI',
          motivo: 'autorizzazione-nido-mancante',
        },
      },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    fireEvent.click(await screen.findByRole('button', { name: itGenitore.certificatoGenera }))
    expect(
      await screen.findByText(itGenitore.certificatoAutorizzazioneNidoMancante),
    ).toBeInTheDocument()
  })

  it('il rifiuto compare ACCANTO al pulsante che l’ha causato, non in cima all’elenco', async () => {
    /**
     * 🔴 Misurato su una finestra 430×900 — la misura di un telefono. Il banner del rifiuto
     * stava in cima all'elenco, il pulsante a `y≈768`: il messaggio veniva disegnato a
     * `boundingBox.y = -777`, cioè fuori dallo schermo, e gli screenshot prima e dopo il clic
     * erano identici. Un rifiuto che l'utente non vede è un pulsante che non risponde.
     *
     * Qui non si può misurare un `boundingBox` (jsdom non impagina), e si misura la cosa che
     * lo causa: la PARENTELA. Il messaggio dev'essere dentro la stessa voce d'elenco del
     * pulsante — con il banner in cima, `closest('li')` è `null` e la prova è rossa.
     */
    armaFetch({
      elenco: [
        {
          ok: true,
          status: 200,
          corpo: elencoServito(FIGLIO_A.id, [MODELLO_SANITARIO, MODELLO_CERTIFICATO]),
        },
      ],
      documento: {
        ok: false,
        status: 422,
        corpo: {
          error: 'Il certificato per il Bonus Asilo Nido si rilascia solo a chi frequenta il nido…',
          codice: 'PRESTAMPATO_DATI_MANCANTI',
          motivo: 'livello-non-nido',
        },
      },
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    fireEvent.click(await screen.findByRole('button', { name: itGenitore.certificatoGenera }))

    const messaggio = await screen.findByText(itGenitore.certificatoLivelloNonNido)
    const voce = messaggio.closest('li')
    // ⚠️ IL PULSANTE SI RICERCA DOPO IL CLIC: il ri-render sostituisce il nodo, e un
    // riferimento preso prima è staccato dal documento — `closest('li')` risponderebbe
    // `null` e la prova sarebbe verde per il motivo sbagliato.
    const bottone = screen.getByRole('button', { name: itGenitore.certificatoGenera })
    expect(voce, 'il messaggio non sta dentro nessuna voce d’elenco: è tornato in cima').not.toBeNull()
    expect(voce).toBe(bottone.closest('li'))
    // E la scheda sanitaria, che non c'entra niente, resta pulita.
    expect(screen.getAllByText(itGenitore.certificatoLivelloNonNido)).toHaveLength(1)
  })
})

// ─── La gita: che cosa dice la scheda del n. 10 ─────────────────────────────────

describe('PrestampatiGenitore — la gita si legge PRIMA di aprire il modulo', () => {
  it('con i due orari li stampa entrambi', async () => {
    armaFetch({
      elenco: [
        {
          ok: true,
          status: 200,
          corpo: elencoServito(FIGLIO_A.id, [MODELLO_USCITA], {
            destinazione: 'Museo di Prova',
            data: '2026-10-01',
            oraPartenza: '08:30',
            oraRientro: '16:00',
          }),
        },
      ],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    await screen.findByText(/Museo di Prova/)
    expect(screen.getByText(/partenza 08:30/)).toBeInTheDocument()
    expect(screen.getByText(/rientro 16:00/)).toBeInTheDocument()
  })

  /**
   * 🔴 È IL CASO NORMALE IN PRODUZIONE, non il limite: l'unica schermata che crea uscite
   * (`TeacherAgendaCard` → `agenda:POST`) gli orari non li scrive, e il server li serve
   * `null`. Prima del 2026-08-16 questa scheda non esisteva affatto per quel caso — il
   * modulo non compariva — e la frase unica avrebbe stampato «· partenza , rientro .», che
   * su un'autorizzazione si legge come un orario deciso e non comunicato.
   */
  it('senza orari dice dove si va e quando, e NON lascia due valori vuoti in mezzo', async () => {
    armaFetch({
      elenco: [
        {
          ok: true,
          status: 200,
          corpo: elencoServito(FIGLIO_A.id, [MODELLO_USCITA], {
            destinazione: 'Museo di Prova',
            data: '2026-10-01',
            oraPartenza: null,
            oraRientro: null,
          }),
        },
      ],
    })
    render(<PrestampatiGenitore figli={[FIGLIO_A]} />)

    const riga = await screen.findByText(/Museo di Prova/)
    expect(riga.textContent).not.toMatch(/partenza/)
    expect(riga.textContent).not.toMatch(/rientro/)
    // La frase è quella del catalogo, non un pezzo dell'altra rimasto a metà.
    expect(riga.textContent).toBe(
      itGenitore.uscitaRigaSenzaOrari
        .replace('{destinazione}', 'Museo di Prova')
        .replace('{data}', '01/10/2026'),
    )
  })
})

// ─── Il catalogo: nessuna chiave che non serve più a nessuno ────────────────────

describe('prestampatiGenitore — il catalogo non conserva frasi che il prodotto non dice più', () => {
  /**
   * 🔴 IL DIFETTO CHE QUESTO LOCK CHIUDE, e perché una chiave orfana non è «solo pulizia».
   *
   * Dopo che i certificati self-service in jsPDF sono stati tolti, in catalogo restavano
   * `copiaFamiglia` («Copia a uso della famiglia — non protocollata») e `certificatoAvviso`
   * («se un ente lo vuole protocollato, chiedilo in segreteria»). Nessuna delle due era più
   * usata da nessuno — e tutte e due dicevano ora una cosa FALSA sul prodotto: quel
   * certificato adesso HA un numero di protocollo e la firma del legale rappresentante. Chi
   * le riusasse fidandosi del catalogo stamperebbe «non protocollata» sotto una segnatura di
   * protocollo, cioè esattamente la bugia che questo lavoro è nato per togliere dal foglio.
   *
   * ⚠️ SI CERCA LA STRINGA QUOTATA, E SI TOLGONO I COMMENTI PRIMA. `copiaFamiglia` compare
   * in `src/` come nome di un'opzione del render (`copiaFamiglia: true`) e dentro tre
   * commenti fra apici inversi: un riconoscitore che guardasse il testo grezzo l'avrebbe
   * dichiarata «usata» e sarebbe stato verde su una chiave morta. Le chiavi vive invece
   * compaiono sempre quotate: `t('scarica')`, oppure come valore di una mappa
   * (`'livello-non-nido': 'certificatoLivelloNonNido'`).
   */
  const senzaCommenti = (codice: string): string =>
    codice.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

  /** Ogni foglia del catalogo, col suo percorso puntato. */
  function foglie(o: Record<string, unknown>, pref = ''): string[] {
    return Object.entries(o).flatMap(([k, v]) =>
      v !== null && typeof v === 'object'
        ? foglie(v as Record<string, unknown>, `${pref}${k}.`)
        : [`${pref}${k}`],
    )
  }

  it('nessuna chiave resta senza uno schermo che la mostri', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const radice = path.join(process.cwd(), 'src')

    const sorgenti: string[] = []
    const cammina = (dir: string): void => {
      for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const completo = path.join(dir, voce.name)
        if (voce.isDirectory()) cammina(completo)
        else if (/\.tsx?$/.test(voce.name)) sorgenti.push(fs.readFileSync(completo, 'utf8'))
      }
    }
    cammina(radice)
    const codice = senzaCommenti(sorgenti.join('\n'))

    /**
     * Le due famiglie COMPOSTE a runtime, e sono le sole deroghe.
     *
     * `chiaveEtichetta()` (`registro.ts`) costruisce `modelli.${slug in camelCase}` e il
     * pannello ne ricava `descrizioni.…` con una `replace`: quei nomi non compaiono quotati
     * da nessuna parte, per costruzione. Che ci siano tutti lo verifica già il test del
     * registro, che pretende una chiave per ogni slug in tutte e due le lingue — quindi qui
     * si deroga senza lasciare scoperto niente.
     */
    const composte = (chiave: string) => /^(modelli|descrizioni)\./.test(chiave)

    /**
     * L'unica deroga NOMINATA, e con la sua ragione scritta accanto — non un elenco che
     * cresce: `scaricaRicevuta` è la ricevuta di firma FEA, che il pannello dichiara per
     * iscritto di non rendere ancora («esiste già ma NON si rende, e non per dimenticanza»,
     * `PrestampatiGenitore.tsx`). È fuori dallo scopo di questo lavoro per decisione
     * esplicita: toglierla dal catalogo vorrebbe dire riscriverla il giorno in cui la
     * ricevuta arriva, in due lingue.
     */
    const derogate = new Set(['scaricaRicevuta'])

    /**
     * Una chiave è VIVA se compare quotata — col suo nome di foglia (`t('scarica')`, oppure
     * come valore di una mappa) o col suo percorso intero (`t('datiApp.codiceFiscale')`).
     * Servono tutte e due le forme: il pannello usa l'una o l'altra a seconda che la chiave
     * sia annidata, e guardarne una sola dichiarerebbe morte sei chiavi che si vedono a
     * schermo.
     */
    const viva = (chiave: string): boolean =>
      [chiave, chiave.split('.').pop() as string].some((nome) =>
        new RegExp(`(['"\`])${nome.replace('.', '\\.')}\\1`).test(codice),
      )

    const orfane = foglie(itGenitore as unknown as Record<string, unknown>)
      .filter((c) => !composte(c) && !derogate.has(c))
      .filter((c) => !viva(c))

    expect(
      orfane,
      'chiavi di `prestampatiGenitore` che nessuno schermo mostra più: o si tolgono dal ' +
        'catalogo (in ITALIANO e in INGLESE), o si rimette la schermata che le usava',
    ).toEqual([])
  })

  it('i due cataloghi hanno le stesse chiavi: una frase che esiste solo in una lingua è una lacuna', () => {
    const it = foglie(itGenitore as unknown as Record<string, unknown>).sort()
    const en = foglie(enGenitore as unknown as Record<string, unknown>).sort()
    expect(it).toEqual(en)
  })
})
