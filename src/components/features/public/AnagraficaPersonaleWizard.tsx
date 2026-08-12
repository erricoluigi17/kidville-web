'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useForm, useWatch, type FieldValues } from 'react-hook-form'
import {
  AlertCircle, AlertTriangle, Check, Fingerprint, IdCard, Loader2, MapPin, RefreshCw,
  ShieldCheck, UserRound,
} from 'lucide-react'
import { FieldRenderer, FIELD_BASE, FIELD_BASE_ERRORE } from '@/components/features/forms/FieldRenderer'
import {
  BarraAvanzamento, ColonnaCentrale, ColonnaContesto, ComandiWizard, ContatorePassi,
  EscaHoneypot, GrigliaPasso, GuscioPubblico, PannelloConferma, PannelloErroreInvio,
  TestataPasso, type ComandoAvanti,
} from '@/components/features/public/wizard/pezzi-wizard-pubblico'
import {
  corpoDellaRisposta, useSediPubbliche,
} from '@/components/features/public/wizard/use-sedi-pubbliche'
import {
  LuogoNascitaFields, SIGLA_ESTERO, idsLuogoNascita, type ValoreLuogoNascita,
} from '@/components/features/anagrafica/LuogoNascitaFields'
import {
  BadgeCoerenzaCf, badgeHaQualcosaDaDire,
} from '@/components/features/anagrafica/BadgeCoerenzaCf'
import {
  AvvisoScadenzaDocumento, DocumentoIdentitaFields, CAMPI_DOCUMENTO,
} from '@/components/features/anagrafica/DocumentoIdentitaFields'
import {
  PERSONALE_FIELDS, CONSENSI_PERSONALE_FIELDS,
} from '@/lib/forms/personale-template'
import { validateField, isProvinceField } from '@/lib/forms/validate-fields'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { verificaCoerenza } from '@/lib/fiscale/coerenza'
import { isoToIt } from '@/lib/format/data'
import { dataCivile } from '@/i18n/config'
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch'
import { logClient, nomeErrore } from '@/lib/logging/client'
import type { FormField } from '@/types/database.types'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  «La tua anagrafica» — il modulo PUBBLICO del personale IN SERVIZIO      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Non è `/lavora-con-noi`, e la differenza è tutta la ragione per cui questo file
 * esiste. Là si RACCOGLIE una proposta da chi la Scuola non conosce; qui si
 * raccoglie l'anagrafica di chi il rapporto di lavoro ce l'ha già — e quindi il
 * codice fiscale, il documento d'identità e la sua scansione, che là non si
 * chiedono affatto. Il ragionamento sulle basi giuridiche (art. 6.1.b e 6.1.c, e
 * perché il consenso qui non solo non serve ma sarebbe dannoso) sta in
 * `src/lib/forms/personale-template.ts` e non si ripete: quello è il CONTRATTO,
 * questo è il modulo che lo rende.
 *
 * La pratica finisce in `pratiche_personale` e non produce NIENTE finché una
 * persona della segreteria non la approva: nessun account, nessun ruolo, nessun
 * cambio di sede.
 *
 * ── LE COSE EREDITATE, E DA DOVE ────────────────────────────────────────────
 *
 * Il guscio (barra, testata, impaginatura, comandi, pannelli, colonna di
 * contesto, esca) sta in `wizard/pezzi-wizard-pubblico.tsx`; l'elenco delle sedi
 * e i suoi tre stati in `wizard/use-sedi-pubbliche.ts`. Sono stati estratti
 * l'11/08/2026 PROPRIO perché questo modulo stava per essere la terza copia, e
 * ogni copia precedente aveva ereditato i difetti della prima aggiungendone uno
 * suo. C'è un lock che diventa rosso se le classi del guscio ricompaiono qui
 * (`__tests__/architecture/wizard-pubblici-un-solo-guscio.test.ts`).
 *
 * Restano ereditate, e vanno dette perché sono decisioni e non stile:
 *
 *  · **NIENTE framer-motion.** Con `AnimatePresence mode="wait"` il pannello
 *    nuovo si monta solo dopo l'uscita del vecchio, e un pannello mai montato
 *    NON registra i suoi campi in react-hook-form: si arrivava all'invio con i
 *    dati vuoti. Qui non c'è nessuna animazione che monti o smonti un passo.
 *  · **`mode: 'onTouched'`**, e i valori dei passi smontati si conservano
 *    (`shouldUnregister` è false): si cammina avanti e indietro senza perdere
 *    niente.
 *  · **Il riepilogo si COSTRUISCE dai campi del template**, mai a mano: una riga
 *    per ogni campo reso, «Non indicato» in grigio sui facoltativi vuoti e in
 *    rosso sugli obbligatori. Un elenco scritto a mano è la seconda lista da
 *    mantenere, ed è il modo in cui quella del modulo fratello era rimasta
 *    indietro di undici campi.
 *  · **L'esca `sito_web`**, montata in OGNI passo (un campo mai montato non è
 *    registrato affatto, e l'esca non scatterebbe mai).
 *  · **I comandi non sono `sticky` e non sono incollati in fondo**: il piede
 *    appiccicato copre l'ultimo campo — difetto già pagato su «Comunica
 *    un'assenza» — e il vuoto in mezzo si legge come «manca qualcosa più sotto».
 *  · **Il guardiano del doppio tocco** è un `ref` e non uno stato: `disabled`
 *    si arma dopo un confine asincrono, e tre tocchi rapidi facevano partire tre
 *    POST. Qui costerebbe il doppio: il tetto orario è per INDIRIZZO IP, e il
 *    modo previsto di usare questo modulo è più maestre che compilano lo stesso
 *    pomeriggio dietro il NAT della stessa sede.
 *
 * ── LE COSE CHE SONO DI QUESTO MODULO SOLO ──────────────────────────────────
 *
 * **1. IL PASSO «SEDE» C'È SEMPRE, E NON ESISTE NESSUN `?sede=`.** Il link è UNO
 * per tutte e tre le sedi (decisione del titolare dell'11/08/2026) e la sede la
 * sceglie chi compila. Perciò questo file NON accetta una sede dall'URL, e
 * `mostraSede` non si chiede all'hook: è `true` e basta. La differenza si vede
 * con UN SOLO plesso in elenco — il caso della CI, e quello di una sede
 * disattivata in produzione — dove l'hook direbbe «non c'è niente da scegliere» e
 * il passo sparirebbe: il riepilogo perderebbe il suo «Modifica» sulla sede, e
 * chi compila non leggerebbe MAI il nome del plesso a cui sta consegnando il
 * proprio documento d'identità. La sede resta comunque auto-scelta dall'hook
 * quando è una sola: si vede una card già spuntata, non un passo da riempire.
 *
 * **2. LE CARD DELLA SEDE PORTANO IL NOME DEL PLESSO E LA CITTÀ.** Aversa e Cesa
 * distano sei chilometri e il nome secco non basta a distinguerle per chi lavora
 * in una e conosce l'altra. La città arriva dal NOME che serve l'elenco pubblico
 * (`GET /api/iscrizione/sedi`), non da una tabella di questo file: quando il nome
 * la contiene già — «Kidville Aversa» — non si ripete.
 *
 * **3. «TI SERVE IL DOCUMENTO D'IDENTITÀ» STA IN TESTA, NON AL PASSO 4.** È la
 * riga che evita l'abbandono: chi scopre al quarto passo di doversi alzare a
 * cercare la carta d'identità chiude il modulo, e i tre passi già compilati non
 * esistono più (vedi il punto 4: qui non c'è nessuna bozza). Sparisce quando si
 * arriva al passo del documento, dove diventa rumore.
 *
 * **4. NESSUNA BOZZA IN `localStorage`, E AL SUO POSTO UNA GUARDIA.** Qui i campi
 * sono il codice fiscale e il numero del documento: una bozza li lascerebbe in
 * chiaro nel browser — spesso condiviso, spesso di scuola — senza scadenza,
 * senza cifratura e fuori da qualunque termine di conservazione dichiarato nelle
 * prese visione. Il modulo si ricompila; un identificativo nazionale dimenticato
 * dentro un browser no. Al suo posto c'è `beforeunload`, che avvisa prima di
 * chiudere una pagina con dentro dati scritti e non ancora inviati.
 *
 * **5. IL CODICE FISCALE SI VERIFICA DA SOLO.** Il luogo di nascita si sceglie da
 * una tendina a cascata (`LuogoNascitaFields`), che produce il codice catastale:
 * da un comune scritto a mano il codice fiscale non si verifica, e il badge
 * direbbe «non verificabile» su ogni riga. `BadgeCoerenzaCf` confronta il codice
 * scritto con quello che l'anagrafica implica e — solo dove ha senso — propone il
 * proprio. ⚠️ **Il badge non blocca MAI**: l'unica cosa che ferma «Avanti» è
 * `validateField`, la stessa regola che il server rigira. Un codice omocodico è
 * un codice vero, e un modulo che lo respingesse direbbe a una persona che il
 * proprio codice fiscale non esiste.
 */

/** Dove arriva la pratica. */
const ROTTA_INVIO = '/api/iscrizione/personale'
/** Dove va la scansione del documento: bucket privato `documenti_personale`. */
const ROTTA_CARICAMENTO = '/api/iscrizione/personale/upload'
/**
 * Lo slug di QUESTO modulo nei log del client.
 *
 * Il `messaggio` di `logClient` è anche la chiave del suo throttle: due moduli
 * pubblici che spedissero lo stesso slug si dedurrebbero a vicenda proprio mentre
 * uno dei due è guasto. Da qui escono `anagrafica-personale-sedi-non-caricate`,
 * `anagrafica-personale-invio-fallito`, e si interrogano in SQL su `app_log`.
 */
const ETICHETTA_LOG = 'anagrafica-personale'
/** La cartella logica del caricamento. La rotta la ignora: il percorso lo decide lei. */
const MODELLO = 'personale'

/** I passi. Sono sempre sei: vedi il punto 1 in testa al file. */
type Passo = 'sede' | 'dati' | 'residenza' | 'documento' | 'consensi' | 'riepilogo'

const PASSI: Passo[] = ['sede', 'dati', 'residenza', 'documento', 'consensi', 'riepilogo']

/**
 * I campi del passo «Residenza e recapiti», scritti in POSITIVO.
 *
 * ⚠️ Gli elenchi scritti a mano sono DUE — questo e quello del documento — e
 * tutto ciò che il template dichiara e che non è in nessuno dei due finisce nel
 * passo «I tuoi dati». È deliberato ed è il verso giusto: un campo AGGIUNTO
 * domani al template viene reso comunque, invece di sparire in silenzio — e un
 * campo obbligatorio che sparisce è un modulo che il server rifiuta per sempre
 * senza che nessuno capisca perché.
 *
 * Il contatto d'emergenza sta qui e non in un passo suo perché è un RECAPITO, ed
 * è facoltativo per intero: sono i dati di un terzo che non sta compilando nulla
 * e non ha ricevuto nessuna informativa (art. 14 GDPR).
 */
const IDS_RESIDENZA = new Set([
  'address', 'residence_street_number', 'residence_city', 'residence_province', 'zip_code',
  'domicilio_address', 'domicilio_street_number', 'domicilio_city', 'domicilio_province',
  'domicilio_zip_code',
  'email', 'telefono',
  'emergenza_nome', 'emergenza_telefono', 'emergenza_relazione',
])

/** Gli `id` del passo «Documento»: li dichiara il blocco che li rende. */
const IDS_DOCUMENTO = new Set(CAMPI_DOCUMENTO.map((f) => f.id))

/**
 * I campi che react-hook-form NON vede, perché li rende `LuogoNascitaFields`
 * (tendina a cascata, non `register`).
 *
 * ⚠️ Non è un dettaglio di forma: `trigger(id)` di react-hook-form vale solo per
 * i campi registrati, e su questi quattro risponderebbe `true` a qualunque cosa —
 * cioè «Avanti» passerebbe con il codice catastale vuoto, che è OBBLIGATORIO e
 * senza il quale il codice fiscale non si verifica affatto. Si validano con
 * `validateField`, che legge il valore da `getValues` e non ha bisogno di nessun
 * nodo nel documento: è la stessa regola che il server rigira.
 */
/** Il codice catastale: l'unico OBBLIGATORIO dei quattro, e quello che la tendina rende. */
const ID_BELFIORE = 'codice_belfiore_nascita'
/** La sigla della provincia: è il PRIMO gradino della cascata, e a volte l'unico da salire. */
const ID_PROVINCIA_NASCITA = 'birth_province'
const IDS_LUOGO_NASCITA = [ID_BELFIORE, 'birth_place', ID_PROVINCIA_NASCITA, 'birth_nation']
const NON_REGISTRATI = new Set(IDS_LUOGO_NASCITA)

/** Il prefisso degli `id` della tendina a cascata, e i due `id` che ne escono. */
const ID_PREFISSO_NASCITA = 'pers-nascita'
const IDS_NASCITA = idsLuogoNascita(ID_PREFISSO_NASCITA)

const CAMPI_RESIDENZA: FormField[] = PERSONALE_FIELDS.filter((f) => IDS_RESIDENZA.has(f.id))
const CAMPI_DATI: FormField[] = PERSONALE_FIELDS.filter(
  (f) => !IDS_RESIDENZA.has(f.id) && !IDS_DOCUMENTO.has(f.id),
)
/**
 * I campi di «I tuoi dati» che il modulo RENDE DAVVERO — ed è la stessa lista da
 * cui il riepilogo ricava le sue righe.
 *
 * `birth_place`, `birth_province` e `birth_nation` non hanno un controllo proprio:
 * li scrive la tendina a cascata, che a schermo occupa il posto del codice
 * catastale (l'unico obbligatorio dei quattro). Il passo li salta già
 * (`CAMPI_DATI.map` ritorna `null` su di essi), e il riepilogo li salta per la
 * stessa ragione: la regola di questo file è «una riga per ogni campo RESO», non
 * «una riga per ogni riga del template». Il loro contenuto non si perde — finisce
 * in chiaro nella riga del luogo di nascita, che è dove chi rilegge lo cerca.
 */
const CAMPI_DATI_RESI: FormField[] = CAMPI_DATI.filter(
  (f) => f.id === ID_BELFIORE || !NON_REGISTRATI.has(f.id),
)
/** Tutti i campi che il modulo rende, nell'ordine in cui si compilano. */
const CAMPI_RESI: FormField[] = [...CAMPI_DATI, ...CAMPI_RESIDENZA, ...CAMPI_DOCUMENTO]

/**
 * Il codice fiscale. È l'unico campo del passo «I tuoi dati» che non passa da
 * `FieldRenderer`, e l'unica ragione è `aria-describedby`: deve poter puntare al
 * badge di coerenza, e quel componente non accetta descrittori aggiuntivi.
 */
const ID_CF = 'fiscal_code'

/**
 * Il nome dell'ESCA (honeypot). La rotta accetta `sito_web` e `honeypot` come
 * sinonimi: si manda il primo, quello che un compilatore automatico riempie più
 * volentieri. Un modulo che l'esca non la rende affatto è una difesa che non
 * scatta mai, cioè una difesa che sembra esserci.
 */
const CAMPO_ESCA = 'sito_web'

/** L'`id` del messaggio d'errore del gruppo «sede», per `aria-describedby`. */
const ID_ERRORE_SEDE = 'pers-sede-errore'
/** L'`id` della riga «Passo N di M», che descrive il titolo del passo. */
const ID_PASSO_CONTATORE = 'pers-passo-contatore'
/** L'`id` del badge di coerenza del codice fiscale. */
const ID_BADGE_CF = 'pers-badge-cf'
/** L'`id` del messaggio d'errore del codice fiscale. */
const ID_ERRORE_CF = 'pers-fiscal-code-errore'

/** Una riga del riepilogo: un'etichetta e ciò che è stato scritto sotto di essa. */
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
  righe: RigaRiepilogo[]
}

/** La stringa di un valore letto dal modulo, senza mai lanciare. */
function stringa(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function AnagraficaPersonaleWizard({
  intestazione,
  oggi,
}: {
  /** La riga di testa pubblica (ritorno + Alto Contrasto), montata dalla pagina. */
  intestazione?: ReactNode
  /**
   * Il giorno civile ITALIANO, in forma `YYYY-MM-DD`.
   *
   * ⚠️ È un parametro con un ripiego, e non una lettura dell'orologio sepolta più
   * in basso: è la stessa disciplina di `src/lib/anagrafica/scadenze.ts`, dove
   * «oggi» è sempre iniettato perché i confini delle soglie siano collaudabili.
   * Un collaudo che dovesse costruire una scadenza «fra 89 giorni» rispetto
   * all'istante in cui gira misurerebbe l'orologio invece della regola — ed è
   * esattamente il difetto che il 12/08 ha reso rosso da solo un test con le date
   * cablate nel futuro.
   */
  oggi?: string
} = {}) {
  const t = useTranslations('public')
  /**
   * L'unico prestito da un altro namespace, e ha due usi. `devAccettare` è LA
   * frase che `FieldRenderer` mostra quando una spunta obbligatoria manca (il
   * server, quando rifiuta per lo stesso motivo, manda gli id e non un testo:
   * riscriverne uno qui sarebbero due formulazioni per lo stesso rifiuto);
   * `allegatoCaricato` è la stessa frase che si legge sul campo di caricamento, e
   * il riepilogo non deve dire una seconda cosa.
   */
  const tCampi = useTranslations('parentForms')

  const giornoDiOggi = oggi ?? dataCivile()

  /**
   * TUTTO CIÒ CHE QUESTO MODULO SA DELLE SEDI. `sedeId` non si passa: qui non
   * esiste nessun `?sede=` (punto 1 in testa al file).
   */
  const {
    sedi, statoSedi, elencoPronto, riprova: riprovaSedi,
    sedeScelta, scegliSede, sedeSmentitaDalServer,
    sedeDecisa, nomeSedeDecisa,
    formaDecisa, sediVuote, nonPuoCominciare, sedeSceglibile,
  } = useSediPubbliche({ etichetta: ETICHETTA_LOG })

  const [erroreSede, setErroreSede] = useState(false)
  const [indice, setIndice] = useState(0)
  /**
   * «MODIFICA» È UN VIAGGIO DI ANDATA **E RITORNO**: acceso quando si è entrati in
   * un passo dal riepilogo, spento appena ci si è tornati. Finché è acceso il
   * comando primario si chiama «Torna al riepilogo» e ci riporta in un colpo
   * solo — validando però TUTTI i passi scavalcati, altrimenti il riepilogo
   * mostrerebbe un modulo che il server rifiuterà, cioè la cosa che il riepilogo
   * esiste per evitare.
   */
  const [ritornoAlRiepilogo, setRitornoAlRiepilogo] = useState(false)
  /** Il passo su cui il ritorno si è dovuto fermare, o `null`. */
  const [ritornoInterrotto, setRitornoInterrotto] = useState<Passo | null>(null)
  const [inviando, setInviando] = useState(false)
  const [inviata, setInviata] = useState(false)
  const [erroreInvio, setErroreInvio] = useState<
    { tipo: 'generico' | 'sede'; corpo: string; nota: string } | null
  >(null)

  /**
   * IL GUARDIANO DEL DOPPIO TOCCO, e non può essere uno stato: `disabled` si arma
   * DOPO l'`await` della validazione, e fra il clic e il render che disabilita il
   * bottone c'è un confine asincrono. Un `ref` si aggiorna nell'istante del clic.
   */
  const avantiInCorso = useRef(false)
  /** L'`h2` della conferma: ci si porta il fuoco, che l'invio ha appena distrutto. */
  const confermaRef = useRef<HTMLHeadingElement>(null)
  /** Il pannello d'errore d'invio: sul rifiuto della sede è un ancoraggio per il fuoco. */
  const pannelloErroreRef = useRef<HTMLDivElement>(null)
  /** Il PRIMO radio della sede: è lì che va il fuoco quando manca la scelta. */
  const primoRadioRef = useRef<HTMLInputElement>(null)
  /** L'`h2` del passo corrente: è lì che si va quando il passo CAMBIA. */
  const titoloPassoRef = useRef<HTMLHeadingElement>(null)
  /** L'indice del render precedente: distingue «il passo è cambiato» dal resto. */
  const indicePrecedente = useRef(indice)
  /**
   * IL MODULO È SPORCO: qualcuno ha scritto qualcosa e non l'ha ancora inviato.
   *
   * È un `ref` e non uno stato di proposito — non deve ridisegnare niente, serve
   * solo a `beforeunload` — e si accende alla prima modifica di un CAMPO, non
   * alla scelta della sede: un avviso di uscita per un radio spuntato è un avviso
   * che si impara a chiudere senza leggerlo, e questa guardia è l'unica cosa che
   * sta fra chi chiude una scheda per sbaglio e un modulo da ricompilare da capo
   * (qui non c'è nessuna bozza: vedi il punto 4 in testa al file).
   */
  const sporco = useRef(false)

  const {
    register, control, trigger, getValues, setValue, setFocus, setError, clearErrors,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched' })

  const passo = PASSI[Math.min(indice, PASSI.length - 1)]
  const ultimo = indice === PASSI.length - 1

  // ── I valori che servono FUORI da `FieldRenderer` ──────────────────────────
  // I quattro del luogo di nascita non sono registrati (li rende la tendina a
  // cascata), gli altri servono a calcolare la coerenza del codice fiscale.
  const osservati = useWatch({
    control,
    name: [
      'nome', 'cognome', 'gender', 'birth_date', ID_CF,
      'codice_belfiore_nascita', 'birth_place', 'birth_province', 'birth_nation',
      'document_expiry',
    ],
  }) as unknown[]
  const [
    vNome, vCognome, vGender, vNascita, vCf,
    vBelfiore, vComune, vProvincia, vNazione,
    vScadenza,
  ] = osservati

  /**
   * IL VERDETTO SUL CODICE FISCALE, e NON blocca niente.
   *
   * `verificaCoerenza` è la stessa funzione che la rotta esegue sul server
   * (punto 5-bis di `iscrizione/personale:POST`), e produce le stesse conclusioni
   * sugli stessi dati: qui serve a mostrarle mentre si scrive, invece che dopo
   * l'invio. Il codice ASSENTE non è un'incoerenza — è l'assenza dell'oggetto
   * della verifica — quindi il badge tace, e a bloccare «Avanti» resta
   * `validateField`, che il campo lo dichiara obbligatorio.
   */
  const esitoCoerenza = useMemo(
    () =>
      verificaCoerenza(vCf, {
        nome: stringa(vNome),
        cognome: stringa(vCognome),
        sesso: stringa(vGender),
        dataNascita: stringa(vNascita),
        codiceBelfiore: stringa(vBelfiore),
      }),
    [vCf, vNome, vCognome, vGender, vNascita, vBelfiore],
  )

  const luogoNascita: ValoreLuogoNascita = {
    provincia: stringa(vProvincia),
    comune: stringa(vComune),
    belfiore: stringa(vBelfiore),
    nazione: stringa(vNazione),
  }

  /**
   * La tendina a cascata scrive QUATTRO campi insieme, e spegne insieme i loro
   * messaggi: sono un campo solo per chi compila, e lasciare acceso il rosso del
   * codice catastale dopo che il comune è stato riscelto direbbe che il problema
   * è ancora lì.
   */
  function cambiaLuogoNascita(v: ValoreLuogoNascita): void {
    setValue('birth_province', v.provincia, { shouldValidate: false })
    setValue('birth_place', v.comune, { shouldValidate: false })
    setValue('birth_nation', v.nazione, { shouldValidate: false })
    setValue('codice_belfiore_nascita', v.belfiore, { shouldValidate: false })
    clearErrors(IDS_LUOGO_NASCITA)
    sporco.current = true
  }

  // Il fuoco sulla conferma. Sta in un effetto e non nel gestore dell'invio
  // perché l'`h2` non esiste ancora quando `setInviata(true)` viene chiamato.
  useEffect(() => {
    if (inviata) confermaRef.current?.focus()
  }, [inviata])

  /*
   * IL FUOCO DOPO IL RIFIUTO DELLA SEDE. Chi preme «Invia» ha il fuoco su quel
   * bottone; il rifiuto riporta al primo passo, dove lo stesso bottone diventa
   * `disabled` finché l'elenco non torna — e un browser vero toglie il fuoco a un
   * elemento che si disabilita, lasciandolo cadere su `<body>`. Il pannello che
   * spiega cos'è successo è l'unico appiglio sensato.
   */
  useEffect(() => {
    if (erroreInvio?.tipo === 'sede') pannelloErroreRef.current?.focus()
  }, [erroreInvio])

  /*
   * IL FUOCO DOPO «SCEGLI UNA SEDE». Il passo «sede» non ha campi di
   * react-hook-form: i radio sono stato locale, quindi `trigger`/`setFocus` non
   * li vedono. Portare il fuoco sul primo radio fa due cose insieme — il browser
   * lo porta in vista da sé, e chi usa uno screen reader si ritrova dentro il
   * gruppo annunciato dalla sua `legend`, cioè nel punto in cui l'errore chiede
   * di agire.
   */
  useEffect(() => {
    if (erroreSede) primoRadioRef.current?.focus()
  }, [erroreSede])

  /*
   * IL PASSO NUOVO COMINCIA DAL SUO TITOLO: si torna in cima e si posa il fuoco
   * sull'`h2`. Senza, il passo nuovo si apre all'altezza di scorrimento
   * precedente — cioè a metà — e da tastiera il fuoco resta su un bottone che nel
   * frattempo ha cambiato etichetta.
   *
   * ⚠️ NON SCATTA quando il fuoco è già stato assegnato di proposito: i tre
   * percorsi che cambiano l'indice E posano il fuoco altrove sono tutti percorsi
   * d'errore, cioè quelli in cui portarlo via è più grave.
   *
   * `scrollTop` e non `window.scrollTo`: fa la stessa cosa nel browser ed è un
   * assegnamento di proprietà, quindi sotto jsdom (dove `scrollTo` è «not
   * implemented») non stampa un errore a ogni passo di ogni test.
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

  /*
   * IL MODULO È SPORCO — e da qui in poi chiudere la pagina costa qualcosa.
   *
   * L'effetto tiene il `beforeunload` finché l'invio non è andato a buon fine:
   * dopo, non c'è più niente da perdere e l'avviso sarebbe soltanto un ostacolo
   * fra chi ha finito e la chiusura della scheda.
   *
   * ⚠️ Nessun `setState` qui dentro, e nemmeno una sottoscrizione a `watch()`.
   * Il segno è un `ref` acceso dall'`onChange` che avvolge il contenuto del passo
   * (vedi `SEGNO_DI_SPORCO`, più sotto): un setter nel corpo di un effetto fa
   * fallire `react-hooks/set-state-in-effect`, e `watch()` fa fallire
   * `react-hooks/incompatible-library` — entrambi ERRORI del gate di questo repo,
   * ed entrambi per la stessa ragione di fondo: quel segno non deve ridisegnare
   * niente, quindi non deve passare per lo stato.
   *
   * Il testo dell'avviso non lo scriviamo noi: i browser moderni mostrano il
   * proprio, e una stringa personalizzata verrebbe ignorata. `preventDefault()`
   * più `returnValue` coprono le due convenzioni che convivono.
   */
  useEffect(() => {
    if (inviata) return
    const avviso = (e: BeforeUnloadEvent): void => {
      if (!sporco.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', avviso)
    return () => window.removeEventListener('beforeunload', avviso)
  }, [inviata])

  /** I campi del modulo che vivono nel passo corrente (il riepilogo non ne ha). */
  function campiDelPasso(p: Passo): FormField[] {
    if (p === 'dati') return CAMPI_DATI
    if (p === 'residenza') return CAMPI_RESIDENZA
    if (p === 'documento') return CAMPI_DOCUMENTO
    if (p === 'consensi') return CONSENSI_PERSONALE_FIELDS
    return []
  }

  /** In quale passo si vede il campo `id`, oppure `null` se non è reso. */
  function passoDelCampo(id: string): Passo | null {
    if (CAMPI_DATI.some((f) => f.id === id)) return 'dati'
    if (CAMPI_RESIDENZA.some((f) => f.id === id)) return 'residenza'
    if (CAMPI_DOCUMENTO.some((f) => f.id === id)) return 'documento'
    if (CONSENSI_PERSONALE_FIELDS.some((f) => f.id === id)) return 'consensi'
    return null
  }

  /**
   * Il messaggio che questo campo merita adesso, o `null` se sta bene — e si
   * calcola SENZA `trigger`, di proposito.
   *
   * `trigger(id)` vale solo per i campi MONTATI e REGISTRATI: i passi scavalcati
   * non sono a schermo, e i quattro del luogo di nascita non sono registrati
   * affatto. `validateField` è la stessa regola che il server rigira e legge il
   * valore da `getValues`: non le serve nessun nodo nel documento.
   */
  function messaggioMancante(f: FormField): string | null {
    const valore = getValues(f.id)
    if (f.type === 'consent') return f.required && valore !== true ? tCampi('devAccettare') : null
    return validateField(f, valore)
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * DOVE VA IL MESSAGGIO DEL LUOGO DI NASCITA — sul controllo che si può TOCCARE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ─── IL VICOLO CIECO, MISURATO IL 12/08/2026 ───────────────────────────────
   * Compilando tutto il passo «I tuoi dati» tranne la PROVINCIA di nascita e
   * premendo «Avanti»: il passo restava «Passo 2 di 6» e l'unico `role="alert"`
   * a schermo era `pers-nascita-comune-errore` — «Campo obbligatorio» — sotto un
   * controllo con `disabled = true`, fondo rgb(240,242,241) e bordo
   * rgb(138,149,143). Cioè il messaggio stava sotto una casella spenta, che non
   * si può cliccare, che non riceve il fuoco (`com.focus()` misurato: il fuoco
   * NON ci va) e che la tabulazione salta. Il campo da compilare davvero — la
   * provincia, un centimetro più su — non aveva `aria-invalid`, non aveva
   * messaggio, non aveva asterisco.
   *
   * Per chi guarda: si preme «Avanti», la pagina torna in cima e non succede
   * niente di comprensibile. Per chi ascolta è peggio: si annuncia un errore su
   * un elemento irraggiungibile, e non esiste nessun modo di scoprire che la via
   * d'uscita è il campo precedente. Sono maestre in servizio che compilano una
   * volta sola, e qui non c'è nessuna bozza a cui tornare (punto 4 in testa).
   *
   * ─── LA REGOLA ─────────────────────────────────────────────────────────────
   * I quattro campi della cascata sono UN controllo per chi compila, e il loro
   * messaggio va su quello dei due che in questo istante è ABILITATO:
   *  · provincia vuota → il messaggio sta sulla PROVINCIA, e dice cosa fare
   *    («scegli prima la provincia»), non che manca un campo che non si vede;
   *  · provincia scelta → la tendina del comune è viva, e il messaggio è suo.
   * Vale per il rifiuto del server allo stesso modo: `mappaErroriServer` passa
   * di qui, altrimenti un 400 su `birth_place` riaprirebbe lo stesso vicolo.
   */
  function bersaglioDelCampo(id: string): string {
    if (!NON_REGISTRATI.has(id)) return id
    return stringa(getValues(ID_PROVINCIA_NASCITA)).trim() === '' ? ID_PROVINCIA_NASCITA : ID_BELFIORE
  }

  /**
   * I guasti di un passo, NELL'ORDINE DEL TEMPLATE e con i quattro del luogo di
   * nascita già collassati in uno solo.
   *
   * L'ordine conta perché il primo elemento è anche il campo che riceve il fuoco:
   * «il primo campo non valido» deve essere il primo che si incontra scendendo,
   * non il primo di una lista raggruppata per modo-di-rendere.
   */
  function guastiDelPasso(p: Passo): { id: string; messaggio: string }[] {
    const guasti: { id: string; messaggio: string }[] = []
    let nascitaGiaDetta = false
    for (const f of campiDelPasso(p)) {
      const messaggio = messaggioMancante(f)
      if (messaggio === null) continue
      if (!NON_REGISTRATI.has(f.id)) {
        guasti.push({ id: f.id, messaggio })
        continue
      }
      // Un messaggio solo per tutta la cascata: quattro «Campo obbligatorio»
      // sotto un controllo solo direbbero che i problemi sono quattro.
      if (nascitaGiaDetta) continue
      nascitaGiaDetta = true
      const dove = bersaglioDelCampo(f.id)
      guasti.push({
        id: dove,
        // Sul primo gradino il messaggio non è «manca un dato»: è l'ISTRUZIONE
        // che sblocca il gradino successivo. «Campo obbligatorio» su una
        // provincia che il template dichiara facoltativa sarebbe anche falso.
        messaggio: dove === ID_PROVINCIA_NASCITA ? t('persNascitaProvinciaPrima') : messaggio,
      })
    }
    return guasti
  }

  /**
   * IL FUOCO SUL CAMPO CHE HA SBAGLIATO — anche quando non è registrato.
   *
   * `setFocus` di react-hook-form vale solo per i campi che passano da
   * `register`/`Controller`: sui due controlli della cascata è un no-op silenzioso
   * (è il motivo per cui, prima del 12/08/2026, il fuoco finiva sull'`h2` del
   * passo). Il nodo però esiste — il passo non è cambiato — e non è disabilitato,
   * perché il bersaglio lo sceglie `bersaglioDelCampo` proprio in base a quello.
   * Gli `id` arrivano da `idsLuogoNascita`, cioè dallo stesso file che li scrive.
   */
  function portaIlFuoco(id: string): void {
    if (!NON_REGISTRATI.has(id)) {
      setFocus(id)
      return
    }
    const dove = id === ID_PROVINCIA_NASCITA ? IDS_NASCITA.provincia : IDS_NASCITA.comune
    document.getElementById(dove)?.focus()
  }

  /**
   * ⚠️ DA QUI IN POI QUESTO CAMPO SI RIVALIDA MENTRE LO SI SCRIVE.
   *
   * ─── IL DIFETTO, MISURATO IL 12/08/2026 CON INTERAZIONE VERA ──────────────
   * Dopo un «Avanti» fallito, correggere un campo NON spegneva il suo rosso
   * finché non se ne usciva. MISURATO su `#cognome` (clic del mouse e
   * digitazione vera): valore «Rossini», `aria-invalid="true"`, bordo
   * `rgb(229,57,53)` e «Campo obbligatorio» ancora sotto, col cursore DENTRO il
   * campo; solo il `blur` li spegneva. Sul menu `#gender` era peggio: lì non c'è
   * niente da digitare — si sceglie «Femmina» e il rosso resta a fissarti.
   * Al primo «Avanti» a modulo vuoto i messaggi simultanei sono NOVE sul solo
   * passo «I tuoi dati»: si smontano uno per uno davanti a un modulo che non
   * risponde.
   *
   * ─── PERCHÉ SUCCEDEVA, E PERCHÉ SI RIPARA COSÌ ────────────────────────────
   * Il modulo non usa `handleSubmit` (i passi si validano a mano), quindi
   * `formState.isSubmitted` resta `false` per sempre; e in `mode: 'onTouched'`
   * react-hook-form salta la rivalidazione su `change` finché il campo non è
   * TOCCATO — dove «toccato» vuol dire «ha avuto un blur». Un campo che ha preso
   * il rosso da `trigger` non è toccato: è marcato non valido e sordo.
   * `setValue(id, valore, { shouldTouch: true })` è l'unico modo pubblico di
   * dichiararlo toccato, e da quel momento ogni battuta lo rivaluta. Non tocca
   * il valore (si riscrive quello che c'è) e non sporca `isDirty`.
   *
   * Si accende SOLO sui campi che hanno davvero acceso un messaggio: fare vivi
   * anche gli altri significherebbe mostrare «Campo obbligatorio» sotto un campo
   * appena cominciato, cioè spostare il difetto invece di chiuderlo.
   */
  function accendiRivalidazione(id: string): void {
    setValue(id, getValues(id), { shouldTouch: true, shouldValidate: false })
  }

  /**
   * Gli errori per campo del SERVER, riportati sotto i campi e sul passo giusto.
   *
   * `POST /api/iscrizione/personale` risponde 400 con `{ campi: { id: msg } }` in
   * forma PIATTA e, per le prese visione obbligatorie, con `{ consensi: [id, …] }`.
   * Senza questa mappatura chi compila legge una frase generica davanti a un
   * passo che sembra a posto: è la differenza fra un rifiuto azionabile e un
   * vicolo cieco.
   *
   * Ritorna `false` se non c'è stato niente da mostrare — e allora il chiamante
   * mostra il pannello generico invece di lasciare la schermata muta.
   */
  function mappaErroriServer(corpo: unknown): boolean {
    const c = corpo as { campi?: unknown; consensi?: unknown } | null
    if (c === null || typeof c !== 'object') return false
    let primo = -1
    const segna = (id: string, messaggio: string): void => {
      const p = passoDelCampo(id)
      if (p === null) return
      // Vale anche per il rifiuto del SERVER: un campo che il server ha respinto
      // deve spegnersi mentre lo si corregge, non quando lo si abbandona.
      accendiRivalidazione(id)
      // ⚠️ …e il messaggio va sul controllo RAGGIUNGIBILE, non su quello che
      // porta il nome della colonna: un 400 su `birth_place` scritto sotto la
      // tendina del comune, con la provincia ancora vuota, riaprirebbe esatto il
      // vicolo cieco chiuso in `bersaglioDelCampo`. Il passo si calcola sull'id
      // VERO (è lì che il campo si vede), il messaggio si posa sul bersaglio.
      setError(bersaglioDelCampo(id), { type: 'server', message: messaggio })
      const dove = PASSI.indexOf(p)
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
    // altro clic già in coda: `disabled={inviando}` non li ferma, questo sì.
    if (avantiInCorso.current) return
    avantiInCorso.current = true
    try {
      await passoAvanti()
    } finally {
      avantiInCorso.current = false
    }
  }

  /**
   * DOVE SI VA DOPO AVER SUPERATO IL PASSO CORRENTE — il passo seguente, oppure
   * il riepilogo in un colpo solo se ci si è arrivati da lì con «Modifica».
   *
   * Il salto NON è un `setIndice(ultimo)`: valida prima, uno per uno, tutti i
   * passi che scavalcherebbe. Al riepilogo non può arrivare un modulo che nessuno
   * ha controllato.
   */
  async function prosegui(): Promise<void> {
    if (!ritornoAlRiepilogo) {
      setIndice((i) => i + 1)
      return
    }
    for (const p of PASSI.slice(indice + 1, PASSI.length - 1)) {
      // La stessa lista che usa «Avanti», e per la stessa ragione: i quattro del
      // luogo di nascita collassano sul controllo raggiungibile.
      const guasti = guastiDelPasso(p)
      if (guasti.length === 0) continue
      // Si ricade nel percorso lineare, E LO SI DICE: il riquadro nomina il passo
      // e i campi portano il loro messaggio. Spegnere il segno in silenzio sarebbe
      // la peggiore delle possibilità — un comando che ha appena promesso «torna
      // al riepilogo» e ha consegnato un altro passo.
      for (const g of guasti) {
        accendiRivalidazione(g.id)
        setError(g.id, { type: 'validate', message: g.messaggio })
      }
      setRitornoAlRiepilogo(false)
      setRitornoInterrotto(p)
      setIndice(PASSI.indexOf(p))
      return
    }
    setRitornoAlRiepilogo(false)
    setIndice(PASSI.length - 1)
  }

  async function passoAvanti(): Promise<void> {
    // Il riquadro del ritorno interrotto descrive l'esito dell'ULTIMA pressione:
    // alla successiva si spegne, comunque vada.
    setRitornoInterrotto(null)

    if (passo === 'sede') {
      if (!sedeScelta) {
        setErroreSede(true)
        return
      }
      setErroreSede(false)
      // ⚠️ Uscire dal passo «sede» spegne l'errore d'invio: il pannello del
      // rifiuto vive nel ramo dei passi, cioè in TUTTI, e senza questa riga
      // sopravviverebbe dove il selettore della sede non c'è — continuando a
      // ordinare «scegli la sede qui sopra» davanti a zero radio.
      setErroreInvio(null)
      await prosegui()
      return
    }

    const campi = campiDelPasso(passo)
    // Province: «Napoli» → «NA» PRIMA di validare, così passa anche senza blur.
    // Solo sui campi REGISTRATI: quello di nascita lo scrive la tendina a
    // cascata, che la sigla la conosce già e non la indovina mai.
    for (const f of campi) {
      if (!isProvinceField(f) || NON_REGISTRATI.has(f.id)) continue
      const grezzo = getValues(f.id)
      if (grezzo === null || grezzo === undefined || String(grezzo).trim() === '') continue
      const sigla = normalizzaProvincia(grezzo)
      if (sigla && sigla !== grezzo) setValue(f.id, sigla, { shouldValidate: false })
    }

    const registrati = campi.filter((f) => !NON_REGISTRATI.has(f.id))
    const validoRhf = await trigger(registrati.map((f) => f.id))

    // I guasti del passo NELL'ORDINE IN CUI SI VEDONO, coi quattro del luogo di
    // nascita già collassati sul controllo raggiungibile: `trigger` non li vede
    // affatto e su di essi risponderebbe `true` a qualunque cosa.
    const guasti = guastiDelPasso(passo)
    const guastiSpeciali = guasti.filter((g) => NON_REGISTRATI.has(g.id))
    for (const g of guastiSpeciali) setError(g.id, { type: 'validate', message: g.messaggio })

    if (!validoRhf || guastiSpeciali.length > 0) {
      // I campi che hanno appena acceso il rosso diventano VIVI: da adesso si
      // rivalidano a ogni battuta, invece di aspettare che li si abbandoni.
      // Vedi `accendiRivalidazione` per la misura che ha portato a questa riga.
      for (const f of registrati) {
        if (messaggioMancante(f) === null) continue
        accendiRivalidazione(f.id)
      }
      // IL FUOCO VA SUL PRIMO CAMPO NON VALIDO, e «primo» è quello che si
      // incontra scendendo — la scansione del documento compresa (dal 12/08/2026
      // il suo `<input type="file">` è raggiungibile e porta il `ref` di
      // react-hook-form) e i due controlli della cascata compresi, che `setFocus`
      // non vede e che `portaIlFuoco` raggiunge per `id`. Prima di allora questa
      // regola degradava in silenzio proprio dove costava di più: un elemento
      // disabilitato non è focalizzabile, quindi il codice chiamava `setFocus` e
      // non succedeva niente.
      const primo = guasti[0]
      if (primo) portaIlFuoco(primo.id)
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
    // trasformerebbe in un avviso che si impara a ignorare.
    setErroreInvio(null)
    setRitornoInterrotto(null)
    setIndice((i) => Math.max(0, i - 1))
  }

  async function invia(): Promise<void> {
    // Ultima difesa lato client: la rotta pretende `scuola_id`, e senza sede non
    // si invia alla cieca. Un'anagrafica archiviata nel plesso sbagliato è peggio
    // di un passo in più: la Segreteria che l'aspetta crede che non sia arrivata.
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
      // LE PRESE VISIONE VANNO NEL PAYLOAD, e anche quelle NON spuntate, come
      // `false`: «non gliel'ho chiesto» e «ha detto no» non sono la stessa cosa
      // dentro `consents_log`, che è la prova di ciò che è stato dichiarato.
      for (const f of CONSENSI_PERSONALE_FIELDS) dati[f.id] = valori[f.id] === true

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
        // ⚠️ IL RIFIUTO SULLA SEDE VIENE PRIMA DI TUTTI GLI ALTRI: la frase del
        // catalogo ordina un'azione, e su questo modulo l'azione dev'essere
        // possibile. Qui si rimette il passo «sede» davanti e ci si porta chi
        // compila. Non è un caso di scuola: `GET /api/iscrizione/sedi` e la POST
        // applicano lo STESSO `sediReali`, ma non nello stesso istante.
        if (res.status === 400 && (corpo as { codice?: unknown } | null)?.codice === 'SEDE_DA_SPECIFICARE') {
          sedeSmentitaDalServer(sede)
          setIndice(0)
          // Una sola frase, e non due come sul modulo fratello: qui il link
          // targato non esiste, quindi la sede l'ha scelta chi compila da un
          // elenco che il server aveva appena servito. Accusare «il collegamento
          // con cui hai aperto il modulo» darebbe la colpa a una cosa che non è
          // mai esistita.
          setErroreInvio({
            tipo: 'sede',
            corpo: t('persSedeRifiutataCorpo'),
            nota: t('persSedeRifiutataNota'),
          })
          // `warn` e non `error`: il server ha risposto correttamente a un dato
          // sbagliato. L'uuid NON si logga: non dice niente che lo status non dica già.
          logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'anagrafica-personale-sede-rifiutata',
            stato: res.status,
          })
          return
        }
        // 400 con gli errori per campo: si riporta chi compila sul campo
        // sbagliato, invece di lasciarlo davanti a una frase generica.
        if (res.status === 400 && mappaErroriServer(corpo)) return
        // ⚠️ IL TESTO NON È LA PROSA DEL SERVER. `soloCatalogoDaCorpo` traduce il
        // CODICE dichiarato (`PRATICA_NON_INVIATA`, `PRATICHE_NON_DISPONIBILI`
        // sul 503, `TROPPE_RICHIESTE` sul 429) e altrimenti ripiega sulla frase
        // di questa schermata, che è già tradotta. La prosa del server nasce dove
        // il locale non esiste ed è italiana per costruzione.
        setErroreInvio({
          tipo: 'generico',
          corpo: soloCatalogoDaCorpo(corpo, t('persErroreInvioCorpo')),
          nota: t('persErroreInvioDatiSalvi'),
        })
        // ⚠️ Nel log un'etichetta STABILE, non la frase del server: su un 400
        // quella nomina i campi respinti, e da lì finirebbe archiviata.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: 'anagrafica-personale-invio-fallito',
          stato: res.status,
        })
        return
      }

      // 201 — e si arriva qui ANCHE quando quella persona ha già una pratica
      // viva: la rotta risponde 201 di proposito, perché un 409 su un modulo
      // anonimo direbbe a chiunque digiti l'email di una maestra che quella
      // persona ha consegnato l'anagrafica. Il corpo porta anche `avvisi` (i
      // motivi di incoerenza del codice fiscale): NON si leggono qui, perché sono
      // gli stessi che il badge ha già mostrato mentre si scriveva — ripeterli
      // dopo l'invio, quando non c'è più niente da correggere, sarebbe un allarme
      // senza azione.
      setInviata(true)
    } catch (err) {
      // La rete è caduta: il server non ha risposto affatto. `withRoute` è lato
      // server e non vede niente di tutto questo — se non si logga qui, non si
      // logga da nessuna parte.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `anagrafica-personale-invio-fallito: ${nomeErrore(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
      })
      // NIENTE `alert()`: il pannello di sistema non dice cosa fare, non lascia
      // traccia in pagina e nella WebView nativa è peggio.
      setErroreInvio({
        tipo: 'generico',
        corpo: t('persErroreInvioCorpo'),
        nota: t('persErroreInvioDatiSalvi'),
      })
    } finally {
      setInviando(false)
    }
  }

  /**
   * Il valore di un campo COME SI LEGGE, oppure `null` se non è stato compilato.
   *
   * Il punto è che il riepilogo non mostri mai il valore TECNICO: `document_type`
   * vale `CI` in react-hook-form, e chi rilegge deve trovarci «Carta d'identità»,
   * cioè la stessa stringa che ha scelto.
   *
   * ⚠️ Il ramo `file` NON mostra il percorso. Il valore di `documento_path` è la
   * chiave con cui si firma un oggetto del bucket privato del personale, e i
   * segmenti sono due uuid: a chi rilegge non dice niente, e metterlo a schermo
   * significa metterlo in una schermata da fotografare, da leggere ad alta voce e
   * — con un pizzico di sfortuna — in una segnalazione di guasto. Il riepilogo
   * dice ciò che serve controllare: che la scansione c'è.
   *
   * ⚠️ E le DATE si rileggono in `gg/mm/aaaa`, non in ISO. In react-hook-form
   * `birth_date` e `document_expiry` valgono `1985-06-12` e `2029-05-20`: senza
   * questa branca il riepilogo li mostrava così — cioè restituiva in aaaa-mm-gg
   * due date che il modulo aveva chiesto in gg/mm/aaaa, e sulla scadenza le aveva
   * chieste con la maschera di `DateField` proprio perché un giorno e un mese
   * scambiati non danno un errore ma una data VALIDA E SBAGLIATA (il ragionamento
   * per esteso è nella testata di `DocumentoIdentitaFields`). Questa è l'ultima
   * schermata prima di un invio irreversibile e il suo unico compito è farsi
   * ricontrollare: chiedere in un formato e restituire nell'altro obbliga a
   * ritradurre a mente proprio la riga su cui l'errore non si vede.
   * `isoToIt` è la stessa funzione con cui `AvvisoScadenzaDocumento` scrive
   * «scaduto il 04/03/2025», quaranta righe più in là: una seconda formattazione
   * qui sarebbero due date diverse per lo stesso giorno nella stessa schermata.
   * Se il valore non è una data ISO — non può esserlo, ma non si butta via ciò
   * che è stato scritto — si mostra com'è.
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
    if (f.type === 'file') return tCampi('allegatoCaricato')
    if (f.type === 'date') return isoToIt(testo) || testo
    return testo
  }

  /**
   * IL LUOGO DI NASCITA IN UNA RIGA SOLA, E IN CHIARO.
   *
   * Il riepilogo mostrava `Comune di nascita → E054` e, subito sotto, `Comune di
   * nascita (per esteso) → GIUGLIANO IN CAMPANIA`: due righe adiacenti con
   * etichette che si distinguono per un «(per esteso)» in coda — cioè nel punto
   * in cui l'occhio ha già smesso di leggere — e la prima delle due mostrava un
   * valore che chi compila non ha mai digitato né visto, perché al suo posto c'è
   * la tendina a cascata. Una riga che chiede di controllare quattro caratteri
   * illeggibili non si controlla: si salta, e con essa si salta quella accanto,
   * che invece era controllabile. È la stessa regola che `testoDelValore`
   * dichiara per `document_type`: nel riepilogo non ci va MAI il valore tecnico.
   *
   * Qui la riga è una e porta ciò che è stato SCELTO: il comune con la sua
   * provincia (`GIUGLIANO IN CAMPANIA (NA)`), oppure il solo nome dello Stato per
   * chi è nato all'estero — dove la provincia vale `EE`, che è un codice quanto
   * `E054`, e la nazione ripete il nome già scritto.
   *
   * Il ROSSO guarda il codice catastale, non il nome: è lui l'obbligatorio, ed è
   * lui che serve a verificare il codice fiscale. Un nome scritto senza codice si
   * legge — non si nasconde ciò che è stato scritto — ma si legge in rosso.
   */
  function rigaLuogoNascita(f: FormField): RigaRiepilogo {
    const etichetta = String(f.label)
    const belfiore = stringa(getValues(ID_BELFIORE)).trim()
    const comune = stringa(getValues('birth_place')).trim()
    const provincia = stringa(getValues('birth_province')).trim().toUpperCase()
    const nazione = stringa(getValues('birth_nation')).trim()
    const nome = comune !== '' ? comune : nazione

    if (nome === '') {
      return {
        id: f.id,
        etichetta,
        valore: t('persRiepilogoNonIndicato'),
        vuoto: true,
        mancante: f.required === true,
      }
    }
    const estero = provincia === SIGLA_ESTERO || provincia === ''
    return {
      id: f.id,
      etichetta,
      valore: estero ? nome : `${nome} (${provincia})`,
      vuoto: false,
      mancante: belfiore === '' && f.required === true,
    }
  }

  /** Una riga di riepilogo per un campo del template. */
  function rigaDelCampo(f: FormField): RigaRiepilogo {
    // I quattro del luogo di nascita sono UN controllo solo a schermo, e sono una
    // riga sola qui: vedi `rigaLuogoNascita`.
    if (f.id === ID_BELFIORE) return rigaLuogoNascita(f)

    const grezzo = getValues(f.id)
    const etichetta = String(f.label)
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
        // «Nessuna fascia indicata» dice molto più di «Non indicato» su un campo
        // che decide quali funzioni la persona vedrà nell'app.
        valore: f.id === 'gradi' ? t('persRiepilogoNessunaFascia') : t('persRiepilogoNonIndicato'),
        vuoto: true,
        mancante: obbligatorio,
      }
    }

    // Le prese visione non conoscono il «non indicato»: la casella è stata vista,
    // e la risposta è sì oppure no. È la stessa distinzione per cui il `false`
    // viaggia nel payload invece di essere omesso.
    if (f.type === 'consent') {
      const dato = grezzo === true
      return {
        id: f.id,
        etichetta,
        valore: dato ? t('persRiepilogoSi') : t('persRiepilogoNo'),
        vuoto: false,
        mancante: obbligatorio && !dato,
      }
    }

    const testo = testoDelValore(f, grezzo)
    if (testo === null) {
      return {
        id: f.id,
        etichetta,
        valore: t('persRiepilogoNonIndicato'),
        vuoto: true,
        mancante: obbligatorio,
      }
    }
    return { id: f.id, etichetta, valore: testo, vuoto: false, mancante: false }
  }

  /**
   * Il riepilogo per intero, raggruppato come i passi che l'hanno prodotto.
   *
   * L'ordine e il contenuto vengono dalle stesse liste che disegnano i passi: non
   * c'è nessun elenco di campi scritto a mano, quindi non c'è nessun elenco che
   * possa restare indietro rispetto al template. LA SEDE È IN CIMA, col suo
   * «Modifica»: è la prima cosa da ricontrollare, perché è l'unica che decide DOVE
   * finiscono tutte le altre.
   */
  function gruppiRiepilogo(): GruppoRiepilogo[] {
    return [
      {
        passo: 'sede',
        titolo: t('persSede'),
        righe: [
          {
            id: 'scuola_id',
            etichetta: t('persRiepilogoSede'),
            // Il nome c'è ogni volta che l'elenco è arrivato, ed è l'unico modo
            // per cui il modulo comincia: senza elenco non si può nemmeno partire.
            valore: nomeSedeDecisa ?? t('persRiepilogoNonIndicato'),
            vuoto: nomeSedeDecisa === null,
            mancante: sedeDecisa === null,
          },
        ],
      },
      { passo: 'dati', titolo: t('persDati'), righe: CAMPI_DATI_RESI.map(rigaDelCampo) },
      { passo: 'residenza', titolo: t('persResidenza'), righe: CAMPI_RESIDENZA.map(rigaDelCampo) },
      { passo: 'documento', titolo: t('persDocumento'), righe: CAMPI_DOCUMENTO.map(rigaDelCampo) },
      {
        passo: 'consensi',
        titolo: t('persConsensiTitolo'),
        righe: CONSENSI_PERSONALE_FIELDS.map(rigaDelCampo),
      },
    ]
  }

  /**
   * «Modifica» dal riepilogo: si torna al passo indicato — e si ACCENDE il segno
   * del ritorno, che è ciò che rende il viaggio di andata e ritorno. È l'unico
   * posto che lo accende, ed è giusto che lo sia.
   */
  function vaiAlPasso(p: Passo): void {
    const dove = PASSI.indexOf(p)
    if (dove < 0) return
    setErroreInvio(null)
    setRitornoInterrotto(null)
    setRitornoAlRiepilogo(true)
    setIndice(dove)
  }

  const testata: Record<Passo, { icona: typeof MapPin; titolo: string; sotto: string }> = {
    sede: { icona: MapPin, titolo: t('persSede'), sotto: t('persSedeSub') },
    dati: { icona: UserRound, titolo: t('persDati'), sotto: t('persDatiSub') },
    residenza: { icona: MapPin, titolo: t('persResidenza'), sotto: t('persResidenzaSub') },
    documento: { icona: IdCard, titolo: t('persDocumento'), sotto: t('persDocumentoSub') },
    consensi: { icona: ShieldCheck, titolo: t('persConsensiTitolo'), sotto: t('persConsensiSottotitolo') },
    riepilogo: { icona: Check, titolo: t('persRiepilogo'), sotto: t('persRiepilogoSub') },
  }

  /**
   * Che cosa sta per succedere premendo il comando primario — e quindi come si
   * chiama e che icona porta. L'ordine dei rami NON è indifferente: `inCorso`
   * viene per primo perché l'ultimo passo è anche quello da cui si invia, e la
   * rotellina deve vincere sulla spunta.
   */
  const versoDelComando: ComandoAvanti['verso'] = inviando
    ? 'inCorso'
    : ultimo
      ? 'invio'
      : ritornoAlRiepilogo
        ? 'riepilogo'
        : 'avanti'
  /** L'etichetta segue il VERSO, e non una seconda catena di ternari sulle stesse variabili. */
  const etichettaDelComando: Record<ComandoAvanti['verso'], string> = {
    inCorso: t('persInvioInCorso'),
    invio: t('persInvia'),
    riepilogo: t('persTornaAlRiepilogo'),
    avanti: t('persAvanti'),
  }

  /**
   * La seconda riga del pannello d'errore, e si decide al RENDER, non al rifiuto:
   * «scegli la sede qui sopra» è vera quando l'elenco è arrivato, ed è un ordine
   * ineseguibile finché non lo è — cioè proprio nell'istante in cui il rifiuto
   * viene mostrato, visto che il ri-caricamento parte insieme al pannello.
   */
  const notaErrore =
    erroreInvio === null
      ? ''
      : erroreInvio.tipo === 'sede' && !sedeSceglibile
        ? t('persSedeRifiutataNotaAttesa')
        : erroreInvio.nota

  const messaggioCf = (errors[ID_CF] as { message?: string } | undefined)?.message
  const badgeParla = badgeHaQualcosaDaDire(esitoCoerenza)
  /** L'avviso sul documento si ripete sopra il bottone d'invio: vedi il riepilogo. */
  const scadenzaISO = stringa(vScadenza)

  return (
    <GuscioPubblico>
      <BarraAvanzamento indice={indice} totale={PASSI.length} />

      <ColonnaCentrale>
        {/* La riga di testa pubblica (ritorno + Alto Contrasto) arriva dalla
            pagina: è un componente server, e il suo posto è sopra il titolo. */}
        {intestazione}

        <div className="mb-6 mt-4">
          <h1 className="flex items-center gap-2 font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green sm:text-3xl lg:text-4xl">
            <IdCard className="h-6 w-6 shrink-0 sm:h-8 sm:w-8" aria-hidden="true" />
            {t('persTitolo')}
          </h1>
          <p className="mt-1 text-sm text-kidville-sub">{t('persSottotitolo')}</p>
          {!inviata && formaDecisa && (
            <ContatorePassi id={ID_PASSO_CONTATORE} indice={indice} totale={PASSI.length} />
          )}
        </div>

        {/* ⚠️ «TIENI IL DOCUMENTO A PORTATA DI MANO», E STA QUI.
            Sopra il primo campo, non al passo 4: chi scopre solo lì di doversi
            alzare a cercare la carta d'identità chiude la scheda, e con essa se ne
            vanno tre passi già compilati (qui non c'è nessuna bozza da riprendere
            — vedi il punto 4 in testa al file).
            Sparisce quando si arriva al passo del documento, dove il documento è
            in mano e la riga diventa rumore: un pannello che segnala tutto non
            segnala niente. */}
        {!inviata && formaDecisa && indice < PASSI.indexOf('documento') && (
          <div className="mb-6 flex items-start gap-2 rounded-card border border-kidville-info bg-kidville-info-soft px-4 py-3">
            <IdCard className="mt-0.5 h-4 w-4 shrink-0 text-kidville-info-strong" aria-hidden="true" />
            {/* ── IL TETTO È IN REM, E IL NUMERO È QUELLO MISURATO ───────────
                Questa riga deve essere LETTA, non solo mostrata: è ciò che
                evita l'abbandono al passo 4. Senza tetto, da 1024 px in su i
                122 caratteri finivano su UNA riga sola — MISURATO con un
                `Range` carattere per carattere sulla pagina viva (WebKit):
                44·44·34 a 360, 94/28 a 640, 102/20 a 768, e 122 su una riga
                a 1024, 1280 e 1440, con il paragrafo largo 678 px. A 12 px
                una riga di 122 caratteri è la lunghezza su cui l'occhio perde
                il capo della riga successiva.
                Il numero qui sotto è misurato DOPO, non sperato — è la lezione
                di `FieldRenderer.tsx:330-343`, dove `max-w-[60ch]` prometteva
                60 e ne rendeva 87 (`ch` è la larghezza dello ZERO). Provati
                sulla stessa pagina: 384 px → 70 · 400 → 70 · **416 → 75** ·
                432 → 78. 26rem = 416 px = 75 caratteri per riga, il limite
                dichiarato. */}
            <p className="max-w-[26rem] text-xs font-semibold leading-relaxed text-kidville-info-strong">
              {t('persDocumentoAPortata')}
            </p>
          </div>
        )}

        {nonPuoCominciare ? (
          /*
           * NON C'È NESSUNA SEDE A CUI CONSEGNARE — e lo si dice.
           * Due cause, due frasi, un solo pannello: l'elenco NON è arrivato
           * (guasto → si riprova) oppure è arrivato ed è VUOTO (niente da
           * ricaricare → si scrive alla segreteria). Dire «non riusciamo a
           * caricare le sedi» quando l'elenco è arrivato manda a controllare una
           * connessione che non ha nessun problema.
           */
          <div role="alert" className="flex flex-col items-center gap-4 py-10">
            <div className="w-full rounded-card border border-kidville-error bg-kidville-error-soft px-5 py-4 text-left">
              <h2 className="flex items-center gap-2 text-base font-semibold text-kidville-error-strong">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {sediVuote ? t('persSediVuoteTitolo') : t('persSediErroreTitolo')}
              </h2>
              {/* Il tetto di larghezza vale per OGNI prosa di questa pagina, non
                  solo per quella misurata: qui il corpo è a 14 px, e 29rem =
                  464 px sono i 74 caratteri già misurati su un testo della
                  stessa taglia (il corpo dei consensi, `FieldRenderer`). */}
              <p className="mt-1.5 max-w-[29rem] text-sm leading-relaxed text-kidville-ink">
                {sediVuote ? t('persSediVuoteCorpo') : t('persSediErroreCorpo')}
              </p>
            </div>
            {/* «Riprova» SOLO per il guasto: su un elenco vuoto ricaricare darebbe
                la stessa risposta, e un pulsante che ripete la stessa risposta
                insegna a non fidarsi dei pulsanti. */}
            {!sediVuote && (
              <button
                type="button"
                onClick={riprovaSedi}
                /* ⚠️ `py-3` = 44 px, come «Avanti» — e qui vale di più che là.
                   Questo è l'UNICO comando della schermata: il modulo non è
                   ancora cominciato, non c'è nient'altro da toccare, e chi lo
                   manca col pollice non ha un secondo bersaglio su cui ricadere.
                   MISURATO dal critico visivo a 360 px: era 117×40, quattro sotto
                   la misura che il resto del modulo si è già dato — la stessa
                   ragione, e le stesse quattro pixel, del commento di
                   `ComandiWizard`. */
                className="flex items-center gap-2 rounded-pill bg-kidville-green px-6 py-3 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-yellow-ink transition-all hover:bg-kidville-green-dark"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {t('persSediRiprova')}
              </button>
            )}
          </div>
        ) : !formaDecisa ? (
          // Attesa dell'elenco. È annunciata, perché un'attesa muta è
          // indistinguibile da una pagina rotta per chi non vede la rotellina.
          <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
            <Loader2 className="h-6 w-6 animate-spin text-kidville-green" aria-hidden="true" />
            <span className="sr-only">{t('persCaricamento')}</span>
          </div>
        ) : inviata ? (
          <PannelloConferma
            titolo={t('persInviata')}
            corpo={t('persInviataCorpo')}
            riferimento={confermaRef}
          />
        ) : (
          <GrigliaPasso
            contenuto={
              /*
               * ── SEGNO_DI_SPORCO ────────────────────────────────────────────
               * L'`onChange` sta sul contenitore e non su ogni campo, e non è una
               * scorciatoia: React normalizza `change` perché BOLLA, quindi un
               * gestore qui vede ogni modifica dei discendenti — i campi di
               * `FieldRenderer`, la tendina a cascata del luogo di nascita, la
               * casella del file — senza che nessuno debba ricordarsi di
               * agganciarlo campo per campo il giorno in cui ne aggiunge uno.
               * Ed è l'unico modo rimasto: `watch()` di react-hook-form è vietato
               * dal gate (`react-hooks/incompatible-library`), e `formState.isDirty`
               * non è affidabile senza `defaultValues` dichiarati per ogni campo.
               *
               * Non accende niente a schermo: scrive un `ref` che serve solo a
               * `beforeunload`. Il `<div>` non porta classi, quindi non tocca
               * l'impaginatura del guscio.
               */
              <div
                onChange={() => {
                  sporco.current = true
                }}
              >
                <TestataPasso
                  icona={testata[passo].icona}
                  titolo={testata[passo].titolo}
                  sotto={testata[passo].sotto}
                  titoloRef={titoloPassoRef}
                  contatoreId={ID_PASSO_CONTATORE}
                />

                {/* IL RITORNO AL RIEPILOGO SI È DOVUTO FERMARE QUI, E LO DICE.
                    `role="alert"` e non `status`: è la ragione per cui il comando
                    non ha fatto ciò che c'era scritto sopra. Il colore è quello
                    dell'AVVISO e non dell'errore — il dato che manca ha già il suo
                    rosso sotto il campo che lo chiede, e due rossi sulla stessa
                    schermata direbbero che i problemi sono due. */}
                {ritornoInterrotto !== null && (
                  <div
                    role="alert"
                    className="mb-5 rounded-card border border-kidville-warn bg-kidville-warn-soft px-4 py-3"
                  >
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-kidville-warn-strong">
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {t('persRitornoInterrottoTitolo')}
                    </h3>
                    <p className="mt-1 max-w-[26rem] text-xs leading-relaxed text-kidville-ink">
                      {t('persRitornoInterrottoCorpo', { passo: testata[ritornoInterrotto].titolo })}
                    </p>
                  </div>
                )}

                {/* IL PASSO «SEDE» PORTA ANCHE LE NOTIZIE SULL'ELENCO: ci si
                    arriva dall'apertura (elenco già pronto) oppure dopo un rifiuto
                    del server, e allora l'elenco si sta ricaricando adesso. Nel
                    secondo caso attesa, guasto ed elenco vuoto si dicono QUI
                    DENTRO, accanto al modulo compilato, invece di sostituire
                    l'intera pagina e portarselo via. */}
                {passo === 'sede' && statoSedi === 'caricamento' && (
                  <div className="flex items-center justify-center gap-2 py-8" role="status" aria-live="polite">
                    <Loader2 className="h-5 w-5 animate-spin text-kidville-green" aria-hidden="true" />
                    <span className="text-sm text-kidville-sub">{t('persCaricamento')}</span>
                  </div>
                )}

                {passo === 'sede' && statoSedi === 'errore' && (
                  <div className="space-y-3">
                    <div role="alert" className="rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {t('persSediErroreTitolo')}
                      </h3>
                      <p className="mt-1 max-w-[26rem] text-xs leading-relaxed text-kidville-ink">
                        {t('persSediErroreCorpo')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={riprovaSedi}
                      /* `py-3` = 44 px: stesso bersaglio dell'altro «Riprova» e
                         di «Avanti». Era 109×36, il più piccolo della schermata. */
                      className="flex items-center gap-2 rounded-pill bg-kidville-green px-5 py-3 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-yellow-ink transition-all hover:bg-kidville-green-dark"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                      {t('persSediRiprova')}
                    </button>
                  </div>
                )}

                {passo === 'sede' && elencoPronto && sedi.length === 0 && (
                  <div role="alert" className="rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {t('persSediVuoteTitolo')}
                    </h3>
                    <p className="mt-1 max-w-[26rem] text-xs leading-relaxed text-kidville-ink">
                      {t('persSediVuoteCorpo')}
                    </p>
                  </div>
                )}

                {passo === 'sede' && sedeSceglibile && (
                  <fieldset
                    className="space-y-3"
                    /* Il messaggio del gruppo è legato al GRUPPO, come lo lega
                       `FieldRenderer` ai suoi: chi ascolta sente la frase quando
                       entra nella scelta, non solo quando l'`alert` viene
                       annunciato. */
                    aria-describedby={erroreSede ? ID_ERRORE_SEDE : undefined}
                  >
                    <legend className="sr-only">{t('persSedeLegenda')}</legend>
                    {sedi.map((s, i) => {
                      const scelta = sedeScelta === s.id
                      return (
                        <label
                          key={s.id}
                          htmlFor={`pers-sede-${s.id}`}
                          /* La grafica della card di scelta è quella di
                             `FieldRenderer` (`SCELTA_LIBERA`/`SCELTA_PRESA`), e i
                             tre token dell'errore sono i suoi: stesso rosso,
                             stesso peso. `data-scelta-invalida` è il gancio con cui
                             `globals.css` dà alla card il bordo DOPPIO in Alto
                             Contrasto, dove ogni contorno diventa nero e il rosso
                             semplicemente non esiste più.
                             Il peso del bordo sta nello STATO e non nella
                             struttura: fra `border` e `border-[1.5px]` sullo stesso
                             elemento vince quella che sta più avanti nel FOGLIO,
                             non quella scritta dopo nella stringa. */
                          {...(erroreSede && !scelta ? { 'data-scelta-invalida': 'true' } : {})}
                          className={`flex cursor-pointer items-start gap-3 rounded-card px-4 py-4 transition-all ${
                            scelta
                              ? 'border border-kidville-green bg-kidville-green-soft'
                              : erroreSede
                                ? 'border-[1.5px] border-kidville-error bg-kidville-white'
                                : 'border border-kidville-neutral bg-kidville-white hover:border-kidville-green'
                          }`}
                        >
                          <input
                            type="radio"
                            id={`pers-sede-${s.id}`}
                            name="pers-sede"
                            value={s.id}
                            ref={i === 0 ? primoRadioRef : undefined}
                            checked={scelta}
                            onChange={() => {
                              scegliSede(s.id)
                              // Scegliere È la risposta all'avviso: si spegne qui,
                              // non al prossimo invio.
                              setErroreSede(false)
                              setErroreInvio(null)
                            }}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-kidville-green"
                          />
                          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-kidville-green" aria-hidden="true" />
                          {/* ⚠️ IL NOME DEL PLESSO **E** LA CITTÀ, e non è
                              ridondanza: Aversa e Cesa distano sei chilometri, e
                              chi lavora in una conosce l'altra. Un elenco di tre
                              righe che si distinguono per una parola sola si
                              sbaglia, e sbagliarlo qui significa consegnare il
                              proprio documento d'identità alla segreteria di
                              un'altra sede.
                              La città NON viene da una tabella scritta qui: è
                              dentro il nome che serve l'elenco pubblico
                              («Kidville Aversa»), e una seconda fonte sarebbe la
                              solita seconda lista da tenere allineata. Quando il
                              nome basta a sé, la riga sotto non compare affatto. */}
                          <span className="min-w-0">
                            <span className={`block text-base text-kidville-green ${scelta ? 'font-bold' : 'font-semibold'}`}>
                              {s.nome}
                            </span>
                            {cittaDelPlesso(s.nome) !== null && (
                              <span className="mt-0.5 block text-xs text-kidville-sub">
                                {cittaDelPlesso(s.nome)}
                              </span>
                            )}
                          </span>
                        </label>
                      )
                    })}
                    {/* L'ERRORE DEL GRUPPO STA SOTTO IL GRUPPO, come ogni
                        messaggio di campo di `FieldRenderer`, e il fuoco va sul
                        primo radio — cioè dentro il gruppo che la frase descrive. */}
                    {erroreSede && (
                      <p
                        id={ID_ERRORE_SEDE}
                        role="alert"
                        className="flex items-center gap-1.5 text-xs font-bold text-kidville-error-strong"
                      >
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {t('persSedeErrore')}
                      </p>
                    )}
                  </fieldset>
                )}

                {/* ⚠️ L'ORDINE DEI CAMPI È QUELLO DEL TEMPLATE, e non «prima gli
                    ordinari e poi quelli speciali»: `PERSONALE_FIELDS` dichiara che
                    il suo ordine È l'ordine in cui i campi compaiono nel modulo, e
                    raggruppare per modo-di-rendere spezzerebbe la sequenza —
                    «Cittadinanza» prima del comune di nascita, il codice fiscale in
                    fondo dopo le fasce d'età. Qui si scorre l'elenco una volta sola
                    e si decide campo per campo CHI lo rende. */}
                {passo === 'dati' && (
                  <div className="space-y-6">
                    {CAMPI_DATI.map((f) => {
                      // I tre derivati dalla tendina non hanno un campo proprio:
                      // li scrive `LuogoNascitaFields`, che compare al posto del
                      // codice catastale (l'unico obbligatorio dei quattro).
                      if (f.id !== ID_BELFIORE && NON_REGISTRATI.has(f.id)) return null

                      if (f.id === ID_BELFIORE) {
                        return (
                          /* IL LUOGO DI NASCITA È UNA TENDINA A CASCATA, non tre
                             caselle di testo: da un comune scritto a mano il codice
                             fiscale non si verifica (omonimie fra province, comuni
                             soppressi, refusi), e senza il codice catastale il badge
                             qui sotto direbbe «non verificabile» su ogni riga.
                             Il dataset dei 13.656 comuni NON entra nel bundle: si
                             passa da `/api/anagrafiche/comuni`, e c'è un lock che lo
                             verifica. */
                          <LuogoNascitaFields
                            key={f.id}
                            valore={luogoNascita}
                            onChange={cambiaLuogoNascita}
                            idPrefisso={ID_PREFISSO_NASCITA}
                            /* ⚠️ OBBLIGATORI TUTTI E DUE, e la provincia lo è
                               anche se il template la dichiara `required: false`.
                               L'obbligo qui non è del DATO ma del PERCORSO: la
                               tendina del comune resta spenta finché la provincia
                               non è scelta, quindi senza provincia il codice
                               catastale — che È obbligatorio, ed è la ragione per
                               cui il codice fiscale si verifica da solo — non si
                               può produrre affatto. Fino al 12/08/2026
                               l'etichetta «Provincia di nascita» non aveva
                               asterisco, e l'asterisco è l'UNICA convenzione con
                               cui questa pagina dice «questo è obbligatorio»: la
                               persona scopriva l'obbligo solo quando «Avanti»
                               falliva — e allora il messaggio finiva su un campo
                               che non poteva nemmeno raggiungere. */
                            obbligatori={{ provincia: f.required === true, comune: f.required === true }}
                            errori={{
                              // I due messaggi vengono da UNA sola sorgente: la
                              // cascata ha un guasto solo, e `bersaglioDelCampo`
                              // ha già deciso su quale dei due controlli posarlo
                              // (quello abilitato adesso). Le due letture qui
                              // sotto non si sovrappongono mai.
                              provincia: (errors[ID_PROVINCIA_NASCITA] as { message?: string } | undefined)?.message,
                              comune: (errors[ID_BELFIORE] as { message?: string } | undefined)?.message,
                            }}
                          />
                        )
                      }

                      if (f.id === ID_CF) {
                        return (
                          /* IL CODICE FISCALE, reso a mano — e l'unica ragione è
                             `aria-describedby`: `FieldRenderer` non accetta
                             descrittori aggiuntivi, e senza il legame col badge chi
                             usa uno screen reader non sentirebbe mai che il codice
                             appena scritto contraddice la data di nascita. Le classi
                             sono IMPORTATE (`FIELD_BASE`/`FIELD_BASE_ERRORE`), non
                             riscritte: sono le stesse di ogni altro campo, bordo
                             d'errore compreso. */
                          <div key={f.id} className="space-y-2">
                            <label
                              htmlFor={ID_CF}
                              className="flex items-center gap-1.5 text-sm font-medium text-kidville-green/80"
                            >
                              <Fingerprint className="h-4 w-4 shrink-0" aria-hidden="true" />
                              {f.label}
                              {f.required && <span className="text-kidville-green">*</span>}
                            </label>
                            <input
                              id={ID_CF}
                              type="text"
                              autoCapitalize="characters"
                              placeholder={f.placeholder}
                              className={`${messaggioCf ? FIELD_BASE_ERRORE : FIELD_BASE} uppercase`}
                              {...(messaggioCf ? { 'aria-invalid': true } : {})}
                              /* ⚠️ IL BADGE SI AGGANCIA SOLO SE HA QUALCOSA DA DIRE.
                                 `BadgeCoerenzaCf` ritorna `null` quando tace — ed è
                                 lo stato ORDINARIO di un campo appena aperto —
                                 quindi un `aria-describedby` fisso punterebbe a un
                                 elemento inesistente: uno screen reader annuncia un
                                 campo che rimanda a una descrizione che non c'è, e
                                 lo fa in silenzio. La condizione vive in
                                 `badgeHaQualcosaDaDire` e non si riscrive qui. */
                              aria-describedby={
                                [messaggioCf ? ID_ERRORE_CF : null, badgeParla ? ID_BADGE_CF : null]
                                  .filter((x): x is string => x !== null)
                                  .join(' ') || undefined
                              }
                              {...register(ID_CF, {
                                validate: (v: unknown) => validateField(f, v) ?? true,
                              })}
                            />
                            {messaggioCf && (
                              <p
                                id={ID_ERRORE_CF}
                                role="alert"
                                className="flex items-center gap-1.5 text-xs font-bold text-kidville-error-strong"
                              >
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                {messaggioCf}
                              </p>
                            )}
                            {/* Segnala e PROPONE, non decide: «Usa questo» compila
                                il campo E NULLA PIÙ — non invia, non avanza, non
                                salva. E il badge non ha nessuna voce su «Avanti»: a
                                fermarlo resta `validateField`, la stessa regola che
                                il server rigira. */}
                            <BadgeCoerenzaCf
                              esito={esitoCoerenza}
                              id={ID_BADGE_CF}
                              onUsaCalcolato={(codice) =>
                                setValue(ID_CF, codice, { shouldValidate: true, shouldDirty: true })
                              }
                            />
                          </div>
                        )
                      }

                      return (
                        <FieldRenderer
                          key={f.id}
                          field={f}
                          modelId={MODELLO}
                          register={register}
                          control={control}
                          error={errors[f.id]}
                        />
                      )
                    })}
                  </div>
                )}

                {passo === 'residenza' && (
                  <div className="space-y-6">
                    {CAMPI_RESIDENZA.map((f) => (
                      <FieldRenderer
                        key={f.id}
                        field={f}
                        modelId={MODELLO}
                        register={register}
                        control={control}
                        error={errors[f.id]}
                      />
                    ))}
                  </div>
                )}

                {passo === 'documento' && (
                  <DocumentoIdentitaFields
                    register={register}
                    control={control}
                    errori={errors}
                    idPrefisso="pers-documento"
                    oggi={giornoDiOggi}
                    uploadEndpoint={ROTTA_CARICAMENTO}
                    modelId={MODELLO}
                  />
                )}

                {passo === 'consensi' && (
                  <div className="space-y-3">
                    {CONSENSI_PERSONALE_FIELDS.map((f) => (
                      <FieldRenderer
                        key={f.id}
                        field={f}
                        modelId={MODELLO}
                        register={register}
                        control={control}
                        error={errors[f.id]}
                      />
                    ))}
                  </div>
                )}

                {passo === 'riepilogo' && (
                  <div className="space-y-4">
                    {gruppiRiepilogo().map((g) => (
                      <div
                        key={g.passo}
                        className="rounded-card border border-kidville-line bg-kidville-white px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-3 border-b border-kidville-line pb-2">
                          <h3
                            id={`pers-riepilogo-titolo-${g.passo}`}
                            className="font-barlow text-base font-bold uppercase tracking-wide text-kidville-green"
                          >
                            {g.titolo}
                          </h3>
                          {/* Il nome accessibile porta il GRUPPO — «Modifica La tua
                              sede» — perché cinque comandi chiamati tutti «Modifica»
                              sono, per chi li ascolta in fila, cinque volte la
                              stessa cosa. Si compone con `aria-labelledby` che punta
                              al bottone STESSO e poi al titolo del gruppo: nessuna
                              chiave in più da tradurre, e il nome resta giusto anche
                              il giorno in cui il titolo cambia. */}
                          <button
                            type="button"
                            id={`pers-riepilogo-modifica-${g.passo}`}
                            aria-labelledby={`pers-riepilogo-modifica-${g.passo} pers-riepilogo-titolo-${g.passo}`}
                            onClick={() => vaiAlPasso(g.passo)}
                            /* `py-3.5`: 28 px di riempimento + 16 px di riga = 44 px,
                               l'altezza raccomandata per un pollice. Su telefono
                               questi comandi sono l'UNICO modo di correggere prima
                               di inviare. */
                            className="shrink-0 rounded-pill px-3 py-3.5 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green underline transition-all hover:bg-kidville-green-soft"
                          >
                            {t('persRiepilogoModifica')}
                          </button>
                        </div>
                        {/* Non è una `<dl>`: `dl` ammette come contenuto solo coppie
                            `dt`/`dd`, e axe lo verifica con la regola
                            `definition-list`. Qui le righe sono due `<p>`. */}
                        <div className="divide-y divide-kidville-line">
                          {g.righe.map((r) => (
                            <div key={r.id} className="py-2">
                              <p className="text-xs font-semibold uppercase tracking-wide text-kidville-sub">
                                {r.etichetta}
                              </p>
                              {/* `wrap-anywhere` SUL VALORE: a 360 px la scatola del
                                  valore è larga 294 px, e un indirizzo email di
                                  scuola ne occupa 313 — il testo scavalcava il bordo
                                  e l'INTERA pagina si trascinava di lato. Vale per
                                  ogni valore, non solo per l'email: comune di
                                  residenza e dettaglio del titolo sono testo libero. */}
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

                    {/* ⚠️ L'AVVISO SULLA SCADENZA SI RIPETE QUI, SOPRA IL BOTTONE.
                        Non è una ripetizione decorativa: il riquadro accanto al
                        campo si legge mentre si scrive la data, tre passi prima, e
                        il riepilogo è l'unico punto in cui si rilegge tutto insieme
                        prima di consegnare. Chi arriva qui con un documento scaduto
                        deve saperlo NEL momento in cui preme «Invia», così sa già
                        che la segreteria gli chiederà quello rinnovato — e non
                        scopre di aver consegnato un documento non valido dopo.
                        È lo stesso componente, montato una seconda volta: due
                        formulazioni della stessa avvertenza divergono alla prima
                        modifica. */}
                    <AvvisoScadenzaDocumento scadenzaISO={scadenzaISO} oggi={giornoDiOggi} />

                    {/* ── IL TETTO ANCHE QUI, ED È L'ULTIMA COSA CHE SI LEGGE ────
                        MISURATE a 1440 px con un `Range` sui nodi di testo:
                        «Rileggi il codice fiscale e la scadenza…» **106**
                        caratteri per riga, «Premi «Invia l'anagrafica» per
                        trasmettere…» **114**. Sono le due righe che stanno fra
                        chi ha compilato trentadue campi e un invio
                        irreversibile: una dice COSA ricontrollare, l'altra cosa
                        succede dopo. 26rem = 416 px = 75 caratteri, la misura
                        già fatta sul banner del documento in questa pagina. */}
                    <p className="max-w-[26rem] text-xs font-semibold leading-relaxed text-kidville-green">
                      {t('persRiepilogoControlla')}
                    </p>
                    <p className="max-w-[26rem] text-xs leading-relaxed text-kidville-sub">
                      {t('persRiepilogoNota')}
                    </p>
                  </div>
                )}

                {/* L'esca deve esistere in OGNI passo, e per questo sta dentro il
                    contenuto invece che accanto ai comandi: react-hook-form
                    conserva i valori dei campi smontati, ma un campo che non viene
                    montato MAI non è registrato affatto e l'esca non scatterebbe. */}
                <EscaHoneypot
                  nome={CAMPO_ESCA}
                  etichetta={t('persEscaEtichetta')}
                  register={register}
                />
              </div>
            }
            comandi={
              <>
                {erroreInvio !== null && (
                  <PannelloErroreInvio
                    titolo={t('persErroreInvioTitolo')}
                    corpo={erroreInvio.corpo}
                    nota={notaErrore}
                    riferimento={pannelloErroreRef}
                  />
                )}
                <ComandiWizard
                  indietro={
                    indice > 0
                      ? { etichetta: t('persIndietro'), onClick: indietro, disabilitato: inviando }
                      : null
                  }
                  avanti={{
                    etichetta: etichettaDelComando[versoDelComando],
                    onClick: avanti,
                    /* Nel passo «sede» senza un elenco da cui scegliere il comando
                       non porta da nessuna parte: premerlo risponderebbe soltanto
                       «Scegli la sede» davanti a zero sedi. Ciò che si può fare
                       adesso — riprovare l'elenco — sta qui sopra. */
                    disabilitato: inviando || (passo === 'sede' && !sedeSceglibile),
                    verso: versoDelComando,
                  }}
                />
              </>
            }
            contesto={
              <ColonnaContesto
                titolo={t('persContestoTitolo')}
                voci={[
                  t('persContestoApprovazione'),
                  t('persContestoDocumento'),
                  t('persContestoScadenza'),
                ]}
              />
            }
          />
        )}
      </ColonnaCentrale>
    </GuscioPubblico>
  )
}

/**
 * LA CITTÀ DEL PLESSO, ricavata dal suo NOME — oppure `null` se il nome non ne
 * dichiara una.
 *
 * ⚠️ Non è una tabella di sedi, ed è deliberato: una tabella qui sarebbe la
 * seconda fonte di verità sui plessi, quella che nessuno aggiorna il giorno in
 * cui ne apre un quarto. I nomi veri sono «Kidville Giugliano», «Kidville
 * Aversa», «Kidville Cesa» — il marchio e poi il comune — e la seconda riga della
 * card serve a rendere la CITTÀ leggibile come tale invece che come una parola
 * qualsiasi attaccata al marchio.
 *
 * Quando il nome è una parola sola («Kidville»), oppure quando non c'è niente
 * dopo il marchio, la riga non compare affatto: meglio nessuna riga che una riga
 * vuota, ed è la stessa regola con cui il riepilogo non scrive un uuid al posto
 * di un nome che non conosce.
 */
export function cittaDelPlesso(nome: string): string | null {
  const pulito = (nome ?? '').trim().replace(/\s+/g, ' ')
  const spazio = pulito.indexOf(' ')
  if (spazio < 0) return null
  const coda = pulito.slice(spazio + 1).trim()
  return coda === '' ? null : coda
}
