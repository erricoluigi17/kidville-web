import { createHash } from 'node:crypto'

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { haCookieSessioneNellIntestazione } from '@/lib/auth/session-cookie'
import { comuniDiProvincia, comunePerBelfiore, siglePresenti, type Comune } from '@/lib/fiscale/comuni'
import { withRoute } from '@/lib/logging/with-route'
import { clientIp, rateLimit } from '@/lib/security/rate-limit'
import { parseQuery } from '@/lib/validation/http'

/**
 * =============================================================================
 * GET /api/anagrafiche/comuni — la tendina a cascata provincia → comune.
 * =============================================================================
 *
 * ─── PERCHÉ QUESTA ROUTE ESISTE ────────────────────────────────────────────────
 * È il SOLO consumatore di `@/lib/fiscale/comuni`, cioè delle 13.656 righe della
 * tabella Belfiore (~294 KB di testo). Quel dataset non deve mai finire nel bundle
 * del browser — per comporre il codice fiscale di un bambino servono QUATTRO
 * caratteri, non la tabella — e il lock che lo impone è
 * `__tests__/architecture/dataset-comuni-fuori-dal-bundle.test.ts`.
 *
 * Questa route è la porta che rende quel divieto sostenibile: al client arriva
 * l'elenco già ridotto alla provincia scelta (Torino, il caso peggiore d'Italia,
 * sono 33 KB con tutte le denominazioni storiche; Napoli 6 KB con le sole attive).
 * Se sparisse, il divieto tornerebbe a essere una privazione e qualcuno lo
 * aggirerebbe importando il dataset da un componente `'use client'` — che compila,
 * passa i test e non accende nessun errore.
 *
 * ⚠️ E OGGI NON LA CHIAMA NESSUNO. Va scritto qui, perché è la sola cosa che nessuno
 * misura da solo: `grep -rn 'anagrafiche/comuni'` (fuori da `node_modules`/`.next`)
 * il 2026-08-10 trova questo file, i suoi test, `gate-coverage`, `zod-coverage` e un
 * commento in `rate-limit.ts` — nessun `fetch` da un client. Finché resta così è una
 * superficie PUBBLICA senza gate che provoca una scrittura service-role sul contatore
 * del tetto a ogni richiesta, e non serve a nessun utente: il rilascio ha senso solo
 * insieme alla tendina che la consuma.
 *
 * E il debito che questa route esiste per sanare è ancora intatto: la deroga
 * `src/lib/utils/fiscalCodeApi.ts` in `dataset-comuni-fuori-dal-bundle.test.ts` — 425
 * KB di `codice-fiscale-js` in un chunk del browser — è al suo posto, e quel lock
 * pretende che venga TOLTA quando il ripiego passerà di qui. Non è stato fatto in
 * questo lavoro: quel file sta fuori da questo perimetro.
 *
 * Il modulo `comuni.ts` costruisce il proprio indice AL PRIMO USO e non
 * all'import: la prima richiesta di ogni istanza paga il parsing, le successive no.
 * Per questo la validazione della sigla (`siglePresenti()`) sta DENTRO il `refine`
 * e non in una costante di modulo — una costante lo farebbe pagare anche alle
 * richieste che finiscono in 400.
 *
 * ─── NIENTE GATE DI RUOLO. QUANTO AL DATABASE, LA VERITÀ È PIÙ LUNGA ───────────
 * Non c'è `requireStaff`/`requireUser`: la chiama un ANONIMO dal wizard pubblico
 * d'iscrizione, che un account non ce l'ha ancora, e ciò che restituisce è un dato
 * aperto — l'elenco dei comuni italiani, lo stesso che chiunque scarica
 * dall'Agenzia delle Entrate. Un anonimo che passa non ottiene niente che non fosse
 * già suo.
 *
 * ⚠️ Questa testata, fino al 2026-08-10, diceva «e non c'è nessun `.from(`/`.rpc(`».
 * Nel CORPO dell'handler è vero, ma il comportamento a runtime è un altro: la prima
 * riga chiama `rateLimit()`, che apre un `createAdminClient()` (SERVICE ROLE) e fa
 * `rpc('tetto_frequenza_consuma', …)` — cioè una SCRITTURA su
 * `public.tetto_frequenza`, provocabile da un anonimo, una per richiesta. Non tocca
 * nessun dato di famiglie e non è una query applicativa, ma è un accesso al
 * database, e chiamarlo «nessuno» era una promessa che il codice non manteneva.
 * (Se Postgres non risponde entro `ATTESA_MASSIMA_DB_MS` il contatore degrada al
 * conteggio locale: vedi la testata di `src/lib/security/rate-limit.ts`.)
 *
 * Quel service role è TRANSITIVO, ed è bene sapere che nessun lock lo conta come
 * tale: `isolamento-sede-coverage` guarda il codice di QUESTO file, dove
 * `createAdminClient` non compare — la parola qui sopra sta in un commento, e per
 * qualche ora del 2026-08-10 è bastata a far contare questa route fra le 280 con
 * service role, perché quel lock leggeva il sorgente grezzo. Corretto lì (vedi
 * `usaServiceRole`), non qui: un commento deve poter NOMINARE la funzione di cui
 * parla. Se un domani si volesse un inventario degli accessi transitivi, si
 * costruisce sul grafo dei moduli, non su una `grep` di prosa.
 *
 * La decisione sul gate è dichiarata, non implicita: sta in `PUBBLICHE` di
 * `__tests__/architecture/gate-coverage.test.ts`, con la sua ragione scritta.
 * Il perimetro che resta è il tetto di frequenza per IP, qui sotto.
 *
 * ─── ⚠️ L'UNICA RISPOSTA DI QUESTA APPLICAZIONE CHE SI PUÒ METTERE IN CACHE ────
 * ─── CONDIVISA. NON COPIARE QUESTE INTESTAZIONI ALTROVE. ───────────────────────
 * `public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800` dice a ogni
 * proxy e a ogni CDN fra qui e il browser che questa risposta può essere
 * conservata e RISERVITA A CHIUNQUE ALTRO per un giorno. Qui è corretto perché il
 * corpo non dipende da chi chiama e non contiene nessun dato personale: comuni e
 * stati esteri, gli stessi per tutti, fermi da anni.
 *
 * `s-maxage` non è un doppione di `max-age`: sulla piattaforma dove questo codice
 * gira è LA direttiva che decide. La documentazione Vercel («Set CDN Cache Freshness
 * with s-maxage», `vercel.com/docs/caching/cache-control-headers`) dice che è
 * `s-maxage` a essere consumato dal proxy — che poi lo TOGLIE prima di consegnare la
 * risposta al client, dove resta `max-age` per il browser. Senza, «una volta sola per
 * provincia grazie alla cache» sarebbe una promessa sulla sola cache del browser.
 *
 * Su QUALUNQUE altra risposta di questo progetto sarebbe un incidente. Le altre
 * route parlano di 33 alunni e delle loro famiglie: una cache pubblica su una di
 * quelle significa il diario di un bambino servito dal proxy al genitore di un
 * altro, senza che nessun log lo registri e senza che nessun test diventi rosso —
 * il difetto invisibile per definizione. È il motivo per cui nel resto del repo si
 * scrive `Cache-Control: no-store`, e per cui questa deroga porta il proprio
 * cartello addosso.
 *
 * ─── ⚠️⚠️ E IL CARTELLO NON BASTAVA: IL MIDDLEWARE CI ATTACCA UN `Set-Cookie` ───
 * Il ragionamento qui sopra è vero e si fermava un passo prima della fine: parla del
 * CORPO («non dipende da chi chiama»), che è corretto, e non degli INTESTAZIONI
 * della risposta, che dipendono eccome da chi chiama.
 *
 * Il `matcher` di `src/middleware.ts` copre anche `/api` (esclude i soli asset
 * statici), e per ogni richiesta esegue `supabase.auth.getUser()`. Quando la
 * sessione va rinnovata — o va CANCELLATA — `setAll` fa `response.cookies.set(...)`,
 * e Next fonde quegli header nella risposta finale della route.
 *
 * NON è una deduzione dal codice: è una MISURA, presa il 2026-08-10 sul `next start`
 * già in ascolto sulla 3100 di questa macchina, su una route API vera:
 *
 *     $ curl -sS -o /dev/null -D - http://localhost:3100/api/health
 *     HTTP/1.1 503 …            (nessun set-cookie)
 *
 *     $ curl -sS -o /dev/null -D - \
 *         -H 'Cookie: sb-uimulkjyekgemjakmepp-auth-token=base64-eyJhIjoxfQ' \
 *         http://localhost:3100/api/health
 *     HTTP/1.1 503 …
 *     set-cookie: sb-uimulkjyekgemjakmepp-auth-token=; Path=/; Max-Age=0; SameSite=lax
 *
 * Cioè: un `Set-Cookie` di sessione scritto dal MIDDLEWARE compare sulla risposta di
 * una ROUTE API che quel cookie non l'ha mai toccato. Se questa route rispondesse
 * sempre `public`, un utente già autenticato (segreteria, genitore, la schermata dei
 * codici fiscali) potrebbe ricevere `Set-Cookie: sb-*-auth-token=…` INSIEME a
 * `Cache-Control: public`: una cache condivisa memorizzerebbe il token di sessione e
 * lo riservirebbe. È l'anti-pattern che RFC 6265 §8.5 nomina, e in questo repo i
 * cookie di sessione non sono nemmeno `HttpOnly` (rilievo W1 del collaudo di
 * sicurezza), quindi il token riservito sarebbe leggibile anche da JavaScript.
 *
 * PERCHÉ NON SI CHIUDE DAL `matcher`. Escludere `/api/anagrafiche/comuni` dal
 * middleware chiuderebbe la strada oggi, ma sposterebbe la correttezza di QUESTA
 * intestazione dentro una regex scritta in un altro file, che nessun test di questa
 * route legge: basterebbe che qualcuno riscrivesse il matcher — cosa che succede per
 * ragioni che con la cache non c'entrano niente — perché la falla tornasse in
 * silenzio. La condizione si valuta dove l'intestazione si scrive.
 *
 * QUINDI: `public` **solo** quando la richiesta non porta un cookie di sessione
 * Supabase, cioè esattamente quando il middleware non ha niente da rinnovare né da
 * cancellare. Chi risponde a quella domanda NON è una regex di questo file: è
 * `haCookieSessioneNellIntestazione` di `src/lib/auth/session-cookie.ts`, il file
 * canonico dove il nome `sb-<ref>-auth-token` è scritto UNA volta sola (vedi il
 * blocco più sotto, che racconta la copia divergente che stava qui). Quando invece
 * il cookie c'è, la risposta è `private`: il browser di quell'utente la tiene lo
 * stesso — il beneficio per la famiglia resta — ma nessuna cache condivisa può
 * conservarla. E `Vary: Cookie` sta su ENTRAMBE le strade, perché una cache che
 * avesse già in mano la copia pubblica non deve poterla servire a una richiesta con
 * cookie diversi.
 *
 * ⚠️ QUANTO VALE DAVVERO `Vary: Cookie`, detto qui perché non lo scopra qualcuno
 * dopo. `Vary` non è un interruttore: per RFC 9111 §4.1 una risposta conservata si
 * può riusare solo per una richiesta le cui intestazioni ELENCATE combaciano. Con
 * `Vary: Cookie` ogni valore diverso dell'header `Cookie` è dunque una VOCE DI CACHE
 * a sé, e la copia condivisa serve in pratica le sole richieste che non mandano
 * nessun cookie. La promessa «una volta sola per provincia» vale per quelle — che
 * nel wizard pubblico sono la maggioranza — e non per tutte.
 *
 * E il `Vary: Cookie` scritto qui ARRIVA davvero al client? La domanda è legittima,
 * perché Next scrive un `vary` suo su ogni risposta di route (misurato il 2026-08-10
 * sul `next start` della 3100: `GET /api/health` →
 * `vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch`).
 * Se quello strato SOSTITUISSE invece di accodare, questa difesa sparirebbe in
 * produzione senza che nessun test qui dentro se ne accorga.
 *
 * MISURATO, non dedotto, sul codice di Next 16.3.0 installato in `node_modules`:
 * `sendResponse` (`next/dist/server/send-response.js`) tiene un elenco esplicito di
 * intestazioni a valori multipli — `set-cookie`, `www-authenticate`,
 * `proxy-authenticate`, `vary` — e per quelle chiama `res.appendHeader` invece di
 * saltarle quando sono già presenti. Fatto girare su un server HTTP vero, con la
 * `Response` di questa route e il `vary` di Next già impostato, il client riceve:
 *
 *     vary: rsc, next-router-state-tree, next-router-prefetch,
 *           next-router-segment-prefetch, Cookie
 *
 * Cioè `Cookie` si ACCODA. (È lo stesso elenco che fa arrivare a valle il
 * `Set-Cookie` del middleware: la fusione che qui ci difende è la stessa che lì ci
 * minaccia.) Resta comunque vero che la difesa principale non è `Vary` ma `private`
 * sul ramo con sessione: `Vary` protegge la copia già conservata, `private` impedisce
 * che se ne conservi una.
 *
 * L'`ETag` è l'impronta del corpo: alla scadenza il browser rimanda
 * `If-None-Match` e si prende un 304 vuoto invece di 33 KB. È la differenza fra
 * pagare Torino una volta e pagarlo ogni giorno, sulla rete mobile di una famiglia.
 * =============================================================================
 */

/** Tetto per IP: generoso, perché la tendina si ricarica a ogni cambio di provincia. */
const TETTO = { limit: 60, windowMs: 10 * 60 * 1000 }

/**
 * Le due intestazioni di cache, e perché sono DUE. La lunga spiegazione sta nella
 * testata: qui basta la regola. `public` = «qualunque proxy può conservarla e
 * riservirla a chiunque»; `private` = «solo la cache del browser di chi ha chiesto».
 * La seconda si usa quando il middleware potrebbe attaccare un `Set-Cookie` di
 * sessione a questa stessa risposta — misurato, non supposto.
 */
const CACHE_CONDIVISA = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800'
const CACHE_PRIVATA = 'private, max-age=86400, stale-while-revalidate=604800'

/**
 * ─── IL NOME DEL COOKIE DI SESSIONE NON SI RISCRIVE QUI ────────────────────────
 *
 * Chi decide che cos'è un cookie di sessione Supabase è UN SOLO file:
 * `src/lib/auth/session-cookie.ts`, con la regola `/^sb-.+-auth-token(\.\d+)?$/` e
 * la funzione `haCookieSessioneNellIntestazione(cookieHeader)`. Non è un modulo
 * lontano: `withRoute` — il wrapper di QUESTA route — lo importa alla sua prima
 * riga, quindi è già nel grafo dei moduli di questo handler.
 *
 * Fino al 2026-08-10 questo file ne portava una SECONDA COPIA
 * (`/^sb-[A-Za-z0-9_.-]+-auth-token(\.\d+)?$/`), scritta a mano con la stessa
 * motivazione — «l'header grezzo, perché i test chiamano con una `Request` nuda» —
 * che in `session-cookie.ts` era già lì parola per parola. Ed era GIÀ divergente:
 * misurato, le due regole rispondono in modo diverso su `sb-a b-auth-token` e
 * `sb-%C3%A8-auth-token`, e in entrambi i casi la copia diceva «non è una sessione»
 * dove la canonica dice di sì. Cioè la divergenza puntava esattamente dalla parte
 * sbagliata: la copia mandava sul ramo `public` una richiesta che la regola
 * canonica manda su `private`. Lì il prezzo di una divergenza era un livello di log;
 * qui è un token di sessione in una cache condivisa.
 *
 * La funzione canonica è un rimpiazzo esatto: stessa firma sull'header grezzo e
 * accetta `null`. Il suo criterio è volutamente LARGO — «qualunque cosa fra `sb-`
 * e `-auth-token`» — e per questa route larga significa prudente: più nomi
 * riconosciuti = più risposte `private`.
 *
 * ⚠️ IL SUO `catch` NON È UN «fail-safe» QUI, e fino al 2026-08-10 questa riga lo
 * chiamava così. La parola era copiata dalla ragione vera, che sta in
 * `session-cookie.ts:30-32` e vale per l'ALTRA funzione: là il default «non
 * autenticato» è sicuro perché il consumatore è il gate biometrico, e spegnerlo
 * evita di chiudere l'utente fuori dall'app. Su QUESTA route il default è
 * l'opposto: `haCookieSessioneNellIntestazione` ritorna `false` (`session-cookie.ts:60-62`),
 * `false` è il ramo `CACHE_CONDIVISA`, cioè `public` verso ogni cache condivisa —
 * la direzione PERICOLOSA, esattamente quella che questa route esiste per non
 * prendere. Se qui servisse un default, servirebbe INVERTITO.
 *
 * Non è un difetto aperto, ed è per questo che si scrive invece di correggere: su
 * un argomento di tipo `string` quel `catch` è IRRAGGIUNGIBILE. `split()` non
 * lancia, `[0]` di un array mai vuoto è una stringa, `trim()` non lancia, e
 * `RegExp.test` su una regex senza `/g` nemmeno. È questo il fatto — «codice
 * morto» — non «fail-safe». Chi un giorno rendesse quel corpo capace di lanciare
 * (una normalizzazione, una decodifica percent, un limite di lunghezza) apra un
 * ramo `catch` PROPRIO qui dentro che scelga `CACHE_PRIVATA`, invece di ereditare
 * un default scritto per un gate biometrico.
 * Se un giorno servisse un criterio DIVERSO da quello del logging, la seconda
 * regola va dichiarata lì accanto alla prima, come funzione esportata, non
 * riscritta dentro una route.
 *
 * ─── PERCHÉ IL NOME DEL COOKIE, E NON «C'È UN COOKIE QUALSIASI» ────────────────
 * La ragione è STRUTTURALE, ed è l'unica che si può dimostrare: a scrivere il
 * `Set-Cookie` su questa risposta è `setAll` di `@supabase/ssr`, chiamato dal
 * middleware sul rinnovo o sulla cancellazione della sessione. Quel percorso lo
 * accendono i soli cookie `sb-<ref>-auth-token`; un cookie che non è di sessione non
 * produce nessun `Set-Cookie` e quindi non c'è niente da proteggere.
 *
 * ⚠️ Fino al 2026-08-10 qui c'era scritta un'altra ragione, e ERA FALSA: «nel wizard
 * pubblico un `NEXT_LOCALE` c'è quasi sempre». `NEXT_LOCALE` non esiste in questa
 * applicazione — `grep -rn NEXT_LOCALE src/` trovava quella riga di commento e basta.
 * Il cookie della lingua qui si chiama `KV_LOCALE` (`src/i18n/config.ts:11`), e
 * next-intl gira SENZA routing per-locale, quindi non lo scrive di suo: l'unico punto
 * che lo scrive è `LanguageSwitcher.tsx:12`, cioè solo se l'utente cambia lingua a
 * mano. Sbagliato il nome e sbagliato il «quasi sempre».
 *
 * IPOTESI, dichiarata come tale: i cookie che una richiesta anonima può portare
 * comunque (analytics, terze parti, un `KV_LOCALE` di chi è passato all'inglese, o
 * qualunque cookie futuro) esistono, e con la regola larga spegnerebbero la cache
 * condivisa per quelle richieste. Ma non è la ragione della scelta — la ragione è
 * quella strutturale qui sopra: se il criterio fosse «un cookie qualsiasi» si
 * spegnerebbe `public` per richieste in cui nessun `Set-Cookie` può nascere.
 */

/**
 * Il flag booleano come arriva da una query string, senza indovinare.
 *
 * `?includiSoppressi` nudo vale `''` (è così che `parseQuery` lo consegna) e
 * significa «sì»: è la forma naturale di un flag in un URL. `1`/`true` e
 * `0`/`false` sono le due scritture esplicite. Tutto il resto è un 400, e non un
 * «boh, sarà falso»: un valore che il chiamante crede di aver messo non può
 * evaporare in silenzio — è la stessa regola d'oro che `comuni.ts` applica alla
 * provincia mal tipata.
 */
const FLAG = z
  .enum(['', '1', 'true', '0', 'false'])
  .transform((v) => v === '' || v === '1' || v === 'true')

const querySchema = z
  .object({
    /**
     * La sigla della provincia. Le due lettere non bastano: deve essere una sigla
     * PRESENTE NEL DATASET, e l'elenco si chiede a `siglePresenti()` invece di
     * cablarlo. Sono 110 voci — le 107 province di oggi, `EE` per chi è nato
     * all'estero e le storiche `PL` (Pola) e `ZA` (Zara) — e un elenco copiato qui
     * sarebbe sbagliato il giorno in cui il dataset viene rigenerato, respingendo
     * una provincia che esiste o accettandone una che non c'è più.
     */
    provincia: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'La provincia è una sigla di due lettere (es. NA, EE)')
      .transform((s) => s.toUpperCase())
      .refine((s) => siglePresenti().includes(s), 'Sigla di provincia sconosciuta')
      .optional(),

    /**
     * Le denominazioni SOPPRESSE (comuni fusi, rinominati, estinti). Senza questo
     * flag un genitore nato nel 1978 in un comune che oggi non esiste più non
     * troverebbe il proprio comune di nascita, e finirebbe per sceglierne uno
     * sbagliato: nel codice fiscale di un bambino quel comune ci resta.
     */
    includiSoppressi: FLAG.optional(),

    /**
     * La risoluzione di un SINGOLO codice catastale, per mostrare in chiaro un
     * valore storico già in archivio (`alunni.codice_belfiore_nascita`,
     * `parents.codice_belfiore_nascita`) senza costringere il client a scaricare la
     * provincia intera per tradurre quattro caratteri.
     */
    belfiore: z
      .string()
      .trim()
      .regex(/^[A-Za-z][0-9]{3}$/, 'Il codice catastale è una lettera seguita da tre cifre')
      .transform((s) => s.toUpperCase())
      .optional(),
  })
  .superRefine((q, ctx) => {
    // Esattamente uno dei due modi. Nessuno dei due → si risponderebbe con l'Italia
    // intera (13.656 righe), che è esattamente ciò che questa route esiste per non
    // fare. Tutti e due → la richiesta chiede due cose diverse, e sceglierne una
    // sarebbe indovinare.
    if (q.provincia === undefined && q.belfiore === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['provincia'],
        message: 'Indicare la provincia (es. NA) oppure un codice catastale (es. H501)',
      })
    }
    if (q.provincia !== undefined && q.belfiore !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['belfiore'],
        message: 'Indicare la provincia OPPURE il codice catastale, non entrambi',
      })
    }
  })

/**
 * La proiezione verso il client, campo per campo.
 *
 * Esplicita e non uno spread di `Comune`: se domani la libreria aggiungesse un
 * campo (una nota interna, un riferimento alla fonte), uno spread lo spedirebbe a
 * ogni famiglia senza che nessuno l'abbia deciso.
 */
interface ComuneRisposta {
  belfiore: string
  nome: string
  sigla: string
  attivo: boolean
}

function proietta(c: Comune): ComuneRisposta {
  return { belfiore: c.belfiore, nome: c.nome, sigla: c.sigla, attivo: c.attivo }
}

/**
 * Attivi prima, poi i soppressi; dentro ciascun blocco, ordine alfabetico.
 *
 * Il confronto è sui codepoint e non `localeCompare`, come in `comuni.ts`: il
 * dataset è ASCII maiuscolo e l'ordine deve essere identico su ogni macchina e in
 * ogni locale — altrimenti l'`ETag` cambierebbe da un'istanza all'altra e la cache
 * non servirebbe a niente.
 */
function ordina(comuni: readonly Comune[]): ComuneRisposta[] {
  return [...comuni]
    .sort((a, b) => {
      if (a.attivo !== b.attivo) return a.attivo ? -1 : 1
      if (a.nome !== b.nome) return a.nome < b.nome ? -1 : 1
      return a.belfiore < b.belfiore ? -1 : 1
    })
    .map(proietta)
}

/** Impronta del corpo: un ETag forte, stabile a parità di risposta. */
function impronta(corpo: string): string {
  return `"${createHash('sha256').update(corpo).digest('base64url').slice(0, 27)}"`
}

/**
 * Il client ha GIÀ questa identica risposta?
 *
 * `If-None-Match` può arrivare come elenco (`"a", "b"`) e con il marcatore debole
 * `W/` davanti, che i proxy aggiungono di loro iniziativa. Si confronta ogni voce
 * dopo aver tolto quel prefisso.
 *
 * L'asimmetria è deliberata e va detta: quando NON si riconosce l'intestazione si
 * risponde 200 col corpo. Un 200 di troppo costa 33 KB nel caso peggiore; un 304
 * di troppo consegnerebbe al browser una risposta VUOTA lasciandogli in memoria
 * una versione vecchia — cioè una tendina che mostra comuni che non esistono più.
 * Nel dubbio si spedisce, mai il contrario. Per la stessa ragione `If-None-Match: *`
 * non è implementato: sarebbe l'unico caso in cui si dice «uguale» senza confrontare.
 */
function giaInCache(intestazione: string | null, etag: string): boolean {
  if (intestazione === null) return false
  return intestazione
    .split(',')
    .map((v) => v.trim().replace(/^W\//, ''))
    .includes(etag)
}

export const GET = withRoute('anagrafiche/comuni:GET', async (request: NextRequest) => {
  const rl = await rateLimit(`anagrafiche-comuni:${clientIp(request)}`, TETTO)
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: 'Troppe richieste. Riprova tra qualche minuto.',
        codice: 'TROPPE_RICHIESTE',
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
          // Un rifiuto NON si mette in cache pubblica: resterebbe servito a tutti
          // per un giorno, e la tendina sembrerebbe rotta a chi non ha superato
          // nessun tetto.
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response

  let comuni: ComuneRisposta[]
  if (q.data.belfiore !== undefined) {
    // Un codice sconosciuto è un elenco VUOTO, non un errore: capita leggendo un
    // archivio vecchio, e un 404 costringerebbe ogni schermata a un ramo d'errore
    // per un caso che non è un guasto di nessuno.
    const trovato = comunePerBelfiore(q.data.belfiore)
    comuni = trovato === null ? [] : [proietta(trovato)]
  } else {
    // `provincia` c'è per forza: lo `superRefine` qui sopra ha già respinto il caso
    // in cui mancano entrambi.
    comuni = ordina(
      comuniDiProvincia(q.data.provincia as string, { soppressi: q.data.includiSoppressi === true }),
    )
  }

  const corpo = JSON.stringify({ comuni })
  const etag = impronta(corpo)
  const intestazioni = {
    // La sola intestazione di questa route che dipende da CHI chiama. Vedi la
    // testata: con una sessione in corso il middleware può attaccare qui sopra un
    // `Set-Cookie`, e `public` lo consegnerebbe alla prima cache condivisa.
    'Cache-Control': haCookieSessioneNellIntestazione(request.headers.get('cookie'))
      ? CACHE_PRIVATA
      : CACHE_CONDIVISA,
    Vary: 'Cookie',
    ETag: etag,
  }

  // Rivalidazione: il browser ha già questa identica risposta in memoria.
  if (giaInCache(request.headers.get('if-none-match'), etag)) {
    return new NextResponse(null, { status: 304, headers: intestazioni })
  }

  return new NextResponse(corpo, {
    status: 200,
    headers: { ...intestazioni, 'Content-Type': 'application/json; charset=utf-8' },
  })
})
