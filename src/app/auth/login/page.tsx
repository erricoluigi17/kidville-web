'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { getSupabase } from '@/lib/supabase/browser-client';
import { useAccessibility } from '@/lib/accessibility/useAccessibility';
import { LanguageSwitcher } from '@/components/features/i18n/LanguageSwitcher';
import { areaFromPath, homePathForRole, isAreaAllowed } from '@/lib/auth/active-role';
import {
  apriBudgetAccesso,
  classificaErroreAccesso,
  eGuastoDelServizio,
  ESITO_GUASTO_DOPO_ACCESSO,
  ESITO_TIMEOUT,
  ESITO_TIMEOUT_DOPO_ACCESSO,
  statoErroreAccesso,
  type BudgetDiAccesso,
  type ChiaveErroreAccesso,
  type EsitoAccesso,
} from '@/lib/auth/errore-accesso';
import {
  impostaRuoloAttivo,
  passoDiRete,
  type EsitoPasso,
} from '@/lib/auth/ruolo-attivo-client';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { classificaFormaPassword, type FormaPassword } from '@/lib/auth/forma-password';
import { useLabelRuolo } from '@/lib/auth/ruoli';
import { OcchioPassword } from '@/components/ui/OcchioPassword';
import { SfondoAuth } from '@/components/features/auth/SfondoAuth';
import styles from './page.module.css';

/* ───────── Iconcine inline (leading/eye + decori) ───────── */
function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M4 7l8 6 8-6" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.6" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </svg>
  );
}
/*
 * ⚠️ `EyeIcon` e `BackgroundDeco` NON VIVONO PIÙ QUI.
 *
 * · l'occhio della password sta in `@/components/ui/OcchioPassword` (importato in
 *   cima). Era privato di questa schermata, e andava bene finché il campo password
 *   dell'app era UNO. Dal cambio password i campi diventano quattro, in due
 *   schermate che un utente vede a trenta secondi l'una dall'altra: ricopiare i due
 *   `path` avrebbe prodotto due disegni destinati a divergere al primo ritocco.
 *   Lock: `__tests__/architecture/occhio-password-una-copia-sola.test.ts`.
 * · lo sfondo decorativo sta in `@/components/features/auth/SfondoAuth`, con le sue
 *   regole CSS, per la stessa ragione: l'interstiziale del primo accesso deve avere
 *   lo STESSO linguaggio visivo della login, e «stesso» scritto due volte è due cose
 *   che si somigliano finché qualcuno non ne tocca una.
 *
 * Sono stati SPOSTATI, non riscritti: i path sono quelli del design «Kidville ·
 * Login (standalone)» (spazio 402×874) e il comportamento di questa pagina non
 * cambia di un pixel.
 */

// M4B.3 — login unico con smistamento per ruolo: dopo l'accesso si atterra
// sulla dashboard del proprio ruolo; chi ha più profili (docente che è anche
// genitore) sceglie il ruolo in uno step inline nella stessa card.

interface ProfiloDisponibile {
  ruolo: string;
  area: string;
}


/*
 * S28 — UNA sola navigazione per ogni uscita dal login.
 *
 * Qui c'erano quattro `router.replace(...)` seguiti immediatamente da `router.refresh()`.
 * Sul simulatore iOS, 1 login su 6 finiva sulla schermata «KIDVILLE NON È RAGGIUNGIBILE»
 * con il server perfettamente raggiungibile: WebKit registrava
 * `Failed provisional load (isCancellation = 1, errorCode = -999)`, cioè
 * `NSURLErrorCancelled` — la prima navigazione non falliva, veniva ANNULLATA dalla
 * seconda partita 28 ms dopo.
 *
 * Il `refresh()` non aggiungeva nulla: il `replace` verso una destinazione mai visitata
 * da questa istanza di router va comunque a prendere il payload RSC dal server, e ci va
 * con i cookie appena scritti (sessione Supabase + ruolo attivo da /api/auth/active-role).
 * Chi fosse tentato di rimetterlo: il lock è `__tests__/components/login-navigazione-singola.test.tsx`.
 */

/**
 * Dove si andrebbe A PRESCINDERE dalla password: `?next=` onorato solo se coerente
 * col ruolo attivo, altrimenti la home del ruolo.
 *
 * `ruolo: null` è il DEGRADO — `/api/me` ha risposto, il corpo era il nostro, e
 * semplicemente non contiene un ruolo da cui smistare. Lì `?next=` si onora se è un
 * path interno alle aree (mai grezzo: sarebbe un open redirect) e per il resto si va
 * alla radice, dove le guardie server-side faranno il loro lavoro. È lo stesso
 * comportamento che quella riga aveva scritto in linea: sta qui perché il ramo che
 * NON ha un ruolo è esattamente quello che una funzione «per ruolo» si dimentica.
 */
function meta(ruolo: string | null, next: string | null): string {
  if (next) {
    const area = areaFromPath(next);
    if (area && (ruolo === null || isAreaAllowed(ruolo, area))) return next;
  }
  return ruolo === null ? '/' : homePathForRole(ruolo);
}

/**
 * L’USCITA DAL LOGIN, per tutte e quattro le strade — e l’unico posto in cui si
 * decide se in mezzo ci va l’interstiziale del primo accesso.
 *
 * ─── PERCHÉ QUI E NON NEI CHIAMANTI ─────────────────────────────────────────
 *
 * Perché i chiamanti sono QUATTRO (auto-riparazione di `?scegli=1`, picker dei
 * ruoli, smistamento diretto, degrado senza ruolo) e il commento in testa a questo
 * file spiega, con la misura di WebKit accanto, perché una seconda navigazione ne
 * annulla un’altra. Una regola valida per quattro strade scritta in quattro posti è
 * una regola che, alla prossima modifica, resta giusta in tre.
 *
 * ─── LA REGOLA, E I DUE MODI DI SBAGLIARLA ──────────────────────────────────
 *
 * Se la password appena digitata ha la FORMA di una temporanea (quella spedita per
 * email: `Xxxx-xxxx-xxxx-xxxx`, o il formato vecchio che 67 famiglie hanno ancora in
 * mano), si passa da `/auth/nuova-password` e la destinazione vera viaggia in
 * `?next=`. Altrimenti non cambia niente.
 *
 *  · troppo largo, e l’interstiziale si mette davanti a chi la password se l’è
 *    scelta mesi fa — un ostacolo quotidiano fra una madre e il diario di suo figlio;
 *  · troppo stretto, e non compare mai: il lavoro sembra fatto mentre chi ha in mano
 *    una temporanea continua a usarla.
 *
 * ⚠️ LA STRINGA VUOTA NON È UNA TEMPORANEA, ed è il caso che si vede solo provandolo.
 * Chi arriva con `?scegli=1` è **già autenticato** (lo manda la guardia d’area) e non
 * ha digitato nessuna password: `password` vale `''`. `classificaFormaPassword('')`
 * risponde `'altra'` — cioè nessun instradamento — ed è la ragione per cui questa
 * funzione interroga il classificatore invece di chiedersi «la password è vuota?».
 */
function destinazione(ruolo: string | null, next: string | null, password: string): string {
  const dove = meta(ruolo, next);
  if (classificaFormaPassword(password) === 'altra') return dove;
  return `/auth/nuova-password?next=${encodeURIComponent(dove)}`;
}

/**
 * Scrive in `localStorage` ciò che `useSessionIdentity` rilegge (`kv_user_id`, `kv_user_role`).
 *
 * ⚠️ REGOLA D'ORDINE SU `kv_user_role`: si persiste **dopo** che il server ha accettato il ruolo
 * attivo, mai prima. Fino al 2026-08-03 due dei tre percorsi lo scrivevano un attimo prima della
 * chiamata (e `onSubmit` scriveva perfino `me.role` prima ancora di sapere QUALE ruolo sarebbe
 * andato in gioco): dopo un 403 il client restava convinto di avere un ruolo per cui il cookie
 * server non è mai stato messo. Prima quell'incoerenza durava un istante, perché si navigava
 * comunque e la guardia d'area la risolveva; da quando un guasto del ruolo attivo NON naviga più,
 * lo stato sbagliato **resta** sulla pagina di login. La sonda del verificatore leggeva
 * `educator | educator | educator` su tutte e tre le strade dopo un 403.
 *
 * `kv_user_id` invece si scrive appena `/api/me` ha risposto bene: è l'identità, non il ruolo, e
 * non dipende da nessun passo successivo.
 */
function persisti(chiave: string, valore: string) {
  try {
    window.localStorage.setItem(chiave, valore);
  } catch {
    /* ignore */
  }
}

/**
 * DOVE si è fermato l'accesso. `credenziali` = la sessione non è ancora stata scritta;
 * `dopo-accesso` = c'è già, e ciò che manca è il profilo o il ruolo attivo. Sono due incidenti
 * diversi per chi legge il log — nel secondo caso l'autenticazione ha funzionato e il guasto è
 * dalla nostra parte — e senza questo campo, nella tabella, avrebbero lo stesso aspetto.
 */
type FaseAccesso = 'credenziali' | 'dopo-accesso';

/**
 * Un accesso fallito si registra. ANCHE quando è una password sbagliata.
 *
 * ⚠️ FINO AL 2026-08-22 QUI C'ERA SCRITTO IL CONTRARIO, e la motivazione era che «un
 * refuso al login è un evento normale di ogni giorno di ogni genitore, e spedirlo
 * sarebbe la riga di rumore sotto cui l'incidente vero non si trova più». Il timore
 * era il rumore. Il rumore non è mai arrivato: in trenta giorni di `app_log` le righe
 * di accesso fallito erano **zero**, perché non ne veniva scritta nessuna.
 *
 * Quello che è arrivato è il caso opposto. Il 22/08 il cron delle iscrizioni ha
 * spedito 67 credenziali a famiglie vere: 37 sono entrate, 30 no, e alcune hanno
 * telefonato in segreteria. Alla domanda «quante persone hanno provato e non ci sono
 * riuscite, e stavano usando la password che avevamo spedito noi o una loro?» il
 * sistema non sapeva rispondere — e senza quella risposta la diagnosi è rimasta
 * un'opinione per un giorno intero. L'assenza di rumore è costata la misura.
 *
 * ─── LA DISTINZIONE CHE REGGE TUTTO: MOSTRARE ≠ REGISTRARE ──────────────────────
 * `errore-accesso.ts` spiega perché all'utente non si dice MAI se sia sbagliata
 * l'email o la password: lo direbbe a un anonimo, e trasformerebbe il modulo in un
 * oracolo su chi è iscritto a una scuola dell'infanzia. Quel vincolo riguarda ciò che
 * si MOSTRA, e non cambia di una virgola. Questa riga è roba nostra, e per tre
 * ragioni cumulative non riapre quell'oracolo:
 *
 *  · non contiene identità: né email, né un suo hash, né la lunghezza della password.
 *    `hashCorrelabile` sta sul server e ha un salt; un hash calcolato QUI, senza
 *    salt, sarebbe invertibile con l'elenco delle caselle iscritte — cioè PII
 *    travestita da impronta. Non si fa;
 *  · non crea conoscenza nuova: GoTrue risponde `400 invalid_credentials` in entrambi
 *    i casi, quindi nemmeno noi sappiamo quale dei due sia;
 *  · il «chi» c'è già altrove ed è più affidabile: `auth.users.last_sign_in_at` è la
 *    colonna da cui è uscito il «37 su 67». Questa riga deve rispondere al PERCHÉ.
 *
 * ─── DUE TRAPPOLE, ENTRAMBE CAPACI DI PASSARE I TEST ────────────────────────────
 *
 * 1. `stato` DEVE restare `undefined` per il ramo credenziali. `livelloEvento` in
 *    `logging/client.ts` applica `livelloFetch` a qualunque evento che porti uno
 *    `stato` fra 400 e 599, e 400 non è fra le `ANOMALIE_4XX`: passare lo status di
 *    GoTrue farebbe **scartare l'evento in silenzio**, i test che spiano `logClient`
 *    resterebbero verdi perché guardano a monte, e in produzione non arriverebbe
 *    niente. Lo status vive dentro il messaggio, dove nessun filtro lo tocca.
 * 2. Le discriminanti stanno nel MESSAGGIO, non nel contesto. L'impronta di
 *    deduplicazione di `app_log` comprende il messaggio e **non** il contesto (che
 *    resta quello della prima occorrenza del giorno): una combinazione diversa deve
 *    essere una riga diversa col proprio `occorrenze`, altrimenti diciannove casi su
 *    venti verrebbero raccontati dal primo.
 *
 * Il vocabolario è CHIUSO — tre valori per `pwd`, quattro per `spazi`, tre per
 * `riprova` — quindi al massimo 36 righe al giorno, e nessuna esplosione di cardinalità.
 *
 * Livello `warn` e non `error`, e non è estetica: `controlloTassoErrore` dichiara
 * `/api/health` degradato a cinque impronte `error` distinte in un quarto d'ora. Sei
 * famiglie che sbagliano password nella stessa mattina marcherebbero l'applicazione
 * come guasta.
 *
 * E va detto ciò che questo canale NON è: **non è un sensore d'attacco**. Chi attacca
 * parla direttamente con `/auth/v1/token` e non esegue il nostro JavaScript. Serve a
 * dare un'ETICHETTA DI CAUSA alle righe, così che un picco di `pwd=temporanea` si
 * legga come «le famiglie non riescono a entrare» invece che come rumore.
 */
function registraGuastoAccesso(
  fase: FaseAccesso,
  esito: string,
  errore: unknown,
  stato: number | undefined,
) {
  logClient({
    livello: 'warn',
    evento: 'fetch',
    messaggio: `accesso non completato — fase=${fase} esito=${esito} errore=${nomeErrore(errore)}`,
    route: '/auth/login',
    stato,
  });
}

/** Dove stavano gli spazi di troppo. Vocabolario chiuso: quattro valori, mai altro. */
type SpaziIncollati = 'nessuno' | 'email' | 'password' | 'entrambi';

function doveSonoGliSpazi(email: string, password: string): SpaziIncollati {
  const e = email !== email.trim();
  const p = password !== password.trim();
  if (e && p) return 'entrambi';
  if (e) return 'email';
  if (p) return 'password';
  return 'nessuno';
}

/**
 * Il fallimento di credenziali, con la sua causa strutturale e nulla della persona.
 *
 * `riprova` racconta l'esito del secondo tentativo con la stringa ripulita, e
 * `riprova=riuscita` è la regola 5 di AGENTS.md applicata a un ricupero: senza quella
 * parola non sapremmo mai quante persone il ritentativo ha salvato, cioè quanto
 * pesasse davvero il difetto degli spazi incollati.
 */
function registraCredenzialiRifiutate(dati: {
  esito: string;
  stato: number | undefined;
  forma: FormaPassword;
  spazi: SpaziIncollati;
  riprova: 'non-serviva' | 'fallita' | 'riuscita';
}) {
  logClient({
    livello: 'warn',
    evento: 'accesso',
    messaggio:
      `credenziali rifiutate — esito=${dati.esito} http=${dati.stato ?? 'nessuno'} ` +
      `pwd=${dati.forma} spazi=${dati.spazi} riprova=${dati.riprova}`,
    route: '/auth/login',
    // Vedi la trappola 1 qui sopra: con `stato: 400` questa riga non esisterebbe.
    stato: undefined,
  });
}

/*
 * ⚠️ `passoDiRete`, `EsitoPasso`, `erroreRispostaNonOk` e `impostaRuoloAttivo` NON
 * VIVONO PIÙ QUI: stanno in `@/lib/auth/ruolo-attivo-client`, importate in cima.
 *
 * Erano private di questa pagina, e andava bene finché l'unico modo di scegliere una
 * veste era il picker qui sotto. Dal 2026-09-01 esiste uno switch di profilo DENTRO
 * l'app (`ui/CambiaProfiloMenuButton`), e lasciarle qui avrebbe voluto dire
 * ricopiarle: due copie della stessa decisione — quale ruolo si sta indossando, e
 * cosa fare quando il server dice di no — che divergono al primo ritocco.
 *
 * Sono state SPOSTATE, non riscritte: il comportamento di questa pagina non cambia
 * di una riga, e i commenti che spiegano il perché di ogni ramo (i tre modi di
 * fallire di una fetch, il trattamento del 401 e del 403) sono andati con loro.
 */

/** Ciò che di `/api/me` interessa a questa pagina. Tutto `unknown`: è roba di rete. */
interface RispostaMe {
  id?: unknown;
  role?: unknown;
  profili?: unknown;
}

/**
 * `/api/me` letta PER INTERO: la risposta **e** il suo corpo.
 *
 * Sono due attese distinte e tutte e due possono non finire mai — un corpo che non arriva
 * pianta `res.json()` esattamente come una risposta che non arriva pianta la `fetch`. Stanno
 * sotto la stessa funzione perché così il chiamante può metterle sotto UN tetto: metterlo sulla
 * sola `fetch` lascerebbe scoperta la seconda metà dello stesso identico blocco.
 *
 * ⚠️ UN 401 DA QUESTA ROUTE VIENE TRATTATO COME GUASTO, E LO È DI PROPOSITO. `/api/me` risponde
 * 401 «Utente non trovato» anche a un utente **autenticato** che non ha una riga né in `utenti`
 * né in `parents` (`me/route.ts`) — la classe di bug già vista con `parents.id != auth.user.id`,
 * per cui 0 genitori su 46 avevano completato l'onboarding. Chiamarlo «degrado» significava
 * mandarlo su `/`, da dove la guardia d'area lo rispediva al login: un giro senza uscita e senza
 * una parola. Adesso legge «Ti abbiamo riconosciuto, ma l'accesso non si è completato… avvisa la
 * Segreteria», che è vero (le credenziali sono state accettate) ed è azionabile. Non entra in
 * nessuno dei due modi: la differenza è che ora lo sa, e lascia una riga in `app_log`.
 */
function leggiProfilo(): Promise<EsitoPasso<RispostaMe | null>> {
  return passoDiRete<RispostaMe>('/api/me');
}

/*
 * ⚠️ RESTA VERO, E VA LETTO DOVE ORA VIVE: il trattamento del 401 e del 403 di
 * `POST /api/auth/active-role` — nessuna navigazione, in nessuno dei due casi — è
 * una DECISIONE DI PRODOTTO, motivata per esteso nella testata di
 * `impostaRuoloAttivo` dentro `@/lib/auth/ruolo-attivo-client`. Se un giorno si
 * volesse distinguere i due stati, il punto da toccare resta UNO: lo `stato` dentro
 * `eseguiPasso`, non i chiamanti.
 */

/** Le chiavi con cui si racconta un guasto capitato DOPO che la sessione è stata scritta. */
type ChiaveGuastoDopoAccesso =
  | typeof ESITO_TIMEOUT_DOPO_ACCESSO
  | typeof ESITO_GUASTO_DOPO_ACCESSO
  | 'erroreRuolo';

type PassoRisolto<T> =
  | { ok: true; dato: T }
  | { ok: false; chiave: ChiaveGuastoDopoAccesso; errore: unknown; stato: number | undefined };

/**
 * Un passo post-autenticazione corso contro il budget, con i suoi DUE modi di fallire ridotti a
 * uno solo per chi lo chiama.
 *
 * Il tempo scaduto e il guasto vero arrivano da due tipi diversi (`EsitoTetto` e `EsitoPasso`)
 * ma hanno la stessa identica risposta: messaggio, log, nessuna navigazione. Tenerli separati
 * vorrebbe dire scrivere quella risposta due volte per ognuno dei tre passi — sei posti da cui,
 * alla prossima modifica, ne resterebbe corretto qualcuno.
 */
async function eseguiPasso<T>(
  budget: BudgetDiAccesso,
  lavoro: Promise<EsitoPasso<T>>,
  chiaveGuasto: ChiaveGuastoDopoAccesso,
): Promise<PassoRisolto<T>> {
  const esito = await budget.corri(lavoro);
  if (esito.scaduto) {
    return { ok: false, chiave: ESITO_TIMEOUT_DOPO_ACCESSO, errore: null, stato: undefined };
  }
  if (esito.valore.guasto) {
    return {
      ok: false,
      chiave: chiaveGuasto,
      errore: esito.valore.errore,
      stato: esito.valore.stato,
    };
  }
  return { ok: true, dato: esito.valore.dato };
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  // Arrivo dalla guardia d'area (M4B.4): utente già autenticato con doppio
  // profilo ma senza ruolo attivo → salta le credenziali, mostra la scelta.
  const scegli = params.get('scegli') === '1';
  const t = useTranslations('auth');
  const labelRuolo = useLabelRuolo();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  // Alto contrasto: qui si legge soltanto (per nascondere mascotte e decori). Il
  // toggle vive nei menu account di tutte le aree (ContrastMenuButton), non più
  // in questa pagina: la login deve restare a tutto schermo, senza scroll.
  const { highContrast } = useAccessibility();
  /**
   * Lo stato tiene la CHIAVE del messaggio, non il testo già tradotto — e la traduzione si fa
   * in render, dove `t` c'è. Due ragioni, tutte e due misurate:
   *  · l'effetto `?scegli=1` deve poter segnalare un guasto SENZA avere `t` fra le proprie
   *    dipendenze: `t` cambia identità a ogni render, e nelle dipendenze rilancerebbe
   *    l'effetto — cioè la fetch — a ogni render;
   *  · un messaggio tradotto una volta sola resterebbe nella lingua che aveva al momento
   *    dell'errore anche dopo un cambio di lingua (l'app è bilingue, cookie `KV_LOCALE`).
   */
  const [chiaveErrore, setChiaveErrore] = useState<ChiaveErroreAccesso | 'erroreRuolo' | null>(null);
  /**
   * Se l'errore mostrato accusa le CREDENZIALI. Non è un doppione di `error`: è ciò che
   * decide `aria-invalid` sui due campi. Marcare email e password come non valide mentre il
   * database è giù è la stessa bugia del messaggio, detta a chi usa uno screen reader — e a
   * quell'utente è anche l'unica versione che arriva.
   */
  const [credenzialiErrate, setCredenzialiErrate] = useState(false);
  const [loading, setLoading] = useState(false);
  // ≥2 profili → step inline di scelta ruolo nella stessa card.
  const [profili, setProfili] = useState<ProfiloDisponibile[] | null>(null);
  // Con ?scegli=1 il primo paint attende /api/me: niente flash del form
  // credenziali prima del picker (resta la card con titolo e sottotitolo).
  const [attesa, setAttesa] = useState(scegli);
  const gruppoRuoli = useRef<HTMLDivElement>(null);

  /** Il testo mostrato: la chiave nello stato, la lingua qui. */
  const error = chiaveErrore === null ? null : t(chiaveErrore);

  /**
   * LA REGOLA DEI GUASTI DOPO L'ACCESSO, IN UN POSTO SOLO — e sono quattro cose insieme:
   *  1. un messaggio che dice che le credenziali sono state ACCETTATE (non «non dipende da…»:
   *     a questo punto si sa di più, e si sa la cosa più utile che ci sia);
   *  2. i campi NON marcati non validi, perché a chi usa uno screen reader `aria-invalid` è
   *     l'unica versione del messaggio che arriva;
   *  3. la fine dell'attesa: chi è arrivato da `?scegli=1` deve ritrovarsi su una superficie da
   *     cui ritentare, non su «Caricamento dei profili…» per sempre;
   *  4. **una riga di log con `fase=dopo-accesso`** — regola 6 di AGENTS.md, e l'unico modo per
   *     distinguere in `app_log` un guasto a sessione già scritta da uno sulle credenziali.
   *
   * `useCallback` con dipendenze vuote non è cerimonia: le tre `set*` di `useState` e
   * `registraGuastoAccesso` (di modulo) sono già stabili, e l'identità stabile è ciò che
   * permette all'effetto `?scegli=1` di tenerla fra le proprie dipendenze senza rilanciarsi —
   * cioè senza rifare la fetch — a ogni render.
   *
   * ⚠️ QUATTRO COSE DICHIARATE VUOL DIRE QUATTRO COSE MISURATE, su OGNI strada. Il 2026-08-03 il
   * verificatore ha rimesso `setCredenzialiErrate(chiave === 'erroreRuolo')` — cioè far dire a
   * uno screen reader «hai sbagliato le credenziali» mentre il guasto è del server, su tutte e
   * tre le strade — e la suite è rimasta **81 verdi su 81**: i test asserivano la navigazione, la
   * traccia e la superficie da cui ritentare, e mai il punto 2. Le asserzioni ci sono adesso, e
   * sono divise fra le strade che montano il form e quella che monta il picker, perché su
   * quest'ultima i campi non esistono e un `if (campo)` sarebbe un'asserzione che non sa fallire.
   */
  const segnalaGuastoDopoAccesso = useCallback(
    (chiave: ChiaveGuastoDopoAccesso, errore: unknown, stato: number | undefined) => {
      setChiaveErrore(chiave);
      setCredenzialiErrate(false);
      setAttesa(false);
      registraGuastoAccesso('dopo-accesso', chiave, errore, stato);
    },
    [],
  );

  // Lo swap credenziali → picker smonta il bottone che ha il focus: senza questo
  // il focus finisce su <body>. Si punta il contenitore, non il primo bottone,
  // così un Invio ancora premuto non lo attiva.
  useEffect(() => {
    if (profili) gruppoRuoli.current?.focus();
  }, [profili]);

  useEffect(() => {
    if (!scegli) return;
    let cancelled = false;
    /**
     * W8 — anche QUI il tetto, e per il motivo peggiore di tutti: chi arriva con `?scegli=1`
     * è **già autenticato** (lo manda la guardia d'area). Senza tetto, un `/api/me` che non
     * risponde mai lascia `attesa` a `true` per sempre: la pagina mostra «Caricamento dei
     * profili…» e non arriva mai né al picker né al form — nessun messaggio, nessun modo di
     * riprovare, su una schermata che non ha nemmeno un bottone da premere.
     *
     * `t` NON entra qui dentro (vedi `chiaveErrore`): si scrive la chiave, non il testo.
     */
    const budget = apriBudgetAccesso();
    const load = async () => {
      // Quattro modi di fallire — tempo scaduto, `fetch` rifiutata, risposta non-ok, corpo
      // illeggibile — e una risposta sola: `segnalaGuastoDopoAccesso`, che spegne anche
      // `attesa`. Gli ultimi tre fino al 2026-08-03 finivano tutti in `elenco = []`, cioè nel
      // form credenziali muto: nessun messaggio e nessun log per un utente GIÀ autenticato.
      const profilo = await eseguiPasso(budget, leggiProfilo(), ESITO_GUASTO_DOPO_ACCESSO);
      // Questa guardia non è decorativa e non è a credito: se salta, un componente smontato
      // scrive nel proprio stato E lascia una riga in `app_log` per un guasto che nessuno sta
      // più guardando. Fino al 2026-08-03 nessun test smontava la pagina con l'effetto in volo
      // (manomissione M-E: scavalcarla lasciava 81 verdi su 81); adesso lo fa
      // `login-errori-servizio.test.tsx`, contando le righe di log dopo l'`unmount()`.
      if (cancelled) return;
      if (!profilo.ok) {
        segnalaGuastoDopoAccesso(profilo.chiave, profilo.errore, profilo.stato);
        return;
      }

      const me = profilo.dato;
      const elenco = Array.isArray(me?.profili) ? (me.profili as ProfiloDisponibile[]) : [];
      if (me?.id) persisti('kv_user_id', String(me.id));

      if (elenco.length === 1) {
        // Auto-riparazione: un profilo solo non ha nulla da scegliere.
        const ruolo = elenco[0].ruolo;
        // Stesso trattamento del picker, e non è un caso: fino al 2026-08-03 qui l'esito non
        // veniva nemmeno LETTO — si navigava comunque, cookie di ruolo o no.
        const messo = await eseguiPasso(budget, impostaRuoloAttivo(ruolo), 'erroreRuolo');
        if (cancelled) return;
        if (!messo.ok) {
          segnalaGuastoDopoAccesso(messo.chiave, messo.errore, messo.stato);
          return;
        }
        // DOPO l'accettazione del server, come nel picker (vedi `persisti`).
        persisti('kv_user_role', ruolo);
        // `attesa` resta `true`: si sta navigando via, niente flash del form.
        //
        // ⚠️ LA PASSWORD SI PASSA VUOTA, ED È UN FATTO, NON UNA SCORCIATOIA. Su questa
        // strada nessuna password è stata digitata: chi arriva con `?scegli=1` è già
        // autenticato e lo manda la guardia d'area. Leggere lo stato `password` qui
        // darebbe lo stesso risultato (`''`) e in più obbligherebbe a metterlo fra le
        // dipendenze dell'effetto — cioè a rilanciare questa fetch a ogni tasto
        // digitato nel form che compare quando i profili sono zero.
        router.replace(destinazione(ruolo, next, ''));
        return;
      }

      // ≥2 profili → picker; nessuna sessione/profilo → form credenziali.
      if (elenco.length >= 2) setProfili(elenco);
      setAttesa(false);
    };
    /**
     * IL TETTO SUL GUASTO, NON SOLO SUL TEMPO — e su questa strada mancava del tutto.
     *
     * `load` non fa solo passi che RITORNANO un esito: chiama anche `router.replace(...)`, che
     * **lancia** se la navigazione viene rifiutata. Senza questo `.catch` quel rifiuto diventava
     * un `unhandledrejection` e la pagina restava su «Caricamento dei profili…» PER SEMPRE, a
     * utente già autenticato: nessun messaggio, nessun log, nessun form da cui ritentare, e
     * nemmeno un bottone da premere. È il sintomo W8 esatto sulla terza strada — le altre due il
     * loro `catch` ce l'hanno (`onSubmit`, `scegliRuolo`), questa no — ed è la regola 6 di
     * AGENTS.md nella sua forma più grave: non è un `catch` che tace, è un `catch` che manca.
     *
     * `cancelled` vale anche qui: un rifiuto che arriva dopo lo smontaggio non deve scrivere né
     * nello stato di un componente che non c'è più né in `app_log`.
     */
    void load().catch((err) => {
      if (!cancelled) {
        segnalaGuastoDopoAccesso(ESITO_GUASTO_DOPO_ACCESSO, err, statoErroreAccesso(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [scegli, next, router, segnalaGuastoDopoAccesso]);

  /** Un errore che NON accusa le credenziali, capitato PRIMA che la sessione fosse scritta. */
  function mostraErrore(chiave: ChiaveErroreAccesso) {
    setChiaveErrore(chiave);
    setCredenzialiErrate(false);
  }

  function pulisciErrore() {
    setChiaveErrore(null);
    setCredenzialiErrate(false);
  }

  async function scegliRuolo(ruolo: string) {
    pulisciErrore();
    setLoading(true);
    // W8 — chi è su questo picker è GIÀ autenticato: senza tetto, un `/api/auth/active-role`
    // che non risponde mai lascia i bottoni dei ruoli `disabled` per sempre. Stesso sintomo
    // del bottone «Accesso…», una schermata più in là.
    const budget = apriBudgetAccesso();
    try {
      const messo = await eseguiPasso(budget, impostaRuoloAttivo(ruolo), 'erroreRuolo');
      if (!messo.ok) {
        // Prima qui il `false` del server mostrava `erroreRuolo` e **non lasciava nessuna
        // traccia**: l'unico dei tre passi post-accesso che non finiva in `app_log`.
        segnalaGuastoDopoAccesso(messo.chiave, messo.errore, messo.stato);
        return;
      }
      persisti('kv_user_role', ruolo);
      // La password è quella dello stato: su questa strada può essere sia quella
      // appena digitata (si è passati da `onSubmit` e poi dal picker) sia la stringa
      // vuota (si è arrivati da `?scegli=1`). `destinazione` distingue i due casi.
      router.replace(destinazione(ruolo, next, password));
    } catch (err) {
      // `impostaRuoloAttivo` non rifiuta (`passoDiRete` non lascia passare niente), ma qui dentro
      // c'è anche `router.replace`, che LANCIA se la navigazione viene rifiutata — ed è il modo
      // in cui questo ramo si raggiunge davvero. Un `catch` che non dice niente sarebbe un
      // bottone che si sblocca senza spiegare perché.
      //
      // ⚠️ Fino al 2026-08-03 questo ramo non era toccato da NESSUN test: la manomissione M-D
      // (fase riportata a `credenziali`, `stato` buttato via, `attesa` non spenta) lasciava
      // 81 verdi su 81. Delle tre strade era l'unica misurata solo sul percorso non-eccezionale.
      segnalaGuastoDopoAccesso(ESITO_GUASTO_DOPO_ACCESSO, err, statoErroreAccesso(err));
    } finally {
      setLoading(false);
    }
  }

  /**
   * T16-F3 — il messaggio segue la CAUSA, non il fatto che ci sia stato un errore.
   *
   * Qui c'era `if (error) setError(t('credenzialiNonValide'))`, e bastava perché
   * `signInWithPassword` non lancia: ritorna `{ error }` per la password sbagliata come per
   * il 500 del database giù, il 429, la rete caduta e la risposta non-JSON. Sei guasti, una
   * frase sola — e quella frase mandava a cambiare una password che era giusta.
   * La tassonomia sta in `@/lib/auth/errore-accesso`, con la fonte in `auth-js`.
   *
   * Ciò che resta INDISTINTO è l'errore dell'utente: email inesistente e password sbagliata
   * dicono la stessa cosa, perché distinguerle direbbe a un anonimo chi è iscritto.
   */
  function mostraErroreAccesso(
    errore: unknown,
    /** Com'è andato il secondo tentativo con la stringa ripulita, se c'è stato. */
    riprova: 'non-serviva' | 'fallita' = 'non-serviva',
  ) {
    const esito: EsitoAccesso = classificaErroreAccesso(errore);
    setChiaveErrore(esito);
    setCredenzialiErrate(!eGuastoDelServizio(esito));
    if (eGuastoDelServizio(esito)) {
      registraGuastoAccesso('credenziali', esito, errore, statoErroreAccesso(errore));
      return;
    }
    // Il ramo che fino al 22/08 non lasciava traccia: vedi il blocco su
    // `registraCredenzialiRifiutate` per il perché adesso la lascia.
    registraCredenzialiRifiutate({
      esito,
      stato: statoErroreAccesso(errore),
      forma: classificaFormaPassword(password),
      spazi: doveSonoGliSpazi(email, password),
      riprova,
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    pulisciErrore();
    setLoading(true);
    /**
     * W8 — IL TETTO È DELL'INTERA SEQUENZA, non della sola `signInWithPassword`.
     *
     * Entrare sono tre attese in fila (credenziali → `/api/me` → ruolo attivo). Fino al
     * 2026-08-03 il tetto stava sulla prima soltanto: bastava che `/api/me` non rispondesse
     * per rimettere in piedi, una riga più sotto, il difetto T16-F4 — bottone `disabled` su
     * «Accesso…», nessun `role="alert"`, nessun modo di riprovare — e stavolta **a utente già
     * autenticato**, col cookie di sessione scritto. Un budget solo copre tutta la fila e
     * continuerà a coprirla se domani i passi diventassero quattro.
     */
    const budget = apriBudgetAccesso();
    /** Da qui in poi il guasto NON è più delle credenziali: sono state accettate. */
    let autenticato = false;
    try {
      const supabase = getSupabase();
      // Il tipo è dichiarato QUI perché `getSupabase()` arriva tipizzato `any`: senza
      // annotazione l'errore tornerebbe `any` (com'era prima) e nessuno si accorgerebbe di
      // un `error.status` scritto male. `unknown` obbliga a passare dal classificatore.
      /**
       * L'EMAIL SI RIPULISCE SEMPRE, LA PASSWORD SOLO SE SERVE — e la differenza non
       * è una sfumatura.
       *
       * Uno spazio ai bordi di un indirizzo non ha nessuna semantica legittima:
       * GoTrue normalizza già di suo, e il `trim()` qui evita solo di sprecare un
       * tentativo. Uno spazio ai bordi di una PASSWORD invece può essere voluto —
       * chi l'ha scelta così in onboarding ce l'ha davvero dentro l'hash — e
       * ripulirla d'ufficio chiuderebbe fuori quella persona senza che possa
       * capirlo, visto che il messaggio d'errore è indistinto per costruzione.
       * Perciò la password grezza si prova SEMPRE per prima: chi è dentro resta
       * dentro, e il secondo tentativo lo vede solo chi stava già fallendo.
       */
      const emailPulita = email.trim();
      const provaAccesso = (pwd: string): Promise<{ error: unknown }> =>
        supabase.auth.signInWithPassword({ email: emailPulita, password: pwd });

      // T16-F4 — senza tetto, una risposta che non arriva mai lascia il bottone su
      // «Accesso…» per sempre: nessun messaggio, nessun modo di riprovare.
      const tentativo = await budget.corri(provaAccesso(password));
      if (tentativo.scaduto) {
        mostraErrore(ESITO_TIMEOUT);
        // Un timeout non produce nessuna risposta HTTP: né il patch di `fetch` né i log del
        // server lo vedranno mai. Questa riga è l'unica traccia che esista.
        registraGuastoAccesso('credenziali', ESITO_TIMEOUT, null, undefined);
        return;
      }
      let { error } = tentativo.valore;

      /**
       * IL SECONDO E ULTIMO TENTATIVO — il rimedio al difetto del 2026-08-22.
       *
       * Si fa solo se ricorrono tutte e tre le condizioni, e ognuna esclude un modo
       * di peggiorare le cose:
       *  · l'esito è `credenzialiNonValide` — su un 429 ritentare aggrava il rate
       *    limit, e su un 500 il secondo tentativo mentirebbe due volte;
       *  · la password aveva davvero spazi ai bordi — altrimenti sarebbe una
       *    richiesta identica alla prima, cioè regalata a GoTrue;
       *  · ripulita non resta vuota.
       * Gira dentro lo STESSO `budget`: nessun tetto nuovo, nessuna manopola nuova.
       */
      const passwordPulita = password.trim();
      let riprova: 'non-serviva' | 'fallita' | 'riuscita' = 'non-serviva';
      if (
        error &&
        classificaErroreAccesso(error) === 'credenzialiNonValide' &&
        passwordPulita !== password &&
        passwordPulita !== ''
      ) {
        const secondo = await budget.corri(provaAccesso(passwordPulita));
        if (secondo.scaduto) {
          mostraErrore(ESITO_TIMEOUT);
          registraGuastoAccesso('credenziali', ESITO_TIMEOUT, null, undefined);
          return;
        }
        error = secondo.valore.error;
        riprova = error ? 'fallita' : 'riuscita';
      }

      if (error) {
        mostraErroreAccesso(error, riprova === 'fallita' ? 'fallita' : 'non-serviva');
        return;
      }
      if (riprova === 'riuscita') {
        // Il ricupero riuscito si registra (regola 5 di AGENTS.md): è l'unico modo di
        // sapere quante persone il ritentativo ha salvato, cioè quanto pesasse
        // davvero il difetto degli spazi incollati.
        registraCredenzialiRifiutate({
          esito: 'credenzialiNonValide',
          stato: 400,
          forma: classificaFormaPassword(password),
          spazi: doveSonoGliSpazi(email, password),
          riprova: 'riuscita',
        });
      }
      autenticato = true;

      // Smistamento (M4B.3): profili disponibili da /api/me; identità
      // persistita per coerenza con useSessionIdentity (kv_user_id/kv_user_role).
      //
      // ⚠️ UN `/api/me` CHE RISPONDE MALE NON È UN DEGRADO, È UN GUASTO. Fino al 2026-08-03 un
      // 500 (o un 401, o una pagina HTML al posto del JSON) usciva da `leggiProfilo` come
      // `null` — cioè identico a «questo utente non ha profili» — e finiva nel
      // `router.replace('/')` di fondo funzione: nessun messaggio, nessun log, e una guardia
      // d'area che rispediva al login. Il degrado graceful resta, ma vale solo per una risposta
      // ARRIVATA e VALIDA da cui non si ricava un ruolo.
      const profilo = await eseguiPasso(budget, leggiProfilo(), ESITO_GUASTO_DOPO_ACCESSO);
      if (!profilo.ok) {
        segnalaGuastoDopoAccesso(profilo.chiave, profilo.errore, profilo.stato);
        return;
      }
      const me = profilo.dato;
      if (me?.id) persisti('kv_user_id', String(me.id));
      // ⚠️ `me.role` NON si persiste qui, e la riga che lo faceva è stata tolta: chi ha due
      // profili non ha ancora scelto (scriverebbe `educator` a uno che sta per premere
      // «Genitore»), e chi ne ha uno solo non sa ancora se il server accetterà quel ruolo.
      // Vedi la regola d'ordine su `persisti`.

      const profs: ProfiloDisponibile[] = Array.isArray(me?.profili)
        ? (me.profili as ProfiloDisponibile[])
        : [];
      if (profs.length >= 2) {
        setProfili(profs); // step inline di scelta ruolo
        return;
      }
      const ruolo = profs[0]?.ruolo ?? (me?.role ? String(me.role) : null);
      if (ruolo) {
        // Né best-effort sull'ESITO né sul TEMPO: stesso trattamento del picker e dell'effetto
        // `?scegli=1`. Il «tanto la guardia ha il fallback ruolo unico» che stava scritto qui
        // vale solo se il server riesce a leggere la sessione — cioè proprio ciò che un 401 da
        // questa route dice che NON riesce a fare, e per il 403 vale l'argomento gemello
        // scritto su `impostaRuoloAttivo`.
        const messo = await eseguiPasso(budget, impostaRuoloAttivo(ruolo), 'erroreRuolo');
        if (!messo.ok) {
          segnalaGuastoDopoAccesso(messo.chiave, messo.errore, messo.stato);
          return;
        }
        // DOPO l'accettazione del server, come nelle altre due strade (vedi `persisti`).
        persisti('kv_user_role', ruolo);
        router.replace(destinazione(ruolo, next, password));
        return;
      }

      // Degrado graceful — e adesso è DAVVERO un degrado: `/api/me` ha risposto, il corpo era
      // il nostro, e semplicemente non contiene un ruolo da cui smistare. Mai next grezzo
      // (open redirect): si onorano solo path interni alle aree; per il resto si va alla radice
      // e le guardie server-side faranno il loro lavoro.
      //
      // ⚠️ QUESTA RIGA ERA SCRITTA IN LINEA, ED È L'USCITA CHE SI DIMENTICA. La regola
      // («next solo se interno, altrimenti la radice») è la stessa di `meta`, e passa da
      // `destinazione` per la sola ragione che conta: è l'unica delle quattro uscite senza
      // un ruolo, quindi l'unica che un instradamento «per ruolo» lascerebbe indietro —
      // e chi ci finisce con una password temporanea in mano è, per definizione, qualcuno
      // il cui accesso non si è ancora concluso bene.
      router.replace(destinazione(null, next, password));
    } catch (err) {
      // PER UN FALLIMENTO DELL'ACCESSO questo ramo non era raggiungibile — `signInWithPassword`
      // non lancia — ed è il motivo per cui `erroreConnessione` non si vedeva mai. Ci arriva
      // solo ciò che lancia davvero: `getSupabase()` senza configurazione, o il rifiuto che
      // il tetto di tempo rilancia.
      //
      // A sessione GIÀ SCRITTA, però, la classificazione di sopra racconterebbe una cosa
      // inesatta: `erroreImprevisto` dice «non dipende dalle tue credenziali» a una persona di
      // cui abbiamo appena ACCETTATO le credenziali. È il difetto W8 visto dal ramo d'errore.
      if (autenticato) segnalaGuastoDopoAccesso(ESITO_GUASTO_DOPO_ACCESSO, err, statoErroreAccesso(err));
      else mostraErroreAccesso(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      {!highContrast && <SfondoAuth />}
      {/* ⚠️ QUI NON C'È IL COMANDO DI ALTO CONTRASTO, ED È UNA DECISIONE, NON UNA
          DIMENTICANZA — ma è una decisione che va riaperta.

          Il collaudo a11y del 2026-08-02 ha misurato che /auth/login è l'unica
          superficie pubblica senza il comando (zero bottoni di contrasto nel
          DOM): chi apre l'app per la prima volta e ha bisogno dell'alto
          contrasto per leggere «Email» e «Password» non ha modo di accenderlo, e
          il tema HC della login — che esiste ed è corretto (fondo nero, testo
          bianco, bordi campi 15,91:1) — resta irraggiungibile a meno di fare
          login altrove prima. Il rilievo è fondato.

          Il comando però era stato TOLTO da qui di proposito, «perché la login
          deve stare in una schermata sola, senza scroll», e la scelta è lockata
          in `__tests__/components/login-contrast.test.tsx:43`. Rimetterlo è una
          decisione di prodotto del titolare, non di un giro di pulizia dei
          warning: per questo non è stato fatto qui.

          Nota per chi deciderà: il vincolo «una schermata sola» NON sarebbe
          violato da un comando FUORI dal flusso. `LanguageSwitcher`, due righe
          sotto, sta già in `position:absolute` nell'angolo in alto a destra per
          esattamente quella ragione. Il costo sarebbe una pill di ~143×38 px
          accanto a una di 65×24, con `flex-wrap` per i 320 px. */}
      <div style={{ position: 'absolute', top: 'max(12px, env(safe-area-inset-top))', right: 12, zIndex: 10 }}>
        <LanguageSwitcher />
      </div>

      <div className={styles.scene}>
        {/* logo trim su next/image; il CSS decide la larghezza reale. Resta anche in
            Alto Contrasto (invertito in bianco): è l'unica identificazione del brand. */}
        <div className={styles.logo}>
          <Image src="/logo-kidville.png" alt="Kidville" width={2227} height={571} priority />
        </div>
        {/* mascotte a figura intera (cutout trasparente), sporge sulla card */}
        {!highContrast && (
          <div className={styles.mascot}>
            <Image src="/mascot-hero.png" alt="" aria-hidden width={665} height={994} priority />
          </div>
        )}

        <form onSubmit={onSubmit} className={styles.card} aria-label={t('formLabel')}>
          <h1 className={styles.title}>{t('title')}</h1>
          {/* nodo persistente: React ne muta solo il testo, così il passaggio al
              picker viene annunciato in modo affidabile */}
          <p className={styles.subtitle} role="status">
            {profili ? (
              <>{t('subtitlePicker')}</>
            ) : (
              <>{t('subtitleLogin')}</>
            )}
          </p>

          {error && (
            <div role="alert" id="login-error" className={styles.alert}>
              {error}
            </div>
          )}

          {attesa ? (
            <p className={styles.forgotNote} role="status" style={{ marginTop: 24 }}>
              {t('caricamentoProfili')}
            </p>
          ) : profili ? (
            <div
              ref={gruppoRuoli}
              tabIndex={-1}
              role="group"
              aria-label={t('sceltaRuolo')}
              style={{ marginTop: 24 }}
            >
              {profili.map((p) => (
                <button
                  key={p.ruolo}
                  type="button"
                  disabled={loading}
                  onClick={() => void scegliRuolo(p.ruolo)}
                  className={styles.roleBtn}
                >
                  {labelRuolo(p.ruolo)}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email">
                  {t('email')}
                </label>
                <div className={styles.inwrap}>
                  <span className={styles.lead}>
                    <MailIcon />
                  </span>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="next"
                    placeholder={t('emailPlaceholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={styles.input}
                    // `credenzialiErrate`, non `error`: un servizio giù non rende non valido
                    // ciò che l'utente ha scritto. `aria-describedby` invece resta legato a
                    // QUALUNQUE errore — il messaggio va sentito comunque.
                    aria-invalid={credenzialiErrate}
                    aria-describedby={error ? 'login-error' : undefined}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="password">
                  {t('password')}
                </label>
                <div className={`${styles.inwrap} ${styles.hasEye}`}>
                  <span className={styles.lead}>
                    <LockIcon />
                  </span>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="go"
                    placeholder={t('passwordPlaceholder')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={styles.input}
                    aria-invalid={credenzialiErrate}
                    aria-describedby={error ? 'login-error' : undefined}
                  />
                  {/* nome statico + aria-pressed: un aria-label che cambia insieme
                      allo stato farebbe annunciare "Nascondi password, premuto" */}
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className={styles.eye}
                    aria-pressed={showPassword}
                    aria-label={t('mostraPassword')}
                  >
                    <OcchioPassword off={showPassword} />
                  </button>
                </div>
              </div>

              <button
                type="button"
                className={styles.forgot}
                onClick={() => setShowForgot((s) => !s)}
                aria-expanded={showForgot}
                aria-controls="forgot-note"
              >
                {t('passwordDimenticata')}
              </button>
              {showForgot && (
                <p id="forgot-note" className={styles.forgotNote}>
                  {t('forgotNote')}
                </p>
              )}

              <button type="submit" disabled={loading} aria-busy={loading} className={styles.accedi}>
                {loading ? t('accesso') : t('accedi')}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
