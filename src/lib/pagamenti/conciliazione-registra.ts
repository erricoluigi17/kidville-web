import type { SupabaseClient } from '@supabase/supabase-js'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { isScuolaE2E } from '@/lib/scuole/reali'
import { pagantiAmmessiPerAlunni } from '@/lib/pagamenti/pagante-ammesso'
// Il predicato «questo documento è ancora vivo?» sta FUORI da qui, e non per
// eleganza: sul riabbinamento di un movimento riaperto si affacciano DUE porte
// (§9), e due definizioni di «viva» direbbero due cose diverse dello stesso
// documento — una fermerebbe, l'altra lascerebbe passare con un 200 sopra.
import { fatturaViva, etichettaFattura, type RigaFatturaEmessa } from '@/lib/pagamenti/fattura-viva'
import {
  puoConfermare,
  violazioniRighe,
  violazioniComposizione,
  scartoQuadratura,
  proponiAncora,
  rigaDaVoceAperta,
  type RigaComposizione,
  type RigaNuova,
  type RigaTicket,
} from '@/lib/pagamenti/conciliazione-composita'

// ─────────────────────────────────────────────────────────────────────────────
// «COMPONI IL PAGAMENTO» — la registrazione, senza l'HTTP che la circonda.
//
// Un bonifico di famiglia non paga quasi mai una voce sola: paga la retta, il
// pomeridiano e i ticket mensa, magari per due fratelli di plessi diversi.
// Finora un movimento bancario si abbinava a UNA voce, e quando l'importo
// superava il residuo la schermata rimbalzava a «Incasso unico» PERDENDO l'id
// del movimento: la riga restava rossa per sempre e un secondo operatore poteva
// riabbinarla, incassando due volte lo stesso denaro.
//
// Questa fetta registra l'intera composizione in UNA transazione, e lega il
// movimento con un compare-and-swap.
//
// ─── PERCHÉ NON STA PIÙ DENTRO L'HANDLER ────────────────────────────────────
// Le porte che arrivano a questa stessa registrazione stanno per diventare più
// d'una (l'import che concilierà da sé), e nessuna di quelle avrà una `Request`
// o un corpo JSON. I NOVE gate qui sotto devono valere per tutte: ricopiarli è il
// modo certo di farli divergere, ed è già successo in questo repository —
// «quando un predicato è scritto in linea in due punti, la correzione è una
// funzione esportata, non due modifiche gemelle».
// Restano fuori, nell'handler: il gate di ruolo, la validazione `zod`, la
// risoluzione delle sedi (il perimetro arriva qui come PARAMETRO, così la
// differenza fra percorso manuale e automatico è dichiarata e non accidentale) e,
// dopo, l'audit, l'avviso alla famiglia e la revoca della sospensione — che sa
// solo il chiamante se vanno fatti.
//
// ─── IL MOTORE NON È QUI, E NON SI RISCRIVE ─────────────────────────────────
// L'atomicità è della RPC `registra_transazione_contabile(p jsonb)`
// (`supabase/migrations/20260912180100_transazione_voci_nuove.sql`): crea le voci
// nuove, gli incassi, le ricariche mensa con il loro ledger, e chiude con il CAS
// sul movimento. Se qualcosa va storto si annulla tutto — nessun incasso orfano,
// nessun ticket accreditato a metà. Il suo contratto è congelato.
//
// ─── COSA PORTA QUESTA FETTA, CHE LA RPC PER COSTRUZIONE NON PUÒ AVERE ──────
// La RPC non ha né `request` né utente chiamante: i gate APPLICATIVI stanno qui,
// e la testata di quella migrazione li elenca uno per uno come obblighi della
// route che l'avrebbe chiamata. Erano sette; dal 2026-09-13 sono NOVE, e i due
// nuovi hanno UNA causa radice sola, che conviene leggere prima dei due
// paragrafi: fino a quel giorno questa rotta trattava il movimento come se fosse
// APPENA ARRIVATO DALLA BANCA, e non leggeva nessuna delle due cose che la
// RIAPERTURA gli conserva apposta — `scuola_id` e `pagamento_id`. Le due
// migrazioni di questa fetta le preservano con un commento che dice perché; qui
// nessuno le guardava. «Movimento riaperto» è uno stato NUOVO, nato in questo
// stesso branch col pulsante d'annullo, e questa è la sua SECONDA porta: la prima
// (`riconciliazione/[id]:PATCH`) le legge entrambe.
//
//  1. GLI ALUNNI NON ATTIVI. La RPC accetta qualunque `alunno_id` che ESISTA.
//     Misurato sul database vivo il 2026-09-13, su 727 alunni: **10 ritirati**
//     (gli stati sono due — `iscritto` e `ritirato`; `archiviato` non esiste),
//     **4 anonimizzati** dall'oblio GDPR (tutti e quattro dentro i dieci
//     ritirati) e **29 della sede fittizia E2E**, che sono invece tutti
//     `iscritto` — cioè lo stato da solo non li vede. Un critico ha incassato
//     davvero per bambini di sedi finte e nessuno l'ha fermato.
//     Il gate vale sulle voci che NASCONO qui. Una voce già a registro resta
//     incassabile anche dopo il ritiro: un insoluto si salda anche quando il
//     bambino non frequenta più, ed è il caso normale di fine anno.
//
//  2. DERIVARE LA SEDE NON È UN GATE. La RPC deriva la sede della voce
//     dall'ALUNNO, il che impedisce di ARCHIVIARE nel plesso sbagliato. Non
//     impedisce a un operatore di Cesa di CREARE e INCASSARE una voce per un
//     bambino di Giugliano: per le voci che nascono lì non esiste il 403 che
//     `pagamenti/transazioni/route.ts` applica alle voci ESISTENTI (cerca
//     «Una o più voci appartengono a un altro plesso»). Qui quel 403 c'è, e
//     copre tutt'e tre le specie: voci esistenti, voci nuove, ticket.
//
//  3. LA SEDE DEL DOCUMENTO È DICHIARATA DAL CLIENT. Decisione n. 15 del
//     titolare: un bonifico che paga figli di plessi diversi produce UN
//     documento solo, intestato a una sede che l'operatore SCEGLIE. Quella sede
//     finisce in `pagamenti_transazioni.scuola_id` e — nuovo — in
//     `riconciliazione_movimenti.scuola_id`. La RPC non la confronta con niente:
//     qui si verifica che sia accessibile a chi la dichiara, E SI LOGGA. Senza
//     quel log «sede scelta dall'operatore» resta una frase in un commento.
//
//  4. `stato_atteso` SI LEGGE DAL MOVIMENTO, mai dal client, e i valori ammessi
//     sono tre: `da_abbinare`, `suggerito`, `ignorato`. `confermato` è escluso
//     apposta: un CAS confermato→confermato riscriverebbe `incasso_id` senza
//     stornare l'incasso precedente e senza la guardia «già fatturato» del
//     riabbinamento — un bonifico da €X inciderebbe 2×€X, con un 200 sopra.
//
//  5. `KV409` → HTTP **409**. Quando il compare-and-swap perde la corsa la RPC
//     solleva con quell'ERRCODE. `transazioni/route.ts` manda tutto a 500 (mappa
//     503 solo su `PGRST202`/`42883`): qui si distingue, perché «hai perso la
//     corsa, ricarica» e «è esploso qualcosa» chiedono due cose diverse.
//
//  6. I TETTI STANNO NELLA `zod` DELLA ROUTE, e sono misurati — vedi `MAX_*` più
//     sotto. Vivono QUI e la `zod` li IMPORTA: chi arriverà dall'automatismo non
//     passa da nessuno schema, quindi i tetti devono stare dove li leggono tutti
//     e due. Una seconda copia nello schema sarebbe la solita coppia di numeri
//     gemelli che un giorno divergono.
//
//  7. IL GATE È UNO SOLO, e si chiama `puoConfermare`. Non si ricompone a mano
//     `violazioniRighe(...).length === 0 && quadra(...)`: due righe sulla STESSA
//     voce che insieme sforano il residuo passavano i controlli separati. E la
//     quadratura si RIFÀ qui: il totale che l'operatrice vede è quello del
//     browser, e fra i due ci vuole una rete.
//
//  8. IL MOVIMENTO HA UNA SEDE, E VA GUARDATA. La `SELECT` portava a casa
//     `scuola_id` e nelle 981 righe non lo usava mai. Sonda del 2026-09-13:
//     movimento con `scuola_id` FUORI dalle sedi attive, stato `da_abbinare` →
//     **200, RPC chiamata**, e nel payload `scuola_id` = la sede DELL'OPERATORE.
//     Il CAS della RPC la scrive (`…180100`: `UPDATE … SET … scuola_id = v_scuola`)
//     con un `WHERE` che confronta il solo stato: un operatore di Cesa consumava
//     il bonifico di Giugliano E GLI RISCRIVEVA LA SEDE — la riga spariva dal
//     filtro di Giugliano, che a quel punto non poteva più nemmeno riaprirla
//     (la riapertura passa da `assertTransazioneInScope`, e la transazione era
//     ormai di Cesa). La rotta sorella quel gate ce l'ha, nel ramo `riapri`:
//     `else if (mov.scuola_id && !sediRiapertura.includes(mov.scuola_id))` → 404.
//     Due scritture che dicevano due cose opposte sulla stessa riga bancaria.
//     Popolazione al 2026-09-13: **0** — i 65 conciliabili hanno tutti
//     `scuola_id` NULL. Ma a crearne è la riapertura, che è di questo branch: né
//     la PATCH né `annulla_transazione` azzerano quella colonna, e il commento
//     della PATCH dice che è DELIBERATO («a NULL la riga sparirebbe dalla vista
//     di sede di chi deve rilavorarla»). Il gate della PATCH esiste per quelle
//     righe: questo è il suo gemello sull'altra porta.
//
//  9. UN BONIFICO NON SI FATTURA DUE VOLTE — e §4 ne copriva solo metà.
//     Escludere `confermato` da `STATI_CONCILIABILI` chiude il caso del movimento
//     MAI riaperto. Ma il caso della rotta sorella non è un confermato: è un
//     movimento RIAPERTO, cioè `da_abbinare` — dentro `STATI_CONCILIABILI`.
//     `annulla_transazione_contabile` riapre il movimento della transazione
//     annullata e gli LASCIA `pagamento_id`, e l'annullo non è un intervento a
//     mano: è un pulsante del registro (`TransazioniPanel`). Il percorso «il
//     bonifico M salda la transazione T ancorata a P1 → su P1 si emette la
//     fattura → si annulla T → M torna in coda → l'operatore lo ricompone su
//     altre voci» è normale amministrazione. Senza questa guardia restavano in
//     circolazione un documento fiscale vivo SENZA l'incasso che lo giustifica,
//     un secondo incasso e una notifica «Pagamento registrato» al genitore — con
//     un 200 sopra e nessuna riga d'errore da nessuna parte. Fail-closed come la
//     sorella: se la lettura non riesce, non si compone (503).
//
// ─── COSA QUESTA FETTA NON FA ───────────────────────────────────────────────
// Niente ECCEDENZA. La quadratura qui è esatta e bloccante (decisione n. 11):
// l'eccedenza → credito famiglia resta la strada di «Incasso unico»
// (`pagamenti/transazioni`), che non si tocca. Alla RPC va sempre
// `eccedenza_a_credito: 0`.
// Niente `ricariche_mensa` (la ricarica SENZA voce si fa da Mensa): qui il
// ticket lascia una riga a registro, ed è `voci_ticket`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codici che significano «la RPC non c'è» — e SOLO quelli. Il DB E2E della CI è
 * un progetto separato e non migrato. Qualunque altro errore è un guasto vero e
 * NON degrada: «la funzione non esiste» e «la funzione è fallita» sono due cose
 * diverse, e confonderle nasconde i guasti.
 */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])
/** Colonna assente su un DB non migrato (SELECT). */
const COLONNA_ASSENTE = '42703'
/** La RPC ha perso il compare-and-swap sul movimento. */
const CAS_PERSO = 'KV409'

/**
 * Gli stati da cui un movimento si può conciliare. Sono TRE, e sono meno dei
 * quattro che la tabella ammette: `confermato` è fuori apposta (vedi §4 in
 * testata). Misurato sul database vivo il 2026-09-13, 239 movimenti: 174
 * `confermato`, 33 `da_abbinare`, 31 `suggerito`, 1 `ignorato` — cioè 65 righe
 * conciliabili, che sono esattamente quelle che questa schermata deve poter
 * chiudere.
 */
const STATI_CONCILIABILI = new Set(['da_abbinare', 'suggerito', 'ignorato'])

/**
 * ⚠️ I TETTI, e la misura che li regge — nessuno è un numero tondo scelto a occhio.
 *
 * `MAX_QUANTITA_TICKET` — la RPC casta la quantità a `int` (`::numeric::int`) e
 * oltre 2 147 483 647 PostgreSQL risponde `22003`, cioè un 500 opaco a metà
 * chiamata. Il motore puro si ferma molto più in alto (`Number.isSafeInteger`,
 * 2⁵³−1: 4,2 milioni di volte tanto), quindi fra i due c'è una finestra larga in
 * cui il browser dice sì e il database esplode. Si chiude qui.
 *
 * `MAX_IMPORTO_EURO` — sopra `Number.MAX_SAFE_INTEGER` il centesimo smette di
 * esistere, e il motore lo dichiara come limite proprio da chiudere nella `zod`
 * della route: una riga da `1e17 + 0,01` contro un movimento da `1e17` dà scarto
 * 0 e `puoConfermare` risponde **true**, perché i due numeri sono lo stesso
 * double. Un bonifico scolastico sta in sei cifre; il tetto è un milione di euro,
 * cioè due ordini di grandezza sopra il caso peggiore plausibile e dodici sotto
 * la soglia in cui l'aritmetica mente.
 *
 * `MAX_RIGHE_PER_ELENCO` / `MAX_RIGHE_TOTALI` — oggi un tetto non c'è né in
 * `zod` né nella RPC: 500 voci passano. Misurato in produzione il 2026-09-13 su
 * 499 famiglie con voci aperte: **massimo 4** voci aperte per famiglia, p99 = 3,
 * media 1,24. Cinquanta per elenco è più di dieci volte il caso peggiore
 * osservato, e sessanta in tutto tiene conto di un bonifico che paghi insieme
 * voci vecchie, voci nuove e ticket di più fratelli.
 *
 * `MAX_DECIMALI_COSTO` — il costo unitario sta a due decimali. Oltre, il conto
 * del browser e quello del database DIVERGONO di un centesimo sull'1,07% dei
 * valori (misurato su 600 000 coppie: `1 × 2,135` → browser 2,13, PostgreSQL
 * 2,14, perché l'uno arrotonda un double e l'altro un `numeric` esatto). Un
 * centesimo di divergenza fra la quadratura e la riga scritta è una cassa che
 * non torna.
 *
 * ⚠️ STANNO QUI E NON NELLA `zod`, dal 2026-09-20: la `zod` li importa. Chi
 * arriverà dall'automatismo non passa da nessuno schema di richiesta, e un tetto
 * che vive solo dentro la validazione HTTP è un tetto che l'automatismo non ha.
 */
export const MAX_QUANTITA_TICKET = 2_147_483_647
export const MAX_IMPORTO_EURO = 1_000_000
export const MAX_RIGHE_PER_ELENCO = 50
export const MAX_RIGHE_TOTALI = 60

/**
 * Le colonne del pagamento che servono al residuo EFFETTIVO e al gate di sede.
 * `sconto` è di Contabilità v2 e sul DB non migrato non esiste (`42703`): si
 * ritenta senza, e `residuoEffettivo` tratta lo sconto assente come 0. Stesso
 * pattern di `/api/pagamenti` e di `riconciliazione/[id]`.
 */
const PAG_SELECT_V2 =
  'id, alunno_id, scuola_id, importo, importo_pagato, sconto, stato, tipo, scadenza, descrizione, payment_categories(slug)'
const PAG_SELECT_BASE =
  'id, alunno_id, scuola_id, importo, importo_pagato, stato, tipo, scadenza, descrizione, payment_categories(slug)'

const ALUNNI_SELECT_V2 = 'id, scuola_id, stato, anonimizzato_il'
const ALUNNI_SELECT_BASE = 'id, scuola_id, stato'

/**
 * L'esito di una lettura PostgREST, visto in modo NEUTRO rispetto all'elenco di
 * colonne. Serve ai due ritenti «senza la colonna nuova»: `.select(A)` e
 * `.select(B)` producono due tipi diversi e inferiti, e la stessa variabile non
 * può ospitarli entrambi. Il tipo vero delle righe si dichiara subito dopo, dove
 * i campi vengono letti davvero.
 */
type EsitoLettura = { data: unknown; error: { code?: string; message?: string } | null }

interface MovimentoRiga {
  id: string
  importo: number | string
  stato: string
  data_operazione: string | null
  /**
   * La sede del movimento. Nasce NULL — i bonifici arrivano su un conto unico e
   * non hanno plesso finché non sono abbinati — e la assume alla conferma. Ma
   * una riga RIAPERTA se la tiene: né la PATCH né `annulla_transazione` la
   * azzerano, ed è deliberato (a NULL sparirebbe dalla vista di sede di chi deve
   * rilavorarla). Per questo si guarda: vedi §8.
   */
  scuola_id: string | null
  /**
   * Il pagamento a cui questo bonifico era abbinato prima di essere riaperto.
   *
   * ⚠️ NON è una colonna nuova — sta in `MOV_SELECT_BASE` della rotta sorella,
   * cioè esiste anche sul DB E2E non migrato: chiederla non apre un ramo `42703`
   * in più. È nuovo l'USO: è la memoria su cui poggia la guardia §9, e la
   * migrazione dell'annullo la conserva PROPRIO perché qualcuno la legga.
   */
  pagamento_id: string | null
  transazione_id: string | null
}

interface PagamentoRiga {
  id: string
  alunno_id: string | null
  scuola_id: string | null
  importo: number | string
  importo_pagato?: number | string | null
  sconto?: number | string | null
  stato: string
  tipo?: string | null
  scadenza?: string | null
  descrizione?: string | null
  payment_categories?: { slug?: string | null } | null
}

interface AlunnoRiga {
  id: string
  scuola_id: string | null
  stato: string | null
  anonimizzato_il?: string | null
}

/**
 * La composizione da registrare: è la forma che la `zod` della route produce, e
 * si dichiara qui perché chi arriverà senza `zod` sappia che cosa deve mettere
 * insieme. Gli elenchi non sono opzionali: la RPC vuole `[]`, mai `null`.
 */
export interface Composizione {
  /** La sede del DOCUMENTO, scelta dall'operatore (§3). Non è la sede delle voci. */
  scuola_id: string
  pagante_parent_id: string
  riferimento?: string | null
  note?: string | null
  voci: { pagamento_id: string; importo: number }[]
  voci_nuove: {
    alunno_id: string
    categoria_id: string
    descrizione: string
    importo: number
    scadenza: string
    gruppo?: string | null
  }[]
  voci_ticket: {
    alunno_id: string
    quantita: number
    costo_unitario: number
    categoria_id?: string | null
    scadenza?: string | null
    gruppo?: string | null
  }[]
  ancora?: { specie: 'esistente' | 'nuova' | 'ticket'; indice: number }
}

/** Ciò che la registrazione ha scritto, per chi deve ancora fare audit e notifica. */
export interface ConciliazioneRegistrata {
  transazioneId: string | null
  /** L'importo del MOVIMENTO, che è il totale della transazione: mai un campo del client. */
  importoTotale: number
  /** Falso quando la RPC vecchia non ha legato la riga bancaria: vedi «LA SECONDA RETE». */
  movimentoConfermato: boolean
  /** I bambini toccati: lo STESSO elenco su cui si è deciso il pagante. */
  alunniCoinvolti: string[]
}

export interface EsitoConciliazione {
  status: number
  body: Record<string, unknown>
  /** Presente SOLO quando la transazione contabile è stata registrata. */
  ok?: ConciliazioneRegistrata
}

/**
 * Registra la composizione di un bonifico: i nove gate, la quadratura, l'àncora,
 * la RPC e la rete che dice se la riga bancaria è stata davvero legata.
 *
 * L'ordine dei gate non si riordina, e il perché sta sopra ciascuno: il soggetto
 * della richiesta è la riga bancaria, e ogni guardia sta davanti a tutto ciò che
 * legge o scrive per conto suo.
 */
export async function registraConciliazione(
  supabase: SupabaseClient,
  args: {
    movimentoId: string
    composizione: Composizione
    /** Le sedi su cui il chiamante può conciliare. Vedi la testata: è un parametro apposta. */
    sediAmmesse: string[]
    /**
     * Chi firma la transazione (`registrato_da`).
     *
     * ⚠️ RESTA VALORIZZATO ANCHE QUANDO `automatico` è vero: quell'uuid finisce
     * in `pagamenti_transazioni.registrato_da` e in `incassi.registrato_da`,
     * cioè in due registri contabili. Azzerarlo per distinguere la macchina
     * avrebbe risparmiato una colonna al prezzo di due registri anonimi — e
     * sarebbe anche falso: qualcuno ha comunque premuto «Importa».
     */
    attoreId: string
    /** Il nome dell'operazione nei log: lo dichiara il chiamante, che è l'unico a saperlo. */
    operazione: string
    /**
     * `true` quando a decidere questa composizione è stata l'APPLICAZIONE, senza
     * un click: la riga bancaria si marca con `abbinato_auto_il`, e a scriverla
     * è la RPC DENTRO il proprio compare-and-swap (migrazione `20260920124744`).
     *
     * Default `false` = il comportamento di oggi, più l'azzeramento della marca
     * — che è il verso giusto: una ricomposizione fatta a mano su un movimento
     * che la macchina aveva abbinato deve smettere di risultare automatica, o
     * l'annullamento in blocco disferebbe il lavoro di una persona.
     *
     * 🔴 CHI LO METTE A `true` DEVE AVER CHIESTO PRIMA `marcaAutomaticaDisponibile`:
     * senza la colonna l'abbinamento automatico non deve PARTIRE, non «partire
     * senza marca». Il perché per esteso sta in `@/lib/pagamenti/marca-automatica`.
     */
    automatico?: boolean
  },
): Promise<EsitoConciliazione> {
  const {
    movimentoId,
    composizione: body,
    sediAmmesse,
    attoreId,
    operazione,
    automatico,
  } = args

  // ── 1) IL MOVIMENTO ────────────────────────────────────────────────────
  // `transazione_id` è nella SELECT apposta, e non perché serva leggerlo: è
  // la sonda che dice se lo schema esteso esiste. Se la colonna non c'è, la
  // RPC estesa non può esistere (la sua migrazione ha una guardia che si
  // rifiuta di crearla senza), mentre la RPC VECCHIA c'è e accetta lo stesso
  // payload: ignorerebbe `movimento_id` in silenzio, scriverebbe gli incassi
  // e lascerebbe la riga rossa. Meglio non partire.
  const { data: movRaw, error: errMov } = await supabase
    .from('riconciliazione_movimenti')
    .select('id, importo, stato, data_operazione, scuola_id, pagamento_id, transazione_id')
    .eq('id', movimentoId)
    .maybeSingle()
  if (errMov) {
    const code = (errMov as { code?: string }).code ?? ''
    if (code === COLONNA_ASSENTE) {
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'schema-conciliazione-assente',
        tipo: 'colonna-transazione-id',
      }, errMov)
      return {
        status: 503,
        body: { error: 'La composizione del pagamento non è disponibile su questo ambiente: nessun incasso è stato registrato.', codice: 'CONCILIAZIONE_NON_DISPONIBILE' },
      }
    }
    logErrore({ operazione, stato: 500, evento: 'db' }, errMov)
    return {
      status: 500,
      body: { error: 'Movimento non leggibile', codice: 'CONCILIAZIONE_CONTESTO_NON_LETTO' },
    }
  }
  const movimento = movRaw as MovimentoRiga | null
  if (!movimento) {
    logEvento('pagamento', 'info', { operazione, esito: 'movimento-inesistente', movimento_id: movimentoId })
    return {
      status: 404,
      body: { error: 'Movimento non trovato', codice: 'CONCILIAZIONE_MOVIMENTO_NON_TROVATO' },
    }
  }

  // ── §4) `stato_atteso` DAL MOVIMENTO, mai dal client ───────────────────
  // Un movimento già `confermato` non si riconcilia di nuovo da qui: si
  // riapre (PATCH `riconciliazione/[id]`), che storna l'incasso e controlla
  // le fatture vive. Uno stato fuori vocabolario (schema più nuovo del
  // codice) finisce nello stesso ramo: mai un CAS su un valore ignoto.
  const statoAtteso = movimento.stato
  if (!STATI_CONCILIABILI.has(statoAtteso)) {
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'movimento-non-conciliabile',
      movimento_id: movimentoId,
      stato: statoAtteso,
    })
    return {
      status: 409,
      body: { error: 'Questo bonifico non è più nello stato in cui lo si stava componendo', codice: 'CONCILIAZIONE_MOVIMENTO_CAMBIATO' },
    }
  }

  // ── L'ELENCO DELLE SEDI: UNO SOLO, per tutti i confronti che seguono ───
  // Lo usano il gate sul movimento (§8), quello sulla sede del documento (§3),
  // le voci esistenti, i bambini delle voci nuove e quelli dei ticket. Un
  // secondo elenco risolto in un altro modo aprirebbe la porta a cui questa
  // fetta è più esposta: una cosa validata contro un insieme e la sua gemella
  // contro un altro.
  //
  // ⚠️ Lo risolve il CHIAMANTE, con `resolveScuoleAttive` e non
  // `resolveScuolaScrittura`: il secondo risolve UNA sede e la confronta con le
  // accessibili ignorando il SedeSelector; qui serve un INSIEME, perché le voci
  // di un bonifico cross-sede vanno confrontate una per una. Un elenco solo, una
  // regola sola. Il prezzo è che una selezione stretta nel SedeSelector
  // restringe anche la scrittura — e la direzione in cui si sbaglia è quella
  // sicura: mai più larga dell'ambito dichiarato a schermo.
  const sedi = sediAmmesse
  const inScope = (s: string | null | undefined) => !!s && sedi.includes(s)

  // ── §8) IL MOVIMENTO, PRIMA DI OGNI ALTRA COSA ─────────────────────────
  // Il soggetto di questa richiesta è la riga bancaria dell'URL, non la sede
  // scritta nel corpo: chi non può gestirla non deve arrivare né al 403 sul
  // corpo né a una lettura fatta per suo conto.
  //
  // **404 e non 403**, ed è la differenza con tutti gli altri dinieghi di
  // questa fetta: quelli parlano di righe che il chiamante ha NOMINATO lui
  // (le sue voci, i suoi bambini), e un 403 gli dice solo «no» su una cosa
  // che già conosce. Qui la riga è un'altra: confermarne l'esistenza
  // direbbe a un operatore di Cesa che un certo bonifico esiste a Giugliano.
  // Stesso codice e stesso stato della rotta sorella, che su questo caso
  // risponde `CONCILIAZIONE_MOVIMENTO_NON_TROVATO` — due porte sulla stessa
  // riga non possono rispondere due cose diverse.
  //
  // `scuola_id` NULL non è un buco: è un movimento non ancora abbinato, che
  // per costruzione appartiene alla coda globale — sono i 65 conciliabili di
  // oggi, tutti a NULL. Il gate scatta su una sede DICHIARATA e non tua.
  if (movimento.scuola_id && !inScope(movimento.scuola_id)) {
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'movimento-fuori-sede',
      movimento_id: movimentoId,
      sede_id: movimento.scuola_id,
      n: sedi.length,
    })
    return {
      status: 404,
      body: { error: 'Movimento non trovato', codice: 'CONCILIAZIONE_MOVIMENTO_NON_TROVATO' },
    }
  }

  // ── §3) LA SEDE DEL DOCUMENTO ──────────────────────────────────────────
  // Dichiarata dal client e validata qui. `rifiutoSede` NON logga (il log lo
  // fa chi decide, ed è l'unico a conoscere il contesto): la riga la scrive
  // questa fetta, altrimenti il rifiuto è muto.
  //
  // Viene DOPO §8, e l'ordine non è indifferente: la riga bancaria è il
  // soggetto della richiesta, la sede del documento è una cosa che il
  // chiamante ha scritto lui. Prima si stabilisce se quella riga è sua.
  //
  // ⚠️ Il diniego si CHIEDE a `rifiutoSede` e poi si apre, invece di riscriverne
  // il corpo: quella funzione è l'unico posto in cui i due dinieghi di sede
  // hanno una frase e uno stato, e una copia qui sarebbe la ventunesima
  // variante che il suo commento racconta d'aver tolto. Il chiamante vuole
  // `{ status, body }` — non una `Response` — perché non tutti i chiamanti
  // parlano HTTP.
  if (!inScope(body.scuola_id)) {
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'sede-documento-fuori-scope',
      movimento_id: movimentoId,
      sede_id: body.scuola_id,
      n: sedi.length,
    })
    const rifiuto = rifiutoSede('SEDE_NON_ACCESSIBILE')
    return { status: rifiuto.status, body: (await rifiuto.json()) as Record<string, unknown> }
  }

  // ── §9) UN BONIFICO NON SI FATTURA DUE VOLTE — LA SECONDA PORTA ────────
  // Sta QUI, prima di ogni lettura di voci, bambini e legami e di ogni
  // scrittura, per la stessa ragione della sorella: finché una guardia sta in
  // fondo, tutto ciò che le sta davanti ha già letto, scritto o notificato
  // quando lei dice di no. Più in alto non può stare: le due cose che decide
  // — la memoria del movimento e le voci scelte — si conoscono solo dopo i
  // gate di sede, e un rifiuto fiscale a chi non ha titolo su quella riga
  // sarebbe un'informazione regalata.
  //
  // La condizione è «il bonifico si sposta ALTROVE»: se la voce di prima è
  // ancora dentro la composizione, il documento continua ad avere l'incasso
  // che lo giustifica e non c'è niente da fermare — vietarlo renderebbe
  // impossibile il caso più normale, ricomporre lo stesso bonifico su quella
  // voce più altre. Costa una lettura, e solo quando il pagamento cambia
  // davvero.
  const pagamentoDiPrima = movimento.pagamento_id
  if (pagamentoDiPrima != null && !body.voci.some((v) => v.pagamento_id === pagamentoDiPrima)) {
    const { data: righeFattura, error: errFatture } = await supabase
      .from('fatture_emesse')
      .select('numero, anno, sezionale, sdi_stato')
      .eq('pagamento_id', pagamentoDiPrima)
    // PostgREST non lancia: ritorna `{ error }`. Con l'errore scartato `data`
    // vale null, «nessuna fattura» e «non l'abbiamo potuta leggere» diventano
    // la stessa cosa, e un guasto di lettura si trasforma in un secondo
    // incasso. Fail-closed: se non è VERIFICABILE, non si compone.
    if (errFatture) {
      logErrore(
        { operazione, stato: 503, evento: 'fatture_del_movimento_non_lette' },
        errFatture,
      )
      return {
        status: 503,
        body: {
          error:
            'Non è stato possibile verificare se questo bonifico sia già stato fatturato: la ' +
            'composizione è stata fermata per non rischiare un secondo documento. Riprova fra qualche minuto.',
          codice: 'BONIFICO_FATTURA_NON_VERIFICABILE',
        },
      }
    }
    // «Viva» lo dice `fattura-viva.ts`, in un posto solo: una riga scartata
    // dallo SDI si riemette, e chiuderle la strada renderebbe uno scarto
    // definitivo; una riga senza stato (rifiuto di trasporto) resta viva,
    // perché nessuno sa se quel documento sia partito.
    const viva = ((righeFattura ?? []) as RigaFatturaEmessa[]).find(fatturaViva)
    if (viva) {
      // `esito` è in lista bianca e resta in chiaro: «quante volte si è
      // tentato di ricomporre un bonifico già fatturato» diventa una query.
      // Numeri e uuid soltanto: la causale di un bonifico porta i nomi delle
      // famiglie.
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'bonifico-gia-fatturato-fermato',
        movimento_id: movimentoId,
        pagamento_id: pagamentoDiPrima,
        numero: viva.numero,
        anno: viva.anno ?? new Date().getFullYear(),
      })
      // La prosa dice il FATTO col numero — che il catalogo non può conoscere,
      // ed è l'unica cosa che dica quale documento andare a guardare; la
      // conseguenza e il rimedio stanno nella frase tradotta
      // (`BONIFICO_GIA_FATTURATO` è in `CODICI_CON_DETTAGLIO`, quindi a
      // schermo si leggono tutt'e due). Nient'altro: né descrizioni, né
      // importi, né l'uuid della voce.
      return {
        status: 409,
        body: {
          error: `Fattura viva sulla voce a cui questo bonifico era abbinato: ${etichettaFattura(viva)}.`,
          codice: 'BONIFICO_GIA_FATTURATO',
        },
      }
    }
  }

  // ── 2) LE VOCI ESISTENTI, lette dal DATABASE ───────────────────────────
  // Il client manda `pagamento_id` e `importo`, e basta: residuo, alunno,
  // sede e categoria li legge il server. Il `residuo` di riga NON è
  // autorevole — lo dichiara il client — e la RPC non lo riverifica: se lo
  // prendessimo per buono, un client che mente incasserebbe più del dovuto.
  const idVoci = body.voci.map((v) => v.pagamento_id)
  let pagamenti: PagamentoRiga[] = []
  if (idVoci.length > 0) {
    let ris: EsitoLettura = await supabase.from('pagamenti').select(PAG_SELECT_V2).in('id', idVoci)
    if (ris.error && ris.error.code === COLONNA_ASSENTE) {
      logEvento('pagamento', 'warn', {
        operazione, esito: 'sconto-non-disponibile', tipo: 'colonna-sconto',
      }, ris.error)
      ris = await supabase.from('pagamenti').select(PAG_SELECT_BASE).in('id', idVoci)
    }
    if (ris.error) {
      // PostgREST non lancia: senza questo controllo un errore di lettura
      // diventerebbe «nessuna voce fuori sede», cioè un permesso.
      logErrore({ operazione, stato: 500, evento: 'db' }, ris.error)
      return {
        status: 500,
        body: { error: 'Verifica delle voci non riuscita', codice: 'CONCILIAZIONE_CONTESTO_NON_LETTO' },
      }
    }
    pagamenti = (ris.data ?? []) as unknown as PagamentoRiga[]
  }
  const perId = new Map(pagamenti.map((p) => [p.id, p]))
  const mancanti = idVoci.filter((id) => !perId.has(id))
  if (mancanti.length > 0) {
    logEvento('pagamento', 'info', {
      operazione, esito: 'voci-inesistenti', movimento_id: movimentoId, n: mancanti.length,
    })
    return {
      status: 404,
      body: { error: 'Una o più voci non esistono più', codice: 'PAGAMENTO_NON_TROVATO' },
    }
  }

  // ── §2) IL 403 CHE ALLA RPC MANCA — voci esistenti ─────────────────────
  // Nessun id nel corpo della risposta: dire QUALI voci sono fuori sede
  // confermerebbe l'esistenza di pagamenti di un altro plesso a chi non ha
  // titolo per saperlo.
  const vociFuoriSede = pagamenti.filter((p) => !inScope(p.scuola_id))
  if (vociFuoriSede.length > 0) {
    logEvento('pagamento', 'warn', {
      operazione, esito: 'voci-fuori-sede', tipo: 'voce-esistente',
      movimento_id: movimentoId, n: vociFuoriSede.length,
    })
    return {
      status: 403,
      body: { error: 'Una o più voci appartengono a un plesso che non puoi gestire', codice: 'CONCILIAZIONE_SEDE_NON_ACCESSIBILE' },
    }
  }

  // ── IL CONTENITORE DI RATE NON SI INCASSA ──────────────────────────────
  // `tipo` era già nella SELECT e nell'interfaccia, e poi non veniva usato: il
  // filtro esisteva solo in `contesto/route.ts` («I contenitori `padre` non si
  // incassano: sono la somma delle rate figlie»), cioè sulla LETTURA. Una
  // guardia sulla lettura non protegge la scrittura: sonda del 2026-09-13, una
  // voce con `tipo: 'padre'` passava di qui con 200 e la RPC chiamata.
  //
  // Incassarlo lo porterebbe a `pagato` LASCIANDO APERTE le rate figlie: lo
  // stesso denaro a registro due volte, e la famiglia morosa sulle rate. È la
  // stessa specie di rete del residuo — quel numero lo dichiara il client e non
  // è autorevole — con la differenza che qui il dato autorevole era già letto.
  //
  // Nessun id e nessuna descrizione nel corpo: valgono le stesse ragioni del
  // 403 di sede qui sopra.
  const vociContenitore = pagamenti.filter((p) => p.tipo === 'padre')
  if (vociContenitore.length > 0) {
    logEvento('pagamento', 'warn', {
      operazione, esito: 'voci-contenitore',
      movimento_id: movimentoId, n: vociContenitore.length,
    })
    return {
      status: 422,
      body: {
        error: 'Una delle voci scelte è un piano a rate: si incassano le rate, non il totale',
        codice: 'CONCILIAZIONE_VOCE_CONTENITORE',
      },
    }
  }

  // ── 3) GLI ALUNNI delle voci che NASCONO qui ───────────────────────────
  const idAlunniNuovi = [
    ...new Set([
      ...body.voci_nuove.map((v) => v.alunno_id),
      ...body.voci_ticket.map((t) => t.alunno_id),
    ]),
  ]
  let alunni: AlunnoRiga[] = []
  /** `anonimizzato_il` assente sul DB non migrato: il presidio dell'oblio resta cieco, e va detto. */
  let oblioVerificabile = true
  if (idAlunniNuovi.length > 0) {
    let ris: EsitoLettura = await supabase.from('alunni').select(ALUNNI_SELECT_V2).in('id', idAlunniNuovi)
    if (ris.error && ris.error.code === COLONNA_ASSENTE) {
      oblioVerificabile = false
      // `error` sarebbe eccessivo (la strada funziona) ma `info` nasconderebbe
      // che un presidio su dati di minori è spento: `warn`, cioè persistito.
      logEvento('pagamento', 'warn', {
        operazione, esito: 'oblio-non-verificabile', tipo: 'colonna-anonimizzato-il',
      }, ris.error)
      ris = await supabase.from('alunni').select(ALUNNI_SELECT_BASE).in('id', idAlunniNuovi)
    }
    if (ris.error) {
      logErrore({ operazione, stato: 500, evento: 'db' }, ris.error)
      return {
        status: 500,
        body: { error: 'Verifica dei bambini non riuscita', codice: 'CONCILIAZIONE_CONTESTO_NON_LETTO' },
      }
    }
    alunni = (ris.data ?? []) as unknown as AlunnoRiga[]
  }
  const alunnoPerId = new Map(alunni.map((a) => [a.id, a]))
  const alunniMancanti = idAlunniNuovi.filter((id) => !alunnoPerId.has(id))
  if (alunniMancanti.length > 0) {
    logEvento('pagamento', 'info', {
      operazione, esito: 'alunni-inesistenti', movimento_id: movimentoId, n: alunniMancanti.length,
    })
    return {
      status: 404,
      body: { error: 'Uno o più bambini non sono più raggiungibili', codice: 'ALUNNO_NON_APRIBILE' },
    }
  }

  // ── §2 e §1) SEDE e STATO dei bambini delle voci nuove ─────────────────
  // I nomi delle sedi servono a riconoscere la sede fittizia della CI, che ha
  // DUE indizi (prefisso dell'id e nome): il prefisso basta al caso misurato,
  // il nome copre un DB su cui qualcuno l'abbia creata a mano. Se la lettura
  // dei nomi non riesce si prosegue col solo prefisso — è un indizio in meno,
  // non un gate in meno — e lo si dice.
  const nomiSedi = new Map<string, string>()
  const idSedi = [...new Set(alunni.map((a) => a.scuola_id).filter((s): s is string => !!s))]
  if (idSedi.length > 0) {
    const { data: scuole, error: errScuole } = await supabase.from('schools').select('id, nome').in('id', idSedi)
    if (errScuole) {
      logEvento('pagamento', 'warn', {
        operazione, esito: 'nomi-sedi-non-letti', tipo: 'riconoscimento-e2e-parziale',
      }, errScuole)
    } else {
      for (const s of (scuole ?? []) as { id: string; nome: string | null }[]) nomiSedi.set(s.id, s.nome ?? '')
    }
  }

  const alunniFuoriSede = alunni.filter(
    (a) => !inScope(a.scuola_id) || isScuolaE2E({ id: a.scuola_id ?? '', nome: nomiSedi.get(a.scuola_id ?? '') ?? '' }),
  )
  if (alunniFuoriSede.length > 0) {
    logEvento('pagamento', 'warn', {
      operazione, esito: 'alunni-fuori-sede', tipo: 'voce-nuova',
      movimento_id: movimentoId, n: alunniFuoriSede.length,
    })
    return {
      status: 403,
      body: { error: 'Una o più voci riguardano un plesso che non puoi gestire', codice: 'CONCILIAZIONE_SEDE_NON_ACCESSIBILE' },
    }
  }

  const alunniNonAttivi = alunni.filter((a) => a.stato !== 'iscritto' || !!a.anonimizzato_il)
  if (alunniNonAttivi.length > 0) {
    // Nel log niente nomi e niente id di minori oltre agli uuid, che `redact`
    // lascia passare perché sono identificativi e non anagrafica.
    logEvento('pagamento', 'warn', {
      operazione, esito: 'alunni-non-attivi', tipo: 'voce-nuova',
      movimento_id: movimentoId, n: alunniNonAttivi.length,
    })
    return {
      status: 403,
      body: { error: 'Una o più voci riguardano un bambino che non è più fra gli iscritti', codice: 'CONCILIAZIONE_ALUNNO_NON_ATTIVO' },
    }
  }

  // ── IL PAGANTE: È LUI CHE FINISCE SULLA FATTURA ────────────────────────
  // `pagante_parent_id` era validato dalla sola `zod` (`zUuid`) e arrivava
  // INTATTO alla RPC. La FK è `REFERENCES parents(id)`: verifica l'esistenza e
  // nient'altro, e `parents` non ha `scuola_id`, quindi nemmeno la sede lo
  // limita. Sonda del 2026-09-13: un `pagante_parent_id` di un'ALTRA famiglia
  // dava 200 con la RPC chiamata e l'uuid intatto nel payload. Da lì
  // `src/lib/pagamenti/ricevute.ts` prende NOME e CODICE FISCALE
  // dell'intestatario: il documento fiscale usciva a nome di un estraneo, col
  // suo CF — denaro, detrazione 730 e dato personale di un'altra famiglia
  // insieme.
  //
  // Il gate esisteva già, ma sulla LETTURA: `contesto/route.ts` costruisce i
  // candidati dalle due sorgenti e risponde 403 a un `?pagante=` fuori elenco.
  // Una guardia sulla lettura non protegge la scrittura.
  //
  // L'insieme è l'UNIONE dei due ponti (vedi `pagante-ammesso.ts`): 81 legami
  // veri stanno nella sola anagrafica e 4 nel solo runtime, quindi una guardia
  // su un ponte solo rifiuterebbe incassi legittimi. L'unione, che è un
  // sovrainsieme di entrambi, non ne rifiuta nessuno.
  const alunniCoinvolti = [
    ...new Set(
      [...pagamenti.map((p) => p.alunno_id), ...idAlunniNuovi].filter((a): a is string => !!a),
    ),
  ]
  if (alunniCoinvolti.length > 0) {
    const ammessi = await pagantiAmmessiPerAlunni(supabase, alunniCoinvolti, operazione)
    // ⚠️ FAIL-OPEN, due volte e per due ragioni diverse.
    //  · `completo: false` = una lettura non è riuscita. Rifiutare qui
    //    scaricherebbe sul banco della segreteria un guasto del database,
    //    travestito da «questo genitore non è di questa famiglia».
    //  · insieme VUOTO = di quei bambini non si conosce nessun genitore, e
    //    non è un'ipotesi: l'anagrafica ne contiene, oggi e da sempre — un
    //    bambino appena importato, uno il cui tutore ha un account ma non
    //    ancora una riga `parents`. Rifiutare qui renderebbe i loro insoluti
    //    impossibili da incassare da questa schermata. Non è un permesso che
    //    si allarga: è un insieme su cui non c'è niente da decidere.
    //
    //    ⚠️ QUI C'ERA UN CONTEGGIO («5 su 727, di cui 2 con voci aperte»), e
    //    i due numeri erano veri ma dicevano una cosa falsa: TUTTE E DUE le
    //    voci aperte stanno nelle sedi FITTIZIE, non in una famiglia vera.
    //    Cioè la frase giustificava il fail-open con una conseguenza di
    //    produzione che in produzione non c'è. Un numero dentro un commento
    //    invecchia da solo; questo si è anche portato dietro la sede
    //    sbagliata. La ragione del fail-open regge senza numeri — e chi ne
    //    vuole uno lo RIFACCIA, sono due query e sono letture:
    //
    //      -- i bambini per cui questo gate non trova nessun pagante:
    //      --   NOT EXISTS su `student_parents`
    //      --   AND NOT EXISTS su `legame_genitori_alunni` JOIN `parents`
    //      --       ON parents.auth_user_id = legame_genitori_alunni.genitore_id
    //      -- di questi, quelli con residuo > 0 su `pagamenti`.
    //
    //    ⚠️ E si raggruppi per SEDE, escludendo le sedi di prova dall'ID e
    //    mai dal nome: sono DUE, entrambe col prefisso `e2e00000-`
    //    («Kidville E2E» e «Kidville Demo»), e chi filtra per nome ne prende
    //    una sola. ⚠️ E il JOIN su `parents` non è un dettaglio: senza,
    //    si conta «chi non ha nessuna riga di legame» invece di «chi non ha
    //    nessun pagante AMMESSO» — due domande diverse, e il gate pone la
    //    seconda. Misurato il 2026-09-13: differivano di un bambino, che ha
    //    il legame runtime ma non la riga `parents` a cui il ponte arriva.
    // In tutt'e due i casi si prosegue, ma non in silenzio: un presidio spento
    // che nessuno vede è la prima metà di ogni guasto lungo di questo repo.
    if (!ammessi.completo || ammessi.parentIds.size === 0) {
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'pagante-non-verificato',
        tipo: ammessi.completo ? 'nessun-legame-noto' : 'legami-non-letti',
        movimento_id: movimentoId,
        n: alunniCoinvolti.length,
        candidati: ammessi.parentIds.size,
      })
    } else if (!ammessi.parentIds.has(body.pagante_parent_id)) {
      // Nel corpo e nel log NIENTE uuid del pagante: identifica una persona, e
      // rimandarlo indietro confermerebbe a chi l'ha inventato che esiste.
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'pagante-fuori-dai-candidati',
        movimento_id: movimentoId,
        n: alunniCoinvolti.length,
        candidati: ammessi.parentIds.size,
      })
      return {
        status: 403,
        body: {
          error: 'Il genitore indicato non è collegato ai bambini di questo pagamento',
          codice: 'CONCILIAZIONE_PAGANTE_NON_AMMESSO',
        },
      }
    }
  }

  // ── §7) IL GATE, e la quadratura rifatta lato server ───────────────────
  // Le righe si costruiscono nell'ORDINE in cui la RPC le incassa —
  // `voci` → `voci_nuove` → `voci_ticket` — perché è lo stesso ordine su cui
  // si risolve l'àncora predefinita.
  const righeEsistenti: RigaComposizione[] = body.voci.map((v) =>
    rigaDaVoceAperta(perId.get(v.pagamento_id)! as never, v.importo),
  )
  const righeNuove: RigaNuova[] = body.voci_nuove.map((v) => ({
    specie: 'nuova',
    alunnoId: v.alunno_id,
    scuolaId: alunnoPerId.get(v.alunno_id)?.scuola_id ?? null,
    categoriaId: v.categoria_id,
    descrizione: v.descrizione,
    importo: v.importo,
  }))
  const righeTicket: RigaTicket[] = body.voci_ticket.map((t) => ({
    specie: 'ticket',
    alunnoId: t.alunno_id,
    scuolaId: alunnoPerId.get(t.alunno_id)?.scuola_id ?? null,
    quantita: t.quantita,
    costoUnitario: t.costo_unitario,
  }))
  const righe: RigaComposizione[] = [...righeEsistenti, ...righeNuove, ...righeTicket]
  const importoMovimento = Number(movimento.importo)

  // UN SOLO GATE. `violazioniRighe(...).length === 0 && quadra(...)` compila,
  // passa `tsc`, passa ogni lock — e su zero righe contro un movimento a 0
  // dice SÌ. Le due funzioni qui sotto servono a DIRE quale riga è sbagliata,
  // non a decidere.
  if (!puoConfermare(righe, importoMovimento)) {
    const violazioni = violazioniRighe(righe)
    const dInsieme = violazioniComposizione(righe, importoMovimento)
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'composizione-non-confermabile',
      movimento_id: movimentoId,
      n: violazioni.length + dInsieme.length,
    })
    return {
      status: 422,
      body: {
        error: 'La composizione non quadra con l\'importo del bonifico',
        codice: 'CONCILIAZIONE_NON_QUADRA',
        // Enumerati e numeri: nessuna descrizione, nessun nome, nessun importo
        // di una voce altrui. `indice` è l'indice di riga che la UI evidenzia.
        violazioni,
        violazioni_composizione: dInsieme,
        scarto: scartoQuadratura(righe, importoMovimento),
      },
    }
  }

  // ── L'ÀNCORA ───────────────────────────────────────────────────────────
  // `riconciliazione_movimenti` ha UNA `pagamento_id` e UNA `incasso_id`, ma
  // una transazione composita ha N voci: una fa da rappresentante, ed è
  // quella da cui la fattura prende intestatario, causale e competenza.
  // L'uuid di una voce che NASCE qui il client non può conoscerlo: per quelle
  // si manda l'INDICE, 0-based, e l'uuid lo risolve la RPC dopo l'INSERT.
  let ancoraPagamentoId: string | null = null
  let ancoraIndiceNuova: number | null = null
  let ancoraIndiceTicket: number | null = null
  if (body.ancora) {
    const { specie, indice } = body.ancora
    const dimensione =
      specie === 'esistente' ? body.voci.length : specie === 'nuova' ? body.voci_nuove.length : body.voci_ticket.length
    if (indice >= dimensione) {
      logEvento('pagamento', 'info', {
        operazione, esito: 'ancora-fuori-elenco', tipo: specie, movimento_id: movimentoId,
      })
      return {
        status: 400,
        body: { error: 'La voce indicata come àncora della fattura non è nella composizione', codice: 'CONCILIAZIONE_ANCORA_MANCANTE' },
      }
    }
    if (specie === 'esistente') ancoraPagamentoId = body.voci[indice].pagamento_id
    else if (specie === 'nuova') ancoraIndiceNuova = indice
    else ancoraIndiceTicket = indice
  } else {
    // Proposta: la voce con categoria `retta` vince anche quando non è la
    // maggiore — è la riga che dà senso fiscale al documento (detrazione 730).
    const proposta = proponiAncora(righe)
    // ⚠️ RAMO OGGI IRRAGGIUNGIBILE, E RESTA — dichiarato qui perché il
    // prossimo lettore non ci perda un pomeriggio a scrivere il test che lo
    // copra, né lo cancelli credendolo vivo.
    //
    // `proponiAncora` ritorna `null` SOLTANTO su `righe.length === 0`, e su
    // zero righe `puoConfermare` ha già detto no venti righe più su —
    // `violazioniComposizione` emette sempre `composizione_vuota` — quindi
    // qui si arriva solo con almeno una riga. Non è una supposizione: è
    // l'invariante che i due test «l'àncora proposta non manca mai» MISURANO
    // sul motore puro, in tutt'e due le direzioni (null sul vuoto, non-null
    // su ogni specie di riga). Il giorno in cui `proponiAncora` guadagnasse
    // un secondo ramo `null` quei test diventerebbero rossi, e questo ramo
    // tornerebbe vivo con un preavviso invece che con un 400 in produzione.
    //
    // PERCHÉ NON SI TOGLIE. L'alternativa è `proposta!.indice`, cioè
    // sostituire un ramo DICHIARATO con una scommessa muta: se l'invariante
    // cadesse, al posto di un 400 parlante uscirebbe un `TypeError` dentro il
    // `catch` della rotta, cioè un 500 opaco — e sarebbe la prima volta che
    // questa strada risponde 500 prima di aver scritto un centesimo, con la
    // frase «non siamo riusciti a registrare» a coprire un guasto logico.
    // Sei righe contro quello.
    if (!proposta) {
      // Se ci si arriva davvero non è un errore dell'operatrice: è
      // un'invariante rotta fra il motore e questo gate, e il livello lo dice.
      logEvento('pagamento', 'error', {
        operazione,
        esito: 'ancora-non-proponibile',
        tipo: 'invariante-motore',
        movimento_id: movimentoId,
        n: righe.length,
      })
      return {
        status: 400,
        body: { error: 'Nessuna voce da cui intestare la fattura', codice: 'CONCILIAZIONE_ANCORA_MANCANTE' },
      }
    }
    const i = proposta.indice
    if (i < righeEsistenti.length) ancoraPagamentoId = body.voci[i].pagamento_id
    else if (i < righeEsistenti.length + righeNuove.length) ancoraIndiceNuova = i - righeEsistenti.length
    else ancoraIndiceTicket = i - righeEsistenti.length - righeNuove.length
  }

  // ── IL PAYLOAD ─────────────────────────────────────────────────────────
  // Gli array vanno mandati come `[]`, MAI come `null`: i due campi storici si
  // leggono con `COALESCE(p->'voci', '[]')` e il jsonb `null` non è SQL NULL,
  // quindi il COALESCE non scatta e `jsonb_array_elements` riceve uno scalare
  // — errore criptico invece di «nessuna voce». È un difetto noto e dichiarato
  // nella testata della migrazione, che chiede espressamente a chi la chiama di
  // mandare `[]`.
  const payload = {
    pagante_parent_id: body.pagante_parent_id,
    scuola_id: body.scuola_id,
    metodo: 'bonifico',
    riferimento: body.riferimento ?? null,
    // La valuta è quella del MOVIMENTO: è la data in cui il denaro è arrivato
    // in banca, non quella in cui la segreteria apre la schermata.
    data_valuta: movimento.data_operazione ?? null,
    note: body.note ?? null,
    importo_totale: importoMovimento,
    voci: body.voci.map((v) => ({ pagamento_id: v.pagamento_id, importo: v.importo })),
    // Sempre `[]`, anche se questa strada non lo popola mai: la ricarica SENZA
    // voce a registro resta un'operazione di Mensa. Si manda esplicito e non
    // si omette perché il payload è ciò che si rilegge nei log quando una
    // transazione va indagata, e «campo assente» e «nessuna ricarica» devono
    // leggersi diversi. È anche l'unico dei due campi storici che la RPC legge
    // con un `COALESCE` NUDO, senza `NULLIF(…, 'null'::jsonb)`: un `null` qui
    // dentro non darebbe «nessuna ricarica», darebbe un errore criptico da
    // `jsonb_array_elements` su uno scalare.
    ricariche_mensa: [] as never[],
    // `scuola_id` NON si manda: la sede di una voce che nasce qui la deriva la
    // RPC da `alunni.scuola_id`, e un campo che viene ignorato è un campo che
    // il prossimo lettore crede attivo.
    voci_nuove: body.voci_nuove.map((v) => ({
      alunno_id: v.alunno_id,
      categoria_id: v.categoria_id,
      descrizione: v.descrizione,
      importo: v.importo,
      scadenza: v.scadenza,
      gruppo: v.gruppo ?? null,
    })),
    voci_ticket: body.voci_ticket.map((t) => ({
      alunno_id: t.alunno_id,
      quantita: t.quantita,
      costo_unitario: t.costo_unitario,
      categoria_id: t.categoria_id ?? null,
      scadenza: t.scadenza ?? null,
      gruppo: t.gruppo ?? null,
    })),
    // Quadratura esatta e bloccante: qui l'eccedenza non esiste (decisione
    // n. 11). Chi ha un'eccedenza da mettere a credito passa da «Incasso unico».
    eccedenza_a_credito: 0,
    movimento_id: movimentoId,
    stato_atteso: statoAtteso,
    ancora_pagamento_id: ancoraPagamentoId,
    ancora_indice_voce_nuova: ancoraIndiceNuova,
    ancora_indice_voce_ticket: ancoraIndiceTicket,
    registrato_da: attoreId,
    // La marca «abbinato dalla macchina». La scrive la RPC DENTRO il proprio
    // compare-and-swap (`20260920124744`), mai un UPDATE dopo: fra la RPC e una
    // seconda scrittura c'è una finestra vera, e l'esito parziale è una riga
    // confermata dalla macchina e non marcata — cioè una riga che
    // l'annullamento in blocco non troverà mai più.
    //
    // Si manda SEMPRE, esplicito, anche quando è `false`, per la stessa ragione
    // per cui `ricariche_mensa` viaggia come `[]`: il payload è ciò che si
    // rilegge nei log quando una transazione va indagata, e «campo assente» e
    // «non è automatica» devono leggersi diversi. Alla RPC non cambia niente —
    // `COALESCE((p->>'abbinato_auto')::boolean, false)` tratta i due casi allo
    // stesso modo — e alla RPC VECCHIA nemmeno: una chiave che non conosce la
    // ignora, mentre una colonna che PostgREST non conosce farebbe fallire
    // l'intera scrittura. Qui il jsonb non ha quel problema.
    abbinato_auto: automatico === true,
  }

  const { data: rpcData, error: rpcErr } = await supabase.rpc('registra_transazione_contabile', { p: payload })
  if (rpcErr) {
    const code = (rpcErr as { code?: string }).code ?? ''
    // RPC assente sul DB non migrato: la funzione è atomica, quindi «non c'è»
    // significa anche «non ha scritto niente».
    if (RPC_ASSENTE.has(code)) {
      logEvento('pagamento', 'warn', {
        operazione, esito: 'rpc-assente', error_code: code, movimento_id: movimentoId,
      }, rpcErr)
      return {
        status: 503,
        body: { error: 'La composizione del pagamento non è disponibile su questo ambiente: nessun incasso è stato registrato.', codice: 'CONCILIAZIONE_NON_DISPONIBILE' },
      }
    }
    // §5 — la corsa persa NON è un guasto: è due operatori sulla stessa riga,
    // e l'intera transazione SQL si è annullata da sé.
    if (code === CAS_PERSO) {
      logEvento('pagamento', 'warn', {
        operazione, esito: 'movimento-gia-conciliato', error_code: code,
        movimento_id: movimentoId, stato: statoAtteso,
      })
      return {
        status: 409,
        body: { error: 'Un altro operatore ha già conciliato questo bonifico', codice: 'CONCILIAZIONE_MOVIMENTO_CAMBIATO' },
      }
    }
    // `logErrore` porta il messaggio della RPC nel log, dove ha un lettore. Nel
    // CORPO no: la funzione è stata scritta per non emettere testo libero — le
    // voci si nominano con l'indice, mai con la descrizione — e rimandarlo al
    // client riaprirebbe il canale da questo capo.
    logErrore({ operazione, stato: 500, evento: 'rpc' }, rpcErr)
    return {
      status: 500,
      body: { error: 'Non siamo riusciti a registrare il pagamento: nulla è stato scritto.', codice: 'CONCILIAZIONE_NON_REGISTRATA' },
    }
  }

  const esito = (rpcData ?? {}) as {
    transazione_id?: string
    incassi?: number
    voci_nuove?: number
    voci_ticket?: number
    movimento_id?: string | null
    ancora_pagamento_id?: string | null
    ancora_incasso_id?: string | null
  }

  // ⚠️ LA SECONDA RETE, e perché non basta la prima. La sonda sulla colonna
  // chiude il caso misurato (schema per niente migrato). Resta la finestra
  // stretta in cui la colonna c'è ma la RPC è ancora quella VECCHIA: là gli
  // incassi vengono scritti e il movimento non viene legato, in silenzio. La
  // RPC estesa mette sempre `movimento_id` nell'esito quando lo riceve, la
  // vecchia non conosce quella chiave: la sua assenza È il segnale.
  // Non si risponde 500 — la transazione contabile c'è davvero, e un 500
  // inviterebbe a ritentare, cioè a incassare due volte. Si dice la verità:
  // 200, `movimento_confermato: false`, e una riga di log a livello `error`.
  const movimentoConfermato = esito.movimento_id != null
  if (!movimentoConfermato) {
    logEvento('pagamento', 'error', {
      operazione,
      esito: 'movimento-non-legato',
      tipo: 'rpc-senza-compare-and-swap',
      movimento_id: movimentoId,
      transazione_id: esito.transazione_id ?? null,
    })
  }

  // ── EVENTO CRITICO: SI LOGGA ANCHE IL SUCCESSO ─────────────────────────
  // Con i soli errori, «nessun log» non distingue «tutto ok» da «non è mai
  // partito niente» — ed è l'ambiguità che ha nascosto per mesi il guasto
  // delle email. `pagamento` è in `EVENTI_PERSISTITI`: questa riga finisce in
  // `app_log` e si interroga in SQL. Conteggi e uuid soltanto: mai importi di
  // una famiglia, mai descrizioni, mai nomi.
  logEvento('pagamento', 'info', {
    operazione,
    esito: 'conciliazione_composita_registrata',
    movimento_id: movimentoId,
    transazione_id: esito.transazione_id ?? null,
    sede_id: body.scuola_id,
    stato: statoAtteso,
    voci: body.voci.length,
    nuove: body.voci_nuove.length,
    ticket: body.voci_ticket.length,
    incassi: esito.incassi ?? 0,
    confermato: movimentoConfermato,
    // «Questa l'ha decisa la macchina o una persona?» diventa una query invece
    // di un'ipotesi: è un booleano, quindi `redact` lo lascia in chiaro, e senza
    // di lui il giorno in cui l'automatismo sbaglia in blocco non ci sarebbe
    // modo di contare quante righe ha toccato prima che qualcuno se ne accorga.
    automatico: automatico === true,
    oblio_verificato: oblioVerificabile,
  })

  // Il CODICE nel 200, e perché un 200 ne ha bisogno. Il campo
  // `movimento_confermato` diceva il fatto ma non lo diceva a nessuno: il
  // client lo ignorava, a schermo restava «fatto» e la riga bancaria restava
  // rossa — cioè l'operatrice ritentava, ed è il gesto che questa strada non
  // sopporta (sulle voci NUOVE e sui ticket il secondo giro crea righe nuove,
  // e il residuo riletto non le trattiene). Il codice si aggiunge SOLO nel caso
  // anomalo: un avviso che compare sempre smette di essere un avviso.
  return {
    status: 200,
    body: {
      success: true,
      ...(movimentoConfermato ? {} : { codice: 'CONCILIAZIONE_MOVIMENTO_NON_LEGATO' }),
      data: { ...esito, movimento_confermato: movimentoConfermato },
    },
    ok: {
      transazioneId: esito.transazione_id ?? null,
      importoTotale: importoMovimento,
      movimentoConfermato,
      alunniCoinvolti,
    },
  }
}
