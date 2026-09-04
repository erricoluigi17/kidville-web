# Handoff — Trasferimento di sede · genitore multi-sede · sezioni rinominabili

**Data:** 2026-09-03 · **Branch:** `fix/aruba-prima-fattura` · **PR aperta sul branch:** #112

Questo documento basta da solo: chi riprende il lavoro non ha bisogno della chat da cui nasce.

---

## 0. STATO — aggiornato il 2026-09-04

**Commit `2c383cb1`** su `fix/aruba-prima-fattura` (non pushato). Gate al momento del commit:
eslint 0 · tsc 0 · **vitest 13.464/13.464** · build ok.

### ✅ Fatto, revisionato da un critico e corretto

| Task | Cosa |
|---|---|
| **T1** | `src/lib/sedi/trasferimento.ts` (destinazioni consentite, fail-closed) e `src/lib/anagrafiche/riallinea-sede-genitori.ts`. Critico: NON-A su 4 punti → corretti tutti, 42 test. |
| **T2** | La migrazione `20260903145106_…` che propaga la rinomina a 7 tabelle. Critico: **nessun difetto sul SQL**; 2 rilievi sul lock, ancora aperti. **NON APPLICATA.** |
| **T3** | Genitore multi-sede: 5 route + `ChildSwitcher` + il modulo condiviso `src/lib/anagrafiche/sedi.ts`. Critico: NON-A su 5 punti → corretti tutti. |

### ⏳ Resta da fare

1. **Applicare la migrazione** (T2) — e subito dopo **rinominare il file** alla versione che
   `schema_migrations` registra: `apply_migration` sceglie il proprio timestamp, e committare il
   nome locale arma una riapplicazione.
2. **Chiudere due buchi del lock** della rinomina: il filtro di sede si soddisfa anche stando
   dentro una sottoquery (mutazione dimostrata: il lock resta verde mentre la rinomina
   riscriverebbe il registro di tutte le sedi), e la prova sui dati personali è una lista nera di
   cinque parole invece di un controllo strutturale.
3. **T4** — `PATCH /api/admin/students`: `scuola_id` nello schema (oggi è **scartato in silenzio**),
   azzeramento di `section_id`/`classe_sezione`/`gruppo_mensa_id`, `riallineaSedeGenitori`, audit.
   Più `GET /api/admin/sedi/destinazioni`.
4. **T5** — `PATCH /api/admin/staff`: aprire il cambio di **sede** alla segreteria tenendo il cambio
   di **ruolo** alla Direzione, destinazioni da T1, e pulizia delle `utenti_sezioni` della sede
   vecchia (oggi restano attaccate).
5. **T6** — l'interfaccia del selettore, in `StudentDetailPanel` e `ParentDetailPanel`.
6. **T7** — il pulsante di rinomina della sezione (il backend è pronto da prima).
7. **Sanare 31 account genitore** (decisione del titolare: si sanano i dati, non il codice) —
   misurato: **21 legami** da riportare in `student_parents` per **19 account**, e **12 account**
   con anagrafica e zero figli. Nessuno punta a un alunno inesistente.

---

## 1. Perché

Kidville ha tre sedi reali (Giugliano, Aversa, Cesa) più la sede fittizia E2E. Oggi **la sede di
una persona si decide all'inserimento e non si tocca più**: non esiste in tutta l'applicazione un
punto dove spostare un bambino da un plesso all'altro. Quando una famiglia cambia sede — e
succede — l'unica strada è una `UPDATE` a mano sul database di produzione, cioè su quello che
contiene le anagrafiche reali di oltre cinquecento minori.

Nello stesso lavoro entrano due mancanze della stessa famiglia: il nome di una sezione non è
modificabile da nessuna interfaccia, e un genitore con figli in due plessi diversi è supportato
dal modello dati ma non da alcune route rimaste indietro né dall'interfaccia, che non gli mostra
mai a quale sede appartenga ciascun figlio.

## 2. Cosa la richiesta chiedeva, e cos'era già vero

La richiesta iniziale era di cinque punti. L'esplorazione ne ha ridotti tre:

| # | Richiesta | Stato reale, misurato |
|---|---|---|
| 1 | Selettore sede in anagrafica bambino/genitore/staff | bambino: **da fare**. staff: **già a metà**. genitore: **non si fa** (vedi §4) |
| 2 | Un genitore con due figli in due sedi | modello dati **già pronto**; restano 5 route e l'interfaccia |
| 3 | «Fattura errore allegata foto» | **fuori da questo giro**: la foto non era allegata |
| 4 | Nomi delle sezioni modificabili da segreteria e direzione | route **già esistente e completa**; manca il pulsante e la propagazione |
| 5 | Anche la segreteria rigenera le credenziali | **GIÀ FATTO**, in PR #112 su questo stesso branch |

**Il punto 5 non va rifatto.** `src/lib/auth/credenziali-staff.ts:46` (`puoRigenerareCredenzialiStaff`)
è applicato in quattro punti: route reset (`admin/regenerate-credentials/route.ts:207`), route PDF
(`admin/credentials-pdf/route.ts:122`), `StaffPanel.tsx:142`, `StaffDetailPanel.tsx:556`. Sette
commit, PRD aggiornato, 13.366 test verdi.

## 3. Decisioni prese dal titolare

| Domanda | Risposta |
|---|---|
| Cosa segue chi cambia sede | **Solo l'anagrafica.** Classe/sezione azzerata e da riassegnare a mano. Lo storico (fatture, presenze, mensa) resta sulla sede vecchia. |
| Chi può spostare | **Direzione e Segreteria.** |
| Quali destinazioni | **Tutte le sedi reali solo per la Direzione.** La Segreteria vede solo le sedi a cui ha già accesso. |
| Anagrafica genitore | **Nessun selettore.** Il selettore sta solo sul figlio; la sede del genitore si ricalcola **da sola**. |
| Genitore con figli in sedi diverse | Vede tutti i figli insieme; la sede la porta ciascun figlio. |
| Rinomina sezione | **Estendere la propagazione** a tutte le tabelle che tengono il nome come testo. |

## 4. I tre fatti tecnici che decidono tutto

### Il bambino: la sede si scarta in silenzio
`PATCH /api/admin/students` (`src/app/api/admin/students/route.ts:606`) valida con
`patchBodySchema` (righe 134-191), che **non contiene `scuola_id`**. Essendo un `z.object` non
strict, un `scuola_id` inviato oggi viene **scartato senza errore**: risponde 200 e non sposta
niente. `allowedFields` (riga 695) ha `section_id`, `classe_sezione`, `gruppo_mensa_id` — la sede no.

Tre agganci si rompono cambiando `alunni.scuola_id` da solo:
1. **`section_id` / `classe_sezione`** — vanno azzerati **entrambi**, nella stessa UPDATE.
   ⚠️ **Questa riga è stata corretta il 2026-09-04: la versione di prima era imprecisa, e
   l'imprecisione era un tranello.** Letto dal database: il trigger è dichiarato
   `BEFORE INSERT OR UPDATE OF classe_sezione, section_id, scuola_id`, quindi sul cambio di sede
   **parte** — è il suo *corpo* a non fare niente, perché la condizione interna chiede
   `INSERT` o `classe_sezione` cambiata o `section_id IS NULL`.
   Il corollario è ciò che conta: **azzerare il solo `section_id` sarebbe peggio che non azzerare
   nulla.** Il corpo scatterebbe (`section_id IS NULL`), cercherebbe in `sections` la riga con
   `scuola_id = NEW.scuola_id` — la sede NUOVA — e riaggancerebbe il bambino alla sezione
   **omonima** di quel plesso: «2 ANNI» esiste in tutti e tre. Una classe scelta da nessuno,
   assegnata in silenzio. Con `classe_sezione` a NULL il blocco esterno è saltato per intero.
2. **`gruppo_mensa_id`** — punta a `gruppi_mensa`, che è `UNIQUE(scuola_id, nome)`: va azzerato.
3. **La sede dei genitori** — `utenti.scuola_id` è `NOT NULL` ed è derivato dai figli da
   `sedeDelGenitore()` (`src/lib/auth/parent-identity.ts:280`), ma **oggi nessuno lo ricalcola dopo**.

### Il genitore: la colonna non esiste, ed è giusto così
`parents` **non ha `scuola_id`** e non deve averlo — è scritto nel codice
(`src/app/api/admin/parents/route.ts:86-90`) ed è precisamente ciò che rende possibile il punto 2.
Da qui: nessun selettore sull'anagrafica genitore, e ricalcolo automatico quando si sposta il figlio.

⚠️ `PATCH /api/admin/parents` usa `z.object({id}).loose()` (righe 208-213): **accetta qualunque
chiave** e su colonna sconosciuta la scarta con un warn invece di rifiutare.

### La sezione: rinominare oggi fa sparire il registro
Il trigger `trg_sections_propaga_rinomina`
(`supabase/migrations/20260902145538_identita_classe_presidi.sql:101-149`) aggiorna **solo**
`alunni.classe_sezione`, e solo per gli alunni con `section_id` valorizzato.

| Tabella | Colonna | Cosa succede rinominando |
|---|---|---|
| `registro_orario` | `classe_sezione` (chiave di upsert) | **lezioni, compiti e firme storiche invisibili**; il registro riparte da zero |
| `avvisi`, `news_posts`, `galleria_media_v2`, `forms_templates` | `target_classes text[]` | gli avvisi già pubblicati **smettono di arrivare, senza errore** |
| `mensa_class_menu_assignment` | `classe` | la classe perde il menu e ricade sul legacy di sede |

Il guasto degli avvisi **è già successo**: `20260801104252_avvisi_target_classes_nomi.sql`
(10 alunni, 0 destinatari raggiunti). Restano fuori anche gli alunni con `section_id NULL` — il
caso dei 73 bambini di Aversa: vanno raggiunti per forma normalizzata, non solo per uuid.

## 5. I sette task

**Onda 1** (indipendenti, file disgiunti)

- **T1 · Helper del trasferimento** — `src/lib/sedi/trasferimento.ts` (destinazioni consentite:
  Direzione → tutte le sedi reali, Segreteria → solo le proprie, ruolo ignoto → **vuoto**,
  fail-closed) e `src/lib/anagrafiche/riallinea-sede-genitori.ts` (dopo lo spostamento riscrive
  `utenti.scuola_id` **solo** su esito `figli`; su esito `ambigua` **non tocca niente**).
  Riusa `scuoleDiUtente` (`scope.ts:53`), `sediReali` (`src/lib/scuole/reali.ts:126`),
  `getGenitoriDiAlunni` (`src/lib/anagrafiche/legami.ts:121`).
- **T2 · Migrazione della rinomina** — riscrive `propaga_rinomina_sezione()` estendendola alle sei
  tabelle sopra, **filtrando sempre per `scuola_id = NEW.scuola_id`** (l'omonimia fra sedi è
  lecita: «2 ANNI» esiste in più plessi), sostituendo l'**elemento** dentro i `target_classes` e
  non l'array, più il ramo per gli alunni con `section_id NULL`.
- **T3 · Genitore multi-sede** — cinque route che ricadono sulla sede dell'ACCOUNT invece che sui
  figli: `parent/submissions:105`, `parent/onboarding:253`, `chat/messages:291-295`,
  `chat/threads/[id]/sospendi:86-91`, `segnalazioni:506`. Più `ChildSwitcher.tsx`, che deve
  mostrare la sede quando i figli stanno in plessi diversi.

**Onda 2** (dipende da T1)

- **T4 · Backend bambino** — `scuola_id` in `patchBodySchema`, destinazione validata con
  `destinazioniConsentite` (T1) e **non** con `resolveScuolaScrittura` (quella risolve la sede di
  una riga *nuova* e rifiuterebbe la destinazione fuori dal proprio plesso, che qui è il caso
  d'uso). Il bersaglio resta protetto da `assertAlunnoInScope` (riga 733). Azzerare
  `section_id`, `classe_sezione`, `gruppo_mensa_id`; poi `riallineaSedeGenitori`.
- **T5 · Backend staff** — `PATCH /api/admin/staff` accetta già `scuola_id` (`route.ts:140-150`)
  ma è riservata a `['admin','coordinator']`: aprirla alla Segreteria **per il solo campo sede**
  (il cambio di `ruolo` resta alla Direzione: è ciò che rende non aggirabile la riserva sulle
  credenziali). Cancellare le `utenti_sezioni` della sede vecchia anche senza `section_ids`
  (oggi restano, `route.ts:158`).
- **T6 · UI selettore sede** — `StudentDetailPanel.tsx` (conferma che dice **cosa si perde**) e
  `ParentDetailPanel.tsx` (sedi dei figli in sola lettura). Quando c'è una sola destinazione, il
  controllo si spiega invece di sembrare rotto.
- **T7 · UI rinomina sezione** — dialog in `SectionsView.tsx` / `sezioni/[id]/page.tsx`, clonando
  `changeSchoolType` (`sezioni/[id]/page.tsx:382-407`), con gestione esplicita del **409**.
  Nessun cambio di gate: `requireStaff` ammette già Segreteria e Direzione.

**T8 · Chiusura** — `PRD REGISTRO ELETTRONICO.md` (tabelle di stato + changelog datato) e i gate.

## 6. Metodo

Un **esecutore** per task (`subagent_type: esecutore-opus`, Opus 5, effort max, un solo task
ciascuno, file disgiunti) e un **critico** per esecutore (Fable 5.1, sola lettura, verdetto `A` /
`NON-A` con difetti numerati e riproducibili). Su `NON-A` parte un esecutore nuovo con la sola
lista dei difetti. Massimo tre giri per task; al terzo si ferma e si porta la cosa al titolare.
Gli esecutori **non committano**: committa l'orchestratore dopo l'`A`.

## 7. Trappole di questo repo, da non ripagare

- **Un mock piatto è verde con e senza la correzione.** Rompi il codice e guarda il test diventare
  rosso: un test mai visto fallire non è un test.
- **`comando | tail; echo $?` non verifica niente** (`$?` è l'ultimo anello della pipe), e
  `vitest -t 'nome-inesistente'` esce **0**.
- **`apply_migration` sceglie il proprio timestamp**: il file locale e `schema_migrations`
  divergono, e committare il nome locale **arma una riapplicazione**. Dopo ogni applicazione,
  rileggere `schema_migrations` e rinominare il file.
- **Il DB E2E della CI non è migrato**: il codice nuovo deve degradare pulito (`PGRST204` su
  INSERT/UPDATE, `42703` su SELECT).
- **PostgREST non lancia**: un `try/catch` attorno a `await supabase.from(...)` non scatta mai. Si
  controlla `{ error }`.
- **Su WebKit** un elemento che cambia altezza fa risalire il pulsante sotto il dito: riservare lo
  spazio, non farlo comparire.
- **Un job E2E «verde» può contenere due fallimenti su tre**: leggere i `retry #`.
- **Una seconda sessione lavora su `/Users/lerri/kidville-web-aruba`** (branch
  `fix/aruba-emissione-reale`): committare solo i percorsi di questo lavoro.

## 8. Ambiente

- `.env.local` punta al **database di PRODUZIONE**: `npm run e2e` e `e2e:seed` sono vietati in
  locale. L'E2E si verifica in CI.
- Durante lo sviluppo, sul DB di produzione **solo letture**. Le migrazioni si applicano con
  `apply_migration` + `get_advisors` (0 ERROR), **dopo** aver mostrato al titolare quante righe
  toccherebbero.
- Il repository è **pubblico**: mai segreti, mai PII reali di famiglie o bambini.
- `utenti.role` è colonna **generata** da `ruolo`: non scriverla mai.

## 9. Verifica

1. `npx eslint . --max-warnings 0` → 0
2. `npx tsc --noEmit` → 0
3. `npx vitest run` → verdi, **≥ 13.366** (baseline della PR #112). I test nuovi devono diventare
   **rossi** se si neutralizza la correzione che coprono.
4. `npm run build` → ok
5. Prima di applicare la migrazione: contare in **sola lettura** quante righe toccherebbe la
   propagazione (`registro_orario`, `avvisi.target_classes`, `mensa_class_menu_assignment`) e
   mostrare i numeri.
6. A mano su `:3100` — che parla col DB di **produzione**, quindi **navigare senza salvare**.
7. Controprova del trasferimento su un alunno di collaudo, mai su un bambino vero: dopo lo
   spostamento `section_id` e `gruppo_mensa_id` sono NULL e la sede del genitore è cambiata; con
   due figli in due sedi, invece, **non** cambia.
