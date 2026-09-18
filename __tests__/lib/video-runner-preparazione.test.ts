import { describe, expect, it } from 'vitest'

import {
  ARCHIVIO_FFMPEG_SHA256,
  ARCHIVIO_FFMPEG_URL,
  DECODER_RICHIESTI,
  ENCODER_RICHIESTI,
  FFMPEG_NELL_ARCHIVIO,
  FFPROBE_NELL_ARCHIVIO,
  FILTRI_RICHIESTI,
} from '@/lib/media/video/build'
import {
  USCITE_PREPARAZIONE,
  codiceDaUscitaPreparazione,
  inventarioDellaBuild,
  mancanzeDellaBuild,
  SEPARATORE_INVENTARIO,
  nomeSandboxVideo,
  percorsoUscitaVideo,
  scriptPreparazioneBuild,
} from '@/lib/media/video/runner/preparazione'

/**
 * LA PREPARAZIONE — il pezzo che decide se un binario preso da Internet può girare
 * sui video dei bambini.
 *
 * Qui non c'è nessun doppio, e non è una comodità: sono funzioni pure su stringhe.
 * Un test che passa una stringa e ne guarda un'altra non può essere verde «con e
 * senza la correzione» — è la trappola che in questo repo ha già prodotto un mock
 * piatto verde in entrambe le direzioni. L'unica cosa che qui NON si prova è che
 * `sh` interpreti lo script come noi crediamo: quella misura vive nel Sandbox vero.
 */

const JOB = '3f2a61b4-1c7d-4e58-9a0b-2d4c6e8f0a12'

describe('runner video · il nome del Sandbox', () => {
  it('è deterministico e porta dentro il fence_epoch', () => {
    expect(nomeSandboxVideo(JOB, 7)).toBe(nomeSandboxVideo(JOB, 7))
    expect(nomeSandboxVideo(JOB, 7)).toContain('7')
    // Il punto di tutto: un worker morto che risorge non deve poter riagganciare
    // il Sandbox del suo successore. Fence diverso ⇒ nome diverso.
    expect(nomeSandboxVideo(JOB, 7)).not.toBe(nomeSandboxVideo(JOB, 8))
    expect(nomeSandboxVideo(JOB, 7)).not.toBe(
      nomeSandboxVideo('11111111-2222-3333-4444-555555555555', 7),
    )
  })

  it('resta un nome accettabile: minuscolo, senza punti, entro 63 caratteri', () => {
    const nome = nomeSandboxVideo(JOB, 9_007_199_254_740_991)
    expect(nome).toMatch(/^[a-z][a-z0-9-]{0,62}$/)
    expect(nome.length).toBeLessThanOrEqual(63)
  })

  it('rifiuta un job che non è un uuid e un fence che non è un intero non negativo', () => {
    expect(() => nomeSandboxVideo('non-un-uuid', 1)).toThrow(TypeError)
    expect(() => nomeSandboxVideo(JOB, -1)).toThrow(TypeError)
    expect(() => nomeSandboxVideo(JOB, 1.5)).toThrow(TypeError)
    expect(() => nomeSandboxVideo(JOB, Number.NaN)).toThrow(TypeError)
  })
})

describe('runner video · il percorso dell’uscita', () => {
  it('cambia a ogni tentativo, perché `video_jobs_output_unico` è UNIQUE', () => {
    const uno = percorsoUscitaVideo({ id: JOB, owner_id: JOB, fence_epoch: 3 })
    const due = percorsoUscitaVideo({ id: JOB, owner_id: JOB, fence_epoch: 4 })
    expect(uno).not.toBe(due)
    expect(uno.endsWith('.mp4')).toBe(true)
    // Nessuna risalita, nessun doppio separatore: il bucket è privato ma il
    // percorso lo compone il worker, e un `..` qui scriverebbe altrove.
    expect(uno).not.toContain('..')
    expect(uno).not.toContain('//')
    expect(uno.startsWith('/')).toBe(false)
    expect(uno.length).toBeLessThanOrEqual(1024)
  })
})

describe('runner video · lo script che scarica e verifica FFmpeg', () => {
  const script = scriptPreparazioneBuild()

  it('usa la build PINNATA, con il suo sha256, senza copiarne i valori', () => {
    expect(script).toContain(ARCHIVIO_FFMPEG_URL)
    expect(script).toContain(ARCHIVIO_FFMPEG_SHA256)
    expect(script).toContain(FFMPEG_NELL_ARCHIVIO)
    expect(script).toContain(FFPROBE_NELL_ARCHIVIO)
    // `latest` è il tag mobile: la build cambierebbe sotto i piedi e lo sha non
    // tornerebbe più. Vale la pena che il test lo dica.
    expect(script).not.toContain('autobuild-latest')
  })

  it('VERIFICA PRIMA DI ESTRARRE, e non è un dettaglio di ordine', () => {
    const scarica = script.indexOf('curl')
    const verifica = script.indexOf('sha256sum')
    const estrai = script.indexOf('tar ')
    expect(scarica).toBeGreaterThanOrEqual(0)
    expect(verifica).toBeGreaterThan(scarica)
    expect(estrai).toBeGreaterThan(verifica)
  })

  it('si ferma al primo comando che fallisce e non usa variabili non definite', () => {
    expect(script).toMatch(/set -eu/)
  })

  it('distingue i tre modi di fallire con tre uscite diverse', () => {
    const uscite = new Set(Object.values(USCITE_PREPARAZIONE))
    expect(uscite.size).toBe(Object.keys(USCITE_PREPARAZIONE).length)
    for (const codice of uscite) {
      expect(script).toContain(`exit ${codice}`)
      expect(codice).toBeGreaterThan(0)
    }
  })
})

describe('runner video · dall’uscita dello script al codice d’errore', () => {
  it('zero non è un errore', () => {
    expect(codiceDaUscitaPreparazione(0)).toBeNull()
  })

  it('lo sha che non torna ha il suo codice, distinto dal download e dall’estrazione', () => {
    expect(codiceDaUscitaPreparazione(USCITE_PREPARAZIONE.scarico)).toBe('BUILD_DOWNLOAD_FAILED')
    expect(codiceDaUscitaPreparazione(USCITE_PREPARAZIONE.impronta)).toBe('BUILD_HASH_MISMATCH')
    expect(codiceDaUscitaPreparazione(USCITE_PREPARAZIONE.estrazione)).toBe('BUILD_EXTRACT_FAILED')
  })

  it('un’uscita che non conosciamo non diventa «tutto a posto»', () => {
    // Fail-closed: 137 è un SIGKILL, 1 è il `set -e` su qualcosa che non abbiamo
    // previsto. Nessuno dei due può ricadere su `null`, che significa «riuscito».
    for (const uscita of [1, 2, 126, 127, 137, 255]) {
      expect(codiceDaUscitaPreparazione(uscita)).toBe('BUILD_DOWNLOAD_FAILED')
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * L'INVENTARIO. Le stringhe qui sotto sono ESTRATTI VERI dell'uscita di
 * `ffmpeg -hide_banner -filters|-decoders|-encoders`, presi dalla build Homebrew
 * 8.1.2 di questo Mac — quella che, misurata, NON ha `zscale`. Non sono un
 * formato inventato: è la ragione per cui `build.ts` esiste.
 * ──────────────────────────────────────────────────────────────────────────── */

const FILTRI_HOMEBREW = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  A = Audio input/output
  V = Video input/output
  ------
 .. abench            A->A       Benchmark part of a filtergraph.
 .. format            V->V       Convert the input video to one of the specified pixel formats.
 .. fps               V->V       Force constant framerate.
 TS overlay           VV->V      Overlay a video source on top of the input.
 .. scale             V->V       Scale the input video size and/or convert the image format.
 .. setsar            V->V       Set the pixel sample aspect ratio.
 T. sidedata          V->V       Manipulate video frame side data.
 .S tonemap           V->V       Conversion to/from different dynamic ranges.
`

const DECODER_VERI = `Decoders:
 V..... = Video
 .F.... = Frame-level multithreading
 ------
 V....D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V....D hevc                 HEVC (High Efficiency Video Coding)
 V....D vp8                  On2 VP8
 V....D vp9                  Google VP9
 VFS..D av1                  Alliance for Open Media AV1
 VF...D prores               Apple ProRes (iCodec Pro)
 VFS..D dnxhd                VC3/DNxHD
`

const ENCODER_VERI = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx264rgb           libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 RGB (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 VFS... prores_ks            Apple ProRes (iCodec Pro) (codec prores)
 VFS..D dnxhd                VC3/DNxHD
 A....D aac                  AAC (Advanced Audio Coding)
`

/** La stessa uscita, ma con `zscale` presente: è la build BtbN che gira in Sandbox. */
const FILTRI_COMPLETI = FILTRI_HOMEBREW.replace(
  ' .. abench',
  ' .. zscale            V->V       Apply resizing, colorspace and bit depth conversion.\n .. abench',
)

function unisci(filtri: string, decoder: string, encoder: string): string {
  return [filtri, decoder, encoder].join(`\n${SEPARATORE_INVENTARIO}\n`)
}

describe('runner video · l’inventario della build, letto dalla build stessa', () => {
  it('legge i nomi e non le righe di legenda', () => {
    const inv = inventarioDellaBuild(unisci(FILTRI_COMPLETI, DECODER_VERI, ENCODER_VERI))
    expect(inv.filtri.has('zscale')).toBe(true)
    expect(inv.filtri.has('overlay')).toBe(true)
    expect(inv.decoder.has('hevc')).toBe(true)
    expect(inv.encoder.has('libx264')).toBe(true)
    // Le righe `T.. = Timeline support` e `------` non sono nomi di filtro.
    expect(inv.filtri.has('=')).toBe(false)
    expect(inv.filtri.has('Timeline')).toBe(false)
    expect([...inv.filtri].every((n) => /^[A-Za-z0-9_]+$/.test(n))).toBe(true)
  })

  it('una build completa non ha mancanze', () => {
    const inv = inventarioDellaBuild(unisci(FILTRI_COMPLETI, DECODER_VERI, ENCODER_VERI))
    expect(mancanzeDellaBuild(inv)).toEqual([])
  })

  it('la build Homebrew di questo Mac viene RIFIUTATA, e per il motivo giusto', () => {
    // Misurato: `ffmpeg -filters | grep -c zscale` → 0. È il guasto che `build.ts`
    // racconta nella sua testata, e qui diventa una regressione eseguibile.
    const inv = inventarioDellaBuild(unisci(FILTRI_HOMEBREW, DECODER_VERI, ENCODER_VERI))
    expect(mancanzeDellaBuild(inv)).toEqual(['zscale'])
  })

  it('accorgersi di un decoder o di un encoder mancante, non solo di un filtro', () => {
    const senzaHevc = DECODER_VERI.replace(/^ V\.\.\.\.D hevc.*$/m, '')
    const senzaAac = ENCODER_VERI.replace(/^ A\.\.\.\.D aac.*$/m, '')
    const inv = inventarioDellaBuild(unisci(FILTRI_COMPLETI, senzaHevc, senzaAac))
    expect(mancanzeDellaBuild(inv).sort()).toEqual(['aac', 'hevc'])
  })

  it('un’uscita vuota o illeggibile non passa per «build completa»', () => {
    const vuoto = inventarioDellaBuild('')
    const mancanti = mancanzeDellaBuild(vuoto)
    // Tutto ciò che `build.ts` pretende deve risultare mancante: il caso «ffmpeg
    // non ha stampato niente» è indistinguibile da «non ha nessun filtro», e
    // ricadere su «va bene» significherebbe partire alla cieca.
    expect(mancanti.length).toBe(
      FILTRI_RICHIESTI.length + DECODER_RICHIESTI.length + ENCODER_RICHIESTI.length,
    )
  })
})
