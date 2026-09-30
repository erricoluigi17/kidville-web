/**
 * GLI ESITI DELLA PUSH CHE POSSONO GUARIRE DA SOLI — un elenco, non tre copie.
 *
 * ─── PERCHÉ ESISTE (revisione di qualità, 2026-09-30) ───────────────────────────
 *
 * `plugin_error` era classificato in due modi opposti a due metri di distanza:
 * `NativePushAutoRegister` lo trattava come RITENTABILE — un bridge che non ha risposto può
 * rispondere al giro dopo — e riprovava da sé; `PushOptIn`, sullo stesso esito, diceva
 * all'utente «non è stato possibile» senza invitarlo a riprovare. Due copie di un elenco
 * scritte a mano in due file: hanno detto la stessa cosa finché qualcuno non ne ha toccata una.
 *
 * ─── PERCHÉ IN UN MODULO PROPRIO, E NON IN `native-register.ts` ─────────────────
 *
 * Perché quello è il modulo che ogni test della push MOCKA (`vi.mock('@/lib/push/native-register', …)`),
 * e un mock elenca a mano ciò che espone: una costante nuova lì dentro arriva `undefined` a
 * chi la importa, e il test si rompe per una ragione che non ha niente a che vedere con ciò
 * che sta misurando. Un modulo senza dipendenze non viene mockato da nessuno, quindi l'elenco
 * resta uno anche sotto i finti.
 *
 * ─── COSA NON È RITENTABILE, e perché ──────────────────────────────────────────
 *
 *  · `permission_denied`: è una scelta dell'utente. Si cambia dalle Impostazioni di sistema,
 *    non riprovando — e `registerNativePush` con il permesso negato esce prima del dialogo,
 *    quindi «riprova» sarebbe l'invito a un gesto che non può riuscire.
 *  · `plugin_unavailable`: il plugin non è nel binario. È un difetto di build: serve un
 *    aggiornamento dell'app, non un secondo tentativo.
 *  · `not_native`: non è un errore, è il sito nel browser.
 */

/** Gli errori di `registerNativePush` che vale la pena riprovare. */
export const ERRORI_PUSH_RITENTABILI: ReadonlySet<string> = new Set([
  // Il bridge ha risposto male una volta: può rispondere bene la prossima.
  'plugin_error',
  // APNs/FCM non hanno chiamato né `registration` né `registrationError` entro il tetto.
  'registration_timeout',
  // Il POST a `/api/push/subscribe` non è andato: rete, 5xx, o la finestra dei ritentativi.
  'subscribe_failed',
])

/** `true` se vale la pena riprovare l'esito di `registerNativePush`. */
export function esitoPushRitentabile(errore: string | undefined): boolean {
  return errore !== undefined && ERRORI_PUSH_RITENTABILI.has(errore)
}

/**
 * LO STATO HTTP CHE VALE LA PENA RIPROVARE, e l'unica eccezione dichiarata.
 *
 * La regola di partenza è quella del canale dei log (`ritentabile` in `@/lib/logging/client`):
 * **5xx, 429, 408**. Un 4xx ordinario no: quel corpo il server lo rifiuterà sempre.
 *
 * ⚠️ L'ECCEZIONE È IL **503** DI `/api/push/subscribe`, e non è un capriccio: quella route
 * risponde 503 per dire «VAPID non configurato», cioè una configurazione mancante sul server.
 * Non guarisce riprovando — guarisce quando qualcuno imposta le chiavi. Dirgli «riprova fra
 * qualche istante» sarebbe la stessa classe di bugia che questo compito è nato per chiudere.
 * Chi ha uno 503 che significa «riprova più tardi» (un vero sovraccarico) non passa da qui.
 */
export function statoHttpRitentabile(stato: number): boolean {
  if (stato === 503) return false
  return stato >= 500 || stato === 429 || stato === 408
}
