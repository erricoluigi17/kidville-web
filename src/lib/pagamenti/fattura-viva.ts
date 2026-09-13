import { mapStatoAruba } from '@/lib/aruba/stato'

// ─────────────────────────────────────────────────────────────────────────────
// «QUESTO DOCUMENTO È ANCORA VIVO?» — UNA DEFINIZIONE SOLA, PER CINQUE POSTI.
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
// 🔑 E LE PORTE NON ERANO IL POSTO PIÙ CARO. La stessa domanda la facevano altre
// tre copie, tutte chiamate in modo diverso — `eViva`, `viveNonScartate`, e una
// condizione anonima dentro un `continue` — e tutte migrate qui il 2026-09-13:
//   · `pagamenti/riconciliazione:GET` — il chip «fatturata» del registro;
//   · `pagamenti/fattura:GET` — la consegna del PDF alla famiglia;
//   · `emissione.ts` (`viveNonScartate`) — LA GUARDIA DI IDEMPOTENZA, cioè quella
//     citata quattro righe più su come la ragione per cui questo file esiste.
// Finché quell'ultima copia viveva fuori di qui, questa testata prometteva
// un'unificazione che non c'era: la copia più cara delle cinque stava proprio
// nella riga che il testo addita. Una divergenza lì non è un chip sbagliato, è un
// SECONDO documento fiscale allo SDI per la stessa retta — e le fatture emesse
// sono WORM: non si annulla con un UPDATE, si corregge con una nota di variazione.
//
// ⚠️ UNA DELLE CINQUE COPIE NON ERA IDENTICA: quella della consegna del PDF
// passava da `Number(r.sdi_stato)`. Su una stringa come `'02'` le due forme
// DIVERGONO (`mapStatoAruba('02')` cade sul ramo difensivo, `Number('02')` trova
// lo scarto 2). Misurato il 2026-09-13 prima di unificarle:
// `fatture_emesse.sdi_stato` è `smallint` e PostgREST lo serializza come numero
// JSON non quotato, quindi quella stringa il database non la produce e il
// `Number()` era rumore. Se un giorno la colonna cambiasse tipo, la
// normalizzazione andrebbe aggiunta QUI, non in un chiamante.
//
// Che le cinque non tornino a divergere lo tiene — IN PARTE, e la parte va detta —
// il lock `__tests__/architecture/annullo-riapre-movimento.test.ts`. Sui file di
// tutt'e cinque vieta NEL CODICE (non nei nomi, che erano cinque diversi, e non nei
// commenti, che li nominano apposta) DUE forme sole: `mapStatoAruba`/`isScarto`, e i
// codici di scarto riscritti a mano in un letterale di array — quest'ultimo calcolato
// da `mapStatoAruba` mentre il test gira, non copiato, o il lock commetterebbe il
// peccato che vieta.
//
// ⚠️ COSA NON FERMA, misurato il 2026-09-13 e non dedotto: un modulo ponte che
// ri-esporti `(c) => mapStatoAruba(c).isScarto` sotto un altro nome, una lista
// importata da altrove, una catena `s === 2 || s === 4 || s === 9`. Fino a oggi qui
// c'era scritto che vietare la materia prima bastava «perché comunque la si chiami,
// una copia deve per forza passare di lì»: non è vero, e la copia che passava era la
// peggiore — quella scritta a mano, l'unica NON derivata. Il lock alza il prezzo di
// una copia; a renderla inutile è questa testata.
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
 *
 * 🔴 E NON È NEMMENO `numeroLeggibile` DI `pagamenti/riconciliazione:GET`, che le
 * somiglia moltissimo e sta nello stesso file che ORA importa questo modulo — cioè
 * a un passo da chi domani le trova quasi gemelle e le unisce. NON SI UNISCONO, e le
 * tre differenze sono misurate (2026-09-13): su sezionale `FPR` quella passa da
 * `formattaNumeroFattura`, che TRONCA l'anno a due cifre (`FPR 12/26`), mentre qui
 * si scrive `FPR 12/2026` — unirle cambierebbe il numero stampato di un documento
 * fiscale sulla lista dei movimenti, in silenzio; un sezionale sconosciuto lì viene
 * SCARTATO (`12/2026`) e qui TENUTO (`Boh 12/2026`); e lì un numero o un anno fuori
 * scala danno `null` (nessun chip), mentre questa funzione una stringa la restituisce
 * sempre, ripiegando sull'anno corrente quando `anno` è nullo. Chi ha bisogno del
 * numero DA STAMPARE usi quella; questa nomina una riga.
 */
export function etichettaFattura(r: Pick<RigaFatturaEmessa, 'numero' | 'anno' | 'sezionale'>): string {
  const anno = r.anno ?? new Date().getFullYear()
  return r.sezionale ? `${r.sezionale} ${r.numero}/${anno}` : `${r.numero}/${anno}`
}
