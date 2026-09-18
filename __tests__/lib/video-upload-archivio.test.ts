import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  CHIAVI_RIGA_CARICAMENTO,
  STATI_CARICAMENTO_VIDEO,
  TTL_CARICAMENTI_MS,
  caricamentiDaPotare,
  caricamentiDaRiprendere,
  caricamentiDaSeguire,
  nuovoCaricamento,
  type CaricamentoVideoLocale,
} from '@/lib/media/video/upload/stato'
import { ArchivioCaricamentiInMemoria } from '@/lib/media/video/upload/archivio-memoria'
import { SCHEMA_ARCHIVIO_VIDEO, VERSIONE_ARCHIVIO_VIDEO } from '@/lib/media/video/upload/archivio-dexie'
import type { CoordinateCaricamentoVideo } from '@/lib/media/video/contratto'

/**
 * L'ARCHIVIO DEI CARICAMENTI VIDEO — lo stato che deve sopravvivere alla chiusura
 * dell'app.
 *
 * Il criterio d'accettazione di V10 non è «il codice chiama `resume()`»: è che un
 * genitore che chiude l'app dopo aver spedito 180 secondi di video, al rientro
 * ritrovi il LAVORO invece di ricominciarlo. Quel «ritrovare» è possibile solo se
 * lo stato sta su un supporto che sopravvive al processo, e qui si collauda che
 * cosa ci sta dentro, chi si ripesca e chi si butta.
 *
 * Il collaudo della ripresa VERA — offset parziale, byte contati — sta in
 * `video-upload-tus.test.ts`: qui c'è solo la memoria, lì c'è il protocollo.
 */

const COORDINATE: CoordinateCaricamentoVideo = {
  protocollo: 'tus',
  endpoint: 'https://progetto.supabase.co/storage/v1/upload/resumable',
  bucket: 'video_originals',
  percorso: 'e2e00000-0000-4000-8000-000000000000/11111111-1111-4111-8111-111111111111.mp4',
  contentType: 'video/mp4',
  dimensioneBloccoByte: 6 * 1024 * 1024,
}

function riga(modifiche: Partial<CaricamentoVideoLocale> = {}): CaricamentoVideoLocale {
  const base = nuovoCaricamento({
    jobId: '11111111-1111-4111-8111-111111111111',
    intentId: '22222222-2222-4222-8222-222222222222',
    canale: 'gallery',
    chiaveIdempotenza: 'chiave-1',
    nome: 'recita.mp4',
    dimensioneByte: 1024,
    mime: 'video/mp4;codecs=avc1',
    coordinate: COORDINATE,
    adesso: new Date('2026-09-18T08:00:00.000Z'),
  })
  return { ...base, ...modifiche }
}

describe('la riga di un caricamento video sul dispositivo', () => {
  it('nasce da caricare, a offset zero, con il MIME ridotto al solo container', () => {
    const r = riga()

    expect(r.stato).toBe('da_caricare')
    expect(r.offsetByte).toBe(0)
    expect(r.urlTus).toBeNull()
    // `video/mp4;codecs=avc1` entra e resta `video/mp4`: è il valore che va allo
    // Storage come `contentType`, e lì un suffisso di codec prende 400.
    expect(r.mime).toBe('video/mp4')
    expect(r.creatoIl).toBe('2026-09-18T08:00:00.000Z')
    expect(r.aggiornatoIl).toBe('2026-09-18T08:00:00.000Z')
  })

  /**
   * 🔒 IL LOCK CHE IMPEDISCE A UN TOKEN DI FINIRE SU DISCO.
   *
   * L'upload TUS si autentica con il bearer della sessione. Persisterlo accanto ai
   * byte sarebbe comodo — la ripresa non dovrebbe chiedere niente a nessuno — e
   * sarebbe una credenziale di un genitore lasciata in IndexedDB, leggibile da
   * qualunque script della stessa origine e sopravvissuta alla scadenza della
   * sessione. Le intestazioni si chiedono AL MOMENTO di partire, non si conservano.
   *
   * Il lock è sull'ELENCO CHIUSO delle chiavi: un campo nuovo va dichiarato qui, e
   * dichiararlo obbliga a chiedersi se è un segreto. Un `toMatchObject` non lo
   * avrebbe preso — le chiavi in più non le vede nessuno.
   */
  it('porta solo le chiavi dichiarate: nessuna intestazione, nessun token', () => {
    const chiavi = Object.keys(riga()).sort()
    expect(chiavi).toEqual([...CHIAVI_RIGA_CARICAMENTO].sort())
    expect(chiavi.some((k) => /token|authorization|bearer|apikey|jwt/i.test(k))).toBe(false)
  })

  it('gli stati sono i cinque dichiarati, e nessun altro', () => {
    expect([...STATI_CARICAMENTO_VIDEO]).toEqual([
      'da_caricare',
      'in_corso',
      'caricato',
      'annullato',
      'fallito',
    ])
  })
})

describe('chi si ripesca al rientro nell’app', () => {
  const righe: CaricamentoVideoLocale[] = [
    riga({ jobId: 'a', stato: 'da_caricare' }),
    riga({ jobId: 'b', stato: 'in_corso', offsetByte: 512 }),
    riga({ jobId: 'c', stato: 'caricato' }),
    riga({ jobId: 'd', stato: 'annullato' }),
    riga({ jobId: 'e', stato: 'fallito' }),
  ]

  it('si riprendono i byte non ancora tutti spediti, e solo quelli', () => {
    expect(caricamentiDaRiprendere(righe).map((r) => r.jobId)).toEqual(['a', 'b'])
  })

  /**
   * Il secondo criterio d'accettazione, in una riga: dopo il completamento i byte
   * non servono più, ma il JOB sì. Chi ha chiuso l'app deve ritrovare qui il
   * riferimento da tornare a interrogare — altrimenti la conversione prosegue sul
   * server e sullo schermo non c'è niente che la racconti.
   */
  it('si torna a interrogare il job dei caricamenti già completati', () => {
    expect(caricamentiDaSeguire(righe).map((r) => r.jobId)).toEqual(['c'])
  })
})

describe('la potatura: nessuna riga che nessuno ripulisce', () => {
  const ora = Date.parse('2026-09-18T08:00:00.000Z')

  it('butta ciò che è fermo da più del TTL, in qualunque stato', () => {
    const vecchia = new Date(ora - TTL_CARICAMENTI_MS - 1).toISOString()
    const righe = [
      riga({ jobId: 'annullata', stato: 'annullato', aggiornatoIl: vecchia }),
      riga({ jobId: 'abbandonata', stato: 'in_corso', aggiornatoIl: vecchia }),
      riga({ jobId: 'conclusa', stato: 'caricato', aggiornatoIl: vecchia }),
    ]

    expect(caricamentiDaPotare(righe, ora).map((r) => r.jobId).sort()).toEqual([
      'abbandonata',
      'annullata',
      'conclusa',
    ])
  })

  it('non butta ciò che è recente, nemmeno se è già concluso', () => {
    const recente = new Date(ora - TTL_CARICAMENTI_MS + 1000).toISOString()
    const righe = [
      riga({ jobId: 'annullata', stato: 'annullato', aggiornatoIl: recente }),
      riga({ jobId: 'in-volo', stato: 'in_corso', aggiornatoIl: recente }),
    ]

    expect(caricamentiDaPotare(righe, ora)).toEqual([])
  })

  it('il TTL è quello del piano: sette giorni', () => {
    expect(TTL_CARICAMENTI_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('l’archivio in memoria', () => {
  let archivio: ArchivioCaricamentiInMemoria

  beforeEach(() => {
    archivio = new ArchivioCaricamentiInMemoria()
  })

  it('rilegge ciò che ha scritto e aggiorna per campi', async () => {
    await archivio.scrivi(riga())
    await archivio.aggiorna('11111111-1111-4111-8111-111111111111', {
      stato: 'in_corso',
      urlTus: 'https://progetto.supabase.co/storage/v1/upload/resumable/abc',
    })

    const letta = await archivio.leggi('11111111-1111-4111-8111-111111111111')
    expect(letta?.stato).toBe('in_corso')
    expect(letta?.urlTus).toContain('/abc')
    // L'aggiornamento di un campo non può cancellare il resto della riga.
    expect(letta?.dimensioneByte).toBe(1024)
  })

  /**
   * I BYTE STANNO IN UN DEPOSITO SEPARATO, e non è una raffinatezza: un originale
   * arriva a 2.000.000.000 byte, e `elenca()` deve poter dire «che cosa è rimasto a
   * metà?» senza tirare in memoria due gigabyte di Blob per rispondere.
   */
  it('tiene i byte in un deposito separato dai metadati', async () => {
    const r = riga()
    await archivio.scrivi(r)
    await archivio.scriviByte(r.jobId, new Blob([new Uint8Array(1024)]))

    const elenco = await archivio.elenca()
    expect(elenco).toHaveLength(1)
    expect(JSON.stringify(elenco)).not.toContain('Blob')
    expect(Object.values(elenco[0]).some((v) => v instanceof Blob)).toBe(false)

    const byte = await archivio.leggiByte(r.jobId)
    expect(byte?.size).toBe(1024)
  })

  it('liberare i byte lascia la riga e toglie il peso', async () => {
    const r = riga()
    await archivio.scrivi(r)
    await archivio.scriviByte(r.jobId, new Blob([new Uint8Array(1024)]))

    await archivio.eliminaByte(r.jobId)

    expect(await archivio.leggiByte(r.jobId)).toBeUndefined()
    expect(await archivio.leggi(r.jobId)).toBeDefined()
  })

  it('eliminare la riga porta via anche i byte: niente deposito orfano', async () => {
    const r = riga()
    await archivio.scrivi(r)
    await archivio.scriviByte(r.jobId, new Blob([new Uint8Array(1024)]))

    await archivio.elimina(r.jobId)

    expect(await archivio.leggi(r.jobId)).toBeUndefined()
    expect(await archivio.leggiByte(r.jobId)).toBeUndefined()
  })

  it('aggiornare una riga che non c’è non la inventa', async () => {
    await archivio.aggiorna('inesistente', { stato: 'caricato' })
    expect(await archivio.leggi('inesistente')).toBeUndefined()
  })
})

/**
 * LO SCHEMA DEXIE — un lock, non una fotografia.
 *
 * In Dexie una `where('campo')` su un campo NON dichiarato non torna vuota: lancia
 * `SchemaError` a runtime, cioè sul telefono di chi carica, e mai in un test che
 * non abbia IndexedDB sotto (jsdom non ce l'ha, e `fake-indexeddb` non è installato
 * in questo repo). Qui si verifica l'unica cosa che si può verificare senza un
 * motore: che la dichiarazione contenga gli indici su cui l'adattatore interroga.
 */
describe('lo schema dell’archivio su IndexedDB', () => {
  it('dichiara due store: i metadati indicizzati, i byte no', () => {
    expect(Object.keys(SCHEMA_ARCHIVIO_VIDEO).sort()).toEqual(['byte', 'caricamenti'])
    expect(SCHEMA_ARCHIVIO_VIDEO.caricamenti).toBe('jobId, stato, aggiornatoIl')
    expect(SCHEMA_ARCHIVIO_VIDEO.byte).toBe('jobId')
  })

  it('è la versione 1: un database nuovo, non una v12 del database condiviso', () => {
    expect(VERSIONE_ARCHIVIO_VIDEO).toBe(1)
  })
})

/**
 * LA FABBRICA — e il caso in cui la durabilità semplicemente non c'è.
 *
 * In navigazione privata su Safari, e in una WebView con lo storage di sito
 * disabilitato, IndexedDB non è utilizzabile. Senza un ripiego il caricamento
 * esploderebbe alla prima scrittura: con il ripiego si perde la ripresa dopo la
 * chiusura dell'app e si tiene tutto il resto.
 *
 * ⚠️ Il declassamento NON può essere muto. Una capacità che manca è un incidente
 * da registrare — è la regola 4 di AGENTS.md applicata a una capability invece
 * che a una variabile d'ambiente: senza la riga, «i video di quel genitore non
 * riprendono mai» non avrebbe nessuna spiegazione da nessuna parte.
 *
 * Questo test gira in jsdom, dove `indexedDB` non esiste: è l'ambiente stesso a
 * mettere alla prova il ramo, non un mock.
 */
describe('la scelta dell’archivio', () => {
  it('senza IndexedDB ripiega sulla memoria e lo dice a voce alta', async () => {
    const logClient = vi.fn()
    vi.doMock('@/lib/logging/client', async () => {
      const vero = await vi.importActual<typeof import('@/lib/logging/client')>(
        '@/lib/logging/client',
      )
      return { ...vero, logClient: (...a: unknown[]) => logClient(...a) }
    })
    const { creaArchivioCaricamenti } = await import('@/lib/media/video/upload/crea-archivio')

    expect(typeof globalThis.indexedDB).toBe('undefined')
    const archivio = await creaArchivioCaricamenti()

    expect(archivio).toBeInstanceOf(ArchivioCaricamentiInMemoria)
    const avviso = logClient.mock.calls.find(([e]) =>
      String(e.messaggio).includes('video-upload-archivio-volatile'),
    )
    expect(avviso).toBeDefined()
    expect(avviso![0].livello).toBe('warn')
    vi.doUnmock('@/lib/logging/client')
  })
})
