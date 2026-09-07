/**
 * ─── IL MOTORE DEL LOTTO DI FATTURE — puro, e collaudabile senza un browser ──
 *
 * «Emetti tutte» su una lista di bonifici già abbinati. Qui vivono le quattro
 * decisioni che rendono quella funzione utile invece che dannosa; la schermata
 * (`LottoFatturePanel.tsx`) è solo la pelle che le mostra.
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
 * consumato. È un difetto PRE-ESISTENTE dell'emissione singola: un lotto non lo
 * peggiora — emette le stesse POST, una per volta — ma non lo chiude neanche.
 * L'unica mitigazione qui dentro è `fermaIlLotto`, che al primo esito ignoto
 * ferma tutto, più il testo che dice l'unica cosa che conta: **non ripremere**.
 */

/**
 * Quante righe si possono mandare in UN lotto.
 *
 * IL CONTO: 12 × 90 s ≈ **18 minuti** di scheda aperta — il limite vero non è
 * Aruba, è quanto a lungo una segretaria resta davanti a una barra che avanza —
 * e **due lotti pieni in un'ora fanno 24 upload**, cioè meno della metà del tetto
 * di 60 upload/ora, che è il margine per chi nel frattempo emette anche a mano.
 *
 * ⚠️ VA RIVISTO DOPO IL PRIMO LOTTO VERO, e il numero da guardare è uno solo:
 * quanti `429` sono comparsi in `app_log` (`esito: 'upload-trasporto'`) durante
 * quei 18 minuti. Se sono zero, questo tetto è prudente e si può alzare; se ce
 * n'è anche uno, è l'intervallo a essere corto, non il tetto a essere alto.
 */
export const TETTO_LOTTO = 12

/**
 * Quanto passa fra l'INIZIO di un'emissione e l'INIZIO della successiva.
 *
 * ⚠️ 90 s E NON 60, e non è prudenza generica: **60 è il limite esatto del
 * `signin`** (uno al minuto per IP), e un limite esatto non è un margine — basta
 * un decimo di secondo di deriva fra l'orologio del browser e quello di Aruba per
 * prendere il `429`. E c'è la seconda aritmetica, quella che il solo `signin` non
 * racconta: quando la cache del progressivo è fredda, un'emissione fa fino a
 * **7 pagine di `findByUsername`**, e il tetto di ricerca è 12 al minuto **in
 * ogni finestra scorrevole**. Due emissioni a 60 s di distanza, entrambe con la
 * cache fredda, mettono 14 ricerche dentro una finestra da 60 s; a 90 s ne
 * mettono al massimo 7 + 7 in 90 s, cioè meno di 12 in qualunque minuto.
 *
 * Il prezzo è dichiarato: dodici fatture costano diciotto minuti.
 */
export const INTERVALLO_FRA_EMISSIONI_MS = 90_000

/**
 * La pausa dopo un rifiuto LOCALE (400/404/409/422).
 *
 * Ad Aruba non è partito niente — il rifiuto nasce nei nostri gate, prima del
 * `signin` — quindi non c'è nessun ritmo da rispettare. Senza questa distinzione
 * un lotto di dodici righe tutte respinte costerebbe diciotto minuti di attesa
 * per zero chiamate al provider: la funzione sembrerebbe rotta proprio nel caso
 * in cui sta lavorando bene.
 *
 * Cinque secondi e non zero: le righe respinte scorrerebbero troppo in fretta per
 * essere lette, e il pannello non è una barra di caricamento — è ciò che dice
 * quali documenti NON sono usciti.
 */
export const PAUSA_DOPO_RIFIUTO_LOCALE_MS = 5_000

/**
 * Gli status che riguardano SOLO la riga rifiutata: nessuna richiesta è mai
 * arrivata ad Aruba, e la riga successiva si può tentare subito.
 *
 * `409` (documento già vivo, quote cambiate) e `422` (intestatario non del
 * bambino) nascono dai gate di `emettiFatturaPagamento`, `400`/`404` da `zod` e
 * dallo scope di sede: tutti e quattro prima del `signin`.
 */
const RIFIUTI_LOCALI = new Set([400, 404, 409, 422])

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
export interface AnteprimaPerIlLotto {
  quote?: QuotaPerIlLotto[] | null
}

/**
 * La riga si può mandare al lotto?
 *
 * ⚠️ `quote.length > 0` NON è una ridondanza: `Array.prototype.every` su un elenco
 * vuoto risponde `true`, quindi senza questo controllo un pagamento per cui
 * l'anteprima non ha saputo determinare nessuna quota — cioè il caso in cui non si
 * sa a chi intestare la fattura — passerebbe come «pronto».
 *
 * Verificato in produzione il 2026-09-07: dei 130 pagamenti saldati in attesa di
 * fattura **uno solo** ha un intestatario risolvibile. È questo predicato a
 * trasformare «emetti tutte» da bruciatore di quota in un elenco che, senza
 * spendere un colpo, dice in dieci secondi ciò che oggi si scopre aprendo 130
 * popup uno per uno.
 */
export function prontaPerIlLotto(anteprima: AnteprimaPerIlLotto | null | undefined): boolean {
  const quote = anteprima?.quote
  if (!Array.isArray(quote) || quote.length === 0) return false
  return quote.every((q) => q?.fatturabile === true)
}

/** Il corpo della POST di emissione di UNA riga del lotto. */
export interface CorpoEmissione {
  pagamento_id: string
  /** SEMPRE `null`: vedi `corpoEmissione`. Il tipo non ammette `undefined`. */
  causale: null
}

/**
 * ⚠️ `causale: null`, MAI `undefined` — ed è il difetto più caro di questo file.
 *
 * In `POST /api/pagamenti/fattura` i tre valori significano tre cose diverse:
 *
 *   stringa non vuota → si SCRIVE la correzione manuale su `pagamenti.fattura_causale`
 *   `null`            → si TOGLIE la correzione salvata
 *   `undefined`       → non si tocca niente
 *
 * `fattura_causale` è appiccicoso: una volta scritto batte qualunque modello
 * configurato in Contabilità → Causali, per sempre e senza che nessuno possa
 * capire perché. È così che la FPR 1948/26 è partita verso lo SdI con «Retta
 * 09/2026» mentre la sede aveva configurato un modello coi segnaposti. Un lotto
 * che mandasse `undefined` lascerebbe congelata quella correzione su OGNI
 * pagamento del lotto: lo stesso difetto, moltiplicato per dodici, su documenti
 * che si correggono solo con una nota di variazione.
 *
 * Il lotto non personalizza mai la causale — non c'è nessun campo da compilare —
 * quindi «togli la correzione salvata» è esattamente ciò che deve dire.
 */
export function corpoEmissione(pagamentoId: string): CorpoEmissione {
  return { pagamento_id: pagamentoId, causale: null }
}

/**
 * Quanto aspettare PRIMA della prossima emissione, misurato **da inizio a
 * inizio**.
 *
 * Non «90 secondi dopo la risposta»: il limite di Aruba conta le RICHIESTE in una
 * finestra, non le pause fra loro. Un'emissione che ha impiegato 40 s ha già speso
 * 40 dei 90; aspettarne altri 90 raddoppierebbe la durata del lotto senza
 * comprare nessun margine.
 *
 * @param statoHttp lo status della risposta appena ricevuta (0 = mai arrivata)
 * @param durataMs quanto è durata quella chiamata
 */
export function pausaDopo(statoHttp: number, durataMs: number): number {
  if (RIFIUTI_LOCALI.has(statoHttp)) return PAUSA_DOPO_RIFIUTO_LOCALE_MS
  return Math.max(0, INTERVALLO_FRA_EMISSIONI_MS - durataMs)
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

/**
 * Il `codice` con cui `POST /api/pagamenti/fattura` dichiara il RIFIUTO DI
 * TRASPORTO: il numero è stato consumato e nessuno sa se il documento sia partito.
 *
 * ⚠️ Copiato dalla rotta di proposito e non importato: quella è un modulo server
 * (`withRoute`, `next/server`, il client Aruba) e questo lo legge il browser. È
 * una stringa che viaggia dentro un JSON, cioè un pezzo di CONTRATTO — come i
 * codici di `@/lib/ui/esito-fetch` — non una costante condivisa.
 */
export const CODICE_TRASPORTO_IGNOTO = 'FATTURA_TRASPORTO_IGNOTO'

/**
 * ─── «IL NUMERO È IN DUBBIO?» NON È «MI FERMO?» ─────────────────────────────
 *
 * Due domande diverse, due risposte diverse, e la seconda deve restare STRETTA
 * mentre la prima va bene larga (`fermaIlLotto`).
 *
 * «Mi fermo?» è una decisione prudenziale: sbagliarla per eccesso costa una riga
 * non tentata, che si ritenta. «Il numero è in dubbio?» è un'AFFERMAZIONE, e la
 * schermata la stampa così: *«il numero potrebbe essere stato consumato»*, più
 * l'invito ad andare a cercare il documento sul pannello Aruba prima di
 * riprovare. Sbagliarla per eccesso manda un operatore a cercare un documento che
 * non esiste.
 *
 * ⚠️ FINO AL 2026-09-07 QUI C'ERA `fermaIlLotto`, e il caso che pagava il prezzo
 * era il più probabile di tutti. I 503 di `src/lib/aruba/emissione.ts` — Aruba non
 * configurata (:510), cedente incompleto (:583), numerazione non allineata
 * (:2062), una lettura caduta (:473, :530, :566, :846, :931) — nascono TUTTI
 * prima del `signin`, e ognuno di quei rami lo scrive nel proprio messaggio:
 * «nessun numero è stato consumato». Se la sede non è configurata il 503 esce
 * sulla PRIMA riga del primo lotto vero: era esattamente lì che il pannello
 * mandava a cercare un documento fantasma.
 *
 * CHI RESTA DENTRO, e perché:
 *  · **0** — la risposta non è arrivata affatto: indistinguibile da «la POST è
 *    partita e ha emesso». Su un documento fiscale l'ignoto si tratta come il
 *    peggio;
 *  · **502** — l'unico status che in `emissione.ts` esce DOPO l'upload. Col
 *    codice di trasporto il numero è consumato e l'esito ignoto; senza codice è
 *    uno scarto di merito, dove il numero è consumato lo stesso.
 *
 * CHI RESTA FUORI: **503** (sopra), **500** — l'XML non composto, che sta prima
 * dell'upload, o il `catch` della rotta — e **429**, che qui può essere solo un
 * tetto di frequenza NOSTRO: il 429 di Aruba lo traduce in 502 l'emissione.
 *
 * @param statoHttp lo status della risposta (0 = mai arrivata)
 * @param codice il `codice` dichiarato dal server nel corpo, se c'è
 */
export function numeroInDubbio(statoHttp: number, codice?: string | null): boolean {
  if (statoHttp === 0) return true
  if (codice === CODICE_TRASPORTO_IGNOTO) return true
  return statoHttp === 502
}
