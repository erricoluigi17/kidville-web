import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_FUNZIONI_MATRICE,
  DEFAULT_SOLLECITI_SEDE_NUOVA,
} from '@/lib/scuole/admin-settings-default'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK — il default di una sede nuova esiste in DUE copie: che restino gemelle
//
// Il corredo di `admin_settings` con cui nasce una sede è scritto due volte, e non
// per sciatteria: la RPC `provisiona_sede` lo applica in SQL (produzione), il ramo
// di fallback di POST /api/admin/schools lo applica in TypeScript (DB E2E, dove la
// RPC non esiste). Due copie che divergono in silenzio significano una sede che
// nasce diversa a seconda di quale ramo l'ha creata — e il ramo lo decide il DB,
// non chi legge il codice.
//
// Questo lock confronta il JSON dentro la migrazione con il default TypeScript.
// Se cambi uno dei due, il test dice subito che manca l'altro.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRAZIONE = join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260729120000_provisiona_sede_admin_settings.sql',
)

describe('lock architettura · default sede nuova: SQL e TypeScript gemelli', () => {
  const sql = readFileSync(MIGRAZIONE, 'utf8')

  it('la matrice funzioni della RPC è identica a DEFAULT_FUNZIONI_MATRICE', () => {
    // Il corpo di `admin_settings_default_matrice()`: SELECT '<json>'::jsonb;
    const m = sql.match(/SELECT\s+'(\{[\s\S]*?\})'::jsonb;\s*\$\$/)
    expect(m, 'blocco SELECT …::jsonb non trovato nella migrazione').not.toBeNull()
    const matriceSql = JSON.parse(m![1]) as Record<string, Record<string, boolean>>
    expect(matriceSql).toEqual(DEFAULT_FUNZIONI_MATRICE)
  })

  it('i solleciti della RPC nascono con lo stesso valore del default TypeScript', () => {
    const m = sql.match(/VALUES \(v_id, public\.admin_settings_default_matrice\(\), '([^']+)'::jsonb\)/)
    expect(m, "INSERT di admin_settings non trovato nella RPC").not.toBeNull()
    expect(JSON.parse(m![1])).toEqual(DEFAULT_SOLLECITI_SEDE_NUOVA)
  })

  it('la RPC crea la riga in modo idempotente (ON CONFLICT sulla PK scuola_id)', () => {
    expect(sql).toMatch(/INSERT INTO public\.admin_settings[\s\S]*?ON CONFLICT \(scuola_id\) DO NOTHING/)
  })
})
