import {
  apriBudgetAccesso,
  ESITO_GUASTO_DOPO_ACCESSO,
  ESITO_TIMEOUT_DOPO_ACCESSO,
} from './errore-accesso';
import { svuotaCacheLocale } from '@/lib/offline/pulizia-cache';
import type { AppRole } from './predicati-ruolo';

/* ════════════════════════════════════════════════════════════════════════════
 * COME SI CAMBIA VESTE — in un posto solo.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 * `passoDiRete` e `impostaRuoloAttivo` erano funzioni PRIVATE di
 * `src/app/auth/login/page.tsx`. Finché l'unico modo di scegliere una veste era
 * il picker del login andava bene; dal momento in cui esiste uno switch dentro
 * l'app, lasciarle lì significa ricopiarle — e la copia diverge al primo
 * ritocco, su una decisione che riguarda il ruolo con cui si guardano i dati di
 * bambini. Sono state SPOSTATE qui (non riscritte) e la login le importa: il
 * suo comportamento non cambia di una riga.
 *
 * ─── NIENTE `next/*`, NIENTE `@supabase/*` ──────────────────────────────────
 * Questo modulo gira nel BROWSER e basta: `fetch`, `localStorage`, Dexie. Non
 * importa `require-staff` nemmeno per il tipo (`AppRole` arriva da
 * `predicati-ruolo`, che è puro): un `import type` è cancellato dal
 * compilatore, ma basta che un domani qualcuno tolga la parola `type` per
 * trascinare il client Supabase del server dentro un bundle del browser.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Il GUASTO di un passo verso le nostre route, con dentro le due sole cose di un errore che
 * possono lasciare il dispositivo: la CLASSE (che `nomeErrore` estrae dal `name`) e lo stato
 * HTTP. Il corpo della risposta non si legge mai — è roba del nostro server, e ciò che scrive
 * dentro un 401 può benissimo essere il nome di chi sta entrando.
 */
export interface GuastoPasso {
  guasto: true;
  errore: unknown;
  stato: number | undefined;
}

/** O il passo ha portato a casa il suo dato, o è un guasto. Non esiste una terza forma. */
export type EsitoPasso<T> = { guasto: false; dato: T } | GuastoPasso;

/**
 * Il `name` con cui una risposta NON-OK entra nel log. Serve perché `nomeErrore()` fa passare
 * solo la CLASSE dell'errore e mai il messaggio: senza un errore da nominare, un 500 di
 * `/api/me` finirebbe in `app_log` come `errore=errore`, indistinguibile da qualunque altra
 * cosa. Il messaggio contiene il solo status, che è già nel campo `stato`: nessun dato altrui.
 */
export function erroreRispostaNonOk(stato: number | undefined): Error {
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
export async function passoDiRete<T>(url: string, init?: RequestInit): Promise<EsitoPasso<T | null>> {
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

/**
 * `POST /api/auth/active-role`.
 *
 * Il suo esito ha QUATTRO chiamanti — il form credenziali, il picker dei ruoli, l'effetto
 * `?scegli=1` e adesso lo switch di profilo dentro l'app — e fino al 2026-08-03 lo stesso
 * `false` del server riceveva tre trattamenti diversi: uno lo ignorava e navigava lo stesso,
 * uno mostrava un messaggio senza loggare, uno non lo leggeva nemmeno. È la forma esatta del
 * difetto che la login si portava dietro da W8 — una regola valida su una strada e non sulle
 * altre — ed è la ragione per cui questa funzione sta qui invece che dentro una pagina.
 *
 * ⚠️ E NON NAVIGARE È LA SCELTA GIUSTA ANCHE COL PROFILO UNICO, dove il commento di prima
 * dichiarava il fallimento «best-effort perché la guardia ha il fallback ruolo unico».
 *
 * ─── E VALE PER IL 403 QUANTO PER IL 401, ANCHE SE NON PER LO STESSO MOTIVO ───────────
 *
 *  · **401** — `resolveIdentity()` non ha visto la sessione. È transitorio e ritentabile, ed è
 *    anche il caso in cui la guardia d'area non può salvare niente: legge la stessa sessione.
 *  · **403** — «Ruolo non disponibile per questo utente» (`active-role/route.ts`). Sembra
 *    permanente, e in astratto lo sarebbe; nella pratica di questa app la causa più probabile è
 *    ancora **transitoria**, ed è scritta in `getProfiliForAuthUid`: una lettura di `utenti` o
 *    `parents` che fallisce degrada in «meno profili», e un ruolo che non c'è non è ammesso.
 *    La guardia d'area chiama **la stessa** `getSessionProfili()`: se il ruolo manca a lei,
 *    manca anche alla guardia, che non ha nessun fallback da offrire.
 */
export function impostaRuoloAttivo(ruolo: string): Promise<EsitoPasso<unknown>> {
  return passoDiRete('/api/auth/active-role', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruolo }),
  });
}

/** Le chiavi i18n con cui si racconta un cambio di veste che non è riuscito. */
export type ChiaveGuastoCambio =
  | typeof ESITO_TIMEOUT_DOPO_ACCESSO
  | typeof ESITO_GUASTO_DOPO_ACCESSO;

/**
 * L'esito del gesto intero. `ok: false` significa **una cosa sola per chi chiama**: resta
 * dove sei, dillo, e lascia una riga di log. Nessun ramo intermedio in cui si naviga «tanto
 * la guardia rimedia»: la guardia legge lo stesso cookie che il server non ha scritto.
 */
export type EsitoCambio =
  | { ok: true }
  | { ok: false; chiave: ChiaveGuastoCambio; errore: unknown; stato: number | undefined };

const CHIAVE_RUOLO = 'kv_user_role';
/**
 * Il figlio selezionato. Vive in `localStorage` e lo legge `getCurrentStudentId`
 * (`use-parent-identity`): è una scelta fatta NELLA VESTE DI FAMIGLIA, e portarsela dietro
 * mostrerebbe al docente un `ChildSwitcher` puntato su un bambino scelto da genitore.
 */
const CHIAVE_FIGLIO = 'kv_student_id';

/** Scrittura in `localStorage` che non lancia: lo storage può essere negato (modalità privata). */
function scrivi(chiave: string, valore: string) {
  try {
    window.localStorage.setItem(chiave, valore);
  } catch {
    /* ignore: la persistenza dell'identità è un'ottimizzazione, non il prodotto */
  }
}

function dimentica(chiave: string) {
  try {
    window.localStorage.removeItem(chiave);
  } catch {
    /* ignore: come sopra */
  }
}

/**
 * CAMBIA VESTE: la POST, e tutto ciò che va rimesso a posto PRIMA di navigare.
 *
 * ─── L'ORDINE È IL RIMEDIO, non uno stile ───────────────────────────────────
 * Ogni riconciliazione sta QUI dentro, con `await`, e non nel chiamante dopo un
 * `router.replace`: la navigazione cancella qualunque lavoro in volo — è la lezione
 * scritta per esteso in `lib/auth/logout.ts:19-22`, dove un `void impostaBadgeNonLette(0)`
 * lasciava sull'icona il numero dell'utente precedente. Qui il lavoro in volo sarebbe lo
 * svuotamento della cache offline, cioè diario, mensa e galleria di **bambini**.
 *
 * ─── I TRE PASSI, E PERCHÉ NON SONO QUATTRO ─────────────────────────────────
 *  1. `kv_user_role` — DOPO il 200 del server, mai prima (regola d'ordine della login);
 *  2. `kv_student_id` — si cancella: appartiene alla veste di famiglia;
 *  3. `svuotaCacheLocale()` — si ATTENDE: dati di minori raccolti nella veste precedente.
 *
 * Ciò che NON si fa, ed è altrettanto deliberato: **niente deregistrazione della push e
 * niente `signOut`**. La sessione non cambia — è la stessa persona — e le notifiche
 * appartengono alla persona, non alla veste. Un `doLogout` mascherato qui dentro
 * chiuderebbe fuori l'utente ogni volta che cambia profilo.
 *
 * `sedi_attive` non compare in questo elenco perché non è roba del client: lo azzera il
 * SERVER, dentro la stessa risposta di `/api/auth/active-role` (vedi la route). È un cookie
 * scritto dal cockpit, e cancellarlo qui vorrebbe dire cancellarlo *dopo* che la risposta è
 * già tornata — cioè lasciare una finestra in cui la richiesta successiva lo porta ancora.
 *
 * @param tettoMs tetto di tempo dell'intero gesto. Chi preme è **già autenticato**: senza
 *   tetto, un `/api/auth/active-role` che non risponde mai lascia il bottone inattivo per
 *   sempre — il difetto W8, già pagato una volta sulla login.
 */
export async function cambiaRuoloAttivo(ruolo: AppRole, tettoMs?: number): Promise<EsitoCambio> {
  const budget = apriBudgetAccesso(tettoMs);
  const esito = await budget.corri(impostaRuoloAttivo(ruolo));

  if (esito.scaduto) {
    return { ok: false, chiave: ESITO_TIMEOUT_DOPO_ACCESSO, errore: null, stato: undefined };
  }
  if (esito.valore.guasto) {
    return {
      ok: false,
      chiave: ESITO_GUASTO_DOPO_ACCESSO,
      errore: esito.valore.errore,
      stato: esito.valore.stato,
    };
  }

  scrivi(CHIAVE_RUOLO, ruolo);
  dimentica(CHIAVE_FIGLIO);
  await svuotaCacheLocale();
  return { ok: true };
}
