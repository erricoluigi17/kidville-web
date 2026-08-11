'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useForm, type FieldValues } from 'react-hook-form'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, GraduationCap, Loader2,
  MapPin, PartyPopper, RefreshCw, ShieldCheck, UserRound,
} from 'lucide-react'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import {
  INSEGNANTE_FIELDS, CONSENSI_INSEGNANTI_FIELDS, GRADI_OPTIONS,
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
 * ── LA FORMA È COPIATA DA `EnrollmentWizard`, NON REINVENTATA ───────────────
 *
 * Ogni pezzo dell'impianto delle SEDI qui sotto esiste perché un difetto è
 * arrivato in produzione sul modulo fratello, ed è ripetuto pezzo per pezzo:
 *
 *   · `!r.ok` NON è un'eccezione. Il `catch` di una promise non scatta su un
 *     429, e fino al 2026-08-02 il rate-limit di `/api/iscrizione/sedi` passava
 *     in silenzio: l'elenco restava vuoto, «vuoto» valeva «una sede sola», e la
 *     domanda partiva per non poter essere inviata;
 *   · un 200 con un corpo SENZA l'array `data` non è «nessuna sede»: è «elenco
 *     non ottenuto». `null` non è `[]`, e confonderli è lo stesso difetto con
 *     un'altra faccia;
 *   · un elenco VUOTO non è «una sede sola, vai avanti». Qui pesa ancora di più
 *     che sull'iscrizione: `POST /api/iscrizione/insegnanti` pretende
 *     `scuola_id` come uuid OBBLIGATORIO — è più severo della rotta sorella, e
 *     giustamente, perché con tre plessi dedurre la sede vuol dire archiviare la
 *     candidatura nel posto sbagliato in silenzio. Senza sede non c'è nessun
 *     invio possibile, quindi il modulo non comincia;
 *   · finché la FORMA della procedura non è definitiva non si dipinge NESSUN
 *     passo. Dipingerne uno e cambiarlo dopo è ciò che congelava il wizard
 *     fratello, e comunque farebbe saltare sotto le mani il passo su cui si sta
 *     scrivendo.
 *
 * ── PERCHÉ `?sede=` NON BASTA, E L'ELENCO SI CHIEDE COMUNQUE ────────────────
 *
 * Fino al 2026-08-11 un link «targato» (`/lavora-con-noi?sede=<uuid>`) faceva
 * saltare del tutto la fetch dell'elenco: la sede era «già decisa», `mostraSede`
 * restava false per sempre e nessun passo di scelta poteva esistere. Misurato
 * percorrendo il modulo per intero con un uuid che la rotta non accetta:
 * riepilogo «Sede scelta —», e all'invio il 400 `SEDE_DA_SPECIFICARE`, cioè
 * «Specificare la sede a cui si riferisce questa operazione» seguito dall'invito
 * a ripremere «Invia candidatura» — un ordine che l'interfaccia non permetteva
 * di eseguire (zero `radio` in pagina) e un bottone che avrebbe ripetuto la
 * stessa risposta per sempre. Esattamente le due cose che questo file condanna
 * più sotto.
 *
 * E un uuid che la rotta non accetta NON è un caso di scuola: `POST
 * /api/iscrizione/insegnanti` valida `scuola_id` contro `sediReali`, che applica
 * `scuole.attiva` ed esclude la sede di collaudo. Un plesso soft-deleted, la
 * sede E2E, un volantino stampato l'anno prima, un uuid ritoccato a mano: quattro
 * strade per lo stesso vicolo cieco.
 *
 * Adesso l'elenco è l'AUTORITÀ e si chiede sempre; `?sede=` è un suggerimento
 * che vale solo se l'elenco lo conferma:
 *
 *   · elenco ottenuto e il link c'è dentro → nessun passo di scelta (com'era), e
 *     in più il riepilogo può dire il NOME del plesso invece di un trattino;
 *   · elenco ottenuto e il link NON c'è dentro → il link si abbandona PRIMA che
 *     sia stato compilato alcunché, e il passo «sede» torna al suo posto: chi
 *     apre il volantino vecchio sceglie, e non se ne accorge nemmeno;
 *   · elenco NON ottenuto (429, rete giù, corpo strano) → il link si tiene e il
 *     modulo parte lo stesso. È la proprietà che il ramo precedente proteggeva e
 *     che resta vera: nessun guasto dell'elenco può impedire una candidatura;
 *   · e se in quel caso il server rifiuta comunque con `SEDE_DA_SPECIFICARE`
 *     (link davvero morto, oppure plesso disattivato mentre si compilava), il
 *     rifiuto è AZIONABILE: si abbandona il link, si richiede l'elenco, il passo
 *     «sede» ricompare davanti e i dati restano dove sono — react-hook-form
 *     conserva i valori dei campi smontati (`shouldUnregister` è false).
 *
 * ── E DOPO IL RIFIUTO IL MODULO NON SI SMONTA PIÙ, QUALUNQUE COSA DICA L'ELENCO
 *
 * La rete residua qui sopra, scritta l'11/08/2026, non copriva il caso per cui
 * era nata. `sedeSmentitaDalServer()` richiede l'elenco, e finché quella
 * richiesta è in volo la forma dei passi tornava «non decisa»: il ramo dei passi
 * — l'UNICO che contiene il pannello `erroreInvio` — veniva smontato, e se il
 * ri-caricamento falliva di nuovo si cadeva sulla schermata «Non riusciamo a
 * caricare le sedi / Controlla la connessione». MISURATO sullo scenario esatto
 * (`?sede=` morto + elenco illeggibile): messaggio della sede rifiutata in
 * pagina, `false`; pannello generico delle sedi, `true`.
 *
 * E non è il caso raro: la causa documentata per cui il link viene creduto è il
 * 429 di `/api/iscrizione/sedi`, che dura DIECI MINUTI — il tentativo che parte
 * subito dopo il rifiuto cade quasi certamente nella stessa finestra. Chi aveva
 * compilato quattro passi leggeva una schermata che non diceva che l'invio era
 * fallito, non nominava la sede del collegamento, dava la colpa a una
 * connessione che non ne aveva, e offriva un bottone destinato a ripetere lo
 * stesso errore fino allo scadere del tetto.
 *
 * Da qui in avanti vale una regola sola, ed è `sedeRifiutata !== null`: quando il
 * server ha rifiutato la sede, il modulo è GIÀ COMINCIATO ed è già compilato. La
 * forma dei passi resta decisa (il passo «sede» ci sarà comunque), e le tre
 * notizie sull'elenco — attesa, guasto, elenco vuoto — si danno DENTRO il passo
 * «sede», accanto al pannello del rifiuto, invece che al posto dell'intera
 * pagina. Nessun esito del ri-caricamento può più far sparire ciò che si è
 * scritto, né la spiegazione di ciò che è successo.
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
 * ── ⚠️ LIMITE NOTO: CON L'INTERFACCIA IN INGLESE LA PAGINA È TRADOTTA A METÀ ─
 *
 * Il GUSCIO di questa schermata è bilingue e lo è per davvero (36 chiavi `cand*`
 * in `messages/it` e `messages/en`, sorvegliate dal lock di parità): titoli dei
 * passi, bottoni, errori, conferma. Le ETICHETTE DEI CAMPI no: arrivano da
 * `INSEGNANTE_FIELDS` e sono cablate in italiano — «Per quali fasce ti proponi»,
 * «Titolo di studio», «Presentati in poche righe», i sette `TITOLI_STUDIO`, le
 * cinque `DISPONIBILITA`, e i tre `GRADI_OPTIONS` che anche il riepilogo
 * ristampa così come sono (`fasceScelte()`).
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
/** Da dove si legge l'elenco pubblico dei plessi (lo stesso di `/iscrizione`). */
const ROTTA_SEDI = '/api/iscrizione/sedi'

/**
 * Stato dell'elenco sedi. Sono TRE, e il difetto nasceva dall'averne due:
 * «elenco vuoto» e «elenco non ottenuto» finivano nella stessa variabile, e
 * `sedi.length` non poteva distinguerli.
 */
type StatoSedi = 'caricamento' | 'pronto' | 'errore'

interface Sede {
  id: string
  nome: string
}

/** I passi possibili. Il primo esiste solo quando c'è davvero da scegliere. */
type Passo = 'sede' | 'dati' | 'profilo' | 'consensi' | 'riepilogo'

/**
 * Estrae `[{ id, nome }]` dalla risposta di `/api/iscrizione/sedi`, scartando le
 * voci di forma inattesa.
 *
 * `null` = **elenco NON ottenuto** (il corpo non contiene affatto un array
 * `data`), che NON è la stessa cosa di un elenco vuoto: `[]` è una risposta
 * valida — è ciò che risponde il database della CI — e va detta con la sua
 * frase; `null` è un guasto, e si può riprovare.
 */
function sediValide(payload: unknown): Sede[] | null {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  return data
    .filter(
      (s): s is Sede =>
        s !== null && typeof s === 'object' &&
        typeof (s as Sede).id === 'string' && (s as Sede).id.length > 0 &&
        typeof (s as Sede).nome === 'string' && (s as Sede).nome.length > 0,
    )
    .map((s) => ({ id: s.id, nome: s.nome }))
}

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
 * Il corpo JSON di una risposta, senza mai lanciare e senza mai tacere.
 *
 * Non si usa `.catch(() => null)`: un `catch` che non logga è un bug (AGENTS.md,
 * regola 6), e qui il caso vero esiste — un 500 di piattaforma senza corpo, o
 * l'HTML di un proxy. Il livello è `warn` perché il fatto è «il server ha
 * risposto e non l'abbiamo capito», che è diverso dal guasto vero e proprio.
 */
async function corpoDellaRisposta(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch (err) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `candidatura-corpo-illeggibile: ${nomeErrore(err)}`,
      stato: res.status,
    })
    return null
  }
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
  /** L'uuid arrivato dal link, normalizzato. È un SUGGERIMENTO, non una decisione. */
  const sedeLink = sedeId !== null && sedeId.trim().length > 0 ? sedeId.trim() : null

  const [sedi, setSedi] = useState<Sede[]>([])
  const [statoSedi, setStatoSedi] = useState<StatoSedi>('caricamento')
  /** Cambia a ogni «Riprova»: è ciò che fa ripartire la fetch dell'elenco. */
  const [tentativoSedi, setTentativoSedi] = useState(0)
  const [sedeScelta, setSedeScelta] = useState<string | null>(null)
  const [erroreSede, setErroreSede] = useState(false)
  /**
   * La sede che il SERVER ha appena rifiutato (400 `SEDE_DA_SPECIFICARE`), se
   * c'è stata. Non è un doppione dell'elenco: è l'unico modo di sapere che quel
   * plesso non vale più anche quando l'elenco non si è potuto leggere.
   */
  const [sedeRifiutata, setSedeRifiutata] = useState<string | null>(null)

  const [indice, setIndice] = useState(0)
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

  const {
    register, control, trigger, getValues, setValue, setFocus, setError,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched' })

  useEffect(() => {
    // L'elenco si chiede SEMPRE, anche col link targato: è l'unica autorità su
    // quali plessi ricevono candidature, ed è lo stesso predicato (`sediReali`)
    // che la rotta d'invio applica a `scuola_id`. Chiederlo qui costa una
    // richiesta e vale la differenza fra un link vecchio che si corregge da solo
    // al primo schermo e un vicolo cieco dopo quattro passi compilati.
    let annullato = false
    fetch(ROTTA_SEDI)
      .then(async (r) => {
        // `!r.ok` NON è un'eccezione: il `catch` qui sotto non scatterebbe, ed è
        // esattamente da qui che il 429 del rate-limit passava in silenzio.
        if (!r.ok) {
          logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: 'candidatura-sedi-non-caricate',
            stato: r.status,
          })
          return null
        }
        const lista = sediValide(await corpoDellaRisposta(r))
        if (lista === null) {
          // 200 con un corpo che non contiene l'elenco: l'elenco non c'è lo
          // stesso, e trattarlo come «nessuna sede» sarebbe una bugia diversa.
          logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: 'candidatura-sedi-corpo-inatteso',
            stato: r.status,
          })
        }
        return lista
      })
      .then((lista) => {
        if (annullato) return
        if (lista === null) {
          setStatoSedi('errore')
          return
        }
        setSedi(lista)
        // Con UNA sola sede non si fa scegliere niente, ma la sede va DECISA lo
        // stesso: `scuola_id` è obbligatorio sulla rotta, e lasciarlo `null`
        // qui significherebbe un 400 all'invio dopo quattro passi compilati.
        if (lista.length === 1) setSedeScelta(lista[0].id)
        setStatoSedi('pronto')
      })
      .catch((err) => {
        // Rete giù, o JSON illeggibile. Un catch che non logga è un bug, e
        // `logClient` non lancia mai.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `candidatura-sedi-non-caricate: ${nomeErrore(err)}`,
          stack: err instanceof Error ? err.stack : undefined,
        })
        if (annullato) return
        setStatoSedi('errore')
      })
    return () => {
      annullato = true
    }
  }, [tentativoSedi])

  const elencoPronto = statoSedi === 'pronto'
  /**
   * Il link è SMENTITO: l'elenco è arrivato e non lo contiene, oppure il server
   * ha rifiutato proprio quell'uuid. In entrambi i casi smette di valere, e da
   * qui in poi il modulo si comporta come se il link non ci fosse mai stato.
   */
  const linkSmentito =
    sedeLink !== null &&
    (sedeLink === sedeRifiutata || (elencoPronto && !sedi.some((s) => s.id === sedeLink)))
  /** La sede decisa dal link, se il link vale ancora qualcosa. */
  const sedeDaLink = sedeLink !== null && !linkSmentito ? sedeLink : null
  /** La sede che partirà nel POST: il link se regge, altrimenti la scelta. */
  const sedeDecisa = sedeDaLink ?? sedeScelta

  /**
   * IL MODULO È GIÀ COMINCIATO, ED È GIÀ COMPILATO.
   *
   * Un rifiuto `SEDE_DA_SPECIFICARE` si può ricevere solo dal riepilogo, cioè
   * dopo aver riempito tutti i passi. Da quel momento nessuna notizia
   * sull'elenco può più smontare il modulo: le schermate che «non fanno
   * cominciare» sono giuste all'apertura e sarebbero una perdita di lavoro qui.
   */
  const giaCompilato = sedeRifiutata !== null

  /**
   * La sede si sceglie quando c'è davvero da scegliere — e SEMPRE dopo un
   * rifiuto del server sulla sede, anche con un plesso solo, anche mentre
   * l'elenco si sta ricaricando: lì la frase d'errore parla della sede, e una
   * frase che nomina un passo che non c'è è precisamente il vicolo cieco che
   * questo ramo esiste per chiudere.
   */
  const mostraSede = sedeDaLink === null && (giaCompilato || sedi.length > 1)

  /**
   * La FORMA dei passi è definitiva e si può dipingere il primo.
   *
   * `errore` non decide la forma DA SOLO: con l'elenco ignoto non si sa se il
   * passo sede serva, e far cominciare il modulo significherebbe farlo compilare
   * per intero per poi rifiutarlo. Col link ancora in piedi però la forma È
   * decisa (nessuna scelta da fare), e il modulo parte: un guasto dell'elenco non
   * può impedire una candidatura.
   *
   * Dopo un rifiuto sulla sede la forma è decisa una volta per tutte: il passo
   * «sede» c'è, e ci resta qualunque cosa risponda il ri-caricamento. È la riga
   * che impedisce al modulo compilato di sparire mentre l'elenco è in volo.
   */
  const formaDecisa =
    (elencoPronto && sedi.length > 0) || (statoSedi === 'errore' && sedeDaLink !== null) || giaCompilato
  /** L'elenco non è arrivato e non c'è un link su cui ripiegare: si offre «Riprova». */
  const sediNonCaricate = statoSedi === 'errore' && sedeDaLink === null && !giaCompilato
  /**
   * L'elenco è ARRIVATO ed è VUOTO: non esiste nessuna sede a cui candidarsi, e
   * la rotta pretende `scuola_id`. Quindi il modulo non comincia, e si dice
   * perché — senza «Riprova»: ricaricare darebbe la stessa risposta, e un
   * pulsante che ripete la stessa risposta insegna a non fidarsi dei pulsanti.
   *
   * Vale anche col link targato: se nessun plesso riceve candidature, quel link
   * non ne indica uno valido per definizione (è lo stesso predicato).
   *
   * NON vale a modulo già compilato: la stessa notizia si dà dentro il passo
   * «sede», che a quel punto esiste, senza buttare via quattro passi di lavoro.
   */
  const sediVuote = elencoPronto && sedi.length === 0 && !giaCompilato
  const nonPuoCominciare = sediNonCaricate || sediVuote
  /**
   * Nel passo «sede» c'è davvero una scelta da fare. Quando l'elenco è in volo,
   * guasto o vuoto non c'è: «Avanti» prometterebbe un passaggio che non esiste e
   * risponderebbe solo «Scegli una sede per proseguire», davanti a zero sedi.
   */
  const sedeSceglibile = elencoPronto && sedi.length > 0

  const passi: Passo[] = useMemo(
    () => (mostraSede ? ['sede', 'dati', 'profilo', 'consensi', 'riepilogo'] : ['dati', 'profilo', 'consensi', 'riepilogo']),
    [mostraSede],
  )
  const passo = passi[Math.min(indice, passi.length - 1)]
  const ultimo = indice === passi.length - 1
  const avanzamento = ((indice + 1) / passi.length) * 100

  function riprovaSedi(): void {
    setStatoSedi('caricamento')
    setTentativoSedi((n) => n + 1)
  }

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

  async function passoAvanti(): Promise<void> {
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
      setIndice((i) => i + 1)
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
    setIndice((i) => i + 1)
  }

  function indietro(): void {
    // Tornare indietro per correggere spegne l'errore d'invio: tenerlo acceso lo
    // trasformerebbe in un avviso che si impara a ignorare.
    setErroreInvio(null)
    setIndice((i) => Math.max(0, i - 1))
  }

  /**
   * IL SERVER HA RIFIUTATO LA SEDE (400 `SEDE_DA_SPECIFICARE`).
   *
   * È il ramo che trasforma un vicolo cieco in un rifiuto azionabile, e fa
   * quattro cose in un ordine che conta:
   *  1. segna l'uuid come rifiutato — così il link targato smette di valere e
   *     `mostraSede` diventa vero anche se i plessi sono uno solo;
   *  2. dimentica la scelta, che il server ha appena smentito;
   *  3. riporta al primo passo, dove il passo «sede» sta ricomparendo;
   *  4. RICHIEDE l'elenco. È l'unica autorità su quali plessi accettano, ed è lo
   *     stesso predicato che la rotta applica: dopo l'aggiornamento, ciò che si
   *     può scegliere è ciò che il server accetta.
   *
   * I dati compilati NON si toccano: react-hook-form li conserva anche mentre il
   * pannello dei campi è smontato dall'attesa dell'elenco.
   */
  function sedeSmentitaDalServer(sede: string): void {
    setSedeRifiutata(sede)
    setSedeScelta(null)
    setIndice(0)
    riprovaSedi()
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
      const corpo = await corpoDellaRisposta(res)

      if (!res.ok) {
        // ⚠️ IL RIFIUTO SULLA SEDE VIENE PRIMA DI TUTTI GLI ALTRI, e non ricade
        // nel pannello generico: la frase del catalogo («Specificare la sede a
        // cui si riferisce questa operazione») è scritta per il cockpit, ordina
        // un'azione, e su questo modulo l'azione dev'essere possibile. Qui si
        // rimette il passo «sede» davanti e ci si porta chi compila.
        if (res.status === 400 && (corpo as { codice?: unknown } | null)?.codice === 'SEDE_DA_SPECIFICARE') {
          sedeSmentitaDalServer(sede)
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
    const nome = sedi.find((s) => s.id === sedeDecisa)?.nome
    if (nome) return nome
    return sedeDaLink !== null ? t('candRiepilogoSedeDalLink') : '—'
  }

  /** Le fasce scelte, con l'etichetta che ha letto chi le ha spuntate. */
  function fasceScelte(): string[] {
    const v = getValues('gradi')
    if (!Array.isArray(v)) return []
    return GRADI_OPTIONS.filter((o) => v.includes(o.value)).map((o) => String(o.label))
  }

  const testata: Record<Passo, { icona: typeof MapPin; titolo: string; sotto: string }> = {
    sede: { icona: MapPin, titolo: t('candSede'), sotto: t('candSedeSub') },
    dati: { icona: UserRound, titolo: t('candDati'), sotto: t('candDatiSub') },
    profilo: { icona: GraduationCap, titolo: t('candProfilo'), sotto: t('candProfiloSub') },
    consensi: { icona: ShieldCheck, titolo: t('candConsensiTitolo'), sotto: t('candConsensiSottotitolo') },
    riepilogo: { icona: Check, titolo: t('candRiepilogo'), sotto: t('candRiepilogoSub') },
  }
  const Intestazione = testata[passo].icona

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
    // `kv-public` è il marcatore della superficie PUBBLICA: senza, l'Alto
    // Contrasto su questa pagina non cambia un pixel — i token si ribaltano, ma
    // il guscio è dipinto con utility il cui hex `@theme inline` ha già inlinato,
    // e le regole per-superficie di `globals.css` sono l'unico modo di
    // raggiungerlo.
    <div className="kv-public flex min-h-screen flex-col bg-kidville-cream text-kidville-ink">
      <div className="h-1 w-full bg-kidville-cream-dark">
        <div
          className="h-full bg-kidville-green transition-all duration-300"
          style={{ width: `${avanzamento}%` }}
        />
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 sm:px-5 sm:py-8">
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
          <h1 className="flex items-center gap-2 font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green">
            <GraduationCap className="h-6 w-6 shrink-0" aria-hidden="true" />
            {t('candTitolo')}
          </h1>
          <p className="mt-1 text-sm text-kidville-sub">{t('candSottotitolo')}</p>
          {!inviata && formaDecisa && (
            <p className="mt-2 text-xs font-medium text-kidville-sub">
              {/* La chiave è quella del modulo d'iscrizione, ed è deliberato:
                  «Passo N di M» è una posizione in una sequenza, non un
                  conteggio, ed è dichiarata come tale nell'allowlist del lock
                  `messaggi-plurali-e-glossario` — un'allowlist che «può solo
                  accorciarsi». Una seconda chiave identica con un altro nome
                  sarebbe la stessa frase da mantenere in due posti. */}
              {t('wizardPassoDi', { corrente: indice + 1, totale: passi.length })}
            </p>
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
          <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4 py-10">
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
          <div className="flex flex-1 items-center justify-center" role="status" aria-live="polite">
            <Loader2 className="h-6 w-6 animate-spin text-kidville-green" aria-hidden="true" />
            <span className="sr-only">{t('candCaricamento')}</span>
          </div>
        ) : inviata ? (
          /*
           * LA CONFERMA È IL MOMENTO PIÙ IMPORTANTE DEL MODULO, E VA ANNUNCIATA.
           *
           * Questo ramo SOSTITUISCE l'intero blocco dei passi: il bottone «Invia
           * candidatura» appena premuto viene smontato, e con lui se ne va il
           * fuoco della tastiera, che cade su `<body>`. Senza le due righe qui
           * sotto chi usa uno screen reader preme «Invia», torna in cima al
           * documento e non sente niente: indistinguibile da una pagina che si è
           * rotta, sul solo schermo che dice che la candidatura è partita.
           *
           * `jest-axe` non poteva vederlo — l'assenza di una regione live non è
           * una violazione axe — e infatti gli 11 controlli di accessibilità
           * passavano lo stesso. Il presidio è il test che asserisce l'annuncio,
           * non la sonda automatica.
           *
           * `role="status"` (che implica `aria-live="polite"`) annuncia il
           * pannello a chi non guarda; il fuoco sull'`h2` (`tabIndex={-1}`, non
           * raggiungibile col Tab) rimette chi usa la tastiera dentro il
           * contenuto nuovo invece che all'inizio del documento.
           */
          <div role="status" className="flex flex-1 flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-card bg-kidville-success-soft">
              <PartyPopper className="h-8 w-8 text-kidville-success" aria-hidden="true" />
            </div>
            <h2 ref={confermaRef} tabIndex={-1} className="text-xl font-semibold text-kidville-green">
              {t('candInviata')}
            </h2>
            <p className="mt-1.5 max-w-sm text-sm text-kidville-sub">{t('candInviataCorpo')}</p>
          </div>
        ) : (
          <>
            <div className="flex-1">
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-kidville-success-soft">
                  <Intestazione className="h-4 w-4 text-kidville-success" aria-hidden="true" />
                </div>
                <div>
                  {/* Il titolo del passo è un `h2`, COMPRESO quello dei consensi:
                      sul wizard fratello quel ramo mancava, la catena di ternari
                      cadeva sul ramo finale, e la schermata su cui si presta il
                      consenso al trattamento si annunciava col titolo della
                      pagina successiva. È la prima cosa che uno screen reader
                      legge quando ci si arriva. */}
                  <h2 className="text-xl font-semibold leading-tight text-kidville-green">
                    {testata[passo].titolo}
                  </h2>
                  <p className="text-sm text-kidville-sub">{testata[passo].sotto}</p>
                </div>
              </div>

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
                <fieldset className="space-y-3">
                  <legend className="sr-only">{t('candSedeLegenda')}</legend>
                  {sedi.map((s) => {
                    const scelta = sedeScelta === s.id
                    return (
                      <label
                        key={s.id}
                        htmlFor={`sede-${s.id}`}
                        className={`flex cursor-pointer items-center gap-3 rounded-card border px-4 py-3.5 transition-all focus-within:ring-2 focus-within:ring-kidville-green focus-within:ring-offset-2 ${
                          scelta
                            ? 'border-kidville-green bg-kidville-green-soft'
                            : 'border-kidville-line bg-kidville-white hover:border-kidville-green'
                        }`}
                      >
                        <input
                          type="radio"
                          id={`sede-${s.id}`}
                          name="sede"
                          value={s.id}
                          checked={scelta}
                          onChange={() => {
                            setSedeScelta(s.id)
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
                        <MapPin
                          className={`h-4 w-4 shrink-0 ${scelta ? 'text-kidville-green' : 'text-kidville-sub'}`}
                          aria-hidden="true"
                        />
                        <span className={`text-sm ${scelta ? 'font-semibold text-kidville-green' : 'text-kidville-ink'}`}>
                          {s.nome}
                        </span>
                      </label>
                    )
                  })}
                  {erroreSede && (
                    <p role="alert" className="text-xs text-kidville-error-strong">
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

              {passo === 'riepilogo' && (
                <div className="space-y-4">
                  <div className="rounded-card border border-kidville-line bg-kidville-white px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-kidville-sub">
                      {t('candRiepilogoSede')}
                    </p>
                    <p className="mt-0.5 text-sm text-kidville-ink">{testoSede()}</p>
                  </div>
                  <div className="rounded-card border border-kidville-line bg-kidville-white px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-kidville-sub">
                      {t('candRiepilogoFasce')}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {fasceScelte().length === 0 ? (
                        <li className="text-sm text-kidville-error-strong">{t('candRiepilogoNessunaFascia')}</li>
                      ) : (
                        fasceScelte().map((etichetta) => (
                          <li key={etichetta} className="text-sm text-kidville-ink">
                            {etichetta}
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                  <p className="text-xs leading-relaxed text-kidville-sub">{t('candRiepilogoNota')}</p>
                </div>
              )}

              {/*
                L'ESCA, e sta QUI dentro perché deve esistere in ogni passo del
                modulo: react-hook-form conserva i valori dei campi smontati, ma
                un campo che non viene montato MAI non è registrato affatto e
                l'esca non scatterebbe. È nascosta agli occhi (`hidden`) e agli
                screen reader (`aria-hidden`), fuori dall'ordine di tabulazione,
                e senza autocompletamento: nessuna persona la trova, nessun
                assistente vocale la annuncia. Un compilatore automatico che
                riempie ogni `input` sì.
              */}
              <div hidden aria-hidden="true">
                <label htmlFor={CAMPO_ESCA}>{t('candEscaEtichetta')}</label>
                <input
                  id={CAMPO_ESCA}
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  {...register(CAMPO_ESCA)}
                />
              </div>
            </div>

            {/* L'invio è fallito. Sta QUI — sopra i bottoni, dentro la pagina —
                e non in un `alert()`: chi ha appena premuto «Invia candidatura»
                deve leggere, senza chiudere niente, che il lavoro fatto non è
                andato perduto. */}
            {erroreInvio !== null && (
              <div
                role="alert"
                /* `tabIndex={-1}` = raggiungibile col FUOCO ma non col Tab, come
                   l'`h2` della conferma: serve solo perché l'effetto qui sopra
                   possa posarci chi ha appena perso l'appiglio, non per
                   aggiungere una tappa alla tabulazione di tutti gli altri. */
                ref={pannelloErroreRef}
                tabIndex={-1}
                className="mt-4 rounded-card border border-kidville-error bg-kidville-error-soft px-4 py-3"
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-kidville-error-strong">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t('candErroreInvioTitolo')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-kidville-ink">{erroreInvio.corpo}</p>
                <p className="mt-1 text-xs leading-relaxed text-kidville-ink">{notaErrore}</p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-kidville-line pt-6">
              <button
                type="button"
                onClick={indietro}
                disabled={indice === 0 || inviando}
                className="flex items-center gap-2 rounded-pill px-4 py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-sub transition-all hover:bg-kidville-green-soft hover:text-kidville-green disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('candIndietro')}
              </button>

              <button
                type="button"
                onClick={avanti}
                /* Nel passo «sede» senza un elenco da cui scegliere il comando
                   non porta da nessuna parte: premerlo risponderebbe soltanto
                   «Scegli una sede per proseguire» davanti a zero sedi. Ciò che
                   si può fare adesso — riprovare l'elenco — sta qui sopra. */
                disabled={inviando || (passo === 'sede' && !sedeSceglibile)}
                className="flex items-center gap-2 rounded-pill bg-kidville-green px-6 py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-yellow-ink transition-all hover:bg-kidville-green-dark disabled:opacity-50"
              >
                {inviando ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : ultimo ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : null}
                <span>{inviando ? t('candInvioInCorso') : ultimo ? t('candInvia') : t('candAvanti')}</span>
                {!inviando && !ultimo && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
