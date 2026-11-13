import { getSupabase } from '@/lib/supabase/browser-client';
import { impostaBadgeNonLette } from '@/lib/native/badge';
import { impostaBiometria } from '@/lib/native/biometric';
import { dimenticaTuttiIGradi } from '@/lib/auth/use-child-school-type';
import { svuotaCacheLocale } from '@/lib/offline/pulizia-cache';
import { unregisterNativePush } from '@/lib/push/native-register';
import { logClient, nomeErrore } from '@/lib/logging/client';

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

// Ogni passo è best-effort e FAIL-OPEN: un errore (di rete, di cache, perfino del logger) non impedisce mai di
// uscire. Ma non si butta via in silenzio (regole 6 e 7 di AGENTS.md): si scrive il PASSO e il CODICE dell'errore,
// mai il messaggio (può contenere email o altro). Il canale client conosce solo `warn` ed `error`: questi sono
// `warn`, perché l'uscita si completa comunque.
const CODICE_SICURO = /^[a-z][a-z0-9_]{0,63}$/;

function segnala(passo: string, errore: unknown): void {
  try {
    let codice = nomeErrore(errore);
    const c = (errore as { code?: unknown } | null)?.code;
    if (typeof c === 'string' && CODICE_SICURO.test(c)) codice = c;
    logClient({
      livello: 'warn',
      evento: 'accesso',
      messaggio: `uscita: passo non riuscito — passo=${passo} codice=${codice}`,
      route: '/logout',
    });
  } catch {
    // Il logger non rompe mai l'uscita (regola 9): qui si può solo tacere.
  }
}

export async function doLogout(): Promise<void> {
  try {
    // PRIMA di chiudere la sessione: vedi il blocco qui sopra. Su web è un no-op
    // puro (la push web resta gestita dal service worker e dal suo opt-in).
    await unregisterNativePush();
  } catch (e) {
    segnala('push', e); // non lancia già di suo, e comunque l'uscita non dipende da lei
  }
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    segnala('cookie', e); // procedo comunque a chiudere la sessione
  }
  try {
    // `scope: 'local'`: l'uscita chiude la sessione di QUESTO dispositivo e basta. Senza scope supabase-js usa
    // `'global'` e cancella le sessioni di quell'utente su TUTTI i dispositivi (visto nel collaudo del 13/11:
    // un «Esci» sull'iPhone ha buttato fuori anche Chrome). Decisione di Luigi del 13/11/2026.
    // `signOut` NON lancia: ritorna `{ error }`. Con `local` la revoca lato server è l'unica che resta, e se fallisce
    // (rete, 5xx) il refresh token resta vivo: si registra il codice. Lo stato locale lo toglie comunque.
    const { error } = await getSupabase().auth.signOut({ scope: 'local' });
    if (error) segnala('signOut', error);
  } catch (e) {
    segnala('signOut', e);
  }
  try {
    await impostaBadgeNonLette(0);
  } catch (e) {
    segnala('badge', e); // il badge è cosmetico, l'uscita no
  }
  try {
    // `impostaBiometria(false)` e NON la chiave dentro LOCAL_KEYS: quella lista
    // è l'identità, l'opt-in è una preferenza con un modulo proprietario.
    // Duplicare qui la stringa 'kv_biometric_optin' creerebbe due fonti di
    // verità, e il giorno in cui la chiave venisse rinominata il logout
    // smetterebbe di spegnerla IN SILENZIO — cioè di nuovo un utente chiuso
    // fuori dalla schermata di login, che è il difetto appena corretto.
    impostaBiometria(false);
  } catch (e) {
    segnala('biometria', e);
  }
  try {
    await svuotaCacheLocale();
  } catch (e) {
    segnala('cache', e);
  }
  try {
    for (const k of LOCAL_KEYS) window.localStorage.removeItem(k);
  } catch (e) {
    segnala('chiavi', e);
  }
  try {
    // Il grado di ogni figlio è memorizzato per dispositivo con una chiave a
    // SUFFISSO VARIABILE (`kv_grado_<uuid>`), quindi in `LOCAL_KEYS` — che è una
    // lista di nomi esatti — non può entrare. Si chiama la funzione del modulo
    // che possiede il prefisso, per la stessa ragione già scritta sopra per
    // `impostaBiometria(false)`: ricopiare qui la stringa farebbe due fonti di
    // verità, e a una rinomina il logout smetterebbe di ripulirla in silenzio.
    // Non è cosmetico: nel suffisso c'è l'uuid di un minore, e questi telefoni
    // e tablet passano di mano.
    dimenticaTuttiIGradi();
  } catch (e) {
    segnala('gradi', e);
  }
  // Hard navigation: scarta qualunque stato in memoria e rivaluta le guardie.
  window.location.href = '/auth/login';
}
