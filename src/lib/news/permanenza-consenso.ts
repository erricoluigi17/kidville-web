// =============================================================================
// IL CONSENSO NON È UN BIGLIETTO D'INGRESSO: È UNA CONDIZIONE DI PERMANENZA.
//
// PERCHÉ ESISTE QUESTO FILE. Il 2026-08-02 il collaudo privacy ha misurato due
// difetti sullo stesso magazzino — `news`, l'unico bucket PUBBLICO dei tredici,
// servito a chiunque conosca l'indirizzo, senza login:
//
//  #1 UNA FOTO ENTRATA LÌ NON USCIVA PIÙ. Il registro dell'oblio dichiarava
//     `news` ESCLUSO con la motivazione «ci vanno solo media editoriali, le foto
//     dei bambini stanno in `gallery`». Ma `gate-consenso.ts` — scritto lo stesso
//     giorno, nel file accanto — esiste APPOSTA per autorizzare le foto di minori
//     che hanno il consenso al canale «sito». Le due frasi descrivono due
//     prodotti diversi, e quella scritta nel registro non era quella vera:
//     esercitato il diritto alla cancellazione, l'immagine del bambino restava
//     pubblica per sempre.
//
//  #2 LA REVOCA NON ARRIVAVA AGLI ARTICOLI GIÀ PUBBLICATI. Il consenso si
//     verificava in tre punti — creazione, modifica, pubblicazione — e poi non lo
//     rileggeva più nessuno. Una famiglia che revocava (art. 7 §3 GDPR: revocare
//     dev'essere facile quanto acconsentire) vedeva la foto del figlio restare
//     online a tempo indeterminato.
//
// LA CAUSA È UNA SOLA. È la stessa forma di difetto che questo ciclo ha già
// corretto tre volte — la regola chiusa su una strada e lasciata aperta su quella
// accanto — applicata però all'asse del TEMPO invece che a quello delle rotte: si
// controllava l'INGRESSO del dato e mai la sua PERMANENZA. Il gate risponde alla
// domanda «questa foto può entrare?»; qui si risponde all'altra metà, che nessuno
// stava facendo: «questa foto può ancora stare qui?».
//
// LA DECISIONE DEL TITOLARE RESTA IN PIEDI, E DIVENTA VERA. Il 2026-07-31 il
// titolare ha deciso che `news` è pubblico — «è un blog rivolto all'esterno e un
// link firmato scadrebbe» — e che «ci vanno SOLO i media editoriali; le foto dei
// bambini restano in `gallery`, privato». La regola c'era: non la faceva
// rispettare niente. Da qui in avanti la fa rispettare questo modulo, dai due
// capi: nel bucket pubblico un media ci ENTRA solo dopo il gate del consenso
// (`promuoviMediaBozza`) e ci RESTA solo finché quel consenso regge. Nel momento
// in cui cade — revoca, oblio, riga dell'alunno sparita — il post si ritira e il
// file esce dal bucket.
//
// PERCHÉ IL FILE SI TOGLIE, E NON BASTA NASCONDERE IL POST. Il bucket è pubblico:
// l'indirizzo diretto continua a servire l'immagine anche quando la riga è
// `nascosta`. Un ritiro che lascia il file al suo posto è un ritiro dichiarato,
// non un ritiro — ed è esattamente la specie di «fatto» che questo repository ha
// già pagato una volta con le email che non arrivavano. E l'ordine conta: PRIMA
// il file (verificato), POI la riga — il perché sta sopra `ritiraPost`.
//
// L'ASIMMETRIA COL GATE, che è voluta. Il gate è fail-CLOSED sull'incertezza: se
// non riesce a leggere il consenso, rifiuta di pubblicare — un gesto neutro, che
// si annulla riprovando. Qui il gesto è DISTRUTTIVO (i file escono dal bucket e
// non tornano), quindi davanti a un guasto di lettura non si ritira niente: si
// grida a livello `error` e si lascia il mondo com'è. «Non lo so» non vale «sì»,
// ma non vale nemmeno «demolisci».
//
// ─── LA DOMANDA CHE MANCAVA: «C'È ANCORA QUALCUNO CHE LO NOMINA?» (2026-08-03) ─
//
// IL DIFETTO, introdotto dalla correzione di W1 e DIMOSTRATO eseguendolo. Le tre
// strade che liberano un file (`PATCH`, `DELETE`, il ritiro) prendevano il
// percorso dalla riga su cui stavano lavorando e lo passavano a una `remove()` in
// SERVICE-ROLE. Nessuna di loro chiedeva di CHI fosse quel file — `percorsoPubblicoNews`
// valida la FORMA dell'indirizzo, mai la proprietà — e il bucket è pubblico, cioè
// l'indirizzo dell'immagine di un altro articolo lo conosce chiunque:
//   1. un educator mette nel `contenuto_json` della propria bozza l'indirizzo
//      pubblico dell'immagine di un ALTRO post (anche di un'altra sede) → 200;
//   2. una seconda `PATCH` toglie quel nodo → `usciti` contiene il percorso della
//      vittima → `remove()` sul file altrui;
//   3. la riga della vittima continua a nominarlo: immagine rotta, PERMANENTE e
//      invisibile. Stessa cosa via `DELETE`, su tutta la riga.
//
// LA RISPOSTA ERA GIÀ SCRITTA IN QUESTO REPO, due volte. In `media-bozza.ts`
// (`EsitoPromozione.promossiPercorsi`): «annullare a occhio significherebbe
// cancellare l'immagine di qualcun altro», e lì la soluzione è tracciare SOLO ciò
// che quella chiamata ha spostato. E in `src/lib/allegati/rimozione.ts`
// (`rimuoviSeNessunAvvisoLoUsa`), che prima di cancellare l'allegato di un avviso
// chiede se un altro avviso lo referenzia. È la stessa domanda, e da oggi vive in
// un posto solo anche qui: `percorsiCitatiDaAltriPost`, dentro
// `liberaPercorsiPubblici`, cioè nell'imbuto da cui passano tutte e tre le strade.
//
// I DUE MODI DI SBAGLIARE, ed è per questo che il controllo esiste in questa forma:
//  · troppo stretto → si cancella il file di un altro post (il difetto qui sopra);
//  · troppo largo  → non si libera più niente, e tornano i file pubblici orfani
//    che né la revoca né l'oblio possono più raggiungere (difetto V4).
//
// ─── LA PRIMA STESURA DELLA DOMANDA ERA SBAGLIATA, E IL PERCHÉ CONTA (giro 2) ──
//
// Chiedeva al database `copertina_url ILIKE %p% OR contenuto_html ILIKE %p% OR
// contenuto_testo ILIKE %p%` e poi CONFERMAVA riga per riga guardando anche
// `contenuto_json`. Due insiemi diversi di colonne per una domanda sola: una riga
// che nomina il file SOLO dentro il JSON non tornava mai dalla query, quindi il
// ramo che l'avrebbe salvata era IRRAGGIUNGIBILE e il file di quell'altro post
// usciva lo stesso. Non è un caso di scuola — `ilike` non si applica a una colonna
// `jsonb`, `estraiTesto` toglie i tag (quindi `contenuto_testo` non contiene MAI
// l'indirizzo di un'immagine), `sanificaContenuto` SCARTA gli `<img>` che non
// passano `imgConsentita` lasciando l'indirizzo nel JSON e fuori dall'HTML, e le
// righe vecchie hanno `contenuto_html` a `null`.
//
// DA OGGI NON C'È NESSUN FILTRO: si leggono le righe a pagine e si applica a
// ciascuna LA STESSA identica funzione (`nominaIlPercorso`). Cercato e confermato
// coincidono per costruzione, e non per disciplina di chi modifica. Costa una
// passata su `news_posts` per ogni liberazione; quando le righe supereranno il
// tetto la risposta diventa «non lo so» — rumorosa — e la strada scritta è
// aggiungere una colonna testuale generata su `contenuto_json` e tornare a una
// query mirata. Finché il tetto non morde, questa è la risposta che non può
// sbagliare, ed è preferibile a una veloce che cancella la foto di un bambino.
//
// ─── E UNA RIGA GIÀ RITIRATA NON TRATTIENE PIÙ NIENTE ───────────────────────
//
// La prima stesura ha introdotto una REGRESSIONE sull'oblio, dimostrata
// eseguendola: due post che ritraggono lo stesso bambino e usano la stessa foto si
// tenevano in ostaggio a vicenda (A non libera perché B nomina il file, B non
// libera perché A lo nomina), finivano entrambi `nascosta`, e `nascosta` non è
// sorvegliata: la foto restava pubblica PER SEMPRE. Prima della correzione la
// `remove()` era incondizionata e l'oblio funzionava.
// Si chiude da due capi, e servono tutti e due:
//  · la passata dichiara in ANTICIPO tutti i post che sta per ritirare e li esclude
//    in blocco dalla domanda: chi sta per perdere i propri file non è più padrone
//    di niente (`ancheRitirati`);
//  · una riga già `nascosta` con motivo «consenso revocato» o «oblio» non conta
//    come chi lo nomina, mai (`giaRitirataPerConsenso`). Copre il caso che
//    l'esclusione non vede: A ritirato ieri con il file TRATTENUTO perché B lo
//    usava, B ritirato oggi — senza questa regola il file di A resterebbe pubblico
//    per sempre, trattenuto da una riga che non ha più titolo a trattenere niente.
// E dopo una liberazione riuscita la riga SMETTE di nominare i file che non
// esistono più: un articolo non deve continuare a citare un indirizzo vuoto.
//
// LA DIFESA COMPLEMENTARE, che chiude il passo 1 invece del passo 2: `mediaEstranei`,
// usata da `news:POST` e da `news/[id]:PATCH` — le due sole rotte che scrivono
// copertina e rich-text. Un post non può cominciare a nominare un file che non è
// suo, né nel bucket pubblico né nell'area di sosta privata (di là la conseguenza
// sarebbe anche peggio: una `move()` in service-role che rende PUBBLICO il file
// privato di un altro). È IN AGGIUNTA e non al posto del controllo qui sopra: la
// `DELETE` e il ritiro non hanno un corpo da validare, e le righe che già oggi
// nominano il file di un altro sono lì.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { percorsoNelBucket } from '@/lib/allegati/storage'
import { rimuoviEVerifica, bloccanti } from '@/lib/storage/rimozione-verificata'
import { NEWS_BUCKET } from './tipi'
import { schemaAssente } from './schema-assente'
import { mappaOgniStringa, pathBozza, perOgniStringa } from './media-bozza'

/** Colonna di `alunni` che registra il consenso per il canale pubblico. */
const COLONNA_CONSENSO_SITO = 'consenso_foto_sito'

/**
 * Gli stati in cui la sorveglianza deve passare.
 *
 * Fino al 2026-08-03 questo elenco si chiamava `STATI_ESPOSTI` e conteneva i due
 * stati in cui un post è visibile al pubblico — `pubblicata` e `programmata`.
 * Era la domanda sbagliata, e l'ha dimostrata una data.
 *
 * UN MEDIA DIVENTA PUBBLICO ALLA CREAZIONE, NON ALLA PUBBLICAZIONE. Lo fa
 * `promuoviMediaBozza`, che `news:POST` chiama subito dopo il gate: da
 * quell'istante il file sta nel bucket `news`, servito senza login, anche se il
 * post resta fermo in `bozza` per sempre. Guardare i soli stati esposti lasciava
 * perciò scoperto il caso più LUNGO di tutti — un articolo abbandonato in bozza,
 * con la foto del bambino già pubblica e nessun tick che la guardasse: una
 * famiglia che revocava non otteneva niente (difetto V4c del 2026-08-03,
 * decisione 2 del titolare: «chiudi tutto, anche le foto ferme in bozza»).
 * La domanda giusta non è «questo post si vede?» ma «un file di questo post può
 * stare nel bucket pubblico?».
 *
 * `programmata` resta qui per la ragione di prima, che vale ancora: il tick
 * promuove le programmate scadute a `pubblicata` SENZA passare da nessun gate —
 * è l'unica strada che pubblica da sola. Verificandole, un post il cui consenso
 * è caduto viene ritirato PRIMA che il tick lo pubblichi.
 *
 * `nascosta` NON è qui, ed è deliberato: è lo stato in cui un post FINISCE dopo
 * il ritiro, con i file già usciti. Riprenderlo a ogni passata significherebbe
 * una `remove()` e un `update` inutili ogni dieci minuti, per sempre, e un canale
 * di log sommerso dal rumore — che è il modo più efficace di non vedere più i
 * guasti veri. Quel confine è ciò che rende la passata idempotente.
 */
export const STATI_SORVEGLIATI = ['pubblicata', 'programmata', 'bozza', 'proposta'] as const

/** La famiglia ha ritirato il consenso alla pubblicazione sul sito. */
export const MOTIVO_CONSENSO_REVOCATO = 'consenso-revocato'
/** Il minore è stato cancellato/anonimizzato, o la sua riga non esiste più. */
export const MOTIVO_OBLIO = 'oblio-minore'

/** Quanti post si esaminano per passata: il tick gira ogni 10 minuti. */
const LIMITE_POST = 200

/** Quante righe per pagina nella passata di «c'è ancora qualcuno che lo nomina?». */
const LOTTO_RIGHE = 200

/**
 * Quante pagine al massimo, cioè quanti post si arriva a guardare (5000).
 *
 * Il tetto esiste perché una passata senza fine dentro una richiesta HTTP è un
 * timeout, e un timeout qui vuol dire nessun file liberato con nessuna spiegazione.
 * Quando MORDE la risposta non è «nessuno lo nomina» ma «non lo so» — che qui vale
 * «non toccare», perché il gesto a valle è irreversibile — e lo si grida: è il
 * giorno in cui serve una colonna testuale generata su `contenuto_json` e una
 * query mirata al posto di questa passata.
 */
const PAGINE_MAX = 25

/**
 * La forma dei percorsi che questa applicazione scrive nel bucket
 * (`uploads/<utente>/<file>`). Vale come vincolo, non come descrizione: un
 * valore che non ha questa forma non viene mai passato a una `remove()`.
 */
const FORMA_PERCORSO = /^uploads\/[^/]+\/[^/]+$/

interface PostPermanenza {
  id: string
  stato?: string | null
  /** Perché il post è stato nascosto: vedi `giaRitirataPerConsenso`. */
  nascosta_motivo?: unknown
  bambini_ritratti?: unknown
  copertina_url?: unknown
  contenuto_json?: unknown
  /**
   * Le due colonne DERIVATE dal rich-text. Non servono al ritiro: servono a
   * `nominaIlPercorso`, perché sono ciò che il feed pubblico serve davvero — una
   * riga il cui HTML mostra ancora quell'immagine la sta usando, e cancellargliela
   * sotto significherebbe romperle l'articolo.
   */
  contenuto_html?: unknown
  contenuto_testo?: unknown
}

export interface EsitoPermanenza {
  /** `false` se lo schema della dichiarazione non esiste (DB E2E non migrato). */
  disponibile: boolean
  /**
   * `false` se il consenso NON è stato riletto per un guasto: chi chiama non può
   * concludere «tutto in regola». Il tick, per esempio, in quel caso non pubblica
   * le programmate — non pubblicare è recuperabile, pubblicare senza consenso no.
   */
  verificato: boolean
  esaminati: number
  ritirati: number
  fileRimossi: number
  fileNonRimossi: number
  /**
   * I file che il ritiro NON ha tolto perché un'altra riga li nomina ancora.
   *
   * Non è una curiosità: è il numero di foto che, pur avendo perso il consenso o
   * essendo state obliate, restano a un indirizzo PUBBLICO. Fino al 2026-08-03
   * l'unica traccia era un `warn` per post, cioè una riga che si ripete a ogni
   * passata e che nessuno distingue dal rumore. Contarlo e farlo risalire al cron
   * è il minimo perché un file che nessuna passata riesce a togliere diventi una
   * cosa che si VEDE invece di una che si legge nei log per caso.
   */
  fileTrattenuti: number
}

const vuoto = (): EsitoPermanenza => ({
  disponibile: true,
  verificato: true,
  esaminati: 0,
  ritirati: 0,
  fileRimossi: 0,
  fileNonRimossi: 0,
  fileTrattenuti: 0,
})

/** Gli uuid dichiarati come ritratti, senza duplicati e senza valori vuoti. */
function ritrattiDi(post: PostPermanenza): string[] {
  const v = post.bambini_ritratti
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0))]
}

/**
 * Il percorso nel bucket pubblico, se il valore ne indica davvero un oggetto.
 *
 * Severo di proposito, e il primo test scritto su questa funzione l'ha
 * dimostrato: qui dentro passa OGNI stringa del rich-text — testo scritto a mano
 * da chi redige l'articolo — e a valle c'è una `remove()` sul bucket pubblico
 * eseguita col service-role. `percorsoNelBucket` da solo NON basta: su una
 * stringa che non è un URL restituisce la stringa stessa come percorso, quindi
 * bastava scrivere `uploads/qualcuno/qualcosa` dentro un articolo per far
 * cancellare l'immagine di un altro.
 *
 * Perciò si pretende il marcatore dello Storage di QUESTO bucket — la stessa
 * scelta di `pathBozza` per l'area di sosta — e in più la forma che questa
 * applicazione produce (`uploads/<utente>/<file>`, mai un `..`).
 */
export function percorsoPubblicoNews(valore: unknown): string | null {
  if (typeof valore !== 'string') return null
  const v = valore.trim()
  if (!v || !/^https?:\/\//i.test(v)) return null
  const p = percorsoNelBucket(NEWS_BUCKET, v)
  return p && FORMA_PERCORSO.test(p) && !p.includes('..') ? p : null
}

/**
 * Tutti gli oggetti del bucket pubblico citati dal post: la copertina e le
 * immagini del rich-text. Senza duplicati — la stessa foto può stare in
 * entrambi, e chiedere due volte la stessa `remove()` farebbe contare due volte
 * un file solo.
 */
export function percorsiPubbliciDelPost(post: {
  copertina_url?: unknown
  contenuto_json?: unknown
}): string[] {
  const trovati = new Set<string>()
  const dallaCopertina = percorsoPubblicoNews(post.copertina_url)
  if (dallaCopertina) trovati.add(dallaCopertina)
  perOgniStringa(post.contenuto_json, (s) => {
    const p = percorsoPubblicoNews(s)
    if (p) trovati.add(p)
  })
  return [...trovati]
}

/**
 * Chi ha CARICATO l'oggetto: il segmento `<utente>` di `uploads/<utente>/<file>`.
 *
 * È l'unica traccia di proprietà che questo bucket porta con sé — la scrive
 * `news/upload:POST`, e la prende dall'utente del gate, mai da un campo del
 * client. `null` per qualunque percorso che non abbia quella forma.
 */
export function caricatoDa(percorso: unknown): string | null {
  if (typeof percorso !== 'string') return null
  const m = /^uploads\/([^/]+)\/[^/]+$/.exec(percorso.trim())
  return m ? m[1] : null
}

/**
 * I percorsi del bucket pubblico che questo contenuto NON può nominare.
 *
 * ─── CHIUDE IL PASSO 1 DELL'ATTACCO (2026-08-03) ────────────────────────────
 *
 * `percorsiCitatiDaAltriPost` impedisce di CANCELLARE il file di un altro post;
 * questa impedisce di ADOTTARLO. Un corpo di `PATCH` può contenere qualunque
 * indirizzo — il bucket è pubblico, quello dell'immagine di un altro articolo lo
 * conosce chiunque legga il sito — e finché la riga poteva cominciare a nominarlo
 * il file di qualcun altro entrava nel raggio d'azione della modifica successiva.
 *
 * DUE COSE SOLE SONO AMMESSE, e la seconda non è un allentamento:
 *  · un percorso che la riga GIÀ nomina — l'editor rimanda gli indirizzi
 *    definitivi delle immagini salvate, e rifiutarli bloccherebbe ogni modifica;
 *  · un percorso caricato DA CHI STA SCRIVENDO. Serve perché finché la migrazione
 *    del bucket privato `news_bozze` non è applicata `news/upload:POST` ricade sul
 *    bucket pubblico e restituisce già un indirizzo pubblico: senza questo ramo,
 *    su quegli ambienti nessuno potrebbe più aggiungere un'immagine a un articolo.
 *    Non apre niente: il file di un altro post sta sotto l'uuid di chi lo ha
 *    caricato, che non è quello dell'attore.
 *
 * Attore senza identità → non si concede niente: `caricatoDa` non può coincidere
 * con una stringa vuota, e «non so chi sei» non autorizza.
 */
export function percorsiPubbliciEstranei(
  contenuto: { copertina_url?: unknown; contenuto_json?: unknown },
  giaNominati: string[],
  attoreId: unknown,
): string[] {
  const proprio = typeof attoreId === 'string' ? attoreId.trim() : ''
  const suoi = new Set(giaNominati)
  return percorsiPubbliciDelPost(contenuto).filter(
    (p) => !suoi.has(p) && (proprio === '' || caricatoDa(p) !== proprio),
  )
}

/**
 * I percorsi dell'AREA DI SOSTA privata che questo contenuto non può nominare.
 *
 * ─── LA STRADA ACCANTO, E QUI LA CONSEGUENZA È PEGGIORE ─────────────────────
 *
 * `pathBozza` accetta qualunque `uploads/<utente>/<file>` e non chiede di chi sia
 * — la stessa forma del difetto chiuso qui sopra sul bucket pubblico, ma su
 * `news_bozze`, che è PRIVATO. Mettere nel corpo l'indirizzo firmato del media in
 * sosta di un altro operatore faceva partire, dopo il gate, una `move()` in
 * service-role verso il bucket `news`: cioè non si cancellava il file di un altro,
 * lo si PUBBLICAVA. Su una foto che sta in un'area privata proprio perché nessuno
 * ha ancora verificato il consenso.
 *
 * UNA SOLA DEROGA, ed è lo STESSO percorso che la riga già nomina nel bucket
 * pubblico: è il RITENTATIVO. Dopo un salvataggio fallito l'editor rimanda
 * l'indirizzo di sosta di un file che nel frattempo è già stato promosso; quel
 * percorso non è un'adozione, è lo stesso file di prima. Non apre niente: la
 * `move()` che ne segue trova «not found» nel bucket privato e non sposta nulla,
 * e comunque un percorso può essere «già nominato» solo se questo controllo lo
 * aveva lasciato passare la volta scorsa.
 */
export function percorsiSostaEstranei(
  contenuto: { copertina_url?: unknown; contenuto_json?: unknown },
  giaNominati: string[],
  attoreId: unknown,
): string[] {
  const proprio = typeof attoreId === 'string' ? attoreId.trim() : ''
  const suoi = new Set(giaNominati)
  const trovati = new Set<string>()
  const esamina = (v: unknown) => {
    const p = pathBozza(v)
    // Attore senza identità → non si concede niente: «non so chi sei» non autorizza.
    if (p && !suoi.has(p) && (proprio === '' || caricatoDa(p) !== proprio)) trovati.add(p)
  }
  esamina(contenuto.copertina_url)
  perOgniStringa(contenuto.contenuto_json, esamina)
  return [...trovati]
}

/**
 * TUTTI i media che questo contenuto non ha il diritto di nominare — il passo 1
 * dell'attacco, chiuso in un posto solo per le due sole rotte che scrivono
 * copertina e rich-text (`news:POST` e `news/[id]:PATCH`).
 *
 * Esiste come funzione unica per la ragione che è la causa radice di tutta questa
 * serie: una regola valida per due bucket e due rotte, scritta in tre posti,
 * diverge in silenzio alla prima modifica. Fino al giro 2 la difesa viveva sulla
 * sola `PATCH` e sul solo bucket pubblico — bastava CREARE il post invece di
 * modificarlo, o citare un indirizzo dell'area di sosta, per avere lo stesso
 * risultato.
 */
export function mediaEstranei(
  contenuto: { copertina_url?: unknown; contenuto_json?: unknown },
  giaNominati: string[],
  attoreId: unknown,
): string[] {
  return [
    ...percorsiPubbliciEstranei(contenuto, giaNominati, attoreId),
    ...percorsiSostaEstranei(contenuto, giaNominati, attoreId),
  ]
}

/**
 * Questa riga nomina quel percorso? Domanda ESATTA, sulla riga già in mano.
 *
 * È l'UNICA definizione di «nominare» che il modulo usa, e questo è il punto: la
 * passata non filtra niente nel database, quindi ogni riga letta passa di qui e
 * ciò che si cerca coincide per costruzione con ciò che si conferma. La prima
 * stesura chiedeva al database tre colonne di TESTO e poi confermava guardando
 * anche `contenuto_json`: una riga che nomina il file solo nel JSON non tornava
 * mai, e il primo ramo qui sotto era irraggiungibile proprio nel caso che doveva
 * salvare (vedi la testata del file).
 *
 * Due sorgenti, e servono entrambe:
 *  · `percorsiPubbliciDelPost` — la stessa definizione che usano il ritiro, la
 *    `DELETE` e la `PATCH`, cioè copertina + ogni stringa del rich-text;
 *  · il testo grezzo di `copertina_url`/`contenuto_html`/`contenuto_testo`, che è
 *    ciò che `/api/news/feed` serve davvero al pubblico: una riga il cui HTML
 *    mostra ancora quell'immagine la sta usando, anche se il JSON non la cita più.
 */
function nominaIlPercorso(riga: PostPermanenza, percorso: string): boolean {
  if (percorsiPubbliciDelPost(riga).includes(percorso)) return true
  for (const t of [riga.copertina_url, riga.contenuto_html, riga.contenuto_testo]) {
    if (typeof t === 'string' && t.includes(percorso)) return true
  }
  return false
}

/** I motivi di nascondimento che significano «i file di questa riga sono usciti». */
const MOTIVI_DI_RITIRO: readonly string[] = [MOTIVO_CONSENSO_REVOCATO, MOTIVO_OBLIO]

/**
 * Una riga già ritirata per consenso caduto o per oblio NON trattiene più niente.
 *
 * ─── LA REGRESSIONE CHE CHIUDE (giro 2, 2026-08-03) ─────────────────────────
 *
 * `ritiraPost` scrive `nascosta` SOLO dopo una liberazione riuscita: una riga in
 * questo stato ha già perso i propri file, e se qualcuno è rimasto è unicamente
 * perché in quell'istante un'ALTRA riga lo nominava. Contarla come «qualcuno che
 * lo nomina» produceva l'ostaggio reciproco: post A e post B ritraggono lo stesso
 * bambino e usano la stessa foto, A non libera per colpa di B, B non libera per
 * colpa di A, tutti e due finiscono `nascosta` — e `nascosta` non è in
 * `STATI_SORVEGLIATI`, quindi nessuna passata li riprende MAI. La foto del minore
 * resta a un indirizzo PUBBLICO per sempre, con un solo `warn`.
 *
 * Il verso opposto è sicuro: una riga ritirata per consenso non ha più titolo a
 * tenere una foto pubblica, quindi ignorarla non può proteggere niente che vada
 * protetto. Gli altri motivi di nascondimento — `instagram-non-raggiungibile`, per
 * dire — NON entrano qui: quelle righe hanno ancora i loro file, e i loro file
 * sono ancora loro.
 */
function giaRitirataPerConsenso(riga: PostPermanenza): boolean {
  return riga.stato === 'nascosta' && MOTIVI_DI_RITIRO.includes(String(riga.nascosta_motivo ?? ''))
}

/**
 * La forma di un id che si può nominare dentro un filtro PostgREST senza
 * ambiguità: `in.(a,b)` separa con la virgola, e un valore che ne contiene una
 * cambierebbe la domanda invece del risultato. Gli id di `news_posts` sono uuid,
 * quindi in pratica passano tutti — e ciò che non passa non resta scoperto: la
 * stessa esclusione è applicata una seconda volta sulle righe lette.
 */
const ID_FILTRABILE = /^[0-9a-zA-Z-]+$/

/** L'esito della domanda «c'è ancora qualcuno che lo nomina?». */
export interface EsitoCitazioni {
  /**
   * `false` se non si è potuto SAPERE. Chi chiama non deve rimuovere niente: il
   * gesto è irreversibile e potrebbe cadere sull'immagine di un altro articolo.
   */
  verificato: boolean
  /** I percorsi che almeno un'ALTRA riga di `news_posts` continua a nominare. */
  citati: string[]
}

/**
 * «C'è ancora qualcuno che lo nomina?» — in un posto solo, per tutte e tre le
 * strade che liberano.
 *
 * È la stessa domanda di `rimuoviSeNessunAvvisoLoUsa`
 * (`src/lib/allegati/rimozione.ts`), e per la stessa ragione: il bucket è UNO per
 * tutte e tre le sedi, e un file cancellato non si recupera. La ricerca è perciò
 * DELIBERATAMENTE senza filtro di sede — filtrare per plesso qui renderebbe il
 * controllo meno sicuro, non più: cancellerebbe l'immagine di Aversa perché
 * l'attore è di Giugliano. Della riga trovata non esce niente: solo il fatto che
 * esista, e i conteggi.
 *
 * SI ESCLUDONO LE RIGHE CHE STANNO PERDENDO I PROPRI FILE, e non è un dettaglio.
 * Tutte e tre le strade liberano PRIMA di toccare la riga, quindi al momento della
 * domanda il post cita ancora i propri file: senza l'esclusione la risposta sarebbe
 * sempre «sì, qualcuno lo nomina» e non uscirebbe più niente — il difetto V4, cioè
 * l'opposto di quello che questa funzione chiude. L'elenco è PLURALE e non un id
 * solo perché una passata di ritiro ne tratta molti insieme: se ciascuno guardasse
 * solo sé stesso, due post che ritraggono lo stesso bambino con la stessa foto si
 * terrebbero in ostaggio a vicenda e la foto resterebbe pubblica per sempre (la
 * regressione del giro 1, vedi `giaRitirataPerConsenso`).
 *
 * NESSUN FILTRO SUL CONTENUTO: si leggono le righe a pagine e si applica a
 * ciascuna `nominaIlPercorso`. Il perché sta nella testata del file — cercare in
 * tre colonne e confermare su quattro voleva dire, per una riga che nomina il file
 * solo nel `contenuto_json`, non trovarla mai e cancellarle il file sotto.
 */
export async function percorsiCitatiDaAltriPost(
  supabase: SupabaseClient,
  percorsi: string[],
  postIdEsclusi: string[],
  op: string,
): Promise<EsitoCitazioni> {
  const cercati = [
    ...new Set(percorsi.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0)),
  ]
  if (cercati.length === 0) return { verificato: true, citati: [] }

  const esclusi = new Set(
    postIdEsclusi.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0),
  )
  const filtrabili = [...esclusi].filter((x) => ID_FILTRABILE.test(x))
  // L'id del primo escluso è quello che finisce nei log: identifica l'operazione
  // senza dire niente di nessuno (è un uuid di riga, non di persona).
  const postId = postIdEsclusi[0] ?? ''

  const citati = new Set<string>()
  const restanti = new Set(cercati)
  for (let pagina = 0; pagina < PAGINE_MAX; pagina++) {
    const da = pagina * LOTTO_RIGHE
    let q = supabase
      .from('news_posts')
      .select('id, stato, nascosta_motivo, copertina_url, contenuto_json, contenuto_html, contenuto_testo')
      // ORDINE DETERMINISTICO: senza, `range()` su pagine successive può ridare la
      // stessa riga e saltarne un'altra — cioè una riga che nomina il file non
      // viene letta MAI e il file di un altro post esce lo stesso.
      .order('id', { ascending: true })
      .range(da, da + LOTTO_RIGHE - 1)
    if (filtrabili.length > 0) q = q.not('id', 'in', `(${filtrabili.join(',')})`)
    const { data, error } = await q

    // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo un guasto
    // di lettura passerebbe per «nessun altro lo usa» e il file di un altro post
    // sparirebbe proprio nel momento in cui se ne sa di meno.
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: op, esito: 'schema-assente', post_id: postId })
        return { verificato: false, citati: [] }
      }
      logEvento('news', 'error', {
        operazione: op,
        esito: 'citazioni-non-lette',
        post_id: postId,
        n_file: cercati.length,
        msg: `${op}: non si è potuto sapere se questi file siano nominati da un altro post, quindi non si rimuove niente`,
      }, error)
      return { verificato: false, citati: [] }
    }

    const righe = (Array.isArray(data) ? data : []) as PostPermanenza[]
    for (const r of righe) {
      // L'esclusione una SECONDA volta, sulle righe già lette: se il filtro del
      // database non fosse arrivato (id di forma inattesa, o `not` ignorato da un
      // client), la riga del post stesso risponderebbe di sé e non uscirebbe più
      // nessun file. Costa niente e toglie di mezzo un'intera classe di guasti.
      if (esclusi.has(String(r.id))) continue
      if (giaRitirataPerConsenso(r)) continue
      for (const p of [...restanti]) {
        if (nominaIlPercorso(r, p)) {
          citati.add(p)
          restanti.delete(p)
        }
      }
    }
    // Non c'è più niente da sapere: ogni percorso ha già trovato chi lo nomina.
    if (restanti.size === 0) return { verificato: true, citati: [...citati] }
    // Pagina più corta del lotto = ultima pagina. La passata è COMPLETA, quindi
    // sui percorsi rimasti la risposta è «nessuno», non «non lo so».
    if (righe.length < LOTTO_RIGHE) return { verificato: true, citati: [...citati] }
  }

  // Il tetto ha morso: oltre non ha guardato nessuno, quindi sui percorsi rimasti
  // la risposta non è «nessuno lo nomina» — e qui «non lo so» non autorizza una
  // `remove()`. Mai il percorso nel log: contiene l'uuid di chi ha caricato e il
  // nome del file scelto da una persona.
  logEvento('news', 'error', {
    operazione: op,
    esito: 'tetto-citazioni-raggiunto',
    post_id: postId,
    n_post: PAGINE_MAX * LOTTO_RIGHE,
    n_file: restanti.size,
    msg: `${op}: guardati ${PAGINE_MAX * LOTTO_RIGHE} post senza esaurirli, quindi non si può escludere che qualcun altro nomini questi file e non si rimuove niente. Serve una colonna testuale generata su contenuto_json per tornare a una query mirata`,
  })
  return { verificato: false, citati: [] }
}

/** L'esito della liberazione: `liberato` è l'UNICA condizione per toccare la riga. */
export interface EsitoLiberazione {
  /** `true` se nessun file di questo post resta nel bucket pubblico. */
  liberato: boolean
  /** Usciti adesso dal bucket. */
  rimossi: number
  /** Ancora presenti, o di stato ignoto: bloccano. */
  nonRimossi: number
  /**
   * Lasciati apposta dove sono, perché un'ALTRA riga li nomina ancora. NON
   * bloccano: la riga di questo post può smettere di nominarli comunque — è il
   * file che non si tocca, non l'operazione.
   */
  trattenuti: number
  /**
   * I percorsi che NON sono più nel bucket: usciti adesso o già assenti.
   *
   * Serve a `ritiraPost` per smettere di nominarli nella riga. Una riga che
   * continua a citare un file che non esiste più non è un dettaglio estetico: è
   * una citazione fantasma che la prossima domanda «c'è ancora qualcuno che lo
   * nomina?» conta come «sì», e che quindi può trattenere nel bucket pubblico la
   * foto di un altro bambino. Sono i percorsi TENTATI e riusciti, mai i
   * `trattenuti` — quelli il file ce l'hanno ancora, e la riga fa bene a nominarlo.
   */
  percorsiUsciti: string[]
}

/**
 * Toglie dal bucket PUBBLICO i percorsi indicati e dice se ci è riuscita.
 *
 * ─── PRIMA IL FILE (VERIFICATO), POI LA RIGA ────────────────────────────────
 *
 * È l'ordine che il repo ha adottato il 2026-08-02 (testata di
 * `rimuoviFileOblio` in `@/lib/gdpr/esegui`), e qui la ragione è ancora più
 * stretta che nell'oblio. Toccare prima la riga significherebbe:
 *  · se poi la `remove()` fallisce, la foto resta a un indirizzo PUBBLICO —
 *    guasto invisibile, esattamente quello che questo modulo esiste per chiudere;
 *  · e il post, passato a `nascosta` (o cancellato), esce dagli stati sorvegliati:
 *    nessuna passata futura lo riprenderebbe, e nel caso della cancellazione non
 *    resterebbe nemmeno una riga da cui ritrovare il file. Il guasto invisibile
 *    diventerebbe PERMANENTE.
 * Al contrario, togliere il file e fallire l'aggiornamento lascia un articolo con
 * l'immagine rotta: visibile, correggibile, e la foto del bambino è già sparita.
 *
 * ─── PERCHÉ PRENDE DEI PERCORSI E NON UN POST ───────────────────────────────
 *
 * Perché le strade che devono liberare file sono TRE, e solo due liberano tutto:
 *  · il RITIRO per consenso caduto → tutti i file del post;
 *  · `DELETE /api/news/[id]` → tutti i file del post (difetto V4 del 2026-08-03);
 *  · `PATCH /api/news/[id]` → solo quelli che la riga SMETTE di nominare, cioè
 *    la copertina sostituita o l'immagine tolta dal rich-text (difetto W1 dello
 *    stesso giorno: la riga smetteva di nominarli e restavano pubblici per
 *    sempre, irraggiungibili da revoca e oblio, che partono dalla riga corrente).
 * `liberaFilePubbliciDelPost` è il caso particolare «tutti quelli del post». Una
 * regola valida per tre strade scritta in tre posti diverge in silenzio alla
 * prima modifica: è letteralmente la causa radice di questa serie di difetti.
 *
 * ─── PRIMA DELLA `remove()`: DI CHI È QUESTO FILE? ──────────────────────────
 *
 * Ed è per questo che il controllo di proprietà sta QUI e non nelle tre rotte:
 * questo è l'imbuto da cui passano tutte. Vedi la testata del file, sezione
 * «c'è ancora qualcuno che lo nomina?».
 *
 * COSA SUCCEDE AL FILE CHE UN ALTRO POST NOMINA: resta dov'è, e l'operazione
 * prosegue. È il FILE che non si tocca, non l'operazione — bloccarla vorrebbe dire
 * che nessuno può più modificare o cancellare un post che cita l'immagine di un
 * altro. Il ritiro a cascata, invece, sarebbe l'attacco moltiplicato per uno:
 * basterebbe nominare il file di un altro per farlo sparire dalla vista.
 *
 * QUANDO IL FILE TRATTENUTO È LA FOTO DI UN BAMBINO IL CUI CONSENSO È CADUTO, e
 * qui la testata precedente diceva il falso: prometteva che «la strada corretta —
 * ritirare anche quel post — la percorre la passata stessa, perché anche lui
 * dichiara il bambino». Non era vero, e la trappola è esattamente quella che
 * questo file denuncia altrove: ritirare il secondo post non liberava niente,
 * perché il primo — ormai `nascosta` — continuava a nominare il file. Da oggi la
 * cosa è vera per costruzione, da due capi: la passata esclude in blocco tutti i
 * post che sta per ritirare, e una riga già ritirata per consenso/oblio non conta
 * più come chi lo nomina (`giaRitirataPerConsenso`). Resta il caso in cui a
 * trattenerlo è un post che il bambino NON lo dichiara: lì il file resta pubblico,
 * il `warn` qui sotto lo dice e il conteggio `trattenuti` risale fino al cron —
 * perché un file che nessuna passata riesce a togliere deve diventare una cosa che
 * si vede, non una riga di log che si ripete.
 */
export async function liberaPercorsiPubblici(
  supabase: SupabaseClient,
  percorsi: string[],
  postId: string,
  op: string,
  /**
   * Gli ALTRI post che questa stessa operazione sta ritirando, e che quindi non
   * hanno più titolo a trattenere niente. Vuoto per `PATCH` e `DELETE`, che
   * lavorano su una riga sola; pieno per la passata del consenso e per l'oblio.
   */
  ancheRitirati: string[] = [],
): Promise<EsitoLiberazione> {
  const richiesti = [
    ...new Set(percorsi.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0)),
  ]
  if (richiesti.length === 0) {
    return { liberato: true, rimossi: 0, nonRimossi: 0, trattenuti: 0, percorsiUsciti: [] }
  }

  const citazioni = await percorsiCitatiDaAltriPost(
    supabase,
    richiesti,
    [postId, ...ancheRitirati],
    op,
  )
  if (!citazioni.verificato) {
    // «Non lo so» non vale «demolisci» — la stessa asimmetria col gate dichiarata
    // in testa al file. `percorsiCitatiDaAltriPost` ha già gridato col corpo
    // dell'errore: qui si aggiunge la sola conseguenza, cioè che la riga non si
    // tocca e chi ha chiamato deve ritentare.
    logEvento('news', 'error', {
      operazione: op,
      esito: 'proprieta-file-non-verificata',
      post_id: postId,
      n_file: richiesti.length,
      msg: `${op}: non si sa se questi file siano ancora nominati da un altro post, quindi non si rimuove niente e la riga non si tocca`,
    })
    return { liberato: false, rimossi: 0, nonRimossi: richiesti.length, trattenuti: 0, percorsiUsciti: [] }
  }

  const trattenuti = citazioni.citati.length
  if (trattenuti > 0) {
    // Evento che cambia l'esito → si logga, anche quando tutto il resto va bene:
    // senza questa riga «eliminato, 0 file» non distinguerebbe un post senza
    // immagini da uno le cui immagini sono rimaste pubbliche perché di un altro.
    logEvento('news', 'warn', {
      operazione: op,
      esito: 'file-nominato-da-un-altro-post',
      post_id: postId,
      n_file: trattenuti,
      msg: `${op}: ${trattenuti} file restano nel bucket pubblico perché un'altra riga di news_posts li nomina ancora`,
    })
  }
  const daLiberare = richiesti.filter((p) => !citazioni.citati.includes(p))
  if (daLiberare.length === 0) {
    return { liberato: true, rimossi: 0, nonRimossi: 0, trattenuti, percorsiUsciti: [] }
  }

  // La regola su cosa significa un `remove()` incompleto vive in un posto solo:
  // si verifica lo STATO dei file, non il conteggio. Un file già assente è esito
  // raggiunto; un file ancora presente è un guasto e blocca.
  const esito = await rimuoviEVerifica(supabase, NEWS_BUCKET, daLiberare, op)
  const fermi = esito.erroreRimozione ? daLiberare : bloccanti(esito)
  if (fermi.length > 0) {
    // `rimuoviEVerifica` ha già scritto la riga nel canale degli errori, col
    // corpo dell'errore del provider. Qui si aggiunge il solo fatto che manca:
    // QUALE post resta con i file al loro posto, e per questo non si tocca.
    logEvento('news', 'error', {
      operazione: op,
      esito: 'file-pubblici-non-liberati',
      post_id: postId,
      n_file: fermi.length,
      msg: `${op}: la riga non si tocca perché ${fermi.length} file non sono usciti dal bucket pubblico`,
    })
    return {
      liberato: false,
      rimossi: esito.rimossi.length,
      nonRimossi: fermi.length,
      trattenuti,
      percorsiUsciti: [],
    }
  }
  // «Usciti» comprende i già assenti: l'esito voluto è raggiunto per entrambi, e
  // la riga non deve continuare a nominare né gli uni né gli altri.
  return {
    liberato: true,
    rimossi: esito.rimossi.length,
    nonRimossi: 0,
    trattenuti,
    percorsiUsciti: daLiberare,
  }
}

/** Tutti i file del post fuori dal bucket pubblico: il ritiro e la cancellazione. */
export async function liberaFilePubbliciDelPost(
  supabase: SupabaseClient,
  post: { id: string; copertina_url?: unknown; contenuto_json?: unknown },
  op: string,
  /** Vedi `liberaPercorsiPubblici`: gli altri post che la stessa passata ritira. */
  ancheRitirati: string[] = [],
): Promise<EsitoLiberazione> {
  return liberaPercorsiPubblici(supabase, percorsiPubbliciDelPost(post), post.id, op, ancheRitirati)
}

/**
 * Toglie dai campi della riga gli indirizzi dei file che non esistono più.
 *
 * ─── PERCHÉ UNA RIGA NON PUÒ CONTINUARE A NOMINARE UN FILE CANCELLATO ───────
 *
 * Perché «chi lo nomina?» è la domanda su cui poggia tutta la liberazione, e una
 * citazione fantasma è una risposta sbagliata che sembra giusta: la prossima volta
 * che qualcun altro prova a liberare quello stesso percorso, questa riga risponde
 * «io» e il file resta nel bucket PUBBLICO. Su un file già cancellato non fa danno;
 * su un file che nel frattempo esiste di nuovo, sì. Vale anche fuori dal codice:
 * un articolo che cita un'immagine inesistente è un articolo rotto, e nasconderlo
 * non lo ripara.
 *
 * Si toglie il MINIMO: la copertina torna `null`, e nel rich-text si svuotano
 * SOLO le stringhe che contengono uno dei percorsi usciti (il nodo `image` resta,
 * con `src` vuoto — che il sanitizer scarta). Il testo dell'articolo non si tocca:
 * il post è nascosto, non cancellato, e la scuola deve poterlo ripubblicare con
 * una copertina nuova.
 */
function senzaIPercorsi(post: PostPermanenza, usciti: string[]): Record<string, unknown> {
  if (usciti.length === 0) return {}
  const nomina = (v: unknown): v is string => typeof v === 'string' && usciti.some((p) => v.includes(p))
  const patch: Record<string, unknown> = {}
  if (nomina(post.copertina_url)) patch.copertina_url = null
  if (percorsiPubbliciDelPost({ contenuto_json: post.contenuto_json }).some((p) => usciti.includes(p))) {
    patch.contenuto_json = mappaOgniStringa(post.contenuto_json, (s) => (nomina(s) ? '' : s))
  }
  // Le due colonne DERIVATE: si toglie l'occorrenza dell'indirizzo, non il testo.
  // Restano un `<img src="…/public/news/">` monco e un articolo leggibile, invece
  // di una riga che promette una foto che non c'è.
  for (const c of ['contenuto_html', 'contenuto_testo'] as const) {
    const v = post[c]
    if (nomina(v)) patch[c] = usciti.reduce((acc, p) => acc.split(p).join(''), v)
  }
  return patch
}

/**
 * Ritira un post dalla vista pubblica e toglie i suoi file dal bucket.
 *
 * L'ordine — e il perché — stanno in `liberaFilePubbliciDelPost`, qui sopra: se
 * restano file «ancora presenti» o «incerti» la riga NON si tocca, e il tick
 * successivo ritenta tutto da capo.
 */
async function ritiraPost(
  supabase: SupabaseClient,
  post: PostPermanenza,
  motivo: string,
  op: string,
  opz: {
    /** Gli uuid dei bambini che restano dichiarati (l'oblio toglie il suo). */
    ritrattiRimanenti?: string[]
    /** Gli altri post che questa stessa passata sta ritirando. */
    ancheRitirati?: string[]
  } = {},
): Promise<{ ritirato: boolean; rimossi: number; nonRimossi: number; trattenuti: number }> {
  const liberazione = await liberaFilePubbliciDelPost(
    supabase,
    { ...post, id: post.id },
    op,
    opz.ancheRitirati ?? [],
  )
  if (!liberazione.liberato) {
    return {
      ritirato: false,
      rimossi: liberazione.rimossi,
      nonRimossi: liberazione.nonRimossi,
      trattenuti: liberazione.trattenuti,
    }
  }
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...senzaIPercorsi(post, liberazione.percorsiUsciti),
  }
  // Non solo gli stati ESPOSTI: anche una bozza va marcata come ritirata. Il suo
  // file era già pubblico (`promuoviMediaBozza` lo promuove alla creazione) e
  // adesso non c'è più; lasciare la riga in `bozza` la farebbe riprendere a ogni
  // passata, per sempre, su file che non esistono più. Vedi `STATI_SORVEGLIATI`.
  if (STATI_SORVEGLIATI.includes((post.stato ?? '') as (typeof STATI_SORVEGLIATI)[number])) {
    patch.stato = 'nascosta'
    patch.nascosta_motivo = motivo
  }
  if (opz.ritrattiRimanenti) patch.bambini_ritratti = opz.ritrattiRimanenti

  // PostgREST non lancia: ritorna `{ error }`. Un try/catch qui non scatterebbe mai.
  const { error } = await supabase.from('news_posts').update(patch).eq('id', post.id)
  if (error) {
    logEvento('news', 'error', {
      operazione: op,
      esito: 'ritiro-non-riuscito',
      post_id: post.id,
      n_file: liberazione.rimossi,
      msg: `${op}: file rimossi ma il post è rimasto pubblicato con l'immagine rotta`,
    }, error)
    return { ritirato: false, rimossi: liberazione.rimossi, nonRimossi: 0, trattenuti: liberazione.trattenuti }
  }

  // Nel log solo il post e i conteggi: gli uuid dei bambini restano fuori.
  logEvento('news', 'warn', {
    operazione: op,
    esito: `ritirato-${motivo}`,
    post_id: post.id,
    n_file: liberazione.rimossi,
  })
  return { ritirato: true, rimossi: liberazione.rimossi, nonRimossi: 0, trattenuti: liberazione.trattenuti }
}

/**
 * Rilegge il consenso di TUTTI i post sorvegliati che dichiarano bambini
 * ritratti e ritira quelli il cui consenso non regge più.
 *
 * «Sorvegliati» e non «esposti»: la foto è pubblica dalla CREAZIONE del post, non
 * dalla sua pubblicazione — vedi `STATI_SORVEGLIATI`.
 *
 * Tre condizioni, tutte trattate come «il consenso non c'è più»:
 *  · `consenso_foto_sito` non è più `true` → la famiglia ha REVOCATO;
 *  · `anonimizzato_il` valorizzato → l'oblio è stato eseguito. `patchAlunno` NON
 *    tocca la colonna del consenso: guardare solo la spunta lascerebbe online la
 *    foto di un bambino cancellato, che è precisamente il difetto #1;
 *  · la riga non torna indietro → il minore non esiste più. Fail-closed: un id
 *    che non si sa spiegare non autorizza niente.
 */
export async function verificaPermanenzaConsenso(supabase: SupabaseClient, op: string): Promise<EsitoPermanenza> {
  const esito = vuoto()

  const { data, error } = await supabase
    .from('news_posts')
    .select('id, stato, bambini_ritratti, copertina_url, contenuto_json')
    .in('stato', [...STATI_SORVEGLIATI])
    .not('bambini_ritratti', 'is', null)
    // ORDINE DETERMINISTICO, e non è un abbellimento: senza `.order()`
    // PostgreSQL non promette nessun ordine, quindi con più di `LIMITE_POST`
    // post sorvegliati il taglio cade ogni volta su un sottoinsieme diverso — e
    // un post può non essere riletto MAI, cioè una revoca può non arrivare mai.
    // Si parte dai più vecchi per data di modifica: sono quelli il cui consenso
    // è stato riletto più tempo fa, e il ritiro riscrive `updated_at`, quindi
    // ciò che viene trattato esce dalla testa della coda. `id` rompe il pareggio:
    // due righe con lo stesso istante tornerebbero altrimenti in ordine libero.
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(LIMITE_POST)
  if (error) {
    if (schemaAssente(error)) {
      // DB E2E della CI non migrato: la dichiarazione non esiste, quindi non c'è
      // nessun consenso da rileggere. Si degrada in silenzio, come ovunque.
      logEvento('news', 'info', { operazione: op, esito: 'schema-assente' })
      return { ...esito, disponibile: false }
    }
    logEvento('news', 'error', { operazione: op, esito: 'post-non-riletti' }, error)
    return { ...esito, verificato: false }
  }

  const letti = (data ?? []) as PostPermanenza[]
  if (letti.length === LIMITE_POST) {
    // IL TETTO HA MORSO. Il conto è sulle righe LETTE, non su quelle esaminate:
    // il taglio avviene nel database, prima di qualunque filtro nostro.
    // Il 2026-08-03 la popolazione sorvegliata è stata allargata (aggiunti
    // `bozza` e `proposta`) a parità di tetto, e nei log non c'era una riga sola
    // che lo dicesse: una passata monca è indistinguibile da una completa, e
    // «nessun ritiro» si legge come «tutto in regola». L'ordinamento qui sopra
    // rende il taglio ripetibile, non lo elimina: finché resta un solo lotto,
    // questo warn è l'unica cosa che dice il giorno in cui serve paginare.
    logEvento('news', 'warn', {
      operazione: op,
      esito: 'tetto-post-raggiunto',
      n_post: letti.length,
      msg: `${op}: letti ${LIMITE_POST} post sorvegliati, cioè il massimo per passata: oltre questo numero una parte non viene riletta`,
    })
  }
  const posts = letti.filter((p) => ritrattiDi(p).length > 0)
  esito.esaminati = posts.length
  if (posts.length === 0) {
    // Evento critico → si logga anche il SUCCESSO: senza questa riga «nessun log»
    // direbbe insieme «tutto in regola» e «la sorveglianza non è mai partita».
    logEvento('news', 'info', { operazione: op, esito: 'permanenza-verificata', n_post: 0, n_ritirati: 0 })
    return esito
  }

  const ids = [...new Set(posts.flatMap(ritrattiDi))]
  const { data: rows, error: errAlunni } = await supabase
    .from('alunni')
    .select(`id, ${COLONNA_CONSENSO_SITO}, anonimizzato_il`)
    .in('id', ids)
  if (errAlunni) {
    if (schemaAssente(errAlunni)) {
      logEvento('news', 'info', { operazione: op, esito: 'schema-assente', n_post: posts.length })
      return { ...esito, disponibile: false }
    }
    // Il consenso NON è stato riletto: non si ritira niente (il gesto è
    // irreversibile) e non si tace (chi legge i log deve poter distinguere
    // «verificato, tutto a posto» da «non ho potuto guardare»).
    logEvento('news', 'error', { operazione: op, esito: 'consensi-non-riletti', n_post: posts.length }, errAlunni)
    return { ...esito, verificato: false }
  }

  const perId = new Map(
    ((rows ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]),
  )

  // ─── PRIMA SI DECIDE CHI ESCE, POI SI ESCE ─────────────────────────────────
  // L'elenco completo dei post che questa passata sta per ritirare si calcola
  // TUTTO qui, prima di toccare un solo file, e viaggia dentro ogni liberazione.
  // Il motivo è la regressione del giro 1: due post che ritraggono lo stesso
  // bambino e condividono la stessa foto, esaminati uno per volta, si tenevano in
  // ostaggio a vicenda — il primo non liberava perché il secondo nominava il file,
  // il secondo non liberava perché lo nominava il primo — e finivano tutti e due
  // `nascosta`, stato che nessuna passata riprende: la foto del minore restava a
  // un indirizzo PUBBLICO per sempre. Chi sta per perdere i propri file non è più
  // padrone di niente, e la passata lo sa in anticipo.
  const daRitirare: { post: PostPermanenza; motivo: string }[] = []
  for (const post of posts) {
    let motivo: string | null = null
    for (const id of ritrattiDi(post)) {
      const r = perId.get(id)
      if (!r || r.anonimizzato_il != null) {
        motivo = MOTIVO_OBLIO
        break
      }
      if (r[COLONNA_CONSENSO_SITO] !== true) motivo = MOTIVO_CONSENSO_REVOCATO
    }
    if (motivo) daRitirare.push({ post, motivo })
  }
  const idsInRitiro = daRitirare.map((x) => x.post.id)

  for (const { post, motivo } of daRitirare) {
    const r = await ritiraPost(supabase, post, motivo, op, { ancheRitirati: idsInRitiro })
    if (r.ritirato) esito.ritirati++
    esito.fileRimossi += r.rimossi
    esito.fileNonRimossi += r.nonRimossi
    esito.fileTrattenuti += r.trattenuti
  }

  logEvento('news', 'info', {
    operazione: op,
    esito: 'permanenza-verificata',
    n_post: esito.esaminati,
    n_ritirati: esito.ritirati,
    n_file: esito.fileRimossi,
  })
  if (esito.fileTrattenuti > 0) {
    // Un `warn` per post lo diceva già, ma si ripete a ogni passata e affoga nel
    // rumore: qui c'è il TOTALE della passata, che è il numero che il cron fa
    // risalire. Sono foto di bambini il cui consenso è caduto e che restano a un
    // indirizzo pubblico: se nessuno le conta, nessuno le toglierà mai.
    logEvento('news', 'error', {
      operazione: op,
      esito: 'file-trattenuti-dopo-il-ritiro',
      n_post: esito.ritirati,
      n_file: esito.fileTrattenuti,
      msg: `${op}: ${esito.fileTrattenuti} file restano nel bucket pubblico dopo un ritiro per consenso o oblio, perché un altro post che non dichiara quel bambino li nomina ancora`,
    })
  }
  return esito
}

/**
 * L'oblio del minore applicato al blog pubblico: i post che lo ritraggono escono
 * dalla vista, i loro file escono dal bucket e il suo uuid sparisce dalla
 * dichiarazione.
 *
 * DIFFERENZA VOLUTA DALLA GALLERIA. Lì una foto di gruppo resta e si toglie solo
 * il tag, perché quel bucket è privato e la foto la vedono solo le famiglie dei
 * bambini ritratti: l'oblio di uno non autorizza a cancellare il dato altrui. Qui
 * l'indirizzo è PUBBLICO, e lasciare il file vorrebbe dire lasciare online
 * l'immagine di chi ha chiesto la cancellazione. Esce il file, resta il post
 * (nascosto) con gli altri uuid al loro posto: la scuola può ripubblicarlo con
 * una copertina nuova.
 *
 * CHI LA CHIAMA. `anonimizzaAlunno` (`src/lib/gdpr/esegui.ts`, punto 3g-bis):
 * l'oblio arriva qui SUBITO, nello stesso gesto che anonimizza il minore. Fino
 * al 2026-08-03 questa riga non c'era e la testata diceva «non è ancora chiamata
 * da nessuno, è il gancio per quando la si aggancerà»: era vera quando è stata
 * scritta e ha smesso di esserlo poche ore dopo, senza che nessun test cadesse.
 * Un commento che descrive un mondo che non c'è più è una trappola — chi legge
 * si fida — e questa in particolare avrebbe fatto credere che il bucket pubblico
 * fosse coperto dal solo tick.
 *
 * Il tick resta, e non è ridondanza: prende i casi che di qui non passano — la
 * revoca senza oblio, i post fermi in bozza, e il minore la cui riga sparisce
 * senza passare da `anonimizzaAlunno`.
 */
export async function obliaFotoNewsAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<{
  ritirati: number
  fileRimossi: number
  fileNonRimossi: number
  fileTrattenuti: number
  /**
   * ⚠️ «HO POTUTO GUARDARE `news_posts`?», e non è una sfumatura.
   *
   * Aggiunto il 2026-08-13. Con i soli conteggi, un `42501 permission denied` su
   * questa SELECT era indistinguibile da «nessun articolo lo ritrae»: il
   * chiamante dichiarava successo e l'articolo restava `stato = 'pubblicata'`
   * sul sito PUBBLICO, cioè con la foto di un bambino a un indirizzo che
   * conosce chiunque. Lo schema assente (DB della CI non migrato) resta `true`:
   * lì il vuoto è la risposta giusta, non un guasto.
   */
  letto: boolean
}> {
  const conteggio = { ritirati: 0, fileRimossi: 0, fileNonRimossi: 0, fileTrattenuti: 0, letto: true }
  const id = (alunnoId ?? '').trim()
  if (!id) return conteggio

  const { data, error } = await supabase
    .from('news_posts')
    .select('id, stato, bambini_ritratti, copertina_url, contenuto_json, contenuto_html, contenuto_testo')
    .contains('bambini_ritratti', [id])
  if (error) {
    if (!schemaAssente(error)) {
      logEvento('news', 'error', { operazione: op, esito: 'oblio-news-post-non-letti' }, error)
      return { ...conteggio, letto: false }
    }
    return conteggio
  }

  const posts = ((data ?? []) as PostPermanenza[]).filter((p) => ritrattiDi(p).includes(id))
  // Tutti insieme, come nella passata del consenso: due articoli che ritraggono
  // QUESTO bambino e condividono la stessa foto si trattenevano il file a vicenda,
  // e l'oblio non toglieva niente. L'elenco è già noto qui, e va passato intero.
  const ids = posts.map((p) => p.id)
  for (const post of posts) {
    const altri = ritrattiDi(post).filter((x) => x !== id)
    const r = await ritiraPost(supabase, post, MOTIVO_OBLIO, op, {
      ritrattiRimanenti: altri,
      ancheRitirati: ids,
    })
    if (r.ritirato) conteggio.ritirati++
    conteggio.fileRimossi += r.rimossi
    conteggio.fileNonRimossi += r.nonRimossi
    conteggio.fileTrattenuti += r.trattenuti
  }
  if (conteggio.fileTrattenuti > 0) {
    // L'oblio è un diritto esercitato da una persona: se una sua foto resta a un
    // indirizzo pubblico, non può essere un dettaglio dentro un `warn` per post.
    logEvento('news', 'error', {
      operazione: op,
      esito: 'file-trattenuti-dopo-oblio',
      n_post: conteggio.ritirati,
      n_file: conteggio.fileTrattenuti,
      msg: `${op}: ${conteggio.fileTrattenuti} file restano nel bucket pubblico dopo l'oblio del minore, perché un altro post che non lo dichiara li nomina ancora`,
    })
  }
  return conteggio
}
