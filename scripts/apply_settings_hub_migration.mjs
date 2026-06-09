#!/usr/bin/env node
/**
 * Applica la migrazione 20260711_settings_hub.sql (impostazioni hub) via
 * RPC exec_sql con service role. Idempotente, rieseguibile.
 *
 * Esegui con: node scripts/apply_settings_hub_migration.mjs
 * Legge SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY da .env.local.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

function loadEnvLocal() {
  try {
    const txt = readFileSync('.env.local', 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch { /* opzionale */ }
}

async function main() {
  loadEnvLocal();
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('❌ Mancano SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const sql = readFileSync(join('supabase', 'migrations', '20260711_settings_hub.sql'), 'utf8');

  process.stdout.write('⏳ 20260711_settings_hub.sql ... ');
  const { error } = await supabase.rpc('exec_sql', { sql });
  if (error) {
    console.log(`❌ ${error.message}`);
    process.exit(1);
  }
  console.log('✅');

  // Verifica post-migrazione
  const { data, error: readErr } = await supabase
    .from('admin_settings')
    .select('scuola_id, diario_config, presenze_config, funzioni_matrice')
    .limit(3);
  if (readErr) {
    console.log(`⚠️ Verifica fallita: ${readErr.message}`);
    process.exit(1);
  }
  for (const row of data ?? []) {
    console.log(`\n🔍 scuola ${row.scuola_id}:`);
    console.log('  diario_config:', JSON.stringify(row.diario_config));
    console.log('  presenze_config:', JSON.stringify(row.presenze_config));
    console.log('  funzioni_matrice.primaria:', JSON.stringify(row.funzioni_matrice?.primaria));
  }
  console.log('\n✅ Migrazione applicata.');
}

main().catch((err) => { console.error('❌ Errore fatale:', err); process.exit(1); });
