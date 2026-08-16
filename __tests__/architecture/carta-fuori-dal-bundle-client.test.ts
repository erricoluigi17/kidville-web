// @vitest-environment node
/**
 * LA CARTA INTESTATA NON PUÒ ENTRARE IN UN BUNDLE CLIENT — e questo è il lock che lo tiene.
 *
 * `src/lib/carta/asset/carta-intestata.pdf` pesa **1.097.589 byte**. Un solo `import` da un
 * componente `'use client'` lo trascina nel bundle della pagina: 1,1 MB scaricati da ogni
 * telefono di famiglia e da ogni tablet della scuola, a ogni apertura, anche da chi un PDF
 * non lo genera mai. Non romperebbe niente — la pagina funzionerebbe, i test passerebbero,
 * la build sarebbe verde — e il costo lo pagherebbe qualcun altro, sulla rete di casa sua.
 *
 * È il motivo per cui il registro presenze, che il PDF lo componeva nel browser, è passato
 * a una rotta (`/api/admin/registro-presenze/pdf`).
 *
 * ─── SI GUARDA IL GRAFO, NON LA RIGA ───────────────────────────────────────────
 *
 * Un lock che cercasse `@/lib/carta` dentro i file `'use client'` sarebbe già aggirato oggi:
 * basta che un componente importi un modulo che importa la carta. Qui si cammina il grafo
 * degli import a partire da ogni file client, e si guarda dove si arriva.
 *
 * `@/lib/carta/geometria` è ammesso di proposito, ed è la distinzione che conta: sono una
 * manciata di numeri senza dipendenze, mentre `carta/asset`, `carta/applica` e `carta/index`
 * portano pdf-lib e la lettura da disco dell'asset.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.join(process.cwd(), 'src')

/** I moduli che nessun file client può raggiungere, e perché. */
const VIETATI: Record<string, string> = {
  'src/lib/carta/asset.ts': 'legge da disco 1,1 MB di carta intestata',
  'src/lib/carta/applica.ts': "porta l'asset e pdf-lib",
  'src/lib/carta/index.ts': "porta l'asset e pdf-lib",
  'jspdf-autotable': 'sta nel motore server del registro presenze, non nel browser',
}

function sorgenti(cartella: string, raccolti: string[] = []): string[] {
  for (const voce of fs.readdirSync(cartella, { withFileTypes: true })) {
    const completo = path.join(cartella, voce.name)
    if (voce.isDirectory()) sorgenti(completo, raccolti)
    else if (/\.tsx?$/.test(voce.name)) raccolti.push(completo)
  }
  return raccolti
}

const FILES = sorgenti(SRC)

/** Da uno specificatore di import al file di `src/` che risolve, se ce n'è uno. */
function risolvi(specificatore: string, daFile: string): string | null {
  let base: string
  if (specificatore.startsWith('@/')) base = path.join(SRC, specificatore.slice(2))
  else if (specificatore.startsWith('.')) base = path.resolve(path.dirname(daFile), specificatore)
  else return null
  for (const tentativo of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (fs.existsSync(tentativo) && fs.statSync(tentativo).isFile()) return tentativo
  }
  return null
}

/** Ogni specificatore importato da un file: `import`, `import type` e `import()` dinamico. */
function specificatori(sorgente: string): string[] {
  const trovati: string[] = []
  for (const [, s] of sorgente.matchAll(/^[ \t]*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  for (const [, s] of sorgente.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  for (const [, s] of sorgente.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) trovati.push(s)
  for (const [, s] of sorgente.matchAll(/^[ \t]*export\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  return trovati
}

const eClient = (file: string) => /^\s*['"]use client['"]/m.test(fs.readFileSync(file, 'utf8'))

/** Il primo percorso che dal file client arriva a un modulo vietato, se esiste. */
function stradaVerso(partenza: string): string[] | null {
  const visti = new Set<string>([partenza])
  const coda: { file: string; strada: string[] }[] = [{ file: partenza, strada: [partenza] }]
  while (coda.length > 0) {
    const { file, strada } = coda.shift()!
    for (const specificatore of specificatori(fs.readFileSync(file, 'utf8'))) {
      if (VIETATI[specificatore]) return [...strada, specificatore]
      const risolto = risolvi(specificatore, file)
      if (!risolto) continue
      const relativo = path.relative(process.cwd(), risolto)
      if (VIETATI[relativo]) return [...strada, relativo]
      if (visti.has(risolto)) continue
      visti.add(risolto)
      coda.push({ file: risolto, strada: [...strada, relativo] })
    }
  }
  return null
}

describe('la carta intestata resta fuori dal bundle client', () => {
  it('ci sono file client da controllare (o questo lock è vacuo)', () => {
    expect(FILES.filter(eClient).length).toBeGreaterThan(50)
  })

  it("i moduli vietati esistono davvero, col nome che questo lock si aspetta", () => {
    // Un percorso rinominato renderebbe il lock verde senza sorvegliare più niente: è il
    // modo in cui un test smette di misurare senza che nessuno se ne accorga.
    for (const nome of Object.keys(VIETATI)) {
      if (nome.startsWith('src/')) expect(fs.existsSync(path.join(process.cwd(), nome)), nome).toBe(true)
    }
  })

  it('nessun file «use client» arriva alla carta o a jspdf-autotable', () => {
    const colpevoli: string[] = []
    for (const file of FILES.filter(eClient)) {
      const strada = stradaVerso(file)
      if (strada) colpevoli.push(strada.map((p) => path.relative(process.cwd(), p)).join(' → '))
    }
    expect(
      colpevoli,
      'un import da qui trascina nel bundle della pagina 1,1 MB di carta intestata (o il ' +
        'motore delle tabelle PDF): il PDF si genera in una rotta, non nel browser.\n' +
        colpevoli.join('\n')
    ).toEqual([])
  })
})
