#!/usr/bin/env node
// =============================================================================
// SERVER FINTO DI COLLAUDO DEI CARICAMENTI NATIVI
// PR 3 «app 1.2: caricamenti nativi in background», compito S2
// (spec: docs/superpowers/specs/2026-10-03-video-pr3-app-1-2-design.md, §10 e §11.1)
//
// A CHE COSA SERVE
// Il collaudo C1 prova il MOTORE nativo (iOS: URLSession in background; Android: UIDT o
// WorkManager) su simulatore ed emulatore senza il server vero: quello costringerebbe a
// sporcare lo Storage e a non poter provocare i guasti a comando. Questo server fa la parte
// dello Storage e delle due porte di `/api/video-uploads/rinnovo` e `/api/logs`, e RICORDA
// tutto: byte e sha256 ricevuti, ogni tentativo, ogni log. Ogni scenario di C1 si chiude
// LEGGENDO `/stato`, non guardando lo schermo.
//
// COME SI AVVIA
//   node scripts/collaudo-caricamenti/server.mjs --porta 4310
//   iOS Simulator  →  http://localhost:4310/            (condivide la rete del Mac)
//   Android (AVD)  →  http://10.0.2.2:4310/             (alias del loopback del Mac)
//   curl -s http://127.0.0.1:4310/stato                 (tutto ciò che il server ha visto)
// Raggiungibilità, da provare per prima cosa in C1 (con la porta vera):
//   iOS     xcrun simctl spawn booted /usr/bin/curl -s http://localhost:4310/salute
//           → {"ok":true}  (PROVATO il 03/10 sul simulatore iPhone 16e, con questo server su 127.0.0.1)
//   Android dal browser dell'emulatore: http://10.0.2.2:4310/salute  (NON provato: nessun AVD era
//           avviato quando è stato scritto; è la funzione documentata dell'emulatore, e la
//           configurazione di rete Debug dell'app riapre il chiaro proprio verso quell'indirizzo)
// Opzioni: --porta N (0 = ne sceglie una libera) · --file-porta PERCORSO (ci scrive la
// porta scelta) · --vita-massima SECONDI (si spegne da solo: rete di sicurezza per chi lo
// lancia da uno script) · --velocita-lento KB/s · --drena-byte N · --muto-secondi S ·
// --tetto-log N · --tace · --aiuto.
//
// 🔒 ASCOLTA SOLO SU 127.0.0.1. L'emulatore Android raggiunge il loopback del Mac con
// l'indirizzo speciale 10.0.2.2 (è l'alias che l'emulatore dà a «127.0.0.1 della macchina
// ospite»): quel traffico arriva QUI, su 127.0.0.1, e non serve ascoltare altrove. Non c'è
// un'opzione per cambiare l'indirizzo, di proposito: un server che accetta video «di
// prova» da tutta la rete locale è un'altra cosa. La configurazione di rete Debug di
// Android (`android/app/src/debug/res/xml/network_security_config.xml`) riapre il chiaro
// proprio verso 10.0.2.2, localhost e 127.0.0.1; la politica degli host del plugin
// (spec §9) in Debug ammette gli stessi tre, con qualunque porta.
//
// ─── LE PORTE ───────────────────────────────────────────────────────────────────
//   GET  /                              la pagina di collaudo (`pagina.html`)
//   GET  /config                        utente e sede di prova, testi delle notifiche, scenari
//   POST /apri                          fa la parte di `POST /api/video-uploads`: apre un job di
//                                       prova e restituisce URL, token e testi da dare ad
//                                       `accodaVideo` (il corpo è sotto)
//   PUT  /put/<jobId>?token=<scenario>  fa la parte dell'URL firmato dello Storage
//   POST /api/video-uploads/rinnovo     il rinnovo (gate: `x-kidville-rinnovo`, come il vero)
//   POST /api/logs                      i log del nativo, validati con le regole della route vera
//   GET  /stato  ·  GET /stato/<jobId>  quello che il server ha visto, e le VERIFICHE (sotto)
//   POST /azzera                        dimentica jobs e log (non tocca la coda del telefono)
//   GET  /salute                        {ok:true}
//
// ─── GLI SCENARI DELLA PUT (il «token» dell'URL) ─────────────────────────────────
// Si scelgono con `?token=<scenario>` sull'URL, come l'URL vero porta il suo token firmato.
//   ok              200 a piena velocità
//   lento           200, ma leggendo a `velocitaKBs` (predefinita: --velocita-lento): serve a
//                   dare il tempo di bloccare lo schermo, uccidere l'app, annullare
//   cade-a-meta     ai primi `volte` tentativi (1) legge `frazione` (0,5) del corpo, A VELOCITÀ
//                   LENTA (così l'app fa in tempo ad andare in background) e poi spezza la
//                   connessione; dal tentativo successivo è un `ok`
//   scaduto         400 `{statusCode:"403", error:"InvalidJWT"}`: l'URL è scaduto
//   duplicato       400 `{statusCode:"409", error:"Duplicate"}`: l'oggetto c'è già
//   muto            ai primi `volte` tentativi legge tutto il corpo e NON risponde (poi chiude
//                   dopo --muto-secondi); dal successivo è un `ok`
//   errore-500      ai primi `volte` tentativi risponde 500; dal successivo è un `ok`
//   risposta-persa  ai primi `volte` tentativi riceve TUTTO il corpo, lo tiene (l'oggetto
//                   «c'è») e spezza la connessione senza rispondere: la ripetizione prende
//                   il Duplicate e il rinnovo dice `arrivato` (il caso vero della seconda PUT)
// Lo stato HTTP e il corpo dei rifiuti sono quelli MISURATI sullo Storage di produzione il
// 02/10 (S0-d/S0-g): una seconda PUT prende **400** col corpo `statusCode:"409"`,
// `error:"Duplicate"`, anche con `x-upsert: true`. Mai un 409 vero.
// ⚠️ S0-c (PUT con URL scaduto) non era ancora compilata quando questo file è stato scritto:
// `scaduto` risponde 400 con `statusCode:"403"` e `error:"InvalidJWT"`, che è la forma
// dichiarata nel compito, ma il `message` («jwt expired») è un'ipotesi. Il nativo legge solo
// stato HTTP, `statusCode` ed `error` (spec §4.5): quando S0-c sarà scritta, si ritocca qui.
//
// Come lo Storage vero, un URL si verifica SOLO ALL'AVVIO della PUT (parametro `e` = scadenza
// in secondi dell'epoca, il nostro `exp`): una PUT già iniziata non si interrompe quando
// l'URL scade. L'ordine dei controlli è quello dello Storage: prima la firma (`scaduto`),
// poi l'esistenza dell'oggetto (`Duplicate`), poi il corpo.
//
// I RIFIUTI RISPONDONO SUBITO, senza aspettare il corpo. Poi il server continua a LEGGERE e
// scartare fino a `drenaByte` (1 MiB) e, se il client sta ancora mandando, chiude di colpo la
// connessione. È la forma peggiore per un client — una `HttpURLConnection` di Android in
// scrittura prende «Broken pipe» PRIMA di aver letto la risposta, e il collaudo C1 del 03/10 l'ha
// visto: un 400 letto come «rete caduta», PUT ripetute sullo stesso URL fino al rinnovo proattivo.
// ⚠️ NON è ciò che fa lo Storage vero: misurato la sera del 03/10 sul progetto della CI, il 400
// `Duplicate` di una PUT da 100 MB arriva DOPO l'ultimo byte (104.857.600 inviati, anche con
// `Expect: 100-continue`), come l'`InvalidJWT` di S0. Questa forma resta come prova di robustezza;
// per un client che si comporta come con lo Storage vero si avvia con `--drena-byte -1`: il
// rifiuto parte comunque subito, ma il server legge tutto il corpo senza mai chiudere, così la
// scrittura finisce e la risposta si legge. Con i file di prova piccoli (≤ drenaByte) le due forme
// coincidono.
//
// ─── GLI SCENARI DEL RINNOVO (il token `x-kidville-rinnovo`, assegnato da /apri) ──────
//   da-caricare   200 `{stato:'da-caricare', caricamento:{protocollo:'put', url, metodo,
//                 intestazioni}, scadeIl}` — `scadeIl` è quella del TOKEN, non dell'URL
//   arrivato      200 `{stato:'arrivato'}`
//   annullato     200 `{stato:'annullato'}`
//   404           404 uniforme `VIDEO_NON_TROVATO` (identico a token assente, malformato,
//                 sconosciuto o scaduto)
//   429           ai primi `volte` (1) chiamate 429 con `Retry-After`, poi `da-caricare`
// Se l'oggetto è già arrivato (una PUT completata, o `duplicato`) il rinnovo dice SEMPRE
// `arrivato`, come la RPC vera: il token si revoca all'arrivo. L'URL nuovo di un
// `da-caricare` porta lo scenario `dopoRinnovo` (predefinito `ok`).
//
// ─── POST /apri: il corpo ────────────────────────────────────────────────────────
// Obbligatorio `byte` (intero ≥ 1). Facoltativi: `sha256` (hex 64) · `nome` (il nome del file
// di prova, che i log NON devono mai contenere) · `mime` · `put` · `rinnovo` · `dopoRinnovo`
// · `volte` (-1 = sempre) · `velocitaKBs` · `frazione` · `retryAfterS` · `drenaByte` ·
// `urlScadeSecondi` · `tokenScadeSecondi`. La risposta porta esattamente i pezzi che
// `accodaVideo` vuole (spec §4.2): `jobId`, `intentId`, `utenteId`, `scuolaId`,
// `caricamento {url, contentType, scadeIl}`, `rinnovo {url, token, scadeIl}`,
// `registro {url}`, `testi`. Gli URL sono costruiti sull'host con cui il client ha chiamato
// (`localhost` su iOS, `10.0.2.2` su Android): è lì che il nativo li ritroverà.
//
// L'ESITO DI UN TENTATIVO (`/stato` → `jobs[].tentativi[].esito`):
//   in-corso · completata (200) · rifiutata (400/500, con `statoHttp`) · interrotta (cade-a-meta)
//   · muta (letto tutto, nessuna risposta) · risposta-persa (commesso, risposta mai data)
//   · abbandonata (il client è sparito prima della fine: annullo, app uccisa, rete caduta)
//
// ─── LE VERIFICHE: `/stato` → `verifiche` ────────────────────────────────────────
// Il server non si limita a registrare: giudica, con le regole scritte nella spec, così
// C1 non deve rifarlo a occhio. Si ricalcolano a ogni lettura.
//   violazioni (rosse)  intestazioni vietate sulla PUT (`x-upsert`, `authorization`, `apikey`,
//                       `x-kidville-rinnovo`, `cookie`: spec §2.2) · `content-type` diverso da
//                       quello dichiarato · byte o sha256 ricevuti diversi dai dichiarati ·
//                       token nell'URL del rinnovo · log con URL, `kvr_`, sha256, host, percorso,
//                       nome di file, e-mail, chiavi fuori dall'elenco chiuso (spec §8.1-8.2),
//                       messaggi fuori elenco, identità assente o nell'URL, evento diverso da
//                       `caricamento-nativo`, piattaforma non nativa, eventi che il server
//                       vero scarterebbe (`livello: info`, `stato` non intero, …)
//   avvisi (gialli)     intestazioni sospette (`cache-control`, `pragma`, `expect`: il sistema
//                       può aggiungerle da sé) · `versione_app` assente o fuori forma · più di 4
//                       righe per un video senza intoppi · chiavi dell'evento che il server
//                       vero ignora in silenzio · `stack` presente
//
// ⚠️ COME SI LEGGE «NESSUN BYTE DOPO UN ANNULLO» (S11). I byte contati sono quelli LETTI dal
// server, non quelli spediti dal client: fra i due c'è il buffer del sistema (qualche centinaio
// di KB), e con un invio rallentato il server lo svuota piano. Dopo un annullo il contatore può
// quindi salire ancora per qualche secondo. Si aspetta che il tentativo non sia più `in-corso`
// (diventa `abbandonata` quando il server vede la fine della connessione) e SOLO ALLORA si
// legge `byte` due volte a distanza di un secondo: devono coincidere.
//
// ─── COSA NON FA ─────────────────────────────────────────────────────────────────
// Non scrive i byte su disco (li conta e ne calcola lo sha256 in streaming: nessun dato di
// nessuno resta qui). Non ha limiti di tempo sul corpo (`requestTimeout = 0`: l'invio lento
// di un video grande supera i 5 minuti predefiniti di Node). Non stampa mai i token del
// rinnovo. Non porta sedi, utenti o nomi veri: gli uuid di prova sono DERIVATI da un seme
// (stabili fra un riavvio e l'altro, così la coda del telefono resta leggibile) e non sono
// uuid di nessuna sede. Il repository è pubblico.
// =============================================================================

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const QUI = dirname(fileURLToPath(import.meta.url))

// ─── Il contratto, dichiarato in un posto solo ──────────────────────────────────

/** L'unico indirizzo su cui si ascolta. Vedi la testata: nessuna opzione lo cambia. */
const INDIRIZZO = '127.0.0.1'

/** Versione del contratto di questo server: la pagina e l'autoverifica la leggono da /config. */
const VERSIONE_COLLAUDO = 1

/** `VALIDITA_FIRMA_SECONDI` di `src/app/api/video-uploads/firme.ts`: l'URL firmato vale 2 ore. */
const VALIDITA_URL_PUT_S = 7200

/** Il token di rinnovo vale 48 ore dall'apertura (`token-rinnovo.ts`) e il rinnovo non lo allunga. */
const VALIDITA_TOKEN_S = 48 * 3600

/** `schemaTokenRinnovoVideo` (contratto.ts): `kvr_` + 32 byte casuali in base64url = 43 caratteri. */
const PREFISSO_TOKEN = 'kvr_'
const BYTE_CASUALI_TOKEN = 32
const FORMA_TOKEN = new RegExp(`^${PREFISSO_TOKEN}[A-Za-z0-9_-]{${Math.ceil((BYTE_CASUALI_TOKEN * 4) / 3)}}$`)
const INTESTAZIONE_TOKEN = 'x-kidville-rinnovo'

/** Gli scenari: gli elenchi chiusi che /apri e la pagina condividono. */
const SCENARI_PUT = ['ok', 'lento', 'cade-a-meta', 'scaduto', 'duplicato', 'muto', 'errore-500', 'risposta-persa']
const SCENARI_RINNOVO = ['da-caricare', 'arrivato', 'annullato', '404', '429']
/** Gli scenari che si comportano male solo ai primi `volte` tentativi e poi guariscono. */
const SCENARI_CHE_GUARISCONO = ['cade-a-meta', 'muto', 'errore-500', 'risposta-persa']

/** I testi delle notifiche native, come li passa il JS (spec §7.8, chiavi `notificaCaricamento*`). */
const TESTI_NOTIFICHE = {
  titolo: 'Kidville',
  invio: 'Invio dei video in corso',
  attesaRete: 'Il video è in attesa di rete: riprenderà da solo',
  pausa: 'Invio in pausa: tocca per riprendere',
}

/** I rifiuti dello Storage (S0-d, S0-g) e del rinnovo (`risposte.ts`, `messages/it/shared.json`). */
const CORPO_FIRMA_SCADUTA = { statusCode: '403', error: 'InvalidJWT', message: 'jwt expired' }
const CORPO_DUPLICATO = { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }
const CORPO_ERRORE_500 = { statusCode: '500', error: 'InternalServerError', message: 'errore finto di collaudo' }
const CORPO_NON_TROVATO = {
  error: 'Questo caricamento non esiste più: potrebbe essere stato annullato, oppure essere scaduto. Ricomincia dall’inizio.',
  codice: 'VIDEO_NON_TROVATO',
}
const CORPO_TROPPE_RICHIESTE = { error: 'Troppi caricamenti. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' }

/** `/api/logs` (src/app/api/logs/route.ts): le stesse soglie e gli stessi pattern della route vera. */
const LOG_BYTE_MAX = 64_000
const LOG_BATCH_MAX = 20
const LOG_LIMITE = 30
const LOG_FINESTRA_MS = 60_000
const LOG_EVENTO = /^[a-z][a-z0-9-]{0,29}$/
const LOG_CHIAVE_CAMPO = /^[a-z][a-z0-9_]{0,31}$/
const LOG_DIGEST = /^[\w.:-]{1,64}$/
const LOG_CAMPI_MAX = 12
const LOG_CAMPO_TESTO_MAX = 64
const LOG_CHIAVI_EVENTO = ['livello', 'evento', 'messaggio', 'stack', 'route', 'stato', 'digest', 'campi']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Il nome dell'evento dei log nativi (spec §8.1): salvato dal server vero come `client:caricamento-nativo`. */
const EVENTO_NATIVO = 'caricamento-nativo'

/** I messaggi del nativo: l'elenco chiuso di spec §8.2 (`EVENTI_LOG_NATIVI`). Un altro slug è una violazione. */
const MESSAGGI_NATIVI = [
  'video-nativo-accodato', 'video-nativo-inviato', 'video-nativo-ritento', 'video-nativo-rinnovo',
  'video-nativo-attesa-rete', 'video-nativo-pausa', 'video-nativo-ripreso-dopo-chiusura',
  'video-nativo-annullato', 'video-nativo-fallito', 'media-nativo-preparazione-fallita',
  'caricamenti-nativi-motore', 'coda-nativa-corrotta', 'registro-nativo-scartati',
  'notifica-locale-non-autorizzata', 'put-oltre-scadenza',
]

/** Le chiavi di `campi` dei log nativi: l'unione delle colonne `campi` di spec §8.1 e §8.2, più `versione_app`. */
const CHIAVI_CAMPI_NATIVI = [
  'esito', 'error_code', 'operazione', 'tipo', 'ambiente', 'mime', 'versione_app',
  'byte', 'ms', 'tentativi', 'rinnovi', 'in_background', 'tentativo', 'attesa_s', 'byte_inviati',
  'notifica', 'autorizzata', 'sdk', 'in_coda', 'in_invio', 'task_vivi', 'file_orfani', 'scartati', 'durata_s', 'voci_scartate',
]
const FORMA_VERSIONE_APP = /^\d+\.\d+(?:\.\d+)?\+\d+$/

/** Un video «normale» costa al più 4 righe di log (spec §8.1). */
const RIGHE_LOG_MASSIME_SENZA_INTOPPI = 4

/** Le intestazioni che sulla PUT sono un difetto (spec §2.2: «esattamente quelle del server»), e quelle solo sospette. */
const INTESTAZIONI_PUT_VIETATE = ['x-upsert', 'authorization', 'apikey', 'x-kidville-rinnovo', 'cookie']
const INTESTAZIONI_PUT_SOSPETTE = ['cache-control', 'pragma', 'expect']

// ─── Le opzioni ─────────────────────────────────────────────────────────────────

const AIUTO = `Server finto di collaudo dei caricamenti nativi (solo 127.0.0.1).

  node scripts/collaudo-caricamenti/server.mjs [opzioni]

  --porta N             porta (predefinita 4310; 0 = una libera)
  --file-porta PERCORSO scrive qui la porta scelta, a server pronto
  --vita-massima S      si spegne da solo dopo S secondi (0 = mai)
  --velocita-lento KB/s velocità dello scenario «lento» (predefinita 512)
  --drena-byte N        quanto leggere dopo un rifiuto anticipato prima di spezzare (predefinito
                        1048576; -1 = tutto)
  --muto-secondi S      quanto tace lo scenario «muto» prima di chiudere (predefinito 330)
  --tetto-log N         richieste al minuto accettate da /api/logs (predefinito 30, come la route)
  --tace                non stampa una riga per richiesta
  --aiuto               questo testo
`

/**
 * Le opzioni ammesse: nome → [chiave, minimo, massimo, valore intero?].
 * Ogni valore fuori intervallo chiude con uscita 2: un'opzione scritta male che passa in
 * silenzio è un collaudo fatto con un server diverso da quello che si crede.
 */
const OPZIONI_NUMERICHE = new Map([
  ['--porta', ['porta', 0, 65535, true]],
  ['--vita-massima', ['vitaMassimaS', 0, 7 * 86400, true]],
  ['--velocita-lento', ['velocitaLentoKBs', 1, 10_000_000, false]],
  ['--drena-byte', ['drenaByte', -1, 4_000_000_000, true]],
  ['--muto-secondi', ['mutoS', 1, 3600, false]],
  ['--tetto-log', ['tettoLog', 1, 100_000, true]],
])

function leggiOpzioni(argv) {
  const opz = {
    porta: 4310, filePorta: null, vitaMassimaS: 0, velocitaLentoKBs: 512,
    drenaByte: 1_048_576, mutoS: 330, tettoLog: LOG_LIMITE, tace: false,
  }
  const esci = (messaggio) => {
    process.stderr.write(`${messaggio}\n\n${AIUTO}`)
    process.exit(2)
  }
  for (let i = 0; i < argv.length; i++) {
    const nome = argv[i]
    if (nome === '--aiuto' || nome === '-h') {
      process.stdout.write(AIUTO)
      process.exit(0)
    }
    if (nome === '--tace') {
      opz.tace = true
      continue
    }
    if (nome === '--file-porta') {
      const valore = argv[++i]
      if (valore === undefined || valore === '') esci('--file-porta vuole un percorso')
      opz.filePorta = valore
      continue
    }
    const regola = OPZIONI_NUMERICHE.get(nome)
    if (regola === undefined) esci(`opzione sconosciuta: ${nome}`)
    const [chiave, minimo, massimo, intero] = regola
    const testo = argv[++i]
    const numero = testo === undefined || testo.trim() === '' ? Number.NaN : Number(testo)
    if (!Number.isFinite(numero) || numero < minimo || numero > massimo || (intero && !Number.isInteger(numero))) {
      esci(`${nome} vuole un numero ${intero ? 'intero ' : ''}fra ${minimo} e ${massimo}`)
    }
    opz[chiave] = numero
  }
  return opz
}

const opz = leggiOpzioni(process.argv.slice(2))

// ─── Lo stato: tutto in memoria, tutto azzerabile ───────────────────────────────

/**
 * L'identità di prova: uuid DERIVATI da un seme, non letterali. Stabili fra un riavvio e
 * l'altro (la pagina li usa per filtrare `elenco({utenteId})` e la coda sul telefono deve
 * restare leggibile dopo un riavvio del server), e di nessun utente né sede vera: il lock
 * `migrazioni-senza-sede-cablata` esiste proprio perché un uuid di sede incollato in uno
 * script è una scorciatoia che poi agisce.
 */
function uuidStabile(seme) {
  const h = createHash('sha256').update(`kidville-collaudo-caricamenti:${seme}`).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

const UTENTE_DI_PROVA = uuidStabile('utente')
const SEDE_DI_PROVA = uuidStabile('sede')

const stato = {
  avviatoIl: new Date().toISOString(),
  porta: 0,
  richieste: 0,
  /** jobId → job. L'ordine di inserimento è l'ordine di creazione. */
  jobs: new Map(),
  /** token di rinnovo → jobId. Un token non in tabella è «sconosciuto»: 404, come il vero. */
  token: new Map(),
  /** Le chiamate al rinnovo che non portano a nessun job (token assente, malformato, sconosciuto, scaduto). */
  rinnoviRifiutati: [],
  /** I POST di /api/logs accettati (anche con eventi scartati). */
  logs: [],
  /** I POST di /api/logs respinti prima della lettura degli eventi (429, 413, 400). */
  logRespinti: [],
  /** Gli istanti delle richieste a /api/logs nell'ultima finestra: il tetto per IP della route vera. */
  finestraLog: [],
}

const ora = () => new Date().toISOString()

function traccia(riga) {
  if (!opz.tace) process.stdout.write(`${new Date().toLocaleTimeString('it-IT')} ${riga}\n`)
}

/** Gli errori del server finto escono sempre, anche con --tace: un collaudo con un server rotto non vale. */
function errore(riga, causa) {
  process.stderr.write(`${new Date().toLocaleTimeString('it-IT')} ERRORE ${riga}${causa ? `: ${causa.stack ?? causa}` : ''}\n`)
}

// ─── Piccoli aiuti di risposta e di lettura ─────────────────────────────────────

function json(res, codice, corpo, intestazioni = {}) {
  const testo = JSON.stringify(corpo)
  res.writeHead(codice, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(testo),
    'cache-control': 'no-store',
    ...intestazioni,
  })
  res.end(testo)
}

/** Spezza la connessione di colpo (RST) invece di chiuderla con garbo: è «la rete è caduta». */
function spezza(socket) {
  if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy()
  else socket.destroy()
}

/**
 * L'origine con cui il client ci ha raggiunti. Gli URL che il server restituisce devono
 * puntare lì: `localhost` per il simulatore iOS, `10.0.2.2` per l'emulatore Android.
 */
function origine(req) {
  const host = String(req.headers.host ?? '')
  return /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/.test(host) ? `http://${host}` : `http://${INDIRIZZO}:${stato.porta}`
}

/** Legge il corpo come testo fino a `limite` byte: oltre, continua a contare ma non accumula. */
function leggiTesto(req, res, limite) {
  return new Promise((risolvi, rifiuta) => {
    const pezzi = []
    let totale = 0
    req.on('data', (blocco) => {
      totale += blocco.length
      if (totale <= limite) pezzi.push(blocco)
    })
    req.on('end', () => risolvi({ testo: Buffer.concat(pezzi).toString('utf8'), troppoGrande: totale > limite, byte: totale }))
    req.on('error', rifiuta)
    req.on('close', () => {
      if (!req.complete) rifiuta(new Error('richiesta interrotta dal client'))
    })
    if (req.attendeContinue) res.writeContinue()
  })
}

const eOggetto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ─── I job ──────────────────────────────────────────────────────────────────────

function nuovoJob(parametri) {
  const adesso = Date.now()
  const job = {
    jobId: parametri.jobId ?? randomUUID(),
    intentId: randomUUID(),
    utenteId: parametri.utenteId ?? UTENTE_DI_PROVA,
    scuolaId: parametri.scuolaId ?? SEDE_DI_PROVA,
    implicito: parametri.implicito === true,
    creatoIl: new Date(adesso).toISOString(),
    nome: parametri.nome ?? null,
    mime: parametri.mime ?? null,
    byteAttesi: parametri.byteAttesi ?? null,
    sha256Atteso: parametri.sha256Atteso ?? null,
    put: parametri.put ?? 'ok',
    rinnovo: parametri.rinnovo ?? 'da-caricare',
    dopoRinnovo: parametri.dopoRinnovo ?? 'ok',
    volte: parametri.volte ?? 1,
    velocitaKBs: parametri.velocitaKBs ?? null,
    frazione: parametri.frazione ?? 0.5,
    retryAfterS: parametri.retryAfterS ?? 3,
    drenaByte: parametri.drenaByte ?? null,
    urlScadeMs: adesso + (parametri.urlScadeSecondi ?? VALIDITA_URL_PUT_S) * 1000,
    tokenScadeMs: adesso + (parametri.tokenScadeSecondi ?? VALIDITA_TOKEN_S) * 1000,
    tokenRinnovo: null,
    /** L'oggetto è nello «Storage»: una PUT completata, o `duplicato`. Da qui in poi ogni PUT è un Duplicate. */
    oggettoPresente: false,
    tentativi: [],
    chiamateRinnovo: [],
    rinnovi: 0,
  }
  stato.jobs.set(job.jobId, job)
  return job
}

/** Un job nato dalla sola PUT (un `curl` a mano, senza /apri): vale gli scenari dell'URL e i predefiniti. */
function jobPerPut(jobId) {
  return stato.jobs.get(jobId) ?? nuovoJob({ jobId, implicito: true })
}

const nuovoTokenRinnovo = () => `${PREFISSO_TOKEN}${randomBytes(BYTE_CASUALI_TOKEN).toString('base64url')}`

/** L'URL di una PUT: porta lo scenario (`token`) e la scadenza (`e`, secondi dell'epoca, il nostro `exp`). */
function urlPut(req, job, scenario, scadeMs) {
  return `${origine(req)}/put/${encodeURIComponent(job.jobId)}?token=${scenario}&e=${Math.floor(scadeMs / 1000)}`
}

// ─── La PUT ─────────────────────────────────────────────────────────────────────

/** Quanto leggere dopo un rifiuto prima di spezzare: la scelta del job, o quella del server. */
const drenaDi = (job) => job.drenaByte ?? opz.drenaByte

function nuovoTentativo(job, scenario, req) {
  const dichiarato = req.headers['content-length']
  const tentativo = {
    n: job.tentativi.length + 1,
    scenario,
    esito: 'in-corso',
    statoHttp: null,
    byte: 0,
    sha256: null,
    contentType: req.headers['content-type'] ?? null,
    contentLength: dichiarato === undefined ? null : Number(dichiarato),
    intestazioni: Object.keys(req.headers).sort(),
    iniziataIl: ora(),
    ultimoByteIl: null,
    finitaIl: null,
    durataMs: null,
  }
  job.tentativi.push(tentativo)
  return tentativo
}

function chiudiTentativo(tentativo, esito, statoHttp = null) {
  tentativo.esito = esito
  tentativo.statoHttp = statoHttp
  tentativo.finitaIl = ora()
  tentativo.durataMs = Date.now() - Date.parse(tentativo.iniziataIl)
}

/**
 * Risponde SUBITO con un rifiuto, senza aspettare il corpo (vedi la testata), poi continua a
 * leggere e a contare i byte che il client sta ancora mandando, fino a `drenaByte`: oltre, il
 * client sta mandando un video a un server che l'ha già rifiutato, e la connessione si spezza.
 */
function rifiutaSubito(req, res, job, tentativo, codice, corpo) {
  chiudiTentativo(tentativo, 'rifiutata', codice)
  json(res, codice, corpo)
  if (req.complete) return
  const limite = drenaDi(job)
  req.on('data', (blocco) => {
    tentativo.byte += blocco.length
    tentativo.ultimoByteIl = ora()
    if (limite >= 0 && tentativo.byte > limite) spezza(req.socket)
  })
  req.on('error', () => traccia('il client ha chiuso mentre il rifiuto era già partito (esito normale di un rifiuto anticipato)'))
}

/**
 * Riceve il corpo contando i byte e calcolandone lo sha256 in streaming (non si scrive niente
 * su disco). `velocitaKBs > 0` rallenta la lettura: il TCP fa il resto e il client vede
 * un'uscita lenta. `fermaAByte` interrompe la lettura a quella soglia. Risolve con `fine`,
 * `soglia` o `abbandonata` (il client ha chiuso prima della fine).
 */
function riceviCorpo(req, tentativo, { velocitaKBs, fermaAByte }) {
  return new Promise((risolvi) => {
    const impronta = createHash('sha256')
    const inizio = Date.now()
    let chiuso = false
    const concludi = (esito) => {
      if (chiuso) return
      chiuso = true
      risolvi(esito)
    }
    req.on('data', (blocco) => {
      if (chiuso) return
      impronta.update(blocco)
      tentativo.byte += blocco.length
      tentativo.ultimoByteIl = ora()
      if (tentativo.byte >= fermaAByte) {
        concludi('soglia')
        return
      }
      if (velocitaKBs > 0) {
        // Un conto cumulativo e non un'attesa fissa per blocco: tiene la velocità media vera
        // anche quando i blocchi arrivano a grappoli.
        const attesaMs = (tentativo.byte / (velocitaKBs * 1024)) * 1000 - (Date.now() - inizio)
        if (attesaMs > 5) {
          req.pause()
          setTimeout(() => req.resume(), attesaMs)
        }
      }
    })
    req.on('end', () => {
      tentativo.sha256 = impronta.digest('hex')
      // Dopo l'ultimo blocco l'`end` arriva comunque, anche se lo si è messo in pausa: senza questa
      // attesa un invio «lento» finirebbe in anticipo di quanto dura l'ultimo blocco.
      const restoMs = velocitaKBs > 0 ? (tentativo.byte / (velocitaKBs * 1024)) * 1000 - (Date.now() - inizio) : 0
      if (restoMs > 5) setTimeout(() => concludi('fine'), restoMs)
      else concludi('fine')
    })
    req.on('error', () => concludi('abbandonata'))
    req.on('close', () => {
      if (!req.complete) concludi('abbandonata')
    })
  })
}

async function gestisciPut(req, res, url) {
  const m = /^\/put\/([A-Za-z0-9._-]{1,64})$/.exec(url.pathname)
  if (m === null) return json(res, 404, { error: 'percorso sconosciuto' })
  const job = jobPerPut(m[1])
  const scenario = url.searchParams.get('token') ?? 'ok'
  const scadeS = Number(url.searchParams.get('e') ?? 0)
  const tentativo = nuovoTentativo(job, scenario, req)

  if (!SCENARI_PUT.includes(scenario)) {
    return rifiutaSubito(req, res, job, tentativo, 400, { error: 'scenario sconosciuto', ammessi: SCENARI_PUT })
  }
  // 1 · La firma, come lo Storage: prima di tutto, e SOLO all'avvio della PUT.
  if (scenario === 'scaduto' || (Number.isFinite(scadeS) && scadeS > 0 && Date.now() >= scadeS * 1000)) {
    return rifiutaSubito(req, res, job, tentativo, 400, CORPO_FIRMA_SCADUTA)
  }
  // 2 · L'oggetto. `duplicato` è «c'era già»: da qui l'oggetto è presente.
  if (scenario === 'duplicato') job.oggettoPresente = true
  if (job.oggettoPresente) return rifiutaSubito(req, res, job, tentativo, 400, CORPO_DUPLICATO)

  // 3 · Gli scenari che si comportano male solo le prime `volte` volte.
  const precedenti = job.tentativi.filter((t) => t !== tentativo && t.scenario === scenario).length
  const guasto = SCENARI_CHE_GUARISCONO.includes(scenario) && (job.volte < 0 || precedenti < job.volte)
  if (scenario === 'errore-500' && guasto) {
    return rifiutaSubito(req, res, job, tentativo, 500, CORPO_ERRORE_500)
  }

  // 4 · Il corpo.
  if (req.attendeContinue) res.writeContinue()
  const lento = scenario === 'lento' || (scenario === 'cade-a-meta' && guasto)
  const velocitaKBs = job.velocitaKBs ?? (lento ? opz.velocitaLentoKBs : 0)
  const totale = tentativo.contentLength ?? job.byteAttesi ?? 1_048_576
  const fermaAByte = scenario === 'cade-a-meta' && guasto ? Math.max(1, Math.floor(totale * job.frazione)) : Number.POSITIVE_INFINITY
  const esito = await riceviCorpo(req, tentativo, { velocitaKBs, fermaAByte })

  if (esito === 'abbandonata') {
    chiudiTentativo(tentativo, 'abbandonata')
    return
  }
  if (esito === 'soglia') {
    chiudiTentativo(tentativo, 'interrotta')
    spezza(req.socket)
    return
  }
  // `fine`: il corpo è arrivato tutto.
  if (scenario === 'muto' && guasto) {
    // Letto tutto, mai commesso, mai una risposta: «nessuna risposta (rete, timeout)».
    chiudiTentativo(tentativo, 'muta')
    const sveglia = setTimeout(() => spezza(req.socket), opz.mutoS * 1000)
    req.socket.once('close', () => clearTimeout(sveglia))
    return
  }
  job.oggettoPresente = true
  if (scenario === 'risposta-persa' && guasto) {
    // Commesso, ma il client non lo saprà mai da questa connessione.
    chiudiTentativo(tentativo, 'risposta-persa')
    spezza(req.socket)
    return
  }
  chiudiTentativo(tentativo, 'completata', 200)
  json(res, 200, { Key: `video_originals/collaudo/${job.jobId}` })
}

// ─── Il rinnovo ─────────────────────────────────────────────────────────────────

function rifiutoRinnovo(motivo, conQuery) {
  stato.rinnoviRifiutati.push({ a: ora(), motivo, conQuery })
}

async function gestisciRinnovo(req, res, url) {
  const conQuery = url.search !== ''
  const grezzo = req.headers[INTESTAZIONE_TOKEN]
  const token = Array.isArray(grezzo) ? grezzo[0] : grezzo
  if (token === undefined || token === '') {
    rifiutoRinnovo('assente', conQuery)
    return json(res, 404, CORPO_NON_TROVATO)
  }
  if (!FORMA_TOKEN.test(token)) {
    rifiutoRinnovo('malformato', conQuery)
    return json(res, 404, CORPO_NON_TROVATO)
  }
  const job = stato.jobs.get(stato.token.get(token) ?? '')
  if (job === undefined) {
    rifiutoRinnovo('sconosciuto', conQuery)
    return json(res, 404, CORPO_NON_TROVATO)
  }
  const chiamata = { n: job.chiamateRinnovo.length + 1, a: ora(), esito: null, statoHttp: null, conQuery }
  job.chiamateRinnovo.push(chiamata)
  const chiudi = (esito, codice, corpo, intestazioni) => {
    chiamata.esito = esito
    chiamata.statoHttp = codice
    json(res, codice, corpo, intestazioni)
  }
  // Il token scaduto è un 404 uniforme, come tutti gli altri rifiuti.
  if (Date.now() >= job.tokenScadeMs) return chiudi('token-scaduto', 404, CORPO_NON_TROVATO)

  // L'ordine è quello della route vera: il tetto prima di tutto, poi il token, poi lo stato.
  if (job.rinnovo === '429') {
    const precedenti = job.chiamateRinnovo.filter((c) => c !== chiamata && c.esito === '429').length
    if (job.volte < 0 || precedenti < job.volte) {
      return chiudi('429', 429, CORPO_TROPPE_RICHIESTE, { 'retry-after': String(job.retryAfterS) })
    }
  }
  if (job.rinnovo === '404') return chiudi('404', 404, CORPO_NON_TROVATO)
  if (job.rinnovo === 'annullato') return chiudi('annullato', 200, { stato: 'annullato' })
  if (job.rinnovo === 'arrivato' || job.oggettoPresente) return chiudi('arrivato', 200, { stato: 'arrivato' })

  job.rinnovi += 1
  const scadenzaUrl = Date.now() + VALIDITA_URL_PUT_S * 1000
  return chiudi('da-caricare', 200, {
    stato: 'da-caricare',
    caricamento: {
      protocollo: 'put',
      url: urlPut(req, job, job.dopoRinnovo, scadenzaUrl),
      metodo: 'PUT',
      intestazioni: { 'content-type': job.mime ?? 'video/mp4' },
    },
    // La scadenza del TOKEN, immutata dal rinnovo (rinnovo/route.ts): non quella dell'URL.
    scadeIl: new Date(job.tokenScadeMs).toISOString(),
  }, { 'cache-control': 'no-store' })
}

// ─── L'apertura di un job di prova (fa la parte di POST /api/video-uploads) ─────

/** Le opzioni numeriche di /apri: nome → [minimo, massimo, intero?]. */
const PARAMETRI_APERTURA = {
  volte: [-1, 1000, true],
  velocitaKBs: [0, 10_000_000, false],
  frazione: [0.05, 0.95, false],
  retryAfterS: [1, 3600, true],
  drenaByte: [-1, 4_000_000_000, true],
  urlScadeSecondi: [-86_400, 7 * 86_400, true],
  tokenScadeSecondi: [-86_400, 7 * 86_400, true],
}

function leggiApertura(corpo) {
  if (!eOggetto(corpo)) return { errori: ['il corpo deve essere un oggetto JSON'] }
  const errori = []
  const p = {}
  const scelta = (chiave, ammessi, predefinito) => {
    const v = corpo[chiave] ?? predefinito
    if (!ammessi.includes(v)) errori.push(`${chiave}: ammessi ${ammessi.join(', ')}`)
    return v
  }
  p.put = scelta('put', SCENARI_PUT, 'ok')
  p.dopoRinnovo = scelta('dopoRinnovo', SCENARI_PUT, 'ok')
  p.rinnovo = scelta('rinnovo', SCENARI_RINNOVO, p.put === 'duplicato' ? 'arrivato' : 'da-caricare')
  if (!Number.isSafeInteger(corpo.byte) || corpo.byte < 1) errori.push('byte: serve un intero >= 1')
  else p.byteAttesi = corpo.byte
  if (corpo.sha256 !== undefined) {
    if (typeof corpo.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(corpo.sha256)) errori.push('sha256: 64 cifre esadecimali minuscole')
    else p.sha256Atteso = corpo.sha256
  }
  if (corpo.nome !== undefined) {
    if (typeof corpo.nome !== 'string' || corpo.nome.length < 1 || corpo.nome.length > 120) errori.push('nome: da 1 a 120 caratteri')
    else p.nome = corpo.nome
  }
  if (corpo.mime !== undefined) {
    if (typeof corpo.mime !== 'string' || !/^[a-z]+\/[a-z0-9.+-]{1,60}$/.test(corpo.mime)) errori.push('mime: forma tipo/sottotipo')
    else p.mime = corpo.mime
  }
  for (const [chiave, [minimo, massimo, intero]] of Object.entries(PARAMETRI_APERTURA)) {
    const v = corpo[chiave]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < minimo || v > massimo || (intero && !Number.isInteger(v))) {
      errori.push(`${chiave}: numero ${intero ? 'intero ' : ''}fra ${minimo} e ${massimo}`)
    } else p[chiave] = v
  }
  if (p.mime === undefined) p.mime = 'video/mp4'
  return errori.length > 0 ? { errori } : { parametri: p }
}

async function gestisciApri(req, res) {
  const { testo, troppoGrande } = await leggiTesto(req, res, 16_384)
  if (troppoGrande) return json(res, 413, { error: 'Payload troppo grande' })
  let corpo
  try {
    corpo = JSON.parse(testo)
  } catch (causa) {
    return json(res, 400, { error: 'Body JSON malformato', dettaglio: String(causa?.message ?? causa).slice(0, 120) })
  }
  const letto = leggiApertura(corpo)
  if (letto.errori) return json(res, 400, { error: 'Dati non validi', details: letto.errori })

  const job = nuovoJob(letto.parametri)
  job.tokenRinnovo = nuovoTokenRinnovo()
  stato.token.set(job.tokenRinnovo, job.jobId)
  traccia(`apri job=${job.jobId.slice(0, 8)} put=${job.put} rinnovo=${job.rinnovo} byte=${job.byteAttesi}`)
  return json(res, 200, {
    jobId: job.jobId,
    intentId: job.intentId,
    utenteId: job.utenteId,
    scuolaId: job.scuolaId,
    caricamento: {
      url: urlPut(req, job, job.put, job.urlScadeMs),
      contentType: job.mime,
      scadeIl: new Date(job.urlScadeMs).toISOString(),
    },
    rinnovo: {
      url: `${origine(req)}/api/video-uploads/rinnovo`,
      token: job.tokenRinnovo,
      scadeIl: new Date(job.tokenScadeMs).toISOString(),
    },
    registro: { url: `${origine(req)}/api/logs` },
    testi: TESTI_NOTIFICHE,
    scenario: {
      put: job.put, rinnovo: job.rinnovo, dopoRinnovo: job.dopoRinnovo, volte: job.volte,
      velocitaKBs: job.velocitaKBs, frazione: job.frazione, retryAfterS: job.retryAfterS, drenaByte: job.drenaByte,
    },
  })
}

// ─── I log ──────────────────────────────────────────────────────────────────────

/** Un evento del lotto, riletto come lo rilegge `eventoSchema` della route vera: o l'evento, o il motivo per cui il server vero lo scarterebbe. */
function leggiEvento(grezzo) {
  if (!eOggetto(grezzo)) return { motivo: 'non-oggetto' }
  const { livello, evento, messaggio, stack, route, stato: statoHttp, digest, campi } = grezzo
  if (livello !== 'warn' && livello !== 'error') return { motivo: 'livello' }
  if (typeof evento !== 'string' || !LOG_EVENTO.test(evento)) return { motivo: 'evento' }
  if (typeof messaggio !== 'string' || messaggio.length < 1 || messaggio.length > 1000) return { motivo: 'messaggio' }
  if (stack !== undefined && (typeof stack !== 'string' || stack.length > 8000)) return { motivo: 'stack' }
  if (route !== undefined && (typeof route !== 'string' || route.length > 300)) return { motivo: 'route' }
  if (statoHttp !== undefined && !(Number.isInteger(statoHttp) && statoHttp >= 0 && statoHttp <= 599)) return { motivo: 'stato' }
  if (digest !== undefined && (typeof digest !== 'string' || !LOG_DIGEST.test(digest))) return { motivo: 'digest' }
  return {
    evento: {
      livello, evento, messaggio, stack, route, stato: statoHttp, digest,
      campi: eOggetto(campi) ? campi : undefined,
      campiNonOggetto: campi !== undefined && !eOggetto(campi),
      chiaviIgnorate: Object.keys(grezzo).filter((k) => !LOG_CHIAVI_EVENTO.includes(k)),
    },
  }
}

/** `campiAmmessi` della route vera: ciò che il server terrebbe e il numero dei campi che butterebbe. */
function campiTenuti(grezzi) {
  const tenuti = {}
  let scartati = 0
  let n = 0
  for (const chiave of Object.keys(grezzi ?? {})) {
    if (n >= LOG_CAMPI_MAX || !LOG_CHIAVE_CAMPO.test(chiave)) {
      scartati += 1
      continue
    }
    const v = grezzi[chiave]
    const ok = (typeof v === 'string' && v.length <= LOG_CAMPO_TESTO_MAX) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean'
    if (!ok) {
      scartati += 1
      continue
    }
    tenuti[chiave] = v
    n += 1
  }
  return { tenuti, scartati }
}

async function gestisciLog(req, res, url) {
  // 1 · Il tetto per IP, PRIMA di leggere il corpo: l'IP qui è uno solo, il Mac.
  const adesso = Date.now()
  stato.finestraLog = stato.finestraLog.filter((istante) => adesso - istante < LOG_FINESTRA_MS)
  if (stato.finestraLog.length >= opz.tettoLog) {
    const attesaS = Math.max(1, Math.ceil((stato.finestraLog[0] + LOG_FINESTRA_MS - adesso) / 1000))
    stato.logRespinti.push({ a: ora(), stato: 429 })
    return json(res, 429, { error: 'Troppe richieste' }, { 'retry-after': String(attesaS) })
  }
  stato.finestraLog.push(adesso)

  // 2 · Il peso, dichiarato e poi vero.
  const dichiarati = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(dichiarati) && dichiarati > LOG_BYTE_MAX) {
    stato.logRespinti.push({ a: ora(), stato: 413 })
    return json(res, 413, { error: 'Payload troppo grande' })
  }
  const { testo, troppoGrande } = await leggiTesto(req, res, LOG_BYTE_MAX)
  if (troppoGrande) {
    stato.logRespinti.push({ a: ora(), stato: 413 })
    return json(res, 413, { error: 'Payload troppo grande' })
  }
  let corpo
  try {
    corpo = JSON.parse(testo)
  } catch {
    stato.logRespinti.push({ a: ora(), stato: 400 })
    return json(res, 400, { error: 'Body JSON malformato' })
  }

  // 3 · L'involucro: `eventi` (1..20) e `piattaforma` (web | ios | android, predefinita web).
  const dettagli = []
  if (!eOggetto(corpo) || !Array.isArray(corpo.eventi)) dettagli.push({ path: 'eventi', message: 'Invalid input: expected array' })
  else if (corpo.eventi.length < 1) dettagli.push({ path: 'eventi', message: 'Too small: expected array to have >=1 items' })
  else if (corpo.eventi.length > LOG_BATCH_MAX) dettagli.push({ path: 'eventi', message: `Too big: expected array to have <=${LOG_BATCH_MAX} items` })
  const piattaforma = eOggetto(corpo) ? (corpo.piattaforma ?? 'web') : 'web'
  if (!['web', 'ios', 'android'].includes(piattaforma)) dettagli.push({ path: 'piattaforma', message: 'Invalid option: expected one of "web"|"ios"|"android"' })
  if (dettagli.length > 0) {
    stato.logRespinti.push({ a: ora(), stato: 400 })
    return json(res, 400, { error: 'Dati non validi', details: dettagli })
  }

  // 4 · Evento per evento: uno rotto non affonda gli altri (come la route vera).
  const eventi = []
  const scartatiDettaglio = []
  let campiScartati = 0
  for (const grezzo of corpo.eventi) {
    const letto = leggiEvento(grezzo)
    if (letto.evento === undefined) {
      scartatiDettaglio.push(letto.motivo)
      continue
    }
    const { tenuti, scartati } = campiTenuti(letto.evento.campi)
    campiScartati += scartati
    eventi.push({ ...letto.evento, campi: letto.evento.campi === undefined ? undefined : tenuti, campiScartati: scartati })
  }
  const identita = req.headers['x-user-id']
  stato.logs.push({
    ricevutoIl: ora(),
    piattaforma,
    utenteId: typeof identita === 'string' ? identita : null,
    identitaNellUrl: url.searchParams.has('userId'),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 120),
    eventi,
    scartatiDettaglio,
    campiScartati,
  })
  return json(res, 200, { ok: true, ricevuti: eventi.length, scartati: scartatiDettaglio.length })
}

// ─── Le verifiche: il giudizio, ricalcolato a ogni lettura ──────────────────────

const REGOLE_TESTO = [
  ['LOG_URL', /:\/\//],
  ['LOG_TOKEN_RINNOVO', /kvr_/i],
  ['LOG_SHA256', /\b[0-9a-f]{64}\b/i],
  ['LOG_HOST', /(?:supabase\.co|localhost|127\.0\.0\.1|10\.0\.2\.2)/i],
  ['LOG_PERCORSO', /(?:^|[\s=:(,'"])\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\|KidvilleCaricamenti|noBackupFiles|Application Support/],
  ['LOG_NOME_FILE', /\.(?:mp4|mov|m4v|3gp|jpe?g|png|heic|webp|bin)\b/i],
  ['LOG_EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
]

/** Controlla un testo (messaggio, stack, route, valore di un campo) e restituisce i codici violati. */
function codiciDelTesto(testo, nomiDiProva) {
  const codici = REGOLE_TESTO.filter(([, regola]) => regola.test(testo)).map(([codice]) => codice)
  const basso = testo.toLowerCase()
  if (nomiDiProva.some((nome) => basso.includes(nome))) codici.push('LOG_NOME_FILE')
  return [...new Set(codici)]
}

function calcolaVerifiche() {
  const violazioni = new Map()
  const avvisi = new Map()
  const segna = (mappa, codice, dove, dettaglio) => {
    const chiave = `${codice}|${dove}|${dettaglio}`
    const esistente = mappa.get(chiave)
    if (esistente) esistente.conteggio += 1
    else mappa.set(chiave, { codice, dove, dettaglio, conteggio: 1 })
  }
  const nomiDiProva = [...stato.jobs.values()].map((j) => j.nome).filter((n) => typeof n === 'string' && n.length >= 3).map((n) => n.toLowerCase())

  for (const job of stato.jobs.values()) {
    const sigla = `job ${job.jobId.slice(0, 8)}`
    for (const t of job.tentativi) {
      const dove = `${sigla} PUT n.${t.n}`
      for (const nome of t.intestazioni) {
        if (INTESTAZIONI_PUT_VIETATE.includes(nome)) segna(violazioni, 'PUT_INTESTAZIONE_VIETATA', dove, nome)
        if (INTESTAZIONI_PUT_SOSPETTE.includes(nome)) segna(avvisi, 'PUT_INTESTAZIONE_SOSPETTA', dove, nome)
      }
      if (job.mime !== null && !job.implicito) {
        if (t.contentType === null) segna(violazioni, 'PUT_CONTENT_TYPE_ASSENTE', dove, `atteso ${job.mime}`)
        else if (t.contentType !== job.mime) segna(violazioni, 'PUT_CONTENT_TYPE_DIVERSO', dove, `atteso ${job.mime}, visto ${t.contentType}`)
      }
      if (t.esito === 'completata' || t.esito === 'risposta-persa') {
        if (job.sha256Atteso !== null && t.sha256 !== job.sha256Atteso) segna(violazioni, 'PUT_SHA256_DIVERSO', dove, 'lo sha256 ricevuto non è quello dichiarato')
        if (job.byteAttesi !== null && t.byte !== job.byteAttesi) segna(violazioni, 'PUT_BYTE_DIVERSI', dove, `attesi ${job.byteAttesi}, ricevuti ${t.byte}`)
      }
    }
    for (const c of job.chiamateRinnovo) {
      if (c.conQuery) segna(violazioni, 'RINNOVO_URL_CON_QUERY', `${sigla} rinnovo n.${c.n}`, 'il rinnovo non ha parametri nell’URL: il token sta solo nell’intestazione')
    }
    const righe = righeLogDelJob(job)
    const senzaIntoppi = job.tentativi.length === 1 && job.tentativi[0].esito === 'completata' && job.rinnovi === 0 && job.chiamateRinnovo.length === 0
    if (senzaIntoppi && righe > RIGHE_LOG_MASSIME_SENZA_INTOPPI) {
      segna(avvisi, 'LOG_TROPPE_RIGHE', sigla, `${righe} righe per un video senza intoppi (al più ${RIGHE_LOG_MASSIME_SENZA_INTOPPI})`)
    }
  }
  for (const r of stato.rinnoviRifiutati) {
    if (r.conQuery) segna(violazioni, 'RINNOVO_URL_CON_QUERY', `rinnovo ${r.motivo}`, 'il rinnovo non ha parametri nell’URL: il token sta solo nell’intestazione')
  }

  stato.logs.forEach((lotto, i) => {
    const dove = `log POST n.${i + 1}`
    if (lotto.utenteId === null || !UUID.test(lotto.utenteId)) segna(violazioni, 'LOG_IDENTITA_ASSENTE', dove, 'manca `x-user-id` (un uuid)')
    if (lotto.identitaNellUrl) segna(violazioni, 'LOG_IDENTITA_NELL_URL', dove, 'l’identità va nell’intestazione `x-user-id`, mai in `?userId=`')
    if (lotto.piattaforma !== 'ios' && lotto.piattaforma !== 'android') segna(violazioni, 'LOG_PIATTAFORMA', dove, `piattaforma ${lotto.piattaforma}: il nativo dichiara ios o android`)
    if (lotto.scartatiDettaglio.length > 0) segna(violazioni, 'LOG_SCARTATO_DAL_SERVER', dove, `il server vero scarterebbe ${lotto.scartatiDettaglio.length} eventi (${[...new Set(lotto.scartatiDettaglio)].join(', ')})`)
    if (lotto.campiScartati > 0) segna(violazioni, 'LOG_CAMPI_SCARTATI', dove, `il server vero butterebbe ${lotto.campiScartati} campi (chiave o valore fuori forma, o più di ${LOG_CAMPI_MAX})`)
    lotto.eventi.forEach((e, k) => {
      const riga = `${dove} evento ${k + 1}`
      if (e.evento !== EVENTO_NATIVO) segna(violazioni, 'LOG_EVENTO_DIVERSO', riga, `evento ${e.evento}: il nativo usa ${EVENTO_NATIVO}`)
      const slug = /^[^\s:]+/.exec(e.messaggio)?.[0] ?? ''
      if (!MESSAGGI_NATIVI.includes(slug)) segna(violazioni, 'LOG_MESSAGGIO_FUORI_ELENCO', riga, `messaggio «${slug.slice(0, 60)}» non è nell’elenco chiuso di spec §8.2`)
      for (const [nome, testo] of [['messaggio', e.messaggio], ['stack', e.stack], ['route', e.route]]) {
        if (typeof testo !== 'string') continue
        for (const codice of codiciDelTesto(testo, nomiDiProva)) segna(violazioni, codice, riga, `nel campo ${nome}`)
      }
      if (e.stack !== undefined) segna(avvisi, 'LOG_STACK_PRESENTE', riga, 'il nativo non manda stack (spec §8.1)')
      if (e.campiNonOggetto) segna(avvisi, 'LOG_CAMPI_NON_OGGETTO', riga, '`campi` non è un oggetto: il server vero lo perde')
      for (const chiave of e.chiaviIgnorate) segna(avvisi, 'LOG_CHIAVE_EVENTO_IGNORATA', riga, `la chiave ${chiave} non è nello schema: il server vero la ignora`)
      const campi = e.campi ?? {}
      for (const [chiave, valore] of Object.entries(campi)) {
        if (!CHIAVI_CAMPI_NATIVI.includes(chiave)) segna(violazioni, 'LOG_CHIAVE_NON_AMMESSA', riga, `campi.${chiave} non è nell’elenco chiuso di spec §8.1-8.2`)
        if (typeof valore === 'string') for (const codice of codiciDelTesto(valore, nomiDiProva)) segna(violazioni, codice, riga, `in campi.${chiave}`)
      }
      if (typeof campi.versione_app !== 'string' || !FORMA_VERSIONE_APP.test(campi.versione_app)) {
        segna(avvisi, 'LOG_VERSIONE_APP', riga, '`versione_app` manca o non ha la forma 1.2+6')
      }
    })
  })
  const elenco = (mappa) => [...mappa.values()]
  return { ok: violazioni.size === 0, violazioni: elenco(violazioni), avvisi: elenco(avvisi) }
}

/** Le righe di log che nominano il job (`job=<uuid>` nel messaggio, spec §8.1). */
function righeLogDelJob(job) {
  const ago = `job=${job.jobId}`
  return stato.logs.reduce((somma, lotto) => somma + lotto.eventi.filter((e) => e.messaggio.includes(ago)).length, 0)
}

// ─── Lo stato che si legge ──────────────────────────────────────────────────────

function vistaJob(job) {
  const arrivati = job.tentativi.filter((t) => t.esito === 'completata' || t.esito === 'risposta-persa')
  const ultimo = arrivati[arrivati.length - 1]
  const inCorso = job.tentativi.some((t) => t.esito === 'in-corso')
  return {
    jobId: job.jobId,
    intentId: job.intentId,
    utenteId: job.utenteId,
    scuolaId: job.scuolaId,
    implicito: job.implicito,
    creatoIl: job.creatoIl,
    nome: job.nome,
    mime: job.mime,
    byteAttesi: job.byteAttesi,
    sha256Atteso: job.sha256Atteso,
    scenario: {
      put: job.put, rinnovo: job.rinnovo, dopoRinnovo: job.dopoRinnovo, volte: job.volte,
      velocitaKBs: job.velocitaKBs, frazione: job.frazione, retryAfterS: job.retryAfterS, drenaByte: job.drenaByte,
    },
    urlScadeIl: new Date(job.urlScadeMs).toISOString(),
    tokenScadeIl: new Date(job.tokenScadeMs).toISOString(),
    fase: job.oggettoPresente ? 'arrivato' : inCorso ? 'in-corso' : 'da-caricare',
    arrivato: job.oggettoPresente,
    byteRicevuti: ultimo ? ultimo.byte : null,
    sha256Ricevuto: ultimo ? ultimo.sha256 : null,
    sha256Coincide: ultimo && job.sha256Atteso !== null ? ultimo.sha256 === job.sha256Atteso : null,
    byteCoincidono: ultimo && job.byteAttesi !== null ? ultimo.byte === job.byteAttesi : null,
    tentativi: job.tentativi,
    chiamateRinnovo: job.chiamateRinnovo,
    rinnovi: job.rinnovi,
    righeLog: righeLogDelJob(job),
  }
}

function vistaStato(server) {
  return {
    server: {
      versione: VERSIONE_COLLAUDO,
      avviatoIl: stato.avviatoIl,
      pid: process.pid,
      ascolto: `${INDIRIZZO}:${stato.porta}`,
      requestTimeoutMs: server.requestTimeout,
      opzioni: { velocitaLentoKBs: opz.velocitaLentoKBs, drenaByte: opz.drenaByte, mutoS: opz.mutoS, tettoLog: opz.tettoLog },
    },
    contatori: {
      richieste: stato.richieste,
      job: stato.jobs.size,
      put: [...stato.jobs.values()].reduce((s, j) => s + j.tentativi.length, 0),
      rinnovi: [...stato.jobs.values()].reduce((s, j) => s + j.chiamateRinnovo.length, 0) + stato.rinnoviRifiutati.length,
      rinnoviRifiutati: stato.rinnoviRifiutati.length,
      logPost: stato.logs.length,
      logEventi: stato.logs.reduce((s, l) => s + l.eventi.length, 0),
      logRespinti: stato.logRespinti.length,
    },
    jobs: [...stato.jobs.values()].map(vistaJob),
    logs: stato.logs,
    logRespinti: stato.logRespinti,
    rinnoviRifiutati: stato.rinnoviRifiutati,
    verifiche: calcolaVerifiche(),
  }
}

// ─── Il router ──────────────────────────────────────────────────────────────────

function servi(res, nomeFile, tipo) {
  const corpo = readFileSync(join(QUI, nomeFile))
  res.writeHead(200, { 'content-type': tipo, 'content-length': corpo.length, 'cache-control': 'no-store' })
  res.end(corpo)
}

async function gestisci(req, res, server) {
  stato.richieste += 1
  const metodo = req.method ?? 'GET'
  let url
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return json(res, 400, { error: 'indirizzo non valido' })
  }
  const percorso = url.pathname
  res.on('close', () => traccia(`${metodo} ${percorso} → ${res.headersSent ? res.statusCode : 'nessuna risposta'}`))
  try {
    if (metodo === 'GET' && (percorso === '/' || percorso === '/index.html' || percorso === '/pagina.html')) {
      return servi(res, 'pagina.html', 'text/html; charset=utf-8')
    }
    if (metodo === 'GET' && percorso === '/salute') return json(res, 200, { ok: true })
    if (metodo === 'GET' && percorso === '/config') {
      return json(res, 200, {
        versione: VERSIONE_COLLAUDO,
        utenteId: UTENTE_DI_PROVA,
        scuolaId: SEDE_DI_PROVA,
        testi: TESTI_NOTIFICHE,
        scenariPut: SCENARI_PUT,
        scenariRinnovo: SCENARI_RINNOVO,
        // Le costanti che questo server copia dal contratto vero: `autoverifica.sh` le confronta coi sorgenti
        // (route dei log, firme, token di rinnovo, EVENTI_LOG_NATIVI) e diventa rossa se uno dei due cambia.
        contratto: {
          validitaUrlPutS: VALIDITA_URL_PUT_S,
          validitaTokenS: VALIDITA_TOKEN_S,
          prefissoToken: PREFISSO_TOKEN,
          byteCasualiToken: BYTE_CASUALI_TOKEN,
          intestazioneToken: INTESTAZIONE_TOKEN,
          logByteMax: LOG_BYTE_MAX,
          logBatchMax: LOG_BATCH_MAX,
          logLimite: LOG_LIMITE,
          logFinestraMs: LOG_FINESTRA_MS,
          logEvento: LOG_EVENTO.source,
          logChiaveCampo: LOG_CHIAVE_CAMPO.source,
          logCampiMax: LOG_CAMPI_MAX,
          logCampoTestoMax: LOG_CAMPO_TESTO_MAX,
          messaggiNativi: MESSAGGI_NATIVI,
        },
      })
    }
    if (metodo === 'POST' && percorso === '/apri') return await gestisciApri(req, res)
    if (percorso.startsWith('/put/')) {
      if (metodo !== 'PUT') return json(res, 405, { error: 'qui si accetta solo PUT' }, { allow: 'PUT' })
      return await gestisciPut(req, res, url)
    }
    if (percorso === '/api/video-uploads/rinnovo') {
      if (metodo !== 'POST') return json(res, 405, { error: 'qui si accetta solo POST' }, { allow: 'POST' })
      return await gestisciRinnovo(req, res, url)
    }
    if (percorso === '/api/logs') {
      if (metodo !== 'POST') return json(res, 405, { error: 'qui si accetta solo POST' }, { allow: 'POST' })
      return await gestisciLog(req, res, url)
    }
    if (metodo === 'GET' && percorso === '/stato') return json(res, 200, vistaStato(server))
    if (metodo === 'GET' && percorso.startsWith('/stato/')) {
      let jobId = ''
      try {
        jobId = decodeURIComponent(percorso.slice('/stato/'.length))
      } catch {
        // Un indirizzo che non si decodifica non nomina nessun job: è un 404 come un altro.
      }
      const job = stato.jobs.get(jobId)
      return job === undefined ? json(res, 404, { error: 'job sconosciuto' }) : json(res, 200, vistaJob(job))
    }
    if (metodo === 'POST' && percorso === '/azzera') {
      stato.jobs.clear()
      stato.token.clear()
      stato.rinnoviRifiutati.length = 0
      stato.logs.length = 0
      stato.logRespinti.length = 0
      stato.finestraLog.length = 0
      traccia('azzerato')
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'percorso sconosciuto' })
  } catch (causa) {
    errore(`${metodo} ${percorso}`, causa)
    if (!res.headersSent) json(res, 500, { error: 'errore del server finto' })
    else res.destroy()
  }
}

// ─── L'avvio ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  void gestisci(req, res, server)
})
// Nessun tetto sul corpo: l'invio lento di un video grande dura molto più dei 5 minuti
// predefiniti di Node, e un server che interrompe la PUT che dovrebbe subire non prova niente.
server.requestTimeout = 0
// Un client che manda `Expect: 100-continue` aspetta il via prima del corpo: un rifiuto
// anticipato deve poter rispondere SENZA mai dare il via (come lo Storage). Il via lo dà
// chi accetta il corpo (`writeContinue`).
server.on('checkContinue', (req, res) => {
  req.attendeContinue = true
  void gestisci(req, res, server)
})
/** I modi in cui Node racconta «il client è sparito»: connessione azzerata, scrittura su un socket chiuso, chiusura a metà di una richiesta. */
const CLIENT_SPARITO = ['ECONNRESET', 'EPIPE', 'HPE_INVALID_EOF_STATE']
server.on('clientError', (causa, socket) => {
  // Un client che sparisce è la normalità di questo collaudo: il motore nativo viene ucciso, l'invio
  // si annulla a metà, il telefono si blocca, la rete cade. Una richiesta malformata invece è un difetto.
  if (CLIENT_SPARITO.includes(causa.code)) traccia(`il client è sparito (${causa.code})`)
  else errore('richiesta non valida', causa)
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})
process.on('unhandledRejection', (causa) => errore('promessa respinta e non gestita', causa))

function chiudi(codice) {
  server.close()
  server.closeAllConnections()
  process.exit(codice)
}
process.on('SIGINT', () => chiudi(0))
process.on('SIGTERM', () => chiudi(0))

server.on('error', (causa) => {
  errore(`impossibile ascoltare su ${INDIRIZZO}:${opz.porta}`, causa)
  process.exit(1)
})
server.listen(opz.porta, INDIRIZZO, () => {
  stato.porta = server.address().port
  if (opz.filePorta !== null) writeFileSync(opz.filePorta, `${stato.porta}\n`)
  const base = `http://localhost:${stato.porta}`
  process.stdout.write(
    `Server finto di collaudo dei caricamenti, in ascolto su http://${INDIRIZZO}:${stato.porta}/ (solo loopback)\n` +
      `  iOS Simulator : ${base}/\n` +
      `  Android (AVD) : http://10.0.2.2:${stato.porta}/   (alias del loopback del Mac)\n` +
      `  Stato         : curl -s http://${INDIRIZZO}:${stato.porta}/stato\n`,
  )
  if (opz.vitaMassimaS > 0) {
    setTimeout(() => {
      process.stdout.write(`vita massima di ${opz.vitaMassimaS} s raggiunta: mi spengo\n`)
      chiudi(0)
    }, opz.vitaMassimaS * 1000)
  }
})
