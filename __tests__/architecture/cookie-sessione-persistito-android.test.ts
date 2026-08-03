import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * T14-F3 — la sessione si perdeva chiudendo l'app entro ~30 secondi dal login.
 *
 * Il rilievo, dal collaudo Android del 2026-08-03: chi faceva il login e chiudeva subito
 * l'app, riaprendola si ritrovava slogato. Oltre la mezza minuto, no.
 *
 * ── L'IPOTESI CHE IL RILIEVO SUGGERIVA, E CHE È FALSA ─────────────────────────────────
 *
 * «Un cookie di sessione senza scadenza esplicita, che muore col processo.» **Non è così**,
 * ed è la prima cosa che è stata falsificata invece che assunta: `@supabase/ssr` 0.10.3
 * applica `DEFAULT_COOKIE_OPTIONS` — `maxAge: 400 * 24 * 60 * 60` — a OGNI scrittura, sia dal
 * browser (`documentCookieSetAll` → `document.cookie = serialize(name, value, options)`,
 * `dist/main/cookies.js:60-64`) sia dal server (`src/middleware.ts` inoltra le stesse
 * `options` a `response.cookies.set`). Il cookie nasce con `Max-Age=34560000`: è persistente.
 * E soprattutto quell'ipotesi non spiegava il dato che contava — la FINESTRA. Un cookie di
 * sessione si perde sempre, non solo entro trenta secondi.
 *
 * ── LA CAUSA RADICE, E PERCHÉ LA FINESTRA È PROPRIO QUELLA ────────────────────────────
 *
 * Il cookie è persistente per il web, ma la WebView di Android lo tiene **in RAM** e lo
 * scrive su disco quando le pare. Documentazione dell'SDK (android-36,
 * `android/webkit/CookieSyncManager.java`, in testa alla classe):
 *
 *   «The CookieSyncManager is used to synchronize the browser cookie store between RAM and
 *    permanent storage. To get the best performance, browser cookies are saved in RAM.
 *    A separate thread saves the cookies between, driven by a timer.»
 *   «@deprecated … To manually force a sync you can use the CookieManager method flush()
 *    which is a synchronous replacement for sync().»
 *
 * e `CookieManager.flush()`: «Ensures all cookies currently accessible through the get-cookie
 * API are written to persistent storage. This call will block the caller until it is done
 * and may perform I/O.»
 *
 * Cioè: fra la scrittura del cookie e il suo arrivo su disco c'è una finestra decisa da un
 * timer, e se il processo muore prima il cookie non è mai esistito su disco. È esattamente
 * la forma del guasto misurato — «entro ~30 secondi sì, dopo no».
 *
 * E nessuno chiudeva quella finestra: in `@capacitor/android` 8.4.2 l'unico `flush()` sta in
 * `plugin/CapacitorCookieManager.java:189` (usato dal plugin `CapacitorCookies`, cioè da
 * `CapacitorHttp`) e in `cordova/CapacitorCordovaCookieManager.java:40`. `Bridge.onPause()`,
 * `onStop()` e `onDestroy()` (`Bridge.java:1358-1395`) non toccano i cookie. La `MainActivity`
 * dell'app era `public class MainActivity extends BridgeActivity {}` — un corpo vuoto.
 *
 * ── TRE GIRI DI PROVE FINTE, TUTTE MISURATE (2026-08-03) ──────────────────────────────
 *
 * Questo file è stato smontato tre volte da un verificatore adversariale, e le tre volte le
 * manomissioni lo lasciavano VERDE mentre contraddicevano ciò che i suoi titoli promettevano.
 * Un test che non sa fallire non è un test: è fiducia comprata a credito, e qui la fiducia
 * riguarda i cookie di sessione di genitori di minori. Le manomissioni chiuse, e come:
 *
 *  1. `getCookie()` in un metodo privato FUORI da `onPause`, invocato dentro la `Log.i` →
 *     9 verdi su 9, e il token di un genitore in logcat leggibile con `adb`. Il divieto sui
 *     dati cercava solo dentro il corpo del metodo. → ora vale su TUTTI i sorgenti del modulo.
 *  2. Un secondo `public void onPause()` dichiarato prima (classe interna, Fragment,
 *     LifecycleObserver) faceva collaudare l'esca mentre l'override vero conteneva
 *     `AsyncTask.execute(new Runnable(){…})` → 9 verdi. Il vecchio `corpoDi` prendeva il
 *     PRIMO. → ora la firma dev'essere UNICA, con `@Override`, a profondità 1, in
 *     `MainActivity`; se ce n'è più d'una il lock non «sceglie»: si rompe.
 *  3. Il `Log.i` del successo spostato PRIMA del flush → verde, e il log diceva «ok» anche
 *     con `flush()` che lanciava. → ora la posizione è verificata: sta FRA flush e `catch`.
 *  4. Il flush spostato FUORI dal `try`, con dentro il try una chiamata innocua → verde: il
 *     test contava i `catch` del corpo senza chiedersi quale `try` proteggesse la chiamata.
 *     → ora si risale al `try` che CONTIENE il flush e si collauda il SUO catch.
 *  5. `if (BuildConfig.DEBUG) { Log.i(…) }` e `if (BuildConfig.DEBUG) { Log.e(…, errore) }` →
 *     verdi, e in release spariscono sia il successo sia il guasto: esattamente il silenzio
 *     che AGENTS.md §5 esiste per chiudere. → ora ogni riga di log dev'essere alla STESSA
 *     profondità di graffe della chiamata che commenta e dev'essere un'istruzione intera
 *     (niente `if` davanti, con o senza graffe).
 *  6. `evaluateJavascript("document.cookie", v -> Log.i(TAG, v))` → verde: il divieto era una
 *     denylist di tre identificatori Java. E `getCookie` scritto dentro un letterale di
 *     stringa → verde pure lui, perché il divieto girava sul testo già ripulito dalle
 *     stringhe, che è proprio dove il codice di estrazione vive. → ora il divieto sui DATI
 *     gira sul testo GREZZO (commenti e stringhe compresi) e copre anche il canale JS.
 *  7. Il LAUNCHER del manifest spostato su un'altra `BridgeActivity` → verde: nessuna riga
 *     apriva `AndroidManifest.xml`, quindi il lock non sapeva se `MainActivity` ospitasse
 *     ancora la WebView. Il flush finiva in codice morto con nove test verdi. → ora
 *     l'ancoraggio legge il manifest.
 *  8. `if (giaSospesa) super.onPause();` in testa più il `super` vero dopo il flush →
 *     verde: era un `indexOf` sulla prima occorrenza testuale. → ora si pretende UNA sola
 *     chiamata, a profondità 0, istruzione intera, prima del flush.
 *  9. `cookieOptions: { maxAge: 1 }` — la prova di comportamento guardava che la PAROLA
 *     `max-age=` comparisse, non quanto durasse. → ora la scadenza si MISURA (≥ 30 giorni).
 *
 * Le quattro del TERZO giro, tutte con 11 test verdi su 11:
 *
 * 10. Il `catch` che RILANCIA: `throw new RuntimeException("flush cookie fallito", errore);`
 *     dopo il `Log.e`. Il titolo della prova promette letteralmente «non chiude l'app», e
 *     nessuna asserzione guardava il ramo di guasto per un `throw`: onPause tornava a lanciare
 *     ed è il crash che l'utente vede. → ora nessun ramo di `catch` può contenere `throw`.
 * 11. `CookieManager.getInstance().removeSessionCookies(null);` dentro il `try`, subito PRIMA
 *     del flush. Il flush c'era, era diretto, era incondizionato — e scriveva su disco la
 *     CANCELLAZIONE della sessione, cioè il difetto in riparazione reso permanente. → ora
 *     l'unica cosa che il modulo può fare con `CookieManager` è l'import più UN
 *     `getInstance().flush()`. Non è una denylist di nomi (`removeAllCookies`,
 *     `setAcceptCookie(false)`, la cattura in una variabile…): è l'elenco chiuso di ciò che è
 *     PERMESSO, ed è la stessa forma della clausola W9 qui sotto.
 * 12. L'import obbligatorio soddisfatto da un COMMENTO: l'asserzione girava sul testo grezzo,
 *     quindi bastava `// import android.webkit.CookieManager;`. Con accanto una classe
 *     `CookieManager` dichiarata nel pacchetto dell'app, con `getInstance()`/`flush()` a
 *     vuoto, il flush non scriveva più niente. → l'import si verifica sul testo NEUTRALIZZATO
 *     (un commento non lo soddisfa più) e nessun sorgente del modulo può dichiarare una classe
 *     con quel nome. Le due clausole non sono ridondanti solo per prudenza: da sola la seconda
 *     non basterebbe, perché in Java un import esplicito PREVALE su una classe omonima dello
 *     stesso pacchetto (JLS §6.4.1) — la classe-esca funziona solo se l'import sparisce.
 * 13. Il manifest: un `<activity-alias>` con la categoria LAUNCHER scritto DOPO `</activity>`,
 *     `android:enabled="false"` sulla `.MainActivity` e una `AvvioActivity` che estende
 *     `android.app.Activity` — quindi invisibile alla clausola su `BridgeActivity`. Nel file
 *     c'erano DUE categorie LAUNCHER e il lock ne contava una: il regex chiudeva su
 *     `</activity>`, e `</activity-alias>` non gli somigliava abbastanza. → ora le categorie
 *     LAUNCHER si contano sul testo PRIMA di qualunque parsing (è la clausola che non dipende
 *     da come i tag vengono estratti), gli alias si estraggono, `android:enabled="false"` è
 *     rifiutato e `android:targetActivity` viene RISOLTO — anche sull'Activity di destinazione.
 *
 * ── PERCHÉ LA CLAUSOLA «SINCRONO» NON È UN ELENCO DI NOMI (rilievo W9, 2026-08-03) ─────
 *
 * La prima versione vietava per NOME i modi di essere asincroni che venivano in mente:
 * `new Thread`, `runOnUiThread`, `.post(`, `Executor`, `CompletableFuture`. È una denylist, e
 * una denylist è lunga quanto la fantasia di chi la scrive. Misurato:
 *
 *     android.os.AsyncTask.execute(() -> CookieManager.getInstance().flush());
 *
 * dentro `onPause` passava TUTTI E OTTO i test — ed è esattamente la «correzione sbagliata»
 * che questo file dichiara di vietare: il flush torna su un thread di pool, in corsa con la
 * morte del processo, con in più l'apparenza di essere protetto da un test.
 *
 * Ora la clausola è una allowlist di FORMA, che non nomina nessuna API: il flush dev'essere
 * un'istruzione diretta del corpo — nessuna lambda (`->`) né riferimento a metodo (`::`) fra
 * `super.onPause()` e la chiamata, e profondità di graffe ≤ 1 (il solo `try` che lo protegge).
 * Qualunque costrutto capace di portarsi via la chiamata deve aprirsi PRIMA di lei, quindi
 * guardare il prefisso e la profondità li intercetta tutti, compresi quelli non ancora
 * inventati.
 *
 * Sul CONDIZIONAMENTO, invece, la denylist è legittima e viene usata: i costrutti con cui
 * Java può saltare un'istruzione sono fissati dalla grammatica del linguaggio (`if`, `switch`,
 * i tre cicli, `break`/`continue`, `return`, `throw`), non dalla fantasia di chi scrive. Sono
 * vietati tutti nel tratto che precede il flush.
 *
 * ── COSA QUESTO LOCK NON COPRE, perché chi lo legge sappia quanto vale ────────────────
 *
 *  · **È un controllo sul SORGENTE, non sul COMPORTAMENTO.** Nessuno dei test del primo
 *    gruppo esegue Java, avvia una WebView o apre l'app: leggono `MainActivity.java` e
 *    `AndroidManifest.xml` come testo e ne verificano la forma. «Verde» significa «il codice
 *    è scritto così», mai «sul telefono la sessione sopravvive».
 *  · La prova sul dispositivo **non è stata eseguita**: `KV_TEST_PASSWORD` non è
 *    nell'ambiente e senza credenziali il percorso «login → chiudi → riapri» non è
 *    percorribile (`.claude/maestro-flows/esegui.sh` esce con codice 1). Finché quella prova
 *    non c'è, «il flush è scritto lì» resta l'unica cosa dimostrata.
 *  · **Un'istruzione che lancia PRIMA del flush lo salta, e nessuna forma lo vede.** Il
 *    condizionamento esplicito è vietato, ma `String s = null; s.length();` scritto sopra al
 *    `try` manderebbe `onPause` in eccezione senza mai arrivare alla chiamata. La grammatica
 *    non dice quali espressioni lanciano; solo l'esecuzione lo direbbe.
 *  · **Il CONTENUTO del messaggio di log non è verificato.** Il divieto copre gli accessori
 *    dei cookie, `document.cookie` e il canale JS (`evaluateJavascript`, `javascript:`) sui
 *    sorgenti del modulo `app`, testo grezzo compreso. Non copre una stringa costruita per
 *    altra via, né un cookie letto in JavaScript dentro il bundle web e spedito altrove: da
 *    lì in poi valgono `no-console` e la redazione a lista bianca di `@/lib/logging`.
 *  · **Il perimetro è il modulo `app`.** Il Java dei plugin Capacitor (`node_modules`), i
 *    sorgenti di test strumentato e il modulo iOS non sono scanditi.
 *  · **Il manifest è letto, ma solo come testo.** Si pretende UNA sola categoria LAUNCHER in
 *    tutto il file, che l'elemento che la porta (`<activity>` o `<activity-alias>`) non sia
 *    `android:enabled="false"`, che il suo bersaglio risolva a `.MainActivity` e che neanche
 *    l'Activity di destinazione sia disabilitata; più il fatto che nessun altro sorgente del
 *    modulo estenda `BridgeActivity`. Non si vede però il manifest FUSO (merge dei manifest di
 *    libreria): un'Activity introdotta da una dipendenza non comparirebbe qui. E `enabled` è
 *    letto solo nella forma statica: `PackageManager.setComponentEnabledSetting` cambia la
 *    stessa grandezza a runtime, e nessun testo lo racconta.
 *  · **L'elenco di ciò che si può fare con `CookieManager` vale sul modulo `app`, non
 *    sull'APK.** Dentro `android/app/src/main/java` l'unica forma ammessa è l'import più un
 *    `getInstance().flush()`; un plugin Capacitor in `node_modules` che chiamasse
 *    `removeAllCookies` non è scandito da nessuno di questi test. È lo stesso confine già
 *    dichiarato per il divieto sui dati, e vale la pena ripeterlo perché la clausola sembra
 *    più larga di quanto sia.
 *  · **Il divieto di `throw` nel ramo di guasto è testuale.** Vieta la parola dentro il corpo
 *    del `catch` — quindi manda rosso anche un `throw` che vivesse dentro una lambda innocua
 *    lì dentro (falso positivo scelto) — ma non vede un rilancio INDIRETTO: una riga che chiami
 *    un metodo che a sua volta lancia esce da `onPause` esattamente come un `throw`, e la
 *    grammatica non dice quali chiamate lanciano. È la stessa frontiera del punto qui sopra
 *    sull'istruzione che lancia prima del flush: solo l'esecuzione la sposterebbe.
 *  · **Falsi positivi scelti, e sono tre.** Un flush spostato in un metodo privato chiamato
 *    da `onPause` — sincrono e corretto — è ROSSO. Una freccia innocente prima della chiamata
 *    (`case X ->` di uno `switch`) è ROSSA. Un flush legittimamente condizionato alla
 *    versione di Android è ROSSO. La forma vincolata vale più della libertà di rifattorizzare
 *    sei righe, e il rosso si legge in un secondo.
 *  · **La neutralizzazione di commenti e stringhe serve al conteggio delle graffe, non al
 *    divieto sui dati.** Le prove di forma girano sul testo neutralizzato (così una graffa in
 *    un commento non falsa la profondità); il divieto sui dati gira su ENTRAMBI, grezzo
 *    compreso, perché un divieto sui dati che ignora le stringhe ignora proprio il posto in
 *    cui il codice di estrazione vive. Il prezzo è che `getCookie` scritto in un commento
 *    manda rosso: è voluto.
 *  · **`istruzioneIntera` è un'euristica sul testo, non un parser.** Guarda che fra l'ultimo
 *    `;` `{` `}` e la riga non ci sia altro che spazio. Regge le forme misurate
 *    (`if (…) Log.i(…);`, `if (…) super.onPause();`) ma un `for (int i = 0; …)` scritto sulla
 *    stessa riga sposterebbe il confine. Nessun test qui costruisce un albero sintattico
 *    Java: se un giorno servisse quel livello di certezza, servirebbe un parser vero.
 *
 * Il secondo gruppo di test è invece una prova di COMPORTAMENTO (gira il nostro client
 * Supabase vero) ed è una difesa in profondità: nasce VERDE di proposito, e blinda l'ipotesi
 * falsificata in cima. Se domani qualcuno passasse a `createBrowserClient` delle
 * `cookieOptions` con una scadenza corta, il cookie morirebbe a ogni chiusura e il difetto
 * rinascerebbe in forma peggiore — con il flush nativo che continua a funzionare e non serve
 * più a niente.
 *
 * Nota onesta su quella prova, perché il rilievo che l'ha aperta era impreciso: in
 * `@supabase/ssr` 0.10.3 il ramo di scrittura RIMETTE `maxAge: DEFAULT_COOKIE_OPTIONS.maxAge`
 * DOPO aver applicato `options.cookieOptions` (`dist/main/cookies.js:203-206` e `:358-361`),
 * quindi oggi `cookieOptions: { maxAge: 1 }` non arriva al cookie: la libreria lo sovrascrive.
 * La regressione contro cui questo test difende è quindi un aggiornamento della libreria che
 * smetta di forzarlo, o un archivio cookie scritto da noi. Per non lasciare la misura
 * indimostrata, la funzione che estrae la scadenza è collaudata a parte su stringhe sintetiche
 * (`max-age=1` deve essere RIFIUTATO): così si sa che discrimina, e non solo che oggi è verde.
 */

const RADICE = process.cwd();
const PACCHETTO = 'it.kidville.app';
const MAIN_ACTIVITY = 'android/app/src/main/java/it/kidville/app/MainActivity.java';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
/** Tutti i sorgenti del modulo `app`: il divieto sui cookie non vale «dentro un metodo». */
const SORGENTI = 'android/app/src/main/java';
/** Trenta giorni. Sotto, un cookie «persistente» è una sessione che muore comunque. */
const SCADENZA_MINIMA_SECONDI = 30 * 24 * 60 * 60;

function leggi(relativo: string): string {
  return fs.readFileSync(path.join(RADICE, relativo), 'utf8');
}

/**
 * Ogni sorgente sotto una cartella, ricorsivamente. `.kt` oltre a `.java`: oggi nel modulo
 * non ce ne sono, ma un divieto sui dati che si ferma all'estensione di ieri è un divieto che
 * si aggira convertendo un file.
 */
function fileSorgente(cartella: string): string[] {
  const fuori: string[] = [];
  for (const voce of fs.readdirSync(cartella, { withFileTypes: true })) {
    const pieno = path.join(cartella, voce.name);
    if (voce.isDirectory()) fuori.push(...fileSorgente(pieno));
    else if (voce.name.endsWith('.java') || voce.name.endsWith('.kt')) fuori.push(pieno);
  }
  return fuori;
}

/**
 * Sostituisce con spazi il contenuto di commenti e letterali, lasciando intatte lunghezza e
 * a capo: così le posizioni restano le stesse del file vero, ma una graffa o una freccia
 * scritte dentro un commento non entrano nel conteggio della profondità. Senza questo passo
 * il lock sarebbe rosso o verde a seconda di come è scritta una nota, il che è peggio che non
 * averlo. Serve al conteggio: il divieto sui DATI gira anche sul testo grezzo.
 */
function senzaCommentiNeStringhe(java: string): string {
  const fuori: string[] = [];
  let i = 0;
  const spazi = (n: number, testo: string) => testo.replace(/[^\n]/g, ' ').slice(0, n);
  while (i < java.length) {
    const due = java.slice(i, i + 2);
    if (due === '//') {
      const fine = java.indexOf('\n', i);
      const stop = fine < 0 ? java.length : fine;
      fuori.push(spazi(stop - i, java.slice(i, stop)));
      i = stop;
    } else if (due === '/*') {
      const fine = java.indexOf('*/', i + 2);
      const stop = fine < 0 ? java.length : fine + 2;
      fuori.push(spazi(stop - i, java.slice(i, stop)));
      i = stop;
    } else if (java[i] === '"' || java[i] === "'") {
      const apice = java[i];
      let j = i + 1;
      while (j < java.length && java[j] !== apice) j += java[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, java.length);
      fuori.push(spazi(stop - i, java.slice(i, stop)));
      i = stop;
    } else {
      fuori.push(java[i]);
      i += 1;
    }
  }
  return fuori.join('');
}

/** Tutte le posizioni in cui la firma compare. Serve a pretendere che ce ne sia UNA sola. */
function occorrenzeDi(sorgente: string, firma: RegExp): number[] {
  const globale = new RegExp(firma.source, firma.flags.includes('g') ? firma.flags : `${firma.flags}g`);
  const fuori: number[] = [];
  for (const trovato of sorgente.matchAll(globale)) {
    if (trovato.index !== undefined) fuori.push(trovato.index);
  }
  return fuori;
}

/**
 * Il blocco `{…}` che si apre dopo `da`, con gli ESTREMI: senza le posizioni non si può dire
 * «il flush cade dentro QUESTO try», che è la differenza fra legare il catch alla chiamata e
 * contare i catch che capitano nel metodo.
 */
function blocco(
  sorgente: string,
  da: number,
  cosa: string,
): { apertura: number; chiusura: number; corpo: string } {
  const apertura = sorgente.indexOf('{', da);
  if (apertura < 0) throw new Error(`corpo non trovato dopo: ${cosa}`);
  let profondita = 0;
  for (let i = apertura; i < sorgente.length; i += 1) {
    if (sorgente[i] === '{') profondita += 1;
    else if (sorgente[i] === '}') {
      profondita -= 1;
      if (profondita === 0) return { apertura, chiusura: i, corpo: sorgente.slice(apertura + 1, i) };
    }
  }
  throw new Error(`graffa mai chiusa dopo: ${cosa}`);
}

/** Il corpo `{…}` che si apre dopo `da`, contando le graffe. */
function corpoDaPosizione(sorgente: string, da: number, cosa: string): string {
  return blocco(sorgente, da, cosa).corpo;
}

/** Quante graffe restano aperte prima di `posizione`: 0 = istruzione diretta del corpo. */
function profonditaGraffe(corpo: string, posizione: number): number {
  let profondita = 0;
  for (let i = 0; i < posizione; i += 1) {
    if (corpo[i] === '{') profondita += 1;
    else if (corpo[i] === '}') profondita -= 1;
  }
  return profondita;
}

/**
 * `true` se in `posizione` comincia un'istruzione intera, cioè se fra l'ultimo confine
 * (`;` `{` `}`) e lì non c'è altro che spazio.
 *
 * Serve contro la variante senza graffe di una manomissione misurata: `if (BuildConfig.DEBUG)
 * Log.i(…);` sta alla stessa profondità di graffe della riga che commenta — la profondità da
 * sola non la vede — ma non è un'istruzione intera, e in una build di rilascio quel log non
 * esiste. Vale identico per `if (giaSospesa) super.onPause();`.
 */
function istruzioneIntera(corpo: string, posizione: number): boolean {
  const prima = corpo.slice(0, posizione);
  const confine = Math.max(prima.lastIndexOf(';'), prima.lastIndexOf('{'), prima.lastIndexOf('}'));
  return prima.slice(confine + 1).trim() === '';
}

/** Qualunque `onPause`, anche di una classe interna: serve a pretenderne UNO SOLO nel file. */
const FIRMA_ONPAUSE_QUALUNQUE = /public\s+void\s+onPause\s*\(\s*\)/;
/** L'override vero, ancorato all'annotazione: è quello che il ciclo di vita chiama. */
const FIRMA_ONPAUSE = /@Override\s+public\s+void\s+onPause\s*\(\s*\)/;
const FLUSH = /CookieManager\s*\.\s*getInstance\s*\(\s*\)\s*\.\s*flush\s*\(\s*\)/;
const SUPER_ONPAUSE = /super\s*\.\s*onPause\s*\(\s*\)/;
/**
 * Il `catch` con il tipo e il nome dell'eccezione. Il multi-catch (`catch (A | B e)`) è Java
 * legittimo e va riconosciuto: la versione precedente lo rifiutava e mandava rossi due test
 * con il messaggio «senza catch, un guasto del flush è un crash» — che diceva il falso, e
 * spingeva chi lo incontrava a rifattorizzare nella direzione sbagliata.
 */
const CATCH = /catch\s*\(\s*([\w.|\s]+?)\s+(\w+)\s*\)/;
/** L'apertura di un `try` — anche try-with-resources: il blocco lo trova `blocco()`. */
const APERTURA_TRY = /\btry\b/;
/**
 * Gli accessi al VALORE di un cookie, per qualunque via. `flush()` non è fra essi: sposta
 * byte su disco senza leggerli.
 */
const ACCESSO_AI_COOKIE = /\bgetCookie\b|\bsetCookie\b|\bhasCookies\b|document\s*\.\s*cookie/;
/**
 * Il canale da cui i cookie escono per davvero. Un divieto sui soli identificatori Java non
 * vede `evaluateJavascript("document.cookie", v -> Log.i(TAG, v))`, che è il modo più corto
 * per far comparire il token di un genitore in logcat.
 */
const CANALE_JS = /\bevaluateJavascript\b|\bjavascript\s*:/i;
/** I costrutti con cui Java può SALTARE un'istruzione. La grammatica li fissa: sono questi. */
const CONDIZIONAMENTO = /\b(?:if|else|switch|while|for|do|break|continue|return|throw)\b/;
/** Una dichiarazione di classe col suo corpo — non un letterale `Foo.class`. */
const DICHIARAZIONE_CLASSE = /\bclass\s+(\w+)[^{;]*\{/g;
/** L'Activity che ospita la WebView di Capacitor, in Java o in Kotlin. */
const ESTENDE_BRIDGE = /\bextends\s+BridgeActivity\b|:\s*BridgeActivity\s*\(/;

/** Un elemento lanciabile del manifest: `<activity>` oppure `<activity-alias>`. */
type ElementoAttivita = { alias: boolean; tag: string; intero: string };

/**
 * Gli elementi `<activity>` e `<activity-alias>` del manifest, con il loro tag di apertura.
 *
 * L'estrazione è scritta a mano e non con un regex solo, per tre motivi tutti misurati al
 * terzo giro sulla manomissione M5:
 *  · `/<activity\b/` combacia anche con `<activity-alias`, perché dopo «activity» c'è un `-`,
 *    che è un confine di parola: il vecchio regex partiva dall'alias e correva fino al primo
 *    `</activity>` incontrato, incollando insieme elementi diversi;
 *  · un alias si chiude con `</activity-alias>`, che `/<\/activity>/` non riconosce: l'alias
 *    era quindi INVISIBILE, ed è esattamente il buco da cui è passata l'esca;
 *  · una `<activity …/>` autochiusa non ha corpo, e trattarla come un blocco farebbe
 *    proseguire la lettura dentro l'elemento successivo.
 */
function elementiAttivita(manifest: string): ElementoAttivita[] {
  const fuori: ElementoAttivita[] = [];
  // `(?![-\w])` distingue `<activity` da `<activity-alias`: senza, il primo pattern se li
  // prende entrambi e l'alias non viene mai riconosciuto come tale.
  const apertura = /<activity(-alias)?(?![-\w])/g;
  let trovato: RegExpExecArray | null;
  while ((trovato = apertura.exec(manifest)) !== null) {
    const alias = trovato[1] !== undefined;
    const fineTag = manifest.indexOf('>', trovato.index);
    if (fineTag < 0) break;
    const tag = manifest.slice(trovato.index, fineTag + 1);
    if (tag.endsWith('/>')) {
      fuori.push({ alias, tag, intero: tag });
      continue;
    }
    const chiusura = alias ? /<\/activity-alias\s*>/g : /<\/activity\s*>/g;
    chiusura.lastIndex = fineTag;
    const fine = chiusura.exec(manifest);
    fuori.push({
      alias,
      tag,
      intero: manifest.slice(trovato.index, fine ? fine.index + fine[0].length : manifest.length),
    });
  }
  return fuori;
}

/** Il valore di un attributo nel tag di apertura. `\s` davanti: `android:name` ≠ `x:name`. */
function attributo(tag: string, nome: string): string | undefined {
  return new RegExp(`\\s${nome}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
}

/** `.MainActivity` e `it.kidville.app.MainActivity` sono lo stesso nome. */
function nomeAssoluto(nome: string): string {
  return nome.startsWith('.') ? `${PACCHETTO}${nome}` : nome;
}

const CATEGORIA_LAUNCHER = /<category\s+android:name\s*=\s*"android\.intent\.category\.LAUNCHER"/;
const DISABILITATA = /\sandroid:enabled\s*=\s*"false"/;

/**
 * I motivi per cui ciò che il sistema apre non è (o non è più) `.MainActivity`. Lista vuota =
 * l'icona sul telefono porta all'Activity che contiene il flush.
 *
 * Esiste perché il lock non leggeva il manifest, e senza manifest «MainActivity contiene il
 * flush» non dice niente: misurato al secondo giro, bastava creare `AvvioActivity.java`
 * (un'altra `BridgeActivity`) e spostarci il LAUNCHER perché il flush finisse in codice morto
 * con tutti i test verdi. Al TERZO giro la stessa esca è passata di nuovo, in forma più
 * sottile e senza toccare l'`<activity>` esistente (M5): un `<activity-alias>` LAUNCHER
 * aggiunto DOPO `</activity>`, `android:enabled="false"` sulla MainActivity, e una destinazione
 * che estende `android.app.Activity` invece di `BridgeActivity` — così anche il conteggio delle
 * BridgeActivity restava a uno. Nel file c'erano DUE categorie LAUNCHER e il lock ne contava
 * una sola.
 *
 * Da qui le tre clausole, e l'ordine conta: la prima è un CONTEGGIO sul testo, non dipende dal
 * parsing, e regge anche se un domani gli elementi verranno scritti in una forma che
 * `elementiAttivita` non prevede.
 */
function problemiDiAvvio(manifest: string): string[] {
  const senzaCommenti = manifest.replace(/<!--[\s\S]*?-->/g, '');
  const problemi: string[] = [];

  const quante = (senzaCommenti.match(/android\.intent\.category\.LAUNCHER/g) ?? []).length;
  if (quante !== 1) {
    problemi.push(
      `nel manifest ci sono ${quante} categorie LAUNCHER: con più d’una il sistema mostra più icone e non è più univoco cosa si apre`,
    );
  }

  const elementi = elementiAttivita(senzaCommenti);
  const lanciabili = elementi.filter((e) => CATEGORIA_LAUNCHER.test(e.intero));
  if (lanciabili.length !== 1) {
    problemi.push(
      `gli elementi con categoria LAUNCHER sono ${lanciabili.length} (${
        lanciabili.map((e) => attributo(e.tag, 'android:name') ?? '(senza nome)').join(', ') || 'nessuno'
      }): il lock non sa più quale schermata il sistema apre`,
    );
    return problemi;
  }

  const punto = lanciabili[0];
  const suoNome = attributo(punto.tag, 'android:name') ?? '(senza android:name)';
  if (DISABILITATA.test(punto.tag)) {
    problemi.push(
      `l’elemento di avvio «${suoNome}» è android:enabled="false": il sistema non lo lancia, e il flush non viene mai eseguito`,
    );
  }

  // Un `<activity-alias>` non contiene codice: dice solo a chi delegare. È l'attributo
  // `android:targetActivity` a decidere quale classe parte davvero, e senza risolverlo un alias
  // chiamato «.MainActivity» che punta altrove passerebbe per l'Activity giusta.
  const bersaglio = punto.alias ? attributo(punto.tag, 'android:targetActivity') : suoNome;
  if (punto.alias && bersaglio === undefined) {
    problemi.push(`l’activity-alias «${suoNome}» non dichiara android:targetActivity: non si sa cosa lancia`);
  }
  if (nomeAssoluto(bersaglio ?? '(senza bersaglio)') !== `${PACCHETTO}.MainActivity`) {
    problemi.push(
      `ciò che il LAUNCHER apre è «${bersaglio ?? '(senza bersaglio)'}», non «.MainActivity»: il flush sta in un’Activity che il sistema non apre`,
    );
    return problemi;
  }

  // E la destinazione dev'essere abilitata a sua volta: un alias attivo su un'Activity
  // disabilitata non lancia niente (l'alias eredita lo stato del bersaglio).
  if (punto.alias) {
    const destinazione = elementi.find(
      (e) => !e.alias && nomeAssoluto(attributo(e.tag, 'android:name') ?? '') === `${PACCHETTO}.MainActivity`,
    );
    if (!destinazione) {
      problemi.push('l’alias punta a .MainActivity ma nel manifest quell’<activity> non c’è');
    } else if (DISABILITATA.test(destinazione.tag)) {
      problemi.push('l’alias punta a .MainActivity, che però è android:enabled="false": non parte niente');
    }
  }

  return problemi;
}

/**
 * I motivi per cui l'`onPause` di questo file non è — o non è collaudabile come — l'override
 * dell'Activity che ospita la WebView. Lista vuota = il lock sta guardando il metodo giusto.
 *
 * Esiste perché il predecessore di `corpoOnPause` prendeva il PRIMO `public void onPause()`
 * del file e andava avanti. È il modo in cui il lock si è fatto collaudare un'esca: un
 * `onPause` di una classe interna scritto prima dell'override vero veniva letto al posto suo,
 * e il vero poteva contenere qualunque cosa (misurato: `AsyncTask.execute(new Runnable(){…})`,
 * 9 test verdi su 9). Le clausole coprono le forme in cui l'esca funziona — due metodi
 * omonimi, un metodo senza `@Override`, un metodo annidato, un metodo di un'altra classe — più
 * il caso, misurato al secondo giro, in cui `MainActivity` esiste ancora e contiene ancora il
 * flush ma non è più l'Activity che il sistema lancia.
 */
function problemiDiAncoraggio(netto: string, manifest: string, sorgenti: string[]): string[] {
  const problemi: string[] = [];

  const tutti = occorrenzeDi(netto, FIRMA_ONPAUSE_QUALUNQUE);
  if (tutti.length !== 1) {
    problemi.push(
      `nel file ci sono ${tutti.length} «public void onPause()»: con più d'uno il lock collauderebbe il primo, che può essere un'esca`,
    );
  }
  if (occorrenzeDi(netto, FIRMA_ONPAUSE).length !== 1) {
    problemi.push(
      'manca (o è duplicato) l’@Override su onPause: senza, non si sta sovrascrivendo il callback del ciclo di vita',
    );
  }
  if (tutti.length >= 1) {
    // Profondità 1 = membro diretto del corpo di una classe di primo livello. Un `onPause`
    // dentro una classe interna o anonima sta a 2 o più, e non lo chiama nessun ciclo di vita
    // dell'Activity.
    const profondita = profonditaGraffe(netto, tutti[0]);
    if (profondita !== 1) {
      problemi.push(
        `onPause è a profondità ${profondita} e non 1: annidato così non lo chiama il ciclo di vita dell’Activity`,
      );
    }
    const classi = [...netto.slice(0, tutti[0]).matchAll(DICHIARAZIONE_CLASSE)];
    const contenitore = classi.at(-1)?.[1];
    if (contenitore !== 'MainActivity') {
      problemi.push(`onPause appartiene a «${contenitore ?? 'nessuna classe'}», non a MainActivity`);
    }
  }
  if (!/class\s+MainActivity\s+extends\s+BridgeActivity/.test(netto)) {
    problemi.push('MainActivity non estende più BridgeActivity: non è l’Activity della WebView');
  }

  // ── L'ancoraggio al MANIFEST: senza, «il flush è in MainActivity» non dice se MainActivity
  //    è ancora l'Activity che si apre. Le vie per spostarla sono tre, e sono tutte state
  //    misurate: cambiare il LAUNCHER, aggiungere una seconda BridgeActivity che diventi
  //    quella vera, o lasciare tutto com'è e mettere davanti un `<activity-alias>`.
  problemi.push(...problemiDiAvvio(manifest));

  const bridge = sorgenti.filter((file) => ESTENDE_BRIDGE.test(fs.readFileSync(file, 'utf8')));
  if (bridge.length !== 1 || !bridge[0].endsWith('MainActivity.java')) {
    problemi.push(
      `le Activity che estendono BridgeActivity sono ${bridge.length} (${bridge.map((f) => path.basename(f)).join(', ') || 'nessuna'}): con più d’una la WebView può vivere altrove`,
    );
  }

  return problemi;
}

/**
 * Il corpo dell'override VERO — o un errore, se l'ancoraggio non regge. Ogni prova di questo
 * gruppo passa di qui: così un'esca non fa fallire una prova sola lasciando verdi le altre,
 * le fa fallire tutte, ed è la lettura onesta della situazione (il lock non sa più cosa sta
 * guardando).
 */
function corpoOnPause(netto: string, manifest: string, sorgenti: string[]): string {
  const problemi = problemiDiAncoraggio(netto, manifest, sorgenti);
  if (problemi.length > 0) {
    throw new Error(`onPause non ancorato all’Activity della WebView — ${problemi.join(' · ')}`);
  }
  const dove = occorrenzeDi(netto, FIRMA_ONPAUSE);
  return corpoDaPosizione(netto, dove[0], 'onPause');
}

/**
 * Il `try` che CONTIENE il flush, con la posizione del `catch` che lo chiude.
 *
 * È la correzione della manomissione T1: il predecessore contava i `catch` presenti nel corpo
 * di `onPause` senza chiedersi quale `try` proteggesse la chiamata, quindi bastava spostare il
 * flush sopra al `try` e metterci dentro un'istruzione innocua perché il test restasse verde
 * mentre un guasto del flush tornava a essere un crash dentro `onPause` — proprio il caso che
 * il commento del sorgente cita (pacchetto WebView in aggiornamento).
 */
function tryCheProteggeIlFlush(corpo: string): { flush: number; catch: number } {
  const flush = corpo.search(FLUSH);
  if (flush < 0) throw new Error('nessun flush nel corpo di onPause');

  const aperture = occorrenzeDi(corpo, APERTURA_TRY).filter((p) => p < flush);
  if (aperture.length === 0) {
    throw new Error('il flush non è dentro nessun try: un suo guasto è un crash dentro onPause');
  }

  const candidato = blocco(corpo, aperture.at(-1) as number, 'try');
  if (flush < candidato.apertura || flush > candidato.chiusura) {
    throw new Error(
      'il flush è FUORI dal try che lo precede: il catch collaudato protegge un’altra istruzione',
    );
  }

  const resto = corpo.slice(candidato.chiusura + 1);
  const scarto = resto.search(/\S/);
  if (scarto < 0 || !/^catch\b/.test(resto.slice(scarto))) {
    throw new Error('il try che contiene il flush non è chiuso da un catch');
  }
  return { flush, catch: candidato.chiusura + 1 + scarto };
}

describe('T14-F3 — il cookie di sessione arriva su disco prima che l’app muoia', () => {
  const sorgente = leggi(MAIN_ACTIVITY);
  const manifest = leggi(MANIFEST);
  const sorgenti = fileSorgente(path.join(RADICE, SORGENTI));
  // Le prove di FORMA (posizioni, graffe, frecce) girano sul sorgente neutralizzato; quelle
  // sul testo letterale — l'import, il divieto sui dati — sul file vero.
  const netto = senzaCommentiNeStringhe(sorgente);
  const corpo = () => corpoOnPause(netto, manifest, sorgenti);

  it('l’Activity dichiara UN SOLO onPause, è l’override di MainActivity, e MainActivity è ciò che il sistema apre', () => {
    // `onPause` è il primo callback garantito quando l'app perde il foreground — cioè
    // l'ultimo istante certo prima che il sistema possa uccidere il processo. `onStop` e
    // `onDestroy` vengono dopo e non sono garantiti allo stesso modo.
    //
    // Le clausole di `problemiDiAncoraggio` esistono per manomissioni misurate, non per
    // prudenza teorica: con un secondo `onPause` dichiarato prima (una classe interna
    // qualsiasi) tutte le prove di questo gruppo finivano a collaudare quello; e col LAUNCHER
    // del manifest spostato su un'altra BridgeActivity restavano verdi mentre il flush
    // diventava codice morto.
    expect(
      problemiDiAncoraggio(netto, manifest, sorgenti),
      'il lock non sta guardando l’onPause che il ciclo di vita chiama davvero',
    ).toEqual([]);
  });

  it('onPause forza la scrittura su disco dei cookie della WebView', () => {
    expect(corpo()).toMatch(FLUSH);
    // Sul testo NEUTRALIZZATO, non sul grezzo. Manomissione misurata (M6): l'import spostato
    // dentro un commento — `// import android.webkit.CookieManager;` — soddisfaceva
    // `toContain` sul file vero, e accanto una classe `CookieManager` dichiarata nel pacchetto
    // dell'app con `getInstance()`/`flush()` a vuoto rendeva il flush una chiamata a nulla:
    // 11 test verdi e nessun cookie che arriva su disco.
    expect(
      netto,
      'l’import di android.webkit.CookieManager non è codice (è in un commento o in una stringa): il flush potrebbe risolvere su un’altra classe',
    ).toContain('import android.webkit.CookieManager;');
  });

  it('chiama super.onPause() UNA volta sola, senza guardie, e prima del flush', () => {
    // `indexOf('super.onPause()')` non bastava: misurato, `if (giaSospesa) super.onPause();`
    // in testa più il `super` vero DOPO il flush lasciava il test verde invertendo i fatti —
    // il lock leggeva la prima occorrenza testuale, non la chiamata che viene eseguita.
    const dentro = corpo();
    const superi = occorrenzeDi(dentro, SUPER_ONPAUSE);
    expect(
      superi.length,
      'super.onPause() dev’essere chiamato una volta sola: due chiamate rendono l’ordine indecidibile',
    ).toBe(1);
    expect(
      profonditaGraffe(dentro, superi[0]),
      'super.onPause() è annidato: sotto una guardia può non essere chiamato affatto',
    ).toBe(0);
    expect(
      istruzioneIntera(dentro, superi[0]),
      'super.onPause() ha una guardia davanti: saltarlo rompe il ciclo di vita di Capacitor',
    ).toBe(true);
    expect(superi[0]).toBeLessThan(dentro.search(FLUSH));
  });

  it('il flush è un’ISTRUZIONE DIRETTA e INCONDIZIONATA di onPause, non un compito rimandato', () => {
    // `flush()` è documentato come bloccante, e il blocco è il punto: rimandato a un thread,
    // l'app può essere uccisa prima che quel thread giri — cioè si riottiene il difetto, con
    // in più l'illusione di averlo corretto.
    //
    // Sull'ASINCRONIA questa è una allowlist di FORMA e non un elenco di nomi: la denylist
    // che stava qui (`new Thread|runOnUiThread|.post(|Executor|CompletableFuture`) è stata
    // evasa da `android.os.AsyncTask.execute(() -> …)` (rilievo W9).
    //
    // Sul CONDIZIONAMENTO invece la denylist è legittima ed è stata aggiunta al secondo giro:
    // `if (!isChangingConfigurations()) return;` davanti al flush era sincrono, diretto, a
    // profondità 1 — verde su tutto — e il flush non veniva mai eseguito. I costrutti con cui
    // Java salta un'istruzione sono fissati dalla grammatica, quindi elencarli è esaustivo.
    const dentro = corpo();
    const dove = dentro.search(FLUSH);
    expect(dove, 'senza flush non c’è niente da rendere sincrono').toBeGreaterThan(-1);

    // (a) Qualunque costrutto capace di portarsi via la chiamata — lambda, riferimento a
    //     metodo — deve APRIRSI prima di lei: guardare il prefisso li intercetta tutti,
    //     anche quelli che nessuno ha ancora scritto.
    expect(
      dentro.slice(0, dove),
      'una lambda o un `::` fra super.onPause() e il flush lo spostano su un altro thread',
    ).not.toMatch(/->|::/);

    // (b) Profondità ≤ 1: il corpo del metodo, o il solo `try` che protegge la chiamata. Una
    //     classe anonima (`new Runnable() { public void run() { … } }`) porta a 3.
    expect(
      profonditaGraffe(dentro, dove),
      'il flush è annidato: al massimo può stare dentro il try che lo protegge',
    ).toBeLessThanOrEqual(1);

    // (c) Nessun modo di saltarlo. Il `try` non è condizionamento e non compare nell'elenco.
    expect(
      dentro.slice(0, dove),
      'c’è un costrutto che può saltare il flush: la forma direbbe «non è rimandato» mentre la chiamata non avviene mai',
    ).not.toMatch(CONDIZIONAMENTO);

    // (d) E dev'essere un'istruzione intera, non la coda di qualcos'altro.
    expect(istruzioneIntera(dentro, dove), 'il flush non apre un’istruzione propria').toBe(true);

    // (e) L'UNICA cosa che onPause fa con i cookie è scriverli su disco. Manomissione misurata
    //     al terzo giro (M2): `CookieManager.getInstance().removeSessionCookies(null);` dentro
    //     il try, subito prima del flush — 11 test verdi, con un flush diretto, incondizionato
    //     e sincrono che rendeva PERMANENTE la cancellazione della sessione. Cioè il difetto in
    //     riparazione, peggiorato, con addosso un lock verde.
    //
    //     Non una denylist di nomi (`removeSessionCookies`, `removeAllCookies`,
    //     `setAcceptCookie(false)`, …): è la lezione W9 qui sopra, una denylist è lunga quanto
    //     la fantasia di chi la scrive. Si dichiara invece ciò che è PERMESSO — una sola
    //     menzione della classe, e quella menzione è un `flush()`. Da qui non passa nemmeno la
    //     cattura in una variabile (`CookieManager cm = CookieManager.getInstance();`), che
    //     nominerebbe la classe una seconda volta.
    const menzioni = occorrenzeDi(dentro, /\bCookieManager\b/);
    expect(
      menzioni.length,
      'onPause nomina CookieManager più di una volta: l’unica forma consentita è il solo flush',
    ).toBe(1);
    const usi = [...dentro.matchAll(/CookieManager\s*\.\s*getInstance\s*\(\s*\)\s*\.\s*(\w+)/g)].map(
      (m) => m[1],
    );
    expect(usi, 'onPause tocca i cookie per altro che scriverli su disco').toEqual(['flush']);
  });

  it('il try che protegge il flush è QUELLO che lo contiene, e il suo catch lo chiude', () => {
    // Manomissione misurata (T1): flush spostato PRIMA del try, e dentro il try un innocuo
    // `getBridge().getWebView().clearFocus();`. Il predecessore contava i catch del corpo e
    // restava verde — mentre un guasto del flush tornava a essere un crash dentro onPause.
    const dentro = corpo();
    const legame = tryCheProteggeIlFlush(dentro);
    expect(legame.catch, 'il catch non segue il try che contiene il flush').toBeGreaterThan(
      legame.flush,
    );
    const catture = occorrenzeDi(dentro, CATCH);
    expect(
      catture,
      'il catch che chiude il try del flush non è riconosciuto come catch: la forma è cambiata',
    ).toContain(legame.catch);
  });

  it('un guasto del flush non chiude l’app, non è muto, non è declassato a «info» e non sparisce in release', () => {
    // AGENTS.md §6: un catch che non logga è un bug. §9: l'osservabilità non deve poter
    // rompere il prodotto — un'eccezione non gestita dentro onPause è un crash visibile.
    // §4: una configurazione/uno stato di guasto si registra a livello error, mai info.
    // §3: il corpo dell'errore non si butta via — qui è l'eccezione, e dev'essere PASSATA
    // alla riga di log, non riassunta in una frase.
    const dentro = corpo();
    // Prima di tutto: il catch dev'essere legato alla chiamata. Se il flush è fuori dal try,
    // questa riga lancia — e il messaggio dice esattamente cosa manca.
    tryCheProteggeIlFlush(dentro);

    const catture = [...dentro.matchAll(new RegExp(CATCH.source, 'g'))];
    expect(
      catture.length,
      'senza catch, un guasto del flush è un crash dentro onPause',
    ).toBeGreaterThan(0);

    // TUTTI i catch, non il primo: un secondo ramo muto aggiunto dopo sarebbe invisibile a
    // un controllo che si ferma al primo riscontro — è la stessa forma di errore che ha reso
    // finte tre prove di questo file.
    for (const cattura of catture) {
      const nomeEccezione = cattura[2];
      const dove = cattura.index ?? 0;
      const ramo = corpoDaPosizione(dentro, dove, `catch (${cattura[1]} ${nomeEccezione})`);
      expect(ramo.trim().length, 'catch muto: il guasto sparisce senza lasciare traccia').toBeGreaterThan(0);

      // Il titolo di questa prova promette che l'app NON si chiude, e fino al terzo giro
      // nessuna asserzione lo guardava: misurato (M1), `throw new RuntimeException("flush
      // cookie fallito", errore);` dopo il `Log.e` lasciava 11 test verdi su 11 e rimetteva il
      // crash dentro onPause — cioè proprio il caso che il commento del sorgente cita
      // (pacchetto WebView in aggiornamento) e che AGENTS.md §9 vieta: un guasto
      // dell'osservabilità o di una garanzia accessoria non può diventare un guasto del
      // prodotto. Il flush è una garanzia di durata: se fallisce si perde una sessione, non
      // l'app.
      expect(
        ramo,
        'il catch rilancia: un guasto del flush torna a essere un crash dentro onPause',
      ).not.toMatch(/\bthrow\b/);

      const LOG_GUASTO = /Log\s*\.\s*[ew]\s*\(/;
      expect(
        ramo,
        'il ramo di guasto va registrato a livello error/warn: `Log.i` su un fallimento contraddice AGENTS.md §4',
      ).toMatch(LOG_GUASTO);
      expect(
        ramo,
        `l’eccezione «${nomeEccezione}» non arriva alla riga di log: uno stato di guasto senza causa non dice perché`,
      ).toMatch(new RegExp(`Log\\s*\\.\\s*[ew]\\s*\\([^;]*\\b${nomeEccezione}\\b`));

      // RAGGIUNGIBILITÀ, non sola presenza. Manomissione misurata (T2):
      // `if (BuildConfig.DEBUG) { Log.e(…, errore) }` lasciava il test verde e in release il
      // guasto non si registrava mai — il silenzio che AGENTS.md descrive come «codice rotto».
      const dovLog = ramo.search(LOG_GUASTO);
      expect(
        profonditaGraffe(ramo, dovLog),
        'la riga di log del guasto è annidata dentro una guardia: in release il guasto è muto',
      ).toBe(0);
      expect(
        istruzioneIntera(ramo, dovLog),
        'la riga di log del guasto ha una guardia davanti: in release il guasto è muto',
      ).toBe(true);
    }
  });

  it('il log del SUCCESSO segue il flush, alla sua stessa profondità: prima o annidato non dimostra niente', () => {
    // AGENTS.md §5: con i soli errori, «nessun log» non distingue «tutto ok» da «non è mai
    // partito niente» — che è l'ambiguità in cui questo difetto è vissuto finora.
    //
    // Due metà, e all'inizio c'erano zero. La POSIZIONE: il predecessore chiedeva solo che un
    // `Log.i(` comparisse prima della parola `catch`, quindi spostando la riga sopra il flush
    // restava verde e il log affermava un successo non ancora avvenuto. La RAGGIUNGIBILITÀ:
    // misurato al secondo giro, `if (BuildConfig.DEBUG) { Log.i(…) }` restava verde e in
    // release il successo non si registrava mai.
    const dentro = corpo();
    const flush = FLUSH.exec(dentro);
    expect(flush?.index, 'senza flush non c’è nessun successo da registrare').toBeGreaterThan(-1);
    const posFlush = flush?.index ?? 0;
    const dopoIlFlush = posFlush + (flush?.[0].length ?? 0);

    const dovCatch = dentro.search(CATCH);
    expect(dovCatch, 'nessun catch: il confine del ramo di successo non esiste').toBeGreaterThan(-1);
    expect(dovCatch, 'il catch precede il flush: il try non protegge la chiamata').toBeGreaterThan(dopoIlFlush);

    const LOG_OK = /Log\s*\.\s*i\s*\(/;
    const fra = dentro.slice(dopoIlFlush, dovCatch);
    expect(
      fra,
      'nessun Log.i fra il flush e il catch: o il successo non si registra, o si registra prima di essere avvenuto',
    ).toMatch(LOG_OK);

    const posLog = dopoIlFlush + fra.search(LOG_OK);
    expect(
      profonditaGraffe(dentro, posLog),
      'il log del successo è annidato più a fondo della chiamata: sotto una guardia, in release non esiste',
    ).toBe(profonditaGraffe(dentro, posFlush));
    expect(
      istruzioneIntera(dentro, posLog),
      'il log del successo ha una guardia davanti: in release il successo non si registra',
    ).toBe(true);
  });

  it('nessun sorgente del modulo legge i cookie, e l’unica cosa che ne fa è scriverli su disco', () => {
    // `getCookie(...)` in questo modulo sarebbe il token di accesso di un genitore scritto in
    // chiaro in logcat, leggibile da `adb` — la stessa classe di guasto della foto base64.
    //
    // Tre correzioni, tutte da manomissioni misurate:
    //  · il perimetro è il MODULO e non il corpo di `onPause` (un metodo privato `diagnostica()`
    //    dichiarato fuori teneva il lock a 9 verdi su 9 mentre il cookie finiva nel log);
    //  · si guarda anche il testo GREZZO, non solo quello neutralizzato: `getCookie` scritto
    //    dentro un letterale di stringa spariva prima del divieto, ed è proprio lì che il
    //    codice di estrazione vive. Il prezzo è che la parola in un commento manda rosso;
    //  · il divieto copre il canale JS (`evaluateJavascript`, `javascript:`), da cui i cookie
    //    escono per davvero: `evaluateJavascript("document.cookie", v -> Log.i(TAG, v))` non
    //    contiene nessuno dei tre identificatori Java della vecchia denylist.
    expect(
      sorgenti.length,
      'scansione vuota: un divieto che non guarda nessun file è verde per un errore di percorso',
    ).toBeGreaterThan(0);
    expect(
      sorgenti.some((f) => f.endsWith('MainActivity.java')),
      'la scansione non vede MainActivity.java: il percorso dei sorgenti è cambiato',
    ).toBe(true);

    for (const file of sorgenti) {
      const relativo = path.relative(RADICE, file);
      const grezzo = fs.readFileSync(file, 'utf8');
      const codice = senzaCommentiNeStringhe(grezzo);
      for (const [etichetta, testo] of [
        ['testo grezzo', grezzo],
        ['codice', codice],
      ] as const) {
        expect(
          testo,
          `${relativo} (${etichetta}) accede al VALORE dei cookie: da lì a una riga di logcat c’è un passo`,
        ).not.toMatch(ACCESSO_AI_COOKIE);
        expect(
          testo,
          `${relativo} (${etichetta}) inietta JavaScript nella WebView: è il canale da cui un cookie esce senza mai nominarsi`,
        ).not.toMatch(CANALE_JS);
        // Metà di M6: una classe `CookieManager` dichiarata nel pacchetto dell'app, con
        // `getInstance()`/`flush()` a vuoto. Da sola non basterebbe a dirottare la chiamata —
        // in Java un import esplicito prevale sul tipo omonimo dello stesso pacchetto (JLS
        // §6.4.1) — ma insieme all'import commentato faceva 11 verdi su 11 con il flush che
        // non scriveva niente. Il divieto vale anche sul testo grezzo: è la stessa scelta già
        // fatta per gli accessori dei cookie, e il prezzo è che la frase in un commento manda
        // rosso.
        expect(
          testo,
          `${relativo} (${etichetta}): dichiara una classe CookieManager che scavalca android.webkit per risoluzione di pacchetto`,
        ).not.toMatch(/\bclass\s+CookieManager\b/);
      }

      // L'ELENCO CHIUSO di ciò che il modulo può fare con l'archivio cookie: l'import, e un
      // `getInstance().flush()`. Tolti quei due, l'identificatore non deve più comparire.
      //
      // È il perimetro giusto, e lo si è imparato al primo giro: il divieto sui dati cercava
      // dentro il corpo di `onPause`, e un metodo privato dichiarato fuori lo aggirava. Qui
      // vale lo stesso ragionamento per le SCRITTURE: la clausola (e) del test sul flush
      // guarda il corpo di `onPause`, ma una `removeAllCookies` chiamata da `onCreate`
      // cancellerebbe la sessione senza passare mai da lì.
      const residuo = codice
        .replace(/import\s+android\.webkit\.CookieManager\s*;/g, ' ')
        .replace(/CookieManager\s*\.\s*getInstance\s*\(\s*\)\s*\.\s*flush\s*\(\s*\)/g, ' ');
      expect(
        residuo,
        `${relativo} nomina CookieManager fuori dall’import e dall’unico flush consentito: l’archivio cookie di una famiglia si tocca solo per scriverlo su disco`,
      ).not.toMatch(/\bCookieManager\b/);
    }
  });
});

/**
 * Legge la durata dichiarata da un `Set-Cookie`, in secondi. `null` se non ne dichiara
 * nessuna, cioè se è un cookie di sessione.
 *
 * `Max-Age` vince su `Expires` perché è così che si comportano i browser (RFC 6265 §5.3.2).
 */
function scadenzaInSecondi(cookie: string, adesso = Date.now()): number | null {
  const testo = cookie.toLowerCase();
  const maxAge = /(?:^|;\s*)max-age\s*=\s*(-?\d+)/.exec(testo);
  if (maxAge) return Number(maxAge[1]);
  const expires = /(?:^|;\s*)expires\s*=\s*([^;]+)/.exec(testo);
  if (expires) {
    const quando = Date.parse(expires[1].trim());
    if (Number.isNaN(quando)) return null;
    return Math.round((quando - adesso) / 1000);
  }
  return null;
}

describe('T14-F3 — difesa in profondità: il cookie non deve tornare «di sessione»', () => {
  // Il test più sotto sostituisce l'archivio cookie di jsdom con uno finto, e va rimesso a
  // posto: senza, il primo test aggiunto dopo erediterebbe il magazzino finto e leggerebbe
  // cookie che non esistono — cioè un falso verde su una prova che con i cookie non c'entra
  // niente. `vi.unstubAllGlobals()` non basta: `Object.defineProperty` non passa dagli stub di
  // vitest e non viene annullato.
  let descrittoreCookie: PropertyDescriptor | undefined;

  beforeEach(() => {
    descrittoreCookie = Object.getOwnPropertyDescriptor(document, 'cookie');
  });

  afterEach(() => {
    // In jsdom `cookie` vive sul prototipo di `Document`: prima di questo test l'istanza non
    // ha una propria proprietà, quindi rimetterla a posto vuol dire toglierla e lasciare che
    // l'accesso torni al prototipo.
    if (descrittoreCookie) Object.defineProperty(document, 'cookie', descrittoreCookie);
    else delete (document as unknown as { cookie?: unknown }).cookie;
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('la misura della scadenza DISCRIMINA: un cookie che dura un secondo va rifiutato', () => {
    // Il test qui sotto misura una grandezza, e una misura non provata è un'opinione. Questo
    // è il collaudo della misura stessa, su stringhe sintetiche: senza, «≥ 30 giorni» sarebbe
    // verde anche se l'estrazione restituisse sempre lo stesso numero.
    //
    // Serve anche perché la manomissione suggerita dal verificatore — `cookieOptions:
    // { maxAge: 1 }` — oggi NON arriva al cookie: `@supabase/ssr` 0.10.3 rimette
    // `maxAge: DEFAULT_COOKIE_OPTIONS.maxAge` dopo aver applicato le opzioni dell'utente
    // (`dist/main/cookies.js:203-206`). La regressione contro cui si difende è quindi un
    // aggiornamento che smetta di forzarlo — e la difesa dev'essere dimostrata comunque.
    const fra30giorni = new Date(Date.now() + 40 * 24 * 3600 * 1000).toUTCString();
    const ieri = new Date(Date.now() - 24 * 3600 * 1000).toUTCString();

    expect(scadenzaInSecondi('sb-x=v; Path=/; Max-Age=34560000')).toBe(34560000);
    expect(scadenzaInSecondi('sb-x=v; Path=/; Max-Age=1')).toBe(1);
    expect(scadenzaInSecondi('sb-x=v; Path=/; Max-Age=0')).toBe(0);
    expect(scadenzaInSecondi('sb-x=v; Path=/; Max-Age=-1')).toBe(-1);
    expect(scadenzaInSecondi('sb-x=v; Path=/'), 'senza scadenza è un cookie di sessione').toBeNull();
    expect(scadenzaInSecondi(`sb-x=v; Expires=${fra30giorni}`) ?? 0).toBeGreaterThan(
      SCADENZA_MINIMA_SECONDI,
    );
    expect(scadenzaInSecondi(`sb-x=v; Expires=${ieri}`) ?? 0).toBeLessThan(0);
    // E la soglia deve dire di no a ciò che il vecchio test lasciava passare.
    expect(scadenzaInSecondi('sb-x=v; Max-Age=1') ?? 0).toBeLessThan(SCADENZA_MINIMA_SECONDI);
  });

  it('ogni cookie di sessione scritto dal client browser dura almeno 30 giorni', async () => {
    // Test di COMPORTAMENTO, non un grep: monta il nostro `getSupabase()` vero, gli fa
    // salvare una sessione e MISURA la scadenza della stringa che finisce in `document.cookie`
    // — cioè esattamente ciò che decide se il cookie sopravvive alla chiusura dell'app.
    //
    // La presenza della parola `max-age=` non bastava: `Max-Age=1` la conteneva e distruggeva
    // la sessione a ogni login, cioè un difetto peggiore di quello in riparazione.
    const scritti: string[] = [];
    const magazzino = new Map<string, string>();

    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => [...magazzino].map(([n, v]) => `${n}=${v}`).join('; '),
      set: (grezzo: string) => {
        scritti.push(grezzo);
        const [coppia] = grezzo.split(';');
        const i = coppia.indexOf('=');
        magazzino.set(coppia.slice(0, i).trim(), coppia.slice(i + 1).trim());
      },
    });

    vi.resetModules();
    const { getSupabase } = await import('@/lib/supabase/browser-client');
    // `auth.storage` è l'archivio che `@supabase/ssr` installa nel client: è il percorso
    // esatto che la sessione segue dopo il login. È un dettaglio interno di `supabase-js` —
    // se un aggiornamento lo rinomina questo test si rompe RUMOROSAMENTE, ed è preferibile
    // a una prova che guardi altrove.
    const archivio = (getSupabase().auth as unknown as {
      storage: { setItem(chiave: string, valore: string): Promise<void> };
    }).storage;
    expect(typeof archivio?.setItem).toBe('function');

    await archivio.setItem(
      'sb-collaudo-auth-token',
      JSON.stringify({ access_token: 'finto', refresh_token: 'finto', expires_at: 4102444800 }),
    );

    expect(scritti.length).toBeGreaterThan(0);
    let conValore = 0;
    for (const cookie of scritti) {
      const nome = cookie.split('=')[0];
      const valore = cookie.split(';')[0].slice(nome.length + 1);
      const durata = scadenzaInSecondi(cookie);

      if (valore === '') {
        // `@supabase/ssr` cancella i frammenti avanzati scrivendoli vuoti con `maxAge: 0`.
        // Non sono sessioni: pretendere 30 giorni su una cancellazione sarebbe un test che
        // vieta il comportamento corretto.
        expect(durata, `${nome}: cookie vuoto ma senza scadenza a zero, non è una cancellazione`).toBe(0);
        continue;
      }
      conValore += 1;
      // Senza `Max-Age` (o `Expires`) è un cookie di sessione: muore con il processo della
      // WebView, e nessun flush nativo può salvarlo. Con una scadenza corta muore lo stesso,
      // solo più tardi.
      expect(durata, `${nome}: cookie di sessione, nessun flush nativo può salvarlo`).not.toBeNull();
      expect(
        durata as number,
        `${nome}: scadenza di ${durata}s — sotto i 30 giorni la sessione muore comunque`,
      ).toBeGreaterThanOrEqual(SCADENZA_MINIMA_SECONDI);
    }
    expect(conValore, 'nessun cookie con un valore: la sessione non è stata scritta').toBeGreaterThan(0);
  });

  it('l’archivio cookie finto è stato smontato: chi aggiunge un test dopo non lo eredita', () => {
    // Il ripristino è VERIFICATO, non promesso: senza l'`afterEach` qui sopra, questo test
    // vedrebbe ancora il magazzino del test precedente — con dentro `sb-collaudo-auth-token`
    // e nessuna delle regole vere di jsdom sui cookie. (Provato togliendo il ripristino: rosso.)
    expect(Object.getOwnPropertyDescriptor(document, 'cookie')).toBeUndefined();
    document.cookie = 'kv-ripristino=1';
    expect(document.cookie).toContain('kv-ripristino=1');
    expect(document.cookie).not.toContain('sb-collaudo-auth-token');
  });
});
