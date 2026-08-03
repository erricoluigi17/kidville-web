import { getSupabase } from '@/lib/supabase/browser-client';
import { impostaBadgeNonLette } from '@/lib/native/badge';
import { impostaBiometria } from '@/lib/native/biometric';
import { svuotaCacheLocale } from '@/lib/offline/pulizia-cache';
import { unregisterNativePush } from '@/lib/push/native-register';

// Logout lato client (modello ibrido: sessione Supabase via cookie + identità
// applicativa in localStorage + cookie server-side ruolo/sedi). doLogout():
//  0) DEREGISTRA la push nativa di questo dispositivo (server + listener)
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
//
// ─────────────────────────────────────────────────────────────────────────────
// PERCHÉ LA PUSH È IL PASSO 0, E NON UNO QUALSIASI FRA GLI ALTRI.
//
// Il difetto (collaudo 2026-08-03, T17-F1): la deregistrazione del token nativo
// era agganciata all'OPT-IN — il bottone «promemoria» in area pagamenti — e non
// alla SESSIONE. Chi usciva dall'app restava iscritto: `push_subscriptions`
// conservava la riga con il suo `utente_id`, e il diario, i messaggi e le
// comunicazioni sui suoi figli continuavano ad arrivare sulla schermata di blocco
// di quel telefono. Su un dispositivo venduto, restituito o passato di mano sono
// dati di un minore consegnati a chi non è più autorizzato a riceverli — e non
// c'è nessuna azione, dentro l'app, che l'utente potesse fare per fermarli, visto
// che per spegnere l'opt-in bisogna prima rientrare.
//
// L'ORDINE È IL FIX, non un dettaglio: `DELETE /api/push/subscribe` passa da
// `requireUser`, cioè dai cookie `sb-*`. Chiamata DOPO `auth.signOut()`
// risponderebbe 401 e la riga resterebbe esattamente dov'era — un fix che sembra
// esserci e non c'è. Per questo il passo 0 sta prima anche di `/api/auth/logout`:
// nessuna riga di questa funzione può insinuarsi fra la deregistrazione e la
// sessione che la autorizza.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_KEYS = [
  'kv_user_id',
  'kv_user_role',
  'kv_parent_id',
  'kv_student_id',
  'kv_teacher_id',
];

export async function doLogout(): Promise<void> {
  try {
    // PRIMA di chiudere la sessione: vedi il blocco qui sopra. Su web è un no-op
    // puro (la push web resta gestita dal service worker e dal suo opt-in).
    await unregisterNativePush();
  } catch {
    /* ignore: non lancia già di suo, e comunque l'uscita non dipende da lei */
  }
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
