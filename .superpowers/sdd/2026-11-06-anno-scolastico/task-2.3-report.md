# Compito 2.3 — rapporto

Stato: DONE_WITH_CONCERNS.

## Fatto
- V1 (`20261107023143_anno_vincoli_1.sql`): CHECK `<tab>_anno_id_presente ... NOT VALID` sulle tabelle del registro.
- V2 (`20261107023257_anno_vincoli_2.sql`): riempimento finale con `ANNO_RIEMPIMENTO_INCOMPLETO` (anche da `check_violation`), VALIDATE, NOT NULL, DROP del CHECK, `controlli_rigidi = true`, `anno_invarianti()` con 12, 13 e 11-bis, DROP `anno_riempi`, fotografia finale solo la prima volta.
- M1 (estesa): specchio `alunni -> frequenze`, `anno_log_avviso`, traduzione di `target_section_ids`/mensa `section_id` (6 trigger), `anno_target_divergenti()`, `anno_righe_senza_anno_con_sede`; `anno_riempi(p_tabelle, p_oggi)`; il trigger CRM rispetta `anno_tabelle.rigida`; 7a: niente `GIORNO_SENZA_ANNO` per `sede_facoltativa` con sede NULL.
- Test: `anno-vincoli` (15), `anno-specchio-alunni` (10), `anno-target-section-ids` (31), `anno-invarianti` (45), `anno-transitorio` (49, +4 nuovi), riempimento/riconciliazione adattati. Helper `creaDbAnnoPr2`.
- Lock: V1/V2 in `MIGRAZIONI_ATTESE_AL_MERGE` (il filtro `add constraint` le segnalava).
- Allineato `docs/superpowers/specs/2026-11-06-anno-scolastico-invarianti.sql` (11-bis, 12, 13).

## Prova del rosso
Invariante 12 rotta in V2 (conteggio forzato a 0): `anno-invarianti` rosso sul test «12 · avvisi...»; ripristinata, 60/60 verdi. Il controllo `v_n > 0` di V2 da solo non e' osservabile: lo copre il catch di `check_violation` (stesso codice).

## Gate
eslint e tsc puliti. `vitest run __tests__/db __tests__/architecture`: 1 rosso, `offline-html-nativo` (ambiente, gia' rosso prima). `anno-*.test.ts`: 14 file, 12 passati, 2 skipped (preesistenti), 475 test.

## Deviazioni e dubbi
- Specchio: due trigger (INSERT e UPDATE OF ... con WHEN) invece di uno: `OLD` non e' ammesso nel WHEN di un INSERT.
- Finestra V1->V2: una riga nuova non risolvibile viene rifiutata.
- Invariante 13 resta >0 in produzione per la riga mensa senza corrispondenza ed e' ancorata all'anno attivo: salta al rollover.
- Le righe senza sede non sono contate (12). `alunni.stato` non usato: lo stato deriva da `archiviato_il`.
- CHECK sulle tabelle facoltative con alunno senza `scuola_id`.
- Il banco dipende dall'orologio reale solo dove la data non e' fissata.
- Scritture in `src/` che a controlli rigidi potrebbero essere rifiutate (solo dubbi, se la data cade fuori da ogni anno o la sede manca): `src/app/api/attendance/daily/route.ts:372`, `src/app/api/primaria/appello/route.ts:456` (presenze, `GIORNO_SENZA_ANNO`); `src/app/api/avvisi/route.ts:1109,1140`; `src/app/api/pagamenti/route.ts:685`, `pagamenti/genera/route.ts:271-331`, `pagamenti/rate/route.ts:139-164` (`ANNO_NON_COERENTE` se `anno_id` o competenza discordi).

---

# Correzione, giro 1 di 5

## Cambiato
- **Importante 1** (M1): `anno_traduci_classi(p_scuola, p_nomi, p_anno uuid DEFAULT NULL)`, `p_anno` e' un `anni_scolastici.id`, NULL = anno attivo (il riempimento 2.2 non cambia). Il trigger `anno_traduci_classi_trg` usa `OLD.anno_id` in UPDATE se la tabella ha `anno_id` e non e' NULL, l'anno attivo in INSERT; per le tabelle senza `anno_id` (`mensa_class_menu_assignment`, `news_posts`, `forms_templates`) l'anno della data della riga (`attivo_dal`, poi `created_at`, con `anno_di`). `anno_target_divergenti()` confronta con `t.anno_id` o, senza, con l'anno della stessa data; senza nessuna data usa l'anno attivo (limite scritto nel commento; nello schema di prova `news_posts` e `forms_templates` non hanno `created_at`). Nessun `WHEN` sul trigger.
- **Importante 2** (V2): due giri nello stesso blocco, prima tutti i `VALIDATE`, poi `SET NOT NULL` + `DROP CONSTRAINT`.
- **Banco**: `__tests__/db/anno-banco-specchio.test.ts`, solo con `KIDVILLE_BANCO_ANNO=1`.

## Test
`anno-target-section-ids.test.ts`: due casi nuovi dopo il passaggio d'anno (Girasoli in 2026/27 e 2027/28; UPDATE con gli stessi nomi lascia l'uuid del 2026/27 e il 13 resta 0; INSERT nuovo sceglie la Girasoli 2027/28; mensa con `attivo_dal`). V2 (atomicita', rieseguibilita', nessun CHECK doppio) resta verde.

## Comandi e uscite
- `vitest run anno-target-section-ids anno-vincoli anno-riempimento anno-riconciliazione`: 4 file, 102 test verdi.
- `vitest run __tests__/db __tests__/architecture`: 220 file passati, 3 saltati; 1 rosso, `offline-html-nativo` (ambiente, come prima).
- eslint e tsc puliti.
- Banco (`KIDVILLE_BANCO_ANNO=1`, PGlite, ordine di grandezza): 1.000 INSERT singoli di `alunni`, specchio spento 151 ms, acceso 339 ms (+~0,19 ms a riga); 2.000 alunni, 1.000 frequenze.

## Prova del rosso
`anno_traduci_classi` che ignora `p_anno` (`coalesce(NULL::uuid, ...)`): rossi entrambi i casi nuovi (2 falliti su 33); ripristinata, 33/33 verdi.

## Dubbio
Il riempimento 2.2 traduce ancora con l'anno attivo: una riga di un anno diverso dall'attivo con nomi di classe, riempita cosi', risulterebbe divergente per l'invariante 13 se quell'anno ha sezioni diverse. Non toccato, come da istruzione.
