import { fatturaViva } from '@/lib/pagamenti/fattura-viva'
import { mapStatoAruba } from '@/lib/aruba/stato'

// ─────────────────────────────────────────────────────────────────────────────
// «LA FATTURA È PARTITA, MA NON È A REGISTRO?» — UN PREDICATO SOLO (CR1).
//
// Un pagamento resta `fattura_stato = 'in_attesa'` quando il documento è stato
// consegnato ad Aruba ma la riga di `fatture_emesse` non c'è (INSERT fallito
// dopo l'upload, oppure la sync ha scritto lo scarto e non il pagamento).
// Emettere di nuovo in quello stato manda allo SdI un SECONDO documento per lo
// stesso incasso: per questo il predicato ferma l'emissione con un 409.
//
// La forma è quella CASE del contratto (C0.3, C0.5 n. 7), e i due rami non sono
// intercambiabili:
//  · con `fattura_aruba_id` valorizzato conta SOLO la riga di QUEL file. Il file
//    scritto sul pagamento è quello della PRIMA quota riuscita (emissione.ts), e
//    una riga viva di un'altra quota non dice nulla su di lui; una riga SCARTATA
//    dello stesso file invece sì: lo scarto è registrato, e la ritrasmissione è
//    legittima (falso);
//  · con `fattura_aruba_id` nullo conta una riga VIVA qualsiasi (`fatturaViva`):
//    una riga senza stato SdI resta viva, perché nessuno sa se sia partita.
//
// 🔴 Fonte unica: il testo SQL qui sotto è il GEMELLO di questa funzione, e lo
// usano identico gli script (fatture-orfane, numerazione-serie), la coda (D2,
// `_fatture_coda_partita_non_registrata`) e il pre-controllo di D4. La parità
// fra i due lati è provata eseguendoli entrambi su PGlite, caso per caso
// (`__tests__/lib/pagamenti/fattura-partita-non-registrata.test.ts`, con i casi
// condivisi di `__tests__/fixtures/casi-partita-non-registrata.ts`).
// ─────────────────────────────────────────────────────────────────────────────

/** Specchio di ESITO_VOCE.partita_non_registrata (contratto-db.ts, PR-A). */
export const MOTIVO_PARTITA_NON_REGISTRATA = 'partita_non_registrata' as const

/**
 * Codici `sdi_stato` di scarto, RICAVATI dal motore Aruba e mai scritti a mano
 * (oggi 2, 4 e 9). Coincidono col WHERE di `fatture_emesse_pagamento_quota_uidx`:
 * il test lo prova leggendo la migrazione.
 */
export const CODICI_SDI_SCARTO_REGISTRO: readonly number[] = Object.freeze(
  Array.from({ length: 21 }, (_, c) => c).filter((c) => mapStatoAruba(c).isScarto),
)

/**
 * Gemello SQL, forma CASE di contratto C0.3. Alias obbligato: `p` = public.pagamenti.
 * Si usa come `... FROM public.pagamenti p WHERE <PREDICATO>`.
 *
 * In SQL `f.aruba_filename = p.fattura_aruba_id` con un filename nullo vale NULL
 * e la riga non conta; in TS lo stesso confronto con `null` dà falso: i due lati
 * coincidono.
 */
export const PREDICATO_SQL_PARTITA_NON_REGISTRATA =
  `p.fattura_stato = 'in_attesa' AND CASE ` +
  `WHEN p.fattura_aruba_id IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM public.fatture_emesse f ` +
  `WHERE f.pagamento_id = p.id AND f.aruba_filename = p.fattura_aruba_id) ` +
  `ELSE NOT EXISTS (SELECT 1 FROM public.fatture_emesse f ` +
  `WHERE f.pagamento_id = p.id AND (f.sdi_stato IS NULL OR f.sdi_stato <> ALL (ARRAY[${CODICI_SDI_SCARTO_REGISTRO.join(',')}]))) END`

/** Il minimo di una riga di `fatture_emesse` che serve al predicato. */
export interface RigaRegistroMinima {
  sdi_stato: number | null
  aruba_filename: string | null
}

/**
 * Vero se il pagamento è `in_attesa` e la sua fattura risulta partita verso
 * Aruba senza essere a registro (forma CASE di C0.3).
 *
 * @param righeRegistro TUTTE le righe di `fatture_emesse` del pagamento, in
 *   qualunque stato SdI: filtrarle prima (per esempio sulle sole vive) cambia
 *   l'esito del ramo col file.
 */
export function fatturaPartitaNonRegistrata(
  pag: { fattura_stato?: string | null; fattura_aruba_id?: string | null },
  righeRegistro: readonly RigaRegistroMinima[],
): boolean {
  if (pag.fattura_stato !== 'in_attesa') return false
  const file = pag.fattura_aruba_id
  // `!= null`, non la verità del valore: SQL tratta la stringa vuota come NOT
  // NULL, e un `if (file)` la manderebbe nell'altro ramo rompendo la parità.
  if (file != null) return !righeRegistro.some((r) => r.aruba_filename === file)
  return !righeRegistro.some(fatturaViva)
}
