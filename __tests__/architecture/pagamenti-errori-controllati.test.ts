import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * LOCK · OGNI `{ error }` DI POSTGREST, IN `pagamenti`, SI GUARDA.
 * (Fase 5 della roadmap di robustezza, sesto pezzo — 2026-10-10.)
 *
 * PostgREST non lancia: restituisce `{ data: null, error }`. La ricognizione del 10/10 su
 * `src/app/api/pagamenti/**` e sugli aiuti che quelle route chiamano contava 68 letture e
 * scritture col risultato mai guardato. Il `null` diventava un valore: un'attestazione 730
 * con versato 0, un'anteprima di rette che riproponeva quelle già emesse, una DELETE di una
 * voce fatturata perché la guardia fiscale «non aveva trovato» la fattura, un riporto fra
 * rate che toglieva X da una rata senza aggiungerlo all'altra.
 *
 * Quattro forme vietate, tutte già viste qui:
 *   1. `const { data } = await …` / `const { data: x } = await …` — il risultato senza `error`;
 *   2. `await supabase.from(…)…` / `await supabase.rpc(…)` come istruzione — il risultato buttato;
 *   3. `.then(() => {}, () => {})` — l'errore inghiottito;
 *   4. `.catch(() => {})` — idem.
 * Sorgenti letti senza commenti: la prosa nomina le forme vecchie.
 *
 * Lo storage (`supabase.storage`) è fuori: non è PostgREST, e ha la sua gestione.
 */

const RADICE = process.cwd()
const ROUTE = join(RADICE, 'src', 'app', 'api', 'pagamenti')

/** Gli aiuti di `lib/pagamenti` chiamati dalle route e corretti in questo pezzo. */
const AIUTI = [
  'src/lib/pagamenti/credito.ts',
  'src/lib/pagamenti/guasto-db.ts',
  'src/lib/pagamenti/intestatari.ts',
  'src/lib/pagamenti/ricevute.ts',
  'src/lib/pagamenti/riconciliazione-conferma.ts',
  'src/lib/pagamenti/solleciti-invio.ts',
  'src/lib/pagamenti/sospensione.ts',
  'src/lib/pagamenti/spill.ts',
]

/**
 * ⏳ In attesa, con la ragione accanto: queste route le riscrivono le PR della fase 5 ancora
 * aperte (#212 incassi, #213 quote, #214 ticket). Si correggono DOPO il loro merge, nello
 * stesso ramo: correggerle ora vorrebbe dire scrivere due volte lo stesso file su due rami.
 * L'elenco può solo accorciarsi: un file che non ha più violazioni va tolto (test sotto).
 */
const IN_ATTESA = new Set<string>([
  'src/app/api/pagamenti/incassi/route.ts',
  'src/app/api/pagamenti/quote/route.ts',
  'src/app/api/pagamenti/ticket/route.ts',
])

const FORME: Array<{ nome: string; re: RegExp }> = [
  { nome: 'data-senza-error', re: /const\s*\{\s*data(?:\s*:\s*\w+)?\s*\}\s*=\s*await\s+(?!supabase\s*\.\s*storage)/g },
  { nome: 'risultato-buttato', re: /^\s*await\s+supabase\s*\.\s*(?:from|rpc)\s*\(/gm },
  { nome: 'then-muto', re: /\.then\(\s*\(\)\s*=>\s*\{\s*\}\s*,\s*\(\)\s*=>\s*\{\s*\}\s*\)/g },
  { nome: 'catch-muto', re: /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/g },
]

function senzaCommenti(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function fileTs(dir: string): string[] {
  const out: string[] = []
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) out.push(...fileTs(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

function violazioni(sorgente: string): Array<{ forma: string; riga: number }> {
  const s = senzaCommenti(sorgente)
  const trovate: Array<{ forma: string; riga: number }> = []
  for (const { nome, re } of FORME) {
    for (const m of s.matchAll(re)) trovate.push({ forma: nome, riga: s.slice(0, m.index).split('\n').length })
  }
  return trovate
}

const FILE = [...fileTs(ROUTE), ...AIUTI.map((f) => join(RADICE, f))].map((f) => relative(RADICE, f)).sort()

describe('pagamenti · ogni { error } di PostgREST si guarda', () => {
  it('scansiona davvero: le route di pagamenti sono decine, e gli aiuti esistono tutti', () => {
    // Un lock verde su zero file è decorazione (lezione dei tre lock ciechi, 2026-09-19).
    expect(FILE.filter((f) => f.startsWith('src/app/api/pagamenti/')).length).toBeGreaterThan(50)
    for (const a of AIUTI) expect(FILE).toContain(a)
  })

  it('nessuna delle quattro forme vietate, fuori dall’elenco d’attesa', () => {
    const rotti: string[] = []
    for (const f of FILE) {
      if (IN_ATTESA.has(f)) continue
      for (const v of violazioni(readFileSync(join(RADICE, f), 'utf8'))) rotti.push(`${f}:${v.riga} ${v.forma}`)
    }
    expect(rotti, 'risultati di PostgREST non guardati (vedi il commento in testa al file)').toEqual([])
  })

  it('l’elenco d’attesa si accorcia: un file senza più violazioni va tolto', () => {
    const guariti = [...IN_ATTESA].filter((f) => violazioni(readFileSync(join(RADICE, f), 'utf8')).length === 0)
    expect(guariti, 'file in IN_ATTESA che non hanno più violazioni').toEqual([])
  })

  it('il rilevatore riconosce le quattro forme (e non i commenti)', () => {
    const campione = [
      "const { data } = await supabase.from('x').select('id')",
      "const { data: righe } = await query",
      "  await supabase.from('registro_modifiche').insert({})",
      "await supabase.rpc('f', {}).then(() => {}, () => {})",
      "p.catch(() => {})",
      "// const { data } = await supabase.from('commento')",
      "const { data: b } = await supabase.storage.listBuckets()",
      "const { data, error } = await supabase.from('x').select('id')",
    ].join('\n')
    expect(violazioni(campione).map((v) => v.forma).sort()).toEqual(
      ['catch-muto', 'data-senza-error', 'data-senza-error', 'risultato-buttato', 'risultato-buttato', 'then-muto'].sort(),
    )
  })
})
