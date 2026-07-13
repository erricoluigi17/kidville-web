import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sealDangerous } from '@/lib/security/seal'
import { requireEnv } from '@/lib/security/require-env'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const querySchema = z.object({}) // nessun parametro in ingresso

/**
 * POST/GET /api/admin/apply-enrollment-migration
 * Applica la migrazione iscrizioni (tabella enrollment_submissions + colonne documento).
 * Usa l'endpoint SQL REST di Supabase (non richiede la funzione exec_sql).
 * Idempotente — usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 */

// Letti a import-time senza asserzione: il check runtime (503) è negli handler.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

async function execSql(sql: string): Promise<{ error?: string }> {
  // Supabase espone un endpoint pg REST per eseguire SQL raw via service-role
  // Usiamo l'endpoint /rest/v1/rpc dopo aver creato una funzione temporanea,
  // oppure l'endpoint SQL direttamente.
  // Il modo più affidabile con Supabase hosted è creare la funzione exec_sql prima.

  // Primo tentativo: creiamo/usiamo la funzione exec_sql
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ sql }),
  })

  if (rpcRes.ok) return {}

  const body = await rpcRes.json().catch(() => null)
  return { error: body?.message || body?.error || `HTTP ${rpcRes.status}` }
}

async function ensureExecSqlFunction(): Promise<{ error?: string }> {
  // Crea la funzione helper exec_sql via l'endpoint SQL di Supabase (pg endpoint)
  const sql = `
    CREATE OR REPLACE FUNCTION public.exec_sql(sql text)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    BEGIN
      EXECUTE sql;
    END;
    $$;
  `

  // Usiamo l'endpoint SQL di Supabase Management API
  // Supabase hosted ha /pg/query per eseguire SQL raw con la service role key
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ sql }),
  })

  // Se la funzione non esiste, dobbiamo crearla via un altro canale.
  // Proviamo a usare il Supabase SQL Editor API
  if (!res.ok) {
    // Fallback: usa il pg endpoint di Supabase (disponibile su hosted)
    const pgRes = await fetch(`${SUPABASE_URL}/pg/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ query: sql }),
    })
    if (!pgRes.ok) {
      const body = await pgRes.text()
      return { error: `Impossibile creare exec_sql: ${body}` }
    }
  }
  return {}
}

async function runMigration() {
  const steps: string[] = []
  const errors: string[] = []

  // Step 0: assicuriamoci che exec_sql esista
  const fnResult = await ensureExecSqlFunction()
  if (fnResult.error) {
    // Se non riusciamo a creare exec_sql, proviamo a eseguire tutto via SQL diretto
    // Fallback: usiamo l'approccio diretto con pg/query
    return await runMigrationDirect()
  }
  steps.push('✅ exec_sql function ready')

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
    { name: 'reload schema', sql: `NOTIFY pgrst, 'reload schema'` },
  ]

  for (const { name, sql } of statements) {
    const result = await execSql(sql)
    if (result.error && !result.error.includes('already exists')) {
      errors.push(`❌ ${name}: ${result.error}`)
    } else {
      steps.push(`✅ ${name}`)
    }
  }

  // Attendi un momento per il reload dello schema, poi verifica
  await new Promise(r => setTimeout(r, 2000))

  // Verifica con un fetch diretto al REST API
  const verifyRes = await fetch(
    `${SUPABASE_URL}/rest/v1/enrollment_submissions?select=id&limit=1`,
    {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    }
  )

  const schemaVerified = verifyRes.ok
  const schemaError = schemaVerified ? undefined : await verifyRes.text()

  return { success: errors.length === 0 && schemaVerified, steps, errors, schemaVerified, schemaError }
}

/** Fallback: esegue SQL direttamente senza exec_sql, usando Supabase SQL endpoint */
async function runMigrationDirect() {
  const steps: string[] = []
  const errors: string[] = []

  const fullSql = `
    CREATE TABLE IF NOT EXISTS public.enrollment_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id UUID,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      assigned_classes JSONB DEFAULT '{}'::jsonb,
      imported_at TIMESTAMPTZ,
      credentials JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE public.enrollment_submissions ENABLE ROW LEVEL SECURITY;
    DO $$ BEGIN
      ALTER TABLE public.alunni ADD COLUMN IF NOT EXISTS documento_path TEXT;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS documento_path TEXT;
      ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS document_type VARCHAR(50);
      ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS document_number VARCHAR(100);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;
    NOTIFY pgrst, 'reload schema';
  `

  // Prova endpoint pg/query
  const pgRes = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ query: fullSql }),
  })

  if (!pgRes.ok) {
    const body = await pgRes.text()
    errors.push(`❌ pg/query fallito: ${body}`)
    // Ultimo tentativo: SQL via Supabase Management API (usato dal Dashboard)
    return { success: false, steps, errors, schemaVerified: false, schemaError: 'exec_sql non disponibile e pg/query non accessibile. Eseguire la migrazione manualmente dal Supabase Dashboard SQL Editor.' }
  }

  steps.push('✅ Migration SQL executed via pg/query')

  await new Promise(r => setTimeout(r, 2000))

  const verifyRes = await fetch(
    `${SUPABASE_URL}/rest/v1/enrollment_submissions?select=id&limit=1`,
    {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
    }
  )

  const schemaVerified = verifyRes.ok
  const schemaError = schemaVerified ? undefined : await verifyRes.text()

  return { success: errors.length === 0 && schemaVerified, steps, errors, schemaVerified, schemaError }
}

export const POST = withRoute('admin/apply-enrollment-migration:POST', async (request: Request) => {
  const sealed = await sealDangerous(request)
  if (sealed) return sealed
  const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY')
  if (missingEnv) return missingEnv
  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response
  try {
    return NextResponse.json(await runMigration())
  } catch (error) {
    logErrore({ operazione: 'admin/apply-enrollment-migration:POST', stato: 500 }, error)
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 })
  }
})

export const GET = withRoute('admin/apply-enrollment-migration:GET', async (request: Request) => {
  const sealed = await sealDangerous(request)
  if (sealed) return sealed
  const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY')
  if (missingEnv) return missingEnv
  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response
  try {
    return NextResponse.json(await runMigration())
  } catch (error) {
    logErrore({ operazione: 'admin/apply-enrollment-migration:GET', stato: 500 }, error)
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 })
  }
})
