import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireUser } from '@/lib/auth/require-staff';
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami';
import { persistSignedSubmission } from '@/lib/forms/persist-submission';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { staffScuola, scuolaUnicaReale } from '@/lib/notifiche/destinatari';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

// ─── Schemi di validazione input (M3/M4) ─────────────────────────────────────
// L'identità viene dal gate (requireUser): il `parent_id` legacy in query/body
// è ignorato, nessun fallback demo (M4).

// student_id opzionale: stringa vuota trattata come assente
// (persistSignedSubmission fa già `student_id || null`).
const zStudentIdOpzionale = z.preprocess(
  (v) => (v === '' ? undefined : v),
  zUuid.nullish()
);

const postBodySchema = z.object({
  form_id: zUuid,
  student_id: zStudentIdOpzionale,
  // answers è un pass-through jsonb: oggi è accettato qualsiasi valore truthy.
  answers: z.unknown().refine((v) => !!v, 'form_id e risposte obbligatori'),
  // is_signed è già coercito a boolean (`!!is_signed`) in persistSignedSubmission.
  is_signed: z.coerce.boolean().optional(),
  signature_log: z.unknown().optional(),
});

const getQuerySchema = z.object({});

// POST: Sottoscrive e firma un modulo
export const POST = withRoute('parent/submissions:POST', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;

    const b = await parseBody(request, postBodySchema);
    if ('response' in b) return b.response;
    const { form_id, student_id, answers, is_signed, signature_log } = b.data;

    const supabase = await createAdminClient();

    // IDOR: un genitore può sottomettere (e auto-aggiornare l'anagrafica) solo su
    // un PROPRIO figlio. student_id assente = onboarding (ammesso).
    if (student_id && auth.user.role === 'genitore' && !(await genitoreHasFiglio(supabase, auth.user.id, student_id))) {
      return NextResponse.json({ error: 'Accesso negato' }, { status: 403 });
    }

    const result = await persistSignedSubmission(supabase, {
      form_id,
      parent_id: auth.user.id,
      student_id,
      answers: answers as Record<string, unknown>,
      is_signed,
      signature_log,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Notifica alla segreteria: modulo firmato ricevuto (best-effort).
    try {
      let scuolaId: string | null = null;
      if (student_id) {
        const { data: alunno } = await supabase.from('alunni').select('scuola_id').eq('id', student_id).maybeSingle();
        scuolaId = (alunno?.scuola_id as string | undefined) ?? null;
      }
      if (!scuolaId) scuolaId = auth.user.scuola_id ?? (await scuolaUnicaReale(supabase));
      const destinatari = await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'segreteria']);
      const { data: tpl } = await supabase.from('forms_templates').select('title').eq('id', form_id).maybeSingle();
      await notificaEvento(supabase, {
        tipo: 'modulo_compilato',
        scuolaId,
        utenteIds: destinatari,
        titolo: 'Modulo compilato ricevuto',
        corpo: `Ci sono nuove compilazioni per «${(tpl as { title?: string } | null)?.title ?? 'un modulo'}».`,
        link: '/admin/modulistica',
        entitaTipo: 'forms_template',
        entitaId: form_id,
        bufferMin: 60,
        debounce: true,
      });
    } catch (e) {
      // Il modulo è acquisito, ma la segreteria non saprà che è arrivato: notifica persa.
      logEvento('notifica', 'error', {
        operazione: 'parent/submissions:POST',
        tipo: 'modulo_compilato',
        esito: 'notifica_non_inviata',
      }, e);
    }

    return NextResponse.json(result.submission, { status: 201 });
  } catch (err) {
    logErrore({ operazione: 'parent/submissions:POST', stato: 500 }, err);
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
})

// GET: Recupera tutte le sottomissioni per l'archivio genitore
export const GET = withRoute('parent/submissions:GET', async (request: NextRequest) => {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;
    const parentId = auth.user.id;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;

    const supabase = await createAdminClient();

    // Query difensiva: niente embed annidato PostgREST (che dà 500 quando la
    // relazione FK non è riconosciuta) → base + arricchimento con query separate.
    const { data: subs, error } = await supabase
      .from('forms_submissions')
      .select('*')
      .eq('parent_id', parentId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (subs ?? []) as Record<string, unknown>[];
    const formIds = [...new Set(rows.map((s) => s.form_id).filter(Boolean))] as string[];
    const studentIds = [...new Set(rows.map((s) => s.student_id).filter(Boolean))] as string[];

    const [tplRes, alRes] = await Promise.all([
      formIds.length
        ? supabase.from('forms_templates').select('id, title, description').in('id', formIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
      studentIds.length
        ? supabase.from('alunni').select('id, nome, cognome').in('id', studentIds)
        : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    ]);

    const tById = new Map((tplRes.data ?? []).map((t: Record<string, unknown>) => [t.id, { title: t.title, description: t.description }]));
    const aById = new Map((alRes.data ?? []).map((a: Record<string, unknown>) => [a.id, { nome: a.nome, cognome: a.cognome }]));

    const enriched = rows.map((s) => ({
      ...s,
      forms_templates: s.form_id ? tById.get(s.form_id as string) ?? null : null,
      alunni: s.student_id ? aById.get(s.student_id as string) ?? null : null,
    }));

    return NextResponse.json(enriched);
  } catch (err) {
    logErrore({ operazione: 'parent/submissions:GET', stato: 500 }, err);
    const message = err instanceof Error && err.message ? err.message : 'Errore interno';
    return NextResponse.json({ error: message }, { status: 500 });
  }
})
