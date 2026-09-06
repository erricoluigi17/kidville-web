/**
 * Chiavi di conflitto degli upsert del builder menu mensa.
 *
 * PERCHÉ UNA SOLA, E PERCHÉ PORTA SEMPRE `menu_config_id`.
 * Fino al 2026-09-06 la route ne sceglieva una delle due a runtime: con
 * `menu_config_id` quando un menu era selezionato, senza quando si usava il menu
 * unico. In produzione entrambe erano coperte SOLO da indici PARZIALI
 * (`… WHERE menu_config_id IS NULL` e `… WHERE menu_config_id IS NOT NULL`), e
 * `ON CONFLICT (colonne)` non infersce un indice parziale: Postgres pretende un
 * `WHERE` che implichi il predicato, e PostgREST non ha modo di mandarlo — il
 * parametro è `on_conflict=<colonne>` e basta. Risultato: `42P10` su OGNI
 * salvataggio, in ogni sede, in entrambi i rami. Nove volte a Cesa il 2026-09-05,
 * e nessun test poteva vederlo perché il vincolo vive nel database.
 *
 * L'indice che queste chiavi si aspettano è UNO e non è parziale:
 * `(scuola_id, menu_config_id, …)` con `NULLS NOT DISTINCT`, che tratta due `NULL`
 * come uguali. Le righe del menu unico restano uniche per (sede, settimana, giorno)
 * come prima — la garanzia non cambia, cambia il modo di esprimerla.
 *
 * ⚠️ L'INDICE LO CREANO LE MIGRAZIONI DEI TASK 4 E 5 DEL PIANO
 * (`docs/superpowers/plans/2026-09-06-menu-mensa-onconflict.md`), e finché non sono
 * applicate il salvataggio prende ancora `42P10`. Questo file da solo non ripara il
 * menu: toglie il ramo a runtime — che sbagliava comunque, in tutti e quattro i casi —
 * e fa sì che il fallimento sia LOGGATO come `evento: 'schema'` invece di uscire a
 * schermo. La frase al presente qui sopra descrive il bersaglio, non lo stato del
 * database: chi legge questo commento prima di fidarsene esegua
 * `select indexdef from pg_indexes where tablename = 'mensa_menu_rotazione'`.
 *
 * ⚠️ Se qualcuno rimette una chiave senza `menu_config_id`, la trova
 * `__tests__/api/mensa-menu-put-chiave.test.ts`; se qualcuno cambia le colonne
 * senza migrare l'indice, lo trova `__tests__/architecture/onconflict-arbitro.test.ts`.
 */
export const CHIAVE_ROTAZIONE = 'scuola_id,menu_config_id,settimana,giorno_settimana'
export const CHIAVE_OVERRIDE = 'scuola_id,menu_config_id,data'

export { vincoloConflittoAssente } from '@/lib/db/vincolo-conflitto'
