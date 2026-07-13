import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// GET /api/admin/chat/threads?teacher_id=&parent_id=&classe=
// Vista di supervisione (sola lettura) di TUTTE le conversazioni genitore↔insegnante,
// arricchite e filtrabili per insegnante, genitore, classe. Riservata allo staff.
const getQuerySchema = z.object({
  teacher_id: zUuid.optional(),
  parent_id: zUuid.optional(),
  classe: z.string().optional(),
});

interface Named { id: string; nome: string }
function dedupById(items: (Named | null)[]): Named[] {
  const map = new Map<string, Named>();
  for (const it of items) if (it && !map.has(it.id)) map.set(it.id, it);
  return [...map.values()];
}

export const GET = withRoute('admin/chat/threads:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;
  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;

  try {
    const supabase = await createAdminClient();
    let query = supabase.from('chat_threads').select('*').order('last_message_at', { ascending: false });
    if (q.data.teacher_id) query = query.eq('teacher_id', q.data.teacher_id);
    if (q.data.parent_id) query = query.eq('parent_id', q.data.parent_id);
    const { data: threads, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = threads ?? [];
    const userIds = [...new Set(rows.flatMap((t) => [t.teacher_id, t.parent_id]).filter(Boolean))];
    const studentIds = [...new Set(rows.map((t) => t.student_id).filter(Boolean))];

    const [{ data: utenti }, { data: alunni }] = await Promise.all([
      userIds.length ? supabase.from('utenti').select('id, nome, cognome, ruolo, role').in('id', userIds) : Promise.resolve({ data: [] }),
      studentIds.length ? supabase.from('alunni').select('id, nome, cognome, classe_sezione').in('id', studentIds) : Promise.resolve({ data: [] }),
    ]);
    const uMap = new Map((utenti ?? []).map((u) => [u.id, u]));
    const aMap = new Map((alunni ?? []).map((a) => [a.id, a]));

    const nome = (u?: { nome?: string | null; cognome?: string | null }) =>
      `${u?.cognome ?? ''} ${u?.nome ?? ''}`.trim() || '—';

    let enriched = rows.map((t) => {
      const teacher = uMap.get(t.teacher_id);
      const parent = uMap.get(t.parent_id);
      const student = aMap.get(t.student_id);
      return {
        id: t.id,
        last_message_at: t.last_message_at,
        teacher: teacher ? { id: teacher.id, nome: nome(teacher), ruolo: teacher.role || teacher.ruolo } : null,
        parent: parent ? { id: parent.id, nome: nome(parent) } : null,
        student: student ? { nome: `${student.nome ?? ''} ${student.cognome ?? ''}`.trim(), classe: student.classe_sezione as string | null } : null,
      };
    });

    if (q.data.classe) enriched = enriched.filter((t) => t.student?.classe === q.data.classe);

    const filtri = {
      docenti: dedupById(enriched.map((t) => t.teacher)),
      genitori: dedupById(enriched.map((t) => t.parent)),
      classi: [...new Set(enriched.map((t) => t.student?.classe).filter(Boolean))],
    };

    return NextResponse.json({ success: true, data: enriched, filtri });
  } catch (err) {
    logErrore({ operazione: 'admin/chat/threads:GET', stato: 500 }, err);
    const msg = err instanceof Error ? err.message : 'Errore interno';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
