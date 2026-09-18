import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CODICI_CONSEGNA_VIDEO_NEWS,
  MIME_ALLEGATO_VIDEO_NEWS,
  consegnaVideoInBozzaNews,
  normalizzaMimeAllegato,
  percorsoAllegatoVideoNews,
  ritiraAllegatiVideoNews,
  TETTO_VIDEO_NEWS_BYTE,
} from '@/lib/news/video-allegato'
import { NEWS_BUCKET_BOZZE, pathBozza } from '@/lib/news/media-bozza'
import { caricatoDa } from '@/lib/news/permanenza-consenso'
import { NEWS_BUCKET } from '@/lib/news/tipi'

// =============================================================================
// IL VIDEO DIVENTA UN ALLEGATO DI BOZZA ORDINARIO — e il resto non lo sa.
//
// La decisione (piano V09): per le News la copia nel bucket delle bozze avviene
// AL MOMENTO DEL `ready`, cioè quando il runner ha finito di convertire. Da quel
// momento il video è un allegato di bozza come una foto, e la pubblicazione è
// quella che esiste già — `promuoviMediaBozza`, non toccata.
//
// Costa una copia in più. In cambio la superficie di privacy più delicata del
// repository (il percorso che decide che cosa una famiglia vede) resta INTATTA:
// il legame fra questa consegna e quella promozione è inchiodato in
// `video-allegato-promozione.test.ts`.
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'
const BUCKET_USCITA = 'video_processing'
const PERCORSO_USCITA = `esiti/${JOB}/1/uscita.mp4`

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

/** Le righe di evento registrate, in forma comoda da interrogare. */
type RigaLog = { evento: string; livello: string; campi: Record<string, unknown> }
const righe = (): RigaLog[] =>
  h.logEvento.mock.calls.map((c) => ({
    evento: String(c[0]),
    livello: String(c[1]),
    campi: (c[2] ?? {}) as Record<string, unknown>,
  }))

const conEsito = (esito: string) => righe().filter((r) => r.campi.esito === esito)

interface OpzioniFinto {
  /** Il `content-type` con cui l'uscita è stata scritta nel bucket di lavorazione. */
  mimeUscita?: string | null
  /** Quanto pesa l'uscita, come lo Storage la racconta. `null` = non si sa. */
  byteUscita?: number | null
  /** L'uscita non c'è (o non si riesce a sapere se c'è). */
  uscitaAssente?: boolean
  erroreList?: { message: string } | null
  erroreCopy?: { message: string } | null
  /** `copy()` LANCIA invece di ritornare `{ error }` (guasto di trasporto). */
  copyLancia?: boolean
  erroreFirma?: { message: string } | null
  /** `remove()` non toglie niente e `list()` conferma che il file è ancora lì. */
  rimozioneInefficace?: boolean
  /** `remove()` non nomina niente e il file NON c'è più: l'esito voluto c'era già. */
  fileGiaAssente?: boolean
}

function clientFinto(o: OpzioniFinto = {}) {
  const tracce = {
    copy: [] as { da: string; a: string; bucketSorgente: string; destinationBucket?: string }[],
    upload: [] as { bucket: string; percorso: string }[],
    remove: [] as { bucket: string; percorsi: string[] }[],
    firmati: [] as { bucket: string; percorso: string }[],
    list: [] as { bucket: string; cartella: string }[],
  }
  const mime = o.mimeUscita === undefined ? MIME_ALLEGATO_VIDEO_NEWS : o.mimeUscita
  const byte = o.byteUscita === undefined ? 8_000_000 : o.byteUscita
  const client = {
    storage: {
      from: (bucket: string) => ({
        list: async (cartella: string, opts?: { search?: string }) => {
          tracce.list.push({ bucket, cartella })
          if (o.erroreList) return { data: null, error: o.erroreList }
          // Dopo una `remove()` inefficace il file risulta ANCORA presente: è il
          // caso che `rimuoviEVerifica` esiste per distinguere da «non c'era più».
          if (bucket === NEWS_BUCKET_BOZZE) {
            return o.rimozioneInefficace
              ? { data: [{ name: opts?.search, metadata: { mimetype: mime, size: byte } }], error: null }
              : { data: [], error: null }
          }
          if (o.uscitaAssente) return { data: [], error: null }
          return { data: [{ name: opts?.search, metadata: { mimetype: mime, size: byte } }], error: null }
        },
        copy: async (da: string, a: string, opz?: { destinationBucket?: string }) => {
          tracce.copy.push({ da, a, bucketSorgente: bucket, destinationBucket: opz?.destinationBucket })
          if (o.copyLancia) throw new Error('fetch failed')
          if (o.erroreCopy) return { data: null, error: o.erroreCopy }
          return { data: { path: a }, error: null }
        },
        upload: async (percorso: string) => {
          tracce.upload.push({ bucket, percorso })
          return { data: { path: percorso }, error: null }
        },
        remove: async (percorsi: string[]) => {
          tracce.remove.push({ bucket, percorsi })
          const tolti = o.rimozioneInefficace || o.fileGiaAssente ? [] : percorsi.map((p) => ({ name: p }))
          return { data: tolti, error: null }
        },
        createSignedUrl: async (percorso: string) => {
          tracce.firmati.push({ bucket, percorso })
          if (o.erroreFirma) return { data: null, error: o.erroreFirma }
          return {
            data: { signedUrl: `https://cdn.test/storage/v1/object/sign/${bucket}/${percorso}?token=x` },
            error: null,
          }
        },
      }),
    },
  }
  return { client, tracce }
}

const job = { id: JOB, ownerId: OWNER, bucketUscita: BUCKET_USCITA, percorsoUscita: PERCORSO_USCITA }

beforeEach(() => {
  h.logEvento.mockClear()
  h.logErrore.mockClear()
})

describe('il percorso dell’allegato video parla la lingua che il resto di News già capisce', () => {
  it('ha la forma `uploads/<proprietario>/<file>` e `pathBozza` la riconosce sull’indirizzo firmato', () => {
    const percorso = percorsoAllegatoVideoNews(OWNER, JOB)
    expect(percorso).toBe(`uploads/${OWNER}/${JOB}.mp4`)

    const firmato = `https://cdn.test/storage/v1/object/sign/${NEWS_BUCKET_BOZZE}/${percorso}?token=x`
    expect(pathBozza(firmato)).toBe(percorso)
  })

  it('il primo segmento è il PROPRIETARIO: è l’unica traccia da cui `caricatoDa` riconosce il padrone', () => {
    // Se qui ci finisse l'id del job, `mediaEstranei` vedrebbe un file «di un
    // altro» e la creazione del post morirebbe con un 403 che nessuno saprebbe
    // spiegare. Il legame completo sta in `video-allegato-promozione.test.ts`.
    expect(caricatoDa(percorsoAllegatoVideoNews(OWNER, JOB))).toBe(OWNER)
  })

  it('rifiuta tutto ciò che non è un uuid: niente `..`, niente barre, niente stringhe vuote', () => {
    expect(percorsoAllegatoVideoNews('../../etc', JOB)).toBeNull()
    expect(percorsoAllegatoVideoNews(OWNER, 'a/b')).toBeNull()
    expect(percorsoAllegatoVideoNews('', JOB)).toBeNull()
    expect(percorsoAllegatoVideoNews(OWNER, null)).toBeNull()
    expect(percorsoAllegatoVideoNews(42, JOB)).toBeNull()
  })
})

describe('il MIME col suffisso del codec — e i confronti sono DUE', () => {
  it('`normalizzaMimeAllegato` toglie il suffisso: un confronto per uguaglianza esatta respingerebbe un mp4 valido', () => {
    expect(normalizzaMimeAllegato('video/mp4;codecs=avc1')).toBe('video/mp4')
    expect(normalizzaMimeAllegato('video/mp4; codecs="avc1.640028, mp4a.40.2"')).toBe('video/mp4')
    expect(normalizzaMimeAllegato(' VIDEO/MP4 ')).toBe('video/mp4')
    expect(normalizzaMimeAllegato(null)).toBe('')
  })

  it('IL SECONDO CONFRONTO È DELLO STORAGE: un’uscita scritta con il suffisso non si copia, e lo si dice a voce alta', async () => {
    const { client, tracce } = clientFinto({ mimeUscita: 'video/mp4;codecs=avc1' })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok).toBe(false)
    expect(esito.ok === false && esito.codice).toBe('MIME_NON_AMMESSO')
    // Non si tenta la copia: `news_bozze` confronta per UGUAGLIANZA con la propria
    // lista, quindi l'oggetto entrerebbe (o peggio, entrerebbe e si fermerebbe alla
    // promozione, DOPO che il consenso è stato verificato).
    expect(tracce.copy).toHaveLength(0)
    const riga = conEsito('mime-col-suffisso-codec')
    expect(riga).toHaveLength(1)
    expect(riga[0].livello).toBe('error')
    expect(riga[0].campi.mime).toBe('video/mp4;codecs=avc1')
  })

  it('un’uscita che non è un mp4 è rifiutata, col mime nel log e senza copia', async () => {
    const { client, tracce } = clientFinto({ mimeUscita: 'video/x-matroska' })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok === false && esito.codice).toBe('MIME_NON_AMMESSO')
    expect(tracce.copy).toHaveLength(0)
    expect(conEsito('mime-non-ammesso')[0]?.campi.mime).toBe('video/x-matroska')
  })
})

describe('la consegna: una copia server-side, e il SUCCESSO si logga', () => {
  it('copia l’uscita in `news_bozze` e restituisce l’indirizzo firmato dell’anteprima', async () => {
    const { client, tracce } = clientFinto()
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.percorso).toBe(`uploads/${OWNER}/${JOB}.mp4`)
    expect(esito.giaConsegnato).toBe(false)
    expect(pathBozza(esito.url)).toBe(esito.percorso)

    // I byte NON passano dalla funzione: `copy()` è una copia lato server. Un
    // `download()` + `upload()` di un'uscita da 2 GB non entra in un'invocazione.
    expect(tracce.copy).toEqual([
      {
        da: PERCORSO_USCITA,
        a: `uploads/${OWNER}/${JOB}.mp4`,
        bucketSorgente: BUCKET_USCITA,
        destinationBucket: NEWS_BUCKET_BOZZE,
      },
    ])
    expect(tracce.upload).toHaveLength(0)

    // Evento critico → il successo si logga: senza, «nessun log» non distingue
    // «consegnato» da «non è mai partita nessuna consegna».
    const ok = conEsito('video-allegato-in-sosta')
    expect(ok).toHaveLength(1)
    expect(ok[0].evento).toBe('news')
    expect(ok[0].livello).toBe('info')
    expect(ok[0].campi.bucket).toBe(NEWS_BUCKET_BOZZE)
  })

  it('l’anteprima è firmata sul bucket PRIVATO, mai pubblica', async () => {
    const { client, tracce } = clientFinto()
    await consegnaVideoInBozzaNews(client as never, job, 'test')
    expect(tracce.firmati).toEqual([{ bucket: NEWS_BUCKET_BOZZE, percorso: `uploads/${OWNER}/${JOB}.mp4` }])
  })

  it('una seconda consegna dello stesso job non è un errore: il file era già di là', async () => {
    const { client, tracce } = clientFinto({
      erroreCopy: { message: 'The resource already exists' },
    })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok).toBe(true)
    expect(esito.ok === true && esito.giaConsegnato).toBe(true)
    expect(esito.ok === true && pathBozza(esito.url)).toBe(`uploads/${OWNER}/${JOB}.mp4`)
    // Non è silenzio: la riga distingue «copiato adesso» da «era già di là».
    expect(conEsito('video-gia-consegnato')).toHaveLength(1)
    expect(tracce.remove).toHaveLength(0)
  })
})

describe('le vie d’uscita — nessuna lascia un file orfano, e nessuna tace', () => {
  it('l’uscita non c’è: si rifiuta, col corpo dell’errore nel log e senza copia', async () => {
    const { client, tracce } = clientFinto({ uscitaAssente: true })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok === false && esito.codice).toBe('USCITA_NON_TROVATA')
    expect(tracce.copy).toHaveLength(0)
    expect(conEsito('uscita-non-trovata')[0]?.livello).toBe('error')
  })

  it('`copy()` LANCIA invece di ritornare `{ error }`: l’eccezione non esce, e il corpo si logga', async () => {
    const { client } = clientFinto({ copyLancia: true })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok === false && esito.codice).toBe('COPIA_FALLITA')
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('il bucket di sosta non c’è: livello `error`, col nome del bucket — e NESSUN ripiego sul bucket pubblico', async () => {
    const { client, tracce } = clientFinto({ erroreCopy: { message: 'Bucket not found' } })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok === false && esito.codice).toBe('BUCKET_BOZZE_MANCANTE')
    const riga = conEsito('bucket-bozze-mancante')
    expect(riga).toHaveLength(1)
    expect(riga[0].livello).toBe('error')
    expect(riga[0].campi.bucket).toBe(NEWS_BUCKET_BOZZE)
    // Il ripiego di `news/upload:POST` qui NON si fa: un video nel bucket pubblico
    // prima che qualcuno abbia verificato il consenso è la cosa che l'area di sosta
    // esiste per impedire. Allargare quella superficie non è una degradazione: è il
    // difetto.
    expect(tracce.copy.every((c) => c.destinationBucket !== NEWS_BUCKET)).toBe(true)
    expect(tracce.upload).toHaveLength(0)
  })

  it('anteprima non firmabile dopo una copia NUOVA: il file torna indietro, verificato, mai con un `remove` muto', async () => {
    const { client, tracce } = clientFinto({ erroreFirma: { message: 'signing failed' } })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok === false && esito.codice).toBe('ANTEPRIMA_NON_DISPONIBILE')
    expect(tracce.remove).toEqual([
      { bucket: NEWS_BUCKET_BOZZE, percorsi: [`uploads/${OWNER}/${JOB}.mp4`] },
    ])
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('anteprima non firmabile su un file GIÀ consegnato: non si cancella niente', async () => {
    // Toglierlo qui vorrebbe dire cancellare l'allegato di una bozza che lo sta
    // già usando: un guasto momentaneo della firma diventerebbe la perdita del
    // lavoro di chi scrive.
    const { client, tracce } = clientFinto({
      erroreCopy: { message: 'The resource already exists' },
      erroreFirma: { message: 'signing failed' },
    })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok === false && esito.codice).toBe('ANTEPRIMA_NON_DISPONIBILE')
    expect(tracce.remove).toHaveLength(0)
  })

  it('un proprietario che non è un uuid non arriva nemmeno allo Storage', async () => {
    const { client, tracce } = clientFinto()
    const esito = await consegnaVideoInBozzaNews(
      client as never,
      { ...job, ownerId: 'uploads/altro' },
      'test',
    )
    expect(esito.ok === false && esito.codice).toBe('PERCORSO_NON_VALIDO')
    expect(tracce.list).toHaveLength(0)
    expect(tracce.copy).toHaveLength(0)
  })

  it('l’uscita supera il tetto: si rifiuta PRIMA di spedire, non dopo', async () => {
    // Il tetto si guarda prima della copia. Lo Storage rifiuterebbe comunque, ma
    // lo farebbe alla fine del trasferimento e con un 4xx opaco — e su un file da
    // un gigabyte «alla fine» costa banda e tempo per arrivare a un errore che si
    // sapeva già.
    const { client, tracce } = clientFinto({ byteUscita: TETTO_VIDEO_NEWS_BYTE + 1 })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok === false && esito.codice).toBe('USCITA_TROPPO_GRANDE')
    expect(tracce.copy).toHaveLength(0)
    const riga = conEsito('uscita-oltre-il-tetto')
    expect(riga).toHaveLength(1)
    expect(riga[0].campi.bucket).toBe(NEWS_BUCKET_BOZZE)
  })

  it('dimensione ignota: non si blocca, e resta la rete dello Storage', async () => {
    // «Non so quanto pesa» non è «pesa troppo»: il confronto si salta e il rifiuto,
    // se deve arrivare, arriva dal bucket — con il suo codice.
    const { client, tracce } = clientFinto({ byteUscita: null })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')
    expect(esito.ok).toBe(true)
    expect(tracce.copy).toHaveLength(1)
  })

  it('il tetto lo dice anche lo STORAGE: quel rifiuto ha un codice proprio, non un `COPIA_FALLITA`', async () => {
    // Senza un codice suo, «i video lunghi non arrivano mai» resterebbe
    // indistinguibile da un guasto di rete — e la riparazione (alzare il tetto
    // dichiarato del bucket) non la troverebbe nessuno.
    const { client } = clientFinto({
      byteUscita: null,
      erroreCopy: { message: 'The object exceeded the maximum allowed size' },
    })
    const esito = await consegnaVideoInBozzaNews(client as never, job, 'test')

    expect(esito.ok === false && esito.codice).toBe('USCITA_TROPPO_GRANDE')
    const riga = conEsito('uscita-oltre-il-tetto-del-bucket')
    expect(riga).toHaveLength(1)
    expect(riga[0].livello).toBe('error')
    expect(riga[0].campi.bucket).toBe(NEWS_BUCKET_BOZZE)
  })

  it('ogni codice restituito è dichiarato nel vocabolario chiuso', () => {
    expect([...CODICI_CONSEGNA_VIDEO_NEWS].sort()).toEqual([
      'ANTEPRIMA_NON_DISPONIBILE',
      'BUCKET_BOZZE_MANCANTE',
      'COPIA_FALLITA',
      'MIME_NON_AMMESSO',
      'PERCORSO_NON_VALIDO',
      'USCITA_NON_TROVATA',
      'USCITA_TROPPO_GRANDE',
    ])
  })
})

describe('i due bucket di dominio dicono la stessa cosa del codice', () => {
  const sql = readdirSync(join(process.cwd(), 'supabase', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'))
    .join('\n')

  /**
   * Tutti gli statement che toccano quel bucket, in ordine di migrazione.
   *
   * Si guarda l'ULTIMO che dichiara la cosa cercata, non l'ultimo in assoluto: un
   * bucket si dichiara con un INSERT e poi si corregge con degli UPDATE che
   * toccano un campo solo, e un lettore che prendesse l'ultimo statement e basta
   * leggerebbe una lista di tipi inesistente credendo di leggerne una vuota. È la
   * stessa cautela di `allegati-mime-dichiarati.test.ts`.
   */
  function statementDel(bucket: string): string[] {
    return sql
      .replace(/--[^\n]*/g, ' ')
      .split(';')
      .filter((s) => /storage\.buckets/i.test(s) && s.includes(`'${bucket}'`))
  }

  /** L'ultima lista di tipi dichiarata per quel bucket. */
  function mimeDichiarati(bucket: string): string[] {
    let ultimi: string[] = []
    for (const s of statementDel(bucket)) {
      const lista = s.match(/allowed_mime_types[^)]*?(array\s*\[[\s\S]*?\])/i)?.[1]
      const inseriti = lista ?? (/insert\s+into/i.test(s) ? s.match(/(array\s*\[[\s\S]*?\])/i)?.[1] : undefined)
      if (!inseriti) continue
      const trovati = [...inseriti.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/gi)].map((x) => x[1])
      if (trovati.length) ultimi = trovati
    }
    return ultimi
  }

  it('`news_bozze` e `news` accettano entrambi il tipo che la pipeline produce', () => {
    // Se il bucket fosse più STRETTO del codice, il video verrebbe respinto DOPO
    // la conversione — e, per il bucket pubblico, DOPO che il consenso è stato
    // verificato. È lo stesso disallineamento che `allegati-mime-dichiarati`
    // inchioda per gli allegati.
    expect(mimeDichiarati(NEWS_BUCKET_BOZZE)).toContain(MIME_ALLEGATO_VIDEO_NEWS)
    expect(mimeDichiarati(NEWS_BUCKET)).toContain(MIME_ALLEGATO_VIDEO_NEWS)
  })

  /** Il tetto dichiarato: `file_size_limit = N`, oppure il valore posizionale dell'INSERT. */
  function tettoDichiarato(bucket: string): number | null {
    let ultimo: number | null = null
    for (const s of statementDel(bucket)) {
      const assegnati = [...s.matchAll(/file_size_limit\s*=\s*(\d+)/gi)]
      if (assegnati.length) ultimo = Number(assegnati[assegnati.length - 1][1])
      else {
        const posizionale = s.match(/'\s*,\s*(?:true|false)\s*,\s*(\d+)/i)?.[1]
        if (posizionale) ultimo = Number(posizionale)
      }
    }
    return ultimo
  }

  it('il tetto del codice è quello che i DUE bucket dichiarano in migrazione', () => {
    // Un numero scritto in due posti diverge alla prima modifica, e qui la
    // divergenza ha una forma precisa: un'uscita accettata dal confronto in
    // TypeScript e respinta dallo Storage, dopo aver pagato la conversione.
    expect(tettoDichiarato(NEWS_BUCKET_BOZZE)).toBe(TETTO_VIDEO_NEWS_BYTE)
    expect(tettoDichiarato(NEWS_BUCKET)).toBe(TETTO_VIDEO_NEWS_BYTE)
  })

  it('i due bucket dichiarano LO STESSO tetto di dimensione', () => {
    // L'area di sosta e il bucket pubblico sono lo stesso file in due momenti
    // della sua vita (lo dice la testata della migrazione che crea `news_bozze`).
    // Se i due tetti divergono, un file entra in sosta e viene respinto al momento
    // di diventare pubblico: cioè il guasto si manifesta DOPO il gate del
    // consenso, su un articolo già approvato. È lo stesso disallineamento che su
    // `gallery` è vissuto per mesi — 50 MB nel bucket, 200 nella route — senza che
    // niente diventasse rosso.
    const sosta = tettoDichiarato(NEWS_BUCKET_BOZZE)
    const pubblico = tettoDichiarato(NEWS_BUCKET)
    // Asserzione di autoinganno: se il lettore non trova più i numeri, il test
    // deve cadere invece di confrontare due `null` e dirsi contento.
    expect(sosta).toBeGreaterThan(0)
    expect(pubblico).toBeGreaterThan(0)
    expect(sosta).toBe(pubblico)
  })
})

describe('la bozza abbandonata non lascia orfani nel bucket', () => {
  it('ritira gli allegati dei job indicati e conferma che sono usciti', async () => {
    const { client, tracce } = clientFinto()
    const esito = await ritiraAllegatiVideoNews(
      client as never,
      { ownerId: OWNER, jobIds: [JOB, '33333333-3333-4333-8333-333333333333'] },
      'test',
    )

    expect(esito.ritirati).toBe(2)
    expect(esito.trattenuti).toBe(0)
    expect(tracce.remove).toEqual([
      {
        bucket: NEWS_BUCKET_BOZZE,
        percorsi: [
          `uploads/${OWNER}/${JOB}.mp4`,
          `uploads/${OWNER}/33333333-3333-4333-8333-333333333333.mp4`,
        ],
      },
    ])
    // Evento critico → si logga anche il successo.
    expect(conEsito('allegati-video-ritirati')).toHaveLength(1)
  })

  it('un file che NON esce resta contato come trattenuto: si verifica lo stato, non il conteggio', async () => {
    const { client } = clientFinto({ rimozioneInefficace: true })
    const esito = await ritiraAllegatiVideoNews(
      client as never,
      { ownerId: OWNER, jobIds: [JOB] },
      'test',
    )

    expect(esito.ritirati).toBe(0)
    expect(esito.trattenuti).toBe(1)
  })

  it('un file che NON C’ERA PIÙ conta come ritirato, non come trattenuto', async () => {
    // «Non c'è più» è l'esito voluto, già raggiunto: trattarlo da guasto
    // bloccherebbe per sempre la pulizia di un lotto in cui un solo file era già
    // uscito. La regola sta in `rimuoviEVerifica` e vale identica qui.
    const { client } = clientFinto({ fileGiaAssente: true })
    const esito = await ritiraAllegatiVideoNews(
      client as never,
      { ownerId: OWNER, jobIds: [JOB] },
      'test',
    )
    expect(esito).toEqual({ ritirati: 1, trattenuti: 0 })
  })

  it('un job che non è un uuid non produce un percorso, e non si chiede niente allo Storage', async () => {
    const { client, tracce } = clientFinto()
    const esito = await ritiraAllegatiVideoNews(
      client as never,
      { ownerId: OWNER, jobIds: ['../../altro'] },
      'test',
    )
    expect(esito).toEqual({ ritirati: 0, trattenuti: 0 })
    expect(tracce.remove).toHaveLength(0)
  })
})
