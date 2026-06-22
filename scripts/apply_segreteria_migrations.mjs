#!/usr/bin/env node
/**
 * Applica una o più migrazioni SQL (Segreteria/Direzione) via RPC exec_sql con
 * service role. Idempotente, rieseguibile. Legge SUPABASE_URL e
 * SUPABASE_SERVICE_ROLE_KEY da .env.local.
 *
 * Uso: node scripts/apply_segreteria_migrations.mjs <file1.sql> [file2.sql ...]
 *      (i path sono relativi a supabase/migrations/)
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

  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('❌ Specifica almeno un file di migrazione (relativo a supabase/migrations/).');
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // Sanity check: exec_sql disponibile?
  const probe = await supabase.rpc('exec_sql', { sql: 'SELECT 1;' });
  if (probe.error) {
    console.error(`❌ RPC exec_sql non disponibile: ${probe.error.message}`);
    process.exit(2);
  }
  console.log('✅ RPC exec_sql disponibile\n');

  for (const f of files) {
    const path = join('supabase', 'migrations', f);
    const sql = readFileSync(path, 'utf8');
    process.stdout.write(`⏳ ${f} ... `);
    const { error } = await supabase.rpc('exec_sql', { sql });
    if (error) {
      console.log(`❌ ${error.message}`);
      process.exit(1);
    }
    console.log('✅');
  }

  console.log('\n✅ Migrazioni applicate.');
}

main().catch((err) => { console.error('❌ Errore fatale:', err); process.exit(1); });
