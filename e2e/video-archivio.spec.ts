import { test, expect } from '@playwright/test'
import { installaArchivioVideo } from './helpers/archivio-video'
import type { ArchivioCaricamentiDexie } from '../src/lib/media/video/upload/archivio-dexie'
import type { LettoreBlob } from '../src/lib/media/video/upload/lettore-blob'

declare global {
  interface Window {
    videoArchivePause?: boolean
    videoArchiveWriteError?: string
    videoArchivioQA: {
      ArchivioCaricamentiDexie: typeof ArchivioCaricamentiDexie
      LettoreBlob: typeof LettoreBlob
      BLOCCO_VIDEO_LOCALE: number
      log: Array<{ messaggio: string }>
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/__archivio-video-e2e', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Archivio sintetico</body></html>' }))
  await page.goto('/__archivio-video-e2e')
  await installaArchivioVideo(page)
})

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
  await page.reload()
  await installaArchivioVideo(page)
  const riletto = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Byte persi al reload')
    const source = await new LettoreBlob().openFile(byte)
    const aCavallo = await source.slice(blocco - 11, blocco + 19)
    const ultimo = await source.slice(blocco + 19, blocco + 100)
    await a.eliminaByte(jobId)
    const assente = await a.leggiByte(jobId)
    return { size: source.size, cavallo: Array.from(aCavallo.value), ultimo: Array.from(ultimo.value), done: ultimo.done, sizeFinale: ultimo.value.size, assente: !assente }
  }, jobId)
  expect(riletto.size).toBe(scritto.blocco + 37)
  expect(riletto.cavallo).toEqual(Array.from({ length: 30 }, (_, i) => (scritto.blocco - 11 + i) % 251))
  expect(riletto.ultimo).toEqual(Array.from({ length: 18 }, (_, i) => (scritto.blocco + 19 + i) % 251))
  expect(riletto.done).toBe(true)
  expect(riletto.sizeFinale).toBe(18)
  expect(riletto.assente).toBe(true)
  expect(await contaDepositi(page)).toBe(0)
})

test('video: interruzione durante la persistenza conserva il deposito precedente', async ({ page }) => {
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
    const log = window.videoArchivioQA.log.map(e => e.messaggio)
    await a.eliminaByte(jobId)
    return { errore, byte: Array.from(fetta.value), log }
  }, jobId)
  expect(risultato.errore).toBe('AbortError')
  expect(risultato.byte).toEqual([9, 8, 7])
  expect(risultato.log).toContain('video-upload-persistenza-fallita')
  expect(await contaDepositi(page)).toBe(0)
})

async function contaDepositi(page: import('@playwright/test').Page): Promise<number> {
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

test('video: quota durante il secondo blocco annulla anche i blocchi parziali', async ({ page }) => {
  const risultato = await page.evaluate(async () => {
    const { ArchivioCaricamentiDexie, LettoreBlob, BLOCCO_VIDEO_LOCALE: blocco } = window.videoArchivioQA
    const jobId = '33333333-3333-4333-8333-333333333333'
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([3, 2, 1])]))
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value, key) {
      const id = (value as { jobId?: string }).jobId
      if (id?.startsWith(`${jobId}:`) && id.endsWith(':1')) throw new DOMException('Quota sintetica', 'QuotaExceededError')
      return put.call(this, value, key)
    }
    let errore = ''
    try { await a.scriviByte(jobId, new Blob([new Uint8Array(blocco + 1)])) }
    catch (e) { errore = (e as Error).name }
    finally { IDBObjectStore.prototype.put = put }
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito precedente perso')
    const source = await new LettoreBlob().openFile(byte)
    return { errore, byte: Array.from((await source.slice(0, 3)).value) }
  })
  expect(risultato.errore).toBe('QuotaExceededError')
  expect(risultato.byte).toEqual([3, 2, 1])
  expect(await contaDepositi(page)).toBe(2) // Un manifest e il solo blocco precedente.
})

test('video: chiusura della pagina durante la scrittura non pubblica blocchi parziali', async ({ page }) => {
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
  const byte = await page.evaluate(async jobId => {
    const { ArchivioCaricamentiDexie, LettoreBlob } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Deposito perso dopo chiusura')
    return Array.from((await (await new LettoreBlob().openFile(byte)).slice(0, 3)).value)
  }, jobId)
  expect(byte).toEqual([4, 5, 6])
  expect(await contaDepositi(page)).toBe(2)
})

test('video: un blocco mancante viene rifiutato senza spedire byte troncati', async ({ page }) => {
  const risultato = await page.evaluate(async () => {
    const jobId = '55555555-5555-4555-8555-555555555555'
    const { ArchivioCaricamentiDexie, LettoreBlob } = window.videoArchivioQA
    const a = new ArchivioCaricamentiDexie()
    await a.scriviByte(jobId, new Blob([new Uint8Array([1, 2, 3])]))
    await new Promise<void>((resolve, reject) => {
      const richiesta = indexedDB.open('KidvilleVideoUploadDB')
      richiesta.onerror = () => reject(richiesta.error)
      richiesta.onsuccess = () => {
        const db = richiesta.result
        const tx = db.transaction('byte', 'readwrite')
        const store = tx.objectStore('byte')
        const cursore = store.openCursor()
        cursore.onsuccess = () => {
          const voce = cursore.result
          if (!voce) return
          if (String(voce.key).startsWith(`${jobId}:`)) voce.delete()
          voce.continue()
        }
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
    })
    const byte = await a.leggiByte(jobId)
    if (!byte) throw Error('Manifest assente')
    let errore = ''
    try { await (await new LettoreBlob().openFile(byte)).slice(0, 3) }
    catch (e) { errore = (e as Error).message }
    await a.eliminaByte(jobId)
    return { errore, log: window.videoArchivioQA.log.map(e => e.messaggio) }
  })
  expect(risultato.errore).toBe('VIDEO_BLOCCO_INCOMPLETO')
  expect(risultato.log).toContain('video-upload-blocco-assente')
  expect(await contaDepositi(page)).toBe(0)
})
