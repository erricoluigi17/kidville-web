import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { getGenitoriDiAlunni } from '@/lib/anagrafiche/legami';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

// Nessun parametro in ingresso: schema vuoto (rispetta il lock zod-coverage admin).
const getQuerySchema = z.object({});

// GET /api/admin/chat/contacts
// Elenco genitori (utenti con login) con un figlio, per avviare una chat
// segreteria↔genitore. Il figlio serve come student_id del thread. Solo staff.
export const GET = withRoute('admin/chat/contacts:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;
  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;

  try {
    const supabase = await createAdminClient();
    // Si parte dagli ALUNNI, non da `legame_genitori_alunni`: i legami arrivano
    // dall'unione runtime + anagrafica (`student_parents` via ponte
    // `parents.auth_user_id`), come già fa il gemello `/api/chat/contacts` lato
    // docente. Con la sola tabella runtime la Segreteria non poteva aprire una
    // conversazione con i genitori arrivati dal form pubblico: semplicemente non
    // comparivano in elenco.
    //
    // Isolamento per sede. `requireStaff` verifica il RUOLO, non il tenant, e la
    // route gira in service-role: senza questo filtro la Segreteria di Giugliano
    // riceveva nome, cognome e classe di TUTTI i bambini delle tre sedi e dei loro
    // genitori, con la chat già apribile. La correzione del 2026-07-29 aveva
    // toccato il GEMELLO `/api/chat/contacts` (lato docente), non questa.
    // Fail-closed: nessun plesso ⇒ `.in(…, [])` ⇒ nessun contatto.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user);
    const { data: alunni, error } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione')
      .in('scuola_id', plessi);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const righeAlunni = alunni ?? [];
    if (righeAlunni.length === 0) return NextResponse.json({ success: true, data: [] });

    const perAlunno = await getGenitoriDiAlunni(supabase, righeAlunni.map((a) => a.id as string));
    const genitoreIds = [...new Set([...perAlunno.values()].flat())];
    if (genitoreIds.length === 0) return NextResponse.json({ success: true, data: [] });

    const { data: utenti } = await supabase
      .from('utenti')
      .select('id, nome, cognome')
      .in('id', genitoreIds)
      .eq('ruolo', 'genitore');
    const uMap = new Map((utenti ?? []).map((u) => [u.id, u]));

    const seen = new Set<string>();
    const contatti: { parentUserId: string; parentName: string; studentId: string; studentName: string; classe: string | null }[] = [];
    for (const a of righeAlunni) {
      for (const genitoreId of perAlunno.get(a.id as string) ?? []) {
        if (seen.has(genitoreId)) continue;
        const u = uMap.get(genitoreId);
        if (!u) continue; // solo genitori con account di login
        seen.add(genitoreId);
        contatti.push({
          parentUserId: u.id,
          parentName: `${u.cognome ?? ''} ${u.nome ?? ''}`.trim() || '—',
          studentId: a.id as string,
          studentName: `${a.nome ?? ''} ${a.cognome ?? ''}`.trim(),
          classe: (a.classe_sezione as string | null) ?? null,
        });
      }
    }
    contatti.sort((x, y) => x.parentName.localeCompare(y.parentName));

    return NextResponse.json({ success: true, data: contatti });
  } catch (err) {
    logErrore({ operazione: 'admin/chat/contacts:GET', stato: 500 }, err);
    const msg = err instanceof Error ? err.message : 'Errore interno';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
