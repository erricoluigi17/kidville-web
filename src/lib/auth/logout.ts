import { getSupabase } from '@/lib/supabase/browser-client';

// Logout lato client (modello ibrido: sessione Supabase via cookie + identità
// applicativa in localStorage + cookie server-side ruolo/sedi). doLogout():
//  1) azzera i cookie server-side (kv-active-role, sedi_attive) via /api/auth/logout
//  2) chiude la sessione Supabase (rimuove i cookie sb-*)
//  3) ripulisce l'identità applicativa persistita in localStorage
//  4) riporta al login (hard navigation: nessuno stato client residuo)
// Ogni passo è best-effort: un fallimento non deve impedire l'uscita.

const LOCAL_KEYS = [
  'kv_user_id',
  'kv_user_role',
  'kv_parent_id',
  'kv_student_id',
  'kv_teacher_id',
];

export async function doLogout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore: procedo comunque a chiudere la sessione */
  }
  try {
    await getSupabase().auth.signOut();
  } catch {
    /* ignore */
  }
  try {
    for (const k of LOCAL_KEYS) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
  // Hard navigation: scarta qualunque stato in memoria e rivaluta le guardie.
  window.location.href = '/auth/login';
}
