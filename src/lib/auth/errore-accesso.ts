/**
 * PERCHÉ UN FALLIMENTO DI ACCESSO VA CLASSIFICATO — e non è una raffinatezza estetica.
 *
 * `supabase.auth.signInWithPassword()` **non lancia**: ritorna `{ error }`. È la regola 7 di
 * AGENTS.md («PostgREST non lancia: ritorna { error }») nella sua versione auth, e vale per
 * TUTTI i motivi allo stesso modo — password sbagliata, GoTrue che risponde 500 perché il
 * database è giù, rate limit, rete caduta, risposta non-JSON di un proxy davanti all'API.
 * Un `if (error) → «credenziali non valide»` è quindi sintatticamente corretto e
 * semanticamente falso cinque volte su sei.
 *
 * IL COSTO, misurato al collaudo del 2026-08-02 su `/auth/v1/token` intercettata: sei
 * scenari (500, 429, corpo non-JSON, risposta lenta 12 s, rete assente, e un 418 messo
 * apposta) producevano tutti la stessa frase, «Credenziali non valide. L'accesso è solo su
 * invito della Segreteria.» Due conseguenze reali:
 *
 *  · con il database giù, una persona cambia una password che era GIUSTA — e poi telefona
 *    alla Segreteria, che non ha modo di sapere che è in corso un guasto;
 *  · nei log, un'ondata di «credenziali non valide» ha la firma di un ATTACCO. Se è
 *    indistinguibile da un'indisponibilità, il primo incidente vero verrà letto per l'altro.
 *
 * ─── LA DISTINZIONE CHE SI FA, E QUELLA CHE NON SI FA ────────────────────────────────
 *
 * Si distingue **l'errore dell'utente dal guasto del servizio**. NON si distingue fra i tipi
 * di errore dell'utente: `credenzialiNonValide` resta volutamente indistinto fra «l'email non
 * esiste» e «la password è sbagliata». Dirlo a un anonimo trasformerebbe il modulo di login
 * in un oracolo su chi è iscritto a una scuola dell'infanzia — cioè su dei minori.
 *
 * ─── LA TASSONOMIA DI `@supabase/auth-js` (2.110) ────────────────────────────────────
 *
 * Da `dist/main/lib/fetch.js` → `handleError()`, che è l'unico posto in cui questi errori
 * nascono. I due campi che contano sono `name` e `status`:
 *
 *  · `fetch` rifiuta (rete giù, DNS, CORS)   → `AuthRetryableFetchError`, status **0**
 *  · status in `NETWORK_ERROR_CODES`         → `AuthRetryableFetchError`, status **5xx**
 *    (500-504 e i codici Cloudflare 520-530)
 *  · corpo non-JSON su una risposta d'errore → `AuthUnknownError`, **senza** status
 *  · corpo non-JSON su una risposta ok       → `AuthRetryableFetchError`, status **0**
 *  · tutto il resto                          → `AuthApiError`, con lo status di GoTrue
 *    (400 `invalid_credentials`, 429 `over_request_rate_limit`, …)
 *
 * ⚠️ `name === 'AuthRetryableFetchError'` NON basta a dire «rete»: la stessa classe porta sia
 * lo 0 della rete assente sia il 500 del database giù. Lo status va guardato per primo — ed è
 * il motivo per cui l'ordine dei rami qui sotto è parte del contratto, non uno stile.
 */

/**
 * L'esito di un tentativo di accesso fallito. **Ogni valore è anche la chiave di traduzione**
 * nel namespace `auth` (`messages/{it,en}/auth.json`): il chiamante fa `t(classifica(err))` e
 * non c'è nessuna tabella intermedia da tenere allineata a mano. Una chiave in più qui senza
 * la voce nei cataloghi la ferma il lock `messaggi-parita-cataloghi.test.ts`.
 */
export type EsitoAccesso =
  | 'credenzialiNonValide'
  | 'troppiTentativi'
  | 'servizioNonDisponibile'
  | 'erroreConnessione'
  | 'erroreImprevisto';

/** Chiave mostrata quando la risposta non arriva entro il tetto di tempo. */
export const ESITO_TIMEOUT = 'timeoutAccesso' as const;

/*
 * I DUE ESITI DI CIÒ CHE SUCCEDE **DOPO** CHE LA SESSIONE È STATA SCRITTA — e perché non
 * possono riusare i messaggi di sopra.
 *
 * Il difetto W8, misurato il 2026-08-03: il tetto copriva la sola `signInWithPassword`, e
 * subito dopo la stessa funzione aspettava senza tetto `/api/me` e `/api/auth/active-role`.
 * Con `/api/me` che non risponde mai, il bottone restava `disabled` su «Accesso…» per sempre —
 * cioè il sintomo esatto del rilievo T16-F4 — **con l'utente ormai autenticato**: il cookie di
 * sessione c'era già.
 *
 * Quella differenza va detta. `erroreImprevisto` dice «Non dipende dalle tue credenziali»,
 * che è la frase giusta per un guasto di cui non si sa nulla; qui invece si sa di più, e si sa
 * la cosa più utile che ci sia: le credenziali sono state ACCETTATE. Dirlo in modo timido
 * (`non dipende da…`) quando si può dirlo in modo esatto (`sono corrette`) è ancora un
 * messaggio meno vero di quanto potrebbe essere — ed è tutto ciò che una persona bloccata
 * davanti a un modulo ha per decidere se cambiare password o riprovare.
 */
/** Il tetto è scaduto DOPO l'autenticazione: profilo o ruolo non arrivati in tempo. */
export const ESITO_TIMEOUT_DOPO_ACCESSO = 'timeoutDopoAccesso' as const;
/** Un guasto qualunque DOPO l'autenticazione (il ramo `catch` a sessione già scritta). */
export const ESITO_GUASTO_DOPO_ACCESSO = 'erroreDopoAccesso' as const;

/**
 * Ogni messaggio che la schermata di accesso può mostrare è **una chiave del namespace
 * `auth`**: lo stato del componente tiene la CHIAVE, non il testo già tradotto. Non è
 * pignoleria di tipi — è ciò che permette a un `useEffect` di segnalare un guasto senza
 * avere `t` fra le proprie dipendenze (`t` cambia identità a ogni render: nelle dipendenze
 * rilancerebbe l'effetto, cioè la fetch, a ogni render).
 */
export type ChiaveErroreAccesso =
  | EsitoAccesso
  | typeof ESITO_TIMEOUT
  | typeof ESITO_TIMEOUT_DOPO_ACCESSO
  | typeof ESITO_GUASTO_DOPO_ACCESSO;

/**
 * Gli status che sono davvero «hai sbagliato tu».
 *
 * 400 è ciò che GoTrue risponde a `grant_type=password` con credenziali sbagliate; 422 è la
 * validazione (`validation_failed`), cioè ancora l'input di chi scrive. 401 è nell'elenco
 * perché alcune versioni di GoTrue lo usano per lo stesso rifiuto — con una riserva onesta:
 * un 401 può anche voler dire «apikey non valida», che è un guasto di CONFIGURAZIONE nostro.
 * Non è distinguibile dal corpo in modo affidabile, e fra le due lo si tratta come errore
 * dell'utente perché è di gran lunga il caso frequente; il guasto di configurazione resta
 * visibile nel log che il chiamante emette (vedi `eGuastoDelServizio`).
 */
const STATI_UTENTE = new Set([400, 401, 422]);

/** Lo status di un errore auth, se ne porta uno leggibile. */
export function statoErroreAccesso(errore: unknown): number | undefined {
  if (errore === null || typeof errore !== 'object') return undefined;
  const stato = (errore as { status?: unknown }).status;
  return typeof stato === 'number' && Number.isFinite(stato) ? stato : undefined;
}

function nomeDi(errore: unknown): string {
  if (errore === null || typeof errore !== 'object') return '';
  const nome = (errore as { name?: unknown }).name;
  return typeof nome === 'string' ? nome : '';
}

/**
 * Da un errore di `signInWithPassword` alla chiave del messaggio da mostrare.
 *
 * L'ORDINE DEI RAMI È IL CONTRATTO:
 *  1. 429 prima di tutto: è un 4xx, ma non è «hai sbagliato la password» — è «riprova fra un
 *     po'», ed è l'unico messaggio che fa fare all'utente la cosa giusta;
 *
 *     ⚠️ SÌ, IL 429 HA DUE FRASI IN DUE NAMESPACE, ED È VOLUTO. `auth.troppiTentativi`
 *     («Troppi tentativi di accesso…») e `shared.erroreTroppeRichieste` («Troppe richieste in
 *     poco tempo…», codice `TROPPE_RICHIESTE` di `src/lib/ui/esito-fetch.ts`) dicono la stessa
 *     regola in due contesti diversi, e unificarle costerebbe più di quanto renda: sono due
 *     canali che non si toccano — qui la classificazione la fa il CLIENT dallo `status` di
 *     auth-js, là arriva dal SERVER come `codice` nel corpo JSON (lock
 *     `errori-con-codice.test.ts`), e la login un `codice` non lo riceve mai — e le due frasi
 *     non sono intercambiabili: «troppi tentativi di ACCESSO» a chi ha chiesto troppi OTP
 *     sarebbe falso, e la frase generica al login perderebbe l'unica parola che dice a quella
 *     persona che cosa ha fatto. Resta un costo, ed è dichiarato: un domani in cui si volesse
 *     cambiare l'attesa suggerita, i posti da toccare sono due.
 *  2. 5xx: guasto del servizio, chiunque l'abbia avvolto (`AuthRetryableFetchError` per i
 *     codici 500-504/520-530, `AuthApiError` per gli altri);
 *  3. 400/401/422: l'errore dell'utente, l'unico ramo che nomina le credenziali;
 *  4. `AuthRetryableFetchError` rimasto senza status utile (0 o assente): la richiesta non è
 *     mai arrivata a destinazione, o è tornata con qualcosa che non era una risposta;
 *  5. tutto il resto — 418, 403, `AuthUnknownError`, un oggetto che non è nemmeno un errore:
 *     non si sa, e lo si dice. Dire «non lo so» è una diagnosi migliore di una sbagliata.
 *
 * Non lancia per nessun input: la chiamano dei rami d'errore.
 */
export function classificaErroreAccesso(errore: unknown): EsitoAccesso {
  const stato = statoErroreAccesso(errore);

  if (stato === 429) return 'troppiTentativi';
  if (stato !== undefined && stato >= 500) return 'servizioNonDisponibile';
  if (stato !== undefined && STATI_UTENTE.has(stato)) return 'credenzialiNonValide';
  if (nomeDi(errore) === 'AuthRetryableFetchError') return 'erroreConnessione';
  return 'erroreImprevisto';
}

/**
 * Vero quando il fallimento NON è colpa di chi ha digitato. È il discriminante del logging:
 * un guasto del servizio si registra, una password sbagliata no — sarebbe una riga per ogni
 * refuso di ogni genitore, cioè il rumore sotto cui l'incidente vero non si trova più. È la
 * stessa politica del patch di `fetch` in `src/lib/logging/client.ts`, che i 400 su
 * `/auth/v1/token` li lascia deliberatamente passare senza spedirli.
 */
export function eGuastoDelServizio(esito: EsitoAccesso): boolean {
  return esito !== 'credenzialiNonValide';
}

/**
 * IL TETTO DI TEMPO SULL'ACCESSO.
 *
 * Senza, una risposta che non arriva mai lascia il bottone su «Accesso…» per sempre: nessun
 * messaggio, nessun modo di riprovare, e per l'utente l'app è semplicemente morta. Al
 * collaudo è stato misurato anche il caso intermedio (risposta a 12 s), ed è la ragione per
 * cui il tetto NON è stretto: un accesso lento ma vero deve poter riuscire. 15 secondi sta
 * sopra ogni latenza plausibile di GoTrue e sotto la soglia in cui una persona conclude che
 * l'applicazione è rotta.
 *
 * ⚠️ È IL TETTO DELL'INTERA SEQUENZA DI ACCESSO, non di una chiamata (vedi `apriBudgetAccesso`).
 */
export const TETTO_ACCESSO_MS = 15_000;

/** L'esito di una corsa contro il tetto: o è scaduto, o c'è il valore del lavoro. */
export type EsitoTetto<T> = { scaduto: true } | { scaduto: false; valore: T };

/**
 * Corre `lavoro` contro un tetto di tempo.
 *
 * ⚠️ NON è un `AbortController`, ed è una SCELTA — non un'impossibilità. Fino al 2026-08-03 qui
 * c'era scritto che «non può esserlo», ed era più forte del vero: `signInWithPassword()` non
 * accetta un `AbortSignal`, ma il `fetch` lo possiede il client, e `createBrowserClient` accetta
 * `{ global: { fetch } }` esattamente come fa già `src/lib/supabase/server-client.ts` con
 * `creaFetchStrumentato()`. La strada esiste. Costa: `getSupabase()` è un SINGLETON condiviso da
 * tutte le pagine, quindi il segnale andrebbe fatto viaggiare per richiesta (una `AsyncLocalStorage`
 * non c'è nel browser) — cioè riscrivere il trasporto dell'intera applicazione per il caso limite
 * di una schermata. Si è deciso di non farlo, e la richiesta non viene annullata: viene
 * **abbandonata**. La differenza è visibile in un caso solo — se la risposta arrivasse dopo il
 * tetto ed è un successo, la sessione viene comunque scritta e il tentativo successivo
 * dell'utente entra al primo colpo.
 *
 * (Il motivo per cui la distinzione conta: «impossibile» chiude la ricerca, «costoso» la lascia
 * aperta a chi un giorno dovesse annullare davvero una richiesta di autenticazione.)
 *
 * ─── IL RIFIUTO CHE ARRIVA TARDI (e la riga di commento che qui diceva il falso) ──────
 *
 * Un `lavoro` abbandonato può rifiutare DOPO la scadenza, e una promise rifiutata senza
 * gestore è un `unhandledrejection` — che in quest'app non è un dettaglio, ma una riga di log
 * `error` per ogni volta che succede (`installaLoggerClient`). Non succede, e il motivo è
 * `Promise.race` stessa: race chiama `.then(onOk, onKo)` su OGNI elemento, quindi il perdente
 * resta osservato: il suo rifiuto arriva a un gestore che lo scarta perché la corsa è già
 * decisa. `lavoro` ha il gestore del `.then` qui sotto; la promise derivata ce l'ha da race.
 *
 * Fino al 2026-08-03 qui c'era in più una «neutralizzazione» (`then` a due rami, che mappava
 * il rifiuto in un valore e lo rilanciava dopo), documentata come la cosa che REGGEVA questa
 * garanzia. Non la reggeva: toglierla lasciava il test verde, perché la garanzia è di race.
 * È stata rimossa insieme al commento che la dichiarava portante — cinque righe che
 * spiegavano un meccanismo inesistente valgono meno di nessun commento, perché chi legge
 * smette di cercare quello vero. La prova sta in `__tests__/lib/auth-tetto-accesso.test.ts`,
 * che il rifiuto orfano lo misura per davvero (`process.on('unhandledRejection')`).
 */
export async function conTettoDiTempo<T>(lavoro: Promise<T>, ms: number): Promise<EsitoTetto<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scadenza = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });

  try {
    // Due note su questa riga sola:
    //  · l'incarto `{ valore }` non è decorazione: `T` può benissimo essere `null` (una fetch
    //    che porta già il suo `.catch(() => null)`), e senza incarto «ha risposto il lavoro» e
    //    «è scaduto il tempo» sarebbero lo stesso identico valore;
    //  · il rifiuto non viene inghiottito: il `.then` a un ramo solo lo lascia passare, la
    //    corsa rifiuta e l'`await` rilancia — chi ha un `catch` attorno vede il SUO errore.
    const esito = await Promise.race([lavoro.then((valore) => ({ valore })), scadenza]);
    if (esito === null) return { scaduto: true };
    return { scaduto: false, valore: esito.valore };
  } finally {
    // Sempre, anche sul successo: un timer non spento tiene sveglio il processo di test e —
    // peggio — farebbe comparire «il server non risponde» a login già andato a buon fine.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * IL TETTO DELL'INTERA SEQUENZA DI ACCESSO — non della sola chiamata di autenticazione.
 *
 * PERCHÉ UN BUDGET E NON UN TETTO PER CHIAMATA (difetto W8). Entrare in Kidville sono tre
 * attese in fila: `signInWithPassword`, poi `/api/me`, poi `/api/auth/active-role`. Un tetto
 * su ognuna garantirebbe solo che ogni singola chiamata finisce — e nel caso peggiore
 * lascerebbe il bottone su «Accesso…» per 45 secondi, cioè tre volte la soglia oltre la quale
 * `TETTO_ACCESSO_MS` dichiara che una persona conclude che l'app è rotta. Ciò che l'utente
 * misura non è la latenza di una chiamata: è **quanto tempo passa da quando preme «Accedi» a
 * quando succede qualcosa**. Il budget è quel numero, e non cambia se domani la sequenza
 * diventasse di quattro passi.
 *
 * Il prezzo è dichiarato: un accesso di 14 secondi lascia un secondo scarso al resto della
 * sequenza, e può scadere. È la scelta giusta lo stesso — a quel punto la sessione è già
 * scritta, il messaggio lo dice («le credenziali sono corrette»), e il tentativo successivo
 * dell'utente parte da un login già valido.
 */
export interface BudgetDiAccesso {
  /** Corre `lavoro` contro ciò che RESTA del budget. Esaurito, scade all'istante. */
  corri<T>(lavoro: Promise<T>): Promise<EsitoTetto<T>>;
}

export function apriBudgetAccesso(ms: number = TETTO_ACCESSO_MS): BudgetDiAccesso {
  const fine = Date.now() + ms;
  return {
    corri: <T,>(lavoro: Promise<T>) => conTettoDiTempo(lavoro, Math.max(0, fine - Date.now())),
  };
}
