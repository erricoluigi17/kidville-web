import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { sealDangerous } from '@/lib/security/seal';
import { parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  // Sostituisce il 400 manuale 'userId obbligatorio'; usato come uuid nelle query.
  userId: zUuid,
});

export async function GET(request: Request) {
  const sealed = await sealDangerous(request);
  if (sealed) return sealed;

  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;
  const { userId } = q.data;

  const supabase = await createAdminClient();

  const [
    { data: utente },
    { data: legami },
    { data: alunni },
    { data: tickets },
  ] = await Promise.all([
    supabase.from('utenti').select('id, nome, cognome, ruolo, role').eq('id', userId).maybeSingle(),
    supabase.from('legame_genitori_alunni').select('genitore_id, alunno_id').eq('genitore_id', userId),
    supabase.from('alunni').select('id, nome, cognome, classe_sezione, scuola_id').limit(10),
    supabase.from('ticket_mensa').select('alunno_id, saldo_ticket').limit(10),
  ]);

  return NextResponse.json({
    userId,
    utente,
    legami: legami ?? [],
    alunni_disponibili: alunni ?? [],
    ticket_mensa: tickets ?? [],
  });
}
