import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { shouldRedirect } from '@/lib/auth/middleware-rules';
import { redigiPathSicuro } from '@/lib/logging/path';
import { conTetto, eTimeout } from '@/lib/logging/tetto';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabase/public-config';

/**
 * Middleware P0: rinnova la sessione Supabase dai cookie (refresh trasparente)
 * e reindirizza le navigazioni di pagina anonime verso `/auth/login`.
 * Le API non vengono mai reindirizzate qui: l'autorizzazione è nei gate.
 *
 * OSSERVABILITÀ — perché qui c'è solo un header e non il logger.
 *
 * Il middleware gira sull'EDGE ed è un'invocazione SEPARATA dalla route: fra i due non
 * corre nessuna catena async, quindi l'AsyncLocalStorage di `@/lib/logging/context` NON
 * li attraversa (aprirlo qui sarebbe un contesto che muore alla fine di questo file).
 * L'unica cosa che passa davvero a valle è un HEADER — ed è per questo che il middleware
 * si limita a coniare `x-request-id` e a metterlo sulla richiesta: è `withRoute`, dall'altra
 * parte, a rileggerlo e ad aprirci sopra il contesto della richiesta. Un solo id di
 * correlazione, dal primo hop all'ultima riga.
 *
 * E non è nemmeno una scelta: importare `@/lib/logging/logger` (o `context`) da qui
 * romperebbe la build. La catena `logger → redact → node:crypto` è un modulo Node che
 * l'Edge Runtime rifiuta. Da qui si scrive a mano, con `console.log`, ed è uno dei tre
 * file che AGENTS.md esenta da `no-console` proprio per questa ragione.
 *
 * Le righe scritte a mano da questo file sono DUE, ed entrambe stanno su un vicolo cieco per
 * l'osservabilità — cioè su un percorso in cui non c'è nessuna route a valle che possa
 * registrarlo:
 *  · `KV_EVT … evt=auth esito=redirect-login` — l'utente sbattuto fuori al login;
 *  · `KV_ERR … evt=auth code=timeout|rete` — GoTrue irraggiungibile o muto (vedi
 *    `TETTO_MIDDLEWARE_MS`), che prima di oggi era un'attesa infinita e silenziosa.
 * Tutto il resto (livelli, `app_log`, corpo dell'errore) resta ai gate, dove il logger esiste.
 */

/**
 * L'id di correlazione della richiesta. Generato QUI e SEMPRE sovrascritto: un
 * `x-request-id` che arriva dal client è INPUT NON FIDATO — è spoofabile (due richieste
 * diverse possono dichiarare lo stesso id, e le righe di un altro utente si confondono
 * con le proprie) e, siccome finisce in ogni riga di un formato A RIGHE, un `\n` nel
 * valore non è un carattere strano: è una riga di log FALSA scritta da chi fa la
 * richiesta. Non si sanifica ciò che arriva: si sostituisce.
 *
 * (`withRoute` normalizza comunque a valle — vedi `requestIdSicuro` in `context.ts`, che
 * accetta solo `[A-Za-z0-9_:.-]{1,64}` — ma la difesa non deve dipendere dal fatto che il
 * secondo presidio ci sia: un uuid v4 rientra in quel formato per costruzione, e anche il
 * ripiego qui sotto è scelto per rientrarci.)
 */
function nuovoRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // `randomUUID` sull'Edge c'è, ma questo file sta sul percorso di OGNI richiesta:
    // un'eccezione qui non sarebbe un log perso, sarebbe un 500 su tutto il sito. La
    // regola vale anche per l'osservabilità del middleware — fail-open, sempre.
    return `mw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * IL TETTO DI TEMPO DEL MIDDLEWARE — la strada più larga che ne era rimasta senza.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * COS'ERA IL DIFETTO. Il `matcher` qui sotto copre tutto tranne gli asset statici: **ogni
 * pagina e ogni route API passa da questo file PRIMA** di arrivare al proprio gate. E il
 * client che sta qui veniva costruito senza `global: { fetch }` — cioè senza il `fetch`
 * strumentato che governa tutto il resto dell'applicazione — e subito dopo faceva
 * `await supabase.auth.getUser()`.
 *
 * È letteralmente lo scenario che `supabase-fetch.ts` cita per motivare il proprio tetto («se
 * GoTrue accetta e tace, senza tetto NESSUNA route risponde più»), su un percorso con raggio
 * d'azione più ampio di quello che quel file protegge: lì il tetto difende le chiamate fatte
 * DENTRO le route, qui si difende la porta da cui passano tutte. Misurato altrove nello stesso
 * ciclo: un bersaglio che ACCETTA la connessione e non risponde mai tiene appesa la `fetch`
 * **150 secondi senza eccezione**, perché `fetch` non ha nessun timeout di suo.
 *
 * PERCHÉ NON SI RIUSA `creaFetchStrumentato`. Perché non può girare qui: la sua catena
 * (`logger → redact → node:crypto`) è un modulo Node che l'Edge Runtime rifiuta, ed è la stessa
 * ragione per cui questo file scrive a mano su console. `@/lib/logging/tetto` invece non importa
 * NIENTE — è nato apposta come primitiva condivisa — quindi il tetto, che è la parte che
 * impedisce lo stallo, si può prendere da lì senza copiarlo. L'osservabilità ricca (livelli,
 * `app_log`, corpo dell'errore) resta fuori: qui c'è la riga essenziale, scritta a mano.
 *
 * È UN BUDGET, NON UN TETTO PER CHIAMATA, ed è la lezione già pagata sul difetto W8
 * (`apriBudgetAccesso` in `src/lib/auth/errore-accesso.ts`): `getUser()` può fare DUE giri di
 * rete — il rinnovo del token (`/auth/v1/token`) e poi `/auth/v1/user`. Con un tetto per
 * chiamata il caso peggiore sarebbe il doppio, cioè trenta secondi su un percorso che sta
 * davanti a ogni richiesta e che la piattaforma taglia prima. Ciò che conta non è che ogni
 * singola chiamata finisca: è quanto tempo il middleware trattiene la richiesta in totale.
 *
 * PERCHÉ 15 SECONDI. Lo stesso numero, per la stessa misura, di `TETTO_MS_DEFAULT`
 * (`supabase-fetch.ts`) e `TETTO_ACCESSO_MS` (`errore-accesso.ts`): al collaudo dell'accesso una
 * risposta lenta ma VERA di GoTrue è arrivata a 12 secondi. Più stretto significherebbe
 * sbattere fuori al login un utente autenticato solo perché GoTrue è lento — che è il guasto
 * opposto e altrettanto reale.
 *
 * COME DEGRADA, e va detto perché è una scelta e non un effetto collaterale: quando il tetto
 * scatta, `auth-js` non lancia — avvolge il rifiuto in un `AuthRetryableFetchError` e `getUser()`
 * ritorna `{ user: null }`. Quindi una navigazione di pagina finisce al login invece di restare
 * appesa per sempre. È **fail-closed**, ed è deliberato: il redirect di questo file non è il
 * controllo d'accesso (quello sta nei gate delle route, e non si tocca), ma lasciar passare una
 * navigazione perché GoTrue è muto sarebbe aprire una strada che oggi non esiste. Meglio un
 * accesso da rifare che una porta che si apre quando il guardiano non risponde.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
const TETTO_MIDDLEWARE_MS = 15_000;

/**
 * Il `fetch` del client di questo file: il budget qui sopra, e una riga quando non ce la fa.
 *
 * SI LOGGA SOLO IL FALLIMENTO DI TRASPORTO (scadenza o rete), mai lo status. Un 400/401 di
 * GoTrue su un cookie scaduto è la risposta CORRETTA a una sessione vecchia, e succede a ogni
 * richiesta di ogni utente con una sessione morta: registrarlo qui vorrebbe dire una riga per
 * richiesta, cioè accecare il canale nel momento in cui serve. È la stessa politica dei livelli
 * di `supabase-fetch.ts`, ridotta all'osso che l'Edge consente.
 *
 * `code=timeout` e `code=rete` sono lo stesso vocabolario di `erroreTimeout` (`tetto.ts`): «non
 * risponde» si ripara alzando il tetto o chiamando il fornitore, «non si raggiunge» si ripara
 * sul DNS o sul firewall, e con un codice solo i due guasti sarebbero indistinguibili.
 *
 * L'errore si RILANCIA sempre: chi lo gestisce è `auth-js`, che lo trasforma in
 * `{ user: null, error }`. Inghiottirlo qui vorrebbe dire consegnargli una `Response` finta.
 */
function fetchConBudget(requestId: string, pathname: string): typeof fetch {
  const fine = Date.now() + TETTO_MIDDLEWARE_MS;
  return async (input, init) => {
    const t0 = Date.now();
    // `Math.max(1, …)`: a budget esaurito si interrompe subito, NON si riparte da quindici
    // secondi. Un millisecondo e non zero perché `AbortSignal.timeout(0)` è un tetto valido ma
    // di lettura ambigua nella riga di log («tetto=0» sembra un tetto assente).
    const resta = Math.max(1, fine - t0);
    // `resta` è UNA variabile sola, e va a due posti: al `signal` della chiamata e alla riga di
    // log. Devono restare lo stesso numero — se divergessero, la riga direbbe un budget mentre
    // alla `fetch` ne va un altro, e chi legge i log smetterebbe di cercare. Non è affidato alla
    // buona volontà: `__tests__/lib/middleware-tetto.test.ts` (test 2) incrocia il valore chiesto
    // ad `AbortSignal.timeout` con quello stampato, e pretende che coincidano.
    try {
      return await globalThis.fetch(input, conTetto(input, init, resta));
    } catch (err) {
      registraGuasto(requestId, pathname, err, Date.now() - t0, resta);
      throw err;
    }
  };
}

/**
 * La riga, e il fatto che non possa rompere niente.
 *
 * FAIL-OPEN, come `nuovoRequestId` e per la stessa ragione (AGENTS.md, regola 9): un'eccezione
 * qui non sarebbe un log perso, sarebbe un 500 su OGNI richiesta del sito — e per giunta
 * proprio mentre è già in corso un guasto. L'errore da consegnare al chiamante lo rilancia il
 * chiamante: questa funzione non ha nessun altro mestiere.
 */
function registraGuasto(
  requestId: string,
  pathname: string,
  err: unknown,
  ms: number,
  tetto: number,
): void {
  try {
    console.error(
      `KV_ERR rid=${requestId} evt=auth code=${eTimeout(err) ? 'timeout' : 'rete'}`
      + ` ms=${ms} tetto=${tetto}`
      + ` path=${redigiPathSicuro(pathname)} msg=${nomeErroreSicuro(err)}`
    );
  } catch {
    // Si perde la riga, non la richiesta.
  }
}

/**
 * Il solo NOME dell'errore, ripulito. Due ragioni per non metterci il messaggio:
 *
 *  · questa è una riga di un formato A RIGHE, e il messaggio di un errore di rete arriva da
 *    undici e dal runtime — non è testo che scriviamo noi, e uno spazio o un `\n` lì dentro
 *    spezzerebbe la riga esattamente come farebbe un `x-request-id` forgiato (vedi sopra);
 *  · il nome è già la diagnosi: `TimeoutError`, `AbortError`, `TypeError`. Il resto («fetch
 *    failed») non aggiunge niente che `code=` non dica già.
 */
function nomeErroreSicuro(err: unknown): string {
  try {
    const nome = (err as { name?: unknown } | null | undefined)?.name;
    if (typeof nome !== 'string') return '?';
    return nome.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || '?';
  } catch {
    return '?';
  }
}

/*
 * `redigiPathSicuro` arriva da `@/lib/logging/path`, ed è l'UNICO modulo del logging che si
 * possa importare da qui INSIEME a `@/lib/logging/tetto`: nessuno dei due importa niente — né
 * `node:crypto` (che l'Edge rifiuta, ed è la ragione per cui `@/lib/logging/redact` da qui
 * farebbe fallire la build), né Supabase, né `next/*`. Prima l'euristica stava copiata a mano
 * proprio in questo file; ora è una sola, e middleware, instrumentation e browser la
 * condividono. Vedi la testata di `path.ts`.
 *
 * Perché non loggare il path grezzo: in questo repo il path È una credenziale (`/m/<token>`
 * del modulo pubblico è una capability) e gli id dei minori sono segmenti di rotta. Del path
 * serve il PATTERN — "quale rotta ha buttato fuori l'utente" — non l'istanza.
 * La query string non c'è già di suo: `nextUrl.pathname` la esclude (ed è lì che vivono
 * `?userId=`, `?email=`, `?next=`).
 */

export async function middleware(request: NextRequest) {
  const requestId = nuovoRequestId();
  // Letto QUI e non più giù: serve anche alla riga di `fetchConBudget`, che nasce prima della
  // chiamata a GoTrue. È una lettura pura di `nextUrl`, senza effetti.
  const pathname = request.nextUrl.pathname;

  /**
   * TRAPPOLA `@supabase/ssr`: `setAll` chiama `request.cookies.set(...)`, che RISCRIVE
   * l'header `cookie` della richiesta, e poi RICREA la response da capo. Gli header
   * vanno quindi ricostruiti DOPO quelle scritture, non prima — altrimenti la response
   * ricreata porterebbe a valle o i cookie vecchi (se si riusasse una copia stantia degli
   * header) o nessun `x-request-id` (se ci si limitasse a `NextResponse.next({ request })`).
   * Per questo la costruzione sta in una funzione richiamabile, invocata in ENTRAMBI i punti.
   */
  const conRequestId = () => {
    const headers = new Headers(request.headers);
    headers.set('x-request-id', requestId);
    return NextResponse.next({ request: { headers } });
  };

  let response = conRequestId();

  const supabase = createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      // Il budget di tempo su TUTTA la sequenza `getUser()`. Senza, una connessione accettata e
      // muta teneva appesa OGNI richiesta del sito. Vedi `TETTO_MIDDLEWARE_MS`.
      global: { fetch: fetchConBudget(requestId, pathname) },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = conRequestId();
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANTE: non eseguire codice tra createServerClient e getUser (refresh).
  //
  // `getUser()` NON lancia su un guasto di trasporto: `auth-js` avvolge il rifiuto della `fetch`
  // in un `AuthRetryableFetchError` e ritorna `{ data: { user: null }, error }` (verificato nel
  // sorgente: `_getUser`, ramo `catch (error) → isAuthError`). Quindi una scadenza del budget
  // qui sopra non diventa un 500 su tutto il sito: diventa «nessun utente», e il ramo di
  // redirect sotto la registra come qualunque altra sessione assente.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (shouldRedirect(pathname, !!user)) {
    /**
     * `next` PORTA ANCHE LA QUERY, e la pagina di login non ne eredita nessun'altra.
     *
     * Prima qui c'era `url.searchParams.set('next', pathname)` su un `clone()`, e faceva
     * due cose sbagliate insieme. MISURATO su `/admin/staff?tab=scadenze&stato=scaduto` —
     * il bersaglio della notifica di scadenza documenti:
     *   · `next` valeva `/admin/staff` NUDO, quindi chi rifaceva il login atterrava sulla
     *     linguetta «Personale» senza filtro: la notifica arrivava, la sessione era
     *     scaduta (è il caso NORMALE per un avviso notturno letto la mattina), e il gesto
     *     che l'avviso prometteva si perdeva nel login. Una notifica che chiede di
     *     ritrovare a mano la riga si impara a ignorare;
     *   · il `clone()` si portava dietro la query ORIGINALE, e la pagina di login si
     *     ritrovava addosso `?tab=scadenze` — parametri di un'altra pagina, sui quali un
     *     domani il login potrebbe reagire per sbaglio.
     *
     * Perciò: URL costruita da zero (nessun parametro ereditato) e `next` col percorso
     * COMPLETO. Resta relativo e comincia con `/`: `destinazione()` sul login lo passa
     * comunque da `areaFromPath` + `isAreaAllowed`, che si fermano al pathname — un
     * `//evil.com/admin/x` non è mai stato e non diventa un'area valida.
     */
    const url = new URL('/auth/login', request.nextUrl.origin);
    url.searchParams.set('next', `${pathname}${request.nextUrl.search}`);

    // Il ramo di redirect è un vicolo cieco per l'osservabilità: non c'è nessuna route a
    // valle che possa loggarlo (la richiesta finisce qui), e "l'utente sbattuto fuori al
    // login senza capire perché" è la classe di guasto più fastidiosa che abbiamo — oggi
    // completamente invisibile. Quindi la riga si scrive qui, a mano, nel formato del
    // logger (marker + logfmt) così che sia cercabile su Vercel come tutte le altre:
    // `KV_EVT` come marker, `rid`/`evt` come chiavi. Il path è ridotto a pattern.
    console.log(
      `KV_EVT rid=${requestId} evt=auth esito=redirect-login path=${redigiPathSicuro(pathname)}`
    );

    // `NextResponse.redirect` non accetta `request: { headers }`: a valle non va più nulla.
    // L'header sulla RISPOSTA resta però utile — è l'id che il client (e chi legge il
    // browser) può citare per farsi ritrovare questa riga nei log.
    const redirect = NextResponse.redirect(url);
    redirect.headers.set('x-request-id', requestId);
    return redirect;
  }

  // Anche sulla risposta, non solo sulla richiesta: verso valle serve a `withRoute` per
  // correlare, verso monte serve a chi guarda il browser per citare l'id giusto.
  response.headers.set('x-request-id', requestId);
  return response;
}

export const config = {
  // Escludi asset statici e immagini; la logica pubblica/API è in middleware-rules.
  //
  // `webmanifest` è nell'elenco per una ragione precisa: `/manifest.webmanifest` NON è una
  // pagina e non ha una sessione. Passando di qui verrebbe rediretto al login come qualunque
  // rotta non pubblica, e il browser — che lo scarica prima e fuori dalla sessione — leggerebbe
  // l'HTML del login al posto del JSON: niente installazione della web app, niente icona sulla
  // schermata Home. Stessa logica per cui `favicon.ico` è escluso qui accanto.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|webmanifest|woff2?)$).*)',
  ],
};
