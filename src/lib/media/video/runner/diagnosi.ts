import { senzaUrl } from './script'

/**
 * LA DIAGNOSI CHE ARRIVA NEI LOG: la CODA dell'errore, senza ciò che nei log non deve stare.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IL DIFETTO CHE QUESTO FILE CHIUDE
 *
 * Dal 29/09/2026 alle 14:20 UTC nessun video si è più convertito: 17 job su 17 sono
 * finiti `failed / BUILD_DOWNLOAD_FAILED`. Il motivo stava in una riga — `curl: (22)
 * The requested URL returned error: 404`, perché BtbN aveva tolto la release pinnata —
 * e quella riga non l'ha letta nessuno. Lo stderr che si salvava era l'INIZIO
 * (`senzaUrl(diagnosi).trim().slice(0, 1000)`), e l'inizio era l'output di
 * `dnf install xz`: 76 MB di metadati dei mirror, la tabella delle dipendenze. Poi
 * `app_log.messaggio` tronca a 500 caratteri, e il 404, che stava in fondo, non è mai
 * arrivato: ogni riga di log di quei fallimenti è lunga esattamente 500 caratteri, è
 * l'inizio di dnf, e nessuna dice perché.
 *
 * È la violazione di AGENTS.md (regola 3: «il corpo dell'errore non si butta MAI via»)
 * nella forma che nessun test vede: un `slice(0, n)`.
 *
 * Gli strumenti scrivono ciò che è andato storto per ULTIMO. Perciò qui si tengono le
 * **ultime** battute, non le prime.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COSA SPARISCE, E PERCHÉ
 *
 * Lo stderr di `ffmpeg` e di `curl` non è un testo qualunque: contiene il video di un
 * bambino e l'indirizzo che lo autorizza a leggerlo, e `app_log` dura trenta giorni ed è
 * interrogabile in SQL.
 *
 *  · gli **URL** (`senzaUrl`) portano un token che autorizza a leggere o scrivere nel
 *    bucket privato dei video; i **JWT** (`eyJ…`) e le coppie `token=…`, `signature=…`,
 *    `apikey=…` sono la stessa credenziale quando arriva spezzata fuori da un indirizzo.
 *    Il MOTIVO del guasto resta (`403`, `404`, `connection reset`): sparisce il segreto.
 *  · i **metadati del filmato**. Il banner d'ingresso di ffmpeg li stampa tutti, e un
 *    iPhone ci scrive `com.apple.quicktime.location.ISO6709`: le coordinate GPS di dove
 *    sono stati ripresi i bambini. Con loro `creation_time`, `make`, `model`,
 *    `manufacturer`, `software`, `title`, `comment`, `artist` — testo libero o ciò che
 *    identifica un apparecchio. Spariscono i blocchi `Metadata:` interi e, fuori dai
 *    blocchi (la coda di uno stderr può cominciare a metà), le righe che nominano uno di
 *    quei campi. E spariscono le **coordinate per VALORE**, ovunque compaiano: un valore
 *    può stare dove il nome del tag non c'è (la riga di continuazione di un tag su più
 *    righe, il resto di una riga tagliata) e la sua forma — due numeri con segno attaccati,
 *    `+40.8518+014.2681/` — non si confonde con nient'altro che ffmpeg scriva.
 *  · il **progresso** di ffmpeg e di curl, che riscrive la stessa riga con `\r`: di una
 *    riga fatta di cento aggiornamenti si tiene l'ultimo, che è quello che dice a che
 *    punto era arrivato.
 *
 * ⚠️ NON È LA DIFESA PRINCIPALE. Sono euristiche sulla FORMA del testo, e come tutte
 * danno falsi negativi. Il passaggio che c'è sempre, dopo, resta `sanificaMessaggio`
 * (`@/lib/logging/serialize`: email, codici fiscali, tetto a `MESSAGGIO_MAX`). Qui si
 * toglie ciò che quel passaggio non può riconoscere perché non ha la forma di un dato
 * personale, e si fa in modo che i 500 caratteri del log siano quelli che servono.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PURA, E PER QUESTO SENZA LOG
 *
 * Stringa in, stringa fuori: nessun I/O, nessun import dell'SDK del Sandbox (l'unico
 * import è `senzaUrl`, pura anche lei), e **non lancia mai** — un guasto del
 * formattatore di un errore non può diventare un secondo guasto sopra il primo. Non
 * ha un `catch`, quindi non ha un `catch` muto: le righe di log (`conversione-fallita`,
 * `conversione-da-riprovare`) le scrive il chiamante, che ha il job, e che passa questo
 * testo come MESSAGGIO dell'errore e non come campo — `redact` è a lista bianca per
 * chiave, e un campo `diagnosi` uscirebbe `[redatto:str/…]`, cioè illeggibile proprio
 * dove serve.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** Davanti al testo quando se ne è tagliato l'inizio. Un carattere solo, come in `tronca`. */
const ELLISSI = '…'

/**
 * Quanto testo si guarda, al massimo, prima di ripulire: le ultime 200.000 battute.
 *
 * Ciò che sta più indietro non entrerebbe comunque nel tetto, e un dump da megabyte
 * (l'HTML d'errore di un provider, un log che nessuno ha troncato) non deve far girare
 * le espressioni regolari su tutto. Stessa idea di `PRE_TAGLIO` in `serialize.ts`, con
 * un margine molto più largo perché qui si ripulisce PRIMA di tagliare: le righe tolte
 * non devono consumare il budget di quelle che restano.
 */
const FINESTRA_LETTURA = 200_000

/** Una riga che è soltanto `Metadata:`: l'intestazione di un blocco di metadati di ffmpeg. */
const INTESTAZIONE_METADATI = /^\s*metadata:\s*$/i

/**
 * Tracce che bastano da sole a riconoscere un metadato personale, in qualunque punto
 * della riga: sono così specifiche che non compaiono in nessun altro contesto.
 * (Si applica DOPO `senzaUrl`: un indirizzo può contenere qualunque sottostringa, e non
 * deve poter far sparire una riga diagnostica per una parola che sta nel suo percorso.)
 */
const TRACCIA_METADATO_PERSONALE = /ISO6709|com\.apple\.|creation_time|creationdate/i

/**
 * Nomi di tag che, **a inizio riga**, aprono una riga di metadati: `chiave : valore`
 * nello stderr di ffmpeg, `TAG:chiave=valore` in quello di ffprobe, `"chiave": "valore"`
 * nel suo JSON. `location` porta anche il suffisso della lingua (`location-eng`).
 *
 * Il nome del tag può avere un prefisso puntato: `com.android.model: …`,
 * `com.android.manufacturer: …`, `format.tags.location=…`, `TAG:com.android.model=…`. È lo
 * stesso tag col nome per esteso (lo scrivono certi apparecchi Android, e ffprobe in
 * formato `flat` lo prefissa col percorso), e a inizio riga identifica l'apparecchio o il
 * luogo come la chiave nuda. `manufacturer` è la marca come la scrive Android, accanto a
 * `model`: l'una senza l'altra dice già che telefono ha ripreso il bambino.
 *
 * In posizione di chiave e non «ovunque nella riga» di proposito: `make`, `model`,
 * `manufacturer`, `title` o `comment` compaiono in frasi qualunque di un errore, e una
 * riga diagnostica persa per una parola comune è proprio il difetto che questo file esiste
 * per evitare. Per lo stesso motivo il prefisso puntato conta solo a inizio riga: un nome
 * come `x.model` dentro una frase d'errore non è una chiave.
 */
const TAG_METADATO_PERSONALE =
  /^\s*(?:TAG:)?["']?(?:[\w-]+\.)*(?:location(?:-\w+)?|make|model|manufacturer|software|title|comment|artist)["']?\s*[:=]/i

/**
 * Una coordinata GPS in forma ISO 6709, riconosciuta dal VALORE e non dal nome del tag.
 *
 * È l'altra metà della difesa sui metadati. Le righe che NOMINANO il tag (`ISO6709`,
 * `location`, `com.apple.…`) spariscono per nome, ma un valore può stare dove il nome non
 * c'è: la riga di continuazione di un tag su più righe, il resto di una riga tagliata a
 * metà, una riga che uno strumento scrive per conto proprio. Ed è il dato che nei log non
 * deve stare, perché dice dove sono stati ripresi dei bambini.
 *
 * La forma è inconfondibile: due numeri CON SEGNO attaccati — latitudine di due cifre,
 * longitudine di tre, con decimali facoltativi — poi una quota facoltativa con il suo
 * segno, un sistema di riferimento facoltativo (`CRSWGS_84`) e la `/` finale:
 * `+40.8518+014.2681/`, `+47.6543+019.8765+123.456/`, `-33.8688-070.6693-012.500/`.
 *
 * Perché non dà falsi positivi sulle righe di ffmpeg: servono DUE segni, a due e a tre
 * cifre una dopo l'altra, e in `time=00:00:05.00`, `bitrate=3919.6kbits/s`, `speed=1.2x`,
 * `fps= 49`, `q=-1.0` o `start: -0.023220` ne compare uno solo, o nessuno, e mai con
 * quelle cifre. In più `senzaCoordinate` maschera solo se il testo trovato ha un punto
 * decimale o la `/` finale: `+12-345` da solo è un numero qualunque.
 *
 * Il flag `g` serve a `replace`, che riparte da zero a ogni chiamata (mai con `test` o
 * `exec`). Nessun quantificatore annidato su un insieme che si sovrappone: il tempo è
 * lineare anche su milioni di segni e di cifre.
 */
const COORDINATE_ISO6709 =
  /[+-]\d{2}(?:\.\d+)?[+-]\d{3}(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)?(?:CRS\w+)?\/?/g

/**
 * Una credenziale in forma di JWT: tre segmenti base64url, e il primo comincia sempre
 * con `eyJ` (cioè `{"`). Quelli troncati a metà — la coda di un log può finire dove vuole
 * — si riconoscono lo stesso, perché si chiede solo l'inizio e poi si consuma quel che
 * segue.
 */
const JWT = /eyJ[\w-]{4,}(?:\.[\w-]*){0,2}/g

/**
 * `token=…`, `signature=…`, `apikey: …` e le loro varianti (`access_token`,
 * `X-Amz-Signature`, `x-api-key`, `api_key`): il valore sparisce, la chiave resta, così
 * si vede CHE COSA c'era senza vederne il contenuto. Il valore finisce al primo
 * spazio, `&`, virgola, punto e virgola o apice, oppure è una stringa fra apici; se
 * l'apice di chiusura manca (riga troncata), il valore arriva a fine riga.
 *
 * Nessun `[\w-]*` davanti alla chiave: con un quantificatore aperto prima dell'alternativa,
 * una lunga sequenza di caratteri di parola (un dump, un base64) costringerebbe il motore
 * a un tentativo quadratico a ogni posizione.
 */
const CHIAVE_SEGRETA =
  /(token|signature|api[_-]?key)(["']?\s*[=:]\s*)(?:"[^"\n]*"?|'[^'\n]*'?|[^\s"'&,;]+)/gi

/**
 * Le ultime `n` battute di `s`, senza mai spezzare una coppia surrogata.
 *
 * Un taglio che cade in mezzo a un'emoji lascerebbe una metà orfana in testa al
 * risultato, e una metà orfana non è un testo ben formato: dentro un JSON o una
 * colonna `text` di Postgres è un errore di scrittura, cioè un log che non si salva
 * proprio quando serviva. Se il taglio cade lì, la metà orfana si scarta (il risultato
 * resta comunque entro `n`).
 */
function ultime(s: string, n: number): string {
  if (n >= s.length) return s
  let inizio = s.length - n
  const unita = s.charCodeAt(inizio)
  if (unita >= 0xdc00 && unita <= 0xdfff) inizio += 1
  return s.slice(inizio)
}

/**
 * Di una riga fatta di aggiornamenti separati da `\r` (il progresso di ffmpeg e di curl
 * riscrive la stessa riga) tiene l'ultimo segmento che non sia vuoto.
 */
function ultimoSegmento(riga: string): string {
  if (riga.indexOf('\r') < 0) return riga
  const segmenti = riga.split('\r')
  for (let i = segmenti.length - 1; i >= 0; i -= 1) {
    if (segmenti[i].trim() !== '') return segmenti[i]
  }
  return ''
}

/** Toglie i segreti che non stanno dentro un indirizzo (quelli dentro un indirizzo sono già spariti). */
function senzaSegreti(riga: string): string {
  return riga
    .replace(
      CHIAVE_SEGRETA,
      (_trovato: string, chiave: string, separatore: string) => `${chiave}${separatore}[segreto]`,
    )
    .replace(JWT, '[jwt]')
}

/**
 * Sostituisce con `[coordinate]` ogni coordinata GPS in forma ISO 6709 (vedi
 * `COORDINATE_ISO6709`), in qualunque punto della riga. Maschera solo ciò che ha un punto
 * decimale o la `/` finale: due numeri con segno e basta non sono un luogo.
 */
function senzaCoordinate(riga: string): string {
  return riga.replace(COORDINATE_ISO6709, (trovata: string) =>
    trovata.includes('.') || trovata.endsWith('/') ? '[coordinate]' : trovata,
  )
}

/**
 * Ripulisce un testo diagnostico e ne restituisce le ULTIME `max` battute.
 *
 * `max` è il tetto del RISULTATO, ellissi compresa: il risultato non lo supera mai.
 * Chi lo passa a un log lo dimensiona sul budget del canale (`MESSAGGIO_MAX - 1`,
 * `@/lib/logging/serialize`), così `sanificaMessaggio` non ha più niente da tagliare — e
 * se tagliasse, taglierebbe la CODA, cioè proprio la riga che si voleva salvare.
 *
 * Se si è tagliato, il risultato comincia con `…`. Un `max` che non è un numero positivo
 * dà la stringa vuota (e il chiamante ripiega sul codice d'errore); con `max` pari a 1
 * non c'è spazio per l'ellissi e si restituisce l'ultima battuta e basta.
 *
 * L'ORDINE conta: prima si ripulisce, poi si taglia. Al contrario, le righe tolte (un
 * blocco `Metadata:` può essere lungo quanto tutto il budget) consumerebbero i caratteri
 * di quelle che restano.
 *
 *  1. si guardano al massimo le ultime `FINESTRA_LETTURA` battute;
 *  2. via gli URL (`senzaUrl`), per primi: un indirizzo contiene qualunque cosa, e non
 *     deve poter far scattare le regole sulle righe;
 *  3. riga per riga: del progresso `\r` resta l'ultimo segmento, le righe vuote
 *     spariscono, i blocchi `Metadata:` e le righe dei metadati personali spariscono;
 *  4. sulle righe rimaste, via JWT, `token=`/`signature=`/`apikey=` e le coordinate GPS
 *     (`[coordinate]`, per valore);
 *  5. si tengono le ultime `max` battute, con `…` davanti se si è tagliato.
 */
export function codaDiagnostica(testo: string, max: number): string {
  if (typeof testo !== 'string') return ''
  const tetto = typeof max === 'number' && !Number.isNaN(max) ? Math.floor(max) : 0
  if (tetto <= 0) return ''

  const righe: string[] = []
  // Il rientro della riga `Metadata:` che ha aperto il blocco in corso, o -1 se non siamo
  // in un blocco. Il blocco dura finché le righe sono rientrate PIÙ di lei: ffmpeg lo
  // chiude con la riga successiva allo stesso livello (`Duration:`, `Stream #…`, `Side data:`).
  let rientroBlocco = -1

  for (const grezza of senzaUrl(ultime(testo, FINESTRA_LETTURA)).split(/\r?\n/)) {
    const riga = ultimoSegmento(grezza)
    if (riga.trim() === '') continue

    const rientro = riga.length - riga.trimStart().length
    if (rientroBlocco >= 0) {
      if (rientro > rientroBlocco) continue
      rientroBlocco = -1
    }
    if (INTESTAZIONE_METADATI.test(riga)) {
      rientroBlocco = rientro
      continue
    }
    if (TRACCIA_METADATO_PERSONALE.test(riga) || TAG_METADATO_PERSONALE.test(riga)) continue

    righe.push(senzaCoordinate(senzaSegreti(riga)).trimEnd())
  }

  const pulito = righe.join('\n').trim()
  if (pulito.length <= tetto) return pulito
  // Niente spazio per l'ellissi: l'ultima battuta e basta (come `tronca` in `serialize.ts`).
  if (tetto === 1) return ultime(pulito, 1)
  return ELLISSI + ultime(pulito, tetto - 1)
}
