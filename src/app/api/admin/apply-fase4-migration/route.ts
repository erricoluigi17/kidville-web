import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealDangerous } from '@/lib/security/seal';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

const querySchema = z.object({}); // nessun parametro in ingresso

/**
 * ⚠️ Questo SQL non è più la copia fedele di
 * `supabase/migrations_archive/20260526_fase4_modulistica_legal.sql`, e la differenza è
 * voluta: il 2026-08-16 ne sono usciti DUE blocchi interi — il **punto 5**, la tabella dei
 * modelli di certificato che alimentava una linguetta-mockup, e il **punto 3**, la tabella
 * delle pre-iscrizioni della «Sala d'Attesa». Di entrambi se n'è andata la macchina per
 * intero: CREATE, indici, RLS e la policy aperta a tutti.
 *
 * Nessuna delle due esiste in produzione (`to_regclass` → null, 0 oggetti in qualunque
 * schema con qualunque `relkind`, misurato il 2026-08-16), quindi non c'è nessun `DROP` da
 * applicare da nessuna parte: l'unico posto dove esistevano ancora era questo file. I due
 * pannelli che le avrebbero usate sono stati smontati lo stesso giorno — le domande di
 * iscrizione si leggono da «Moduli ricevuti», la carta intestata vera arriva dal motore dei
 * Prestampati (`src/lib/carta/`).
 *
 * Il punto 3 andava tolto per un motivo in più: ricreava una tabella destinata a nome,
 * cognome, email, telefono, codice fiscale e indirizzo del genitore, più i dati dei figli,
 * con una `CREATE POLICY … FOR ALL USING (true)` — leggibile e scrivibile da chiunque. Che
 * questa route sia sigillata (`sealDangerous` → 404 fuori da vitest) la rende inerte, non
 * innocua: «inerte» era la stessa identica difesa dell'altro blocco, e non è bastata a
 * giustificarne la permanenza.
 *
 * I numeri dei blocchi restano quelli dell'archivio — 1, 2, 4 — perché servono a ritrovarli
 * là, non a contarli qui.
 *
 * I nomi esatti delle due tabelle, e il perché per esteso, stanno nel lock di architettura
 * che sorveglia questa pulizia, e non qui: il criterio è che un `grep` su `src/` non ne
 * trovi più traccia, e una riga di commento sarebbe una traccia.
 *
 * Chi rimettesse uno dei due blocchi «per riallineare con l'archivio» disferebbe la pulizia:
 * la fonte di verità dello storico è l'archivio, non questa route, che non gira in nessun
 * ambiente.
 */
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

    -- Abilitazione RLS
    ALTER TABLE forms_templates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE forms_submissions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE certificati_medici ENABLE ROW LEVEL SECURITY;

    -- Policy RLS
    DROP POLICY IF EXISTS "Moduli accessibili a tutti" ON forms_templates;
    DROP POLICY IF EXISTS "Sottomissioni accessibili a tutti" ON forms_submissions;
    DROP POLICY IF EXISTS "Certificati medici accessibili a tutti" ON certificati_medici;

    CREATE POLICY "Moduli accessibili a tutti" ON forms_templates FOR ALL USING (true);
    CREATE POLICY "Sottomissioni accessibili a tutti" ON forms_submissions FOR ALL USING (true);
    CREATE POLICY "Certificati medici accessibili a tutti" ON certificati_medici FOR ALL USING (true);
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
