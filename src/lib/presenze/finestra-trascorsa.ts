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
): Q {
  return query.lte(colonna, oggiFiscaleISO())
}
