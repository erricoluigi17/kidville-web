import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

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
    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, sender_id, content, attachment_url, attachment_type, created_at')
      .eq('thread_id', q.data.thread_id)
      .order('created_at', { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (err) {
    logErrore({ operazione: 'admin/chat/messages:GET', stato: 500 }, err);
    const msg = err instanceof Error ? err.message : 'Errore interno';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
