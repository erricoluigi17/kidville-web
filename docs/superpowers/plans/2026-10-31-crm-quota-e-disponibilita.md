# CRM — quota d'iscrizione in contabilità e disponibilità settimana per settimana · piano di implementazione

> **Per chi esegue:** SOTTO-SKILL OBBLIGATORIA: superpowers:subagent-driven-development (consigliata) oppure
> superpowers:executing-plans. Si va compito per compito, nell'ordine. I passi usano le caselle (`- [ ]`).

**Obiettivo:** la segreteria segna dal CRM la quota d'iscrizione con importo, giorno e metodo. I contanti
entrano subito nella cassa del giorno. Quando il bambino diventa alunno, la quota diventa la sua voce
«Iscrizione AAAA/AA» senza che nessun totale di cassa cambi. Le disponibilità si danno per persona o per
sede, settimana per settimana.

**Architettura:** una migrazione aggiunge le colonne della quota a `crm_bambini`, due tabelle per le
settimane (`crm_settimane`, `crm_fasce`) al posto di `crm_disponibilita`, e cinque funzioni plpgsql che
fanno ogni scrittura a più passi in **una** transazione (segnare, togliere, passare in contabilità,
agganciare l'alunno, salvare una settimana). La regola «un movimento di cassa con `incasso_id` è assorbito»
vale in una funzione TS pura e nelle tre funzioni SQL dei report. Le route stanno sotto `/api/admin/crm/`
con `withRoute` + `requireCrm` + zod. L'import delle domande e il collegamento chiamano l'aggancio
all'alunno senza poter fallire per colpa sua.

**Tecnologie:** Next.js (prima di scrivere codice leggere la guida in `node_modules/next/dist/docs/`),
Supabase/PostgREST, PostgreSQL 17.6, zod, next-intl, vitest.

**Specifica:** `docs/superpowers/specs/2026-10-31-crm-quota-e-disponibilita-design.md` (approvata da Luigi
il 31/10/2026). Va letta **per intero** prima di cominciare: il piano rimanda ai suoi paragrafi (§).

## Vincoli globali

- **Lingua:** interfaccia in italiano, ogni stringa con la sua traduzione in `messages/en/`.
- **Dati di minori:** il repository è pubblico. Nei test solo nomi di prova («Bimbo Prova»), sedi
  `SEDE_A`/`SEDE_B` da `__tests__/fixtures/sedi.ts`. Nei log solo uuid, importi, conteggi, enumerazioni e
  codici d'esito; mai `nome`, `descrizione` del movimento di cassa, `testo` o `dati` degli eventi.
- **Logging:** mai `console.*`; `logOk` / `logErrore` / `logEvento('crm', …)` da `@/lib/logging/logger`.
  Il passaggio in contabilità e l'aggancio all'alunno sono eventi critici: loggano **anche il successo**.
- **Route:** `withRoute('admin/crm/<percorso>:<METODO>', …)`, poi `requireCrm(request)` di
  `src/lib/crm/accesso.ts` (segreteria + admin: la spec §7 dice `requireStaff(['segreteria'])`, ma il CRM
  in produzione usa `requireCrm` e il lock `crm-gate-requirecrm` lo impone), poi `parseBody`/`parseQuery`.
  Ogni risposta d'errore ha un `codice` letterale, dichiarato in `CODICI_ERRORE`
  (`src/lib/ui/esito-fetch.ts:72`) e tradotto in `messages/{it,en}/shared.json` (lock `errori-con-codice`).
- **Sede:** ogni lettura su `crm_*` porta il filtro di sede nella **stessa** query; ogni `update`/`delete`
  porta `.eq('scuola_id', <sede verificata>)`; quota, entrata, voce e alunno sono tutti della sede della
  scheda (lock `isolamento-sede-coverage`).
- **PostgREST non lancia:** ogni risultato si controlla su `{ error }` e passa da `rispostaErroreDb`
  (`src/lib/crm/errori.ts`): `PGRST205`/`42P01` → `503 CRM_NON_INSTALLATO`.
  Il database E2E della CI **non ha le tabelle `crm_*`** e non sarà migrato: ogni percorso nuovo degrada lì.
- **Metodi:** il CRM conosce `contanti`, `carta`, `bonifico`. L'enum `incasso_metodo` non ha `carta`: si
  scrive `pos` (`contanti→contanti`, `carta→pos`, `bonifico→bonifico`). `cassa_movimenti.metodo` riceve solo
  `contanti`.
- **Anno della quota:** si salva come intero `quota_anno` = anno d'apertura (2027 per il 2027/28), calcolato
  **al momento in cui si segna**: `in_corso` → primo anno di `annoScolasticoCorrente()`
  (`src/lib/anno-scolastico.ts`, cambia ad agosto), `prossimo` → quello più uno. Etichetta «2027/28»,
  competenza `2027-09-01`.
- **Database:** nessuno applica la migrazione né scrive in produzione. La applica l'integrazione al merge,
  che fa il titolare. In produzione solo `SELECT`, solo per verificare.
- **Gate:** `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` · `npm run build`
  (con `NODE_OPTIONS=--max-old-space-size=8192` se va in memoria). E2E solo in CI.

## Fatti misurati in produzione il 31/10/2026 (solo `SELECT`)

| Fatto | Valore |
|---|---|
| righe in `crm_disponibilita` | 1 (sede Demo) |
| bambini con `quota_saldata = true` | 1 (sede Demo) |
| movimenti di cassa con `incasso_id` | 0 su 168 |
| categoria `payment_categories` con `slug = 'iscrizione'` | 1, globale (`scuola_id` nullo) e di sistema |
| valori di `pagamenti.stato` | `da_pagare`, `pagato`, `scaduto` (nessuno «annullato») |
| enum `incasso_metodo` | `contanti, bonifico, pos, assegno, altro, credito_famiglia, storno, rettifica` |
| nome del CHECK su `crm_eventi.tipo` | `crm_eventi_tipo_check` |
| trigger su `cassa_movimenti` | `cassa_movimenti_valida_provenienza` (solo su `scuola_id`, `cassa_categoria_id`, `storno_di`), `scatola_nera_eliminazioni`, `scatola_nera_no_truncate` |
| versione di PostgreSQL | 17.6 (`UNIQUE NULLS NOT DISTINCT` disponibile) |
| `iscrizioni_import_esiti` | `submission_id uuid`, `scuola_id uuid`, `stato text`, `alunni_creati uuid[]` |

`cassa_movimenti.incasso_id` esiste già (`uuid UNIQUE REFERENCES incassi ON DELETE SET NULL`, dalla
migrazione `20260720100000_cassa_base.sql`): non si crea. Lo storno della cassa rifiuta già un movimento
con `incasso_id` (`storno/route.ts:91`).

## Scelte dell'assistente fatte scrivendo il piano

Da far vedere a Luigi insieme al piano; si cambiano senza toccare la spec.

1. **Contanti e cassa chiusa** (spec §5.1): il giorno è ammesso se è **dopo** il giorno civile dell'ultima
   chiusura della sede, oppure se è **oggi** (soldi arrivati dopo la chiusura di oggi).
2. **La vecchia spunta** (spec §5.1): `quota_saldata` resta nel database ma non la legge e non la scrive più
   nessuno (commento «dismessa»); `quota_saldata_il` diventa il giorno del pagamento e `quota_segnata_da`
   chi ha segnato. Nessuna colonna tolta: niente `DROP COLUMN`. La quota Demo diventa `senza_importo`.
3. **Motivi di blocco:** oltre ai due della spec (`gia_pagata`, `supera_residuo`) servono `piu_voci` (due voci
   «Iscrizione» per lo stesso alunno e anno: non si sceglie a caso) ed `entrata_stornata` (l'entrata di
   cassa del CRM è stata stornata dalla cassa: passarla in contabilità creerebbe soldi che non ci sono).
4. **Togliere il collegamento all'alunno** è ammesso solo finché la quota non è in contabilità.
5. **La conversione della fascia Demo** finisce nella settimana in corso al momento della migrazione.
6. **La lista delle quote** è una vista nuova della contabilità («Quote dal CRM»); a chi non è segreteria o
   admin il pannello risponde «riservato alla segreteria».
7. **Salvare una settimana** manda tutte le fasce di quel proprietario per quella settimana, e la funzione le
   sostituisce. Così la copia di ciò che si ereditava e la modifica sono un'unica scrittura (spec §6.2).

## Da tenere d'occhio (Review Focus)

Condizioni che la spec implica e che nessun test dei compiti coprirebbe da solo. Ognuna ha il suo test,
aggiunto al compito indicato.

1. **Doppio clic su «Segna la quota»** con i contanti: due richieste in volo non devono lasciare due entrate
   in cassa. Il bottone si disabilita mentre la richiesta è in volo, e la funzione blocca la riga del
   bambino (`FOR UPDATE`). Test nei Compiti 1 e 5.
2. **Lo stesso alunno collegato a due bambini**, perché l'import e un collegamento a mano arrivano
   insieme: la `UNIQUE (alunno_id)` risponde `23505`, che deve diventare `409 ALUNNO_GIA_COLLEGATO` e non 500
   (oggi `rispostaErroreDb` traduce ogni 23505 in `GIA_COLLEGATO` con il testo delle domande). Test nel
   Compito 4.
3. **Importo scritto all'italiana** («150,50»), con tre decimali, zero o negativo: il campo accetta la
   virgola, la route rifiuta il resto con `400`. Test nei Compiti 3 e 5.
4. **«Mai nel futuro» a cavallo della mezzanotte di Roma:** alle 23:30 UTC del 31/10 a Roma è già il
   1/11; quel giorno va accettato. Test nel Compito 3.
5. **Il cambio dell'ora legale** (domenica 25/10/2026): il lunedì della settimana e gli slot delle 9:00 del
   26/10 (08:00 UTC) devono uscire giusti. Test nel Compito 7.

## Mappa dei file

| File | Responsabilità | Compito |
|---|---|---|
| `supabase/migrations/<UTC>_crm_quota_e_settimane.sql` | colonne, tabelle, cinque funzioni, tre report | 1 |
| `src/lib/crm/tipi.ts` | vocabolari e righe nuove | 1 |
| `__tests__/lib/crm/migrazione-quota-settimane.test.ts` | lock strutturale della migrazione | 1 |
| `src/lib/cassa/assorbiti.ts` | la regola dell'assorbimento, pura | 2 |
| `src/lib/cassa/saldo.ts`, `src/app/api/pagamenti/cassa/movimenti/route.ts` | la applicano | 2 |
| `src/lib/crm/quota.ts` | anno, etichette, metodo, giorno ammesso, chiamate alle funzioni SQL | 3 |
| `src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/quota/route.ts` (+ `riprova/`) | segnare, correggere, togliere, riprovare | 3 |
| `src/lib/crm/aggancio-alunno.ts` | aggancio dall'import, dalla domanda già importata, a mano | 4 |
| `src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/alunno/route.ts`, `src/app/api/admin/crm/alunni/route.ts` | collegare e cercare alunni | 4 |
| `src/lib/iscrizioni/import/esegui.ts`, `src/lib/crm/collegamento.ts` | chiamano l'aggancio | 4 |
| `src/components/features/crm/schede/QuotaIscrizione.tsx`, `CollegaAlunno.tsx` | la quota e l'alunno nella scheda | 5 |
| `src/app/api/admin/crm/quote/route.ts`, `src/components/features/admin/pagamenti/QuoteCrmPanel.tsx` | la lista in contabilità | 6 |
| `src/lib/crm/settimane.ts`, `src/lib/crm/slot.ts`, `src/lib/crm/agenda.ts` | fasce di una settimana, slot | 7 |
| `src/app/api/admin/crm/disponibilita/route.ts` (via `[id]/`) | leggere e salvare una settimana | 7 |
| `src/components/features/crm/disponibilita/SettimanaDisponibilita.tsx` | la griglia della settimana | 8 |
| `PRD REGISTRO ELETTRONICO.md` | stato e changelog | 9 |

---

### Compito 1: la migrazione, i vocabolari e i tipi

**File:**
- Crea: `supabase/migrations/<UTC>_crm_quota_e_settimane.sql` (nome con `date -u +%Y%m%d%H%M%S` nel momento
  in cui si crea il file; mai un orario tondo)
- Modifica: `src/lib/crm/tipi.ts` (vocabolari, `BambinoRow`, righe nuove)
- Modifica: `__tests__/architecture/soglia-fotografia.ts:292` (`MIGRAZIONI_ATTESE_AL_MERGE`)
- Modifica: `__tests__/lib/crm/vocabolari-allineati.test.ts`
- Modifica: `__tests__/lib/report-cassa-aggregato-sql.test.ts`, `__tests__/lib/report-cassa-dettaglio-sql.test.ts`,
  `__tests__/lib/cassa-provenienza-sql.test.ts`
- Crea: `__tests__/lib/crm/migrazione-quota-settimane.test.ts`

**Interfacce prodotte** (in `src/lib/crm/tipi.ts`):

```ts
export const QUOTA_METODI = ['contanti', 'carta', 'bonifico'] as const
export const QUOTA_STATI = ['senza_importo', 'in_attesa', 'in_contabilita', 'bloccata'] as const
export const QUOTA_MOTIVI_BLOCCO = ['gia_pagata', 'supera_residuo', 'piu_voci', 'entrata_stornata'] as const
export type MetodoQuota = (typeof QUOTA_METODI)[number]
export type StatoQuota = (typeof QUOTA_STATI)[number]
export type MotivoBloccoQuota = (typeof QUOTA_MOTIVI_BLOCCO)[number]
// TIPI_EVENTO: in coda, nell'ordine, 'quota_in_contabilita','quota_corretta','quota_tolta','alunno_collegato','alunno_scollegato'
export interface BambinoRow { /* campi esistenti, senza quota_saldata */
  quota_importo: number | string | null; quota_metodo: MetodoQuota | null; quota_anno: number | null
  quota_stato: StatoQuota | null; quota_blocco_motivo: MotivoBloccoQuota | null
  quota_saldata_il: string | null; quota_segnata_da: string | null
  quota_cassa_movimento_id: string | null; quota_pagamento_id: string | null
  alunno_id: string | null; alunno_collegato_il: string | null }
export interface SettimanaRow { id: string; scuola_id: string; utente_id: string | null; settimana: string; aggiornata_da: string | null; aggiornata_il: string }
export interface FasciaRow { id: string; scuola_id: string; settimana_id: string; giorno_settimana: number; ora_inizio: string; ora_fine: string; durata_slot_min: number }
```

`DisponibilitaRow` resta fino al Compito 7, che la toglie.

**Cosa contiene la migrazione** (in quest'ordine):

1. `crm_bambini`, colonne nuove: `quota_importo numeric(10,2) CHECK (quota_importo > 0)`,
   `quota_metodo text CHECK (quota_metodo IN ('contanti','carta','bonifico'))`,
   `quota_anno smallint CHECK (quota_anno BETWEEN 2000 AND 2100)`,
   `quota_stato text CHECK (quota_stato IN ('senza_importo','in_attesa','in_contabilita','bloccata'))`,
   `quota_blocco_motivo text CHECK (quota_blocco_motivo IN ('gia_pagata','supera_residuo','piu_voci','entrata_stornata'))`,
   `quota_cassa_movimento_id uuid REFERENCES public.cassa_movimenti(id) ON DELETE SET NULL`,
   `quota_pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL`,
   `alunno_id uuid REFERENCES public.alunni(id) ON DELETE SET NULL`, `alunno_collegato_il timestamptz`.
   Vincoli con nome: `crm_bambini_alunno_unico UNIQUE (alunno_id)`;
   `crm_bambini_quota_completa CHECK (quota_stato IS NULL OR quota_stato = 'senza_importo' OR (quota_importo IS NOT NULL AND quota_metodo IS NOT NULL AND quota_anno IS NOT NULL AND quota_saldata_il IS NOT NULL))`;
   `crm_bambini_quota_blocco CHECK ((quota_stato IS NOT DISTINCT FROM 'bloccata') = (quota_blocco_motivo IS NOT NULL))`.
   Indici: `quota_cassa_movimento_id`, `quota_pagamento_id`, e
   `idx_crm_bambini_quote_aperte (scuola_id, quota_stato) WHERE quota_stato IN ('senza_importo','in_attesa','bloccata')`.
   Poi `UPDATE public.crm_bambini SET quota_stato = 'senza_importo' WHERE quota_saldata AND quota_stato IS NULL;`
   e `COMMENT ON COLUMN … quota_saldata` «dismessa dal 31/10/2026: la verità è quota_stato».
2. `crm_eventi`: `ALTER TABLE … DROP CONSTRAINT crm_eventi_tipo_check, ADD CONSTRAINT crm_eventi_tipo_check CHECK (tipo IN (…24 valori di oggi…, 'quota_in_contabilita','quota_corretta','quota_tolta','alunno_collegato','alunno_scollegato'))`.
3. `crm_settimane`: `id`, `scuola_id uuid NOT NULL REFERENCES public.schools(id)`,
   `utente_id uuid REFERENCES public.utenti(id)` (nullo = la sede), `settimana date NOT NULL CHECK (extract(isodow FROM settimana) = 1)`,
   `aggiornata_da uuid REFERENCES public.utenti(id)`, `aggiornata_il timestamptz NOT NULL DEFAULT now()`,
   `creata_il timestamptz NOT NULL DEFAULT now()`;
   `CONSTRAINT crm_settimane_proprietario UNIQUE NULLS NOT DISTINCT (scuola_id, utente_id, settimana)`,
   `UNIQUE (id, scuola_id)`; indici su `utente_id` e `aggiornata_da`; RLS accesa, nessuna policy.
4. `crm_fasce`: `id`, `scuola_id uuid NOT NULL REFERENCES public.schools(id)`, `settimana_id uuid NOT NULL`,
   `giorno_settimana smallint NOT NULL CHECK (giorno_settimana BETWEEN 1 AND 7)`, `ora_inizio time NOT NULL`,
   `ora_fine time NOT NULL`, `durata_slot_min smallint NOT NULL DEFAULT 45 CHECK (durata_slot_min BETWEEN 15 AND 240)`,
   `CHECK (ora_fine > ora_inizio)`, `FOREIGN KEY (settimana_id, scuola_id) REFERENCES public.crm_settimane (id, scuola_id) ON DELETE CASCADE`;
   indice `(settimana_id, scuola_id)`; RLS accesa, nessuna policy.
5. Conversione: una settimana per `(scuola_id, utente_id)` di `crm_disponibilita` con
   `valida_al IS NULL OR valida_al >= CURRENT_DATE`, con `settimana = date_trunc('week', CURRENT_DATE)::date`,
   e le sue fasce copiate. Nessun uuid scritto a mano (lock `migrazioni-senza-sede-cablata`). Poi
   `-- distruttiva approvata: crm_disponibilita sostituita da crm_settimane/crm_fasce (spec 2026-10-31 §6.2, approvata da Luigi); l'unica riga, sede Demo, è copiata sopra`
   e `DROP TABLE public.crm_disponibilita;`.
6. Le cinque funzioni (sotto), tutte `LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp`,
   con `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role;` e un `COMMENT`.
7. `CREATE OR REPLACE` di `report_cassa_aggregato`, `report_cassa_dettaglio` e `conteggio_cassa_provenienza`:
   si copia il testo **dell'ultima** migrazione che le definisce (oggi `20261010084330`, `20261014215153`,
   `20261016075419`: verificarlo con
   `grep -ln "function public.report_cassa_aggregato" supabase/migrations/*.sql | tail -1`, e così per le
   altre) e si aggiunge `AND m.incasso_id IS NULL` a **ogni** lettura di `cassa_movimenti`. Firma e
   risultato restano identici.
8. `NOTIFY pgrst, 'reload schema';`

**Le funzioni.** Ogni funzione restituisce `jsonb` con `esito` e scrive lo storico in `crm_eventi`
(`autore` = `p_eseguito_da`, `autore_via` = `'sistema'` se è nullo, altrimenti `'segreteria'`; in `dati`
solo uuid, importi, metodo, giorno, anno).

- **`crm_quota_passa(p_bambino_id uuid, p_eseguito_da uuid) RETURNS jsonb`** — la quota diventa una voce.
  1. Blocca il bambino `FOR UPDATE`. Assente → `non_trovato`. `in_contabilita` → `gia_in_contabilita` (con il
     `pagamento_id`). Stato diverso da `in_attesa`/`bloccata`, oppure `alunno_id` nullo → `non_pronta`.
  2. L'alunno deve essere della sede del bambino, altrimenti `sede_diversa`.
  3. La categoria: `payment_categories` con `slug = 'iscrizione' AND is_sistema AND scuola_id IS NULL`;
     assente → `categoria_assente`.
  4. Le voci già presenti, bloccate `FOR UPDATE`: stesso `alunno_id`, stessa categoria, e
     `periodo_competenza = make_date(quota_anno, 9, 1)` oppure `periodo_competenza IS NULL AND scadenza BETWEEN make_date(quota_anno, 9, 1) AND make_date(quota_anno + 1, 8, 31)`.
     Più di una → blocco `piu_voci`.
  5. Contanti con `quota_cassa_movimento_id`: se quel movimento ha `stornato_il` valorizzato → blocco
     `entrata_stornata`.
  6. Una voce trovata, residuo = `importo − coalesce(sconto,0) − coalesce(importo_pagato,0)`:
     - residuo ≤ 0,005 → blocco `gia_pagata`;
     - bonifico → la quota si lega alla voce, nessun incasso;
     - importo della quota > residuo + 0,005 → blocco `supera_residuo`;
     - altrimenti l'incasso si registra su quella voce (passo 8).
  7. Nessuna voce: `INSERT INTO pagamenti` con gli stessi campi di `POST /api/pagamenti`
     (`src/app/api/pagamenti/route.ts:670-683`): `alunno_id`, `scuola_id` = sede del bambino,
     `descrizione = 'Iscrizione ' || quota_anno || '/' || lpad(((quota_anno + 1) % 100)::text, 2, '0')`,
     `importo`, `scadenza = quota_saldata_il`, `categoria_id`, `tipo = 'singolo'`, `obbligatorio = true`,
     `periodo_competenza = make_date(quota_anno, 9, 1)`, `gruppo = NULL`, `creato_da = quota_segnata_da`,
     `stato = 'da_pagare'`.
  8. Contanti e carta: `public.registra_incasso_voce(p_pagamento_id => voce, p_importo => quota_importo, p_registrato_da => quota_segnata_da, p_data_incasso => quota_saldata_il, p_metodo => CASE quota_metodo WHEN 'carta' THEN 'pos' ELSE 'contanti' END, p_note => 'Quota d''iscrizione dal CRM')`.
     Un `esito` diverso da `ok` fa `RAISE EXCEPTION` (si disfa tutto).
  9. Contanti con `quota_cassa_movimento_id`: `UPDATE cassa_movimenti SET incasso_id = <id dell'incasso> WHERE id = … AND incasso_id IS NULL AND stornato_il IS NULL`;
     zero righe → `RAISE EXCEPTION`.
  10. `quota_stato = 'in_contabilita'`, `quota_pagamento_id`, `quota_blocco_motivo = NULL`,
      `aggiornata_il = now()`; evento `quota_in_contabilita` (`dati`: `bambino_id`, `pagamento_id`,
      `incasso_id`, `importo`, `metodo`, `anno`).
  11. Un blocco scrive `quota_stato = 'bloccata'` con il motivo e restituisce `{esito:'bloccata', motivo}`,
      senza eventi. Il successo restituisce
      `{esito:'ok', pagamento_id, incasso_id (null per bonifico), voce_nuova, metodo}`.
- **`crm_quota_segna(p_bambino_id uuid, p_importo numeric, p_metodo text, p_giorno date, p_anno smallint, p_eseguito_da uuid) RETURNS jsonb`**
  — segna o corregge.
  1. Blocca il bambino `FOR UPDATE`. Assente → `non_trovato`; `in_contabilita` → `in_contabilita`.
  2. Se c'è già un movimento di contanti (`quota_cassa_movimento_id`) non stornato, lo storna come
     `storno/route.ts:98-147`: contro-movimento (stesso tipo, metodo e `cassa_categoria_id`, importo negato,
     `storno_di`, `registrato_da = p_eseguito_da`), marca `stornato_il = now()` e
     `storno_motivo = 'Quota d''iscrizione corretta dal CRM'`, riga in `registro_modifiche`.
  3. Contanti: `INSERT INTO cassa_movimenti` con `scuola_id` = sede del bambino, `tipo = 'entrata'`,
     `importo`, `metodo = 'contanti'`, `data = p_giorno`, `cassa_categoria_id` = categoria `iscrizione`,
     `categoria_id = NULL`, `registrato_da = p_eseguito_da` e la descrizione della spec §5.2
     (`format('Quota d''iscrizione %s – %s (CRM)', <etichetta>, coalesce(nome, 'bambino'))`).
  4. Scrive i campi della quota, `quota_saldata_il = p_giorno`, `quota_segnata_da = p_eseguito_da`,
     `quota_stato = 'in_attesa'`, `quota_blocco_motivo = NULL`, il movimento nuovo (o `NULL`). Evento:
     `quota_segnata` se prima non c'era una quota con importo, altrimenti `quota_corretta`.
  5. Se `alunno_id` è valorizzato, chiama `crm_quota_passa` nella stessa transazione e mette il suo
     risultato in `passaggio`. Restituisce `{esito:'ok', movimento_id, corretta, passaggio}`.
- **`crm_quota_togli(p_bambino_id uuid, p_eseguito_da uuid) RETURNS jsonb`**: blocca il bambino,
  `in_contabilita` → `in_contabilita`. Storna il movimento come al passo 2 di `crm_quota_segna`, con
  motivo «Quota d'iscrizione tolta dal CRM». Azzera i campi della quota (`quota_saldata = false`).
  Evento `quota_tolta`, risultato `{esito:'ok', stornato}`.
- **`crm_aggancia_alunno(p_bambino_id uuid, p_alunno_id uuid, p_eseguito_da uuid) RETURNS jsonb`**: blocca il
  bambino; l'alunno deve esistere ed essere della stessa sede (`sede_diversa`). `alunno_id` già uguale:
  nessun cambiamento. Diverso: `gia_collegato_altro`. Nullo: scrive `alunno_id` e `alunno_collegato_il`
  ed emette l'evento `alunno_collegato` (`dati`: `bambino_id`, `alunno_id`). Una `23505` sulla
  `crm_bambini_alunno_unico` si intercetta (`EXCEPTION WHEN unique_violation`) e diventa
  `alunno_gia_collegato`. Poi, se la quota è `in_attesa` o `bloccata`, `crm_quota_passa`. Risultato:
  `{esito:'ok', collegato: bool, passaggio: jsonb|null}`.
- **`crm_salva_settimana(p_scuola_id uuid, p_utente_id uuid, p_settimana date, p_fasce jsonb, p_eseguito_da uuid) RETURNS jsonb`**:
  1. `p_settimana` non è un lunedì → `settimana_non_valida`. È prima del lunedì della settimana in corso a
     Roma (`date_trunc('week', (now() AT TIME ZONE 'Europe/Rome')::date)`) → `settimana_passata`.
  2. Fasce dello stesso giorno che si sovrappongono → `fasce_sovrapposte`.
  3. Testata con
     `INSERT … ON CONFLICT ON CONSTRAINT crm_settimane_proprietario DO UPDATE SET aggiornata_da, aggiornata_il = now() RETURNING id`.
  4. `DELETE FROM crm_fasce WHERE settimana_id = <id>`, poi le fasce da `jsonb_to_recordset(p_fasce)`
     (`giorno_settimana`, `ora_inizio`, `ora_fine`, `durata_slot_min`).
  5. Risultato `{esito:'ok', settimana_id}`. Una lista vuota è una settimana volutamente vuota.

- [ ] **Passo 1: scrivi il lock della migrazione**

`__tests__/lib/crm/migrazione-quota-settimane.test.ts` legge il file senza commenti (`senzaCommenti` di
`../../architecture/soglia-fotografia`):

```ts
it('esiste un solo file *_crm_quota_e_settimane.sql, posteriore al CRM', …)            // nome > 20261030230225
it('aggiunge a crm_bambini tutte le colonne della quota e alunno_id unico', …)          // regex per ogni colonna + 'crm_bambini_alunno_unico unique (alunno_id)'
it('la proprietà di una settimana è unica con i NULL non distinti', …)                 // /unique\s+nulls\s+not\s+distinct\s*\(\s*scuola_id,\s*utente_id,\s*settimana\s*\)/
it('ogni chiave esterna nuova ha il suo indice', …)                                     // quota_cassa_movimento_id, quota_pagamento_id, utente_id, aggiornata_da, (settimana_id, scuola_id)
it('il DROP TABLE di crm_disponibilita è approvato e viene DOPO la conversione', …)     // approvata(sql) === true; indexOf('insert into public.crm_fasce') < indexOf('drop table public.crm_disponibilita')
it('le cinque funzioni sono solo del service_role', …)                                  // per ogni nome: revoke … from public, anon, authenticated + grant execute … to service_role
it('crm_quota_segna, crm_quota_togli, crm_quota_passa e crm_aggancia_alunno bloccano il bambino', …) // 'for update' nel corpo di ciascuna
it('le tre funzioni dei report escludono i movimenti assorbiti', …)                     // nel corpo di ciascuna, ogni 'from public.cassa_movimenti m' è seguito da 'm.incasso_id is null' prima del ';' successivo
it('il passaggio in contabilità scrive carta come pos e la competenza al 1° settembre', …) // "when 'carta' then 'pos'" e 'make_date(' + "9, 1"
```

`approvata` è esportata da `__tests__/architecture/migrazioni-distruttive-approvate.test.ts`: se non è
importabile da un altro test, si sposta in `__tests__/architecture/soglia-fotografia.ts` e la si importa da
entrambi.

- [ ] **Passo 2: lancialo e guardalo fallire**

Esegui `npx vitest run __tests__/lib/crm/migrazione-quota-settimane.test.ts`.
Atteso: FAIL «esiste un solo file», e la riga `Test Files 1 failed`.

- [ ] **Passo 3: estendi `vocabolari-allineati`**

La costante `FILE` diventa la lista dei file `/^\d{14}_crm_(segreteria|quota_e_settimane)\.sql$/` in ordine
di nome. `checkDellaMigrazione` legge anche
`alter table public.crm_bambini add column <col> … check (<col> in (…))` e
`add constraint crm_eventi_tipo_check check (tipo in (…))`; vince la definizione dell'ultimo file. In
`MAPPA` entrano `crm_bambini.quota_metodo → QUOTA_METODI`, `crm_bambini.quota_stato → QUOTA_STATI` e
`crm_bambini.quota_blocco_motivo → QUOTA_MOTIVI_BLOCCO`. La voce `crm_disponibilita` sparisce dal test,
se c'è. Esegui: deve fallire per i tre vocabolari che mancano in `tipi.ts`.

- [ ] **Passo 4: scrivi la migrazione e i tipi**

Il contenuto è sopra. Nei tre test SQL dei report, il file letto diventa l'ultimo che definisce la
funzione, e si aggiunge `expect(corpo).toMatch(/m\.incasso_id\s+is\s+null/i)`.

- [ ] **Passo 5: dichiara la migrazione**

In `MIGRAZIONI_ATTESE_AL_MERGE` aggiungi la voce `'<UTC>_crm_quota_e_settimane.sql'`, con un commento datato
nello stile di quelli sopra. Il commento dice cosa cambierà nelle fotografie:
- indici unici `crm_bambini_alunno_unico`, `crm_settimane_proprietario`, chiavi primarie;
- RLS su `crm_settimane`/`crm_fasce`, `crm_disponibilita` tolta;
- FK di sede (+2), FK verso `utenti` (+2, −1), tabelle con `scuola_id` (+2, −1);
- la fotografia delle migrazioni.

Aggiungi anche che si svuota nella PR-B dopo il merge.

- [ ] **Passo 6: verifica**

Esegui:
`npx vitest run __tests__/lib/crm __tests__/lib/report-cassa-aggregato-sql.test.ts __tests__/lib/report-cassa-dettaglio-sql.test.ts __tests__/lib/cassa-provenienza-sql.test.ts __tests__/architecture`.
Atteso: tutto verde.
Poi `npx tsc --noEmit`, che fallirà solo dove `quota_saldata` era letto: lo sistemano i Compiti 3 e 5. Se
il tipo rompe la build prima, lascia `quota_saldata?: boolean` facoltativo e annota nel commit che si toglie
nel Compito 5.

- [ ] **Passo 7: commit** — `git commit -m "CRM: migrazione della quota in contabilità e delle settimane di disponibilità"`

---

### Compito 2: la cassa non conta due volte

**File:**
- Crea: `src/lib/cassa/assorbiti.ts`, `__tests__/cassa/assorbiti.test.ts`
- Modifica: `src/lib/cassa/saldo.ts` (`caricaSaldoCassa`, `caricaEntratoOggi`: aggiungere `incasso_id` alla
  `select` e filtrare)
- Modifica: `src/app/api/pagamenti/cassa/movimenti/route.ts` (GET: lettura a righe 163 e seguenti, lista
  240–298, totali 305–320)
- Test: `__tests__/cassa/saldo.test.ts`, `__tests__/cassa/movimenti-route.test.ts`

**Interfacce prodotte:**

```ts
/** Un movimento con incasso_id è rappresentato da quell'incasso: non si conta e non si elenca. */
export function movimentoAssorbito(m: { incasso_id?: string | null }): boolean
export function soloMovimentiContati<T extends { incasso_id?: string | null }>(movimenti: T[]): T[]
```

- [ ] **Passo 1: test della funzione pura** — `__tests__/cassa/assorbiti.test.ts`:

```ts
expect(movimentoAssorbito({ incasso_id: 'inc-1' })).toBe(true)
expect(movimentoAssorbito({ incasso_id: null })).toBe(false)
expect(movimentoAssorbito({})).toBe(false)
expect(soloMovimentiContati([{ id: 'a', incasso_id: null }, { id: 'b', incasso_id: 'inc-1' }]).map((m) => m.id)).toEqual(['a'])
```

- [ ] **Passo 2: test del saldo e della lista** — in `saldo.test.ts`, entrata 50 € contanti con
  `incasso_id = 'inc-1'` più l'incasso virtuale 50 € in contanti `inc-1`: `saldo_atteso` aumenta di **50**,
  non di 100. Lo stesso caso in `movimenti-route.test.ts`: la GET elenca una riga sola da 50 € e il totale
  entrate del giorno è 50.
- [ ] **Passo 3: lanciali e guardali fallire** (100 invece di 50): `npx vitest run __tests__/cassa`.
- [ ] **Passo 4: implementa** — `assorbiti.ts`, poi la funzione chiamata in ogni punto che somma o elenca
  `cassa_movimenti`. Controlla di averli presi tutti:
  `grep -rn "from('cassa_movimenti')" src` deve mostrare solo `movimenti/route.ts`, `movimenti/storno/route.ts`
  (riga singola: non serve), `saldo.ts` e `gdpr/esegui.ts` (export dei dati: non serve).
- [ ] **Passo 5: verifica** — `npx vitest run __tests__/cassa __tests__/components/Cassa*` verde. Poi rompi il
  filtro di proposito: il test del Passo 2 deve tornare rosso.
- [ ] **Passo 6: commit** — `git commit -m "Cassa: un'entrata assorbita da un incasso non si conta due volte"`

---

### Compito 3: segnare, correggere e togliere la quota

**File:**
- Crea: `src/lib/crm/quota.ts`, `__tests__/lib/crm/quota.test.ts`
- Crea: `src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/quota/route.ts` (`PUT`, `DELETE`)
- Crea: `src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/quota/riprova/route.ts` (`POST`)
- Modifica: `src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/route.ts` (toglie `quotaSaldata`,
  `quotaSaldataIl` dallo schema zod e le righe 151–163 e 189)
- Modifica: `src/lib/ui/esito-fetch.ts` (`CODICI_ERRORE`), `messages/{it,en}/shared.json`
- Test: `__tests__/api/crm-quota.test.ts`

**Interfacce:**
- Usa: le funzioni SQL `crm_quota_segna`, `crm_quota_togli`, `crm_quota_passa` (Compito 1),
  `assertSchedaInScope` (`src/lib/crm/accesso.ts`), `notificaEvento` e `politicaNotificaServizio`, come in
  `src/app/api/pagamenti/incassi/route.ts:259-275`.
- Produce (`src/lib/crm/quota.ts`):

```ts
export function annoDellaQuota(annoIngresso: AnnoIngresso, adesso?: Date): number | null   // 'non_indicato' → null
export function etichettaAnno(anno: number): string                                         // 2027 → '2027/28'
export function competenzaDellaQuota(anno: number): string                                  // 2027 → '2027-09-01'
export function metodoIncasso(m: MetodoQuota): 'contanti' | 'pos' | 'bonifico'
export function giornoContantiAmmesso(giorno: string, ultimaChiusuraIl: string | null, oggi: string): boolean
export type EsitoPassaggio =
  | { esito: 'ok'; pagamentoId: string; incassoId: string | null; voceNuova: boolean }
  | { esito: 'bloccata'; motivo: MotivoBloccoQuota }
  | { esito: 'gia_in_contabilita'; pagamentoId: string }
  | { esito: 'non_pronta' | 'non_trovato' | 'sede_diversa' | 'categoria_assente' | 'non_installato' | 'errore' }
export function esitoPassaggioDa(json: unknown): EsitoPassaggio         // dal jsonb della funzione SQL al tipo
/** Chiama crm_quota_passa. NON LANCIA MAI: ogni guasto è un log e un esito. */
export async function passaQuotaInContabilita(supabase: SupabaseClient, bambinoId: string, eseguitoDa: string | null): Promise<EsitoPassaggio>
```

`passaQuotaInContabilita` logga: `logEvento('crm','info',{esito:'quota-in-contabilita', entita_id: bambinoId, pagamento_id, voce_nuova})`
sul successo, `warn` con `motivo` sul blocco, `error` sul guasto; tabella o funzione assente
(`PGRST202`, `PGRST205`, `42P01`, `42883`) → `non_installato` con un `warn`.

**Le route** (`requireCrm` → `assertSchedaInScope(supabase, user, id)` → il bambino deve avere
`scheda_id = id` e la stessa `scuola_id`, letta con `.eq('scuola_id', scheda.scuola_id)` nella stessa query):

- `PUT …/quota`, corpo `z.object({ importo: z.number().positive().multipleOf(0.01).max(100000), giorno: zDataYMD.nullish(), metodo: z.enum(QUOTA_METODI) })`:
  - giorno vuoto = oggi a Roma (`dataCivile(new Date())`); giorno dopo oggi → `422 QUOTA_GIORNO_FUTURO`;
  - `annoDellaQuota(bambino.anno_ingresso)` nullo → `422 QUOTA_ANNO_MANCANTE`;
  - contanti: si legge l'ultima `cassa_chiusure` della sede
    (`.eq('scuola_id', sede).order('eseguita_il', { ascending: false }).limit(1)`);
    `giornoContantiAmmesso` falso → `409 QUOTA_CASSA_CHIUSA` con `{ giornoProposto: oggi }`;
  - poi `rpc('crm_quota_segna', …)`. `in_contabilita` → `409 QUOTA_GIA_IN_CONTABILITA`; `non_trovato` → 404;
  - `passaggio.esito === 'ok'` con un incasso → la notifica `pagamento_registrato` come in
    `incassi/route.ts:259-275` (il bambino era già alunno: spec §5.2, «notifiche normali»);
  - risposta `200 { data: { stato, passaggio } }`.
- `DELETE …/quota` → `rpc('crm_quota_togli')`; `in_contabilita` → `409 QUOTA_GIA_IN_CONTABILITA`. È anche
  l'azione «È lo stesso pagamento» della spec §5.5.
- `POST …/quota/riprova` → `passaQuotaInContabilita(supabase, bambinoId, user.id)`; risponde con l'esito. Non
  manda notifiche: è un aggancio fatto dopo.

Codici nuovi in `CODICI_ERRORE` e nelle traduzioni: `QUOTA_GIORNO_FUTURO`, `QUOTA_ANNO_MANCANTE`,
`QUOTA_CASSA_CHIUSA`, `QUOTA_GIA_IN_CONTABILITA`.

- [ ] **Passo 1: test della logica pura** — `__tests__/lib/crm/quota.test.ts`:

```ts
expect(annoDellaQuota('in_corso', new Date('2026-10-31T10:00:00Z'))).toBe(2026)
expect(annoDellaQuota('prossimo', new Date('2026-10-31T10:00:00Z'))).toBe(2027)
expect(annoDellaQuota('in_corso', new Date('2026-07-15T10:00:00Z'))).toBe(2025)   // prima di agosto
expect(annoDellaQuota('non_indicato')).toBeNull()
expect(etichettaAnno(2027)).toBe('2027/28'); expect(etichettaAnno(2099)).toBe('2099/00')
expect(competenzaDellaQuota(2027)).toBe('2027-09-01')
expect(metodoIncasso('carta')).toBe('pos')
expect(giornoContantiAmmesso('2026-10-30', '2026-10-29T17:00:00Z', '2026-10-31')).toBe(true)
expect(giornoContantiAmmesso('2026-10-29', '2026-10-29T17:00:00Z', '2026-10-31')).toBe(false)
expect(giornoContantiAmmesso('2026-10-31', '2026-10-31T16:00:00Z', '2026-10-31')).toBe(true)  // oggi, dopo la chiusura
expect(giornoContantiAmmesso('2026-10-20', null, '2026-10-31')).toBe(true)
expect(esitoPassaggioDa({ esito: 'bloccata', motivo: 'gia_pagata' })).toEqual({ esito: 'bloccata', motivo: 'gia_pagata' })
expect(esitoPassaggioDa({ esito: 'boh' })).toEqual({ esito: 'errore' })
```

`passaQuotaInContabilita`: con `rpc` che restituisce `{ error: { code: 'PGRST202' } }` → `non_installato`;
con `rpc` che lancia → `errore` e nessuna eccezione esce.

- [ ] **Passo 2: test delle route** — `__tests__/api/crm-quota.test.ts`, sul modello di
  `__tests__/api/crm-schede.test.ts`:

```ts
it('segna 150 € in contanti: chiama crm_quota_segna con anno 2027 e giorno di oggi a Roma', …)
it('rifiuta importo 0, negativo e 150.555 con 400', …)
it('rifiuta il giorno di domani con 422 QUOTA_GIORNO_FUTURO', …)
it('alle 23:30 UTC del 31/10 accetta il giorno 2026-11-01 (a Roma è già oggi)', …)   // vi.setSystemTime
it('anno di ingresso non indicato: 422 QUOTA_ANNO_MANCANTE', …)
it('contanti su un giorno già chiuso: 409 QUOTA_CASSA_CHIUSA con giornoProposto', …)
it('bambino di un\'altra sede: 404 e nessuna rpc', …)
it('quota già in contabilità: PUT e DELETE rispondono 409 QUOTA_GIA_IN_CONTABILITA', …)
it('bambino già alunno, contanti: notifica pagamento_registrato una volta', …)
it('bambino già alunno, bonifico: nessuna notifica', …)
it('tabelle assenti: 503 CRM_NON_INSTALLATO', …)
it('riprova: restituisce l\'esito di crm_quota_passa e non notifica', …)
it('il PATCH del bambino con solo { quotaSaldata: true } non scrive niente su crm_bambini', …)
```

- [ ] **Passo 3: lanciali e guardali fallire** — `npx vitest run __tests__/lib/crm/quota.test.ts __tests__/api/crm-quota.test.ts`.
- [ ] **Passo 4: implementa** `quota.ts` e le route.
- [ ] **Passo 5: verifica** — i due file verdi, più `__tests__/api/crm-schede.test.ts`,
  `__tests__/api/zod-coverage.test.ts`, `__tests__/architecture/logging-coverage.test.ts`,
  `__tests__/architecture/crm-gate-requirecrm.test.ts`, `__tests__/architecture/errori-con-codice.test.ts`.
- [ ] **Passo 6: commit** — `git commit -m "CRM: la quota d'iscrizione con importo, metodo e giorno"`

---

### Compito 4: l'aggancio all'alunno (import, domanda già importata, a mano)

**File:**
- Crea: `src/lib/crm/aggancio-alunno.ts`, `__tests__/lib/crm/aggancio-alunno.test.ts`
- Crea: `src/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/alunno/route.ts` (`PUT`, `DELETE`)
- Crea: `src/app/api/admin/crm/alunni/route.ts` (`GET`, ricerca)
- Modifica: `src/lib/iscrizioni/import/esegui.ts` (ciclo a 511–524, e dopo `chiudi()` a 580 e a 594)
- Modifica: `src/lib/crm/collegamento.ts` (dopo il collegamento riuscito in `eseguiCollegamento` e in
  `collegaAMano`)
- Modifica: `src/lib/ui/esito-fetch.ts`, `messages/{it,en}/shared.json`
- Test: `__tests__/api/crm-alunno.test.ts`, `__tests__/api/iscrizioni-import-crm-quota.test.ts` (sul
  modello di `__tests__/api/iscrizioni-import-tetto.test.ts`), `__tests__/lib/crm/collegamento.test.ts`

**Interfacce:**
- Usa: `crm_aggancia_alunno` (Compito 1), `EsitoPassaggio` ed `esitoPassaggioDa` (Compito 3), i piccoli
  attrezzi di `collegamento.ts` (`TABELLA_ASSENTE`, `paroleDelNome`: esportarla se serve).
- Produce (`src/lib/crm/aggancio-alunno.ts`):

```ts
export type EsitoAggancio =
  | { esito: 'ok'; collegato: boolean; passaggio: EsitoPassaggio | null }
  | { esito: 'non_trovato' | 'sede_diversa' | 'gia_collegato_altro' | 'alunno_gia_collegato' | 'non_installato' | 'errore' }
/** Chiama crm_aggancia_alunno. NON LANCIA MAI. */
export async function agganciaAlunno(supabase: SupabaseClient, bambinoId: string, alunnoId: string, eseguitoDa: string | null): Promise<EsitoAggancio>
/** Dall'import: per ogni figlio, il bambino del CRM con (domanda_id, domanda_figlio) e quella sede. NON LANCIA MAI. */
export async function agganciaDaImport(supabase: SupabaseClient, d: { domandaId: string; scuolaId: string; figli: { figlio: number; alunnoId: string }[] }): Promise<{ esito: 'fatto'; agganciati: number } | { esito: 'non_installato' | 'errore' }>
/** Domanda già importata: l'unico alunno di alunni_creati con la stessa sede, nascita e nome. null se nessuno o più d'uno. */
export async function alunnoDaDomandaImportata(supabase: SupabaseClient, b: { domandaId: string; scuolaId: string; nome: string | null; dataNascita: string | null }): Promise<string | null>
```

Regole:
- `agganciaDaImport` salta i bambini con `alunno_id` già valorizzato. Una riga di log per esito
  (`logEvento('crm','info',{esito:'aggancio-import', entita_id: domandaId, n})`).
- `alunnoDaDomandaImportata` legge **gli alunni**, mai la domanda (regola 1 di `collegamento.ts`):
  `iscrizioni_import_esiti` per `submission_id` + `scuola_id`, poi `alunni` con `.in('id', alunni_creati)` e
  `.eq('scuola_id', scuolaId)`. Tiene chi ha la stessa `data_nascita` (se il bambino del CRM ce l'ha) e una
  parola di tre lettere del nome in comune (`paroleDelNome`). Senza `data_nascita` nel CRM serve il nome.
  Più di uno → `null`.
- In `esegui.ts`, accanto a `alunnoPerNome` nasce `const figliAlunni: { figlio: number; alunnoId: string }[] = []`
  (si riempie con `{ figlio: ass.indice, alunnoId: esito.id }`). Dopo **ognuna** delle due chiamate
  `await chiudi(…)` si aggiunge `await agganciaDaImport(supabase, { domandaId: domanda.id, scuolaId, figli: figliAlunni })`.
  Il valore restituito non cambia l'esito dell'import.
- In `collegamento.ts`, dopo ogni collegamento riuscito di un bambino a una domanda (automatico e a mano):
  `alunnoDaDomandaImportata` e, se restituisce un id, `agganciaAlunno(…, eseguitoDa)` (`null` nel
  collegamento automatico). Nessun cambiamento all'esito del collegamento.

**Le route:**
- `PUT …/alunno`, corpo `{ alunnoId: zUuid }`: `requireCrm` → `assertSchedaInScope` → bambino della scheda →
  `agganciaAlunno`. Esiti: `ok` → 200 con `passaggio`; `sede_diversa` → `422 ALUNNO_NON_DELLA_SEDE`;
  `gia_collegato_altro` e `alunno_gia_collegato` → `409 ALUNNO_GIA_COLLEGATO`; `non_installato` → 503;
  `errore` → 500.
- `DELETE …/alunno`:
  `update crm_bambini set alunno_id = null, alunno_collegato_il = null where id = … and scuola_id = … and quota_stato is distinct from 'in_contabilita'`
  (con `.select('id')`). Zero righe con la quota in contabilità → `409 QUOTA_GIA_IN_CONTABILITA`. Evento
  `alunno_scollegato`.
- `GET /api/admin/crm/alunni?scuolaId&q` (`q` almeno 2 caratteri): `assertSedeInScope`, poi `alunni` con
  `.eq('scuola_id', scuolaId)` e `.or('nome.ilike.%q%,cognome.ilike.%q%')`, con `q` ripulito da `%`, `,`,
  `(` e `)`. `limit(20)`; restituisce `id, nome, cognome, data_nascita`. Nessun nome nei log.

Codici nuovi: `ALUNNO_NON_DELLA_SEDE`, `ALUNNO_GIA_COLLEGATO`.

- [ ] **Passo 1: test della libreria** — `aggancio-alunno.test.ts`:

```ts
it('agganciaDaImport: con crm_bambini assente torna non_installato e non lancia', …)
it('agganciaDaImport: con rpc che lancia torna errore e non lancia', …)
it('agganciaDaImport: salta il bambino già collegato e aggancia l\'altro', …)   // rpc chiamata 1 volta
it('alunnoDaDomandaImportata: un solo alunno con stessa nascita e nome → il suo id', …)
it('alunnoDaDomandaImportata: due gemelli con la stessa nascita e nomi diversi → quello col nome giusto', …)
it('alunnoDaDomandaImportata: alunno di un\'altra sede → null', …)
it('alunnoDaDomandaImportata: nessun esito di import → null', …)
```

- [ ] **Passo 2: test dell'import** — `iscrizioni-import-crm-quota.test.ts`:

```ts
it('domanda importata: chiama agganciaDaImport con { figlio: indice, alunnoId } dopo chiudi()', …)
it('agganciaDaImport che lancia: l\'import finisce lo stesso con esito inviata', …)   // vi.mock di aggancio-alunno con mockRejectedValue
it('domanda fallita prima di chiudi(): agganciaDaImport non è mai chiamata', …)
```

- [ ] **Passo 3: test delle route** — `crm-alunno.test.ts`:

```ts
it('collega un alunno della sede e restituisce il passaggio della quota', …)
it('alunno di un\'altra sede: 422 ALUNNO_NON_DELLA_SEDE', …)
it('23505 / alunno_gia_collegato: 409 ALUNNO_GIA_COLLEGATO, non 500', …)     // Review Focus 2
it('scollega: con la quota in contabilità 409 QUOTA_GIA_IN_CONTABILITA', …)
it('ricerca: q di 1 carattere → 400; filtra per sede nella stessa query', …)
```

E in `collegamento.test.ts`: dopo un collegamento a mano riuscito su una domanda già importata,
`agganciaAlunno` è chiamata con l'alunno trovato; se la ricerca restituisce `null` non è chiamata.

- [ ] **Passo 4: lanciali e guardali fallire.**
- [ ] **Passo 5: implementa.**
- [ ] **Passo 6: verifica** — i file sopra più `__tests__/api/iscrizioni-import-*.test.ts`,
  `__tests__/api/crm-collegamento.test.ts`, `__tests__/api/iscrizione-crm-aggancio.test.ts`,
  `__tests__/architecture`.
- [ ] **Passo 7: commit** — `git commit -m "CRM: il bambino si aggancia all'alunno all'import, alla domanda già importata e a mano"`

---

### Compito 5: la quota e l'alunno nella scheda

**File:**
- Crea: `src/components/features/crm/schede/QuotaIscrizione.tsx`, `CollegaAlunno.tsx`
- Modifica: `src/components/features/crm/schede/DettaglioScheda.tsx` (`CardBambino` a 511: via la
  casella e il campo data alle righe 519–520, 534–535, 643–669; etichette degli eventi a 909)
- Modifica: `messages/{it,en}/crmSchede.json`
- Modifica: la route che restituisce i bambini della scheda (`src/app/api/admin/crm/schede/[id]/route.ts`),
  se elenca le colonne: aggiungere quelle nuove
- Test: `__tests__/components/crm/quota-iscrizione.test.tsx`, `__tests__/components/crm/schede.test.tsx`

**Interfacce:**
- Usa: `PUT/DELETE …/quota`, `POST …/quota/riprova` (Compito 3), `PUT/DELETE …/alunno` e
  `GET /api/admin/crm/alunni` (Compito 4), `etichettaAnno`, `annoDellaQuota` (Compito 3).
- Produce: `QuotaIscrizione({ schedaId, bambino, onCambiata }: { schedaId: string; bambino: BambinoRow; onCambiata: () => void })`
  e `CollegaAlunno({ schedaId, bambino, scuolaId, onCambiata })`.

**Cosa mostra `QuotaIscrizione`**, per stato:
- nessuna quota → bottone «Segna la quota d'iscrizione»;
- `senza_importo` → «Quota segnata senza importo»: completa;
- `in_attesa` → importo, metodo, giorno, anno, e «in attesa dell'alunno», oppure, se `alunno_id` c'è,
  «in attesa del passaggio in contabilità» con il bottone «Riprova». Azioni: correggi, togli;
- `bloccata` → il motivo tradotto (`quotaBlocco_<motivo>`), «Riprova», e per `gia_pagata` anche «È lo stesso
  pagamento» (chiama `DELETE`);
- `in_contabilita` → sola lettura, collegamento a `/admin/pagamenti?vista=scadenzario`; per un bonifico non
  ancora pagato «in contabilità, in attesa del bonifico».

Il modulo: importo (testo, accetta la virgola: `Number(valore.replace(',', '.'))`, al massimo due decimali),
giorno (`DateField`, vuoto = oggi, `max` = oggi), metodo (contanti · carta (POS) · bonifico). L'anno si
legge e non si sceglie («Anno scolastico 2027/28»). Con `non_indicato` il modulo dice «Indica prima l'anno
di ingresso» e il bottone resta spento. Un `409 QUOTA_CASSA_CHIUSA` propone il giorno di oggi nel campo.
Durante l'invio il bottone è spento.

**Etichette degli eventi:**
- `quota_segnata`: con `dati.importo` → `eventoQuotaSegnata` («Quota di {importo} € segnata»);
  con `dati.saldata === false` (eventi vecchi) → `eventoQuotaTolta`; altrimenti `eventoQuotaSaldata`;
- nuove: `eventoQuotaCorretta`, `eventoQuotaInContabilita`, `eventoAlunnoCollegato`,
  `eventoAlunnoScollegato`; `quota_tolta` → `eventoQuotaTolta`.

- [ ] **Passo 1: test del componente** — `quota-iscrizione.test.tsx`:

```ts
it('con «150,50» manda importo 150.5 e metodo contanti', …)
it('rifiuta «150,555» e «0» senza chiamare la rete', …)
it('anno di ingresso non indicato: bottone spento e messaggio', …)
it('mentre l\'invio è in volo il bottone è disabilitato (un secondo clic non parte)', …)   // Review Focus 1: fetch chiamata 1 volta
it('409 QUOTA_CASSA_CHIUSA mette oggi nel campo del giorno', …)
it('bloccata gia_pagata mostra «È lo stesso pagamento» e chiama DELETE', …)
it('in contabilità: nessun campo modificabile, collegamento allo scadenzario', …)
```

Nelle prove che aspettano il caricamento si aspetta la **presenza** di un testo, mai un'assenza.

- [ ] **Passo 2: test della scheda** — in `schede.test.tsx`, la vecchia casella «Quota saldata» non c'è più
  e la scheda mostra `QuotaIscrizione` e `CollegaAlunno` per ogni bambino.
- [ ] **Passo 3: lanciali e guardali fallire.**
- [ ] **Passo 4: implementa** — componenti, chiavi i18n in it/en, rimozione della vecchia casella. Togli
  `quota_saldata` da `BambinoRow` se il Compito 1 l'aveva lasciata facoltativa.
- [ ] **Passo 5: verifica** — `npx vitest run __tests__/components/crm` e `npx tsc --noEmit` verdi.
- [ ] **Passo 6: commit** — `git commit -m "CRM: la quota d'iscrizione e l'alunno nella scheda"`

---

### Compito 6: la lista «Quote dal CRM» in contabilità

**File:**
- Crea: `src/app/api/admin/crm/quote/route.ts` (`GET`)
- Crea: `src/components/features/admin/pagamenti/QuoteCrmPanel.tsx`
- Modifica: `src/components/features/admin/pagamenti/ContabilitaNav.tsx` (`VistaContabilita` e
  `VISTE_CONTABILITA`: voce `quote`), `src/app/(dashboard)/admin/pagamenti/page.tsx` (righe 199–214),
  `messages/{it,en}/adminContabilita.json` (`cnav_quote` e i testi del pannello)
- Test: `__tests__/api/crm-quote.test.ts`, `__tests__/components/quote-crm-panel.test.tsx`,
  `__tests__/components/ContabilitaNav.test.tsx`

**Interfacce:**
- Produce: `GET /api/admin/crm/quote?scuolaId` (facoltativo; senza, tutte le sedi attive dell'utente con
  `resolveScuoleAttive`). Risposta:
  `{ data: QuotaInAttesa[] }` con
  `QuotaInAttesa = { bambinoId; schedaId; scuolaId; nome: string | null; anno: number | null; importo: number | null; metodo: MetodoQuota | null; giorno: string | null; giorniAttesa: number | null; stato: 'senza_importo' | 'in_attesa' | 'bloccata'; motivo: MotivoBloccoQuota | null; alunnoCollegato: boolean }`.
  La lettura è su `crm_bambini` con `.in('scuola_id', sedi).in('quota_stato', ['senza_importo','in_attesa','bloccata'])`,
  ordinata per `quota_saldata_il`. `giorniAttesa` = giorni civili da `quota_saldata_il` a oggi (Roma).
- `QuoteCrmPanel({ userId, scuolaId }: { userId: string; scuolaId: string | null })`: tabella con bambino
  (collegamento a `/admin/crm?scheda=<schedaId>`: verificare in `CrmShell.tsx` il parametro che apre il
  dettaglio e usare quello), anno, importo, metodo, giorno, giorni di attesa, motivo. «Riprova» chiama
  `POST …/quota/riprova` per le righe con alunno collegato. `403` → «Riservato alla segreteria»; `503` →
  «Il CRM non è disponibile su questo ambiente»; lista vuota → «Nessuna quota in attesa».

- [ ] **Passo 1: test** —

```ts
// crm-quote.test.ts
it('elenca solo le quote in attesa, senza importo e bloccate delle sedi dell\'utente', …)
it('scuolaId di un\'altra sede: 403', …)
it('docente: 403 dal gate del CRM', …)
it('tabelle assenti: 503 CRM_NON_INSTALLATO', …)
it('calcola i giorni di attesa sul giorno civile di Roma', …)
// quote-crm-panel.test.tsx
it('mostra il motivo tradotto di una quota bloccata', …)
it('403: mostra «Riservato alla segreteria»', …)
it('Riprova chiama la route e ricarica la lista', …)
// ContabilitaNav.test.tsx
it('ha la vista quote', …)
```

- [ ] **Passo 2: lanciali e guardali fallire.**
- [ ] **Passo 3: implementa.**
- [ ] **Passo 4: verifica** — i tre file, più `__tests__/components/pagamenti-contabilita.test.tsx` e
  `__tests__/architecture`.
- [ ] **Passo 5: commit** — `git commit -m "Contabilità: la lista delle quote d'iscrizione in attesa dell'alunno"`

---

### Compito 7: le settimane e gli orari liberi

**File:**
- Crea: `src/lib/crm/settimane.ts`, `__tests__/lib/crm/settimane.test.ts`
- Modifica: `src/lib/crm/slot.ts` (`SlotLibero`, `valeIl`, `calcolaSlotLiberi`, `fuoriDisponibilita`)
- Modifica: `src/lib/crm/agenda.ts:128-158` (`visitaFuoriDisponibilita`)
- Modifica: `src/app/api/admin/crm/appuntamenti/route.ts` (GET: lettura delle fasce, `calcolaSlotLiberi`,
  `fuoriDisponibilita`)
- Riscrive: `src/app/api/admin/crm/disponibilita/route.ts` (`GET`, `PUT`); elimina
  `src/app/api/admin/crm/disponibilita/[id]/route.ts`
- Modifica: `src/lib/crm/tipi.ts` (via `DisponibilitaRow`), `src/lib/ui/esito-fetch.ts`, `messages/{it,en}/shared.json`
- Test: `__tests__/lib/crm/slot.test.ts`, `__tests__/api/crm-disponibilita.test.ts` (riscritto),
  `__tests__/api/crm-appuntamenti.test.ts`

**Interfacce prodotte** (`src/lib/crm/settimane.ts`):

```ts
export interface FasciaEffettiva { utenteId: string | null; settimana: string /* lunedì in cui vale */; giornoSettimana: number; oraInizio: string; oraFine: string; durataSlotMin: number }
export type OrigineSettimana = 'registrata' | 'ereditata' | 'nessuna'
export function lunediDi(ymd: string): string
export function settimanaModificabile(settimana: string, oggi: string): boolean          // settimana >= lunediDi(oggi)
/** La settimana registrata più recente non successiva a `settimana` per quel proprietario. */
export function settimanaDiRiferimento(settimane: SettimanaRow[], utenteId: string | null, settimana: string): SettimanaRow | null
export function fasceDellaSettimana(settimane: SettimanaRow[], fasce: FasciaRow[], settimana: string): { utenteId: string | null; origine: OrigineSettimana; daSettimana: string | null; fasce: FasciaEffettiva[] }[]
/** Le fasce di ogni settimana che tocca [dal, al]. Lancia sull'errore del database: il chiamante lo passa a rispostaErroreDb. */
export async function caricaFasceEffettive(supabase: SupabaseClient, scuolaId: string, dal: string, al: string): Promise<FasciaEffettiva[]>
```

`caricaFasceEffettive` fa due letture, entrambe con `.eq('scuola_id', scuolaId)`:
1. `crm_settimane` con `settimana <= lunediDi(al)`;
2. `crm_fasce` con `.in('settimana_id', <id delle settimane di riferimento di ogni settimana del periodo>)`.

Una fascia restituita vale solo nella settimana della sua `settimana` (`FasciaEffettiva.settimana` è la
settimana del periodo, non quella registrata da cui eredita).

**`slot.ts`:**
- `SlotLibero` diventa `{ utenteId: string | null; inizio: string; fine: string; personeLibere?: string[] }`.
- `calcolaSlotLiberi({ fasce: FasciaEffettiva[], persone: string[], indisponibilita, appuntamenti, dal, al, adesso })`.
  - Per una fascia della persona funziona come oggi.
  - Per una fascia della sede (`utenteId === null`), `personeLibere` = le `persone` che in quello slot non
    hanno assenze (né chiusure di sede) né visite `in_programma` sovrapposte, in ordine. Lo slot c'è solo
    se la lista non è vuota.
  - Chiave di unicità `sede|<inizio>` per la sede.
- `valeIl(f, ymd)`: `ymd` fra `f.settimana` e `addGiorni(f.settimana, 6)` e stesso giorno della settimana.
- `fuoriDisponibilita(a, fasce, indisponibilita)`: dentro se la visita sta per intero in una fascia della
  sua persona **o** della sede, in quel giorno.

**Le route della disponibilità** (`requireCrm`, `assertSedeInScope`):
- `GET ?scuolaId&settimana=YYYY-MM-DD` (qualunque giorno; si normalizza con `lunediDi`): legge
  `crm_settimane` e `crm_fasce` della sede e le persone (`personeDellaSede`). Risponde
  `{ data: { settimana, modificabile, proprietari: ReturnType<typeof fasceDellaSettimana> (sempre con la riga della sede e una per persona, anche vuote), persone }, io: { id, ruolo } }`.
  Le righe di persone non più della sede non si restituiscono.
- `PUT`, corpo
  `{ scuolaId: zUuid, settimana: zDataYMD, utenteId: zUuid.nullable(), fasce: z.array(z.object({ giornoSettimana: z.number().int().min(1).max(7), oraInizio: zOra, oraFine: zOra, durataSlotMin: z.number().int().min(15).max(240) })).max(50) }`
  (`zOra` = `HH:MM`; `oraFine > oraInizio` con `superRefine`). Con `utenteId` si chiama
  `assertPersonaInScope`; senza restrizione `puoToccareDi`: ogni persona della sede cambia la sede e i
  colleghi (spec §6.1). Poi `rpc('crm_salva_settimana', …)`. Esiti: `settimana_passata` →
  `409 SETTIMANA_PASSATA`; `fasce_sovrapposte` → `422 FASCE_SOVRAPPOSTE`; `settimana_non_valida` → 400.
  Log `logEvento('crm','info',{esito:'settimana-salvata', scuola_id, n: fasce.length})`.

Codici nuovi: `SETTIMANA_PASSATA`, `FASCE_SOVRAPPOSTE`.

- [ ] **Passo 1: test delle settimane** — `settimane.test.ts`:

```ts
expect(lunediDi('2026-10-25')).toBe('2026-10-19')    // domenica del cambio dell'ora: Review Focus 5
expect(lunediDi('2026-10-26')).toBe('2026-10-26')
expect(settimanaModificabile('2026-10-26', '2026-10-31')).toBe(true)
expect(settimanaModificabile('2026-10-19', '2026-10-31')).toBe(false)
// settimane registrate per la persona P: 2026-10-05 (lun 9–12) e 2026-10-19 (mer 14–17)
it('una settimana mai toccata è uguale alla precedente registrata', …)       // 2026-10-12 → lun 9–12, origine 'ereditata', daSettimana '2026-10-05'
it('la modifica di W si vede da W+1 e non da W−1', …)                       // 2026-10-26 → mer; 2026-10-12 → lun
it('una testata senza fasce è una settimana vuota, e vuote restano le successive', …)
it('prima della prima settimana registrata: origine nessuna', …)
it('sede e persona sono proprietari separati', …)
```

- [ ] **Passo 2: test degli slot** — in `slot.test.ts` le prove esistenti passano da `DisponibilitaRow` a
  `FasciaEffettiva`, e se ne aggiungono:

```ts
it('fascia della sede: libera finché una persona è libera, personeLibere solo quella', …)   // spec §8.7: A ha una visita alle 9:00, B è in ferie alle 9:45
it('fascia della sede: nessuna persona libera → nessuno slot', …)
it('persona e sede alla stessa ora: si vedono entrambi gli slot', …)
it('lunedì 26/10/2026 alle 9:00 di Roma è 08:00 UTC', …)                                     // Review Focus 5
it('una fascia vale solo nella sua settimana', …)
it('fuoriDisponibilita: una visita dentro una fascia della sede non è fuori', …)
```

- [ ] **Passo 3: test delle route** — `crm-disponibilita.test.ts` riscritto:

```ts
it('GET normalizza il giorno al lunedì e dà sede + persone, con origine e daSettimana', …)
it('GET: settimana passata → modificabile false', …)
it('PUT: settimana passata → 409 SETTIMANA_PASSATA', …)
it('PUT: una collega cambia le fasce di un\'altra persona della sede → 200', …)
it('PUT: persona di un\'altra sede → 422 PERSONA_NON_DELLA_SEDE', …)
it('PUT: oraFine prima di oraInizio → 400; fasce sovrapposte → 422 FASCE_SOVRAPPOSTE', …)
it('tabelle assenti → 503 CRM_NON_INSTALLATO', …)
```

In `crm-appuntamenti.test.ts`, il finto Supabase risponde su `crm_settimane`/`crm_fasce` invece che su
`crm_disponibilita`, e una prova controlla che uno slot della sede abbia `personeLibere`.

- [ ] **Passo 4: lanciali e guardali fallire.**
- [ ] **Passo 5: implementa.** Alla fine `grep -rn "crm_disponibilita\|DisponibilitaRow\|valida_dal" src __tests__`
  deve trovare **solo** `src/lib/personale/tracce-docente-voci.ts` (resta fino alla PR-B: vedi sotto) e i
  test della vecchia migrazione.
- [ ] **Passo 6: verifica** — `npx vitest run __tests__/lib/crm __tests__/api/crm-*.test.ts __tests__/architecture`.
- [ ] **Passo 7: commit** — `git commit -m "CRM: le disponibilità per settimana, della persona o della sede"`

---

### Compito 8: la settimana nella pagina delle disponibilità e nell'agenda

**File:**
- Crea: `src/components/features/crm/disponibilita/SettimanaDisponibilita.tsx`
- Modifica: `src/components/features/crm/disponibilita/DisponibilitaPersona.tsx` (la sezione «settimana
  tipo» e `DialogoFascia` lasciano il posto a `SettimanaDisponibilita`; assenze e chiusure restano)
- Modifica: `src/components/features/crm/agenda/AgendaSettimana.tsx` (colonna «Sede»: chiave
  `<giorno>|sede` alle righe 148–156; clic su uno slot della sede a 260)
- Modifica: `src/components/features/crm/agenda/FissaVisita.tsx` (prop nuova `personeProposte?: string[]`)
- Modifica: `messages/{it,en}/crmAgenda.json`
- Test: `__tests__/components/crm/disponibilita-settimana.test.tsx`, `__tests__/components/crm/agenda.test.tsx`

**Interfacce:**
- Usa: `GET`/`PUT /api/admin/crm/disponibilita` (Compito 7), `lunediDi` e `settimanaModificabile` (Compito 7).
- Produce: `SettimanaDisponibilita({ scuolaId }: { scuolaId: string })`; in `FissaVisita` la prop
  `personeProposte?: string[]`. Con `personeProposte` il selettore della persona elenca solo quelle; con una
  sola è già scelta; con più di una nessuna è preselezionata e la scelta è obbligatoria.

**La griglia:**
- intestazione con «‹», «Questa settimana», «›» e le date «dal … al …»;
- una riga «Sede» e una per persona, sette giorni (lun–dom), le fasce come «9:00–12:00»;
- accanto al nome «uguale alla settimana del 5 ottobre» (ereditata) o «modificata questa settimana»
  (registrata);
- settimane passate in sola lettura, con l'avviso «Le settimane passate non si modificano»;
- «Modifica» apre un dialogo con le fasce di quel proprietario per quella settimana: si aggiungono e si
  tolgono righe (giorno, dalle, alle, durata). «Salva» manda la `PUT` con tutte le righe. Il dialogo dice
  «Vale da questa settimana in poi, finché non la cambi di nuovo».

**Nell'agenda**, la colonna «Sede» compare prima delle persone quando nella settimana c'è almeno uno slot
della sede. Il clic su uno slot della sede apre `FissaVisita` con `inizioProposto` e
`personeProposte = slot.personeLibere`.

- [ ] **Passo 1: test** —

```ts
// disponibilita-settimana.test.tsx
it('mostra la riga della sede e una per persona, con «uguale alla settimana del …» per le ereditate', …)
it('‹ e › cambiano settimana e rileggono; «Questa settimana» torna a oggi', …)
it('settimana passata: nessun bottone Modifica', …)
it('Salva manda la PUT con tutte le fasce del proprietario e utenteId null per la sede', …)
it('409 SETTIMANA_PASSATA resta nel dialogo come alert', …)
// agenda.test.tsx
it('uno slot della sede apre FissaVisita che propone solo le persone libere', …)
it('con una sola persona libera è già scelta', …)
```

- [ ] **Passo 2: lanciali e guardali fallire.**
- [ ] **Passo 3: implementa.**
- [ ] **Passo 4: verifica** — `npx vitest run __tests__/components/crm` verde, poi controllo in pagina: dev
  server (preview `:3100`, che parla col DB di **produzione**: solo navigazione, nessun salvataggio) sulla
  sede Demo. Se le tabelle nuove non ci sono ancora, la pagina mostra il 503 pulito: va bene, è la prova
  della degradazione. La prova delle scritture si fa dopo il merge.
- [ ] **Passo 5: commit** — `git commit -m "CRM: la griglia della settimana e gli slot della sede nell'agenda"`

---

### Compito 9: PRD, gate, PR

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md` (voce di changelog in cima, nello stile di quella del CRM del
  31/10; stato del CRM nelle tabelle in cima)

- [ ] **Passo 1: PRD** — changelog datato 31/10/2026, branch `feat/crm-quota-disponibilita`. Contiene:
  - cosa cambia per la segreteria;
  - la regola dell'assorbimento in cassa;
  - le cinque funzioni;
  - le settimane;
  - le scelte dell'assistente di questo piano;
  - la PR-B da fare;
  - i video 8 e 11 da rigirare.
- [ ] **Passo 2: gate completo** — `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`
  (controlla la riga `Test Files N passed` e che i file nuovi ci siano), `npm run build`. Tutti verdi.
- [ ] **Passo 3: revisione dell'intero branch** con un revisore nuovo (spec + piano + diff).
- [ ] **Passo 4: PR** verso `main`, con descrizione in italiano. La descrizione dice:
  - che la migrazione la applica l'integrazione al merge, e il merge lo fa il titolare;
  - le `SELECT` di verifica da fare dopo (sotto);
  - la PR-B.
- [ ] **Passo 5: commit** — `git commit -m "PRD: la quota d'iscrizione in contabilità e le disponibilità per settimana"`

**Verifica dopo il merge** (solo `SELECT`, la fa la sessione dopo):

```sql
SELECT version FROM supabase_migrations.schema_migrations WHERE name LIKE '%crm_quota_e_settimane%';  -- una riga
SELECT count(*) FROM crm_settimane; SELECT count(*) FROM crm_fasce;                                   -- 1 e 1 (Demo)
SELECT quota_stato, count(*) FROM crm_bambini GROUP BY 1;                                              -- senza_importo: 1
SELECT to_regclass('public.crm_disponibilita');                                                        -- NULL
```

Poi `get_advisors`: 0 ERROR. Prova d'uso in sede Demo, scenari 1–4 e 7 del §8 della spec
(`docs/superpowers/specs/2026-10-31-crm-quota-e-disponibilita-design.md`): le funzioni SQL non girano in
vitest, quindi cassa che torna, bonifico, nessun doppione e competenza si provano lì, sul database vero.

## Per la PR-B (dopo il merge)

1. Rigenerare dalla produzione le fotografie toccate. Quali sono lo dice il commento del Compito 1, passo 5:
   migrazioni, indici unici, RLS, FK di sede, FK verso `utenti`, tabelle con `scuola_id`.
2. In `src/lib/personale/tracce-docente-voci.ts`:
   - la voce `crm_disponibilita.utente_id` (`tracciaDocenteCrmDisponibilita`) diventa
     `crm_settimane.utente_id`;
   - si aggiunge `crm_settimane.aggiornata_da`;
   - tutte con `azioneFk: 'blocca'`, le chiavi i18n tradotte.

   Fino ad allora la lettura di `crm_disponibilita` risponde «tabella assente», che `tracce-docente.ts`
   conta come zero senza errori.
3. Svuotare `MIGRAZIONI_ATTESE_AL_MERGE`.
4. Rigirare i video tutorial 8 (quota) e 11 (disponibilità) nella sede Demo.
