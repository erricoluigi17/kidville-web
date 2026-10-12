/**
 * IL RITMO CON CUI L'AREA GENITORE RILEGGE I PAGAMENTI (S4-A, 2026-10-12).
 *
 * ═════════════════════════════════════════════════════════════════════════════════
 * COS'ERA PRIMA. Tre componenti — `SospensioneBanner`, `PagamentiSummary`,
 * `StoricoPagamenti` — ascoltavano `postgres_changes` su TABELLE INTERE (`pagamenti`,
 * `incassi`, e il banner anche `alunni`). Non c'era alcun filtro per famiglia: ogni
 * modifica della tabella arrivava a OGNI genitore collegato, il database doveva valutare
 * la RLS una volta per modifica e per ascoltatore, e ogni modifica ricevuta faceva ANCHE
 * un refetch. La segreteria che genera le rette del mese scrive centinaia di righe in un
 * colpo: con 400 famiglie collegate quello era il momento peggiore possibile.
 *
 * ⚠️ E un canale dei tre non poteva funzionare: `alunni` NON è nella pubblicazione
 * `supabase_realtime` (verificato in produzione il 12/10 su `pg_publication_tables`).
 * Quel `.on(..., { table: 'alunni' })` non ha mai consegnato niente a nessuno — senza
 * fallire, senza avvisare. Chi leggeva il codice concludeva che la revoca della
 * sospensione arrivasse da sola.
 *
 * PERCHÉ DIECI MINUTI, e non uno.
 * Il dato cambia quando la segreteria registra un incasso o emette le rette: poche volte
 * al giorno, in orario d'ufficio. Non c'è niente che un genitore debba vedere entro un
 * minuto — e il conto dice che stringere non sarebbe gratis. La home monta DUE di questi
 * componenti (banner + riepilogo) e la pagina dei pagamenti altri due (banner + storico):
 * ogni giro costa 2 richieste per pagina aperta, cioè 12 richieste all'ora. A un minuto
 * sarebbero 120.
 *
 * ⚠️ IL TETTO NON È UN GUSTO: è il 12 ottobre. Lunedì 12/10, fra le 06:00 e le 08:30 UTC,
 * `/rest/v1/pagamenti` ha preso 11.327 richieste in due ore, il p95 del database è salito
 * da ~25 ms a 160-240 ms e quello di `/auth/v1/user` a 350-470 ms. Un orologio che
 * sostituisce il realtime e intanto aggiunge richieste non ha risolto niente: avrebbe solo
 * cambiato il nome del guasto. Il pavimento di cinque minuti è inchiodato in
 * `__tests__/components/pagamenti-senza-realtime.test.tsx`.
 *
 * E la freschezza vera non la dà l'orologio: la dà il RITORNO IN PRIMO PIANO, che
 * `usePollingVisibile` esegue subito e senza aspettare il tick. Il momento in cui il dato
 * vecchio mente al genitore è la riapertura dell'app, non il minuto che passa mentre lui
 * guarda la pagina.
 * ═════════════════════════════════════════════════════════════════════════════════
 */
export const RITMO_PAGAMENTI_MS = 10 * 60 * 1000;
