// @vitest-environment node
/**
 * LOCK · DOVE MANDARE I SOLDI E A CHI si decide in UN POSTO SOLO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * IBAN e intestatario compaiono in due punti che parlano alla stessa famiglia:
 * il riquadro «Dati per il bonifico» delle email di sollecito e la card «Come
 * pagare» di `/parent/pagamenti`. Sono le due righe che chi legge copia
 * nell'home banking, ed è l'unico punto del prodotto in cui un dato sbagliato
 * non produce un errore: produce un bonifico finito altrove.
 *
 * Se i due posti leggessero `fiscale_config` per conto proprio, divergerebbero
 * al primo cambio senza che nessuno se ne accorga — perché entrambi
 * continuerebbero ad avere l'aria di essere giusti. È la stessa storia dei lock
 * gemelli `causale-fattura-un-motore-solo` e `intestatario-fattura-un-motore-solo`,
 * e lì la divergenza è costata una fattura emessa con la descrizione sbagliata.
 *
 * ─── COSA SORVEGLIA ─────────────────────────────────────────────────────────
 *  1. `GET /api/pagamenti` e il motore dei solleciti CHIAMANO
 *     `coordinateBonificoSede`. Togliere l'uso del motore in uno dei due rende
 *     rosso questo lock, che è il punto.
 *  2. Gli stessi due file NON ricompongono le coordinate a mano
 *     (`ibanLeggibile` / `datiStruttura`): una seconda cascata è una seconda
 *     regola.
 *  3. Nessun file `'use client'` chiama il motore, e nessun file sotto
 *     `src/components` importa `fiscale.ts` (o il motore, che se lo porta
 *     dietro): quel modulo trascina il logger e quindi `node:crypto` nel bundle
 *     della pagina — un difetto che `vitest` non vede e che salta fuori solo a
 *     `next build`. Il browser che deve validare un IBAN usa `@/lib/pagamenti/iban`,
 *     che è puro apposta.
 *
 * NON verifica che le coordinate siano GIUSTE: quello è
 * `__tests__/lib/pagamenti/coordinate-bonifico.test.ts` (il motore),
 * `__tests__/api/pagamenti-coordinate-bonifico.test.ts` (la risposta del GET) e
 * `__tests__/api/pagamenti-solleciti-invio.test.ts` (il riquadro dell'email).
 *
 * ⚠️ LIMITE DICHIARATO: il divieto sul bundle guarda gli import di PRIMO
 * LIVELLO dei file sotto `src/components`. Un modulo intermedio lo aggirerebbe;
 * a coprire il grafo intero è `carta-fuori-dal-bundle-client.test.ts`, che
 * cammina gli import a partire da ogni file `'use client'`. Qui la porta che
 * conta è la più diretta, ed è quella che si apre distrattamente.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.join(process.cwd(), 'src')
const COMPONENTI = path.join(RADICE, 'components')

const MOTORE = path.join('src', 'lib', 'pagamenti', 'coordinate-bonifico.ts')
const ROUTE = path.join('src', 'app', 'api', 'pagamenti', 'route.ts')
const SOLLECITI = path.join('src', 'lib', 'pagamenti', 'solleciti-invio.ts')
const FISCALE = path.join('src', 'lib', 'pagamenti', 'fiscale.ts')
const IBAN_PURO = path.join('src', 'lib', 'pagamenti', 'iban.ts')

/** I due che devono passare dal motore, e che prima leggevano la config da soli. */
const CONSUMATORI = [ROUTE, SOLLECITI]

/** Chi non può entrare nel bundle di una pagina, e perché. */
const FUORI_DAL_BUNDLE: Record<string, string> = {
  [FISCALE]: 'porta il logger, e con lui node:crypto',
  [MOTORE]: 'importa fiscale.ts, quindi porta le stesse dipendenze',
}

function fileTs(dir: string, out: string[] = []): string[] {
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name)
    if (voce.isDirectory()) fileTs(p, out)
    else if (/\.tsx?$/.test(voce.name)) out.push(p)
  }
  return out
}

/** Via i commenti: un lock non deve poter essere aggirato — né innescato — da una frase. */
function soloCodice(testo: string): string {
  return testo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const FILE = fileTs(RADICE).map((assoluto) => ({
  relativo: path.relative(process.cwd(), assoluto),
  codice: soloCodice(fs.readFileSync(assoluto, 'utf-8')),
}))

const di = (relativo: string) => FILE.find((f) => f.relativo === relativo)

/** I file che chiamano la funzione `nome`. */
function chiamano(nome: string): string[] {
  const re = new RegExp(`\\b${nome}\\s*\\(`)
  return FILE.filter((f) => re.test(f.codice)).map((f) => f.relativo)
}

/** Gli specificatori importati da un file: `import`, `import type`, `import()` ed `export … from`. */
function specificatori(codice: string): string[] {
  const trovati: string[] = []
  for (const [, s] of codice.matchAll(/^[ \t]*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  for (const [, s] of codice.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  for (const [, s] of codice.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) trovati.push(s)
  for (const [, s] of codice.matchAll(/^[ \t]*export\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  return trovati
}

/** Da uno specificatore al file di `src/` che risolve, se ce n'è uno. */
function risolvi(specificatore: string, daFile: string): string | null {
  let base: string
  if (specificatore.startsWith('@/')) base = path.join(RADICE, specificatore.slice(2))
  else if (specificatore.startsWith('.')) base = path.resolve(path.dirname(path.join(process.cwd(), daFile)), specificatore)
  else return null
  for (const tentativo of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(tentativo) && fs.statSync(tentativo).isFile()) return path.relative(process.cwd(), tentativo)
  }
  return null
}

const eClient = (codice: string) => /^\s*['"]use client['"]/m.test(codice)
const soggettiComponenti = FILE.filter((f) => f.relativo.startsWith(path.relative(process.cwd(), COMPONENTI)))

describe('LOCK · un solo motore per le coordinate del bonifico', () => {
  it('la misura vede davvero i sorgenti (controllo positivo)', () => {
    // Senza questo, un percorso sbagliato renderebbe VERDI tutte le regole qui
    // sotto: «zero file letti» e «zero violazioni» hanno lo stesso colore.
    expect(FILE.length).toBeGreaterThan(500)
    for (const atteso of [MOTORE, ROUTE, SOLLECITI, FISCALE, IBAN_PURO]) {
      expect(FILE.map((f) => f.relativo), atteso).toContain(atteso)
    }
    expect(soggettiComponenti.length).toBeGreaterThan(100)
    expect(soggettiComponenti.some((f) => eClient(f.codice))).toBe(true)
  })

  it('la pagina e l’email passano ENTRAMBE da `coordinateBonificoSede`', () => {
    const chiamanti = chiamano('coordinateBonificoSede')
    for (const consumatore of CONSUMATORI) {
      expect(
        chiamanti,
        `${consumatore} deve chiedere IBAN e intestatario al motore unico: se se li rilegge ` +
          'per conto suo, la pagina e il sollecito possono dire due IBAN diversi alla stessa famiglia.',
      ).toContain(consumatore)
    }
  })

  it('e non se le ricompongono a mano (`ibanLeggibile` / `datiStruttura`)', () => {
    for (const consumatore of CONSUMATORI) {
      const codice = di(consumatore)!.codice
      expect(/\bibanLeggibile\s*\(/.test(codice), `${consumatore} chiama ibanLeggibile`).toBe(false)
      expect(/\bdatiStruttura\s*\(/.test(codice), `${consumatore} chiama datiStruttura`).toBe(false)
    }
  })

  it('il motore ha una sola definizione, ed è quella', () => {
    // Una seconda `export function coordinateBonificoSede` altrove sarebbe una
    // copia che il test precedente non distinguerebbe dall'originale.
    const definizioni = FILE.filter((f) => /export\s+async\s+function\s+coordinateBonificoSede\b/.test(f.codice))
    expect(definizioni.map((f) => f.relativo)).toEqual([MOTORE])
  })

  it('nessun file «use client» chiama il motore', () => {
    const colpevoli = FILE.filter(
      (f) => eClient(f.codice) && /\bcoordinateBonificoSede\s*\(/.test(f.codice),
    ).map((f) => f.relativo)
    expect(colpevoli).toEqual([])
  })

  it('`fiscale.ts` e il motore restano fuori da `src/components`', () => {
    const colpevoli: string[] = []
    for (const f of soggettiComponenti) {
      for (const s of specificatori(f.codice)) {
        const risolto = risolvi(s, f.relativo)
        if (risolto && FUORI_DAL_BUNDLE[risolto]) colpevoli.push(`${f.relativo} → ${risolto}`)
      }
    }
    expect(
      colpevoli,
      'quel modulo ' +
        Object.values(FUORI_DAL_BUNDLE).join(' / ') +
        ': un componente che lo importa se lo porta nel bundle della pagina. ' +
        `Per validare un IBAN nel browser esiste ${IBAN_PURO}, che è puro apposta.\n` +
        colpevoli.join('\n'),
    ).toEqual([])
  })
})
