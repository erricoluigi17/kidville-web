import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK — la formula che risolve la sezione vive in UN POSTO SOLO
//
// Il nome di una classe scritto a mano dalla segreteria ritrova la sua sezione
// grazie a un trigger nel database:
//
//   lower(replace(s.name, ' ', '')) = lower(replace(NEW.classe_sezione, ' ', ''))
//   — `sync_alunno_section_id()`, 20260704120000_baseline.sql
//
// Chi in TypeScript vuole sapere IN ANTICIPO se una classe troverà la sua
// sezione deve rifare esattamente quel conto. Fino al 2026-08-20 la copia viveva
// privata dentro `src/app/api/admin/iscrizioni/route.ts`, e il giorno che è
// servita una seconda volta — la guardia sull'elenco di classe — la strada
// naturale era copiarla. Due copie della stessa normalizzazione sono due
// dialetti: divergono al primo ritocco, e quando divergono il codice accetta
// nomi che il trigger poi NON risolve. L'esito non è un errore: è
// `alunni.section_id` a NULL, cioè un bambino iscritto e invisibile all'appello.
//
// LA PROVA. Nessun file di `src/` — tranne il modulo che la ospita — può
// contenere la forma `replace(/ /g, '')` seguita da `toLowerCase()`, in un verso
// o nell'altro. È la firma della formula, e prenderla per firma vuol dire che
// anche una copia rinominata («normalizzaSezione», «chiaveClasse») viene vista.
//
// LA PROVA DI SANITÀ, obbligatoria: se nessun file importa il modulo, questo
// lock sta guardando il vuoto e va considerato rotto — è la lezione pagata dal
// lock che si era immunizzato col proprio commento (PR #88).
// ─────────────────────────────────────────────────────────────────────────────

const CASA = 'src/lib/alunni/sezione.ts'
const FIRMA = /replace\(\s*\/ \/g\s*,\s*''\s*\)\s*\.\s*toLowerCase\(\)|toLowerCase\(\)\s*\.\s*replace\(\s*\/ \/g\s*,\s*''\s*\)/

function tsDi(dir: string, out: string[] = []): string[] {
  for (const v of readdirSync(dir)) {
    const p = join(dir, v)
    if (statSync(p).isDirectory()) tsDi(p, out)
    else if (/\.tsx?$/.test(v)) out.push(p)
  }
  return out
}

describe('LOCK — la formula del trigger sezione non si duplica', () => {
  const file = tsDi('src')

  it('nessun file di src/ la ridefinisce fuori dalla sua casa', () => {
    const colpevoli = file
      .map((p) => relative(process.cwd(), p))
      .filter((p) => p !== CASA)
      .filter((p) => FIRMA.test(readFileSync(p, 'utf8')))
    expect(colpevoli, `la formula del trigger è stata riscritta in: ${colpevoli.join(', ')}`).toEqual([])
  })

  it('PROVA DI SANITÀ: qualcuno la importa davvero, altrimenti questo lock guarda il vuoto', () => {
    const importatori = file.filter((p) =>
      /from '@\/lib\/alunni\/sezione'/.test(readFileSync(p, 'utf8')),
    )
    expect(importatori.length).toBeGreaterThanOrEqual(2)
  })

  it('la firma cercata riconosce davvero una copia (controllo negativo)', () => {
    // Se questa asserzione cade, la regex ha smesso di riconoscere la formula e
    // il primo lock passerebbe su qualunque duplicato.
    expect(FIRMA.test("String(n ?? '').replace(/ /g, '').toLowerCase()")).toBe(true)
    expect(FIRMA.test("nome.trim().toLowerCase()")).toBe(false)
  })
})
