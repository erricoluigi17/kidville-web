import { mapStatoAruba } from '@/lib/aruba/stato'

// ─────────────────────────────────────────────────────────────────────────────
// «QUESTO DOCUMENTO È ANCORA VIVO?» — UNA DEFINIZIONE SOLA, PER DUE PORTE.
//
// La guardia «un bonifico non si fattura due volte» esiste perché la fattura si
// emette per `pagamento_id`, e la guardia contro il secondo documento
// (`emettiFatturaPagamento`) confronta le righe vive dello STESSO pagamento: non
// vede niente, quindi, quando è il BONIFICO a cambiare pagamento sotto di lei.
//
// Su quel riabbinamento si affacciano DUE rotte, e non è un'ipotesi — è lo stato
// «movimento riaperto» che `annulla_transazione_contabile`
// (`20260912180200_annulla_transazione_riapre_movimento.sql`) crea da un pulsante
// del registro, lasciando al movimento la memoria di ciò a cui era legato:
//   · `pagamenti/riconciliazione/[id]:PATCH` — la conferma a voce singola;
//   · `pagamenti/riconciliazione/[id]/componi:POST` — la composizione.
// Due definizioni di «viva» direbbero due cose diverse dello stesso documento:
// una fermerebbe e l'altra lascerebbe passare, e la seconda con un 200 sopra.
// Perciò la definizione sta qui, fuori da tutt'e due.
//
// ⚠️ AL 2026-09-13 LA SORELLA NON È ANCORA MIGRATA QUI, ed è deliberato:
// `[id]/route.ts` è chiusa e approvata in questo stesso branch e ne tiene una
// copia locale (`fatturaViva`, `etichettaFattura`, `RigaFattura`). Questo file è
// la sede NUOVA, non una seconda copia: chi tocca quella route la faccia
// importare da qui e cancelli le sue tre definizioni. Finché convivono, ciò che
// tiene onesta la copia non è la buona volontà ma il comportamento misurato dai
// due file di test delle rotte.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Una riga di `fatture_emesse` come la leggono le guardie del riabbinamento: il
 * minimo per dire se il documento è vivo e come si chiama.
 */
export interface RigaFatturaEmessa {
  numero: number
  /** L'anno del SEZIONALE di quella riga, che non è per forza quello di oggi. */
  anno: number | null
  sezionale: string | null
  sdi_stato: number | null
}

/**
 * Le righe VIVE: tutto ciò che non è uno scarto SDI (oggi 2, 4 e 9). È DERIVATO
 * da `mapStatoAruba`, non copiato — il giorno in cui Aruba aggiunge uno stato di
 * scarto il predicato lo segue da sé.
 *
 * Due ragioni, e sono opposte:
 *  · una riga SCARTATA si riemette, e chiuderle la strada renderebbe uno scarto
 *    definitivo;
 *  · una riga SENZA stato (rifiuto di trasporto) resta viva, perché nessuno sa
 *    se quel documento sia partito — e su un forse non si incassa due volte.
 */
export const fatturaViva = (r: Pick<RigaFatturaEmessa, 'sdi_stato'>): boolean =>
  !(r.sdi_stato != null && mapStatoAruba(r.sdi_stato).isScarto)

/**
 * Il numero di una fattura come si legge sul documento, a prova di riga storica.
 *
 * NON è `formattaNumeroFattura` di `@/lib/fatturazione/sezionale`, ed è una
 * scelta: quella LANCIA su un sezionale assente o su un anno fuori scala, perché
 * nasce per comporre il numero di un documento che sta per partire. Qui si sta
 * solo NOMINANDO una riga già a registro — magari una storica, senza sezionale —
 * e un'eccezione trasformerebbe un rifiuto parlante in un 500 muto.
 */
export function etichettaFattura(r: Pick<RigaFatturaEmessa, 'numero' | 'anno' | 'sezionale'>): string {
  const anno = r.anno ?? new Date().getFullYear()
  return r.sezionale ? `${r.sezionale} ${r.numero}/${anno}` : `${r.numero}/${anno}`
}
