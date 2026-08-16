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
 * trappola qui costerebbe un 500 in produzione e nient'altro in locale.
 *
 * ⚠️ **LA PRIMA VERSIONE DI QUESTO COMMENTO RIPORTAVA UNA MISURA CHE NON ERA STATA
 * FATTA.** Diceva di aver trovato l'asset nei manifest di tre rotte; rimisurato sullo
 * stesso `.next/`, le occorrenze erano **zero**, e l'unica in tutta la cartella era una
 * riga dentro una source-map. Non era un dettaglio sbagliato: era coerente col difetto
 * vero di quel giorno — **nessuna rotta importava la carta**, quindi il bundler non aveva
 * niente da tracciare. Una prova che non prova niente è peggio di nessuna prova, perché
 * chiude l'indagine.
 *
 * La misura vera, **dopo** aver collegato le rotte (2026-08-15, Next 16.3, `rm -rf .next
 * && npm run build`):
 *
 * ```
 * .next/server/app/api/prestampati/genera/route.js.nft.json
 *   → "../../../../../../src/lib/carta/asset/carta-intestata.pdf"      1.097.589 byte ✓
 * .next/server/app/api/parent/prestampati/firma/route.js.nft.json
 *   → "../../../../../../../src/lib/carta/asset/carta-intestata.pdf"   1.097.589 byte ✓
 * ```
 *
 * Sono le due sole rotte che oggi importano la carta, e in entrambe il percorso relativo
 * risolve al file vero. Il tracciamento di Next valuta staticamente questo
 * `path.join(process.cwd(), …)`, quindi il file **entra nel bundle serverless**: un base64
 * inline sarebbe 1,46 MB di sorgente da far leggere a eslint, a tsc e al bundler a ogni
 * build, per risolvere un problema che la misura dice non esserci.
 *
 * ⚠️ Se un giorno il percorso diventa dinamico (una variabile, un `if`), il tracciamento
 * smette di vederlo **in silenzio**: la build resta verde e il guasto compare solo in
 * produzione. La stringa qui sotto resta letterale per questo. E la misura si rifà a ogni
 * rotta nuova che importa la carta — `grep -rl carta-intestata.pdf .next/server` — perché
 * è la voce nel manifest, non questo commento, a decidere che cosa parte per Vercel.
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
