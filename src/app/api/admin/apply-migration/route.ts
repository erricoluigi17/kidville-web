import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealDangerous } from '@/lib/security/seal';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const querySchema = z.object({}); // nessun parametro in ingresso

/**
 * POST/GET /api/admin/apply-migration
 * Applies the extended schema to task_interni table.
 * Idempotente - uses ADD COLUMN IF NOT EXISTS.
 */
async function runMigration() {
  const supabase = await createAdminClient();
  const steps: string[] = [];
  const errors: string[] = [];

  const alterations = [
    { col: 'status', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'todo'` },
    { col: 'priority', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium'` },
    { col: 'category', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'generale'` },
    { col: 'deadline', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ` },
    { col: 'student_id', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS student_id UUID` },
    { col: 'resolved_by', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS resolved_by UUID` },
    { col: 'resolution_notes', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS resolution_notes TEXT` },
    { col: 'resolved_at', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ` },
    { col: 'target_role', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS target_role VARCHAR(50)` },
    { col: 'target_scope', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS target_scope VARCHAR(20) DEFAULT 'single'` },
    { col: 'compiti', sql: `ALTER TABLE task_interni ADD COLUMN IF NOT EXISTS compiti JSONB DEFAULT '[]'::jsonb` },
  ];

  for (const { col, sql } of alterations) {
    const { error } = await supabase.rpc('exec_sql', { sql });
    if (error) {
      errors.push(`❌ ${col}: ${error.message}`);
    } else {
      steps.push(`✅ ${col} aggiunto`);
    }
  }

  // Verify columns now exist by reading table structure
  const { error: readError } = await supabase
    .from('task_interni')
    .select('id, status, priority, category, deadline, student_id, resolved_by, resolution_notes, resolved_at, target_role, target_scope, compiti')
    .limit(1);

  const columnsOk = !readError;

  return {
    success: errors.length === 0 && columnsOk,
    steps,
    errors,
    schemaVerified: columnsOk,
    schemaError: readError?.message,
  };
}

export const POST = withRoute('admin/apply-migration:POST', async (request: Request) => {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  const q = parseQuery(request, querySchema);
  if ('response' in q) return q.response;
  try {
    const result = await runMigration();
    return NextResponse.json(result);
  } catch (error) {
    logErrore({ operazione: 'admin/apply-migration:POST', stato: 500 }, error);
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
});

export const GET = withRoute('admin/apply-migration:GET', async (request: Request) => {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  const q = parseQuery(request, querySchema);
  if ('response' in q) return q.response;
  try {
    const result = await runMigration();
    return NextResponse.json(result);
  } catch (error) {
    logErrore({ operazione: 'admin/apply-migration:GET', stato: 500 }, error);
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
});
