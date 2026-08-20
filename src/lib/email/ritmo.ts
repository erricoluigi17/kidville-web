/**
 * IL PASSO FRA DUE EMAIL — uno solo, e per una ragione che è cambiata.
 *
 * ─── PERCHÉ NON SONO PIÙ 550 ms ─────────────────────────────────────────────
 * Fino al 2026-08-20 la pausa era 550 ms in tre file e 500 nel digest, con lo
 * stesso commento copiato quattro volte: «~2 al secondo, che è il limite del
 * provider». Era vero sul piano Resend **Free**: 100 email al giorno e ~2
 * richieste al secondo.
 *
 * Dal 2026-08-20 il piano è **Pro**: nessun tetto giornaliero, 50.000 email al
 * mese, e un limite di RITMO — **10 richieste al secondo per team** (verificato
 * sulla documentazione Resend il 2026-08-20; alzabile su richiesta).
 *
 * 150 ms sono ~6,7 al secondo: due terzi di quel che si può. Il terzo che resta
 * non è prudenza generica, è **per chi non fa parte di questo giro**. Il limite è
 * PER TEAM: una candidatura che arriva mentre l'import sta spedendo, un codice
 * OTP, il digest del 1° settembre attingono alla stessa cordata. Un 429 preso da
 * noi lo paga qualcun altro — e in `copia-alla-sede.ts` un 429 significa la
 * copia di una candidatura che nessuna sede vedrà mai.
 *
 * ─── ⚠️ NON È IL COLLO DI BOTTIGLIA, E CREDERLO PORTA FUORI STRADA ──────────
 * Misurato in produzione il 2026-08-20 sull'inoltro arretrato delle candidature,
 * che spedisce **senza nessuna pausa**: 50 email in 57,2 secondi, cioè **1.167 ms
 * per email**. La chiamata a Resend, da sola, ne pesa ~356. Gli altri ~800 sono
 * le chiamate al database che stanno attorno a ogni invio.
 *
 * Quindi: stringere questa pausa non fa uscire quasi niente in più, e allargarla
 * non è ciò che rallenta. Chi vuole un giro più veloce guardi il numero di
 * chiamate per destinatario, non questo numero.
 */
export const PAUSA_FRA_EMAIL_MS = 150

/**
 * La pausa, come funzione.
 *
 * Esiste perché i test possano contarla e sostituirla senza aspettare davvero, e
 * perché il ritmo resti UNO: un `setTimeout` scritto a mano accanto a un invio è
 * il modo in cui le quattro copie di prima sono nate.
 */
export async function pausaFraEmail(): Promise<void> {
  await new Promise((r) => setTimeout(r, PAUSA_FRA_EMAIL_MS))
}
