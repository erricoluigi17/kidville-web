import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuolaScrittura } from '@/lib/auth/scope';
import { logScrittura } from '@/lib/audit/scrittura';
import { parseBody } from '@/lib/validation/http';
import { parseFamilyRow } from '@/lib/import/template';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// POST /api/admin/import/anagrafiche
// Body: { rows: [{ <intestazione italiana>: valore, ... }], scuola_id? }
// Il client parsa il foglio (xlsx/csv) → righe JSON; il server mappa, deduplica su
// CF e crea alunni + genitori + collegamenti (service-role, come le altre route admin).
const bodySchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).max(2000),
  scuola_id: z.string().optional(),
});

export const POST = withRoute('admin/import/anagrafiche:POST', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  const b = await parseBody(request, bodySchema);
  if ('response' in b) return b.response;

  try {
    const supabase = await createAdminClient();
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, b.data.scuola_id);
    if (sw.response) return sw.response;

    const families = b.data.rows.map(parseFamilyRow);
    let alunniCreati = 0;
    let genitoriCreati = 0;
    let legami = 0;
    const errori: { riga: number; messaggio: string }[] = [];

    for (let i = 0; i < families.length; i++) {
      const fam = families[i];
      if (!fam) continue;
      try {
        // 1. Alunno — dedup su codice_fiscale se presente.
        let studentId: string | null = null;
        if (fam.alunno.codice_fiscale) {
          const { data: existing } = await supabase
            .from('alunni')
            .select('id')
            .eq('codice_fiscale', fam.alunno.codice_fiscale)
            .maybeSingle();
          if (existing) studentId = existing.id;
        }
        if (!studentId) {
          const record = {
            scuola_id: sw.scuolaId,
            nome: fam.alunno.nome,
            cognome: fam.alunno.cognome,
            data_nascita: fam.alunno.data_nascita || null,
            gender: fam.alunno.sesso || null,
            codice_fiscale: fam.alunno.codice_fiscale || null,
            birth_city: fam.alunno.comune_nascita || null,
            birth_province: fam.alunno.provincia_nascita || null,
            residence_address: fam.alunno.indirizzo_residenza || null,
            residence_city: fam.alunno.comune_residenza || null,
            zip_code: fam.alunno.cap || null,
            // Il trigger DB sincronizza section_id da classe_sezione.
            classe_sezione: fam.alunno.classe_sezione || null,
            stato: 'iscritto',
          };
          const { data: created, error } = await supabase
            .from('alunni')
            .insert(record)
            .select('id')
            .single();
          if (error) throw new Error(`alunno: ${error.message}`);
          studentId = created.id;
          alunniCreati++;
        }

        // 2. Genitori — dedup su parents.fiscal_code; link student_parents.
        for (const gen of fam.genitori) {
          let parentId: string | null = null;
          if (gen.fiscal_code) {
            const { data: ep } = await supabase
              .from('parents')
              .select('id')
              .eq('fiscal_code', gen.fiscal_code)
              .maybeSingle();
            if (ep) parentId = ep.id;
          }
          if (!parentId) {
            const { data: np, error: pe } = await supabase
              .from('parents')
              .insert({
                first_name: gen.first_name,
                last_name: gen.last_name,
                fiscal_code: gen.fiscal_code || null,
                emails: gen.email ? [gen.email] : [],
                phone_numbers: gen.phone ? [gen.phone] : [],
                // `citizenship` conserva il ruolo (workaround esistente della codebase).
                citizenship: gen.role,
              })
              .select('id')
              .single();
            if (pe) throw new Error(`genitore ${gen.last_name}: ${pe.message}`);
            parentId = np.id;
            genitoriCreati++;
          }

          const { error: le } = await supabase.from('student_parents').upsert(
            {
              student_id: studentId,
              parent_id: parentId,
              relation_type: gen.role,
              is_primary: gen.role === 'mother' || gen.role === 'father',
            },
            { onConflict: 'student_id,parent_id', ignoreDuplicates: true },
          );
          if (le) throw new Error(`legame ${gen.last_name}: ${le.message}`);
          legami++;
        }
      } catch (err) {
        // +2: intestazione + indice 1-based → numero riga nel foglio.
        errori.push({ riga: i + 2, messaggio: (err as Error).message });
      }
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'import_anagrafiche',
      azione: 'insert',
      scuolaId: sw.scuolaId ?? null,
      valoreDopo: { alunniCreati, genitoriCreati, legami, errori: errori.length },
    });

    return NextResponse.json({
      ok: true,
      totale: families.filter(Boolean).length,
      alunniCreati,
      genitoriCreati,
      legami,
      errori,
    });
  } catch (err) {
    logErrore({ operazione: 'admin/import/anagrafiche:POST', stato: 500 }, err);
    const msg = err instanceof Error ? err.message : 'Errore interno';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
