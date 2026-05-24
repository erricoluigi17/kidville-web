import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server-client';

export async function GET() {
  const supabase = await createAdminClient();
  
  // Get all adults
  const { data: adults, error } = await supabase
    .from('adults')
    .select('id, first_name, last_name, role')
    .order('first_name');
  
  // Also check author_id FK constraint - can we insert with a utenti user?
  const { data: utenti } = await supabase
    .from('utenti')
    .select('id, nome, cognome, first_name, last_name, ruolo, role')
    .limit(5);
    
  return NextResponse.json({ adults, adultsError: error?.message, utenti });
}
