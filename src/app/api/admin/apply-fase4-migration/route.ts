import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealDangerous } from '@/lib/security/seal';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

const querySchema = z.object({}); // nessun parametro in ingresso

async function runMigration() {
  const supabase = await createAdminClient();
  const sql = `
    -- 1. Tabella Moduli (Form Templates)
    CREATE TABLE IF NOT EXISTS forms_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scuola_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        fields JSONB NOT NULL,
        target_scope VARCHAR(20) NOT NULL DEFAULT 'class',
        target_classes TEXT[] DEFAULT '{}',
        expiration_date TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_forms_templates_scuola ON forms_templates(scuola_id);
    CREATE INDEX IF NOT EXISTS idx_forms_templates_scope ON forms_templates(target_scope);

    -- 2. Tabella Sottomissioni Moduli (Form Submissions)
    CREATE TABLE IF NOT EXISTS forms_submissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        form_id UUID NOT NULL REFERENCES forms_templates(id) ON DELETE CASCADE,
        parent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        student_id UUID REFERENCES alunni(id) ON DELETE CASCADE,
        answers JSONB NOT NULL,
        is_signed BOOLEAN DEFAULT false,
        signature_log JSONB,
        pdf_path TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_forms_submissions_form ON forms_submissions(form_id);
    CREATE INDEX IF NOT EXISTS idx_forms_submissions_parent ON forms_submissions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_forms_submissions_student ON forms_submissions(student_id);

    -- 3. Tabella Pre-Iscrizioni / Sala d'Attesa (Pre-Inscriptions)
    CREATE TABLE IF NOT EXISTS pre_inscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scuola_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        parent_first_name VARCHAR(100) NOT NULL,
        parent_last_name VARCHAR(100) NOT NULL,
        parent_email VARCHAR(255) NOT NULL,
        parent_phone VARCHAR(50),
        parent_fiscal_code VARCHAR(16),
        parent_address VARCHAR(200),
        students JSONB NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        assigned_class VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_pre_inscriptions_scuola ON pre_inscriptions(scuola_id);
    CREATE INDEX IF NOT EXISTS idx_pre_inscriptions_status ON pre_inscriptions(status);

    -- 4. Tabella Certificati Medici (Medical Certificates)
    CREATE TABLE IF NOT EXISTS certificati_medici (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        alunno_id UUID NOT NULL REFERENCES alunni(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        giorni_coperti DATE[] DEFAULT '{}',
        caricato_da UUID NOT NULL REFERENCES auth.users(id),
        note TEXT,
        creato_il TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_certificati_medici_alunno ON certificati_medici(alunno_id);

    -- 5. Tabella Template Certificati (Certificati ODT Templates)
    CREATE TABLE IF NOT EXISTS certificati_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scuola_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        file_name VARCHAR(255),
        file_path TEXT,
        uploaded_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_certificati_templates_scuola ON certificati_templates(scuola_id);

    -- Abilitazione RLS
    ALTER TABLE forms_templates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE forms_submissions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE pre_inscriptions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE certificati_medici ENABLE ROW LEVEL SECURITY;
    ALTER TABLE certificati_templates ENABLE ROW LEVEL SECURITY;

    -- Policy RLS
    DROP POLICY IF EXISTS "Moduli accessibili a tutti" ON forms_templates;
    DROP POLICY IF EXISTS "Sottomissioni accessibili a tutti" ON forms_submissions;
    DROP POLICY IF EXISTS "Pre-iscrizioni accessibili a tutti" ON pre_inscriptions;
    DROP POLICY IF EXISTS "Certificati medici accessibili a tutti" ON certificati_medici;
    DROP POLICY IF EXISTS "Certificati templates accessibili a tutti" ON certificati_templates;

    CREATE POLICY "Moduli accessibili a tutti" ON forms_templates FOR ALL USING (true);
    CREATE POLICY "Sottomissioni accessibili a tutti" ON forms_submissions FOR ALL USING (true);
    CREATE POLICY "Pre-iscrizioni accessibili a tutti" ON pre_inscriptions FOR ALL USING (true);
    CREATE POLICY "Certificati medici accessibili a tutti" ON certificati_medici FOR ALL USING (true);
    CREATE POLICY "Certificati templates accessibili a tutti" ON certificati_templates FOR ALL USING (true);
  `;

  const { error } = await supabase.rpc('exec_sql', { sql });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}

export const POST = withRoute('admin/apply-fase4-migration:POST', async (request: Request) => {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  const q = parseQuery(request, querySchema);
  if ('response' in q) return q.response;
  try {
    const result = await runMigration();
    return NextResponse.json(result);
  } catch (error) {
    logErrore({ operazione: 'admin/apply-fase4-migration:POST', stato: 500 }, error);
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
});

export const GET = withRoute('admin/apply-fase4-migration:GET', async (request: Request) => {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  const q = parseQuery(request, querySchema);
  if ('response' in q) return q.response;
  try {
    const result = await runMigration();
    return NextResponse.json(result);
  } catch (error) {
    logErrore({ operazione: 'admin/apply-fase4-migration:GET', stato: 500 }, error);
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
});
