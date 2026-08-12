'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, FileWarning, Loader2, XCircle,
} from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit'
import { SHADOW_CARD } from '@/components/ui/Card'
import { cx } from '@/lib/ui/cx'
import { FUOCO_ESITO } from '@/lib/ui/fuoco'
import { useSediAttive } from '@/lib/context/sede-context'
import { useLabelRuolo } from '@/lib/auth/ruoli'
import { useDateFormat } from '@/lib/i18n/date'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { messaggioErrore } from '@/lib/ui/esito-fetch'
import { TIPI_DOCUMENTO } from '@/lib/forms/personale-template'
import { SOGLIA_SCADUTO, giorniResidui, sogliaRaggiunta } from '@/lib/anagrafica/scadenze'
import { dataCivile } from '@/i18n/config'

/**
 * IL CRUSCOTTO DELLE SCADENZE DEI DOCUMENTI D'IDENTITÀ — lato Segreteria.
 *
 * ─── LO STATO SI DERIVA DALLE DATE, E NON ESISTE DA NESSUN'ALTRA PARTE ──────
 *
 * È la stessa regola di `AgendaScadenze` (`src/lib/pagamenti/aging.ts`), e la
 * ragione è la stessa: una colonna di stato è un dato che deve essere
 * AGGIORNATO da qualcuno, e il giorno in cui quel qualcuno non gira — un cron
 * fermo, un deploy andato male, una riga scritta a mano in SQL — la colonna
 * continua a dire «in regola» su un documento scaduto da tre mesi, e nessuno se
 * ne accorge perché non c'è nessun errore da nessuna parte. Qui l'unico input è
 * `document_expiry`, e il conto lo fanno le due funzioni pure di
 * `@/lib/anagrafica/scadenze` — le STESSE che usa il cron notturno. Due
 * implementazioni della stessa soglia divergono al primo cambio, e a divergere
 * sarebbe ciò che la segreteria vede da ciò per cui la persona viene avvisata.
 *
 * ⚠️ `oggi` ARRIVA DAL SERVER (`dataCivile()`, `Europe/Rome`) e non
 * dall'orologio del portatile. Un browser avanti di un giorno — succede, e non
 * serve una manomissione: basta un fuso sbagliato in un portatile portato da
 * casa — sposterebbe la riga fra «scade oggi» e «scaduto», che è esattamente il
 * confine su cui questo pannello esiste per non sbagliare.
 *
 * ─── I QUATTRO RIQUADRI SONO DISGIUNTI ──────────────────────────────────────
 *
 * «Scadono entro 30 giorni» NON contiene gli scaduti, e «Scadono entro 90» non
 * contiene i primi trenta. Se si sovrapponessero, la somma dei quattro numeri
 * non tornerebbe con le righe in tabella e — peggio — chi clicca due riquadri
 * diversi vedrebbe la stessa persona due volte, senza capire perché.
 *
 * «In regola» NON è un riquadro, ed è una scelta: un riquadro che nessuno clicca
 * è rumore, e filtrare per «va tutto bene» non è un gesto che qualcuno faccia.
 * Il numero c'è, in una riga sotto, perché senza di lui i quattro riquadri non
 * hanno scala: «4 scaduti» su 6 persone e «4 scaduti» su 60 sono due fatti
 * diversi.
 *
 * ─── «DOCUMENTO MANCANTE» È IL BUCKET PIÙ GRANDE, ED È IL PIÙ AZIONABILE ────
 *
 * Il primo giorno quasi tutti sono lì: l'anagrafica del personale è appena nata
 * e nessuno ha ancora compilato il modulo. Non è un errore da nascondere — è la
 * coda di lavoro, e si smaltisce mandando il link. Per questo ha un riquadro suo
 * e un tono NEUTRO: colorarlo di rosso metterebbe sullo stesso piano «non
 * abbiamo ancora chiesto il documento» e «una persona sta lavorando senza un
 * documento valido», che sono due fatti diversi con due rimedi diversi.
 *
 * ─── QUATTRO STATI DISEGNATI, NON DUE ───────────────────────────────────────
 *
 * caricamento · errore · vuoto VERO · vuoto DA FILTRO. Le ultime due hanno
 * frasi diverse di proposito: «Nessun documento in scadenza» è un'affermazione
 * sul mondo, «Nessun documento in questo stato» è un'affermazione sul filtro, e
 * dirne una per l'altra manda qualcuno a chiudere la pagina convinto che non ci
 * sia niente da fare. E una lista eternamente vuota che nasconde un guasto è la
 * risposta più pericolosa che questa pagina possa dare: se la lettura fallisce
 * si dice, in `role="alert"`, invece di disegnare zero righe.
 *
 * ─── QUANDO LA LETTURA FALLISCE, LO SCHERMO NON AFFERMA PIÙ NIENTE ──────────
 *
 * Non basta smettere di disegnare le righe: vanno via anche i QUATTRO NUMERI e
 * la riga «N in regola». Il difetto misurato al primo giro era proprio questo —
 * una ri-lettura fallita (basta cambiare sede: non serve toccare «Riprova»)
 * sostituiva la tabella col pannello d'errore, ma i quattro riquadri restavano a
 * schermo con i conteggi della lettura PRECEDENTE, e il messaggio d'errore
 * diceva «l'elenco che vedi potrebbe non essere completo» davanti a zero righe.
 * Due affermazioni, entrambe false, nella stessa schermata.
 *
 * ⚠️ E i conteggi rimasti non erano solo «vecchi»: dopo un cambio di sede erano
 * di un ALTRO PLESSO. «3 scaduti» sotto il nome di Aversa, contati su Giugliano.
 * Perciò su una lettura fallita le righe si BUTTANO — stato e schermo dicono la
 * stessa cosa, e l'unica frase rimasta parla della lettura, non dell'elenco.
 * Da qui anche `ricevuto`: i numeri compaiono solo dopo una lettura riuscita,
 * mai durante la prima attesa (dove «0 scaduti» sarebbe un'affermazione).
 *
 * ─── IL FUOCO HA UN RICOVERO ────────────────────────────────────────────────
 *
 * «Riprova» e «Togli il filtro» SMONTANO sé stessi: premendoli, il pannello che
 * li contiene sparisce e il fuoco cade su `<body>` — cioè chi lavora da tastiera
 * riparte a tabulare dall'inizio del documento proprio nell'istante in cui la
 * schermata è cambiata (WCAG 2.4.3). È la lezione già pagata sulle schermate
 * «comunica un'assenza», e il ricovero è lo stesso: un contenitore STABILE
 * attorno ai quattro stati, `tabIndex={-1}`, classi `FUOCO_ESITO` (che portano
 * anche l'anello giallo dell'Alto Contrasto). Stabile è la parola che conta: il
 * nodo esiste prima e dopo il cambio di stato, quindi `.focus()` si può chiamare
 * dentro il gesto, senza inseguire il render con un `setTimeout`.
 *
 * ─── «APRI DOCUMENTO» NON SI MARCA `disabled` MENTRE LAVORA ─────────────────
 *
 * Il secondo giro aveva dato il ricovero a «Riprova» e «Togli il filtro» e
 * lasciato intatto il comando che si preme UNA VOLTA PER RIGA — cioè l'azione
 * principale del pannello, su una tabella che il server ammette fino a 500
 * righe. Misurato in Chrome sul markup vero: `document.activeElement` diventa
 * `BODY` nell'istante in cui il bottone passa a `disabled`, e ci RESTA anche
 * dopo la riattivazione (2 misure su 2). Chi lavora da tastiera perde il posto a
 * ogni riga della coda.
 *
 * È la regola di casa, scritta in `Btn.tsx`: **`disabled` non è il modo di dire
 * «sto lavorando»**. Mentre la richiesta è in volo il bottone è un MESSAGGIO, non
 * un controllo spento — `aria-busy` più `aria-disabled`, che dicono la stessa
 * cosa agli assistivi senza togliere il fuoco. Il doppio invio lo ferma la
 * GUARDIA `aprendoRef`, che è sincrona: `disabled` passa dallo stato di React e
 * il secondo clic dello stesso tick lo trova ancora attivo, quindi non era
 * nemmeno la difesa che sembrava. E niente `opacity-*`: sbiadire toglie proprio
 * l'unico segnale che il gesto è partito (stessa lezione, stesso file).
 *
 * ─── L'ESITO DI QUEL CLIC SI ANNUNCIA, E VA A PRENDERSI IL FUOCO ────────────
 *
 * Le due fasce d'esito («non si è aperto» e «il browser ha bloccato la finestra»)
 * stanno in cima al pannello: con 25 righe a 1280 px sono 1745 px sopra il
 * comando dell'ultima riga — 2,4 schermate. Al secondo giro una portava
 * `role="alert"` e l'altra NIENTE: due esiti dello stesso gesto, uno annunciato e
 * uno muto, ed era muto proprio quello che CHIEDE un'azione (aprire il
 * collegamento a mano). Chi premeva in fondo alla tabella non vedeva niente, non
 * sentiva niente e — per il difetto qui sopra — non aveva più nemmeno il fuoco:
 * indistinguibile da un pulsante rotto.
 *
 * Ora sono simmetriche: `role="alert"` tutte e due, `tabIndex={-1}` e
 * `FUOCO_ESITO` tutte e due, e un effetto ci posa il fuoco appena compaiono.
 * ⚠️ `.focus()` NON serve solo a chi ascolta: il browser porta in vista
 * l'elemento che riceve il fuoco, quindi lo stesso gesto risolve anche i 1745 px
 * per chi guarda. Il ricovero qui è sulla fascia STESSA e il fuoco si sposta da
 * un effetto (non dal gestore) perché queste due, al contrario del ricovero
 * dell'elenco, non esistono prima dell'esito: è la forma di `/parent/attendance`.
 *
 * ⚠️ E `errore` si AZZERA a ogni tentativo, insieme a `documentoBloccato`. Al
 * secondo giro c'erano 3 assegnazioni e ZERO `setErrore(null)`: l'avviso rosso
 * nato sulla riga A restava a schermo mentre la riga B apriva il documento
 * benissimo — «Il documento non si è aperto», in `role="alert"`, sotto gli occhi
 * di chi lo aveva appena aperto, e senza modo di chiuderlo.
 *
 * ─── LA COLONNA SEDE NON DICE «NON RICONOSCIUTA» QUANDO NON SA ─────────────
 *
 * `nomeSede` aveva due rami — trovata, oppure «Sede non riconosciuta» — e le
 * sedi arrivano da un contesto che le carica per conto suo. Finché non erano
 * arrivate (e PER SEMPRE, se quella lettura falliva: il contesto chiude comunque
 * `loading` nel `finally`, con l'elenco vuoto) ogni riga dichiarava che la
 * propria sede non si riconosce. Con tre plessi in produzione quella colonna è
 * l'unica cosa che dice a chi appartiene il documento che si sta guardando, e
 * «non riconosciuta» non è un segnaposto: è un'affermazione sul dato, la stessa
 * forma che questa testata vieta due paragrafi più su.
 *
 * Perciò: si legge `loading` dal contesto, la prima lettura ASPETTA che le sedi
 * si sappiano (senza, partiva con scope vuoto e le righe si disegnavano mentre
 * `sedi` era ancora `[]`), e i rami diventano quattro — «non indicata» se la riga
 * non porta una sede, «non disponibile» se l'elenco non c'è, «non riconosciuta»
 * solo quando un elenco c'è davvero e quell'id non ci sta dentro. Sono tre fatti
 * diversi, e «mancante» non è «sbagliato».
 */

/** I quattro stati dei riquadri, più «in regola» che è solo un conteggio. */
export type StatoScadenza = 'scaduto' | 'entro30' | 'entro90' | 'mancante' | 'regola'

/** Gli stati filtrabili: sono i quattro riquadri, nell'ordine in cui compaiono. */
export const STATI_FILTRABILI: readonly StatoScadenza[] = ['scaduto', 'entro30', 'entro90', 'mancante']

/** Il valore di `?stato=` è uno dei quattro, oppure niente. */
export function statoDaUrl(grezzo: string | null | undefined): StatoScadenza | null {
  const s = (grezzo ?? '').trim()
  return (STATI_FILTRABILI as readonly string[]).includes(s) ? (s as StatoScadenza) : null
}

/** La riga d'elenco: esattamente le colonne che la route proietta in lista. */
export interface RigaScadenza {
  utente_id: string
  nome?: string | null
  cognome?: string | null
  ruolo?: string | null
  scuola_id?: string | null
  document_type?: string | null
  document_expiry?: string | null
}

/**
 * LO STATO DI UNA RIGA, dalle sole date.
 *
 * I confini li decide `sogliaRaggiunta`, che è la funzione del cron: qui si
 * traducono le sue soglie (0/7/30/60/90) nei quattro secchi del cruscotto, e
 * NIENTE altro. In particolare `giorni === 0` — il documento scade oggi — NON è
 * «scaduto»: un documento d'identità è valido fino al giorno di scadenza
 * compreso, e dirlo scaduto manderebbe una persona in Comune un giorno prima
 * del necessario.
 *
 * ⚠️ DATA ILLEGGIBILE ⇒ «mancante», non «in regola». `document_expiry` è una
 * colonna `date` e da PostgREST esce sempre `YYYY-MM-DD`, quindi questo ramo può
 * nascere solo da un database che non è il nostro o da una route che cambia
 * forma. Fra le due scelte possibili — mostrarla come a posto o metterla nella
 * coda di lavoro — si sceglie la seconda: il verso giusto su un allarme è la
 * riga in più, e in tabella la cella dice che la data non si legge.
 */
export function statoScadenza(scadenza: string | null | undefined, oggi: string): StatoScadenza {
  const grezza = (scadenza ?? '').trim()
  if (grezza === '') return 'mancante'
  const giorni = giorniResidui(grezza, oggi)
  if (!Number.isFinite(giorni)) return 'mancante'
  const soglia = sogliaRaggiunta(giorni)
  if (soglia === null) return 'regola'
  if (soglia === SOGLIA_SCADUTO) return 'scaduto'
  return soglia <= 30 ? 'entro30' : 'entro90'
}

/** Il tono di ciascuno stato: `error` per l'urgenza, `neutral` per la coda di lavoro. */
const TONO: Record<StatoScadenza, BadgeTone> = {
  scaduto: 'error',
  entro30: 'warn',
  entro90: 'info',
  mancante: 'neutral',
  regola: 'success',
}

/**
 * LE CLASSI DEI RIQUADRI, SCRITTE PER ESTESO — e non `bg-kidville-${tono}-soft`.
 *
 * ⚠️ Non è verbosità: Tailwind v4 genera le utility leggendo il SORGENTE, quindi
 * una classe composta a runtime non viene generata affatto. Il risultato non è
 * «il colore sbagliato», è NESSUN COLORE — un riquadro trasparente che non si
 * distingue da quello accanto — e succede in silenzio, col gate verde. È il
 * difetto T08-F1 del collaudo del 2026-08-03, sei classi inesistenti in dieci
 * punti dell'interfaccia, e il lock `utility-kidville-esistenti` nasce da lì.
 *
 * `neutral` NON ha la variante `-strong` (non esiste fra i token): l'inchiostro
 * è `sub`, che è quello che usa anche `Badge` per lo stesso tono e regge l'AA sul
 * fondo neutro.
 */
const CLASSI_TONO: Record<StatoScadenza, { inchiostro: string; attivo: string }> = {
  scaduto: { inchiostro: 'text-kidville-error-strong', attivo: 'border-kidville-error bg-kidville-error-soft' },
  entro30: { inchiostro: 'text-kidville-warn-strong', attivo: 'border-kidville-warn bg-kidville-warn-soft' },
  entro90: { inchiostro: 'text-kidville-info-strong', attivo: 'border-kidville-info bg-kidville-info-soft' },
  mancante: { inchiostro: 'text-kidville-sub', attivo: 'border-kidville-neutral bg-kidville-neutral-soft' },
  regola: { inchiostro: 'text-kidville-success-strong', attivo: 'border-kidville-success bg-kidville-success-soft' },
}

/** La chiave i18n dell'etichetta di stato (badge). */
const CHIAVE_STATO: Record<StatoScadenza, string> = {
  scaduto: 'scadStatoScaduto',
  entro30: 'scadStatoEntro30',
  entro90: 'scadStatoEntro90',
  mancante: 'scadStatoMancante',
  regola: 'scadStatoRegola',
}

/** La chiave i18n del riquadro. */
const CHIAVE_RIQUADRO: Record<StatoScadenza, string> = {
  scaduto: 'scadBoxScaduti',
  entro30: 'scadBoxEntro30',
  entro90: 'scadBoxEntro90',
  mancante: 'scadBoxMancante',
  regola: 'scadStatoRegola',
}

/**
 * L'ICONA di ciascuno stato — e non è decorazione.
 *
 * Il badge porta ICONA + TESTO, mai il colore da solo: chi non distingue rosso e
 * arancione (circa un uomo su dodici) leggerebbe quattro pillole identiche, e su
 * questa tabella la differenza fra due pillole è «ha tempo» e «sta lavorando
 * senza documento». L'icona è `aria-hidden`: il nome accessibile è il testo, che
 * c'è sempre.
 */
const ICONA_STATO: Record<StatoScadenza, typeof AlertTriangle> = {
  scaduto: XCircle,
  entro30: AlertTriangle,
  entro90: CalendarClock,
  mancante: FileWarning,
  regola: CheckCircle2,
}

/**
 * L'ordine in tabella: prima ciò che brucia. A parità di stato, prima chi è più
 * indietro — il documento scaduto da 200 giorni sopra quello scaduto ieri.
 */
const PESO_STATO: Record<StatoScadenza, number> = {
  scaduto: 0, entro30: 1, entro90: 2, mancante: 3, regola: 4,
}

/** Tipo di documento → chiave i18n. Un valore fuori enum resta GREZZO: vedi sotto. */
const CHIAVE_TIPO: Record<string, string> = {
  CI: 'scadTipoCI',
  PP: 'scadTipoPP',
  DL: 'scadTipoDL',
}

/**
 * I valori ammessi, dall'unico posto che li dichiara. Serve al lock nel test:
 * un tipo aggiunto a `TIPI_DOCUMENTO` senza la sua chiave qui uscirebbe a
 * schermo come sigla di database (`DL`), in italiano come in inglese.
 */
export const TIPI_DOCUMENTO_VALORI = TIPI_DOCUMENTO.map((o) => String(o.value))

/** La chiave d'ordinamento alfabetico: valori grezzi, nessuna traduzione. */
function chiaveOrdinamento(r: RigaScadenza): string {
  return [r.cognome ?? '', r.nome ?? ''].map((s) => s.trim()).filter(Boolean).join(' ').toLocaleLowerCase()
}

const ROUTE_LOG = '/admin/staff'
const API = '/api/admin/anagrafica-personale'

/**
 * IL COMANDO DEI PANNELLI D'ESITO — «Riprova» e «Togli il filtro».
 *
 * Scritto una volta perché sono lo stesso comando in due schermate diverse, e al
 * primo giro erano due stringhe gemelle che avrebbero potuto divergere.
 *
 * ⚠️ L'altezza viene da `min-h-[44px]` e NON da `py-*`: è la stessa lezione già
 * scritta in `StaffDetailPanel`. Con `py-2` questi due bottoni misuravano 38 px
 * (misurati), sotto i 44 del bersaglio minimo — e il padding verticale NON è
 * un'altezza: dipende dalla riga di testo che ci sta dentro, quindi una
 * traduzione più corta o un corpo più piccolo lo fanno rimpicciolire da solo.
 */
const BTN_ESITO =
  'mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-pill border border-kidville-green ' +
  'bg-kidville-white px-4 font-barlow text-sm font-bold uppercase tracking-[0.02em] ' +
  'text-kidville-green hover:bg-kidville-green-soft'

interface RispostaCruscotto {
  data?: RigaScadenza[]
  inRegola?: number
  cessati?: number
  oggi?: string
  totalePersonale?: number
  limite?: number
}

interface Props {
  /** Identità di sessione: propagata come gli altri pannelli admin. */
  userId?: string | null
  /** Lo stato con cui la pagina apre il pannello, letto da `?stato=`. */
  statoIniziale?: StatoScadenza | null
  /**
   * «Oggi» in forma civile `YYYY-MM-DD`. Normalmente NON si passa: arriva dal
   * server insieme alle righe. Esiste per i test, che congelano il tempo — un
   * test sulle scadenze con date fisse diventa rosso da solo quando quel giorno
   * arriva, ed è già successo in questo repo.
   */
  oggi?: string
}

export function ScadenzeDocumenti({ userId, statoIniziale = null, oggi }: Props) {
  const t = useTranslations('adminStudents')
  const labelRuolo = useLabelRuolo()
  /**
   * `loading` NON è un dettaglio del contesto: è la differenza fra «questa sede
   * non la riconosco» e «non so ancora quali sedi esistono». Vedi la testata.
   */
  const { sedi, reFetchKey, loading: sediInCorso } = useSediAttive()

  const [righe, setRighe] = useState<RigaScadenza[]>([])
  const [inRegola, setInRegola] = useState(0)
  const [cessati, setCessati] = useState(0)
  const [troncato, setTroncato] = useState(false)
  const [oggiServer, setOggiServer] = useState<string | null>(null)
  const [caricamento, setCaricamento] = useState(true)
  /**
   * Una lettura è RIUSCITA, e quindi i numeri a schermo sono numeri veri.
   *
   * Finché è `false` i quattro riquadri non si disegnano affatto: durante la
   * prima attesa direbbero «0 scaduti», che non è un conteggio ma
   * un'affermazione — la stessa che questo pannello esiste per non fare.
   */
  const [ricevuto, setRicevuto] = useState(false)
  /**
   * L'ULTIMA lettura dell'ELENCO è FALLITA, e questo è il messaggio da mostrare.
   *
   * Tiene separati due stati che altrimenti collassano in uno: «non scade
   * niente» e «non si è riusciti a guardare». Con zero righe si disegnerebbe
   * «Nessun documento in scadenza» anche con la GET a 503 — un'affermazione
   * FALSA, in inchiostro neutro, accanto all'avviso rosso che dice il contrario.
   *
   * ⚠️ È SEPARATO da `errore` (che è l'esito di un CLIC su «Apri documento») per
   * una ragione misurata: mostrati insieme, i due riquadri si contraddicevano.
   * Questo messaggio vive nel pannello che PRENDE IL POSTO dell'elenco, quello
   * lì è una fascia SOPRA un elenco che resta. Un messaggio solo, nel posto che
   * gli corrisponde.
   */
  const [erroreElenco, setErroreElenco] = useState<string | null>(null)
  const [errore, setErrore] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<StatoScadenza | null>(statoIniziale)
  const [documentoBloccato, setDocumentoBloccato] = useState<{ url: string; nome: string } | null>(null)
  const [aprendo, setAprendo] = useState<string | null>(null)

  const letturaFallita = erroreElenco !== null

  /** Il gettone dell'elenco: la risposta di una lettura superata non tocca lo schermo. */
  const gettone = useRef(0)
  /**
   * IL RICOVERO DEL FUOCO: un contenitore stabile attorno ai quattro stati.
   * Vedi la testata — «Riprova» e «Togli il filtro» smontano sé stessi, e senza
   * questo nodo il fuoco cade su `<body>`.
   */
  const ricovero = useRef<HTMLDivElement | null>(null)
  /**
   * I DUE RICOVERI DELLE FASCE D'ESITO. Non sono stabili — nascono con l'esito —
   * quindi il fuoco ci arriva da un effetto e non dal gestore. Vedi la testata.
   */
  const ricoveroErrore = useRef<HTMLParagraphElement | null>(null)
  const ricoveroBloccato = useRef<HTMLParagraphElement | null>(null)
  /**
   * LA GUARDIA DEL DOPPIO CLIC, sincrona.
   *
   * Prende il posto di `disabled` sul comando di riga (che sfogava il fuoco su
   * `<body>`), e lo fa meglio: `disabled` passa dallo stato di React e il secondo
   * clic dello stesso tick trova il bottone ancora attivo. Questo `ref` no.
   */
  const aprendoRef = useRef<string | null>(null)

  const riferimento = oggi ?? oggiServer ?? dataCivile()

  /**
   * Una lettura fallita NON lascia in piedi i dati della precedente.
   *
   * Sembra distruttivo e invece è l'unica forma onesta: il caso che conta è il
   * cambio di sede, dove le righe rimaste sono di un ALTRO PLESSO e i quattro
   * numeri li conterebbero sotto il nome della sede sbagliata. Meglio nessun
   * numero che un numero attribuito al posto sbagliato.
   */
  function scartaLettura(messaggio: string) {
    setErroreElenco(messaggio)
    setRicevuto(false)
    setRighe([])
    setInRegola(0)
    setCessati(0)
    setTroncato(false)
  }

  async function carica(sediKey: string) {
    const mio = ++gettone.current
    try {
      const res = await fetch(`${API}${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`, {
        headers: { 'x-sedi': sediKey },
      })
      if (!res.ok) {
        const messaggio = await messaggioErrore(res, t('scadErroreElenco'))
        if (mio === gettone.current) scartaLettura(messaggio)
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: `scadenze-documenti-non-caricate: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      const json = (await res.json()) as RispostaCruscotto
      // Se nel frattempo le sedi sono cambiate, questo elenco è di un altro plesso.
      if (mio !== gettone.current) return
      if (!Array.isArray(json?.data)) {
        // 200 con un corpo che non è un elenco: è una lettura fallita quanto un
        // 503, e senza questo ramo finirebbe in silenzio — a schermo lo stesso
        // riquadro del «non scade niente».
        scartaLettura(t('scadErroreElenco'))
        logClient({
          livello: 'error',
          evento: 'react',
          messaggio: 'scadenze-documenti-corpo-inatteso: data non è un elenco',
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      setRighe(json.data)
      setInRegola(typeof json.inRegola === 'number' ? json.inRegola : 0)
      setCessati(typeof json.cessati === 'number' ? json.cessati : 0)
      setOggiServer(typeof json.oggi === 'string' ? json.oggi : null)
      setTroncato(
        typeof json.totalePersonale === 'number' &&
        typeof json.limite === 'number' &&
        json.totalePersonale >= json.limite,
      )
      setErroreElenco(null)
      setRicevuto(true)
    } catch (e) {
      if (mio === gettone.current) scartaLettura(t('scadErroreElenco'))
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `scadenze-documenti-fallito: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      if (mio === gettone.current) setCaricamento(false)
    }
  }

  /**
   * Si ricarica quando cambiano le sedi attive, e solo per quello.
   *
   * `carica` passa da un `ref` invece che dalle dipendenze: usa `t()`, e nel
   * banco di prova `useTranslations` costruisce una funzione nuova a ogni
   * chiamata — con `carica` fra le deps l'effetto rifarebbe la fetch all'infinito.
   */
  const caricaRef = useRef(carica)
  useEffect(() => { caricaRef.current = carica })
  useEffect(() => {
    /**
     * ⚠️ NON SI LEGGE FINCHÉ NON SI SA QUALI SEDI.
     *
     * `reFetchKey` è `effettive.join(',')`, cioè `''` finché l'elenco non è
     * arrivato: la prima lettura partiva con scope vuoto e il server rispondeva
     * comunque con tutte le righe accessibili (`resolveScuoleAttive`: elenco
     * vuoto ⇒ tutte). Risultato, le righe si disegnavano mentre `sedi` era
     * ancora `[]` e la colonna Sede dichiarava «Sede non riconosciuta» su ognuna
     * — un'affermazione sul dato, davanti a tre plessi. Aspettare costa
     * un'attesa che c'era già (il velo di caricamento è lo stato iniziale) e
     * toglie anche la doppia fetch di ogni apertura.
     */
    if (sediInCorso) return
    caricaRef.current(reFetchKey)
  }, [reFetchKey, sediInCorso])

  /**
   * IL FUOCO SULL'ESITO DEL CLIC — e non è solo per chi ascolta: il browser
   * porta in vista l'elemento che riceve il fuoco, quindi questa riga è anche
   * ciò che chiude i 1745 px fra il comando dell'ultima riga e la fascia in
   * cima. Sta in un effetto e non nel gestore perché queste due fasce, al
   * contrario del ricovero dell'elenco, NON esistono prima dell'esito.
   */
  useEffect(() => { if (errore) ricoveroErrore.current?.focus() }, [errore])
  useEffect(() => { if (documentoBloccato) ricoveroBloccato.current?.focus() }, [documentoBloccato])

  /**
   * Sposta il fuoco sul ricovero.
   *
   * Si chiama DENTRO il gesto, prima ancora che React ridisegni: il nodo è
   * stabile, esiste già, e resta lo stesso dopo il cambio di stato — quindi il
   * fuoco non ha bisogno di inseguire il render con un `setTimeout`, che sarebbe
   * un altro modo di sbagliare (e in jsdom un altro modo di non poterlo provare).
   */
  function ricoveraFuoco() {
    ricovero.current?.focus()
  }

  /** Il ritenta del riquadro d'errore: rimette il velo e rilegge. */
  function riprova() {
    // Il fuoco PRIMA della `setState`: il bottone che l'utente ha appena premuto
    // sta per smontarsi insieme al pannello che lo contiene.
    ricoveraFuoco()
    setCaricamento(true)
    void carica(reFetchKey)
  }

  /** Toglie il filtro dal riquadro del vuoto-da-filtro, che smonta sé stesso. */
  function togliFiltro() {
    ricoveraFuoco()
    setFiltro(null)
  }

  const conStato = useMemo(
    () => righe.map((r) => ({ riga: r, stato: statoScadenza(r.document_expiry, riferimento) })),
    [righe, riferimento],
  )

  const conteggi = useMemo(() => {
    const out: Record<StatoScadenza, number> = { scaduto: 0, entro30: 0, entro90: 0, mancante: 0, regola: 0 }
    for (const v of conStato) out[v.stato] += 1
    return out
  }, [conStato])

  const visibili = useMemo(() => {
    const scelte = filtro ? conStato.filter((v) => v.stato === filtro) : conStato
    return [...scelte].sort((a, b) => {
      const peso = PESO_STATO[a.stato] - PESO_STATO[b.stato]
      if (peso !== 0) return peso
      const ga = giorniResidui(a.riga.document_expiry ?? '', riferimento)
      const gb = giorniResidui(b.riga.document_expiry ?? '', riferimento)
      if (Number.isFinite(ga) && Number.isFinite(gb) && ga !== gb) return ga - gb
      // A parità di urgenza, l'ordine alfabetico. Si confrontano i valori
      // GREZZI e non l'etichetta tradotta: `nomeDi` passa da `t()`, che nel
      // banco di prova è una funzione nuova a ogni render — usarla qui
      // ricalcolerebbe l'ordinamento a ogni giro per niente.
      return chiaveOrdinamento(a.riga).localeCompare(chiaveOrdinamento(b.riga))
    })
  }, [conStato, filtro, riferimento])

  /**
   * QUATTRO RAMI, PERCHÉ SONO QUATTRO FATTI DIVERSI (vedi la testata).
   *
   *   riga senza sede      → «Non indicato»        · è la riga a non dirlo
   *   elenco sedi assente  → «Sede non disponibile» · è UNA COSA CHE NON SAPPIAMO
   *   id fuori dall'elenco → «Sede non riconosciuta» · è l'unico caso in cui si
   *                                                   sta affermando qualcosa
   *   trovata              → il nome
   *
   * Il secondo ramo copre due situazioni con una frase sola, ed è voluto: chi
   * legge non ha nessun gesto diverso da fare fra «le sedi stanno arrivando» e
   * «le sedi non sono arrivate», mentre ha un gesto molto diverso da fare se la
   * sede di quella persona non esiste più.
   */
  function nomeSede(scuolaId?: string | null): string {
    const id = (scuolaId ?? '').trim()
    if (id === '') return t('scadNonIndicato')
    const trovata = sedi.find((s) => s.id === id)?.nome
    if (trovata) return trovata
    if (sediInCorso || sedi.length === 0) return t('scadSedeNonDisponibile')
    return t('scadSedeSconosciuta')
  }

  function nomeDi(r: RigaScadenza): string {
    return [r.cognome ?? '', r.nome ?? ''].map((s) => s.trim()).filter(Boolean).join(' ') || t('scadSenzaNome')
  }

  /** L'etichetta del tipo: un valore fuori enum si mostra GREZZO, mai nascosto. */
  function etichettaTipo(tipo?: string | null): string {
    const grezzo = (tipo ?? '').trim()
    if (grezzo === '') return t('scadNonIndicato')
    return CHIAVE_TIPO[grezzo] ? t(CHIAVE_TIPO[grezzo]) : grezzo
  }

  /**
   * Apre la scansione del documento: la URL è firmata dal server e vive cinque
   * minuti.
   *
   * La finestra si apre PRIMA della fetch, dentro il gesto dell'utente: Safari e
   * la WebView Capacitor (l'app è spedita nativa) bloccano una `window.open`
   * chiamata in continuazione di promise. Se la finestra non c'è, la URL si
   * mostra come collegamento da aprire a mano — invece di un pulsante che non fa
   * niente e non dice niente.
   *
   * ⚠️ PERCHÉ QUI NON SI USA `@/lib/ui/apri-documento-firmato`, che pure fa
   * esattamente questo per gli altri tre pannelli: quella funzione apre la
   * finestra prima del PRIMO `await` che fa lei — e in questo pannello il primo
   * `await` è un altro, la richiesta del DETTAGLIO, perché il percorso nel bucket
   * non esce mai in elenco (proiezione povera: niente residenza, niente numero di
   * documento, niente percorso di storage). Delegando, la `window.open`
   * cadrebbe dopo quell'`await`, cioè fuori dal gesto, cioè bloccata da Safari e
   * dalla WebView — che è precisamente il difetto che quel modulo esiste per
   * evitare. Il giorno in cui l'elenco portasse il percorso, questo blocco si
   * cancella e si chiama la funzione condivisa.
   */
  async function apriDocumento(riga: RigaScadenza) {
    const utenteId = riga.utente_id
    // LA GUARDIA, e non `disabled`: sincrona, quindi regge anche il doppio clic
    // nello stesso tick — che è più di quanto facesse il `disabled` che c'era.
    if (aprendoRef.current === utenteId) return
    const nome = nomeDi(riga)
    // ⚠️ SI AZZERANO TUTTE E DUE LE FASCE, non una sola. Con `setErrore` mai
    // riportato a `null`, l'avviso rosso della riga A restava a schermo mentre
    // la riga B apriva il documento: un `role="alert"` che afferma «il documento
    // non si è aperto» davanti a un documento appena aperto.
    setDocumentoBloccato(null)
    setErrore(null)
    aprendoRef.current = utenteId
    setAprendo(utenteId)
    const finestra = typeof window !== 'undefined' ? window.open('', '_blank') : null
    try {
      // Il percorso non si conosce in elenco (non esce mai in lista): si chiede
      // il dettaglio, che è anche il punto in cui l'accesso viene registrato.
      const dett = await fetch(`${API}?utenteId=${encodeURIComponent(utenteId)}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      const corpo = await dett.json().catch(() => null)
      const percorso = corpo?.data?.anagrafica?.documento_path as string | null | undefined
      if (!dett.ok || !percorso) {
        finestra?.close()
        setErrore(dett.ok ? t('scadDocumentoAssente') : t('scadErroreDocumento'))
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `scadenze-documento-non-risolto: http ${dett.status}`,
          route: ROUTE_LOG,
          stato: dett.status,
        })
        return
      }
      const res = await fetch(`${API}?doc=${encodeURIComponent(percorso)}`, {
        headers: { 'x-sedi': reFetchKey },
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.url) {
        finestra?.close()
        setErrore(t('scadErroreDocumento'))
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: `scadenze-documento-non-firmato: http ${res.status}`,
          route: ROUTE_LOG,
          stato: res.status,
        })
        return
      }
      const url = String(json.url)
      if (finestra && !finestra.closed) {
        // `opener` a null: la scheda del documento non deve poter toccare il
        // cockpit da cui è nata.
        try { finestra.opener = null } catch { /* alcune WebView la rendono non scrivibile: l'apertura vale comunque */ }
        finestra.location.replace(url)
        return
      }
      setDocumentoBloccato({ url, nome })
      logClient({
        livello: 'warn',
        evento: 'react',
        messaggio: 'scadenze-documento-finestra-bloccata: window.open ha ritornato null',
        route: ROUTE_LOG,
      })
    } catch (e) {
      finestra?.close()
      setErrore(t('scadErroreDocumento'))
      logClient({
        livello: 'error',
        evento: 'react',
        messaggio: `scadenze-documento-fallito: ${nomeErrore(e)}`,
        route: ROUTE_LOG,
      })
    } finally {
      if (aprendoRef.current === utenteId) aprendoRef.current = null
      setAprendo((corrente) => (corrente === utenteId ? null : corrente))
    }
  }

  return (
    <>
      {/* L'INTESTAZIONE DELLA SEZIONE — `sr-only`, e non è una scorciatoia.

          Il difetto misurato il 2026-08-12: su `/admin/staff?tab=scadenze`
          l'intera pagina aveva UN SOLO `<h1>` («Gestione Staff») e ZERO `<h2>`,
          cioè `document.querySelectorAll('h2').length === 0`. La navigazione per
          intestazioni — il modo normale di orientarsi con uno screen reader, il
          tasto H — restituiva il titolo della pagina e poi il nulla: non c'era
          modo di saltare al cruscotto, e nella schermata del VUOTO quel titolo
          era anche l'unico messaggio a schermo.

          Perché invisibile e non a schermo: la linguetta premuta dice già
          «Scadenze documenti» a chi guarda, e ristampare la stessa parola due
          righe sotto sarebbe rumore per tutti per riparare un difetto che
          riguarda chi non la vede. Stessa stringa della linguetta di proposito:
          chi ha appena premuto «Scadenze documenti» deve ritrovare quel nome, non
          un sinonimo che lo faccia dubitare di essere nel posto giusto.

          Da qui il livello di TUTTO ciò che sta dentro: questa è la sezione, e i
          titoli interni (il vuoto vero) sono `<h3>`. h1 → h2 → h3, nessun livello
          saltato. */}
      <h2 className="sr-only">{t('scadTabScadenze')}</h2>

      {/* ⚠️ `ch` NON È UNA BATTUTA, e il giro scorso questo commento lo dava per
          scontato. `1ch` è l'avanzata della cifra «0»: in Maven Pro vale 0,646 em,
          mentre la battuta media di questa prosa ne misura 0,446 — rapporto 1,45.
          Quindi il `max-w-[60ch]` scritto qui «per stare sotto le ~75 battute»
          faceva righe da 87 (IT) e 85 (EN): meglio dei 120 di `max-w-3xl`, ma
          ancora sopra le ~75 oltre cui l'occhio perde il ritorno a capo.
          Misurato in Chrome con un Range sui nodi di testo, non stimato: 60ch =
          542,6 px, `scadIntro` IT 87/80 e EN 83/51. Con `52ch` (470,3 px) lo
          stesso testo fa 71/73/23 (IT) e 72/62 (EN).
          Le due fasce d'esito restano a `68ch` e non è una dimenticanza: le loro
          frasi sono di 61 e 57 battute, cioè una riga sola a qualunque tetto.

          ⚠️ QUI SI RESTA IN `ch`, E ALTROVE NO: `FieldRenderer.tsx` e
          `StaffDetailPanel.tsx` hanno pagato lo stesso difetto l'11/08 e ne sono
          usciti scrivendo il tetto in rem («NON SI SCRIVE IN `ch`»), con un lock
          che lo pretende. La divergenza è voluta, e la ragione è misurata: in
          `ch` il conto delle battute NON DIPENDE DAL CORPO — scatola e glifi
          scalano insieme e il corpo si semplifica, misurato `71/73/5` sia a
          14 px sia a 16 px. Questo pannello ha prosa a tutti e due i corpi
          (`text-sm` qui, 1 rem ereditato nel pannello d'errore e nel vuoto da
          filtro), e in rem servirebbero due costanti — o un banco che INDOVINA
          il corpo da una classe Tailwind, che è un buco silenzioso in un lock
          nato proprio per non averne. In `ch` al banco basta il numero scritto
          nella classe, e infatti lo misura: `battutePerRiga` conta le righe che
          il testo produce davvero, in italiano e in inglese. */}
      <p className="mb-4 max-w-[52ch] font-maven text-sm text-kidville-sub">{t('scadIntro')}</p>

      {/* LE DUE FASCE D'ESITO DEL CLIC SU «APRI DOCUMENTO» — simmetriche.
          Stesso ruolo (`alert`), stesso ricovero del fuoco, stesso `data-ricovero`:
          nascono dallo stesso gesto e si escludono a vicenda, e al secondo giro
          una era annunciata e l'altra muta — muta proprio quella che CHIEDE
          un'azione. Vedi la testata. */}
      {errore && (
        <p
          ref={ricoveroErrore}
          role="alert"
          tabIndex={-1}
          data-ricovero="esito"
          className={cx(
            'mb-4 flex max-w-[68ch] items-start gap-2 rounded-card border border-kidville-error/30 bg-kidville-error-soft px-4 py-3 font-maven text-sm text-kidville-error-strong',
            FUOCO_ESITO,
          )}
        >
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" /> {errore}
        </p>
      )}

      {documentoBloccato && (
        <p
          ref={ricoveroBloccato}
          role="alert"
          tabIndex={-1}
          data-ricovero="esito"
          className={cx(
            'mb-4 flex max-w-[68ch] flex-wrap items-center gap-2 rounded-card border border-kidville-warn/40 bg-kidville-warn-soft px-4 py-3 font-maven text-sm text-kidville-warn-strong',
            FUOCO_ESITO,
          )}
        >
          {t('scadDocumentoBloccato')}
          {/* Il nome accessibile DICE DI CHI È il documento, come i comandi di
              riga: «Apri documento» e basta, ripetuto, non distingue una riga
              dall'altra — e qui si sta per aprire il documento d'identità di una
              persona vera. `min-h` a 44 px: è un bersaglio, non una parola in
              mezzo a una frase. */}
          <a
            href={documentoBloccato.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center gap-1.5 font-semibold text-kidville-green underline"
          >
            {t('scadApriDocumentoDi', { nome: documentoBloccato.nome })} <ExternalLink size={14} aria-hidden="true" />
          </a>
        </p>
      )}

      {/* Stesso tetto dell'introduzione, e per la stessa misura: a 60ch questa
          frase faceva 75 battute in italiano — cioè esattamente al confine, che
          non è un margine ma un caso fortunato — e 85 in inglese, sopra. */}
      {troncato && (
        <p role="alert" className="mb-4 max-w-[52ch] font-maven text-sm text-kidville-warn-strong">
          {t('scadElencoTroncato')}
        </p>
      )}

      {/* I QUATTRO RIQUADRI E LA RIGA «IN REGOLA» ESISTONO SOLO SU UNA LETTURA
          RIUSCITA (`ricevuto`).
          Restano a schermo quando l'elenco è vuoto — i numeri a zero sono
          un'informazione, e farli sparire toglierebbe anche il modo di togliere
          un filtro — ma NON quando la lettura è fallita né durante la prima
          attesa: lì «0 scaduti» non sarebbe un conteggio, sarebbe
          un'affermazione, e dopo un cambio di sede sarebbe pure il conteggio del
          plesso sbagliato. Vedi la testata. */}
      {ricevuto && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {STATI_FILTRABILI.map((stato) => (
              <RiquadroStato
                key={stato}
                stato={stato}
                etichetta={t(CHIAVE_RIQUADRO[stato])}
                valore={conteggi[stato]}
                attivo={filtro === stato}
                onClick={() => setFiltro(filtro === stato ? null : stato)}
              />
            ))}
          </div>

          {/* «In regola» non è un riquadro: è una riga. E accanto, quando ce ne
              sono, i rapporti cessati — che dal cruscotto sono esclusi apposta, e
              senza questa riga la somma dei numeri non tornerebbe con nessun
              elenco. */}
          <p className="mb-5 font-maven text-[13px] text-kidville-sub">
            {t('scadInRegola', { n: inRegola })}
            {/* `sub` e non `muted`: questa riga è CONTENUTO — dice perché la somma
                dei riquadri non torna con il personale in servizio — e `muted` sta a
                2,51:1 su bianco, sotto il 4,5:1 di WCAG AA. */}
            {cessati > 0 && <span className="text-kidville-sub"> · {t('scadCessati', { n: cessati })}</span>}
          </p>
        </>
      )}

      {/* IL RICOVERO DEL FUOCO — vedi la testata. Non è un contenitore di
          impaginazione: è il nodo STABILE su cui posare il fuoco quando il
          comando premuto smonta sé stesso. `tabIndex={-1}` lo rende raggiungibile
          da codice senza entrare nell'ordine di tabulazione. */}
      <div ref={ricovero} tabIndex={-1} data-ricovero="elenco" className={cx(FUOCO_ESITO, 'rounded-card')}>
        {caricamento ? (
          <div role="status" aria-live="polite" className="flex min-h-[30vh] items-center justify-center gap-3">
            <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-kidville-green" />
            <span className="font-maven text-kidville-sub">{t('scadCaricamento')}</span>
          </div>
        ) : letturaFallita ? (
          /* L'elenco NON si è potuto leggere: non si afferma niente sul mondo, si
             dice che non si sa — e si offre il gesto per riprovare.
             UN SOLO MESSAGGIO, ed è quello risolto dalla risposta (il codice del
             server se c'è, altrimenti `scadErroreElenco`): al primo giro qui
             c'era una frase, e sopra ce n'era un'altra in `role="alert"`, e tutte
             e due dicevano «l'elenco che vedi potrebbe non essere completo»
             davanti a ZERO righe. */
          <div role="alert" className="rounded-card border border-kidville-warn/40 bg-kidville-warn-soft p-10 text-center">
            <AlertTriangle aria-hidden="true" className="mx-auto mb-3 h-10 w-10 text-kidville-warn-strong" />
            <p className="mx-auto max-w-[52ch] font-maven text-kidville-warn-strong">{erroreElenco}</p>
            <button type="button" onClick={riprova} className={BTN_ESITO}>
              {t('scadRiprova')}
            </button>
          </div>
        ) : visibili.length === 0 ? (
          filtro ? (
            /* VUOTO DA FILTRO — e la frase è DIVERSA da quella del vuoto vero: qui
               non si sta dicendo che non c'è niente da fare, si sta dicendo che
               non c'è niente IN QUESTO STATO. */
            <div className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center">
              <p className="mx-auto max-w-[52ch] font-maven text-kidville-sub">{t('scadVuotoFiltro')}</p>
              <button type="button" onClick={togliFiltro} className={BTN_ESITO}>
                {t('scadTogliFiltro')}
              </button>
            </div>
          ) : (
            /* VUOTO VERO: l'elenco è stato letto, e non c'è niente in scadenza. */
            <div className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center">
              <CheckCircle2 aria-hidden="true" className="mx-auto mb-3 h-10 w-10 text-kidville-success" />
              {/* ⚠️ `<h3>` E NON `<p>`. Questa riga porta la formula visiva di un
                  titolo (`font-barlow`, corpo maggiorato, maiuscolo, verde di
                  casa) e nel resto del repo quella formula È un'intestazione:
                  `CodiciFiscaliDaVerificare.tsx` la usa su un `<h2>`, e il
                  pannello gemello di questo stesso modulo
                  (`PratichePersonale.tsx`) il suo `<h2>` ce l'ha. Qui era un
                  paragrafo travestito: sembrava un titolo e non lo era, e nella
                  schermata del vuoto è l'UNICO messaggio a schermo — cioè
                  esattamente il punto in cui una lista di intestazioni vuota
                  lascia chi ascolta senza niente a cui saltare.
                  `h3` e non `h2` perché sopra c'è il titolo della sezione: questo
                  è il suo esito, non una sezione sorella. */}
              <h3 className="font-barlow text-lg font-extrabold uppercase text-kidville-green">{t('scadVuoto')}</h3>
              <p className="mx-auto mt-1 max-w-[52ch] font-maven text-sm text-kidville-sub">{t('scadVuotoSottotitolo')}</p>
            </div>
          )
        ) : (
          /* LA CARTA STA FUORI DALLO SCORRITORE, e non è impaginazione.
             `TABLE_WRAP` porta `.kv-table-scroll`, che dichiara la SCORCIATOIA
             `background: linear-gradient(…)` fuori da ogni `@layer`: quella
             scorciatoia azzera `background-color` e batte le utility (che stanno
             in `@layer utilities`). Un `bg-kidville-white` sullo stesso elemento
             è codice morto — misurato `rgba(0, 0, 0, 0)`, cioè non «il colore
             sbagliato» ma NESSUN COLORE, con la carta trasparente sul crema
             della pagina, l'ombra che fluttua sul nulla e i due coperchi bianchi
             dello scorrimento ridotti a due sbavature chiare.
             Il fondo va su un contenitore ESTERNO: è così negli altri sei usi di
             `TABLE_WRAP` nel repo, e questo era l'unico fuori riga. */
          <div className="rounded-card bg-kidville-white px-4 py-3" style={{ boxShadow: SHADOW_CARD }}>
            <div className={TABLE_WRAP}>
              <table className={TABLE}>
                {/* Il nome della tabella per chi la incontra con uno screen reader:
                    senza, è una griglia di celle senza titolo in mezzo alla pagina. */}
                <caption className="sr-only">{t('scadTabScadenze')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>{t('scadColPersona')}</th>
                    <th scope="col" className={TH}>{t('scadColRuolo')}</th>
                    <th scope="col" className={TH}>{t('scadColSede')}</th>
                    <th scope="col" className={TH}>{t('scadColTipo')}</th>
                    <th scope="col" className={TH}>{t('scadColScadenza')}</th>
                    <th scope="col" className={TH}>{t('scadColStato')}</th>
                    <th scope="col" className={TH}>{t('scadColAzioni')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibili.map(({ riga, stato }) => (
                    <tr key={riga.utente_id} className={TROW}>
                      <td className={TD}>
                        {/* Un collegamento VERO (`<a href>`), non un `onClick` su una
                            riga: si apre in una scheda nuova col tasto centrale, si
                            copia, si raggiunge con Tab.
                            `min-h`/`min-w` a 44 px: è un bersaglio in una riga di
                            tabella, non una parola dentro una frase, e un nome corto
                            arrivava a 29 px di larghezza. */}
                        <a
                          href={`/admin/students/${riga.utente_id}?kind=staff`}
                          className="inline-flex min-h-[44px] min-w-[44px] items-center font-barlow font-bold text-kidville-green underline-offset-2 hover:underline"
                        >
                          {nomeDi(riga)}
                        </a>
                      </td>
                      <td className={cx(TD, 'font-maven text-[13px] text-kidville-sub')}>
                        {riga.ruolo ? labelRuolo(riga.ruolo) : t('scadNonIndicato')}
                      </td>
                      <td className={cx(TD, 'font-maven text-[13px] text-kidville-sub')}>{nomeSede(riga.scuola_id)}</td>
                      <td className={cx(TD, 'font-maven text-[13px] text-kidville-sub')}>{etichettaTipo(riga.document_type)}</td>
                      <td className={cx(TD, 'font-maven text-[13px] text-kidville-ink')}>
                        <CellaScadenza scadenza={riga.document_expiry} oggi={riferimento} />
                      </td>
                      <td className={TD}>
                        <BadgeStato stato={stato} />
                      </td>
                      <td className={TD}>
                        {/* IL NOME ACCESSIBILE PORTA IL NOME DELLA PERSONA.
                            Con «Apri documento» e basta, chi naviga per elenco di
                            comandi — la modalità normale su una tabella — sente N
                            volte la stessa voce e non sa di chi sia il documento che
                            sta per aprire: l'icona è `aria-hidden` (giusto) e non
                            resta nient'altro a distinguere una riga dall'altra. Su
                            un fascicolo del personale quella riga è il documento
                            d'identità di una persona vera. Il testo VISIBILE resta
                            corto (la colonna è stretta): il nome sta nell'`aria-label`.
                            ⚠️ E l'`aria-label` COMINCIA con il testo a schermo
                            («Apri documento di Anna Rossi», non «Apri il documento
                            di…»): è WCAG 2.5.3 Label in Name — chi comanda a voce
                            dice quello che LEGGE, e un nome accessibile che non
                            contiene l'etichetta visibile rende il comando muto. */}
                        {/* ⚠️ NIENTE `disabled` MENTRE LAVORA — è la regola di
                            casa (`Btn.tsx`) e qui il difetto era misurato:
                            Chrome sfoga il fuoco dell'elemento che diventa
                            `disabled`, `document.activeElement` passa a BODY e
                            NON torna alla riattivazione. Su una tabella che il
                            server ammette fino a 500 righe, chi lavora da
                            tastiera ritabulerebbe dall'inizio del documento a
                            ogni riga della coda.
                            `aria-busy` + `aria-disabled` dicono la stessa cosa
                            agli assistivi tenendo il bottone nel giro del Tab; il
                            doppio invio lo ferma `aprendoRef`, che è sincrona.
                            E niente `opacity-*`: sbiadire toglie proprio l'unico
                            segnale che il gesto è partito — lo stato è il
                            girandolo, che resta pieno. */}
                        <button
                          type="button"
                          onClick={() => apriDocumento(riga)}
                          aria-busy={aprendo === riga.utente_id || undefined}
                          aria-disabled={aprendo === riga.utente_id || undefined}
                          aria-label={t('scadApriDocumentoDi', { nome: nomeDi(riga) })}
                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-kidville-line bg-kidville-white px-3 font-barlow text-[11.5px] font-bold uppercase tracking-[0.03em] text-kidville-green transition-colors hover:bg-kidville-green-soft"
                        >
                          {aprendo === riga.utente_id
                            ? <Loader2 size={13} aria-hidden="true" className="animate-spin" />
                            : <ExternalLink size={13} aria-hidden="true" />}
                          {t('scadApriDocumento')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * Un riquadro cliccabile. `aria-pressed` porta lo stato su un ruolo che lo
 * espone davvero: prima di questa riga «filtro attivo» sarebbe stato solo un
 * bordo colorato, cioè niente per chi non vede.
 */
function RiquadroStato({
  stato, etichetta, valore, attivo, onClick,
}: {
  stato: StatoScadenza
  etichetta: string
  valore: number
  attivo: boolean
  onClick: () => void
}) {
  const t = useTranslations('adminStudents')
  const classi = CLASSI_TONO[stato]
  const Icona = ICONA_STATO[stato]
  return (
    <button
      type="button"
      aria-pressed={attivo}
      onClick={onClick}
      className={cx(
        'rounded-xl border-2 px-3 py-2.5 text-left transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1',
        attivo ? classi.attivo : 'border-kidville-line bg-kidville-white hover:border-kidville-green',
      )}
    >
      <span className="flex items-center gap-1.5">
        <Icona size={14} aria-hidden="true" className={classi.inchiostro} />
        <span className="font-barlow text-[11px] font-bold uppercase leading-tight tracking-[0.04em] text-kidville-sub">
          {etichetta}
        </span>
      </span>
      <span className="mt-1 flex items-baseline gap-2">
        <span className={cx('font-barlow text-2xl font-black leading-none', classi.inchiostro)}>{valore}</span>
        {attivo && <span className="font-maven text-[10.5px] text-kidville-sub">{t('scadFiltroAttivo')}</span>}
      </span>
    </button>
  )
}

/** Il badge di stato: ICONA + TESTO, mai il colore da solo. */
function BadgeStato({ stato }: { stato: StatoScadenza }) {
  const t = useTranslations('adminStudents')
  const Icona = ICONA_STATO[stato]
  return (
    <Badge tone={TONO[stato]}>
      <Icona size={12} aria-hidden="true" />
      {t(CHIAVE_STATO[stato])}
    </Badge>
  )
}

/**
 * La cella della scadenza: la DATA, e sotto quanto manca (o quanto è passato).
 *
 * La distanza in giorni sta accanto alla data perché è la sola cosa che si legge
 * senza fare un conto: «12/09/2026» non dice a nessuno se sia un problema di
 * oggi o dell'anno prossimo.
 */
function CellaScadenza({ scadenza, oggi }: { scadenza?: string | null; oggi: string }) {
  const t = useTranslations('adminStudents')
  const f = useDateFormat()
  const grezza = (scadenza ?? '').trim()
  if (grezza === '') return <span className="text-kidville-sub">{t('scadSenzaDocumento')}</span>
  const giorni = giorniResidui(grezza, oggi)
  if (!Number.isFinite(giorni)) return <span className="text-kidville-sub">{t('scadDataIllegibile')}</span>
  return (
    <span className="flex flex-col leading-tight">
      <span className="font-semibold">{f.dataBreve(grezza)}</span>
      <span className="font-maven text-[11.5px] text-kidville-sub">
        {giorni === 0
          ? t('scadOggi')
          : giorni > 0
            ? t('scadFraGiorni', { n: giorni })
            : t('scadDaGiorni', { n: -giorni })}
      </span>
    </span>
  )
}
