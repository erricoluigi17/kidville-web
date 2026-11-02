// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AMBITI, TITOLO_MAX } from '@/lib/votazioni/tipi'
import { senzaCommenti } from '../../architecture/soglia-fotografia'

/**
 * I VOCABOLARI DELLE VOTAZIONI STANNO IN DUE POSTI, E DEVONO DIRE LA STESSA COSA.
 *
 * Il database conosce l’ambito di un voto come `check (ambito in ('classe','istituto'))` nella migrazione;
 * il codice come `AMBITI` di `src/lib/votazioni/tipi.ts`. Se uno dei due cresce senza l’altro, il codice
 * propone un ambito che il database rifiuta (23514) o il database accetta un ambito che la schermata non
 * sa mostrare. Stesso discorso per il tetto del titolo: `TITOLO_MAX` e il `BETWEEN 1 AND …` del `check`.
 *
 * Il modello è `__tests__/lib/crm/vocabolari-allineati.test.ts`.
 *
 * ⚠️ Cerca i check nella migrazione SENZA COMMENTI: un commento che li nomina non li sostituisce.
 * ⚠️ La migrazione si trova per NOME (`<14 cifre>_votazioni_rappresentanti.sql`), non per versione: la
 * versione la decide `date -u` al momento di scriverla.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const FILE = readdirSync(CARTELLA)
  .filter((f) => /^\d{14}_votazioni_rappresentanti\.sql$/.test(f))
  .sort()
const SQL = FILE.length > 0 ? senzaCommenti(readFileSync(join(CARTELLA, FILE[0]), 'utf8')) : ''

/** I valori fra apici di una lista `('a','b',…)`. */
const valori = (lista: string): string[] => [...lista.matchAll(/'([^']*)'/g)].map((v) => v[1])

/** Il corpo di `create table [if not exists] [public.]<nome> ( … )`, parentesi bilanciate. */
function corpoTabella(sql: string, nome: string): string | null {
  const intestazione = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${nome}\\s*\\(`, 'i')
  const m = intestazione.exec(sql)
  if (!m) return null
  let livello = 1
  let j = m.index + m[0].length
  while (j < sql.length && livello > 0) {
    if (sql[j] === '(') livello++
    if (sql[j] === ')') livello--
    j++
  }
  return sql.slice(m.index + m[0].length, j - 1)
}

/** I valori del `check (ambito in (…))` di `votazioni_voti`, oppure `null` se non c’è. */
function ambitiDelCheck(sql: string): string[] | null {
  const corpo = corpoTabella(sql, 'votazioni_voti')
  if (corpo === null) return null
  const m = /check\s*\(\s*ambito\s+in\s*\(([^)]*)\)\s*\)/i.exec(corpo)
  return m ? valori(m[1]) : null
}

/** Gli estremi del `check (char_length(btrim(titolo)) between 1 and N)` di `votazioni`. */
function estremiTitolo(sql: string): { min: number; max: number } | null {
  const corpo = corpoTabella(sql, 'votazioni')
  if (corpo === null) return null
  const m = /check\s*\(\s*char_length\s*\(\s*btrim\s*\(\s*titolo\s*\)\s*\)\s+between\s+(\d+)\s+and\s+(\d+)\s*\)/i.exec(corpo)
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null
}

describe('i lettori di questo test (controllo positivo: senza, il resto sarebbe verde sul vuoto)', () => {
  const ESEMPIO = `
    create table if not exists public.votazioni (
      id uuid primary key,
      titolo text not null check (char_length(btrim(titolo)) between 1 and 120)
    );
    create table if not exists public.votazioni_voti (
      id uuid primary key,
      ambito text not null check (ambito in ('classe','istituto')),
      section_id uuid null,
      check ((ambito = 'classe') = (section_id is not null))
    );`

  it('legge gli ambiti e gli estremi del titolo da un SQL fatto in casa', () => {
    expect(ambitiDelCheck(ESEMPIO)).toEqual(['classe', 'istituto'])
    expect(estremiTitolo(ESEMPIO)).toEqual({ min: 1, max: 120 })
  })

  it('NON si lascia ingannare da un check che compare solo in un commento', () => {
    const soloCommento = senzaCommenti(`
      -- check (ambito in ('classe','istituto'))
      create table public.votazioni_voti (id uuid primary key);`)
    expect(ambitiDelCheck(soloCommento)).toBeNull()
  })

  it('un ambito in più nel database è visto come una differenza', () => {
    const piuUno = ESEMPIO.replace(`'classe','istituto'`, `'classe','istituto','plesso'`)
    expect(ambitiDelCheck(piuUno)).not.toEqual([...AMBITI])
  })
})

describe('vocabolari delle votazioni · migrazione e tipi.ts dicono la stessa cosa', () => {
  it('la migrazione c’è, ed è una sola', () => {
    expect(FILE).toHaveLength(1)
    expect(SQL.length).toBeGreaterThan(0)
  })

  it('votazioni_voti.ambito: stessi valori, stesso ordine di AMBITI', () => {
    expect(ambitiDelCheck(SQL)).toEqual([...AMBITI])
  })

  it('AMBITI non ha valori ripetuti o vuoti', () => {
    expect(new Set(AMBITI).size).toBe(AMBITI.length)
    expect(AMBITI.every((v) => v.length > 0)).toBe(true)
  })

  it('votazioni.titolo: il tetto del database è TITOLO_MAX, e il minimo è 1', () => {
    expect(estremiTitolo(SQL)).toEqual({ min: 1, max: TITOLO_MAX })
  })
})
