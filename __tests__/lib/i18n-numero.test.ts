/**
 * `formattaDecimale` / `formattaMegabyte` — il separatore segue l'INTERFACCIA.
 *
 * ─── IL DIFETTO (verificatore adversariale, 2026-08-03) ─────────────────────
 * `teacher/gallery/page.tsx` scriveva la dimensione di un video così:
 *
 *     (file.size / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })
 *
 * `undefined` non vuol dire «la lingua dell'app»: vuol dire «la lingua del
 * RUNTIME» — il sistema operativo di chi guarda, o il processo su Vercel
 * (`en-US`). Con l'interfaccia inglese su un browser italiano usciva
 * «50,3 MB» dentro una frase inglese; con l'interfaccia italiana su un browser
 * inglese, «50.3 MB» dentro una frase italiana. Nella stessa pagina, una riga
 * più in là, lo stesso numero aveva il difetto opposto: locale CABLATO a
 * `'it-IT'`.
 *
 * ─── PERCHÉ QUESTO TEST SA DIVENTARE ROSSO ──────────────────────────────────
 * Le due lingue si asseriscono INSIEME, ed è la parte che conta: qualunque
 * riscrittura che ignori il parametro `locale` — `toLocaleString(undefined, …)`,
 * `'it-IT'` cablato, `Intl` senza lingua — dà lo STESSO separatore in tutti e
 * due i casi, e uno dei due diventa rosso qualunque sia il locale della macchina
 * che esegue i test. Un test che asserisse una lingua sola sarebbe verde su
 * metà delle macchine e cieco sull'altra metà.
 */
import { describe, it, expect } from 'vitest'
import { formattaDecimale, formattaMegabyte } from '@/lib/i18n/numero'

const CINQUANTA_VIRGOLA_TRE_MB = 52.8 * 1024 * 1024

describe('formattaDecimale — il locale è un parametro, non l’ambiente', () => {
  it('la stessa cifra si scrive con la virgola in italiano e col punto in inglese', () => {
    expect(formattaDecimale(50.3, 'it')).toBe('50,3')
    expect(formattaDecimale(50.3, 'en')).toBe('50.3')
    // …e le due DEVONO essere diverse: se un giorno coincidessero vorrebbe dire
    // che il parametro non arriva più a `Intl`.
    expect(formattaDecimale(50.3, 'it')).not.toBe(formattaDecimale(50.3, 'en'))
  })

  it('arrotonda a una cifra (il default), e rispetta `cifreMax` quando serve', () => {
    expect(formattaDecimale(50.34, 'en')).toBe('50.3')
    expect(formattaDecimale(50.36, 'en')).toBe('50.4')
    expect(formattaDecimale(50.345, 'en', 2)).toBe('50.35')
  })

  it('numero non finito ⇒ stringa vuota: «NaN MB» a schermo è peggio di un buco', () => {
    expect(formattaDecimale(Number.NaN, 'it')).toBe('')
    expect(formattaDecimale(Number.POSITIVE_INFINITY, 'en')).toBe('')
    expect(formattaMegabyte(Number.NaN, 'it')).toBe('')
  })

  it('lingua sconosciuta o vuota ⇒ il default dell’app (italiano), mai il runtime', () => {
    // `bcp47` mappa lingua → regione e ricade su `it-IT`: un valore sporco non
    // deve poter riaprire la porta al locale della macchina.
    expect(formattaDecimale(50.3, 'de')).toBe('50,3')
    expect(formattaDecimale(50.3, '')).toBe('50,3')
    // …e un BCP47 già completo resta stabile (le funzioni si incatenano).
    expect(formattaDecimale(50.3, 'en-GB')).toBe('50.3')
  })
})

describe('formattaMegabyte — la dimensione di un file dentro una frase', () => {
  it('converte i byte e porta con sé l’unità, nella lingua giusta', () => {
    expect(formattaMegabyte(CINQUANTA_VIRGOLA_TRE_MB, 'it')).toBe('52,8 MB')
    expect(formattaMegabyte(CINQUANTA_VIRGOLA_TRE_MB, 'en')).toBe('52.8 MB')
  })

  it('`unita: false` per le frasi che il «MB» ce l’hanno già scritto dentro', () => {
    // `galleryAlertVideoTroppoGrande` dice «(attuale: {dimensione} MB)»: con
    // l'unità attaccata uscirebbe «52,8 MB MB».
    expect(formattaMegabyte(CINQUANTA_VIRGOLA_TRE_MB, 'it', { unita: false })).toBe('52,8')
    expect(formattaMegabyte(CINQUANTA_VIRGOLA_TRE_MB, 'en', { unita: false })).toBe('52.8')
  })

  it('`cifreMax` arriva fino a `Intl` (l’opzione pubblica non è decorativa)', () => {
    // Il file esercitava `cifreMax` solo su `formattaDecimale`: togliendo la
    // propagazione da `formattaMegabyte` (`numero.ts`, la riga che passa
    // `cifreMax` al decimale) restavano verdi tutti e sette i casi, e un
    // parametro che non arriva da nessuna parte è indistinguibile da un
    // parametro che non esiste.
    //
    // 52,789 MB col default (1 cifra) darebbe «52.8 MB»: il valore atteso qui
    // sotto è raggiungibile SOLO se `cifreMax: 2` arriva davvero a `Intl`.
    expect(formattaMegabyte(52.789 * 1024 * 1024, 'en', { cifreMax: 2 })).toBe('52.79 MB')
    expect(formattaMegabyte(52.789 * 1024 * 1024, 'it', { cifreMax: 2 })).toBe('52,79 MB')
    // …e col default resta una cifra: senza questa riga il caso sopra sarebbe
    // verde anche cablando `maximumFractionDigits: 2` e buttando via il
    // parametro, che è lo stesso difetto con un altro nome.
    expect(formattaMegabyte(52.789 * 1024 * 1024, 'en')).toBe('52.8 MB')
  })

  it('i megabyte sono binari (1024²), come il limite con cui si confrontano', () => {
    // Il limite lato pagina è `50 * 1024 * 1024`: contarli in 10⁶ direbbe «52,4»
    // per un file che il codice ha appena chiamato «oltre i 50 MB».
    expect(formattaMegabyte(50 * 1024 * 1024, 'en')).toBe('50 MB')
    expect(formattaMegabyte(1024 * 1024, 'en')).toBe('1 MB')
  })
})
