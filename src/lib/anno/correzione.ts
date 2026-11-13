import { z } from 'zod'

/**
 * LA CORREZIONE DI UN ANNO CHIUSO, dal lato della richiesta (PR 4.9, compito 4.9.3).
 *
 * Su un anno `chiuso` la Direzione e la segreteria possono scrivere solo registrando una CORREZIONE: un gettone che vale una
 * transazione, legato a chi lo chiede e a un MOTIVO. Il flusso a due tempi:
 *
 *   1. la richiesta parte senza `correzione`; la route risponde 409 `ANNO_CHIUSO` con `correzione_possibile: true` (solo allo staff,
 *      e solo se la route sa chiedere il gettone: lo dice il lock `anno-correzione-wiring`);
 *   2. la schermata apre il dialogo «Registra come correzione», la persona scrive il perché, e la STESSA richiesta riparte con
 *      `correzione: { motivo }` nel corpo. La route lo passa a `resolveAnnoScrittura({ correzione })`.
 *
 * ⚠️ Il motivo è testo libero: sta nella riga di `correzioni_anno_chiuso` e basta. Mai in un log, mai in un messaggio d'errore,
 * mai in una query string (nel corpo, perché una URL finisce nei log di chiunque stia in mezzo).
 *
 * Il file è usato anche dal browser (le costanti del motivo): nessun import di `next/server`.
 */

/** Meno di così non è un motivo: «ok», «x» e «correzione» (9) passano la lunghezza ma non la soglia di una frase. */
export const MOTIVO_CORREZIONE_MIN = 8
export const MOTIVO_CORREZIONE_MAX = 500

/** Il pezzo di corpo che porta la correzione. `.trim()` prima del controllo: gli spazi non fanno lunghezza. */
export const zCorrezione = z.object({
  motivo: z
    .string()
    .trim()
    .min(MOTIVO_CORREZIONE_MIN, `Il motivo deve avere almeno ${MOTIVO_CORREZIONE_MIN} caratteri`)
    .max(MOTIVO_CORREZIONE_MAX, `Il motivo può avere al massimo ${MOTIVO_CORREZIONE_MAX} caratteri`),
})

export type Correzione = z.infer<typeof zCorrezione>

/**
 * Il corpo di un 409 `ANNO_CHIUSO` che la schermata può trasformare in una correzione. `etichetta` (es. «2026/27») è l'anno che si
 * sta correggendo, quando la route lo sa: serve al dialogo per dire quale anno si sta toccando.
 */
export type RispostaCorrezionePossibile = {
  error: string
  codice: 'ANNO_CHIUSO'
  correzione_possibile: true
  etichetta?: string
}

/**
 * Un corpo che non porta `correzione` valida (troppo corta, troppo lunga, non è testo) diventa 400 con codice `MOTIVO_OBBLIGATORIO`
 * (lo fa `validationError`, che riconosce il percorso `correzione`): le route con `zCorrezione` nello schema non hanno bisogno di altro.
 * Mai l'eco del motivo nella risposta.
 */

/** Il 409 dice «si può correggere»? Lo guarda la schermata (`useCorrezioneAnno`) e lo prova il test del contratto. */
export function eCorrezionePossibile(stato: number, corpo: unknown): corpo is RispostaCorrezionePossibile {
  if (stato !== 409 || typeof corpo !== 'object' || corpo === null) return false
  const c = corpo as Record<string, unknown>
  return c.codice === 'ANNO_CHIUSO' && c.correzione_possibile === true
}

/** L'etichetta del 409, se è testo non vuoto: altrimenti `undefined` (il dialogo dice «un anno già chiuso»). */
export function etichettaDelRifiuto(corpo: RispostaCorrezionePossibile): string | undefined {
  return typeof corpo.etichetta === 'string' && corpo.etichetta.trim() !== '' ? corpo.etichetta : undefined
}
