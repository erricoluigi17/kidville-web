#!/usr/bin/env node
/**
 * fotografia-galleria-guasta.mjs — che cosa è ROTTO, ORFANO o SCUCITO nella
 * galleria di PRODUZIONE, misurato adesso.
 *
 * ─── 🔴 SOLA LETTURA. NON SI AGGIUNGE MAI UNA SCRITTURA A QUESTO FILE. ────────
 * Nessun `DELETE`, nessun `UPDATE`, nessun `INSERT`, nessun `storage.remove()`,
 * nessun `upsert`, nessuna RPC che scriva. Chi arriva qui con l'idea di
 * "aggiungere anche la cancellazione, tanto la lista ce l'ho già" scriva un ALTRO
 * file: questo è l'unico strumento con cui si guarda PRIMA di toccare, e deve
 * poter essere eseguito da chiunque, in qualunque momento, senza chiedersi se
 * stavolta cancella. Un verificatore che può distruggere non lo si esegue più —
 * e allora non si verifica più niente.
 * Vale anche DOPO la pulizia: si riesegue, e i conteggi dicono se ha funzionato.
 *
 * ─── VINCOLI SUI DATI, perché sono dati di MINORI ────────────────────────────
 * In galleria ci sono foto e video di bambini. Questo file stampa SOLO:
 *   uuid · conteggi · byte · date · codici (MIME, esito) · impronte sha256.
 * NON stampa, e non deve mai stampare:
 *   · le DIDASCALIE (`caption`): testo libero scritto da un'insegnante, che
 *     quasi sempre contiene il nome del bambino;
 *   · i PERCORSI dei file nel bucket: in questo repo un percorso è una
 *     CREDENZIALE — `uploads/<utente>/<file>` più una firma apre la foto, e il
 *     bucket è privato dal 2026-07-31 proprio per questo;
 *   · nomi, email, codici fiscali, e il nome del file caricato dal telefono
 *     (che è a sua volta, spesso, il nome del bambino).
 * Stessa disciplina dei report di collaudo — `docs/collaudo/README.md`.
 * Dove serve distinguere un oggetto dall'altro fra due esecuzioni si usa
 * l'IMPRONTA: i primi 12 esadecimali dello `sha256` del percorso. Identifica
 * senza rivelare, e la parte casuale del nome la rende non invertibile.
 *
 * ─── CHE COSA MISURA ─────────────────────────────────────────────────────────
 *  1. MEDIA GUASTI — righe di `galleria_media_v2` il cui oggetto nello Storage
 *     pesa ≤ 1024 byte. Un JPEG da 775 byte non è una foto: è un file troncato
 *     che le famiglie vedono come riquadro rotto. Sono VISIBILI adesso.
 *  2. FILE ORFANI — oggetti del bucket `gallery` che NESSUNA riga nomina.
 *     ⚠️ Non sono tutti spazzatura: vedi il riquadro «CARICAMENTO IN DUE TEMPI».
 *  3. RIGHE SENZA FILE — righe la cui `file_url` non corrisponde ad alcun
 *     oggetto: la famiglia vede una voce che non si aprirà mai.
 *  4. SEGNALAZIONI ORFANE — righe di `segnalazioni` con `tipo_oggetto =
 *     'media_galleria'` il cui `oggetto_id` non esiste più. Una segnalazione UGC
 *     che punta al vuoto è una moderazione che non si può più istruire.
 *  5. RIEPILOGO con i totali e l'impronta dell'insieme, da confrontare fra due
 *     esecuzioni.
 * La sezione 0 dice anche quali OGGETTI SONO NOMINATI DA PIÙ DI UNA RIGA: non è
 * una curiosità, è una trappola per chi pulisce — cancellare l'oggetto «di» una
 * riga ne rompe un'altra che nessuno stava guardando.
 *
 * ─── IL CESTINO A 30 GIORNI, quando arriverà ─────────────────────────────────
 * `galleria_media_v2` sta per prendere `eliminato_il`, `eliminato_da` e
 * `file_rimosso_il`. Quelle colonne cambiano il SIGNIFICATO di due sezioni, non
 * il loro conteggio: una riga nel cestino non è più visibile alle famiglie
 * (sezione 1 la chiamerebbe urgente a torto), e una riga purgata NON HA il file
 * per progetto (sezione 3 la chiamerebbe un difetto a torto). Questo script le
 * chiede al database invece di darle per scontate: se non ci sono, PostgREST
 * risponde `42703` e si degrada allo stato di prima, dicendolo in chiaro nella
 * sezione 0. Una fotografia che diventa falsa il giorno di una migrazione non è
 * una fotografia: è una didascalia.
 *
 * ─── ⚠️ CARICAMENTO IN DUE TEMPI: un orfano GIOVANE non è spazzatura ─────────
 * Il caricamento di una foto sono DUE chiamate distinte:
 *   1. `POST /api/gallery/upload-url` → il file finisce nel bucket;
 *   2. `POST /api/gallery`            → nasce la riga in `galleria_media_v2`.
 * Fra le due c'è una finestra in cui l'oggetto esiste e la riga no. Un oggetto
 * caricato pochi minuti fa è quindi, con buona probabilità, una foto che
 * un'insegnante sta caricando in questo momento: cancellarla vuol dire farle
 * perdere la giornata. Per questo la sezione 2 separa gli orfani in
 * ATTENDIBILI (più vecchi della soglia) e SOSPESI (più giovani), e il totale
 * "recuperabile" conta SOLO i primi. La soglia si cambia con `--ore-di-grazia`.
 *
 * ─── USO ─────────────────────────────────────────────────────────────────────
 *   node scripts/fotografia-galleria-guasta.mjs
 *   node scripts/fotografia-galleria-guasta.mjs --ore-di-grazia 48
 *   node scripts/fotografia-galleria-guasta.mjs --soglia-byte 2048
 *
 * Credenziali: come `scripts/anagrafica-completa-2026.mjs` — prima
 * `~/kindertap-export/.env.runtime`, poi `.env.local` del repo. L'ordine non è
 * un vezzo: la `SUPABASE_SERVICE_ROLE_KEY` di `.env.local` è stata rifiutata dal
 * progetto con «Unregistered API key» (misurato il 2026-08-30), e una chiave nel
 * formato nuovo `sb_secret_…` fallisce con «Invalid Compact JWS». Ciò che è già
 * nell'ambiente vince su entrambi i file.
 *
 * ─── USCITA ──────────────────────────────────────────────────────────────────
 *   0 = niente da pulire · 1 = errore di lettura/credenziali
 *   3 = c'è qualcosa da pulire (guasti, orfani attendibili, righe senza file,
 *       segnalazioni orfane). Dopo una pulizia riuscita questo script deve
 *       uscire 0: è così che si verifica che abbia funzionato.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const RADICE = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const CARTELLA_LAVORO = join(homedir(), 'kindertap-export')

/** Il bucket. Sta scritto anche in `src/lib/gallery/limiti.ts` (`BUCKET_GALLERIA`). */
const BUCKET = 'gallery'

/**
 * Sotto quanti byte un oggetto non è una foto ma un file troncato.
 * 1024 e non 0: i tre guasti di produzione pesano 775 byte, cioè NON sono vuoti
 * — un controllo su `size = 0` non li vedrebbe. È il difetto tipico di questa
 * famiglia di guardie: guardare il caso estremo e mancare quello reale.
 */
const SOGLIA_BYTE_DEFAULT = 1024

/** Quanto tempo si concede a un caricamento in volo prima di chiamarlo orfano. */
const ORE_DI_GRAZIA_DEFAULT = 24

/** Quante voci per pagina si chiedono allo Storage. */
const PAGINA = 1000

/** Quanto in profondità si scende nel bucket. Oggi la forma è `uploads/<utente>/<file>`. */
const PROFONDITA_MASSIMA = 8

// ═══════════════════════════════════════════════════════════════════════════════
// Argomenti
// ═══════════════════════════════════════════════════════════════════════════════

function argomentoNumerico(nome, predefinito) {
    const i = process.argv.indexOf(nome)
    if (i === -1) return predefinito
    const v = Number(process.argv[i + 1])
    if (!Number.isFinite(v) || v < 0) {
        console.error(`✗ ${nome} vuole un numero ≥ 0, ricevuto: ${process.argv[i + 1] ?? '(niente)'}`)
        process.exit(1)
    }
    return v
}

const SOGLIA_BYTE = argomentoNumerico('--soglia-byte', SOGLIA_BYTE_DEFAULT)
const ORE_DI_GRAZIA = argomentoNumerico('--ore-di-grazia', ORE_DI_GRAZIA_DEFAULT)

// ═══════════════════════════════════════════════════════════════════════════════
// Credenziali
// ═══════════════════════════════════════════════════════════════════════════════

function caricaEnv() {
    for (const p of [join(CARTELLA_LAVORO, '.env.runtime'), join(RADICE, '.env.local')]) {
        if (!existsSync(p)) continue
        for (const riga of readFileSync(p, 'utf8').split('\n')) {
            const t = riga.trim()
            if (!t || t.startsWith('#') || !t.includes('=')) continue
            const i = t.indexOf('=')
            const k = t.slice(0, i).trim()
            if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim()
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utilità
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PostgREST NON lancia: ritorna `{ error }` (AGENTS.md regola 7). Senza questo
 * controllo un guasto di lettura diventerebbe un elenco vuoto, cioè «non c'è
 * niente di rotto» — che è il modo esatto in cui un verificatore smette di
 * verificare senza dirlo a nessuno. Si esce 1, non 0 e non 3: un errore di
 * lettura non è «pulito» e non è «da pulire», è «non lo so».
 */
function esito(cosa, res) {
    if (res.error) {
        const e = res.error
        console.error(`✗ ${cosa}: [${e.code ?? '—'}] ${e.message ?? e}`)
        if (e.details) console.error(`  dettagli: ${e.details}`)
        if (e.hint) console.error(`  suggerimento: ${e.hint}`)
        process.exit(1)
    }
    return res.data ?? []
}

/**
 * Il percorso nel bucket a partire da `file_url`. Specchio di
 * `percorsoNelBucket()` in `src/lib/gallery/storage.ts`, riscritto qui e non
 * importato: quel modulo tira `@/lib/logging/logger` → il client service-role di
 * Next, e uno script diagnostico non deve poter morire per la catena di import
 * del prodotto. La divergenza fra i due non resta nascosta: la sezione 0 conta
 * le forme di `file_url` trovate, e una forma inattesa si vede lì.
 *
 * Tre forme convivono nel dato: il percorso nudo (quello di oggi), l'URL
 * pubblico completo (le righe storiche, di quando il bucket era aperto) e l'URL
 * già firmato. Un indirizzo che non appartiene a questo bucket dà `null`:
 * inventarsi un percorso sarebbe peggio che ammettere di non saperlo.
 */
const RE_URL_STORAGE = new RegExp(`/storage/v1/object/(?:public|sign|authenticated)/${BUCKET}/([^?#]+)`)
const PERCENTUALI_BEN_FORMATE = /^(?:[^%]|%[0-9a-fA-F]{2})*$/

function percorsoNelBucket(fileUrl) {
    const valore = (fileUrl ?? '').trim()
    if (!valore) return null
    if (/^https?:\/\//i.test(valore)) {
        const m = RE_URL_STORAGE.exec(valore)
        if (!m) return null
        return PERCENTUALI_BEN_FORMATE.test(m[1]) ? decodeURIComponent(m[1]) : m[1]
    }
    return valore.replace(/^\/+/, '') || null
}

/** Identifica un oggetto fra due esecuzioni senza rivelarne il percorso. */
function impronta(testo) {
    return createHash('sha256').update(testo).digest('hex').slice(0, 12)
}

/** «1 alunno» / «2 alunni»: un plurale sbagliato fa dubitare del resto del numero. */
function plurale(n, singolare, plur) {
    return `${n} ${n === 1 ? singolare : plur}`
}

function byteLeggibili(n) {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

const ADESSO = Date.now()

/** Età in giorni interi, arrotondata per difetto. `null` se la data manca. */
function etaGiorni(iso) {
    if (!iso) return null
    const t = Date.parse(iso)
    if (Number.isNaN(t)) return null
    return Math.floor((ADESSO - t) / 86_400_000)
}

/** Età in ore, con un decimale. Serve per la finestra di grazia. */
function etaOre(iso) {
    if (!iso) return null
    const t = Date.parse(iso)
    if (Number.isNaN(t)) return null
    return (ADESSO - t) / 3_600_000
}

/** `2026-09-10 09:22 UTC` — data e ora al minuto, niente di più fino. */
function quando(iso) {
    if (!iso) return '—'
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function titolo(n, testo) {
    console.log('')
    console.log(`━━━ ${n}. ${testo} ${'━'.repeat(Math.max(0, 70 - testo.length))}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Il bucket, per intero
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cammina il bucket e restituisce `Map<percorso, {byte, mime, creato, aggiornato}>`.
 *
 * Ricorsivo e non a tre livelli fissi: oggi la forma è `uploads/<utente>/<file>`,
 * ma un camminatore che conosce la forma a memoria smette di vedere gli oggetti
 * il giorno che la forma cambia — e un oggetto non visto qui diventa una «riga
 * senza file» inventata nella sezione 3. Meglio scendere, e dire quanto si è scesi.
 *
 * `list()` mescola file e cartelle: le cartelle tornano con `id: null`.
 */
async function camminaBucket(db) {
    const oggetti = new Map()
    const visitate = new Set()
    let chiamate = 0
    let profonditaVista = 0
    const coda = [{ prefisso: '', livello: 0 }]

    while (coda.length) {
        const { prefisso, livello } = coda.shift()
        if (visitate.has(prefisso)) continue
        visitate.add(prefisso)
        if (livello > profonditaVista) profonditaVista = livello
        if (livello >= PROFONDITA_MASSIMA) {
            console.error(`✗ profondità oltre ${PROFONDITA_MASSIMA} livelli nel bucket: il`
                + ` conteggio degli oggetti sarebbe incompleto, e un oggetto non visto`
                + ` diventerebbe una «riga senza file» inesistente. Alzare PROFONDITA_MASSIMA.`)
            process.exit(1)
        }

        for (let offset = 0; ; offset += PAGINA) {
            chiamate++
            // `list` NON lancia: ritorna `{ error }`, come PostgREST.
            const { data, error } = await db.storage
                .from(BUCKET)
                .list(prefisso, { limit: PAGINA, offset, sortBy: { column: 'name', order: 'asc' } })
            if (error) {
                console.error(`✗ storage.list('${prefisso ? '…' : '(radice)'}', offset ${offset}):`
                    + ` ${error.message ?? error}`)
                process.exit(1)
            }
            const voci = data ?? []
            for (const v of voci) {
                const percorso = prefisso ? `${prefisso}/${v.name}` : v.name
                // Cartella: `id` nullo e nessun `metadata`. Si scende.
                if (v.id === null || v.id === undefined) {
                    coda.push({ prefisso: percorso, livello: livello + 1 })
                    continue
                }
                const grezzo = v.metadata?.size
                oggetti.set(percorso, {
                    // `size` assente = oggetto senza metadati: NON si finge che sia 0,
                    // altrimenti finirebbe fra i guasti per un difetto dei metadati.
                    byte: typeof grezzo === 'number' ? grezzo : null,
                    mime: v.metadata?.mimetype ?? null,
                    creato: v.created_at ?? null,
                    aggiornato: v.updated_at ?? null,
                })
            }
            if (voci.length < PAGINA) break
        }
    }
    return { oggetti, chiamate, profonditaVista }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Il giro
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    caricaEnv()
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    const chiave = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !chiave) {
        console.error('✗ Servono SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL) e'
            + ' SUPABASE_SERVICE_ROLE_KEY, nell\'ambiente o in .env.runtime/.env.local.')
        process.exit(1)
    }
    const db = createClient(url, chiave, { auth: { persistSession: false } })

    console.log('╔══════════════════════════════════════════════════════════════════════════════╗')
    console.log('║  FOTOGRAFIA DELLA GALLERIA — sola lettura, nessuna scrittura                 ║')
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝')
    console.log(`istante        : ${new Date(ADESSO).toISOString().replace(/\.\d+Z$/, 'Z')}`)
    console.log(`progetto       : ${url.replace(/^https?:\/\//, '').split('.')[0]}  (bucket «${BUCKET}»)`)
    console.log(`soglia guasto  : ≤ ${SOGLIA_BYTE} byte`)
    console.log(`ore di grazia  : ${ORE_DI_GRAZIA} h  (un orfano più giovane è «sospeso», non spazzatura)`)

    // ── Le sedi, per dare un nome allo uuid ───────────────────────────────────
    const sedi = new Map()
    for (const s of esito('lettura scuole', await db.from('scuole').select('id, nome'))) {
        sedi.set(s.id, s.nome)
    }
    const nomeSede = (id) => (id ? `${sedi.get(id) ?? '(sede ignota)'} · ${id}` : '(nessuna sede) · —')

    // ── Il CESTINO esiste? ────────────────────────────────────────────────────
    // `galleria_media_v2` sta per prendere tre colonne (`eliminato_il`,
    // `eliminato_da`, `file_rimosso_il`): il cestino a 30 giorni. Cambiano il
    // significato di due sezioni di questa fotografia, e in silenzio:
    //   · una riga NEL CESTINO non è «visibile alle famiglie» — la sezione 1 la
    //     chiamerebbe urgente quando non lo è;
    //   · una riga PURGATA (`file_rimosso_il` valorizzato) non ha più il file, ed
    //     è CORRETTO che sia così — la sezione 3 la chiamerebbe un difetto.
    // Quindi la si chiede, invece di darla per scontata in un verso o nell'altro.
    // Su un DB non ancora migrato PostgREST risponde `42703` in SELECT: è il modo
    // in cui questo repo pretende che il codice nuovo degradi (AGENTS.md).
    const sonda = await db.from('galleria_media_v2').select('eliminato_il, file_rimosso_il').limit(1)
    const cestino = !(sonda.error && sonda.error.code === '42703')
    if (sonda.error && sonda.error.code !== '42703') {
        esito('sonda colonne del cestino', sonda)
    }

    // ── Le righe di galleria_media_v2, tutte ──────────────────────────────────
    // `caption` NON si seleziona: non serve a niente qui, e ciò che non si legge
    // non si può stampare per sbaglio. Stessa ragione per `eliminato_da`.
    const COLONNE = 'id, uploaded_by, scuola_id, created_at, file_type, file_url, is_broadcast, tag_students, target_classes'
        + (cestino ? ', eliminato_il, file_rimosso_il' : '')
    const righe = []
    for (let da = 0; ; da += 1000) {
        const pagina = esito(
            `lettura galleria_media_v2 (${da}…)`,
            await db
                .from('galleria_media_v2')
                .select(COLONNE)
                .order('created_at', { ascending: true })
                .range(da, da + 999),
        )
        righe.push(...pagina)
        if (pagina.length < 1000) break
    }
    const nelCestino = (r) => cestino && r.eliminato_il !== null && r.eliminato_il !== undefined
    const filePurgato = (r) => cestino && r.file_rimosso_il !== null && r.file_rimosso_il !== undefined

    // ── Il bucket ─────────────────────────────────────────────────────────────
    const { oggetti, chiamate, profonditaVista } = await camminaBucket(db)

    // ── Le forme di file_url, per vedere una divergenza invece di subirla ─────
    let nudi = 0
    let urlCompleti = 0
    let nonInterpretabili = 0
    const percorsoDiRiga = new Map()
    const percorsiNominati = new Set()
    /** Quali righe nominano lo stesso percorso. Serve alla sezione 0. */
    const righePerPercorso = new Map()
    for (const r of righe) {
        const p = percorsoNelBucket(r.file_url)
        percorsoDiRiga.set(r.id, p)
        if (p === null) {
            nonInterpretabili++
            continue
        }
        percorsiNominati.add(p)
        if (!righePerPercorso.has(p)) righePerPercorso.set(p, [])
        righePerPercorso.get(p).push(r)
        if (/^https?:\/\//i.test((r.file_url ?? '').trim())) urlCompleti++
        else nudi++
    }
    const byteBucket = [...oggetti.values()].reduce((a, o) => a + (o.byte ?? 0), 0)

    titolo(0, 'COSA SI È GUARDATO')
    console.log(`righe galleria_media_v2   : ${righe.length}`)
    console.log(`oggetti nel bucket        : ${oggetti.size}  (${chiamate} chiamate a list, ${profonditaVista + 1} livelli)`)
    console.log(`byte nel bucket           : ${byteBucket} · ${byteLeggibili(byteBucket)}`)
    console.log(`forma di file_url         : ${nudi} percorsi nudi · ${urlCompleti} URL completi · ${nonInterpretabili} non interpretabili`)
    console.log(`percorsi distinti nominati: ${percorsiNominati.size}`)
    if (cestino) {
        const inCestino = righe.filter(nelCestino).length
        const purgate = righe.filter(filePurgato).length
        console.log(`cestino a 30 giorni       : presente · ${inCestino} righe nel cestino · ${purgate} già purgate (file rimosso)`)
    } else {
        console.log('cestino a 30 giorni       : ASSENTE su questo database (colonne non migrate, PostgREST 42703)')
        console.log('                            ogni riga qui sotto è quindi visibile, e ogni «Elimina» è definitivo.')
    }

    // ── Più righe sullo STESSO oggetto ────────────────────────────────────────
    // Non è una curiosità: è una trappola per chi pulisce. Cancellare l'oggetto
    // "di" una riga ne rompe un'altra che nessuno stava guardando, e la seconda
    // resterebbe viva in galleria come riquadro rotto. Va saputo PRIMA.
    const condivisi = [...righePerPercorso.entries()].filter(([, lista]) => lista.length > 1)
    if (condivisi.length) {
        console.log('')
        console.log(`⚠️  ${plurale(condivisi.length, 'oggetto', 'oggetti')} è nominato da più di una riga:`
            + ' cancellarlo ne romperebbe più di una.')
        for (const [percorso, lista] of condivisi.slice(0, 20)) {
            const o = oggetti.get(percorso)
            console.log(`    impronta ${impronta(percorso)} · ${byteLeggibili(o?.byte ?? 0)}`
                + ` · ${plurale(lista.length, 'riga', 'righe')}: ${lista.map((r) => r.id).join(', ')}`)
            console.log(`      sedi: ${[...new Set(lista.map((r) => nomeSede(r.scuola_id)))].join(' | ')}`)
            console.log(`      date: ${lista.map((r) => quando(r.created_at)).join(' | ')}`)
        }
        if (condivisi.length > 20) console.log(`    …e altri ${condivisi.length - 20}.`)
    }

    // ══ 1. MEDIA GUASTI ══════════════════════════════════════════════════════
    // Presenza nella galleria VECCHIA (`galleria_media`, la v1 dismessa): se lo
    // stesso file è nominato anche là, cancellarlo lascerebbe scucita anche quella.
    const percorsiV1 = new Set()
    const v1 = await db.from('galleria_media').select('url_file')
    if (v1.error) {
        // La v1 è dismessa: su un DB non migrato la tabella può non esserci
        // (PostgREST: 42P01). Non è un motivo per fermare tutta la fotografia, ma
        // tacere sarebbe peggio — la colonna «v1» diventerebbe un «no» inventato.
        console.log(`⚠️  galleria_media (v1) non leggibile: [${v1.error.code ?? '—'}] ${v1.error.message}`)
        console.log('    la colonna «v1» qui sotto dirà «?» invece di un no che non abbiamo misurato.')
    } else {
        for (const r of v1.data ?? []) {
            const p = percorsoNelBucket(r.url_file)
            if (p) percorsiV1.add(p)
        }
    }
    const v1Leggibile = !v1.error

    const tuttiGuasti = []
    for (const r of righe) {
        const p = percorsoDiRiga.get(r.id)
        if (!p) continue
        const o = oggetti.get(p)
        if (!o || o.byte === null) continue
        if (o.byte <= SOGLIA_BYTE) tuttiGuasti.push({ riga: r, oggetto: o, percorso: p })
    }
    // Un guasto nel cestino non è urgente: nessuno lo vede più. Tenerli insieme
    // gonfierebbe il numero che serve a decidere, ed è il numero che si guarda.
    const guasti = tuttiGuasti.filter((g) => !nelCestino(g.riga))
    const guastiCestinati = tuttiGuasti.filter((g) => nelCestino(g.riga))

    titolo(1, `MEDIA GUASTI — oggetto ≤ ${SOGLIA_BYTE} byte, ma la riga è VIVA`)
    if (guastiCestinati.length) {
        console.log(`(più ${plurale(guastiCestinati.length, 'riga guasta', 'righe guaste')} già nel cestino:`
            + ` nessuno le vede, non sono urgenti — ${guastiCestinati.map((g) => g.riga.id).join(', ')})`)
        console.log('')
    }
    if (guasti.length === 0) {
        console.log('nessuno. Ogni riga VIVA di galleria punta a un oggetto di peso plausibile.')
    } else {
        console.log(`${guasti.length} righe. Sono VISIBILI alle famiglie adesso: la riga esiste, il file è troncato.`)
        console.log('')
        for (const g of guasti) {
            const r = g.riga
            const visibile = r.is_broadcast
                ? 'TUTTA LA SEDE (broadcast)'
                : `${plurale((r.tag_students ?? []).length, 'alunno taggato', 'alunni taggati')}`
                  + ` · ${plurale((r.target_classes ?? []).length, 'classe', 'classi')}`
            console.log(`  media      ${r.id}`)
            console.log(`    uploader ${r.uploaded_by}`)
            console.log(`    sede     ${nomeSede(r.scuola_id)}`)
            console.log(`    data     ${quando(r.created_at)}  (${plurale(etaGiorni(r.created_at) ?? 0, 'giorno', 'giorni')})`)
            console.log(`    byte     ${g.oggetto.byte}  ·  MIME oggetto ${g.oggetto.mime ?? '—'}  ·  tipo dichiarato ${r.file_type ?? '—'}`)
            console.log(`    visibile ${visibile}`)
            console.log(`    v1       ${v1Leggibile ? (percorsiV1.has(g.percorso) ? 'SÌ — nominato anche da galleria_media (v1)' : 'no') : '? (v1 non leggibile)'}`)
            console.log(`    impronta ${impronta(g.percorso)}`)
            console.log('')
        }
        const perSede = new Map()
        const perUploader = new Set()
        for (const g of guasti) {
            perSede.set(g.riga.scuola_id, (perSede.get(g.riga.scuola_id) ?? 0) + 1)
            perUploader.add(g.riga.uploaded_by)
        }
        console.log(`  in sintesi : ${plurale(perSede.size, 'sede', 'sedi')}`
            + ` · ${plurale(perUploader.size, 'uploader distinto', 'uploader distinti')}`
            + ` · ${guasti.reduce((a, g) => a + g.oggetto.byte, 0)} byte in tutto`)
        for (const [sede, n] of [...perSede].sort((a, b) => b[1] - a[1])) {
            console.log(`               ${n} × ${nomeSede(sede)}`)
        }
    }

    // ══ 2. FILE ORFANI ═══════════════════════════════════════════════════════
    const orfani = []
    for (const [percorso, o] of oggetti) {
        if (percorsiNominati.has(percorso)) continue
        const rif = o.creato ?? o.aggiornato
        orfani.push({
            percorso,
            byte: o.byte ?? 0,
            byteIgnoti: o.byte === null,
            mime: o.mime,
            creato: rif,
            giorni: etaGiorni(rif),
            ore: etaOre(rif),
        })
    }
    orfani.sort((a, b) => String(a.creato).localeCompare(String(b.creato)))
    const sospesi = orfani.filter((o) => o.ore !== null && o.ore < ORE_DI_GRAZIA)
    const attendibili = orfani.filter((o) => !(o.ore !== null && o.ore < ORE_DI_GRAZIA))
    const sommaByte = (lista) => lista.reduce((a, o) => a + o.byte, 0)

    titolo(2, 'FILE ORFANI — oggetti che nessuna riga nomina')
    if (orfani.length === 0) {
        console.log('nessuno. Ogni oggetto del bucket è nominato da almeno una riga.')
    } else {
        console.log(`${orfani.length} oggetti · ${sommaByte(orfani)} byte · ${byteLeggibili(sommaByte(orfani))}`)
        console.log(`  ${attendibili.length} ATTENDIBILI (più vecchi di ${ORE_DI_GRAZIA} h) · ${sommaByte(attendibili)} byte · ${byteLeggibili(sommaByte(attendibili))}`)
        console.log(`  ${sospesi.length} SOSPESI (più giovani: forse un caricamento in volo — NON cancellare) · ${byteLeggibili(sommaByte(sospesi))}`)

        console.log('')
        console.log('  per mese di creazione')
        console.log('  mese      oggetti        byte  leggibile     dal          al           età max  età min')
        const perMese = new Map()
        for (const o of orfani) {
            const m = (o.creato ?? '????-??').slice(0, 7)
            if (!perMese.has(m)) perMese.set(m, [])
            perMese.get(m).push(o)
        }
        for (const [mese, lista] of [...perMese].sort((a, b) => a[0].localeCompare(b[0]))) {
            const date = lista.map((o) => (o.creato ?? '').slice(0, 10)).filter(Boolean).sort()
            const eta = lista.map((o) => o.giorni).filter((g) => g !== null)
            console.log(
                `  ${mese}  ${String(lista.length).padStart(7)}  ${String(sommaByte(lista)).padStart(10)}`
                + `  ${byteLeggibili(sommaByte(lista)).padStart(9)}`
                + `  ${(date[0] ?? '—').padEnd(11)}  ${(date[date.length - 1] ?? '—').padEnd(11)}`
                + `  ${String(eta.length ? Math.max(...eta) : '—').padStart(7)}  ${String(eta.length ? Math.min(...eta) : '—').padStart(7)}`,
            )
        }

        console.log('')
        console.log('  per età in giorni')
        console.log('  fascia            oggetti        byte  leggibile')
        const FASCE = [
            ['oggi (< 1 g)', (g) => g !== null && g < 1],
            ['1–7 giorni', (g) => g !== null && g >= 1 && g < 7],
            ['7–30 giorni', (g) => g !== null && g >= 7 && g < 30],
            ['30–90 giorni', (g) => g !== null && g >= 30 && g < 90],
            ['oltre 90 giorni', (g) => g !== null && g >= 90],
            ['data ignota', (g) => g === null],
        ]
        for (const [etichetta, dentro] of FASCE) {
            const lista = orfani.filter((o) => dentro(o.giorni))
            if (lista.length === 0) continue
            console.log(
                `  ${etichetta.padEnd(16)}  ${String(lista.length).padStart(7)}`
                + `  ${String(sommaByte(lista)).padStart(10)}  ${byteLeggibili(sommaByte(lista)).padStart(9)}`,
            )
        }

        // L'elenco uno per uno, per IMPRONTA e non per percorso: serve a
        // confrontare il «prima» col «dopo» senza che un percorso — che è una
        // credenziale — finisca in un terminale, in un report o in un incolla.
        console.log('')
        console.log('  uno per uno (impronta = sha256 del percorso, primi 12 esadecimali)')
        console.log('  impronta      giorni        byte  MIME                       stato')
        for (const o of orfani) {
            // Per i giovani le ORE, non i giorni: «0 giorni» non distingue un file
            // caricato due minuti fa da uno di ieri sera, ed è proprio lì che sta
            // la differenza fra spazzatura e la giornata di un'insegnante.
            const stato = o.ore !== null && o.ore < ORE_DI_GRAZIA
                ? `SOSPESO — ${o.ore.toFixed(1)} h (in volo?)`
                : 'attendibile'
            console.log(
                `  ${impronta(o.percorso)}  ${String(o.giorni ?? '—').padStart(6)}`
                + `  ${String(o.byteIgnoti ? '?' : o.byte).padStart(10)}  ${(o.mime ?? '—').padEnd(25)}  ${stato}`,
            )
        }
    }

    // ══ 3. RIGHE SENZA FILE ══════════════════════════════════════════════════
    const senzaOggetto = righe.filter((r) => {
        const p = percorsoDiRiga.get(r.id)
        return p !== null && !oggetti.has(p)
    })
    // Una riga PURGATA dal cestino non ha il file per progetto: è l'esito giusto
    // della purga, non un difetto. Contarla fra i difetti renderebbe questa
    // sezione permanentemente rossa e quindi illeggibile — e allora la si
    // smetterebbe di guardare, che è il modo in cui un difetto vero passa.
    const senzaFile = senzaOggetto.filter((r) => !filePurgato(r))
    const purgate = senzaOggetto.filter((r) => filePurgato(r))
    const illeggibili = righe.filter((r) => percorsoDiRiga.get(r.id) === null)

    titolo(3, 'RIGHE SENZA FILE — la voce esiste, l\'oggetto no')
    if (purgate.length) {
        console.log(`(più ${plurale(purgate.length, 'riga', 'righe')} con \`file_rimosso_il\` valorizzato:`
            + ' il file non c\'è perché la purga del cestino lo ha distrutto. È corretto, non è un difetto.)')
        console.log('')
    }
    if (senzaFile.length === 0 && illeggibili.length === 0) {
        console.log('nessuna. Ogni `file_url` corrisponde a un oggetto del bucket.')
    } else {
        if (senzaFile.length) {
            console.log(`${senzaFile.length} righe puntano a un oggetto che non c'è.`)
            for (const r of senzaFile) {
                console.log(`  media ${r.id} · uploader ${r.uploaded_by} · ${nomeSede(r.scuola_id)}`
                    + ` · ${quando(r.created_at)} · tipo ${r.file_type ?? '—'}`
                    + ` · impronta ${impronta(percorsoDiRiga.get(r.id))}`)
            }
        }
        if (illeggibili.length) {
            console.log(`${illeggibili.length} righe hanno una \`file_url\` che non si sa mappare su questo bucket`
                + ' (vuota, o un indirizzo di un altro bucket/CDN): non sono firmabili, quindi non si aprono.')
            for (const r of illeggibili) {
                console.log(`  media ${r.id} · uploader ${r.uploaded_by} · ${nomeSede(r.scuola_id)}`
                    + ` · ${quando(r.created_at)} · tipo ${r.file_type ?? '—'}`)
            }
        }
    }

    // ══ 4. SEGNALAZIONI ORFANE ═══════════════════════════════════════════════
    const segnalazioni = esito(
        'lettura segnalazioni media_galleria',
        // `motivo` e `note_gestione` NON si selezionano: testo libero, mai in chiaro.
        await db
            .from('segnalazioni')
            .select('id, scuola_id, oggetto_id, categoria, stato, creata_il')
            .eq('tipo_oggetto', 'media_galleria')
            .order('creata_il', { ascending: true }),
    )
    const idMedia = new Set(righe.map((r) => r.id))
    const segnOrfane = segnalazioni.filter((s) => !s.oggetto_id || !idMedia.has(s.oggetto_id))

    titolo(4, 'SEGNALAZIONI ORFANE — moderazione UGC che punta al vuoto')
    console.log(`segnalazioni con tipo_oggetto = 'media_galleria': ${segnalazioni.length}`)
    if (segnOrfane.length === 0) {
        console.log('nessuna orfana: ognuna punta a una riga che esiste ancora.')
    } else {
        console.log(`${segnOrfane.length} orfane:`)
        for (const s of segnOrfane) {
            console.log(`  segnalazione ${s.id} · ${nomeSede(s.scuola_id)} · ${quando(s.creata_il)}`
                + ` · categoria ${s.categoria} · stato ${s.stato}`
                + ` · oggetto_id ${s.oggetto_id ?? '(nullo)'}`)
        }
        console.log('  ⚠️ cancellare un media guasto CREA una di queste righe, se qualcuno lo aveva segnalato:')
        console.log('     questa sezione va riletta DOPO la pulizia, non solo prima.')
    }

    // ══ 5. RIEPILOGO ═════════════════════════════════════════════════════════
    // L'impronta dell'INSIEME: una riga sola da confrontare fra «prima» e «dopo».
    // Se la pulizia ha fatto qualcosa, cambia; se non ha fatto niente, resta
    // identica — ed è la differenza fra «ha funzionato» e «ha detto di sì».
    const improntaInsieme = impronta(
        JSON.stringify({
            guasti: guasti.map((g) => g.riga.id).sort(),
            orfani: orfani.map((o) => impronta(o.percorso)).sort(),
            senzaFile: senzaFile.map((r) => r.id).sort(),
            segnOrfane: segnOrfane.map((s) => s.id).sort(),
        }),
    )
    const daPulire = guasti.length + attendibili.length + senzaFile.length + illeggibili.length + segnOrfane.length

    const voce = (etichetta, valore) => console.log(`${etichetta.padEnd(46)}: ${valore}`)

    titolo(5, 'RIEPILOGO')
    voce('righe di galleria', righe.length)
    voce('oggetti nel bucket', oggetti.size)
    voce('oggetti nominati da più di una riga', condivisi.length)
    voce('cestino a 30 giorni', cestino ? `presente · ${righe.filter(nelCestino).length} righe dentro` : 'assente (colonne non migrate)')
    console.log('')
    voce(`1. media guasti (≤ ${SOGLIA_BYTE} B, VISIBILI alle famiglie)`,
        `${guasti.length}  ·  ${byteLeggibili(guasti.reduce((a, g) => a + g.oggetto.byte, 0))}`)
    if (guastiCestinati.length) voce('   più guasti già nel cestino (non urgenti)', guastiCestinati.length)
    voce('2. file orfani, in tutto', `${orfani.length}  ·  ${byteLeggibili(sommaByte(orfani))}`)
    voce(`   di cui attendibili (più di ${ORE_DI_GRAZIA} h)`, `${attendibili.length}  ·  ${byteLeggibili(sommaByte(attendibili))}`)
    voce('   di cui sospesi, forse un caricamento in volo', `${sospesi.length}  ·  ${byteLeggibili(sommaByte(sospesi))}`)
    voce('3. righe senza file', senzaFile.length)
    if (purgate.length) voce('   più righe purgate dal cestino (corretto)', purgate.length)
    voce('   righe con file_url non interpretabile', illeggibili.length)
    voce('4. segnalazioni orfane', `${segnOrfane.length}  (su ${segnalazioni.length} di galleria)`)
    console.log('')
    voce("impronta dell'insieme", improntaInsieme)
    voce('recuperabile cancellando gli orfani attendibili', byteLeggibili(sommaByte(attendibili)))
    console.log('')
    if (daPulire === 0) {
        console.log('✓ niente da pulire.')
        process.exit(0)
    }
    console.log(`✗ ${daPulire} elementi da sanare. Questo script non li tocca: è di sola lettura.`)
    console.log('  Dopo la pulizia si riesegue: deve uscire 0, e l\'impronta dell\'insieme deve cambiare.')
    process.exit(3)
}

main().catch((e) => {
    // Un'eccezione qui è di TRASPORTO (rete, DNS, chiave malformata): PostgREST e
    // lo Storage non lanciano, ritornano `{ error }`, e quelli sono già gestiti sopra.
    console.error(`✗ errore inatteso: ${e?.message ?? e}`)
    if (e?.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
    process.exit(1)
})
