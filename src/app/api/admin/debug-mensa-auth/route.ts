import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export async function GET(request: Request) {
  const supabase = await createAdminClient();
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId') || '33333333-3333-3333-3333-333333333333';

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
