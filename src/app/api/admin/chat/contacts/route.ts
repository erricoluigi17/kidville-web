import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { getGenitoriDiAlunni } from '@/lib/anagrafiche/legami';
import { STATI_CON_CANALE_FAMIGLIA } from '@/lib/alunni/stato';
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
    // `scuola_id` nella proiezione: la rubrica lo MOSTRA quando le sedi attive
    // sono più d'una. Con «2 ANNI» presente in due plessi, `nome · classe` non
    // dice a quale famiglia si sta per scrivere.
    //
    // ─── SOLO ISCRITTI, ED È QUI CHE VA DETTO PERCHÉ ─────────────────────────
    // L'archiviazione di un alunno lo fa sparire dagli elenchi SGANCIANDOLO
    // dalla classe (`section_id` e `classe_sezione` a NULL), e quel gesto copre
    // le query per sezione — la maggioranza. Questa NON è una di quelle: legge
    // la SEDE INTERA, quindi un bambino archiviato continuerebbe a comparire in
    // rubrica con la sua famiglia, e la segreteria potrebbe aprire una chat
    // nuova con genitori che non hanno più un figlio iscritto.
    //
    // Il confine è `STATI_CON_CANALE_FAMIGLIA` (`@/lib/alunni/stato`), e non è
    // scritto qui: ⚠️ fino al 2026-08-13 questo commento diceva «si cambia
    // questa riga» mentre il gemello di `notifiche/destinatari.ts` diceva «si
    // cambia lì, in un posto solo». Non potevano essere veri entrambi, ed erano
    // sei copie della stessa regola.
    // ⚠️ Conseguenza CAMBIATA lo stesso giorno: `'sospeso'` è ora DENTRO il
    // confine. Escluderlo significava che la segreteria non poteva nemmeno
    // aprire una conversazione con la famiglia di un bambino che frequenta —
    // perché `LATO_DEL_CONFINE` lo classifica «ancora-iscritto», ed era l'unico
    // punto del prodotto a non crederci.
    const { data: alunni, error } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, scuola_id')
      .in('scuola_id', plessi)
      .in('stato', [...STATI_CON_CANALE_FAMIGLIA]);
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
    const contatti: { parentUserId: string; parentName: string; studentId: string; studentName: string; classe: string | null; scuolaId: string | null }[] = [];
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
          scuolaId: (a.scuola_id as string | null) ?? null,
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
