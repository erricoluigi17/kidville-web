import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import { validateField } from '@/lib/forms/validate-fields'
import {
  ALFA, OGGI, apriTendina, avanti, passoSede, reteFinta, scegliNapoli,
} from '../fixtures/anagrafica-personale'

/**
 * `/anagrafica-personale` — IL CODICE FISCALE CHE SI VERIFICA DA SOLO.
 *
 * ─── I QUATTRO DIFETTI CHE QUESTO FILE IMPEDISCE ────────────────────────────
 *
 * **1. Il badge che BLOCCA.** È la deriva naturale di un controllo che sa dire
 * «questo codice non torna»: farne un requisito. Sarebbe sbagliato per due
 * ragioni misurate. Un codice OMOCODICO (lettere al posto di alcune cifre) l'ha
 * assegnato l'Agenzia a una persona vera, ed è DIVERSO da quello calcolato dai
 * dati: bloccarlo direbbe a qualcuno che il proprio codice fiscale non esiste. E
 * un'anagrafica incompleta — sesso o comune non ancora scelti — rende il codice
 * atteso incalcolabile, quindi il badge non ha niente da confrontare: bloccare lì
 * significherebbe impedire di andare avanti per un dato che non è stato chiesto.
 * L'unica cosa che ferma «Avanti» è `validateField`, la stessa regola che il
 * server rigira.
 *
 * **2. «Usa questo» che fa più di quello che dice.** Il contratto di
 * `BadgeCoerenzaCf` è: compila il campo E NULLA PIÙ. Non invia, non avanza, non
 * salva. Qui il gesto è dentro un modulo pubblico con un bottone «Avanti» accanto:
 * un `onUsaCalcolato` che avanzasse di un passo scriverebbe in archivio un codice
 * fiscale che nessuno ha riletto.
 *
 * **3. `aria-describedby` che punta al vuoto.** Il badge ritorna `null` quando non
 * ha niente da dire — ed è lo stato ORDINARIO di un campo appena aperto. Un
 * riferimento fisso rimanderebbe a un elemento inesistente: uno screen reader
 * annuncia un campo che rinvia a una descrizione che non c'è, e lo fa in silenzio.
 * La condizione vive in `badgeHaQualcosaDaDire` e non si riscrive nel wizard.
 *
 * **4. Il comune scritto a mano.** Da un testo libero il codice fiscale non si
 * verifica: omonimie fra province, comuni soppressi, refusi. Serve il CODICE
 * CATASTALE, e lo produce solo la tendina a cascata. Senza, il badge direbbe «non
 * verificabile» su ogni riga — cioè non direbbe niente.
 *
 * ⚠️ E NESSUN DATO ESCE VERSO UN TERZO. Fino all'11/08/2026 esisteva una
 * verifica che chiamava `api.codicefiscale.it`: mandava nome, cognome, data e
 * comune di nascita di una persona a un servizio fuori da ogni informativa. Qui
 * l'unica rete è quella della Scuola, e questo file lo misura.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { AnagraficaPersonaleWizard } from '@/components/features/public/AnagraficaPersonaleWizard'

const CAMPO_CF = PERSONALE_FIELDS.find((f) => f.id === 'fiscal_code')!

const campoCf = () => screen.getByLabelText(/^Codice fiscale/) as HTMLInputElement
const badge = () => document.getElementById('pers-badge-cf')
const descrittoriCf = () => (campoCf().getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
const codiceProposto = () => badge()?.querySelector('code')?.textContent ?? ''
const usaQuesto = () => screen.getByRole('button', { name: 'Usa questo' })

/** Arriva al passo «I tuoi dati» senza compilare niente. */
async function finoAiDati(rete = reteFinta()): Promise<ReturnType<typeof reteFinta>> {
  vi.stubGlobal('fetch', rete.fetch)
  render(<AnagraficaPersonaleWizard oggi={OGGI} />)
  await passoSede(ALFA.id)
  await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
  return rete
}

/** L'anagrafica di prova, luogo di nascita ESCLUSO. Nessuna persona vera. */
function compilaAnagrafica(): void {
  fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Prova' } })
  fireEvent.change(screen.getByPlaceholderText('Es. Rossi'), { target: { value: 'Esempio' } })
  fireEvent.change(screen.getByLabelText(/^Sesso/), { target: { value: 'F' } })
  fireEvent.change(screen.getByLabelText(/^Data di nascita/), { target: { value: '1985-03-07' } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AnagraficaPersonaleWizard — il badge parla solo quando ha qualcosa da dire', () => {
  it('campo aperto e anagrafica vuota: nessun badge, e NESSUN riferimento nel vuoto', async () => {
    await finoAiDati()

    expect(badge()).toBeNull()
    // Ogni id dichiarato come descrizione deve puntare a un elemento che esiste.
    for (const id of descrittoriCf()) expect(document.getElementById(id)).not.toBeNull()
    expect(descrittoriCf()).not.toContain('pers-badge-cf')
  })

  it('scelti sesso, data e comune, il badge compare e il campo lo dichiara', async () => {
    await finoAiDati()
    compilaAnagrafica()
    await scegliNapoli()

    await waitFor(() => expect(badge()).not.toBeNull())
    expect(descrittoriCf()).toContain('pers-badge-cf')
    // …e propone un codice, perché il campo è ancora vuoto.
    expect(codiceProposto()).toMatch(/^[A-Z]{6}[0-9A-Z]{2}[A-Z][0-9A-Z]{2}[A-Z][0-9A-Z]{3}[A-Z]$/)
  })

  it('⚠️ il comune scritto a mano non basta: senza codice catastale non c’è proposta', async () => {
    // È la ragione per cui il luogo di nascita è una tendina e non tre caselle.
    await finoAiDati()
    compilaAnagrafica()

    // Nessuna scelta dalla cascata: il codice catastale resta vuoto.
    await waitFor(() => expect(screen.getByLabelText(/^Cittadinanza/)).toBeInTheDocument())
    expect(badge()).toBeNull()
  })
})

describe('AnagraficaPersonaleWizard — «Usa questo» compila il campo E NULLA PIÙ', () => {
  it('il codice finisce nel campo, il passo NON avanza e niente parte verso il server', async () => {
    const rete = await finoAiDati()
    compilaAnagrafica()
    await scegliNapoli()
    await waitFor(() => expect(badge()).not.toBeNull())

    const proposto = codiceProposto()
    expect(campoCf().value).toBe('')

    fireEvent.click(usaQuesto())

    await waitFor(() => expect(campoCf().value).toBe(proposto))
    // Si è ancora al passo «I tuoi dati»: il gesto non ha avanzato niente…
    expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument()
    // …e non ha inviato niente.
    expect(rete.inviati).toHaveLength(0)
  })

  it('adottato il codice, la proposta sparisce: non si propone di sostituire un codice coerente', async () => {
    await finoAiDati()
    compilaAnagrafica()
    await scegliNapoli()
    await waitFor(() => expect(badge()).not.toBeNull())

    fireEvent.click(usaQuesto())
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Usa questo' })).toBeNull())
  })
})

describe('AnagraficaPersonaleWizard — il badge NON blocca: blocca solo `validateField`', () => {
  it('un codice che CONTRADDICE l’anagrafica lascia passare «Avanti»', async () => {
    await finoAiDati()
    compilaAnagrafica()
    await scegliNapoli()
    await waitFor(() => expect(badge()).not.toBeNull())
    fireEvent.click(usaQuesto())
    await waitFor(() => expect(campoCf().value).not.toBe(''))

    // Il sesso cambia, il codice no: adesso il codice dice «femmina» e
    // l'anagrafica «maschio». È una contraddizione dimostrata, ed è rossa.
    fireEvent.change(screen.getByLabelText(/^Sesso/), { target: { value: 'M' } })
    await waitFor(() => expect(badge()?.textContent ?? '').toContain('femmina'))

    // …e non impedisce di proseguire: il resto del passo è compilato.
    fireEvent.change(screen.getByLabelText(/^Cittadinanza/), { target: { value: 'Italiana' } })
    fireEvent.change(screen.getByLabelText(/^Titolo di studio/), { target: { value: 'diploma' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nido (0-3)' }))
    avanti()

    await waitFor(() => expect(screen.getByLabelText(/^Indirizzo di residenza/)).toBeInTheDocument())
  })

  it('un codice MALFORMATO invece ferma «Avanti», e il messaggio sta sotto il campo', async () => {
    await finoAiDati()
    compilaAnagrafica()
    await scegliNapoli()

    fireEvent.change(campoCf(), { target: { value: 'NON-UN-CODICE' } })
    fireEvent.change(screen.getByLabelText(/^Cittadinanza/), { target: { value: 'Italiana' } })
    fireEvent.change(screen.getByLabelText(/^Titolo di studio/), { target: { value: 'diploma' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nido (0-3)' }))
    avanti()

    await waitFor(() => expect(campoCf()).toHaveAttribute('aria-invalid', 'true'))
    expect(document.getElementById('pers-fiscal-code-errore')).not.toBeNull()
    // Si è rimasti al passo «I tuoi dati».
    expect(screen.queryByLabelText(/^Indirizzo di residenza/)).not.toBeInTheDocument()
    // Il riferimento all'errore E quello al badge convivono, e puntano entrambi a
    // qualcosa: `aria-describedby` è una LISTA, non un solo id.
    for (const id of descrittoriCf()) expect(document.getElementById(id)).not.toBeNull()
  })

  it('⚠️ un OMOCODICO non viene respinto dalla forma: è un codice vero di una persona vera', () => {
    // La regola che blocca è `validateField` sul `pattern` del template, e quel
    // pattern ammette le lettere nelle posizioni numeriche. Se un giorno tornasse
    // quello di `enrollment-template.ts`, un modulo pubblico direbbe a qualcuno
    // che il proprio codice fiscale non esiste.
    expect(validateField(CAMPO_CF, 'SPRMRA85C47F839K')).toBeNull()
    expect(validateField(CAMPO_CF, 'SPRMRAL5C47F839K')).toBeNull()
    expect(validateField(CAMPO_CF, 'SPRMRALMCQ7F839K'.slice(0, 16))).toBeNull()
    // …e ciò che non ha la forma di un codice fiscale resta respinto.
    expect(validateField(CAMPO_CF, 'SPRMRA85C47F839')).not.toBeNull()
    expect(validateField(CAMPO_CF, '1234567890123456')).not.toBeNull()
  })
})

describe('AnagraficaPersonaleWizard — nessun dato esce verso un terzo', () => {
  it('l’unica rete è quella della Scuola: nessuna chiamata fuori da `/api/`', async () => {
    const rete = await finoAiDati()
    compilaAnagrafica()
    await scegliNapoli()
    await waitFor(() => expect(badge()).not.toBeNull())
    fireEvent.click(usaQuesto())

    expect(rete.chiamate.length).toBeGreaterThan(0)
    for (const url of rete.chiamate) {
      expect(url.startsWith('/api/'), `chiamata verso un terzo: ${url}`).toBe(true)
    }
  })

  it('e nessun log del client porta con sé il codice fiscale digitato', async () => {
    await finoAiDati()
    compilaAnagrafica()
    await scegliNapoli()
    fireEvent.change(campoCf(), { target: { value: 'SPRMRA85C47F839K' } })
    avanti()

    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    for (const [riga] of h.logClient.mock.calls) {
      expect(JSON.stringify(riga)).not.toContain('SPRMRA85C47F839K')
    }
  })
})

describe('AnagraficaPersonaleWizard — il titolo del passo resta quello giusto', () => {
  it('il passo dei dati si annuncia col proprio nome, non con quello del successivo', async () => {
    await finoAiDati()
    const h2 = screen.getAllByRole('heading', { level: 2 })
    expect(h2.map((n) => n.textContent)).toContain(itPublic.persDati)
  })
})

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * IL VICOLO CIECO DEL LUOGO DI NASCITA — rilievo GRAVE del critico visivo,
 * misurato il 12/08/2026 e chiuso qui.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─── COSA SUCCEDEVA ────────────────────────────────────────────────────────
 * Compilando nome, cognome, sesso, data, codice fiscale, cittadinanza, titolo di
 * studio e fascia d'età, lasciando vuota SOLO la provincia di nascita, e premendo
 * «Avanti»: il passo restava «Passo 2 di 6» e l'unico `role="alert"` a schermo era
 * `pers-nascita-comune-errore` — «Campo obbligatorio» — sotto un controllo con
 * `disabled = true`, fondo rgb(240,242,241) e bordo rgb(138,149,143). Il campo da
 * compilare davvero, `pers-nascita-provincia`, aveva `aria-invalid = null`,
 * nessun messaggio, bordo normale ed etichetta SENZA asterisco. L'unica istruzione
 * era il segnaposto «Scegli prima la provincia», cioè testo effimero dentro una
 * casella grigia.
 *
 * ─── PERCHÉ ERA GRAVE, E NON UNA SFUMATURA ─────────────────────────────────
 * Per chi vede: si preme «Avanti», la pagina torna in cima, e l'unico rosso sta
 * sotto una casella spenta che non si può cliccare. Per chi ascolta è peggio: si
 * annuncia un errore su un elemento `disabled`, quindi fuori dall'ordine di
 * tabulazione — e non esiste nessun modo di scoprire che la via d'uscita è il
 * campo PRECEDENTE. La regola «dopo un Avanti fallito il fuoco va sul primo campo
 * non valido» degradava in silenzio proprio qui: un elemento disabilitato non è
 * focalizzabile, quindi `setFocus` veniva chiamato e non succedeva niente.
 * Sono maestre in servizio che compilano una volta sola, e qui non c'è nessuna
 * bozza a cui tornare.
 *
 * ─── LA REGOLA CHE QUESTI COLLAUDI DIFENDONO ───────────────────────────────
 * I quattro campi della cascata sono UN controllo per chi compila, e il loro
 * messaggio va su quello dei due che in questo istante è ABILITATO.
 */
describe('AnagraficaPersonaleWizard — il luogo di nascita non è un vicolo cieco', () => {
  /** Tutto il passo «I tuoi dati» TRANNE il luogo di nascita: la cascata resta vuota. */
  function tuttoTranneIlLuogo(): void {
    compilaAnagrafica()
    fireEvent.change(screen.getByLabelText(/^Codice fiscale/), { target: { value: 'SPRMRA85C47F839K' } })
    fireEvent.change(screen.getByLabelText(/^Cittadinanza/), { target: { value: 'Italiana' } })
    fireEvent.change(screen.getByLabelText(/^Titolo di studio/), { target: { value: 'laurea_triennale' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Infanzia (3-6)' }))
  }

  const provincia = () => document.getElementById('pers-nascita-provincia') as HTMLInputElement
  const comune = () => document.getElementById('pers-nascita-comune') as HTMLInputElement

  it('provincia vuota: il messaggio sta sulla PROVINCIA, non sotto la casella spenta', async () => {
    await finoAiDati()
    tuttoTranneIlLuogo()
    avanti()

    // Il passo NON avanza — e deve: il codice catastale è obbligatorio.
    await waitFor(() => expect(document.getElementById('pers-nascita-provincia-errore')).not.toBeNull())
    expect(screen.getByPlaceholderText('Es. Maria'), 'il passo è cambiato').toBeInTheDocument()

    // ⚠️ IL PUNTO: il messaggio non è più sotto il controllo DISABILITATO.
    expect(comune()).toBeDisabled()
    expect(comune().getAttribute('aria-invalid')).toBeNull()
    expect(document.getElementById('pers-nascita-comune-errore')).toBeNull()

    // …ed è sul campo che si può davvero toccare.
    expect(provincia()).toBeEnabled()
    expect(provincia().getAttribute('aria-invalid')).toBe('true')
    const messaggio = document.getElementById('pers-nascita-provincia-errore') as HTMLElement
    expect(messaggio.getAttribute('role')).toBe('alert')
    // Non «Campo obbligatorio»: sul primo gradino serve l'ISTRUZIONE che sblocca
    // il secondo — e «obbligatorio» sarebbe pure falso, visto che il template
    // dichiara `birth_province` facoltativa.
    // ⚠️ La FRASE per esteso, non solo la chiave: `toHaveTextContent(undefined)`
    // passa su qualunque testo, quindi una chiave sparita dal catalogo lascerebbe
    // questo collaudo verde mentre a schermo compare `public.persNascita…`.
    expect(itPublic.persNascitaProvinciaPrima).toBe(
      'Scegli prima la provincia di nascita: il comune si sceglie dal suo elenco.',
    )
    expect(messaggio).toHaveTextContent(itPublic.persNascitaProvinciaPrima)
    expect(messaggio.textContent).not.toMatch(/^public\./)

    // Un solo messaggio per tutta la cascata: quattro «Campo obbligatorio» sotto
    // un controllo solo direbbero che i problemi sono quattro.
    const alert = screen.getAllByRole('alert')
    expect(alert).toHaveLength(1)
    expect(alert[0].id).toBe('pers-nascita-provincia-errore')
  })

  it('…e il FUOCO ci arriva davvero: è la cosa che `setFocus` non sapeva fare', async () => {
    await finoAiDati()
    tuttoTranneIlLuogo()
    avanti()

    await waitFor(() => expect(document.getElementById('pers-nascita-provincia-errore')).not.toBeNull())
    // I quattro campi della cascata non passano da `register`: `setFocus` è un
    // no-op silenzioso su di essi, e prima del 12/08/2026 il fuoco ripiegava
    // sull'`h2` del passo — cioè la pagina sembrava non reagire.
    expect(document.activeElement).toBe(provincia())
  })

  it('la provincia è marcata OBBLIGATORIA, così l’obbligo non si scopre premendo «Avanti»', async () => {
    await finoAiDati()
    // L'asterisco è l'unica convenzione con cui questa pagina dice «obbligatorio»,
    // e `aria-required` è il segnale che non dipende da un carattere nel testo.
    expect(screen.getByRole('combobox', { name: /^Provincia di nascita\s*\*$/ })).toBeInTheDocument()
    expect(provincia().getAttribute('aria-required')).toBe('true')
    expect(comune().getAttribute('aria-required')).toBe('true')
  })

  it('scelta la provincia, il messaggio SI SPOSTA sul comune — che adesso è vivo', async () => {
    await finoAiDati()
    tuttoTranneIlLuogo()
    avanti()
    await waitFor(() => expect(document.getElementById('pers-nascita-provincia-errore')).not.toBeNull())

    // Si sceglie la sola provincia: la cascata è a metà.
    apriTendina(provincia())
    fireEvent.click(screen.getByRole('option', { name: /Napoli \(NA\)/ }))
    // Scegliere È la risposta all'avviso: il rosso della provincia si spegne qui,
    // non al prossimo «Avanti».
    await waitFor(() => expect(document.getElementById('pers-nascita-provincia-errore')).toBeNull())
    await waitFor(() => expect(comune()).toBeEnabled())

    avanti()
    await waitFor(() => expect(document.getElementById('pers-nascita-comune-errore')).not.toBeNull())
    // Adesso il messaggio è dove il gesto è possibile, e la provincia è pulita.
    expect(provincia().getAttribute('aria-invalid')).toBeNull()
    expect(comune().getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(comune())
  })

  it('scelto anche il comune, «Avanti» passa: la cascata non blocca più niente', async () => {
    await finoAiDati()
    tuttoTranneIlLuogo()
    avanti()
    await waitFor(() => expect(document.getElementById('pers-nascita-provincia-errore')).not.toBeNull())

    await scegliNapoli()
    avanti()
    // Il passo successivo è «Residenza e recapiti».
    await waitFor(() => expect(screen.getByLabelText(/^Indirizzo di residenza/)).toBeInTheDocument())
  })
})
