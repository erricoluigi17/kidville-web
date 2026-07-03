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
- `npx playwright install chromium`.

Architettura: `playwright.config.ts` avvia `next dev --port 3100` (`webServer`),
il progetto `setup` fa login UI per i 3 ruoli e salva gli storageState in
`e2e/.auth/*.json` (gitignorati); gli spec riusano quelle sessioni.

## Cosa semina `scripts/seed-e2e.mjs`

Scuola **dedicata** "Kidville E2E" (`e2e00000-0000-4000-8000-000000000001`) con UUID
fissi prefisso `e2e00000-…`: i dati demo/reali delle altre scuole NON vengono toccati.

| Entità | Dettaglio |
| --- | --- |
| Sezioni | `Girasoli` + `Tulipani` (infanzia). Il nome Girasoli è obbligato: appello e diario docente sono agganciati a quel nome. |
| Alunni | Aurora Arcobaleno-E2E, Bruno Baleno-E2E (Girasoli); Clara Cometa-E2E, Dino Delfino-E2E (Tulipani) — tutti `iscritto`. |
| Utenti Auth | `admin.e2e@kidville.test` (admin), `docente.e2e@kidville.test` (educator, sezione Girasoli), `genitore.e2e@kidville.test` (genitore di Aurora), `doppio.e2e@kidville.test` (educator Tulipani **+** bridge `parents.auth_user_id` ⇒ picker multi-profilo). Password comune: `KidvilleE2E.2026!`. |
| Config scuola | `admin_settings` della sola scuola E2E: `diario_config.routine_attive` include `umore`; `avvisi_config.ruoli_pubblicazione = ['admin','teacher']`. |
| Dati di contorno | 1 avviso adesione (classe Girasoli), 1 evento agenda futuro (Girasoli, visibile ai genitori), presenze di oggi SOLO per Tulipani (Girasoli = "appello mancante"), 2 pagamenti di Aurora (aperto+pagato), armadietto Aurora con stock 1 (bottone "Avvisa"), diario di oggi di Aurora (umore + attività), 1 notifica non letta per l'admin, 1 form model + submission `completed` non gestita. |

## Idempotenza e reset

Il seed è upsert su UUID fissi e **azzera i soli dati E2E mutabili** a ogni run:
presenze/diario/agenda/notifiche/pagamenti/armadietto/chat degli utenti-alunni E2E,
risposte all'avviso seminato, avvisi creati dal docente E2E nei test, e gli artefatti
del flusso pubblico d'iscrizione (submission con CF `TSTBNE20A01H501X`, anagrafiche e
account `iscrizione.e2e@kidville.test` creati dall'import admin). Eseguibile N volte.

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
