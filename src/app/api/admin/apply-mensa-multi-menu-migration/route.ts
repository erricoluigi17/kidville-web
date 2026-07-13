import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sealDangerous } from '@/lib/security/seal';
import { createAdminClient } from '@/lib/supabase/server-client';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const querySchema = z.object({}); // nessun parametro in ingresso

const steps_sql = [
  {
    label: 'CREATE mensa_menu_config',
    sql: `CREATE TABLE IF NOT EXISTS public.mensa_menu_config (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id  UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
      nome       TEXT NOT NULL,
      ordine     INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  },
  {
    label: 'CREATE mensa_class_menu_assignment',
    sql: `CREATE TABLE IF NOT EXISTS public.mensa_class_menu_assignment (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id      UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
      classe         TEXT NOT NULL,
      menu_config_id UUID NOT NULL REFERENCES public.mensa_menu_config(id) ON DELETE CASCADE,
      attivo_dal     DATE NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )`,
  },
  {
    label: 'INDEX mensa_class_menu_assignment',
    sql: `CREATE INDEX IF NOT EXISTS idx_mensa_class_menu_scuola_classe
      ON public.mensa_class_menu_assignment(scuola_id, classe, attivo_dal DESC)`,
  },
  {
    label: 'ALTER mensa_menu_rotazione ADD menu_config_id',
    sql: `ALTER TABLE public.mensa_menu_rotazione
      ADD COLUMN IF NOT EXISTS menu_config_id UUID REFERENCES public.mensa_menu_config(id) ON DELETE SET NULL`,
  },
  {
    label: 'ALTER mensa_menu_override ADD menu_config_id',
    sql: `ALTER TABLE public.mensa_menu_override
      ADD COLUMN IF NOT EXISTS menu_config_id UUID REFERENCES public.mensa_menu_config(id) ON DELETE SET NULL`,
  },
  {
    label: 'DROP old unique constraint on rotazione',
    sql: `ALTER TABLE public.mensa_menu_rotazione
      DROP CONSTRAINT IF EXISTS mensa_menu_rotazione_scuola_id_settimana_giorno_settimana_key`,
  },
  {
    label: 'CREATE partial unique index rotazione legacy (NULL)',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_rot_legacy
      ON public.mensa_menu_rotazione(scuola_id, settimana, giorno_settimana)
      WHERE menu_config_id IS NULL`,
  },
  {
    label: 'CREATE partial unique index rotazione multi-menu',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_rot_menu
      ON public.mensa_menu_rotazione(scuola_id, menu_config_id, settimana, giorno_settimana)
      WHERE menu_config_id IS NOT NULL`,
  },
  {
    label: 'DROP old unique constraint on override',
    sql: `ALTER TABLE public.mensa_menu_override
      DROP CONSTRAINT IF EXISTS mensa_menu_override_scuola_id_data_key`,
  },
  {
    label: 'CREATE partial unique index override legacy (NULL)',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_ovr_legacy
      ON public.mensa_menu_override(scuola_id, data)
      WHERE menu_config_id IS NULL`,
  },
  {
    label: 'CREATE partial unique index override multi-menu',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_ovr_menu
      ON public.mensa_menu_override(scuola_id, menu_config_id, data)
      WHERE menu_config_id IS NOT NULL`,
  },
  {
    label: 'RLS mensa_menu_config',
    sql: `ALTER TABLE public.mensa_menu_config ENABLE ROW LEVEL SECURITY`,
  },
  {
    label: 'RLS mensa_class_menu_assignment',
    sql: `ALTER TABLE public.mensa_class_menu_assignment ENABLE ROW LEVEL SECURITY`,
  },
  {
    label: 'POLICY mensa_menu_config SELECT',
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'mensa_menu_config' AND policyname = 'mensa_menu_config_select'
      ) THEN
        CREATE POLICY mensa_menu_config_select ON public.mensa_menu_config FOR SELECT USING (true);
      END IF;
    END $$`,
  },
  {
    label: 'POLICY mensa_class_menu_assignment SELECT',
    sql: `DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'mensa_class_menu_assignment' AND policyname = 'mensa_class_menu_assignment_select'
      ) THEN
        CREATE POLICY mensa_class_menu_assignment_select ON public.mensa_class_menu_assignment FOR SELECT USING (true);
      END IF;
    END $$`,
  },
];

async function runMigration() {
  const supabase = await createAdminClient();
  const results: { label: string; ok: boolean; error?: string }[] = [];

  for (const { label, sql } of steps_sql) {
    const { error } = await supabase.rpc('exec_sql', { sql });
    results.push({ label, ok: !error, error: error?.message });
  }

  return {
    success: results.every(r => r.ok),
    results,
  };
}

export const GET = withRoute('admin/apply-mensa-multi-menu-migration:GET', async (request: Request) => {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  const q = parseQuery(request, querySchema);
  if ('response' in q) return q.response;
  try {
    const result = await runMigration();
    return NextResponse.json(result);
  } catch (error) {
    logErrore({ operazione: 'admin/apply-mensa-multi-menu-migration:GET', stato: 500 }, error);
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
});

export const POST = withRoute('admin/apply-mensa-multi-menu-migration:POST', async (request: Request) => {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;
  const q = parseQuery(request, querySchema);
  if ('response' in q) return q.response;
  try {
    const result = await runMigration();
    return NextResponse.json(result);
  } catch (error) {
    logErrore({ operazione: 'admin/apply-mensa-multi-menu-migration:POST', stato: 500 }, error);
    return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
  }
});
