#!/usr/bin/env node
/**
 * Applica la migration 20260716_alunni_usa_pannolino.sql al database.
 *
 * Uso (uno dei due):
 *   1) node scripts/apply_usa_pannolino.mjs "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
 *   2) Aggiungi DATABASE_URL=... in .env.local, poi: node scripts/apply_usa_pannolino.mjs
 *
 * La connection string è in Supabase Dashboard → Settings → Database →
 * Connection string → URI. La migration è idempotente (rieseguibile).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from 'pg';

const { Client } = pkg;
const MIGRATION = '20260716_alunni_usa_pannolino.sql';

function loadEnvLocal() {
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
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

  const sql = readFileSync(join('supabase', 'migrations', MIGRATION), 'utf8');
  process.stdout.write(`⏳ ${MIGRATION} ... `);
  try {
    await client.query(sql);
    console.log('✅');
  } catch (err) {
    console.log(`❌ ${err.message}`);
    await client.end();
    process.exit(1);
  }

  // Verifica
  const r = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name='alunni' AND column_name='usa_pannolino'"
  );
  console.log(`\n🔍 colonna alunni.usa_pannolino: ${r.rowCount ? 'presente ✅' : 'ASSENTE ❌'}`);

  await client.end();
  console.log('\n✅ Migration applicata.');
}

main().catch((err) => { console.error('❌ Errore fatale:', err); process.exit(1); });
