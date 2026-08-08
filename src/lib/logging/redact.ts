import { createHash } from 'node:crypto';
import { redigiPath } from './path';

/**
 * `redigiPath` resta esportata DA QUI, anche se ora vive in `./path`: è la firma che il resto
 * del repo importa (`context.ts`, `app-log.ts`, `external.ts`, `supabase-fetch.ts`, i test), e
 * un modulo di logging non è il posto dove si rompono trenta call-site per un refactor. Il
 * codice però sta in un file SENZA IMPORT, perché la stessa euristica serve al middleware
 * (Edge), all'instrumentation e al browser — tre runtime che `node:crypto` non ce l'hanno.
 * Vedi la testata di `path.ts`.
 */
export { redigiPath };

/**
 * Redazione a LISTA BIANCA.
 *
 * Perché il default è invertito: in questo dominio "campo sensibile" è indecidibile
 * a runtime. `descrizione` compare 113 volte nelle route e vale tanto "Merenda"
 * quanto una diagnosi clinica. Una lista NERA basta dimenticare una chiave — o che
 * qualcuno ne aggiunga una nuova domani — perché un dato sanitario di un minore
 * finisca in chiaro nei log. Con la lista bianca, la dimenticanza è innocua.
 *
 * Cosa passa, ESATTAMENTE (il resto è redatto):
 *
 * - STRINGHE: chiuse per default. Escono in chiaro solo se la chiave è in `IN_CHIARO`
 *   (metadati di dominio: dicono cosa succedeva, non a chi) o se il valore è
 *   auto-descrittivo (uuid, timestamp ISO puro).
 *   Unica deroga: `digest` (il codice d'errore che Next mostra all'utente) esce in chiaro
 *   SOLO se anche il valore ha la forma di un digest — la chiave apre, il valore conferma.
 *   Vedi `CHIAVI_DIGEST`: senza quel campo la correlazione utente↔log è rotta; con la chiave
 *   sola sarebbe un canale di testo libero verso la tabella.
 * - NUMERI, BOOLEANI, DATE: passano, perché da soli non identificano nessuno e sono
 *   ciò che rende un log leggibile (conteggi, flag, istanti).
 *   ⚠️ MA un numero può essere un DATO: `voto_numerico: 7`, `media: 4.5` sono la
 *   valutazione di un minore, e accanto a un `alunno_id` (uuid, in chiaro) sarebbero
 *   il suo giudizio scritto nei log. Per questo la sensibilità si decide sulla CHIAVE,
 *   non sul tipo: qualunque chiave che contenga una `RADICE_SEGRETA` è redatta a
 *   prescindere dal tipo del valore.
 * - CHIAVI: confrontate NORMALIZZATE (minuscolo, senza `_` e `-`), così `votoNumerico`,
 *   `voto_numerico` e `VOTO-NUMERICO` cadono nello stesso secchio.
 */

/** Normalizza la chiave: `codice_fiscale`, `codiceFiscale`, `CODICE-FISCALE` → `codicefiscale`. */
function normalizzaChiave(k: string): string {
    return k.toLowerCase().replace(/[_-]/g, '');
}

function insieme(...chiavi: string[]): Set<string> {
    return new Set(chiavi.map(normalizzaChiave));
}

/**
 * Radici sensibili: qualunque chiave che CONTENGA una di queste è redatta, di qualunque
 * tipo sia il valore. La corrispondenza esatta non basta: il repo ha già `voto_numerico`
 * (grades), `media` (prospetto: la media per materia di un alunno), `giudizio`,
 * `votoNumerico`. Una lista di nomi esatti li lascerebbe passare tutti perché sono numeri.
 * Falsi positivi noti e accettati: `multimedia`/`mediateca` finiscono redatti — si perde
 * un metadato irrilevante, che è esattamente il verso in cui vogliamo sbagliare.
 */
const RADICI_SEGRETE = [
    'voto', 'media', 'giudizio', 'livello', 'valutazione', 'punteggio',
    'password', 'token', 'secret', 'firma', 'iban', 'otp',
];

/** Segreti per nome esatto (quelli che non hanno una radice utile). */
const SEGRETI = insieme(
    'apikey', 'api_key', 'authorization', 'cookie', 'code', 'hash', 'piva', 'signature',
);

/** Sostituiti da un hash stabile: identità non leggibile ma CORRELABILE. */
const DA_HASHARE = insieme(
    'nome', 'cognome', 'nome_completo', 'denominazione', 'email', 'mail',
    'telefono', 'cellulare', 'codice_fiscale', 'cf',
);

/**
 * LA DATA DI NASCITA DI UN MINORE — l'unico buco che la lista bianca aveva ancora, e come
 * si è aperto.
 *
 * Le DATE passano in chiaro per TIPO (vedi `DATA_ISO`): è la deroga che rende leggibile un
 * log (istanti, scadenze, giorni) e da sola non identifica nessuno. Ma "da sola" è la
 * parola che nasconde il difetto: la deroga guardava il VALORE e non la CHIAVE, quindi
 * `data_nascita: '2019-05-03'` usciva in chiaro esattamente come `creato_il`. Nelle righe
 * `iscrizione warn` di `app_log` — produzione, 30 giorni, interrogabile in SQL — nome,
 * cognome e codice fiscale uscivano hashati, tutto il resto era redatto, e la data di
 * nascita del bambino stava lì in chiaro accanto alla provincia di residenza e all'orario
 * dell'invio. Tre campi che insieme identificano una persona; e la persona è un minore.
 *
 * La correzione va nel verso che la regola 8 di AGENTS.md impone: si RESTRINGE la lista
 * bianca, non la si allarga. Qui la sensibilità si decide sulla CHIAVE, come per
 * `RADICI_SEGRETE`, e per la stessa ragione: `2019-05-03` e `2026-08-31` sono
 * indistinguibili a guardare il valore.
 *
 * DUE RADICI, `nascita` e `birth`, con `includes` — quindi coprono anche `dataNascita`,
 * `DATA-NASCITA`, `date_of_birth`, `birthDate`, `birthplace`. Per gli altri campi di
 * nascita (`comune_nascita`, `provincia_nascita`, `birth_city`…) NON cambia niente: erano
 * già redatti perché stringhe fuori dalla lista bianca. Cambia solo che ora lo sono per una
 * ragione dichiarata invece che per omissione.
 *
 * `dob` NON è qui di proposito: in questo repo non compare, e una radice di tre lettere
 * dentro un `includes` è il modo più facile di redigere per sbaglio una chiave innocua.
 */
const RADICI_NASCITA = ['nascita', 'birth'];

/**
 * IL TESTO LIBERO — e PERCHÉ LA CHIAVE DEVE DECIDERE PRIMA DEL TIPO.
 *
 * ─── LA REGOLA, prima del caso ──────────────────────────────────────────────
 *
 * In questo modulo la deroga per TIPO («numeri, booleani e date passano, da soli non
 * identificano nessuno») nasce pensando ai campi che scriviamo NOI: `ms`, `n_righe`,
 * `stato`, `occorrenze`. Ma `redact()` non gira solo su quelli: gira sul BODY GREZZO di
 * ogni richiesta, che `parseBody` deposita PRIMA di zod. Su quel materiale **il tipo non è
 * una proprietà del dato: è una scelta di chi manda la richiesta.** `motivo` è dichiarato
 * `z.unknown()` nello schema della rotta, quindi la stessa informazione può arrivare come
 * stringa, come numero, come booleano o come oggetto — e una difesa che guarda la forma
 * prima del nome tratta in quattro modi diversi lo stesso dato.
 *
 * Da qui la regola generale, che vale per tutte e quattro le famiglie di chiavi sensibili
 * (`RADICI_SEGRETE`, `DA_HASHARE`, `RADICI_NASCITA`, e queste): **la CHIAVE decide, e decide
 * per prima.** Il tipo può solo aggiungere una difesa, mai toglierne una. Il ramo per tipo
 * resta dov'è, ma sotto le chiavi che nominano un dato è irraggiungibile.
 *
 * ─── IL CASO CHE L'HA MOSTRATA (Q19, quarto collaudo) ───────────────────────
 *
 * `{"motivo": 40404}` usciva **in chiaro** in `app_log` — 30 giorni, interrogabile in SQL —
 * mentre `{"motivo":"40404"}` usciva `[redatto:str/5]`. Misurato in produzione su 18
 * occorrenze, più una riga preesistente della stessa forma. È la TERZA direzione da cui
 * questo stesso canale si è aperto: prima le CHIAVI (M15), poi le STRINGHE sotto lista
 * bianca (M11), ora il TIPO. Le prime due sono state chiuse una alla volta; questa chiude
 * la regola.
 *
 * ─── COSA C'È DENTRO, E PERCHÉ NON DI PIÙ ───────────────────────────────────
 *
 * I nomi con cui, in QUESTO schema, viaggia un testo scritto da una persona su un'altra:
 * il motivo dell'assenza e le note dell'appello (`presenze`, art. 9 su un minore), le note
 * mediche e le allergie del modulo d'iscrizione, il corpo di una notifica (porta il nome
 * del bambino), la descrizione — che «vale tanto "Merenda" quanto una diagnosi clinica»,
 * come dice la testata di questo file.
 *
 * NON è un elenco di parole «sensibili» a naso: ogni radice qui dentro corrisponde a una
 * colonna o a un campo di richiesta che esiste. Una radice troppo golosa spegnerebbe log
 * innocui, e una difesa che dà fastidio viene disattivata sei mesi dopo da qualcuno che non
 * sa perché c'era. Falsi positivi noti e accettati: `sospeso_motivo`, `annotazioni` (sono
 * testo libero davvero). Volutamente FUORI: `testo` — perché `contesto` lo contiene, e
 * redigere la chiave `contesto` cancellerebbe l'intera riga di log; il caso vero
 * (`giustificazione_testo`) è già coperto da `giustificazione`.
 */
const RADICI_TESTO_LIBERO = [
    'motivo', 'nota', 'note', 'giustificazione', 'descrizione', 'commento', 'corpo',
    'diagnosi', 'allerg', 'intolleran', 'patolog', 'terapia', 'farmac', 'sintom', 'anamnes',
];

/**
 * Path e URL: MAI in chiaro. In questo repo il token del modulo pubblico è un
 * SEGMENTO di path (`/m/[token]`, `/api/public/forms/[token]/submit`) ed è una
 * capability; le query string trasportano `?userId=`, `?email=`, `?token=`.
 * Passano da `redigiPath`, che ne tiene il solo pattern.
 *
 * ANCHE QUI LA CHIAVE APRE E IL VALORE CONFERMA (vedi `CHIAVI_DIGEST`, `FORMA_PATH`):
 * `redigiPath` riduce un PATH a pattern, e su una stringa che path non è non riduce niente —
 * la restituisce intatta. Finché bastava la chiave, `{"url":"<quello che ti pare>"}` era un
 * canale di TESTO LIBERO verso `app_log`: `redact()` gira anche sul BODY GREZZO di ogni
 * richiesta (`parseBody` deposita il raw PRIMA di zod), quindi la porta era aperta a chiunque
 * sapesse fare una POST. Misurato: `"url":"NON-ESISTE-collaudo-log.pdf"` in chiaro accanto a
 * `"fileUrl":"[redatto:str/27]"` — lo stesso valore, due trattamenti.
 */
const CHIAVI_PATH = insieme('path', 'route', 'url');

/**
 * La FORMA di un path o di un URL: comincia con `/` (path assoluto) oppure porta uno schema
 * (`https://`, `capacitor://`). Tutto il resto, sotto una chiave di path, è una stringa come
 * un'altra e viene redatta come un'altra.
 *
 * NON accetta i path RELATIVI (`api/alunni`): sotto queste chiavi, nei log del repo, arriva
 * sempre un `pathname` (`context.ts`, `client.ts`, `/api/logs`) o un URL intero. Accettarli
 * significherebbe riaprire la porta a qualunque parola sciolta — «Mario Rossi» è un path
 * relativo tanto quanto `api/alunni`. Chi ha in mano un frammento relativo e sa che è un path
 * chiama `redigiPath` direttamente (lo fa `supabase-fetch.ts` con `object/fascicoli/…`), e lì
 * la riduzione continua a valere.
 */
const FORMA_PATH = /^(\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/;

/**
 * Le uniche chiavi il cui valore STRINGA esce in chiaro. Sono metadati di dominio.
 * NB: `codice` NON è qui. Sembra innocuo, ma la valutazione di competenza viaggia
 * anche come `Livello.codice: 'A'|'B'|'C'|'D'` (src/lib/competenze/modello.ts): stessa
 * informazione di `livello`, altro nome. I codici d'errore hanno il loro campo dedicato.
 *
 * ESPORTATO perché il lock `logging-redact-canale-testo-libero.test.ts` gira sull'ELENCO e
 * non su un campione: una chiave aggiunta domani è coperta il giorno in cui viene aggiunta,
 * che è il solo momento in cui nessuno la sta guardando.
 */
export const CHIAVI_IN_CHIARO = [
    'tipo', 'tipo_evento', 'stato', 'esito', 'azione', 'operazione', 'metodo',
    'ordine', 'periodo', 'anno', 'anno_scolastico', 'mese', 'cadenza',
    'ruolo', 'grado', 'classe_sezione', 'sezione', 'bucket', 'mime', 'content_type',
    'estensione', 'formato', 'canale', 'piattaforma', 'ambiente', 'provider',
    'error_code', 'evento', 'entita_tipo',
] as const;

const IN_CHIARO = insieme(...CHIAVI_IN_CHIARO);

/**
 * LA FORMA DI UN ENUMERATO — la stessa deroga di `digest` e di `url`, estesa alle venti
 * chiavi che erano rimaste indietro.
 *
 * IL PROBLEMA (collaudo del 2026-08-07, rilievo M11). `redact()` non gira solo sui campi che
 * scriviamo noi: gira sul BODY GREZZO di ogni richiesta, perché `parseBody` fa
 * `impostaPayload('body', raw)` PRIMA di zod. Finché bastava la CHIAVE, `{"stato": "<quello
 * che ti pare>"}` era un canale di TESTO LIBERO verso `app_log` — 30 giorni, interrogabile in
 * SQL — e con `stato` uscivano `tipo`, `esito`, `operazione`, `sezione`, `grado`, `error_code`,
 * `entita_tipo`… Il canale non è anonimo (serve una sessione perché `withRoute` persista il
 * 400), ma su `parent/presenze/comunica-assenza` basta un account genitore, e il testo libero
 * di quella rotta è il MOTIVO dell'assenza: dato sanitario di un minore.
 *
 * Il modulo aveva già scritto la risposta due volte — `CHIAVI_DIGEST`, `CHIAVI_PATH`: **la
 * chiave apre, il valore conferma** — e non l'aveva generalizzata. Qui la forma è quella di un
 * ENUMERATO tecnico: comincia con una lettera o una cifra, niente spazi, niente a capo, e non
 * più lunga di 64 caratteri.
 *
 * PERCHÉ PROPRIO QUESTA FORMA, e perché non stringe i log veri. Misurati i 1.261 valori
 * letterali che `src/` scrive sotto queste chiavi: nessuno supera i **45** caratteri e nessuno
 * esce da questo alfabeto — ci stanno i nomi di rotta con segmento dinamico
 * (`admin/sections/[id]/teachers:DELETE`), i mime (`application/vnd.api+json`), i periodi
 * (`2026-07`), gli slug (`body-json-malformato`). 64 è il tetto che `/api/logs` usa già per
 * `evento`: non è un numero nuovo.
 *
 * NIENTE SPAZI è la riga che fa il lavoro: la prosa ne ha, un enumerato no. E un `\n` è nella
 * stessa classe per una ragione in più della privacy — spezzerebbe la riga di log in due voci,
 * e la seconda la scriverebbe il client.
 *
 * LO SLASH INIZIALE È AMMESSO, e non è una concessione: sotto `operazione` questo repo scrive
 * anche un PATTERN DI PATH — `instrumentation.ts` passa la rotta di render (`/dashboard`),
 * `external.ts` passa `redigiPath(new URL(url).pathname)` del provider. Quei valori sono già
 * ridotti a pattern da `redigiPath` prima di arrivare qui, e senza lo slash uscivano
 * `[redatto:str/10]`: si perdeva la sola colonna che dice DOVE è successo. Un path resta senza
 * spazi e sotto i 64 caratteri, quindi la difesa non cambia natura.
 *
 * ⚠️ LIMITE DICHIARATO, perché nessuno lo scopra da solo fra sei mesi: un token SENZA spazi e
 * più corto di 64 caratteri passa ancora — un codice fiscale (`RSSMRA80A01H501U`) ha questa
 * forma. Questa difesa chiude il testo libero, non ogni dato possibile. Il presidio contro i
 * dati personali resta quello di sempre: la chiave (`DA_HASHARE`, `RADICI_SEGRETE`,
 * `RADICI_NASCITA`) e la lista bianca chiusa per default.
 */
const FORMA_ENUMERATO = /^[A-Za-z0-9/][A-Za-z0-9._:/+[\]-]{0,63}$/;

/**
 * LA FORMA DI UN CODICE FISCALE — l'unica eccezione alla forma dell'enumerato, e perché.
 *
 * Misurata in `app_log` una riga che non veniva dal collaudo, scritta da un `educator`:
 * `"sezione": "RSSMRA80A01H501U"` in chiaro dentro `campi` e dentro `payload.query`. Il nome
 * della classe arriva da un query param, il codice lo rimette nei campi, e sedici caratteri
 * senza spazi sono un enumerato perfetto: `FORMA_ENUMERATO` non aveva niente da obiettare.
 *
 * È il caso in cui il «limite dichiarato» del commento qui sopra («un codice fiscale ha questa
 * forma») smette di essere un limite teorico. In produzione ce ne sono centinaia, di minori, e
 * il codice fiscale è l'unico identificatore di questo dominio che si riconosca dalla forma
 * senza ambiguità — sei lettere, due cifre, lettera, due cifre, lettera, tre cifre, lettera.
 *
 * Costa zero in diagnosi: nessuno dei 1.261 valori letterali che `src/` scrive sotto le chiavi
 * in lista bianca ha questa forma, e i nomi di sezione veri (`TEST-1A`, `Primavera-A`) non le
 * somigliano nemmeno. Vale ovunque — campi e payload — perché il difetto misurato stava nei
 * campi, dove la difesa sulla provenienza (`redactInput`) non arriva.
 */
const FORMA_CODICE_FISCALE = /^[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z]$/;

/** Un enumerato tecnico: la forma giusta E non la forma di un codice fiscale. */
function eEnumerato(v: string): boolean {
    return FORMA_ENUMERATO.test(v) && !FORMA_CODICE_FISCALE.test(v);
}

/**
 * L'alfabeto di una CHIAVE, e perché le chiavi vanno guardate come i valori (rilievo M15).
 *
 * `redactValore` riusava il nome della chiave intatto: `out[kk] = redactValore(kk, …)`. Quindi
 * bastava spostare il testo dal valore al NOME per non passare da nessuna riduzione —
 * `{"motivo": {"HA LA VARICELLA": 1}}` usciva intero, mentre `{"motivo": "HA LA VARICELLA"}`
 * usciva `[redatto:str/15]`. Lo stesso dato, due trattamenti, decisi dalla forma che gli dà
 * il client. E il client la forma la sceglie: `motivo` è dichiarato `z.unknown()`, e le chiavi
 * dello slot `query` sono i nomi dei query param, cioè testo che arriva dall'esterno.
 *
 * Alfabeto conservativo — quello di un identificatore, più `.` e `-` per gli header e i nomi
 * composti — e tetto a 64 come per i valori. Una chiave fuori forma esce come
 * `[chiave-redatta:N]`: si perde il nome, si tiene il fatto che il campo c'era e quanto era
 * lungo, che è metà della diagnosi.
 */
const FORMA_CHIAVE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/**
 * IL `digest` DI NEXT — l'unica deroga alla lista bianca, e vale la pena scrivere perché.
 *
 * IL PROBLEMA. `error.tsx` e `global-error.tsx` mostrano il digest all'utente come «il codice da
 * dare alla segreteria»: è l'unico numero che un genitore ha in mano quando telefona. Dall'altra
 * parte, `instrumentation.ts` (`onRequestError`) è l'unico punto che vede lo STACK VERO di un
 * errore di render — e lo passa in `campi.digest`, che finisce in `app_log.contesto`. Ma
 * `digest` non era in lista bianca: in tabella usciva come `[redatto:str/10]`. Risultato: il
 * genitore detta un codice che in SQL non trova NESSUNA riga, e la riga con lo stack — che c'è,
 * ed è a un `where` di distanza — resta irraggiungibile. Non è un campo comodo che manca: è la
 * correlazione utente↔log che è rotta in due.
 *
 * PERCHÉ NON VIOLA LA REGOLA 8 («non allargare la lista bianca perché sarebbe comodo»). Il
 * digest di Next è un HASH generato dal FRAMEWORK a partire da messaggio e stack dell'errore:
 * non è un dato personale, non è invertibile, non lo scrive nessun utente. Non è un dato che si
 * vuole vedere: è la CHIAVE con cui si ritrova la riga che il dato ce l'ha già.
 *
 * PERCHÉ LA CHIAVE DA SOLA NON BASTA (ed è qui che la deroga si stringe). `redact()` non gira
 * solo sui campi che scriviamo noi: gira sul BODY GREZZO di ogni richiesta — `parseBody` fa
 * `impostaPayload('body', raw)` PRIMA della validazione zod, apposta per poter diagnosticare i
 * 400. Mettere `digest` in `IN_CHIARO` e basta significherebbe quindi aprire un canale di TESTO
 * LIBERO (fino a 120 caratteri, in chiaro, in tabella) a chiunque possa fare una POST: basta
 * spedire `{"digest": "<quello che ti pare>"}`. La lista bianca resterebbe "a lista bianca" solo
 * di nome.
 *
 * Perciò: LA CHIAVE APRE, IL VALORE CONFERMA. Passa in chiaro solo ciò che ha la FORMA di un
 * digest — un token opaco esadecimale. Tutto il resto sotto quella chiave resta redatto
 * esattamente come oggi (fail-closed: si perde la correlazione, non si guadagna una falla).
 * Cosa NON passa, e sono i casi che contano:
 *  · testo libero, nomi, note, diagnosi (hanno spazi, accenti, lettere fuori dall'esadecimale);
 *  · un'email (la `@` non è esadecimale) e un codice fiscale (`RSSMRA…`: R, S, M non lo sono);
 *  · i digest di CONTROLLO di Next, che non sono hash ma stringhe con dentro un PATH —
 *    `NEXT_REDIRECT;replace;/m/<token>;307;`. In questo repo il path è una CREDENZIALE
 *    (`/m/[token]` è una capability): è il caso in cui una lista bianca ingenua avrebbe versato
 *    nei log proprio ciò che `redigiPath` esiste per togliere. Il `;` non è esadecimale: redatto.
 */
const CHIAVI_DIGEST = insieme('digest');

/**
 * La forma di un digest: solo esadecimale. Copre le due che Next produce davvero — il digest
 * numerico degli errori di Server Component (`stringHash` → «2043430104») e gli hash esadecimali
 * — e NON copre nient'altro che possa essere un dato. Il tetto a 64 caratteri è quello di uno
 * sha256 in esadecimale: oltre, non è un digest, è qualcos'altro.
 */
const DIGEST_PLAUSIBILE = /^[0-9a-f]{4,64}$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ANCORATO IN FONDO ($), e deve restarci: senza l'ancora, qualunque testo libero che
 * COMINCIA con una data ("2026-07-12 il bambino ha avuto una crisi") verrebbe giudicato
 * auto-descrittivo e finirebbe in chiaro nei log. Solo un timestamp ISO puro passa.
 */
const DATA_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const PROFONDITA_MAX = 5;
const ELEMENTI_MAX = 20;
const CHIAVI_MAX = 40;
const STRINGA_IN_CHIARO_MAX = 120;
const STACK_RIGHE_MAX = 5;

function eSegreta(chiaveNorm: string): boolean {
    if (SEGRETI.has(chiaveNorm)) return true;
    return RADICI_SEGRETE.some((radice) => chiaveNorm.includes(radice));
}

function eNascita(chiaveNorm: string): boolean {
    return RADICI_NASCITA.some((radice) => chiaveNorm.includes(radice));
}

function eTestoLibero(chiaveNorm: string): boolean {
    return RADICI_TESTO_LIBERO.some((radice) => chiaveNorm.includes(radice));
}

/**
 * Il valore di un campo di testo libero, redatto SENZA far sparire il campo.
 *
 * `[redatto:num]` e non `[redatto]` secco: la diagnosi di un 400 sta metà nel sapere che il
 * campo c'era e di che forma era. «`motivo` è arrivato come numero» è esattamente ciò che
 * spiega perché `motivoNormalizzato` l'ha scartato e la riga di `presenze` è rimasta senza
 * testo — con `[redatto]` per tutti quel filo si perde e resta solo la riproduzione a mano.
 *
 * Le stringhe conservano la lunghezza come qualunque altra stringa fuori dalla lista bianca;
 * oggetti e array collassano, perché lì il testo può stare tanto nei valori quanto nei nomi
 * (rilievo M15) e non c'è una forma da conservare che valga il rischio.
 *
 * `null`/`undefined` passano intatti: «il campo mancava» è il 95% dei bug, e un `null` non è
 * il dato di nessuno.
 */
function redigiTestoLibero(v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return redigiStringa(v);
    if (typeof v === 'number') return '[redatto:num]';
    if (typeof v === 'boolean') return '[redatto:bool]';
    return '[redatto]';
}

/**
 * Il valore di un campo di nascita, redatto SENZA perdere la diagnosi.
 *
 * Non è `'[redatto]'` secco, e la differenza è già stata pagata una volta: la provincia
 * viaggia in una colonna `varchar(2)` e il guasto vero era un `22001` (valore troppo
 * lungo). Con `[redatto:str/8]` in tabella si vede subito che il campo aveva 8 caratteri
 * invece di 2 — con `[redatto]` non si vede più niente e resta solo la riproduzione a mano.
 * Perciò le stringhe conservano la lunghezza, esattamente come qualunque altra stringa
 * fuori dalla lista bianca: rispetto a oggi cambia solo che la deroga «è una data, quindi
 * passa» qui non si applica più.
 *
 * `null`/`undefined` passano intatti: «il campo mancava» è il 95% dei bug (§5 del design),
 * e un `null` non è il dato di nessuno.
 */
function redigiNascita(v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return redigiStringa(v);
    // Date, numeri (un epoch è una data di nascita a tutti gli effetti), oggetti annidati:
    // niente forma da conservare, e il verso in cui si sbaglia è quello giusto.
    return '[redatto]';
}

/**
 * Hash stabile e corto: permette di dire "è sempre lo stesso genitore" senza dire chi.
 *
 * FAIL-CLOSED due volte:
 * 1. senza `LOG_HASH_SALT` non produce un hash debole, redige e basta. Questo repo è
 *    pubblico: con il salt noto e uno spazio di input minuscolo (le poche centinaia di
 *    nomi/email di una scuola) l'hash sarebbe invertibile per forza bruta, e la
 *    pseudonimizzazione sarebbe solo nominale. Il salt NON si genera a runtime: uno
 *    casuale per processo spezzerebbe la correlazione tra lambda diverse, che è l'unica
 *    ragione per cui questo hash esiste.
 * 2. hasha solo `string | number`. `String({...})` è `"[object Object]"` per QUALUNQUE
 *    oggetto: l'hash sarebbe identico per persone diverse, e un hash "correlabile" che
 *    correla il falso è peggio di nessun hash.
 * 3. non hasha il VUOTO, per la stessa ragione del punto 2 — ed è il caso che si è
 *    presentato davvero. `hashCorrelabile('')` è una COSTANTE: in una riga `iscrizione warn`
 *    di produzione nome, cognome, codice fiscale ed email di un adulto uscivano TUTTI come lo
 *    stesso `#xxxxxxxx`, e quello stesso `#xxxxxxxx` compariva sulle righe di persone
 *    DIVERSE. Un campo vuoto non è un'identità: correlarlo significa affermare che due
 *    estranei sono la stessa persona, in una tabella che si legge per capire cosa è successo.
 *    Esce quindi come qualunque altra stringa fuori dalla lista bianca — `[redatto:str/0]` —
 *    che dice anche la cosa utile: «il campo c'era ed era vuoto», che è metà dei bug.
 */
export function hashCorrelabile(valore: unknown): string {
    const salt = process.env.LOG_HASH_SALT;
    if (!salt) return '[redatto]';
    if (typeof valore !== 'string' && typeof valore !== 'number') return '[redatto]';
    if (typeof valore === 'string' && valore.trim() === '') return redigiStringa(valore);
    return '#' + createHash('sha256').update(salt + String(valore)).digest('hex').slice(0, 8);
}

function redigiStringa(v: string): string {
    return `[redatto:str/${v.length}]`;
}

function tronca(v: string): string {
    return v.length > STRINGA_IN_CHIARO_MAX ? v.slice(0, STRINGA_IN_CHIARO_MAX) + '…' : v;
}

/** Un valore stringa esce in chiaro solo se è "auto-descrittivo" (uuid o data). */
function stringaAutoDescrittiva(v: string): boolean {
    return UUID.test(v) || DATA_ISO.test(v);
}

/**
 * Un Error non può uscire come `{}`. `message` e `stack` non sono enumerabili, quindi
 * `Object.keys` non li vede: senza questo ramo l'errore — il caso d'uso numero uno di un
 * logger — sparirebbe, e chiunque cabli il logger sarebbe tentato di bypassare `redact`
 * per gli errori. Ma `message` contiene benissimo un'email o un nome: esce redatto.
 */
function redigiErrore(v: Error): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null);
    out.name = v.name;
    out.message = redigiStringa(v.message);
    if (typeof v.stack === 'string') {
        out.stack = v.stack.split('\n').slice(0, STACK_RIGHE_MAX).map(redigiStringa);
    }
    return out;
}

/**
 * Il nome con cui una chiave arriva in tabella.
 *
 * Fuori dalla `FORMA_CHIAVE` diventa `[chiave-redatta:N]` — e il progressivo `#2`, `#3` non è
 * un vezzo: senza, due chiavi ostili della stessa lunghezza (`{'a b':1,'c d':2}`) collasserebbero
 * nello stesso nome e la seconda sovrascriverebbe la prima. Il log direbbe che il campo era uno
 * solo, cioè mentirebbe sul numero — che in una riga di diagnosi è metà dell'informazione.
 *
 * NB: la sensibilità del VALORE si continua a decidere sulla chiave VERA (`redactValore(kk, …)`
 * riceve `kk`, non il nome in uscita): `{'password!': 'hunter2'}` perde il nome per la forma e
 * il valore per la radice segreta. Se si passasse il nome redatto, redigere una chiave
 * significherebbe ASSOLVERE il suo valore — l'esatto contrario di ciò che serve.
 */
function nomeInUscita(chiave: string, gia: Record<string, unknown>): string {
    if (FORMA_CHIAVE.test(chiave)) return chiave;
    const base = `[chiave-redatta:${chiave.length}]`;
    if (!(base in gia)) return base;
    let i = 2;
    while (`${base}#${i}` in gia) i++;
    return `${base}#${i}`;
}

function redactValore(
    chiave: string | null,
    v: unknown,
    prof: number,
    visti: Set<object>,
    /**
     * `false` per il PAYLOAD GREZZO di una richiesta: lì le chiavi le sceglie il client, e una
     * chiave scelta dal client non può aprire niente. Vedi `redactInput`.
     */
    fidato = true,
): unknown {
    const k = chiave === null ? null : normalizzaChiave(chiave);

    // ═══ LA CHIAVE DECIDE, E DECIDE PER PRIMA ════════════════════════════════════
    // Tutte e quattro le politiche per NOME stanno qui, sopra ogni ramo per tipo. Non è
    // ordine estetico: sotto, `typeof v === 'number' || 'boolean'` e `v instanceof Date`
    // farebbero uscire in chiaro proprio le forme con cui questi dati arrivano davvero —
    // e su un body grezzo la forma la sceglie il client, non il dato (vedi
    // `RADICI_TESTO_LIBERO`). Il tipo può aggiungere una difesa, mai toglierne una.
    if (k !== null) {
        if (eSegreta(k)) return '[redatto]';
        if (DA_HASHARE.has(k)) return v === null || v === undefined ? v : hashCorrelabile(v);
        if (eNascita(k)) return redigiNascita(v);
        if (eTestoLibero(k)) return redigiTestoLibero(v);
    }

    if (v === null || v === undefined) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return `${v.toString()}n`;
    if (typeof v === 'function' || typeof v === 'symbol') return `[${typeof v}]`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '[data-invalida]' : v.toISOString();
    if (v instanceof Error) return redigiErrore(v);

    if (typeof v === 'string') {
        // `fidato === false`: nessuna chiave apre. Restano solo le stringhe auto-descrittive
        // per FORMA (uuid, data ISO) — quelle sono tali chiunque le scriva.
        if (k !== null && fidato) {
            // LA CHIAVE APRE, IL VALORE CONFERMA: solo ciò che ha la forma di un path o di un
            // URL viene ridotto a pattern. Quello che path non è cade sotto, e viene redatto
            // come qualunque altra stringa — così `url` e `fileUrl` dicono la stessa cosa
            // dello stesso valore.
            if (CHIAVI_PATH.has(k)) return FORMA_PATH.test(v) ? tronca(redigiPath(v)) : redigiStringa(v);
            // LA CHIAVE APRE, IL VALORE CONFERMA (vedi `FORMA_ENUMERATO`). Niente `tronca`:
            // la forma impone già 64 caratteri, e un troncamento a 120 non scatterebbe mai —
            // ma soprattutto un enumerato tagliato a metà non è un enumerato, è un'altra
            // cosa che si legge come se fosse quella giusta.
            if (IN_CHIARO.has(k)) return eEnumerato(v) ? v : redigiStringa(v);
            // LA CHIAVE APRE, IL VALORE CONFERMA (vedi `CHIAVI_DIGEST`): niente `tronca`, perché
            // un digest o ci sta intero — e allora si può cercare — o non serve a niente. Se la
            // forma non torna si cade sotto, e la stringa esce redatta come qualunque altra:
            // la deroga non ha un ramo "quasi in chiaro".
            if (CHIAVI_DIGEST.has(k) && DIGEST_PLAUSIBILE.test(v)) return v;
        }
        if (stringaAutoDescrittiva(v)) return v;
        return redigiStringa(v);
    }

    if (prof >= PROFONDITA_MAX) return '[profondità-max]';

    // `visti` traccia il PERCORSO, non tutti gli oggetti già incontrati: alla fine della
    // ricorsione l'oggetto viene tolto. Altrimenti un riferimento semplicemente CONDIVISO
    // (`{ a: x, b: x }`, non ciclico) verrebbe etichettato `[ciclo]` e il dato sparirebbe.
    if (visti.has(v as object)) return '[ciclo]';
    visti.add(v as object);

    try {
        if (Array.isArray(v)) {
            const testa = v.slice(0, ELEMENTI_MAX).map((el) => redactValore(chiave, el, prof + 1, visti, fidato));
            return v.length > ELEMENTI_MAX ? [...testa, `[+${v.length - ELEMENTI_MAX} elementi]`] : testa;
        }

        // Object.create(null): il body di una richiesta è input non fidato, e su un
        // oggetto letterale `out['__proto__'] = …` invocherebbe il setter del prototipo.
        const out: Record<string, unknown> = Object.create(null);
        // Object.keys (non Object.entries): entries INVOCA i getter, quindi un getter che
        // lancia farebbe collassare l'intero oggetto. Qui si legge campo per campo, dentro
        // un try: si perde il campo rotto, non tutta la riga di log.
        const chiavi = Object.keys(v as object);
        let n = 0;
        for (const kk of chiavi) {
            if (n++ >= CHIAVI_MAX) {
                out['[…]'] = `[+${chiavi.length - CHIAVI_MAX} chiavi]`;
                break;
            }
            // Il nome si decide PRIMA del try: calcolarlo anche nel `catch` significherebbe
            // chiamare due volte il progressivo delle collisioni su uno stato diverso.
            const nome = nomeInUscita(kk, out);
            try {
                out[nome] = redactValore(kk, (v as Record<string, unknown>)[kk], prof + 1, visti, fidato);
            } catch {
                out[nome] = '[campo-illeggibile]';
            }
        }
        return out;
    } finally {
        visti.delete(v as object);
    }
}

/**
 * IL VALORE PUÒ DISTINGUERE UNA RIGA DI LOG? — «uuid sì, nomi mai», come CODICE.
 *
 * Serve a `logEvento({ distingui: [...] })`, che fa entrare nell'IMPRONTA di
 * `app_log` l'identità del bersaglio di una riga: senza, tutti i rifiuti di un
 * genitore su venti bambini diversi cadono in una riga sola e la colonna
 * `contesto.campi.alunno_id` dichiara UN bambino — quello della prima
 * occorrenza del giorno (rilievi T9, T10, T29).
 *
 * L'AMMISSIONE PASSA DALLA FORMA, non dalla buona volontà del chiamante: si
 * accetta esattamente ciò che questo modulo lascia già uscire IN CHIARO senza
 * bisogno di una chiave in lista bianca — uuid, numeri, booleani, date ISO,
 * enumerati tecnici. Tutto il resto (un nome, un'email, il motivo di
 * un'assenza) restituisce `null` e NON distingue: due nomi diversi producono
 * la stessa impronta, che è il comportamento che si vuole.
 *
 * PERCHÉ CONTA anche se l'impronta è un hash e non si legge: un'impronta
 * calcolata su un nome è comunque una chiave stabile e correlabile per
 * PERSONA. Su dati di minori, «non si vede» non è «non c'è».
 *
 * ⚠️ LIMITE DICHIARATO, lo stesso di `FORMA_ENUMERATO`: un token senza spazi e
 * più corto di 64 caratteri passa (un codice fiscale ha questa forma). Il
 * presidio resta che il chiamante DICHIARA il campo, e i campi dichiarati sono
 * id ed enumerati scelti dal codice, non input dell'utente.
 */
export function valoreDistintivo(v: unknown): string | null {
    try {
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        if (typeof v === 'boolean') return String(v);
        if (typeof v !== 'string' || v === '') return null;
        if (UUID.test(v)) return v;
        if (DATA_ISO.test(v)) return v;
        // `eEnumerato` e non `FORMA_ENUMERATO`: un codice fiscale ha la forma di un enumerato,
        // e un'impronta calcolata su un codice fiscale è una chiave stabile per PERSONA anche
        // se il valore non si legge. Su dati di minori, «non si vede» non è «non c'è».
        return eEnumerato(v) ? v : null;
    } catch {
        return null;
    }
}

/**
 * Redige un valore qualunque. NON lancia mai: è chiamata dentro un logger, e un
 * logger che lancia trasforma una 200 in 500 su tutte le route.
 */
export function redact(v: unknown): unknown {
    try {
        return redactValore(null, v, 0, new Set());
    } catch {
        return '[redazione-fallita]';
    }
}

/**
 * Come `redact`, ma per ciò che ARRIVA DALLA RETE: il body, la query, i params di una
 * richiesta, depositati da `impostaPayload` prima ancora che zod li guardi.
 *
 * ─── LA DIFFERENZA, IN UNA RIGA: QUI LA CHIAVE NON APRE ─────────────────────
 *
 * La lista bianca di `redact` («`stato`, `esito`, `tipo`… escono in chiaro») presuppone una
 * cosa che nel payload non è vera: che il nome del campo lo abbia scelto il NOSTRO codice.
 * Sotto `payload` il nome lo sceglie chi fa la richiesta, e `FORMA_ENUMERATO` non può
 * distinguere `body-json-malformato` da `diagnosi-inventata-per-collaudo` — hanno la stessa
 * forma, e la seconda è stata piantata in produzione con la sola sessione di un genitore
 * (quarto collaudo, rilievo Q2). Non c'è una forma che separi le due: c'è la PROVENIENZA.
 *
 * Cosa resta leggibile, ed è quanto serve a diagnosticare un 400: gli uuid e le date (sono
 * auto-descrittivi per forma, chiunque li scriva), i numeri e i booleani sotto chiavi che non
 * nominano un dato, i nomi dei campi, e la lunghezza di ciò che è stato redatto. Cioè: QUALE
 * bambino, QUALE giorno, QUALI campi c'erano e quanto erano lunghi.
 *
 * NON si applica ai `campi`: quelli li scrive il nostro codice, e lì la lista bianca è ciò che
 * rende `app_log` interrogabile. Il residuo noto è dichiarato: una route che rimette un query
 * param dentro i campi (`sezione`) riporta il valore del client in un canale fidato — per quel
 * caso la difesa è sulla forma, vedi `FORMA_CODICE_FISCALE`.
 */
export function redactInput(v: unknown): unknown {
    try {
        return redactValore(null, v, 0, new Set(), false);
    } catch {
        return '[redazione-fallita]';
    }
}
