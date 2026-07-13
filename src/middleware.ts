import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { shouldRedirect } from '@/lib/auth/middleware-rules';
import { redigiPathSicuro } from '@/lib/logging/path';
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

/*
 * `redigiPathSicuro` arriva da `@/lib/logging/path`, ed è l'UNICO modulo del logging che si
 * possa importare da qui: non importa niente — né `node:crypto` (che l'Edge rifiuta, ed è la
 * ragione per cui `@/lib/logging/redact` da qui farebbe fallire la build), né Supabase, né
 * `next/*`. Prima l'euristica stava copiata a mano proprio in questo file; ora è una sola, e
 * middleware, instrumentation e browser la condividono. Vedi la testata di `path.ts`.
 *
 * Perché non loggare il path grezzo: in questo repo il path È una credenziale (`/m/<token>`
 * del modulo pubblico è una capability) e gli id dei minori sono segmenti di rotta. Del path
 * serve il PATTERN — "quale rotta ha buttato fuori l'utente" — non l'istanza.
 * La query string non c'è già di suo: `nextUrl.pathname` la esclude (ed è lì che vivono
 * `?userId=`, `?email=`, `?next=`).
 */

export async function middleware(request: NextRequest) {
  const requestId = nuovoRequestId();

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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  if (shouldRedirect(pathname, !!user)) {
    const url = request.nextUrl.clone();
    url.pathname = '/auth/login';
    url.searchParams.set('next', pathname);

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
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$).*)',
  ],
};
