import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * LOCK · OGNI `{ error }` DI POSTGREST, IN TUTTO `src/`, SI GUARDA.
 * (Fase 11 della roadmap di robustezza, «errori non ignorati» — 2026-10-19.)
 *
 * È il lock della fase 5 (`pagamenti-errori-controllati.test.ts`) esteso a tutto il codice. La
 * ricognizione del 19/10 contava, fuori dai pagamenti, 208 letture col solo `data`, 57 scritture
 * col risultato buttato e 62 `.then`/`.catch` muti, in 156 file. PostgREST non lancia: il `null`
 * di un guasto diventava un elenco vuoto, un «non trovato», una scrittura data per fatta.
 *
 * Cinque forme vietate:
 *   1. `const { data } = await …`, `const { data: x } = await …`, `const { count } = await …`
 *      (anche `let`, anche `{ data, count }`) — il risultato senza `error`;
 *   2. `await <client>.from(…)…` / `await <client>.rpc(…)` come istruzione — il risultato buttato;
 *   3. `.then(() => {}, () => {})` e `.then(() => undefined, () => undefined)` — l'errore inghiottito;
 *   4. `.catch(() => {})` — idem.
 *   5. `const { data } = await <client>.storage…` — lo Storage col solo `data` (sessione 13 della seconda serie:
 *      il 20/10 erano 8, due URL firmati e sei `listBuckets()`). Lo Storage non è PostgREST, ma non lancia
 *      nemmeno lui: risponde `{ data: null, error }`.
 *
 * Come si ripara: `src/lib/db/guasto.ts` (`rispostaGuastoDb`, `guastoSecondario`,
 * `guastoLetturaAccessoria`), o nei componenti la gestione già usata dalla pagina. Un errore
 * davvero ignorabile si destruttura comunque e si logga a livello `info` dicendo perché (regola 6
 * di AGENTS.md).
 *
 * Sorgenti letti SENZA commenti: la prosa nomina le forme vecchie (anche questo file).
 *
 * FUORI, e perché:
 *   · `src/lib/logging/**` — il logger è fail-open per regola (AGENTS.md, regola 9): lì un
 *     `.catch(() => {})` è la difesa, non il difetto;
 *   · il risultato BUTTATO di una chiamata dello Storage (`await s.storage.createBucket(…)` come istruzione): la
 *     forma 2 guarda solo `from`/`rpc`. Lo Storage col solo `data` è invece la forma 5.
 */

const RADICE = process.cwd()
const SRC = join(RADICE, 'src')
const ESCLUSI = ['src/lib/logging/']

/**
 * ⏳ In attesa: vuoto. Il meccanismo della fase 5, per la prossima volta che una riscrittura in
 * corso altrove costringe ad aspettare: un file entra con la ragione accanto, ed esce appena non
 * ha più violazioni (test sotto).
 */
const IN_ATTESA = new Map<string, string>([])

const FORME: Array<{ nome: string; re: RegExp }> = [
  {
    nome: 'data-senza-error',
    re: /(?:const|let)\s*\{\s*(?:data|count)(?:\s*:\s*\w+)?(?:\s*,\s*(?:data|count)(?:\s*:\s*\w+)?)?\s*\}\s*=\s*await\s+(?!\w+\s*\.\s*storage\b)/g,
  },
  { nome: 'risultato-buttato', re: /^\s*await\s+\w+\s*\.\s*(?:from|rpc)\s*\(/gm },
  {
    nome: 'then-muto',
    re: /\.then\(\s*\(\)\s*=>\s*(?:\{\s*\}|undefined)\s*,\s*\(\)\s*=>\s*(?:\{\s*\}|undefined)\s*\)/g,
  },
  { nome: 'catch-muto', re: /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/g },
  {
    nome: 'storage-senza-error',
    re: /(?:const|let)\s*\{\s*(?:data|count)(?:\s*:\s*\w+)?(?:\s*,\s*(?:data|count)(?:\s*:\s*\w+)?)?\s*\}\s*=\s*await\s+\w+\s*\.\s*storage\b/g,
  },
]

function senzaCommenti(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function fileSorgente(dir: string): string[] {
  const out: string[] = []
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) out.push(...fileSorgente(p))
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
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

const FILE = fileSorgente(SRC)
  .map((f) => relative(RADICE, f))
  .filter((f) => !ESCLUSI.some((e) => f.startsWith(e)))
  .sort()

describe('lock — ogni { error } di PostgREST si guarda, in tutto src/', () => {
  it('il lock legge davvero il codice (non è verde scansionando zero file)', () => {
    // Un lock che non trova i suoi file è verde per sempre: misurato il 19/10, sono più di 1.500.
    expect(FILE.length).toBeGreaterThan(1000)
    expect(FILE.some((f) => f.startsWith('src/app/api/'))).toBe(true)
    expect(FILE.some((f) => f.endsWith('.tsx'))).toBe(true)
  })

  it('riconosce ognuna delle cinque forme, e lascia passare quelle corrette', () => {
    const rotto = [
      "const { data } = await supabase.from('alunni').select('id')",
      "const { data: righe } = await admin.from('x').select('id')",
      "const { count } = await s.from('x').select('id', { count: 'exact', head: true })",
      "let { data } = await db.rpc('f')",
      "  await supabase.from('x').update({ a: 1 }).eq('id', id)",
      "  await admin.rpc('f', {})",
      'p.then(() => {}, () => {})',
      'p.then(() => undefined, () => undefined)',
      'p.catch(() => {})',
      "const { data } = await supabase.storage.from('b').download('p')",
    ].join('\n')
    expect(violazioni(rotto).map((v) => v.forma)).toEqual([
      'data-senza-error',
      'data-senza-error',
      'data-senza-error',
      'data-senza-error',
      'risultato-buttato',
      'risultato-buttato',
      'then-muto',
      'then-muto',
      'catch-muto',
      'storage-senza-error',
    ])
    const giusto = [
      "const { data, error } = await supabase.from('alunni').select('id')",
      "const { data, error } = await supabase.storage.from('b').download('p')",
      "const { data: buckets, error: erroreElenco } = await supabase.storage.listBuckets()",
      "const { error } = await supabase.from('x').update({ a: 1 })",
      "// const { data } = await supabase.from('x') — un commento non conta",
      "p.catch((err) => logErrore({ operazione: 'x' }, err))",
    ].join('\n')
    expect(violazioni(giusto)).toEqual([])
  })

  it('nessun file ha un risultato di PostgREST senza `error`, buttato o inghiottito', () => {
    const trovate: string[] = []
    for (const f of FILE) {
      if (IN_ATTESA.has(f)) continue
      for (const v of violazioni(readFileSync(join(RADICE, f), 'utf8'))) trovate.push(`${f}:${v.riga} ${v.forma}`)
    }
    expect(
      trovate,
      'Un risultato di PostgREST va guardato: `const { data, error }` e poi `rispostaGuastoDb` / `guastoSecondario` / `guastoLetturaAccessoria` (src/lib/db/guasto.ts), o un log `info` che dice perché si può ignorare.',
    ).toEqual([])
  })

  it('un file in attesa esce dall’elenco appena è pulito, ed esiste davvero', () => {
    for (const [f] of IN_ATTESA) {
      expect(FILE, `${f} non esiste più: va tolto da IN_ATTESA`).toContain(f)
      expect(violazioni(readFileSync(join(RADICE, f), 'utf8')), `${f} è già pulito: va tolto da IN_ATTESA`).not.toEqual([])
    }
  })
})
