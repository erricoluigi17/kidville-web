import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

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
  const { data: testRow, error: readError } = await supabase
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

export async function POST() {
  try {
    const result = await runMigration();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
}

export async function GET() {
  try {
    const result = await runMigration();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
}
