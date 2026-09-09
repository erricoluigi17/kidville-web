import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { assertAlunnoInScope } from '@/lib/auth/scope';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';
import { firmaAllegatiChat } from '@/lib/chat/allegati';
import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit';

// GET /api/admin/chat/messages?thread_id=
// Messaggi di un thread in SOLA LETTURA per la supervisione della segreteria
// (nessun mark-read, nessuna scrittura). Riservata allo staff.
const getQuerySchema = z.object({
  thread_id: zUuid,
});

export const GET = withRoute('admin/chat/messages:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request);
  if (auth.response) return auth.response;
  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;

  try {
    const supabase = await createAdminClient();

    // Isolamento per sede. `thread_id` è un uuid preso dalla richiesta: senza
    // questa verifica bastava conoscerlo per leggere il CONTENUTO di una
    // conversazione fra un genitore e una maestra di un'altra sede. Qui il gate è
    // anche il filtro — il thread è identificato da un uuid, non da un nome, e
    // l'omonimia non c'entra: verificato l'alunno del thread, la query per
    // `thread_id` non può portare dentro nient'altro.
    const { data: thread } = await supabase
      .from('chat_threads')
      .select('student_id')
      .eq('id', q.data.thread_id)
      .maybeSingle();
    if (!thread) return NextResponse.json({ error: 'Conversazione non trovata' }, { status: 404 });
    const alunnoId = thread.student_id as string;

    const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunnoId);
    if (fuoriScope) {
      // Un tentativo su una conversazione di un'altra sede si REGISTRA: il gate
      // ha già identificato la persona, ed è esattamente ciò che un registro
      // serve a far vedere. Qui non è bloccante — si sta già negando.
      await registraAccessoVigilanza(supabase, {
        operatore: auth.user,
        azione: 'lettura',
        esito: 'fuori-scope',
        threadId: q.data.thread_id,
        alunnoId,
        request,
      });
      return fuoriScope;
    }

    // La sede del bambino si legge ADESSO e si scrive nel registro: se domani
    // viene trasferito, quella riga deve continuare a dire dove stava quando è
    // stata letta. `assertAlunnoInScope` l'ha già letta ma non la restituisce,
    // e una seconda lettura puntuale su chiave primaria costa meno che allargare
    // la firma di un guard usato da mezzo progetto.
    const { data: alunno } = await supabase
      .from('alunni')
      .select('scuola_id')
      .eq('id', alunnoId)
      .maybeSingle();

    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, sender_id, content, attachment_url, attachment_type, created_at')
      .eq('thread_id', q.data.thread_id)
      .order('created_at', { ascending: true });
    if (error) {
      // PostgREST non lancia: ritorna `{ error }`. Il `catch` sotto non scatta
      // mai su questo ramo, quindi la riga di log va emessa qui (AGENTS §7).
      logErrore({ operazione: 'admin/chat/messages:GET', stato: 500, evento: 'db' }, error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // ── Il registro PRIMA della risposta, e bloccante ────────────────────────
    // La vigilanza è silenziosa per decisione del titolare (2026-09-09): i due
    // interlocutori non vedono nulla. Questa riga è l'unico contrappeso, quindi
    // se non si riesce a scriverla il contenuto NON esce. Costa un round-trip su
    // una schermata di supervisione, non su un percorso operativo — e rende
    // «ho letto ma non risulta» impossibile invece che improbabile.
    const { tracciato } = await registraAccessoVigilanza(supabase, {
      operatore: auth.user,
      azione: 'lettura',
      threadId: q.data.thread_id,
      alunnoId,
      scuolaId: (alunno?.scuola_id as string | null) ?? null,
      nMessaggi: (data ?? []).length,
      request,
    });
    if (!tracciato) {
      return NextResponse.json(
        {
          error: 'La lettura non si è potuta registrare: la conversazione non è stata aperta.',
          codice: 'VIGILANZA_NON_TRACCIABILE',
        },
        { status: 503 },
      );
    }

    // In tabella c'è il PERCORSO nel bucket privato (S32): anche la supervisione
    // riceve un link firmato a tempo, generato dietro a questo gate.
    const messaggi = await firmaAllegatiChat(supabase, data ?? [], 'admin/chat/messages:GET');
    return NextResponse.json({ success: true, data: messaggi });
  } catch (err) {
    logErrore({ operazione: 'admin/chat/messages:GET', stato: 500 }, err);
    const msg = err instanceof Error ? err.message : 'Errore interno';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
