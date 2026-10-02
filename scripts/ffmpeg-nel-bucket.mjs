#!/usr/bin/env node
// =============================================================================
// LA BUILD DI FFMPEG NEL NOSTRO BUCKET — carica, rilegge, firma
//
// Dal 2026-10-02 FFmpeg non si scarica più da Internet: i due binari compressi
// (`ffmpeg.gz`, `ffprobe.gz`) vivono nel bucket PRIVATO `video_build` del nostro
// Supabase, insieme all'archivio BtbN da cui vengono (provenienza). Il runner e la
// CI li prendono da lì con URL firmati. Questo script è l'unico modo di metterceli
// e di fabbricare gli URL firmati che la CI tiene nei segreti.
// Perché, e che cosa è successo: `src/lib/media/video/build.ts` (testata) e
// `docs/superpowers/specs/2026-09-16-video-build-verificata.md`.
//
// ─── COME SI USA ─────────────────────────────────────────────────────────────
//
// La chiave di servizio NON sta in `.env.local` (quella non è del progetto) e non
// si passa mai da riga di comando: lo script la legge da STDIN, dentro il JSON che la
// CLI già autenticata stampa. Così non finisce né in `ps` né nella cronologia.
//
//   supabase projects api-keys --project-ref uimulkjyekgemjakmepp -o json \
//     | node scripts/ffmpeg-nel-bucket.mjs --carica --cartella <cartella>
//
//   supabase projects api-keys --project-ref uimulkjyekgemjakmepp -o json \
//     | node scripts/ffmpeg-nel-bucket.mjs --firma-ci ffmpeg | gh secret set CI_FFMPEG_GZ_URL
//
// La chiave si sceglie per NOME (`service_role`) o, in mancanza, per TIPO (`secret`).
//
// ─── LE DUE MODALITÀ ─────────────────────────────────────────────────────────
//
// --carica --cartella <dir>
//   La cartella contiene tre file: `ffmpeg.gz`, `ffprobe.gz`, `archivio-btbn.tar.xz`.
//   1. RIFIUTA di caricare se le impronte locali non sono quelle di `build.ts`: non
//      solo quelle dei file (SHA-256 dei due `.gz` e dell'archivio), ma anche quelle
//      dei binari che ne escono (`gzip -dc` e SHA-256 da capo). Si carica ciò che è
//      stato verificato, e nient'altro.
//   2. Carica con `upsert: false`: un oggetto già presente NON si sovrascrive (una
//      seconda esecuzione lo rilegge e lo riverifica soltanto). `contentType` è
//      `application/gzip` per i `.gz` e `application/x-xz` per l'archivio, gli unici
//      che il bucket accetta.
//   3. Rilegge OGNI oggetto dal bucket con un URL firmato e ne ricalcola
//      l'impronta da capo a fondo: «caricato» non vuol dire «integro».
//   Stampa solo nomi, byte e OK/KO. Esce 0 se tutto è OK, 1 altrimenti.
//
// --firma-ci ffmpeg|ffprobe
//   Scrive UN solo URL firmato, valido 365 giorni, sullo stdout, SENZA a capo, e solo
//   se stdout NON è un terminale: serve a finire in `| gh secret set …`, non a
//   schermo né nella cronologia. Su un terminale esce 2 con un messaggio. Prima di
//   scriverlo ne prova la lettura (una richiesta di un solo byte): un URL che non
//   funziona in un segreto romperebbe la CI settimane dopo, quando la cache scade.
//
// ─── COSA NON STAMPA MAI ─────────────────────────────────────────────────────
//
// Né la chiave, né un URL (firmato o no) — fuori dall'unico stdout della modalità
// `--firma-ci`. Anche i messaggi d'errore dell'SDK passano da `senzaSegreti`.
//
// Il repository è PUBBLICO: nessun segreto qui dentro, solo il riferimento del
// progetto (che è un identificatore, non una credenziale).
// =============================================================================

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { createClient } from '@supabase/supabase-js'

const RIFERIMENTO_PROGETTO = 'uimulkjyekgemjakmepp'
const URL_PROGETTO = `https://${RIFERIMENTO_PROGETTO}.supabase.co`

/** 365 giorni: la CI li usa solo a cache vuota, e la data di scadenza sta nel commento di `ci.yml`. */
const SECONDI_FIRMA_CI = 365 * 24 * 60 * 60
/** Il tempo che basta a rileggere un oggetto per verificarlo. */
const SECONDI_FIRMA_VERIFICA = 10 * 60

/**
 * I tre file della cartella di caricamento, e a quali costanti di `build.ts` rispondono.
 * I `.gz` portano anche l'impronta del binario che ne esce.
 */
const FILE_DA_CARICARE = [
  {
    file: 'ffmpeg.gz',
    percorso: 'PERCORSO_FFMPEG_GZ',
    sha256: 'FFMPEG_GZ_SHA256',
    sha256Binario: 'FFMPEG_SHA256',
    contentType: 'application/gzip',
  },
  {
    file: 'ffprobe.gz',
    percorso: 'PERCORSO_FFPROBE_GZ',
    sha256: 'FFPROBE_GZ_SHA256',
    sha256Binario: 'FFPROBE_SHA256',
    contentType: 'application/gzip',
  },
  {
    file: 'archivio-btbn.tar.xz',
    percorso: 'PERCORSO_ARCHIVIO_ORIGINALE',
    sha256: 'ARCHIVIO_FFMPEG_SHA256',
    sha256Binario: null,
    contentType: 'application/x-xz',
  },
]

const USO = `Uso:
  <JSON di \`supabase projects api-keys --project-ref ${RIFERIMENTO_PROGETTO} -o json\`> \\
    | node scripts/ffmpeg-nel-bucket.mjs --carica --cartella <cartella con ffmpeg.gz, ffprobe.gz, archivio-btbn.tar.xz>
    | node scripts/ffmpeg-nel-bucket.mjs --firma-ci ffmpeg|ffprobe | gh secret set CI_FFMPEG_GZ_URL`

/** Errore di utilizzo: esce 2. */
class ErroreUso extends Error {}
/** Un controllo che non torna: esce 1, e il messaggio è già scritto per essere letto. */
class ErroreKO extends Error {}

/** La chiave in uso, solo per poterla togliere da qualunque messaggio. Mai stampata. */
let chiaveInUso = null

/**
 * Toglie da un testo tutto ciò che non deve mai arrivare a un terminale o a un log:
 * la chiave, ogni JWT, ogni chiave `sb_…`, ogni `token=…` e ogni URL.
 */
function senzaSegreti(testo) {
  let pulito = String(testo ?? '')
  if (chiaveInUso) pulito = pulito.split(chiaveInUso).join('[chiave]')
  return pulito
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    .replace(/\bsb_(?:secret|publishable)_[\w-]+/g, '[chiave]')
    .replace(/token=[^&\s"']+/gi, 'token=[redatto]')
    .replace(/https?:\/\/\S+/gi, '[url]')
}

/** Come si descrive un errore dell'SDK senza dire più del dovuto: nome, stato, messaggio ripulito. */
function descriviErrore(errore) {
  if (!errore) return 'errore sconosciuto'
  const stato = errore.status ?? errore.statusCode
  return senzaSegreti(`${stato ? `HTTP ${stato}: ` : ''}${errore.message ?? errore.name ?? errore}`)
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE FUNZIONI PURE: argomenti, costanti di build.ts, scelta della chiave
 * ──────────────────────────────────────────────────────────────────────────── */

function leggiArgomenti(argv) {
  const caricare = argv.includes('--carica')
  const firmare = argv.includes('--firma-ci')
  if (caricare === firmare) {
    throw new ErroreUso('serve UNA modalità: --carica oppure --firma-ci')
  }

  if (caricare) {
    const indice = argv.indexOf('--cartella')
    const cartella = indice >= 0 ? argv[indice + 1] : undefined
    if (!cartella || cartella.startsWith('--')) {
      throw new ErroreUso('--carica vuole --cartella <dir>')
    }
    if (argv.length !== 3) throw new ErroreUso('argomenti non previsti')
    return { modo: 'carica', cartella: resolve(cartella) }
  }

  const quale = argv[argv.indexOf('--firma-ci') + 1]
  if (quale !== 'ffmpeg' && quale !== 'ffprobe') {
    throw new ErroreUso('--firma-ci vuole `ffmpeg` oppure `ffprobe`')
  }
  if (argv.length !== 2) throw new ErroreUso('argomenti non previsti')
  return { modo: 'firma', quale }
}

/**
 * Le costanti di `src/lib/media/video/build.ts`, lette COME TESTO.
 *
 * Non si importa il file, benché sia un `.ts` e le Node recenti lo carichino: `.nvmrc`
 * dice 22, e le Node 22.x prima della 22.18 non importano un `.ts` (lo strip dei tipi è
 * attivo di default solo dalla 22.18; senza, l'import muore con
 * `ERR_UNKNOWN_FILE_EXTENSION`). Lo script deve girare con un semplice
 * `node scripts/ffmpeg-nel-bucket.mjs`, su qualunque 22 e senza flag. Si tiene una sola
 * fonte (`build.ts`) invece di copiare i valori qui, dove divergerebbero in silenzio.
 * Il parser resta quello che è, e fallisce in modo esplicito: il formato che serve è uno
 * solo — `export const NOME =` seguito da una stringa fra apici o fra backtick, con al
 * massimo `${ALTRA_COSTANTE}` dentro — e se qualcosa non lo rispetta l'errore è alto e
 * subito, non un caricamento sbagliato.
 */
function leggiCostantiDiBuild() {
  const sorgente = readFileSync(new URL('../src/lib/media/video/build.ts', import.meta.url), 'utf8')
  // Via i commenti di blocco e le righe che iniziano con `//`: non i `//` dentro una stringa (gli URL).
  const codice = sorgente
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((riga) => !riga.trimStart().startsWith('//'))
    .join('\n')

  const costanti = {}
  for (const trovato of codice.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*(?:'([^']*)'|`([^`]*)`)/g)) {
    const [, nome, apici, backtick] = trovato
    costanti[nome] = (apici ?? backtick).replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, altra) => {
      if (!(altra in costanti)) throw new ErroreKO(`build.ts: ${nome} usa ${altra}, che non è definita prima`)
      return costanti[altra]
    })
  }

  const attese = ['BUCKET_BUILD_VIDEO', ...FILE_DA_CARICARE.flatMap((f) => [f.percorso, f.sha256, f.sha256Binario])].filter(Boolean)
  for (const nome of attese) {
    if (typeof costanti[nome] !== 'string' || costanti[nome] === '') {
      throw new ErroreKO(`build.ts: la costante ${nome} manca o non ha la forma attesa`)
    }
    if (nome.endsWith('SHA256') && !/^[0-9a-f]{64}$/.test(costanti[nome])) {
      throw new ErroreKO(`build.ts: ${nome} non è uno SHA-256 di 64 cifre esadecimali`)
    }
    if (nome.startsWith('PERCORSO_') && (costanti[nome].startsWith('/') || costanti[nome].includes('..'))) {
      throw new ErroreKO(`build.ts: ${nome} non è un percorso relativo pulito`)
    }
  }
  return costanti
}

/**
 * La chiave di servizio dentro il JSON di `supabase projects api-keys -o json`:
 * per nome (`service_role`), altrimenti per tipo (`secret`). Mai stampata.
 */
function sceltaDellaChiave(testoJson) {
  let voci
  try {
    voci = JSON.parse(testoJson)
  } catch {
    throw new ErroreKO('stdin non è JSON: serve l’uscita di `supabase projects api-keys --project-ref … -o json`')
  }
  if (!Array.isArray(voci)) throw new ErroreKO('stdin è JSON ma non è un elenco di chiavi')

  const candidate = voci.filter(
    (voce) => voce && typeof voce === 'object' && typeof voce.api_key === 'string' && voce.api_key !== '',
  )
  const scelta =
    candidate.find((voce) => voce.name === 'service_role' || voce.id === 'service_role') ??
    candidate.find((voce) => voce.type === 'secret')
  if (!scelta) {
    // Solo nomi e tipi, mai i valori.
    const viste = voci.map((voce) => `${voce?.name ?? '?'}/${voce?.type ?? '?'}`).join(', ')
    throw new ErroreKO(`nessuna chiave di servizio (nome service_role o tipo secret) fra: ${viste || 'nessuna voce'}`)
  }
  // Una chiave `secret` si stampa mascherata senza `--reveal`: la si riconosce dai caratteri.
  if (!/^[A-Za-z0-9._-]+$/.test(scelta.api_key)) {
    throw new ErroreKO('la chiave di servizio sembra mascherata: rilancia `supabase projects api-keys` con --reveal')
  }
  return scelta.api_key
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'I/O: stdin, impronte, Storage
 * ──────────────────────────────────────────────────────────────────────────── */

async function leggiStdin() {
  if (process.stdin.isTTY) {
    throw new ErroreUso('manca il JSON delle chiavi: va in pipe, dall’uscita di `supabase projects api-keys`')
  }
  const pezzi = []
  for await (const pezzo of process.stdin) pezzi.push(pezzo)
  return Buffer.concat(pezzi).toString('utf8')
}

/** SHA-256 e byte di un file, a flusso: un archivio da 150 MB non entra tutto in memoria per questo. */
async function improntaDelFile(percorso, { decomprimi = false } = {}) {
  const hash = createHash('sha256')
  let byte = 0
  const fasi = [createReadStream(percorso)]
  if (decomprimi) fasi.push(createGunzip())
  fasi.push(async (sorgente) => {
    for await (const pezzo of sorgente) {
      hash.update(pezzo)
      byte += pezzo.length
    }
  })
  await pipeline(...fasi)
  return { sha256: hash.digest('hex'), byte }
}

const abbreviata = (impronta) => `${impronta.slice(0, 12)}…`

/** Rilegge un oggetto dal bucket con un URL firmato e ne ricalcola l'impronta da capo a fondo. */
async function rileggiDalBucket(supabase, bucket, percorso) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(percorso, SECONDI_FIRMA_VERIFICA)
  if (error || !data?.signedUrl) return { ok: false, motivo: `firma fallita (${descriviErrore(error)})` }
  try {
    const risposta = await fetch(data.signedUrl)
    if (!risposta.ok || !risposta.body) return { ok: false, motivo: `lettura fallita (HTTP ${risposta.status})` }
    const hash = createHash('sha256')
    let byte = 0
    for await (const pezzo of risposta.body) {
      hash.update(pezzo)
      byte += pezzo.length
    }
    return { ok: true, byte, sha256: hash.digest('hex') }
  } catch (errore) {
    return { ok: false, motivo: `lettura fallita (${senzaSegreti(errore?.message ?? errore)})` }
  }
}

function eGiaPresente(errore) {
  return (
    String(errore?.statusCode) === '409' ||
    Number(errore?.status) === 409 ||
    /already exists|duplicate/i.test(String(errore?.message ?? ''))
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * --carica
 * ──────────────────────────────────────────────────────────────────────────── */

async function carica({ cartella }, build, supabase) {
  const bucket = build.BUCKET_BUILD_VIDEO
  let problemi = 0
  const dice = (riga) => console.log(riga)
  const ko = (riga) => {
    problemi += 1
    dice(`KO  ${riga}`)
  }

  // ── 1. le impronte locali, PRIMA di toccare la rete ──────────────────────────
  const locali = []
  for (const voce of FILE_DA_CARICARE) {
    const locale = join(cartella, voce.file)
    let byte
    try {
      const stato = statSync(locale)
      if (!stato.isFile()) throw new Error('non è un file')
      byte = stato.size
    } catch {
      ko(`${voce.file}: non trovato in ${cartella}`)
      continue
    }
    const { sha256 } = await improntaDelFile(locale)
    if (sha256 !== build[voce.sha256]) {
      ko(`${voce.file}: l’impronta (${abbreviata(sha256)}) non è quella di build.ts (${abbreviata(build[voce.sha256])})`)
      continue
    }
    if (voce.sha256Binario) {
      let binario = null
      let causa = ''
      try {
        binario = await improntaDelFile(locale, { decomprimi: true })
      } catch (errore) {
        causa = ` — ${senzaSegreti(errore?.message ?? errore)}`
      }
      if (!binario || binario.sha256 !== build[voce.sha256Binario]) {
        ko(`${voce.file}: ciò che esce da gzip -dc non è il binario di build.ts (${abbreviata(build[voce.sha256Binario])})${causa}`)
        continue
      }
    }
    dice(`OK  ${voce.file}: ${byte} byte, impronte locali come in build.ts`)
    locali.push({ ...voce, locale, byte })
  }
  if (problemi > 0) {
    dice('KO  non carico niente: i file locali non sono quelli di build.ts')
    return 1
  }

  // ── 2. il caricamento: upsert false, un oggetto presente non si tocca ────────
  const daRileggere = []
  for (const voce of locali) {
    const percorso = build[voce.percorso]
    const { error } = await supabase.storage
      .from(bucket)
      .upload(percorso, readFileSync(voce.locale), { contentType: voce.contentType, upsert: false })
    if (!error) {
      dice(`OK  ${voce.file}: caricato in ${bucket}/${percorso}`)
      daRileggere.push(voce)
    } else if (eGiaPresente(error)) {
      dice(`--  ${voce.file}: già presente in ${bucket}/${percorso}, non lo sovrascrivo`)
      daRileggere.push(voce)
    } else {
      // Un oggetto che non è arrivato non si rilegge: sarebbe un secondo KO per lo stesso guasto.
      ko(`${voce.file}: caricamento fallito (${descriviErrore(error)})`)
    }
  }

  // ── 3. la rilettura: «caricato» non vuol dire «integro» ──────────────────────
  for (const voce of daRileggere) {
    const percorso = build[voce.percorso]
    const letto = await rileggiDalBucket(supabase, bucket, percorso)
    if (!letto.ok) ko(`${voce.file}: ${letto.motivo}`)
    else if (letto.byte !== voce.byte) ko(`${voce.file}: nel bucket sono ${letto.byte} byte, in locale ${voce.byte}`)
    else if (letto.sha256 !== build[voce.sha256]) {
      ko(`${voce.file}: l’oggetto nel bucket ha un’impronta diversa (${abbreviata(letto.sha256)}); se era già presente va rimosso a mano prima di ricaricarlo`)
    } else dice(`OK  ${voce.file}: riletto dal bucket, ${letto.byte} byte, impronta come in build.ts`)
  }

  dice(problemi === 0 ? 'TUTTO OK' : `KO  ${problemi} problemi`)
  return problemi === 0 ? 0 : 1
}

/* ────────────────────────────────────────────────────────────────────────────
 * --firma-ci
 * ──────────────────────────────────────────────────────────────────────────── */

async function firma({ quale }, build, supabase) {
  const bucket = build.BUCKET_BUILD_VIDEO
  const percorso = quale === 'ffmpeg' ? build.PERCORSO_FFMPEG_GZ : build.PERCORSO_FFPROBE_GZ

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(percorso, SECONDI_FIRMA_CI)
  if (error || !data?.signedUrl) throw new ErroreKO(`firma di ${quale}.gz fallita (${descriviErrore(error)})`)

  // Un URL che non funziona dentro un segreto romperebbe la CI settimane dopo, a cache
  // vuota: lo si prova adesso con una richiesta di UN byte.
  let stato
  try {
    const risposta = await fetch(data.signedUrl, { headers: { range: 'bytes=0-0' } })
    stato = risposta.status
    await risposta.body?.cancel()
  } catch (errore) {
    throw new ErroreKO(`l’URL firmato di ${quale}.gz non si legge (${senzaSegreti(errore?.message ?? errore)})`)
  }
  if (stato !== 200 && stato !== 206) {
    throw new ErroreKO(`l’URL firmato di ${quale}.gz risponde HTTP ${stato}: l’oggetto manca dal bucket?`)
  }

  const scadenza = new Date(Date.now() + SECONDI_FIRMA_CI * 1000).toISOString().slice(0, 10)
  // L'URL è l'UNICA cosa che esce su stdout, senza a capo. Il resto, su stderr, non lo contiene.
  process.stdout.write(data.signedUrl)
  console.error(`firmato ${quale}.gz: 365 giorni, scade il ${scadenza}. Aggiornare la data nel commento di .github/workflows/ci.yml.`)
  return 0
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'INGRESSO
 * ──────────────────────────────────────────────────────────────────────────── */

async function main(argv) {
  const richiesta = leggiArgomenti(argv)

  // L'URL firmato non deve MAI finire a schermo né nella cronologia: si decide prima di
  // leggere la chiave o toccare la rete.
  if (richiesta.modo === 'firma' && process.stdout.isTTY) {
    throw new ErroreUso(
      'rifiuto di scrivere un URL firmato su un terminale: va in pipe, ad esempio `… | gh secret set CI_FFMPEG_GZ_URL`',
    )
  }

  const chiave = sceltaDellaChiave(await leggiStdin())
  chiaveInUso = chiave
  const build = leggiCostantiDiBuild()
  const supabase = createClient(URL_PROGETTO, chiave, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  return richiesta.modo === 'carica' ? carica(richiesta, build, supabase) : firma(richiesta, build, supabase)
}

main(process.argv.slice(2)).then(
  (codice) => {
    process.exitCode = codice
  },
  (errore) => {
    if (errore instanceof ErroreUso) {
      console.error(`${errore.message}\n\n${USO}`)
      process.exitCode = 2
    } else if (errore instanceof ErroreKO) {
      console.error(`KO  ${senzaSegreti(errore.message)}`)
      process.exitCode = 1
    } else {
      console.error(`KO  errore imprevisto: ${senzaSegreti(errore?.message ?? errore)}`)
      process.exitCode = 1
    }
  },
)
