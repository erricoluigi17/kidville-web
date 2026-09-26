import { test, expect, type Page } from '@playwright/test'
import { installaArchivioVideo } from './helpers/archivio-video'
import type { ArchivioCaricamentiDexie } from '../src/lib/media/video/upload/archivio-dexie'
import type { LettoreBlob } from '../src/lib/media/video/upload/lettore-blob'

/**
 * L'ARCHIVIO DEI VIDEO SUL VERO INDEXEDDB — il modulo di produzione, transpilato
 * e caricato nella pagina, su WebKit e Chromium. jsdom non ha IndexedDB e
 * `fake-indexeddb` non riprodurrebbe né il rifiuto dei Blob di WebKit né il
 * comportamento delle transazioni: queste prove esistono per questo.
 *
 * Nessun retry: un collaudo di persistenza che passa al secondo tentativo sta
 * nascondendo esattamente la fragilità che deve misurare.
 */
test.describe.configure({ retries: 0 })

declare global {
  interface Window {
    videoArchivePause?: boolean
    videoArchiveWriteError?: string
    videoArchivioQA: {
      ArchivioCaricamentiDexie: typeof ArchivioCaricamentiDexie
      LettoreBlob: typeof LettoreBlob
      BLOCCO_VIDEO_LOCALE: number
      PREFISSO_DEPOSITO_VIDEO: string
      ETA_MINIMA_ORFANO_MS: number
      log: Array<{ messaggio: string; campi?: Record<string, unknown> }>
    }
    Dexie: typeof import('dexie').default
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/__archivio-video-e2e', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Archivio sintetico</body></html>' }))
  await page.goto('/__archivio-video-e2e')
  await installaArchivioVideo(page)
})

/** I database di blocchi ancora presenti, e le chiavi dentro quello di un job. */
async function depositi(page: Page, jobId?: string): Promise<{ nomi: string[]; chiavi: string[] }> {
  return page.evaluate(async jobId => {
    const { PREFISSO_DEPOSITO_VIDEO: prefisso } = window.videoArchivioQA
    const nomi = (await indexedDB.databases()).map(d => d.name ?? '').filter(n => n.startsWith(prefisso))
    let chiavi: string[] = []
    if (jobId && nomi.includes(prefisso + jobId)) {
      const d = new window.Dexie(prefisso + jobId, { autoOpen: false })
      d.version(1).stores({ blocchi: 'chiave' })
      await d.open()
      chiavi = (await d.table('blocchi').toCollection().primaryKeys()) as string[]
      d.close()
    }
    return { nomi, chiavi }
  }, jobId)
}

/** Le righe dello store principale `byte` (manifest e Blob legacy). */
async function manifest(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const richiesta = indexedDB.open('KidvilleVideoUploadDB')
    richiesta.onerror = () => reject(richiesta.error)
    richiesta.onsuccess = () => {
      const db = richiesta.result
      const count = db.transaction('byte').objectStore('byte').count()
      count.onsuccess = () => { db.close(); resolve(count.result) }
      count.onerror = () => { db.close(); reject(count.error) }
    }
  }))
}

test('video: byte persistenti dopo reload, offset interno, ultimo blocco e cancellazione', async ({ page }) => {
  const jobId = '11111111-1111-4111-8111-111111111111'
  const scritto = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const dati = new Uint8Array(blocco + 37)
    for (let i = 0; i < dati.length; i++) dati[i] = i % 251
    let massimo = 0
    class FileMisurato extends File {
      slice(inizio = 0, fine = this.size, tipo?: string) {
        massimo = Math.max(massimo, fine - inizio)
        return super.slice(inizio, fine, tipo)
      }
    }
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new FileMisurato([dati], 'sintetico.mp4', { type: 'video/mp4' }))
    return { massimo, blocco }
  }, jobId)
  expect(scritto.massimo).toBeLessThanOrEqual(scritto.blocco)
  expect((await depositi(page, jobId)).chiavi).toHaveLength(2)
  await page.reload()
  await installaArchivioVideo(page)
  const riletto = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Byte persi al reload')
    const source = await new LettoreBlob().openFile(byte)
    const aCavallo = await source.slice(blocco - 11, blocco + 19)
    const ultimo = await source.slice(blocco + 19, blocco + 37)
    await a.eliminaByte(jobId)
    const assente = await a.leggiByte(jobId)
    return { size: source.size, type: byte.type, cavallo: Array.from(aCavallo.value), ultimo: Array.from(ultimo.value), done: ultimo.done, sizeFinale: ultimo.value.size, assente: !assente }
  }, jobId)
  expect(riletto.size).toBe(scritto.blocco + 37)
  expect(riletto.type).toBe('video/mp4')
  expect(riletto.cavallo).toEqual(Array.from({ length: 30 }, (_, i) => (scritto.blocco - 11 + i) % 251))
  expect(riletto.ultimo).toEqual(Array.from({ length: 18 }, (_, i) => (scritto.blocco + 19 + i) % 251))
  expect(riletto.done).toBe(true)
  expect(riletto.sizeFinale).toBe(18)
  expect(riletto.assente).toBe(true)
  // Il database del job se ne va intero: su WebKit è l'unico modo di restituire
  // lo spazio (SQLite senza auto_vacuum tiene il file grande dopo i DELETE).
  expect((await depositi(page)).nomi).toEqual([])
  expect(await manifest(page)).toBe(0)
})

test('video: lettura fallita durante la copia conserva il deposito precedente e non lascia blocchi', async ({ page }) => {
  const jobId = '22222222-2222-4222-8222-222222222222'
  const risultato = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([9, 8, 7])]))
    class FileInterrotto extends Blob {
      slice(inizio = 0, fine = this.size, tipo?: string) {
        if (inizio >= blocco) throw new DOMException('Lettura interrotta', 'AbortError')
        return super.slice(inizio, fine, tipo)
      }
    }
    let errore = ''
    try { await a.scriviByte(jobId, new FileInterrotto([new Uint8Array(blocco + 1)])) }
    catch (e) { errore = (e as Error).name }
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito precedente perso')
    const source = await new LettoreBlob().openFile(byte)
    const fetta = await source.slice(0, 3)
    return { errore, byte: Array.from(fetta.value), log: window.videoArchivioQA.log.map(e => e.messaggio) }
  }, jobId)
  expect(risultato.errore).toBe('AbortError')
  expect(risultato.byte).toEqual([9, 8, 7])
  expect(risultato.log).toContain(`video-upload-persistenza-fallita: job=${jobId}`)
  expect((await depositi(page, jobId)).chiavi).toHaveLength(1) // Solo il blocco del deposito precedente.
})

test('video: quota esaurita sul secondo blocco conserva il deposito precedente e registra la causa', async ({ page }) => {
  const jobId = '33333333-3333-4333-8333-333333333333'
  const risultato = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([3, 2, 1])]))
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value, key) {
      const chiave = (value as { chiave?: string }).chiave
      if (chiave?.endsWith(':1')) throw new DOMException('Quota sintetica', 'QuotaExceededError')
      return put.call(this, value, key)
    }
    let errore = ''
    try { await a.scriviByte(jobId, new Blob([new Uint8Array(blocco + 1)])) }
    catch (e) { errore = (e as Error).name }
    finally { IDBObjectStore.prototype.put = put }
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito precedente perso')
    const source = await new LettoreBlob().openFile(byte)
    const log = window.videoArchivioQA.log.find(e => e.messaggio === `video-upload-persistenza-fallita: job=${jobId}`)
    return { errore, byte: Array.from((await source.slice(0, 3)).value), campi: log?.campi ?? null }
  }, jobId)
  expect(risultato.errore).toMatch(/QuotaExceededError|AbortError/)
  expect(JSON.stringify(risultato.campi)).toContain('QuotaExceededError')
  expect(risultato.byte).toEqual([3, 2, 1])
  expect((await depositi(page, jobId)).chiavi).toHaveLength(1)
})

test('video: chiusura della pagina durante la copia lascia leggibile il deposito precedente', async ({ page }) => {
  const jobId = '44444444-4444-4444-8444-444444444444'
  await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([4, 5, 6])]))
    class BloccoInAttesa extends Blob {
      arrayBuffer(): Promise<ArrayBuffer> {
        window.videoArchivePause = true
        return new Promise(() => {})
      }
    }
    class FileInAttesa extends Blob {
      slice(inizio = 0, fine = this.size, tipo?: string) {
        return inizio >= blocco ? new BloccoInAttesa() : super.slice(inizio, fine, tipo)
      }
    }
    void a.scriviByte(jobId, new FileInAttesa([new Uint8Array(blocco + 1)]))
      .catch(e => { window.videoArchiveWriteError = (e as Error).name })
  }, jobId)
  await page.waitForFunction(() => window.videoArchivePause === true)
  await page.reload()
  await installaArchivioVideo(page)
  const letto = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito perso dopo chiusura')
    return Array.from((await (await new LettoreBlob().openFile(byte)).slice(0, 3)).value)
  }, jobId)
  expect(letto).toEqual([4, 5, 6])
  // Il primo blocco della copia interrotta è rimasto: è della generazione che
  // nessun manifest nomina. La prossima copia riuscita lo toglie.
  expect((await depositi(page, jobId)).chiavi).toHaveLength(2)
  await page.evaluate(async jobId => {
    const a = new window.videoArchivioQA.ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([7, 7])]))
  }, jobId)
  expect((await depositi(page, jobId)).chiavi).toHaveLength(1)
})

test('video: un blocco mancante viene rifiutato senza spedire byte troncati', async ({ page }) => {
  const jobId = '55555555-5555-4555-8555-555555555555'
  const risultato = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, PREFISSO_DEPOSITO_VIDEO: prefisso } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([1, 2, 3])]))
    const d = new window.Dexie(prefisso + jobId, { autoOpen: false })
    d.version(1).stores({ blocchi: 'chiave' })
    await d.open()
    await d.table('blocchi').clear()
    d.close()
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Manifest assente')
    let errore = ''
    try { await (await new LettoreBlob().openFile(byte)).slice(0, 3) }
    catch (e) { errore = (e as Error).name }
    await a.eliminaByte(jobId)
    return { errore, log: window.videoArchivioQA.log.map(e => e.messaggio) }
  }, jobId)
  expect(risultato.errore).toBe('VIDEO_BLOCCO_INCOMPLETO')
  expect(risultato.log).toContain(`video-upload-blocco-assente: job=${jobId}`)
  expect((await depositi(page)).nomi).toEqual([])
})

test('video: riscrivere lo stesso video mentre un lettore è aperto non gli toglie i byte', async ({ page }) => {
  const jobId = '66666666-6666-4666-8666-666666666666'
  const risultato = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const dati = new Uint8Array(blocco * 2 + 5)
    for (let i = 0; i < dati.length; i++) dati[i] = (i * 7) % 256
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([dati], { type: 'video/mp4' }))
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito assente')
    const source = await new LettoreBlob().openFile(byte)
    const primo = await source.slice(0, blocco)
    await a.scriviByte(jobId, new Blob([dati], { type: 'video/mp4' }))
    const secondo = await source.slice(blocco, blocco * 2)
    const attesi = Array.from(dati.subarray(blocco, blocco + 16))
    await a.eliminaByte(jobId)
    return { primo: primo.value.byteLength, secondo: Array.from(secondo.value.subarray(0, 16)), attesi }
  }, jobId)
  expect(risultato.primo).toBeGreaterThan(0)
  expect(risultato.secondo).toEqual(risultato.attesi)
})

test('video: un deposito cancellato da fuori durante la copia fa fallire la scrittura, non la blocca', async ({ page }) => {
  const jobId = '77777777-7777-4777-8777-777777777777'
  const risultato = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, BLOCCO_VIDEO_LOCALE: blocco, PREFISSO_DEPOSITO_VIDEO: prefisso } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    let sblocca: () => void = () => {}
    const attesa = new Promise<void>(r => { sblocca = r })
    class BloccoSospeso extends Blob {
      async arrayBuffer(): Promise<ArrayBuffer> {
        await attesa
        return new ArrayBuffer(1)
      }
    }
    class FileSospeso extends Blob {
      slice(inizio = 0, fine = this.size, tipo?: string) {
        return inizio >= blocco ? new BloccoSospeso() : super.slice(inizio, fine, tipo)
      }
    }
    const scrittura = a.scriviByte(jobId, new FileSospeso([new Uint8Array(blocco + 1)]))
      .then(() => 'riuscita', (e: Error) => e.name)
    // Come «cancella dati del sito» o un'altra scheda che pota: il database del
    // job sparisce mentre la copia aspetta la seconda fetta.
    await new Promise(r => setTimeout(r, 200))
    await window.Dexie.delete(prefisso + jobId)
    sblocca()
    const esito = await Promise.race([scrittura, new Promise<string>(r => setTimeout(() => r('APPESA'), 10_000))])
    const manifest = !!(await a.leggiByte(jobId))
    // La connessione chiusa dall'esterno non resta inutilizzabile: la copia dopo
    // riapre un database nuovo e si rilegge.
    await a.scriviByte(jobId, new Blob([new Uint8Array([8, 9])]))
    const byte = await a.leggiByte(jobId)
    const riletti = byte ? Array.from((await (await new window.videoArchivioQA.LettoreBlob().openFile(byte)).slice(0, 2)).value) : []
    await a.eliminaByte(jobId)
    return { esito, manifest, riletti }
  }, jobId)
  expect(risultato.esito).not.toBe('APPESA')
  expect(risultato.esito).not.toBe('riuscita')
  expect(risultato.manifest).toBe(false)
  expect(risultato.riletti).toEqual([8, 9])
})

test('video: elimina toglie riga, manifest e database dei blocchi', async ({ page }) => {
  const jobId = '88888888-8888-4888-8888-888888888888'
  await page.evaluate(async jobId => {
    const a = new window.videoArchivioQA.ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([1, 2])]))
    await a.scrivi({ jobId } as never)
    await a.elimina(jobId)
    return !!(await a.leggi(jobId))
  }, jobId).then(rigaRimasta => expect(rigaRimasta).toBe(false))
  expect((await depositi(page)).nomi).toEqual([])
  expect(await manifest(page)).toBe(0)
})

test('video: la potatura toglie i depositi orfani vecchi e lascia quelli giovani e quelli nominati', async ({ page }) => {
  const esito = await page.evaluate(async () => {
    const { ArchivioCaricamentiDexie, PREFISSO_DEPOSITO_VIDEO: prefisso, ETA_MINIMA_ORFANO_MS: eta } = window.videoArchivioQA
    const vecchio = '99999999-9999-4999-8999-999999999991'
    const giovane = '99999999-9999-4999-8999-999999999992'
    const nominato = '99999999-9999-4999-8999-999999999993'
    async function orfano(jobId: string, nato: number) {
      const d = new window.Dexie(prefisso + jobId, { autoOpen: false })
      d.version(1).stores({ blocchi: 'chiave' })
      await d.open()
      await d.table('blocchi').put({ chiave: `${nato.toString(36)}-sintetico:0`, buffer: new ArrayBuffer(4) })
      d.close()
    }
    await orfano(vecchio, Date.now() - eta - 60_000)
    await orfano(giovane, Date.now())
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(nominato, new Blob([new Uint8Array([5])]))
    await a.scrivi({ jobId: nominato } as never)
    const rimossi = await a.potaDepositiOrfani()
    const rimasti = (await indexedDB.databases()).map(d => d.name ?? '').filter(n => n.startsWith(prefisso)).map(n => n.slice(prefisso.length)).sort()
    await a.elimina(nominato)
    return { rimossi, rimasti, attesi: [giovane, nominato].sort() }
  })
  expect(esito.rimossi).toBe(1)
  expect(esito.rimasti).toEqual(esito.attesi)
})

test('video: un deposito legacy {blob} scritto dalle versioni precedenti resta leggibile', async ({ page, browserName }) => {
  // WebKit in un contesto effimero rifiuta proprio i Blob in IndexedDB: è il
  // difetto che ha reso necessari i blocchi, quindi lì un deposito legacy non può
  // nemmeno essere preparato.
  test.skip(browserName === 'webkit', 'WebKit effimero non accetta Blob in IndexedDB')
  const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const letto = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.leggi(jobId) // apre il database con lo schema di produzione
    const d = new window.Dexie('KidvilleVideoUploadDB')
    d.version(1).stores({ caricamenti: 'jobId, stato, aggiornatoIl', byte: 'jobId' })
    await d.table('byte').put({ jobId, blob: new Blob([new Uint8Array([6, 5, 4, 3])], { type: 'video/mp4' }) })
    d.close()
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito legacy non trovato')
    const fetta = await (await new LettoreBlob().openFile(byte)).slice(1, 4)
    await a.eliminaByte(jobId)
    return { valori: Array.from(fetta.value), done: fetta.done, assente: !(await a.leggiByte(jobId)) }
  }, jobId)
  expect(letto).toEqual({ valori: [5, 4, 3], done: true, assente: true })
})

/* ─── Seconda critica indipendente (2026-09-26): i rami rimasti scoperti ─── */

test('video: la prima copia fallita toglie il database del job intero (su WebKit le righe non liberano il disco)', async ({ page }) => {
  const jobId = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'
  const esito = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    class FettaCorta extends Blob {
      slice(inizio = 0, fine = this.size, tipo?: string) {
        // Il secondo blocco torna più corto del dovuto: una copia che non si può fidare.
        return inizio >= blocco ? new Blob([new Uint8Array(1)]) : super.slice(inizio, fine, tipo)
      }
    }
    let errore = ''
    try { await a.scriviByte(jobId, new FettaCorta([new Uint8Array(blocco + 10)])) }
    catch (e) { errore = (e as Error).name }
    return { errore, manifest: !!(await a.leggiByte(jobId)) }
  }, jobId)
  expect(esito).toEqual({ errore: 'VIDEO_BLOCCO_INCOMPLETO', manifest: false })
  expect((await depositi(page)).nomi).toEqual([])
})

test('video: gli avanzi di copie interrotte e di altre generazioni spariscono alla copia successiva', async ({ page }) => {
  const jobId = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'
  await page.evaluate(async jobId => {
    const { PREFISSO_DEPOSITO_VIDEO: prefisso } = window.videoArchivioQA
    const d = new window.Dexie(prefisso + jobId, { autoOpen: false })
    d.version(1).stores({ blocchi: 'chiave' })
    await d.open()
    // Una copia interrotta dalla chiusura dell'app: blocchi senza manifest.
    await d.table('blocchi').bulkPut([
      { chiave: '0000-interrotta:0', buffer: new ArrayBuffer(8) },
      { chiave: '0000-interrotta:1', buffer: new ArrayBuffer(8) },
    ])
    d.close()
  }, jobId)
  // Gli avanzi devono sparire PRIMA della copia nuova, non dopo: su un telefono
  // quasi pieno è durante la copia che lo spazio serve.
  const duranteLaCopia = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, BLOCCO_VIDEO_LOCALE: blocco, PREFISSO_DEPOSITO_VIDEO: prefisso } = window.videoArchivioQA
    let sblocca: () => void = () => {}
    let inPausa: () => void = () => {}
    const pausa = new Promise<void>(r => { inPausa = r })
    const attesa = new Promise<void>(r => { sblocca = r })
    class SecondaSospesa extends Blob {
      async arrayBuffer(): Promise<ArrayBuffer> { inPausa(); await attesa; return new ArrayBuffer(3) }
    }
    class FileSospeso extends Blob {
      slice(inizio = 0, fine = this.size, tipo?: string) {
        return inizio >= blocco ? new SecondaSospesa() : super.slice(inizio, fine, tipo)
      }
    }
    const a = new ArchivioCaricamentiDexie()
    const copia = a.scriviByte(jobId, new FileSospeso([new Uint8Array(blocco + 3)]))
    await pausa
    const d = new window.Dexie(prefisso + jobId, { autoOpen: false })
    d.version(1).stores({ blocchi: 'chiave' })
    await d.open()
    const chiavi = (await d.table('blocchi').toCollection().primaryKeys()) as string[]
    d.close()
    sblocca()
    await copia
    await a.scriviByte(jobId, new Blob([new Uint8Array([1, 2, 3])]))
    return chiavi
  }, jobId)
  expect(duranteLaCopia.some(c => c.includes('interrotta'))).toBe(false)
  const primaCopia = (await depositi(page, jobId)).chiavi
  expect(primaCopia).toHaveLength(1)
  expect(primaCopia[0]).not.toContain('interrotta')
  // Avanzi sotto e SOPRA la generazione valida (un orologio che è andato avanti e
  // indietro): la copia dopo li toglie entrambi.
  await page.evaluate(async jobId => {
    const { PREFISSO_DEPOSITO_VIDEO: prefisso } = window.videoArchivioQA
    const d = new window.Dexie(prefisso + jobId, { autoOpen: false })
    d.version(1).stores({ blocchi: 'chiave' })
    await d.open()
    await d.table('blocchi').bulkPut([
      { chiave: '0000-passata:0', buffer: new ArrayBuffer(4) },
      { chiave: 'zzzz-futura:0', buffer: new ArrayBuffer(4) },
    ])
    d.close()
    const a = new window.videoArchivioQA.ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([4, 5])]))
  }, jobId)
  const seconda = (await depositi(page, jobId)).chiavi
  expect(seconda).toHaveLength(1)
  expect(seconda[0]).not.toMatch(/passata|futura/)
  expect(seconda[0]).not.toBe(primaCopia[0])
})

test('video: due copie dello stesso job nella stessa scheda vanno in fila e lasciano un deposito solo', async ({ page }) => {
  const jobId = 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3'
  const letti = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    const uno = new Uint8Array(blocco + 3).fill(1)
    const due = new Uint8Array(blocco + 3).fill(2)
    await Promise.all([a.scriviByte(jobId, new Blob([uno])), a.scriviByte(jobId, new Blob([due]))])
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito assente')
    const s = await new LettoreBlob().openFile(byte)
    const inizio = Array.from((await s.slice(0, 2)).value)
    const fine = Array.from((await s.slice(blocco, blocco + 3)).value)
    return { inizio, fine }
  }, jobId)
  // Vince l'ultima accodata, per intero: mai un deposito fatto di pezzi di due copie.
  expect(letti).toEqual({ inizio: [2, 2], fine: [2, 2, 2] })
  expect((await depositi(page, jobId)).chiavi).toHaveLength(2)
})

test('video: manifest non valido, blocco troncato e intervallo fuori misura sono rifiutati e registrati', async ({ page }) => {
  const risultato = await page.evaluate(async () => {
    const { ArchivioCaricamentiDexie, PREFISSO_DEPOSITO_VIDEO: prefisso } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.leggi('x') // apre il database principale con lo schema di produzione
    const principale = new window.Dexie('KidvilleVideoUploadDB')
    principale.version(1).stores({ caricamenti: 'jobId, stato, aggiornatoIl', byte: 'jobId' })
    const nonValido = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
    await principale.table('byte').put({ jobId: nonValido, formato: 'blocchi-v2', generazione: 'g', size: -1, type: 'video/mp4', dimensioneBlocco: 0 })
    principale.close()
    let manifestErrato = ''
    try { await a.leggiByte(nonValido) } catch (e) { manifestErrato = (e as Error).name }

    const troncato = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'
    await a.scriviByte(troncato, new Blob([new Uint8Array([1, 2, 3, 4])]))
    const d = new window.Dexie(prefisso + troncato, { autoOpen: false })
    d.version(1).stores({ blocchi: 'chiave' })
    await d.open()
    const [chiave] = (await d.table('blocchi').toCollection().primaryKeys()) as string[]
    await d.table('blocchi').put({ chiave, buffer: new ArrayBuffer(2) })
    d.close()
    const byte = await a.leggiByte(troncato)
    if (!byte || !('leggiIntervallo' in byte)) throw Error('Sorgente persistente attesa')
    let bloccoTroncato = ''
    try { await byte.leggiIntervallo(0, 4) } catch (e) { bloccoTroncato = (e as Error).name }
    let fuoriMisura = ''
    try { await byte.leggiIntervallo(0, 5) } catch (e) { fuoriMisura = (e as Error).name }
    await a.eliminaByte(troncato)
    return { manifestErrato, bloccoTroncato, fuoriMisura, log: window.videoArchivioQA.log.map(e => e.messaggio) }
  })
  expect(risultato.manifestErrato).toBe('VIDEO_ARCHIVIO_NON_VALIDO')
  expect(risultato.bloccoTroncato).toBe('VIDEO_BLOCCO_INCOMPLETO')
  expect(risultato.fuoriMisura).toBe('VIDEO_INTERVALLO_NON_VALIDO')
  expect(risultato.log).toEqual(expect.arrayContaining([
    'video-upload-archivio-non-valido: job=c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
    'video-upload-blocco-assente: job=c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2',
    'video-upload-intervallo-non-valido: job=c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2',
  ]))
})

test('video: un deposito scritto con un blocco diverso resta leggibile (il layout sta nel manifest)', async ({ page }) => {
  const jobId = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'
  const letto = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, PREFISSO_DEPOSITO_VIDEO: prefisso } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.leggi('x')
    const d = new window.Dexie(prefisso + jobId, { autoOpen: false })
    d.version(1).stores({ blocchi: 'chiave' })
    await d.open()
    // Dieci byte in blocchi da 4: [0..3] [4..7] [8,9]
    await d.table('blocchi').bulkPut([0, 1, 2].map(i => ({
      chiave: `g4:${i}`, buffer: new Uint8Array(Array.from({ length: i === 2 ? 2 : 4 }, (_, k) => i * 4 + k)).buffer,
    })))
    d.close()
    const principale = new window.Dexie('KidvilleVideoUploadDB')
    principale.version(1).stores({ caricamenti: 'jobId, stato, aggiornatoIl', byte: 'jobId' })
    await principale.table('byte').put({ jobId, formato: 'blocchi-v2', generazione: 'g4', size: 10, type: 'video/mp4', dimensioneBlocco: 4 })
    principale.close()
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito assente')
    const s = await new LettoreBlob().openFile(byte)
    const fetta = await s.slice(3, 10)
    await a.eliminaByte(jobId)
    return { valori: Array.from(fetta.value), done: fetta.done }
  }, jobId)
  expect(letto).toEqual({ valori: [3, 4, 5, 6, 7, 8, 9], done: true })
})

test('video: un lettore non segue una riscrittura con un file DIVERSO, e dopo la rimozione non ricrea database', async ({ page }) => {
  const jobId = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4'
  const esito = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array(blocco * 2).fill(1)], { type: 'video/mp4' }))
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito assente')
    const s = await new LettoreBlob().openFile(byte)
    await s.slice(0, blocco)
    // Un file diverso (altra dimensione) al posto del primo: il lettore aperto non
    // deve cucire i byte dell'uno con quelli dell'altro.
    await a.scriviByte(jobId, new Blob([new Uint8Array(blocco * 2 + 1).fill(2)], { type: 'video/mp4' }))
    let diverso = ''
    try { await s.slice(blocco, blocco * 2) } catch (e) { diverso = (e as Error).name }
    const s2 = await new LettoreBlob().openFile((await a.leggiByte(jobId))!)
    await a.eliminaByte(jobId)
    let rimosso = ''
    try { await s2.slice(0, 4) } catch (e) { rimosso = (e as Error).name }
    return { diverso, rimosso, log: window.videoArchivioQA.log.map(e => e.messaggio) }
  }, jobId)
  expect(esito.diverso).toBe('VIDEO_BLOCCO_INCOMPLETO')
  expect(esito.rimosso).toBe('VIDEO_BLOCCO_INCOMPLETO')
  expect(esito.log).toContain(`video-upload-deposito-rimosso: job=${jobId}`)
  expect((await depositi(page)).nomi).toEqual([])
})

test('video: la potatura decide anche sui manifest senza riga e sui database vuoti', async ({ page }) => {
  const esito = await page.evaluate(async () => {
    const { ArchivioCaricamentiDexie, PREFISSO_DEPOSITO_VIDEO: prefisso, ETA_MINIMA_ORFANO_MS: eta } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    const manifestVecchio = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'
    const manifestGiovane = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2'
    const vuoto = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3'
    await a.scriviByte(manifestGiovane, new Blob([new Uint8Array([1])]))
    await a.scriviByte(manifestVecchio, new Blob([new Uint8Array([1])]))
    // Il manifest del «vecchio» porta una generazione nata più di un'ora fa.
    const principale = new window.Dexie('KidvilleVideoUploadDB')
    principale.version(1).stores({ caricamenti: 'jobId, stato, aggiornatoIl', byte: 'jobId' })
    const m = await principale.table('byte').get(manifestVecchio)
    const vecchia = `${(Date.now() - eta - 60_000).toString(36)}-sintetica`
    const d = new window.Dexie(prefisso + manifestVecchio, { autoOpen: false })
    d.version(1).stores({ blocchi: 'chiave' })
    await d.open()
    await d.table('blocchi').put({ chiave: `${vecchia}:0`, buffer: new ArrayBuffer(1) })
    d.close()
    await principale.table('byte').put({ ...m, generazione: vecchia })
    principale.close()
    const v = new window.Dexie(prefisso + vuoto, { autoOpen: false })
    v.version(1).stores({ blocchi: 'chiave' })
    await v.open()
    v.close()
    const rimossi = await a.potaDepositiOrfani()
    const rimasti = (await indexedDB.databases()).map(x => x.name ?? '').filter(n => n.startsWith(prefisso)).map(n => n.slice(prefisso.length))
    const manifestTolto = !(await a.leggiByte(manifestVecchio))
    await a.eliminaByte(manifestGiovane)
    return { rimossi, rimasti, manifestTolto, attesi: [manifestGiovane] }
  })
  expect(esito.rimossi).toBe(2)
  expect(esito.rimasti).toEqual(esito.attesi)
  expect(esito.manifestTolto).toBe(true)
})

test('video: una lettura fallita del manifest prima della copia non distrugge il deposito valido', async ({ page }) => {
  const jobId = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'
  const esito = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([7, 6, 5])]))
    const get = IDBObjectStore.prototype.get
    let iniettato = false
    IDBObjectStore.prototype.get = function(chiave) {
      if (!iniettato && this.name === 'byte' && chiave === jobId) {
        iniettato = true
        throw new DOMException('Lettura sintetica fallita', 'UnknownError')
      }
      return get.call(this, chiave)
    }
    let errore = ''
    try { await a.scriviByte(jobId, new Blob([new Uint8Array([1, 1, 1, 1])])) }
    catch (e) { errore = (e as Error).name }
    finally { IDBObjectStore.prototype.get = get }
    const byte = await a.leggiByte(jobId)
    const letti = byte ? Array.from((await (await new LettoreBlob().openFile(byte)).slice(0, 3)).value) : []
    await a.eliminaByte(jobId)
    return { iniettato, errore, letti }
  }, jobId)
  expect(esito.iniettato).toBe(true)
  expect(esito.errore).not.toBe('')
  expect(esito.letti).toEqual([7, 6, 5])
})
