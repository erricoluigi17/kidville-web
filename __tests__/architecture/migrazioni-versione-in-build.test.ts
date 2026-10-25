// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NextConfig } from 'next'
import config from '../../next.config'

/**
 * LOCK · LA BUILD FISSA LA VERSIONE DELLE MIGRAZIONI DEL REPO.
 *
 * Il controllo `migrazioni` di `/api/health` (sessione 7 della seconda serie) confronta l'ultima
 * migrazione del repo con `max(version)` del database. La versione del repo la fissa
 * `next.config.ts` alla build (chiave `env`): a runtime su Vercel la cartella
 * `supabase/migrations` non c'è. Next sostituisce SOLO la forma statica `process.env.NOME`: una
 * lettura dinamica (`process.env[nome]`) resterebbe `undefined` in produzione, e il controllo
 * direbbe per sempre «versione del repo non fissata alla build».
 */

const RADICE = process.cwd()
const NOMI = readdirSync(join(RADICE, 'supabase', 'migrations'))
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort()
const CONTROLLI = readFileSync(join(RADICE, 'src', 'lib', 'health', 'controlli.ts'), 'utf8')
const ENV = (config as NextConfig).env ?? {}

describe('lock · la versione delle migrazioni è fissata alla build', () => {
    it('KV_MIGRAZIONE_REPO è la versione più alta della cartella, KV_MIGRAZIONI_REPO_NUMERO il numero dei file', () => {
        expect(NOMI.length).toBeGreaterThanOrEqual(232)
        expect(ENV.KV_MIGRAZIONE_REPO).toBe(NOMI[NOMI.length - 1].slice(0, 14))
        expect(ENV.KV_MIGRAZIONI_REPO_NUMERO).toBe(String(NOMI.length))
    })

    it('KV_BUILD_IL è un istante leggibile', () => {
        expect(Number.isNaN(Date.parse(ENV.KV_BUILD_IL ?? ''))).toBe(false)
    })

    it('controlli.ts legge le tre chiavi nella sola forma che Next sostituisce', () => {
        for (const chiave of ['KV_MIGRAZIONE_REPO', 'KV_MIGRAZIONI_REPO_NUMERO', 'KV_BUILD_IL']) {
            expect(CONTROLLI, `process.env.${chiave} assente da src/lib/health/controlli.ts`).toContain(`process.env.${chiave}`)
        }
        expect(CONTROLLI).not.toMatch(/process\.env\[\s*['"`]KV_/)
        expect(CONTROLLI).not.toMatch(/\{[^}]*\bKV_[A-Z_]+[^}]*\}\s*=\s*process\.env/)
    })
})
