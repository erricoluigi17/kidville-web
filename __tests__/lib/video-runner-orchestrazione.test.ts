import { describe, expect, it } from 'vitest'

import { SEDE_A } from '../fixtures/sedi'

import { TETTO_INVOCAZIONE_MS } from '@/lib/media/video/runner/battito'
import { eseguiUnJobVideo } from '@/lib/media/video/runner/esegui'
import {
  SEPARATORE_INVENTARIO,
  nomeSandboxVideo,
  percorsoUscitaVideo,
} from '@/lib/media/video/runner/preparazione'
import type {
  ArchivioVideo,
  CodaVideo,
  ComandoSandbox,
  EsitoComando,
  EsitoRpcVideo,
  JobVideo,
  MacchinaSandbox,
  SessioneSandbox,
} from '@/lib/media/video/runner/porte'
import {
  USCITE_APPARECCHIO,
  USCITE_CONVERSIONE,
  codiceDaUscitaApparecchio,
  codiceDaUscitaConversione,
  leggiApparecchio,
  leggiEsitoConversione,
  scriptApparecchio,
  scriptConversione,
  senzaUrl,
} from '@/lib/media/video/runner/script'

/**
 * L'ORCHESTRAZIONE — chi vince, che cosa si ferma, in che ordine, con quale codice.
 *
 * ⚠️ QUI I DOPPI SONO OVUNQUE, E QUINDI QUI SI SBAGLIA. Un doppio piatto — «la
 * sandbox risponde sempre bene, il database dice sempre sì» — resta verde anche se
 * l'orchestrazione sotto è al contrario. Perciò ogni caso qui sotto rompe UNA cosa
 * sola e pretende due fatti: il codice giusto sul database, e **che cosa NON è
 * successo** (nessun comando dopo il guasto, nessuna scrittura sul job che non è
 * più nostro, nessuna MicroVM lasciata accesa). La seconda metà è quella che i mock
 * piatti non hanno mai.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Le fixture: un probe di ingresso vero e un'uscita che lo rispetta
 * ──────────────────────────────────────────────────────────────────────────── */

const JOB_ID = '3f2a61b4-1c7d-4e58-9a0b-2d4c6e8f0a12'
const OWNER = '9d0c1b2a-3e4f-4a5b-8c9d-0e1f2a3b4c5d'
const WORKER = '00000000-1111-4222-8333-444444444444'
// La sede viene da `__tests__/fixtures/sedi.ts`: un uuid di produzione dentro un
// test è innocuo ma NORMALIZZA l'errore — chi copia il test copia l'uuid, e da lì
// finisce in uno script che scrive sul database vero (lock
// `migrazioni-senza-sede-cablata`).
const SCUOLA = SEDE_A

function job(sovrascritture: Partial<JobVideo> = {}): JobVideo {
  return {
    id: JOB_ID,
    owner_id: OWNER,
    scuola_id: SCUOLA,
    channel: 'gallery',
    intent_id: OWNER,
    status: 'processing',
    original_bucket: 'video_originals',
    original_path: `${OWNER}/originale`,
    source_size: 20_000_000,
    source_mime: 'video/mp4',
    attempt: 1,
    fence_epoch: 5,
    ...sovrascritture,
  }
}

/** Durata a ridosso del tetto: serve al caso «il probe_json è la SORGENTE». */
const DURATA_SORGENTE = 179.9
const DURATA_USCITA = 179.92

function probeSorgente(durata = DURATA_SORGENTE): string {
  return JSON.stringify({
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        codec_type: 'video',
        width: 1920,
        height: 1080,
        coded_width: 1920,
        coded_height: 1088,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '30000/1001',
        r_frame_rate: '30000/1001',
        duration: String(durata),
        sample_aspect_ratio: '1:1',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        color_space: 'bt709',
        disposition: { default: 1, attached_pic: 0 },
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: String(durata) },
  })
}

function probeUscita(durata = DURATA_USCITA): string {
  return JSON.stringify({
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        codec_type: 'video',
        width: 1920,
        height: 1080,
        pix_fmt: 'yuv420p',
        avg_frame_rate: '30000/1001',
        r_frame_rate: '30000/1001',
        duration: String(durata),
        sample_aspect_ratio: '1:1',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        color_space: 'bt709',
        color_range: 'tv',
        disposition: { default: 1, attached_pic: 0 },
      },
    ],
    format: { format_name: 'mov,mp4', duration: String(durata) },
  })
}

const INVENTARIO_COMPLETO = [
  ' .. zscale            V->V       Colorspace conversion.\n' +
    ' .S tonemap           V->V       Dynamic range.\n' +
    ' .. scale             V->V       Scale.\n' +
    ' TS overlay           VV->V      Overlay.\n' +
    ' .. setsar            V->V       Set SAR.\n' +
    ' .. fps               V->V       Force fps.\n' +
    ' .. format            V->V       Convert pixel format.\n' +
    ' T. sidedata          V->V       Side data.',
  ' V....D h264\n V....D hevc\n V....D vp8\n V....D vp9\n VFS..D av1\n VF...D prores\n VFS..D dnxhd',
  ' V....D libx264\n A....D aac\n V....D libx265\n VFS... prores_ks\n VFS..D dnxhd',
].join(`\n${SEPARATORE_INVENTARIO}\n`)

function uscitaApparecchio(probe = probeSorgente()): string {
  return [
    '===INVENTARIO===',
    INVENTARIO_COMPLETO,
    '===BYTE===',
    '20000000',
    '===PROBE===',
    probe,
  ].join('\n')
}

function marcatore(
  p: {
    uscita?: number
    byteSorgente?: number
    byteUscita?: number
    decodeExit?: number
    decodeFrames?: number
    probeIn?: string
    probeOut?: string
    diagnosi?: string
  } = {},
): string {
  return [
    `KV_ESITO_EXIT=${p.uscita ?? 0}`,
    `KV_BYTE_SORGENTE=${p.byteSorgente ?? 20_000_000}`,
    `KV_BYTE_USCITA=${p.byteUscita ?? 8_000_000}`,
    `KV_DECODE_EXIT=${p.decodeExit ?? 0}`,
    `KV_DECODE_FRAMES=${p.decodeFrames ?? 5391}`,
    '===PROBE_SORGENTE===',
    p.probeIn ?? probeSorgente(),
    '===PROBE_USCITA===',
    p.probeOut ?? probeUscita(),
    '===DIAGNOSI===',
    p.diagnosi ?? 'frame= 5391 fps=120 q=-1.0',
  ].join('\n')
}

/* ────────────────────────────────────────────────────────────────────────────
 * I doppi
 * ──────────────────────────────────────────────────────────────────────────── */

const OK: EsitoComando = { exitCode: 0, stdout: '', stderr: '' }

interface Copione {
  /** Risposta a ciascun comando, scelta guardando che cosa è stato chiesto. */
  risposta?: (c: ComandoSandbox, n: number) => EsitoComando | Error
  nuova?: boolean
  apriFallisce?: boolean
}

function sandboxFinta(copione: Copione = {}) {
  const eseguiti: ComandoSandbox[] = []
  const avviati: ComandoSandbox[] = []
  const nomi: string[] = []
  let fermata = 0
  let marcatoriLetti = 0

  const sessione: SessioneSandbox = {
    nuova: copione.nuova ?? true,
    esegui: async (c) => {
      eseguiti.push(c)
      if (c.args.join(' ').includes('esito.txt')) marcatoriLetti += 1
      const r = copione.risposta?.(c, eseguiti.length)
      if (r instanceof Error) throw r
      return r ?? OK
    },
    avvia: async (c) => {
      avviati.push(c)
    },
    ferma: async () => {
      fermata += 1
    },
  }

  const macchina: MacchinaSandbox = {
    apri: async (p) => {
      nomi.push(p.nome)
      if (copione.apriFallisce) throw new Error('microvm non disponibile')
      return sessione
    },
  }

  return { macchina, eseguiti, avviati, nomi, fermate: () => fermata, marcatoriLetti: () => marcatoriLetti }
}

interface CopioneCoda {
  prossimo?: EsitoRpcVideo
  miei?: JobVideo[]
  battito?: EsitoRpcVideo
  pronto?: EsitoRpcVideo
  fallito?: EsitoRpcVideo
}

function codaFinta(copione: CopioneCoda = {}) {
  const pronti: unknown[] = []
  const falliti: unknown[] = []
  const riprese: string[] = []
  let battiti = 0

  const coda: CodaVideo = {
    miei: async () => ({ ok: true, jobs: copione.miei ?? [] }),
    prossimo: async () => copione.prossimo ?? { ok: false, code: 'EMPTY_QUEUE' },
    riprendi: async (jobId) => {
      riprese.push(jobId)
      return { ok: true, job: (copione.miei ?? [])[0] ?? job() }
    },
    battito: async () => {
      battiti += 1
      return copione.battito ?? { ok: true, job: job() }
    },
    pronto: async (p) => {
      pronti.push(p)
      return copione.pronto ?? { ok: true, job: job() }
    },
    fallito: async (p) => {
      falliti.push(p)
      return copione.fallito ?? { ok: true, job: job() }
    },
  }

  return { coda, pronti, falliti, riprese, battiti: () => battiti }
}

const archivio: ArchivioVideo = {
  urlLettura: async (bucket, percorso) => ({
    ok: true,
    url: `https://esempio.invalid/storage/${bucket}/${percorso}?token=segreto-che-non-va-loggato`,
  }),
  urlScrittura: async (bucket, percorso) => ({
    ok: true,
    url: `https://esempio.invalid/storage/upload/${bucket}/${percorso}?token=altro-segreto`,
  }),
}

function orologioFinto() {
  let ora = 1_000_000
  return { adesso: () => ora, pausa: async (ms: number) => void (ora += ms) }
}

function dipendenze(
  coda: CodaVideo,
  macchina: MacchinaSandbox,
  sovrascritture: Partial<Parameters<typeof eseguiUnJobVideo>[0]> = {},
) {
  return {
    coda,
    archivio,
    macchina,
    orologio: orologioFinto(),
    leaseOwner: WORKER,
    regione: 'dub1',
    vcpus: 4,
    urlWatermark: 'https://app.esempio.invalid/watermark.png',
    tettoInvocazioneMs: TETTO_INVOCAZIONE_MS,
    ...sovrascritture,
  }
}

/** Il copione del percorso felice: apparecchio ok, args ok, marcatore pronto. */
function rispostaFelice(marca = marcatore()) {
  return (c: ComandoSandbox): EsitoComando => {
    const testo = c.args.join(' ')
    if (testo.includes('esito.txt')) return { exitCode: 0, stdout: marca, stderr: '' }
    if (testo.includes('===INVENTARIO===')) {
      return { exitCode: 0, stdout: uscitaApparecchio(), stderr: '' }
    }
    return OK
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. GLI SCRIPT E I LORO LETTORI — funzioni pure, nessun doppio
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · gli script e i loro lettori', () => {
  it('l’apparecchio distingue i propri modi di fallire da quelli della build', () => {
    expect(codiceDaUscitaApparecchio(0)).toBeNull()
    expect(codiceDaUscitaApparecchio(USCITE_APPARECCHIO.dimensione)).toBe('SOURCE_DOWNLOAD_FAILED')
    expect(codiceDaUscitaApparecchio(USCITE_APPARECCHIO.probe)).toBe('PROBE_COMMAND_FAILED')
    // Le tre uscite della provvista restano quelle, viste da qui.
    expect(codiceDaUscitaApparecchio(22)).toBe('BUILD_HASH_MISMATCH')
  })

  it('la conversione distingue scarico, codifica, probe e caricamento', () => {
    expect(codiceDaUscitaConversione(0)).toBeNull()
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.scarico)).toBe('SOURCE_DOWNLOAD_FAILED')
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.codifica)).toBe('ENCODE_FAILED')
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.probe)).toBe('PROBE_COMMAND_FAILED')
    expect(codiceDaUscitaConversione(USCITE_CONVERSIONE.caricamento)).toBe('OUTPUT_UPLOAD_FAILED')
    // Fail-closed: un 137 (SIGKILL) non è «è andata bene».
    expect(codiceDaUscitaConversione(137)).toBe('ENCODE_FAILED')
  })

  it('il marcatore compare TUTTO INSIEME: si scrive a parte e si sposta', () => {
    const script = scriptConversione({ conWatermark: true })
    // Senza questo `mv`, la sorveglianza potrebbe leggere un marcatore scritto a
    // metà — cioè un probe troncato — e dichiarare guasta una conversione riuscita.
    expect(script).toMatch(/mv\s+\S*parziale\S*\s+\S*esito\.txt/)
    // E il marcatore si scrive COMUNQUE, anche quando qualcosa esplode: senza la
    // trappola, un guasto lascerebbe la sorveglianza a girare fino al tetto.
    expect(script).toContain('trap')
  })

  it('l’apparecchio verifica la build prima di usarla, e legge il probe SENZA scaricare il video', () => {
    const script = scriptApparecchio()
    expect(script.indexOf('sha256sum')).toBeLessThan(script.indexOf('tar '))
    // ffprobe sull'URL firmato: legge le intestazioni con richieste di intervallo,
    // non i 2 GB. Se scaricasse, l'apparecchio non starebbe in un'invocazione.
    expect(script).toContain('$KV_URL_INGRESSO')
    expect(script).not.toContain('curl -fsSL --retry 3 --retry-all-errors -o /tmp/kv-video/ingresso')
  })

  it('il lettore dell’apparecchio separa inventario, dimensione e probe', () => {
    const letto = leggiApparecchio(uscitaApparecchio())
    expect(letto.byte).toBe(20_000_000)
    expect(letto.inventario.filtri.has('zscale')).toBe(true)
    expect(letto.inventario.encoder.has('libx264')).toBe(true)
    expect(JSON.parse(letto.probeGrezzo).format.format_name).toContain('mp4')
  })

  it('il lettore del marcatore ricava i numeri e i due probe', () => {
    const letto = leggiEsitoConversione(marcatore({ uscita: 0, decodeFrames: 12 }))
    expect(letto.uscita).toBe(0)
    expect(letto.byteSorgente).toBe(20_000_000)
    expect(letto.byteUscita).toBe(8_000_000)
    expect(letto.prova).toEqual({ exitCode: 0, decodedFrames: 12 })
    expect(JSON.parse(letto.probeSorgente).format.duration).toBe(String(DURATA_SORGENTE))
    expect(JSON.parse(letto.probeUscita).format.duration).toBe(String(DURATA_USCITA))
  })

  it('un marcatore illeggibile non diventa «tutto a posto»', () => {
    const letto = leggiEsitoConversione('spazzatura')
    expect(letto.uscita).not.toBe(0)
    expect(letto.byteUscita).toBeNull()
    expect(letto.prova).toBeNull()
  })

  it('la diagnosi che finisce nei log non porta dentro un URL firmato', () => {
    const grezzo =
      "curl: (22) The requested URL returned error: 403 for https://x.invalid/o/v?token=eyJhbGciOi.SEGRETO"
    expect(senzaUrl(grezzo)).not.toContain('token=')
    expect(senzaUrl(grezzo)).not.toContain('eyJhbGciOi')
    // …ma il MOTIVO resta leggibile: è l'unica cosa che serve per capire.
    expect(senzaUrl(grezzo)).toContain('403')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 2. IL GIRO DEL WORKER
 * ════════════════════════════════════════════════════════════════════════════ */

describe('runner video · quando non c’è niente da fare', () => {
  it('coda vuota: non si apre nessuna MicroVM', async () => {
    const c = codaFinta({ prossimo: { ok: false, code: 'EMPTY_QUEUE' } })
    const s = sandboxFinta()
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'coda-vuota' })
    // Il conto di una MicroVM aperta per niente è piccolo; quello di 1.440 MicroVM
    // aperte per niente ogni giorno no.
    expect(s.nomi).toEqual([])
    expect(c.falliti).toEqual([])
  })

  it('presa rifiutata: nessuna MicroVM, e nessuna scrittura su un job che non è nostro', async () => {
    const c = codaFinta({ prossimo: { ok: false, code: 'LEASE_ACTIVE' } })
    const s = sandboxFinta()
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'presa-rifiutata', codice: 'LEASE_ACTIVE' })
    expect(s.nomi).toEqual([])
    // ⚠️ `video_job_fail` senza lease risponderebbe LEASE_MISMATCH: chiamarla
    // sarebbe rumore, e su un job di qualcun altro.
    expect(c.falliti).toEqual([])
  })
})

describe('runner video · il percorso felice', () => {
  it('converte, verifica e scrive l’esito — nell’ordine giusto', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'pronto', jobId: JOB_ID, byteUscita: 8_000_000 })
    // La MicroVM porta il fence del tentativo corrente.
    expect(s.nomi).toEqual([nomeSandboxVideo(JOB_ID, 5)])
    // Un solo avvio staccato: la conversione. Tutto il resto è sincrono e corto.
    expect(s.avviati).toHaveLength(1)
    // E si spegne: una MicroVM dimenticata accesa si paga a `GB × ore`.
    expect(s.fermate()).toBe(1)
    expect(c.falliti).toEqual([])
  })

  it('`video_job_ready` riceve il probe della SORGENTE, non quello dell’uscita', async () => {
    // ⚠️ Il trabocchetto, e costa una conversione intera. `video_jobs_probe_chk`
    // pretende `durationSeconds <= 180`, che è il limite dell'INGRESSO; l'uscita
    // AAC può legittimamente superarlo di qualche millisecondo (lo dice
    // `verifyVideoOutput`). Mandare l'uscita farebbe rispondere `BAD_INPUT` DOPO
    // aver pagato la codifica, e solo sui video lunghi — cioè in produzione.
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(c.pronti).toHaveLength(1)
    const scritto = c.pronti[0] as { probe: { durationSeconds: number }; percorsoUscita: string }
    expect(scritto.probe.durationSeconds).toBe(DURATA_SORGENTE)
    expect(scritto.probe.durationSeconds).toBeLessThanOrEqual(180)
    expect(scritto.percorsoUscita).toBe(
      percorsoUscitaVideo({ id: JOB_ID, owner_id: OWNER, fence_epoch: 5 }),
    )
  })

  it('nessun URL firmato finisce fra gli ARGOMENTI di un comando', async () => {
    // Un URL firmato porta un JWT: fra gli argomenti sarebbe leggibile con un `ps`
    // dentro la MicroVM e comparirebbe nella console di Vercel accanto al comando.
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    const tutti = [...s.eseguiti, ...s.avviati]
    expect(tutti.length).toBeGreaterThan(2)
    for (const comando of tutti) {
      expect(comando.args.join(' ')).not.toMatch(/token=/)
      expect(comando.args.join(' ')).not.toMatch(/https?:\/\/esempio\.invalid/)
    }
    // …e almeno un comando GLI URL CE LI HA, nell'ambiente: il controllo qui sopra
    // non sta passando perché non c'è niente da trovare.
    const conUrl = tutti.filter((comando) =>
      Object.values(comando.env ?? {}).some((v) => v.includes('token=')),
    )
    expect(conUrl.length).toBeGreaterThanOrEqual(2)
  })

  it('gli argomenti di FFmpeg viaggiano nell’array, mai in una riga di shell', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    // Il filtergraph della Galleria contiene già degli apici singoli: appiattirlo in
    // una stringa vorrebbe dire inventarsi un quoting, e un quoting inventato salta
    // sul caso strano, cioè in produzione.
    const scrittura = s.eseguiti.find((cmd) => cmd.args.some((a) => a.includes('-filter_complex')))
    expect(scrittura).toBeDefined()
    expect(scrittura?.args.some((a) => a.includes("overlay=x='(main_w-overlay_w)/2'"))).toBe(true)
  })
})

describe('runner video · i modi di fallire, uno per uno', () => {
  async function fallisciCon(risposta: Copione['risposta']) {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ risposta })
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))
    return { esito, c, s }
  }

  it('lo SHA che non torna: si ferma lì, senza estrarre e senza convertire', async () => {
    const { esito, c, s } = await fallisciCon((cmd) =>
      cmd.args.join(' ').includes('===INVENTARIO===')
        ? { exitCode: 22, stdout: '', stderr: "sha256sum: WARNING: 1 computed checksum did NOT match" }
        : OK,
    )

    expect(esito).toEqual({
      esito: 'fallito',
      jobId: JOB_ID,
      codice: 'BUILD_HASH_MISMATCH',
      rifiutato: false,
    })
    // ⚠️ L'asserzione che vale il caso: NIENTE è stato avviato. Riprovare a eseguire
    // un binario che non è quello atteso è peggio che fermarsi.
    expect(s.avviati).toEqual([])
    expect(s.fermate()).toBe(1)
    expect(c.falliti).toHaveLength(1)
  })

  it('una build a cui manca `zscale` non parte: il guasto si vedrebbe solo sul primo HDR', async () => {
    const senzaZscale = uscitaApparecchio().replace(/^ \.\. zscale.*$/m, '')
    const { esito, s } = await fallisciCon((cmd) => {
      const testo = cmd.args.join(' ')
      if (testo.includes('===INVENTARIO===')) {
        return { exitCode: 0, stdout: senzaZscale, stderr: '' }
      }
      return OK
    })

    expect(esito).toEqual({
      esito: 'fallito',
      jobId: JOB_ID,
      codice: 'BUILD_INCOMPLETE',
      rifiutato: false,
    })
    expect(s.avviati).toEqual([])
  })

  it('un probe che non si lascia leggere è colpa del FILE: il job è respinto', async () => {
    const { esito } = await fallisciCon((cmd) =>
      cmd.args.join(' ').includes('===INVENTARIO===')
        ? {
            exitCode: 0,
            stdout: uscitaApparecchio(JSON.stringify({ streams: [], format: { format_name: 'mp4' } })),
            stderr: '',
          }
        : OK,
    )

    expect(esito).toEqual({
      esito: 'fallito',
      jobId: JOB_ID,
      codice: 'MISSING_VIDEO_STREAM',
      // `rejected`: non è la nostra infrastruttura, è il video. Riprovare darebbe
      // lo stesso risultato, e la famiglia deve poterlo sapere.
      rifiutato: true,
    })
  })

  it('un’uscita che non passa la verifica non viene mai dichiarata pronta', async () => {
    const { esito, c } = await fallisciCon(
      rispostaFelice(
        // Un'uscita a 1280×720: `buildVideoEncodeArgs` non l'avrebbe mai prodotta a
        // partire da un 1920×1080, quindi qualcosa è andato storto in mezzo.
        marcatore({ probeOut: probeUscita().replace('"width":1920', '"width":1280') }),
      ),
    )

    expect(esito).toMatchObject({ esito: 'fallito', rifiutato: true })
    expect(c.pronti).toEqual([])
  })

  it('la MicroVM che non si apre è un guasto NOSTRO, e si può riprovare', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ apriFallisce: true })
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({
      esito: 'fallito',
      jobId: JOB_ID,
      codice: 'SANDBOX_UNAVAILABLE',
      rifiutato: false,
    })
    expect(s.fermate()).toBe(0)
    expect(c.falliti).toHaveLength(1)
  })

  it('la conversione uscita male porta il suo codice, non un generico', async () => {
    const { esito } = await fallisciCon(
      rispostaFelice(marcatore({ uscita: USCITE_CONVERSIONE.caricamento })),
    )
    expect(esito).toMatchObject({ esito: 'fallito', codice: 'OUTPUT_UPLOAD_FAILED' })
  })
})

describe('runner video · quando il job smette di essere nostro', () => {
  it('lease persa: non si scrive NIENTE sul job, e la MicroVM si spegne', async () => {
    const c = codaFinta({
      prossimo: { ok: true, job: job() },
      battito: { ok: false, code: 'FENCE_MISMATCH' },
    })
    // Un marcatore che non compare mai: la sorveglianza arriva al primo battito.
    const s = sandboxFinta({
      risposta: (cmd) => {
        const testo = cmd.args.join(' ')
        if (testo.includes('esito.txt')) return { exitCode: 1, stdout: '', stderr: '' }
        if (testo.includes('===INVENTARIO===')) {
          return { exitCode: 0, stdout: uscitaApparecchio(), stderr: '' }
        }
        return OK
      },
    })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'lease-persa', jobId: JOB_ID, codice: 'FENCE_MISMATCH' })
    // ⚠️ Il punto del fencing: un worker che ha perso la lease NON scrive l'esito.
    // `video_job_fail` risponderebbe comunque `FENCE_MISMATCH`, ma provarci
    // significherebbe non aver capito di chi è il job.
    expect(c.falliti).toEqual([])
    expect(c.pronti).toEqual([])
    expect(s.fermate()).toBe(1)
  })
})

describe('runner video · la conversione che dura più di un’invocazione', () => {
  it('finito il tempo, si lascia tutto acceso e si torna dopo', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({
      risposta: (cmd) => {
        const testo = cmd.args.join(' ')
        if (testo.includes('esito.txt')) return { exitCode: 1, stdout: '', stderr: '' }
        if (testo.includes('===INVENTARIO===')) {
          return { exitCode: 0, stdout: uscitaApparecchio(), stderr: '' }
        }
        return OK
      },
    })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'in-corso', jobId: JOB_ID })
    // ⚠️ La MicroVM NON si spegne: è lì che sta girando la conversione.
    expect(s.fermate()).toBe(0)
    expect(c.pronti).toEqual([])
    expect(c.falliti).toEqual([])
    // E la lease è stata tenuta viva fin qui, altrimenti il tick dopo non potrebbe
    // riprendere (`video_job_next` non restituisce un `processing` con lease valida).
    expect(c.battiti()).toBeGreaterThanOrEqual(3)
  })

  it('il tick successivo RIPRENDE lo stesso Sandbox invece di rifare tutto', async () => {
    const inCorso = job({ fence_epoch: 5 })
    const c = codaFinta({ miei: [inCorso] })
    const s = sandboxFinta({ nuova: false, risposta: rispostaFelice() })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'pronto', jobId: JOB_ID, byteUscita: 8_000_000 })
    // Stesso fence ⇒ stesso nome ⇒ `Sandbox.get` riaggancia la MicroVM che sta già
    // convertendo. È l'unica ragione per cui il fence sta nel nome.
    expect(s.nomi).toEqual([nomeSandboxVideo(JOB_ID, 5)])
    expect(c.riprese).toEqual([JOB_ID])
    // ⚠️ Non si riapparecchia e non si riavvia: la build c'è già e la conversione
    // sta girando. Rifare l'apparecchio significherebbe riscaricare FFmpeg sopra un
    // `ffmpeg` in esecuzione; riavviare, due codifiche sullo stesso file.
    expect(s.avviati).toEqual([])
    expect(s.eseguiti.every((cmd) => cmd.args.join(' ').includes('esito.txt'))).toBe(true)
  })

  it('se la MicroVM è morta nel frattempo, si riparte da capo invece di aspettare a vuoto', async () => {
    const inCorso = job({ fence_epoch: 5 })
    const c = codaFinta({ miei: [inCorso] })
    // `nuova: true` su una ripresa = il Sandbox non c'era più e ne è nato uno vuoto.
    const s = sandboxFinta({ nuova: true, risposta: rispostaFelice() })

    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toEqual({ esito: 'pronto', jobId: JOB_ID, byteUscita: 8_000_000 })
    // Apparecchio rifatto e conversione riavviata: altrimenti si sorveglierebbe un
    // marcatore che nessuno scriverà più, fino al tetto dell'invocazione, per sempre.
    expect(s.avviati).toHaveLength(1)
  })

  it('un job da riprendere ha la precedenza su uno nuovo', async () => {
    const c = codaFinta({ miei: [job({ fence_epoch: 5 })], prossimo: { ok: true, job: job() } })
    const s = sandboxFinta({ nuova: false, risposta: rispostaFelice() })

    await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    // Prendere un job nuovo mentre uno è a metà vorrebbe dire due MicroVM aperte e
    // la prima conversione abbandonata a scadere.
    expect(c.riprese).toEqual([JOB_ID])
    expect(s.avviati).toEqual([])
  })
})

describe('runner video · la consegna a News', () => {
  /*
   * Perché questi quattro casi esistono: fino al 2026-09-18
   * `consegnaVideoInBozzaNews` non aveva NESSUN chiamante fuori dai test. L'editor
   * delle comunicazioni scrive nell'articolo un link deterministico a
   * `news_bozze/uploads/<proprietario>/<job>.mp4`, e senza la consegna quel link
   * punta a un file che non c'è. Il guasto non si ferma lì: `promuoviMediaBozza`
   * legge il «not found» dello Storage come «già promosso» e scrive nella riga
   * l'indirizzo pubblico di un oggetto inesistente — un video rotto per le
   * famiglie, scritto in silenzio.
   */

  it('per il canale `news` consegna l’uscita, DOPO che il database ha accettato il pronto', async () => {
    const ordine: string[] = []
    const c = codaFinta({ prossimo: { ok: true, job: job({ channel: 'news' }) } })
    const codaSpiata = {
      ...c.coda,
      pronto: async (...a: Parameters<typeof c.coda.pronto>) => {
        ordine.push('pronto')
        return c.coda.pronto(...a)
      },
    }
    const s = sandboxFinta({ risposta: rispostaFelice() })
    const consegnati: { jobId: string; bucket: string; percorso: string }[] = []

    const esito = await eseguiUnJobVideo(
      dipendenze(codaSpiata, s.macchina, {
        consegnaNews: async (j, percorso, bucket) => {
          ordine.push('consegna')
          consegnati.push({ jobId: j.id, bucket, percorso })
          return { ok: true }
        },
      }),
    )

    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
    // L'ORDINE è la cosa da provare: consegnare prima del `ready` lascerebbe
    // nell'area di sosta l'uscita di un job che il database non ha mai accettato.
    expect(ordine).toEqual(['pronto', 'consegna'])
    expect(consegnati).toHaveLength(1)
    expect(consegnati[0].bucket).toBe('video_processing')
  })

  it('per la Galleria NON consegna niente: quel canale copia per conto suo, dal finalizer', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job({ channel: 'gallery' }) } })
    const s = sandboxFinta({ risposta: rispostaFelice() })
    let chiamate = 0

    await eseguiUnJobVideo(
      dipendenze(c.coda, s.macchina, {
        consegnaNews: async () => {
          chiamate += 1
          return { ok: true }
        },
      }),
    )

    expect(chiamate).toBe(0)
  })

  it('una consegna fallita NON annulla il pronto, ma si grida', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job({ channel: 'news' }) } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    const esito = await eseguiUnJobVideo(
      dipendenze(c.coda, s.macchina, {
        consegnaNews: async () => ({ ok: false, codice: 'BUCKET_BOZZE_MANCANTE' }),
      }),
    )

    // La conversione è riuscita DAVVERO: dichiararla fallita vorrebbe dire rifarla da
    // capo — minuti di CPU pagati due volte — per un guasto di una copia.
    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
  })

  it('se la porta non è stata cablata lo dice a voce alta, invece di fingere', async () => {
    const c = codaFinta({ prossimo: { ok: true, job: job({ channel: 'news' }) } })
    const s = sandboxFinta({ risposta: rispostaFelice() })

    // `consegnaNews` assente: è la configurazione in cui il difetto è vissuto per due
    // giorni senza che nulla lo segnalasse.
    const esito = await eseguiUnJobVideo(dipendenze(c.coda, s.macchina))

    expect(esito).toMatchObject({ esito: 'pronto', jobId: JOB_ID })
  })
})
