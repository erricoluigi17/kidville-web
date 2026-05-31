#!/usr/bin/env node
/**
 * Script per applicare la migrazione enrollment_submissions + funzione exec_sql.
 * 
 * Uso:
 *   node scripts/apply-enrollment-migration.js <DATABASE_URL>
 * 
 * Dove DATABASE_URL è il connection string PostgreSQL dal Supabase Dashboard:
 *   Settings → Database → Connection string → URI
 * 
 * Esempio:
 *   node scripts/apply-enrollment-migration.js "postgresql://postgres.uimulkjyekgemjakmepp:PASSWORD@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"
 */

const { Client } = require('pg')

const MIGRATION_SQL = `
-- 0. Funzione helper exec_sql (usata da altre route)
CREATE OR REPLACE FUNCTION public.exec_sql(sql text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  EXECUTE sql;
END;
$$;

-- 1. Tabella raccolta invii del form pubblico di iscrizione
CREATE TABLE IF NOT EXISTS public.enrollment_submissions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scuola_id        UUID,
  data             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT        NOT NULL DEFAULT 'pending',
  assigned_classes JSONB       DEFAULT '{}'::jsonb,
  imported_at      TIMESTAMPTZ,
  credentials      JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.enrollment_submissions ENABLE ROW LEVEL SECURITY;

-- 2. Colonna documento d'identità sull'alunno
DO $$ BEGIN
  ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS documento_path TEXT;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- 3. Colonne documento sull'adulto (parents)
DO $$ BEGIN
  ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS documento_path TEXT;
  ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS document_type VARCHAR(50);
  ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS document_number VARCHAR(100);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- 4. Storage bucket (se non esiste, va creato dal Dashboard o tramite API)
-- Il bucket form_attachments deve essere creato manualmente se non presente.

-- 5. Notifica PostgREST per ricaricare lo schema
NOTIFY pgrst, 'reload schema';
`

async function main() {
  const dbUrl = process.argv[2]
  
  if (!dbUrl) {
    console.error('❌ Usage: node scripts/apply-enrollment-migration.js <DATABASE_URL>')
    console.error('')
    console.error('   Trovi il DATABASE_URL nel Supabase Dashboard:')
    console.error('   Settings → Database → Connection string → URI')
    process.exit(1)
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

  try {
    console.log('🔌 Connessione al database...')
    await client.connect()
    console.log('✅ Connesso!')

    console.log('🔄 Esecuzione migrazione...')
    await client.query(MIGRATION_SQL)
    console.log('✅ Migrazione completata!')

    // Verifica
    const { rows } = await client.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'enrollment_submissions')"
    )
    console.log(`✅ Tabella enrollment_submissions: ${rows[0].exists ? 'CREATA' : '⚠️ NON TROVATA'}`)

    const { rows: fnRows } = await client.query(
      "SELECT EXISTS (SELECT FROM pg_proc WHERE proname = 'exec_sql' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public'))"
    )
    console.log(`✅ Funzione exec_sql: ${fnRows[0].exists ? 'CREATA' : '⚠️ NON TROVATA'}`)

  } catch (err) {
    console.error('❌ Errore:', err.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()
