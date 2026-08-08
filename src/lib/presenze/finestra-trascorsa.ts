import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

// =============================================================================
// «SI CONTA CIÒ CHE È GIÀ ACCADUTO» — la regola, in un posto solo.
//
// ─── L'ASSUNZIONE INFRANTA ───────────────────────────────────────────────────
//
// Fino al 2026-08-07 `presenze` aveva UNA sola sorgente di scrittura: il docente,
// sul giorno corrente. «Una riga di presenze è un giorno già trascorso» era
// quindi vero per COSTRUZIONE, e tutti i consumatori — riepiloghi, contatori,
// monte ore, PDF — sono stati scritti su quel presupposto senza doverlo mai
// dichiarare. «Comunica un'assenza» ha introdotto una seconda sorgente, che
// scrive `data >= oggi` fino a sessanta giorni in avanti.
//
// La correzione del ciclo precedente è andata sui DUE consumatori nominati dal
// rilievo (`parent/presenze:GET` e `parent/primaria/assenze:GET`) e non sulla
// REGOLA. Gli altri tre lettori della stessa tabella hanno continuato a contare
// come già avvenute le assenze comunicate per giorni futuri: il registro del
// docente mostrava «2 A» e «10 ORE» per un alunno con una sola assenza avvenuta,
// e il monte ore della primaria — il numero con cui si valuta la validità
// dell'anno scolastico — si lasciava gonfiare con dodici giorni di anticipo.
//
// «Una regola valida per due strade deve vivere in un posto solo» è la lezione
// che questo repo si è già annotato in `@/lib/presenze/limiti-testo`.
//
// ─── PERCHÉ `lte` E NON `lt`: OGGI CONTA ─────────────────────────────────────
//
// Due ragioni che tirano dalla stessa parte. (1) È la definizione già scelta
// dalle due rotte corrette: due idee diverse di «trascorso» dentro la stessa app
// si contraddirebbero nelle schermate che le mostrano vicine. (2) Con `lt`
// l'appello che la maestra fa stamattina resterebbe invisibile fino a domani: si
// toglierebbe un dato VERO per nascondere un dato futuro.
//
// ─── PERCHÉ «OGGI» LO DECIDE IL SERVER ───────────────────────────────────────
//
// `oggiFiscaleISO()` è `Europe/Rome`: il runtime gira in UTC e fra mezzanotte e
// le due del mattino `new Date().toISOString()` restituisce ancora ieri. E dove
// il conteggio si fa nel BROWSER, il giorno va comunque deciso qui e mandato
// giù: l'orologio di un tablet può essere sbagliato o su un altro fuso, e un
// conteggio che dipende da quell'orologio non è riproducibile.
//
// ─── COSA QUESTA REGOLA NON FA ───────────────────────────────────────────────
//
// Non nasconde i giorni futuri: la VISUALIZZAZIONE del calendario mensile
// continua a mostrare le assenze comunicate in anticipo, che è il motivo per cui
// il genitore le comunica. Si fermano a oggi i CONTEGGI — presenze/assenze/
// ritardi/uscite, monte ore, PDF — perché quelli affermano un fatto avvenuto.
//
// ─── IL SECONDO ASSE, E PERCHÉ IL TEMPO DA SOLO NON BASTA (Q4) ───────────────
//
// Tutto ciò che sta scritto qui sopra ragiona su UN asse: il tempo. Ma il
// confronto `data <= oggi` non può, per costruzione, escludere una riga che cade
// su OGGI — `oggi <= oggi` è vero sempre. E `oggi` non è un caso di bordo raro:
// è il valore PREIMPOSTATO del modulo su entrambe le schermate che scrivono.
//
// Misura del 2026-08-08, una sola POST di «Comunica un'assenza» per il giorno
// corrente: il badge della home passa da «appello non ancora registrato» ad
// «ASSENTE», il riepilogo dei 30 giorni da 0 a 1 assenza, il monte ore della
// primaria da 0 a 5,25 ore, il prospetto mensile del docente (e il suo PDF) la
// somma alle «A» e alle ORE. `registrato_da IS NULL`: nessun docente ha
// registrato niente.
//
// Serve quindi un secondo asse — la SORGENTE — accanto a quello temporale.
//
// ─── PERCHÉ NON «È UN FATTO SOLO SE `registrato_da IS NOT NULL`» ─────────────
//
// È il predicato che il rilievo proponeva alla lettera, ed è stato MISURATO
// prima di scriverlo. In produzione, il 2026-08-08:
//
//     SELECT count(*), count(registrato_da) FROM presenze;  →  49, 13
//
// Trentasei righe su quarantanove non hanno `registrato_da` e non hanno
// nemmeno `giustificata_da`: sono appelli VERI, scritti prima che
// `attendance/daily:POST` cominciasse a valorizzare la colonna (2026-08-08).
// Con quel predicato sparirebbero da ogni conteggio 2 assenze dell'infanzia,
// 1 assenza e 3 ritardi della primaria, più 30 giorni di presenza. Si
// toglierebbero fatti VERI per nascondere un annuncio: esattamente l'errore
// contro cui la sezione «PERCHÉ `lte` E NON `lt`» mette già in guardia.
//
// La polarità giusta è l'opposta: si nomina l'ANNUNCIO, non il fatto. Un
// annuncio è la congiunzione che SOLO `comunica-assenza:POST` produce —
//
//     stato = 'assente'  AND  giustificata_da IS NOT NULL  AND  registrato_da IS NULL
//
// — e tutto il resto resta un fatto, storico compreso. Il terzo termine non è
// decorativo: `giustifica:POST` scrive `giustificata_da` su una riga che ESISTE
// già, e senza il vincolo sullo stato una vecchia riga di primaria giustificata
// a posteriori (6 presenze, 3 ritardi, 1 uscita, tutte senza `registrato_da`)
// diventerebbe di colpo «un annuncio» e uscirebbe dal registro.
//
// ─── L'ANNUNCIO HA UNA FINE, E CHI LA DECIDE (R15) ───────────────────────────
//
// La congiunzione qui sopra descriveva l'annuncio SENZA il giorno di cui parla:
// `eAssenzaSoloAnnunciata` non riceveva `riga.data`. «Annuncio» era così una
// proprietà PERMANENTE della riga invece che una proprietà del giorno in cui la
// si guarda — e un annuncio che non scade non diventa mai un fatto. Due
// conseguenze, misurate entrambe:
//
//  (a) un'assenza comunicata dal genitore e mai confermata dall'appello restava
//      esclusa PER SEMPRE dal registro del docente, dal monte ore della
//      primaria — il numero con cui si valuta la validità dell'anno — dal
//      riepilogo della home e dalla cronologia. E l'appello che non arriva non è
//      un'ipotesi: il cruscotto conta apposta gli `appelli_mancanti`.
//  (b) un'assenza VERA già a registro e priva di `registrato_da` (le 36 righe
//      storiche di cui sopra) SPARIVA da tutti quei conteggi nell'istante in cui
//      il genitore la giustificava, perché `giustifica:POST` scrive
//      `giustificata_da` su una riga che esiste già e non tocca `registrato_da`.
//      Cioè: il gesto che l'app chiede al genitore cancellava l'assenza del
//      figlio dal registro. Il commento precedente enumerava i controesempi
//      comodi — presenze, ritardi, uscita — cioè tutto TRANNE le assenze, che
//      sono esattamente le righe che il monte ore serve a contare.
//
// CHI DECIDE CHE UN ANNUNCIO È DIVENTATO UN FATTO. Due giudici, in quest'ordine:
//
//  1. L'APPELLO, quando c'è. `attendance/daily:POST` e `primaria/appello:POST`
//     scrivono `registrato_da`: il terzo termine cade e la riga è un fatto del
//     docente nello stesso istante. Nessuna attesa.
//  2. IL TEMPO, quando l'appello non arriva. A mezzanotte del giorno annunciato
//     la comunicazione del genitore smette di essere un'affermazione sul futuro
//     e diventa l'unica affermazione esistente su un giorno concluso — per di
//     più FIRMATA (`giustificata_da` + firma FEA). Contarla è più fedele che
//     ignorarla: l'alternativa è dire «tuo figlio non è mai stato assente» a chi
//     l'assenza l'ha dichiarata lui.
//
// PERCHÉ NON DAL GIORNO STESSO. Finché il giorno corre, l'appello può ancora
// smentire l'annuncio, ed è il solo che sa chi è entrato dal cancello. `oggi` è
// anche il valore PREIMPOSTATO del modulo, cioè il caso più frequente: contarlo
// subito rimetterebbe in piedi il difetto che questa regola è nata per chiudere
// (badge «ASSENTE» e 5,25 ore perse alle 7:50 del mattino).
//
// LA FINESTRA È GIÀ SCRITTA ALTROVE, E QUESTO È IL PUNTO. `comunica-assenza:
// DELETE` rifiuta con 400 `ASSENZA_DATA_PASSATA` esattamente `data < oggi`:
// finché il genitore può ancora RITIRARE la comunicazione, quella comunicazione
// è un annuncio; quando non può più, è un fatto. Le due regole coincidono, e da
// oggi sono la stessa funzione (`finestraAnnuncioAperta`) invece di due confronti
// gemelli in due file — «una regola valida per due strade deve vivere in un posto
// solo», che è la lezione già annotata in `@/lib/presenze/limiti-testo`.
//
// ─── L'ECCEZIONE, DICHIARATA ─────────────────────────────────────────────────
//
// `admin/presenze/realtime:GET` conta le comunicazioni di oggi ed è GIUSTO così:
// è un cruscotto operativo — «chi non arriva stamattina» — non un numero che
// afferma un fatto storico. Non usa questo modulo, e non deve.
// =============================================================================

/** Forma minima di una data ISO (`YYYY-MM-DD`), che è come `presenze.data` è scritta. */
const FORMA_DATA = /^\d{4}-\d{2}-\d{2}/

/**
 * `true` se il giorno indicato è già trascorso — OGGI COMPRESO.
 *
 * Confronto lessicografico su `YYYY-MM-DD`: è totale e coincide con l'ordine
 * cronologico, che è la stessa scelta fatta dalle route (`.lte('data', oggi)`).
 * Una data illeggibile risponde `false`: in dubbio non si somma, perché il
 * risultato di questa funzione finisce in un numero che qualcuno leggerà come
 * un fatto.
 */
export function eGiornoTrascorso(data: string | null | undefined, oggi: string = oggiFiscaleISO()): boolean {
  if (typeof data !== 'string' || !FORMA_DATA.test(data)) return false
  return data.slice(0, 10) <= oggi
}

/** Le sole righe già avvenute. Il campo data lo dichiara il chiamante. */
export function soloTrascorsi<T>(
  righe: readonly T[],
  data: (riga: T) => string | null | undefined,
  oggi: string = oggiFiscaleISO(),
): T[] {
  return (righe ?? []).filter((r) => eGiornoTrascorso(data(r), oggi))
}

/**
 * Il tetto superiore su una query PostgREST: `.lte(colonna, oggi)`.
 *
 * Si accetta qualunque oggetto che sappia fare `.lte()` — cioè il filter builder
 * di PostgREST — senza importare i suoi tipi: questo modulo non deve dipendere
 * dal client Supabase per una regola che è di dominio.
 */
export function limitaAOggi<Q extends { lte(colonna: string, valore: string): Q }>(
  query: Q,
  colonna: string = 'data',
  oggi: string = oggiFiscaleISO(),
): Q {
  return query.lte(colonna, oggi)
}

// ─── IL SECONDO ASSE: LA SORGENTE ────────────────────────────────────────────

/** Le colonne che dicono CHI ha scritto la riga, da aggiungere a ogni `select`. */
export const COLONNE_SORGENTE = 'stato, registrato_da, giustificata_da'

/**
 * I tre termini che negano la SORGENTE dell'annuncio, da soli.
 *
 * `or=(a,b,c)` è `a OR b OR c`, cioè la NEGAZIONE della congiunzione che
 * definisce l'annuncio (De Morgan). Sta in una costante e non in tre stringhe
 * sparse perché una virgola di troppo qui non rompe niente: toglie in silenzio
 * righe vere dal registro di un bambino.
 *
 * ⚠️ NON si usa da sola in una query: senza il quarto termine sulla DATA un
 * annuncio non scade mai (R15). Il filtro completo lo compone `filtroFatti()`,
 * ed è quello che `limitaAiFatti()` manda a PostgREST.
 */
export const FILTRO_NON_ANNUNCIO = 'giustificata_da.is.null,registrato_da.not.is.null,stato.neq.assente'

/**
 * Il filtro PostgREST che tiene i soli FATTI, da passare a `.or()`.
 *
 * Quattro termini in disgiunzione: i tre della sorgente PIÙ `<colonna>.lt.<oggi>`,
 * perché una riga che parla di un giorno già concluso è un fatto qualunque sia
 * la sua provenienza. È la negazione di
 * `stato='assente' AND giustificata_da IS NOT NULL AND registrato_da IS NULL AND data >= oggi`.
 *
 * `oggi` viene interpolato in una stringa che PostgREST interpreta come
 * espressione: se non ha la forma `YYYY-MM-DD` si ricade sul giorno del server
 * invece di lasciar passare termini arbitrari dentro `or=(…)`. Nessun chiamante
 * lo sporca oggi — tutti passano `oggiFiscaleISO()` — e il presidio serve perché
 * continui a essere vero.
 */
export function filtroFatti(oggi: string = oggiFiscaleISO(), colonna: string = 'data'): string {
  const giorno = FORMA_DATA.test(oggi) ? oggi.slice(0, 10) : oggiFiscaleISO()
  return `${FILTRO_NON_ANNUNCIO},${colonna}.lt.${giorno}`
}

/** La forma minima con cui una riga dichiara la propria provenienza. */
export interface SorgenteRiga {
  stato?: string | null
  registrato_da?: string | null
  giustificata_da?: string | null
}

/**
 * `true` finché il giorno di cui una comunicazione parla non è concluso.
 *
 * È la finestra dell'ANNUNCIO — e la stessa dell'ANNULLAMENTO: fino a quando il
 * genitore può ritirare ciò che ha comunicato (`comunica-assenza:DELETE`
 * rifiuta `data < oggi`), quella comunicazione non afferma un fatto.
 *
 * Una data mancante o illeggibile la lascia APERTA, ed è il verso prudente: chi
 * chiama senza data ha già fissato il giorno per conto suo (`parent/presenze:GET`
 * legge la riga di oggi con `.eq('data', oggi)`), e promuovere a fatto una riga
 * di cui non si sa il giorno significa scrivere «ASSENTE» sulla home di un
 * bambino che è a scuola.
 */
export function finestraAnnuncioAperta(
  data: string | null | undefined,
  oggi: string = oggiFiscaleISO(),
): boolean {
  if (typeof data !== 'string' || !FORMA_DATA.test(data)) return true
  return data.slice(0, 10) >= oggi
}

/**
 * `true` se la riga è un'assenza che il genitore ha ANNUNCIATO, che l'appello
 * non ha ancora lavorato e il cui GIORNO non è ancora concluso: un'affermazione
 * sul futuro prossimo, non un fatto.
 *
 * I quattro termini, e perché servono tutti e quattro, stanno nella testata del
 * modulo. Il quarto — la data — è quello che dà all'annuncio una fine: senza,
 * un'assenza annunciata restava esclusa dai conteggi anche a mesi di distanza, e
 * un'assenza storica ne veniva espulsa nell'istante in cui il genitore la
 * giustificava (R15).
 */
export function eAssenzaSoloAnnunciata(
  riga: (SorgenteRiga & { data?: string | null }) | null | undefined,
  oggi: string = oggiFiscaleISO(),
): boolean {
  if (!riga) return false
  if (riga.stato !== 'assente' || riga.giustificata_da == null || riga.registrato_da != null) return false
  return finestraAnnuncioAperta(riga.data, oggi)
}

/**
 * `true` se la riga è un FATTO del registro: giorno già trascorso E non un
 * semplice annuncio. È il predicato che i consumatori devono usare al posto del
 * solo `eGiornoTrascorso`, che sul giorno corrente non discrimina.
 */
export function eFattoDelRegistro(
  riga: (SorgenteRiga & { data?: string | null }) | null | undefined,
  oggi: string = oggiFiscaleISO(),
): boolean {
  if (!riga) return false
  return eGiornoTrascorso(riga.data, oggi) && !eAssenzaSoloAnnunciata(riga, oggi)
}

/** Le sole righe che affermano un fatto. Il campo data lo dichiara il chiamante. */
export function soloFatti<T extends SorgenteRiga>(
  righe: readonly T[],
  data: (riga: T) => string | null | undefined,
  oggi: string = oggiFiscaleISO(),
): T[] {
  return (righe ?? []).filter((r) => eFattoDelRegistro({ ...r, data: data(r) }, oggi))
}

/**
 * Il tetto di `limitaAOggi` PIÙ il filtro sulla sorgente, su una query PostgREST.
 *
 * È la forma da usare quando il conteggio si fa nel DATABASE (`head: true`,
 * `count: 'exact'`) e non ci sono righe da filtrare in memoria.
 */
export function limitaAiFatti<
  Q extends { lte(colonna: string, valore: string): Q; or(filtro: string): Q },
>(query: Q, colonna: string = 'data', oggi: string = oggiFiscaleISO()): Q {
  return limitaAOggi(query, colonna, oggi).or(filtroFatti(oggi, colonna))
}
