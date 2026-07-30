import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { schemaAssente } from '@/lib/news/schema-assente';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';

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
    // Isolamento per sede. `chat_threads` non ha `scuola_id`, ma `student_id` è FK
    // verso `alunni` che ce l'ha: la sede si deriva dal join, e NON serve una
    // migrazione. Senza questo filtro la supervisione mostrava a qualunque
    // segreteria TUTTE le conversazioni genitore↔docente delle tre sedi, coi nomi
    // dei minori e la loro classe. `!inner` perché il filtro sulla risorsa
    // embedded scarti davvero la riga padre; scope vuoto ⇒ nessun thread.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user);
    let query = supabase
      .from('chat_threads')
      .select('*, alunni!inner(scuola_id)')
      .in('alunni.scuola_id', plessi)
      .order('last_message_at', { ascending: false });
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

    // Sospensioni ATTIVE (C5 §2) in UNA sola query batched `thread_id IN (...)` —
    // MAI una query per-thread (sarebbe un N+1). Vista Direzione: il `motivo`
    // (testo libero) è mostrato in chiaro perché è uno strumento interno di
    // moderazione, non un log. Degrada pulito sul DB E2E CI non migrato.
    const threadIds = [...new Set(rows.map((t) => t.id as string).filter(Boolean))];
    const sospMap = new Map<string, { sospesaIl: string; sospesaDa: string; motivo: string | null }>();
    if (threadIds.length > 0) {
      const { data: sosp, error: sospErr } = await supabase
        .from('conversazioni_sospensioni')
        .select('thread_id, sospesa_da, motivo, sospesa_il')
        .in('thread_id', threadIds)
        .is('riaperta_il', null);
      if (sospErr) {
        // Tabella assente = nessuna sospensione. Un errore vero si logga (senza
        // PII) ma NON fa fallire la supervisione: degrada a "nessuna".
        if (!schemaAssente(sospErr)) {
          logEvento('chat', 'error', { operazione: 'admin/chat/threads:GET', esito: 'sospensioni-lettura-fallita' }, sospErr);
        }
      } else {
        for (const s of sosp ?? []) {
          sospMap.set(s.thread_id as string, {
            sospesaIl: s.sospesa_il as string,
            sospesaDa: s.sospesa_da as string,
            motivo: (s.motivo as string | null) ?? null,
          });
        }
      }
    }

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
        sospensione: sospMap.get(t.id as string) ?? null,
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
