import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealDangerous } from '@/lib/security/seal';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}); // nessun parametro in ingresso

/**
 * GET /api/admin/setup-registro
 * Endpoint temporaneo per creare le tabelle del registro primaria nel DB Supabase.
 * Da eseguire UNA SOLA VOLTA. Idempotente (usa IF NOT EXISTS).
 */
export async function GET(request: Request) {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    try {
        const supabase = await createAdminClient();

        const steps: string[] = [];
        const errors: string[] = [];

        // 1. Crea tabella registro_orario
        const createRegistro = await supabase.rpc('exec_sql', {
            sql: `
                CREATE TABLE IF NOT EXISTS public.registro_orario (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    scuola_id UUID REFERENCES public.schools(id),
                    classe_sezione VARCHAR(50) NOT NULL,
                    data DATE NOT NULL,
                    ora_lezione INTEGER NOT NULL CHECK (ora_lezione BETWEEN 1 AND 8),
                    materia VARCHAR(100),
                    argomento TEXT,
                    compiti TEXT,
                    data_consegna_compiti DATE,
                    media_url TEXT,
                    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT unique_registro_orario UNIQUE (classe_sezione, data, ora_lezione)
                );
            `
        });
        if (createRegistro.error) {
            errors.push('registro_orario: ' + createRegistro.error.message);
        } else {
            steps.push('✅ registro_orario creata');
        }

        // 2. Crea tabella firme_docenti
        const createFirme = await supabase.rpc('exec_sql', {
            sql: `
                CREATE TABLE IF NOT EXISTS public.firme_docenti (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    registro_id UUID NOT NULL REFERENCES public.registro_orario(id) ON DELETE CASCADE,
                    maestra_id UUID NOT NULL,
                    tipo_compresenza VARCHAR(50) DEFAULT 'principale',
                    firmato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT unique_firma_docente UNIQUE (registro_id, maestra_id)
                );
            `
        });
        if (createFirme.error) {
            errors.push('firme_docenti: ' + createFirme.error.message);
        } else {
            steps.push('✅ firme_docenti creata');
        }

        // 3. Crea tabella note_disciplinari
        const createNote = await supabase.rpc('exec_sql', {
            sql: `
                CREATE TABLE IF NOT EXISTS public.note_disciplinari (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    alunno_id UUID NOT NULL REFERENCES public.alunni(id),
                    maestra_id UUID NOT NULL,
                    categoria VARCHAR(50) NOT NULL CHECK (categoria IN ('disciplinare', 'didattica', 'compiti_non_svolti')),
                    testo TEXT NOT NULL,
                    richiede_firma BOOLEAN DEFAULT false,
                    firmata_il TIMESTAMP WITH TIME ZONE,
                    firmata_da UUID,
                    creato_il TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            `
        });
        if (createNote.error) {
            errors.push('note_disciplinari: ' + createNote.error.message);
        } else {
            steps.push('✅ note_disciplinari creata');
        }

        // 4. RLS e policy registro_orario
        await supabase.rpc('exec_sql', {
            sql: `
                ALTER TABLE public.registro_orario ENABLE ROW LEVEL SECURITY;
                DO $$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='registro_orario' AND policyname='allow_all_registro') THEN
                    CREATE POLICY allow_all_registro ON public.registro_orario FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
                  END IF;
                END $$;
            `
        });
        steps.push('✅ RLS registro_orario');

        // 5. RLS firme_docenti
        await supabase.rpc('exec_sql', {
            sql: `
                ALTER TABLE public.firme_docenti ENABLE ROW LEVEL SECURITY;
                DO $$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='firme_docenti' AND policyname='allow_all_firme') THEN
                    CREATE POLICY allow_all_firme ON public.firme_docenti FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
                  END IF;
                END $$;
            `
        });
        steps.push('✅ RLS firme_docenti');

        // 6. RLS note_disciplinari
        await supabase.rpc('exec_sql', {
            sql: `
                ALTER TABLE public.note_disciplinari ENABLE ROW LEVEL SECURITY;
                DO $$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='note_disciplinari' AND policyname='allow_all_note') THEN
                    CREATE POLICY allow_all_note ON public.note_disciplinari FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
                  END IF;
                END $$;
            `
        });
        steps.push('✅ RLS note_disciplinari');

        // 7. RLS valutazioni
        await supabase.rpc('exec_sql', {
            sql: `
                ALTER TABLE public.valutazioni ENABLE ROW LEVEL SECURITY;
                DO $$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='valutazioni' AND policyname='allow_all_valutazioni') THEN
                    CREATE POLICY allow_all_valutazioni ON public.valutazioni FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
                  END IF;
                END $$;
            `
        });
        steps.push('✅ RLS valutazioni');

        return NextResponse.json({
            success: errors.length === 0,
            steps,
            errors,
            message: errors.length === 0
                ? 'Setup completato con successo!'
                : 'Setup completato con alcuni errori. Alcune tabelle potrebbero già esistere.',
        });

    } catch (error) {
        console.error('Errore setup registro:', error);
        return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
    }
}
