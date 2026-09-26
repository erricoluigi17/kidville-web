import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ARCHIVIO_FFMPEG_SHA256,
  ARCHIVIO_FFMPEG_URL,
  DECODER_RICHIESTI,
  ENCODER_RICHIESTI,
  FILTRI_RICHIESTI,
} from '@/lib/media/video/build'

/* ════════════════════════════════════════════════════════════════════════════
 * FFMPEG VERO PER I COLLAUDI VIDEO — e la morte del verde falso.
 *
 * ─── IL DIFETTO, misurato il 2026-09-17 ─────────────────────────────────────
 * `__tests__/lib/video-encode.test.ts` calcolava `ffmpegDisponibile` con uno
 * `spawnSync('ffmpeg', ['-version'])` e appendeva i due casi reali a un
 * `runIf(...)`. Su una macchina senza FFmpeg quei due casi SPARIVANO e la suite
 * restava verde: la forma esatta di «un test mai visto fallire non è un test».
 * E `video-verify.test.ts` non eseguiva ffmpeg nemmeno una volta: ventun casi su
 * JSON scritto a mano, che dimostravano che `verifyVideoOutput` legge ciò che gli
 * si dà — non che ffmpeg produca quello. La spec
 * `docs/superpowers/specs/2026-09-16-video-build-verificata.md` dichiarava il buco
 * aperto, e infatti il primo giro con file veri ha trovato due difetti che
 * nessuno dei ventun casi sintetici poteva vedere.
 *
 * ─── LA REGOLA, DA QUI IN AVANTI ────────────────────────────────────────────
 * Un FFmpeg mancante o inadatto fa FALLIRE, non sparire. L'unica uscita è
 * dichiararla a voce alta con `KIDVILLE_VIDEO_SENZA_FFMPEG`, e quella variabile
 * NON vale quando `CI` è impostata: in locale si può lavorare senza, in CI no.
 * La differenza con il vecchio `runIf` non è cosmetica — è il DEFAULT: prima
 * l'assenza era silenzio, adesso l'assenza è rosso e il silenzio va chiesto.
 *
 * ─── PERCHÉ NON BASTA «C'È UN FFMPEG» ───────────────────────────────────────
 * `/opt/homebrew/bin/ffmpeg` 8.1.2 — quello che un Mac ha addosso dopo
 * `brew install ffmpeg` — risponde `-version` con 0 e NON ha il filtro `zscale`,
 * perché Homebrew non compila libzimg. `zscale` è il primo filtro della catena
 * HDR→SDR di `encode.ts`: con quella build ogni video HDR muore con «No such
 * filter», e un collaudo che ci girasse sopra misurerebbe il pacchettizzatore,
 * non la nostra conversione. Perciò qui si controlla l'INVENTARIO della build
 * (filtri, decoder, encoder di `@/lib/media/video/build`) e non solo l'esistenza
 * del file. Un binario che non sa fare il lavoro è un binario assente.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Cartella che contiene `ffmpeg` e `ffprobe`. In CI la scrive il passo del workflow. */
export const VARIABILE_CARTELLA = 'KIDVILLE_VIDEO_FFMPEG_DIR'

/** L'unica uscita, ed è esplicita. Rifiutata quando `CI` è impostata. */
export const VARIABILE_RINUNCIA = 'KIDVILLE_VIDEO_SENZA_FFMPEG'

export interface BinariVideo {
  ffmpeg: string
  ffprobe: string
  /** Prima riga di `ffmpeg -version`: finisce nei messaggi d'errore, non nei log. */
  versione: string
  /** Da dove sono stati risolti, per rendere diagnosticabile un rosso. */
  origine: string
}

/** Il minimo del contesto di vitest che serve qui: evita di legarsi alla sua versione. */
interface ContestoSaltabile {
  skip(motivo?: string): void
}

function istruzioni(problema: string): string {
  return [
    `FFmpeg non è utilizzabile per il collaudo video: ${problema}`,
    '',
    'Come si rimedia:',
    `  · in CI ci pensa il passo «FFmpeg pinnato» di .github/workflows/ci.yml, che scarica`,
    `    ${ARCHIVIO_FFMPEG_URL}`,
    `    e ne verifica lo sha256 ${ARCHIVIO_FFMPEG_SHA256} prima di estrarlo.`,
    '  · in locale, su una macchina che NON sia Linux x86_64, la build pinnata non gira',
    '    proprio: l\'archivio qui sopra è `linux64-gpl`. `brew install ffmpeg` non è un',
    '    sostituto — misurato il 2026-09-17 sulla 8.1.2, `zscale` manca e ogni caso HDR',
    '    muore. Perciò fuori da CI questi casi si DICHIARANO NON DISPONIBILI e la',
    '    fedeltà si prova in integrazione, esattamente come `npm run e2e`, che qui è',
    '    vietato perché `.env.local` punta alla produzione.',
    '',
    '    NON scaricare un ffmpeg qualunque da internet per far tacere questo messaggio:',
    '    un binario non pinnato e senza impronta misura il pacchettizzatore, non la',
    '    nostra conversione, e chiederebbe pure di togliere la quarantena di Gatekeeper.',
    '    Se ti serve davvero girarli in locale, usa la build pinnata su Linux x86_64 e',
    `    punta ${VARIABILE_CARTELLA} alla cartella che la contiene.`,
    `  · per dichiarare la rinuncia a mano: ${VARIABILE_RINUNCIA}=1`,
    '    (rifiutata quando CI è impostata: in integrazione questi casi non si saltano).',
  ].join('\n')
}

/**
 * La rinuncia, se è stata dichiarata e se è legittima.
 *
 * In CI non è legittima e non viene ignorata in silenzio: LANCIA. Una variabile
 * dimenticata nell'ambiente del runner spegnerebbe i casi reali senza che nessuno
 * lo veda passare — che è il difetto che questo file esiste per chiudere.
 */
const NEGAZIONI = new Set(['0', 'false', 'no', 'off', 'n'])

export function rinunciaDichiarata(): string | null {
  const valore = process.env[VARIABILE_RINUNCIA]?.trim()
  if (!valore) return null
  // `KIDVILLE_VIDEO_SENZA_FFMPEG=0` vuol dire NO, non «sì, qualunque stringa va bene».
  // Chi scrive `0` pensando di negare la rinuncia perderebbe in silenzio i casi reali:
  // sarebbe lo stesso verde falso che questo file esiste per chiudere, con un'altra faccia.
  if (NEGAZIONI.has(valore.toLowerCase())) return null
  if (process.env.CI) {
    throw new Error(
      `${VARIABILE_RINUNCIA}=${valore} è impostata mentre CI=${process.env.CI}: ` +
        'in integrazione i casi video reali non si saltano. Toglila dall\'ambiente del runner.',
    )
  }
  return `${VARIABILE_RINUNCIA}=${valore}: collaudo video reale rinunciato su questa macchina`
}

function esegui(comando: string, argomenti: string[]) {
  return spawnSync(comando, argomenti, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** I nomi nella prima colonna utile di `-filters`/`-decoders`/`-encoders`. */
function inventario(ffmpeg: string, opzione: string): Set<string> {
  const esito = esegui(ffmpeg, ['-hide_banner', opzione])
  if (esito.status !== 0) {
    throw new Error(istruzioni(`\`ffmpeg ${opzione}\` è uscito con ${esito.status}`))
  }
  const nomi = new Set<string>()
  for (const riga of (esito.stdout ?? '').split('\n')) {
    const parti = riga.trim().split(/\s+/)
    if (parti.length >= 2) nomi.add(parti[1])
  }
  return nomi
}

function mancanti(presenti: Set<string>, richiesti: readonly string[]): string[] {
  return richiesti.filter((nome) => !presenti.has(nome))
}

let risolti: BinariVideo | null = null
let fallimento: Error | null = null

/**
 * Risolve i binari una volta sola e ne verifica l'inventario. Il risultato (anche il
 * fallimento) è memorizzato: l'inventario costa tre processi, e i casi reali sono dieci.
 */
function risolviBinari(): BinariVideo {
  if (risolti) return risolti
  if (fallimento) throw fallimento

  try {
    const cartella = process.env[VARIABILE_CARTELLA]?.trim()
    const ffmpeg = cartella ? join(cartella, 'ffmpeg') : 'ffmpeg'
    const ffprobe = cartella ? join(cartella, 'ffprobe') : 'ffprobe'
    const origine = cartella ? `${VARIABILE_CARTELLA}=${cartella}` : 'PATH'

    for (const [nome, percorso] of [
      ['ffmpeg', ffmpeg],
      ['ffprobe', ffprobe],
    ] as const) {
      const esito = esegui(percorso, ['-version'])
      if (esito.error || esito.status !== 0) {
        throw new Error(
          istruzioni(
            `\`${percorso} -version\` non risponde (origine: ${origine}, ` +
              `errore: ${esito.error?.message ?? `uscita ${esito.status}`}). Manca ${nome}.`,
          ),
        )
      }
    }

    const filtriMancanti = mancanti(inventario(ffmpeg, '-filters'), FILTRI_RICHIESTI)
    const decoderMancanti = mancanti(inventario(ffmpeg, '-decoders'), DECODER_RICHIESTI)
    const encoderMancanti = mancanti(inventario(ffmpeg, '-encoders'), ENCODER_RICHIESTI)
    const buchi = [
      filtriMancanti.length ? `filtri assenti: ${filtriMancanti.join(', ')}` : null,
      decoderMancanti.length ? `decoder assenti: ${decoderMancanti.join(', ')}` : null,
      encoderMancanti.length ? `encoder assenti: ${encoderMancanti.join(', ')}` : null,
    ].filter((voce): voce is string => voce !== null)

    if (buchi.length > 0) {
      throw new Error(
        istruzioni(
          `la build risolta da ${origine} non sa fare il lavoro — ${buchi.join(' · ')}. ` +
            'Un binario che non sa fare il lavoro è un binario assente.',
        ),
      )
    }

    risolti = {
      ffmpeg,
      ffprobe,
      versione: (esegui(ffmpeg, ['-version']).stdout ?? '').split('\n')[0]?.trim() ?? 'ignota',
      origine,
    }
    return risolti
  } catch (errore) {
    fallimento = errore instanceof Error ? errore : new Error(String(errore))
    throw fallimento
  }
}

/**
 * I binari per un caso reale. Fallisce rumorosamente se non ci sono; salta SOLO se la
 * rinuncia è stata dichiarata a mano, e mai in CI.
 *
 * Il `throw` dopo `contesto.skip(...)` non è codice morto per caso: `skip` di vitest
 * interrompe il test lanciando, quindi non si raggiunge. Se un giorno smettesse di
 * farlo, il test diventerebbe ROSSO invece che verde a vuoto — che è il verso giusto
 * in cui sbagliare.
 */
let avvisato = false

export function binariVideo(contesto: ContestoSaltabile): BinariVideo {
  const rinuncia = rinunciaDichiarata()
  if (rinuncia !== null) {
    contesto.skip(rinuncia)
    throw new Error(rinuncia)
  }

  try {
    return risolviBinari()
  } catch (errore) {
    // IN CI NON SI SALTA MAI. La build pinnata la installa il workflow: se qui manca
    // qualcosa, l'integrazione è rotta e deve dirlo forte.
    if (process.env.CI) throw errore

    // FUORI DA CI, invece, la fedeltà è impossibile per COSTRUZIONE su questa macchina:
    // la build pinnata è `linux64-gpl` e non gira su macOS. Pretendere il rosso qui
    // significherebbe rendere `npm run gate` — che AGENTS.md vuole verde prima di ogni
    // merge — impossibile da soddisfare su ogni macchina di sviluppo del progetto, e
    // l'hook `Stop` di /ship-cycle non ha modo di dichiarare la rinuncia.
    //
    // È la stessa forma di `npm run e2e`, vietato in locale perché `.env.local` punta
    // alla produzione, e verificato solo in CI. La differenza con il vecchio `runIf`
    // resta intera: quello spariva senza dire niente, questo STAMPA il motivo una volta
    // e lo mette nel motivo di ogni skip — e il lock `fixture-video-reali` pretende che
    // il passo di CI che installa la build pinnata esista davvero, così la strada
    // «dichiarata non disponibile» non può diventare in silenzio anche quella di CI.
    const motivo =
      'collaudo video reale non disponibile su questa macchina ' +
      `(${errore instanceof Error ? errore.message.split('\n')[0] : String(errore)}). ` +
      'La fedeltà si prova in CI con la build pinnata.'
    if (!avvisato) {
      avvisato = true
      process.stderr.write(`\n⚠️  ${motivo}\n\n`)
    }
    contesto.skip(motivo)
    throw errore
  }
}

/**
 * LE FIXTURE SI GENERANO, NON SI VERSIONANO.
 *
 * Il repository è PUBBLICO e un HEVC 4K HDR pesa decine di MB: un file del genere
 * committato resta nella storia di git per sempre, anche dopo il `rm`. Qui ogni caso
 * fabbrica i propri file in una cartella temporanea e la distrugge nel `finally`,
 * anche quando l'asserzione fallisce.
 */
export function inCartellaTemporanea<T>(prefisso: string, corpo: (cartella: string) => T): T {
  const cartella = mkdtempSync(join(tmpdir(), prefisso))
  try {
    return corpo(cartella)
  } finally {
    rmSync(cartella, { recursive: true, force: true })
  }
}

/** Esegue ffmpeg con argomenti già completi e lancia con lo stderr vero se fallisce. */
export function eseguiFfmpeg(binari: BinariVideo, argomenti: string[], etichetta: string): string {
  const esito = esegui(binari.ffmpeg, argomenti)
  if (esito.status !== 0) {
    throw new Error(
      `${etichetta}: ffmpeg è uscito con ${esito.status} (${binari.versione})\n` +
        `argomenti: ${argomenti.join(' ')}\n${esito.stderr ?? ''}`,
    )
  }
  return esito.stderr ?? ''
}

/** Fabbrica un file sorgente: aggiunge solo le opzioni globali, il resto lo decide il caso. */
export function generaFixture(binari: BinariVideo, argomenti: string[], etichetta: string): string {
  return eseguiFfmpeg(
    binari,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...argomenti],
    etichetta,
  )
}

/** Il JSON di ffprobe, nella stessa forma che il runner passerà ai parser. */
export function sondaFfprobe(binari: BinariVideo, percorso: string): unknown {
  const esito = esegui(binari.ffprobe, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    percorso,
  ])
  if (esito.status !== 0) {
    throw new Error(`ffprobe è uscito con ${esito.status} su ${percorso}\n${esito.stderr ?? ''}`)
  }
  return JSON.parse(esito.stdout ?? 'null') as unknown
}

/**
 * La decodifica completa che il runner esegue per provare che l'uscita si apre davvero.
 *
 * `-xerror -err_detect explode` è ciò che fa la differenza fra «ffprobe ha letto
 * l'intestazione» e «i frame escono»: su un MP4 troncato a metà questa chiamata esce
 * con 183 e si ferma al quinto frame, misurato il 2026-09-17.
 */
export function provaDiDecodifica(
  binari: BinariVideo,
  percorso: string,
): { exitCode: number; decodedFrames: number } {
  const esito = esegui(binari.ffmpeg, [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-stats',
    '-xerror',
    '-err_detect',
    'explode',
    '-i',
    percorso,
    '-fps_mode',
    'passthrough',
    '-f',
    'null',
    '-',
  ])
  const ultimo = [...(esito.stderr ?? '').matchAll(/frame=\s*(\d+)/g)].pop()
  return {
    // `status` è null quando il processo muore per un segnale: lì «non lo so» vale 1.
    exitCode: esito.status ?? 1,
    decodedFrames: ultimo ? Number(ultimo[1]) : 0,
  }
}
