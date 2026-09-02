import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { arubaSignin, arubaUltimoNumeroFattura } from '@/lib/aruba/client'

/**
 * IL PROGRESSIVO LETTO DA ARUBA, COL CODICE VERO E CONTRO L'API VERA. Sola lettura.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────────
 * Il 2026-09-02 un'emissione si è fermata su «Impossibile leggere l'ultimo numero della
 * serie FPR». La causa: `findByUsername` restituisce DOCUMENTI, e il numero della fattura
 * sta nell'array `invoices` annidato dentro ciascuno — non su `.number` dell'involucro,
 * che è dove il codice lo cercava. Su 3.311 documenti del 2026 il valore era `undefined`
 * su tutti e 3.311.
 *
 * La correzione ha un test unitario (`__tests__/lib/aruba/numerazione-sezionale.test.ts`)
 * costruito sulla forma misurata. Ma un test unitario prova che il codice legge la fixture
 * che gli abbiamo scritto noi — ed è esattamente l'errore che ha causato il guasto: i mock
 * precedenti assumevano la forma che avrebbero dovuto dimostrare, e sono rimasti verdi
 * mentre in produzione non si leggeva niente. Questo collaudo chiude quel cerchio: chiama
 * la funzione DI PRODUZIONE contro l'API DI PRODUZIONE.
 *
 * ─── COSA NON FA ────────────────────────────────────────────────────────────────────
 * Non emette, non carica, non scrive: `findByUsername` è una GET. Non stampa nessun dato
 * personale — i documenti contengono `receiver.fiscalCode` di genitori reali, e qui esce
 * solo un intero per serie.
 *
 * ⚠️ Consuma parte del limite Aruba (~60 richieste/ora): una signin più una pagina ogni
 * 500 documenti, per ciascuna delle due serie.
 *
 * ESECUZIONE
 *   COLLAUDO_REALE=1 npx vitest run --config vitest.collaudo.config.ts
 */

function envLocale(nome: string): string {
  const diretta = process.env[nome]
  if (diretta) return diretta
  try {
    const testo = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    const m = testo.match(new RegExp(`^\\s*${nome}\\s*=\\s*(.*)$`, 'm'))
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

const ATTIVO = process.env.COLLAUDO_REALE === '1'
const USERNAME = envLocale('ARUBA_USERNAME')
const PASSWORD = envLocale('ARUBA_PASSWORD')

describe.skipIf(!ATTIVO || !USERNAME || !PASSWORD)('numerazione Aruba — il codice vero, l\'API vera', () => {
  it('legge un progressivo PLAUSIBILE per entrambe le serie, e non zero', async () => {
    const anno = new Date().getFullYear()
    const { accessToken } = await arubaSignin('production', { username: USERNAME, password: PASSWORD })

    const asilo = await arubaUltimoNumeroFattura('production', accessToken, {
      username: USERNAME, anno, sezionale: 'Asilo',
    })
    const fpr = await arubaUltimoNumeroFattura('production', accessToken, {
      username: USERNAME, anno, sezionale: 'FPR',
    })
    // Solo numeri: nessun nome, nessun codice fiscale.
    console.log(`  Asilo ${anno}: ultimo numero letto = ${asilo}`)
    console.log(`  FPR   ${anno}: ultimo numero letto = ${fpr}`)

    // ZERO è il valore che il difetto produceva quando la guardia non c'era, ed è il
    // valore che farebbe emettere «FPR 1/26» su una serie da millenovecento documenti.
    // Su serie vive da anni non è un numero plausibile: è il sintomo.
    expect(asilo, 'la serie Asilo esiste da anni: uno zero qui è il difetto, non un dato').toBeGreaterThan(1000)
    expect(fpr, 'idem per FPR').toBeGreaterThan(1000)

    // E non devono essere lo STESSO numero: fino al 2026-08-09 il parser mescolava le
    // due serie in un mucchio solo, ed è il difetto che produce una collisione fiscale.
    expect(asilo).not.toBe(fpr)
  })
})
