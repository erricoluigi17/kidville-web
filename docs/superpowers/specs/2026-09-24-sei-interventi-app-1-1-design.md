<!-- Spec approvata dal titolare il 2026-09-24 (sessione di pianificazione). Fonte unica per esecutori e critici. -->

# Piano — sei interventi + app nativa 1.1 (24/09/2026)

## Context
Sei richieste del titolare, più l'app nativa 1.1 emersa durante l'intervista:
1. **Docenti** — eliminarli e trasformarli in genitore. Le funzioni esistono già (PR #157), ma solo la Direzione
   le vede. Caso reale: una persona di Cesa registrata per errore come docente, ancora `educator` a DB (identità nel resoconto della sessione, non qui: repo pubblico).
2. **Primaria** — tutto modificabile ed eliminabile (caso: un «impreparato» messo per errore e tolto a mano dal DB).
3. **Notifiche chat native** — verifica generale e correzione di tutti i difetti trovati.
4. **Mensa** — dopo le 9:30 niente prenotazione/disdetta di oggi o dei giorni passati. Il cutoff oggi scatta
   alle 11:30 italiane (UTC).
5. **Nanna** — «svuotare l'orario e salvare» non cancella la registrazione.
6. **Appello** — annullabile.
7. **App nativa 1.1** — download di foto, video e fatture che non funzionano, più i pezzi nativi delle notifiche;
   pubblicazione sugli store solo dopo aver risolto i download.

## Fatti accertati (esplorazione + letture DB, 24/09)
- **Docenti**
  - `ZonaPericolosaStaff.tsx` è montato in `StaffDetailPanel.tsx:1755`, dietro `canEdit` (solo admin e coordinator, riga 537).
  - Il server ammette già la Segreteria sulla sua sede (`src/lib/personale/permessi-eliminazione.ts`).
  - Il caso reale ha `parents.auth_user_id`, quindi «Trasforma in genitore» gli è applicabile.
- **Primaria**
  - Né l'API né la UI permettono di eliminare quello che scrive il docente.
  - Valutazioni, impreparati, note, allegati e fascicolo non hanno nemmeno la modifica.
  - `SbloccaOraButton` non è montato da nessuna parte.
  - Lo scrutinio chiuso non si riapre.
  - `pagella_ricezioni` dipende da `scrutinio_id`, non dalle pagelle: le firme sopravvivono alla cancellazione delle pagelle.
- **Notifiche (7 giorni)**
  - Invii FCM riusciti: 14.343 iOS e 2.478 Android; errori 0,14% (500 e timeout, mai ritentati).
  - Ritardo della chat: media 2,8'.
  - 26 utenti hanno negato il permesso e ricadono a ogni avvio.
  - Il canale Android non viene mai creato: si finisce in «Miscellaneous».
  - Manca il badge iOS.
  - La notifica del browser mostra testo e nome.
  - `RUOLI_PUSH_SOLO_CODA` (PR #165) esclude la chat verso lo staff.
  - Il dispatch marca le notifiche solo a fine giro: con giri sovrapposti partono doppioni.
- **Mensa**
  - `entroCutoff` in `src/lib/mensa/server.ts:103` usa l'ora UTC.
  - La GET restituisce già `cutoffOra`.
  - La UI del genitore non disabilita i pulsanti di oggi dopo il cutoff.
- **Nanna**
  - Esiste `DELETE /api/diary/entries` ed è corretta.
  - Con l'orario svuotato, il salvataggio scarta la riga (`DiaryEventEditor.tsx:484-490`) e il record resta.
- **Appello**
  - Genitore e maestra scrivono sulla stessa riga `presenze`:
    - il genitore scrive `stato='assente'`, `giustificata_da` e `giustificazione_testo`;
    - la maestra aggiorna `stato`, gli orari e `registrato_da`.
  - Oggi un bambino non torna mai a «da registrare».

## Decisioni del titolare (tutte prese nell'intervista)
**1 Docenti**
- La «Zona pericolosa» diventa visibile **anche alla Segreteria**, sulla sua sede.
- Dopo il deploy **trasformo io** il caso reale con «Trasforma in genitore», mostrando prima la scrittura.

**4 Mensa**
- Il blocco vale **solo per i genitori**; lo staff resta libero, anche sulle date passate.
- Cutoff **per sede, in ora italiana** (predefinito 09:30), sul server e nell'interfaccia.

**5 Nanna**
- Svuotare l'orario e salvare cancella **ciascun campo per sé**: Nanna vuota → via `nanna_inizio`; Sveglia vuota → via `nanna_fine`.

**6 Appello**
- **Annulla per singolo bambino**: torna a «da registrare». Vale per **nido, infanzia e primaria**.
- Se la riga ha una comunicazione del genitore (`giustificata_da` valorizzato), si **torna a quella**:
  `stato='assente'`, `registrato_da=null`, orari null, campi di giustificazione intatti. Altrimenti la riga si cancella.
- Si ritira l'avviso «assenza» ancora in coda; **nessuna rettifica** se è già partito.
- Lo può fare **chi fa l'appello** (docente e Segreteria), **solo il giorno stesso** (data di Roma).

**2 Primaria**
- Diventano modificabili ed eliminabili: valutazioni, impreparati, note, allegati del registro, documenti del fascicolo.
  - Si può eliminare **la propria firma**; se era l'unica sparisce la lezione. Segreteria e Direzione possono eliminare la lezione intera.
  - Riapertura dello scrutinio chiuso (**solo Segreteria e Direzione**): ritira la pubblicazione, cancella i PDF delle pagelle, le firme di ricezione restano.
  - Eliminazione di una **singola pagella** (Segreteria e Direzione).
  - «Annulla presa visione» della giustifica.
  - Modifica degli obiettivi in pagina.
- **Cancellazione vera** più una traccia `logScrittura('delete')`. Per allegati e documenti del fascicolo invece
  **cestino di 7 giorni** con «Ripristina»; poi riga e file spariscono (purga via cron).
- **Chi**: l'autore più Segreteria e Direzione. Un impreparato dichiarato dal genitore lo possono togliere anche i **docenti della classe**.
- **Termine**: 2 giorni (15 per le verifiche scritte), anche per modifica ed eliminazione, e anche per note, impreparati
  e allegati. Poi serve lo **sblocco della Direzione** (admin/coordinator), **voce per voce E per classe+giorno**.
- **Note**: anche quelle firmate dal genitore sono eliminabili (sparisce la firma). Per le note di gruppo si chiede
  **ogni volta** «solo questo alunno / tutti».
- **Nessun avviso** al genitore quando si modifica o elimina.
- **Impreparati**:
  - due tipi, «Impreparato» e «Impreparato giustificato»; li **sceglie il docente**, il tipo si cambia con Modifica;
    quello dichiarato dal genitore è sempre «giustificato»;
  - motivo = testo libero facoltativo;
  - i **7 esistenti** diventano «Impreparato» con motivo null;
  - si mostrano tra le «Valutazioni recenti» (stessa materia più quelli senza materia);
  - li **vede il genitore** tra i voti, con **notifica dopo 10'** (non parte se nel frattempo vengono eliminati);
  - il modulo del genitore si monta nella **pagina Voti**; il genitore può modificare o annullare il suo **fino al giorno dichiarato**.
- **Fascicolo**: autore più Segreteria e Direzione; si modificano tipo, descrizione e scadenza, e **si sostituisce il file**.

**3 Notifiche**
- Canale Android `kidville_notifiche` creato da JS: «Notifiche Kidville», **importanza alta, contenuto visibile**.
- Chat **inviata subito**: dispatch **30 s** dopo il messaggio, con **presa atomica** contro i doppioni.
- La chat verso Segreteria, Direzione e Cuoca va **in push, con il mittente**.
- Notifica del browser: «Nuovo messaggio in chat», **senza testo né nome**.
- Errori FCM 5xx e timeout: 1–2 ritentativi immediati; se nessun telefono l'ha ricevuta resta in coda **fino a 30'**.
- **Badge iOS** = numero di notifiche non lette.
- Avviso «Notifiche disattivate — Apri Impostazioni» **al massimo 1 volta a settimana**.
- Con l'app aperta resta **com'è**.
- Più i difetti minori:
  - ritentativi della registrazione del token, e un nuovo tentativo quando l'app torna in primo piano;
  - listener agganciati una volta sola;
  - `checkPermissions` prima di chiedere il permesso; al rifiuto il token si cancella;
  - livelli di log (`warn` dove l'esito arriva dopo);
  - import robusto dei plugin più la versione dell'app nativa nei log;
  - campionamento del `warn` sulle aperture da notifica;
  - mensa «saldo basso»: niente web-push diretto sui token nativi, niente doppione;
  - icona piccola Android (build).
- Rapporto scritto in `docs/`.

**7 App nativa 1.1**
- Si fa **in questo lavoro**, inclusi i download.
- Android: lo carico io su Play Console **in Chrome**, chiedendo conferma prima dell'invio.
- **Invio in revisione (iOS) e in produzione (Android) solo dopo aver risolto e verificato i download.**
- **Causa accertata**: i binari 1.0 non contengono il plugin Filesystem. In 30 giorni 1.941 ripieghi e **0** scarichi
  nativi riusciti. Altri ~35 punti usano `a[download]`, `blob:` o `window.open`, che nella WebView non fanno nulla o escono dall'app.
- **Download: tutti i ~37 punti.**
  - Foto e video vanno **direttamente in Galleria/Rullino**, con `@capacitor-community/media` (su Android nell'album «Kidville»).
    Il file si scarica con `@capacitor/file-transfer` (niente base64 nel bridge). **Nessun avviso** sulla dimensione dei video.
  - PDF e altri file: **foglio di condivisione «Salva su File»**.
  - Documenti da **aprire**: **anteprima di sistema dentro l'app** (`@capacitor/file-viewer`).
  - Sul **web** tutto resta come oggi.
- «Scarica» in galleria anche per **docenti e Segreteria**.
- Testo del permesso iOS (`NSPhotoLibraryAddUsageDescription`): «Kidville salva nel Rullino le foto e i video che
  scegli di scaricare.» L'informativa privacy **non** cambia. Nessun permesso `READ_MEDIA_*` su Android.
- Chi resta sulla **1.0**: il download ripiega come oggi, e compare un avviso «aggiorna l'app» **al massimo 1 volta a settimana**.
  Nessun plugin si chiama senza `isPluginAvailable`.
- Versioni: iOS **1.1 (5)**; Android `versionName 1.1`, `versionCode` = il primo libero, da verificare su Play Console (≥ 3).
- Build **solo** con `npm run rilascio:sync` (mai `npx cap sync` a mano). Si verifica l'artefatto (`.ipa` / `.aab`).

## Esecuzione
### Regole per tutti gli agenti (esecutori e critici, Opus 5.5)
- Ramo `feat/sei-interventi-e-app-1-1`, creato da `main`. **Nessun agente usa git per scrivere** (niente
  commit, checkout, stash, reset). Committa solo l'orchestratore. I critici possono usare `git diff`.
- Ogni esecutore tocca **solo i file del suo compito**. Sui file condivisi (`messages/it|en/*.json`, liste
  dei lock) fa solo Edit minimi.
- Niente `npm install`, tranne il compito NAT1. Niente `npm run build` né suite intera: solo
  `npx vitest run <propri test>`, `npx eslint <propri file>`, e
  `npx tsc --noEmit 2>&1 | grep <propri percorsi>`.
- Regole di AGENTS.md: `withRoute`, gate di ruolo, zod, logging (successo compreso), niente `console`,
  controllo di `{ error }` su PostgREST, sede dichiarata, niente PII nei log, chiavi i18n in **it ed en**.
- Le migrazioni si scrivono **solo come file idempotenti**, mai applicate a mano: le applica
  l'integrazione al merge.
- Il critico rilegge tutto e controlla punto per punto i requisiti del compito e le regole. Verifica che i test
  diventerebbero rossi senza la correzione (niente mock piatti). Dà `AAA` oppure `RIFARE` con l'elenco
  preciso delle correzioni. Con `RIFARE` parte un **nuovo** esecutore con quell'elenco; tetto di 8 giri, e se si
  raggiunge si ferma e lo dichiara.

### Workflow (catene parallele; dentro una catena i compiti vanno in sequenza, server prima di UI)
Prima del workflow, l'orchestratore crea il ramo e copia questo piano nella spec
`docs/superpowers/specs/2026-09-24-sei-interventi-app-1-1-design.md`, che tutti gli agenti leggono.

**Base, in parallelo** (le catene sotto aspettano che sia finita):
- **P0** — migrazione `20260924220000_primaria_modifica_elimina.sql`, idempotente:
  - `giustifiche_didattiche.tipo` (`impreparato`/`giustificato`, predefinito `impreparato`);
  - riempimento: `origine='genitore'` → `giustificato`; i 7 del docente col testo fisso → `impreparato` e `motivo` null;
  - `eliminato_il` / `eliminato_da` su `allegati_registro` e `student_documents`;
  - vincolo di `sblocchi_audit` esteso ai tipi `impreparato`, `allegato`, `firma`, `giorno`.
- **P1** — lib `src/lib/primaria/permesso-voce.ts`: autore o staff, più il termine (data di Roma), più lo sblocco
  per voce o per `giorno` (sezione + data). Estensione di `/api/primaria/sblocca` e componente `BottoneSblocca`
  (solo Direzione, con motivo). Si monta al posto di `SbloccaOraButton`.
- **NAT1** — l'unico con `npm install`:
  - plugin `@capacitor/file-transfer`, `@capacitor-community/media`, `@capacitor/file-viewer`, più l'apertura delle
    impostazioni notifiche su Android (plugin compatibile con Capacitor 8, da verificare);
  - `npm run rilascio:sync`;
  - testo del permesso iOS; icona piccola Android + meta-data;
  - versioni 1.1;
  - lock `plugin-capacitor-registrati` e `scripts/verifica-shell-nativa.py` estesi ai plugin nuovi.

**Poi, tutte in parallelo:**
| Catena | Compiti |
|---|---|
| Docenti | D1 Zona pericolosa visibile alla Segreteria (solo quella condizione, non tutto `canEdit`) |
| Mensa | M1 `entroCutoff` in ora di Roma + `codice: 'MENSA_OLTRE_CUTOFF'` → M2 `MensaCalendar`: oggi disabilitato dopo il cutoff, giorni passati in data di Roma |
| Nanna | N1 salvataggio con orario svuotato → `DELETE /api/diary/entries` per il solo campo svuotato |
| Appello | A1 lib `src/lib/presenze/annulla-appello.ts` + `DELETE /api/attendance/daily` → { A2 UI nido/infanzia } ∥ { A3 `DELETE /api/primaria/appello` → A4 UI primaria → A5 annulla presa visione (route + UI) } |
| Valutazioni | V1 PATCH/DELETE valutazioni → V2 impreparati del docente (tipo, motivo, PATCH/DELETE, notifica al genitore dopo 10') → V3 UI Valutazioni (recenti con impreparati, Modifica/Elimina, Sblocca) |
| Impreparati genitore | G1 route del genitore (PATCH/DELETE fino al giorno; i voti includono gli impreparati) → G2 pagina Voti: impreparati + `ImpreparatoForm` montato |
| Note | NO1 PATCH/DELETE (gruppo o singolo) → NO2 UI con scelta «solo questo alunno / tutti» |
| Registro | R1 DELETE firma/lezione → R2 allegati: cestino, ripristino, modifica → R3 UI firma/lezione + sblocco classe-giorno → R4 UI allegati + cestino → R5 download del registro/compiti con l'helper (dopo NAT2) |
| Fascicolo | F1 PATCH (con sostituzione del file), cestino, ripristino → F2 UI → F3 download/apertura con l'helper (dopo NAT2) |
| Purga | PU1 `/api/gdpr/retention-cestino-registro` + migrazione `20260924220100_cestino_registro_cron.sql` (7 giorni, costante unica più lock come `cestino-giorni-un-numero-solo`) |
| Scrutinio | S1 riapertura → S2 elimina singola pagella → S3 UI → S4 pagella/CSV con l'helper (dopo NAT2) |
| Obiettivi | O1 modifica degli obiettivi in pagina |
| Push server | PS1 `native-push` (ritentativi 5xx/timeout, badge) → PS2 dispatch estratto in `src/lib/push/dispatch.ts`: presa atomica, coda fino a 30', chat allo staff, conteggio badge → PS3 chat POST: `after()` + 30 s → dispatch |
| Push client | PC1 `native-register` (`checkPermissions`, canale Android «Notifiche Kidville» alto/visibile, ritentativi, listener unici, livelli, token cancellato al rifiuto, `statoPermessoPush()`) → PC2 nuovo tentativo al ritorno in primo piano + `native-shell` robusto + versione nativa nei log + campionamento del warn |
| Web e mensa | W1 notifica del browser «Nuovo messaggio in chat» + log nei catch · W2 mensa saldo basso senza web-push diretto |
| Download | NAT2 helper unico (`src/lib/native/scarica.ts` esteso: media→Galleria, file→foglio, apri→anteprima, ripiego 1.0) → in parallelo: NAT3a galleria (+ «Scarica» a docenti e Segreteria) · NAT3b fatture (+ pulizia del codice morto) · NAT3c genitore (ricevuta firma, prestampati, pagelle, competenze, allegati di lezioni/avvisi/chat) · NAT3d docente fuori dalla primaria (registro presenze PDF, TaskCard, certificati medici, documenti firmati) · NAT3e segreteria pagamenti (ricevute, export, fiscale, cassa) · NAT3f segreteria moduli/export (submissions, graduatorie, classi, adesioni, anagrafiche, modulistica, prestampati) · NAT3g segreteria documenti (protocolli, merchandise, competenze, `apriDocumentoFirmato` e ripieghi, scadenze; `StaffDetailPanel` dopo D1) |
| Avvisi settimanali | AV1 (dopo NAT1 + PC1) «Notifiche disattivate — Apri Impostazioni» e «Aggiorna l'app» (binario 1.0), ciascuno al massimo 1 volta a settimana |
| Rapporto | RAP rapporto notifiche in `docs/` |

**Fine:**
1. Gate completo, che lancio io: eslint · tsc · vitest intero · build. Le correzioni passano da esecutore + critico.
2. `PRD` aggiornato (esecutore + critico) e commit.
3. Push, PR, E2E in CI. Per ogni migrazione nuova lancio `DB migrate (CI)`.
4. Merge, verifica del deploy Vercel e delle migrazioni in produzione (solo `SELECT`), pulizia dei branch.
5. Caso reale: «Trasforma in genitore» dall'interfaccia in Chrome, dopo aver mostrato cosa verrà scritto.
6. App 1.1, dopo il deploy web (l'app carica il sito):
   - build iOS e Android con `rilascio:sync` e verifica degli artefatti;
   - collaudo su **simulatore iPhone 16e** ed **emulatore KV-api33**: foto e video in Galleria, fattura nel foglio
     «Salva su File», anteprima di un documento, canale «Notifiche Kidville», badge;
   - upload iOS via API; upload Android via Chrome, mostrandoti prima cosa invio;
   - invio in revisione (iOS) e in produzione (Android) **solo con i download verificati**.
7. Aggiornamento delle memorie di progetto (lavoro chiuso, trappole nuove).

## Verifica
- Per ogni compito: i test vitest dedicati, e il critico che li esamina.
- Gate finale: `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` (si conta `Test Files N passed`)
  · `npm run build` · E2E in CI con tutti i job verdi.
- In produzione (dopo il deploy, solo lettura): le colonne nuove esistono, il job cron di purga è registrato,
  e in `app_log` compaiono i log di successo delle nuove route.
- App nativa: su simulatore iOS ed emulatore Android si scarica una foto, un video e una fattura, e si controllano
  canale e badge.

## Domande aperte
Nessuna. Resta solo da verificare su Play Console (in esecuzione) il primo `versionCode` libero.
