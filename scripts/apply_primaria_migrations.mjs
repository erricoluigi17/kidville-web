#!/usr/bin/env node
/**
 * Applica le 5 nuove migrazioni Primaria (registro presenze, giustifiche,
 * argomento valutazioni, trigger sync sezione, seed 5 classi) al database.
 *
 * Uso (uno dei due):
 *   1) node scripts/apply_primaria_migrations.mjs "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
 *   2) Aggiungi DATABASE_URL=... in .env.local, poi: node scripts/apply_primaria_migrations.mjs
 *
 * La connection string si trova in Supabase Dashboard → Settings → Database →
 * Connection string → URI. Le migrazioni sono idempotenti (rieseguibili).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from 'pg';

const { Client } = pkg;

// Migrazioni da applicare, in ordine.
const MIGRATIONS = [
  '20260623_presenze_giustifiche.sql',
  '20260624_valutazioni_argomento.sql',
  '20260625_giustifiche_didattiche.sql',
  '20260626_alunni_sync_section_trigger.sql',
  '20260627_primaria_seed_5_classi.sql',
];

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
  const connectionString = process.argv[2] || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('❌ Manca la connection string. Passa la DATABASE_URL come argomento o in .env.local.');
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('🔌 Connesso al database.\n');

  const dir = join('supabase', 'migrations');
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(dir, file), 'utf8');
    process.stdout.write(`⏳ ${file} ... `);
    try {
      await client.query(sql);
      console.log('✅');
    } catch (err) {
      console.log(`❌ ${err.message}`);
      await client.end();
      process.exit(1);
    }
  }

  // Verifiche rapide post-migrazione.
  console.log('\n🔍 Verifiche:');
  const checks = [
    ["colonna presenze.giustificata", "SELECT 1 FROM information_schema.columns WHERE table_name='presenze' AND column_name='giustificata'"],
    ["colonna valutazioni.argomento", "SELECT 1 FROM information_schema.columns WHERE table_name='valutazioni' AND column_name='argomento'"],
    ["tabella giustifiche_didattiche", "SELECT 1 FROM information_schema.tables WHERE table_name='giustifiche_didattiche'"],
    ["trigger trg_alunni_sync_section", "SELECT 1 FROM pg_trigger WHERE tgname='trg_alunni_sync_section'"],
    ["sezioni primaria (>=5)", "SELECT count(*) AS n FROM public.sections WHERE school_type='primaria'"],
    ["alunni primaria", "SELECT count(*) AS n FROM public.alunni a JOIN public.sections s ON s.id=a.section_id WHERE s.school_type='primaria'"],
  ];
  for (const [label, q] of checks) {
    try {
      const r = await client.query(q);
      const val = r.rows[0]?.n !== undefined ? r.rows[0].n : (r.rowCount ? 'ok' : 'assente');
      console.log(`  • ${label}: ${val}`);
    } catch (e) {
      console.log(`  • ${label}: errore ${e.message}`);
    }
  }

  await client.end();
  console.log('\n✅ Migrazioni applicate.');
}

main().catch((err) => { console.error('❌ Errore fatale:', err); process.exit(1); });
