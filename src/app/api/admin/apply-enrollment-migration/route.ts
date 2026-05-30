import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'

/**
 * POST/GET /api/admin/apply-enrollment-migration
 * Applica la migrazione iscrizioni (tabella enrollment_submissions + colonne documento).
 * Idempotente — usa IF NOT EXISTS. Pattern identico a /api/admin/apply-migration.
 */
async function runMigration() {
  const supabase = await createAdminClient()
  const steps: string[] = []
  const errors: string[] = []

  const statements: { name: string; sql: string }[] = [
    {
      name: 'enrollment_submissions',
      sql: `CREATE TABLE IF NOT EXISTS public.enrollment_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scuola_id UUID,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending',
        assigned_classes JSONB DEFAULT '{}'::jsonb,
        imported_at TIMESTAMPTZ,
        credentials JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    },
    { name: 'enable RLS', sql: `ALTER TABLE public.enrollment_submissions ENABLE ROW LEVEL SECURITY` },
    { name: 'alunni.documento_path', sql: `ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS documento_path TEXT` },
    { name: 'parents.documento_path', sql: `ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS documento_path TEXT` },
    { name: 'parents.document_type', sql: `ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS document_type VARCHAR(50)` },
    { name: 'parents.document_number', sql: `ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS document_number VARCHAR(100)` },
  ]

  for (const { name, sql } of statements) {
    const { error } = await supabase.rpc('exec_sql', { sql })
    if (error && !error.message.includes('already exists')) {
      errors.push(`❌ ${name}: ${error.message}`)
    } else {
      steps.push(`✅ ${name}`)
    }
  }

  // Verifica che la tabella sia interrogabile
  const { error: readError } = await supabase.from('enrollment_submissions').select('id').limit(1)

  return {
    success: errors.length === 0 && !readError,
    steps,
    errors,
    schemaVerified: !readError,
    schemaError: readError?.message,
  }
}

export async function POST() {
  try {
    return NextResponse.json(await runMigration())
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 })
  }
}

export async function GET() {
  try {
    return NextResponse.json(await runMigration())
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 })
  }
}
