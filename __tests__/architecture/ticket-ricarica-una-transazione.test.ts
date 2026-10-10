import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK · LA RICARICA DEI TICKET È UNA TRANSAZIONE SOLA.
 *
 * Fino al 2026-10-10 `POST /api/pagamenti/ticket` faceva quattro scritture
 * separate (saldo, pagamento, incasso, movimento) e la guardia «già ricaricato
 * oggi» leggeva il ledger senza blocco: due click ravvicinati passavano entrambi.
 * Ora tutto sta in `ricarica_ticket_mensa`. Questo file tiene ferme le due metà:
 *   1. la route non scrive più niente da sé e non chiama più `varia_saldo_ticket`;
 *   2. la funzione prende l'advisory lock del bambino PRIMA di leggere il ledger,
 *      e fa saldo, pagamento, incasso e movimento DOPO la guardia.
 * SQL e TypeScript letti senza commenti: la prosa nomina le righe vecchie.
 */

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
const ROUTE = join(RADICE, 'src', 'app', 'api', 'pagamenti', 'ticket', 'route.ts')

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

const SCRITTURA = (t: string) => new RegExp(`from\\(\\s*'${t}'\\s*\\)[\\s\\S]{0,80}\\.(insert|update|upsert|delete)\\(`)

describe('lock · ricarica_ticket_mensa in una transazione, con la guardia dopo il blocco', () => {
  const { file, corpo } = corpoUltimaDefinizione('ricarica_ticket_mensa')

  it('la route chiama la RPC e non scrive saldo, pagamenti, incassi o movimenti', () => {
    const src = tsSenzaCommenti(readFileSync(ROUTE, 'utf8'))
    expect(src).toMatch(/\.rpc\(\s*'ricarica_ticket_mensa'/)
    expect(src, 'la route chiama di nuovo varia_saldo_ticket: il saldo torna fuori dalla transazione').not.toMatch(/varia_saldo_ticket/)
    const tornate = ['ticket_mensa', 'pagamenti', 'incassi', 'mensa_ticket_movimenti'].filter((t) => SCRITTURA(t).test(src))
    expect(tornate, 'scritture tornate fuori dalla transazione').toEqual([])
  })

  it('advisory lock del bambino PRIMA della guardia, e la guardia PRIMA di ogni scrittura', () => {
    const blocco = corpo.search(/pg_advisory_xact_lock\s*\(/i)
    const guardia = corpo.search(/FROM\s+public\.mensa_ticket_movimenti/i)
    const saldo = corpo.search(/public\.varia_saldo_ticket\s*\(/i)
    const primoInsert = corpo.search(/INSERT\s+INTO/i)
    expect(blocco, `${file}: l'advisory lock è sparito — due click passano la guardia insieme`).toBeGreaterThan(-1)
    expect(guardia).toBeGreaterThan(blocco)
    expect(saldo).toBeGreaterThan(guardia)
    expect(primoInsert).toBeGreaterThan(guardia)
  })

  it('le quattro scritture ci sono tutte, nella funzione', () => {
    expect(corpo).toMatch(/public\.varia_saldo_ticket\s*\(/i)
    for (const t of ['pagamenti', 'incassi', 'mensa_ticket_movimenti']) {
      expect(corpo, `${file}: manca l'INSERT in ${t}`).toMatch(new RegExp(`INSERT\\s+INTO\\s+public\\.${t}\\b`, 'i'))
    }
  })

  it('controllo positivo: il riconoscitore vede il codice vecchio', () => {
    const vecchio = tsSenzaCommenti(`await supabase.from('incassi').insert({ pagamento_id: pag.id })`)
    expect(SCRITTURA('incassi').test(vecchio)).toBe(true)
  })
})
