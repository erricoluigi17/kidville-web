#!/usr/bin/env node
/**
 * Applica le migrazioni Primaria Fase 2 (Scrutinio/Pagella, Fascicolo RBAC+audit,
 * firma OTP sulla giustifica) al database. Idempotenti (rieseguibili).
 *
 * Uso (uno dei due):
 *   1) node scripts/apply_primaria_fase2_migrations.mjs "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
 *   2) Aggiungi DATABASE_URL=... in .env.local, poi: node scripts/apply_primaria_fase2_migrations.mjs
 *
 * La connection string è in Supabase Dashboard → Settings → Database →
 * Connection string → URI.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from 'pg';

const { Client } = pkg;

const MIGRATIONS = [
  '20260628_primaria_scrutinio.sql',
  '20260629_primaria_scrutinio_audit.sql',
  '20260630_fascicolo_rbac_audit.sql',
  '20260631_presenze_giust_firma.sql',
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
    ['tabella scrutini', "SELECT 1 FROM information_schema.tables WHERE table_name='scrutini'"],
    ['tabella scrutinio_periodi', "SELECT 1 FROM information_schema.tables WHERE table_name='scrutinio_periodi'"],
    ['tabella scrutinio_giudizi', "SELECT 1 FROM information_schema.tables WHERE table_name='scrutinio_giudizi'"],
    ['tabella pagelle', "SELECT 1 FROM information_schema.tables WHERE table_name='pagelle'"],
    ["sblocchi_audit accetta 'scrutinio'", "SELECT 1 FROM pg_constraint WHERE conname='sblocchi_audit_entita_tipo_check' AND pg_get_constraintdef(oid) LIKE '%scrutinio%'"],
    ['tabella fascicolo_accessi_audit', "SELECT 1 FROM information_schema.tables WHERE table_name='fascicolo_accessi_audit'"],
    ['student_documents.section_id', "SELECT 1 FROM information_schema.columns WHERE table_name='student_documents' AND column_name='section_id'"],
    ["document_type_enum include 'pdp'", "SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='document_type_enum' AND e.enumlabel='pdp'"],
    ['presenze.giustificazione_firma', "SELECT 1 FROM information_schema.columns WHERE table_name='presenze' AND column_name='giustificazione_firma'"],
    ['bucket sensitive_documents privato', "SELECT 1 FROM storage.buckets WHERE id='sensitive_documents' AND public=false"],
  ];
  for (const [label, q] of checks) {
    try {
      const r = await client.query(q);
      console.log(`  • ${label}: ${r.rowCount ? 'ok' : 'assente'}`);
    } catch (e) {
      console.log(`  • ${label}: errore ${e.message}`);
    }
  }

  await client.end();
  console.log('\n✅ Migrazioni Fase 2 applicate.');
}

main().catch((err) => { console.error('❌ Errore fatale:', err); process.exit(1); });
