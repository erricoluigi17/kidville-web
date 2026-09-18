import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · un bucket si dichiara in migrazione, e dice le stesse cose del codice
//
// IL DIFETTO, misurato in produzione il 2026-07-31:
//   · `storage.buckets` → gallery.file_size_limit = 52428800 (50 MB)
//   · `src/app/api/gallery/upload/route.ts` → fileSizeLimit: 209715200 (200 MB)
// Due dichiarazioni della stessa regola, in due posti, divergenti da mesi. Un video
// da 120 MB passava tutti i controlli dell'applicazione e veniva rifiutato dallo
// Storage: l'esito di `updateBucket` non lo guardava nessuno, quindi lo scarto non
// lasciava traccia da nessuna parte.
//
// E il bucket «news» non esisteva affatto: `api/news/upload` lo avrebbe creato al
// volo, e pubblico, come effetto collaterale del primo caricamento. La
// configurazione di uno spazio destinato all'esterno non può nascere così: non è
// versionata, non è rivedibile, e cambia da sola il giorno in cui qualcuno modifica
// la route.
//
// IL SECONDO DIFETTO, trovato il 2026-07-31 dal collaudo di questo stesso lock:
//   la correzione di sicurezza più importante di quella giornata — `avvisi_allegati`
//   e `task_allegati` resi PRIVATI — non era protetta da niente. Una migrazione di
//   due righe (`update storage.buckets set public = true where id = 'avvisi_allegati'`)
//   passava l'intero gate: 375 test verdi, 0 rossi. Questo lock guardava
//   `file_size_limit`, l'esistenza dell'INSERT e i MIME — mai la colonna `public`,
//   che il suo stesso parser (`valoriInsert()`) già estraeva.
//   È il difetto di un lock scritto per il guasto che si aveva davanti invece che per
//   la regola. E riaprire quei bucket è sfruttabile: l'URL firmato che l'app manda a
//   ogni famiglia contiene il percorso in chiaro, e da quel percorso si ricostruisce
//   l'indirizzo pubblico — che, a bucket aperto, vale per sempre.
//
// COSA PRETENDE QUESTO LOCK.
//  1. Ogni bucket qui sotto è dichiarato in una migrazione.
//  2. I valori che il codice ripete devono coincidere con quelli della migrazione.
//     Non «essere simili»: coincidere. È l'unico modo perché la divergenza si veda
//     PRIMA, invece che come un caricamento respinto in silenzio.
//  3. **Privato salvo eccezione dichiarata.** Nessuna migrazione può rendere pubblico
//     un bucket dell'elenco `RISERVATI`, e in produzione nessuno di quelli è pubblico.
//     L'unica eccezione è `news`, elencata qui sotto con la ragione scritta.
//
// SU `gallery` ORA SI CONFRONTA ANCHE LA LISTA DEI TIPI — decisa il 2026-09-01.
// Fino a quel giorno qui c'era scritto che il confronto NON si faceva, perché la
// lista del bucket in produzione (`video/quicktime` dentro, `image/gif` fuori)
// divergeva da quella della route e allinearle cambia cosa si può caricare: una
// decisione di prodotto, che un lock non è il posto dove prendere di nascosto.
//
// La decisione, dal titolare: **le foto e i video devono vedersi sia da Android
// che da iOS.** Ne segue una lista sola, e il `.mov` ne esce:
//   · `video/quicktime` è il formato dell'iPhone e Android NON lo riproduce. Non
//     ci arriva mai — il client converte, e il server rifiuta con 415 ciò che è
//     sfuggito — ma finché resta in elenco è la terza porta lasciata aperta su un
//     video che metà dei genitori non riuscirebbe ad aprire;
//   · `image/gif` esce perché è irraggiungibile, non perché faccia danno: il
//     client ridisegna OGNI immagine su canvas e la riesporta in JPEG, quindi al
//     bucket una GIF non arriva. Tenerla in elenco descriveva una cosa che non
//     accade;
//   · `image/jpg` esce perché non è un tipo MIME: nessun browser lo manda.
// Restano `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/webm` —
// tutti riproducibili su tutt'e due i sistemi.
//
// PERCHÉ LA VISIBILITÀ SI GUARDA IN DUE POSTI. Otto bucket su dodici non sono
// dichiarati in nessuna migrazione: sono nati dalla console di Supabase. Per loro il
// repo non ha niente da leggere, e un bucket riaperto da quella console non lascerebbe
// traccia in nessun file. Quindi:
//   · sulle MIGRAZIONI si verifica che nessun file del repo li riapra (è la difesa che
//     scatta PRIMA, in revisione, mentre la modifica è ancora una proposta);
//   · sul DATABASE si verifica lo stato reale, attraverso la fotografia versionata
//     `__tests__/fixtures/bucket-storage-snapshot.json` — stesso schema di
//     `migrazioni-complete.test.ts`, `rls-per-sede.test.ts` e `fk-scuola-id.test.ts`,
//     perché il test gira OFFLINE in CI e le credenziali di produzione lì non ci sono
//     e non devono esserci.
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')

/** Gli statement SQL di tutte le migrazioni, in ordine, senza commenti. */
function statementDelleMigrazioni(): { file: string; sql: string }[] {
  const out: { file: string; sql: string }[] = []
  for (const file of readdirSync(MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort()) {
    const testo = readFileSync(join(MIGRAZIONI, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
    for (const sql of testo.split(';')) if (sql.trim()) out.push({ file, sql })
  }
  return out
}

const STATEMENT = statementDelleMigrazioni()

/** Gli statement che configurano il bucket indicato. */
function statementDelBucket(bucket: string): { file: string; sql: string }[] {
  return STATEMENT.filter(
    (s) => /storage\.buckets/i.test(s.sql) && new RegExp(`'${bucket}'`).test(s.sql),
  )
}

/**
 * Divide per virgole, ma solo a profondità zero: `ARRAY['a','b']` è UN valore, non due.
 * Senza questo, la colonna dei tipi MIME sfalserebbe tutte quelle dopo di lei.
 */
function pezziAProfonditaZero(testo: string): string[] {
  const pezzi: string[] = []
  let corrente = ''
  let profondita = 0
  let inStringa = false
  for (const ch of testo) {
    if (ch === "'") inStringa = !inStringa
    if (!inStringa && (ch === '(' || ch === '[')) profondita++
    if (!inStringa && (ch === ')' || ch === ']')) profondita--
    if (ch === ',' && profondita === 0 && !inStringa) {
      pezzi.push(corrente.trim())
      corrente = ''
    } else corrente += ch
  }
  if (corrente.trim()) pezzi.push(corrente.trim())
  return pezzi
}

/**
 * `INSERT INTO storage.buckets (a, b, c) VALUES (1, 2, 3)` → { a: '1', b: '2', c: '3' }.
 *
 * Si legge la posizione, non la vicinanza fra la parola e un numero: in un INSERT il
 * valore di una colonna può stare venti righe più in basso, e un parser «a distanza»
 * leggerebbe il numero della colonna sbagliata senza accorgersene.
 */
function valoriInsert(sql: string): Record<string, string> | null {
  const m = sql.match(/insert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*\(([\s\S]*)/i)
  if (!m) return null
  const colonne = pezziAProfonditaZero(m[1]).map((c) => c.trim().toLowerCase())
  // Il corpo dei VALUES finisce con la parentesi che li chiude.
  let profondita = 1
  let corpo = ''
  let inStringa = false
  for (const ch of m[2]) {
    if (ch === "'") inStringa = !inStringa
    if (!inStringa && (ch === '(' || ch === '[')) profondita++
    if (!inStringa && (ch === ')' || ch === ']')) profondita--
    if (profondita === 0) break
    corpo += ch
  }
  const valori = pezziAProfonditaZero(corpo)
  if (valori.length !== colonne.length) return null
  return Object.fromEntries(colonne.map((c, i) => [c, valori[i]]))
}

/**
 * L'ULTIMO limite di dimensione dichiarato in migrazione per quel bucket.
 *
 * DENTRO UN SINGOLO STATEMENT VINCE IL PIÙ ALTO, non l'ultimo letto — ed è una
 * correzione del 2026-09-18, trovata provando a falsificare questo stesso lock.
 * Un `INSERT … ON CONFLICT DO UPDATE` dichiara il limite DUE volte, una per ramo:
 * quello dell'`insert` vale in un ambiente nuovo (dove il bucket nasce da lì),
 * quello del `do update` vale in produzione (dove il bucket esiste già). Fino a
 * oggi la riga dell'`update` sovrascriveva quella dell'`insert` in una variabile
 * sola, quindi **il ramo INSERT non veniva mai guardato**: un
 * `values (…, 2000000001) on conflict do update set file_size_limit = 10485760`
 * passava verde, e in un ambiente ricostruito da zero quel bucket sarebbe nato con
 * 2 GB di tetto. Provato: il lock è rimasto verde su quella riga esatta.
 *
 * Non è un caso di scuola, ed è per questo che la correzione arriva adesso: dal
 * 2026-09-17 l'`INSERT … ON CONFLICT` è la forma STANDARD con cui questo repo
 * dichiara un bucket (otto su sedici la usano), cioè la forma in cui i due rami
 * possono divergere è diventata la normale.
 *
 * `Math.max` è la lettura che non assolve: se uno dei due rami è più largo, il
 * bucket è largo così in almeno un ambiente. È la stessa scelta che
 * `visibilitaDichiarata()` fa da sempre sulla colonna `public` (`valori.some`),
 * per la stessa ragione. Fra statement DIVERSI continua a vincere l'ultimo: quella
 * è cronologia, una migrazione successiva sovrascrive la precedente.
 */
function limiteDichiarato(bucket: string): number | null {
  let ultimo: number | null = null
  for (const s of statementDelBucket(bucket)) {
    const valori: number[] = []
    const inserito = valoriInsert(s.sql)?.file_size_limit
    if (inserito && /^\d+$/.test(inserito)) valori.push(Number(inserito))
    for (const m of s.sql.matchAll(/file_size_limit\s*=\s*(\d+)/gi)) valori.push(Number(m[1]))
    if (valori.length) ultimo = Math.max(...valori)
  }
  return ultimo
}

/** I tipi MIME dichiarati in migrazione per quel bucket (ultimo statement che ne elenca). */
function mimeDichiarati(bucket: string): string[] {
  let ultimi: string[] = []
  for (const s of statementDelBucket(bucket)) {
    const inserito = valoriInsert(s.sql)?.allowed_mime_types
    const assegnato = s.sql.match(/allowed_mime_types\s*=\s*(ARRAY\s*\[[\s\S]*?\])/i)?.[1]
    const sorgenteMime = assegnato ?? inserito
    if (!sorgenteMime) continue
    const trovati = [...sorgenteMime.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((m) => m[1])
    if (trovati.length) ultimi = trovati
  }
  return ultimi
}

// ─────────────────────────────────────────────────────────────────────────────
// LA REGOLA: privato salvo eccezione dichiarata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I bucket che NON possono essere pubblici. Su un bucket pubblico lo Storage serve il
 * file a chiunque conosca l'indirizzo: niente login, niente ruolo, niente sede, per
 * sempre. Qui dentro ci sono foto e video dei bambini, certificati medici, pagelle,
 * credenziali, fatture, documenti d'identità dei genitori, allegati di avvisi e
 * incarichi: nessuno di questi è materia pubblica.
 *
 * Aggiungere un bucket a questo elenco è gratis. Toglierlo è una decisione di
 * prodotto, e va nell'elenco qui sotto con la sua ragione.
 */
const RISERVATI = [
  'avvisi_allegati',
  'cassa-giustificativi',
  'certificati-medici',
  'chat-allegati',
  'credenziali',
  // Scansioni dei documenti d'identità del PERSONALE in servizio (2026-08-11), dal
  // modulo pubblico `/anagrafica-personale`. Bucket suo e non `form_attachments`
  // per una ragione che non è di ordine: quello custodisce i documenti allegati
  // alle domande d'iscrizione, cioè carte d'identità di genitori e fotografie di
  // minori. Due popolazioni, due basi giuridiche, due termini di conservazione —
  // e, soprattutto, due risolutori di percorso. Tenendoli separati, il gate di
  // scope di un modulo non può firmare per sbaglio l'oggetto dell'altro: un
  // percorso `documenti/…` non si risolve MAI a una riga d'iscrizione.
  'documenti_personale',
  'fatture',
  'form_attachments',
  'gallery',
  // Gli ELENCHI DI CLASSE della segreteria (2026-08-16): i fogli Excel su cui è
  // scritto, per ogni bambino, in che classe va e quanto paga la sua famiglia.
  // Il file di Giugliano da solo porta 338 nomi di minori. Sta in un bucket e non
  // nel repository per la ragione più semplice che ci sia: il repository è
  // pubblico, e un file lasciato nella cartella di lavoro è a un `git add -A` di
  // distanza dall'esserlo anche lui. La strada è chiusa due volte — qui e in
  // `.gitignore`, dichiarata nel lock `pii-nei-file-tracciati`.
  'iscrizioni_elenchi',
  // I due della pipeline video, nati il 2026-09-18. `video_originals` custodisce
  // l'originale caricato dal telefono di un genitore o di un'insegnante, prima che
  // FFmpeg lo tocchi; `video_processing` l'uscita convertita, prima che il finalizer
  // la copi dove una famiglia potra' vederla. Entrambi PRIVATI e a 2 GB: il tetto
  // alto e' la ragione per cui esistono come bucket separati invece che dentro
  // `gallery` — un originale da due gigabyte non deve poter entrare da nessuna delle
  // porte che servono le foto. La loro copertura di oblio sta in
  // `REGISTRO_BUCKET_OBLIO`, e per `video_processing` quella voce dichiara una
  // LACUNA APERTA invece di fingere una copertura.
  'video_originals',
  'video_processing',
  // ⚠️ TROVATO, NON CREATO da questo lavoro. È comparso in produzione fra la
  // fotografia dell'11/08 e quella del 16/08, e nel repository non c'è nessuna
  // migrazione che lo dichiari né nessuna route che lo nomini: è nato dalla
  // console, come otto degli altri. Lo si classifica come riservato perché è
  // privato e il nome dice cosa contiene; ma resta un bucket di cui il codice non
  // sa niente, e andrebbe capito a chi serve prima che qualcuno ci scriva dentro.
  'sensitive_documents',
  // Area di sosta dei media delle News (2026-08-01). Ci stanno le foto **prima**
  // che il consenso fotografico sia verificato: fino a oggi finivano dritte in
  // `news`, che è pubblico, e restavano leggibili da chiunque senza login anche se
  // la pubblicazione veniva poi rifiutata dal gate — o se il post non veniva mai
  // salvato. È il bucket che deve essere chiuso più di tutti: contiene esattamente
  // ciò per cui il consenso non è ancora stato dato.
  'news_bozze',
  'pagelle',
  'protocollo',
  'task_allegati',
] as const

/**
 * Le UNICHE eccezioni ammesse, con la ragione scritta accanto — come le altre
 * allowlist di questo repo. Un elenco senza ragioni diventa, in sei mesi, il posto
 * dove si infila quello che dà fastidio.
 */
const PUBBLICI_PER_DECISIONE: Record<string, string> = {
  news:
    'Blog rivolto all’esterno, deciso dal titolare il 2026-07-31: un link firmato ' +
    'scadrebbe, e un articolo condiviso su WhatsApp mostrerebbe un’immagine rotta dopo ' +
    'pochi minuti. Qui vanno SOLO i media editoriali degli articoli: le foto dei ' +
    'bambini stanno in `gallery`, che è privato e resta tale.',
}

/** Il testo di uno statement senza la clausola WHERE. */
function senzaWhere(sql: string): string {
  const m = /\bwhere\b/i.exec(sql)
  return m ? sql.slice(0, m.index) : sql
}

/**
 * L'ULTIMA visibilità dichiarata in migrazione per quel bucket, col file che la
 * dichiara. `null` se nessuna migrazione la nomina (per otto bucket su dodici è il
 * caso normale: sono nati dalla console, e la loro verità sta nella fotografia).
 *
 * Due accortezze, entrambe per non leggere il contrario di quel che lo statement fa:
 *  · la clausola WHERE è esclusa — `where public is distinct from false` (che sta
 *    davvero nella migrazione del 2026-07-31) e `where public = true` nominano la
 *    colonna senza assegnarla;
 *  · dentro un `INSERT … ON CONFLICT DO UPDATE` i valori dichiarati possono essere
 *    due, uno per ramo: se uno dei due apre il bucket, lo statement lo apre. La
 *    lettura prudente è l'unica che va bene in un lock di sicurezza.
 */
function visibilitaDichiarata(bucket: string): { pubblico: boolean; file: string } | null {
  let ultima: { pubblico: boolean; file: string } | null = null
  for (const s of statementDelBucket(bucket)) {
    const valori: boolean[] = []
    const inserito = valoriInsert(s.sql)?.public?.trim()
    if (inserito && /^(true|false)$/i.test(inserito)) valori.push(/^true$/i.test(inserito))
    for (const m of senzaWhere(s.sql).matchAll(/\bpublic\s*=\s*(true|false)\b/gi)) {
      valori.push(/^true$/i.test(m[1]))
    }
    if (valori.length) ultima = { pubblico: valori.some(Boolean), file: s.file }
  }
  return ultima
}

// ─── la fotografia della produzione (il test gira OFFLINE) ────────────────────

type Fotografia = { generato_il: string; sha256: string; bucket: { id: string; pubblico: boolean }[] }

const FOTOGRAFIA = join(RADICE, '__tests__', 'fixtures', 'bucket-storage-snapshot.json')
const GENERATORE = join(RADICE, '__tests__', 'fixtures', 'bucket-storage-fotografia.mjs')
const COME_RIGENERARE =
  'Rigenera la fotografia: `node __tests__/fixtures/bucket-storage-fotografia.mjs --sql` → esegui ' +
  'la query sul DB di produzione (sola lettura) → ' +
  '`node __tests__/fixtures/bucket-storage-fotografia.mjs < risposta.json`.'

const foto: Fotografia = JSON.parse(readFileSync(FOTOGRAFIA, 'utf8'))
const inProduzione = new Map(foto.bucket.map((b) => [b.id, b.pubblico]))

const sorgente = (rel: string) => readFileSync(join(RADICE, rel), 'utf8')

/**
 * Il sorgente SENZA commenti.
 *
 * ⚠️ NON È UN DETTAGLIO DI PULIZIA. Questo lock legge numeri e stringhe dal codice
 * con delle regex, e una regex non sa distinguere un valore da una frase che lo
 * nomina. Il 2026-09-01, correggendo il difetto dei 200 MB, il commento che lo
 * SPIEGAVA («spediva `fileSizeLimit: 209715200`…») è stato letto come se fosse il
 * valore in vigore: il lock è rimasto rosso su una riga che era già stata
 * corretta. Al contrario — ed è il caso pericoloso — un commento può rendere VERDE
 * un lock su codice guasto (già successo in questo repo, `carta intestata`).
 * Le migrazioni sono lette così da sempre (`statementDelleMigrazioni`); il codice
 * lo era rimasto.
 *
 * Il `//` preceduto da `:` non si tocca, altrimenti sparirebbe metà di ogni URL.
 */
const senzaCommenti = (codice: string) =>
  codice.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** `fileSizeLimit: 209715200` nel sorgente di una route (commenti esclusi). */
function limiteNelCodice(rel: string): number | null {
  const m = senzaCommenti(sorgente(rel)).match(/fileSizeLimit:\s*(\d+)/)
  return m ? Number(m[1]) : null
}

/**
 * I letterali MIME dentro `allowedMimeTypes: [ … ]` nel sorgente di una route —
 * cioè la configurazione che la route userebbe per CREARE il bucket in un ambiente
 * nuovo. Deve dire le stesse cose della migrazione, altrimenti l'ambiente appena
 * nato accetta file diversi da quello di produzione.
 */
function mimeBucketNelCodice(rel: string): string[] {
  const m = senzaCommenti(sorgente(rel)).match(/allowedMimeTypes:\s*\[([\s\S]*?)\]/)
  if (!m) return []
  return [...m[1].matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((x) => x[1])
}

/**
 * Il numero dietro `const <NOME> = 1_234` in un sorgente (commenti esclusi).
 *
 * Gli underscore si tolgono: `2_000_000_000` e `2000000000` sono lo stesso numero
 * e devono confrontarsi, altrimenti il lock diventerebbe una regola sulla
 * PUNTEGGIATURA — verde o rosso a seconda di come qualcuno ha scritto una cifra.
 */
function costanteNumerica(rel: string, nome: string): number | null {
  const m = senzaCommenti(sorgente(rel)).match(new RegExp(`${nome}\\s*=\\s*([\\d_]+)`))
  return m ? Number(m[1].replaceAll('_', '')) : null
}

/** I letterali MIME dentro `const <NOME> = [ … ]` (commenti esclusi). */
function mimeNelCodice(rel: string, costante: string): string[] {
  const m = senzaCommenti(sorgente(rel)).match(
    new RegExp(`const\\s+${costante}\\s*=\\s*\\[([\\s\\S]*?)\\]`),
  )
  if (!m) return []
  return [...m[1].matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((x) => x[1])
}

const ordinati = (v: string[]) => [...new Set(v)].sort()

/**
 * Il TETTO GLOBALE di upload del progetto Supabase: 50 MB.
 *
 * DOVE VIVE DAVVERO: pannello Supabase → Settings → Storage → «Global file size
 * limit». Non sta nel database del progetto, quindi il repo non può leggerlo: qui
 * è DICHIARATO, come la fotografia dei bucket, e come quella va tenuto aggiornato
 * a mano quando il pannello cambia.
 *
 * PERCHÉ ESISTE QUESTA COSTANTE. Supabase applica `min(limite del bucket, tetto
 * globale)`, e rifiuta con 400 `EntityTooLarge` qualunque `createBucket`/
 * `updateBucket` che dichiari un limite più alto — rifiutando l'INTERA chiamata,
 * quindi senza applicare nemmeno gli altri campi. Fino al 2026-09-01 tre bucket
 * dichiaravano 200 MB e `gallery/upload` li rispediva a ogni foto: 98 giorni di
 * richiusure di sicurezza mai avvenute e due `error` per ogni caricamento
 * riuscito, con il gate sempre verde. Nessun test guardava questo rapporto.
 *
 * DECISIONE DEL TITOLARE (2026-09-01): il tetto resta a 50 MB e non si alza — è
 * ciò che impedisce a un singolo video di mangiarsi lo spazio, ed è già il limite
 * che il client applica. Alzarlo è possibile (il piano Pro arriva a 500 GB): chi
 * lo facesse aggiorni QUESTO numero, altrimenti il lock diventa una bugia con
 * l'aria dell'autorevolezza.
 *
 * ─── ED È SUCCESSO ESATTAMENTE COSÌ ──────────────────────────────────────────
 * Il 2026-09-16, per preparare la pipeline video, il tetto è stato portato a
 * 2.000.000.000 in CI e in produzione. Questo numero non è stato aggiornato, e per
 * un giorno il lock è stato verde su una cifra falsa: il paragrafo qui sopra aveva
 * previsto il proprio guasto e non è bastato a impedirlo.
 *
 * RIMISURATO il 2026-09-17, non copiato da un documento:
 *   GET https://api.supabase.com/v1/projects/<ref>/config/storage
 *   → { "fileSizeLimit": 2000000000 }
 * Entitlement massimo del piano verificato: 536.870.912.000 byte; nessun cambio di
 * abbonamento. La decisione di alzarlo è del titolare, 2026-09-16, e ribalta quella
 * del 2026-09-01 per un motivo preciso: un originale video può arrivare a 2 GB, e
 * Supabase applica `min(limite del bucket, tetto globale)` — con 50 MiB globali i
 * bucket `video_originals` e `video_processing` sarebbero nati morti.
 *
 * ATTENZIONE, ed è il vero costo di questa riga: il tetto globale è GLOBALE. I
 * bucket che non dichiarano un `file_size_limit` proprio non hanno più 50 MiB di
 * soffitto, ne hanno 2 GB. Misurati in produzione il 2026-09-17: sono tre su
 * sedici — `certificati-medici`, `credenziali`, `fatture`.
 * Rimisurato il 2026-09-18 (`select count(*) filter (where file_size_limit is null),
 * count(*) from storage.buckets`): **ancora tre su sedici, gli stessi tre** — perché
 * la migrazione di ieri è scritta e non applicata. Il numero non è invecchiato; lo
 * si è riletto invece di copiarlo, che è l'unico modo di saperlo.
 *
 * FATTO lo stesso giorno, ed è la ragione per cui questo paragrafo non è più una
 * cosa da fare: la migrazione
 * `20260917233752_bucket_limite_esplicito_certificati_credenziali_fatture.sql` li
 * pinna (15 MiB · 4 MiB · 8 MiB, scelti dagli oggetti che ci sono davvero dentro), e
 * il `return` che qui sotto faceva saltare il controllo quando il limite dichiarato
 * era `null` non c'è più: adesso è rosso, a meno di una voce dichiarata in
 * `IN_ATTESA_DI_UN_LIMITE`. ⚠️ La migrazione è scritta, NON applicata — finché
 * qualcuno non la applica, in produzione quei tre limiti restano NULL. Questo lock
 * misura ciò che il repo DICHIARA; che sia anche applicato lo dice `IN_CODA` in
 * `migrazioni-complete.test.ts`.
 *
 * Questa costante resta una DICHIARAZIONE, non una misura: non c'è una fotografia
 * versionata del pannello. Finché non c'è, invecchia in silenzio come ha appena
 * fatto. Chi la tocca rifaccia la GET, non fidandosi di questo commento.
 */
const TETTO_GLOBALE_STORAGE_B = 2_000_000_000

/**
 * I bucket classificati che NESSUNA migrazione pinna ancora — dichiarati uno per uno,
 * con la misura e la ragione, come `IN_CODA` in `migrazioni-complete.test.ts`.
 *
 * ─── DAL 2026-09-18 QUESTA MAPPA È VUOTA, E VUOTA È IL SUO PUNTO D'ARRIVO ──────
 *
 * Ci stavano gli ultimi cinque: `cassa-giustificativi`, `chat-allegati`, `pagelle`,
 * `protocollo`, `sensitive_documents`. Li pinna
 * `20260918025900_bucket_limite_esplicito_cassa_chat_pagelle_protocollo_sensitive.sql`,
 * ai numeri che avevano già (10 MiB · 10 MiB · 10 MiB · 25 MiB · 15 MiB, riletti dal
 * database e non copiati da un documento), quindi in produzione quella migrazione non
 * cambia un solo valore. **Il guadagno non è un numero diverso: è che adesso il numero
 * esiste in un file.** Prima era vero finché nessuno lo cambiava dalla console — la
 * stessa garanzia che il 2026-09-16 non ha retto, quando il tetto globale è passato da
 * 50 MiB a 2 GB per i video e si è portato dietro tre archivi che con i video non
 * c'entravano niente.
 *
 * COSA SIGNIFICA PER CHI LEGGE OGGI: la prova qui sotto non ha più nessuna via
 * d'uscita. Un bucket in `RISERVATI` o in `PUBBLICI_PER_DECISIONE` senza
 * `file_size_limit` dichiarato in una migrazione è rosso, e l'unico modo di farlo
 * tacere è riaprire questa mappa e scriverci una misura — che è un gesto visibile in
 * revisione, non un silenzio.
 *
 * ⚠️ E QUELLO CHE UNA MAPPA VUOTA NON DIMOSTRA, detto prima che qualcuno ci si appoggi:
 * la prova gemella qui sotto gira su zero voci, quindi è verde per costruzione. Non è
 * lei a tenere in piedi la regola — è la prova principale, che adesso interroga tutti e
 * sedici i bucket classificati e non ne assolve nessuno. La gemella serve il giorno in
 * cui qualcuno riapre la mappa, e quel giorno pretenderà una ragione e un numero.
 * ⚠️ E questo lock misura ciò che il repo DICHIARA, non ciò che il database ha:
 * rimisurato il 2026-09-18, in produzione tre bucket su sedici hanno ancora
 * `file_size_limit = NULL` (`certificati-medici`, `credenziali`, `fatture`), perché la
 * migrazione di ieri è scritta e non applicata. Che sia anche applicata lo dice
 * `IN_CODA` in `migrazioni-complete.test.ts`, non questo file.
 *
 * ─── il meccanismo, che resta qui per il giorno in cui servirà di nuovo ────────
 *
 * PERCHÉ ESISTE QUESTA MAPPA, e perché non è un'assoluzione. Fino al 2026-09-17 il caso
 * «limite non dichiarato» usciva dal controllo qui sotto con un `return`: il lock si
 * spegneva da solo esattamente sui bucket che non dichiarano niente, cioè quelli che
 * avrebbe dovuto denunciare per primi. Adesso il silenzio non basta più — si scrive.
 *
 * QUELLO CHE UNA VOCE QUI DENTRO AMMETTE, detto per intero: quel bucket ha per tetto il
 * TETTO GLOBALE del progetto, e il tetto globale non si legge in nessun file del repo.
 * Il 2026-09-16 è passato da 52.428.800 a 2.000.000.000 per far entrare i video, e con
 * lui — senza che nessuno lo decidesse, e senza che nessuno riaprisse questo file — sono
 * passati da 50 MiB a 2 GB anche i bucket che un limite proprio non ce l'hanno.
 *
 * CHE COSA CI PUÒ STARE. Solo un bucket il cui limite, pur non essendo in una migrazione,
 * è comunque DICHIARATO nel repo e MISURATO in produzione: un `createBucket(…)` o una
 * guardia `file.size >` in una route lo scrive, e quel numero è quello che il database ha
 * davvero. È un tetto che esiste, ma che vive nel posto sbagliato — un `createBucket` su
 * un bucket che esiste già non viene mai eseguito, e una guardia applicativa vale solo
 * per la porta che la contiene: chiunque scriva nel bucket da un'altra strada non la
 * incontra. Va portato in migrazione; finché non lo è, sta scritto qui.
 *
 * CHE COSA NON CI PUÒ STARE: un bucket che in produzione ha `file_size_limit = NULL`. Per
 * quello non c'è niente da dichiarare — c'è una migrazione da scrivere, ed è quello che è
 * stato fatto il 2026-09-17 per `certificati-medici`, `credenziali` e `fatture`.
 * ⚠️ Questo lock NON può verificarlo da sé: la fotografia versionata porta l'id e la
 * visibilità, non il limite (`bucket-storage-fotografia.mjs` lascia fuori di proposito il
 * limite, che cambia spesso e non c'entra con la regola di sicurezza). Chi aggiunge una
 * voce qui dentro la misura sul database, e la misura la scrive — la prova gemella qui
 * sotto pretende che nella ragione ci sia il numero.
 *
 * COME MUORE UNA VOCE: da sola, il giorno in cui una migrazione pinna quel bucket. La
 * prova «non contiene voci morte» diventa rossa e la fa togliere, come fa `IN_CODA` in
 * `migrazioni-complete.test.ts` con le migrazioni che nel frattempo sono state applicate.
 * Un'esenzione che sopravvive al suo motivo è un buco che nessuno ricorda di aver aperto.
 */
const IN_ATTESA_DI_UN_LIMITE: Record<string, string | undefined> = {}

describe('lock architettura · i bucket dello storage sono dichiarati in migrazione', () => {
  it('le migrazioni si leggono davvero (sanity)', () => {
    // Un parser rotto renderebbe questo lock verde per sempre, su niente.
    expect(STATEMENT.length).toBeGreaterThan(100)
  })

  it('il tetto globale non è dichiarato due volte con due numeri diversi', () => {
    // LA SECONDA DICHIARAZIONE, e il giorno in cui è scaduta. `gallery-signed-url`
    // simula lo Storage rifiutando con `EntityTooLarge` qualunque `fileSizeLimit`
    // sopra il tetto globale: per farlo tiene una copia di QUESTO numero. Il
    // 2026-09-16 il globale è passato da 52.428.800 a 2.000.000.000 e quella copia
    // non l'ha seguito — per due giorni ha simulato uno Storage più stretto di
    // quello vero, senza che niente diventasse rosso, perché nessun bucket
    // dichiarava più di 50 MiB. Si è visto solo il 18/09, quando `gallery` è salito
    // a 2 GB per i video.
    //
    // Non si è spostata la costante in un file comune: `bucket-storage-dichiarati`
    // è un lock che legge i SORGENTI come testo, e farlo dipendere da un modulo
    // condiviso con i test funzionali gli darebbe un import che oggi non ha. Si
    // confrontano le due dichiarazioni — che è ciò che serviva: adesso la seconda
    // non può più invecchiare in silenzio.
    const gemella = costanteNumerica('__tests__/api/gallery-signed-url.test.ts', 'TETTO_GLOBALE_B')
    expect(gemella, '`TETTO_GLOBALE_B` deve esistere in `__tests__/api/gallery-signed-url.test.ts`.').not.toBeNull()
    expect(
      gemella,
      `\`gallery-signed-url.test.ts\` simula lo Storage con un tetto globale di ${gemella} byte, ` +
        `questo lock ne dichiara ${TETTO_GLOBALE_STORAGE_B}. Uno dei due è invecchiato: quel file ` +
        `respinge con \`EntityTooLarge\` ogni configurazione sopra il SUO numero, quindi se è più ` +
        `basso fa fallire bucket che in produzione nascerebbero benissimo — e se è più alto lascia ` +
        `passare configurazioni che in produzione verrebbero respinte per intero, \`public\` compreso. ` +
        `Rifai la GET \`/v1/projects/<ref>/config/storage\` e allinea entrambe le righe.`,
    ).toBe(TETTO_GLOBALE_STORAGE_B)
  })

  it('i commenti del codice non vengono scambiati per valori (sanity)', () => {
    // Se `senzaCommenti` smettesse di funzionare, ogni confronto «codice contro
    // migrazione» qui sotto potrebbe leggere un numero citato in una frase invece
    // di quello in vigore — verde o rosso a caso, e senza che si veda perché.
    const finto = [
      "// storicamente era fileSizeLimit: 999999999, e allowedMimeTypes: ['image/bmp']",
      '/* anche qui: fileSizeLimit: 888888888 */',
      "const VERO = ['image/jpeg'] // https://esempio.test/doc",
      'const opzioni = { fileSizeLimit: 123 }',
    ].join('\n')
    const pulito = senzaCommenti(finto)
    expect(pulito).not.toContain('999999999')
    expect(pulito).not.toContain('888888888')
    expect(pulito).not.toContain('image/bmp')
    expect(pulito.match(/fileSizeLimit:\s*(\d+)/)?.[1]).toBe('123')
    // Gli URL restano interi: il `//` di `https://` non è un commento.
    expect(pulito).toContain("const VERO = ['image/jpeg']")
  })

  describe('gallery — foto e video dei bambini, bucket privato', () => {
    it('ha un limite di dimensione dichiarato in migrazione', () => {
      expect(
        limiteDichiarato('gallery'),
        'Nessuna migrazione imposta `file_size_limit` sul bucket `gallery`: il limite vive ' +
          'solo dentro la route, che lo riscrive a ogni upload sperando che vada a buon fine.',
      ).not.toBeNull()
    })

    // ═════════════════════════════════════════════════════════════════════════
    // I TRE TETTI DELLA GALLERIA — e perché dal 2026-09-18 sono TRE e non uno
    // ═════════════════════════════════════════════════════════════════════════
    //
    // Fino al 17 settembre `gallery` aveva un numero solo, 52.428.800, ripetuto in
    // tre posti che dicevano tutti la stessa cosa: qui bastava confrontarli a due a
    // due e pretendere l'uguaglianza. Con i video quel numero si SDOPPIA, e i tre
    // posti smettono di descrivere la stessa regola:
    //
    //   ① quanto può pesare una FOTO — cioè quanto il BROWSER può spedire da sé.
    //      Resta 50 MiB, e il suo valore sta nell'essere PICCOLO;
    //   ② quanto può pesare un VIDEO — l'uscita già convertita e verificata, che
    //      nessun browser spedisce: la copia il finalizer con la chiave di servizio;
    //   ③ quanto il BUCKET permette al massimo, che è l'ultima rete e vale per
    //      TUTTE le porte, comprese quelle che ancora non esistono.
    //
    // ⚠️ IL MODO SBAGLIATO DI FARLE PASSARE, scritto qui perché è la tentazione che
    // si presenta per prima: allentare i due confronti in `<=` e chiamarla coerenza.
    // Un `<=` senza le uguaglianze accanto è verde su qualunque combinazione — il
    // tetto delle foto portato a 2 GB, il bucket allargato a piacere, la ricetta del
    // `createBucket` rimasta indietro di quaranta volte — e un lock che non può
    // diventare rosso non sta collaudando niente. Le tre prove qui sotto sono tre
    // perché le tre affermazioni sono tre, e ciascuna si può falsificare da sola.
    it('① la FOTO: quanto il BROWSER può spedire da sé, e non è il tetto del bucket', () => {
      const tettoFoto = costanteNumerica('src/lib/gallery/limiti.ts', 'TETTO_GALLERIA_BYTE')
      expect(tettoFoto, '`TETTO_GALLERIA_BYTE` deve esistere in `src/lib/gallery/limiti.ts`.').not.toBeNull()

      // Il client è il posto dove lo stesso numero ha un effetto VISIBILE: il file
      // viene rifiutato prima di partire. Se i due divergono, uno dei due mente —
      // e la differenza è esattamente la fascia di file che l'applicazione lascia
      // scegliere e il server poi rifiuta (o viceversa).
      //
      // ⚠️ LA LEZIONE DEL 2026-09-17, che questa prova ha ereditato da «il tetto che
      // il client applica è quello della Galleria» (assorbita qui il 18/09, per non
      // tenere due prove sullo stesso confronto): fino a quel giorno il tetto del
      // client si confrontava con quello GLOBALE dello Storage. Erano lo stesso
      // numero per coincidenza, non per una regola — e il giorno in cui il globale è
      // salito a 2 GB per i video, quel confronto avrebbe preteso dal client un
      // tetto di 2 GB, cioè avrebbe chiesto di ALLARGARE il client per far tacere un
      // lock. È esattamente il verso in cui un lock non deve mai spingere, ed è la
      // ragione per cui qui il confronto è con `TETTO_GALLERIA_BYTE` e il globale
      // resta soltanto un limite superiore.
      // ⚠️ RISCRITTA IL 2026-09-18 (V11), E NELLA DIREZIONE PIÙ STRETTA, NON PIÙ LARGA.
      //
      // Fino a oggi questa prova cercava nella pagina della Galleria docente un
      // `MAX_SIZE = N * 1024 * 1024` e ne confrontava il VALORE con la costante. Due
      // difetti, ed entrambi si sono visti lo stesso giorno:
      //
      //  1. cercava un LETTERALE, cioè pretendeva che il numero fosse scritto una
      //     seconda volta. Due dichiarazioni dello stesso tetto possono divergere per
      //     definizione, e il compito di questo lock era accorgersene DOPO. Adesso il
      //     client applica la COSTANTE, e per identità non può più divergere: non c'è
      //     un secondo numero da confrontare, c'è un solo numero da usare;
      //  2. leggeva il sorgente GREZZO, commenti compresi. Quando la pagina ha smesso
      //     di avere quel letterale, il lock è rimasto verde per un COMMENTO che
      //     raccontava com'era prima — misurato, non temuto: è la stessa forma con
      //     cui in questo repository un lock si è già immunizzato da solo, e sta nel
      //     PRD. Da qui in avanti si guarda `senzaCommenti`.
      //
      // ⚠️ E IL POSTO GIUSTO NON È PIÙ LA PAGINA. Da V11 i video non passano più dalla
      // porta delle foto (vanno in TUS verso `video_originals`, e il loro tetto è
      // quello della pipeline): l'unico punto in cui il BROWSER applica ancora questo
      // tetto è `caricaMediaGalleria`, che è la sola porta che un telefono usa da sé.
      //
      // LA LEZIONE DEL 2026-09-17 resta e vale: fino a quel giorno il tetto del client
      // si confrontava con quello GLOBALE dello Storage. Erano lo stesso numero per
      // coincidenza, non per una regola — e il giorno in cui il globale è salito a 2 GB
      // per i video, quel confronto avrebbe preteso dal client un tetto di 2 GB, cioè
      // avrebbe chiesto di ALLARGARE il client per far tacere un lock. È il verso in
      // cui un lock non deve mai spingere.
      const clientFoto = senzaCommenti(sorgente('src/lib/gallery/carica-media.ts'))
      expect(
        /file\.size\s*>\s*TETTO_GALLERIA_BYTE\b/.test(clientFoto),
        'Il caricatore del browser non confronta più la taglia con `TETTO_GALLERIA_BYTE`: ' +
          'il file parte e viene rifiutato dallo Storage a trasferimento finito, su rete ' +
          'mobile. È il tetto che deve dire di no PRIMA, e deve dirlo con la costante.',
      ).toBe(true)

      // E la pagina non deve reintrodurre un tetto SUO, scritto a mano: sarebbe una
      // seconda dichiarazione dello stesso numero, invisibile a questo confronto
      // proprio perché non passa dalla costante.
      const paginaDocente = senzaCommenti(sorgente('src/app/(dashboard)/teacher/gallery/page.tsx'))
      expect(
        /\d+\s*\*\s*1024\s*\*\s*1024/.test(paginaDocente),
        'La pagina della Galleria docente è tornata a scrivere un tetto in byte a mano. ' +
          'I tetti hanno un posto solo: `TETTO_GALLERIA_BYTE` per ciò che il browser ' +
          'spedisce da sé, `MAX_VIDEO_INPUT_BYTES` per ciò che entra nella pipeline video.',
      ).toBe(false)

      // E la porta che FIRMA i caricamenti diretti deve usare QUELLA costante, non
      // un numero suo: è il `.max()` dello zod, cioè l'unico punto in cui questo
      // tetto ha davvero un effetto lato server. Un letterale lì sarebbe una quarta
      // dichiarazione dello stesso numero, invisibile a tutti e tre i confronti.
      expect(
        /\.max\(\s*TETTO_GALLERIA_BYTE\b/.test(
          senzaCommenti(sorgente('src/app/api/gallery/upload-url/route.ts')),
        ),
        'La porta che firma i caricamenti diretti non usa `TETTO_GALLERIA_BYTE` nel suo ' +
          '`.max()`: il tetto delle foto è tornato a essere un numero scritto a mano, e ' +
          'nessuno dei confronti di questo file lo vedrebbe più cambiare.',
      ).toBe(true)

      // STRETTAMENTE sotto il tetto del bucket, e il `toBeLessThan` è voluto. Il
      // valore di questo numero sta nell'essere piccolo: è ciò che impedisce a un
      // telefono di riversare un gigabyte dentro il bucket delle foto dei bambini
      // senza che nessuno l'abbia convertito, verificato o guardato. Portarlo pari
      // al bucket «per semplificare» sarebbe un allargamento di quaranta volte
      // della porta rivolta al browser, ed è la cosa che questa riga deve rendere
      // impossibile da fare in silenzio: chi lo volesse davvero, riscriva questa
      // prova — che è un gesto visibile in revisione.
      expect(
        tettoFoto!,
        'Il tetto delle FOTO ha raggiunto quello del bucket. Sono due regole diverse: il ' +
          'bucket è largo per il video che il finalizer ci copia dentro con la chiave di ' +
          'servizio, non per ciò che un browser può spedire.',
      ).toBeLessThan(limiteDichiarato('gallery')!)
      expect(
        tettoFoto!,
        'Il tetto della Galleria supera il tetto globale dello Storage: Supabase applica ' +
          '`min(bucket, globale)` e quel numero non entrerebbe mai in vigore.',
      ).toBeLessThanOrEqual(TETTO_GLOBALE_STORAGE_B)
    })

    it('② il VIDEO: quanto pesa l’uscita convertita, ed è il numero della pipeline', () => {
      const tettoVideo = costanteNumerica('src/lib/gallery/limiti.ts', 'TETTO_VIDEO_GALLERIA_BYTE')
      expect(
        tettoVideo,
        '`TETTO_VIDEO_GALLERIA_BYTE` deve esistere in `src/lib/gallery/limiti.ts`: è il ' +
          'tetto di ciò che il finalizer copia dentro `gallery`.',
      ).not.toBeNull()

      // Non è un numero scelto in galleria: è quello che la pipeline si dà
      // sull'ingresso e che il database impone all'uscita (`video_jobs_output_chk`,
      // `video_job_ready`). Se divergessero, un job arriverebbe a `ready` — minuti
      // di conversione già pagati — e verrebbe respinto al momento della copia, che
      // è il posto più caro in cui scoprire un limite.
      const pipeline = costanteNumerica('src/lib/media/video/limiti.ts', 'MAX_VIDEO_INPUT_BYTES')
      expect(pipeline, '`MAX_VIDEO_INPUT_BYTES` deve esistere in `src/lib/media/video/limiti.ts`.').not.toBeNull()
      expect(
        tettoVideo,
        'Il tetto dei video della Galleria e quello della pipeline non coincidono più: la ' +
          'differenza è la fascia di video che vengono convertiti per intero e poi rifiutati ' +
          'al momento di entrare in galleria.',
      ).toBe(pipeline)

      // Una costante che nessuno APPLICA è decorazione: il lock la vedrebbe
      // coerente per sempre mentre il codice non la guarda. Il finalizer la usa per
      // rifiutare PRIMA di spedire i byte.
      expect(
        />\s*TETTO_VIDEO_GALLERIA_BYTE\b/.test(
          senzaCommenti(sorgente('src/lib/gallery/video-pubblicazione.ts')),
        ),
        'Il finalizer non confronta più niente con `TETTO_VIDEO_GALLERIA_BYTE`: la costante ' +
          'è diventata un numero che nessuno applica, e il rifiuto arriverebbe dallo Storage ' +
          'alla fine del trasferimento invece che prima.',
      ).toBe(true)

      expect(
        tettoVideo!,
        'Un video ammesso pesa più di quanto il bucket accetti: la copia del finalizer ' +
          'verrebbe respinta dopo che la conversione è già stata pagata.',
      ).toBeLessThanOrEqual(limiteDichiarato('gallery')!)
    })

    it('③ il BUCKET: ESATTAMENTE il più grande dei due, e la ricetta della route lo ripete', () => {
      const bucket = limiteDichiarato('gallery')
      const tettoFoto = costanteNumerica('src/lib/gallery/limiti.ts', 'TETTO_GALLERIA_BYTE')
      const tettoVideo = costanteNumerica('src/lib/gallery/limiti.ts', 'TETTO_VIDEO_GALLERIA_BYTE')
      expect(bucket).not.toBeNull()
      expect(tettoFoto).not.toBeNull()
      expect(tettoVideo).not.toBeNull()

      // LA RICETTA DEL `createBucket` è la seconda dichiarazione dello stesso
      // tetto, e vale nell'unico ambiente in cui la migrazione non è (ancora)
      // passata: uno nuovo. Se dicesse meno, quell'ambiente nascerebbe più stretto
      // della produzione e nessuno lo saprebbe finché un video non viene respinto.
      const ricetta = limiteNelCodice('src/app/api/gallery/upload/route.ts')
      expect(ricetta, 'La route deve dichiarare `fileSizeLimit`.').not.toBeNull()
      expect(
        ricetta,
        `La migrazione dichiara ${bucket} byte e il \`createBucket\` della route ${ricetta}: ` +
          'in un ambiente nuovo il bucket nascerebbe con il secondo numero, e il file che sta ' +
          'nel mezzo passerebbe i controlli dell\'applicazione per farsi respingere dallo Storage.',
      ).toBe(bucket)

      // NÉ PIÙ STRETTO NÉ PIÙ LARGO del più grande dei due tetti dichiarati.
      // `toBe` e non `toBeGreaterThanOrEqual`: il bucket è l'ultima rete e vale per
      // tutte le porte, anche quelle che non esistono ancora. Un bucket più largo
      // del necessario non abilita niente e toglie una rete — è esattamente la
      // ragione per cui questo aumento era stato rimandato dal 16 al 18 settembre.
      expect(
        bucket,
        `Il tetto del bucket (${bucket}) non è il più grande fra il tetto delle foto ` +
          `(${tettoFoto}) e quello dei video (${tettoVideo}). Se è più piccolo, qualcosa che ` +
          'il repo dichiara ammesso viene respinto dallo Storage; se è più grande, il bucket ' +
          'accetta silenziosamente file che nessuna regola scritta autorizza.',
      ).toBe(Math.max(tettoFoto!, tettoVideo!))

      expect(
        bucket!,
        `Il tetto del bucket supera quello globale di ${TETTO_GLOBALE_STORAGE_B}: Supabase ` +
          'applica `min(bucket, globale)` e quel numero non entrerebbe mai in vigore.',
      ).toBeLessThanOrEqual(TETTO_GLOBALE_STORAGE_B)
    })

    it('i tipi ammessi dal bucket sono ESATTAMENTE quelli che dichiara la route', () => {
      const codice = ordinati(mimeBucketNelCodice('src/app/api/gallery/upload/route.ts'))
      expect(codice.length, 'La route deve elencare i MIME in `allowedMimeTypes`.').toBeGreaterThan(0)
      expect(
        ordinati(mimeDichiarati('gallery')),
        'La migrazione e la route dichiarano tipi diversi per lo stesso bucket. Se il bucket è ' +
          'più stretto, il file viene respinto DOPO il caricamento e la maestra vede un errore ' +
          'generico; se è più largo, in un ambiente nuovo entrerebbe roba che qui non entra.',
      ).toEqual(codice)
    })

    // ── LA TERZA FONTE, dal 2026-09-07 ──────────────────────────────────────
    //
    // `POST /api/gallery/upload-url` firma caricamenti DIRETTI allo Storage (è il
    // rimedio al 413 di Vercel sui video) e valida il mime con `MIME_GALLERIA`, in
    // `src/lib/gallery/storage.ts`. Fino a ieri questo lock confrontava DUE fonti —
    // migrazione e route multipart — e la terza sarebbe nata fuori dalla sua vista:
    // una lista più larga qui firmerebbe caricamenti che lo Storage poi rifiuta, con
    // l'insegnante davanti a un errore che arriva DOPO aver spedito il file.
    it('la lista che FIRMA i caricamenti diretti è la stessa del bucket', () => {
      const firma = ordinati(mimeNelCodice('src/lib/gallery/limiti.ts', 'MIME_GALLERIA'))
      expect(firma.length, '`MIME_GALLERIA` deve elencare i tipi ammessi.').toBeGreaterThan(0)
      expect(
        ordinati(mimeDichiarati('gallery')),
        'La porta che firma i caricamenti diretti ammette tipi diversi da quelli del bucket: ' +
          'un file firmato qui verrebbe respinto dallo Storage DOPO essere stato spedito per ' +
          'intero — su rete mobile, dopo decine di megabyte.',
      ).toEqual(firma)
    })

    // ── LA PREMESSA DELLA NORMALIZZAZIONE, dal 2026-09-09 ────────────────────
    //
    // Tutto il rimedio al guasto del 2026-09-08 — `mimeBase()` in tre punti — poggia su
    // un'assunzione muta: che il BERSAGLIO del confronto sia canonico. Se un giorno una
    // di queste liste dichiarasse `video/mp4;codecs=avc1` o `Video/MP4`, normalizzare
    // l'ingresso non lo farebbe più combaciare, e si tornerebbe al 400 — con la
    // differenza che stavolta il codice sembrerebbe averlo già risolto.
    //
    // Questo test NON impedisce la ricomparsa del difetto (quella la misurano
    // `gallery-upload-url.test.ts` e `gallery-carica-media.test.ts`, che sono
    // comportamentali): afferma la premessa senza la quale quelli non vogliono dire
    // niente. Di più sarebbe teatro — un grep per `mimeBase(` sarebbe un lock per
    // PROSSIMITÀ, la specie che in questo repo è già rimasta verde con la forma
    // sbagliata rimessa a mano.
    it('le liste sono CANONICHE: nessun parametro, nessuna maiuscola', () => {
      const fonti: Array<[string, string[]]> = [
        ['la migrazione', mimeDichiarati('gallery')],
        ['la route multipart', mimeBucketNelCodice('src/app/api/gallery/upload/route.ts')],
        ['la porta che firma', mimeNelCodice('src/lib/gallery/limiti.ts', 'MIME_GALLERIA')],
      ]
      for (const [nome, lista] of fonti) {
        expect(
          lista.filter((m) => /[;\s]/.test(m) || m !== m.toLowerCase()),
          `${nome} dichiara un mime non canonico. La normalizzazione dell'ingresso ` +
            '(`mimeBase`) confronta contro QUESTA lista: un parametro o una maiuscola qui ' +
            'rimetterebbe in piedi il 400 del 2026-09-08, con il codice che sembra averlo risolto.',
        ).toEqual([])
      }
    })

    it('non ammette formati che una delle due piattaforme non riproduce', () => {
      // La regola dietro l'elenco, scritta come regola e non come elenco: qualunque
      // aggiunta futura deve passare di qui. `video/quicktime` è il caso che l'ha
      // motivata — il `.mov` dell'iPhone, che Android non apre — ma vale per tutti.
      const NON_UNIVERSALI = ['video/quicktime', 'video/x-matroska', 'image/heic', 'image/heif']
      for (const fonte of [mimeDichiarati('gallery'), mimeBucketNelCodice('src/app/api/gallery/upload/route.ts')]) {
        expect(
          fonte.filter((m) => NON_UNIVERSALI.includes(m.toLowerCase())),
          'In galleria finiscono foto e video che ogni famiglia deve poter aprire, su Android ' +
            'come su iOS. Questi formati non si vedono su entrambi: il client li converte prima ' +
            'di caricare e il server rifiuta con 415 ciò che è sfuggito — ammetterli nel bucket ' +
            'riaprirebbe la terza porta, quella che serve quando le prime due cedono.',
        ).toEqual([])
      }
    })

    it('è DICHIARATO privato da una migrazione, non solo chiuso a mano', () => {
      // Fino al 2026-09-01 non lo diceva nessun file del repo: il bucket è stato
      // chiuso dalla console il 31/07/2026, e da allora l'unica cosa che lo teneva
      // chiuso era che nessuno lo riaprisse. La fotografia della produzione, qui
      // sotto, si accorgerebbe di una riapertura — ma solo DOPO, e solo se
      // qualcuno la rigenera; e una ricostruzione da zero sarebbe ripartita senza
      // nessuna garanzia. Dentro ci sono foto e video di bambini.
      const dichiarata = visibilitaDichiarata('gallery')
      expect(
        dichiarata,
        'Nessuna migrazione dichiara la visibilità di `gallery`. Su un bucket pubblico lo ' +
          'Storage serve il file a chiunque conosca l\'indirizzo: niente login, niente ruolo, ' +
          'niente sede, per sempre.',
      ).not.toBeNull()
      expect(dichiarata?.pubblico).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // NESSUN LIMITE DICHIARATO PUÒ SUPERARE IL TETTO GLOBALE
  // ───────────────────────────────────────────────────────────────────────────

  describe('i limiti dichiarati stanno sotto il tetto globale del progetto', () => {
    it.each([...RISERVATI, ...Object.keys(PUBBLICI_PER_DECISIONE)])(
      '`%s` dichiara un limite che lo Storage può davvero accettare',
      (bucket) => {
        const dichiarato = limiteDichiarato(bucket)
        // ── IL LOCK NON SI SPEGNE PIÙ SUI BUCKET CHE NON DICHIARANO NIENTE ──────
        //
        // Qui c'era `if (dichiarato === null) return`, col commento «non tutti i
        // bucket dichiarano un limite». Era vero, e per questo era il difetto: il
        // controllo saltava proprio sui bucket senza limite, cioè sugli unici il cui
        // tetto non lo decide il repo. Un limite implicito non è «nessun limite»: è
        // il TETTO GLOBALE del progetto, che sta nel pannello di Supabase, che nessun
        // file di questa cartella può leggere e che cambia senza che nessuno riapra
        // questo test. Il 2026-09-16 è successo: da 50 MiB a 2 GB in un pomeriggio,
        // per i video, e con lui si sono allargati di quaranta volte tre archivi che
        // con i video non c'entrano niente — certificati medici di minori,
        // credenziali, fatture. Il lock era verde durante tutto il pomeriggio.
        if (dichiarato === null) {
          expect(
            Object.hasOwn(IN_ATTESA_DI_UN_LIMITE, bucket)
              ? (IN_ATTESA_DI_UN_LIMITE[bucket] ?? '')
              : null,
            `Nessuna migrazione dichiara \`file_size_limit\` per \`${bucket}\`: il suo tetto ` +
              `è quello GLOBALE del progetto — oggi ${TETTO_GLOBALE_STORAGE_B} byte — e quel ` +
              `numero non vive nel repo. Sta nel pannello di Supabase, lo cambia chi serve a ` +
              `un'altra funzionalità, e questo file non se ne accorge: il 2026-09-16 è passato ` +
              `da 52428800 a 2000000000 per la pipeline video, e ha allargato di quaranta ` +
              `volte anche i bucket che con i video non c'entrano. Scrivi una migrazione che ` +
              `pinni il limite di \`${bucket}\` al valore che vuoi davvero — oppure, se un ` +
              `tetto dichiarato nel repo esiste già ma sta in un \`createBucket\`, mettilo in ` +
              `\`IN_ATTESA_DI_UN_LIMITE\` con la misura di produzione e la ragione.`,
          ).not.toBeNull()
          return
        }
        expect(
          dichiarato,
          `La migrazione dichiara ${dichiarato} byte per \`${bucket}\`, sopra il tetto globale ` +
            `di ${TETTO_GLOBALE_STORAGE_B}. Supabase applica \`min(limite del bucket, tetto ` +
            `globale)\`: quel numero non entrerebbe mai in vigore, e sarebbe una regola scritta ` +
            `che non vale — il modo più silenzioso di mentire a chi legge il repo. Peggio: una ` +
            `\`createBucket\`/\`updateBucket\` che lo spedisse verrebbe respinta con 400 ` +
            `\`EntityTooLarge\` e non applicherebbe NESSUN campo, \`public\` compreso. ` +
            `O abbassi il numero, o alzi il tetto globale e aggiorni la costante qui sopra.`,
        ).toBeLessThanOrEqual(TETTO_GLOBALE_STORAGE_B)
      },
    )

    // ── LA PROVA GEMELLA: un'attesa che finisce, finisce anche qui ─────────────
    //
    // Stessa forma di «IN_CODA non contiene voci morte» in
    // `migrazioni-complete.test.ts`, e per la stessa ragione: la prova qui sopra si
    // ADDOLCISCE per ogni voce di `IN_ATTESA_DI_UN_LIMITE`, quindi senza qualcosa che
    // le faccia scadere, l'elenco diventa in sei mesi il posto dove si infila quello
    // che dà fastidio — e lo diventa senza che nessun test cambi colore.
    it('`IN_ATTESA_DI_UN_LIMITE` non contiene voci morte (né voci senza misura)', () => {
      const classificati = new Set<string>([...RISERVATI, ...Object.keys(PUBBLICI_PER_DECISIONE)])
      const morte = Object.keys(IN_ATTESA_DI_UN_LIMITE).filter(
        (b) => limiteDichiarato(b) !== null || !classificati.has(b),
      )
      expect(
        morte,
        `Queste voci non descrivono più un bucket «classificato e senza limite in ` +
          `migrazione»:\n  ${morte.join('\n  ')}\n` +
          `O una migrazione lo pinna ormai (allora l'attesa è finita: togli la voce), o il ` +
          `bucket non è più in \`RISERVATI\`/\`PUBBLICI_PER_DECISIONE\` (e allora questo file ` +
          `sta assolvendo un nome che non significa più niente).`,
      ).toEqual([])

      for (const [bucket, ragione] of Object.entries(IN_ATTESA_DI_UN_LIMITE)) {
        expect(
          (ragione ?? '').trim().length,
          `\`${bucket}\` è in attesa senza una ragione scritta. Scrivi DOVE vive oggi quel ` +
            `tetto, e perché non è ancora in una migrazione.`,
        ).toBeGreaterThan(60)
        // La MISURA, non l'impressione. Il limite non sta nella fotografia versionata:
        // l'unico modo perché una voce sia falsificabile è che porti il numero letto sul
        // database, così chi la rilegge può rifare la query e vedere se è ancora vero.
        expect(
          /\b\d{6,}\b/.test(ragione ?? ''),
          `La voce \`${bucket}\` non porta il valore misurato in produzione. Una voce senza ` +
            `numero non si può smentire: esegui \`select id, file_size_limit from ` +
            `storage.buckets where id = '${bucket}'\` e scrivi cosa hai letto.`,
        ).toBe(true)
      }
    })

    it('la route non spedisce allo Storage un limite che verrebbe respinto', () => {
      // IL GUASTO, misurato il 2026-09-01: `gallery/upload` mandava
      // `fileSizeLimit: 209715200` a ogni foto. Respinto 31 volte su 31, con due
      // righe `error` per ogni caricamento RIUSCITO — e, siccome il rifiuto è
      // sull'intera chiamata, `public: false` non è mai stato applicato: la
      // richiusura automatica del bucket non è avvenuta nemmeno una volta dal
      // 26/05/2026 al 01/09/2026.
      const codice = limiteNelCodice('src/app/api/gallery/upload/route.ts')
      expect(codice, 'La route deve dichiarare `fileSizeLimit`.').not.toBeNull()
      expect(
        codice,
        `La route dichiara ${codice} byte, sopra il tetto globale di ` +
          `${TETTO_GLOBALE_STORAGE_B}: la chiamata allo Storage verrebbe respinta per intero.`,
      ).toBeLessThanOrEqual(TETTO_GLOBALE_STORAGE_B)
    })
  })

  describe('news — media del blog pubblico', () => {
    it('il bucket è creato da una migrazione (non dall’upload)', () => {
      const creazione = statementDelBucket('news').filter((s) => /insert\s+into/i.test(s.sql))
      expect(
        creazione.map((s) => s.file),
        'Il bucket `news` non è dichiarato in nessuna migrazione. Senza, la prima chiamata a ' +
          '`api/news/upload` lo creerebbe al volo con le opzioni scritte nella route.',
      ).not.toEqual([])
    })

    it('ha un limite di dimensione dichiarato', () => {
      expect(limiteDichiarato('news')).not.toBeNull()
    })

    it('i tipi ammessi dal bucket sono ESATTAMENTE quelli che accetta la route', () => {
      const codice = ordinati(mimeNelCodice('src/app/api/news/upload/route.ts', 'MIME_AMMESSI'))
      expect(codice.length, 'La route deve elencare i MIME ammessi in `MIME_AMMESSI`.').toBeGreaterThan(0)
      expect(
        ordinati(mimeDichiarati('news')),
        'Il gate della route e il bucket devono dire la stessa cosa: se il bucket è più ' +
          'stretto il file viene respinto dopo il caricamento (500 opaco), se è più largo ' +
          'l\'unico controllo che resta è quello applicativo.',
      ).toEqual(codice)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATO SALVO ECCEZIONE DICHIARATA
  // ───────────────────────────────────────────────────────────────────────────

  describe('nessuna migrazione del repo riapre un bucket riservato', () => {
    it.each(RISERVATI)('`%s` non viene reso pubblico da nessuna migrazione', (bucket) => {
      const dichiarata = visibilitaDichiarata(bucket)
      expect(
        dichiarata?.pubblico === true ? `${bucket} ← ${dichiarata.file}` : null,
        `La migrazione \`${dichiarata?.file}\` rimette PUBBLICO il bucket \`${bucket}\`. Su un ` +
          'bucket pubblico lo Storage serve il file a chiunque conosca l\'indirizzo: niente ' +
          'login, niente ruolo, niente sede, per sempre — e l\'indirizzo è proprio quello che ' +
          'l\'applicazione manda al browser di ogni famiglia. Se la visibilità di questo bucket ' +
          'va davvero cambiata, è una decisione di prodotto: va spostato in ' +
          '`PUBBLICI_PER_DECISIONE` con la ragione scritta, in questo stesso file.',
      ).toBeNull()
    })

    it('la migrazione che ha chiuso gli allegati è ancora nel repo e dice `false`', () => {
      // Controllo POSITIVO del ramo UPDATE del parser: senza, «nessuno dichiara `true`»
      // sarebbe verde anche se il parser avesse smesso di leggere la colonna `public`
      // — cioè esattamente il difetto che questa parte del lock esiste per impedire.
      // E come effetto voluto: cancellare `20260731192108_allegati_avvisi_task_bucket_privati.sql`
      // da qui diventa rosso.
      for (const bucket of ['avvisi_allegati', 'task_allegati']) {
        const dichiarata = visibilitaDichiarata(bucket)
        expect(
          dichiarata,
          `Nessuna migrazione dichiara la visibilità di \`${bucket}\`: la migrazione che il ` +
            '2026-07-31 li ha resi privati è sparita dal repo. Il database resterebbe chiuso, ' +
            'ma una ricostruzione da zero (nuovo ambiente, disaster recovery) ripartirebbe con ' +
            'gli allegati aperti a chiunque.',
        ).not.toBeNull()
        expect(dichiarata?.pubblico).toBe(false)
      }
    })

    it('`news` è dichiarato pubblico — ed è l’unico (controllo positivo del parser)', () => {
      // Se il parser tornasse sempre `null` (regex rotta, colonne lette per vicinanza,
      // split degli statement sbagliato) la prova qui sopra sarebbe verde su niente.
      // Questa cade per prima.
      expect(
        visibilitaDichiarata('news')?.pubblico,
        'La migrazione `20260731192048_bucket_news.sql` dichiara `news` pubblico: se questa ' +
          'prova è rossa non è cambiata la sicurezza, è rotto il parser — e allora TUTTE le ' +
          'prove qui sopra sono verdi per finta.',
      ).toBe(true)
      expect(Object.keys(PUBBLICI_PER_DECISIONE)).toEqual(['news'])
    })

    it('ogni eccezione pubblica porta la sua ragione scritta', () => {
      for (const [bucket, ragione] of Object.entries(PUBBLICI_PER_DECISIONE)) {
        expect(
          ragione.trim().length,
          `\`${bucket}\` è nell'elenco dei pubblici senza una ragione scritta. Un'eccezione ` +
            'senza motivo è un\'eccezione che nessuno può rivedere: scrivi CHI ha deciso, ' +
            'QUANDO e PERCHÉ, e che cosa NON deve finire in quel bucket.',
        ).toBeGreaterThan(60)
      }
      expect(
        RISERVATI.filter((b) => b in PUBBLICI_PER_DECISIONE),
        'Un bucket non può stare in tutti e due gli elenchi.',
      ).toEqual([])
    })
  })

  describe('in produzione i bucket riservati sono davvero privati (fotografia versionata)', () => {
    it('la fotografia non è stata addomesticata a mano (sha256, DATA COMPRESA)', () => {
      // Stesse chiavi e stesso ordine di `impronta()` in
      // `__tests__/fixtures/bucket-storage-fotografia.mjs`. Senza questa prova
      // basterebbe correggere un `true` in `false` nel JSON per far tacere il lock
      // su un bucket riaperto.
      //
      // ⚠️ `generato_il` È DENTRO L'IMPRONTA dal 2026-08-16, e non è un dettaglio di
      // forma. `gdpr-oblio-completo.test.ts` concede una deroga a un bucket che «in
      // produzione non esiste ancora» — dentro ci andranno diagnosi, PEI, schede
      // sanitarie e posologie di minori — e quella deroga scade quando la fotografia
      // invecchia. Con la data fuori dall'impronta, la scadenza si spostava
      // riscrivendo dieci caratteri: una protezione che si disattiva da sé. Ora
      // l'unico modo di ringiovanire la fotografia è rigenerarla, cioè eseguire
      // davvero la query su `storage.buckets` — che è la misura che si voleva.
      const atteso = createHash('sha256')
        .update(JSON.stringify({ generato_il: foto.generato_il, bucket: foto.bucket }))
        .digest('hex')
      expect(
        foto.sha256,
        `Il contenuto della fotografia non corrisponde al suo sha256: qualcuno l'ha modificata ` +
          `a mano invece di rigenerarla dal database. ${COME_RIGENERARE}`,
      ).toBe(atteso)
    })

    it('la fotografia è piena e plausibile (se cade, il lock si sta autoingannando)', () => {
      // Un lock che gira su una fotografia vuota passa sempre: è il modo più silenzioso
      // di non controllare niente.
      expect(
        foto.bucket.length,
        `La fotografia contiene ${foto.bucket.length} bucket: troppo pochi per essere lo Storage ` +
          `di questo progetto (12 al 2026-07-31). ${COME_RIGENERARE}`,
      ).toBeGreaterThan(9)
      for (const b of foto.bucket) {
        expect(b.id, `id vuoto nella fotografia: ${JSON.stringify(b)}`).toBeTruthy()
        expect(typeof b.pubblico, `\`pubblico\` non è un booleano per \`${b.id}\``).toBe('boolean')
      }
      expect(new Set(foto.bucket.map((b) => b.id)).size, 'id duplicati').toBe(foto.bucket.length)
    })

    it.each(RISERVATI)('`%s` esiste in produzione ed è privato', (bucket) => {
      // Prima l'esistenza: un elenco di nomi che in produzione non ci sono farebbe
      // girare questa prova sul vuoto — verde, e cieca.
      expect(
        inProduzione.has(bucket),
        `Il bucket \`${bucket}\` non compare nella fotografia dello Storage. O è stato ` +
          `cancellato (allora toglilo da \`RISERVATI\`, e di' dove sono finiti i file), o la ` +
          `fotografia è vecchia. ${COME_RIGENERARE}`,
      ).toBe(true)
      expect(
        inProduzione.get(bucket),
        `In produzione il bucket \`${bucket}\` è PUBBLICO: lo Storage serve i suoi file a ` +
          `chiunque conosca l'indirizzo, senza login e per sempre. Richiudilo — ` +
          `\`update storage.buckets set public = false where id = '${bucket}'\` in una ` +
          `migrazione — oppure, se la scelta è voluta, spostalo in \`PUBBLICI_PER_DECISIONE\` ` +
          `con la ragione scritta. ${COME_RIGENERARE}`,
      ).toBe(false)
    })

    it('`news` è pubblico anche in produzione (controllo positivo della fotografia)', () => {
      // Se la fotografia fosse tutta `false` per un errore di lettura (colonna
      // sbagliata, `coalesce` di troppo, normalizzazione che schiaccia i valori), le
      // undici prove qui sopra sarebbero verdi senza aver guardato niente.
      expect(
        inProduzione.get('news'),
        'In produzione `news` non risulta pubblico: o la fotografia legge la colonna sbagliata ' +
          '— e allora le prove sui bucket riservati non verificano più niente — o il bucket è ' +
          'stato richiuso e le immagini degli articoli non si vedono più.',
      ).toBe(true)
    })

    it('nessun bucket sfugge alla classificazione', () => {
      // Il difetto di `news` era proprio questo: un bucket che nasceva da solo, al primo
      // caricamento, pubblico, senza che nessuno lo avesse deciso. Un bucket nuovo qui
      // resta rosso finché qualcuno non dice che cosa contiene.
      const noti = new Set<string>([...RISERVATI, ...Object.keys(PUBBLICI_PER_DECISIONE)])
      const sconosciuti = foto.bucket.map((b) => b.id).filter((id) => !noti.has(id))
      expect(
        sconosciuti,
        `Questi bucket esistono in produzione ma non sono classificati in questo file:\n` +
          `  ${sconosciuti.join('\n  ')}\n` +
          `Mettili in \`RISERVATI\` (il caso normale: qualunque cosa riguardi le famiglie o i ` +
          `bambini) oppure in \`PUBBLICI_PER_DECISIONE\` con la ragione scritta. Un bucket che ` +
          `nessuno ha classificato è un bucket di cui nessuno sa dire se è aperto al mondo.`,
      ).toEqual([])
    })

    it('il generatore della fotografia non legge i file del repo', () => {
      // Se la fotografia si ricavasse dalle migrazioni o dal sorgente, questo blocco
      // confronterebbe il repo con se stesso: verde per costruzione, cioè nessun
      // controllo. La fotografia è la verità del DATABASE. Il generatore riceve solo
      // testo su stdin — non si connette nemmeno da sé al database, perché `.env.local`
      // punta alla PRODUZIONE.
      expect(existsSync(GENERATORE), `manca il generatore ${GENERATORE}`).toBe(true)
      const codice = readFileSync(GENERATORE, 'utf8')
      for (const vietato of ['readdirSync', 'supabase/migrations', "'src'", 'src/app']) {
        expect(
          codice.includes(vietato),
          `Il generatore della fotografia contiene «${vietato}»: se ricava lo stato dei bucket ` +
            `dai file del repo invece che dal database, questo lock confronta il repo con se ` +
            `stesso e non verifica più niente.`,
        ).toBe(false)
      }
      // E deve nominare la tabella da cui la verità arriva davvero.
      expect(
        codice.includes('storage.buckets'),
        'Il generatore non nomina `storage.buckets`: da dove verrebbe la fotografia?',
      ).toBe(true)
    })
  })
})
