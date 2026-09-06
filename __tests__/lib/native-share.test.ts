import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * LA CONDIVISIONE NATIVA, E IL SUO VALORE DI RITORNO.
 *
 * ─── PERCHÉ L'ESITO SI COLLAUDA QUI E NON A VALLE ────────────────────────────
 * `condividiLink` non ritorna `void`: ritorna `'foglio' | 'appunti' |
 * 'non-riuscita'`, e su quella distinzione poggia una correzione intera. La copia
 * negli appunti è MUTA: chi ha premuto «Scarica» non ottiene il file, non vede
 * cambiare niente sullo schermo, e senza un avviso il pulsante torna a sembrare
 * rotto — cioè il difetto da cui è nato tutto questo lavoro.
 *
 * Fino al 2026-09-06 di quei tre valori non ne verificava nessuno NIENTE: i due
 * file che li consumano (`__tests__/lib/scarica-media.test.ts` e
 * `__tests__/components/scarica-media-grid.test.tsx`) sostituiscono
 * `@/lib/native/share` con un doppio, quindi collaudano il consumatore e mai il
 * produttore. Misurato: facendo restituire `'foglio'` al ramo della clipboard —
 * cioè spegnendo la distinzione alla SORGENTE — la suite restava 26/26 verde. È
 * la trappola già pagata in questo repo: un mock piatto è verde con e senza la
 * correzione.
 *
 * Stessa cosa per `condividiFileLocale`, che è la consegna del file sul telefono:
 * invertendone la guardia (`if (uri || !isNativeApp()) return false`), cioè
 * impedendo per sempre lo scarico su nativo, i test restavano tutti verdi.
 */

// `@capacitor/share` si finge: il pacchetto vero, in jsdom, cade sull'implementazione
// web e collauderebbe Capacitor invece del nostro instradamento.
const shareNativo = vi.hoisted(() => vi.fn<(opzioni: unknown) => Promise<void>>())
vi.mock('@capacitor/share', () => ({ Share: { share: shareNativo } }))

// In jsdom `Capacitor.isNativePlatform()` risponde sempre `false`: senza questo
// doppio il ramo nativo — metà del modulo — non sarebbe raggiungibile da nessun test.
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => false) }))

import { condividi, condividiFileLocale, condividiLink } from '@/lib/native/share'
import { isNativeApp } from '@/lib/push/native-register'

const nativo = vi.mocked(isNativeApp)

function stubNavigator(key: string, value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true })
}

/** L'annullamento di iOS e della Web Share API. */
const annullamentoAbort = () => new DOMException('The operation was aborted.', 'AbortError')
/** L'annullamento del plugin Android, che NON alza un AbortError ma un messaggio. */
const annullamentoAndroid = () => new Error('Share canceled')

beforeEach(() => {
  vi.clearAllMocks()
  nativo.mockReturnValue(false)
  shareNativo.mockResolvedValue(undefined)
  stubNavigator('share', undefined)
  stubNavigator('clipboard', undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('condividi (fallback web)', () => {
  it('usa navigator.share quando disponibile', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    stubNavigator('share', share)
    await condividi({ title: 'T', text: 'X', url: 'https://k.it/n/1' })
    expect(share).toHaveBeenCalledWith({ title: 'T', text: 'X', url: 'https://k.it/n/1' })
  })

  it('ripiega su clipboard.writeText (url) quando navigator.share manca', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigator('clipboard', { writeText })
    await condividi({ text: 'ciao', url: 'https://k.it/n/2' })
    expect(writeText).toHaveBeenCalledWith('https://k.it/n/2')
  })

  it('senza url ripiega su clipboard.writeText (text)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigator('clipboard', { writeText })
    await condividi({ text: 'solo testo' })
    expect(writeText).toHaveBeenCalledWith('solo testo')
  })

  it('non lancia se la condivisione viene annullata (AbortError)', async () => {
    const share = vi.fn().mockRejectedValue(annullamentoAbort())
    stubNavigator('share', share)
    await expect(condividi({ url: 'https://k.it/n/3' })).resolves.toBeUndefined()
  })
})

describe('condividiLink — l’ESITO, che è ciò che decide se avvisare l’utente', () => {
  it('web con Web Share API riuscita → `foglio`', async () => {
    stubNavigator('share', vi.fn().mockResolvedValue(undefined))
    await expect(condividiLink({ url: 'https://k.it/g/1' })).resolves.toBe('foglio')
  })

  it('web, l’utente ANNULLA il foglio → `foglio` lo stesso: annullare non è un guasto', async () => {
    // Se l'annullamento contasse come guasto, chi chiama scriverebbe una riga
    // d'errore in `app_log` ogni volta che qualcuno tocca «Annulla», e il tasso
    // d'errore dell'app racconterebbe una degradazione che non esiste.
    stubNavigator('share', vi.fn().mockRejectedValue(annullamentoAbort()))
    await expect(condividiLink({ url: 'https://k.it/g/2' })).resolves.toBe('foglio')
  })

  it('web, il foglio fallisce DAVVERO → `non-riuscita`, e NON si ricade sugli appunti', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigator('share', vi.fn().mockRejectedValue(new TypeError('permission denied')))
    stubNavigator('clipboard', { writeText })
    await expect(condividiLink({ url: 'https://k.it/g/3' })).resolves.toBe('non-riuscita')
    // Il foglio è già stato offerto: riproporre una copia dopo che l'utente ha
    // chiuso il pannello sarebbe un secondo gesto che non ha chiesto.
    expect(writeText).not.toHaveBeenCalled()
  })

  it('web SENZA Web Share, appunti riusciti → `appunti` (l’unico ramo muto)', async () => {
    // È il genitore su Firefox desktop. Questa è la riga che tiene in piedi
    // l'avviso di `MediaGrid`: se qui tornasse `foglio`, «Scarica» copierebbe un
    // link senza dirlo — il pulsante rotto di partenza, spostato di un ramo.
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigator('clipboard', { writeText })
    await expect(condividiLink({ url: 'https://k.it/g/4' })).resolves.toBe('appunti')
    expect(writeText).toHaveBeenCalledWith('https://k.it/g/4')
  })

  it('web, gli appunti sono negati dal browser → `non-riuscita`', async () => {
    stubNavigator('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) })
    await expect(condividiLink({ url: 'https://k.it/g/5' })).resolves.toBe('non-riuscita')
  })

  it('web senza NESSUN canale → `non-riuscita`', async () => {
    await expect(condividiLink({ url: 'https://k.it/g/6' })).resolves.toBe('non-riuscita')
  })

  it('nativo → passa dal plugin Capacitor e risponde `foglio`', async () => {
    nativo.mockReturnValue(true)
    // Se il ramo nativo cadesse su `navigator.share`, questo doppio non verrebbe
    // mai chiamato: nella WebView `navigator.share` esiste ma NON è il foglio di
    // sistema di Capacitor.
    stubNavigator('share', vi.fn().mockResolvedValue(undefined))
    await expect(condividiLink({ url: 'https://k.it/g/7', title: 'Foto' })).resolves.toBe('foglio')
    expect(shareNativo).toHaveBeenCalledWith({ url: 'https://k.it/g/7', title: 'Foto' })
  })

  it('nativo, annullamento con «Share canceled» (Android) → `foglio`', async () => {
    // Android non alza un `AbortError`: se si guardasse solo il `name`, ogni
    // «Annulla» su Android sarebbe contato come guasto.
    nativo.mockReturnValue(true)
    shareNativo.mockRejectedValue(annullamentoAndroid())
    await expect(condividiLink({ url: 'https://k.it/g/8' })).resolves.toBe('foglio')
  })

  it('nativo, plugin assente o guasto vero → `non-riuscita`', async () => {
    nativo.mockReturnValue(true)
    shareNativo.mockRejectedValue(new Error('Share plugin is not implemented on android'))
    await expect(condividiLink({ url: 'https://k.it/g/9' })).resolves.toBe('non-riuscita')
  })
})

describe('condividiFileLocale — la consegna del file sul telefono', () => {
  const URI = 'file:///cache/kidville-foto.jpg'

  it('su WEB risponde `false` e non chiama il plugin: lì la strada è l’ancora `download`', async () => {
    await expect(condividiFileLocale(URI, 'Foto')).resolves.toBe(false)
    expect(shareNativo).not.toHaveBeenCalled()
  })

  it('con un uri VUOTO risponde `false` anche su nativo', async () => {
    nativo.mockReturnValue(true)
    await expect(condividiFileLocale('', 'Foto')).resolves.toBe(false)
    expect(shareNativo).not.toHaveBeenCalled()
  })

  it('su nativo consegna il FILE (non il link) al foglio di sistema → `true`', async () => {
    // È il guadagno vero dello scarico nativo: `files: [uri]`, non `url`. Con
    // `url` il foglio condividerebbe di nuovo un link, cioè quello che faceva già
    // il pulsante «Condividi» accanto.
    nativo.mockReturnValue(true)
    await expect(condividiFileLocale(URI, 'Foto della giornata')).resolves.toBe(true)
    expect(shareNativo).toHaveBeenCalledWith({ files: [URI], title: 'Foto della giornata' })
  })

  it('senza titolo non manda una chiave `title` vuota', async () => {
    nativo.mockReturnValue(true)
    await expect(condividiFileLocale(URI)).resolves.toBe(true)
    expect(shareNativo).toHaveBeenCalledWith({ files: [URI] })
  })

  it('l’utente annulla il foglio → `true`: il meccanismo ha funzionato', async () => {
    nativo.mockReturnValue(true)
    shareNativo.mockRejectedValue(annullamentoAbort())
    await expect(condividiFileLocale(URI)).resolves.toBe(true)
  })

  it('il foglio non si apre davvero → `false`, così chi chiama ripiega', async () => {
    nativo.mockReturnValue(true)
    shareNativo.mockRejectedValue(new Error('Failed to share file'))
    await expect(condividiFileLocale(URI)).resolves.toBe(false)
  })
})
