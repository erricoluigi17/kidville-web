import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK · LE QUOTE DI UN PAGAMENTO NON SI CANCELLANO PER REINSERIRLE.
 *
 * Fino al 2026-10-10 `POST/PATCH /api/pagamenti/quote` faceva
 * `delete().eq('pagamento_id', …)` e poi `insert(…)`: ogni quota rinasceva con
 * un id nuovo e la FK `incassi.quota_id … ON DELETE SET NULL` staccava in
 * silenzio gli incassi già registrati. Ora la route chiama
 * `aggiorna_quote_pagamento`, che aggiorna in una transazione con la riga
 * bloccata. Questo file tiene ferme le due metà:
 *   1. la route non scrive `pagamenti_quote` da sé (nessun delete/insert/update);
 *   2. la funzione blocca `pagamenti` con FOR UPDATE prima di toccare le quote,
 *      aggiorna con ON CONFLICT … DO UPDATE e non toglie una quota con incassi.
 *
 * Si legge lo SQL senza commenti e il TypeScript senza commenti: la prosa
 * racconta le righe sbagliate, e un lock che la leggesse sarebbe verde per colpa
 * della spiegazione.
 */

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
const ROUTE = join(RADICE, 'src', 'app', 'api', 'pagamenti', 'quote', 'route.ts')

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

const SCRIVE_QUOTE = /from\(\s*'pagamenti_quote'\s*\)[\s\S]{0,60}\.(delete|insert|update|upsert)\(/

describe('lock · aggiorna_quote_pagamento al posto di cancella-e-reinserisci', () => {
  const { file, corpo } = corpoUltimaDefinizione('aggiorna_quote_pagamento')

  it('la route chiama la RPC e non scrive pagamenti_quote da sé', () => {
    const src = tsSenzaCommenti(readFileSync(ROUTE, 'utf8'))
    expect(src).toMatch(/\.rpc\(\s*'aggiorna_quote_pagamento'/)
    expect(SCRIVE_QUOTE.test(src), 'la route è tornata a scrivere le quote fuori dalla transazione').toBe(false)
  })

  it('la funzione blocca il pagamento prima di toccare le quote', () => {
    const blocco = corpo.search(/FROM\s+public\.pagamenti\s+WHERE\s+id\s*=\s*p_pagamento_id\s+FOR\s+UPDATE/i)
    const primaScrittura = corpo.search(/(DELETE\s+FROM|INSERT\s+INTO)\s+public\.pagamenti_quote/i)
    expect(blocco, `${file}: il FOR UPDATE su pagamenti è sparito`).toBeGreaterThan(-1)
    expect(primaScrittura).toBeGreaterThan(-1)
    expect(blocco).toBeLessThan(primaScrittura)
  })

  it('chi resta si AGGIORNA (ON CONFLICT … DO UPDATE), e la DELETE tocca solo gli assenti', () => {
    expect(corpo).toMatch(/ON\s+CONFLICT\s*\(\s*pagamento_id\s*,\s*adult_id\s*\)\s+DO\s+UPDATE/i)
    const del = /DELETE\s+FROM\s+public\.pagamenti_quote[\s\S]*?;/i.exec(corpo)
    expect(del, 'nessuna DELETE: chi esce non verrebbe più tolto').not.toBeNull()
    expect(del![0], 'la DELETE non filtra più gli adulti che restano').toMatch(/NOT\s*\(\s*q\.adult_id\s*=\s*ANY/i)
  })

  it('una quota con incassi non si toglie: il controllo viene prima della DELETE', () => {
    const controllo = corpo.search(/'quota_con_incassi'/)
    const del = corpo.search(/DELETE\s+FROM\s+public\.pagamenti_quote/i)
    expect(controllo).toBeGreaterThan(-1)
    expect(controllo).toBeLessThan(del)
  })

  it('controllo positivo: il riconoscitore vede il codice vecchio', () => {
    const vecchio = tsSenzaCommenti(`await supabase.from('pagamenti_quote').delete().eq('pagamento_id', pagamento_id)`)
    expect(SCRIVE_QUOTE.test(vecchio)).toBe(true)
  })
})
