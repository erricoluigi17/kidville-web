# Armadietto — ricollegare le richieste di rifornimento

**Data**: 2026-09-01 · **Stato**: approvato dal titolare in chat il 2026-09-01

## Perché esiste questo lavoro

Il monitoraggio della produzione del 2026-09-01 ha trovato **226 errori `PGRST205`** in 28 giorni su
due rotte — `/api/locker/requests` (195) e il cron `/api/notifiche/promemoria` (31) — tutti con lo
stesso messaggio: *«Could not find the table 'public.locker_requests' in the schema cache»*. L'ultimo
alle 14:59 dello stesso giorno.

La tabella non esiste, e **nessuna migrazione la crea**. Esiste solo in
`supabase/migrations_archive/20260503_armadietto_anagrafica.sql`, che non viene applicato.

### Cosa serviva davvero

`locker_requests` era la terza delle quattro tabelle del vecchio schema a saldo (`locker_catalog`,
`locker_inventory`, `locker_requests`, `locker_loads`). Teneva **lo stato del ciclo di
rifornimento**: `pending` → `acknowledged` → `fulfilled`, più `livello_alert` giallo/rosso, la
`quantita_residua` fotografata al momento dell'allarme e `reminder_inviato_il`, che garantiva *un
promemoria e uno solo*. La riempiva un trigger, `fn_decrement_locker_on_bagno()`, che a ogni evento
«bagno» scalava un pannolino e apriva la richiesta da sé.

Quello schema è stato **sostituito** da uno più semplice a due tabelle: `armadietto` (libro giornale
dei movimenti) e `locker_config` (catalogo per sezione). Il codice però è stato portato **a metà**:
`inventory` e `materials` usano le tabelle nuove, `requests` e la scansione del cron sono rimaste
sulle vecchie.

### Il PRD lo diceva già, e si contraddiceva

| riga | cosa dice |
|---|---|
| 23 | `armadietto` — «Schema creato, **non ancora popolato**» |
| 65 | **Armadietto — ✅ Operativo** |
| 14286 | «`/api/locker/requests` dava 500 perché la tabella **non è migrata su prod** → degrado a vuoto» |
| 14803 | «🔶 Resta: carico merci, lista spesa genitore, dashboard inadempienze, **reminder 07:00**» |

Era noto e fu chiuso come *degrado pulito* invece che come funzionalità mancante. Il degrado c'è ed è
corretto (`tabellaMancante` → `[]`), ed è esattamente il motivo per cui nessuno se n'è accorto: la
lista «Da portare a scuola» è condizionata a `length > 0` e resta invisibile.

## Cosa è vivo, misurato

Il modulo è **quasi tutto funzionante**. `armadietto` è un libro giornale di movimenti (`materiale`,
`quantita`, `date`, `portato`) e lo stock si ottiene sommando (`inventory/route.ts:127`). Su questo
girano già:

- `/api/locker/inventory` — scorte, carico, consumo;
- `/api/locker/materials` — catalogo su `locker_config`;
- `/api/locker/notify` — il genitore avvisa la scuola («Avvisa»);
- **lo scalo automatico del pannolino** — `api/diary/entries/route.ts:316`, per i bambini con
  `alunni.usa_pannolino`;
- le pagine genitore, docente, admin e le impostazioni materiali.

Manca **una sola direzione di comunicazione**: la scuola che dice al genitore *cosa portare*.
Esistono due meccanismi opposti e solo uno è vivo — `locker/notify` (genitore → scuola, funziona) e
`locker_requests` (scuola → genitore, morto). Il PRD descrive il secondo.

### Stato dei dati in produzione, 2026-09-01

| | |
|---|---|
| `armadietto` | 4 righe, 3 alunni, ultimo aggiornamento **13 luglio** |
| `locker_config` | **0 righe** |
| sezioni nido/infanzia nelle tre sedi | **25** (Giugliano 11, Cesa 8, Aversa 6) |

`locker_config` vuota **non è un guasto**: il modulo non è ancora in uso e i materiali li
aggiungeranno le maestre man mano. Il codice lo prevede già —
`api/locker/materials/route.ts:109` restituisce `MATERIALI_DEFAULT` (Pannolini 5/2, Salviette 4/2,
Crema 3/1, Cambio 2/1) quando la tabella è vuota.

## Difetti trovati durante l'analisi

- **`PATCH /api/locker/requests` è irraggiungibile dal genitore.** La pagina genitore
  (`parent/locker/page.tsx:192`) mostra il bottone «Preso in carico», ma la route è protetta da
  `requireDocente` (`requests/route.ts:168`) → **403**. Rotto a prescindere dalla tabella.
- **Soglie cablate nell'interfaccia**: `parent/locker/page.tsx:400` (`gialla = 5, rossa = 2`) e
  `LockerTodayCard.tsx:18-19` ignorano la configurazione.
- **`api/locker/catalog/route.ts`**: unica rotta su `locker_catalog`, **senza chiamanti**, **senza
  tolleranza** (500) e **propaga `error.message` di PostgREST** al chiamante (`:54`, `:100`).
- **`api/locker/materials` PATCH/DELETE fanno lo scope su `classe_sezione`** (testo, nullable)
  invece che su `section_id` (`:217-219`, `:249-251`), che dal 2026-07-30 è la chiave. Con quel
  campo a `null` **non c'è nessun controllo di scope** fra le tre sedi.
- **`InventoryCard.tsx`** non è importato da nessuno.

## Decisioni

1. **Ciclo di stato completo** — `aperta` → `presa_in_carico` → `evasa`. Serve sapere chi ha
   risposto e chi no: è il presupposto della «dashboard inadempienze» della riga 14803.
2. **Apertura e chiusura automatiche** — nasce alla soglia, si chiude quando il carico riporta lo
   stock sopra soglia. La maestra non fa gesti in più; il genitore conferma con «La porto».
3. **Nessun seed di `locker_config`** — resta vuota. Le soglie arrivano da `MATERIALI_DEFAULT`
   finché la segreteria non ne scrive di proprie, per un solo percorso di lettura.
4. **Logica alla scrittura + cron riconciliatore.** Scartato il trigger SQL: con `locker_config`
   vuota le soglie stanno nel codice TypeScript e un trigger dovrebbe duplicarle in SQL — due
   sorgenti di verità per la stessa regola, che è la lezione già pagata da questo repo.

## Architettura

### Tabella `armadietto_richieste`

Nome italiano, coerente con `armadietto`. **Non** si riusa `locker_requests`: in questo repo quel
nome significa «la tabella morta» in log, commenti e PRD.

```sql
CREATE TABLE IF NOT EXISTS public.armadietto_richieste (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id             uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  scuola_id             uuid NOT NULL REFERENCES public.schools(id),
  materiale             text NOT NULL,
  livello               text NOT NULL CHECK (livello IN ('giallo','rosso')),
  quantita_residua      integer NOT NULL DEFAULT 0,
  stato                 text NOT NULL DEFAULT 'aperta'
                          CHECK (stato IN ('aperta','presa_in_carico','evasa')),
  presa_in_carico_il    timestamptz,
  presa_in_carico_da    uuid,
  evasa_il              timestamptz,
  promemoria_inviato_il timestamptz,
  creato_il             timestamptz NOT NULL DEFAULT now(),
  aggiornato_il         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS armadietto_richieste_viva_uniq
  ON public.armadietto_richieste (alunno_id, materiale) WHERE stato <> 'evasa';
```

La guardia anti-doppione sta **nel database**, non in un `SELECT`-poi-`INSERT` che perde la corsa —
era il difetto del vecchio trigger. Le evase non vincolano nulla, così se lo stock ri-scende domani
se ne apre una nuova.

`materiale` è **testo, non una FK a `locker_config`**: quella tabella può legittimamente restare
vuota. Una FK legherebbe la funzione a righe che per scelta non esistono. È la stessa chiave che usa
già `armadietto.materiale`.

RLS accesa senza policy + revoke ad `anon`/`authenticated`, forma di
`20260804124245_tetto_frequenza_condiviso.sql:141-148`: service-role e gate applicativo, come tutto
il repo.

### Motore — `src/lib/armadietto/richieste.ts`

Un modulo, un compito. Tre funzioni:

- **`soglieMateriali(admin, sectionId)`** — `locker_config` per la sezione, ripiego su
  `MATERIALI_DEFAULT`. **La logica di ripiego si estrae qui** da `materials/route.ts:95-112` e
  la chiamano entrambi: la regola vive in un posto solo.
- **`riconciliaRichieste(admin, { alunnoId, materiale? })`** — ricalcola lo stock, confronta,
  apre / aggiorna / chiude.
- **`riconciliaTutto(admin)`** — la passata del cron su **ogni** coppia (alunno, materiale) con
  movimenti, non solo quelle mosse di recente: se la segreteria alza una soglia da 5 a 8, le
  richieste devono comparire il mattino dopo anche senza che nessuno si sia mosso.

Regole: apre a `stock <= livello_allerta` (`rosso` sotto `livello_emergenza`), chiude sopra la stessa
linea — nessuna zona morta; promuove giallo → rosso ma **non** declassa (un allarme dato non si
ritira); `ON CONFLICT DO UPDATE` sull'indice parziale per le scritture concorrenti.

Agganciata dopo il movimento in tre punti — `inventory` POST e PATCH, `diary/entries` — e **mai in
grado di farlo fallire**: il carico è il dato, la richiesta è la conseguenza. Un errore si logga
(`logErrore`, mai un `catch` muto) e non si propaga.

### Flusso

```
Marco usa l'ultimo pannolino
  → diary/entries scala lo stock a 2
  → riconciliaRichieste: 2 <= emergenza(2) → richiesta APERTA livello rosso
  → la maestra la vede subito

Cron 06:00 → riconciliaTutto → notifica al genitore, promemoria_inviato_il
  «Pannolini in esaurimento per Marco (2 pz rimasti)»

Genitore preme «La porto»
  → PATCH { id, alunno_id, stato: 'presa_in_carico' }  [requireParentOfStudent]
  → la maestra la vede presa in carico

Maestra registra carico +30
  → riconciliaRichieste: 32 > allerta(5) → richiesta EVASA
```

### Gate — si ripara il 403 separando i gesti

| gesto | chi | gate |
|---|---|---|
| `presa_in_carico` | genitore | `requireParentOfStudent(request, alunno_id)`, con `alunno_id` nel corpo accanto a `id`; poi si verifica che la riga sia davvero sua |
| `evasa` | scuola | `requireDocente` + `assertAlunnoInScope` |

`alunno_id` nel corpo è il pattern già dichiarato in uso nel repo (cinque casi, citati in
`requests/route.ts:166`) ed è l'unico che permette al gate di decidere.

### Tolleranza schema — resta

In produzione la tabella esisterà, ma **il DB E2E della CI è un progetto separato e non migrato**:
senza `tabellaMancante` la CI diventa rossa. `locker-requests-colonna-assente.test.ts` resta valido.

## Cosa non si tocca

- `armadietto` e il calcolo dello stock: funzionano, ci passa sopra tutto il modulo.
- Le colonne relitto di `armadietto` (`nome_oggetto`, `quantita_residua`, `livello_allerta`,
  `livello_emergenza`): scritte a ogni insert e mai lette. `nome_oggetto` è `NOT NULL` senza
  default; toglierle da una tabella viva è un lavoro a sé. **Debito dichiarato.**
- `POST /api/locker/notify`: è la direzione opposta e funziona.
- Il gating per grado: `funzioni_matrice.<grado>.armadietto` esiste come dato e come pannello di
  Segreteria, ma **nessuna route lo legge** — `requireFunzione` non ha call site di produzione.
  **Debito dichiarato**, da affrontare a parte.

## Verifica

1. Gate del repo: `npx eslint . --max-warnings 0`, `npx vitest run`, `npm run build`.
2. **In produzione, sole letture**: gli errori `PGRST205` su `app_log` per `/api/locker/requests` e
   `/api/notifiche/promemoria` devono **azzerarsi**; il cron delle 06:00 deve scrivere `ok` e non
   più `ok parziale — scansioni saltate (tabella assente): armadietto`.
3. **A mano nell'app**: un consumo sotto soglia fa comparire la richiesta alla maestra; «La porto»
   la porta a presa in carico; un carico la chiude.
