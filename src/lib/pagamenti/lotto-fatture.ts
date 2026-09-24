import { intestatarioAutomaticoDelLotto, type AnteprimaConProposta } from './proposta-intestatario'

/**
 * ─── IL MOTORE DEL LOTTO DI FATTURE — puro, e collaudabile senza un browser ──
 *
 * Le fatture di una lista di bonifici già abbinati, messe in coda con un gesto
 * (dal 2026-09-23 il lotto ACCODA: a emettere è il lavoratore della coda). Qui
 * vivono le decisioni che rendono quel gesto utile invece che dannoso; la
 * schermata (`LottoFatturePanel.tsx`) è solo la pelle che le mostra.
 *
 * ⚠️ NIENTE React, niente `next-intl`, niente import da `src/components`: stessa
 * disciplina di `fatturazione-riga.ts` in questa stessa cartella, e per la stessa
 * ragione — un modulo puro si collauda in ambiente `node`, e da qui escono
 * VERDETTI, non testi. A tradurre è chi disegna.
 *
 * ─── IL RITMO LO DETTA IL `signin`, NON GLI UPLOAD ──────────────────────────
 * `tokenCache` in `src/lib/aruba/emissione.ts` è una variabile LOCALE alla singola
 * invocazione di `emettiFatturaPagamento`: N chiamate a `/api/pagamenti/fattura`
 * sono N `signin`, e Aruba ne concede **uno al minuto per IP**. Gli altri limiti
 * (documentati in `src/lib/aruba/client.ts`) sono 12 ricerche al minuto, 30 upload
 * al minuto ma **60 all'ora** di volume, con un leaky bucket dal TTL di un'ora che
 * **ogni tentativo, anche rifiutato, riazzera**.
 *
 * ─── IL BUCO RESIDUO, CHE IL LOTTO EREDITA E NON ALLARGA ────────────────────
 * Se fallisce anche l'INSERT in `fatture_emesse` (il ramo
 * `segnalaTrasportoNonRegistrato` di `emissione.ts`) non resta nessuna riga a
 * registro, e quel pagamento può tornare fra i «da fatturare» con un numero già
 * consumato. È un difetto PRE-ESISTENTE dell'emissione singola: la coda non lo
 * peggiora — il lavoratore chiama la stessa `emettiFatturaPagamento`, una voce per
 * volta — ma non lo chiude neanche.
 * L'unica mitigazione qui dentro è `fermaIlLotto`, che al primo esito ignoto
 * ferma il blocco del lavoratore (`esegui-blocco-fatture.ts`). Il testo «non ripremere»
 * stava nell'avanzamento del vecchio lotto nel browser, tolto con la consegna 2a.
 */

/**
 * Quante righe si possono SELEZIONARE per un lotto — cioè quante se ne mettono in
 * coda con UN gesto.
 *
 * ⚠️ DAL 2026-09-23 (nucleo della coda fatture) QUESTO NUMERO NON È PIÙ LEGATO AL
 * RITMO DI ARUBA, e vale la pena dirlo perché fino al giorno prima lo era. Il lotto
 * non emette più niente dal browser: fa UNA `POST /api/pagamenti/fattura/coda`, e a
 * inviare è il lavoratore sul server, al ritmo di `SOGLIA_ORARIA_APP` (50 l'ora, in
 * `tetto-orario-aruba.ts`) e a blocchi di `TETTO_BLOCCO`. Finché partiva dal browser
 * il tetto della selezione doveva stare dentro un'ora di quota, e valeva 50; adesso la
 * coda aspetta quanto serve, anche a PC spento, e i due numeri sono INDIPENDENTI:
 *
 *   · `TETTO_LOTTO` (500) — quanto si accoda in un gesto;
 *   · `SOGLIA_ORARIA_APP` (50) — quante ne partono in un'ora.
 *
 * ⚠️ Il valore deve restare uguale a `TETTO_VOCI_CODA` di `src/lib/fatture-coda/api.ts`,
 * che è il massimo di voci che la POST accetta: una selezione più larga partirebbe
 * verso un 400. Non si importa perché quel modulo tira dentro `next/server` e il
 * logger del server, e questo lo legge il browser: a tenerli insieme c'è un test
 * (`__tests__/pagamenti/tetto-orario-aruba.test.ts`).
 */
export const TETTO_LOTTO = 500

/**
 * Quante fatture partono in UNA chiamata al server.
 *
 * ─── DA DOVE VIENE IL NUMERO ────────────────────────────────────────────────
 * Non è scelto: è ciò che entra nel budget di tempo di un'invocazione. La route
 * ha `maxDuration = 300`, e da quei 300 secondi va tolta la **riserva del costo
 * peggiore di UNA fattura** (`RISERVA_PEGGIORE_MS`): restano ~145 secondi utili,
 * e a ~3 secondi per fattura quindici ci stanno larghe.
 *
 * ⚠️ NON è il tetto di Aruba e non va confuso con `TETTO_LOTTO`: quello dice
 * quante se ne possono mettere in coda, questo quante ne parte alla volta. Dal
 * 2026-09-23 lo usano la route del lotto e il lavoratore della coda
 * (`src/lib/fatture-coda/giro.ts`), non più il browser.
 */
export const TETTO_BLOCCO = 15

/**
 * Quanto si aspetta fra un upload e il successivo DENTRO un blocco.
 *
 * SLA §3: 30 upload al minuto per IP, cioè uno ogni 2 secondi. Con 2,5 si sta a
 * ~24 al minuto, con margine. ⚠️ Non è questo il vincolo che conta: il volume
 * orario (60) lo è, e lo sorveglia `tetto-orario-aruba.ts`.
 */
export const PAUSA_FRA_UPLOAD_MS = 2_500

/**
 * Il tempo da tenere da parte per la fattura che sta per partire.
 *
 * ⚠️ LA RISERVA È IL COSTO PEGGIORE DI UNA FATTURA, NON LA MEDIA, e la differenza
 * è tutta. Il ritentativo dopo un `429` è un `await` di **novanta secondi che vive
 * dentro `arubaUpload`**: chi chiama non ha nessun punto di controllo fra
 * l'inizio e la fine. Una guardia che riservasse i ~3 secondi medi lascerebbe
 * partire una fattura con sessanta secondi di margine, e quella fattura finirebbe
 * **oltre il muro dei 300 con il numero già allocato e nessuna riga a registro**.
 *
 * Il conto è quello già scritto in testa a `src/app/api/pagamenti/fattura/route.ts`:
 * pausa fra le pagine (5) + attesa dopo un 429 (90) + due tetti di risposta da 30.
 *
 * (Il lotto passa comunque `ritenta: false`, quindi quei novanta secondi non
 * dovrebbero mai scattare. La riserva resta larga perché una guardia che si fida
 * di un'altra guardia non è una guardia.)
 */
export const RISERVA_PEGGIORE_MS = 5_000 + 90_000 + 2 * 30_000

/** I secondi dichiarati in `maxDuration` sulla route del blocco. Un test li tiene insieme. */
export const MAX_DURATION_BLOCCO_S = 300

/**
 * Quanto si sta lontani dal muro della piattaforma.
 *
 * `maxDuration` è una RICHIESTA, non una garanzia: se il piano dell'account la tosasse,
 * o se l'uccisione arrivasse un istante prima, dieci secondi sono quel che separa un
 * blocco che si chiude ordinatamente da uno troncato a metà di una scrittura.
 */
export const MARGINE_PIATTAFORMA_MS = 10_000

/**
 * L'istante, dall'inizio del blocco, oltre il quale non si comincia più niente.
 *
 * ⚠️ NON è «il tempo di lavoro utile»: la riserva NON va sottratta qui, perché la guardia
 * la somma al tempo trascorso ogni volta che decide. Toglierla anche da questa costante
 * significherebbe contarla due volte — e la guardia scatterebbe **prima della prima
 * fattura**, cioè un blocco che non emette mai niente. È il difetto che il test del
 * budget ha trovato appena scritto: `0 + 155.000 > 145.000` è vero.
 */
export const BUDGET_BLOCCO_MS = MAX_DURATION_BLOCCO_S * 1_000 - MARGINE_PIATTAFORMA_MS

/** Il tempo che resta davvero per emettere, una volta accantonata la riserva. */
export const LAVORO_UTILE_MS = BUDGET_BLOCCO_MS - RISERVA_PEGGIORE_MS

/** Una quota dell'anteprima, per la sola parte che al lotto interessa. */
export interface QuotaPerIlLotto {
  fatturabile?: boolean | null
}

/**
 * Il blocco `intestatario` di `GET /api/pagamenti/fattura/anteprima`, ridotto a
 * ciò che decide se la riga può entrare nel lotto.
 *
 * ⚠️ È un tipo LARGO di proposito (`null`/`undefined` ammessi ovunque): l'anteprima
 * può arrivare degradata — quel blocco è fail-open per progetto — e un lotto che
 * assume la forma piena emetterebbe sulla fede di un campo mai calcolato.
 */
export interface AnteprimaPerIlLotto extends AnteprimaConProposta {
  quote?: QuotaPerIlLotto[] | null
}

/**
 * L'ANAGRAFICA, DA SOLA, BASTA A INTESTARE OGNI QUOTA?
 *
 * ⚠️ `quote.length > 0` NON è una ridondanza: `Array.prototype.every` su un elenco
 * vuoto risponde `true`, quindi senza questo controllo un pagamento per cui
 * l'anteprima non ha saputo determinare nessuna quota — cioè il caso in cui non si
 * sa a chi intestare la fattura — risulterebbe «tutto in regola».
 *
 * ⚠️ ESISTE COME FUNZIONE, e non scritto in linea, perché la stessa domanda la fa
 * anche il pannello: `prontaPerIlLotto` decide se la riga entra, e
 * `LottoFatturePanel` decide se spedire l'intestatario PROPOSTO. Erano due copie, e
 * la seconda sbagliava esattamente sul caso dell'elenco vuoto: dichiarava «hanno
 * deciso le quote» dove di quote non ce n'era nessuna, e la POST partiva senza
 * l'intestatario — cioè il rifiuto si spostava dal browser ad Aruba, a quota spesa.
 */
export function quoteTutteFatturabili(quote: QuotaPerIlLotto[] | null | undefined): boolean {
  return Array.isArray(quote) && quote.length > 0 && quote.every((q) => q?.fatturabile === true)
}

/**
 * La riga si può mandare al lotto?
 *
 * Due vie, e la seconda esiste perché la prima non copre il caso più frequente:
 *
 *  1. l'anagrafica sa intestare OGNI quota (`quoteTutteFatturabili`), oppure
 *  2. l'app sa CHI ha fatto il bonifico, e quel genitore è fatturabile.
 *
 * ⚠️ IL CONTROLLO DI LUNGHEZZA APPARTIENE ALLA PRIMA VIA, NON A TUTTA LA FUNZIONE, e
 * la differenza è il difetto corretto il 2026-09-08. Stava come uscita anticipata
 * (`if (!Array.isArray(quote) || quote.length === 0) return false`) e usciva PRIMA
 * che la proposta venisse guardata — cioè spegneva la seconda via proprio nel caso
 * in cui è l'unica: `quote: []` significa «nessun intestatario risolvibile in
 * anagrafica» (`determinaQuoteFatturazione`, passo 5).
 *
 * Misurato in Conciliazione il 2026-09-08, sulle righe che il lotto può vedere:
 *
 *              alle 16:24   alle 16:50
 *   righe selezionabili        20           14
 *   con un ordinante           20           14
 *   pronte col predicato di prima    4        3
 *   pronte col predicato di adesso  18       12
 *
 * ⚠️ I DUE NUMERI ASSOLUTI SONO DIVERSI PERCHÉ SONO INVECCHIATI IN VENTISEI MINUTI,
 * dentro il lavoro che li ha misurati: la lista si svuota man mano che si fattura e
 * si riempie man mano che si abbina. È il rapporto a essere il risultato — da poco
 * più di un quinto a circa sei settimi — non la coppia di interi. Chi rilegge questo
 * commento fra un mese non ci trova una misura: ci trova la query da rifare.
 *
 * (Il conteggio delle «pronte» qui è calcolato con la sola regola del SOTTOINSIEME
 * unico, la più stretta di `riconosciOrdinante`: l'uguaglianza esatta e la forma
 * senza spazi ne riconoscono altre, quindi il numero vero è ≥ questo.)
 *
 * Il server era già pronto ad accettarle: `applicaIntestatarioScelto` su zero quote
 * ne crea UNA con l'intestatario scelto e il totale, e sta PRIMA del 422
 * «intestatario non impostato». È ciò che fa funzionare l'emissione singola.
 *
 * ⚠️ La misura precedente — «dei 130 pagamenti saldati uno solo ha un intestatario
 * risolvibile» — era SBAGLIATA, e rimisurarla è servito. Contati in produzione il
 * 2026-09-07:
 *
 *   156  pagamenti saldati in attesa di fattura
 *    11  con un movimento di riconciliazione confermato e un ordinante leggibile
 *     8  già emettibili senza alcuna proposta (`alunni.intestatario_fatture`)
 *     6  sbloccati SOLO dalla proposta del bonifico
 *   145  senza alcun movimento confermato: non compaiono nemmeno in lista
 *
 * Le letture sono tutte vere e vanno tenute insieme: rispetto a ciò che il lotto
 * può vedere, la proposta è quasi tutto; rispetto all'arretrato, il collo di
 * bottiglia sono i 145 — e non lo tocca niente di quanto sta in questo file.
 *
 * Resta il punto del predicato: senza spendere un colpo di quota dice in dieci
 * secondi ciò che altrimenti si scopre aprendo i popup uno per uno.
 */
export function prontaPerIlLotto(anteprima: AnteprimaPerIlLotto | null | undefined): boolean {
  if (quoteTutteFatturabili(anteprima?.quote)) return true
  // ...oppure l'app sa CHI ha fatto il bonifico, e quel genitore è fatturabile:
  // è la stessa proposta che l'emissione singola preseleziona, e il lotto la
  // buttava via due volte — il suo tipo non la conteneva, e il corpo
  // dell'emissione non aveva il campo dove spedirla.
  return intestatarioAutomaticoDelLotto(anteprima) !== null
}

/**
 * Il lotto si ferma qui, e la riga successiva NON si tenta.
 *
 * I casi, e perché ciascuno:
 *  · **502** — rifiuto di TRASPORTO: il numero di fattura è stato consumato e
 *    nessuno sa se il documento sia partito (`FATTURA_TRASPORTO_IGNOTO`). Andare
 *    avanti significherebbe consumare altri numeri mentre il primo è in dubbio, e
 *    ogni tentativo riazzera il TTL del secchio di Aruba;
 *  · **500** — l'XML non si è saputo comporre, oppure il `catch` della rotta: è un
 *    guasto NOSTRO, e si ripresenterà identico sulla riga dopo;
 *  · **503** — Aruba non è configurata, la numerazione non è allineata, una
 *    lettura è caduta: nessuna delle undici righe successive andrà meglio;
 *  · **0** — la risposta non è arrivata affatto. È il caso peggiore da leggere,
 *    perché è indistinguibile da «la POST è partita e ha emesso»: ci si ferma e lo
 *    si dice.
 *
 * Non fermano il lotto i rifiuti che riguardano SOLO quella riga (400/404/409/422):
 * lì ad Aruba non è arrivato niente, e le altre undici non c'entrano.
 *
 * ⚠️ `429` c'è anche se nessuno l'ha ancora visto arrivare fin quassù: il `429` di
 * Aruba viene tradotto in 502 dall'emissione, ma un `429` della NOSTRA piattaforma
 * (un tetto di frequenza applicativo) direbbe la stessa cosa — rallenta — e
 * continuare sarebbe il modo più rapido di trasformarlo in un blocco.
 */
export function fermaIlLotto(statoHttp: number): boolean {
  if (statoHttp === 0) return true
  if (statoHttp === 429) return true
  return statoHttp >= 500
}
