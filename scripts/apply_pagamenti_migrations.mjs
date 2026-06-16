/**
 * apply_pagamenti_migrations.mjs
 * Applica le migrazioni del modulo Pagamenti al DB Supabase hosted, via la
 * RPC `exec_sql(sql text)` (SECURITY DEFINER) usando la SERVICE_ROLE_KEY.
 *
 * Idempotente: i file usano IF NOT EXISTS / DROP ... IF EXISTS / ON CONFLICT,
 * quindi può essere rieseguito senza effetti collaterali.
 *
 * Uso:
 *   node scripts/apply_pagamenti_migrations.mjs [file1.sql file2.sql ...]
 * Senza argomenti applica, in ordine, le migrazioni pagamenti note.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// Carica le env da .env.local (senza dipendenze esterne)
function loadEnv() {
  const env = {}
  try {
    const raw = readFileSync(join(root, '.env.local'), 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch { /* ignore */ }
  return env
}

const env = loadEnv()
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Mancano NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const DEFAULT_FILES = [
  'supabase/migrations/20260602_pagamenti_core.sql',
  'supabase/migrations/20260603_pagamenti_rls.sql',
]

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES

async function applyFile(relPath) {
  const sql = readFileSync(join(root, relPath), 'utf8')
  process.stdout.write(`  ⏳ ${relPath} ...`)
  const { error } = await supabase.rpc('exec_sql', { sql })
  if (error) {
    console.log(' ❌')
    console.log(`     ${error.message}`)
    return false
  }
  console.log(' ✅')
  return true
}

async function main() {
  console.log('🚀 Kidville — Applicazione migrazioni Pagamenti\n')
  let ok = true
  for (const f of files) {
    const r = await applyFile(f)
    ok = ok && r
  }
  console.log(ok ? '\n✅ Tutte le migrazioni applicate.\n' : '\n⚠️  Alcune migrazioni hanno generato errori (vedi sopra).\n')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('❌ Errore fatale:', e); process.exit(1) })
