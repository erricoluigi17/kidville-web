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
import { logClient, nomeErrore } from '@/lib/logging/client';
import { useLabelRuolo } from '@/lib/auth/ruoli';
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
function EyeIcon({ off }: { off: boolean }) {
  return off ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a15.5 15.5 0 0 1-3 4M6.2 6.2C3.9 7.6 2.4 9.7 2 12c1 2.5 5 7 10 7a10 10 0 0 0 4.2-.9" />
      <path d="M9.5 9.6a3.4 3.4 0 0 0 4.9 4.7" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7s-9-4.5-10-7z" />
      <circle cx="12" cy="12" r="3.1" />
    </svg>
  );
}

/**
 * Sfondo decorativo, nascosto in Alto Contrasto.
 * Blob e iconcine ripresi dal design "Kidville · Login (standalone)": i path
 * sono quelli originali (spazio 402×874), ritagliati per angolo così restano
 * agganciati ai bordi del viewport anche su schermi larghi.
 */
function BackgroundDeco() {
  return (
    <div className={styles.deco} aria-hidden="true">
      {/* cuneo verde in alto a destra */}
      <svg className={`${styles.blob} ${styles.blobTop}`} viewBox="318 0 84 250">
        <path
          className={styles.fillGreen}
          d="M402,0 L402,250 C 358,246 336,224 326,186 C 317,152 324,100 318,52 C 315,30 318,12 326,0 Z"
        />
      </svg>

      {/* collina verde/teal in basso a sinistra */}
      <svg className={`${styles.blob} ${styles.blobBottomLeft}`} viewBox="0 742 190 132">
        <path className={styles.fillTeal} d="M0,874 L0,742 C 40,724 100,732 146,772 C 176,798 188,840 190,874 Z" />
        <path className={styles.fillGreen} d="M0,874 L0,792 C 30,780 76,786 108,812 C 132,831 144,854 146,874 Z" />
      </svg>

      {/* collina gialla + onda verde in basso a destra */}
      <svg className={`${styles.blob} ${styles.blobBottomRight}`} viewBox="234 718 168 156">
        <path className={styles.fillYellow} d="M402,874 L402,762 C 362,766 306,776 270,810 C 246,832 236,856 234,874 Z" />
        <path className={styles.fillGreen} d="M402,720 C 348,728 298,750 272,788 C 306,760 356,752 402,768 Z" />
      </svg>

      <div className={styles.icons}>
        <svg className={`${styles.ico} ${styles.icoStar}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
          <path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17.8 6.4 20.1l1.4-6.3L3 9.5l6.4-.6L12 3z" />
        </svg>
        <svg className={`${styles.ico} ${styles.icoCloud}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
          <path d="M7 18h10a3.8 3.8 0 0 0 .5-7.6 5.4 5.4 0 0 0-10.5-1.3A3.7 3.7 0 0 0 7 18z" />
        </svg>
        <svg className={`${styles.ico} ${styles.icoRing}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="12" cy="12" r="9" />
        </svg>
        <svg className={`${styles.ico} ${styles.icoHouse}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 11l8-6 8 6" />
          <path d="M6 10v9h12v-9" />
          <path d="M10 19v-5h4v5" />
        </svg>
      </div>
    </div>
  );
}

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

/** Destinazione post-login: `?next=` onorato solo se coerente col ruolo attivo. */
function destinazione(ruolo: string, next: string | null): string {
  if (next) {
    const area = areaFromPath(next);
    if (area && isAreaAllowed(ruolo, area)) return next;
  }
  return homePathForRole(ruolo);
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
 * Un accesso fallito PER UN GUASTO si registra; una password sbagliata no.
 *
 * La ragione è la stessa che tiene i 400 di `/auth/v1/token` fuori dal patch di `fetch`
 * (`src/lib/logging/client.ts`): un refuso al login è un evento normale di ogni giorno di
 * ogni genitore, e spedirlo sarebbe la riga di rumore sotto cui l'incidente vero non si trova
 * più. Ciò che invece NON ha nessun'altra traccia è proprio il caso di T16-F3: il guasto che
 * l'utente vedeva come «credenziali non valide». Da oggi ha un nome nel log — e il TIMEOUT,
 * che non produce nemmeno una risposta HTTP, è visibile SOLO da qui.
 *
 * Nel messaggio non entra nulla dell'utente: né l'email né la password. Solo la nostra
 * classificazione, il nome della classe d'errore e lo status — cioè struttura, non dato. Il
 * lock di quella promessa è in `login-errori-servizio.test.tsx`: fino al 2026-08-03 questa
 * funzione non aveva NESSUNA asserzione addosso, e azzerarne il corpo lasciava verdi tutti e
 * 29 i test del file.
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

/**
 * Il GUASTO di un passo verso le nostre route, con dentro le due sole cose di un errore che
 * possono lasciare il dispositivo: la CLASSE (che `nomeErrore` estrae dal `name`) e lo stato
 * HTTP. Il corpo della risposta non si legge mai — è roba del nostro server, e ciò che scrive
 * dentro un 401 può benissimo essere il nome di chi sta entrando.
 */
interface GuastoPasso {
  guasto: true;
  errore: unknown;
  stato: number | undefined;
}

/** O il passo ha portato a casa il suo dato, o è un guasto. Non esiste una terza forma. */
type EsitoPasso<T> = { guasto: false; dato: T } | GuastoPasso;

/**
 * Il `name` con cui una risposta NON-OK entra nel log. Serve perché `nomeErrore()` fa passare
 * solo la CLASSE dell'errore e mai il messaggio: senza un errore da nominare, un 500 di
 * `/api/me` finirebbe in `app_log` come `errore=errore`, indistinguibile da qualunque altra
 * cosa. Il messaggio contiene il solo status, che è già nel campo `stato`: nessun dato altrui.
 */
function erroreRispostaNonOk(stato: number | undefined): Error {
  const e = new Error(`risposta ${stato ?? '?'}`);
  e.name = 'RispostaNonOk';
  return e;
}

/**
 * UNA CHIAMATA ALLE NOSTRE ROUTE, LETTA PER INTERO — e i tre modi in cui può andare male.
 *
 * Fino al 2026-08-03 questa lettura erano due `.catch(() => null)` e un `if (!res?.ok) return
 * null`: **tre guasti diversi collassati sullo stesso valore di ritorno di «questo utente non
 * ha profili»**. Il chiamante non poteva distinguerli, e infatti non li distingueva — un
 * `/api/me` che rispondeva 500 DOPO un'autenticazione riuscita cadeva nel ramo di degrado, cioè
 * in un `router.replace('/')` senza messaggio e senza una riga di log. Da lì la guardia d'area
 * rimandava a `?scegli=1`, dove la stessa fetch falliva di nuovo, l'elenco tornava vuoto e si
 * ricadeva sul form credenziali: due schermate mute e un giro senza uscita. I due `.catch`
 * erano anche la violazione diretta della regola 6 di AGENTS.md.
 *
 *  · `fetch` rifiuta → la richiesta non è mai arrivata (rete, DNS, CORS): nessuno stato;
 *  · `!res.ok` → il server ha risposto e ha detto di no: lo stato È l'informazione;
 *  · `res.json()` rifiuta → ha risposto qualcosa che non è il nostro JSON, tipicamente la
 *    pagina HTML di un proxy davanti all'API. È lo scenario 3 già collaudato su
 *    `signInWithPassword` un passo più indietro; qui non era coperto e taceva come il primo.
 *
 * Non rifiuta mai: la chiamano percorsi che devono DECIDERE, non morire.
 */
async function passoDiRete<T>(url: string, init?: RequestInit): Promise<EsitoPasso<T | null>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (errore) {
    return { guasto: true, errore, stato: undefined };
  }
  if (!res.ok) {
    return { guasto: true, errore: erroreRispostaNonOk(res.status), stato: res.status };
  }
  try {
    return { guasto: false, dato: (await res.json()) as T };
  } catch (errore) {
    // Il corpo non è il nostro: lo stato resta quello della risposta, che c'è ed è arrivata.
    return { guasto: true, errore, stato: res.status };
  }
}

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

/**
 * `POST /api/auth/active-role`.
 *
 * Il suo esito ha TRE chiamanti — il form credenziali, il picker dei ruoli e l'effetto
 * `?scegli=1` — e fino al 2026-08-03 lo stesso `false` del server riceveva tre trattamenti
 * diversi: uno lo ignorava e navigava lo stesso, uno mostrava un messaggio senza loggare, uno
 * non lo leggeva nemmeno. È la forma esatta del difetto che questa pagina si portava dietro da
 * W8 — una regola valida su una strada e non sulle altre.
 *
 * ⚠️ E NON NAVIGARE È LA SCELTA GIUSTA ANCHE COL PROFILO UNICO, dove il commento di prima
 * dichiarava il fallimento «best-effort perché la guardia ha il fallback ruolo unico».
 *
 * ─── E VALE PER IL 403 QUANTO PER IL 401, ANCHE SE NON PER LO STESSO MOTIVO ───────────
 *
 * Fino al 2026-08-03 questo paragrafo argomentava **solo sul 401** («`resolveIdentity()` non ha
 * visto la sessione, quindi nemmeno `getSessionProfili()` la vedrà»), e la regola la applicava a
 * tutti e due. Un argomento che copre metà dei casi che decide è un argomento che, alla prossima
 * lettura, fa cambiare la regola per il caso che non nomina. I due stati vanno detti separati:
 *
 *  · **401** — `resolveIdentity()` non ha visto la sessione. È transitorio e ritentabile, ed è
 *    anche il caso in cui la guardia d'area non può salvare niente: legge la stessa sessione.
 *  · **403** — «Ruolo non disponibile per questo utente» (`active-role/route.ts`). Sembra
 *    permanente, e in astratto lo sarebbe; nella pratica di questa app la causa più probabile è
 *    ancora **transitoria**, ed è scritta in `getProfiliForAuthUid`: una lettura di `utenti` o
 *    `parents` che fallisce degrada in «meno profili», e un ruolo che non c'è non è ammesso.
 *    La guardia d'area chiama **la stessa** `getSessionProfili()`: se il ruolo manca a lei,
 *    manca anche alla guardia, che non ha nessun fallback da offrire — quello «ruolo unico»
 *    scatta sui profili che ha letto, cioè su quelli che hanno appena prodotto il 403.
 *
 * IL COSTO, dichiarato: se un 403 fosse davvero permanente, prima quell'utente entrava lo stesso
 * (si navigava, e la guardia col profilo unico lo faceva passare) e ora non entra più. Si accetta,
 * per due ragioni: navigare avrebbe portato l'utente in un'area con un ruolo che il server non ha
 * riconosciuto — cioè `kv_user_role` nel client e nessun cookie di ruolo sul server, l'incoerenza
 * descritta su `persisti` — e l'atterraggio sarebbe stato deciso da una guardia che legge la
 * stessa fonte che ha appena detto di no: nel caso migliore un'area diversa da quella attesa, nel
 * caso normale un rimbalzo muto al login. Meglio una frase che si può leggere.
 *
 * ⚠️ QUESTA È UNA DECISIONE DI PRODOTTO, non un dettaglio d'implementazione: va ratificata dal
 * titolare prima del merge (vedi il changelog del PRD). Se un giorno si volesse distinguere —
 * 401 non naviga, 403 naviga e decida la guardia — **il punto da toccare è UNO**: lo `stato`
 * dentro `eseguiPasso`, non i tre chiamanti.
 */
function impostaRuoloAttivo(ruolo: string): Promise<EsitoPasso<unknown>> {
  return passoDiRete('/api/auth/active-role', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruolo }),
  });
}

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
        router.replace(destinazione(ruolo, next));
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
      router.replace(destinazione(ruolo, next));
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
  function mostraErroreAccesso(errore: unknown) {
    const esito: EsitoAccesso = classificaErroreAccesso(errore);
    setChiaveErrore(esito);
    setCredenzialiErrate(!eGuastoDelServizio(esito));
    if (eGuastoDelServizio(esito)) {
      registraGuastoAccesso('credenziali', esito, errore, statoErroreAccesso(errore));
    }
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
      const accesso: Promise<{ error: unknown }> = supabase.auth.signInWithPassword({ email, password });
      // T16-F4 — senza tetto, una risposta che non arriva mai lascia il bottone su
      // «Accesso…» per sempre: nessun messaggio, nessun modo di riprovare.
      const tentativo = await budget.corri(accesso);
      if (tentativo.scaduto) {
        mostraErrore(ESITO_TIMEOUT);
        // Un timeout non produce nessuna risposta HTTP: né il patch di `fetch` né i log del
        // server lo vedranno mai. Questa riga è l'unica traccia che esista.
        registraGuastoAccesso('credenziali', ESITO_TIMEOUT, null, undefined);
        return;
      }
      const { error } = tentativo.valore;
      if (error) {
        mostraErroreAccesso(error);
        return;
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
        router.replace(destinazione(ruolo, next));
        return;
      }

      // Degrado graceful — e adesso è DAVVERO un degrado: `/api/me` ha risposto, il corpo era
      // il nostro, e semplicemente non contiene un ruolo da cui smistare. Mai next grezzo
      // (open redirect): si onorano solo path interni alle aree; per il resto si va alla radice
      // e le guardie server-side faranno il loro lavoro.
      router.replace(next && areaFromPath(next) ? next : '/');
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
      {!highContrast && <BackgroundDeco />}
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
                    <EyeIcon off={showPassword} />
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
