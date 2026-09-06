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
 * ⚠️ L'INDICE C'È, dal 2026-09-06. Lo ha creato la migrazione `20260906122753`
 * (`chiave_conflitto_unica_mensa_e_registro`), applicata in produzione quel giorno
 * insieme alla `20260906122807` (`giudizio_template_chiave_conflitto_unica`), che porta
 * la stessa cura ai template dei giudizi. Verificato sul catalogo lo stesso giorno:
 * `uidx_mensa_rot_chiave` e `uidx_mensa_ovr_chiave` esistono, non sono parziali e hanno
 * `NULLS NOT DISTINCT`; i quattro parziali di prima non ci sono più.
 *
 * Questo file da solo non riparava il menu, e va ricordato perché spiega cosa fa e cosa
 * non fa: toglie il ramo a runtime — che sbagliava comunque, in tutti e quattro i casi —
 * e fa sì che un fallimento di schema sia LOGGATO come `evento: 'schema'` invece di
 * uscire a schermo. L'indice lo mette il database, non questo modulo.
 *
 * ⚠️ Anche la riga qui sopra è una misura con una data, non una garanzia: chi ci si
 * appoggia la rifaccia invece di crederle —
 * `select indexdef from pg_indexes where tablename = 'mensa_menu_rotazione'`.
 *
 * ⚠️ Se qualcuno rimette una chiave senza `menu_config_id`, la trova
 * `__tests__/api/mensa-menu-put-chiave.test.ts`; se qualcuno cambia le colonne
 * senza migrare l'indice, lo trova `__tests__/architecture/onconflict-arbitro.test.ts`.
 */
export const CHIAVE_ROTAZIONE = 'scuola_id,menu_config_id,settimana,giorno_settimana'
export const CHIAVE_OVERRIDE = 'scuola_id,menu_config_id,data'

/**
 * ⚠️ QUI NON C'È `vincoloConflittoAssente`, e l'assenza è voluta: sta in
 * `@/lib/db/vincolo-conflitto`, e da lì lo importa chi ne ha bisogno.
 *
 * Una riesportazione di comodo ci stava, ed è stata tolta. `chiave-orario.ts` ne ha
 * una perché ha tre chiamanti STORICI da non rompere; questo file è nato il
 * 2026-09-06 e di chiamanti storici non ne ha nessuno: l'alias avrebbe creato un
 * terzo percorso d'importazione per lo stesso predicato il giorno in cui se ne
 * creava il primo. Il costo non è teorico — la route dei giudizi della PRIMARIA
 * sarebbe finita a importare da `lib/mensa`.
 */
