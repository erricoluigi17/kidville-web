import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export async function GET() {
  const supabase = await createAdminClient();
  
  // Get staff from utenti (adults table not in public schema)
  const { data: staff, error } = await supabase
    .from('utenti')
    .select('id, first_name, last_name, nome, cognome, ruolo, email')
    .in('ruolo', ['maestra', 'educator', 'admin', 'coordinator', 'coordinatore'])
    .order('cognome');
    
  return NextResponse.json({ 
    staff: staff?.map(u => ({
      id: u.id,
      first_name: u.first_name || u.nome,
      last_name: u.last_name || u.cognome,
      role: u.ruolo,
      email: u.email
    })), 
    staffError: error?.message 
  });
}
