import { z } from 'zod';

// =============================================================================
// I LIMITI DI LUNGHEZZA DI `task_interni`, PRESI DAL DDL.
//
// Rilievo backend F1 del collaudo del 2026-07-31, misurato in produzione:
//
//   POST /api/tasks  { titolo: 'A'.repeat(100000) }
//     → HTTP 500 {"error":"value too long for type character varying(255)"}
//
// Gli schemi zod dichiaravano il tipo e il minimo (`z.string().min(1)`) ma non
// il massimo: il vincolo di lunghezza viveva SOLO nella tabella. Chi valida a
// metà lascia che sia il database a dire di no — e il database dice di no in un
// modo che il chiamante non può né capire né correggere, con lo status
// sbagliato (500 «è colpa mia» invece di 400 «i dati non vanno bene») e
// raccontando al client il tipo esatto della colonna.
//
// PERCHÉ UN MODULO E NON DUE COPIE. Le colonne le scrivono DUE rotte —
// `tasks:POST` e `tasks/[id]:PUT`. Con il numero copiato in entrambe, il giorno
// in cui il DDL cambia se ne aggiorna una e l'altra resta indietro: tornerebbe
// esattamente il 500 di oggi, ma su una sola delle due strade e quindi molto
// più difficile da vedere. Qui il limite sta in un posto solo.
//
// I VALORI VENGONO DA `supabase/migrations/20260704120000_baseline.sql:2710-2711`:
//
//     target_class character varying(50),
//     titolo       character varying(255) NOT NULL,
//
// e non da una stima di quanto sia «ragionevole» un titolo: un massimo più
// stretto della colonna rifiuterebbe dati legittimi, uno più largo lascerebbe il
// difetto aperto per i valori intermedi (256…100000). Se un domani la colonna
// cambia, si cambia QUI, e i test di confine
// (`__tests__/api/tasks-lunghezza-massima.test.ts`) dicono subito se le due cose
// si sono disallineate.
//
// NOTA SUL CONTEGGIO. Postgres conta CARATTERI, JavaScript conta unità UTF-16:
// `'😀'.length` vale 2 per JS e 1 per Postgres. Quindi `.max(255)` su
// `String.length` è sempre ALMENO severo quanto la colonna, mai più largo — non
// esiste una stringa che passi di qui e che il database rifiuti per lunghezza.
// È il motivo per cui, dopo questa dichiarazione, un `22001` che arrivasse
// comunque da PostgREST non sarebbe più un errore del chiamante ma la prova che
// il DDL e questo file hanno divergiuto: resta perciò un **500**, che è la
// verità, e finisce in `app_log` con `codice='22001'`.
//
// `contenuto` NON ha un limite qui: in tabella è `text`, senza larghezza. Il
// resto dei campi del promemoria (priorità, categoria, scadenza, assegnatari,
// sotto-compiti) viaggia dentro quel `text` come JSON e non tocca nessuna
// colonna `varchar`.
// =============================================================================

/** `task_interni.titolo character varying(255) NOT NULL` */
export const MAX_TITOLO_TASK = 255;
/** `task_interni.target_class character varying(50)` */
export const MAX_TARGET_CLASS_TASK = 50;

/**
 * Il titolo del promemoria. NON porta il `.min(1)`: è obbligatorio in creazione
 * e facoltativo in aggiornamento (dove il body è un merge parziale), quindi il
 * minimo lo aggiunge la rotta che lo esige. Il MASSIMO invece vale per
 * entrambe — è la colonna, non la regola d'uso.
 */
export const zTitoloTask = z
    .string()
    .max(MAX_TITOLO_TASK, `Il titolo non può superare ${MAX_TITOLO_TASK} caratteri`);

/** La classe destinataria del promemoria. */
export const zTargetClassTask = z
    .string()
    .max(MAX_TARGET_CLASS_TASK, `La classe non può superare ${MAX_TARGET_CLASS_TASK} caratteri`);
