import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';

// GET /api/admin/chat/contacts
// Elenco genitori (utenti con login) con un figlio, per avviare una chat
// segreteria↔genitore. Il figlio serve come student_id del thread. Solo staff.
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;

  try {
    const supabase = await createAdminClient();
    const { data: legami, error } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id, alunno_id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = legami ?? [];
    const genitoreIds = [...new Set(rows.map((l) => l.genitore_id).filter(Boolean))];
    const alunnoIds = [...new Set(rows.map((l) => l.alunno_id).filter(Boolean))];
    if (genitoreIds.length === 0) return NextResponse.json({ success: true, data: [] });

    const [{ data: utenti }, { data: alunni }] = await Promise.all([
      supabase.from('utenti').select('id, nome, cognome').in('id', genitoreIds).eq('ruolo', 'genitore'),
      alunnoIds.length ? supabase.from('alunni').select('id, nome, cognome, classe_sezione').in('id', alunnoIds) : Promise.resolve({ data: [] }),
    ]);
    const uMap = new Map((utenti ?? []).map((u) => [u.id, u]));
    const aMap = new Map((alunni ?? []).map((a) => [a.id, a]));

    const seen = new Set<string>();
    const contatti: { parentUserId: string; parentName: string; studentId: string; studentName: string; classe: string | null }[] = [];
    for (const l of rows) {
      if (seen.has(l.genitore_id)) continue;
      const u = uMap.get(l.genitore_id);
      if (!u) continue; // solo genitori con account di login
      seen.add(l.genitore_id);
      const a = aMap.get(l.alunno_id);
      contatti.push({
        parentUserId: u.id,
        parentName: `${u.cognome ?? ''} ${u.nome ?? ''}`.trim() || '—',
        studentId: l.alunno_id,
        studentName: a ? `${a.nome ?? ''} ${a.cognome ?? ''}`.trim() : '',
        classe: (a?.classe_sezione as string | null) ?? null,
      });
    }
    contatti.sort((x, y) => x.parentName.localeCompare(y.parentName));

    return NextResponse.json({ success: true, data: contatti });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
