'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle, CalendarClock, CheckCircle2, Clock, ExternalLink, FileText,
  IdCard, KeyRound, Loader2, Mail, MapPin, MoveRight, ShieldCheck, UserCheck,
  Users, XCircle,
} from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { StatCard, TABLE, TABLE_WRAP, TD, TH, TROW, Drawer } from '@/components/ui/cockpit'
import { GRADI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { TIPI_DOCUMENTO } from '@/lib/forms/personale-template'
import { giorniResidui, sogliaRaggiunta, SOGLIA_SCADUTO } from '@/lib/anagrafica/scadenze'
import { dataCivile } from '@/i18n/config'
import { useDateFormat } from '@/lib/i18n/date'
import { LIMITE_ISCRIZIONI_DEFAULT } from '@/lib/api/paginazione'
import { useSediAttive } from '@/lib/context/sede-context'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { messaggioDaCorpo, messaggioErrore } from '@/lib/ui/esito-fetch'
import { apriDocumentoFirmato, AVVISO_FINESTRA_BLOCCATA } from '@/lib/ui/apri-documento-firmato'
import { FUOCO_ESITO } from '@/lib/ui/fuoco'

/**
 * IL COCKPIT DELLE PRATICHE DEL PERSONALE — lato Segreteria di `/anagrafica-personale`.
 *
 * Gemello di `CandidatureInsegnanti.tsx`, e ne eredita le difese perché sono state
 * pagate una volta e non vanno ripagate: gettone per richiesta, avvisi che si
 * accumulano, mai un `alert()`, l'elenco che resta povero anche se il server
 * diventasse generoso. Quello che cambia è scritto qui sotto, punto per punto.
 *
 * ── PERCHÉ QUI I PULSANTI NON SONO SPENTI PER LA SEGRETERIA ──────────────────
 * Sul gemello «Approva» crea un account docente e la `PATCH` è riservata alla
 * Direzione: la schermata mostra i pulsanti spenti col motivo scritto, perché
 * scoprire un 403 dopo il clic fa sembrare un guasto un divieto legittimo. Qui la
 * route ammette `admin`, `coordinator` e `segreteria` — gli stessi tre ruoli che
 * possono APRIRE questa pagina — quindi un gate lato client non avrebbe niente da
 * dire: chi la vede può agire. Non è una svista, è la conseguenza del fatto che
 * queste sono le colleghe che lavorano già qui, e riconoscerle è mestiere di
 * segreteria.
 *
 * ── PERCHÉ L'ELENCO È POVERO, e qui pesa il doppio ───────────────────────────
 * La route proietta sette colonne (`COLONNE_ELENCO`) e questo componente non
 * disegna nemmeno i campi del dettaglio partendo dalla riga d'elenco: se domani la
 * proiezione del server tornasse generosa, l'elenco resterebbe povero lo stesso. Una
 * pratica contiene codice fiscale, residenza, estremi di un documento d'identità e il
 * recapito di un TERZO — il contatto d'emergenza, che non ha ricevuto nessuna
 * informativa e non sta compilando niente.
 *
 * ── PERCHÉ IL NOME È UN `<a href>` E NON UNA RIGA CLICCABILE ─────────────────
 * Una `<tr onClick>` non è raggiungibile da tastiera, non si annuncia, non si apre in
 * una scheda nuova e non si può copiare. Qui il nome è un collegamento VERO a
 * `?tab=personale&pratica=<id>`: col clic normale apre il pannello senza ricaricare,
 * con Cmd/Ctrl apre una scheda — e quella scheda funziona, perché all'avvio il
 * componente legge `?pratica=` e apre da solo la pratica giusta. È anche ciò che
 * rende incollabile in chat il collegamento a UNA pratica.
 *
 * ── LA SCADENZA SI VEDE SENZA APRIRE NIENTE ──────────────────────────────────
 * `document_expiry` è in elenco perché è l'unica colonna che dice quale pratica
 * guardare per prima. Le soglie NON sono ribattute qui: vengono da
 * `@/lib/anagrafica/scadenze` (`giorniResidui`, `sogliaRaggiunta`), che è la stessa
 * logica del cron che manda i promemoria — due elenchi di soglie in due file
 * divergono alla prima modifica, e la schermata direbbe «in regola» su un documento
 * per cui l'allarme è già partito.
 *
 * ── DOVE FINISCE UN ESITO CHE NON SI PUÒ MOSTRARE ────────────────────────────
 * In un avviso fuori dal pannello, che NOMINA la persona e riporta l'esito per
 * intero, credenziali comprese: la password è monouso e non è archiviata da nessuna
 * parte, quindi buttarla vuol dire una reimpostazione obbligata. Le voci si
 * ACCUMULANO e se ne vanno solo con un gesto — aprire un'altra pratica non è una
 * presa d'atto.
 */

/** La riga d'ELENCO: esattamente le colonne che la route proietta in lista. */
interface RigaElenco {
  id: string
  scuola_id?: string | null
  stato: string
  nome?: string | null
  cognome?: string | null
  document_expiry?: string | null
  creata_il?: string | null
}

/** La pratica APERTA: la riga d'elenco più tutto ciò che arriva da `?id=`. */
interface Pratica extends RigaElenco {
  gender?: string | null
  birth_date?: string | null
  birth_place?: string | null
  birth_province?: string | null
  birth_nation?: string | null
  codice_belfiore_nascita?: string | null
  fiscal_code?: string | null
  citizenship?: string | null
  address?: string | null
  residence_street_number?: string | null
  residence_city?: string | null
  residence_province?: string | null
  zip_code?: string | null
  domicilio_address?: string | null
  domicilio_street_number?: string | null
  domicilio_city?: string | null
  domicilio_province?: string | null
  domicilio_zip_code?: string | null
  email?: string | null
  telefono?: string | null
  document_type?: string | null
  document_number?: string | null
  /**
   * LE DUE FACCE DEL DOCUMENTO, e sono due campi perché hanno due destini.
   *
   * Fino al 12/08/2026 era `documento_path`, una scansione sola. All'approvazione ogni
   * faccia può passare al fascicolo per conto suo (il travaso degrada una colonna alla
   * volta), quindi una pratica può restare con il retro e senza il fronte: due chiavi
   * separate sono l'unico modo di disegnare quello stato senza mentire.
   */
  documento_fronte_path?: string | null
  documento_retro_path?: string | null
  titolo_studio?: string | null
  titolo_dettaglio?: string | null
  gradi?: unknown
  emergenza_nome?: string | null
  emergenza_telefono?: string | null
  emergenza_relazione?: string | null
  motivo_rifiuto?: string | null
  consents_log?: {
    versione_consensi?: string | null
    accettato_il?: string | null
    n_blocchi?: number | null
  } | null
}

type Azione = 'approva' | 'rifiuta' | 'sposta-sede'

/**
 * UN AVVISO DEL SERVER — un CODICE, non una frase.
 *
 * Fino al 2026-08-12 la route componeva i suoi `warnings` in italiano e qui si
 * stampavano verbatim: erano gli unici testi della schermata a non passare dal
 * catalogo, ed erano proprio quelli che dicono «l'account NON è stato aggiornato» e
 * «la pratica NON risulta legata all'account: NON ripremere Approva». In interfaccia
 * inglese uscivano in italiano. È lo stesso difetto che questo file evitava già per
 * gli errori (vedi `messaggioDaCorpo`), lasciato aperto sul ramo che conta di più.
 */
interface Avviso {
  codice: string
  parametri?: Record<string, string | number>
}

/**
 * QUELL'EMAIL HA GIÀ UN ACCESSO? — la risposta arriva col dettaglio (`?id=`), quindi
 * PRIMA che qualcuno prema «Confermo».
 *
 * `esiste: null` è «non si è potuto verificare», e non si confonde con `false`: sono
 * due frasi diverse, e una delle due sarebbe una bugia.
 */
interface SguardoAccount {
  esiste?: boolean | null
  ruolo?: string | null
  sede_gestita?: boolean | null
  sede_nome?: string | null
}

/**
 * L'esito di un'azione, mostrato una volta e poi congedato.
 *
 * `stato` è quello che ha risposto il SERVER, non quello che si era chiesto: è
 * l'unica fonte che distingue un'approvazione chiusa da una rimasta a metà.
 */
interface Esito {
  azione: Azione
  stato: string | null
  credentials?: { email: string; password: string } | null
  /**
   * La password è anche PARTITA per email? Dal 2026-08-15 l'approvazione la
   * spedisce, e la distinzione cambia cosa deve fare chi legge: se è partita non
   * c'è niente da consegnare a mano, se non è partita quella a schermo è l'unica
   * copia esistente. Un riquadro che non lo dice le fa sembrare la stessa cosa.
   */
  credentialsEmailSent?: boolean
  accountCreato?: boolean
  spostata?: boolean
}

/**
 * Un esito che NON si è potuto mostrare nel pannello, perché nel frattempo era stato
 * chiuso o ne era stata aperta un'altra pratica.
 *
 * Non è una notifica di cortesia: sul ramo «approva» l'account può ESISTERE, e la
 * password monouso non è archiviata da nessuna parte — questo avviso è l'unica copia
 * che ne esista.
 */
interface EsitoScartato {
  chiave: number
  nome: string
  esito: Esito | null
  avvisi: Avviso[]
  guasto: 'respinta' | 'senzaRisposta' | null
}

const ROUTE_LOG = '/admin/modulistica'
const API = '/api/admin/pratiche-personale'
/** Il collegamento profondo a UNA pratica: è l'`href` del nome in tabella. */
const linkPratica = (id: string) => `?tab=personale&pratica=${encodeURIComponent(id)}`

/**
 * LO STATO SPENTO DI UN COMANDO — si DIPINGE, non si sbiadisce.
 *
 * ⚠️ È la regola del lock `__tests__/a11y/btn-disabilitato-leggibile.test.tsx`, nato il
 * 2026-08-08 su una misura: `disabled:opacity-45` portava l'inchiostro del pulsante
 * primario a **1,20:1**, perché un'alfa abbassa IN BLOCCO fondo e inchiostro e li
 * avvicina invece di separarli. Quel lock però sorveglia il componente `Btn`, e questa
 * schermata i suoi pulsanti se li scrive a mano: fino al 2026-08-12 cinque comandi di
 * questo file portavano ancora `disabled:opacity-50` — misurato a **2,20:1** — mentre
 * gli altri due della stessa riga facevano già la cosa giusta. Una coppia dichiarata
 * fondo/inchiostro non dipende dalla superficie sotto e regge anche in Alto Contrasto,
 * dove `neutral-soft` diventa scuro e `sub` chiaro.
 *
 * Le tre classi stanno qui in un posto solo, e il lock di questo file
 * (`PratichePersonale.test.tsx`) verifica che nessun comando torni all'alfa.
 */
const SPENTO =
  'disabled:border-kidville-neutral disabled:bg-kidville-neutral-soft disabled:text-kidville-sub'

/**
 * GLI ID DEL RIQUADRO DI CONFERMA — il nome e la descrizione di ciò che prende il fuoco.
 *
 * Sono fissi e non generati: dentro il `Drawer` ne vive UNO alla volta (i tre riquadri
 * si escludono a vicenda), esattamente come i `prat-motivo` e `prat-destinazione` che
 * questo file usa già.
 */
const ID_CONFERMA_TITOLO = 'prat-conferma-titolo'
const ID_CONFERMA_TESTO = 'prat-conferma-testo'
const ID_CONFERMA_ACCOUNT = 'prat-conferma-account'
const ID_CONFERMA_FASCE = 'prat-conferma-fasce'
const ID_CONFERMA_SOSPESA = 'prat-conferma-sospesa'
/** Il ricovero del fuoco di un riquadro di conferma: anello visibile e forma dichiarata. */
const RIQUADRO_CONFERMA = `rounded-xl ${FUOCO_ESITO}`

/** Gli stati che il server usa in colonna, e la chiave i18n del loro badge. */
const CHIAVE_STATO: Record<string, string> = {
  pending: 'pratStatoAttesa',
  in_approvazione: 'pratStatoInApprovazione',
  approvata: 'pratStatoApprovata',
  rifiutata: 'pratStatoRifiutata',
}

/**
 * Il tono del badge di stato — dal catalogo di `Badge`, mai una stringa di classi
 * scritta a mano: è l'unico posto in cui i quattro colori sono dichiarati con i loro
 * rapporti di contrasto, Alto Contrasto compreso.
 */
const TONO_STATO: Record<string, BadgeTone> = {
  pending: 'warn',
  in_approvazione: 'inCorso',
  approvata: 'success',
  rifiutata: 'error',
}

/**
 * Fasce e titoli di studio riusano le chiavi `cand*`: sono gli STESSI elenchi chiusi
 * (`GRADI_OPTIONS`, `TITOLI_STUDIO` di `insegnanti-template.ts`), e due chiavi di
 * catalogo per la stessa etichetta è esattamente il difetto che il lock
 * `messaggi-plurali-e-glossario` sorveglia — «Presa visione» chiamata in due modi
 * nella stessa schermata. Una fascia si chiama «Nido (0-3)» ovunque.
 */
const CHIAVE_GRADO: Record<string, string> = {
  nido: 'candGradoNido',
  infanzia: 'candGradoInfanzia',
  primaria: 'candGradoPrimaria',
}

const CHIAVE_TITOLO: Record<string, string> = {
  diploma: 'candTitoloDiploma',
  magistrale: 'candTitoloMagistrale',
  laurea_triennale: 'candTitoloLaureaTriennale',
  laurea_magistrale: 'candTitoloLaureaMagistrale',
  formazione_primaria: 'candTitoloFormazionePrimaria',
  master: 'candTitoloMaster',
  altro: 'candTitoloAltro',
}

const ORDINE_GRADI = GRADI_OPTIONS.map((o) => String(o.value))

/** Il tipo di documento: l'etichetta la porta il template, non una mappa ribattuta. */
const ETICHETTA_DOCUMENTO = new Map(TIPI_DOCUMENTO.map((o) => [String(o.value), o.label]))

/**
 * Le fasce della pratica, ordinate come nel modulo pubblico e senza doppioni. Un
 * valore FUORI dall'enum non si butta: si mostra grezzo, perché nasconderlo direbbe
 * che quella pratica non ha fasce mentre in tabella ce n'è una che qualcuno dovrà
 * sistemare.
 */
function gradiOrdinati(grezzi: unknown): string[] {
  if (!Array.isArray(grezzi)) return []
  const presenti = [...new Set(grezzi.map((g) => String(g)).filter((g) => g !== ''))]
  return [
    ...ORDINE_GRADI.filter((g) => presenti.includes(g)),
    ...presenti.filter((g) => !ORDINE_GRADI.includes(g)),
  ]
}

/**
 * Lo stato del documento d'identità, dalle SOGLIE CONDIVISE.
 *
 * `null` = non c'è una scadenza leggibile, ed è uno stato a sé: dire «in regola» su
 * una data che non si è potuta leggere è la bugia più comoda di tutta la schermata.
 */
function statoDocumento(
  scadenza: string | null | undefined,
  oggi: string,
): { soglia: number | null; giorni: number } | null {
  const ymd = (scadenza ?? '').slice(0, 10)
  if (ymd === '') return null
  const giorni = giorniResidui(ymd, oggi)
  if (!Number.isFinite(giorni)) return null
  return { soglia: sogliaRaggiunta(giorni), giorni }
}

/** L'esito e gli avvisi, letti dal corpo della PATCH — in un posto solo: li leggono
 *  due strade (il riquadro nel pannello e l'avviso dell'esito scartato). */
function esitoDaRisposta(azione: Azione, stato: string | null, json: unknown): Esito {
  const corpo = (json ?? {}) as Record<string, unknown>
  return {
    azione,
    stato,
    credentials: (corpo.credentials as Esito['credentials']) ?? null,
    credentialsEmailSent: corpo.credentialsEmailSent === true,
    accountCreato: corpo.accountCreato === true,
    spostata: corpo.spostata === true,
  }
}

/**
 * Gli avvisi, letti dal corpo — e SETACCIATI: passa solo ciò che ha un `codice`
 * stringa. Un corpo malformato non deve produrre voci vuote in elenco, che
 * sembrerebbero avvisi persi.
 */
function avvisiDaRisposta(json: unknown): Avviso[] {
  const w = ((json ?? {}) as Record<string, unknown>).warnings
  if (!Array.isArray(w)) return []
  return w.flatMap((v) => {
    const codice = (v as { codice?: unknown } | null)?.codice
    if (typeof codice !== 'string' || codice === '') return []
    const parametri = (v as { parametri?: unknown }).parametri
    return [{
      codice,
      parametri:
        parametri && typeof parametri === 'object'
          ? (parametri as Record<string, string | number>)
          : undefined,
    }]
  })
}

/** La chiave di catalogo di un avviso: `fasceNonApplicate` → `pratAvvisoFasceNonApplicate`. */
const chiaveAvviso = (codice: string) =>
  `pratAvviso${codice.charAt(0).toUpperCase()}${codice.slice(1)}`

/**
 * IL RUOLO CHE FA FALLIRE L'APPROVAZIONE.
 *
 * `utenti.ruolo` non ha né `CHECK` né enum, e il server la decisione la prende sul
 * valore NORMALIZZATO (`staff-identity.ts` → `riusaIdentitaEsistente`: `.trim()` +
 * `.toLowerCase()`, perché `'Genitore'` e `'genitore '` sono la stessa persona per
 * chiunque legga). Qui si normalizza allo stesso modo: un riquadro che prevede un
 * esito diverso da quello che accadrà è peggio di un riquadro muto.
 *
 * Il letterale è ribattuto invece che importato apposta: `staff-identity.ts` è un
 * modulo di server (parla col client service-role) e non entra in un componente
 * `'use client'`.
 */
const RUOLO_GENITORE = 'genitore'

/**
 * CHE COSA FARÀ IL SERVER CON QUESTA EMAIL — una domanda, una risposta, un posto solo.
 *
 * La stessa risposta serve a DUE cose che non possono divergere: la FRASE del riquadro
 * di conferma e lo STATO del pulsante «Confermo». Fino al 2026-08-12 la frase c'era e
 * il pulsante no: il pannello scriveva «l'approvazione verrà rifiutata e non verrà
 * scritto niente» e lasciava «Confermo» acceso sotto, cioè contraddiceva sé stesso a
 * dodici pixel di distanza. Ed è la stessa regola per cui il gemello spegne i suoi
 * comandi: scoprire un 403 dopo il clic fa sembrare un guasto un divieto legittimo.
 *
 * Su `altraSede` quel clic non è nemmeno «uno sprecato»: il gesto CLAIMA la pratica
 * (`pending → in_approvazione`) e la riporta indietro con `rimettiPending`. Se quel
 * ripristino fallisce — un ramo che la route logga a `error` perché sa che esiste — la
 * pratica resta appesa. L'unico clic che l'interfaccia sa già che fallirà era anche
 * l'unico che poteva bloccare la pratica.
 *
 * Due strade, una regola sola: è la lezione del ciclo 2 di `/ship-cycle`.
 */
type EsitoPrevisto = 'ignoto' | 'nuovo' | 'altraSede' | 'genitore' | 'riscrittura'

function esitoPrevisto(sguardo: SguardoAccount | null): EsitoPrevisto {
  const esiste = sguardo?.esiste ?? null
  // `null` è «non si è potuto verificare», e NON si confonde con `false`: sono due
  // frasi diverse, e una delle due sarebbe una bugia.
  if (esiste === null) return 'ignoto'
  if (esiste === false) return 'nuovo'
  // ⚠️ L'ORDINE È QUELLO DEL SERVER: quando la sede non è gestita il ruolo non viene
  // nemmeno mandato (e fa bene: il ruolo di una persona di un altro plesso non serve a
  // decidere), quindi il fatto che conta lì è il diniego di sede.
  if (sguardo?.sede_gestita === false) return 'altraSede'
  // Normalizzato COME LO NORMALIZZA IL SERVER (`riusaIdentitaEsistente`: `.trim()` +
  // `.toLowerCase()`): `'Genitore'` e `'genitore '` sono la stessa persona.
  if ((sguardo?.ruolo ?? '').trim().toLowerCase() === RUOLO_GENITORE) return 'genitore'
  return 'riscrittura'
}

/**
 * I DUE ESITI IN CUI L'APPROVAZIONE È GIÀ PERSA — il server risponderà 403 o 409 e non
 * scriverà niente. `ignoto` NON è qui: «non si è potuto verificare» non è «fallirà», e
 * spegnere un comando su un'incertezza toglierebbe l'unica strada a chi invece potrebbe
 * approvare.
 */
const APPROVAZIONE_PERSA: readonly EsitoPrevisto[] = ['altraSede', 'genitore']

/** L'etichetta di un ruolo `utenti.ruolo`, dal catalogo e non da una stringa a mano. */
const CHIAVE_RUOLO: Record<string, string> = {
  admin: 'pratRuoloAdmin',
  coordinator: 'pratRuoloCoordinator',
  segreteria: 'pratRuoloSegreteria',
  educator: 'pratRuoloEducator',
  cuoca: 'pratRuoloCuoca',
  genitore: 'pratRuoloGenitore',
}

/** Accoda una pagina DEDUPLICANDO per `id`: l'offset conta le righe già viste. */
function accoda(precedenti: RigaElenco[], nuove: RigaElenco[]): RigaElenco[] {
  const perId = new Map(precedenti.map((r) => [r.id, r]))
  for (const riga of nuove) perId.set(riga.id, riga)
  return [...perId.values()]
}

export function PratichePersonale() {
  const t = useTranslations('adminAltro')
  const f = useDateFormat()
  const { reFetchKey, sedi, effettive, tutte } = useSediAttive()
  const searchParams = useSearchParams()

  const [righe, setRighe] = useState<RigaElenco[]>([])
  const [totale, setTotale] = useState(0)
  // «La pagina è tornata più corta del limite», cioè: non ce n'è un'altra. Serve
  // perché dalla pagina 2 in poi `total` può mancare, e col solo
  // `righe.length < totale` un `total` stantìo lascia «Mostra altre» acceso per
  // sempre su un elenco che non cresce più.
  const [finePagine, setFinePagine] = useState(false)
  const [caricamento, setCaricamento] = useState(true)
  const [caricandoAltre, setCaricandoAltre] = useState(false)
  /** Una rilettura è in volo: «Mostra altre» si spegne — accodare a una lista che sta
   *  per essere sostituita mescolerebbe due plessi. */
  const [ricaricaInVolo, setRicaricaInVolo] = useState(false)
  /**
   * L'ULTIMA lettura d'elenco è FALLITA. Tiene separati due stati che altrimenti
   * collassano in uno: «non è arrivata nessuna pratica» e «l'elenco non si è riusciti
   * a leggerlo». Con zero righe si scriverebbe «Nessuna pratica ricevuta» anche con la
   * GET a 503 — un'affermazione di fatto FALSA accanto all'avviso rosso che dice il
   * contrario.
   */
  const [letturaFallita, setLetturaFallita] = useState(false)
  const [aprendo, setAprendo] = useState<string | null>(null)
  const [selezionata, setSelezionata] = useState<Pratica | null>(null)
  const [conferma, setConferma] = useState<Azione | null>(null)
  const [motivo, setMotivo] = useState('')
  const [destinazione, setDestinazione] = useState('')
  /**
   * L'`id` della pratica su cui una PATCH è in volo — non un booleano: uno stato
   * condiviso spegnerebbe i pulsanti di CHIUNQUE mentre l'approvazione di un'altra
   * persona viaggia, senza dire perché.
   */
  const [lavorandoSu, setLavorandoSu] = useState<string | null>(null)
  const [errore, setErrore] = useState<string | null>(null)
  const [esito, setEsito] = useState<Esito | null>(null)
  /** Gli avvisi del server vivono FUORI dal riquadro congedabile: sono la sola traccia
   *  di ciò che è stato scritto a metà. */
  const [avvisi, setAvvisi] = useState<Avviso[]>([])
  /** Che cosa sa il server dell'email di QUESTA pratica, prima che si prema «Confermo». */
  const [sguardo, setSguardo] = useState<SguardoAccount | null>(null)
  /** La URL firmata della scansione, quando il browser ha bloccato la finestra. */
  const [docBloccato, setDocBloccato] = useState<string | null>(null)
  const [esitiScartati, setEsitiScartati] = useState<EsitoScartato[]>([])
  /** Le sedi possibili come DESTINAZIONE, lette solo quando servono (vedi sotto). */
  const [sediDestinazione, setSediDestinazione] = useState<{ id: string; nome: string }[] | null>(null)
  const [sediNonLette, setSediNonLette] = useState(false)

  // I gettoni: uno per l'elenco, uno per il dettaglio.
  const gettoneElenco = useRef(0)
  const gettoneDettaglio = useRef(0)
  /** Solo la `key` React delle voci scartate: due esiti possono avere lo stesso nome. */
  const contatoreScartati = useRef(0)
  /** Il collegamento profondo si apre UNA volta sola, al primo elenco atterrato. */
  const deepLinkAperto = useRef(false)

  /** Registra un esito scartato in coda a quelli che sono già a schermo. */
  function annotaScartato(voce: Omit<EsitoScartato, 'chiave'>) {
    setEsitiScartati((prec) => [...prec, { ...voce, chiave: ++contatoreScartati.current }])
  }

  // Un uuid non dice niente a nessuno: la sede si risolve nel nome del plesso, e
  // l'elenco delle destinazioni — quando è stato letto — entra nella stessa mappa.
  const nomeSede = (scuolaId?: string | null) =>
    sedi.find((s) => s.id === scuolaId)?.nome
    ?? sediDestinazione?.find((s) => s.id === scuolaId)?.nome
    ?? t('pratSedeSconosciuta')

  const etichettaGrado = (g: string) => (CHIAVE_GRADO[g] ? t(CHIAVE_GRADO[g]) : g)

  /** L'etichetta di un enum, o il valore grezzo se è fuori dall'elenco chiuso. */
  const daCatalogo = (mappa: Record<string, string>, valore?: string | null) => {
    const grezzo = (valore ?? '').trim()
    if (grezzo === '') return null
    return mappa[grezzo] ? t(mappa[grezzo]) : grezzo
  }

  const nomeCompleto = (r: RigaElenco | Pratica) =>
    [r.nome ?? '', r.cognome ?? ''].map((s) => s.trim()).filter(Boolean).join(' ')
    || t('pratSenzaNome')

  async function carica(sediKey: string) {
    const mio = ++gettoneElenco.current
    setRicaricaInVolo(true)
    try {
      const res = await fetch(`${API}?limit=${LIMITE_ISCRIZIONI_DEFAULT}&offset=0`, {
        headers: { 'x-sedi': sediKey },
      })
      if (!res.ok) {
        const messaggio = await messaggioErrore(res, t('pratErroreElenco'))
        if (mio === gettoneElenco.current) {
          setErrore(messaggio)
          setLetturaFallita(true)
        }
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: `pratiche-personale-elenco-non-caricato: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      const json = await res.json()
      // La risposta di una richiesta SUPERATA non si scrive: se nel frattempo le sedi
      // sono cambiate, l'elenco a schermo sarebbe quello del plesso di prima.
      if (mio !== gettoneElenco.current) return
      if (Array.isArray(json?.data)) {
        setRighe(json.data as RigaElenco[])
        setTotale(typeof json.total === 'number' ? json.total : json.data.length)
        setFinePagine(false)
        setErrore(null)
        setLetturaFallita(false)
      } else {
        // 200 con un corpo che non è un elenco: è una lettura FALLITA quanto un 503, e
        // in silenzio si leggerebbe come «non è arrivato niente».
        setErrore(t('pratErroreElenco'))
        setLetturaFallita(true)
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: 'pratiche-personale-elenco-corpo-inatteso: data non è un elenco',
          route: ROUTE_LOG,
          stato: res.status,
        })
      }
    } catch (e) {
      if (mio === gettoneElenco.current) {
        setErrore(t('pratErroreElenco'))
        setLetturaFallita(true)
      }
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `pratiche-personale-elenco-fallito: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      if (mio === gettoneElenco.current) {
        setCaricamento(false)
        setRicaricaInVolo(false)
      }
    }
  }

  /** Il ritenta del riquadro «elenco non letto»: rimette il velo e rilegge. */
  function riprovaElenco() {
    setCaricamento(true)
    void carica(reFetchKey)
  }

  /**
   * Si ricarica quando cambiano le sedi attive, e SOLO per quello.
   *
   * `carica` non è fra le dipendenze e non serve una deroga: l'effetto chiama la
   * versione più fresca passando da un `ref`, e un ref è stabile per costruzione.
   * (`useCallback` non è un'alternativa: `carica` usa `t()`, che nel banco di prova è
   * una funzione nuova a ogni render — l'effetto rifarebbe la fetch all'infinito.)
   */
  const caricaRef = useRef(carica)
  useEffect(() => { caricaRef.current = carica })
  useEffect(() => { caricaRef.current(reFetchKey) }, [reFetchKey])

  /**
   * IL COLLEGAMENTO PROFONDO. `?pratica=<uuid>` apre quella pratica all'avvio: è ciò
   * che rende vero l'`href` del nome in tabella — un link che non funziona quando lo
   * si apre in una scheda nuova è un link che mente — ed è anche l'indirizzo che si
   * incolla in chat per dire «guarda questa».
   *
   * Si esegue una volta sola (`deepLinkAperto`): senza, un cambio di sede o una
   * ricarica d'elenco riaprirebbero il pannello sotto le mani di chi l'ha chiuso.
   */
  const apriRef = useRef<(riga: RigaElenco) => void>(() => {})
  useEffect(() => {
    if (deepLinkAperto.current || caricamento) return
    const id = searchParams.get('pratica')
    if (!id) return
    const riga = righe.find((r) => r.id === id)
    if (!riga) return
    deepLinkAperto.current = true
    apriRef.current(riga)
  }, [searchParams, righe, caricamento])

  /** Pagina successiva, in coda a quelle già mostrate. */
  async function caricaAltre() {
    // Il gettone si LEGGE, non si incrementa: accodare non crea un'identità d'elenco
    // nuova. Incrementandolo, un clic su «Mostra altre» scarterebbe una rilettura per
    // cambio sede ancora in volo e accoderebbe la pagina della sede nuova alle righe
    // di quella vecchia.
    const mio = gettoneElenco.current
    setCaricandoAltre(true)
    try {
      const res = await fetch(`${API}?limit=${LIMITE_ISCRIZIONI_DEFAULT}&offset=${righe.length}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      if (!res.ok) {
        const messaggio = await messaggioErrore(res, t('pratErrorePagina'))
        if (mio === gettoneElenco.current) setErrore(messaggio)
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: `pratiche-personale-pagina-non-caricata: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      const json = await res.json()
      if (mio !== gettoneElenco.current) return
      if (Array.isArray(json?.data)) {
        const nuove = json.data as RigaElenco[]
        // DEDUPLICATO per `id`: il modulo pubblico riceve invii di continuo, e una
        // pratica arrivata fra la prima pagina e la seconda sposta tutto di uno e fa
        // ricomparire una riga — con la stessa `key` React.
        setRighe((prec) => accoda(prec, nuove))
        if (typeof json.total === 'number') setTotale(json.total)
        if (nuove.length < LIMITE_ISCRIZIONI_DEFAULT) setFinePagine(true)
        setErrore(null)
      }
    } catch (e) {
      if (mio === gettoneElenco.current) setErrore(t('pratErrorePagina'))
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `pratiche-personale-pagina-fallita: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      setCaricandoAltre(false)
    }
  }

  /**
   * Apre una pratica: è QUI che si chiedono codice fiscale, residenza, estremi del
   * documento e contatto d'emergenza, per una riga sola. L'esito non si butta via — il
   * server risponde 404 anche quando la pratica è di un'altra sede, e un pannello che
   * resta vuoto senza dire niente è peggio di un errore.
   */
  async function apriDettaglio(riga: RigaElenco) {
    const mio = ++gettoneDettaglio.current
    setSelezionata(null)
    setAprendo(riga.id)
    setConferma(null)
    setMotivo('')
    setDestinazione('')
    setEsito(null)
    setAvvisi([])
    setSguardo(null)
    setDocBloccato(null)
    setErrore(null)
    // Gli esiti scartati NON si azzerano qui: parlano di un'ALTRA pratica e sono
    // l'unica copia di una password monouso.
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(riga.id)}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      const json = await res.json().catch((e: unknown) => {
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `pratica-personale-dettaglio-corpo-illeggibile: ${nomeErrore(e)}`,
          route: ROUTE_LOG,
        })
        return null
      })
      // Il clic più recente ha già vinto: questa risposta non tocca lo schermo.
      if (mio !== gettoneDettaglio.current) return
      if (!res.ok || !json?.data) {
        setErrore(messaggioDaCorpo(json, t('pratDettaglioNonAperto')))
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `pratica-personale-dettaglio-non-aperto: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      setSelezionata(json.data as Pratica)
      // Quello che il server sa dell'email di questa pratica. Se la chiave non c'è —
      // route più vecchia della pagina, o corpo malformato — resta `null`, e il
      // riquadro di conferma lo dirà con la voce «non si è potuto verificare» invece
      // di tacere: tacere si legge come «nessun account», che è l'unica delle tre
      // risposte che non si può dedurre da un'assenza.
      const acc = (json as { account?: unknown }).account
      setSguardo(acc && typeof acc === 'object' ? (acc as SguardoAccount) : null)
    } catch (e) {
      if (mio === gettoneDettaglio.current) setErrore(t('pratDettaglioNonAperto'))
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `pratica-personale-dettaglio-fallito: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      // Il velo si spegne solo se non c'è una richiesta più recente in volo:
      // altrimenti lo spegnerebbe la PRIMA risposta arrivata, mostrando il pannello
      // vuoto mentre l'apertura vera sta ancora viaggiando.
      if (mio === gettoneDettaglio.current) setAprendo(null)
    }
  }
  useEffect(() => { apriRef.current = apriDettaglio })

  /**
   * Chiude il pannello — ed è un CAMBIO D'APERTURA a tutti gli effetti: il gettone
   * avanza, così l'esito di una PATCH ancora in volo non riapre da solo un pannello
   * che qualcuno ha appena chiuso.
   */
  function chiudiDettaglio() {
    gettoneDettaglio.current += 1
    setSelezionata(null)
    setAprendo(null)
  }

  /**
   * LE SEDI DI DESTINAZIONE, lette solo quando si apre «Sposta di sede».
   *
   * ⚠️ NON bastano le sedi del contesto: quelle sono le sedi ACCESSIBILI a chi guarda,
   * e il caso per cui questa azione esiste è proprio l'altro — una segreteria di un
   * plesso solo che si ritrova la pratica di un plesso che non gestisce. Con l'elenco
   * ristretto, l'unica persona che può rimediare sarebbe l'unica che non ne ha
   * bisogno. L'elenco pubblico (`/api/iscrizione/sedi`) è la stessa lista che il
   * modulo mostra a chi compila — sedi vere, sede della CI esclusa.
   *
   * Si legge SU RICHIESTA e non al montaggio: quella rotta ha un tetto anti-abuso per
   * indirizzo IP, e una segreteria dietro il NAT della scuola lo brucerebbe aprendo la
   * pagina. Se non si legge, si ripiega sulle sedi accessibili e lo si DICE: un menù
   * più corto senza spiegazione si legge come «quella sede non esiste».
   */
  async function caricaSediDestinazione() {
    if (sediDestinazione !== null) return
    try {
      const res = await fetch('/api/iscrizione/sedi')
      const json = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(json?.data)) {
        setSediNonLette(true)
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `pratiche-personale-sedi-non-lette: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      setSediDestinazione(json.data as { id: string; nome: string }[])
      setSediNonLette(false)
    } catch (e) {
      setSediNonLette(true)
      logClient({
        livello: 'warn',
        evento: 'react',
        messaggio: `pratiche-personale-sedi-fallite: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    }
  }

  /**
   * La scansione del documento: la URL è firmata dal server e vive cinque minuti.
   *
   * ⚠️ IL COME NON STA QUI, e non è una delega di comodo. Aprire un file di un bucket
   * privato è lo stesso gesto in tre pannelli della Segreteria (curriculum, allegato
   * d'iscrizione, e questa scansione) e porta con sé quattro fatti già pagati: la
   * finestra si apre PRIMA della fetch, dentro il gesto (Safari e la WebView Capacitor
   * bloccano una `window.open` in continuazione di promise, e il risultato non è un
   * errore: è un pulsante che non fa niente); `opener` a null; il blocco popup è il
   * caso più frequente e non è un guasto; nessun percorso nei log. Vivono in
   * `apriDocumentoFirmato`, una volta sola.
   *
   * Quello che resta QUI è l'unica cosa che il pannello sa e la funzione no: la FRASE.
   * I codici che questa rotta manda su quel ramo parlano della PRATICA, non del file.
   *
   * Si chiama DAL gestore del clic, mai da un effetto: è la condizione perché la
   * finestra sia ancora dentro il gesto dell'utente.
   */
  async function apriDocumento(path?: string | null) {
    if (!path) return
    setDocBloccato(null)
    const esitoDoc = await apriDocumentoFirmato({
      endpoint: API,
      path,
      headers: { 'x-sedi': reFetchKey },
      route: ROUTE_LOG,
      etichetta: 'pratica-personale-documento',
    })
    if (esitoDoc.esito === 'bloccato') setDocBloccato(esitoDoc.url)
    else if (esitoDoc.esito === 'errore') setErrore(t('pratErroreDoc'))
  }

  /** Approva, rifiuta o sposta. La conferma è già stata data nel pannello. */
  async function esegui(azione: Azione) {
    if (!selezionata) return
    if (azione === 'sposta-sede' && destinazione === '') return
    // Il gettone dell'apertura in corso, LETTO e non incrementato: l'azione non cambia
    // quale pratica è aperta, ma la sua risposta vale solo se nessun'altra apertura è
    // arrivata nel frattempo. Il nome si cattura adesso, perché è di questa persona
    // che parlerà l'avviso se l'esito va scartato.
    const mio = gettoneDettaglio.current
    const idBersaglio = selezionata.id
    const nomeBersaglio = nomeCompleto(selezionata)
    const attuale = () => mio === gettoneDettaglio.current
    setLavorandoSu(idBersaglio)
    setErrore(null)
    try {
      const corpo =
        azione === 'approva'
          ? { id: idBersaglio, action: 'approva' }
          : azione === 'rifiuta'
            ? { id: idBersaglio, action: 'rifiuta', motivo: motivo.trim() || undefined }
            : { id: idBersaglio, action: 'sposta-sede', scuola_id: destinazione }
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-sedi': reFetchKey },
        body: JSON.stringify(corpo),
      })
      const json = await res.json().catch((e: unknown) => {
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `pratica-personale-azione-corpo-illeggibile: ${nomeErrore(e)}`,
          route: ROUTE_LOG,
        })
        return null
      })
      if (!res.ok) {
        // L'esito NON si butta via: 403 di sede, 409 «già evasa», 503. Chiudere il
        // pannello senza guardare significherebbe dire «fatto» su un'approvazione mai
        // avvenuta. E si passa dal CATALOGO, non dalla prosa del server, altrimenti in
        // interfaccia inglese uscirebbe l'italiano scritto nella route.
        if (attuale()) setErrore(messaggioDaCorpo(json, t('pratErroreAzione')))
        else annotaScartato({ nome: nomeBersaglio, esito: null, avvisi: avvisiDaRisposta(json), guasto: 'respinta' })
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `pratica-personale-azione-respinta: ${azione} http ${res.status}${attuale() ? '' : ' (esito scartato: apertura cambiata)'}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        // Gli avvisi di un rifiuto del server (l'account creato lo stesso, per dirne
        // uno) restano a schermo anche quando il pannello è ancora quello giusto:
        // sono l'unica traccia di ciò che è stato scritto a metà.
        if (attuale()) setAvvisi(avvisiDaRisposta(json))
        return
      }
      const statoNuovo = typeof json?.stato === 'string' ? json.stato : null
      if (!attuale()) {
        // L'operazione è AVVENUTA: quello che si scarta è solo il POSTO in cui
        // mostrarla. Il riquadro del pannello non si disegna — ci scriverebbe le
        // credenziali di una persona sotto il nome di un'altra — ma l'esito viene
        // riportato per intero in un avviso che NOMINA la persona.
        annotaScartato({
          nome: nomeBersaglio,
          esito: esitoDaRisposta(azione, statoNuovo, json),
          avvisi: avvisiDaRisposta(json),
          guasto: null,
        })
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `pratica-personale-azione-esito-scartato: ${azione} apertura cambiata durante la PATCH`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        await carica(reFetchKey)
        return
      }
      setConferma(null)
      setEsito(esitoDaRisposta(azione, statoNuovo, json))
      setAvvisi(avvisiDaRisposta(json))
      /**
       * NON SOLO LO STATO: LE SCANSIONI HANNO CAMBIATO PROPRIETARIO.
       *
       * All'approvazione la pratica RILASCIA i percorsi delle due facce (un oggetto, un
       * proprietario: da lì in poi la scansione è del fascicolo). Tenendo qui i percorsi
       * vecchi, il pannello continuava a offrire il pulsante che apre quella faccia
       * invece della frase «è passata al fascicolo» — che pure esiste, ed è scritta
       * apposta per questo caso. Il pulsante risponde 403: chi ha appena approvato e
       * vuole ricontrollare il documento riceve un diniego di SEDE su una pratica sua,
       * che sembra un problema di permessi che non c'è. E ogni clic scrive un
       * `documento-non-risolto` in `multi_sede`: il registro di sorveglianza degli
       * accessi alle scansioni dei documenti d'identità si riempie di falsi positivi
       * generati dal percorso normale — l'allarme che si impara a ignorare.
       *
       * ⚠️ UNA FACCIA ALLA VOLTA, perché il server risponde una faccia alla volta: nel
       * degrado su colonna assente il fronte può passare e il retro no, e un unico
       * booleano nasconderebbe anche il pulsante del retro — cioè l'unica strada
       * rimasta verso l'unica copia raggiungibile di quel file.
       *
       * ⚠️ `!== false` E NON `=== true`, per ciascun lato, ed è la stessa difesa di
       * prima: una route più VECCHIA di questa pagina non manda `documentiRilasciati`,
       * e `undefined` non è `false`. Solo un rifiuto ESPLICITO del server conserva il
       * percorso; il caso normale resta il rilascio. Al contrario, `=== true` farebbe
       * sopravvivere il pulsante a ogni risposta che non conosce la chiave — cioè
       * proprio durante un rilascio, quando una pagina in cache parla con la route
       * nuova o viceversa.
       */
      const rilasciati = (json ?? {}) as { documentiRilasciati?: { fronte?: unknown; retro?: unknown } }
      const approvazioneRiuscita = azione === 'approva' && statoNuovo === 'approvata'
      const fronteRilasciato = approvazioneRiuscita && rilasciati.documentiRilasciati?.fronte !== false
      const retroRilasciato = approvazioneRiuscita && rilasciati.documentiRilasciati?.retro !== false
      if (statoNuovo) {
        setSelezionata((s) =>
          s
            ? {
                ...s,
                stato: statoNuovo,
                ...(fronteRilasciato ? { documento_fronte_path: null } : {}),
                ...(retroRilasciato ? { documento_retro_path: null } : {}),
              }
            : s,
        )
      }
      await carica(reFetchKey)
    } catch (e) {
      // Qui non si sa nemmeno se l'operazione sia avvenuta: la risposta non è mai
      // arrivata. È diverso da «respinta», e va detto con parole diverse.
      if (attuale()) setErrore(t('pratErroreAzione'))
      else annotaScartato({ nome: nomeBersaglio, esito: null, avvisi: [], guasto: 'senzaRisposta' })
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `pratica-personale-azione-fallita: ${azione} ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      // Solo se è ancora la NOSTRA: se nel frattempo è partita un'operazione su
      // un'altra pratica, spegnere qui accenderebbe i suoi pulsanti mentre la sua
      // PATCH è ancora in volo.
      setLavorandoSu((corrente) => (corrente === idBersaglio ? null : corrente))
    }
  }

  const oggi = dataCivile()
  /**
   * IL PANNELLO È APERTO? — e da qui in poi non è una domanda estetica.
   *
   * `Drawer` è un `role="dialog" aria-modal="true"`: tutto ciò che sta FUORI è coperto
   * dal pannello e dal velo, e per uno screen reader è escluso dall'albero. Fino al
   * 2026-08-12 l'errore di «Approva»/«Rifiuta»/«Sposta» e l'avviso degli esiti
   * scartati vivevano solo qui, nel frammento di pagina — misurato in browser a 500 px:
   * `document.elementFromPoint` su quattro punti dell'avviso restituiva quattro volte
   * un `div` del drawer, mai l'avviso; in jsdom `dialog.contains(getByRole('alert'))`
   * era `false`. Sul caso più frequente (409 «già evasa») il pannello non mostrava
   * NIENTE, e il pulsante «Confermo» tornava attivo: chi premeva ripremeva.
   *
   * La correzione non duplica il markup — due copie dello stesso avviso divergono, e
   * uno screen reader le annuncerebbe entrambe: c'è UNA copia, e questo booleano
   * decide DOVE montarla.
   */
  const pannelloAperto = aprendo !== null || selezionata !== null
  const inAttesa = righe.filter((r) => r.stato === 'pending' || r.stato === 'in_approvazione')
  // Due domande diverse: «le righe caricate sono TUTTE quelle che esistono?» governa i
  // riquadri per stato (un conteggio parziale spacciato per totale è una bugia scritta
  // in grande), «c'è un'altra pagina?» governa il pulsante.
  const tuttoContato = righe.length >= totale
  const altrePagine = !finePagine && righe.length < totale

  /**
   * L'ELENCO È VUOTO — MA VUOTO DOVE? (la QUARTA schermata)
   *
   * «Nessuna anagrafica del personale ricevuta» è un'AFFERMAZIONE, ed è esattamente
   * l'affermazione che il selettore delle sedi rende falsa: con tre plessi reali e il
   * selettore su uno, quella frase nega l'esistenza di pratiche che ci sono e che
   * un'altra postazione vede. Questo file la distinzione fra «vuoto» e «non letto» la
   * faceva già con cura (vedi `letturaFallita`) e poi la lasciava cadere sul filtro:
   * stessa classe di bugia, con una leva in più e senza nemmeno un avviso rosso
   * accanto a smentirla.
   *
   * `effettive` è ciò che il server scopa DAVVERO — il sottoinsieme scelto ∩ le sedi
   * accessibili, oppure tutte le accessibili quando non si è scelto niente — quindi il
   * filtro è attivo solo quando quel numero è MINORE delle sedi accessibili. Con una
   * sede sola, o con tutte selezionate, «vuoto» torna a essere un'affermazione vera e
   * la schermata resta quella di prima.
   */
  const sediGuardate = effettive.length > 0 && effettive.length < sedi.length ? effettive : []
  const nomiSediGuardate = sediGuardate.map((id) => nomeSede(id)).join(' · ')

  return (
    <>
      <p className="mb-4 max-w-2xl font-maven text-sm text-kidville-sub">{t('pratIntro')}</p>

      {/* Errore e avvisi scartati vivono qui SOLO a pannello chiuso: aperto, la loro
          unica copia si monta dentro il dialogo (vedi `pannelloAperto`). */}
      {errore && !pannelloAperto && <AvvisoErrore testo={errore} />}

      {esitiScartati.length > 0 && !pannelloAperto && (
        <AvvisoEsitiScartati voci={esitiScartati} onCongeda={() => setEsitiScartati([])} />
      )}

      {!caricamento && righe.length > 0 && (
        <div className={`mb-6 grid grid-cols-2 gap-3 ${tuttoContato ? 'sm:grid-cols-4' : 'sm:grid-cols-1'}`}>
          <StatCard icon={Users} label={t('pratStatTotale')} value={totale} tone="green" />
          {tuttoContato && (
            <>
              <StatCard icon={Clock} label={t('pratStatAttesa')} value={inAttesa.length} tone="warn" />
              <StatCard icon={CheckCircle2} label={t('pratStatApprovate')} value={righe.filter((r) => r.stato === 'approvata').length} tone="success" />
              <StatCard icon={XCircle} label={t('pratStatRifiutate')} value={righe.filter((r) => r.stato === 'rifiutata').length} tone="error" />
            </>
          )}
        </div>
      )}

      {caricamento ? (
        <div role="status" className="flex min-h-[40vh] items-center justify-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-kidville-green" />
          <span className="font-maven text-kidville-sub">{t('caricamento')}</span>
        </div>
      ) : righe.length === 0 ? (
        // QUATTRO stati, non due: «vuoto» è un'affermazione, e si fa solo quando
        // l'elenco è stato letto davvero (`letturaFallita`) E quando si stanno davvero
        // guardando tutte le sedi accessibili (`sediGuardate`).
        letturaFallita ? (
          <div className="rounded-card border border-kidville-warn/40 bg-kidville-warn-soft p-10 text-center">
            <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-kidville-warn-strong" />
            <p className="font-maven text-kidville-warn-strong">{t('pratElencoNonLetto')}</p>
            <button
              type="button"
              onClick={riprovaElenco}
              className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-pill border border-kidville-green bg-kidville-white px-4 py-2 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
            >
              {t('pratElencoRiprova')}
            </button>
          </div>
        ) : sediGuardate.length > 0 ? (
          // VUOTO QUI, non vuoto in assoluto: il selettore sta guardando una parte dei
          // plessi, e le pratiche degli altri non sono state nemmeno chieste. La frase
          // lo dice, NOMINA le sedi guardate, e porta con sé il rimedio — senza,
          // l'unica strada sarebbe accorgersi da soli del selettore in cima.
          <div className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center">
            <UserCheck className="mx-auto mb-3 h-10 w-10 text-kidville-neutral" />
            <p className="font-maven text-kidville-sub">{t('pratVuotoFiltrato')}</p>
            <p className="mt-1 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-ink">
              {nomiSediGuardate}
            </p>
            <p className="mx-auto mt-2 max-w-md font-maven text-sm text-kidville-sub">{t('pratVuotoFiltratoNota')}</p>
            <button
              type="button"
              onClick={tutte}
              className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-pill border border-kidville-green bg-kidville-white px-4 py-2 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
            >
              <MapPin size={14} /> {t('pratVuotoGuardaTutte')}
            </button>
          </div>
        ) : (
          <div className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center">
            <UserCheck className="mx-auto mb-3 h-10 w-10 text-kidville-neutral" />
            <p className="font-maven text-kidville-sub">{t('pratVuoto')}</p>
          </div>
        )
      ) : (
        <div className="rounded-card border border-kidville-line bg-kidville-white p-4">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-kidville-sub">{t('pratListaHeader')}</h2>
          {/* `sub` e non `muted`: questa riga È l'avviso che l'elenco è troncato. */}
          {!tuttoContato && (
            <p className="mb-2 font-maven text-xs text-kidville-sub">
              {t('pratMostrate', { n: righe.length, totale })}
            </p>
          )}
          <div className={TABLE_WRAP}>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH}>{t('pratColNome')}</th>
                  <th className={TH}>{t('pratColSede')}</th>
                  <th className={TH}>{t('pratColDocumento')}</th>
                  <th className={TH}>{t('pratColRicevuta')}</th>
                  <th className={TH}>{t('pratColStato')}</th>
                </tr>
              </thead>
              <tbody>
                {righe.map((riga) => (
                  <tr key={riga.id} className={TROW}>
                    <td className={TD}>
                      {/* NIENTE `onClick` sulla riga: il nome è un collegamento VERO,
                          raggiungibile da tastiera e apribile in una scheda nuova. Il
                          clic semplice apre il pannello senza ricaricare; quello con
                          Cmd/Ctrl/Shift o col tasto centrale lo lascia fare al browser,
                          e la scheda che si apre funziona davvero. */}
                      <a
                        href={linkPratica(riga.id)}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                          e.preventDefault()
                          void apriDettaglio(riga)
                        }}
                        className="inline-flex min-h-[44px] min-w-[44px] items-center font-barlow font-bold text-kidville-green underline-offset-2 hover:underline"
                      >
                        {nomeCompleto(riga)}
                      </a>
                    </td>
                    <td className={TD}>
                      <span className="flex items-center gap-1 font-maven text-sm text-kidville-sub">
                        <MapPin size={13} className="text-kidville-green" /> {nomeSede(riga.scuola_id)}
                      </span>
                    </td>
                    <td className={TD}>
                      <ScadenzaDocumento scadenza={riga.document_expiry} oggi={oggi} />
                    </td>
                    <td className={`${TD} font-maven text-sm text-kidville-sub`}>
                      {riga.creata_il ? f.dataBreve(riga.creata_il) : t('pratNonIndicato')}
                    </td>
                    <td className={TD}>
                      <BadgeStato stato={riga.stato} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {altrePagine && (
            <button
              type="button"
              onClick={caricaAltre}
              // Spento anche mentre una RILETTURA è in volo: accodare alla lista
              // vecchia mescolerebbe due plessi.
              disabled={caricandoAltre || ricaricaInVolo}
              // ⚠️ Lo stato spento si DIPINGE, non si sbiadisce — vedi `SPENTO`. Ed è
              // il caso peggiore dei cinque: qui il pulsante è spento MENTRE carica,
              // con dentro lo spinner e la parola, cioè l'unico segnale che il gesto
              // sia partito.
              className={`mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-kidville-line px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.03em] text-kidville-green hover:bg-kidville-green-soft ${SPENTO}`}
            >
              {caricandoAltre && <Loader2 size={14} className="animate-spin" />}
              {t('pratMostraAltre')}
            </button>
          )}
        </div>
      )}

      <Drawer
        open={pannelloAperto}
        onClose={chiudiDettaglio}
        title={selezionata ? nomeCompleto(selezionata) : t('caricamento')}
        subtitle={selezionata ? nomeSede(selezionata.scuola_id) : undefined}
        width={560}
      >
        {/* L'AVVISO DEGLI ESITI SCARTATI STA QUI, e non dentro `PannelloPratica`: si
            accende anche mentre un'ALTRA pratica si sta ancora aprendo — è proprio il
            gesto che lo genera — e in quel momento il pannello non è ancora montato.
            Dentro il dialogo, perché è l'unica copia esistente di una password
            monouso e fuori sarebbe coperto dal pannello. */}
        {esitiScartati.length > 0 && (
          <div className="mb-4">
            <AvvisoEsitiScartati voci={esitiScartati} onCongeda={() => setEsitiScartati([])} />
          </div>
        )}
        {/* Il terzo caso: pannello APERTO ma contenuto non ancora montato (una pratica
            si sta caricando). `PannelloPratica` non c'è per ospitare l'errore e la
            pagina è coperta: senza questa riga esisterebbe una finestra in cui
            l'errore non sta da nessuna parte. UNA copia in tutti e tre i casi. */}
        {errore && !selezionata && <AvvisoErrore testo={errore} />}
        {aprendo !== null && !selezionata ? (
          <div role="status" className="flex items-center justify-center gap-3 p-10">
            <Loader2 className="h-5 w-5 animate-spin text-kidville-green" />
            <span className="font-maven text-kidville-sub">{t('caricamento')}</span>
          </div>
        ) : selezionata ? (
          <PannelloPratica
            pratica={selezionata}
            oggi={oggi}
            nomeCompleto={nomeCompleto(selezionata)}
            nomeSede={nomeSede(selezionata.scuola_id)}
            gradi={gradiOrdinati(selezionata.gradi)}
            etichettaGrado={etichettaGrado}
            titoloStudio={daCatalogo(CHIAVE_TITOLO, selezionata.titolo_studio)}
            conferma={conferma}
            setConferma={setConferma}
            motivo={motivo}
            setMotivo={setMotivo}
            destinazione={destinazione}
            setDestinazione={setDestinazione}
            sediDestinazione={(sediDestinazione ?? sedi).filter((s) => s.id !== selezionata.scuola_id)}
            sediNonLette={sediNonLette}
            onApriSposta={caricaSediDestinazione}
            lavorando={lavorandoSu === selezionata.id}
            esito={esito}
            avvisi={avvisi}
            errore={errore}
            sguardo={sguardo}
            docBloccato={docBloccato}
            onChiudiEsito={() => setEsito(null)}
            onEsegui={esegui}
            onApriDocumento={apriDocumento}
          />
        ) : null}
      </Drawer>
    </>
  )
}

/**
 * L'AVVISO D'ERRORE, in un componente perché ha DUE posti in cui montarsi — la pagina
 * e il dialogo — e una copia sola.
 *
 * `role="alert"` è una live-region assertiva: l'inserimento nel DOM viene annunciato.
 * Ma un annuncio non basta a chi guarda lo schermo, e il fuoco resta sul pulsante che
 * ha appena fallito; `tabIndex={-1}` + `focus()` portano l'errore in vista e sotto il
 * cursore dello screen reader, che è quello che serve quando l'errore riguarda il
 * gesto irreversibile appena tentato.
 *
 * `messaggio` come chiave dell'effetto e non `[]`: due errori diversi di fila sono due
 * annunci, e con `[]` il secondo non muoverebbe niente.
 */
function AvvisoErrore({ testo, autoFocus = false }: { testo: string; autoFocus?: boolean }) {
  const rif = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (autoFocus) rif.current?.focus()
  }, [testo, autoFocus])
  return (
    <p
      ref={rif}
      role="alert"
      tabIndex={-1}
      className={`mb-4 flex items-start gap-2 rounded-card border border-kidville-error/30 bg-kidville-error-soft px-4 py-3 font-maven text-sm text-kidville-error-strong ${FUOCO_ESITO}`}
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {testo}
    </p>
  )
}

/**
 * LO STATO DEL DOCUMENTO, in elenco e nel pannello.
 *
 * Tre esiti e non due: «scaduto», «in scadenza» e «in regola» — più il quarto, che è
 * quello che conta di più: `null`. Una scadenza che non si è potuta leggere NON è un
 * documento valido, ed è precisamente su quelle righe che l'allarme automatico non
 * potrà mai suonare.
 */
function ScadenzaDocumento({ scadenza, oggi }: { scadenza?: string | null; oggi: string }) {
  const t = useTranslations('adminAltro')
  const f = useDateFormat()
  const stato = statoDocumento(scadenza, oggi)
  if (!stato) {
    return <Badge tone="neutral">{t('pratDocIgnoto')}</Badge>
  }
  const data = f.dataBreve((scadenza ?? '').slice(0, 10))
  if (stato.soglia === SOGLIA_SCADUTO) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge tone="error">{t('pratDocScaduto')}</Badge>
        <span className="font-maven text-xs text-kidville-sub">{data}</span>
      </span>
    )
  }
  if (stato.soglia !== null) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge tone="warn">{t('pratDocInScadenza', { n: stato.giorni })}</Badge>
        <span className="font-maven text-xs text-kidville-sub">{data}</span>
      </span>
    )
  }
  return <span className="font-maven text-sm text-kidville-ink">{data}</span>
}

function BadgeStato({ stato }: { stato: string }) {
  const t = useTranslations('adminAltro')
  const chiave = CHIAVE_STATO[stato] ?? CHIAVE_STATO.pending
  const tono = TONO_STATO[stato] ?? TONO_STATO.pending
  return <Badge tone={tono}>{t(chiave)}</Badge>
}

/**
 * UN AVVISO DEL SERVER, tradotto dal CATALOGO.
 *
 * ⚠️ Il codice sconosciuto NON si butta e NON si stampa grezzo. Una pagina in cache e
 * una route appena rilasciata sono la condizione normale nei minuti dopo un deploy, e
 * gli avvisi di questa schermata sono quelli che dicono «l'accesso È STATO CREATO lo
 * stesso» e «NON ripremere Approva»: perderne uno vale un secondo account o una
 * pratica premuta due volte. Il ripiego NOMINA il codice, così chi chiama l'assistenza
 * ha in mano la cosa che serve a capire.
 */
function TestoAvviso({ avviso }: { avviso: Avviso }) {
  const t = useTranslations('adminAltro')
  const chiave = chiaveAvviso(avviso.codice)
  if (!t.has(chiave)) return <>{t('pratAvvisoSconosciuto', { codice: avviso.codice })}</>
  return <>{t(chiave, avviso.parametri)}</>
}

/**
 * GLI ESITI CHE NON SI SONO POTUTI MOSTRARE NEL PANNELLO.
 *
 * Dice tre cose: che cosa è successo davvero (un account creato e un'operazione
 * respinta sono frasi opposte), le credenziali quando ci sono, e perché non è stato
 * mostrato — il pannello era stato chiuso OPPURE ne era stata aperta un'altra.
 */
function AvvisoEsitiScartati({ voci, onCongeda }: { voci: EsitoScartato[]; onCongeda: () => void }) {
  const t = useTranslations('adminAltro')
  return (
    <div
      role="alert"
      className="mb-4 space-y-3 rounded-card border border-kidville-warn/40 bg-kidville-warn-soft px-4 py-3"
    >
      {voci.map((v) => (
        <div key={v.chiave} className="flex items-start gap-2 font-maven text-sm text-kidville-warn-strong">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          {/* `min-w-0`: questa colonna è una voce di un contenitore flex e contiene
              la stessa password monouso del riquadro d'esito. Senza, la sua larghezza
              minima automatica vale il min-content — l'email intera — e l'avviso
              sporge dal `Drawer`, che si mette a scorrere di lato. */}
          <div className="min-w-0 space-y-1">
            <p>
              {t('pratEsitoScartatoPre')} <strong>{v.nome}</strong> {t('pratEsitoScartatoPost')}
            </p>

            {v.guasto === 'respinta' && <p>{t('pratScartatoRespinta')}</p>}
            {v.guasto === 'senzaRisposta' && <p>{t('pratScartatoSenzaRisposta')}</p>}

            {v.esito?.azione === 'rifiuta' && <p>{t('pratScartatoRifiutoRegistrato')}</p>}
            {v.esito?.azione === 'sposta-sede' && <p>{t('pratScartatoSpostata')}</p>}

            {v.esito?.azione === 'approva' && (
              <>
                <p className="font-semibold">
                  {v.esito.stato === 'in_approvazione'
                    ? t('pratScartatoAnagraficaAMeta')
                    : t('pratScartatoAnagraficaRegistrata')}
                </p>
                {v.esito.credentials ? (
                  <>
                    <p className="flex items-start gap-1.5 text-kidville-ink">
                      <KeyRound size={14} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 select-all break-words">
                        {t('pratCredenziali')} <strong>{v.esito.credentials.email}</strong> /{' '}
                        <code>{v.esito.credentials.password}</code>
                      </span>
                    </p>
                    <p className="text-xs">
                      {v.esito.credentialsEmailSent
                        ? t('pratCredenzialiInviate')
                        : t('pratCredenzialiAvviso')}
                    </p>
                  </>
                ) : (
                  <p className="text-xs">{t('pratNessunaCredenziale')}</p>
                )}
              </>
            )}

            {v.avvisi.length > 0 && (
              <ul className="ml-4 list-disc text-xs">
                {v.avvisi.map((w, i) => <li key={i}><TestoAvviso avviso={w} /></li>)}
              </ul>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={onCongeda}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-kidville-green bg-kidville-white px-3.5 py-1.5 font-barlow text-xs font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
      >
        {t('pratEsitoScartatoCongeda')}
      </button>
    </div>
  )
}

/**
 * CHE COSA SUCCEDE ALL'ACCOUNT CHE C'È GIÀ — detto PRIMA del clic.
 *
 * Cinque frasi per cinque fatti diversi, e nessuna di esse è deducibile dalle altre:
 *  · l'account non c'è → ne nasce uno, con ruolo Insegnante;
 *  · c'è, in un plesso di questa postazione → nome, cognome, cellulare e l'intero
 *    fascicolo verranno RISCRITTI con i dati di un modulo anonimo (ruolo, sede e fasce
 *    no: quelle il server non le tocca);
 *  · c'è, in un plesso che questa postazione non gestisce → l'approvazione verrà
 *    RIFIUTATA e non verrà scritto niente, e dirlo prima evita un 403 che sembra un
 *    guasto;
 *  · c'è, ed è di un GENITORE → anche qui l'approvazione verrà rifiutata, e non è un
 *    caso di scuola: in un nido la maestra è spessissimo anche la mamma di un bambino
 *    iscritto, quindi è la collisione PIÙ probabile di tutte. Fino al 2026-08-12 questo
 *    caso cadeva nel ramo finale e prometteva l'esatto contrario di ciò che accade —
 *    «verranno riscritti» — mentre il server si ferma su `email_gia_genitore` con un 409
 *    e non scrive niente (`staff-identity.ts` → `riusaIdentitaEsistente`, che tiene
 *    chiusa quella porta anche col riuso acceso: chi decide che una madre è anche una
 *    dipendente è una persona, non una route). Chi operava leggeva «verrà riscritto
 *    tutto», premeva, e riceveva un 409 che sembrava un guasto;
 *  · non si è potuto verificare → si dice, invece di lasciar credere «non c'è».
 *
 * ⚠️ Il ramo del genitore NON scatta quando `sede_gestita === false`: lì il server il
 * ruolo non lo manda affatto (e fa bene: il ruolo di una persona di un altro plesso non
 * serve a decidere). La frase che esce è comunque «l'approvazione verrà rifiutata», che
 * è il fatto che conta.
 *
 * ⚠️ LE CINQUE FRASI E LO STATO DI «CONFERMO» LEGGONO LA STESSA RISPOSTA
 * (`esitoPrevisto`): due catene di `if` ribattute divergerebbero alla prima modifica, e
 * a divergere sarebbe proprio il punto in cui il riquadro promette un esito e il
 * pulsante ne consente un altro.
 *
 * L'`id` serve al riquadro che ospita questa frase: è ciò che la fa ARRIVARE a chi non
 * guarda lo schermo, come descrizione del pannello di conferma che prende il fuoco.
 */
function SguardoSullAccount({ sguardo, id }: { sguardo: SguardoAccount | null; id?: string }) {
  const t = useTranslations('adminAltro')
  // Il grezzo resta solo per l'etichetta di ripiego, quando il ruolo è fuori dai sei
  // noti; la DECISIONE la prende `esitoPrevisto`, che normalizza come il server.
  const ruoloGrezzo = (sguardo?.ruolo ?? '').trim()
  const ruolo = ruoloGrezzo.toLowerCase()
  const previsto = esitoPrevisto(sguardo)

  if (previsto === 'ignoto') {
    return (
      <p id={id} className="flex items-start gap-1.5 font-maven text-xs text-kidville-warn-strong">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('pratConfermaAccountIgnoto')}
      </p>
    )
  }
  if (previsto === 'nuovo') {
    return <p id={id} className="font-maven text-xs text-kidville-sub">{t('pratConfermaAccountNuovo')}</p>
  }
  if (previsto === 'altraSede') {
    return (
      <p id={id} className="flex items-start gap-1.5 font-maven text-xs text-kidville-error-strong">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('pratConfermaAccountAltraSede')}
      </p>
    )
  }
  if (previsto === 'genitore') {
    return (
      <p id={id} className="flex items-start gap-1.5 font-maven text-xs text-kidville-error-strong">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('pratConfermaAccountGenitore')}
      </p>
    )
  }
  return (
    <div id={id} className="space-y-1 rounded-xl border border-kidville-warn/40 bg-kidville-warn-soft px-3 py-2">
      <p className="flex items-start gap-1.5 font-maven text-xs font-semibold text-kidville-warn-strong">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        {t('pratConfermaAccountEsiste', {
          ruolo: CHIAVE_RUOLO[ruolo] ? t(CHIAVE_RUOLO[ruolo]) : ruoloGrezzo || t('pratRuoloIgnoto'),
          sede: (sguardo?.sede_nome ?? '').trim() || t('pratSedeSconosciuta'),
        })}
      </p>
      <p className="font-maven text-xs text-kidville-warn-strong">{t('pratConfermaAccountEffetto')}</p>
    </div>
  )
}

/**
 * Una voce del dettaglio: etichetta + valore, o «Non indicato».
 *
 * Un dato mancante NON è un errore: qui si dice che non c'è, in inchiostro neutro,
 * invece di lasciare una riga vuota che si legge come un guasto.
 *
 * ⚠️ `break-words` SUL VALORE, e non è cosmesi. Email, codice fiscale e residenza
 * sono stringhe SENZA SPAZI: per il browser sono una parola sola, e una parola sola
 * che non entra non va a capo — sporge. Il corpo del `Drawer` è `overflow-y-auto`
 * (`cockpit.tsx:468`), e per CSS Overflow §3 un asse `auto` rende l'altro asse
 * calcolato `auto` a sua volta: non si ottiene un ritaglio, si ottiene una barra di
 * scorrimento LATERALE dentro il dialogo.
 *
 * Misurato in Chrome col CSS e i font veri (2026-08-12): a 360 px questa scatola è
 * larga 283,2 px, ed è la più larga delle tre del pannello — cede da ~46 caratteri.
 * Qui la difesa è PREVENTIVA, e resta perché la stessa voce disegna anche residenza e
 * domicilio, che sono più lunghi di un'email. I due punti che traboccavano davvero
 * sono il riquadro di conferma (16 px) e la riga delle credenziali (34 px).
 *
 * Funziona perché la griglia che ospita queste voci è `grid-cols-*` di Tailwind, cioè
 * `minmax(0, 1fr)`: la traccia può scendere sotto il min-content, e a quel punto
 * `overflow-wrap: break-word` spezza. In un contenitore FLEX non basterebbe — lì
 * serve anche `min-w-0`, ed è quello che fanno i due riquadri delle credenziali.
 */
function Voce({ etichetta, valore }: { etichetta: string; valore?: string | number | null }) {
  const t = useTranslations('adminAltro')
  const testo = valore === null || valore === undefined || String(valore).trim() === ''
    ? t('pratNonIndicato')
    : String(valore)
  return (
    <div>
      <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">{etichetta}</p>
      <p className="break-words font-maven text-sm text-kidville-ink">{testo}</p>
    </div>
  )
}

function Sezione({ icona: Icona, titolo, children }: { icona: typeof Mail; titolo: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-kidville-sub">
        <Icona size={14} /> {titolo}
      </h3>
      {children}
    </section>
  )
}

function PannelloPratica({
  pratica, oggi, nomeCompleto, nomeSede, gradi, etichettaGrado, titoloStudio, conferma,
  setConferma, motivo, setMotivo, destinazione, setDestinazione, sediDestinazione,
  sediNonLette, onApriSposta, lavorando, esito, avvisi, errore, sguardo, docBloccato,
  onChiudiEsito, onEsegui, onApriDocumento,
}: {
  pratica: Pratica
  oggi: string
  nomeCompleto: string
  nomeSede: string
  gradi: string[]
  etichettaGrado: (g: string) => string
  titoloStudio: string | null
  conferma: Azione | null
  setConferma: (v: Azione | null) => void
  motivo: string
  setMotivo: (v: string) => void
  destinazione: string
  setDestinazione: (v: string) => void
  sediDestinazione: { id: string; nome: string }[]
  sediNonLette: boolean
  onApriSposta: () => void
  lavorando: boolean
  esito: Esito | null
  avvisi: Avviso[]
  /** L'errore dell'AZIONE, montato qui dentro perché il dialogo è modale. */
  errore: string | null
  sguardo: SguardoAccount | null
  docBloccato: string | null
  onChiudiEsito: () => void
  onEsegui: (azione: Azione) => void
  onApriDocumento: (path?: string | null) => void
}) {
  const t = useTranslations('adminAltro')
  const f = useDateFormat()
  const decisa = pratica.stato === 'approvata' || pratica.stato === 'rifiutata'
  /**
   * `in_approvazione` = un claim rimasto APPESO: il fascicolo può esistere, l'accesso
   * può essere già nato, e la pratica non è chiusa.
   *
   * ⚠️ FINO AL 2026-08-12 QUESTO STATO NON AVEVA NESSUNA USCITA, e non era una
   * sfumatura: i tre comandi erano spenti tutti e tre — misurato — mentre l'unica
   * azione che la route accetta da qui è proprio «Rifiuta» (`da: ['pending',
   * 'in_approvazione']`, provato da `pratiche-personale-rifiuta.test.ts`). Da lì la
   * pratica restava ferma PER SEMPRE: il modulo pubblico non ne crea una seconda,
   * perché l'indice unico `(lower(email)) where stato in ('pending','in_approvazione')`
   * la considera VIVA e risponde 201 come al primo invio, quindi né la maestra né la
   * Segreteria avevano un rimedio. Restava la cancellazione a 90 giorni della
   * conservazione, con dentro un codice fiscale e la scansione di un documento
   * d'identità. Il testo a schermo prometteva comandi spenti «finché la pratica è in
   * approvazione»: un «finché» che nessuna azione del prodotto poteva far scadere.
   *
   * Adesso: «Approva» e «Sposta di sede» restano spenti — la route li respinge
   * entrambi, e il claim ripartirebbe da uno stato che non c'è più — e «Rifiuta»
   * RESTA, perché archiviare la pratica appesa è l'unica uscita che esista. Non
   * cancella niente: l'anagrafica e l'accesso eventualmente creati restano dove sono, e
   * il riquadro di conferma lo dice prima del clic.
   */
  const sospesa = pratica.stato === 'in_approvazione'
  const approvaSpenta = sospesa || lavorando
  const spostaSpenta = sospesa || lavorando
  const rifiutaSpenta = lavorando
  const motivoApprovaSpenta = sospesa ? t('pratSospesaAzioniSpente') : t('pratAzioneInCorso')

  /**
   * L'APPROVAZIONE È GIÀ PERSA? — la stessa risposta che `SguardoSullAccount` mette in
   * parole, letta dal medesimo posto (vedi `esitoPrevisto`).
   */
  const approvazionePersa = APPROVAZIONE_PERSA.includes(esitoPrevisto(sguardo))

  const residenza = [
    [pratica.address, pratica.residence_street_number].map((s) => (s ?? '').trim()).filter(Boolean).join(' '),
    [pratica.zip_code, pratica.residence_city, pratica.residence_province]
      .map((s) => (s ?? '').trim()).filter(Boolean).join(' '),
  ].filter(Boolean).join(' · ')

  const domicilio = [
    [pratica.domicilio_address, pratica.domicilio_street_number].map((s) => (s ?? '').trim()).filter(Boolean).join(' '),
    [pratica.domicilio_zip_code, pratica.domicilio_city, pratica.domicilio_province]
      .map((s) => (s ?? '').trim()).filter(Boolean).join(' '),
  ].filter(Boolean).join(' · ')

  // Comune, provincia e nazione sono TRE colonne e due sono facoltative: si uniscono
  // solo quelle che ci sono. Un «Napoli ()» a schermo direbbe che manca un dato che
  // non è mai stato chiesto.
  const luogoNascita = [
    (pratica.birth_place ?? '').trim(),
    (pratica.birth_province ?? '').trim() ? `(${(pratica.birth_province ?? '').trim()})` : '',
  ].filter(Boolean).join(' ')
  const nascita = [
    pratica.birth_date ? f.dataBreve(pratica.birth_date) : '',
    luogoNascita,
    (pratica.birth_nation ?? '').trim(),
  ].filter(Boolean).join(' · ')

  const sesso = pratica.gender === 'F' ? t('pratSessoF') : pratica.gender === 'M' ? t('pratSessoM') : null
  const tipoDocumento = ETICHETTA_DOCUMENTO.get((pratica.document_type ?? '').trim())
    ?? (pratica.document_type ?? '').trim()

  const titoloEsito = esito === null
    ? ''
    : esito.azione === 'rifiuta'
      ? t('pratEsitoRifiutata')
      : esito.azione === 'sposta-sede'
        ? t('pratEsitoSpostata')
        : esito.stato === 'in_approvazione'
          ? t('pratEsitoPresaInCarico')
          : t('pratEsitoApprovata')
  // Il riquadro si tinge di ciò che è successo davvero: verde solo quando la chiusura
  // è riuscita.
  const esitoRiuscito = esito !== null && esito.stato !== 'in_approvazione'

  /**
   * IL FUOCO SUL RIQUADRO D'ESITO, e non è cortesia.
   *
   * Quando l'esito atterra, il riquadro della conferma viene SMONTATO: il pulsante
   * «Confermo» sparisce dal DOM e il fuoco cade su `<body>` — misurato in jsdom,
   * `document.activeElement` = `BODY`. Chi naviga da tastiera riparte dall'inizio del
   * pannello; chi usa uno screen reader non viene informato di niente. E dentro quel
   * riquadro c'è la SOLA copia esistente di una password monouso: non è archiviata da
   * nessuna parte, e per riaverla serve una reimpostazione.
   *
   * `role="status"` da solo non basterebbe: una live-region che nasce già piena non è
   * un cambiamento, e diversi screen reader non la leggono. Regione + fuoco.
   */
  const rifEsito = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (esito) rifEsito.current?.focus()
  }, [esito])

  /**
   * IL FUOCO SUL RIQUADRO DI CONFERMA — lo stesso difetto, sul passo PRIMA.
   *
   * Trenta righe più su questo file chiude a mano la caduta del fuoco sul riquadro
   * d'ESITO, e lasciava aperta la identica caduta sul riquadro di CONFERMA: premendo
   * «Approva», «Rifiuta», «Sposta» o «Annulla» il comando che aveva il fuoco viene
   * SMONTATO (`conferma === null` monta i tre comandi, `conferma !== null` monta il
   * riquadro) e `document.activeElement` diventa `<body>` — misurato in jsdom, tre
   * transizioni su tre. Chi usa uno screen reader premeva «Approva» e non sentiva
   * niente; il Tab successivo lo riportava sul PRIMO comando del pannello per via del
   * ciclo del `Drawer`, cioè in cima, non sul riquadro appena comparso.
   *
   * E lì dentro c'è l'avviso che questo pannello esiste per dare: «questa email HA GIÀ
   * un accesso, ruolo Direzione», oppure «l'approvazione verrà rifiutata». Una difesa
   * che si vede solo guardando lo schermo non è una difesa per tutti.
   *
   * ⚠️ NON basta il fuoco: un contenitore messo a fuoco si annuncia col suo NOME e la
   * sua DESCRIZIONE. Per questo i tre riquadri sono `role="group"` con
   * `aria-labelledby` sul titolo e `aria-describedby` su ciò che cambia le carte in
   * tavola — l'effetto, l'account che c'è già, le fasce, l'avviso della pratica appesa.
   * Un `role="status"` qui sarebbe sbagliato due volte: nasce già pieno (e diversi
   * screen reader non lo leggono) e conterrebbe controlli interattivi.
   */
  const rifConferma = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (conferma !== null) rifConferma.current?.focus()
  }, [conferma])

  /**
   * …E DOVE TORNA IL FUOCO QUANDO SI ANNULLA.
   *
   * «Annulla» smonta il riquadro e rimonta i tre comandi: senza questo, il fuoco cade
   * di nuovo su `<body>` e chi naviga da tastiera riparte dall'inizio del pannello,
   * cioè dovrebbe riattraversare codice fiscale, residenza ed estremi del documento per
   * tornare al pulsante che ha appena premuto. Torna sul comando DI PARTENZA, che è il
   * posto da cui il gesto è cominciato.
   *
   * `esito` fa da guardia: quando l'operazione è andata a termine i comandi non
   * esistono più (`!decisa && !esito`) e il fuoco è del riquadro d'esito, che contiene
   * la sola copia esistente di una password monouso. Rincorrerlo qui glielo
   * strapperebbe.
   */
  const rifComandi = useRef<Partial<Record<Azione, HTMLButtonElement | null>>>({})
  const daRimettereAFuoco = useRef<Azione | null>(null)
  useEffect(() => {
    if (conferma !== null) return
    const azione = daRimettereAFuoco.current
    daRimettereAFuoco.current = null
    if (!azione || esito) return
    rifComandi.current[azione]?.focus()
  }, [conferma, esito])

  /** Annulla: chiude il riquadro e prenota il ritorno del fuoco sul suo comando. */
  const annulla = (azione: Azione) => {
    daRimettereAFuoco.current = azione
    setConferma(null)
  }

  return (
    <div className="space-y-5">
      <Sezione icona={Mail} titolo={t('pratContatti')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Voce etichetta={t('pratEmail')} valore={pratica.email} />
          <Voce etichetta={t('pratTelefono')} valore={pratica.telefono} />
          <Voce etichetta={t('pratSede')} valore={nomeSede} />
          <Voce etichetta={t('pratRicevutaIl')} valore={pratica.creata_il ? f.dataBreve(pratica.creata_il) : null} />
        </div>
      </Sezione>

      <Sezione icona={IdCard} titolo={t('pratAnagrafica')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Voce etichetta={t('pratCodiceFiscale')} valore={pratica.fiscal_code} />
          <Voce etichetta={t('pratSesso')} valore={sesso} />
          <Voce etichetta={t('pratNascita')} valore={nascita} />
          <Voce etichetta={t('pratCittadinanza')} valore={pratica.citizenship} />
          <Voce etichetta={t('pratResidenza')} valore={residenza} />
          <Voce etichetta={t('pratDomicilio')} valore={domicilio} />
        </div>
      </Sezione>

      <Sezione icona={CalendarClock} titolo={t('pratDocumento')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Voce etichetta={t('pratTipoDocumento')} valore={tipoDocumento} />
          <Voce etichetta={t('pratNumeroDocumento')} valore={pratica.document_number} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">
            {t('pratScadenzaDocumento')}
          </p>
          <ScadenzaDocumento scadenza={pratica.document_expiry} oggi={oggi} />
        </div>
        <div className="mt-3">
          {/*
            UN PULSANTE PER FACCIA, e ognuno compare solo se la SUA faccia è ancora
            della pratica. Non è simmetria estetica: dopo un'approvazione degradata il
            fronte può essere passato al fascicolo e il retro no, e un pulsante solo —
            o due legati allo stesso percorso — aprirebbe la faccia sbagliata o
            risponderebbe 403 su un percorso che questa pratica non nomina più.

            Vale anche per le pratiche arrivate PRIMA del 12/08/2026, che hanno il solo
            fronte: lì compare un pulsante solo, ed è esattamente ciò che c'è.
          */}
          {pratica.documento_fronte_path || pratica.documento_retro_path ? (
            <div className="flex flex-wrap items-center gap-2">
              {pratica.documento_fronte_path && (
                <button
                  type="button"
                  onClick={() => onApriDocumento(pratica.documento_fronte_path)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-kidville-green px-3.5 py-1.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
                >
                  <FileText size={14} /> {t('pratApriFronte')} <ExternalLink size={12} />
                </button>
              )}
              {pratica.documento_retro_path && (
                <button
                  type="button"
                  onClick={() => onApriDocumento(pratica.documento_retro_path)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-kidville-green px-3.5 py-1.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
                >
                  <FileText size={14} /> {t('pratApriRetro')} <ExternalLink size={12} />
                </button>
              )}
            </div>
          ) : pratica.stato === 'approvata' ? (
            // Le scansioni NON sono sparite: sono passate al fascicolo, che ne è l'unico
            // proprietario. Dirlo evita che qualcuno le cerchi come se fossero perse.
            <p className="font-maven text-sm text-kidville-sub">{t('pratDocumentoAlFascicolo')}</p>
          ) : (
            <p className="font-maven text-sm text-kidville-sub">{t('pratNessunDocumento')}</p>
          )}
          {docBloccato && (
            <p role="alert" className={AVVISO_FINESTRA_BLOCCATA}>
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {t('pratDocBloccato')}{' '}
              <a
                href={docBloccato}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] min-w-[44px] items-center font-bold text-kidville-green underline"
              >
                {t('pratDocApriManuale')}
              </a>
            </p>
          )}
        </div>
      </Sezione>

      <Sezione icona={FileText} titolo={t('pratProfilo')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Voce etichetta={t('pratTitoloStudio')} valore={titoloStudio} />
          <Voce etichetta={t('pratTitoloDettaglio')} valore={pratica.titolo_dettaglio} />
        </div>
        <div className="mt-3">
          <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">{t('pratFasce')}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {gradi.length === 0 ? (
              <span className="font-maven text-sm text-kidville-ink">{t('pratNonIndicato')}</span>
            ) : (
              gradi.map((g) => (
                <span key={g} className="rounded-pill bg-kidville-green-soft px-2.5 py-1 font-barlow text-[11px] font-bold uppercase tracking-wider text-kidville-green">
                  {etichettaGrado(g)}
                </span>
              ))
            )}
          </div>
        </div>
      </Sezione>

      <Sezione icona={Users} titolo={t('pratEmergenza')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Voce etichetta={t('pratEmergenzaNome')} valore={pratica.emergenza_nome} />
          <Voce etichetta={t('pratEmergenzaTelefono')} valore={pratica.emergenza_telefono} />
          <Voce etichetta={t('pratEmergenzaRelazione')} valore={pratica.emergenza_relazione} />
        </div>
      </Sezione>

      {/* La PROVA dell'informativa, ridotta a ciò che serve: che c'è, di quando è e a
          quale versione del testo. Il resto — testi congelati, indirizzo IP di chi ha
          compilato da casa — resta in tabella, dove è una prova e non un dato da
          guardare. */}
      {pratica.consents_log && (
        <Sezione icona={ShieldCheck} titolo={t('pratConsensi')}>
          <p className="font-maven text-sm text-kidville-ink">
            {t('pratConsensiRiga', {
              n: pratica.consents_log.n_blocchi ?? 0,
              data: pratica.consents_log.accettato_il ? f.dataBreve(pratica.consents_log.accettato_il) : '—',
              versione: pratica.consents_log.versione_consensi ?? '—',
            })}
          </p>
        </Sezione>
      )}

      {pratica.stato === 'rifiutata' && (pratica.motivo_rifiuto ?? '').trim() !== '' && (
        <Sezione icona={XCircle} titolo={t('pratMotivoRegistrato')}>
          <p className="whitespace-pre-line rounded-xl border border-kidville-line bg-kidville-cream/50 p-3 font-maven text-sm text-kidville-ink">
            {pratica.motivo_rifiuto}
          </p>
        </Sezione>
      )}

      {sospesa && (
        <div className="space-y-1 rounded-xl border border-kidville-warn/40 bg-kidville-warn-soft p-4">
          <p className="flex items-center gap-1.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-warn-strong">
            <AlertTriangle size={16} /> {t('pratSospesaTitolo')}
          </p>
          <p className="font-maven text-sm text-kidville-warn-strong">{t('pratSospesaTesto')}</p>
        </div>
      )}

      {/* Gli avvisi del server: FUORI dal riquadro congedabile, perché sono la sola
          traccia di ciò che è stato scritto a metà — e in una live-region `polite`,
          perché compaiono DOPO un gesto e dicono che cosa è stato scritto a metà. */}
      {avvisi.length > 0 && (
        <div role="status" className="rounded-xl bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong">
          <p className="flex items-center gap-1 font-semibold"><AlertTriangle size={12} /> {t('pratAvvisi')}</p>
          <ul className="ml-5 list-disc">
            {avvisi.map((w, i) => <li key={i}><TestoAvviso avviso={w} /></li>)}
          </ul>
        </div>
      )}

      {esito && (
        <div
          ref={rifEsito}
          role="status"
          tabIndex={-1}
          className={`space-y-2 rounded-xl border p-4 ${FUOCO_ESITO} ${
            esitoRiuscito
              ? 'border-kidville-success/30 bg-kidville-success-soft'
              : 'border-kidville-warn/40 bg-kidville-warn-soft'
          }`}
        >
          <p
            className={`flex items-center gap-1.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] ${
              esitoRiuscito ? 'text-kidville-success-strong' : 'text-kidville-warn-strong'
            }`}
          >
            {esitoRiuscito ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            {titoloEsito}
          </p>

          {esito.azione === 'approva' && (
            esito.credentials ? (
              <>
                {/* ⚠️ `min-w-0 break-words` — ed è la coppia, non una delle due.
                    Lo `span` è una voce di un contenitore FLEX: la sua larghezza
                    minima automatica vale il min-content, cioè l'email intera come
                    parola sola, e `overflow-wrap: break-word` per specifica NON
                    riduce il min-content. Senza `min-w-0` la voce resta larga e
                    sporge lo stesso; senza `break-words` può scendere ma non spezza.
                    È il punto del pannello che cede per PRIMO — misurato a 360 px:
                    34 px di scorrimento laterale, perché l'icona e il `gap` tolgono
                    22 px alla scatola. E qui dentro c'è la SOLA copia esistente di
                    una password monouso: se il dialogo scorre di lato, quella riga
                    esce dalla vista e per riaverla serve una reimpostazione. */}
                <p className="flex items-start gap-2 font-maven text-sm text-kidville-ink">
                  <KeyRound size={14} className="mt-0.5 shrink-0 text-kidville-success-strong" />
                  <span className="min-w-0 select-all break-words">
                    {t('pratCredenziali')} <strong>{esito.credentials.email}</strong> /{' '}
                    <code>{esito.credentials.password}</code>
                  </span>
                </p>
                <p className="font-maven text-xs text-kidville-sub">
                  {esito.credentialsEmailSent ? t('pratCredenzialiInviate') : t('pratCredenzialiAvviso')}
                </p>
              </>
            ) : (
              <p className="font-maven text-xs text-kidville-sub">{t('pratNessunaCredenziale')}</p>
            )
          )}

          <button
            type="button"
            onClick={onChiudiEsito}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-kidville-green px-3.5 py-1.5 font-barlow text-xs font-bold uppercase tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft"
          >
            {t('pratHoPresoNota')}
          </button>
        </div>
      )}

      {/* ── LE AZIONI ─────────────────────────────────────────────────────── */}
      {/* L'ERRORE DELL'AZIONE STA QUI, appiccicato ai comandi e dentro il dialogo.
          Non in cima al pannello: i comandi sono in fondo, e a pannello scorso un
          avviso in testa è fuori schermo tanto quanto uno fuori dal dialogo. */}
      {errore && <AvvisoErrore testo={errore} autoFocus />}

      {!decisa && !esito && (
        <div className="space-y-3 border-t border-kidville-line pt-3">
          {(approvaSpenta || spostaSpenta) && conferma === null && (
            <p className="flex items-start gap-2 rounded-xl bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {motivoApprovaSpenta}
            </p>
          )}

          {conferma === null && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                ref={(el) => { rifComandi.current.approva = el }}
                onClick={() => setConferma('approva')}
                disabled={approvaSpenta}
                title={approvaSpenta ? motivoApprovaSpenta : undefined}
                className={`inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-yellow-ink disabled:border ${SPENTO}`}
              >
                <CheckCircle2 size={16} /> {t('pratApprova')}
              </button>
              {/* ⚠️ «Rifiuta» NON si spegne su `in_approvazione`: è l'unica uscita che
                  la route accetta da quello stato, ed è l'unica cosa che sta fra una
                  pratica appesa e la cancellazione a 90 giorni. Vedi `sospesa`. */}
              <button
                type="button"
                ref={(el) => { rifComandi.current.rifiuta = el }}
                onClick={() => setConferma('rifiuta')}
                disabled={rifiutaSpenta}
                title={rifiutaSpenta ? t('pratAzioneInCorso') : undefined}
                className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-kidville-error px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-error-strong ${SPENTO}`}
              >
                <XCircle size={16} /> {t('pratRifiuta')}
              </button>
              <button
                type="button"
                ref={(el) => { rifComandi.current['sposta-sede'] = el }}
                onClick={() => { setConferma('sposta-sede'); onApriSposta() }}
                disabled={spostaSpenta}
                title={spostaSpenta ? motivoApprovaSpenta : undefined}
                className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-kidville-line px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-sub hover:text-kidville-green ${SPENTO}`}
              >
                <MoveRight size={16} /> {t('pratSposta')}
              </button>
            </div>
          )}

          {/* Conferma di APPROVAZIONE: nomina ciò che sta per succedere — e lo nomina
              anche a chi non guarda lo schermo (vedi `rifConferma`). */}
          {conferma === 'approva' && (
            <div
              ref={rifConferma}
              tabIndex={-1}
              role="group"
              aria-labelledby={ID_CONFERMA_TITOLO}
              aria-describedby={`${ID_CONFERMA_TESTO} ${ID_CONFERMA_ACCOUNT} ${ID_CONFERMA_FASCE}`}
              className={`space-y-2 border border-kidville-green/40 bg-kidville-green-soft p-4 ${RIQUADRO_CONFERMA}`}
            >
              <p id={ID_CONFERMA_TITOLO} className="font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-green">
                {t('pratConfermaApprovaTitolo')}
              </p>
              {/* `break-words`: l'EMAIL è una parola sola senza spazi, e questo è il
                  riquadro in cui si preme «Confermo». Senza, il dialogo — che è
                  `overflow-y-auto`, quindi `overflow-x` calcolato `auto` — si mette a
                  scorrere di lato: misurato in Chrome a 360 px, 16 px di scorrimento
                  laterale con un indirizzo da 44 caratteri (la scatola qui è 251,2 px,
                  perché il riquadro ha il suo `p-4`). */}
              <p id={ID_CONFERMA_TESTO} className="break-words font-maven text-sm text-kidville-ink">
                {t('pratConfermaApprovaTesto')} <strong>{nomeCompleto}</strong>{' '}
                {t('pratConfermaApprovaSede')} <strong>{nomeSede}</strong>
                {'. '}
                {t('pratConfermaApprovaAccount')} <strong>{(pratica.email ?? '').trim() || t('pratNonIndicato')}</strong>.
              </p>
              {/* L'ACCOUNT CHE C'È GIÀ, PRIMA DI PREMERE.
                  `/anagrafica-personale` è pubblico e anonimo, e gli indirizzi delle
                  maestre sono pubblici: chiunque può inviare una pratica con l'email di
                  una collega o della Direzione. Il patch stretto della route impedisce
                  la promozione — quella difesa regge — ma nome, cognome, cellulare e
                  l'intero fascicolo di chi esiste già cambiano dopo UN clic. Fino al
                  2026-08-12 il server la risposta ce l'aveva (la calcola prima del
                  claim) e la buttava in un campo di log: qui non compariva, e chi
                  premeva non aveva modo di accorgersene. */}
              <SguardoSullAccount sguardo={sguardo} id={ID_CONFERMA_ACCOUNT} />
              {/* LE FASCE, PRIMA DI PREMERE — e non solo quando mancano.
                  Fino al 2026-08-12 questo riquadro parlava delle fasce SOLO nel caso
                  vuoto, mentre nel caso pieno l'approvazione le scriveva sull'account.
                  Chi confermava non le vedeva nominate da nessuna parte: la spunta
                  sbagliata su un modulo pubblico diventava un permesso, e il riquadro
                  che avrebbe dovuto dirlo taceva. Adesso le fasce dichiarate si
                  LEGGONO qui, con accanto la regola che le governa — si applicano solo
                  se l'accesso nasce adesso, mai a chi ce l'ha già. */}
              {gradi.length === 0 ? (
                <p id={ID_CONFERMA_FASCE} className="flex items-start gap-1.5 font-maven text-xs text-kidville-warn-strong">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('pratConfermaApprovaFasceMancanti')}
                </p>
              ) : (
                <div id={ID_CONFERMA_FASCE} className="space-y-1.5">
                  <p className="flex flex-wrap items-center gap-1.5 font-maven text-xs text-kidville-ink">
                    <span className="font-barlow font-bold uppercase tracking-[0.04em] text-kidville-sub">
                      {t('pratConfermaApprovaFasceDichiarate')}
                    </span>
                    {gradi.map((g) => (
                      <span
                        key={g}
                        className="rounded-pill bg-kidville-white px-2 py-0.5 font-barlow text-[11px] font-bold uppercase tracking-wider text-kidville-green"
                      >
                        {etichettaGrado(g)}
                      </span>
                    ))}
                  </p>
                  <p className="font-maven text-xs text-kidville-sub">
                    {t('pratConfermaApprovaFasceRegola')}
                  </p>
                </div>
              )}
              {/* «CONFERMO» SI SPEGNE QUANDO IL RIQUADRO HA APPENA DETTO CHE FALLIRÀ.
                  Fino al 2026-08-12 restava acceso proprio nei due casi in cui il
                  pannello dichiara «l'approvazione verrà rifiutata e non verrà scritto
                  niente»: due frasi opposte nello stesso riquadro, e quella che si può
                  premere è la sbagliata. Il motivo è scritto, non solo dedotto dallo
                  stato spento — un pulsante grigio senza spiegazione si legge come un
                  permesso mancante. Vedi `APPROVAZIONE_PERSA`. */}
              {approvazionePersa && (
                <p className="flex items-start gap-1.5 font-maven text-xs text-kidville-error-strong">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('pratConfermaSpentaMotivo')}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => onEsegui('approva')}
                  disabled={lavorando || approvazionePersa}
                  title={approvazionePersa ? t('pratConfermaSpentaMotivo') : undefined}
                  className={`inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-yellow-ink disabled:border ${SPENTO}`}
                >
                  {lavorando ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {t('pratConferma')}
                </button>
                <button
                  type="button"
                  onClick={() => annulla('approva')}
                  disabled={lavorando}
                  className={`inline-flex min-h-[44px] items-center rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-sub hover:bg-kidville-cream ${SPENTO}`}
                >
                  {t('pratAnnulla')}
                </button>
              </div>
            </div>
          )}

          {/* Conferma di RIFIUTO: il motivo è una NOTA INTERNA, e non parte nessuna email. */}
          {conferma === 'rifiuta' && (
            <div
              ref={rifConferma}
              tabIndex={-1}
              role="group"
              aria-labelledby={ID_CONFERMA_TITOLO}
              aria-describedby={sospesa ? `${ID_CONFERMA_TESTO} ${ID_CONFERMA_SOSPESA}` : ID_CONFERMA_TESTO}
              className={`space-y-3 border border-kidville-error/40 bg-kidville-error-soft p-4 ${RIQUADRO_CONFERMA}`}
            >
              <p id={ID_CONFERMA_TITOLO} className="font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-error-strong">
                {t('pratConfermaRifiutaTitolo')}
              </p>
              <p id={ID_CONFERMA_TESTO} className="font-maven text-sm text-kidville-ink">
                {t('pratConfermaRifiutaTesto')} <strong>{nomeCompleto}</strong>.
              </p>
              {/* IL RIFIUTO DI UNA PRATICA APPESA NON È IL RIFIUTO DI UNA IN ATTESA, e
                  la differenza va detta PRIMA: da `in_approvazione` l'anagrafica può
                  essere già stata scritta e l'accesso già creato. Rifiutare non li
                  cancella — chiude la pratica, e con lei l'indice che impediva alla
                  stessa email di inviarne una nuova. È l'unica uscita che esista, e chi
                  la usa deve sapere che cosa lascia dietro di sé. */}
              {sospesa && (
                <p id={ID_CONFERMA_SOSPESA} className="flex items-start gap-1.5 font-maven text-xs text-kidville-error-strong">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('pratConfermaRifiutaSospesa')}
                </p>
              )}
              <div>
                <label htmlFor="prat-motivo" className="block font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">
                  {t('pratMotivo')}
                </label>
                {/* `aria-describedby`: l'aiuto sotto al campo dice che il motivo è una
                    NOTA INTERNA e che non parte nessuna email. Senza il legame, chi
                    usa uno screen reader arriva sul campo e sente solo «Motivo
                    (facoltativo)» — cioè proprio la parte che non chiarisce dove
                    finisce quel testo. */}
                <textarea
                  id="prat-motivo"
                  aria-describedby="prat-motivo-aiuto"
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  className="mt-1 min-h-[44px] w-full rounded-input border border-kidville-line bg-kidville-white p-2.5 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none"
                />
                <p id="prat-motivo-aiuto" className="mt-1 font-maven text-xs text-kidville-sub">{t('pratMotivoAiuto')}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEsegui('rifiuta')}
                  disabled={lavorando}
                  className={`inline-flex min-h-[44px] items-center gap-2 rounded-pill border border-kidville-error bg-kidville-white px-4 py-2 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-error-strong ${SPENTO}`}
                >
                  {lavorando ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                  {t('pratConferma')}
                </button>
                <button
                  type="button"
                  onClick={() => annulla('rifiuta')}
                  disabled={lavorando}
                  className={`inline-flex min-h-[44px] items-center rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-sub hover:bg-kidville-cream ${SPENTO}`}
                >
                  {t('pratAnnulla')}
                </button>
              </div>
            </div>
          )}

          {/* SPOSTA DI SEDE: il rimedio all'errore di chi ha sbagliato card. */}
          {conferma === 'sposta-sede' && (
            <div
              ref={rifConferma}
              tabIndex={-1}
              role="group"
              aria-labelledby={ID_CONFERMA_TITOLO}
              // La descrizione è già scritta e già identificata: `prat-destinazione-aiuto`
              // dice a che cosa serve lo spostamento, e la riga «l'elenco è parziale»
              // spiega perché una sede può mancare dalla tendina.
              aria-describedby={
                sediNonLette ? 'prat-destinazione-aiuto prat-destinazione-parziale' : 'prat-destinazione-aiuto'
              }
              className={`space-y-3 border border-kidville-info/40 bg-kidville-info-soft p-4 ${RIQUADRO_CONFERMA}`}
            >
              <p id={ID_CONFERMA_TITOLO} className="font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-info-strong">
                {t('pratSpostaTitolo')}
              </p>
              <p id="prat-destinazione-aiuto" className="font-maven text-sm text-kidville-ink">{t('pratSpostaTesto')}</p>
              {sediNonLette && (
                <p id="prat-destinazione-parziale" className="flex items-start gap-1.5 font-maven text-xs text-kidville-warn-strong">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {t('pratSpostaSediNonLette')}
                </p>
              )}
              <div>
                <label htmlFor="prat-destinazione" className="block font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-sub">
                  {t('pratSpostaSedeLabel')}
                </label>
                {/* `aria-describedby` con DUE riferimenti quando l'elenco è parziale:
                    «qui sotto ci sono solo le sedi di questa postazione» è la
                    spiegazione del perché una sede manca dalla tendina, e a chi non
                    vede lo schermo quella frase non arriverebbe mai al momento giusto. */}
                <select
                  id="prat-destinazione"
                  aria-describedby={
                    sediNonLette ? 'prat-destinazione-aiuto prat-destinazione-parziale' : 'prat-destinazione-aiuto'
                  }
                  value={destinazione}
                  onChange={(e) => setDestinazione(e.target.value)}
                  className="mt-1 min-h-[44px] w-full rounded-input border border-kidville-line bg-kidville-white p-2.5 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none"
                >
                  <option value="">{t('pratSpostaScegli')}</option>
                  {sediDestinazione.map((s) => (
                    <option key={s.id} value={s.id}>{s.nome}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onEsegui('sposta-sede')}
                  disabled={lavorando || destinazione === ''}
                  className={`inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-bold uppercase tracking-[0.02em] text-kidville-yellow-ink disabled:border ${SPENTO}`}
                >
                  {lavorando ? <Loader2 size={14} className="animate-spin" /> : <MoveRight size={14} />}
                  {t('pratConferma')}
                </button>
                <button
                  type="button"
                  onClick={() => annulla('sposta-sede')}
                  disabled={lavorando}
                  className={`inline-flex min-h-[44px] items-center rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-sub hover:bg-kidville-cream ${SPENTO}`}
                >
                  {t('pratAnnulla')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
