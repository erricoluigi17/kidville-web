import { getSupabase } from '@/lib/supabase/browser-client';
import { impostaBadgeNonLette } from '@/lib/native/badge';
import { impostaBiometria } from '@/lib/native/biometric';
import { svuotaCacheLocale } from '@/lib/offline/pulizia-cache';

// Logout lato client (modello ibrido: sessione Supabase via cookie + identità
// applicativa in localStorage + cookie server-side ruolo/sedi). doLogout():
//  1) azzera i cookie server-side (kv-active-role, sedi_attive) via /api/auth/logout
//  2) chiude la sessione Supabase (rimuove i cookie sb-*)
//  3) azzera il badge dell'icona: il conteggio è dell'utente che sta uscendo
//  4) spegne l'opt-in biometrico: il gate non deve armarsi sopra il login
//  5) svuota la cache di lettura offline (dati di minori sul dispositivo)
//  6) ripulisce l'identità applicativa persistita in localStorage
//  7) riporta al login (hard navigation: nessuno stato client residuo)
// Ogni passo è best-effort: un fallimento non deve impedire l'uscita.
//
// I passi 3-5 sono TUTTI prima del redirect, con `await`, e non è un dettaglio
// di stile: `window.location.href` cancella qualunque lavoro in volo, quindi un
// `void impostaBadgeNonLette(0)` lascerebbe sull'icona il numero dell'utente
// precedente esattamente come prima del fix.

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
    await impostaBadgeNonLette(0);
  } catch {
    /* ignore: il badge è cosmetico, l'uscita no */
  }
  try {
    // `impostaBiometria(false)` e NON la chiave dentro LOCAL_KEYS: quella lista
    // è l'identità, l'opt-in è una preferenza con un modulo proprietario.
    // Duplicare qui la stringa 'kv_biometric_optin' creerebbe due fonti di
    // verità, e il giorno in cui la chiave venisse rinominata il logout
    // smetterebbe di spegnerla IN SILENZIO — cioè di nuovo un utente chiuso
    // fuori dalla schermata di login, che è il difetto appena corretto.
    impostaBiometria(false);
  } catch {
    /* ignore */
  }
  try {
    await svuotaCacheLocale();
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
