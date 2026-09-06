# Sanatoria delle liberatorie foto — misure del 2026-09-06

> **Documento di sola lettura.** Qui dentro non è stata eseguita nessuna scrittura: solo `SELECT`
> sul database di produzione. L'`UPDATE` è scritto per intero, con i suoi numeri, **perché il
> titolare lo veda prima che parta**. Mostrare non è chiedere, e non costa niente.

## Il fatto, in tre righe

`alunni.consenso_foto_sito` e `consenso_foto_social` sono `NOT NULL DEFAULT false`, `consenso_privacy`
è `DEFAULT false`: per il database il silenzio vale **no**. Il giro automatico di import
(`iscrizioni-import-invio`, `eseguiDomanda`) non nominava affatto quelle tre colonne, quindi ogni
bambino entrato di lì nasceva su tre `false` **che nessuna famiglia aveva detto**, anche quando la
domanda portava il sì. In più **86 domande approvate** sono anteriori al passo dei consensi e non
portano affatto le chiavi: per loro la regola decisa dal titolare il 2026-09-05 è «prova assente ⇒
consenso dato».

## La regola non si riscrive qui: è già nel codice

La sanatoria **deve dire esattamente ciò che dice il codice**, altrimenti nasce una seconda fonte di
verità — che è il difetto stesso da cui viene questo lavoro (una copia della regola c'era, l'altra
mancava, e per un mese e mezzo hanno divergito in silenzio).

| Dove | Cosa stabilisce |
|---|---|
| `src/lib/forms/enrollment-template.ts` → `CONSENSI_FOTO_CANALI` | il legame canale→colonna: `consenso_foto_galleria`→`consenso_privacy`, `consenso_foto_sito`→`consenso_foto_sito`, `consenso_foto_social`→`consenso_foto_social` |
| `src/lib/iscrizioni/consensi-foto.ts` → `consensiFotoDaProva` | la prova è `enrollment_submissions.consents_log.blocchi`, **mai** `data`: `data` è ciò che il client ha mandato, `blocchi` è ciò che il server ha verificato e congelato all'invio |
| idem → `BIANCO_VALE_CONSENSO = true` | `blocchi` vuoto o assente ⇒ tutti e tre a `true` (ribalta il `DEFAULT false` della colonna, ed è voluto) |
| idem | `blocchi` presente ⇒ canale per canale, `true` **solo** se esiste un blocco con quel `field_id` e `accepted === true` |

L'istruzione scritta più sotto è la traduzione letterale di queste quattro voci, e niente di più:
se un giorno la regola cambia, si cambia il codice e si riscrive di conseguenza questo file — mai il
contrario.

## Le misure — eseguite il 2026-09-06, e destinate a invecchiare

⚠️ **Non copiare questi numeri: rieseguire le query.** Il giro automatico gira **cinque volte al
giorno** (`cron.job` 24, `10,20,30,40,50 8 * * *`, `active = true`) e la correzione del codice
**non è ancora in produzione** — `src/lib/iscrizioni/consensi-foto.ts` risulta *untracked*, quindi
ogni nuovo bambino continua a nascere su tre `false`. **La sanatoria va eseguita DOPO il rilascio
della correzione**, altrimenti ripara un guasto che continua a riprodursi.

### M1 · Le domande e le loro prove

```sql
SELECT status, count(*) AS domande,
       count(*) FILTER (WHERE jsonb_array_length(COALESCE(consents_log->'blocchi','[]'::jsonb)) = 0) AS senza_prova,
       count(*) FILTER (WHERE jsonb_array_length(COALESCE(consents_log->'blocchi','[]'::jsonb)) > 0) AS con_prova
FROM enrollment_submissions GROUP BY status;
```

| status | domande | senza prova | con prova |
|---|--:|--:|--:|
| `approved` | 566 | **86** | 480 |
| `rejected` | 23 | 7 | 16 |
| `pending` | 6 | 0 | 6 |

Le 86 senza prova sono **esattamente** le 86 misurate il 2026-09-05: non ne arrivano altre, perché
il modulo pubblico raccoglie i consensi da luglio. Il resto invece si muove: il commento in
`consensi-foto.ts` contava, il 2026-09-05, **594 domande e 501 con prova**; oggi sono **595 e 502**.
Una domanda in più in un giorno — la misura che conta è quella di adesso, non questa tabella.

### M2 · Dentro le prove: zero parziali

```sql
SELECT b->>'field_id' AS field_id, count(*) AS blocchi,
       count(*) FILTER (WHERE (b->>'accepted')::boolean IS TRUE)  AS accettati,
       count(*) FILTER (WHERE (b->>'accepted')::boolean IS FALSE) AS rifiutati
FROM enrollment_submissions es
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) AS b
GROUP BY 1;
```

| field_id | blocchi | accettati | rifiutati |
|---|--:|--:|--:|
| `presa_visione_informativa` | 502 | 502 | 0 |
| `consenso_foto_galleria` | 502 | 496 | 6 |
| `consenso_foto_sito` | 502 | 468 | 34 |
| `consenso_foto_social` | 502 | 470 | 32 |

502 blocchi per **ognuno** dei quattro campi su 502 domande con prova: **nessuna prova parziale**.
È il fatto che rende lecito guardare la prova nel suo insieme (`blocchi.length === 0`) invece di
canale per canale, come fa `consensiFotoDaProva`.

### M3 · Come si lega un bambino alla sua domanda

Non c'è una chiave esterna: `alunnoDiRiferimento` cerca e crea per **codice fiscale del bambino**
(`data->'children'[]->>'codice_fiscale'` ↔ `alunni.codice_fiscale`, che è `character(16)`, quindi
`upper(btrim(…::text))` su entrambi i lati).

```sql
SELECT count(*) AS righe_bambino,
       count(DISTINCT upper(btrim(c->>'codice_fiscale'))) AS cf_distinti,
       count(DISTINCT upper(btrim(c->>'codice_fiscale'))) FILTER (
         WHERE upper(btrim(c->>'codice_fiscale')) IN (SELECT upper(btrim(a.codice_fiscale::text)) FROM alunni a)
       ) AS presenti_in_alunni
FROM enrollment_submissions es
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(es.data->'children','[]'::jsonb)) AS c
WHERE es.status = 'approved';

SELECT count(DISTINCT alunno_id) AS creati_dal_giro_automatico
FROM (SELECT unnest(alunni_creati) AS alunno_id FROM iscrizioni_import_esiti) x;
```

Misure del legame:

| | valore |
|---|--:|
| righe-bambino nelle domande `approved` | 642 (5 senza codice fiscale) |
| codici fiscali distinti | 601 |
| di cui presenti in `alunni` | **599** |
| `alunni` in totale | 638 |
| `alunni` creati dal giro automatico (`iscrizioni_import_esiti.alunni_creati`) | **474** |

### M4 · Il conto, colonna per colonna

```sql
-- il censimento: per ogni riga di `alunni`, il valore di oggi accanto alla volontà scritta
-- nella prova. `bambino_domanda` e `volonta` sono le stesse due CTE del Passo 1, più sotto.
WITH bambino_domanda AS ( /* … vedi Passo 1 … */ ), volonta AS ( /* … vedi Passo 1 … */ )
SELECT count(*)                                                                        AS con_domanda_approvata,
       count(*) FILTER (WHERE NOT a.consenso_foto_sito   AND     v.v_sito)              AS sito_da_correggere,
       count(*) FILTER (WHERE NOT a.consenso_foto_sito   AND NOT v.v_sito)              AS sito_ha_detto_no,
       count(*) FILTER (WHERE NOT a.consenso_foto_social AND     v.v_social)            AS social_da_correggere,
       count(*) FILTER (WHERE NOT a.consenso_foto_social AND NOT v.v_social)            AS social_ha_detto_no,
       count(*) FILTER (WHERE NOT COALESCE(a.consenso_privacy,false) AND     v.v_galleria) AS galleria_da_correggere,
       count(*) FILTER (WHERE NOT COALESCE(a.consenso_privacy,false) AND NOT v.v_galleria) AS galleria_ha_detto_no
FROM alunni a JOIN volonta v ON v.cf = upper(btrim(a.codice_fiscale::text));

-- lo stato attuale delle tre colonne, che è anche la fotografia del PRIMA
SELECT count(*) AS alunni,
       count(*) FILTER (WHERE consenso_foto_sito)               AS sito_true,
       count(*) FILTER (WHERE consenso_foto_social)             AS social_true,
       count(*) FILTER (WHERE COALESCE(consenso_privacy,false)) AS galleria_true
FROM alunni;
```

Prima della sanatoria, sui 638 `alunni`: `consenso_foto_sito` vero 601, `consenso_foto_social` vero
600, `consenso_privacy` vero 627. I `false` si scompongono così, **e il conto chiude esatto**:

| colonna | `false` in totale | ha detto **no** davvero | **da correggere** | senza alcuna domanda approvata |
|---|--:|--:|--:|--:|
| `consenso_foto_sito` | 37 | 32 | **1** | 4 |
| `consenso_foto_social` | 38 | 32 | **2** | 4 |
| `consenso_privacy` (galleria) | 11 | 6 | **2** | 3 |

- **Righe toccate: 2.** Celle toccate: **5**. Entrambe sono state create il **2026-09-05** dal giro
  automatico (sono fra i 474), in due sedi diverse, ed entrambe hanno oggi tutte e tre le colonne a
  `false`. Per una la prova dice sì su tutti e tre i canali, e salgono tutte e tre. Per l'altra la
  prova dice sì su galleria e social ma **no sul sito**: quella colonna **resta `false`**. È la
  dimostrazione che la guardia lavora sulla singola *cella*, non sulla riga — se lavorasse sulla
  riga, quel «no al sito» sarebbe stato ribaltato insieme agli altri due.
- **Righe con almeno un no esplicito: 35.** Non si toccano.
- **Righe a `true` mentre la prova dice no: 0** su tutte e tre le colonne. Nessun consenso è mai
  stato inventato: la sanatoria parte da una situazione pulita in quella direzione.

### M5 · Il gruppo delle 86 domande mute — oggi non ha nulla da correggere

```sql
WITH senza_prova AS (
  SELECT DISTINCT upper(btrim(c->>'codice_fiscale')) AS cf
  FROM enrollment_submissions es
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(es.data->'children','[]'::jsonb)) AS c
  WHERE es.status='approved'
    AND jsonb_array_length(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) = 0
    AND btrim(COALESCE(c->>'codice_fiscale','')) <> ''
), con_prova AS (
  SELECT DISTINCT upper(btrim(c->>'codice_fiscale')) AS cf
  FROM enrollment_submissions es
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(es.data->'children','[]'::jsonb)) AS c
  WHERE es.status='approved'
    AND jsonb_array_length(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) > 0
    AND btrim(COALESCE(c->>'codice_fiscale','')) <> ''
), solo_mute AS (
  SELECT cf FROM senza_prova WHERE cf NOT IN (SELECT cf FROM con_prova)
)
SELECT (SELECT count(*) FROM senza_prova) AS bambini_in_domande_mute,
       (SELECT count(*) FROM solo_mute)   AS solo_in_domande_mute,
       count(*)                           AS corrispondenti_in_alunni,
       count(*) FILTER (WHERE NOT a.consenso_foto_sito OR NOT a.consenso_foto_social
                           OR NOT COALESCE(a.consenso_privacy,false)) AS con_almeno_una_colonna_false
FROM alunni a WHERE upper(btrim(COALESCE(a.codice_fiscale::text,''))) IN (SELECT cf FROM solo_mute);
```

| | valore |
|---|--:|
| domande `approved` senza prova | 86 |
| bambini distinti in quelle domande | 91 |
| di cui presenti anche in una domanda **con** prova (fratelli reiscritti) | 5 |
| bambini distinti **solo** in domande mute | 86 |
| corrispondenti in `alunni` | 85 |
| **di cui con almeno una colonna a `false`** | **0** |

Il bianco vale sì, ma **oggi non c'è nessun bianco da sanare**: quelle 85 righe sono già a `true`,
perché il backfill della migrazione `20260801081502` è stato ripassato a mano. Il ramo
`BIANCO_VALE_CONSENSO` **resta nell'istruzione lo stesso**: non serve a queste 85, serve alle righe
che nasceranno domani da una domanda muta. Toglierlo perché «oggi conta zero» significherebbe
scrivere un'istruzione che dice una cosa diversa dal codice.

### M6 · Quando un bambino ha più di una domanda approvata

33 codici fiscali compaiono in **più di una** domanda approvata; per **2** di essi i verdetti delle
domande **discordano** su almeno un canale. Il codice vede una domanda alla volta e non ha una
regola per questo caso, quindi la sanatoria ne aggiunge una — ed è la più prudente possibile:
**`bool_and`, l'unanimità**. Basta un no, in una qualunque delle domande, perché la colonna resti
`false`. Le 2 righe discordanti hanno oggi `galleria = true`, `sito = false`, `social = false`, e
l'unanimità le lascia **intatte**.

Controllo del criterio, misurato: la politica alternativa «vince la domanda più recente» darebbe
**gli stessi identici numeri** (1 sito · 2 social · 2 galleria). La scelta non cambia niente oggi;
si prende l'unanimità perché è quella che non può mai concedere ciò che una famiglia ha negato.

```sql
-- quanti bambini hanno più domande, e per quanti i verdetti discordano
-- (a `bambino_domanda` serve qui una colonna in più: `es.id AS submission_id`)
WITH bambino_domanda AS ( /* … vedi Passo 1, con es.id AS submission_id in più … */ ),
     v AS (SELECT cf, submission_id,
                  CASE WHEN ha_prova THEN ok_galleria ELSE true END AS p,
                  CASE WHEN ha_prova THEN ok_sito     ELSE true END AS s,
                  CASE WHEN ha_prova THEN ok_social   ELSE true END AS o
           FROM bambino_domanda)
SELECT count(*)                                                             AS cf_distinti,
       count(*) FILTER (WHERE n_domande > 1)                                AS con_piu_domande,
       count(*) FILTER (WHERE n_p > 1 OR n_s > 1 OR n_o > 1)                AS con_verdetti_discordanti
FROM (SELECT cf, count(DISTINCT submission_id) AS n_domande,
             count(DISTINCT p) AS n_p, count(DISTINCT s) AS n_s, count(DISTINCT o) AS n_o
      FROM v GROUP BY cf) x;
```

### M7 · Chi non ha nessuna domanda approvata NON si tocca

39 righe di `alunni` non hanno alcuna domanda approvata col loro codice fiscale (23 non hanno
codice fiscale affatto). Di queste, 4 hanno almeno una colonna a `false`, e sono tutte in stato
`ritirato`, tutte **senza codice fiscale**, create a luglio e agosto 2026.

Per loro non esiste né una prova né un bianco: esiste un **non-so**. È la stessa distinzione che fa
`consensiFotoDellaDomanda`, che davanti a una lettura caduta restituisce `null` e **non scrive
nessuna colonna** — «una lettura caduta non è un bianco, è un non-so, e da un non-so non si inventa
il consenso a pubblicare la foto di un minore». Il `JOIN` dell'istruzione le esclude per
costruzione: senza domanda, nessuna riga da unire.

### M8 · Controprova: quanto pesa la guardia della volontà

```sql
-- la stessa selezione, ma con la guardia della volontà TOLTA
WITH cf_appr AS (
  SELECT DISTINCT upper(btrim(c->>'codice_fiscale')) AS cf
  FROM enrollment_submissions es
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(es.data->'children','[]'::jsonb)) AS c
  WHERE es.status='approved' AND btrim(COALESCE(c->>'codice_fiscale','')) <> ''
)
SELECT count(*) AS righe_toccate_SENZA_guardia,
       count(*) FILTER (WHERE NOT COALESCE(a.consenso_privacy,false)) AS celle_galleria,
       count(*) FILTER (WHERE NOT a.consenso_foto_sito)               AS celle_sito,
       count(*) FILTER (WHERE NOT a.consenso_foto_social)             AS celle_social
FROM alunni a
WHERE upper(btrim(COALESCE(a.codice_fiscale::text,''))) IN (SELECT cf FROM cf_appr)
  AND (NOT COALESCE(a.consenso_privacy,false) OR NOT a.consenso_foto_sito OR NOT a.consenso_foto_social);
```

La stessa istruzione **senza** le condizioni `v_*` — cioè «metti a `true` tutti i `false` di chi ha
una domanda approvata» — toccherebbe **36 righe e 75 celle** (8 galleria · 33 sito · 34 social)
invece di 2 righe e 5 celle: pubblicherebbe le foto di **32 bambini sul sito e 32 sui social**
contro il no scritto delle loro famiglie, e 6 in galleria. La guardia non è una cintura di
sicurezza: è **il 93% dell'istruzione**.

### M9 · Cosa NON si muove, per costruzione

- **Nessun trigger scatta.** L'unico trigger su `alunni` è `trg_alunni_sync_section`, dichiarato
  `BEFORE INSERT OR UPDATE` **`OF classe_sezione, section_id, scuola_id`**:
  l'istruzione non nomina nessuna di quelle tre colonne, quindi non si sveglia. (Non è un dettaglio: quel trigger, sul
  cambio di sede, riaggancia il bambino alla sezione omonima della sede nuova.)
- **Le due sedi fittizie della CI** (`e2e00000-0000-4000-8000-00000000d000`, 25 righe, e
  `e2e00000-0000-4000-8000-000000000001`, 4 righe) hanno **zero** colonne a `false`: non entrano
  nella selezione. Nessuna clausola aggiunta per escluderle — una guardia che non ha mai niente da
  fermare è decorazione, e questa misura la sostituisce.
- **Includere anche le domande `rejected` e `pending`** darebbe **gli stessi numeri** (1 · 2 · 2).
  Si resta su `status = 'approved'` perché è l'unico stato che il giro automatico esegue: stesso
  perimetro del codice, non uno più largo che oggi combacia per caso.

---

## L'istruzione, per intero

### Passo 1 — l'anteprima (una `SELECT`, e la sua `WHERE` è **identica** a quella dell'`UPDATE`)

```sql
WITH bambino_domanda AS (
  SELECT upper(btrim(c->>'codice_fiscale')) AS cf,
         jsonb_array_length(COALESCE(es.consents_log->'blocchi', '[]'::jsonb)) > 0 AS ha_prova,
         EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) b
                  WHERE b->>'field_id' = 'consenso_foto_galleria' AND (b->>'accepted')::boolean IS TRUE) AS ok_galleria,
         EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) b
                  WHERE b->>'field_id' = 'consenso_foto_sito'     AND (b->>'accepted')::boolean IS TRUE) AS ok_sito,
         EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) b
                  WHERE b->>'field_id' = 'consenso_foto_social'   AND (b->>'accepted')::boolean IS TRUE) AS ok_social
  FROM enrollment_submissions es
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(es.data->'children', '[]'::jsonb)) AS c
  WHERE es.status = 'approved'
    AND btrim(COALESCE(c->>'codice_fiscale','')) <> ''
), volonta AS (
  -- BIANCO_VALE_CONSENSO: prova assente ⇒ true. Prova presente ⇒ ciò che dice.
  -- bool_and = unanimità fra le domande dello stesso bambino: basta un no e resta false.
  SELECT cf,
         bool_and(CASE WHEN ha_prova THEN ok_galleria ELSE true END) AS v_galleria,
         bool_and(CASE WHEN ha_prova THEN ok_sito     ELSE true END) AS v_sito,
         bool_and(CASE WHEN ha_prova THEN ok_social   ELSE true END) AS v_social
  FROM bambino_domanda
  GROUP BY cf
)
SELECT count(*) AS righe_toccate,
       count(*) FILTER (WHERE NOT COALESCE(a.consenso_privacy,false) AND v.v_galleria) AS celle_galleria,
       count(*) FILTER (WHERE NOT a.consenso_foto_sito              AND v.v_sito)      AS celle_sito,
       count(*) FILTER (WHERE NOT a.consenso_foto_social            AND v.v_social)    AS celle_social
FROM alunni a
JOIN volonta v ON v.cf = upper(btrim(a.codice_fiscale::text))
WHERE (NOT COALESCE(a.consenso_privacy,false) AND v.v_galleria)
   OR (NOT a.consenso_foto_sito              AND v.v_sito)
   OR (NOT a.consenso_foto_social            AND v.v_social);
```

**Eseguita il 2026-09-06:** `righe_toccate = 2` · `celle_galleria = 2` · `celle_sito = 1` ·
`celle_social = 2`. **Se il numero è cambiato, sono passati dei giorni: rileggere le misure, non
questo paragrafo.**

### Passo 2 — l'`UPDATE`

```sql
WITH bambino_domanda AS (
  SELECT upper(btrim(c->>'codice_fiscale')) AS cf,
         jsonb_array_length(COALESCE(es.consents_log->'blocchi', '[]'::jsonb)) > 0 AS ha_prova,
         EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) b
                  WHERE b->>'field_id' = 'consenso_foto_galleria' AND (b->>'accepted')::boolean IS TRUE) AS ok_galleria,
         EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) b
                  WHERE b->>'field_id' = 'consenso_foto_sito'     AND (b->>'accepted')::boolean IS TRUE) AS ok_sito,
         EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(es.consents_log->'blocchi','[]'::jsonb)) b
                  WHERE b->>'field_id' = 'consenso_foto_social'   AND (b->>'accepted')::boolean IS TRUE) AS ok_social
  FROM enrollment_submissions es
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(es.data->'children', '[]'::jsonb)) AS c
  WHERE es.status = 'approved'
    AND btrim(COALESCE(c->>'codice_fiscale','')) <> ''
), volonta AS (
  SELECT cf,
         bool_and(CASE WHEN ha_prova THEN ok_galleria ELSE true END) AS v_galleria,
         bool_and(CASE WHEN ha_prova THEN ok_sito     ELSE true END) AS v_sito,
         bool_and(CASE WHEN ha_prova THEN ok_social   ELSE true END) AS v_social
  FROM bambino_domanda
  GROUP BY cf
), prima AS (
  -- la fotografia del PRIMA, che esce dal RETURNING: è il materiale del ritorno indietro
  SELECT id, COALESCE(consenso_privacy,false) AS p0, consenso_foto_sito AS s0, consenso_foto_social AS o0
  FROM alunni
)
UPDATE alunni a
   SET consenso_privacy     = COALESCE(a.consenso_privacy,false) OR v.v_galleria,
       consenso_foto_sito   = a.consenso_foto_sito               OR v.v_sito,
       consenso_foto_social = a.consenso_foto_social             OR v.v_social
  FROM volonta v, prima
 WHERE v.cf = upper(btrim(a.codice_fiscale::text))
   AND prima.id = a.id
   AND ( (NOT COALESCE(a.consenso_privacy,false) AND v.v_galleria)
      OR (NOT a.consenso_foto_sito              AND v.v_sito)
      OR (NOT a.consenso_foto_social            AND v.v_social) )
RETURNING a.id, prima.p0 AS galleria_prima, prima.s0 AS sito_prima, prima.o0 AS social_prima,
          a.consenso_privacy AS galleria_dopo, a.consenso_foto_sito AS sito_dopo, a.consenso_foto_social AS social_dopo;
```

Tre proprietà, e nessuna è affidata all'attenzione di chi la esegue:

1. **`OR`, mai un valore secco.** `x = x OR verdetto` può solo far salire un `false` a `true`:
   **non esiste un cammino che riporti un `true` a `false`**. Chi ha detto sì e chi ha detto no
   restano dove sono, per costruzione.
2. **`JOIN volonta`, non `LEFT JOIN`.** Chi non ha una domanda approvata non entra: nessun bianco
   inventato su un non-so (M7).
3. **La `WHERE` è la stessa dell'anteprima**, parola per parola. Il numero stampato da `UPDATE n`
   **deve** essere quello che l'anteprima ha appena mostrato. Se diverge, fermarsi.

⚠️ **Copiare l'output del `RETURNING` prima di chiudere la finestra**, e tenerlo **fuori dal
repository** (è un elenco di uuid di minori, e questo repo è pubblico). Senza quell'output il
ritorno indietro diventa impossibile — vedi l'ultima sezione.

### Passo 3 — la verifica DOPO

```sql
-- (a) IDEMPOTENZA: rieseguire l'ANTEPRIMA del Passo 1. Deve dare 0, 0, 0, 0.
-- (b) LO STESSO NUMERO, dal lato opposto: quante colonne sono salite.
SELECT count(*) FILTER (WHERE consenso_foto_sito)              AS sito_true,      -- 601 → atteso 602
       count(*) FILTER (WHERE consenso_foto_social)            AS social_true,    -- 600 → atteso 602
       count(*) FILTER (WHERE COALESCE(consenso_privacy,false)) AS galleria_true,  -- 627 → atteso 629
       count(*)                                                 AS alunni_totali   -- 638, invariato
FROM alunni;
```

```sql
-- (c) LA VERIFICA CHE CONTA: nessuno che ha detto no è stato calpestato.
--     Deve restituire 32 · 32 · 6 (invariati) e 0 · 0 · 0 sugli allarmi.
WITH bambino_domanda AS ( /* … identica al Passo 1 … */ ),
     volonta AS ( /* … identica al Passo 1 … */ )
SELECT count(*) FILTER (WHERE NOT v.v_sito)     AS no_sito,
       count(*) FILTER (WHERE NOT v.v_social)   AS no_social,
       count(*) FILTER (WHERE NOT v.v_galleria) AS no_galleria,
       count(*) FILTER (WHERE NOT v.v_sito     AND a.consenso_foto_sito)                AS ALLARME_sito,
       count(*) FILTER (WHERE NOT v.v_social   AND a.consenso_foto_social)              AS ALLARME_social,
       count(*) FILTER (WHERE NOT v.v_galleria AND COALESCE(a.consenso_privacy,false))  AS ALLARME_galleria
FROM alunni a JOIN volonta v ON v.cf = upper(btrim(a.codice_fiscale::text));
```

Prima dell'`UPDATE` questa query dà `32 · 32 · 6 · 0 · 0 · 0`. **Dopo deve dare gli stessi sei
numeri.** Un allarme diverso da zero significa che l'istruzione ha concesso un consenso negato:
tornare indietro subito.

## Come si torna indietro

L'elenco degli id **non sta in questo file, e non ci starà mai**: è anagrafica di minori e il
repository è pubblico. Si ricostruisce al momento, in uno dei due modi — **il primo va scelto prima
di eseguire, perché il secondo esiste solo se il primo è stato fatto**:

1. **Dal `RETURNING` dell'`UPDATE`** (raccomandato). L'istruzione del Passo 2 restituisce già
   `id` + i tre valori **prima** e **dopo**, riga per riga. Si incolla quell'output in un file
   fuori dal repository (per esempio `~/sanatoria-consensi-<data>.txt`) e il ritorno indietro è:

   Poiché la sanatoria è **monotona** (solo `false → true`), il ritorno indietro è esattamente
   «rimetti a `false` le celle che il `RETURNING` mostra come `prima = false`» — una istruzione per
   colonna, con **solo** gli id in cui quella colonna era `false`, così nessuna cella già `true`
   viene toccata:

   ```sql
   UPDATE alunni SET consenso_privacy     = false WHERE id IN (/* gli id con galleria_prima = false */);
   UPDATE alunni SET consenso_foto_sito   = false WHERE id IN (/* gli id con sito_prima     = false */);
   UPDATE alunni SET consenso_foto_social = false WHERE id IN (/* gli id con social_prima   = false */);
   ```

   Perché il `RETURNING` dice il vero sul «prima»: la CTE `prima` legge `alunni` nella **stessa
   istantanea** dell'`UPDATE`, quindi `galleria_prima`/`sito_prima`/`social_prima` sono i valori di
   prima della scrittura, non quelli appena scritti (che escono nelle tre colonne `_dopo`, accanto,
   proprio per poterli confrontare a occhio).

2. **Ricostruendo l'elenco PRIMA di eseguire.** La stessa anteprima del Passo 1, sostituendo i
   `count(*)` con `SELECT a.id, …`, dà le righe candidate. **Dopo** l'`UPDATE` quella stessa query
   non le trova più — sono diventate indistinguibili da tutte le altre già a `true` — quindi eseguirla
   dopo non ricostruisce niente. È il motivo per cui il punto 1 è il modo giusto.

**Non serve un backup della tabella.** L'istruzione tocca 2 righe e 5 celle booleane, e il
ripristino è l'elenco di quelle 5 celle. Un dump di `alunni` sarebbe una copia in più
dell'anagrafica di 638 minori, cioè un rischio maggiore del guasto da cui protegge.

## Prima di premere invio — la lista di controllo

- [ ] La correzione del codice (`src/lib/iscrizioni/consensi-foto.ts` e i suoi due chiamanti) è
      **in produzione**. Finché non lo è, il cron delle 8 rimette `false` su ogni nuovo bambino e
      la sanatoria va rifatta.
- [ ] L'anteprima del Passo 1 è stata **rieseguita adesso**, e il suo numero è quello che ci si
      aspetta di vedere in `UPDATE n`.
- [ ] L'output del `RETURNING` è stato salvato fuori dal repository.
- [ ] La verifica (c) dà gli stessi sei numeri di prima.

---

*Misure eseguite il 2026-09-06 sul database di produzione, in sola lettura. **Nessuna scrittura è
stata effettuata da questo lavoro.** I due blocchi SQL dell'istruzione sono stati verificati
estraendoli da QUESTO file, non riscrivendoli: l'anteprima del Passo 1 è stata eseguita così com'è
ed è tornata `2 · 2 · 1 · 2`; l'`UPDATE` del Passo 2 è passato per `EXPLAIN` — che pianifica senza
eseguire — e il piano risultante porta `Update on alunni a` con la `Join Filter` attesa. Un
documento che contiene un'istruzione mai vista analizzare è un documento che non è stato provato.*

*Nel documento non compaiono nomi, codici fiscali, email o altri dati personali: solo conteggi,
uuid di sedi e nomi di colonne.*
