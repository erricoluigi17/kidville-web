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
 * Il filtro PostgREST che tiene i soli FATTI, da passare a `.or()`.
 *
 * `or=(a,b,c)` è `a OR b OR c`, cioè la NEGAZIONE della congiunzione che
 * definisce l'annuncio (De Morgan). Sta in una costante e non in tre stringhe
 * sparse perché una virgola di troppo qui non rompe niente: toglie in silenzio
 * righe vere dal registro di un bambino.
 */
export const FILTRO_FATTI = 'giustificata_da.is.null,registrato_da.not.is.null,stato.neq.assente'

/** La forma minima con cui una riga dichiara la propria provenienza. */
export interface SorgenteRiga {
  stato?: string | null
  registrato_da?: string | null
  giustificata_da?: string | null
}

/**
 * `true` se la riga è un'assenza che il genitore ha ANNUNCIATO e che l'appello
 * non ha ancora lavorato: un'affermazione sul futuro prossimo, non un fatto.
 *
 * I tre termini, e perché servono tutti e tre, stanno nella testata del modulo.
 */
export function eAssenzaSoloAnnunciata(riga: SorgenteRiga | null | undefined): boolean {
  if (!riga) return false
  return riga.stato === 'assente' && riga.giustificata_da != null && riga.registrato_da == null
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
  return eGiornoTrascorso(riga.data, oggi) && !eAssenzaSoloAnnunciata(riga)
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
  return limitaAOggi(query, colonna, oggi).or(FILTRO_FATTI)
}
