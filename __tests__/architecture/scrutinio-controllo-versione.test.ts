import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK · SULLO SCRUTINIO NON VINCE PIÙ L'ULTIMO.
 *
 * Fino al 2026-10-10 `POST`/`PATCH /api/primaria/scrutinio` facevano un upsert
 * cieco e la pagina rimandava tutta la classe: il secondo che salvava riscriveva
 * con i valori vecchi della sua schermata il lavoro dell'altro. Ora:
 *   1. la route salva SOLO con `salva_giudizi_scrutinio` / `salva_comportamento_scrutinio`,
 *      mai con un upsert diretto sulle due tabelle;
 *   2. le funzioni bloccano la riga di `scrutini` PRIMA di confrontare le versioni,
 *      e confrontano `updated_at` PRIMA di scrivere;
 *   3. la pagina manda la versione letta e solo le celle cambiate.
 * SQL e TypeScript letti senza commenti: la prosa nomina le righe vecchie.
 */

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
const ROUTE = join(RADICE, 'src', 'app', 'api', 'primaria', 'scrutinio', 'route.ts')
const PAGINA = join(RADICE, 'src', 'app', '(dashboard)', 'teacher', 'primaria', '[sectionId]', 'scrutinio', 'page.tsx')

function corpoUltimaDefinizione(nome: string): { file: string; corpo: string } {
  const file = readdirSync(MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => new RegExp(`FUNCTION\\s+public\\.${nome}\\s*\\(`, 'i').test(readFileSync(join(MIGRAZIONI, f), 'utf8')))
    .pop()
  if (!file) throw new Error(`nessuna migrazione definisce public.${nome}`)
  const sql = senzaCommenti(readFileSync(join(MIGRAZIONI, file), 'utf8'))
  const inizio = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${nome}\\s*\\(`, 'i'))
  const fine = sql.indexOf('END $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error(`corpo di ${nome} non trovato in ${file}`)
  return { file, corpo: sql.slice(inizio, fine) }
}

function tsSenzaCommenti(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FUNZIONI = [
  { nome: 'salva_giudizi_scrutinio', tabella: 'scrutinio_giudizi', alias: 'g' },
  { nome: 'salva_comportamento_scrutinio', tabella: 'scrutinio_comportamento', alias: 'c' },
] as const

describe('scrutinio · controllo di versione', () => {
  const route = tsSenzaCommenti(readFileSync(ROUTE, 'utf8'))

  it('la route non scrive più da sé sulle due tabelle: niente upsert/insert/update diretti', () => {
    for (const { tabella } of FUNZIONI) {
      const scrittura = new RegExp(`from\\(\\s*['"]${tabella}['"]\\s*\\)[\\s\\S]{0,80}?\\.(upsert|insert|update|delete)\\(`)
      expect(route, `scrittura diretta su ${tabella}`).not.toMatch(scrittura)
    }
  })

  it('la route chiama le due funzioni', () => {
    for (const { nome } of FUNZIONI) {
      expect(route).toMatch(new RegExp(`['"]${nome}['"]`))
    }
    expect(route).toMatch(/\.rpc\(\s*funzione\s*,/)
  })

  for (const { nome, tabella, alias } of FUNZIONI) {
    it(`${nome}: blocca scrutini, POI confronta updated_at, POI scrive`, () => {
      const { corpo } = corpoUltimaDefinizione(nome)
      const blocco = corpo.search(/FROM\s+public\.scrutini\s+WHERE\s+id\s*=\s*p_scrutinio_id\s+FOR\s+UPDATE/i)
      const confronto = corpo.search(new RegExp(`IS\\s+DISTINCT\\s+FROM\\s+${alias}\\.updated_at`, 'i'))
      const conflitto = corpo.search(/'conflitto'/)
      const scrittura = corpo.search(new RegExp(`INSERT\\s+INTO\\s+public\\.${tabella}`, 'i'))
      expect(blocco, 'FOR UPDATE su scrutini').toBeGreaterThan(-1)
      expect(confronto, 'confronto con updated_at').toBeGreaterThan(blocco)
      expect(conflitto, 'uscita «conflitto»').toBeGreaterThan(confronto)
      expect(scrittura, 'la scrittura dopo il confronto').toBeGreaterThan(conflitto)
      // Lo stato chiuso si guarda sotto il blocco, non solo nella route.
      expect(corpo.search(/'chiuso'/)).toBeGreaterThan(blocco)
    })

    it(`${nome}: EXECUTE tolto ad anon e authenticated, dato alla service_role`, () => {
      const { file } = corpoUltimaDefinizione(nome)
      const sql = senzaCommenti(readFileSync(join(MIGRAZIONI, file), 'utf8'))
      expect(sql).toMatch(new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${nome}\\([^)]*\\)\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated`, 'i'))
      expect(sql).toMatch(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${nome}\\([^)]*\\)\\s+TO\\s+service_role`, 'i'))
    })
  }

  it('la pagina manda la versione letta e solo le celle cambiate, e tiene le versioni nuove', () => {
    const pagina = tsSenzaCommenti(readFileSync(PAGINA, 'utf8'))
    expect(pagina).toMatch(/versione:\s*letto\?\.versione\s*\?\?\s*null/)
    expect(pagina).toMatch(/versione:\s*lettiComp\.current\.get\(a\.id\)\?\.versione\s*\?\?\s*null/)
    expect(pagina).toMatch(/v\s*!==\s*\(letto\?\.valore\s*\?\?\s*''\)/)
    expect(pagina).toMatch(/lettiGiudizi\.current\.set\([\s\S]{0,120}versione:\s*x\.updated_at/)
    expect(pagina).toMatch(/lettiComp\.current\.set\([\s\S]{0,160}versione:\s*x\.updated_at/)
  })
})
