import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, riga } from '../fixtures/sorgente'
import { RIGHE_MASSIME_POSTGREST } from '@/lib/db/blocchi'

/**
 * LE LETTURE CHE NON SI TRONCANO RESTANO TALI (robustezza 2, sessione 11).
 *
 * PostgREST taglia ogni risposta a `max_rows` (1000) senza un errore. La sessione 11 ha portato a
 * blocchi le letture che crescono senza un tetto naturale in cinque file: elenco genitori,
 * cruscotto presenze, controllo del testo di classe, bacheca dei promemoria, archivio avvisi dello
 * staff. Questo lock impedisce che tornino nude. Per ogni file e ogni tabella sorvegliata dichiara
 * QUANTE letture ci sono e in quale FORMA; e un `.limit(N)` sopra `max_rows` non passa.
 *
 * Le forme:
 *  · `a-blocchi`: la `.from()` sta dentro gli argomenti di una chiamata a `leggiABlocchi`;
 *  · `per-id`: `.in('id', blocco)`, cioè un blocco di `ID_PER_QUERY` chiavi primarie (≤ 100 righe);
 *  · `una-riga`: `.single()` / `.maybeSingle()`;
 *  · `altro`: tutto il resto, e ognuna ha la sua ragione scritta accanto al censimento.
 * Le scritture (`insert`, `update`, `upsert`, `delete`) non si contano.
 *
 * Una lettura nuova in questi file fa rosso finché qualcuno non sceglie la sua forma e la dichiara
 * qui: è il punto. Il sorgente si legge con la maschera di `sorgente.ts`, quindi una `.from(…)`,
 * un `.limit(…)` o un `import` dentro un commento non contano, e una parentesi dentro una stringa
 * non sbilancia niente. I metodi della catena (scrittura, una riga, per id) si guardano solo al
 * livello più esterno: un `.delete(` dentro un argomento non trasforma una lettura in scrittura.
 */

type Forma = 'a-blocchi' | 'per-id' | 'una-riga' | 'altro'
type Censimento = Record<string, Partial<Record<Forma, number>>>

interface Lettura {
  tabella: string
  riga: number
  forma: Forma
}

const CENSIMENTO: Record<string, Censimento> = {
  'src/app/api/admin/parents/route.ts': {
    alunni: { 'a-blocchi': 1 },
    student_parents: { 'a-blocchi': 1 },
    // per-id: i genitori di un blocco di `ID_PER_QUERY` id. una-riga: il PATCH legge il genitore
    // prima di scriverlo. altro: il ramo `?student_id=`, i genitori di UN alunno.
    parents: { 'per-id': 1, 'una-riga': 1, altro: 1 },
  },
  'src/app/api/admin/presenze/realtime/route.ts': {
    alunni: { 'a-blocchi': 1 },
    presenze: { 'a-blocchi': 1 },
    // Le sezioni e le sedi dei plessi dello staff: decine di righe (Passo 0.8 del piano).
    sections: { altro: 1 },
    schools: { altro: 1 },
  },
  'src/lib/health/controlli.ts': {
    alunni: { 'a-blocchi': 1 },
    sections: { 'a-blocchi': 1 },
  },
  'src/app/api/tasks/route.ts': {
    task_interni: { 'a-blocchi': 1 },
  },
  'src/app/api/avvisi/route.ts': {
    // altro: il feed del genitore, che legge solo gli avvisi non scaduti delle sedi dei figli.
    avvisi: { 'a-blocchi': 1, altro: 1 },
  },
}

/** Ancore del censimento: si cambiano solo insieme alle voci qui sopra, mai per farlo tornare verde. */
const FILE_SORVEGLIATI = 5
const LETTURE_A_BLOCCHI = 8
const LETTURE_SORVEGLIATE = 14

const MODULO = '@/lib/db/leggi-a-blocchi'

// Apici singoli, doppi o inversi: una lettura scritta con `"task_interni"` non deve sfuggire.
const DA_TABELLA = /\.from\(\s*(['"`])([a-z_]+)\1\s*\)/g
const CHIAMATA_A_BLOCCHI = /\bleggiABlocchi\s*(?:<[^()]*?>)?\s*\(/g
const SCRITTURE = new Set(['insert', 'update', 'upsert', 'delete'])
const UNA_RIGA = new Set(['single', 'maybeSingle'])
const PER_ID = /^\(\s*(['"])id\1\s*,\s*blocco\s*\)$/
const LIMITE = /\.limit\(\s*([\d_]+|[A-Za-z_$][\w$]*)\s*\)/g
const IMPORT = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g

interface Chiamata {
  metodo: string
  /** Gli argomenti con le parentesi, sul testo senza commenti (le stringhe restano leggibili). */
  argomenti: string
}

/**
 * Le chiamate della catena che comincia in `da` (il `.` di `.from(`), solo al livello più esterno.
 * Stessa camminata di `fineCatena` di `sorgente.ts`, ma tiene il nome di ogni metodo.
 */
function chiamateCatena(struttura: string, senzaCommenti: string, da: number): Chiamata[] {
  const out: Chiamata[] = []
  let i = da
  for (;;) {
    if (struttura[i] !== '.') return out
    let j = i + 1
    while (j < struttura.length && /\s/.test(struttura[j])) j++
    const inizioId = j
    while (j < struttura.length && /[A-Za-z0-9_$]/.test(struttura[j])) j++
    if (j === inizioId) return out
    const metodo = struttura.slice(inizioId, j)
    while (j < struttura.length && /\s/.test(struttura[j])) j++
    if (struttura[j] !== '(') return out
    const chiusa = fineParentesi(struttura, j)
    out.push({ metodo, argomenti: senzaCommenti.slice(j, chiusa) })
    j = chiusa
    while (j < struttura.length && /\s/.test(struttura[j])) j++
    i = j
  }
}

/** Le letture di un sorgente, ciascuna con la sua forma. */
function letture(src: string): Lettura[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  // Gli intervalli degli ARGOMENTI di ogni chiamata a `leggiABlocchi`, sul testo `struttura`
  // (commenti spenti, stringhe ridotte a `x`: un `leggiABlocchi(` scritto in una stringa non vale).
  const argomenti: [number, number][] = []
  for (const m of struttura.matchAll(CHIAMATA_A_BLOCCHI)) {
    const apertura = m.index + m[0].length - 1
    argomenti.push([apertura, fineParentesi(struttura, apertura)])
  }
  const out: Lettura[] = []
  for (const m of senzaCommenti.matchAll(DA_TABELLA)) {
    const inizio = m.index
    // Una `.from('…')` dentro una stringa: in `struttura` lì ci sono solo `x`.
    if (!struttura.startsWith('.from', inizio)) continue
    const catena = chiamateCatena(struttura, senzaCommenti, inizio)
    if (catena.some((c) => SCRITTURE.has(c.metodo))) continue
    const forma: Forma = argomenti.some(([a, b]) => inizio > a && inizio < b)
      ? 'a-blocchi'
      : catena.some((c) => UNA_RIGA.has(c.metodo))
        ? 'una-riga'
        : catena.some((c) => c.metodo === 'in' && PER_ID.test(c.argomenti))
          ? 'per-id'
          : 'altro'
    out.push({ tabella: m[2], riga: riga(src, inizio), forma })
  }
  return out
}

function censisci(ls: Lettura[]): Censimento {
  const out: Censimento = {}
  for (const l of ls) {
    const t = out[l.tabella] ?? {}
    t[l.forma] = (t[l.forma] ?? 0) + 1
    out[l.tabella] = t
  }
  return out
}

/**
 * Ogni `.limit(N)` del codice sopra `max_rows`, con la riga. Si legge su `struttura`: niente
 * commenti, niente stringhe. Un nome (`.limit(LIMITE)`) si risolve sulla sua `const` numerica
 * nello stesso file; un nome che non si risolve (importato, calcolato) non si giudica.
 */
function limitiOltre(src: string): string[] {
  const { struttura } = mascheraSorgente(src)
  const valore = (grezzo: string): number | null => {
    if (/^[\d_]+$/.test(grezzo)) return Number(grezzo.replace(/_/g, ''))
    const def = new RegExp(`\\bconst\\s+${grezzo.replace(/\$/g, '\\$')}\\s*(?::\\s*number\\s*)?=\\s*([\\d_]+)\\b`)
    const d = def.exec(struttura)
    return d ? Number(d[1].replace(/_/g, '')) : null
  }
  return [...struttura.matchAll(LIMITE)]
    .filter((m) => (valore(m[1]) ?? 0) > RIGHE_MASSIME_POSTGREST)
    .map((m) => `riga ${riga(src, m.index)}: ${m[0]}`)
}

/** Da quali moduli il sorgente importa `leggiABlocchi` (solo `import` veri: né commenti né stringhe). */
function originiDiLeggiABlocchi(src: string): string[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  return [...senzaCommenti.matchAll(IMPORT)]
    .filter((m) => struttura.startsWith('import', m.index) && /\bleggiABlocchi\b/.test(m[1]))
    .map((m) => m[3])
}

const leggi = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

describe('letture a blocchi — i file della sessione 11 non tornano a leggere «le prime 1000»', () => {
  for (const [file, atteso] of Object.entries(CENSIMENTO)) {
    describe(file, () => {
      it('ogni lettura delle tabelle sorvegliate ha la forma dichiarata, né più né meno', () => {
        const trovate = letture(leggi(file)).filter((l) => Object.hasOwn(atteso, l.tabella))
        const elenco = trovate.map((l) => `${l.tabella}: ${l.forma} (riga ${l.riga})`).join('\n')
        expect(censisci(trovate), `letture trovate in ${file}:\n${elenco}`).toEqual(atteso)
      })

      it('nessun `.limit(N)` sopra `max_rows`: PostgREST lo ignora e taglia in silenzio', () => {
        expect(limitiOltre(leggi(file))).toEqual([])
      })

      it('`leggiABlocchi` viene da `@/lib/db/leggi-a-blocchi`, e da nessun altro modulo', () => {
        expect(originiDiLeggiABlocchi(leggi(file))).toEqual([MODULO])
      })
    })
  }
})

describe('il lock non è cieco', () => {
  it('legge davvero i cinque file, e ci trova tutte le letture dichiarate', () => {
    expect(Object.keys(CENSIMENTO)).toHaveLength(FILE_SORVEGLIATI)
    let aBlocchiTrovate = 0
    let aBlocchiAttese = 0
    let sorvegliateTrovate = 0
    let sorvegliateAttese = 0
    for (const [file, atteso] of Object.entries(CENSIMENTO)) {
      expect(fs.existsSync(path.join(process.cwd(), file)), file).toBe(true)
      const trovate = letture(leggi(file)).filter((l) => Object.hasOwn(atteso, l.tabella))
      sorvegliateTrovate += trovate.length
      aBlocchiTrovate += trovate.filter((l) => l.forma === 'a-blocchi').length
      for (const forme of Object.values(atteso)) {
        for (const [forma, n] of Object.entries(forme)) {
          sorvegliateAttese += n
          if (forma === 'a-blocchi') aBlocchiAttese += n
        }
      }
    }
    expect(aBlocchiAttese).toBe(LETTURE_A_BLOCCHI)
    expect(aBlocchiTrovate).toBe(aBlocchiAttese)
    expect(sorvegliateAttese).toBe(LETTURE_SORVEGLIATE)
    expect(sorvegliateTrovate).toBe(sorvegliateAttese)
  })

  it('la soglia è `max_rows` di `supabase/config.toml`, non un numero comodo', () => {
    const config = fs.readFileSync(path.join(process.cwd(), 'supabase/config.toml'), 'utf8')
    const m = /^\s*max_rows\s*=\s*(\d+)\s*$/m.exec(config)
    expect(m, 'max_rows in supabase/config.toml').not.toBeNull()
    expect(RIGHE_MASSIME_POSTGREST).toBe(Number(m![1]))
  })

  it('distingue le forme su un sorgente scritto apposta, e ignora commenti, stringhe e scritture', () => {
    const src = [
      "import { leggiABlocchi } from '@/lib/db/leggi-a-blocchi'",
      "const a = await leggiABlocchi<{ id: string }>(() => supabase.from('alunni').select('id').in('scuola_id', p))",
      "const b = await supabase.from('alunni').select('id').in('scuola_id', p)",
      "const c = await supabase.from('alunni').select('id').eq('id', x).maybeSingle()",
      "for (const blocco of aBlocchi(ids, ID_PER_QUERY)) await supabase.from('parents').select('id').in('id', blocco)",
      "await supabase.from('alunni').update({ stato: 'x' }).eq('id', x)",
      "// leggiABlocchi(() => supabase.from('alunni').select('id')) dentro un commento non conta",
      'const d = await supabase.from("alunni").select("id")',
      "const e = await supabase.from('alunni').select('id').in('id', ids.filter((i) => !visti.delete(i)))",
      "const f = \"leggiABlocchi(() => supabase.from('alunni'))\"",
      "/* const g = await leggiABlocchi(() => supabase.from('alunni').select('id')) */",
      "const h = await /* leggiABlocchi( */ supabase.from('alunni').select('id') /* ) */",
    ].join('\n')
    expect(letture(src).map((l) => `${l.tabella}:${l.forma}`)).toEqual([
      'alunni:a-blocchi',
      'alunni:altro',
      'alunni:una-riga',
      'parents:per-id',
      'alunni:altro',
      'alunni:altro',
      'alunni:altro',
    ])
  })

  it('vede un `.limit(N)` oltre il tetto anche dietro una costante, non dentro commenti o stringhe', () => {
    const src = [
      'const LIMITE = 5_000',
      "const a = supabase.from('x').select('id').limit(2000)",
      "const b = supabase.from('x').select('id').limit(LIMITE)",
      "const c = supabase.from('x').select('id').limit(1000)",
      "const d = supabase.from('x').select('id').limit(DA_FUORI)",
      "// const e = supabase.from('x').select('id').limit(9000)",
      "const f = '.limit(7000)'",
    ].join('\n')
    expect(limitiOltre(src)).toEqual(['riga 2: .limit(2000)', 'riga 3: .limit(LIMITE)'])
  })

  it('un import da un altro modulo non si salva con un import «giusto» scritto in un commento', () => {
    const src = [
      "// import { leggiABlocchi } from '@/lib/db/leggi-a-blocchi'",
      "const s = \"import { leggiABlocchi } from '@/lib/db/leggi-a-blocchi'\"",
      "import { descriviTetto, leggiABlocchi, type EsitoABlocchi } from '@/lib/pagamenti/leggi-a-blocchi'",
    ].join('\n')
    expect(originiDiLeggiABlocchi(src)).toEqual(['@/lib/pagamenti/leggi-a-blocchi'])
    expect(originiDiLeggiABlocchi("import { type EsitoABlocchi } from '@/lib/db/leggi-a-blocchi'")).toEqual([])
  })
})
