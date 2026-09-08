import { intestatarioAutomaticoDelLotto, type AnteprimaConProposta } from './proposta-intestatario'
import type { IntestatarioScelto } from '@/lib/fatturazione/intestatario-scelto'

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
 * Quante righe si possono SELEZIONARE per un lotto.
 *
 * ⚠️ DAL 2026-09-07 QUESTO NUMERO SIGNIFICA UN'ALTRA COSA, e vale la pena dirlo
 * perché il nome è rimasto. Prima era anche la dimensione di ciò che partiva —
 * una POST per riga, dodici righe, dodici accessi ad Aruba. Adesso il lotto parte
 * a BLOCCHI (`TETTO_BLOCCO`) e questo è solo il tetto della **selezione**, cioè
 * quanto si può mettere in coda in una volta.
 *
 * IL CONTO: 50 è la soglia che l'app si dà sul volume orario di Aruba
 * (`SOGLIA_ORARIA_APP` in `src/lib/pagamenti/tetto-orario-aruba.ts`, che il tetto
 * vero di 60 lo tiene sotto per lasciare margine a chi fattura a mano dal
 * pannello). Selezionarne di più sarebbe promettere qualcosa che il provider non
 * concede: la guardia sul server troncherebbe comunque.
 *
 * ⚠️ Il valore deve restare uguale a `SOGLIA_ORARIA_APP`. Non si importa perché
 * quel modulo parla con Supabase e questo lo legge il browser: a tenerli insieme
 * c'è un test.
 */
export const TETTO_LOTTO = 50

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
 * quante se ne possono mettere in coda, questo quante ne parte alla volta.
 */
export const TETTO_BLOCCO = 15

/**
 * Quanto aspetta il browser fra la fine di un blocco e l'inizio del successivo.
 *
 * ⚠️ 65 s E NON 60: **60 è il limite esatto del `signin`** (uno al minuto per IP),
 * e un limite esatto non è un margine — basta un decimo di secondo di deriva fra
 * l'orologio del browser e quello di Aruba per prendere il `429`. Cinque secondi
 * sono il minimo onesto, e il 2026-09-07 un `signin` ha preso `429` **con novanta
 * secondi di intervallo**, perché il cron `fattura-sync` fa il suo accesso per
 * conto proprio e ruba lo slot del minuto.
 *
 * ⚠️ Prima qui c'erano 90 s ed era l'attesa fra due FATTURE, non fra due blocchi.
 * Novanta erano calibrati su un'emissione che faceva fino a sette ricerche
 * (12 al minuto, due emissioni a 60 s di distanza ne mettevano 14 in una finestra
 * da 60). Con `PAGINA_SIZE = 2000` le ricerche sono due, e dentro un blocco la
 * lettura del pavimento è UNA sola: quel vincolo non lega più. Resta il `signin`.
 */
export const ATTESA_FRA_BLOCCHI_MS = 65_000

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

/**
 * Quanto dura un blocco pieno, per la stima mostrata a chi guarda.
 *
 * Quindici upload a `PAUSA_FRA_UPLOAD_MS` più l'accesso e la lettura del pavimento
 * della prima fattura. È una STIMA e si vede: serve a scrivere «circa sei minuti»
 * accanto a una barra, non a decidere niente.
 */
export const DURATA_BLOCCO_STIMATA_MS = TETTO_BLOCCO * PAUSA_FRA_UPLOAD_MS + 10_000

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

/** Il corpo della POST di emissione di UNA riga del lotto. */
export interface CorpoEmissione {
  pagamento_id: string
  /** SEMPRE `null`: vedi `corpoEmissione`. Il tipo non ammette `undefined`. */
  causale: null
  /**
   * L'intestatario proposto dal bonifico, quando c'è. ASSENTE (mai `null`) quando
   * non c'è: il campo mancante significa «decide la cascata del server», che è il
   * comportamento su cui contano tutti gli altri punti da cui si emette.
   *
   * Solo il ramo `adult`: il lotto non ha nessun modulo da compilare, e accettare
   * l'anagrafica di una persona dal browser è ciò che lo schema della POST vieta
   * per iscritto — `zAdultScelto`, non l'unione intera. ⚠️ Fino al 2026-09-08 questa
   * frase era FALSA: lo schema era `zIntestatarioScelto.optional()`, cioè accettava
   * anche il ramo `persona`. Il commento prometteva una protezione che non c'era.
   */
  intestatario?: Extract<IntestatarioScelto, { tipo: 'adult' }>
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
export function corpoEmissione(pagamentoId: string, adultId?: string | null): CorpoEmissione {
  // `adultId` non riguarda la causale: la nota qui sopra resta intera.
  return {
    pagamento_id: pagamentoId,
    causale: null,
    ...(adultId ? { intestatario: { tipo: 'adult' as const, adult_id: adultId } } : {}),
  }
}

/**
 * Quanto aspettare PRIMA del prossimo BLOCCO, misurato **da inizio a inizio**.
 *
 * ⚠️ Dal 2026-09-07 l'unità è il blocco, non la fattura: prima il browser mandava
 * una POST per riga e questa era la pausa fra due fatture. Adesso una POST porta
 * `TETTO_BLOCCO` fatture, e ciò che va distanziato è l'ACCESSO — uno al minuto
 * per IP, ed è il solo limite rimasto a legare.
 *
 * Non «65 secondi dopo la risposta»: il limite di Aruba conta le richieste in una
 * finestra, non le pause fra loro. Un blocco che ha impiegato 40 s ha già speso
 * 40 dei 65; aspettarne altri 65 allungherebbe il lotto senza comprare margine.
 *
 * @param statoHttp lo status della risposta appena ricevuta (0 = mai arrivata)
 * @param durataMs quanto è durato quel blocco
 */
export function pausaDopo(statoHttp: number, durataMs: number): number {
  if (RIFIUTI_LOCALI.has(statoHttp)) return PAUSA_DOPO_RIFIUTO_LOCALE_MS
  return Math.max(0, ATTESA_FRA_BLOCCHI_MS - durataMs)
}

/**
 * Il blocco ha davvero parlato con Aruba, oppure è stato tutto respinto dai NOSTRI gate?
 *
 * ⚠️ SERVE PERCHÉ IL TRASPORTO È CAMBIATO. Con una POST per riga bastava lo status:
 * `pausaDopo(409, …)` valeva cinque secondi perché ad Aruba non era partito niente.
 * Adesso una POST porta quindici righe e risponde **200** anche quando tutte e quindici
 * sono state respinte da `assertPagamentoInScope` o dai gate dell'intestatario — cioè
 * quando ad Aruba non è arrivato nulla. Aspettare l'attesa piena lì significherebbe
 * annunciare sei minuti a chi ne sta aspettando trenta secondi, e annunciarli a uno
 * screen reader.
 *
 * «Già a registro» non conta come contatto: la SELECT di idempotenza sta prima del
 * `signin`.
 */
export function bloccoHaToccatoAruba(dati: {
  emesse: number
  fallite: readonly { statoHttp?: number }[]
}): boolean {
  if (dati.emesse > 0) return true
  return dati.fallite.some((f) => !RIFIUTI_LOCALI.has(f.statoHttp ?? 0))
}

/**
 * Quanto aspettare prima del prossimo blocco, quando il blocco è ANDATO A BUON FINE.
 *
 * Il gemello di `pausaDopo`, che invece decide sullo status quando la POST del blocco
 * è fallita per intero.
 */
export function pausaDopoBlocco(durataMs: number, haToccatoAruba: boolean): number {
  if (!haToccatoAruba) return PAUSA_DOPO_RIFIUTO_LOCALE_MS
  return Math.max(0, ATTESA_FRA_BLOCCHI_MS - durataMs)
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
 *    uno scarto di merito, dove il numero è consumato lo stesso;
 *  · **504** — l'invocazione uccisa dalla piattaforma. Finché il ciclo girava nel
 *    browser non si presentava (un'emissione dura ~44 s su 300 di `maxDuration`);
 *    col ciclo sul server e un budget di tempo diventa il modo PREVISTO di
 *    fallire, e la risposta non dice quali delle fatture del blocco siano partite.
 *    ⚠️ Oggi il pannello si salva PER CASO: Vercel manda il 504 con un corpo HTML,
 *    `res.json()` lancia, il `catch` mette `stato = 0` e il dubbio scatta da lì.
 *    Un ragionevole `res.json().catch(() => null)` in una riscrittura riporterebbe
 *    il 504 in superficie con `dubbio = false`, cioè con un'AFFERMAZIONE falsa
 *    stampata su un documento fiscale. Meglio dentro, esplicitamente.
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
  return statoHttp === 502 || statoHttp === 504
}

/**
 * ─── QUANTO MANCA ALLA FINE DEL LOTTO ───────────────────────────────────────
 *
 * MISURATO sullo screenshot del 2026-09-07: durante il lotto il pannello diceva
 * soltanto «Fattura 1/3 · invio in corso». Con dodici fatture quel lotto dura
 * **circa diciotto minuti** — è il conto scritto in testa a `TETTO_LOTTO` — e
 * novanta secondi di riga ferma si leggono come un blocco. Chi li legge così
 * ricarica la pagina, cioè fa la sola cosa che qui non si deve fare: perde di
 * vista quali documenti fiscali siano già partiti.
 *
 * ⚠️ DAL 2026-09-07 L'UNITÀ DI MISURA È IL BLOCCO, NON LA FATTURA, e la funzione
 * è stata RISCRITTA, non riallineata a una costante nuova. Prima il conto era
 * «una fattura, un intervallo»: con `ATTESA_FRA_BLOCCHI_MS` al posto dei novanta
 * secondi per riga, lasciarla com'era avrebbe risposto **quindici minuti per un
 * blocco che ne dura quaranta secondi** — un numero verde in tutti i test e falso
 * sullo schermo.
 *
 * Il conto adesso:
 *  · le fatture rimaste si dividono in blocchi da `TETTO_BLOCCO`, arrotondando
 *    per eccesso: quattro fatture residue costano un blocco intero;
 *  · ogni blocco costa `DURATA_BLOCCO_STIMATA_MS`;
 *  · fra un blocco e il successivo passa `ATTESA_FRA_BLOCCHI_MS`, e le attese
 *    sono una in meno dei blocchi;
 *  · l'attesa in corso si SOMMA, perché è tempo che deve ancora passare — ed è
 *    anche l'unico pezzo che distingue una pausa fra blocchi da una da 5 s
 *    (`pausaDopo` dopo un rifiuto locale), cioè un lotto che parla con Aruba da
 *    uno respinto dai nostri gate.
 *
 * IL CONTO CHE NE ESCE: sessanta fatture sono quattro blocchi, cioè **circa sei
 * minuti** — contro i circa ottantasette di prima (cinque lotti da dodici a
 * novanta secondi per riga).
 *
 * ⚠️ È UNA STIMA, e si aggiorna A PASSI: la si ricalcola quando cambia lo stato
 * dell'avanzamento, non con un orologio che scorre. Un contatore al secondo
 * dentro un `role="status"` sarebbe un annuncio al secondo per uno screen reader,
 * cioè la schermata resa inascoltabile proprio da ciò che doveva renderla chiara.
 *
 * @param concluse quante FATTURE hanno già un esito
 * @param totale quante fatture ha il lotto
 * @param attesaMs la pausa in corso adesso (`null` = un blocco è in volo)
 */
export function stimaRimanenteMs(concluse: number, totale: number, attesaMs: number | null): number {
  const restanti = totale - concluse
  if (restanti <= 0) return 0
  const blocchi = Math.ceil(restanti / TETTO_BLOCCO)
  return (
    Math.max(0, attesaMs ?? 0) +
    blocchi * DURATA_BLOCCO_STIMATA_MS +
    (blocchi - 1) * ATTESA_FRA_BLOCCHI_MS
  )
}
