import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRAZIONI_ATTESE_AL_MERGE } from '../../architecture/soglia-fotografia'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => /^\d{14}_crm_accesso_ai\.sql$/.test(f))
const SQL = FILE.length === 1 ? readFileSync(join(CARTELLA, FILE[0]), 'utf8') : ''
/** Lo stesso testo senza i commenti `--`: una parola in un commento non conta. */
const CODICE = SQL.split('\n').map((r) => r.replace(/--.*$/, '')).join('\n')
const FUNZIONI = [
  'crm_ai_token_attivo', 'crm_ai_persone', 'crm_ai_scheda', 'crm_ai_bambini',
  'crm_ai_registra_contatto', 'crm_ai_candidati', 'crm_ai_prenota', 'crm_ai_annulla', 'crm_ai_richiamo',
]

describe('migrazione crm_accesso_ai · il testo', () => {
  it('c’è un solo file, col nome giusto e un istante vero', () => {
    expect(FILE).toHaveLength(1)
    const ts = FILE[0].slice(0, 14)
    expect(ts > '20261104173158').toBe(true)
    expect(ts.slice(10)).not.toBe('0000') // non un orario tondo
  })
  it('le due tabelle hanno scuola_id verso schools e la RLS accesa, senza policy', () => {
    for (const t of ['crm_integrazioni', 'crm_ai_richieste']) {
      expect(CODICE).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t} \\(`))
      expect(CODICE).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY;`))
    }
    expect(CODICE.match(/scuola_id\s+uuid NOT NULL REFERENCES public\.schools\(id\)/g)).toHaveLength(2)
    expect(CODICE).not.toMatch(/create\s+policy/i)
  })
  it('una sola chiave attiva per sede, e l’impronta è unica', () => {
    expect(CODICE).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS crm_integrazioni_una_attiva_per_sede\s+ON public\.crm_integrazioni \(scuola_id\)\s+WHERE revocata_il IS NULL;/)
    expect(CODICE).toMatch(/CONSTRAINT crm_integrazioni_impronta_unica UNIQUE \(token_impronta\)/)
    expect(CODICE).toMatch(/CONSTRAINT crm_ai_richieste_chiave_unica UNIQUE \(integrazione_id, chiave\)/)
  })
  it('il token in chiaro non ha una colonna', () => {
    expect(CODICE).not.toMatch(/\btoken\s+text/i)
  })
  it('niente di distruttivo', () => {
    expect(CODICE).not.toMatch(/\b(DROP|TRUNCATE)\b/i)
    expect(CODICE).not.toMatch(/DELETE\s+FROM/i)
  })
  it.each(FUNZIONI)('%s è plpgsql, SECURITY INVOKER, con search_path fissato e solo del service_role', (nome) => {
    const da = CODICE.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`)
    expect(da).toBeGreaterThan(-1)
    const testa = CODICE.slice(da, CODICE.indexOf('AS $$', da))
    expect(testa).toMatch(/LANGUAGE plpgsql/)
    expect(testa).toMatch(/SECURITY INVOKER/)
    expect(testa).toMatch(/SET search_path = public, pg_temp/)
    expect(CODICE).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${nome}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`))
    expect(CODICE).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${nome}\\([^)]*\\) TO service_role;`))
  })
  it('chiude dicendo a PostgREST di rileggere lo schema', () => {
    expect(CODICE.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true)
  })
  it('è dichiarata fra le migrazioni attese al merge (si toglie nella PR-B)', () => {
    expect(Object.keys(MIGRAZIONI_ATTESE_AL_MERGE)).toContain(FILE[0])
  })
})
