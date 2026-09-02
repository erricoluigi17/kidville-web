/**
 * L’OCCHIO CHE MOSTRA E NASCONDE UNA PASSWORD — una copia sola.
 *
 * ─── PERCHÉ È STATO ESTRATTO ────────────────────────────────────────────────
 *
 * Fino al 2026-09-01 questo disegno viveva dentro `src/app/auth/login/page.tsx`,
 * privato di quella schermata, e andava benissimo finché il campo password
 * dell’app era **uno**. Dal cambio password i campi diventano quattro (l’attuale,
 * la nuova e la sua ripetizione, più quello della login), e la scorciatoia ovvia —
 * ricopiare i due `path` nel componente nuovo — avrebbe prodotto la seconda copia
 * di un’icona: due disegni che il giorno del prossimo ritocco divergono, in due
 * schermate che l’utente vede a distanza di trenta secondi l’una dall’altra.
 *
 * È la stessa lezione già pagata dal generatore delle password temporanee (una
 * copia viveva in `scripts/` e continuava a produrre il vecchio formato) e dalle
 * regole della password (tre risposte diverse alla stessa domanda). Qui il costo
 * di evitarla è un file.
 *
 * ─── COSA C’È QUI E COSA NO ─────────────────────────────────────────────────
 *
 * Qui c’è SOLO il disegno. Il bottone che lo contiene resta di chi lo monta,
 * perché le due schermate hanno bersagli e vestiti diversi (la login ha il suo
 * `.eye` in CSS module, la card usa le utility) — ma la regola d’accessibilità è
 * la stessa e va ricordata dove si sbaglia:
 *
 * ⚠️ IL NOME DEL BOTTONE NON CAMBIA CON LO STATO. Si dichiara un `aria-label`
 * FISSO che dice quale campo si sta scoprendo («Mostra la nuova password») e si
 * lascia raccontare lo stato ad `aria-pressed`. Un’etichetta che diventa
 * «Nascondi la password» quando il bottone è premuto fa annunciare a uno screen
 * reader «Nascondi la password, premuto» — cioè una doppia negazione, che è
 * l’unica lettura in cui l’utente non capisce se la password si vede o no. La
 * decisione è scritta anche accanto al bottone della login, dove è nata.
 *
 * Nessun `'use client'`: è una funzione che restituisce SVG, senza stato e senza
 * hook. Così può essere montata anche da un componente server, se un domani
 * servisse.
 */

/** L’occhio: aperto quando la password è nascosta, sbarrato quando è in chiaro. */
export function OcchioPassword({ off }: { off: boolean }) {
  return off ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a15.5 15.5 0 0 1-3 4M6.2 6.2C3.9 7.6 2.4 9.7 2 12c1 2.5 5 7 10 7a10 10 0 0 0 4.2-.9" />
      <path d="M9.5 9.6a3.4 3.4 0 0 0 4.9 4.7" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7s-9-4.5-10-7z" />
      <circle cx="12" cy="12" r="3.1" />
    </svg>
  )
}
