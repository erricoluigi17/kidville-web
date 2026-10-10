import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK · L'INCASSO DI UNA VOCE SI DECIDE CON LA RIGA BLOCCATA.
 *
 * Fino al 2026-10-10 `POST /api/pagamenti/incassi` leggeva il residuo, decideva in
 * JavaScript e poi inseriva l'incasso: due operatori sulla stessa voce passavano
 * entrambi il controllo e la voce risultava incassata oltre il dovuto. Provato con
 * due sessioni vere su Postgres 17: 2 incassi da 100 € su una voce da 100 €.
 *
 * La correzione ha due metà, e questo file le tiene ferme tutte e due:
 *   1. la funzione `registra_incasso_voce` blocca `pagamenti` con `FOR UPDATE`
 *      PRIMA di calcolare il residuo (un blocco preso dopo non protegge niente);
 *   2. la route non scrive più `incassi` da sé: se tornasse un `.insert` diretto,
 *      il controllo del residuo tornerebbe fuori dalla transazione.
 *
 * Si legge lo SQL senza commenti: la prosa della migrazione racconta la riga
 * sbagliata, e un lock che la cercasse nel testo grezzo sarebbe verde per colpa
 * della spiegazione.
 */

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
const ROUTE = join(RADICE, 'src', 'app', 'api', 'pagamenti', 'incassi', 'route.ts')

/** L'ultima migrazione che (ri)definisce la funzione: è quella che vive in produzione. */
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

/** Codice TypeScript senza commenti di riga e di blocco (basta per un grep di chiamate). */
function tsSenzaCommenti(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('lock · registra_incasso_voce decide il residuo con la riga bloccata', () => {
  const { file, corpo } = corpoUltimaDefinizione('registra_incasso_voce')

  it('blocca la riga di pagamenti con FOR UPDATE', () => {
    expect(
      /FROM\s+public\.pagamenti\s+WHERE\s+id\s*=\s*p_pagamento_id\s+FOR\s+UPDATE/i.test(corpo),
      `${file}: la SELECT su pagamenti ha perso il FOR UPDATE — due operatori tornano a incassare oltre il dovuto.`,
    ).toBe(true)
  })

  it('il blocco viene PRIMA del calcolo del residuo e prima di ogni INSERT', () => {
    const blocco = corpo.search(/FOR\s+UPDATE/i)
    const residuo = corpo.search(/v_residuo\s*:=/i)
    const primoInsert = corpo.search(/INSERT\s+INTO/i)
    expect(blocco).toBeGreaterThan(-1)
    expect(residuo, 'il residuo non è più calcolato nella funzione').toBeGreaterThan(-1)
    expect(blocco, `${file}: il residuo si legge prima del blocco`).toBeLessThan(residuo)
    expect(blocco, `${file}: si scrive prima del blocco`).toBeLessThan(primoInsert)
  })

  it('l\'eccedenza senza conferma esce senza scrivere', () => {
    const ramo = /IF\s+p_eccedenza_parent_id\s+IS\s+NULL\s+THEN([\s\S]*?)END\s+IF/i.exec(corpo)
    expect(ramo, 'il ramo «eccedenza senza conferma» è sparito').not.toBeNull()
    expect(ramo![1]).toMatch(/RETURN\s+jsonb_build_object\(\s*'esito'\s*,\s*'eccedenza'/i)
    expect(ramo![1]).not.toMatch(/INSERT|UPDATE/i)
  })

  it('la route chiama la RPC e non scrive incassi, crediti o sconti da sé', () => {
    const src = tsSenzaCommenti(readFileSync(ROUTE, 'utf8'))
    expect(src).toMatch(/\.rpc\(\s*'registra_incasso_voce'/)
    const scritture = [
      /from\(\s*'incassi'\s*\)[\s\S]{0,40}\.(insert|update|upsert)\(/,
      /from\(\s*'crediti_famiglia'\s*\)[\s\S]{0,40}\.(insert|update|upsert)\(/,
      /from\(\s*'pagamenti'\s*\)[\s\S]{0,40}\.(insert|update|upsert)\(/,
      /accreditaEccedenza\(/,
    ].filter((re) => re.test(src))
    expect(scritture.map(String), 'una scrittura è tornata fuori dalla transazione').toEqual([])
  })

  it('controllo positivo: il lock riconosce una route che inserisce da sé', () => {
    const finta = tsSenzaCommenti(`await supabase\n  .from('incassi')\n  .insert({ pagamento_id })`)
    expect(/from\(\s*'incassi'\s*\)[\s\S]{0,40}\.(insert|update|upsert)\(/.test(finta)).toBe(true)
  })
})
