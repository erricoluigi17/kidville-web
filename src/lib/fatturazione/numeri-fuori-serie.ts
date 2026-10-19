/**
 * Numeri di fattura che esistono su Aruba ma NON fanno da pavimento alla serie.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────
 * L'app prende il numero con `GREATEST(contatore, pavimento) + 1`, e il pavimento è il
 * numero più alto che Aruba conosce per quella serie e quell'anno: serve a rispettare i
 * documenti che la segreteria emette a mano dal pannello. Il rovescio è che UN documento
 * fuori app con il numero sbagliato sposta tutta la serie, per sempre.
 *
 * È successo il 16/10/2026: fra le 13:37 e le 14:46 (ora italiana) sul pannello è nata
 * «Asilo 2826/2026», con il numero della serie FPR, mentre la serie Asilo era a 2775. Il
 * tetto `SCARTO_MASSIMO_PAVIMENTO` (50) l'ha fermata per un numero solo — salto di 51 — e
 * da quel momento ogni fattura Asilo dell'app è rimasta ferma. Il titolare ha deciso di
 * stornarla con una nota di credito e di far riprendere la serie dal numero giusto.
 *
 * ─── COSA SIGNIFICA UNA VOCE QUI ────────────────────────────────────────────────
 * Due cose, e servono tutte e due:
 *  1. il documento NON conta nel pavimento letto da Aruba (`client.ts`), così la serie
 *     riprende dal contatore invece di saltarci sopra;
 *  2. il numero resta OCCUPATO: quando il contatore ci arriva, l'allocazione lo scavalca
 *     (`emissione.ts`), perché su Aruba e allo SdI quel numero c'è già e un secondo
 *     documento con lo stesso numero, nella stessa serie e nello stesso anno, non può
 *     esistere.
 *
 * ⚠️ Un elenco nel codice, e non una tabella, di proposito: ogni voce è una decisione
 * contabile presa da una persona, e deve passare da una revisione. Non ci sono dati
 * personali: solo serie, anno e numero.
 *
 * Funzioni PURE, come `sezionale.ts`: niente I/O, niente log, niente orologio.
 */
import type { Sezionale } from '@/lib/fatturazione/sezionale'

export interface NumeroFuoriSerie {
  sezionale: Sezionale
  anno: number
  numero: number
  /** Perché è qui: quando è nato, chi l'ha deciso, con quale documento è stato stornato. */
  motivo: string
}

export const NUMERI_FUORI_SERIE: readonly NumeroFuoriSerie[] = Object.freeze([
  {
    sezionale: 'Asilo',
    anno: 2026,
    numero: 2826,
    motivo:
      'emessa dal pannello Aruba il 16/10/2026 con un numero della serie FPR (Asilo era a 2775); ' +
      'stornata con nota di credito nella serie Asilo su decisione del titolare (19/10/2026)',
  },
])

/** Vero se quel numero, in quella serie e in quell'anno, va tenuto fuori dalla serie. */
export function numeroFuoriSerie(sezionale: Sezionale, anno: number, numero: number): boolean {
  return NUMERI_FUORI_SERIE.some((v) => v.sezionale === sezionale && v.anno === anno && v.numero === numero)
}
