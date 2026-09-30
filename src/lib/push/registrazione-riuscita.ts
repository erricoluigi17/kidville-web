/**
 * «IL DISPOSITIVO È STATO REGISTRATO» — l'evento che lo dice a chi sta guardando altrove.
 *
 * ─── LA CORSA CHE CHIUDE (revisione finale del branch, 2026-09-30) ──────────────
 *
 * Al primo accesso nell'app due pezzi partono insieme: `NativePushAutoRegister`, montato nel
 * layout, chiede il permesso di sistema e registra il token; `AvvisoNotificheDocente`, nella
 * pagina, chiede quanti dispositivi ha il server. La seconda risposta arriva mentre la prima
 * è ancora in corso, quindi legge «zero dispositivi, permesso da chiedere» e mostra «Le
 * notifiche sono spente · Attiva». Poi la maestra tocca «Consenti», la registrazione riesce —
 * e l'avviso non lo sa: nessun evento lo raggiunge, e un `visibilitychange` entro trenta
 * secondi lo scarta la sua soglia. Restava a schermo, a dire il falso, finché non si usciva
 * dalla home.
 *
 * ─── PERCHÉ UN EVENTO `window`, e non uno stato condiviso ───────────────────────
 *
 * Perché i due vivono in alberi diversi (uno nel layout, uno nella pagina) e non hanno un
 * antenato comune che possa portare uno stato. È la stessa forma di `EVENTO_CHAT_LETTA` in
 * `src/components/features/chat/contatore-non-letti.ts`, per la stessa ragione.
 *
 * NEL DETTAGLIO NON VIAGGIA NIENTE: né il token, né la piattaforma, né quanti dispositivi
 * risultino adesso. Chi ascolta non deve decidere, deve RILEGGERE — il conteggio ce l'ha solo
 * il server, e un dettaglio qui sarebbe una seconda verità da tenere allineata.
 *
 * ⚠️ SI EMETTE SOLO A REGISTRAZIONE RIUSCITA. Su un tentativo fallito il conteggio non è
 * cambiato: un ricontrollo leggerebbe lo stesso zero di prima, e sarebbe traffico che non
 * cambia niente a schermo.
 *
 * Il modulo non ha dipendenze, e non è un caso: `@/lib/push/native-register` lo mockano tutti
 * i test della push con un `vi.mock` che elenca a mano ciò che espone, e una costante nuova
 * lì dentro arriva `undefined` a chi la importa (misurato: sette test rotti per questo).
 */

export const EVENTO_PUSH_REGISTRATA = 'kv:push-registrata'

/** Il token di questo dispositivo è sul server: chi mostra lo stato delle notifiche rilegga. */
export function segnalaPushRegistrata(): void {
  // Nessun `try`: `dispatchEvent` non rilancia le eccezioni di chi ascolta (finiscono in
  // `window.onerror`), quindi l'unico modo di fallire è non avere `window` — e quello si
  // guarda prima. Siamo nel ramo di SUCCESSO della registrazione: niente qui deve farlo fallire.
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EVENTO_PUSH_REGISTRATA))
}

/**
 * Ascolta le registrazioni riuscite. Restituisce la funzione che smette di ascoltare, da
 * chiamare allo smontaggio.
 */
export function ascoltaPushRegistrata(gestore: () => void): () => void {
  const suEvento = () => gestore()
  window.addEventListener(EVENTO_PUSH_REGISTRATA, suEvento)
  return () => window.removeEventListener(EVENTO_PUSH_REGISTRATA, suEvento)
}
