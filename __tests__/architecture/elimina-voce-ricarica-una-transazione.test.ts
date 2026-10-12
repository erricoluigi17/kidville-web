import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK · ELIMINARE UNA RICARICA TOGLIE I TICKET NELLA STESSA TRANSAZIONE.
 *
 * Una voce di ricarica cancellata da sola lascia i ticket accreditati (FK del ledger SET NULL):
 * pasti gratis, senza più un debito dietro. Questo file tiene ferme le due metà:
 *   1. la funzione prende il blocco del bambino PRIMA di leggere il saldo, e cancella la voce
 *      DOPO lo storno, nella stessa funzione;
 *   2. la route della voce chiama la RPC e non tocca il saldo né il ledger da sé.
 * SQL e TypeScript letti senza commenti: la prosa nomina le righe che non devono esserci.
 */

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
const ROUTE = join(RADICE, 'src', 'app', 'api', 'pagamenti', '[id]', 'route.ts')

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

/** Le posizioni dei cinque passi, nell'ordine in cui compaiono nel corpo. */
function passi(corpo: string) {
  return {
    blocco: corpo.search(/pg_advisory_xact_lock\s*\(\s*hashtextextended\(\s*'ricarica_ticket_mensa:'/i),
    saldo: corpo.search(/FROM\s+public\.ticket_mensa[\s\S]{0,80}FOR\s+UPDATE/i),
    storno: corpo.search(/public\.varia_saldo_ticket\s*\(/i),
    rettifica: corpo.search(/INSERT\s+INTO\s+public\.mensa_ticket_movimenti/i),
    cancella: corpo.search(/DELETE\s+FROM\s+public\.pagamenti/i),
  }
}

const SCRITTURA_TICKET = /from\(\s*'(ticket_mensa|mensa_ticket_movimenti)'\s*\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/

describe('lock · elimina_voce_ricarica_ticket', () => {
  const { file, corpo } = corpoUltimaDefinizione('elimina_voce_ricarica_ticket')

  it('blocco del bambino prima del saldo, storno prima della DELETE della voce', () => {
    const p = passi(corpo)
    expect(p.blocco, `${file}: manca il blocco delle ricariche — un'eliminazione e una ricarica si incrociano`).toBeGreaterThan(-1)
    expect(p.saldo, `${file}: il saldo va letto FOR UPDATE dopo il blocco`).toBeGreaterThan(p.blocco)
    expect(p.storno).toBeGreaterThan(p.saldo)
    expect(p.rettifica).toBeGreaterThan(p.storno)
    expect(p.cancella, `${file}: la voce va cancellata DOPO lo storno, nella funzione`).toBeGreaterThan(p.rettifica)
  })

  it('la route della voce chiama la RPC e non tocca il saldo né il ledger da sé', () => {
    const src = tsSenzaCommenti(readFileSync(ROUTE, 'utf8'))
    expect(src).toMatch(/\.rpc\(\s*'elimina_voce_ricarica_ticket'/)
    expect(src, 'la route chiama varia_saldo_ticket: lo storno esce dalla transazione').not.toMatch(/varia_saldo_ticket/)
    expect(SCRITTURA_TICKET.test(src), 'la route scrive su ticket_mensa o sul ledger fuori dalla transazione').toBe(false)
  })

  it('controllo positivo: i riconoscitori vedono una cancellazione fuori posto e una scrittura del ledger', () => {
    const rotto = `PERFORM pg_advisory_xact_lock(hashtextextended('ricarica_ticket_mensa:' || x, 0));
      DELETE FROM public.pagamenti WHERE id = p;
      SELECT 1 FROM public.ticket_mensa WHERE a = b FOR UPDATE;
      v := public.varia_saldo_ticket(a, -1);
      INSERT INTO public.mensa_ticket_movimenti VALUES (1);`
    const p = passi(rotto)
    expect(p.cancella).toBeGreaterThan(-1)
    expect(p.cancella).toBeLessThan(p.rettifica)
    expect(SCRITTURA_TICKET.test(`await supabase.from('mensa_ticket_movimenti').insert({ delta: -1 })`)).toBe(true)
  })
})
