/**
 * L'asset della carta intestata, caricato una volta sola.
 *
 * `src/lib/carta/asset/carta-intestata.pdf` è la carta reale della scuola: vettoriale
 * puro, A4 esatto, con il marchio in alto e il piede a quattro colonne già stampati.
 * **Non si modifica, non si ricomprime, non si ottimizza**: istruzione esplicita del
 * titolare, e `__tests__/lib/carta-asset-lock.test.ts` ne blinda il SHA-256 proprio
 * perché un'ottimizzazione ben intenzionata non passi inosservata.
 *
 * Questo modulo fa una cosa sola — restituire i byte — ed è importabile SOLO dal codice
 * server: 1,1 MB in un bundle client sarebbero 1,1 MB scaricati da ogni telefono.
 *
 * Testato in `__tests__/lib/carta-asset-lock.test.ts`.
 */

/**
 * PERCHÉ SI LEGGE DAL DISCO E NON DA UN BASE64 INLINE — misurato, non dedotto.
 *
 * `src/lib/protocolli/assets.ts` porta il logo in base64 dentro il sorgente proprio
 * perché «la lettura fs da `public/` non è tracciata dal bundler su Vercel»: la stessa
 * trappola qui costerebbe un 500 in produzione e nient'altro in locale. Quindi la strada
 * è stata **misurata** invece che scelta (2026-08-15, Next 16.3):
 *
 *   1. una sonda che chiama `cartaIntestataBytes()` dal motore prestampati;
 *   2. `npm run build`;
 *   3. `.next/server/app/api/parent/prestampati/firma/route.js.nft.json` →
 *      `"../../../../../../../src/lib/carta/asset/carta-intestata.pdf"`, che risolve al
 *      file vero, 1.097.589 byte. Stessa voce nei manifest di `/api/prestampati` e
 *      `/api/prestampati/genera`.
 *
 * Il file finisce dunque nel bundle serverless: il tracciamento di Next valuta
 * staticamente questo `path.join(process.cwd(), …)`. Un base64 inline sarebbe 1,46 MB di
 * sorgente da far leggere a eslint, tsc e al bundler a ogni build, per risolvere un
 * problema che la misura dice non esserci.
 *
 * ⚠️ Se un giorno il percorso diventa dinamico (una variabile, un `if`), il tracciamento
 * smette di vederlo **in silenzio**: la build resta verde e il guasto compare solo in
 * produzione. La stringa qui sotto resta letterale per questo.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const PERCORSO_ASSET = path.join(
  process.cwd(),
  'src',
  'lib',
  'carta',
  'asset',
  'carta-intestata.pdf'
)

let memoria: Uint8Array | null = null

/**
 * I byte della carta intestata. Memoizzato: 1,1 MB riletti a ogni certificato sarebbero
 * 1,1 MB di lettura per ciascuno dei diciassette prestampati, per ogni famiglia che ne
 * scarica uno.
 */
export function cartaIntestataBytes(): Uint8Array {
  if (!memoria) {
    const buffer = readFileSync(PERCORSO_ASSET)
    memoria = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }
  return memoria
}
