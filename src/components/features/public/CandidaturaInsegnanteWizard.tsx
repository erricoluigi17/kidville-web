'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useForm, type FieldValues } from 'react-hook-form'
import {
  AlertCircle, AlertTriangle, Check, GraduationCap, Loader2, MapPin, RefreshCw,
  ShieldCheck, UserRound,
} from 'lucide-react'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import {
  BarraAvanzamento, ColonnaCentrale, ColonnaContesto, ComandiWizard, ContatorePassi,
  EscaHoneypot, GrigliaPasso, GuscioPubblico, PannelloConferma, PannelloErroreInvio,
  TestataPasso, type ComandoAvanti,
} from '@/components/features/public/wizard/pezzi-wizard-pubblico'
import {
  corpoDellaRisposta, useSediPubbliche,
} from '@/components/features/public/wizard/use-sedi-pubbliche'
import {
  INSEGNANTE_FIELDS, CONSENSI_INSEGNANTI_FIELDS,
} from '@/lib/forms/insegnanti-template'
import { validateField, isProvinceField } from '@/lib/forms/validate-fields'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch'
import { logClient, nomeErrore } from '@/lib/logging/client'
import type { FormField } from '@/types/database.types'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  «Lavora con noi» — il modulo PUBBLICO di candidatura di un'insegnante   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Si apre da un link, senza account: chi si candida non ne ha uno e non deve
 * averlo — l'account nasce solo se la Direzione approva
 * (`POST /api/iscrizione/insegnanti`, e la tabella `candidature_insegnanti`).
 *
 * ── L'IMPIANTO DELLE SEDI NON VIVE PIÙ QUI ──────────────────────────────────
 *
 * Era ricopiato da `EnrollmentWizard` riga per riga, e stava per esserlo una
 * terza volta per `/anagrafica-personale`. Dall'11/08/2026 sta in
 * `wizard/use-sedi-pubbliche.ts`, insieme alle misure che gli hanno dato la
 * forma che ha: i tre stati (`null` non è `[]`), il `!r.ok` che non è
 * un'eccezione, `?sede=` come SUGGERIMENTO che l'elenco può smentire, e la
 * regola per cui dopo un rifiuto del server il modulo non si smonta più. Chi
 * cambia il comportamento delle sedi apre quel file, non questo.
 *
 * Resta qui la parte che è di QUESTO modulo, e che è più severa della sorella:
 * `POST /api/iscrizione/insegnanti` pretende `scuola_id` come uuid
 * OBBLIGATORIO, perché con tre plessi dedurre la sede vuol dire archiviare la
 * candidatura nel posto sbagliato in silenzio. Senza sede non c'è nessun invio
 * possibile, quindi il modulo non comincia; e finché la FORMA della procedura
 * non è definitiva (`formaDecisa`) non si dipinge NESSUN passo — dipingerne uno
 * e cambiarlo dopo farebbe saltare sotto le mani il passo su cui si sta
 * scrivendo. I dati restano dove sono anche quando un passo si smonta:
 * react-hook-form conserva i valori dei campi smontati (`shouldUnregister` è
 * false).
 *
 * ── PERCHÉ NON C'È `AnimatePresence mode="wait"` (e nemmeno framer-motion) ──
 *
 * Con `mode="wait"` il pannello nuovo si monta solo DOPO che l'uscita del
 * vecchio è finita: quando quell'uscita non finiva, il wizard restava inchiodato
 * al primo passo mentre il contatore avanzava, e — la parte che conta — un
 * pannello mai montato NON registra i suoi campi in react-hook-form. Si arrivava
 * all'invio con i dati vuoti. Un'animazione non può decidere se un modulo
 * funziona: qui non ce n'è nessuna che monti o smonti un passo.
 *
 * ── PERCHÉ IL CURRICULUM NON SI CHIEDE (ANCORA) ────────────────────────────
 *
 * Il template dichiara un campo `cv_path` facoltativo, e questo modulo NON lo
 * rende. Non è una dimenticanza: `POST /api/iscrizione/insegnanti` accetta solo
 * percorsi della forma `candidature/<uuid>-<nome>` (vedi `percorsoCvAmmesso`,
 * e la ragione per esteso lì: quel valore è la chiave con cui il cockpit fa
 * firmare un oggetto del bucket dei documenti dei minori). Al 2026-08-11 NESSUNA
 * rotta di caricamento produce quel prefisso — l'unica pubblica,
 * `iscrizione/upload:POST`, scrive sotto `iscrizioni/…`. Renderlo qui vorrebbe
 * dire far caricare un curriculum e poi respingerlo all'invio, dopo che tutto il
 * resto è stato compilato: è il difetto «bucket più stretto del gate» che questo
 * repo ha già pagato una volta. Il campo torna il giorno in cui nasce la rotta
 * di caricamento delle candidature — e allora basterà toglierlo da
 * `IDS_NON_RESI`, perché tutto il resto (`accept`, tetto, validazione) è già nel
 * template.
 *
 * ── IL RIEPILOGO RIEPILOGA, E NON È UN DETTAGLIO ESTETICO ──────────────────
 *
 * Fino al 2026-08-11 l'ultimo passo diceva «Controlla e invia la candidatura» e
 * mostrava DUE fatti su tredici campi compilabili: la sede e le fasce d'età.
 * Nome, cognome, EMAIL, telefono, comune, provincia, titolo di studio, dettaglio,
 * anni di esperienza, disponibilità, presentazione e le due risposte sui consensi
 * non comparivano affatto. Chi arrivava lì non aveva niente da controllare — e
 * soprattutto non rileggeva il proprio indirizzo email, che è l'UNICO modo con
 * cui la Scuola può rispondergli (`candInviataCorpo`: «riceverai le credenziali
 * di accesso via email»). Un refuso nell'indirizzo, e la candidatura è persa
 * senza che nessuno lo sappia mai: la rotta risponde 201 anche al duplicato, e
 * nessun rimbalzo torna a chi ha compilato.
 *
 * Adesso il riepilogo è COSTRUITO DAI CAMPI, non scritto a mano: `CAMPI_DATI`,
 * `CAMPI_PROFILO` e `CONSENSI_INSEGNANTI_FIELDS` sono le stesse liste che
 * disegnano i passi, quindi un campo aggiunto domani al template compare nel
 * riepilogo da solo. Ribatterlo a mano sarebbe la seconda lista da mantenere, ed
 * è precisamente il modo in cui la prima è rimasta indietro di undici campi.
 * (Vale anche per `cv_path`: oggi non è reso — vedi il blocco qui sopra — e per
 * questo non ha una riga; il giorno in cui torna in `CAMPI_RESI`, il riepilogo lo
 * nomina senza che si tocchi niente qui.)
 *
 * ⚠️ I CAMPI FACOLTATIVI LASCIATI VUOTI SI MOSTRANO, come «Non indicato», e non
 * si omettono. È una scelta, non un'inerzia: omettere una riga rende l'omissione
 * invisibile proprio a chi deve accorgersene. «Telefono: non indicato» dice che
 * la Scuola potrà scrivere soltanto via email, e chi voleva essere chiamato fa in
 * tempo a tornare indietro; una riga assente non dice niente e si legge come un
 * campo che non era stato chiesto. I consensi non hanno «non indicato» affatto:
 * hanno «Sì» e «No», per la stessa ragione per cui il `false` viaggia nel payload
 * — «non gliel'ho chiesto» e «ha detto no» non sono la stessa cosa.
 *
 * ── E NEMMENO IL GUSCIO VIVE PIÙ QUI ────────────────────────────────────────
 *
 * Barra di avanzamento, pallini dei passi, testata del passo, impaginatura a due
 * colonne, comandi, pannelli d'errore e di conferma, colonna di contesto ed esca
 * stanno in `wizard/pezzi-wizard-pubblico.tsx`, con i commenti misurati che li
 * accompagnano — comprese le due regole che decidono la forma della pagina: i
 * comandi NON sono incollati in fondo allo schermo (il vuoto di 180-327 px) e non
 * sono una barra `sticky` (il piede che copre l'ultimo campo, difetto già pagato
 * su «Comunica un'assenza»). Qui l'ultimo campo è la presentazione libera, cioè
 * una textarea alta: sarebbe lo stesso guasto.
 *
 * Di quel guscio resta a questo file una sola regola sua: il testo della colonna
 * di contesto non promette NIENTE più di quanto prometta il pannello di conferma
 * — nessun termine di risposta (perché la conferma non ne dichiara uno) e le
 * credenziali via email solo «se la candidatura viene accolta».
 *
 * ── ⚠️ LIMITE NOTO: CON L'INTERFACCIA IN INGLESE LA PAGINA È TRADOTTA A METÀ ─
 *
 * Il GUSCIO di questa schermata è bilingue e lo è per davvero (50 chiavi `cand*`
 * in `messages/it` e `messages/en`, sorvegliate dal lock di parità): titoli dei
 * passi, bottoni, errori, conferma. Le ETICHETTE DEI CAMPI no: arrivano da
 * `INSEGNANTE_FIELDS` e sono cablate in italiano — «Per quali fasce ti proponi»,
 * «Titolo di studio», «Presentati in poche righe», i sette `TITOLI_STUDIO`, le
 * cinque `DISPONIBILITA` e i tre gradi.
 *
 * ⚠️ E dal 2026-08-11 quel debito PESA DI PIÙ, il che è il prezzo dichiarato del
 * riepilogo completo: prima le etichette italiane si vedevano una volta sola, nel
 * passo in cui si compilava; adesso il riepilogo le RISTAMPA tutte, etichette e
 * valori (`rigaDelCampo` legge `f.label` e `o.label`). Il conto non cambia — sono
 * le stesse stringhe — ma la schermata su cui si controlla prima di inviare è
 * proprio quella dove il miscuglio si nota di più. Ragione in più per chiudere il
 * debito alla sorgente, cioè nel template, invece che qui.
 *
 * Non è stato introdotto qui: è la forma di `enrollment-template.ts`, che questo
 * template ricalca, e vale identico per `/iscrizione`. Ma va DETTO invece che
 * lasciato passare per fatto: è lo stesso difetto R13 che `PublicPageHeader` è
 * nato per chiudere — metà tradotta e metà no, dentro un documento dichiarato
 * `lang="en"` — ricomparso un livello più sotto. Si chiude portando le etichette
 * del template a chiavi di messaggio, e il giorno in cui lo si fa va fatto per
 * ENTRAMBI i template, altrimenti si sposta di nuovo. Il debito è ripetuto in
 * testa a `src/lib/forms/insegnanti-template.ts`, che è il file che si apre per
 * cambiare un'etichetta.
 */

/** Dove arriva la candidatura. */
const ROTTA_INVIO = '/api/iscrizione/insegnanti'
/**
 * Lo slug di QUESTO modulo nei log del client.
 *
 * Il `messaggio` di `logClient` è anche la chiave del suo throttle: due moduli
 * pubblici che spedissero lo stesso slug si dedurrebbero a vicenda proprio
 * mentre uno dei due è guasto. Le stringhe che ne escono — `candidatura-sedi-
 * non-caricate`, `candidatura-corpo-illeggibile` — sono le stesse di prima
 * dell'estrazione: si interrogano in SQL su `app_log`, e cambiarle vorrebbe dire
 * perdere la continuità della serie.
 */
const ETICHETTA_LOG = 'candidatura'

/** I passi possibili. Il primo esiste solo quando c'è davvero da scegliere. */
type Passo = 'sede' | 'dati' | 'profilo' | 'consensi' | 'riepilogo'

/**
 * I campi del PRIMO passo compilabile: chi sei e come ti si ricontatta.
 *
 * ⚠️ È l'unico elenco scritto a mano, ed è scritto in POSITIVO di proposito:
 * tutto ciò che il template dichiara e che non è qui dentro finisce nel passo
 * «profilo» (vedi `CAMPI_PROFILO`). Così un campo AGGIUNTO domani al template
 * viene reso comunque, in un passo o nell'altro, invece di sparire in silenzio —
 * e un campo obbligatorio che sparisce è un modulo che il server rifiuta per
 * sempre senza che nessuno capisca perché.
 */
const IDS_DATI = new Set([
  'nome', 'cognome', 'email', 'telefono', 'residence_city', 'residence_province',
])

/**
 * I campi del template che questo modulo NON rende, con la ragione.
 *
 * ⚠️ Qui può entrare SOLO un campo `required: false`. Un campo obbligatorio non
 * reso non è «un campo in meno»: è `validatePage` che sul server lo trova vuoto
 * a ogni invio, cioè un modulo che non si può compilare. Il collaudo
 * `CandidaturaInsegnanteWizard-gradi.test.tsx` lo verifica campo per campo.
 */
const IDS_NON_RESI = new Set(['cv_path'])

const CAMPI_DATI: FormField[] = INSEGNANTE_FIELDS.filter((f) => IDS_DATI.has(f.id))
const CAMPI_PROFILO: FormField[] = INSEGNANTE_FIELDS.filter(
  (f) => !IDS_DATI.has(f.id) && !IDS_NON_RESI.has(f.id),
)

/** Tutti i campi che il modulo rende, nell'ordine in cui si compilano. */
const CAMPI_RESI: FormField[] = [...CAMPI_DATI, ...CAMPI_PROFILO]

/**
 * Il nome dell'ESCA (honeypot). La rotta accetta `sito_web` e `honeypot` come
 * sinonimi: si manda il primo, che è quello che un compilatore automatico
 * riempie più volentieri. Se arriva pieno, chi ha inviato non stava guardando il
 * modulo — un modulo che l'esca non la rende affatto è una difesa che non scatta
 * mai, cioè una difesa che sembra esserci.
 */
const CAMPO_ESCA = 'sito_web'

/**
 * L'`id` del messaggio d'errore del gruppo «sede», per `aria-describedby`.
 * Il gruppo è uno solo in pagina (il passo esiste una volta), quindi un id fisso
 * basta e non serve derivarlo da niente.
 */
const ID_ERRORE_SEDE = 'sede-errore'

/**
 * L'`id` della riga «Passo N di M», che è anche la DESCRIZIONE del titolo del
 * passo: arrivando su un passo nuovo il fuoco si posa sull'`h2`, e chi ascolta
 * sente il titolo seguito dalla posizione nella sequenza («Il tuo profilo…
 * Passo 3 di 5») invece del solo titolo. La riga esiste già a schermo: qui non
 * si aggiunge testo, si dichiara un legame.
 */
const ID_PASSO_CONTATORE = 'cand-passo-contatore'

/**
 * Una riga del riepilogo: un'etichetta e ciò che è stato scritto sotto di essa.
 *
 * `elenco` è la forma delle scelte multiple (le fasce d'età): una voce per riga,
 * non una stringa unita da virgole — così ogni etichetta resta la stessa stringa
 * che si è letta spuntandola, e nessuna riga cresce a dismisura sul telefono.
 */
interface RigaRiepilogo {
  id: string
  etichetta: string
  /** Le voci di una scelta multipla; quando c'è, `valore` non si usa. */
  elenco?: string[]
  valore: string
  /** Il campo è rimasto vuoto: si scrive «Non indicato», in grigio. */
  vuoto: boolean
  /** …ed era OBBLIGATORIO: allora è rosso, perché così non si può inviare. */
  mancante: boolean
}

/** Un blocco del riepilogo, con il passo a cui riporta il suo «Modifica». */
interface GruppoRiepilogo {
  passo: Passo
  titolo: string
  /** Falso quando quel passo non esiste (la sede decisa dal link). */
  modificabile: boolean
  righe: RigaRiepilogo[]
}

/**
 * Il valore di un campo COME SI LEGGE, oppure `null` se non è stato compilato.
 *
 * Il punto di questa funzione è che il riepilogo non mostri mai il valore
 * TECNICO: `titolo_studio` vale `laurea_triennale` in react-hook-form, e chi
 * rilegge deve trovarci «Laurea triennale», cioè la stessa stringa che ha
 * scelto. Mostrare il valore d'enum vorrebbe dire chiedere di controllare una
 * cosa che nessuno ha mai visto scritta così.
 *
 * Il ramo `file` non ha oggi nessun campo che lo raggiunga (`cv_path` sta in
 * `IDS_NON_RESI`): esiste perché il giorno in cui il curriculum torna, il
 * riepilogo ne dica almeno il nome invece di stampare il percorso del bucket.
 */
function testoDelValore(f: FormField, grezzo: unknown): string | null {
  if (f.type === 'select' || f.type === 'radio') {
    const scelta = (f.options ?? []).find((o) => o.value === grezzo)
    if (scelta) return String(scelta.label)
  }
  if (typeof grezzo === 'number') return Number.isFinite(grezzo) ? String(grezzo) : null
  if (typeof grezzo !== 'string') return null
  const testo = grezzo.trim()
  if (testo === '') return null
  // Un percorso di Storage (`candidature/<uuid>-<nome>`) non dice niente a chi
  // lo legge: del curriculum interessa il NOME del file, cioè l'ultimo segmento.
  if (f.type === 'file') return testo.split('/').pop() || testo
  return testo
}

export function CandidaturaInsegnanteWizard({
  sedeId = null,
  intestazione,
}: {
  /**
   * La sede arrivata dal link (`?sede=`). La stringa VUOTA vale come ASSENTE: è
   * falsy ma non `null`, e trattata come «sede già decisa» farebbe partire
   * l'invio senza sede dopo aver fatto scegliere il plesso.
   */
  sedeId?: string | null
  /** La riga di testa pubblica (ritorno + Alto Contrasto), montata dalla pagina. */
  intestazione?: ReactNode
} = {}) {
  const t = useTranslations('public')
  /**
   * L'unico prestito da un altro namespace, e ha una ragione: `devAccettare` è
   * LA frase che `FieldRenderer` mostra quando una spunta obbligatoria manca. Il
   * server, quando rifiuta per lo stesso motivo, manda gli id e non un testo —
   * riscriverne uno qui vorrebbe dire due formulazioni diverse per lo stesso
   * rifiuto, sulla stessa casella, a seconda di chi l'ha rilevato.
   */
  const tCampi = useTranslations('parentForms')

  /**
   * TUTTO CIÒ CHE QUESTO MODULO SA DELLE SEDI, e i comandi con cui lo cambia.
   * L'elenco, i tre stati, il link smentito, la forma dei passi e il rifiuto del
   * server stanno in `wizard/use-sedi-pubbliche.ts`: erano ricopiati da
   * `EnrollmentWizard`, e ogni copia ha aggiunto un difetto suo.
   */
  const {
    sedi, statoSedi, elencoPronto, riprova: riprovaSedi,
    sedeScelta, scegliSede, sedeSmentitaDalServer,
    sedeDaLink, sedeDecisa, nomeSedeDalLink, nomeSedeDecisa,
    mostraSede, formaDecisa, sediVuote, nonPuoCominciare, sedeSceglibile,
  } = useSediPubbliche({ sedeId, etichetta: ETICHETTA_LOG })

  const [erroreSede, setErroreSede] = useState(false)

  const [indice, setIndice] = useState(0)
  /**
   * ╔════════════════════════════════════════════════════════════════════════╗
   * ║  «MODIFICA» È UN VIAGGIO DI ANDATA **E RITORNO**                       ║
   * ╚════════════════════════════════════════════════════════════════════════╝
   *
   * Acceso quando si è entrati in un passo dal riepilogo (`vaiAlPasso`), spento
   * appena al riepilogo ci si è tornati. Finché è acceso, il comando primario
   * del passo non si chiama «Avanti» ma «Torna al riepilogo», e ci riporta in
   * un colpo solo.
   *
   * ── IL DIFETTO CHE CHIUDE, MISURATO ─────────────────────────────────────
   *
   * Fino all'11/08/2026 `vaiAlPasso()` cambiava l'indice e basta: dal riepilogo
   * si premeva «Modifica» accanto a «I tuoi dati», si correggeva il refuso
   * nell'email — il gesto per cui tutto il riepilogo è stato scritto — e sotto
   * al campo c'era «Avanti». Per rivedere ciò che si era voluto controllare
   * bisognava riattraversare «Il tuo profilo», riguardare le fasce d'età e
   * ripassare sopra le due caselle dei consensi: **tre pressioni** per un
   * carattere cambiato, e a 360×740 tre schermate da riscorrere.
   *
   * Il modello è quello che le pubbliche amministrazioni chiamano *check your
   * answers*: la correzione costa **un tocco per andare e uno per tornare**.
   *
   * ── ⚠️ LE DUE PARTI NON OVVIE ───────────────────────────────────────────
   *
   * **1. Tornare dritti al riepilogo SALTA dei passi, e saltarli non può voler
   * dire saltare la loro validazione.** Il segno resta acceso anche se nel
   * frattempo si è camminato (vedi `indietro()`), quindi il salto può partire da
   * «Sede» e scavalcare «I tuoi dati», «Il tuo profilo» e i consensi. Perciò
   * `prosegui()` valida **tutti** i passi scavalcati, non solo quello che si sta
   * lasciando: se uno è incompleto — si è cancellato un campo obbligatorio del
   * profilo, per dirne una — il riepilogo mostrerebbe un modulo che il server
   * rifiuterà, cioè esattamente la cosa che il riepilogo esiste per evitare.
   *
   * **2. Quando succede si RICADE NEL PERCORSO LINEARE, e lo si DICE.** Si
   * atterra sul primo passo incompleto, il segno si spegne (il comando torna
   * «Avanti») e `ritornoInterrotto` accende il riquadro che spiega perché il
   * riepilogo non è arrivato. Spegnerlo in silenzio sarebbe la peggiore delle
   * tre possibilità: un comando che ha appena promesso «torna al riepilogo» e ha
   * consegnato un altro passo, senza una riga che dica cos'è cambiato.
   * Il segno NON si riaccende da solo: ha appena mancato la promessa una volta,
   * e rifarla mentre il modulo è incompleto significherebbe chiedere di fidarsi
   * due volte della stessa frase. Il percorso lineare ri-mostra ogni passo
   * rimasto, quindi da lì in poi niente viene più scavalcato.
   */
  const [ritornoAlRiepilogo, setRitornoAlRiepilogo] = useState(false)
  /**
   * Il passo su cui il ritorno si è dovuto fermare, o `null`. È il titolo che
   * finisce nel riquadro: dire «manca un dato» senza dire dove è un avviso che
   * si impara a ignorare.
   */
  const [ritornoInterrotto, setRitornoInterrotto] = useState<Passo | null>(null)
  const [inviando, setInviando] = useState(false)
  const [inviata, setInviata] = useState(false)
  /**
   * L'errore d'invio: il motivo e la riga che dice che cosa fare adesso. Si
   * mostra IN PAGINA, mai in un `alert()`.
   *
   * Sono due campi e non uno perché la seconda riga NON è sempre «premi di nuovo
   * Invia»: quando il rifiuto riguarda la sede, ripremere darebbe la stessa
   * risposta all'infinito, e la frase deve mandare al passo che nel frattempo è
   * ricomparso.
   */
  const [erroreInvio, setErroreInvio] = useState<
    { tipo: 'generico' | 'sede'; corpo: string; nota: string } | null
  >(null)
  /**
   * IL GUARDIANO DEL DOPPIO TOCCO, e non può essere uno stato.
   *
   * `disabled={inviando}` si arma dentro `invia()`, cioè DOPO l'`await
   * trigger(...)` della validazione: fra il clic e il render che disabilita il
   * bottone c'è un confine asincrono, e tre tocchi rapidi facevano partire tre
   * POST (misurato: 3 su 3). Sui dati non succede niente — l'indice unico
   * `candidature_insegnanti_email_viva` fa servire il duplicato come 201 — ma il
   * tetto pubblico è di 3 richieste all'ora per IP: un doppio tocco brucia la
   * dotazione oraria del NAT di una scuola o del CGNAT di un operatore mobile,
   * cioè della stessa popolazione per cui questo file teme il 429. Un `ref` si
   * aggiorna nell'istante del clic, senza aspettare nessun render.
   */
  const avantiInCorso = useRef(false)
  /** L'`h2` della conferma: ci si porta il fuoco, che l'invio ha appena distrutto. */
  const confermaRef = useRef<HTMLHeadingElement>(null)
  /**
   * Il pannello d'errore d'invio — e sul RIFIUTO DELLA SEDE è un ancoraggio per
   * il fuoco, non un semplice riquadro. Vedi l'effetto più sotto.
   */
  const pannelloErroreRef = useRef<HTMLDivElement>(null)
  /**
   * Il PRIMO radio della sede: è lì che va il fuoco quando «Avanti» risponde
   * «Scegli una sede per proseguire». Vedi l'effetto più sotto.
   */
  const primoRadioRef = useRef<HTMLInputElement>(null)
  /** L'`h2` del passo corrente: è lì che si va quando il passo CAMBIA. */
  const titoloPassoRef = useRef<HTMLHeadingElement>(null)
  /**
   * L'indice del render precedente. Serve a distinguere «il passo è cambiato»
   * da «è cambiato qualcos'altro fra le dipendenze dell'effetto»: senza, il
   * fuoco si sposterebbe anche quando compare un errore, cioè proprio dove
   * qualcun altro l'ha già posato di proposito.
   */
  const indicePrecedente = useRef(indice)

  const {
    register, control, trigger, getValues, setValue, setFocus, setError,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched' })

  const passi: Passo[] = useMemo(
    () => (mostraSede ? ['sede', 'dati', 'profilo', 'consensi', 'riepilogo'] : ['dati', 'profilo', 'consensi', 'riepilogo']),
    [mostraSede],
  )
  const passo = passi[Math.min(indice, passi.length - 1)]
  const ultimo = indice === passi.length - 1

  // Il fuoco sulla conferma. Sta in un effetto e non nel gestore dell'invio
  // perché l'`h2` non esiste ancora quando `setInviata(true)` viene chiamato: si
  // monta al render successivo, ed è lì che lo si può mettere a fuoco.
  useEffect(() => {
    if (inviata) confermaRef.current?.focus()
  }, [inviata])

  /*
   * IL FUOCO DOPO IL RIFIUTO DELLA SEDE — la stessa cura della conferma, sul
   * percorso di FALLIMENTO, dove mancava.
   *
   * Chi preme «Invia candidatura» ha il fuoco su quel bottone. Il rifiuto
   * riporta a `indice = 0`, e nel passo «sede» quello STESSO bottone diventa
   * `disabled` finché l'elenco non torna (`passo === 'sede' && !sedeSceglibile`):
   * un browser vero toglie il fuoco a un elemento che si disabilita e lo lascia
   * cadere su `<body>`. Nella stessa finestra «Indietro» è disabilitato perché
   * `indice === 0`, quindi chi naviga da tastiera resta senza appiglio e deve
   * ripercorrere la pagina col Tab per ritrovare il punto in cui era.
   *
   * ⚠️ jsdom NON riproduce quel salto — misurato: dopo il rifiuto
   * `document.activeElement` resta il bottone «Avanti». Il presidio quindi non
   * può essere «il fuoco non è su `<body>`», che sarebbe verde anche senza
   * questo effetto: è che il fuoco stia sul pannello che spiega cos'è successo.
   *
   * Solo per `tipo === 'sede'`: sul pannello generico si resta sul riepilogo, il
   * bottone «Invia candidatura» NON si disabilita e il fuoco non lo perde
   * nessuno — spostarlo sarebbe portare via le mani a chi non le aveva mosse.
   */
  useEffect(() => {
    if (erroreInvio?.tipo === 'sede') pannelloErroreRef.current?.focus()
  }, [erroreInvio])

  /*
   * IL FUOCO DOPO «SCEGLI UNA SEDE», e la stessa cura che gli altri passi hanno
   * già (`setFocus(primo.id)` sul primo campo non valido).
   *
   * Il passo «sede» non ha campi di react-hook-form: i radio sono stato locale,
   * quindi `trigger`/`setFocus` non li vedono e nessuno li metteva a fuoco. Chi
   * premeva «Avanti» senza scegliere restava con il fuoco sul bottone, mentre
   * l'errore compariva a 259 px più in su — misurato a 360 px: errore a `top`
   * 437, «Avanti» a `top` 676. Da tastiera bisognava risalire la pagina col Tab
   * per trovare la cosa da fare; da telefono, scorrere all'indietro.
   *
   * Portare il fuoco sul primo radio fa due cose insieme: il browser lo porta in
   * vista da solo, e chi usa uno screen reader si ritrova dentro il gruppo di
   * scelta annunciato dalla sua `legend`, che è esattamente il punto in cui
   * l'errore chiede di agire.
   */
  useEffect(() => {
    if (erroreSede) primoRadioRef.current?.focus()
  }, [erroreSede])

  /*
   * IL PASSO NUOVO COMINCIA DAL SUO TITOLO — e fino all'11/08/2026 non lo faceva.
   *
   * `vaiAlPasso()` e i due `setIndice` di `avanti()`/`indietro()` cambiavano solo
   * un numero: il documento restava esattamente all'altezza di scorrimento
   * precedente, e il passo nuovo si apriva a metà. MISURATO a 360×740 sulla
   * pagina viva (banco di prova in un iframe da 360 px, elenco sedi finto perché
   * la chiave di `.env.local` non è quella del progetto):
   *
   *   · dal fondo del passo «I tuoi dati» (scrollY 501 su docH 1241) si preme
   *     «Avanti»: il passo «Il tuo profilo» si apre ancora a scrollY 501 su docH
   *     1429, con l'`h2` del passo a y 188 e il select «Titolo di studio»
   *     (obbligatorio) a y 279 — entrambi SOPRA il bordo superiore. Si vede la
   *     coda del passo, e sembra la coda di quello di prima;
   *   · il caso peggiore è il riepilogo, che esiste proprio per far correggere:
   *     scorso in fondo (scrollY 1230 su docH 1970) si preme «MODIFICA» accanto a
   *     «I tuoi dati» e il passo si apre a scrollY 501, con Nome (279), Cognome
   *     (381) ed Email (483) fuori dalla finestra. Si chiede di correggere
   *     l'anagrafica e si vede tutto tranne l'anagrafica.
   *
   * Da tastiera era peggio che da schermo: React riusa il `<button>` fra un passo
   * e l'altro, quindi il fuoco restava su un bottone che nel frattempo era
   * diventato «Avanti» — nessuno annunciava che la schermata era cambiata, e il
   * Tab successivo portava semplicemente avanti.
   *
   * Le due cose si riparano con un gesto solo: si torna in cima (la testata, il
   * contatore «Passo N di M» e il titolo tornano in vista) e si posa il fuoco
   * sull'`h2` del passo — `tabIndex={-1}`, come l'`h2` della conferma. Chi
   * ascolta sente «Il tuo profilo, intestazione livello 2» e, dalla descrizione
   * agganciata, «Passo 3 di 5»; chi guarda ricomincia dall'inizio del passo.
   *
   * `scrollTop` e non `window.scrollTo`: fa la stessa cosa nel browser ed è un
   * assegnamento di proprietà, quindi sotto jsdom (dove `scrollTo` è «not
   * implemented» e stampa un errore a ogni passo di ogni test) non dice niente.
   * Il `focus()` viene DOPO ed è senza `preventScroll`: se per un'altezza di
   * finestra insolita il titolo restasse comunque fuori, il browser lo porta in
   * vista da sé.
   *
   * ⚠️ NON SCATTA QUANDO IL FUOCO È GIÀ STATO ASSEGNATO DI PROPOSITO. Tre percorsi
   * cambiano l'indice E posano il fuoco altrove, e sono tre percorsi d'errore, cioè
   * quelli in cui portarlo via è più grave:
   *   · `invia()` senza sede → `setErroreSede(true)` + `setIndice(0)`, fuoco sul
   *     primo radio;
   *   · rifiuto `SEDE_DA_SPECIFICARE` → `setIndice(0)` + `setErroreInvio(…)`, fuoco
   *     sul pannello che spiega cos'è successo;
   *   · 400 con errori per campo → `mappaErroriServer` porta al passo del primo
   *     campo respinto, dove il messaggio sta sotto il campo.
   * `erroreSede`/`erroreInvio` sono aggiornati nello STESSO render dell'indice
   * (React raggruppa gli aggiornamenti), quindi qui si leggono già veri.
   */
  useEffect(() => {
    const cambiato = indicePrecedente.current !== indice
    indicePrecedente.current = indice
    if (!cambiato) return
    if (erroreSede || erroreInvio !== null) return
    const radice = document.scrollingElement ?? document.documentElement
    radice.scrollTop = 0
    titoloPassoRef.current?.focus()
  }, [indice, erroreSede, erroreInvio])

  /** I campi del modulo che vivono nel passo corrente (il riepilogo non ne ha). */
  function campiDelPasso(p: Passo): FormField[] {
    if (p === 'dati') return CAMPI_DATI
    if (p === 'profilo') return CAMPI_PROFILO
    if (p === 'consensi') return CONSENSI_INSEGNANTI_FIELDS
    return []
  }

  /** In quale passo si vede il campo `id`, oppure `null` se non è reso. */
  function passoDelCampo(id: string): Passo | null {
    if (CAMPI_DATI.some((f) => f.id === id)) return 'dati'
    if (CAMPI_PROFILO.some((f) => f.id === id)) return 'profilo'
    if (CONSENSI_INSEGNANTI_FIELDS.some((f) => f.id === id)) return 'consensi'
    return null
  }

  /**
   * Gli errori per campo del SERVER, riportati sotto i campi e sul passo giusto.
   *
   * `POST /api/iscrizione/insegnanti` risponde 400 con `{ campi: { id: msg } }`
   * in forma PIATTA (questo modulo non ha record ripetuti) e, per i consensi
   * obbligatori, con `{ consensi: [id, …] }`. Senza questa mappatura chi compila
   * legge una frase generica davanti a un passo che sembra a posto, e non ha
   * modo di sapere quale campo correggere: è la differenza fra un rifiuto
   * azionabile e un vicolo cieco.
   *
   * Ritorna `false` se non c'è stato niente da mostrare — e allora il chiamante
   * mostra il pannello generico, invece di lasciare la schermata muta.
   */
  function mappaErroriServer(corpo: unknown): boolean {
    const c = corpo as { campi?: unknown; consensi?: unknown } | null
    if (c === null || typeof c !== 'object') return false
    let primo = -1
    const segna = (id: string, messaggio: string): void => {
      const p = passoDelCampo(id)
      if (p === null) return
      setError(id, { type: 'server', message: messaggio })
      const dove = passi.indexOf(p)
      if (dove >= 0 && (primo === -1 || dove < primo)) primo = dove
    }

    if (c.campi !== null && typeof c.campi === 'object') {
      for (const [id, messaggio] of Object.entries(c.campi as Record<string, unknown>)) {
        if (typeof messaggio !== 'string' || messaggio === '') continue
        segna(id, messaggio)
      }
    }
    if (Array.isArray(c.consensi)) {
      for (const id of c.consensi) {
        if (typeof id !== 'string' || id === '') continue
        // Il server manda gli id dei consensi mancanti senza un testo: il testo
        // giusto ce l'ha già il client, ed è quello che comparirebbe se la
        // spunta mancasse qui — la stessa frase, non una seconda formulazione.
        segna(id, tCampi('devAccettare'))
      }
    }
    if (primo === -1) return false
    if (primo !== indice) setIndice(primo)
    return true
  }

  async function avanti(): Promise<void> {
    // IL GUARDIANO È QUI, PRIMA DI QUALUNQUE `await`. Dopo il primo `await` lo
    // stato di questo componente è ancora quello del render precedente per ogni
    // altro clic già in coda: `disabled={inviando}` non li ferma, questo sì. Vale
    // anche per «Avanti» semplice — due clic nella stessa finestra facevano due
    // `setIndice(i => i + 1)`, cioè un passo SCAVALCATO (il profilo, dove stanno
    // titolo di studio e fasce d'età) che si scopriva solo con un 400.
    if (avantiInCorso.current) return
    avantiInCorso.current = true
    try {
      await passoAvanti()
    } finally {
      avantiInCorso.current = false
    }
  }

  /**
   * Il messaggio che questo campo merita adesso, o `null` se sta bene — e si
   * calcola SENZA `trigger`, di proposito.
   *
   * ⚠️ `trigger(id)` di react-hook-form vale solo per i campi MONTATI: i passi
   * che il ritorno scavalca non sono a schermo, le loro regole sono smontate
   * insieme ai loro `<input>`, e `trigger` su quei nomi risponde `true` a
   * qualunque cosa. MISURATO: con l'unica fascia d'età tolta dal profilo, il
   * ritorno passava lo stesso e il riepilogo mostrava «Nessuna fascia
   * selezionata» accanto a un modulo dichiarato pronto per l'invio. `validateField`
   * è la stessa regola che il server rigira, e legge il valore da `getValues`:
   * non le serve nessun nodo nel documento.
   *
   * L'eccezione dei consensi è la stessa di `mappaErroriServer`: la frase giusta
   * per una spunta obbligatoria mancante ce l'ha `FieldRenderer` (`devAccettare`),
   * e «Campo obbligatorio» davanti a una casella da spuntare sarebbe una seconda
   * formulazione per lo stesso rifiuto.
   */
  function messaggioMancante(f: FormField): string | null {
    const valore = getValues(f.id)
    if (f.type === 'consent') return f.required && valore !== true ? tCampi('devAccettare') : null
    return validateField(f, valore)
  }

  /**
   * DOVE SI VA DOPO AVER SUPERATO IL PASSO CORRENTE — il passo seguente, oppure
   * il riepilogo in un colpo solo se ci si è arrivati da lì con «Modifica».
   *
   * Il salto NON è un `setIndice(ultimo)`: valida prima, uno per uno, tutti i
   * passi che scavalcherebbe. Il perché per esteso sta sulla dichiarazione di
   * `ritornoAlRiepilogo`; qui basti che al riepilogo non può arrivare un modulo
   * che nessuno ha controllato.
   */
  async function prosegui(): Promise<void> {
    if (!ritornoAlRiepilogo) {
      setIndice((i) => i + 1)
      return
    }
    // I passi fra questo e il riepilogo: `passi.length - 1` è il riepilogo, che
    // non ha campi da validare.
    for (const p of passi.slice(indice + 1, passi.length - 1)) {
      const guasti = campiDelPasso(p)
        .map((f) => ({ id: f.id, messaggio: messaggioMancante(f) }))
        .filter((x): x is { id: string; messaggio: string } => x.messaggio !== null)
      if (guasti.length === 0) continue
      // Si ricade nel percorso lineare, E LO SI DICE — il riquadro nomina il
      // passo (`ritornoInterrotto`) e i campi portano il loro messaggio, che qui
      // si scrive a mano perché `trigger` non li vedrebbe (vedi `messaggioMancante`).
      // Il fuoco lo posa l'effetto del cambio di passo, sull'`h2`: un `setFocus`
      // qui parlerebbe a campi non ancora renderizzati.
      for (const g of guasti) setError(g.id, { type: 'validate', message: g.messaggio })
      setRitornoAlRiepilogo(false)
      setRitornoInterrotto(p)
      setIndice(passi.indexOf(p))
      return
    }
    setRitornoAlRiepilogo(false)
    setIndice(passi.length - 1)
  }

  async function passoAvanti(): Promise<void> {
    // Il riquadro del ritorno interrotto descrive l'esito dell'ULTIMA pressione:
    // alla successiva si spegne, comunque vada, e se il caso si ripete lo
    // riaccende il ramo che l'ha acceso.
    setRitornoInterrotto(null)
    if (passo === 'sede') {
      if (!sedeScelta) {
        setErroreSede(true)
        return
      }
      setErroreSede(false)
      // ⚠️ USCIRE DAL PASSO «SEDE» SPEGNE L'ERRORE D'INVIO, esattamente come
      // `indietro()`. Il pannello del rifiuto vive nel ramo dei passi, cioè in
      // TUTTI: senza questa riga sopravviveva nei passi successivi, dove il
      // selettore della sede non c'è, e continuava a ordinare «scegli la sede
      // qui sopra» davanti a zero radio — l'ordine ineseguibile che tutto questo
      // ramo esiste per chiudere.
      //
      // Con due o più plessi non si vedeva: per passare bisogna toccare un
      // radio, e l'`onChange` del radio lo spegne già. MISURATO sul percorso a
      // UNA sola sede, dove il radio è auto-spuntato (`if (lista.length === 1)
      // setSedeScelta(...)`) e si preme «Avanti» senza toccarlo: nota ancora in
      // pagina al passo «I tuoi dati», selettore della sede no.
      setErroreInvio(null)
      await prosegui()
      return
    }

    const campi = campiDelPasso(passo)
    // Province: «Napoli» → «NA» PRIMA di validare, così passa anche senza blur;
    // l'irriconoscibile resta com'è e la validazione lo blocca nominandolo.
    for (const f of campi) {
      if (!isProvinceField(f)) continue
      const grezzo = getValues(f.id)
      if (grezzo === null || grezzo === undefined || String(grezzo).trim() === '') continue
      const sigla = normalizzaProvincia(grezzo)
      if (sigla && sigla !== grezzo) setValue(f.id, sigla, { shouldValidate: false })
    }

    const valido = await trigger(campi.map((f) => f.id))
    if (!valido) {
      // Il fuoco va sul PRIMO campo non valido: senza, chi usa la tastiera o uno
      // screen reader resta in fondo alla pagina con un errore che non vede.
      const primo = campi.find((f) => validateField(f, getValues(f.id)))
      if (primo) setFocus(primo.id)
      return
    }

    if (ultimo) {
      await invia()
      return
    }
    await prosegui()
  }

  function indietro(): void {
    // Tornare indietro per correggere spegne l'errore d'invio: tenerlo acceso lo
    // trasformerebbe in un avviso che si impara a ignorare. Idem il riquadro del
    // ritorno interrotto, che descrive una pressione di «Torna al riepilogo».
    setErroreInvio(null)
    setRitornoInterrotto(null)
    /*
     * ⚠️ «INDIETRO» RESTA IL PASSO PRECEDENTE, ANCHE QUANDO SI È ARRIVATI QUI
     * DAL RIEPILOGO — e il segno del ritorno NON si spegne. Deciso così, con la
     * ragione, perché è la seconda domanda non ovvia di tutto questo lavoro.
     *
     * L'alternativa era farlo puntare al riepilogo, cioè «al posto da cui vengo».
     * Scartata per tre motivi:
     *   · sarebbe l'unico comando della pagina il cui BERSAGLIO dipende da uno
     *     stato che non si vede: la stessa etichetta, nello stesso posto,
     *     porterebbe in due luoghi diversi a seconda di come ci si è arrivati;
     *   · duplicherebbe «Torna al riepilogo», che è lì accanto — ma SENZA la sua
     *     validazione: sarebbe la porta di servizio che riporta al riepilogo un
     *     modulo incompleto, cioè il buco che `prosegui()` esiste per chiudere;
     *   · toglierebbe l'unico modo di guardare il passo ACCANTO a quello che si
     *     sta correggendo senza riattraversare tutto — che è precisamente il
     *     costo che questo lavoro elimina.
     * Il segno resta acceso proprio perché il viaggio non è finito: da dovunque
     * si arrivi, il comando primario continua a essere il biglietto di ritorno, e
     * `prosegui()` valida tutto ciò che quel ritorno scavalcherebbe.
     */
    setIndice((i) => Math.max(0, i - 1))
  }

  async function invia(): Promise<void> {
    // Ultima difesa lato client: la rotta pretende `scuola_id`, e senza sede non
    // si invia alla cieca — si torna a farla scegliere. Una candidatura
    // archiviata nel plesso sbagliato è peggio di un passo in più.
    const sede = sedeDecisa
    if (!sede) {
      setErroreSede(true)
      setIndice(0)
      return
    }

    setInviando(true)
    setErroreInvio(null)
    try {
      const valori = getValues()
      const dati: Record<string, unknown> = {}
      for (const f of CAMPI_RESI) dati[f.id] = valori[f.id]
      // I CONSENSI VANNO NEL PAYLOAD, e questa riga è la ragione per cui il
      // collaudo dei consensi esiste: sul wizard fratello ogni pezzo funzionava
      // — la casella, la validazione, la prova archiviata — e il collegamento
      // fra penultimo e ultimo passo no. Le spunte venivano raccolte e buttate
      // via prima dell'invio, e il server rifiutava (giustamente) una
      // candidatura senza presa visione.
      //
      // Anche i consensi NON spuntati viaggiano, come `false`: «non gliel'ho
      // chiesto» e «ha detto no» non sono la stessa cosa dentro `consents_log`.
      for (const f of CONSENSI_INSEGNANTI_FIELDS) dati[f.id] = valori[f.id] === true
      // I gradi sono già un array (il `type: 'checkbox'` del template lo è per
      // costruzione): si passa così com'è, senza validazione nuova.

      const res = await fetch(ROTTA_INVIO, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scuola_id: sede,
          data: dati,
          [CAMPO_ESCA]: typeof valori[CAMPO_ESCA] === 'string' ? valori[CAMPO_ESCA] : '',
        }),
      })
      const corpo = await corpoDellaRisposta(res, ETICHETTA_LOG)

      if (!res.ok) {
        // ⚠️ IL RIFIUTO SULLA SEDE VIENE PRIMA DI TUTTI GLI ALTRI, e non ricade
        // nel pannello generico: la frase del catalogo («Specificare la sede a
        // cui si riferisce questa operazione») è scritta per il cockpit, ordina
        // un'azione, e su questo modulo l'azione dev'essere possibile. Qui si
        // rimette il passo «sede» davanti e ci si porta chi compila.
        if (res.status === 400 && (corpo as { codice?: unknown } | null)?.codice === 'SEDE_DA_SPECIFICARE') {
          // L'hook abbandona il link, dimentica la scelta e richiede l'elenco; il
          // ritorno al primo passo — dove il passo «sede» sta ricomparendo — è
          // l'unica parte che sa di numeri, e resta qui.
          sedeSmentitaDalServer(sede)
          setIndice(0)
          // ⚠️ LA FRASE DIPENDE DA DOVE VENIVA LA SEDE, e le strade sono due.
          // Col link targato la causa probabile è un collegamento vecchio, e
          // dirlo aiuta. Senza link la sede l'ha scelta chi compila, da un
          // elenco che il server aveva appena servito: accusare «il collegamento
          // con cui hai aperto il modulo» significa dare la colpa a una cosa che
          // non è mai esistita — il link diffuso è UNO solo per tutte e tre le
          // sedi (vedi `src/app/lavora-con-noi/page.tsx`), quindi chi legge non
          // ha nessun collegamento «vecchio» da sostituire.
          //
          // Non è un caso di scuola nemmeno senza link: `GET /api/iscrizione/sedi`
          // e la `POST` applicano lo STESSO `sediReali`, ma non nello stesso
          // istante — un plesso disattivato fra l'elenco e l'invio (o la corsa
          // fra le due chiamate) produce esattamente questo 400.
          // Lo stesso file scrive, per le due cause d'elenco, che «distinguerle
          // non è cosmesi»: vale qui identico.
          setErroreInvio({
            tipo: 'sede',
            corpo: sedeDaLink !== null ? t('candSedeRifiutataCorpo') : t('candSedeRifiutataCorpoScelta'),
            nota: t('candSedeRifiutataNota'),
          })
          // `warn` e non `error`: il server ha risposto correttamente a un dato
          // sbagliato: è un link vecchio, non un guasto. L'uuid NON si logga —
          // `redact` è a lista bianca e lo lascerebbe passare come uuid, ma qui
          // non serve a niente che non dica già lo status.
          logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'candidatura-sede-rifiutata',
            stato: res.status,
          })
          return
        }
        // 400 con gli errori per campo: si riporta chi compila sul campo
        // sbagliato, invece di lasciarlo davanti a una frase generica.
        if (res.status === 400 && mappaErroriServer(corpo)) return
        // ⚠️ IL TESTO NON È LA PROSA DEL SERVER. `soloCatalogoDaCorpo` traduce il
        // CODICE dichiarato (`CANDIDATURE_NON_DISPONIBILI` sul 503,
        // `TROPPE_RICHIESTE` sul 429, …) e altrimenti ripiega sulla frase di
        // questa schermata, che è già tradotta. La prosa che il server manda
        // nasce dove il locale non esiste ed è italiana per costruzione: è il
        // difetto T10-F1, e su questa pagina la leggerebbe chi cerca lavoro.
        setErroreInvio({
          tipo: 'generico',
          corpo: soloCatalogoDaCorpo(corpo, t('candErroreInvioCorpo')),
          nota: t('candErroreInvioDatiSalvi'),
        })
        // ⚠️ E NEL LOG VA UN'ETICHETTA STABILE, non la frase del server: `stack`
        // comincia con il messaggio, e da lì la prosa — che su un 400 nomina i
        // campi respinti — finirebbe archiviata. Lo status è un numero e basta a
        // capire quale ramo è stato preso.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: 'candidatura-invio-fallito',
          stato: res.status,
        })
        return
      }

      // 201 — e si arriva qui ANCHE quando quell'indirizzo ha già una
      // candidatura viva: la rotta risponde 201 di proposito, perché un 409 su
      // un modulo anonimo direbbe a chiunque digiti l'email di una maestra che
      // quella persona si è candidata (migrazione `20260810094610`, righe 60-71).
      // Il corpo può quindi portare `{"id": null}`: NON si legge l'id, e nessun
      // ramo di questa schermata deve dipendere dalla sua presenza.
      setInviata(true)
    } catch (err) {
      // La rete è caduta: il server non ha risposto affatto. `withRoute` è lato
      // server e non vede niente di tutto questo — se non si logga qui, non si
      // logga da nessuna parte.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `candidatura-invio-fallito: ${nomeErrore(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
      })
      // NIENTE `alert()`: il pannello di sistema non dice cosa fare, non lascia
      // traccia in pagina, non si ingrandisce, e nella WebView nativa è peggio.
      // Il messaggio sta accanto al bottone appena premuto e dice l'unica cosa
      // che conta a chi ha compilato quattro passi: i dati sono ancora qui.
      setErroreInvio({
        tipo: 'generico',
        corpo: t('candErroreInvioCorpo'),
        nota: t('candErroreInvioDatiSalvi'),
      })
    } finally {
      setInviando(false)
    }
  }

  /**
   * La sede, per il riepilogo — e NON è mai un trattino quando l'invio è
   * possibile.
   *
   * Fino al 2026-08-11 con un link targato l'elenco non veniva chiesto, il nome
   * del plesso non era noto e la schermata di riepilogo mostrava «Sede scelta —»:
   * l'unico fatto della pagina era un trattino. Adesso l'elenco si chiede sempre,
   * quindi il nome c'è ogni volta che il plesso è uno di quelli che ricevono
   * candidature.
   *
   * Resta un solo caso in cui il nome non si può sapere: l'elenco NON è arrivato
   * (429, rete giù) e il modulo va avanti col link, che è la scelta giusta. Lì non
   * si scrive un uuid — non dice niente a chi lo legge — e nemmeno un trattino: si
   * dice da dove viene la sede, che è l'unica cosa vera che si sa.
   */
  function testoSede(): string {
    if (nomeSedeDecisa !== null) return nomeSedeDecisa
    return sedeDaLink !== null ? t('candRiepilogoSedeDalLink') : '—'
  }

  /**
   * Una riga di riepilogo per un campo del template.
   *
   * Le etichette sono quelle del template — le stesse che si sono lette
   * compilando — con UNA eccezione dichiarata: `gradi`, che nel riepilogo si
   * chiama «Fasce per cui ti proponi» (`candRiepilogoFasce`) invece che «Per
   * quali fasce ti proponi». È l'unica etichetta del modulo scritta come una
   * DOMANDA, e una domanda in un elenco di fatti si legge male; la chiave esiste
   * già, è tradotta in entrambe le lingue, e il vuoto ha la sua frase dedicata
   * («Nessuna fascia selezionata»), che dice molto più di «Non indicato» su un
   * campo obbligatorio.
   */
  function rigaDelCampo(f: FormField): RigaRiepilogo {
    const grezzo = getValues(f.id)
    const etichetta = f.id === 'gradi' ? t('candRiepilogoFasce') : String(f.label)
    const obbligatorio = f.required === true

    if (f.type === 'checkbox') {
      const scelti: unknown[] = Array.isArray(grezzo) ? grezzo : []
      const elenco = (f.options ?? [])
        .filter((o) => scelti.includes(o.value))
        .map((o) => String(o.label))
      if (elenco.length > 0) {
        return { id: f.id, etichetta, elenco, valore: '', vuoto: false, mancante: false }
      }
      return {
        id: f.id,
        etichetta,
        valore: f.id === 'gradi' ? t('candRiepilogoNessunaFascia') : t('candRiepilogoNonIndicato'),
        vuoto: true,
        mancante: obbligatorio,
      }
    }

    // I consensi non conoscono il «non indicato»: la casella è stata vista, e la
    // risposta è sì oppure no. È la stessa distinzione per cui il `false` viaggia
    // nel payload invece di essere omesso.
    if (f.type === 'consent') {
      const dato = grezzo === true
      return {
        id: f.id,
        etichetta,
        valore: dato ? t('candRiepilogoSi') : t('candRiepilogoNo'),
        vuoto: false,
        mancante: obbligatorio && !dato,
      }
    }

    const testo = testoDelValore(f, grezzo)
    if (testo === null) {
      return {
        id: f.id,
        etichetta,
        valore: t('candRiepilogoNonIndicato'),
        vuoto: true,
        mancante: obbligatorio,
      }
    }
    return { id: f.id, etichetta, valore: testo, vuoto: false, mancante: false }
  }

  /**
   * Il riepilogo per intero, raggruppato come i passi che l'hanno prodotto.
   *
   * L'ordine e il contenuto vengono dalle stesse liste che disegnano i passi:
   * non c'è nessun elenco di campi scritto a mano, quindi non c'è nessun elenco
   * che possa restare indietro rispetto al template.
   */
  function gruppiRiepilogo(): GruppoRiepilogo[] {
    return [
      {
        passo: 'sede',
        titolo: t('candSede'),
        // Con la sede decisa dal link il passo non esiste: un «Modifica» che non
        // porta da nessuna parte è peggio di nessun comando.
        modificabile: mostraSede,
        righe: [
          {
            id: 'scuola_id',
            etichetta: t('candRiepilogoSede'),
            valore: testoSede(),
            vuoto: false,
            mancante: false,
          },
        ],
      },
      { passo: 'dati', titolo: t('candDati'), modificabile: true, righe: CAMPI_DATI.map(rigaDelCampo) },
      { passo: 'profilo', titolo: t('candProfilo'), modificabile: true, righe: CAMPI_PROFILO.map(rigaDelCampo) },
      {
        passo: 'consensi',
        titolo: t('candConsensiTitolo'),
        modificabile: true,
        righe: CONSENSI_INSEGNANTI_FIELDS.map(rigaDelCampo),
      },
    ]
  }

  /**
   * «Modifica» dal riepilogo: si torna al passo indicato — e si ACCENDE il segno
   * del ritorno, che è ciò che rende il viaggio di andata e ritorno.
   *
   * È l'unico posto che accende `ritornoAlRiepilogo`, ed è giusto che lo sia: il
   * segno significa «da qui si è entrati dal riepilogo», e dal riepilogo si entra
   * solo di qui.
   *
   * Spegne l'errore d'invio esattamente come `indietro()`, e per la stessa
   * ragione: tornare a correggere È la risposta all'avviso: tenerlo acceso lo
   * trasformerebbe in un avviso che si impara a ignorare.
   */
  function vaiAlPasso(p: Passo): void {
    const dove = passi.indexOf(p)
    if (dove < 0) return
    setErroreInvio(null)
    setRitornoInterrotto(null)
    setRitornoAlRiepilogo(true)
    setIndice(dove)
  }

  const testata: Record<Passo, { icona: typeof MapPin; titolo: string; sotto: string }> = {
    sede: { icona: MapPin, titolo: t('candSede'), sotto: t('candSedeSub') },
    dati: { icona: UserRound, titolo: t('candDati'), sotto: t('candDatiSub') },
    profilo: { icona: GraduationCap, titolo: t('candProfilo'), sotto: t('candProfiloSub') },
    consensi: { icona: ShieldCheck, titolo: t('candConsensiTitolo'), sotto: t('candConsensiSottotitolo') },
    riepilogo: { icona: Check, titolo: t('candRiepilogo'), sotto: t('candRiepilogoSub') },
  }

  /**
   * Che cosa sta per succedere premendo il comando primario — e quindi come si
   * chiama e che icona porta (`ComandiWizard`).
   *
   * L'ordine dei rami NON è indifferente: `inCorso` viene per primo perché
   * l'ultimo passo è anche quello da cui si invia, e la rotellina deve vincere
   * sulla spunta; `riepilogo` viene dopo `invio` perché dal riepilogo non si
   * torna al riepilogo.
   */
  const versoDelComando: ComandoAvanti['verso'] = inviando
    ? 'inCorso'
    : ultimo
      ? 'invio'
      : ritornoAlRiepilogo
        ? 'riepilogo'
        : 'avanti'
  /**
   * L'etichetta segue il VERSO, e non una seconda catena di ternari sulle stesse
   * variabili. Due catene identiche scritte a dieci righe di distanza sono il
   * modo in cui un comando finisce per dire «Avanti» mostrando la lista spuntata
   * del riepilogo: la condizione si corregge in una sola delle due.
   */
  const etichettaDelComando: Record<ComandoAvanti['verso'], string> = {
    inCorso: t('candInvioInCorso'),
    invio: t('candInvia'),
    riepilogo: t('candTornaAlRiepilogo'),
    avanti: t('candAvanti'),
  }

  /**
   * La seconda riga del pannello d'errore, e si decide al RENDER, non al rifiuto.
   *
   * `candSedeRifiutataNota` dice «scegli la sede qui sopra e prosegui»: è vera
   * quando l'elenco è arrivato, ed è un ordine ineseguibile finché non lo è —
   * cioè proprio nell'istante in cui il rifiuto viene mostrato, visto che il
   * ri-caricamento parte insieme al pannello. La variante d'attesa dice le due
   * cose che valgono comunque: la candidatura NON è partita, e i dati sono
   * ancora qui.
   */
  const notaErrore =
    erroreInvio === null
      ? ''
      : erroreInvio.tipo === 'sede' && !sedeSceglibile
        ? t('candSedeRifiutataNotaAttesa')
        : erroreInvio.nota

  return (
    <GuscioPubblico>
      <BarraAvanzamento indice={indice} totale={passi.length} />

      <ColonnaCentrale>
        {/* La riga di testa pubblica (ritorno + Alto Contrasto) arriva dalla
            pagina: è un componente server, e il suo posto è sopra il titolo. */}
        {intestazione}

        {/*
          L'`<h1>` della pagina, e ce n'è UNO SOLO.
          Su `/iscrizione` questa intestazione non esisteva affatto fino al
          2026-08-01: chi naviga per intestazioni con uno screen reader non
          trovava né il nome della pagina né il punto da cui ricominciare dopo un
          errore. L'icona è decorativa e viene tolta dall'albero di
          accessibilità, così il nome dell'`h1` resta esattamente il titolo.
        */}
        <div className="mb-6 mt-4">
          {/* L'`h1` CRESCE CON LO SCHERMO. Restava 24 px anche a 1440, cioè a
              4 px dall'`h2` del passo: due intestazioni quasi identiche non si
              leggono come due livelli, e la scala 24/20 = 1,2 è troppo corta
              per farlo da sola. Qui la scala arriva a 36/18 = 2 sul desktop. */}
          <h1 className="flex items-center gap-2 font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green sm:text-3xl lg:text-4xl">
            <GraduationCap className="h-6 w-6 shrink-0 sm:h-8 sm:w-8" aria-hidden="true" />
            {t('candTitolo')}
          </h1>
          <p className="mt-1 text-sm text-kidville-sub">{t('candSottotitolo')}</p>
          {/* LA SEDE DEL COLLEGAMENTO SI NOMINA SUBITO, non al riepilogo: chi
              apre il link targato non ha scelto niente e non ha modo di sapere a
              quale plesso si sta proponendo. Sta sotto il titolo perché è una
              qualifica della pagina, non un passo; sparisce a candidatura
              inviata, dove il pannello di conferma parla d'altro. */}
          {!inviata && nomeSedeDalLink !== null && (
            <p className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-kidville-green">
              <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t('candSedeDalLinkTitolo', { sede: nomeSedeDalLink })}
            </p>
          )}
          {!inviata && formaDecisa && (
            <ContatorePassi id={ID_PASSO_CONTATORE} indice={indice} totale={passi.length} />
          )}
        </div>

        {nonPuoCominciare ? (
          /*
           * NON C'È NESSUNA SEDE A CUI CANDIDARSI — e lo si dice.
           *
           * Due cause, due frasi, un solo pannello: l'elenco NON è arrivato
           * (guasto → si riprova) oppure è arrivato ed è VUOTO (niente da
           * ricaricare → si scrive alla segreteria). Distinguerle non è cosmesi:
           * dire «non riusciamo a caricare le sedi» quando l'elenco è arrivato
           * manda a controllare una connessione che non ha nessun problema.
           */
          <div role="alert" className="flex flex-col items-center gap-4 py-10">
            <div className="w-full rounded-card border border-kidville-error bg-kidville-error-soft px-5 py-4 text-left">
              <h2 className="flex items-center gap-2 text-base font-semibold text-kidville-error-strong">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {sediVuote ? t('candSediVuoteTitolo') : t('candSediErroreTitolo')}
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-kidville-ink">
                {sediVuote ? t('candSediVuoteCorpo') : t('candSediErroreCorpo')}
              </p>
            </div>
            {/* «Riprova» SOLO per il guasto.
                L'inchiostro è `yellow-ink` e non `yellow` perché è la scrittura
                giusta alla sorgente: il giallo di marchio su verde di marchio
                vale 4,05:1 — sotto AA per un testo di questa misura — mentre
                `yellow-ink` su verde vale 4,78:1 (le due misure stanno in
                `__tests__/a11y/contrasto-cascata.test.tsx` §2).
                ⚠️ Ciò che quel lock NON fa è sorvegliare QUESTO file, e non deve
                farlo: sostituendo qui `-ink` con `yellow` la suite resta verde, e
                sarebbe sbagliato pretendere il contrario. MISURATO l'11/08/2026
                con la sonda di quel file sul markup di questo bottone: scritto
                `-ink` il colore calcolato è `#FFDA5C` su `#006A5F` (4,78:1),
                scritto `yellow` è… `#FFDA5C` su `#006A5F` (4,78:1) — identico;
                togliendo dalla cascata la sola regola `.bg-kidville-green
                .text-kidville-yellow` scende a `#FDC400` (4,05:1). La coppia
                `bg-kidville-green text-kidville-yellow` è il linguaggio del
                marchio, sta su 80 elementi in 46 file, e `globals.css:571` la
                RIPARA per tutti («rete di sicurezza sulla COPPIA, non sul file»):
                qualunque elemento la porti riceve comunque `yellow-ink`. Un lock
                che vietasse la coppia in `src/` renderebbe rossi 46 file di altre
                corsie per un difetto che il CSS chiude — la rete è verificata da
                §5 dello stesso file, col suo controllo positivo che senza la
                regola torna a misurare 4,05:1. Qui si scrive l'inchiostro giusto
                perché è quello che si intende, non perché senza si romperebbe. */}
            {!sediVuote && (
              <button
                type="button"
                onClick={riprovaSedi}
                className="flex items-center gap-2 rounded-pill bg-kidville-green px-6 py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-yellow-ink transition-all hover:bg-kidville-green-dark"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {t('candSediRiprova')}
              </button>
            )}
          </div>
        ) : !formaDecisa ? (
          // Attesa dell'elenco: NESSUN passo viene dipinto finché non si sa se il
          // passo sede esiste. È annunciato, perché un'attesa muta è
          // indistinguibile da una pagina rotta per chi non vede la rotellina.
          <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
            <Loader2 className="h-6 w-6 animate-spin text-kidville-green" aria-hidden="true" />
            <span className="sr-only">{t('candCaricamento')}</span>
          </div>
        ) : inviata ? (
          /* Questo ramo SOSTITUISCE l'intero blocco dei passi, e con esso il
             bottone appena premuto: il perché il pannello si annunci e si prenda
             il fuoco sta su `PannelloConferma`. Qui basti che `candInviataCorpo`
             è anche il TETTO di ciò che la colonna di contesto può promettere. */
          <PannelloConferma
            titolo={t('candInviata')}
            corpo={t('candInviataCorpo')}
            riferimento={confermaRef}
          />
        ) : (
          <GrigliaPasso
            contenuto={
              <>
                <TestataPasso
                  icona={testata[passo].icona}
                  titolo={testata[passo].titolo}
                  sotto={testata[passo].sotto}
                  titoloRef={titoloPassoRef}
                  contatoreId={ID_PASSO_CONTATORE}
                />

                {/*
                  IL RITORNO AL RIEPILOGO SI È DOVUTO FERMARE QUI, E LO DICE.
                  Sta subito sotto il titolo del passo — cioè dove l'effetto del
                  cambio di passo ha appena posato il fuoco e lo scorrimento —
                  perché è la spiegazione di una schermata che non è quella
                  promessa: chi ha premuto «Torna al riepilogo» si aspetta il
                  riepilogo, e riceve un passo. `role="alert"` e non `status`: non è
                  un aggiornamento di cortesia, è la ragione per cui il comando non
                  ha fatto ciò che c'era scritto sopra.
                  Il colore è la famiglia dell'AVVISO (`warn`), non quella
                  dell'errore: non è un guasto, è un passaggio in più — il dato che
                  manca ha già il suo messaggio rosso sotto il campo che lo chiede,
                  e due rossi sulla stessa schermata direbbero che i problemi sono
                  due. `warn-strong` su `warn-soft` è 4,95:1, misurato in
                  `globals.css` accanto al token.
                */}
                {ritornoInterrotto !== null && (
                  <div
                    role="alert"
                    /* `mb-5` come la testata del passo qui sopra: il riquadro si
                       infila fra due blocchi che quel margine se lo davano da soli,
                       e senza resterebbe incollato al primo campo. */
                    className="mb-5 rounded-card border border-kidville-warn bg-kidville-warn-soft px-4 py-3"
                  >
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-kidville-warn-strong">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {t('candRitornoInterrottoTitolo')}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-kidville-ink">
                      {t('candRitornoInterrottoCorpo', { passo: testata[ritornoInterrotto].titolo })}
                    </p>
                  </div>
                )}

                {/*
                  IL PASSO «SEDE» PORTA ANCHE LE NOTIZIE SULL'ELENCO.
                  Ci si arriva in due modi: dall'apertura, e allora l'elenco è per
                  forza già pronto con almeno due plessi; oppure dopo un rifiuto
                  del server sulla sede, e allora l'elenco si sta ricaricando
                  proprio adesso. Nel secondo caso attesa, guasto ed elenco vuoto
                  si dicono QUI DENTRO — sopra ci sono il titolo del passo e, più
                  sotto, il pannello che spiega che l'invio è fallito e che i dati
                  sono salvi. Prima queste tre notizie sostituivano l'intera
                  pagina, e portavano via il modulo compilato insieme alla
                  spiegazione.
                */}
                {passo === 'sede' && statoSedi === 'caricamento' && (
                  <div
                    className="flex items-center justify-center gap-2 py-8"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2 className="h-5 w-5 animate-spin text-kidville-green" aria-hidden="true" />
                    <span className="text-sm text-kidville-sub">{t('candCaricamento')}</span>
                  </div>
                )}

                {passo === 'sede' && statoSedi === 'errore' && (
                  <div className="space-y-3">
                    <div
                      role="alert"
                      className="rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3"
                    >
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {t('candSediErroreTitolo')}
                      </h3>
                      <p className="mt-1 text-xs leading-relaxed text-kidville-ink">
                        {t('candSediErroreCorpo')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={riprovaSedi}
                      className="flex items-center gap-2 rounded-pill bg-kidville-green px-5 py-2 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-yellow-ink transition-all hover:bg-kidville-green-dark"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                      {t('candSediRiprova')}
                    </button>
                  </div>
                )}

                {/* Elenco arrivato e VUOTO a modulo già compilato: nessun plesso
                    riceve candidature. Niente «Riprova» — ricaricare darebbe la
                    stessa risposta — e niente schermata che cancella il lavoro
                    fatto: la notizia sta accanto ad esso. */}
                {passo === 'sede' && elencoPronto && sedi.length === 0 && (
                  <div
                    role="alert"
                    className="rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3"
                  >
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {t('candSediVuoteTitolo')}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-kidville-ink">
                      {t('candSediVuoteCorpo')}
                    </p>
                  </div>
                )}

                {passo === 'sede' && sedeSceglibile && (
                  <fieldset
                    className="space-y-3"
                    /* Il messaggio del gruppo è legato al gruppo, come lo lega
                       `FieldRenderer` ai suoi (`role="radiogroup"` +
                       `aria-describedby`): chi ascolta sente la frase quando entra
                       nel gruppo, non solo quando l'`alert` viene annunciato. */
                    aria-describedby={erroreSede ? ID_ERRORE_SEDE : undefined}
                  >
                    <legend className="sr-only">{t('candSedeLegenda')}</legend>
                    {sedi.map((s, i) => {
                      const scelta = sedeScelta === s.id
                      return (
                        <label
                          key={s.id}
                          htmlFor={`sede-${s.id}`}
                          /*
                            LA CARD DI SCELTA HA UNA GRAFICA SOLA IN TUTTO IL
                            MODULO, e questa è la copia FEDELE — token per token —
                            di `SCELTA_LIBERA`/`SCELTA_PRESA` di `FieldRenderer`
                            (le card delle fasce d'età e dei consensi):
                              · presa   → `border-kidville-green bg-kidville-green-soft`
                              · libera  → `border-kidville-neutral bg-kidville-white`
                              · testo   → `text-kidville-green`, `font-semibold` da scelta
                            Il contorno a riposo era `border-kidville-line`, e non
                            era «un grigio più tenue»: MISURATO l'11/08/2026 sulla
                            pagina viva, `rgb(239,231,220)` = 1,10:1 sul crema e
                            1,09:1 sul bianco della card — un contorno che non
                            esiste. Le stesse tre card, un passo più avanti, ne
                            avevano uno da 2,79:1 (`neutral`, `rgb(138,149,143)`):
                            la stessa domanda posta in due grafiche, e la peggiore
                            delle due proprio al primo passo.
                            Il rimando NON è un `import` da `FieldRenderer`: quel
                            file è condiviso con la modulistica in-app e non è il
                            perimetro di questo intervento. A tenere insieme le due
                            famiglie c'è un lock che RENDE ENTRAMBE e confronta le
                            classi calcolate — `__tests__/components/
                            candidatura-card-di-scelta-unico-linguaggio.test.tsx` —
                            che è ciò che si romperebbe se una delle due cambiasse
                            da sola.

                            ── L'ANELLO DI FUOCO, INVECE, RESTA DIVERSO. E DI PROPOSITO.
                            Qui non c'è `focus-within:ring-2 ring-offset-2`, che
                            `SCELTA_STRUTTURA` porta: `globals.css` dichiara
                            `:focus-visible { outline: 2px solid #006A5F }` FUORI da
                            ogni `@layer` (blocco con scritto «non spostare», più il
                            lock che lo sorveglia), quindi il radio riceve comunque
                            il suo contorno. MISURATO l'11/08/2026 arrivando col TAB
                            su una card delle fasce: `outline: 2px solid rgb(0,106,95)`
                            sull'input 16×16 **e insieme** `box-shadow … rgb(0,106,95)
                            0 0 0 4px` sulla label 688×50 — due anelli concentrici,
                            cioè esattamente il difetto «doppio anello» rilevato sui
                            campi di testo. Copiarlo qui vorrebbe dire propagare un
                            difetto per simmetria: la coerenza si chiude togliendo
                            l'anello di troppo là, in `FieldRenderer`, non
                            aggiungendone uno qui.
                          */
                          /*
                            ── IL GRUPPO IN ERRORE LO DICE ANCHE SULLE CARD ──────
                            «Scegli una sede per proseguire» compariva sotto il
                            gruppo e le tre card restavano identiche a tre card
                            valide non spuntate: `rgb(138,149,143)` a 1 px, cioè lo
                            stato di riposo, mentre un `input` obbligatorio vuoto
                            due passi più avanti mostra `rgb(229,57,53)` a 1,5 px.
                            I tre token sono copiati da `SCELTA_ERRORE` di
                            `FieldRenderer` — stesso rosso, stesso peso — e
                            `data-scelta-invalida` è il gancio con cui `globals.css`
                            dà alla card il bordo DOPPIO in Alto Contrasto, dove
                            `[class*="border-kidville-"]` porta ogni contorno al
                            nero e il rosso semplicemente non esiste più.
                            Il peso del bordo sta nello STATO e non nella struttura:
                            fra `border` e `border-[1.5px]` scritte sullo stesso
                            elemento vince quella che sta più avanti nel FOGLIO, non
                            quella scritta dopo nella stringa — l'unico modo di
                            sceglierla è non averle entrambe.
                            Qui non si può mai dare il caso «scelta E in errore»:
                            l'`onChange` del radio spegne `erroreSede`.
                          */
                          {...(erroreSede && !scelta ? { 'data-scelta-invalida': 'true' } : {})}
                          className={`flex cursor-pointer items-center gap-3 rounded-card px-4 py-3.5 transition-all ${
                            scelta
                              ? 'border border-kidville-green bg-kidville-green-soft'
                              : erroreSede
                                ? 'border-[1.5px] border-kidville-error bg-kidville-white'
                                : 'border border-kidville-neutral bg-kidville-white hover:border-kidville-green'
                          }`}
                        >
                          <input
                            type="radio"
                            id={`sede-${s.id}`}
                            name="sede"
                            value={s.id}
                            /* Il primo radio è il bersaglio del fuoco quando manca
                               la scelta: l'errore lo dice, e la mano ci finisce
                               sopra senza cercarlo. */
                            ref={i === 0 ? primoRadioRef : undefined}
                            checked={scelta}
                            onChange={() => {
                              scegliSede(s.id)
                              setErroreSede(false)
                              // Scegliere È la risposta all'avviso: si spegne qui,
                              // non al prossimo invio. `sedeRifiutata` invece NON
                              // si azzera — è ciò che tiene morto il link targato e
                              // tiene in piedi questo passo: cancellarla farebbe
                              // sparire il passo sotto le mani di chi ci sta
                              // scegliendo.
                              setErroreInvio(null)
                            }}
                            className="h-4 w-4 accent-kidville-green"
                          />
                          {/* Un solo inchiostro per card: il segnaposto seguiva il
                              testo quando la sede era scelta e se ne staccava
                              quando non lo era (`sub`), aggiungendo un quarto
                              stato cromatico a una grafica che ne ha due. */}
                          <MapPin className="h-4 w-4 shrink-0 text-kidville-green" aria-hidden="true" />
                          <span className={`text-sm text-kidville-green ${scelta ? 'font-semibold' : ''}`}>
                            {s.nome}
                          </span>
                        </label>
                      )
                    })}
                    {/*
                      L'ERRORE DEL GRUPPO STA SOTTO IL GRUPPO — come quello delle
                      fasce, come quello dei consensi, come ogni messaggio di campo
                      di `FieldRenderer`. Era l'unico messaggio della pagina a
                      comparire SOPRA ciò che descrive: misurato dal critico, sede
                      a y=267 con le card che cominciano a y=291, fasce a y=535 con
                      il gruppo che finisce a y=518.
                      Era stato messo in cima l'11/08/2026 per una misura vera —
                      a 360 px la frase cadeva a `top` 437 mentre «Avanti» stava a
                      676, 259 px più in basso — ma quella distanza NON veniva da
                      qui: veniva dal `flex-1` sul guscio, che spingeva i comandi in
                      fondo alla finestra lasciando il vuoto in mezzo. Il `flex-1`
                      è stato tolto nello stesso rilascio (vedi il blocco in testa
                      al file), quindi la causa non c'è più e la posizione può
                      tornare dove sta tutto il resto. Il fuoco continua ad andare
                      sul primo radio, cioè dentro il gruppo che la frase descrive.
                    */}
                    {erroreSede && (
                      <p
                        id={ID_ERRORE_SEDE}
                        role="alert"
                        className="flex items-center gap-1.5 text-xs font-bold text-kidville-error-strong"
                      >
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {t('candSedeErrore')}
                      </p>
                    )}
                  </fieldset>
                )}

                {(passo === 'dati' || passo === 'profilo' || passo === 'consensi') && (
                  <div className={passo === 'consensi' ? 'space-y-3' : 'space-y-6'}>
                    {campiDelPasso(passo).map((f) => (
                      <FieldRenderer
                        key={f.id}
                        field={f}
                        modelId="candidature"
                        register={register}
                        control={control}
                        error={errors[f.id]}
                      />
                    ))}
                  </div>
                )}

                {/*
                  IL RIEPILOGO — tutto ciò che è stato scritto, dentro le card che
                  la pagina già usa, raggruppato per passo e con un «Modifica» per
                  gruppo. La ragione per esteso è in testa al file: qui basti che
                  l'elenco NON è scritto a mano, è `gruppiRiepilogo()`, cioè le
                  stesse liste che disegnano i passi.
                */}
                {passo === 'riepilogo' && (
                  <div className="space-y-4">
                    {gruppiRiepilogo().map((g) => (
                      <div
                        key={g.passo}
                        className="rounded-card border border-kidville-line bg-kidville-white px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-3 border-b border-kidville-line pb-2">
                          <h3
                            id={`riepilogo-titolo-${g.passo}`}
                            className="font-barlow text-base font-bold uppercase tracking-wide text-kidville-green"
                          >
                            {g.titolo}
                          </h3>
                          {g.modificabile && (
                            /*
                              Il nome accessibile porta il GRUPPO — «Modifica I
                              tuoi dati» — perché quattro comandi chiamati tutti
                              «Modifica» sono, per chi li ascolta in fila, quattro
                              volte la stessa cosa: l'elenco dei comandi di uno
                              screen reader non porta con sé il titolo che a
                              schermo sta accanto.
                              Il nome si compone con `aria-labelledby` che punta al
                              bottone STESSO e poi al titolo del gruppo — «Modifica»
                              + «Sede» — invece che con un `aria-label` interpolato:
                              così non c'è nessuna chiave di messaggio in più da
                              tradurre in due lingue, e il nome resta giusto anche
                              il giorno in cui il titolo del gruppo cambia.
                              (Uno `sr-only` accodato NON avrebbe funzionato: il
                              calcolo del nome accessibile concatena i nodi di
                              testo dopo averli sfrondati, e «Modifica» + « Sede»
                              diventa `ModificaSede` — misurato con
                              `dom-accessibility-api`, che è ciò che usano sia i
                              test sia i browser.)
                            */
                            <button
                              type="button"
                              id={`riepilogo-modifica-${g.passo}`}
                              aria-labelledby={`riepilogo-modifica-${g.passo} riepilogo-titolo-${g.passo}`}
                              onClick={() => vaiAlPasso(g.passo)}
                              /* `py-3.5` e non `py-2`: 28 px di riempimento + 16 px
                                 di riga = 44 px. Erano 66×32, e su telefono questi
                                 quattro comandi sono l'UNICO modo di correggere
                                 prima di inviare — l'altezza raccomandata per un
                                 pollice è la stessa che «Indietro»/«Avanti» hanno
                                 già qui sotto (44 px). La larghezza non cambia:
                                 `px-3` resta, il bersaglio cresce solo dove serve. */
                              className="shrink-0 rounded-pill px-3 py-3.5 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green underline transition-all hover:bg-kidville-green-soft"
                            >
                              {t('candRiepilogoModifica')}
                            </button>
                          )}
                        </div>
                        {/* Non è una `<dl>`: `dl` ammette come contenuto solo
                            coppie `dt`/`dd` (anche dentro un `div`), e axe lo
                            verifica con la regola `definition-list`. Qui le righe
                            sono due `<p>` — etichetta e valore — perché è la
                            stessa forma delle card di questa pagina. */}
                        <div className="divide-y divide-kidville-line">
                          {g.righe.map((r) => (
                            <div key={r.id} className="py-2">
                              <p className="text-xs font-semibold uppercase tracking-wide text-kidville-sub">
                                {r.etichetta}
                              </p>
                              {/*
                                `wrap-anywhere` (`overflow-wrap: anywhere`) SUL
                                VALORE, e non è una rifinitura: il valore che
                                trabocca più spesso è proprio l'email, cioè l'unico
                                dato con cui la Scuola può rispondere e il motivo
                                per cui questo riepilogo esiste.
                                MISURATO l'11/08/2026 a 360 px: la scatola di testo
                                del valore è larga 294 px (card 328, riempimento 17
                                per lato) e «mariaconcetta.esposito@scuolainfanzia
                                lafavola.it» — 48 caratteri, un indirizzo di scuola
                                del tutto ordinario — ne occupa 313: il testo
                                scavalcava il bordo arrotondato bianco e le righine
                                divisorie e correva fino al margine dello schermo.
                                Con una parte locale non spezzabile (nome e cognome
                                attaccati, 31 caratteri) `scrollWidth` saliva a 382
                                contro 360 di `clientWidth` e l'INTERA pagina si
                                trascinava di lato di 22,5 px — che su un telefono
                                si legge come «la pagina è rotta».
                                Vale per ogni valore, non solo per l'email:
                                «Dettaglio del titolo» e «Comune di residenza» sono
                                testo libero e possono portare parole altrettanto
                                lunghe. `anywhere` e non `break-word` perché è
                                l'unico dei due che entra anche nel calcolo della
                                larghezza minima del contenuto, cioè quello che
                                regge se un giorno la riga finisse dentro un flex.
                              */}
                              {r.elenco ? (
                                <ul className="mt-1 space-y-0.5">
                                  {r.elenco.map((voce) => (
                                    <li key={voce} className="wrap-anywhere text-sm text-kidville-ink">
                                      {voce}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p
                                  className={`mt-0.5 wrap-anywhere text-sm ${
                                    r.mancante
                                      ? 'text-kidville-error-strong'
                                      : r.vuoto
                                        ? 'text-kidville-sub'
                                        : 'text-kidville-ink'
                                  }`}
                                >
                                  {r.valore}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {/*
                      L'AVVERTIMENTO SULL'EMAIL STA QUI, NON NELLA COLONNA DI
                      CONTESTO — ed è il pezzo che quella colonna lascia indietro
                      scendendo sotto i comandi (vedi il commento sull'ordine, più
                      sotto). È l'unica riga del riquadro «Dopo l'invio» che
                      riguarda un gesto da fare PRIMA di premere «Invia», e il posto
                      in cui va letta è questo: subito sotto la card che contiene
                      l'indirizzo appena riletto, subito sopra il bottone.
                      Il resto di quel riquadro — chi valuta, quando risponde, che
                      non serve un account — si legge quando si vuole, e per quello
                      stare dopo i comandi va benissimo.
                    */}
                    <p className="text-xs font-semibold leading-relaxed text-kidville-green">
                      {t('candRiepilogoControllaEmail')}
                    </p>
                    <p className="text-xs leading-relaxed text-kidville-sub">{t('candRiepilogoNota')}</p>
                  </div>
                )}

                {/* L'esca deve esistere in OGNI passo, e per questo sta dentro
                    il contenuto invece che accanto ai comandi: il perché sta su
                    `EscaHoneypot`. La rotta accetta `sito_web` e `honeypot` come
                    sinonimi; si manda il primo. */}
                <EscaHoneypot
                  nome={CAMPO_ESCA}
                  etichetta={t('candEscaEtichetta')}
                  register={register}
                />
              </>
            }
            comandi={
              <>
                {erroreInvio !== null && (
                  <PannelloErroreInvio
                    titolo={t('candErroreInvioTitolo')}
                    corpo={erroreInvio.corpo}
                    nota={notaErrore}
                    riferimento={pannelloErroreRef}
                  />
                )}
                <ComandiWizard
                  indietro={
                    indice > 0
                      ? { etichetta: t('candIndietro'), onClick: indietro, disabilitato: inviando }
                      : null
                  }
                  avanti={{
                    etichetta: etichettaDelComando[versoDelComando],
                    onClick: avanti,
                    /* Nel passo «sede» senza un elenco da cui scegliere il comando
                       non porta da nessuna parte: premerlo risponderebbe soltanto
                       «Scegli una sede per proseguire» davanti a zero sedi. Ciò che
                       si può fare adesso — riprovare l'elenco — sta qui sopra. */
                    disabilitato: inviando || (passo === 'sede' && !sedeSceglibile),
                    verso: versoDelComando,
                  }}
                />
              </>
            }
            contesto={
              <ColonnaContesto
                titolo={t('candContestoTitolo')}
                voci={[
                  /* «la sede che hai scelto» è FALSO quando la sede è arrivata
                     dal collegamento: nessuna scelta c'è stata, e il passo non
                     esiste nemmeno. La variante dice da dove viene davvero. */
                  sedeDaLink !== null ? t('candContestoDirezioneDalLink') : t('candContestoDirezione'),
                  t('candContestoTempi'),
                  t('candContestoCredenziali'),
                ]}
              />
            }
          />
        )}
      </ColonnaCentrale>
    </GuscioPubblico>
  )
}
