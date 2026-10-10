import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK · REPORT DI CASSA E CRUSCOTTO NON SOMMANO RIGHE TAGLIATE.
 *
 * PostgREST taglia ogni risposta a `max_rows` (1000) senza dirlo. Fino al 2026-10-10
 * il report di cassa sommava in JavaScript le righe di `incassi` (1.672 nelle sedi il
 * 10/10) e il cruscotto contava iscritti e scaduti con la LUNGHEZZA di un elenco.
 * Questo file tiene ferme le due correzioni:
 *   1. il report non legge più righe di incassi né di movimenti: chiama
 *      `report_cassa_aggregato` e verifica i totali contro il suo SUM piatto;
 *   2. la funzione restituisce il `controllo` e la usa solo la `service_role`;
 *   3. il cruscotto conta col database (`count: 'exact'`, in GET e non in HEAD) e controlla ogni `error`.
 * Sorgenti letti senza commenti: la prosa nomina le forme vecchie.
 */

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
const REPORT = join(RADICE, 'src', 'app', 'api', 'pagamenti', 'cassa', 'report', 'route.ts')
const CRUSCOTTO = join(RADICE, 'src', 'app', 'api', 'admin', 'dashboard', 'route.ts')

function tsSenzaCommenti(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function ultimaDefinizione(nome: string): string {
  const file = readdirSync(MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => new RegExp(`FUNCTION\\s+public\\.${nome}\\s*\\(`, 'i').test(readFileSync(join(MIGRAZIONI, f), 'utf8')))
    .pop()
  if (!file) throw new Error(`nessuna migrazione definisce public.${nome}`)
  return senzaCommenti(readFileSync(join(MIGRAZIONI, file), 'utf8'))
}

describe('report di cassa · aggregato in SQL', () => {
  const route = tsSenzaCommenti(readFileSync(REPORT, 'utf8'))

  it('non legge più le righe di incassi né di cassa_movimenti', () => {
    expect(route).not.toMatch(/from\(\s*['"]incassi['"]\s*\)/)
    expect(route).not.toMatch(/from\(\s*['"]cassa_movimenti['"]\s*\)/)
  })

  it('chiama report_cassa_aggregato e non risponde senza aver verificato i totali', () => {
    const chiamata = route.search(/\.rpc\(\s*['"]report_cassa_aggregato['"]/)
    const verifica = route.search(/differenzeTotali\(/)
    const csv = route.search(/costruisciCsvReport\(/)
    const json = route.search(/disponibile:\s*true/)
    expect(chiamata).toBeGreaterThan(-1)
    expect(verifica).toBeGreaterThan(chiamata)
    expect(csv).toBeGreaterThan(verifica)
    expect(json).toBeGreaterThan(verifica)
  })

  it('la funzione restituisce il controllo a SUM piatto, ed è solo della service_role', () => {
    const sql = ultimaDefinizione('report_cassa_aggregato')
    expect(sql).toMatch(/'controllo'\s*,\s*jsonb_build_object\(/i)
    expect(sql).toMatch(/GROUPING\s+SETS/i)
    expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.report_cassa_aggregato\([^)]*\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i)
    expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.report_cassa_aggregato\([^)]*\)\s+TO\s+service_role/i)
  })
})

describe('cruscotto · conteggi del database', () => {
  const route = tsSenzaCommenti(readFileSync(CRUSCOTTO, 'utf8'))

  it('iscritti e scaduti non sono la lunghezza di un elenco', () => {
    expect(route).not.toMatch(/iscritti:\s*\w+\.length/)
    expect(route).not.toMatch(/scadutoCount:\s*\w+\.length/)
    expect(route).toMatch(/from\('alunni'\)\s*\.select\('id',\s*\{\s*count:\s*'exact'\s*\}\)\.limit\(1\)/)
    expect(route).toMatch(/scadutoCount:\s*scadutiRes\.count/)
  })

  it('nessun conteggio con head: true — una HEAD fallita torna SENZA codice, e «schema assente» diventa un guasto', () => {
    // Visto il 2026-10-10 sull'E2E della CI (DB non migrato): `{ message: '' }` al posto di 42703,
    // quindi 500 DASHBOARD_NON_LETTA invece dello zero col suo log.
    expect(route).not.toMatch(/head:\s*true/)
  })

  it('la distribuzione per classe si legge tutta, a blocchi', () => {
    expect(route).toMatch(/leggiABlocchi<[^>]*>\(\(\)\s*=>\s*\n?\s*supabase\.from\('alunni'\)/)
  })

  it('ogni lettura con `{ error }` passa dal controllo: i nove risultati sono tutti elencati', () => {
    for (const nome of ['iscrittiRes', 'scadutiRes', 'scadutiListRes', 'fattureRes', 'iscrizioniRes', 'iscrizioniListRes', 'mensaOggiRes', 'moduliTotRes', 'moduliPendingRes']) {
      expect(route, nome).toMatch(new RegExp(`\\[\\s*'[^']+'\\s*,\\s*${nome}\\s*\\]`))
    }
    expect(route).toMatch(/if\s*\(\s*!perClasseRes\.ok\s*\)/)
    expect(route).toMatch(/codice:\s*'DASHBOARD_NON_LETTA'/)
  })
})
