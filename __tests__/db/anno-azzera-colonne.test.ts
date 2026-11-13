import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { type BancoPassaggio } from '../helpers/passaggio-banco'
import { creaBancoAzzera } from '../helpers/banco-azzera'

/**
 * OGNI COLONNA CHE LO SCRIPT DI AZZERAMENTO NOMINA ESISTE DAVVERO IN PRODUZIONE (e nel banco di prova).
 *
 * Perché esiste (B1 della revisione del 13/11/2026): `azzera-anno-nuovo-demo.sql` nominava `pagamenti.fattura_id`. La colonna c'era nel
 * banco PGlite (scritta a mano in `schema-anno-pglite.ts`) e non in produzione: tutti i test erano verdi, e in produzione lo script
 * falliva a ogni esecuzione con `42703`. Un banco di prova che differisce dalla produzione è verde per ragioni sbagliate.
 *
 * Come funziona: dal testo dello script (senza commenti né stringhe) si ricava, per ogni ALIAS di tabella (`FROM public.pagamenti g`,
 * `jsonb_populate_recordset(NULL::public.listino_voci, …) r`), la tabella a cui punta; poi ogni `alias.colonna` e ogni colonna a sinistra
 * di un `SET` si confronta con `__tests__/fixtures/colonne-azzera-snapshot.json`, la fotografia delle colonne PRESA DALLA PRODUZIONE
 * (si rigenera con `colonne-azzera-fotografia.mjs`). Un alias usato per più tabelle passa se la colonna c'è in almeno una di esse.
 * In più il banco non deve avere colonne che la produzione non ha, nelle tabelle che lo script nomina.
 */

const DIR = path.resolve(__dirname, '../../docs/superpowers/simulazione')
const SNAPSHOT = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/colonne-azzera-snapshot.json'), 'utf8')) as {
  colonne: Record<string, string[]>
}

/** Lo script senza commenti `--` e senza il contenuto delle stringhe '…' (dentro ci sono messaggi e SQL dinamico, non colonne). */
function nudo(sql: string): string {
  return sql
    // la funzione d'appoggio legge il CATALOGO (pg_attribute…): i suoi alias non sono tabelle di `public`
    .replace(/CREATE FUNCTION pg_temp\.azzera_blocca[\s\S]*?\$blocca\$;/, '')
    .split('\n').map((riga) => riga.replace(/--.*$/, '')).join('\n')
    .replace(/'(?:[^']|'')*'/g, "''")
}

const PAROLE = new Set(['where', 'set', 'join', 'on', 'select', 'values', 'as', 'left', 'right', 'inner', 'cross', 'using', 'group', 'order', 'limit', 'from', 'and', 'or', 'not', 'in', 'is', 'default'])

/** alias → tabelle a cui punta (nello script lo stesso alias può servire più istruzioni). */
function alias(sql: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  const aggiungi = (a: string, t: string) => { if (!m.has(a)) m.set(a, new Set()); m.get(a)!.add(t) }
  for (const r of sql.matchAll(/\b(?:from|join|update|into)\s+public\.([a-z_0-9]+)\s+(?:as\s+)?([a-z_][a-z_0-9]*)/gi)) {
    if (!PAROLE.has(r[2].toLowerCase())) aggiungi(r[2], r[1])
  }
  for (const r of sql.matchAll(/jsonb_populate_recordset\(\s*NULL::public\.([a-z_0-9]+)\s*,[^)]*\)\s+([a-z_][a-z_0-9]*)/gi)) aggiungi(r[2], r[1])
  return m
}

/** Tutte le tabelle `public.X` che lo script nomina (con o senza alias). */
function tabelleNominate(sql: string): Set<string> {
  return new Set([...sql.matchAll(/\bpublic\.([a-z_][a-z_0-9]*)/gi)].map((r) => r[1]))
}

/** `jsonb_to_recordset(…) AS x(id uuid, stato text, …)`: le colonne di quell'alias le dichiara l'istruzione stessa. */
function colonneDichiarate(sql: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>()
  for (const r of sql.matchAll(/\bAS\s+([a-z_][a-z_0-9]*)\s*\(([^)]*)\)/gi)) {
    if (!m.has(r[1])) m.set(r[1], new Set())
    for (const c of r[2].split(',')) m.get(r[1])!.add(c.trim().split(/\s+/)[0])
  }
  return m
}

interface Uso { alias: string; colonna: string }
function usi(sql: string, conAlias: Map<string, Set<string>>): Uso[] {
  const out: Uso[] = []
  for (const r of sql.matchAll(/(?<![\w.])([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*)\b/gi)) {
    if (conAlias.has(r[1])) out.push({ alias: r[1], colonna: r[2] })
  }
  // `UPDATE public.T a SET col = …, col2 = … FROM|WHERE`: le colonne a sinistra non portano alias.
  for (const r of sql.matchAll(/\bupdate\s+public\.([a-z_0-9]+)(?:\s+[a-z_][a-z_0-9]*)?\s+set\s+([\s\S]*?)(?=\bfrom\b|\bwhere\b|;)/gi)) {
    for (const c of r[2].matchAll(/(?:^|,)\s*([a-z_][a-z_0-9]*)\s*=/gi)) out.push({ alias: `<${r[1]}>`, colonna: c[1] })
  }
  return out
}

function problemi(sql: string): string[] {
  const testo = nudo(sql)
  const conAlias = alias(testo)
  const dichiarate = colonneDichiarate(testo)
  const out: string[] = []
  for (const u of usi(testo, conAlias)) {
    if (dichiarate.get(u.alias)?.has(u.colonna)) continue
    const tabelle = u.alias.startsWith('<') ? [u.alias.slice(1, -1)] : [...conAlias.get(u.alias)!]
    const mancano = tabelle.filter((t) => !SNAPSHOT.colonne[t])
    if (mancano.length) {
      out.push(`${u.alias}.${u.colonna}: la tabella ${mancano.join(', ')} non è nella fotografia (aggiungila a TABELLE in colonne-azzera-fotografia.mjs e rigenerala)`)
    } else if (!tabelle.some((t) => SNAPSHOT.colonne[t].includes(u.colonna))) {
      out.push(`${u.alias}.${u.colonna}: la colonna non esiste in produzione (${tabelle.join(' / ')})`)
    }
  }
  return [...new Set(out)].sort()
}

const SCRIPT = fs.readFileSync(path.join(DIR, 'azzera-anno-nuovo-demo.sql'), 'utf8')
const FOTOGRAFA = fs.readFileSync(path.join(DIR, 'fotografa-anno-nuovo-demo.sql'), 'utf8')

describe('le colonne che gli script di azzeramento nominano esistono in produzione', () => {
  it('azzera-anno-nuovo-demo.sql: nessuna colonna inventata', () => {
    expect(problemi(SCRIPT)).toEqual([])
  })

  it('fotografa-anno-nuovo-demo.sql: nessuna colonna inventata', () => {
    expect(problemi(FOTOGRAFA)).toEqual([])
  })

  it('il controllo non è cieco: legge davvero alias e colonne dello script', () => {
    const conAlias = alias(nudo(SCRIPT))
    expect([...(conAlias.get('g') ?? [])], 'g = le voci di pagamento').toContain('pagamenti')
    expect([...(conAlias.get('r') ?? [])], 'r = le righe della fotografia').toContain('listino_voci')
    expect(usi(nudo(SCRIPT), conAlias).length, 'colonne lette').toBeGreaterThan(40)
  })

  it('e vede l’errore di B1: g.fattura_id su pagamenti', () => {
    const rotto = SCRIPT.replace('g.fattura_aruba_id IS NOT NULL', 'g.fattura_id IS NOT NULL')
    expect(rotto, 'la sostituzione deve cambiare qualcosa (altrimenti il test non prova niente)').not.toBe(SCRIPT)
    expect(problemi(rotto).join('\n')).toContain('g.fattura_id: la colonna non esiste in produzione')
  })
})

describe('il banco di prova ha le colonne della produzione, per le tabelle che lo script nomina', () => {
  let b: BancoPassaggio
  beforeAll(async () => { b = await creaBancoAzzera() }, 240_000)
  afterAll(async () => { await b?.db.close() })

  const nelBanco = async (): Promise<Record<string, string[]>> => {
    const r = await b.db.query<{ t: string; c: string }>(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`)
    const m: Record<string, string[]> = {}
    for (const x of r.rows) (m[x.t] ??= []).push(x.c)
    return m
  }

  it('ogni colonna nominata dallo script c’è nel banco', async () => {
    const banco = await nelBanco()
    const testo = nudo(SCRIPT)
    const conAlias = alias(testo)
    const dichiarate = colonneDichiarate(testo)
    const mancano: string[] = []
    for (const u of usi(testo, conAlias)) {
      if (dichiarate.get(u.alias)?.has(u.colonna)) continue
      const tabelle = u.alias.startsWith('<') ? [u.alias.slice(1, -1)] : [...conAlias.get(u.alias)!]
      if (!tabelle.some((t) => banco[t]?.includes(u.colonna))) mancano.push(`${u.alias}.${u.colonna} (${tabelle.join(' / ')})`)
    }
    expect([...new Set(mancano)].sort()).toEqual([])
  })

  /** Colonne finte del banco che la produzione non ha e che lo script non nomina: servono ai test del registro (trigger finti). */
  const DIFFERENZE_NOTE = new Set(['enrollment_submissions.storico_versione'])

  it('il banco non ha colonne che la produzione non ha (le tabelle nominate dallo script)', async () => {
    const banco = await nelBanco()
    const inPiu: string[] = []
    for (const t of tabelleNominate(nudo(SCRIPT))) {
      if (!SNAPSHOT.colonne[t] || !banco[t]) continue
      for (const c of banco[t]) if (!SNAPSHOT.colonne[t].includes(c) && !DIFFERENZE_NOTE.has(`${t}.${c}`)) inPiu.push(`${t}.${c}`)
    }
    expect(inPiu.sort(), 'colonne del banco assenti in produzione').toEqual([])
  })
})
