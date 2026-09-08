import type { MotivoAbbinamentoOrdinante } from './ordinante-genitore'

// =============================================================================
// LA PROPOSTA D'INTESTATARIO — un motore solo per la singola e per il lotto
//
// `GET /api/pagamenti/fattura/anteprima` calcola, per ogni pagamento, CHI ha
// fatto il bonifico e a quale genitore corrisponde (`componiIntestatarioPagamento`
// → `riconosciOrdinante`). L'emissione singola usa quella proposta per
// preselezionare l'intestatario; il lotto la buttava via due volte — il suo tipo
// non la conteneva nemmeno, e il corpo dell'emissione non aveva il campo — e
// scartava le righe dicendo «manca l'intestatario».
//
// Le condizioni per cui una proposta è utilizzabile vivono QUI, in un modulo
// puro, e non in due copie. Non stanno in `ordinante-genitore.ts` perché quello è
// il riconoscitore puro e non conosce la forma dell'anteprima; non stanno in
// `lotto-fatture.ts` perché `FatturaButton` finirebbe per importare il motore del
// LOTTO per emettere UNA fattura.
//
// PORTATA REALE, misurata in produzione il 2026-09-07 — e va scritta, perché il
// numero che stava nel codice («dei 130 pagamenti saldati uno solo ha un
// intestatario risolvibile») oggi è falso:
//   · 156  pagamenti saldati in attesa di fattura
//   ·  11  hanno un movimento di riconciliazione confermato con un ordinante
//   ·   8  sono già emettibili senza alcuna proposta (`intestatario_fatture`)
//   ·   6  li sblocca SOLO la proposta
//   · 145  non hanno alcun movimento confermato: non compaiono nemmeno in lista,
//          ed è lì che sta il collo di bottiglia vero, che questo modulo non tocca
// =============================================================================

/** I motivi che sappiamo spiegare a parole. Un motivo muto non si propone. */
export const MOTIVI_NOTI: readonly MotivoAbbinamentoOrdinante[] = [
  'bonifico_esatto',
  'sottoinsieme_unico',
  'sottoinsieme_scheda',
  'sottoinsieme_famiglia',
] as const

/**
 * Una frase per ciascun motivo, e non è ridondanza: con un messaggio solo,
 * l'interfaccia direbbe «è l'intestatario sulla scheda del bambino» anche quando
 * la scheda non c'entra — cioè mentirebbe a chi sta per confermare un documento
 * fiscale.
 *
 * ⚠️ `Record<MotivoAbbinamentoOrdinante, string>` è ESAUSTIVO di proposito: un
 * quinto motivo aggiunto in `ordinante-genitore.ts` diventa un errore di
 * compilazione qui, dove va scritta la frase che lo spiega. Con una copia locale
 * dei quattro nomi, `tsc` resterebbe verde e a schermo la proposta sparirebbe in
 * silenzio.
 */
export const CHIAVE_MOTIVO_PROPOSTA: Record<MotivoAbbinamentoOrdinante, string> = {
  bonifico_esatto: 'fatBtn_int_proposta_bonifico_esatto',
  sottoinsieme_unico: 'fatBtn_int_proposta_sottoinsieme_unico',
  sottoinsieme_scheda: 'fatBtn_int_proposta_sottoinsieme_scheda',
  sottoinsieme_famiglia: 'fatBtn_int_proposta_sottoinsieme_famiglia',
}

/** Un candidato, per la sola parte che decide se la proposta si può usare. */
export interface CandidatoPerProposta {
  adult_id?: string | null
  nome?: string | null
  fatturabile?: boolean | null
}

/** Una quota, per la sola parte che decide se la riga entra nel lotto. */
export interface QuotaPerProposta {
  fatturabile?: boolean | null
}

/**
 * Il blocco `intestatario` dell'anteprima, LARGO di proposito: quel blocco è
 * fail-open per progetto e può arrivare degradato. Chi assumesse la forma piena
 * emetterebbe sulla fede di un campo mai calcolato.
 */
export interface AnteprimaConProposta {
  quote?: QuotaPerProposta[] | null
  ripartito?: boolean | null
  candidati?: CandidatoPerProposta[] | null
  proposta?: { adult_id?: string | null; motivo?: string | null } | null
  ordinante?: string | null
}

/** Ciò che una proposta utilizzabile dice: chi, perché, e con quale nome. */
export interface PropostaUsabile {
  adult_id: string
  motivo: MotivoAbbinamentoOrdinante
  nome: string
}

/**
 * La proposta si può usare? Sono le stesse quattro condizioni con cui l'emissione
 * singola preseleziona l'intestatario, e non una loro parafrasi.
 *
 * ⚠️ NESSUN ripiego su `candidati[0]`. Se l'id proposto non è fra i candidati,
 * un ripiego sul primo intesterebbe la fattura alla persona sbagliata in
 * SILENZIO: si preferisce nessuna proposta.
 *
 * Il motivo si valida a RUNTIME contro `MOTIVI_NOTI` e non solo col tipo: fra il
 * server e il browser c'è un `JSON.parse`, e un `Record` totale non può essere
 * falsy per nessun valore del tipo — ma può esserlo per una stringa arrivata da
 * fuori.
 */
export function propostaApplicabile(a: AnteprimaConProposta | null | undefined): PropostaUsabile | null {
  const p = a?.proposta
  if (!p?.adult_id || !p.motivo) return null
  if (!(MOTIVI_NOTI as readonly string[]).includes(p.motivo)) return null
  if (!(a?.ordinante ?? '').trim()) return null

  const candidato = (a?.candidati ?? []).find((c) => c?.adult_id === p.adult_id)
  if (!candidato) return null

  return { adult_id: p.adult_id, motivo: p.motivo as MotivoAbbinamentoOrdinante, nome: candidato.nome ?? '' }
}

/**
 * La proposta si può usare SENZA che nessuno la guardi, cioè dentro un lotto?
 *
 * Due condizioni in più rispetto alla singola, e ognuna replica una guardia che
 * la singola ha e il lotto non avrebbe:
 *
 *  · `ripartito` — con i genitori separati la ripartizione esiste perché ciascuno
 *    riceva il documento per la propria quota, e un documento unico cancella la
 *    detrazione dell'altro. La singola non manda mai un intestatario su un
 *    pagamento ripartito; il server risponde 409 comunque.
 *  · il proposto dev'essere `fatturabile` — la singola preseleziona anche un
 *    proposto incompleto, mostra l'avviso e BLOCCA «Emetti». Nel lotto non c'è
 *    nessuno che legga quell'avviso: senza questa condizione una riga verrebbe
 *    dichiarata «pronta» e poi respinta dall'emissione, cioè si spenderebbe un
 *    colpo di quota per scoprire ciò che si sapeva già.
 */
export function intestatarioAutomaticoDelLotto(a: AnteprimaConProposta | null | undefined): PropostaUsabile | null {
  if (a?.ripartito === true) return null
  const p = propostaApplicabile(a)
  if (!p) return null
  const candidato = (a?.candidati ?? []).find((c) => c?.adult_id === p.adult_id)
  return candidato?.fatturabile === true ? p : null
}

/**
 * «L'app sa CHI ha pagato, ma a quella persona non si può intestare una fattura»
 * — cioè: pagatore riconosciuto, dati fiscali incompleti.
 *
 * Serve al pannello del lotto per scegliere la FRASE di una riga che non è entrata,
 * e non decide nessun documento: «Manca l'intestatario» e «i suoi dati non bastano»
 * mandano l'operatore in due posti diversi, e la prima è falsa qui.
 *
 * ⚠️ SI COMPONE COL MOTORE, non si riscrive: è vero esattamente quando la proposta
 * è applicabile ma il lotto la rifiuta lo stesso. Escluso il caso `ripartito`, che
 * ha una frase sua e va detto prima, l'unica causa rimasta è il proposto non
 * fatturabile. Una copia locale di quella condizione direbbe la frase sbagliata il
 * giorno in cui `intestatarioAutomaticoDelLotto` ne aggiunge una terza.
 */
export function propostaBloccataDaiDati(a: AnteprimaConProposta | null | undefined): boolean {
  if (a?.ripartito === true) return false
  return propostaApplicabile(a) !== null && intestatarioAutomaticoDelLotto(a) === null
}
