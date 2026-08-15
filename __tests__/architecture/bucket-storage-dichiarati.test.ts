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
// PERCHÉ SU `gallery` SI CONFRONTA SOLO IL LIMITE. La lista dei tipi ammessi del
// bucket in produzione (che contiene `video/quicktime` e non contiene `image/gif`)
// diverge da quella della route: è un secondo disallineamento, REALE, che però
// cambierebbe cosa si può caricare e non è stato deciso. Sta nel rapporto, non qui
// dentro: un lock non è il posto dove prendere decisioni di prodotto di nascosto.
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

/** L'ULTIMO limite di dimensione dichiarato in migrazione per quel bucket. */
function limiteDichiarato(bucket: string): number | null {
  let ultimo: number | null = null
  for (const s of statementDelBucket(bucket)) {
    const inserito = valoriInsert(s.sql)?.file_size_limit
    if (inserito && /^\d+$/.test(inserito)) ultimo = Number(inserito)
    const assegnato = [...s.sql.matchAll(/file_size_limit\s*=\s*(\d+)/gi)]
    if (assegnato.length) ultimo = Number(assegnato[assegnato.length - 1][1])
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

/** `fileSizeLimit: 209715200` nel sorgente di una route. */
function limiteNelCodice(rel: string): number | null {
  const m = sorgente(rel).match(/fileSizeLimit:\s*(\d+)/)
  return m ? Number(m[1]) : null
}

/** I letterali MIME dentro `const <NOME> = [ … ]`. */
function mimeNelCodice(rel: string, costante: string): string[] {
  const m = sorgente(rel).match(new RegExp(`const\\s+${costante}\\s*=\\s*\\[([\\s\\S]*?)\\]`))
  if (!m) return []
  return [...m[1].matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((x) => x[1])
}

const ordinati = (v: string[]) => [...new Set(v)].sort()

describe('lock architettura · i bucket dello storage sono dichiarati in migrazione', () => {
  it('le migrazioni si leggono davvero (sanity)', () => {
    // Un parser rotto renderebbe questo lock verde per sempre, su niente.
    expect(STATEMENT.length).toBeGreaterThan(100)
  })

  describe('gallery — foto e video dei bambini, bucket privato', () => {
    it('ha un limite di dimensione dichiarato in migrazione', () => {
      expect(
        limiteDichiarato('gallery'),
        'Nessuna migrazione imposta `file_size_limit` sul bucket `gallery`: il limite vive ' +
          'solo dentro la route, che lo riscrive a ogni upload sperando che vada a buon fine.',
      ).not.toBeNull()
    })

    it('il limite della migrazione è lo stesso che dichiara la route', () => {
      const codice = limiteNelCodice('src/app/api/gallery/upload/route.ts')
      expect(codice, 'La route deve dichiarare `fileSizeLimit`.').not.toBeNull()
      expect(
        limiteDichiarato('gallery'),
        `La route accetta ${codice} byte, la migrazione ne dichiara altri: il file che sta ` +
          'nel mezzo passa i controlli dell\'applicazione e viene respinto dallo Storage.',
      ).toBe(codice)
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
