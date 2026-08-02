# Suite E2E Playwright (M8)

## Come si lancia

```bash
npm run e2e          # seed automatico (globalSetup) + dev server porta 3100 + suite
npm run e2e:seed     # solo il seed, a mano
npx playwright show-report   # report HTML dell'ultimo run
```

Prerequisiti una tantum:

- `.env.local` con `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (il seed usa la service-role; i test usano sessioni vere,
  `ALLOW_HEADER_IDENTITY=false` resta rispettato).
- `export KV_E2E_PASSWORD='…'` — la password dei 4 account `*.e2e@kidville.test`.
  **Non è nel repo** e non ha default: senza, `npm run e2e:seed` esce con `exit 1` e la
  suite fallisce all'import di `e2e/fixtures.ts`. In CI arriva dal secret GitHub
  `CI_E2E_PASSWORD` (job `e2e` di `.github/workflows/ci.yml`). Il seed la **rimposta** a
  ogni esecuzione, quindi per ruotarla basta cambiare il secret e rilanciare.
  Perché sta fuori dal repo: il 2026-07-29 il provisioning di Kidville Aversa e Kidville
  Cesa ha collegato `admin.e2e@kidville.test` (ruolo `admin`) a due sedi **vere**, e quel
  letterale committato è stato per due giorni una credenziale di Direzione valida in
  produzione, in un repository pubblico. Vedi `e2e/lib/e2e-password.mjs`.
- `npx playwright install chromium`.

Architettura: `playwright.config.ts` avvia `next dev --port 3100` (`webServer`),
il progetto `setup` fa login UI per i 3 ruoli e salva gli storageState in
`e2e/.auth/*.json` (gitignorati); gli spec riusano quelle sessioni.

## Cosa semina `scripts/seed-e2e.mjs`

**Due** scuole dedicate, con UUID fissi prefisso `e2e00000-…`: i dati demo/reali delle
altre scuole NON vengono toccati.

### Sede 1 — "Kidville E2E" (`e2e00000-…-0001`)

| Entità | Dettaglio |
| --- | --- |
| Sezioni | `Girasoli` + `Tulipani` + `Nuovi Iscritti` (infanzia). Il nome Girasoli è obbligato: appello e diario docente sono agganciati a quel nome. |
| Alunni | Aurora Arcobaleno-E2E, Bruno Baleno-E2E (Girasoli); Clara Cometa-E2E, Dino Delfino-E2E (Tulipani) — tutti `iscritto`. |
| Utenti Auth | `admin.e2e@kidville.test` (admin), `docente.e2e@kidville.test` (educator, sezione Girasoli), `genitore.e2e@kidville.test` (genitore di Aurora), `doppio.e2e@kidville.test` (educator Tulipani **+** bridge `parents.auth_user_id` ⇒ picker multi-profilo), `segreteria.e2e@kidville.test` (segreteria). Password comune: dalla variabile d'ambiente **`KV_E2E_PASSWORD`** (vedi sotto), mai scritta nel repo. |
| Config scuola | `admin_settings`: `diario_config.routine_attive` include `umore`; `avvisi_config.ruoli_pubblicazione = ['admin','teacher']`. |
| Dati di contorno | 1 avviso adesione (classe Girasoli), 1 evento agenda futuro (Girasoli, visibile ai genitori), presenze di oggi SOLO per Tulipani (Girasoli = "appello mancante"), 2 pagamenti di Aurora (aperto+pagato), armadietto Aurora con stock 1 (bottone "Avvisa"), diario di oggi di Aurora (umore + attività), 1 notifica non letta per l'admin, 1 form model + submission `completed` non gestita. |

### Sede 2 — "Kidville E2E Due" (`e2e00000-…-0002`)

Esiste dal 2026-07-31 (audit multi-sede, rilievo R132). Fino ad allora il seed creava una
sola scuola: **nessuno spec poteva accorgersi di una perdita di dati fra sedi**, non perché
l'isolamento fosse dimostrato ma perché non c'era un confine da attraversare. È la sede su
cui gira `e2e/isolamento-sedi.spec.ts`.

| Entità | Dettaglio |
| --- | --- |
| Sezione | `Girasoli` — **omonima** di quella della sede 1, ed è il punto: il nome-classe non è una chiave (a DB l'unicità è `(scuola_id, name)`), ed è l'ambiguità che il 2026-07-29 ha attivato le falle dormienti. |
| Alunni | Emma Eclissi-E2E (Girasoli), `iscritto`. |
| Utenti Auth | `segreteria2.e2e@kidville.test` (segreteria), `docente2.e2e@kidville.test` (educator, la Girasoli della sede 2), `genitore2.e2e@kidville.test` (genitore di Emma). Nessun ponte `utenti_scuole`: ogni account ha UNA sede, come in produzione per segreteria ed educator. |
| Config scuola | Identica a quella della sede 1 (di proposito: una configurazione diversa renderebbe verde un test d'isolamento per il motivo sbagliato). |
| Dati di contorno | 1 avviso `presa_visione` con `target_classes: ['Girasoli']` — l'**ancora** delle asserzioni negative: distingue «l'avviso dell'altra sede non c'è» da «la pagina non ha caricato niente». |

Entrambe le sedi restano **fuori dagli elenchi pubblici**: `isScuolaE2E`
(`src/lib/scuole/reali.ts`) le riconosce dal prefisso `e2e00000` e da «e2e» nel nome,
quindi il selettore di sede del wizard `/iscrizione` non le mostra.

## Idempotenza e reset

Il seed è upsert su UUID fissi e **azzera i soli dati E2E mutabili** a ogni run:
presenze/diario/agenda/notifiche/pagamenti/armadietto/chat degli utenti-alunni E2E di
**entrambe** le sedi, risposte agli avvisi seminati, avvisi creati dai docenti E2E nei
test (prima le risposte, poi gli avvisi: c'è una FK), e gli artefatti del flusso pubblico
d'iscrizione (submission con CF `TSTBNE20A01H501X`, anagrafiche e account
`iscrizione.e2e@kidville.test` creati dall'import admin). Eseguibile N volte.

## Note e gotcha

- **`utenti.role` live è colonna generata** da `ruolo`: il seed scrive solo `ruolo`.
- Genitore runtime = riga `utenti` con `ruolo='genitore'` (id == auth uid) — è ciò che
  usano legami/chat/pagamenti; il bridge `parents.auth_user_id` esiste comunque (per
  /api/me e per il profilo doppio).
- Le presenze sono seminate con la data **UTC** di oggi (come le legge
  `/api/admin/presenze/realtime`): tra le 00:00 e le 02:00 ora italiana il giorno UTC
  differisce da quello locale e la card presenze può risultare vuota.
- Il test `public-iscrizione` crea una richiesta reale e la importa: gli artefatti
  restano fino al seed successivo, marcati E2E (CF/email fissi di test).
- `isolamento-sedi.spec.ts` **non** usa gli `storageState` del progetto `setup` (che
  conserva le tre sessioni storiche): fa il login dei propri utenti dalla UI. Costa
  qualche secondo in più ed è il motivo per cui i suoi test hanno `setTimeout` espliciti.
- Le sue asserzioni negative sono sempre precedute da una positiva sulla stessa vista:
  `toHaveCount(0)` su una pagina che non ha caricato è verde per il motivo sbagliato. È
  la stessa disciplina che il 2026-07-30 è mancata e ha prodotto due falsi verdi.
