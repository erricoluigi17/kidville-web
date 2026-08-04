import { createAdminClient } from '@/lib/supabase/server-client';
import { logEvento } from '@/lib/logging/logger';
import { segnaleConTetto } from '@/lib/logging/tetto';
import { conTettoDiTempo } from '@/lib/auth/errore-accesso';

/**
 * Rate-limiter a finestra scorrevole, con il contatore su POSTGRES.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * COSA C'ERA PRIMA, E COSA IL RILIEVO AVEVA CAPITO A METÀ (2026-08-04)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Fino a oggi lo `store` era una `Map` nello scope del modulo, cioè nella memoria
 * di UN processo Node, e questa testata lo dichiarava per esteso: «il tetto
 * effettivo è N × `limit`».
 *
 * Il collaudo ne aveva ricavato la conclusione sbagliata — «61 richieste
 * consecutive senza un solo 429, il tetto non esiste». Misurato su `app_log`, che
 * persiste ogni 429 come anomalia, il tetto scattava eccome:
 *
 *     /api/iscrizione/sedi              201 · /api/iscrizione/model    61
 *     /api/forms/send-otp                37 · /api/iscrizione          28
 *     /api/public/cancellazione-account  20 · /api/iscrizione/upload   16
 *     /api/logs                          10 · /api/parent/forms/otp     4
 *
 * Il difetto non era l'ASSENZA del tetto: era la sua INDETERMINATEZZA. Chi
 * mandava 61 richieste ravvicinate le vedeva distribuire su più lambda calde e
 * non toccava il tetto di nessuna; chi ne mandava 6 sulla stessa istanza calda
 * veniva fermato. Stesso codice, stesso numero, esito diverso — e nessun modo di
 * sapere, guardando `limit: 5`, che cosa il sistema stesse davvero promettendo.
 *
 * Da qui il contatore vive in `public.tetto_frequenza`, e la decisione la prende
 * `public.tetto_frequenza_consuma()` in UN SOLO statement
 * (`INSERT … ON CONFLICT DO UPDATE … RETURNING`): incremento e verdetto sotto lo
 * stesso lock di riga. Due query separate sarebbero una corsa critica, e N
 * richieste simultanee passerebbero tutte — che su una firma con valore legale
 * significa N tentativi al prezzo di uno.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SE IL DATABASE È LENTO O IRRAGGIUNGIBILE: SI APRE O SI CHIUDE?
 * ════════════════════════════════════════════════════════════════════════════
 *
 * È la domanda vera di questo file, e ha una risposta sola perché le due
 * alternative pure sono entrambe sbagliate.
 *
 *  · FAIL-CLOSED (il DB non risponde → 429) trasforma un rallentamento del
 *    database in un BLOCCO DELLE ISCRIZIONI. Da questa porta arrivano domande di
 *    famiglie vere — 302 dal 16 luglio, misurate il 2026-08-04 — e la finestra è
 *    di dieci minuti: un genitore respinto non ritenta fra dieci minuti, chiude.
 *    E c'è un argomento più forte del danno: sulle rotte che SCRIVONO, se il
 *    database è giù la richiesta fallirebbe comunque un istante dopo. Fail-closed
 *    non protegge niente lì — cambia solo un 500 in un 429. Dove invece fa danno
 *    davvero è sulle rotte di sola LETTURA (`/api/iscrizione/sedi`, che è il
 *    primo passo del wizard): lì spegnerebbe una pagina che avrebbe funzionato.
 *
 *  · FAIL-OPEN INGENUO (il DB non risponde → passa tutto) trasforma un attacco al
 *    database in un varco: chi vuole tentare un milione di codici a sei cifre ha
 *    un modo per togliersi di mezzo il tetto, ed è mettere sotto sforzo la stessa
 *    cosa che il tetto usa per contare.
 *
 * LA SCELTA È LA TERZA, e non è un compromesso di comodo: **si degrada al
 * contatore LOCALE**. La porta resta aperta al traffico legittimo, ma non si apre
 * nel vuoto — chi tira giù il database non ottiene «nessun tetto», ottiene il
 * tetto di ieri (N × `limit`), che è la difesa con cui questo repo ha vissuto
 * finora e con cui ha comunque prodotto 400 risposte 429. L'asimmetria è tutto:
 * un guasto costa PRECISIONE, non PROTEZIONE.
 *
 * E la scelta è VISIBILE: ogni degrado lascia una riga a livello `error`
 * (`logEvento('db','error',…)`, quindi anche in `app_log`), strozzata a una al
 * minuto per istanza — perché un database giù, senza strozzatura, riempirebbe la
 * tabella dei log con la propria stessa diagnosi e accecherebbe chi indaga. Un
 * tetto che non ha potuto decidere non deve mai tacere; non deve nemmeno urlare
 * fino a coprire tutto il resto.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL COSTO, MISURATO
 * ════════════════════════════════════════════════════════════════════════════
 *
 * **Una** andata e ritorno in più per richiesta, mai due (lo misura
 * `__tests__/lib/rate-limit-condiviso.test.ts`, contando le chiamate al client).
 * Con la scadenza qui sotto, il tetto non può costare più di
 * `ATTESA_MASSIMA_DB_MS` a nessuna richiesta.
 *
 * Le rotte che lo pagano sono 18, e le PUBBLICHE — quelle senza nessun gate
 * d'identità, cioè dove il costo lo paga un anonimo e il volume non lo decidiamo
 * noi — sono nove:
 *
 *     POST /api/iscrizione                    (5/10min)
 *     GET  /api/iscrizione/sedi              (30/10min)
 *     GET  /api/iscrizione/model             (30/10min)
 *     POST /api/iscrizione/upload            (30/10min)
 *     POST /api/forms/submit                 (20/10min)
 *     POST /api/public/forms/[token]/submit  (20/10min)
 *     POST /api/public/forms/[token]/upload  (30/10min)
 *     POST /api/public/cancellazione-account  (5/10min)
 *     POST /api/logs                          (per-IP, vedi la route)
 *
 * Tutte e nove parlano già con Postgres nello stesso handler: la connessione è
 * calda e la query è un accesso per chiave primaria. Il `PATCH /api/forms/send-otp`
 * lo paga attraverso `limitaVerificaOtpOggetto` ed è l'unico caso in cui la
 * precisione del tetto ha un valore legale (vedi `otp-rate-limit.ts`).
 *
 * ⚠️ **Il DB E2E della CI non è migrato**: la funzione lì non esiste, PostgREST
 * risponde `PGRST202` e il limitatore degrada al conteggio locale — cioè si
 * comporta esattamente come prima di questo cambiamento. È il degradare pulito
 * che AGENTS.md pretende, e i test E2E non se ne accorgono.
 *
 * `now` resta iniettabile, ma **vale solo per il ramo LOCALE**: il tempo dello
 * store condiviso è quello del server Postgres (`clock_timestamp()`), ed è giusto
 * così — un contatore condiviso da più istanze non può avere l'orologio di una
 * sola di loro.
 */

/** Il tetto di tempo sulla chiamata al DB. Oltre, si degrada: appendersi è peggio. */
export const ATTESA_MASSIMA_DB_MS = 250;

/** Una riga di degrado al minuto per istanza: si dice, senza accecare `app_log`. */
const SILENZIO_LOG_MS = 60_000;

/**
 * Oltre questa soglia lo store locale viene potato delle chiavi scadute.
 *
 * Nella `Map` di prima le chiavi non venivano cancellate MAI — nemmeno quando la
 * finestra era passata da un'ora — e su una rotta pubblica ogni IP che bussava una
 * volta sola lasciava una voce per tutta la vita dell'istanza. Non era il difetto
 * più grave del file, ma era un difetto, e va detto che qui è chiuso per due
 * ragioni indipendenti: perché il conteggio normale ora vive su Postgres (dove la
 * pulizia è un `pg_cron`), e perché anche il ramo di degrado si pota da sé.
 */
const SOGLIA_POTATURA = 512;

/** La potatura è O(n): si fa di rado, non a ogni richiesta. */
const INTERVALLO_POTATURA_MS = 30_000;

/** Una voce dello store LOCALE: i colpi vivi e l'istante in cui smette di contare. */
interface VoceLocale {
  colpi: number[];
  scadeIl: number;
}

const store = new Map<string, VoceLocale>();
let ultimaPotatura = Number.NEGATIVE_INFINITY;
let ultimoLogDegrado = Number.NEGATIVE_INFINITY;

export interface RateLimitOptions {
  /** Numero massimo di richieste nella finestra. */
  limit: number;
  /** Ampiezza della finestra in millisecondi. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Il minimo che serve del client Supabase, descritto per STRUTTURA e non importato
 * come tipo: qui passa anche il finto Postgres dei test, ed è quello che rende
 * possibile provare il comportamento fra due istanze invece di fidarsi.
 */
interface ClientConRpc {
  rpc: (nome: string, argomenti: Record<string, unknown>) => unknown;
}

/** Il builder di PostgREST è thenable e sa ricevere un `AbortSignal`. */
interface BuilderPostgrest {
  abortSignal?: (segnale: AbortSignal) => unknown;
}

type MotivoDegrado =
  | 'client_assente'
  | 'rpc_errore'
  | 'rpc_scaduta'
  | 'rpc_malformata'
  | 'eccezione';

let clientCondiviso: Promise<ClientConRpc | null> | null = null;

function prendiClient(): Promise<ClientConRpc | null> {
  if (!clientCondiviso) {
    clientCondiviso = createAdminClient()
      .then((c) => c as unknown as ClientConRpc)
      .catch((err) => {
        // Un catch che non logga è un bug (AGENTS.md, regola 6). Qui il motivo è
        // per giunta il più insidioso: senza client il tetto è cieco per SEMPRE,
        // non per una richiesta.
        degrada('client_assente', 'sconosciuto', undefined, err);
        clientCondiviso = null; // si riprova alla prossima richiesta
        return null;
      });
  }
  return clientCondiviso;
}

/**
 * La riga che un tetto cieco DEVE lasciare.
 *
 * Nessun dato personale: della chiave si logga il solo GRUPPO (`iscrizione`,
 * `otp-invio`, …) e mai il soggetto, che è un IP o un uuid. L'IP è un dato
 * personale e in `app_log` non ci entra — la regola 8 di AGENTS.md non ha
 * eccezioni «di diagnostica».
 */
function degrada(motivo: MotivoDegrado, gruppo: string, codice?: string, err?: unknown): void {
  const adesso = Date.now();
  if (adesso - ultimoLogDegrado < SILENZIO_LOG_MS) return;
  ultimoLogDegrado = adesso;
  logEvento(
    'db',
    'error',
    {
      operazione: 'security/rate-limit:degrado',
      azione: motivo,
      tipo: gruppo,
      esito: 'conteggio_locale',
      error_code: codice,
      attesa_ms: ATTESA_MASSIMA_DB_MS,
    },
    err,
  );
}

/** `iscrizione:203.0.113.7` → `iscrizione`. Il soggetto non esce da questa funzione. */
function gruppoDi(chiave: string): string {
  const i = chiave.indexOf(':');
  return i > 0 ? chiave.slice(0, i) : 'sconosciuto';
}

/**
 * Consuma una unità sullo store CONDIVISO.
 *
 * Ritorna `null` quando non è riuscita a DECIDERE — e `null` non è mai «passa»:
 * il chiamante ricade sul conteggio locale. Qualunque risposta che non sia una
 * riga ben formata finisce qui: credere a una risposta che non si è capita
 * significherebbe far sparire il tetto senza che niente lo dica, che è il modo di
 * fallire peggiore di tutti.
 *
 * ─── DUE TETTI, ENTRAMBI PRESI IN PRESTITO ─────────────────────────────────
 * Servono davvero tutti e due, e fanno cose diverse: `segnaleConTetto` INTERROMPE
 * la richiesta HTTP (libera la connessione verso Postgres), `conTettoDiTempo`
 * ABBANDONA l'attesa (libera la richiesta del genitore, anche nel caso in cui il
 * client ignorasse il segnale).
 *
 * Nessuno dei due è scritto qui. La prima stesura di questa funzione li aveva
 * riscritti entrambi a mano — `new AbortController()` con un `setTimeout` che lo
 * interrompe, e una `Promise.race` contro una scadenza — e il lock
 * `__tests__/lib/logging-tetto.test.ts` li ha respinti tutti e due nello stesso
 * giro. Aveva ragione: erano la terza e la quarta copia di una decisione che in
 * questo repo deve stare in un posto solo, e una copia in più è una strada che fra
 * sei mesi resta indietro rispetto alle altre col gate verde.
 */
async function consumaCondiviso(
  chiave: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult | null> {
  try {
    const supabase = await prendiClient();
    if (!supabase) return null;

    const query = supabase.rpc('tetto_frequenza_consuma', {
      p_chiave: chiave,
      p_limite: opts.limit,
      p_finestra_ms: opts.windowMs,
    }) as BuilderPostgrest;

    const segnale = segnaleConTetto(ATTESA_MASSIMA_DB_MS);
    const conSegnale =
      segnale !== undefined && typeof query?.abortSignal === 'function'
        ? query.abortSignal(segnale)
        : query;

    const esito = await conTettoDiTempo(conSegnale as Promise<unknown>, ATTESA_MASSIMA_DB_MS);

    if (esito.scaduto) {
      degrada('rpc_scaduta', gruppoDi(chiave));
      return null;
    }

    // PostgREST non lancia: ritorna `{ error }` (AGENTS.md, regola 7). Il valore
    // di ritorno va guardato, sempre.
    const { data, error } = (esito.valore ?? {}) as {
      data?: unknown;
      error?: { code?: string; message?: string } | null;
    };
    if (error) {
      degrada('rpc_errore', gruppoDi(chiave), error.code, error);
      return null;
    }

    const riga = (Array.isArray(data) ? data[0] : data) as
      | { consentito?: unknown; rimanenti?: unknown; riprova_fra_ms?: unknown }
      | undefined
      | null;
    if (
      !riga ||
      typeof riga.consentito !== 'boolean' ||
      typeof riga.rimanenti !== 'number' ||
      typeof riga.riprova_fra_ms !== 'number'
    ) {
      degrada('rpc_malformata', gruppoDi(chiave));
      return null;
    }

    return {
      ok: riga.consentito,
      remaining: riga.rimanenti,
      retryAfterMs: riga.riprova_fra_ms,
    };
  } catch (err) {
    degrada('eccezione', gruppoDi(chiave), undefined, err);
    return null;
  }
}

/** Toglie dallo store locale le chiavi la cui finestra è finita. */
function pota(now: number): void {
  if (store.size <= SOGLIA_POTATURA) return;
  if (now - ultimaPotatura < INTERVALLO_POTATURA_MS) return;
  ultimaPotatura = now;
  for (const [chiave, voce] of store) {
    if (voce.scadeIl <= now) store.delete(chiave);
  }
}

/** Il conteggio PER ISTANZA: il tetto di ieri, che resta come rete di sicurezza. */
function consumaLocale(chiave: string, opts: RateLimitOptions, now: number): RateLimitResult {
  pota(now);
  const colpi = (store.get(chiave)?.colpi ?? []).filter((t) => now - t < opts.windowMs);
  if (colpi.length >= opts.limit) {
    store.set(chiave, { colpi, scadeIl: colpi[0] + opts.windowMs });
    return { ok: false, remaining: 0, retryAfterMs: opts.windowMs - (now - colpi[0]) };
  }
  colpi.push(now);
  store.set(chiave, { colpi, scadeIl: now + opts.windowMs });
  return { ok: true, remaining: opts.limit - colpi.length, retryAfterMs: 0 };
}

/**
 * Consuma una unità del tetto `key`.
 *
 * È ASINCRONA da quando il contatore è condiviso, e non poteva non esserlo: un
 * tetto che vale per tutte le istanze deve chiedere a qualcosa che le istanze
 * hanno in comune. Tutti i chiamanti sono handler `async` — vedi l'elenco delle
 * 18 rotte nella testata.
 */
export async function rateLimit(
  key: string,
  opts: RateLimitOptions,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const condiviso = await consumaCondiviso(key, opts);
  if (condiviso) return condiviso;
  return consumaLocale(key, opts, now);
}

/**
 * Estrae l'IP client dagli header di proxy (best-effort).
 *
 * ⚠️ Il primo hop di `x-forwarded-for` **non è falsificabile su Vercel**: la
 * piattaforma RISCRIVE l'header con l'IP della connessione reale prima che la
 * funzione lo veda, quindi un `x-forwarded-for` mandato dal client non arriva mai
 * qui. Verificato dal vivo il 2026-08-04. Questa nota sta qui perché il dubbio
 * («il tetto per IP si aggira con un header») è ricorrente e ragionevole: è
 * archiviato, non ignorato. Resta vero il contrario — dietro un NAT più famiglie
 * condividono l'IP — ed è il motivo per cui le rotte AUTENTICATE contano
 * sull'utente e non sull'IP (`otp-rate-limit.ts`).
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/** Solo per i test. */
export function resetRateLimit(): void {
  store.clear();
  clientCondiviso = null;
  ultimaPotatura = Number.NEGATIVE_INFINITY;
  ultimoLogDegrado = Number.NEGATIVE_INFINITY;
}

/** Solo per i test: quante chiavi tiene in vita lo store LOCALE. */
export function dimensioneStoreLocale(): number {
  return store.size;
}
