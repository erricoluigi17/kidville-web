import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HttpRequest, HttpResponse, HttpStack } from 'tus-js-client'

import { SEDE_A } from '../fixtures/sedi'
import { ArchivioCaricamentiInMemoria } from '@/lib/media/video/upload/archivio-memoria'
import { ErroreByteVideo } from '@/lib/media/video/upload/byte-video'
import type { CoordinateCaricamentoVideo } from '@/lib/media/video/contratto'

const logClient = vi.fn()
vi.mock('@/lib/logging/client', async () => {
  const vero = await vi.importActual<typeof import('@/lib/logging/client')>(
    '@/lib/logging/client',
  )
  return { ...vero, logClient: (...a: unknown[]) => logClient(...a) }
})

const {
  accodaCaricamentoVideo,
  annullaCaricamentoVideo,
  caricaVideo,
  jobDaSeguire,
  potaArchivioCaricamenti,
  riprendiCaricamentiVideo,
} = await import('@/lib/media/video/upload/caricamento')

/**
 * L'UPLOADER TUS — collaudato contro un server che interrompe DAVVERO.
 *
 * ─── PERCHÉ UN SERVER FINTO E NON UN MOCK DI `tus.Upload` ───────────────────
 *
 * Il criterio d'accettazione di V10 non è «il codice chiama `resume()`»: è che un
 * upload spezzato a metà riprenda da dove era. Un doppio di `tus.Upload` che
 * espone `resume()` e risponde «fatto» sarebbe verde con la ripresa funzionante e
 * verde con la ripresa rotta — è il difetto del «mock piatto», già pagato in
 * questo repo.
 *
 * Qui gira il `tus.Upload` VERO. Quello che si sostituisce è lo strato HTTP
 * (`httpStack`, un punto di estensione del pacchetto), e sotto c'è un server che
 * implementa il protocollo: crea la risorsa con una `Location`, tiene i byte che
 * riceve, risponde alla `HEAD` con l'offset che ha davvero, e — quando glielo si
 * chiede — accetta metà di una `PATCH` e poi lascia cadere la connessione,
 * esattamente come una rete mobile in galleria. L'offset da cui si riprende è un
 * NUMERO che il server ha calcolato contando byte, non un flag messo da noi.
 *
 * ─── DUE MISURE FATTE QUI DENTRO, E CHE CAMBIANO IL CODICE ──────────────────
 *
 *  · sotto vitest `tus-js-client` si risolve alla build **node**, non a quella
 *    browser: il suo `fileReader` rifiuta un `Blob` con «source object may only be
 *    an instance of Buffer or Readable in this environment». Per questo il modulo
 *    porta il proprio `LettoreBlob` e lo passa sempre — così il codice che gira
 *    nel test è lo stesso che gira sul telefono, invece di essere il suo cugino;
 *  · quello che parte davvero nel corpo di una `PATCH` è un `Uint8Array` (WebKit
 *    rifiuta i `Blob` ricostruiti da IndexedDB). Il server finto legge i byte
 *    della vista, o del `Blob` con `arrayBuffer()`, e il test li confronta UNO A
 *    UNO con l'originale: un corpo sbagliato non supera quel confronto.
 */

const ENDPOINT = 'https://storage.finta.test/storage/v1/upload/resumable'
const JOB = '33333333-3333-4333-8333-333333333333'
const INTENT = '44444444-4444-4444-8444-444444444444'
const TOKEN = 'bearer-di-prova-non-e-un-segreto-vero'

const COORDINATE: CoordinateCaricamentoVideo = {
  protocollo: 'tus',
  endpoint: ENDPOINT,
  bucket: 'video_originals',
  // La sede viene dal banco di prova, mai dall'anagrafica vera: il repository e' PUBBLICO,
  // e il lock `migrazioni-senza-sede-cablata` esiste perche' un uuid reale in un test
  // diventa, prima o poi, un uuid reale in un ramo di produzione.
  percorso: `${SEDE_A}/${JOB}.mp4`,
  contentType: 'video/mp4',
  // Il minimo che il contratto ammette: sotto 1 MiB `schemaCoordinateCaricamentoVideo`
  // rifiuta. Con un originale da 2 MiB e mezzo fanno tre PATCH, cioè abbastanza
  // per interrompere a metà della prima e avere ancora due blocchi da spedire.
  dimensioneBloccoByte: 1024 * 1024,
}

const DIMENSIONE = 2 * 1024 * 1024 + 500

/**
 * Un originale riconoscibile: se un byte si sposta, il confronto finale lo vede.
 *
 * Senza annotazione di ritorno di proposito: `Uint8Array` scritto a mano si allarga
 * a `Uint8Array<ArrayBufferLike>`, che `new File([…])` non accetta.
 */
function byteOriginali() {
  const b = new Uint8Array(DIMENSIONE)
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) % 251
  return b
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL SERVER TUS FINTO
 * ──────────────────────────────────────────────────────────────────────────── */

interface Vista {
  metodo: string
  url: string
  offset: number | null
  byteAccettati: number
  intestazioni: Record<string, string>
}

interface Oggetto {
  lunghezza: number
  byte: Uint8Array
  scritti: number
  metadata: Record<string, string>
}

class RispostaFinta implements HttpResponse {
  constructor(
    private readonly stato: number,
    private readonly intestazioni: Record<string, string> = {},
    private readonly corpo = '',
  ) {}
  getStatus() {
    return this.stato
  }
  getHeader(h: string) {
    return this.intestazioni[h]
  }
  getBody() {
    return this.corpo
  }
  getUnderlyingObject() {
    return null
  }
}

class RichiestaFinta implements HttpRequest {
  private readonly intestazioni: Record<string, string> = {}
  progresso: ((n: number) => void) | null = null

  constructor(
    private readonly server: ServerTusFinto,
    private readonly metodo: string,
    private readonly url: string,
  ) {}

  getMethod() {
    return this.metodo
  }
  getURL() {
    return this.url
  }
  setHeader(h: string, v: string) {
    // XMLHttpRequest.setRequestHeader concatena: una seconda firma non sostituisce la prima.
    this.intestazioni[h] = this.intestazioni[h] === undefined ? v : `${this.intestazioni[h]}, ${v}`
  }
  getHeader(h: string) {
    return this.intestazioni[h]
  }
  setProgressHandler(f: (n: number) => void) {
    this.progresso = f
  }
  getUnderlyingObject() {
    return null
  }
  async abort() {
    /* Niente da interrompere: le richieste finte si risolvono nello stesso giro. */
  }
  send(corpo: unknown): Promise<HttpResponse> {
    return this.server.gestisci(this.metodo, this.url, this.intestazioni, corpo, this)
  }
}

/** `chiave base64valore, chiave2 base64valore2` → oggetto. */
function decodificaMetadata(grezzo: string | undefined): Record<string, string> {
  if (!grezzo) return {}
  const fuori: Record<string, string> = {}
  for (const pezzo of grezzo.split(',')) {
    const [chiave, valore] = pezzo.trim().split(' ')
    if (chiave) fuori[chiave] = valore ? atob(valore) : ''
  }
  return fuori
}

class ServerTusFinto implements HttpStack {
  private seq = 0
  readonly oggetti = new Map<string, Oggetto>()
  readonly viste: Vista[] = []

  /** La prossima PATCH accetta solo questi byte, poi la connessione cade. */
  interrompiLaProssimaPatchDopo: number | null = null
  /** La prossima PATCH risponde con questo stato invece di accettare byte. */
  statoForzatoSullaProssimaPatch: number | null = null
  /** Gancio per agire nel mezzo di un caricamento (annullamento in volo). */
  dopoLaRichiesta: ((v: Vista) => void) | null = null

  createRequest(metodo: string, url: string): HttpRequest {
    return new RichiestaFinta(this, metodo, url)
  }
  getName() {
    return 'ServerTusFinto'
  }

  /** L'unico oggetto creato: i test ne caricano uno per volta. */
  unicoOggetto(): Oggetto | undefined {
    return [...this.oggetti.values()][0]
  }

  metodi(): string[] {
    return this.viste.map((v) => v.metodo)
  }

  /**
   * ⚠️ IL GANCIO SI CHIAMA DA QUI, e non con `this.dopoLaRichiesta?.(annota(…))`.
   *
   * L'optional chaining NON valuta gli argomenti quando salta: con il gancio a
   * `null` — cioè in tutti i test tranne uno — `annota(…)` non veniva eseguita, e
   * POST, HEAD e DELETE sparivano dal registro delle richieste mentre le PATCH
   * (annotate in una variabile a parte) restavano. Il test diceva «nessuna POST»
   * di un caricamento che la POST l'aveva fatta davvero: un doppio che mente è
   * peggio di un doppio che manca.
   */
  private avvisa(vista: Vista): void {
    if (this.dopoLaRichiesta) this.dopoLaRichiesta(vista)
  }

  async gestisci(
    metodo: string,
    url: string,
    intestazioni: Record<string, string>,
    corpo: unknown,
    richiesta: RichiestaFinta,
  ): Promise<HttpResponse> {
    const annota = (offset: number | null, byteAccettati: number): Vista => {
      const v: Vista = { metodo, url, offset, byteAccettati, intestazioni: { ...intestazioni } }
      this.viste.push(v)
      return v
    }

    if (metodo === 'POST') {
      const id = `up${++this.seq}`
      const lunghezza = Number(intestazioni['Upload-Length'])
      this.oggetti.set(id, {
        lunghezza,
        byte: new Uint8Array(lunghezza),
        scritti: 0,
        metadata: decodificaMetadata(intestazioni['Upload-Metadata']),
      })
      this.avvisa(annota(null, 0))
      return new RispostaFinta(201, { Location: `${ENDPOINT}/${id}` })
    }

    const id = url.slice(url.lastIndexOf('/') + 1)
    const oggetto = this.oggetti.get(id)

    if (metodo === 'DELETE') {
      this.oggetti.delete(id)
      this.avvisa(annota(null, 0))
      return new RispostaFinta(204)
    }

    if (!oggetto) {
      this.avvisa(annota(null, 0))
      return new RispostaFinta(404)
    }

    if (metodo === 'HEAD') {
      this.avvisa(annota(oggetto.scritti, 0))
      return new RispostaFinta(200, {
        'Upload-Offset': String(oggetto.scritti),
        'Upload-Length': String(oggetto.lunghezza),
      })
    }

    if (metodo === 'PATCH') {
      const offset = Number(intestazioni['Upload-Offset'])

      if (this.statoForzatoSullaProssimaPatch != null) {
        const stato = this.statoForzatoSullaProssimaPatch
        this.statoForzatoSullaProssimaPatch = null
        this.avvisa(annota(offset, 0))
        return new RispostaFinta(stato)
      }

      if (offset !== oggetto.scritti) {
        this.avvisa(annota(offset, 0))
        return new RispostaFinta(409)
      }

      // Legge i byte davvero, come XHR: verificare solo size nasconderebbe un
      // blocco sbagliato. Il reader consegna una view binaria anche su WebKit.
      const arrivati = ArrayBuffer.isView(corpo)
        ? new Uint8Array(corpo.buffer, corpo.byteOffset, corpo.byteLength)
        : new Uint8Array(await (corpo as Blob).arrayBuffer())

      const accettati =
        this.interrompiLaProssimaPatchDopo != null
          ? Math.min(this.interrompiLaProssimaPatchDopo, arrivati.length)
          : arrivati.length

      oggetto.byte.set(arrivati.subarray(0, accettati), offset)
      oggetto.scritti = offset + accettati
      richiesta.progresso?.(accettati)
      const vista = annota(offset, accettati)

      if (this.interrompiLaProssimaPatchDopo != null) {
        this.interrompiLaProssimaPatchDopo = null
        this.avvisa(vista)
        // La connessione cade: nessuna risposta. È il caso che tus distingue da
        // un rifiuto del server, ed è quello che vive una rete mobile.
        throw new TypeError('rete caduta')
      }

      this.avvisa(vista)
      return new RispostaFinta(204, { 'Upload-Offset': String(oggetto.scritti) })
    }

    this.avvisa(annota(null, 0))
    return new RispostaFinta(405)
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * IL BANCO
 * ──────────────────────────────────────────────────────────────────────────── */

function banco(ritardiRitentativo: number[] = []) {
  const server = new ServerTusFinto()
  const archivio = new ArchivioCaricamentiInMemoria()
  return {
    server,
    archivio,
    dip: {
      archivio,
      intestazioni: () => ({ authorization: `Bearer ${TOKEN}` }),
      pilaHttp: server,
      ritardiRitentativo,
      adesso: () => new Date('2026-09-18T09:00:00.000Z'),
    },
  }
}

async function accoda(
  dip: Parameters<typeof accodaCaricamentoVideo>[0],
  tipoFile = 'video/mp4',
) {
  const file = new File([byteOriginali()], 'recita-di-natale.mp4', { type: tipoFile })
  return accodaCaricamentoVideo(dip, {
    jobId: JOB,
    intentId: INTENT,
    canale: 'gallery',
    chiaveIdempotenza: 'chiave-1',
    coordinate: COORDINATE,
    file,
  })
}

beforeEach(() => {
  logClient.mockClear()
})

/* ────────────────────────────────────────────────────────────────────────────
 * 1. IL CARICAMENTO CHE RIESCE
 * ──────────────────────────────────────────────────────────────────────────── */

describe('il caricamento completo', () => {
  it('spedisce esattamente i byte del file e chiude la riga a «caricato»', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)

    const esito = await caricaVideo(dip, JOB)

    expect(esito).toEqual({ esito: 'caricato', jobId: JOB, byteCaricati: DIMENSIONE })

    const oggetto = server.unicoOggetto()!
    expect(oggetto.scritti).toBe(DIMENSIONE)
    expect(Buffer.from(oggetto.byte).equals(Buffer.from(byteOriginali()))).toBe(true)

    const riga = await archivio.leggi(JOB)
    expect(riga?.stato).toBe('caricato')
    expect(riga?.offsetByte).toBe(DIMENSIONE)
    // I byte locali si liberano: tenere due gigabyte sul telefono dopo che sono
    // arrivati allo Storage è il modo più veloce di riempire la memoria di chi carica.
    expect(await archivio.leggiByte(JOB)).toBeUndefined()
  })

  it('manda allo Storage bucket, percorso e contentType delle coordinate', async () => {
    const { server, dip } = banco()
    await accoda(dip)
    await caricaVideo(dip, JOB)

    expect(server.unicoOggetto()!.metadata).toMatchObject({
      bucketName: 'video_originals',
      objectName: COORDINATE.percorso,
      contentType: 'video/mp4',
    })
  })

  it('autentica ogni richiesta con le intestazioni chieste al momento di partire', async () => {
    const { server, dip } = banco()
    await accoda(dip)
    await caricaVideo(dip, JOB)

    expect(server.viste.length).toBeGreaterThan(0)
    for (const v of server.viste) {
      expect(v.intestazioni.authorization).toBe(`Bearer ${TOKEN}`)
    }
  })

  /**
   * 🔴 IL TOKEN NON TOCCA IL DISCO.
   *
   * La ripresa deve chiedere le intestazioni ogni volta, non ricordarsele: un
   * bearer di un genitore lasciato in IndexedDB è una credenziale leggibile da
   * qualunque script della stessa origine, che sopravvive alla scadenza della
   * sessione e al passaggio del telefono a un'altra persona.
   */
  it('non scrive mai il token nell’archivio', async () => {
    const { archivio, dip } = banco()
    await accoda(dip)
    await caricaVideo(dip, JOB)

    expect(JSON.stringify(await archivio.elenca())).not.toContain(TOKEN)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 2. LA RIPRESA — il cuore del microtask
 * ──────────────────────────────────────────────────────────────────────────── */

describe('la ripresa di un caricamento interrotto', () => {
  /**
   * CRITERIO 2: «chi carica un video di 180 secondi da un telefono chiude l'app, e
   * al ritorno deve ritrovare il lavoro, non ricominciarlo».
   *
   * La prima corsa viene tagliata a 300.000 byte — in mezzo al primo blocco, non a
   * un confine comodo — e non ritenta (`ritardiRitentativo: []`): è l'app che
   * muore. La seconda corsa costruisce un `tus.Upload` NUOVO e ha in mano solo
   * quello che era stato scritto sul disco.
   *
   * Le tre asserzioni che rendono impossibile un falso verde:
   *  · UNA sola `POST` in tutta la vicenda — se l'URL della sessione non fosse
   *    stato persistito, la seconda corsa ne creerebbe una seconda;
   *  · la prima `PATCH` della seconda corsa parte da 300.000, non da 0;
   *  · il server ha ricevuto in totale `DIMENSIONE` byte, non uno di più: se si
   *    ricominciasse da capo sarebbero 2.397.152.
   */
  it('riprende dall’offset che il server ha davvero, dopo che l’app è stata chiusa', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)

    server.interrompiLaProssimaPatchDopo = 300_000
    const primo = await caricaVideo(dip, JOB)

    expect(primo).toEqual({ esito: 'interrotto', jobId: JOB, offsetByte: 300_000, codice: null })
    expect(server.unicoOggetto()!.scritti).toBe(300_000)

    // Quello che sopravvive alla chiusura dell'app: lo stato, l'URL, i byte.
    const dopoIlCrollo = await archivio.leggi(JOB)
    expect(dopoIlCrollo?.stato).toBe('in_corso')
    expect(dopoIlCrollo?.urlTus).toMatch(/\/up1$/)
    expect(dopoIlCrollo?.offsetByte).toBe(300_000)
    expect((await archivio.leggiByte(JOB))?.size).toBe(DIMENSIONE)

    const richiesteDellaPrimaCorsa = server.viste.length

    // ── L'app riapre: `tus.Upload` nuovo, stesso archivio ──
    const secondo = await caricaVideo(dip, JOB)

    expect(secondo).toEqual({ esito: 'caricato', jobId: JOB, byteCaricati: DIMENSIONE })

    const nuove = server.viste.slice(richiesteDellaPrimaCorsa)
    expect(nuove[0].metodo).toBe('HEAD')
    const primaPatchDopoIlRientro = nuove.find((v) => v.metodo === 'PATCH')!
    expect(primaPatchDopoIlRientro.offset).toBe(300_000)

    expect(server.metodi().filter((m) => m === 'POST')).toHaveLength(1)
    const totale = server.viste.reduce((s, v) => s + v.byteAccettati, 0)
    expect(totale).toBe(DIMENSIONE)

    // E il file ricomposto è quello di partenza, byte per byte.
    expect(Buffer.from(server.unicoOggetto()!.byte).equals(Buffer.from(byteOriginali()))).toBe(
      true,
    )
  })

  /** La rete cade e torna nello stesso minuto: si riprende da soli, senza ricominciare. */
  it('con i ritentativi accesi riprende da sola, sempre dallo stesso offset', async () => {
    const { server, dip } = banco([0])
    await accoda(dip)

    server.interrompiLaProssimaPatchDopo = 700_000
    const esito = await caricaVideo(dip, JOB)

    expect(esito).toEqual({ esito: 'caricato', jobId: JOB, byteCaricati: DIMENSIONE })
    expect(server.metodi().filter((m) => m === 'POST')).toHaveLength(1)
    expect(server.viste.find((v) => v.metodo === 'HEAD')?.offset).toBe(700_000)
    expect(server.viste.reduce((s, v) => s + v.byteAccettati, 0)).toBe(DIMENSIONE)
    expect(Buffer.from(server.unicoOggetto()!.byte).equals(Buffer.from(byteOriginali()))).toBe(
      true,
    )
  })

  it('«riprendi tutto» ripesca ciò che è rimasto a metà e lo porta in fondo', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    server.interrompiLaProssimaPatchDopo = 120_000
    await caricaVideo(dip, JOB)

    const esiti = await riprendiCaricamentiVideo(dip)

    expect(esiti).toEqual([{ esito: 'caricato', jobId: JOB, byteCaricati: DIMENSIONE }])
    expect((await archivio.leggi(JOB))?.stato).toBe('caricato')
    expect(server.metodi().filter((m) => m === 'POST')).toHaveLength(1)
  })

  it('dopo il completamento il job resta da seguire, anche a byte liberati', async () => {
    const { dip } = banco()
    await accoda(dip)
    await caricaVideo(dip, JOB)

    const daSeguire = await jobDaSeguire(dip)
    expect(daSeguire).toEqual([{ jobId: JOB, intentId: INTENT, canale: 'gallery' }])
    // E non c'è più niente da riprendere: il lavoro non si rifà.
    expect(await riprendiCaricamentiVideo(dip)).toEqual([])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 3. IL MIME COL SUFFISSO DEL CODEC
 * ──────────────────────────────────────────────────────────────────────────── */

describe('il MIME che arriva dal dispositivo', () => {
  /**
   * `MediaRecorder` consegna `video/mp4;codecs=avc1.42E01E,mp4a.40.2`, e in questo
   * repo un confronto per uguaglianza su quel valore ha già fermato TUTTI i video
   * della galleria per un giorno (2026-09-08, 33 tentativi respinti, 8 insegnanti).
   * I confronti da sistemare erano DUE, non uno: quello applicativo e l'header che
   * lo Storage misura contro `allowed_mime_types`. Questo test li guarda entrambi.
   */
  it('accetta il suffisso dei codec e spedisce allo Storage il solo container', async () => {
    const { server, archivio, dip } = banco()

    const accodato = await accoda(dip, 'video/mp4;codecs=avc1.42E01E,mp4a.40.2')
    expect(accodato.ok).toBe(true)

    await caricaVideo(dip, JOB)

    expect(server.unicoOggetto()!.metadata.contentType).toBe('video/mp4')
    expect((await archivio.leggi(JOB))?.mime).toBe('video/mp4')
  })

  it('un file di un altro formato non parte nemmeno', async () => {
    const { server, dip } = banco()

    const accodato = await accoda(dip, 'video/webm')

    expect(accodato).toEqual({ ok: false, codice: 'VIDEO_FORMATO_NON_SUPPORTATO' })
    expect(server.viste).toHaveLength(0)
  })

  /** Alcuni selettori Android consegnano un `File` senza tipo: non è un rifiuto. */
  it('un file senza tipo dichiarato si fida delle coordinate', async () => {
    const { server, dip } = banco()

    expect((await accoda(dip, '')).ok).toBe(true)
    await caricaVideo(dip, JOB)

    expect(server.unicoOggetto()!.metadata.contentType).toBe('video/mp4')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 4. ANNULLAMENTO — né job orfano, né riga che nessuno ripulisce
 * ──────────────────────────────────────────────────────────────────────────── */

describe('l’annullamento', () => {
  it('con il segnale già annullato non parte nessuna richiesta', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    const controllore = new AbortController()
    controllore.abort()

    const esito = await caricaVideo(dip, JOB, { segnale: controllore.signal })

    expect(esito).toEqual({ esito: 'annullato', jobId: JOB })
    expect(server.viste).toHaveLength(0)
    expect((await archivio.leggi(JOB))?.stato).toBe('annullato')
    expect(await archivio.leggiByte(JOB)).toBeUndefined()
  })

  it('in volo: termina la sessione TUS, così sullo Storage non resta un orfano', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    const controllore = new AbortController()

    let primaPatchVista = false
    server.dopoLaRichiesta = (v) => {
      if (v.metodo === 'PATCH' && !primaPatchVista) {
        primaPatchVista = true
        controllore.abort()
      }
    }

    const esito = await caricaVideo(dip, JOB, { segnale: controllore.signal })

    expect(esito).toEqual({ esito: 'annullato', jobId: JOB })
    expect(server.metodi()).toContain('DELETE')
    expect(server.oggetti.size).toBe(0)

    const riga = await archivio.leggi(JOB)
    expect(riga?.stato).toBe('annullato')
    expect(await archivio.leggiByte(JOB)).toBeUndefined()
    // E non torna a galla alla prossima riapertura dell'app.
    expect(await riprendiCaricamentiVideo(dip)).toEqual([])
  })

  it('annullare una riga ferma termina comunque la sessione aperta', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    server.interrompiLaProssimaPatchDopo = 50_000
    await caricaVideo(dip, JOB)
    expect(server.oggetti.size).toBe(1)

    await annullaCaricamentoVideo(dip, JOB)

    expect(server.metodi()).toContain('DELETE')
    expect(server.oggetti.size).toBe(0)
    expect((await archivio.leggi(JOB))?.stato).toBe('annullato')
    expect(await archivio.leggiByte(JOB)).toBeUndefined()
  })

  it('la potatura porta via le righe ferme da più del TTL, byte compresi', async () => {
    const { archivio, dip } = banco()
    await accoda(dip)

    const potate = await potaArchivioCaricamenti(
      { ...dip, adesso: () => new Date('2026-10-18T09:00:00.000Z') },
    )

    expect(potate).toBe(1)
    expect(await archivio.leggi(JOB)).toBeUndefined()
    expect(await archivio.leggiByte(JOB)).toBeUndefined()
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 5. I RIFIUTI DELLO STORAGE — che cosa si riprova e che cosa no
 * ──────────────────────────────────────────────────────────────────────────── */

describe('quando lo Storage dice di no', () => {
  /**
   * 401 e 403 sono «no» che una PERSONA toglie di mezzo: la sessione è scaduta,
   * basta rientrare. È la stessa politica della coda della primaria
   * (`RIMEDIABILI` in `syncEngine.ts`): la riga deve essere ancora lì quando
   * qualcuno rimedia, e i byte pure — altrimenti si chiede a un genitore di
   * riscegliere un video da due gigabyte perché il token era vecchio di un'ora.
   */
  it('401: resta ripescabile, i byte non si buttano, e lo schermo ha che cosa dire', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    server.statoForzatoSullaProssimaPatch = 401

    const esito = await caricaVideo(dip, JOB)

    expect(esito).toEqual({
      esito: 'interrotto',
      jobId: JOB,
      offsetByte: 0,
      codice: 'VIDEO_NON_AUTORIZZATO',
    })
    expect((await archivio.leggi(JOB))?.stato).toBe('in_corso')
    expect((await archivio.leggiByte(JOB))?.size).toBe(DIMENSIONE)
    expect((await riprendiCaricamentiVideo({ ...dip, pilaHttp: server })).length).toBe(1)
  })

  it('413: è definitivo, la riga si chiude e i byte si liberano', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    server.statoForzatoSullaProssimaPatch = 413

    const esito = await caricaVideo(dip, JOB)

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_TROPPO_GRANDE' })
    expect((await archivio.leggi(JOB))?.stato).toBe('fallito')
    expect(await archivio.leggiByte(JOB)).toBeUndefined()
  })

  it('404 sulla sessione: le coordinate non valgono più, si riapre l’intento', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    server.statoForzatoSullaProssimaPatch = 404

    const esito = await caricaVideo(dip, JOB)

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_RIPROVA' })
    expect((await archivio.leggi(JOB))?.stato).toBe('fallito')
  })

  /**
   * IL GUASTO CHE OGGI SAREBBE MUTO: il browser sfratta IndexedDB per fare posto,
   * i metadati restano e i byte no. Senza questo ramo la ripresa partirebbe con un
   * `Blob` `undefined` e morirebbe dentro tus con un messaggio che non nomina la
   * causa.
   */
  it('byte spariti dal dispositivo: fallisce dicendolo, invece di rompersi dentro', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    // L'app si riapre (archivio nuovo, quindi nessun file vivo in memoria) e il
    // browser nel frattempo ha sfrattato i byte lasciando la riga.
    const riaperto = new ArchivioCaricamentiInMemoria()
    await riaperto.scrivi((await archivio.leggi(JOB))!)

    const esito = await caricaVideo({ ...dip, archivio: riaperto }, JOB)

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_RIPROVA' })
    expect(server.viste).toHaveLength(0)
    expect(
      logClient.mock.calls.some(
        ([e]) => e.livello === 'error' && String(e.messaggio).includes('byte-spariti'),
      ),
    ).toBe(true)
  })

  it('un job che non esiste non lancia: lo dice', async () => {
    const { dip } = banco()
    const esito = await caricaVideo(dip, 'non-esiste')
    expect(esito).toEqual({ esito: 'fallito', jobId: 'non-esiste', codice: 'VIDEO_NON_TROVATO' })
  })

  /**
   * IL DOPPIO TOCCO. `accoda` due volte sullo stesso job — un pulsante premuto
   * due volte, un `useEffect` che rimonta — non deve azzerare `urlTus`: sarebbe
   * la ripresa buttata via da un tocco, con i byte già sullo Storage che nessuno
   * andrebbe più a riprendere.
   */
  it('accodare due volte lo stesso job non cancella il punto di ripresa', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    server.interrompiLaProssimaPatchDopo = 90_000
    await caricaVideo(dip, JOB)
    const urlPrimaDiRiaccodare = (await archivio.leggi(JOB))?.urlTus
    expect(urlPrimaDiRiaccodare).toBeTruthy()

    const secondo = await accoda(dip)

    expect(secondo.ok).toBe(true)
    expect((await archivio.leggi(JOB))?.urlTus).toBe(urlPrimaDiRiaccodare)
    expect((await archivio.leggi(JOB))?.offsetByte).toBe(90_000)
  })

  /**
   * LE INTESTAZIONI CHE NON ARRIVANO: il client Supabase non riesce a rinnovare
   * la sessione e `intestazioni()` rigetta. Senza questo ramo la promessa di
   * `caricaVideo` rigetterebbe, e la schermata che l'ha chiamata resterebbe con
   * la rotellina e senza una riga da nessuna parte.
   */
  it('se la sessione non si risolve, non lancia: lo dice e resta ripescabile', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)

    const esito = await caricaVideo(
      { ...dip, intestazioni: () => Promise.reject(new TypeError('sessione non rinnovata')) },
      JOB,
    )

    expect(esito).toEqual({
      esito: 'interrotto',
      jobId: JOB,
      offsetByte: 0,
      codice: 'VIDEO_NON_AUTORIZZATO',
    })
    expect(server.viste).toHaveLength(0)
    expect((await archivio.leggi(JOB))?.stato).toBe('in_corso')
    expect((await archivio.leggiByte(JOB))?.size).toBe(DIMENSIONE)
    expect(
      logClient.mock.calls.some(
        ([e]) => String(e.messaggio).includes('video-upload-sessione-non-risolta'),
      ),
    ).toBe(true)
  })

  it('un file più grande del tetto non si accoda nemmeno', async () => {
    const { archivio, dip } = banco()
    const enorme = {
      size: 2_000_000_001,
      type: 'video/mp4',
      name: 'lungo.mp4',
      slice: () => new Blob(),
    } as unknown as File

    const accodato = await accodaCaricamentoVideo(dip, {
      jobId: JOB,
      intentId: INTENT,
      canale: 'gallery',
      chiaveIdempotenza: 'chiave-1',
      coordinate: COORDINATE,
      file: enorme,
    })

    expect(accodato).toEqual({ ok: false, codice: 'VIDEO_TROPPO_GRANDE' })
    expect(await archivio.elenca()).toEqual([])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 6. I LOG
 * ──────────────────────────────────────────────────────────────────────────── */

describe('che cosa lascia scritto', () => {
  /**
   * AGENTS.md §5: gli eventi critici loggano ANCHE il successo. Senza la riga del
   * successo, «nessun log» non distingue «tutto ok» da «non è mai partito
   * niente» — ed è esattamente l'ambiguità che ha tenuto nascosto per mesi il
   * guasto delle email di credenziali.
   */
  it('logga il successo, non solo i guasti', async () => {
    const { dip } = banco()
    await accoda(dip)
    await caricaVideo(dip, JOB)

    const riuscito = logClient.mock.calls.find(([e]) =>
      String(e.messaggio).startsWith('video-upload-riuscito'),
    )
    expect(riuscito).toBeDefined()
    expect(riuscito![0].evento).toBe('fetch')
    expect(riuscito![0].campi).toMatchObject({ byte: DIMENSIONE })
  })

  it('logga anche l’interruzione, con l’offset da cui si riprenderà', async () => {
    const { server, dip } = banco()
    await accoda(dip)
    server.interrompiLaProssimaPatchDopo = 300_000

    await caricaVideo(dip, JOB)

    const interrotto = logClient.mock.calls.find(([e]) =>
      String(e.messaggio).startsWith('video-upload-interrotto'),
    )
    expect(interrotto).toBeDefined()
    expect(interrotto![0].campi).toMatchObject({ offset: 300_000 })
  })

  /**
   * 🔴 IL NOME DEL FILE NON È UN UUID. `recita-di-natale.mp4` è già discreto; i
   * nomi veri sono `IMG_bambina-rossi.mov`, cioè anagrafica di un minore, e
   * `app_log` li terrebbe trenta giorni interrogabili in SQL.
   */
  it('nessun log porta il nome del file', async () => {
    const { server, dip } = banco()
    await accoda(dip)
    server.interrompiLaProssimaPatchDopo = 300_000
    await caricaVideo(dip, JOB)
    await caricaVideo(dip, JOB)

    expect(logClient.mock.calls.length).toBeGreaterThan(0)
    expect(JSON.stringify(logClient.mock.calls)).not.toContain('recita-di-natale')
  })
})


describe('riprese sovrapposte dello stesso job', () => {
  it('due chiamate in contemporanea condividono un unico trasferimento TUS', async () => {
    const { server, dip } = banco()
    await accoda(dip)
    const risultati = await Promise.all([caricaVideo(dip, JOB), caricaVideo(dip, JOB)])
    expect(risultati.every(r => r.esito === 'caricato')).toBe(true)
    expect(server.viste.filter(v => v.metodo === 'POST')).toHaveLength(1)
  })
  it('riaccodare un job caricato conserva lo stato senza rispedire i byte', async () => {
    const { archivio, dip } = banco()
    await accoda(dip)
    await caricaVideo(dip, JOB)
    await accoda(dip)
    expect((await archivio.leggi(JOB))?.stato).toBe('caricato')
    expect(await archivio.leggiByte(JOB)).toBeUndefined()
  })
})


it('rinnova le intestazioni fra i chunk quando la firma scade durante il trasferimento', async () => {
  const { server, dip } = banco()
  await accoda(dip)
  let richieste = 0
  const intestazioni = () => ({ 'x-signature': ++richieste <= 2 ? 'prima-firma' : 'firma-rinnovata' })
  await caricaVideo({ ...dip, intestazioni }, JOB)
  expect(server.viste.some(v => v.intestazioni['x-signature'] === 'firma-rinnovata')).toBe(true)
  expect(server.viste.filter(v => v.metodo === 'POST')).toHaveLength(1)
})

/* ────────────────────────────────────────────────────────────────────────────
 * 7. LA SORGENTE VIVA E I BYTE LOCALI (critica indipendente del 2026-09-26)
 * ──────────────────────────────────────────────────────────────────────────── */

/** L'app riaperta: un archivio nuovo con la stessa riga, e nessun file in memoria. */
async function riapri(archivio: ArchivioCaricamentiInMemoria) {
  const riaperto = new ArchivioCaricamentiInMemoria()
  await riaperto.scrivi((await archivio.leggi(JOB))!)
  return riaperto
}

function logCon(prefisso: string) {
  return logClient.mock.calls.find(([e]) => String(e.messaggio).startsWith(prefisso))?.[0]
}

describe('la sorgente viva e i byte salvati sul dispositivo', () => {
  it('nella stessa sessione i byte sfrattati non fermano l’invio: si legge il file scelto', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    await archivio.eliminaByte(JOB)

    const esito = await caricaVideo(dip, JOB)

    expect(esito).toEqual({ esito: 'caricato', jobId: JOB, byteCaricati: DIMENSIONE })
    expect(Buffer.from(server.unicoOggetto()!.byte).equals(Buffer.from(byteOriginali()))).toBe(true)
  })

  it('telefono pieno: il salvataggio locale fallisce, il video parte lo stesso e resta scritto il perché', async () => {
    const { server, archivio, dip } = banco()
    const quota = Object.assign(new Error('abort'), {
      name: 'AbortError',
      inner: Object.assign(new Error(''), { name: 'QuotaExceededError' }),
    })
    archivio.scriviByte = async () => { throw quota }

    const accodato = await accoda(dip)

    expect(accodato.ok).toBe(true)
    expect(await archivio.leggi(JOB)).toBeDefined()
    expect(logCon('video-upload-archivio-degradato')).toMatchObject({
      livello: 'error',
      campi: { error_code: 'AbortError', causa: 'QuotaExceededError' },
    })
    const esito = await caricaVideo(dip, JOB)
    expect(esito.esito).toBe('caricato')
    expect(Buffer.from(server.unicoOggetto()!.byte).equals(Buffer.from(byteOriginali()))).toBe(true)
  })

  it('riaccodare lo stesso video con il deposito già intero non lo ricopia', async () => {
    const { archivio, dip } = banco()
    const scrivi = archivio.scriviByte.bind(archivio)
    let copie = 0
    archivio.scriviByte = async (id, byte) => { copie++; await scrivi(id, byte) }

    await accoda(dip)
    await accoda(dip)
    expect(copie).toBe(1)

    await archivio.eliminaByte(JOB)
    await accoda(dip)
    expect(copie).toBe(2)
  })

  it('un blocco mancante nel deposito chiude come fallito, senza quattro ritentativi', async () => {
    const { server, archivio, dip } = banco([0, 0, 0, 0])
    await accoda(dip)
    const riaperto = await riapri(archivio)
    let letture = 0
    let liberati = 0
    riaperto.leggiByte = async () => ({
      size: DIMENSIONE,
      type: 'video/mp4',
      async leggiIntervallo() {
        letture++
        throw new ErroreByteVideo('VIDEO_BLOCCO_INCOMPLETO')
      },
    })
    riaperto.eliminaByte = async () => { liberati++ }

    const esito = await caricaVideo({ ...dip, archivio: riaperto }, JOB)

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_RIPROVA' })
    expect(letture).toBe(1)
    expect(server.viste.filter((v) => v.metodo === 'HEAD')).toHaveLength(0)
    expect((await riaperto.leggi(JOB))?.stato).toBe('fallito')
    expect(liberati).toBe(1)
    expect(logCon('video-upload-byte-locali-rotti')?.campi).toMatchObject({ error_code: 'VIDEO_BLOCCO_INCOMPLETO' })
  })

  it('un manifest illeggibile non lancia: chiude come fallito prima di aprire la rete', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    const riaperto = await riapri(archivio)
    riaperto.leggiByte = async () => { throw new ErroreByteVideo('VIDEO_ARCHIVIO_NON_VALIDO') }

    const esito = await caricaVideo({ ...dip, archivio: riaperto }, JOB)

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_RIPROVA' })
    expect(server.viste).toHaveLength(0)
    expect(logCon('video-upload-byte-locali-rotti')?.campi).toMatchObject({ error_code: 'VIDEO_ARCHIVIO_NON_VALIDO' })
  })

  it('IndexedDB momentaneamente irraggiungibile: resta ripescabile e non butta niente', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    const riaperto = await riapri(archivio)
    let liberati = 0
    riaperto.leggiByte = async () => { throw Object.assign(new Error('connessione persa'), { name: 'UnknownError' }) }
    riaperto.eliminaByte = async () => { liberati++ }

    const esito = await caricaVideo({ ...dip, archivio: riaperto }, JOB)

    expect(esito).toEqual({ esito: 'interrotto', jobId: JOB, offsetByte: 0, codice: null })
    expect(server.viste).toHaveLength(0)
    expect(liberati).toBe(0)
    expect(logCon('video-upload-deposito-illeggibile')?.campi).toMatchObject({ error_code: 'UnknownError' })
  })

  it('se il file scelto non si legge più, il tentativo dopo riparte dalla copia salvata', async () => {
    const { server, archivio, dip } = banco([0, 0, 0, 0])
    const copia = new Blob([byteOriginali()])
    archivio.scriviByte = (id) => ArchivioCaricamentiInMemoria.prototype.scriviByte.call(archivio, id, copia)
    const file = new File([byteOriginali()], 'recita-di-natale.mp4', { type: 'video/mp4' })
    await accodaCaricamentoVideo(dip, {
      jobId: JOB, intentId: INTENT, canale: 'gallery', chiaveIdempotenza: 'chiave-1', coordinate: COORDINATE, file,
    })
    file.slice = () => { throw Object.assign(new Error('illeggibile'), { name: 'NotReadableError' }) }

    const primo = await caricaVideo(dip, JOB)

    expect(primo).toMatchObject({ esito: 'interrotto', codice: null })
    expect(server.viste.filter((v) => v.metodo === 'HEAD')).toHaveLength(0)
    expect(logCon('video-upload-interrotto')?.campi).toMatchObject({ lettura_locale: true, causa: 'NotReadableError' })

    const secondo = await caricaVideo(dip, JOB)

    expect(secondo.esito).toBe('caricato')
    expect(Buffer.from(server.unicoOggetto()!.byte).equals(Buffer.from(byteOriginali()))).toBe(true)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 8. SECONDA CRITICA INDIPENDENTE (2026-09-26): i rami non coperti
 * ──────────────────────────────────────────────────────────────────────────── */

describe('i rami che la seconda critica ha trovato scoperti', () => {
  it('se nemmeno la riga si scrive, il video si rifiuta con un codice invece di lanciare', async () => {
    const { archivio, dip } = banco()
    archivio.scrivi = async () => { throw Object.assign(new Error('chiuso'), { name: 'DatabaseClosedError' }) }

    const accodato = await accoda(dip)

    expect(accodato).toEqual({ ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' })
    // Senza riga nessuno riprenderà quei byte: lo spazio si libera subito.
    expect(await archivio.leggiByte(JOB)).toBeUndefined()
    expect(logCon('video-upload-riga-non-scritta')).toMatchObject({
      livello: 'error',
      messaggio: `video-upload-riga-non-scritta: job=${JOB}`,
      campi: { error_code: 'DatabaseClosedError' },
    })
  })

  it('riaccodando, un deposito illeggibile si riscrive invece di essere riusato', async () => {
    const { archivio, dip } = banco()
    const scrivi = archivio.scriviByte.bind(archivio)
    let copie = 0
    archivio.scriviByte = async (id, byte) => { copie++; await scrivi(id, byte) }
    await accoda(dip)
    archivio.leggiByte = async () => { throw new ErroreByteVideo('VIDEO_ARCHIVIO_NON_VALIDO') }

    const secondo = await accoda(dip)

    expect(secondo.ok).toBe(true)
    expect(copie).toBe(2)
    expect(logCon('video-upload-deposito-da-riscrivere')?.campi).toMatchObject({ error_code: 'VIDEO_ARCHIVIO_NON_VALIDO' })
  })

  it('i ritentativi di tus restano quelli di prima per la rete: un 5xx si ritenta, un 4xx no', async () => {
    const primo = banco([0, 0, 0])
    await accoda(primo.dip)
    primo.server.statoForzatoSullaProssimaPatch = 503
    expect((await caricaVideo(primo.dip, JOB)).esito).toBe('caricato')
    expect(primo.server.viste.filter((v) => v.metodo === 'HEAD').length).toBeGreaterThan(0)

    const secondo = banco([0, 0, 0])
    await accoda(secondo.dip)
    secondo.server.statoForzatoSullaProssimaPatch = 400
    expect(await caricaVideo(secondo.dip, JOB)).toEqual({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' })
    expect(secondo.server.viste.filter((v) => v.metodo === 'HEAD')).toHaveLength(0)
  })

  it('i log del caricamento portano il job nel messaggio (la deduplica ignora i campi)', async () => {
    const { dip } = banco()
    await accoda(dip)
    await caricaVideo(dip, JOB)
    expect(logCon('video-upload-riuscito')?.messaggio).toBe(`video-upload-riuscito: job=${JOB}`)
  })

  it('un caricamento chiuso come fallito dimentica il file vivo: riaperto a mano non riparte da lì', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    server.statoForzatoSullaProssimaPatch = 404
    expect((await caricaVideo(dip, JOB)).esito).toBe('fallito')
    const richiestePrima = server.viste.length
    await archivio.aggiorna(JOB, { stato: 'in_corso', codice: null })

    const esito = await caricaVideo(dip, JOB)

    expect(esito).toEqual({ esito: 'fallito', jobId: JOB, codice: 'VIDEO_RIPROVA' })
    expect(server.viste.length).toBe(richiestePrima)
    expect(logCon('video-upload-byte-spariti')).toBeDefined()
  })

  it('la potatura all’avvio toglie anche i depositi orfani, e un suo errore non ferma la schermata', async () => {
    const { archivio: base, dip } = banco()
    // L'archivio in memoria non ha depositi orfani: qui si prova solo chi lo chiama.
    const archivio = base as ArchivioCaricamentiInMemoria & { potaDepositiOrfani?: () => Promise<number> }
    archivio.potaDepositiOrfani = async () => 2
    await potaArchivioCaricamenti(dip)
    expect(logCon('video-upload-potatura-orfani')?.campi).toMatchObject({ depositi: 2 })

    logClient.mockClear()
    archivio.potaDepositiOrfani = async () => { throw Object.assign(new Error('x'), { name: 'UnknownError' }) }
    await expect(potaArchivioCaricamenti(dip)).resolves.toBe(0)
    expect(logCon('video-upload-potatura-orfani-fallita')?.campi).toMatchObject({ error_code: 'UnknownError' })
  })
})

describe('terza critica indipendente (2026-09-26)', () => {
  it('un archivio che non si legge rifiuta il video con un codice, senza lanciare', async () => {
    const { archivio, dip } = banco()
    archivio.leggi = async () => { throw Object.assign(new Error('chiuso'), { name: 'DatabaseClosedError' }) }

    expect(await accoda(dip)).toEqual({ ok: false, codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' })
    expect(logCon('video-upload-riga-illeggibile')?.campi).toMatchObject({ error_code: 'DatabaseClosedError' })
  })

  it('una copia intera rimasta senza riga si riusa invece di ricopiarla accanto', async () => {
    const { archivio, dip } = banco()
    await archivio.scriviByte(JOB, new Blob([byteOriginali()]))
    const scrivi = archivio.scriviByte.bind(archivio)
    let copie = 0
    archivio.scriviByte = async (id, byte) => { copie++; await scrivi(id, byte) }

    expect((await accoda(dip)).ok).toBe(true)
    expect(copie).toBe(0)
  })

  it.each([
    ['caricato da un\'altra scheda', 'caricato' as const],
    ['tolto dall\'elenco', 'rimosso' as const],
  ])('se durante la lettura il caricamento è stato %s, quello stato vince', async (_nome, come) => {
    const { archivio, dip } = banco([0, 0])
    await accoda(dip)
    const riaperto = await riapri(archivio)
    riaperto.leggiByte = async () => ({
      size: DIMENSIONE,
      type: 'video/mp4',
      async leggiIntervallo() {
        if (come === 'caricato') await riaperto.aggiorna(JOB, { stato: 'caricato' })
        else await riaperto.elimina(JOB)
        throw new ErroreByteVideo('VIDEO_BLOCCO_INCOMPLETO')
      },
    })

    const esito = await caricaVideo({ ...dip, archivio: riaperto }, JOB)

    if (come === 'caricato') {
      expect(esito).toEqual({ esito: 'caricato', jobId: JOB, byteCaricati: DIMENSIONE })
      expect((await riaperto.leggi(JOB))?.stato).toBe('caricato')
    } else {
      expect(esito).toEqual({ esito: 'annullato', jobId: JOB })
      expect(await riaperto.leggi(JOB)).toBeUndefined()
    }
    expect(logCon('video-upload-concluso-altrove')).toBeDefined()
    expect(logCon('video-upload-byte-locali-rotti')).toBeUndefined()
  })

  it('un manifest che sparisce prima di tus, perché un\'altra scheda ha finito, non chiude come fallito', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    const riaperto = await riapri(archivio)
    riaperto.leggiByte = async () => {
      await riaperto.aggiorna(JOB, { stato: 'caricato' })
      throw new ErroreByteVideo('VIDEO_ARCHIVIO_NON_VALIDO')
    }

    expect(await caricaVideo({ ...dip, archivio: riaperto }, JOB)).toEqual({ esito: 'caricato', jobId: JOB, byteCaricati: DIMENSIONE })
    expect((await riaperto.leggi(JOB))?.stato).toBe('caricato')
    expect(server.viste).toHaveLength(0)
  })

  it('i byte spariti perché un\'altra scheda ha appena finito non chiudono il caricamento come fallito', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    const riaperto = await riapri(archivio)
    // È ciò che fa l'archivio vero: finito altrove, il manifest non c'è più e
    // leggiByte risponde undefined.
    riaperto.leggiByte = async () => {
      await riaperto.aggiorna(JOB, { stato: 'caricato' })
      return undefined
    }

    expect((await caricaVideo({ ...dip, archivio: riaperto }, JOB)).esito).toBe('caricato')
    expect((await riaperto.leggi(JOB))?.stato).toBe('caricato')
    expect(server.viste).toHaveLength(0)
    expect(logCon('video-upload-byte-spariti')).toBeUndefined()
  })

  it('quando vince lo stato concluso altrove, l\'errore dello Storage resta scritto', async () => {
    const { server, archivio, dip } = banco()
    await accoda(dip)
    const riaperto = await riapri(archivio)
    const copia = new Blob([byteOriginali()])
    riaperto.leggiByte = async () => ({
      size: DIMENSIONE,
      type: 'video/mp4',
      async leggiIntervallo(inizio: number, fine: number) {
        await riaperto.aggiorna(JOB, { stato: 'annullato' })
        return new Uint8Array(await copia.slice(inizio, fine).arrayBuffer())
      },
    })
    server.statoForzatoSullaProssimaPatch = 403

    expect(await caricaVideo({ ...dip, archivio: riaperto }, JOB)).toEqual({ esito: 'annullato', jobId: JOB })
    expect(logCon('video-upload-concluso-altrove')?.campi).toMatchObject({ stato: 'annullato', stato_http: 403 })
  })

  it('un errore transitorio arrivato dopo che un\'altra scheda ha finito non riporta la riga a «in corso»', async () => {
    const { archivio, dip } = banco([0, 0])
    await accoda(dip)
    const riaperto = await riapri(archivio)
    riaperto.leggiByte = async () => ({
      size: DIMENSIONE,
      type: 'video/mp4',
      async leggiIntervallo() {
        await riaperto.aggiorna(JOB, { stato: 'caricato' })
        throw Object.assign(new Error('connessione persa'), { name: 'UnknownError' })
      },
    })

    expect((await caricaVideo({ ...dip, archivio: riaperto }, JOB)).esito).toBe('caricato')
    expect((await riaperto.leggi(JOB))?.stato).toBe('caricato')
  })
})
