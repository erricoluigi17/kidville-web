import { NextResponse } from 'next/server';
import { sealDangerous } from '@/lib/security/seal';
import { createAdminClient } from '@/lib/supabase/server-client';

/**
 * Migrazione idempotente per il sistema moduli (modulistica genitori/esterni).
 *
 * Crea `forms_templates` e `forms_submissions` se non esistono e aggiunge la
 * colonna `form_type` ('sondaggio' | 'gradimento' | 'autorizzazione').
 * Le tabelle sono accedute solo lato server (service role), ma abilitiamo RLS
 * con policy permissiva per coerenza con le altre tabelle del progetto.
 *
 * Esegui con GET o POST su /api/admin/apply-forms-migration.
 */
async function runMigration() {
  const supabase = await createAdminClient();
  const sql = `
    CREATE TABLE IF NOT EXISTS forms_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scuola_id UUID NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        form_type VARCHAR(20) NOT NULL DEFAULT 'autorizzazione',
        fields JSONB NOT NULL DEFAULT '[]',
        target_scope VARCHAR(20) NOT NULL DEFAULT 'class',
        target_classes TEXT[] DEFAULT '{}',
        expiration_date TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- Se la tabella esisteva già senza la colonna tipo
    ALTER TABLE forms_templates ADD COLUMN IF NOT EXISTS form_type VARCHAR(20) NOT NULL DEFAULT 'autorizzazione';

    CREATE TABLE IF NOT EXISTS forms_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        form_id UUID NOT NULL REFERENCES forms_templates(id) ON DELETE CASCADE,
        parent_id UUID,
        student_id UUID,
        answers JSONB NOT NULL DEFAULT '{}',
        is_signed BOOLEAN DEFAULT false,
        signature_log JSONB,
        pdf_path TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_forms_templates_scuola ON forms_templates(scuola_id);
    CREATE INDEX IF NOT EXISTS idx_forms_templates_scope ON forms_templates(target_scope);
    CREATE INDEX IF NOT EXISTS idx_forms_submissions_form ON forms_submissions(form_id);
    CREATE INDEX IF NOT EXISTS idx_forms_submissions_parent ON forms_submissions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_forms_submissions_student ON forms_submissions(student_id);

    ALTER TABLE forms_templates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE forms_submissions ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "forms_templates_all" ON forms_templates;
    DROP POLICY IF EXISTS "forms_submissions_all" ON forms_submissions;
    CREATE POLICY "forms_templates_all" ON forms_templates FOR ALL USING (true) WITH CHECK (true);
    CREATE POLICY "forms_submissions_all" ON forms_submissions FOR ALL USING (true) WITH CHECK (true);

    -- Ricarica la cache dello schema di PostgREST così le nuove tabelle sono subito visibili
    NOTIFY pgrst, 'reload schema';
  `;

  const { error } = await supabase.rpc('exec_sql', { sql });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function POST(request: Request) {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  try {
    return NextResponse.json(await runMigration());
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  try {
    return NextResponse.json(await runMigration());
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
}
