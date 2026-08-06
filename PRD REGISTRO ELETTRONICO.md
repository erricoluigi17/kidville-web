
> [!IMPORTANT]
> ## 📊 Stato Implementazione e Architettura Database
>
> ### Database
> Il software recupera, aggiorna e inserisce tutti i dati su un database relazionale PostgreSQL.
> - **Fase Demo/Sviluppo:** Supabase (PostgreSQL gestito, con API REST automatiche e RLS).
> - **Fase Produzione:** PostgreSQL self-hosted sul server dell'istituto.
>
> L'applicazione comunica con il database tramite API Routes server-side (Next.js), che utilizzano il client Supabase in demo e un client PostgreSQL diretto in produzione. Le credenziali sono isolate in variabili d'ambiente (`.env.local`).
>
> ### Schema Database Attivo
> Le tabelle attualmente create e operative su Supabase sono:
> | Tabella | Descrizione | RLS |
> |---------|-------------|-----|
> | `schools` | Anagrafica sedi (multi-tenant) | ✅ Policy anon SELECT |
> | `utenti` | Staff (PK `id` FK → `auth.users`); **genitori reali su `parents`** | ⚠️ RLS abilitata ma **bypassata via `service_role`** — lockdown letture genitore in P0 (DL-003) |
> | `alunni` | Anagrafica alunni con allergie | ✅ Policy anon SELECT |
> | `eventi_diario` | Eventi giornalieri del Diario 0-6 | ✅ SELECT + INSERT + UPDATE |
> | `legame_genitori_alunni` | Relazione genitore↔figlio | ✅ RLS attivo |
> | `valutazioni` | Voti e giudizi (Primaria) | Schema creato, non ancora popolato |
> | `galleria_media` | Foto/Video con privacy tagging | Schema creato, non ancora popolato |
> | `armadietto` | Inventario materiali a scalare | Schema creato, non ancora popolato |
> | `ticket_mensa` | Saldo ticket pasto prepagato (running int per alunno) | Schema creato, non ancora popolato |
> | `mensa_ticket_movimenti` | Ledger movimenti ticket (ricarica/consumo/disdetta/rettifica + `saldo_dopo`) — storico e morosità | ✅ RLS + policy service_role |
> | `mensa_alternative` | Alternativa pasto per allergia/richiesta genitore (UNIQUE alunno+data, origine segreteria/genitore) | ✅ RLS + policy service_role |
> | `protocolli` (+ `protocolli_allegati`, `protocolli_categorie`, `protocolli_numerazione`) | Registro di protocollo DPR 445/2000: trigger WORM (annullo una-tantum art. 54; DELETE solo via `protocollo_elimina()` senza tracce), numerazione atomica per scuola/anno, titolario con seed | ✅ RLS + policy service_role |
> | `pagamenti` | Scadenziario rette e quote (+ `sconto`/`sconto_motivo` per voce, Contabilità v2) | Schema creato, non ancora popolato |
> | `pagamenti_transazioni` | Contenitore «incasso unico di famiglia»: un versamento → più voci di più figli + ricariche mensa (pagante = `parents.id`, metodo, riferimento/CRO, data valuta, note, annullo tracciato) | ✅ RLS + policy service_role |
> | `crediti_famiglia` | Ledger del credito di famiglia (causali eccedenza/utilizzo/rettifica/storno con `saldo_dopo`, ancorato a `parents.id`) — visibile **solo alla segreteria** | ✅ RLS + policy service_role |
> | `cassa_movimenti` (+ `cassa_categorie`, `cassa_chiusure`, `admin_settings.cassa_config`) | Registro di cassa contanti per sede: ledger **immutabile** (entrata/uscita/prelievo/rettifica, solo storno tracciato), entrate auto dagli incassi contanti calcolate a query-time, svuotamento con differenza + prelievo (RPC atomica `registra_chiusura_cassa`), categorie di uscita con seed («Versamento in banca» `is_sistema`), giustificativo su Storage **privato**. Saldo/«entrato oggi»/totali/report/svuotamento **solo admin** | ✅ RLS service_role (RPC SECURITY DEFINER, REVOKE anon/authenticated) |
> | `richieste_cancellazione` | Richieste self-service di cancellazione account genitore (App Store 5.1.1(v) + GDPR art. 17): il genitore avvia in-app **o dalla pagina pubblica `/cancellazione-account`** (C5, colonna `canale` = `in_app`/`pubblico_email`), la Direzione evade via anonimizzazione. Solo `parent_id`/stato/timestamp/conteggi/canale, **nessuna PII** | ✅ RLS abilitata **senza policy** (solo `service_role`) |
> | `segnalazioni` | Coda di triage UGC (C5, Google Play): segnalazione **contenuto** (chat/galleria/diario, discriminante `tipo_oggetto`+`oggetto_id` polimorfico) o **utente** (`segnalato_id`), categoria, motivo libero, stato/gestione. Nessuna FK utente: la riga sopravvive a un'eventuale anonimizzazione | ✅ RLS abilitata **senza policy** (solo `service_role`) |
> | `conversazioni_sospensioni` | Storico **append-only** delle sospensioni di conversazione chat (C5): al più una riga attiva per thread (indice unico parziale `WHERE riaperta_il IS NULL`), riapertura = UPDATE dei soli campi `riaperta_*`, mai un nuovo INSERT. Unica FK: `thread_id → chat_threads` | ✅ RLS abilitata **senza policy** (solo `service_role`) |
> | `consensi_accettazioni` | Prova **append-only** di accettazione Privacy/Termini (C5, valore probatorio art. 1341 c.c.): una riga per consenso, con `versione` decisa **server-side** (mai spoofabile dal client). Affianca `parents.consensi_gdpr` (che resta il flag booleano corrente), non lo sostituisce | ✅ RLS abilitata **senza policy** (solo `service_role`) |
>
> ### Isolamento fra sedi (multi-tenant) — stato al 2026-07-31
> Dal 2026-07-29 i plessi in produzione sono **tre**, non uno. Il nome di una classe ha smesso
> di essere una chiave, e i presidi che reggono l'isolamento sono questi (dettaglio e ragioni
> nel changelog del 2026-07-31, branch `fix/multisede-audit-globale`).
>
> | Presidio | Stato | Dove |
> |---|---|---|
> | Sedi | **3 reali** (Giugliano · Aversa · Cesa) + **1 finta** di collaudo (prefisso `e2e00000-…`), esclusa da elenchi pubblici, digest e contabilità | `src/lib/scuole/reali.ts` (`isScuolaE2E`, `sediReali`), `schools.operativa` |
> | Sede obbligatoria in scrittura | ✅ `resolveScuolaScrittura` risponde **400** quando l'utente ha più sedi e nessuna è indicata — nessun ripiego silenzioso sulla sede primaria | `src/lib/auth/scope.ts` (+ 55 test propri) |
> | `scuola_id` → `schools(id)` | ✅ FK su **65 tabelle su 65** (erano 34) | migr. `20260731122800_fk_scuola_id` · lock `fk-scuola-id` |
> | Nome classe univoco nella sede | ✅ UNIQUE `(scuola_id, name)` su `sections` | migr. `20260731113406_sections_nome_per_sede` |
> | Sede come proprietà del dato | ✅ `presenze` e `armadietto`: trigger dall'alunno + backfill + `NOT NULL` | migr. `20260731114449` |
> | RLS per sede | ✅ 42 policy riviste (37 droppate, 5 riscritte col vincolo di plesso) + fotografia versionata di `pg_policies` | migr. `20260731102245_rls_multisede_pulizia` · lock `rls-per-sede` |
> | Contabilità per sede | ✅ `genera_rette_mensili/anno` con `p_scuola_id` **obbligatorio**; sede di collaudo fuori dal perimetro | migr. `20260731115341` |
> | Semantica di `scuola_id NULL` | ✅ decisa e scritta: dato di famiglia ⇒ mai NULL; configurazione ⇒ NULL = «globale» | changelog 2026-07-31 |
> | Provisioning di una sede nuova | ✅ corredo minimo automatico + checklist di ciò che resta umano | migr. `20260731123052_provisiona_sede_v2` |
> | File negli Storage | ✅ `gallery`, `avvisi_allegati`, `task_allegati` **privati** con link firmati a scadenza breve; `news` **pubblico per scelta scritta** del titolare (blog verso l'esterno), dichiarato in migrazione | migr. `20260731192108`, `20260731192048` · `src/lib/gallery/storage.ts` · lock `bucket-storage-dichiarati` |
> | Copertura dell'isolamento nel gate | ✅ lock per **handler** (non per file), per **scrittura**, su tabelle lette dallo schema, allowlist a match esatto `route:METODO` | `__tests__/architecture/isolamento-sede-coverage.test.ts` |
> | Migrazioni ↔ database | ✅ **97** file = 97 versioni applicate, stessi nomi e stesso ordine; fotografia versionata del registro con `sha256` | lock `migrazioni-complete` |
> | Collaudo dell'isolamento | ✅ account TEST su Aversa e Cesa · account `test.multisede.admin` (solo accesso, tre sedi) per il selettore · seed E2E a **due** sedi con sezione omonima · `e2e/isolamento-sedi.spec.ts` | `scripts/seed-test-sedi.mjs`, `scripts/seed-e2e.mjs` |
>
> ### Moduli Implementati
> | Modulo | Stato | Pagine | API Routes |
> |--------|-------|--------|------------|
> | **Diario 0-6** | ✅ Operativo | `/teacher/diary` | `/api/diary/students`, `/api/diary/entries` |
> | **Presenze** | 🔶 UI pronta | `/teacher/attendance`, `/parent/attendance` | `/api/panic-alert`, `/api/attendance/*` |
> | **Registro Primaria** | 🔶 UI pronta | `/teacher/register`, `/parent/register` | `/api/grades`, `/api/notes` |
> | **Armadietto** | ✅ Operativo | `/teacher/locker`, `/parent/locker` | `/api/locker/*` |
> | **Mensa** | ✅ Operativo | `/admin/mensa`, `/parent/mensa` | `/api/mensa/*` |
> | **Chat** | ✅ Operativo | `/teacher/chat`, `/parent/chat` | `/api/chat/*` |
> | **Contabilità (Pagamenti)** | ✅ Operativo | `/admin/pagamenti` (8 viste, con «Incasso unico» e «Cassa»), `/parent/pagamenti` | `/api/pagamenti/*` (+ transazione unica di famiglia, credito famiglia, ricevute numerate, attestazioni, export AdE/XLSX, solleciti schedulati, riconciliazione bancaria (estratto conto unico cross-sede, abbinamento per codice fiscale), sconti/pro-rata configurabili, registro di cassa contanti (`/cassa/*`: saldo·movimenti·storno·svuotamento·report CSV, KPI solo admin)) |
> | **Modulistica** | ✅ Operativo | `/admin/forms`, `/parent/forms` | `/api/forms/*` |
> | **Registro Protocolli** | ✅ Operativo (solo admin+segreteria) | `/admin/protocolli` | `/api/admin/protocolli/*` (upload-url diretto, analizza, registrazione/annullo/eliminazione, file firmati, verifica integrità, categorie, export XLSX/PDF, da-documento, genera-documento) |
> | **Foto/Video** | ✅ Operativo | `/teacher/gallery`, `/parent/gallery` | `/api/gallery/*` |
> | **Centro Notifiche** | ✅ Operativo | campanella AppBar (genitore+docente+admin), `/admin/impostazioni?sezione=notifiche` | `/api/notifiche` (feed+segna lette), `/api/push/*` (subscribe/dispatch/vapid), `/api/notifiche/promemoria` (cron giornaliero) |
> | **News (blog · Instagram · digest mensile)** | ✅ Operativo | `/admin/news` (5 viste: Elenco·Editor·Proposte·Categorie·Digest), `/teacher/news`, `/parent/news` (feed·dettaglio·archivio digest) + widget home + voce Menu sheet | `/api/news/*` (14 route: gestione CRUD+workflow bozza→proposta→programmata→pubblicata, feed genitore server-derived **fail-closed**, digest mensile via email a tutte le famiglie della sede, cron `tick`+`digest`) |
> | **Cancellazione account pubblica + Moderazione UGC** (C5, Google Play) | ✅ Operativo | `/cancellazione-account`(+`/conferma`, pubbliche, bilingue), `/admin/moderazione` (coda segnalazioni), menu ⋮ in chat (segnala/sospendi), `/parent/onboarding` (gate Termini) | `/api/public/cancellazione-account/*`, `/api/segnalazioni`, `/api/admin/segnalazioni`, `/api/chat/threads/[id]/{sospendi,riapri}`, guardie in `POST /api/chat/messages` |
>
> ### 🎓 Moduli Normativi Scuola Primaria (gap da colmare)
> Requisiti derivati da L. 150/2024, O.M. 3 del 9/1/2025 (All. A), note MIM 5274/2024 e 2773/2025,
> D.M. 14/2024, Regolamento UE 2016/679 (GDPR), L. 4/2004 (Legge Stanca) e cooperazione SIDI.
> | Modulo | Stato | Priorità / Fase | Note |
> |--------|-------|-----------------|------|
> | **Valutazione conforme O.M. 3/2025** | ❌ Non conforme | Fase 1 | Oggi voti numerici: vietati alla primaria. Da convertire a motore ibrido per grado (vedi §4) |
> | **Orario / Tempo scuola / Materie master** | ❌ Da implementare | Fase 1 | `materia` oggi è testo libero; servono materie strutturate, campanelle, modelli 27/29/40h |
> | **Compresenza avanzata** | 🔶 Parziale | Fase 1 | Firme indipendenti presenti; manca firma con argomenti/compiti per singoli alunni + oscuramento |
> | **Vincoli temporali immodificabilità** | ❌ Da implementare | Fase 1 | Blocco 2gg classe/orali, 15gg scritti; sblocco solo dirigente |
> | **Scrutinio + Pagella online** | ❌ Da implementare | Fase 2 | 6 giudizi sintetici, Ed. Civica, comportamento; PDF statico (firma qualificata rimandata) |
> | **Fascicolo Personale + PEI/PDP** | 🔶 Parziale | Fase 2 | Oggi solo flag BES/DSA + delegati; serve fascicolo completo, RBAC ristretto, audit accessi |
> | **Libretto web giustificazioni** | 🔶 Parziale | Fase 2 | Esiste preavviso assenza; manca giustificazione online con PIN dispositivo |
> | **Interoperabilità SIDI / Piattaforma Unica** | ✅ Implementato (P5, DL-047..050) · 🔶 egress gated | Fase P5 | Import ZIP (parser pluggable), Fase A, frequentanti, genitori-alunni, certificati competenze D.M. 14/2024 + indicatore sync. **Trasmissione reale subordinata all'accreditamento ministeriale** |
> | **Accessibilità AgID / Legge Stanca** | 🔶 Baseline (P1, DL-008) | Trasversale | Fatto: alto contrasto globale persistito, focus-ring, reduced-motion, Modal accessibile, landmark/skip-link/aria-current, smoke jest-axe. WCAG-AA = definition-of-done; audit AA per-pagina incrementale |

---

## 🟠 Changelog — Il DSA è stato inviato dall'account individuale, e il gate dei 12 tester era già passato 2026-08-06 (branch `chore/dsa-inviato-e-versioncode`)

Giornata di sola verifica **a schermo** delle due console — l'unica cosa che nessuna API sa dire —
con `claude --chrome` da terminale. Ne sono usciti tre blocchi caduti, una decisione del giorno
prima ribaltata dal titolare, e una trappola documentale che valeva due settimane.

### 1. Google Play: il gate dei 12 tester era **già** soddisfatto, e il contatore non esiste

Si cercava *«Attualmente partecipano N tester»* nella scheda Tester del canale Alpha. **Quella voce
non esiste.** Il posto giusto è **Dashboard dell'app → «Richiedere l'accesso alla produzione»**, e
i requisiti si leggono da barrati o no:

| | |
|---|---|
| ✅ ~~Pubblica una release di test chiuso~~ | fatta il 05/08 alle 18:27 |
| ✅ ~~**Disponi di almeno 12 tester per cui è stato attivato il test chiuso**~~ | **soddisfatto** |
| ○ Esegui il test chiuso con almeno 12 tester per **almeno 14 giorni** | in corso |

Cade quindi il timore scritto il 05/08 che il contatore potesse dire **0** perché conta chi ha
*accettato* e non chi è in elenco: Google conferma ≥12 attivati. La mailing list ha **29 utenti**
(erano ~18), installazioni **0** — e l'opt-in conta, l'installazione no. Non c'è una data d'inizio
esposta: partendo dalla release del 05/08, la fine cade **intorno al 19-20 agosto**.

⚠️ **Da qui a quella data la lista tester non si tocca**: il requisito è *continuativo*, e un
tester che esce e rientra riparte da zero.

### 2. «Cambia tipo di account» era grigio per un motivo che si è risolto in un minuto

Il pulsante era disabilitato, e il tooltip diceva perché: *«Per modificare il tipo di account,
fornisci e verifica un sito web per la tua organizzazione»*. Inserito **`https://app.kidville.it/`**
al posto della spunta *«Non possiedo un sito web»* → *«Invia richiesta di verifica»* → **«Sito web
verificato»** in pochi secondi, e il pulsante è diventato **cliccabile**.

🔑 È stato istantaneo perché **`public/google8a174b25967018e2.html` era già nel repo e in
produzione**: Search Console ha verificato la proprietà **da sola** («Proprietà verificata
automaticamente — metodo: File HTML»). Un file dimenticato in `public/` ha chiuso un blocco che i
documenti davano per lungo.

Il flusso di conversione è stato **aperto e non completato**: chiede D-U-N-S (`432360401`) più
telefono ed email, entrambi da verificare con codice. **Non si converte adesso**: il gate Play è a
2/3 e mancano ~13 giorni; la conversione tocca l'entità a cui è agganciato il test chiuso e Google
non documenta cosa succede al conteggio. Un account *Organization* non avrebbe affatto il requisito
dei 12 tester — ma se la verifica dell'organizzazione durasse più dell'attesa residua, si
pagherebbe il rischio senza incassare il beneficio.

### 3. Apple: la causa era il DSA, e stavolta è **dimostrata**

L'app è approvata dal 06/08 e non è sullo store. Tre riscontri concordanti a schermo, l'ultimo
chiude il caso: **Prezzi e disponibilità → Disponibilità dell'app → «Disponibilità (Paesi o
regioni: **0**)»**, con **Italia → ❌ *«Stato di operatore commerciale non fornito»*** e gli altri
174 paesi «Non disponibile» perché mai selezionati. Zero paesi disponibili spiega
`itunes.apple.com/lookup` → `resultCount:0` e la pagina prodotto → `404`.

### 4. 🔻 Ribaltata la decisione del 2026-08-05: il DSA **è stato compilato** da account individuale

La voce del 05/08 (più sotto) stabiliva che il modulo DSA *«non verrà compilato dall'account
individuale»* e che si sarebbe atteso la conversione a *Organization*. **Il titolare ha deciso il
06/08 di procedere lo stesso**, dopo che sono emersi due fatti che quella decisione non conosceva:

- **Apple accetta le caselle postali** — lo scrive il secondo passo del modulo, *«Le caselle
  postali sono accettate»*: l'obiezione «si pubblica il domicilio di una persona fisica» era
  aggirabile, non insuperabile;
- **la conversione non pubblica niente da sola.** Anche a conversione avvenuta il modulo DSA va
  compilato **a mano**; e i tempi dichiarati da Apple (un giorno lavorativo) diventano **fino a tre
  settimane** quando il D-U-N-S è recente, con telefonata di verifica di mezzo.

**L'analisi del 05/08 non era sbagliata: il costo che descriveva è stato scelto consapevolmente.**
Restano in piedi, e vanno riletti quando l'account sarà convertito: nome, indirizzo, cellulare ed
email **di una persona fisica** sulla scheda pubblica in tutti i 27 paesi UE, e il rischio
**5.1.1(ix)** (chi pubblica ≠ chi eroga il servizio su dati di minori).

Dichiarato: *«Sono un operatore commerciale»* — che include anche *«il prodotto o il servizio è
conforme alla normativa dell'Unione europea»*, due affermazioni in un clic solo. Email
`info@kidville.it` e telefono `+39 331 815 3108` verificati con codice; caricata la carta
d'identità (fronte+retro) sia al passo «nome» sia al passo «indirizzo». Esito: **Azienda →
Conformità → *Normativa sui servizi digitali · 27 paesi o regioni · 6 ago 2026 ·* `Verifica in
corso`**, e il banner rosso è sparito.

⚠️ Subito dopo l'invio la **Disponibilità resta a «Paesi o regioni: 0»**: lo sblocco **non è
immediato**, arriva a verifica dei documenti conclusa. *Non dare per pubblicata l'app finché
`itunes.apple.com/lookup` non risponde `resultCount:1`.*

### 5. La trappola documentale: tre fonti, tre indirizzi diversi

Il modulo era stato compilato con **«Via Silvio Pellico 9»** — l'indirizzo che **App Store Connect
stesso** mostra nel profilo pagamenti. Poi il retro della carta d'identità ha detto un'altra cosa:

| Fonte | Indirizzo |
|---|---|
| Visura CCIAA — sede della cooperativa | Via Silvio Pellico **7** |
| Visura CCIAA — domicilio dell'amministratore *(citato nella voce del 05/08)* | Via Silvio Pellico **9** |
| ASC, profilo pagamenti | Via Silvio Pellico **9** |
| **Carta d'identità, residenza** | **Vico** Silvio Pellico **7** |

Apple confronta l'indirizzo dichiarato con il documento caricato: «Via … 9» sarebbe stato
**respinto**. Il modulo **non ha un pulsante Indietro** — per correggere si annulla e si rifà da
capo, e Apple **rimanda entrambi i codici**, email e SMS: le verifiche già superate non vengono
ricordate.

> **La regola che ne esce, e che vale oltre Apple: l'indirizzo si legge dal documento che si sta
> per caricare, non da quello che la piattaforma ha in archivio.** Averlo scoperto prima di
> caricare è costato dieci minuti; scoprirlo dopo sarebbe costato un rigetto.

### File toccati

- `android/app/build.gradle` — **`versionCode` 1 → 2**. L'1 è **bruciato** dalla release Alpha del
  05/08: Play non riaccetta un numero già caricato nemmeno se l'upload viene eliminato, e il
  prossimo `.aab` sarebbe stato respinto proprio nel momento di fretta.
- `eslint.config.mjs` — **il gate era rosso per tutti, e nessuno poteva vederlo.**
  `docs/collaudo/risultati/**` è escluso da `.gitignore` (contiene estratti del DB di produzione)
  ma **non** lo era da ESLint: `--max-warnings 0` falliva su
  `docs/collaudo/risultati/genera-tabella-pdf.mjs`, un file che **`git status` non mostra** e che
  in un clone pulito non esiste nemmeno. Rosso non riproducibile e non rintracciabile — la stessa
  ragione per cui `.claude/**` era già escluso. Ora le due esclusioni sono allineate.
- Nessuna modifica a `src/`: nessuna route, nessun log, nessuna migrazione.

---

## 🟠 Changelog — Google Play: l'ostacolo non era il codice, ed era invisibile dal repo 2026-08-05 (branch `chore/prompt-chiusura-collaudo`)

Obiettivo di giornata: mandare l'app in revisione su Google Play. **Il motivo per cui non è
immediato non è nel prodotto.** Questa voce esiste perché la ragione va scritta una volta e
trovata da chi riprenderà: il collo di bottiglia è amministrativo, in serie, e nessuna sua parte
si misura leggendo il repository.

> ✅ **Aggiornamento di fine giornata — il quadro qui sotto è cambiato in meglio, e va letto per
> primo.** Il **primo** cancello (verifica del dispositivo) è **caduto**: un telefono Android
> fisico preso in prestito lo ha chiuso in meno di un minuto. Da lì in avanti è caduto tutto il
> resto: app **`Kidville` / `it.kidville.app` creata**, scheda dello Store salvata, `.aab`
> `1 (1.0)` accettato, **11 moduli di conformità su 11 completi**, **canale di test chiuso
> «Alpha» configurato** (Italia · mailing list *Tester Kidville - collaudo chiuso* · feedback
> `info@kidville.it`) con la release `1 (1.0)` sopra.
> **Resta in piedi solo il secondo cancello: 12 tester × 14 giorni consecutivi.**
> Il paragrafo «Cosa resta, in ordine» in fondo a questa voce è aggiornato di conseguenza.

### Cosa si è misurato in Play Console

| Fatto | Valore |
|---|---|
| Account sviluppatore | **esiste** — `Luigi Errico`, ID `8247874898921386637` |
| Tipo | **Personale** |
| Data di creazione | **12 luglio 2026** (dal Log delle attività) |
| App pubblicate | nessuna — `Crea app` è **col lucchetto** |
| Verifiche in sospeso | verifica dispositivo Android · verifica identità e documenti · verifica telefono |
| `it.kidville.app` su Play | **libero** |
| Sito web dell'account | assente: la casella **«Non possiedo un sito web» era spuntata** |

I documenti `docs/submission/C1` davano lo stato di partenza come *«su Google Play non esiste
nulla»*: **era superato**. L'account era stato aperto il 12 luglio e nessun documento lo diceva.

### I due cancelli, e perché il secondo decide il calendario

1. **Verifica del dispositivo Android.** Google: *«You can use any **non-rooted physical**
   Android mobile device that runs at least the Android 10 operating system.»*
   **L'emulatore è stato provato davvero**, non escluso per sentito dire: AVD `KV-play-phone`,
   immagine `google_apis_playstore` API 36.1, account aggiunto, app **Google Play Console
   installata** (e qui una previsione è caduta: la ricerca dava l'app per «non compatibile» a
   420 dpi — invece il pulsante *Install* c'era). Al login l'app risponde:
   > *«You can't verify using this device. To verify, use a device running Android 10 (SDK 29) or newer.»*
   su un emulatore **Android 16**. Il messaggio mente sulla causa — è un controllo di
   attestazione hardware che fallisce, non una questione di versione — ma l'esito è definitivo.
   **Un emulatore non prende `MEETS_DEVICE_INTEGRITY`**: per gli emulatori Google ha
   un'etichetta separata, `MEETS_VIRTUAL_INTEGRITY`. Non è configurazione sbagliata, è progetto.

2. **Il gate dei 12 tester.** Google, testuale: *«developers with **personal accounts created
   after November 13, 2023**, [must] meet specific testing requirements»* → **test chiuso con 12
   tester attivi per 14 giorni consecutivi** prima di poter *chiedere* l'accesso alla
   produzione; fino ad allora *«Production … will be disabled»*. Un account personale del
   12/07/2026 **è dentro il perimetro**. Requisito verificato ancora in vigore ad agosto 2026:
   l'unica modifica mai annunciata è del **11 dicembre 2024** (da 20 tester a 12).
   Restano permessi: creare l'app, caricare l'`.aab`, compilare la scheda, internal testing e
   closed testing.

### La decisione presa

Il titolare ha dichiarato di **non disporre di 12 persone** per il test chiuso. Questo rende la
**conversione dell'account a ORGANIZZAZIONE** non più un'opzione ma l'unica strada — che è poi
la scelta che `docs/submission/C1` §1 aveva già preso, per ragioni indipendenti (il Titolare del
trattamento su `/privacy` è la cooperativa; un account a nome di persona fisica su un'app che
tratta dati sanitari di minori è una contraddizione visibile al revisore).

⚠️ **Da non spacciare per certezza**: il gate dei 12 tester è documentato da Google **solo** per
gli account personali, ma **non esiste alcuna frase di Google che dica che la conversione lo
annulla**. È un'inferenza, ed è marcata come tale.

### Il lavoro tecnico fatto oggi

- **`.aab` ricostruito e firmato** (`jarsigner`: `jar verified`). Quello del 27 luglio era
  **scaduto**: icona, splash e `capacitor.config` sono cambiati con le PR #65 · #67 · #68.
  `capacitor.config.json` sincronizzato verificato col `cat` obbligatorio → `"url":
  "https://app.kidville.it"`, `cleartext: false`.
- **Grafica di scheda ricontrollata**: icona 512×512 **con** alpha, immagine in evidenza
  1024×500 **senza** alpha, 5 screenshot 1080×1920 **senza** alpha. Sopra il minimo per
  pubblicare. Gli screenshot contengono solo dati TEST (`ALUNNO5 TEST INF`).
- **Prova di titolarità del dominio** per Google Search Console: `public/google8a174b25967018e2.html`
  + una voce in `PUBLIC_PREFIXES`. È il prerequisito che sblocca `Cambia tipo di account`.

### Il dettaglio che sarebbe costato un pomeriggio

Il matcher di `src/middleware.ts` esclude dagli intercetti `svg|png|jpg|…|txt|webmanifest|woff2`
ma **non `.html`**. Un file di verifica lasciato nella sola `public/` avrebbe risposto **307
verso `/auth/login`** al crawler di Google — restando perfettamente visibile da browser
autenticato, cioè fallendo in un modo che a occhio non si vede. È lo stesso inciampo già pagato
con `/manifest.webmanifest`, ed è la ragione della riga aggiunta in
`src/lib/auth/middleware-rules.ts`.

### Le due lacune del modulo «Sicurezza dei dati» che nessun controllo segnala

Compilando il modulo a schermo, il passo 3 (*Tipi di dati*) è stato salvato **senza** due tipi che
`docs/submission/C4` dichiara **obbligatori**:

1. **Informazioni finanziarie → «Dati di pagamento dell'utente»** — `incassi.metodo` è
   letteralmente *form of payment*. `C4` §1 avvertiva già che i documenti del repo si
   contraddicono su questa riga e che **vale A2**. L'avvertimento c'era, ed è stato disatteso lo
   stesso.
2. **Attività nell'app → «Altri contenuti generati dagli utenti»** — diario, note, moduli, firme.

**Play Console non ha segnalato niente**: il modulo risultava «completo» con entrambe le voci
mancanti, e sarebbe andato in revisione così. Google dichiara che *«il processo di revisione non è
progettato per verificare l'accuratezza e la completezza»* delle dichiarazioni di data safety: una
dichiarazione minimizzata **passa la revisione e fa rimuovere l'app mesi dopo**. Entrambe aggiunte
prima dell'invio. **L'unico controllo possibile è rileggere la tabella di `C4` riga per riga
contro lo schermo.**

Nella stessa passata è stata sciolta una domanda che `C4` lasciava aperta con un
*«⚠️ verificare nel form»*: **le informazioni sanitarie sono facoltative**, e lo si è **misurato**
invece di dedurlo — `src/lib/forms/enrollment-template.ts:33` dà `allergies` con
`required: false`, e ogni schema zod la valida `.optional()`.

Stesso metodo sulla **dichiarazione ID pubblicità**, che i controlli pre-revisione di Google hanno
segnalato come bloccante: la risposta («no») non è stata data a intuito ma leggendo il **manifest
fuso di release** (`app/build/intermediates/merged_manifest/release/…`), dove
`com.google.android.gms.permission.AD_ID` **non compare** — nemmeno portato da Firebase Cloud
Messaging, che era l'ipotesi da escludere.

### Cosa resta, in ordine

1. ✅ ~~Un telefono Android fisico~~ — **fatto**, con un apparecchio in prestito.
2. **12 tester × 14 giorni consecutivi sul canale chiuso.** È l'unico blocco rimasto e **non è
   aggirabile con codice**: il canale «Alpha» è configurato e la release è sopra, mancano le
   persone. Servono **12 account Google distinti** che accettino l'invito e **restino iscritti**
   per 14 giorni pieni; disinstallare l'app non rompe il conteggio, **uscire dal test sì**.
3. Verifica del sito e conversione a organizzazione (D-U-N-S `432360401`, ragione sociale
   **SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA**). Per Google, a differenza di Apple,
   chi firma **non** deve essere il legale rappresentante: *«any individual who is authorized to
   submit documents on behalf of the organization»*. ⚠️ Resta **non dimostrato** che la
   conversione annulli il gate dei 12: è un'inferenza dal perimetro testuale, non una frase di
   Google.
4. Intestare l'account al titolare: nome contatto ed email risultano ancora di un terzo.
5. ⚠️ **`versionCode 1` è bruciato**: il prossimo upload va incrementato a mano in
   `android/app/build.gradle`.

---

## 🐞 Changelog — Il log diceva «15 secondi» dove ne erano passati 191 2026-08-05 (branch `chore/prompt-chiusura-collaudo`)

Osservabilità e tetto di frequenza. Nessuna modifica funzionale visibile all'utente, ma un
difetto che **ha prodotto una decisione sbagliata**: il messaggio d'errore ha portato a valutare
l'acquisto di piani a pagamento per un guasto che non esisteva.

### Il difetto, in una riga

`conTetto` restituisce l'`init` **intatto** quando il chiamante ha già un `signal` suo — quindi il
tetto d'area (`TETTO_MS_DEFAULT = 15_000`) **non viene applicato**. Il ramo d'errore lo scriveva
comunque nel messaggio. Il tetto condiviso di `security/rate-limit` passa esattamente di lì, con
un signal proprio: ogni degradazione finiva in `app_log` come *«nessuna risposta da Supabase entro
il tetto di 15000 ms»*, evento **mai accaduto**.

| | Diceva il log | Misurato su `app_log` |
|---|---|---|
| Durata delle chiamate «senza risposta» | 15 000 ms | **media 191 ms**, min 66, max 921 |
| Causa registrata | `rpc_errore` (il DB ha risposto un errore) | **scadenza** del tetto del chiamante |
| `rpc_scaduta` su 113 degradazioni | — | **zero**: il ramo non scatta mai |
| Inizio del fenomeno | «qualcosa è rallentato il 4/08» | il **deploy** che ha introdotto il tetto condiviso (`d244eea`, 14:45 UTC; primo log 14:47:50) |

`rpc_scaduta` non scattava perché `segnaleConTetto` è registrato **prima** di `conTettoDiTempo`:
il suo timer parte per primo, l'abort si propaga per microtask e risolve la promise con `{ error }`
prima che la corsa dichiari la scadenza.

### Cosa cambia

- **`tetto.ts`** — nuova `tettoNostro(input, init)`: dice se la scadenza in arrivo è la nostra.
  `erroreTimeout` accetta `tetto: number | null` più i millisecondi **misurati**; `fraseScadenza`
  compone il testo. Con `null` il messaggio afferma solo ciò che è vero: *«entro il tetto del
  chiamante (interrotta dopo 191 ms)»*.
- **`supabase-fetch.ts`** — usa `tettoNostro` per log e rilancio; `NOME_SCADENZA` in un posto solo;
  nuova `eScadenzaSupabase(error)`, che riconosce la scadenza dall'`{ error }` di PostgREST
  guardando il **messaggio** (su quella strada `code` è vuoto — misurato).
- **`external.ts`** — stessa correzione: valeva identica per email, FCM, Aruba/SDI.
- **`rate-limit.ts`** — classifica la scadenza come `rpc_scaduta` e la registra a **`warn`**, non
  più `error`: è il degrado **progettato**, e un `error` che scatta durante il funzionamento
  normale insegna a ignorare gli errori. Le altre cause restano `error`.
- **`ATTESA_MASSIMA_DB_MS`: 250 → 1000 ms.** Su una distribuzione con media 191 e code a 921, un
  tetto di 250 **garantiva** la degradazione — cioè spegneva il contatore condiviso proprio sul
  modulo pubblico d'iscrizione, riportando il tetto per IP a `N istanze × limite`. È un budget,
  non una misura, e va riletto sui numeri quando cambia l'infrastruttura.

### Lock

`__tests__/lib/rate-limit-condiviso.test.ts` — una scadenza è `rpc_scaduta` a `warn`, un errore
vero resta `rpc_errore` a `error`; il finto PostgREST riproduce la forma reale (`code: ''`, nome
dentro al messaggio). `__tests__/lib/logging-tetto.test.ts` — quando il tetto è del chiamante il
messaggio **non** contiene `15000` e contiene la durata misurata.

Gate: `eslint` 0 · `tsc --noEmit` 0 · **7017 test verdi su 728 file** · `build` ok.

---

## 🟠 Changelog — Il DSA non si compila: prima l'account deve diventare della cooperativa 2026-08-05 (branch `chore/prompt-chiusura-collaudo`)

> 🔻 **DECISIONE RIBALTATA IL GIORNO DOPO — leggere prima la voce del 2026-08-06.** Il 06/08 il
> titolare ha scelto di **compilare il DSA dall'account individuale**, ed è stato inviato
> (`Verifica in corso`). Due fatti che questa voce non conosceva: **Apple accetta le caselle
> postali** (lo dichiara il modulo stesso), e **la conversione a Organization non compila il DSA da
> sola** — va fatto comunque a mano, dopo un'attesa che arriva a tre settimane. L'analisi di costo
> qui sotto resta valida: è stata **accettata**, non smentita. Restano aperti i dati personali
> pubblici sulla scheda App Store e il rischio **5.1.1(ix)**.
>
> ⚠️ Anche il domicilio citato qui sotto va corretto: la **carta d'identità** dice **«Vico** Silvio
> Pellico **7»**, non «Via … 9». Tre documenti, tre indirizzi diversi — dettaglio nella voce del 06/08.

Nessuna modifica al prodotto: è una **decisione di conformità** e l'allineamento dei documenti
che la reggevano male. Il modulo DSA — l'ultima cosa che separa l'app dalla pubblicazione in
Italia — **non verrà compilato dall'account individuale**.

### Cosa è stato misurato, contro cosa c'era scritto

| | I documenti dicevano | Misurato il 2026-08-05 |
|---|---|---|
| Tipo di account Apple | ignoto, «si legge a schermo in App Store Connect» | **`Individual`** — e si misura da riga di comando: `TeamName` del `.mobileprovision` = `"luigi errico"` (team `B5ULCGG2V3`). In un team *Organization* lì ci sarebbe la ragione sociale |
| Chi dichiara, e con quale indirizzo | «persona fisica, `Via Silvio Pellico 7`» | combinazione **indocumentabile**: il **7** è la sede della cooperativa, il domicilio della persona fisica è il **9** (visura CCIAA Caserta `T 621117155`, §Amministratori) |
| Chi può vincolare la cooperativa | implicitamente il titolare dell'account | **Errico Cesario**, Presidente del CdA. Visura, §Poteri: *«al Presidente vengono conferiti tutti i poteri di ordinaria e straordinaria amministrazione»*. Il titolare dell'account è **consigliere** → serve una **delega scritta** |
| D-U-N-S | «in mano, serve per Google Play» | **`432360401`, intestato alla cooperativa, dal 26/07/2026.** Il vincolo che aveva imposto l'account individuale era **già caduto da dieci giorni**, e il ticket di conversione (Passo 3 di `A1b`) non era mai stato aperto |
| `+39 331 815 3108` | trattato come recapito personale | è il **numero pubblico della sede di Giugliano**, già su `www.kidville.it`, ed essendo di cellulare riceve l'SMS di verifica |
| `info@kidville.it` | mai verificato che ricevesse | **riceve**: la mail `developer@email.apple.com` col D-U-N-S è arrivata lì il 26/07 alle 18:36 |

### Perché la conversione, e non «compilo e vediamo»

Da account *Organization* l'indirizzo del modulo DSA è **precompilato dal D-U-N-S, non
modificabile, e non richiede alcun documento di associazione**: è l'unico modo pulito di
ottenere la sede della cooperativa sulla pagina pubblica dell'App Store. Da account individuale
si sarebbe pubblicato **nome, domicilio e recapiti di una persona fisica**, con una verifica a
rischio di rigetto sull'indirizzo scelto.

Si aggiunge la **Guideline 5.1.1(ix)**, riverificata in vigore: *«apps … that require sensitive
user information should be submitted by a legal entity that provides the services, and not by an
individual developer»*. Kidville tratta allergie, note mediche e flag BES/DSA **di minori**, e il
Titolare del trattamento dichiarato in `/privacy` è la cooperativa: chi pubblica e chi eroga il
servizio, oggi, sono due soggetti diversi. È un motivo di rigetto documentato, e pende su
**questa** revisione.

⏳ **Un'app mai pubblicata non è trasferibile** (App Transfer pretende almeno una release): non
esiste la scorciatoia «pubblico ora e sistemo domani».

### Costo accettato

Finché la conversione non è fatta, l'app resta **approvabile ma non pubblicabile**: ITA continua
a rispondere `TRADER_STATUS_NOT_PROVIDED · CANNOT_SELL · AVAILABLE_FOR_SALE_UNRELEASED_APP`.
Con `releaseType = AFTER_APPROVAL` e un solo territorio attivo, questo significa **approvata e
mai pubblicata, senza che nessuna schermata lo dica** — per questo il semaforo si rilegge da
programma:

```bash
node scripts/asc-api.mjs GET "/v2/appAvailabilities/6794883055/territoryAvailabilities?limit=200"
```

### File toccati

- `docs/submission/A1b-duns-richiesta.md` — sezione «AGGIORNAMENTO 2026-08-05», tabella dei
  requisiti e checklist riscritte sugli esiti reali
- `docs/submission/A1-dsa-operatore-commerciale.md` — **corretta una riga che diceva il falso**
  («dal 17 febbraio 2025 nessun invio è possibile senza il DSA»: l'invio del 04/08 è avvenuto con
  `TRADER_STATUS_NOT_PROVIDED` attivo); DECISIONE 1/2/3 chiuse, §2 allineato

📄 Testo del ticket ad Apple, delega bilingue da far firmare al Presidente e valori del modulo DSA
stanno **fuori dal repo** — in `~/Downloads/Kidville-Apple-Organization/` — perché la delega
contiene dati personali e **questo repository è pubblico**.

---

## 🚀 Changelog — L'app iOS è in revisione, e il blocco non era quello che tutti i documenti dicevano 2026-08-04

**`WAITING_FOR_REVIEW` dalle 21:32:43 UTC del 2026-08-04**, build **`1.0 (4)`**, territorio
**solo Italia**, rilascio **automatico dopo l'approvazione**.

### Il blocco all'invio era `copyright`, non il DSA

`docs/store-submission.md` e `docs/submission/A1-dsa-operatore-commerciale.md` sostenevano
entrambi che la dichiarazione DSA *«sblocca l'invio in revisione»*. **Falso.** Con
`TRADER_STATUS_NOT_PROVIDED` ancora su ITA, `POST /v1/reviewSubmissionItems` è passato `201` e
`PATCH {submitted:true}` ha portato la versione a `WAITING_FOR_REVIEW`.

Il vero motivo del `409` di stamattina stava scritto nella risposta stessa, in
`meta.associatedErrors`, e nessuno l'aveva letto:

```
ENTITY_ERROR.ATTRIBUTE.REQUIRED
  "You must provide a value for the attribute 'copyright'"
```

> **Lezione generalizzabile**: un `409` di questa API non è un muro, è un **elenco**.
> `meta.associatedErrors` nomina ogni attributo mancante. Si legge quell'elenco invece di
> attribuire il rifiuto alla causa che sembra più probabile — qui la causa «probabile» era
> sbagliata, ed è costata mezza giornata di attesa a una persona.

### 🔴 Il DSA però blocca il RILASCIO, e con un solo territorio è peggio

Riletto il semaforo subito **dopo** l'invio riuscito:

```
ITA  contentStatuses = [TRADER_STATUS_NOT_PROVIDED, CANNOT_SELL,
                        AVAILABLE_FOR_SALE_UNRELEASED_APP]
```

`CANNOT_SELL`: la revisione può concludersi bene e l'app **non può essere distribuita in
Italia** — l'unico territorio attivo. Con `releaseType: AFTER_APPROVAL` l'esito sarebbe
**approvata e mai pubblicata, senza che nessuna schermata lo dica**.

Il momento giusto per dichiarare il DSA è quindi **durante** la finestra di revisione, non prima
dell'invio. La *dichiarazione* toglie `TRADER_STATUS_NOT_PROVIDED`; la *verifica del documento*
da parte di Apple toglie `CANNOT_SELL` e **non ha SLA pubblicato**.

### Stato della scheda al momento dell'invio

| | |
|---|---|
| build agganciata | `4` — `VALID`, `IN_BETA_TESTING`, scade 2026-11-02 |
| disponibilità | 1 territorio su 175 (ITA) |
| prezzo | fascia gratuita |
| diritti sul contenuto | `USES_THIRD_PARTY_CONTENT` |
| crittografia | `ITSAppUsesNonExemptEncryption = false` |
| privacy manifest | 20 tipologie, **dentro l'`.ipa`** |
| account revisore | `test.inf.genitore1@kidville.test`, accesso **provato** contro produzione |
| prova offline | superata su iPhone fisico (modalità aereo) |
| prova push | ⏳ da fare, e va fatta **da genitore**: `NativePushAutoRegister` non è montato nel layout admin |

---

## ✅ Changelog — Lo schermo bianco all'avvio, e la registrazione push che non lasciava traccia 2026-08-04 (branch `fix/splash-avvio-nativo`)

**Segnalazione del titolare, sulla 1.0 (3) installata da TestFlight**: *«quando apre l'app, rimane
per dei secondi schermo bianco»*. E, sulla prova delle notifiche: *«non so cosa dovrei fare»*.

### Lo schermo bianco — cos'era davvero

Non è un caricamento lento del sito: è che l'app **è una WebView che scarica `app.kidville.it`
dalla rete**. La schermata di lancio di iOS sparisce quando il processo è pronto (qualche decimo
di secondo), il primo HTML arriva secondi dopo, e in mezzo la WebView non ha niente da dipingere.
Il `PageLoader` non poteva coprire quell'intervallo: fa parte della pagina che si sta ancora
scaricando.

Misurato sull'imageset, non ricordato: la schermata di lancio era **verde pieno `#006A5F`, senza
logo**. Accanto vivevano tre `splash-2732x2732*.png` bianchi col marchio Capacitor che
`Contents.json` **non referenziava** — residui del template, e la ragione per cui la prima
diagnosi di questa sessione è stata sbagliata (rimossi).

**La correzione**: lo splash nativo è ora la copia esatta del `PageLoader` — fondo crema
`#FEF1E4`, lettering «Kidville» al centro, alla stessa misura. Quando l'app web è pronta lo
splash si dissolve e sotto c'è il `PageLoader`: stesso fondo, stesso logo, nessuno stacco.

| pezzo | dove |
|---|---|
| il PNG (2732², crema, logo a 770 px) | `scripts/genera-icone.mjs` → `assets/splash*.png` |
| plugin, tetto, colori | `capacitor.config.ts` (`@capacitor/splash-screen` 8.0.2) |
| chi lo toglie, e quando | `src/lib/mobile/splash.ts` ← `setupNativeShell` |
| il fondo sotto la WebView | `ios.backgroundColor` / `android.backgroundColor` = `#FEF1E4` |

Tre decisioni che vale la pena aver scritte:

- **`hide()` dopo il doppio `requestAnimationFrame`**, non appena parte il JavaScript. `hide()`
  scopre la WebView nell'istante in cui viene invocata: chiamarla troppo presto rimetterebbe a
  schermo lo stesso lampo bianco, più corto e più fastidioso perché dopo qualcosa di finito.
- **`launchAutoHide` resta `true`, con tetto a 6 s.** Non è il comportamento normale (l'app
  chiama `hide()` dopo 1-3 s): è la rete di sicurezza. Con `false`, un boot in cui il JS non
  arriva mai — server che non risponde né fallisce — lascerebbe l'app su una schermata fissa a
  tempo indeterminato.
- **Il tetto è anche il prezzo della modalità aereo**, dove il caricamento fallisce subito e
  `offline.html` sta su un'origine locale in cui il bridge di Capacitor può non essere iniettato.
  La pagina ci prova comunque; se il bridge non c'è, restano i 6 s. Ciò che rende accettabile il
  compromesso è il livello sotto: quando lo splash se ne va si trova il **crema**, non il bianco.

### La registrazione push — perché non si poteva collaudare

`NativePushAutoRegister.tsx` faceva `void registerNativePush(userId).catch(() => {})`. Misura del
2026-08-04: in `push_subscriptions` **nessuna riga `ios`** — l'ultima registrazione era del 2
agosto, tutte `android`, tutte dall'emulatore. L'app girava su un iPhone vero e del suo tentativo
non restava traccia da nessuna parte: `permission_denied`, `registration_error` e
`subscribe_failed` finivano tutti nello stesso silenzio.

Ora ogni ramo lascia una riga (`push-nativa-permesso-negato`, `-registrazione-fallita` col
messaggio del sistema, `-non-registrata` con lo **stato HTTP**, `-senza-esito`), ed è stato chiuso
un difetto che il catch muto nascondeva: `register()` consegna l'esito a uno di due listener, e se
il sistema non chiama né l'uno né l'altro **la promise non si risolveva mai** — senza secondo
tentativo, perché `attempted` è di modulo. Timeout a 20 s.

Il **successo** non si logga da qui, e non è una deroga alla regola 5: il successo di questa
operazione *è* la riga in `push_subscriptions`, una traccia più forte di un log — è esattamente
quella che, contata a zero, ha rivelato il problema.

### Gate e lock

`eslint` 0 · `tsc` 0 · **728 file, 7014 test** · `build` ok. Due lock nuovi
(`__tests__/architecture/splash-avvio-nativo.test.ts`, `__tests__/lib/splash-nativo.test.ts`) e
l'allowlist dei catch muti scesa da **55 file / 85 occorrenze** a **54 / 84**, con
`NativePushAutoRegister.tsx` iscritto fra quelli che non possono tornarci.

Il lock dello splash tiene insieme le **quattro copie del crema** che nessun compilatore
collega (CSS del `PageLoader`, `capacitor.config.ts`, generatore, `package.json`) e apre i PNG
committati per leggerne il primo pixel: tutta la configurazione può essere giusta e l'immagine
sbagliata — è successo, ed era il verde. Entrambi i lock sono stati **provati per mutazione**, e
la prova ha smascherato un falso verde mio: `toContain('nascondiSplashNativo')` passava anche
togliendo la chiamata, perché il nome resta nell'`import`.

---

## ✅ Changelog — Il menu che a volte non portava da nessuna parte, e la submission App Store 2026-08-04 (branch `feat/icona-brand`)

**Il test rosso su `main` era il prodotto, non il test.** L'E2E `parent-news.spec.ts:51` — «apro il
menu e vado alla sezione News» — falliva a intermittenza da giorni, e due ipotesi erano già state
formulate, scritte nel codice e smontate dai fatti: il focus trap (ritirato) e l'overlay del loader
globale (mitigato, senza effetto). La traccia Playwright della run **30920578641**, scaricata invece
che immaginata, mostra la sequenza vera:

| istante | cosa succede |
|---|---|
| 2543 ms | il click sulla voce «News» **arriva** al link (Playwright ritenta 4 volte: il foglio stava animando) |
| ~2600 ms | parte la richiesta RSC verso `/parent/news` |
| ~2880 ms | la richiesta torna **`200` in 283 ms** |
| 2899 → 7463 ms | l'URL resta `/parent`. Quattordici letture, nessun cambiamento |

La navigazione parte, i dati arrivano, **la transizione non si conclude mai**. La causa è
`onClick={() => setShowMenu(false)}` sul `<Link>` del foglio: il click avvia la navigazione di Next
— che è una *transizione React* — e nello stesso istante **smonta il link che quella transizione sta
portando**. Se il payload RSC arriva prima dello smontaggio la navigazione passa; se arriva dopo, si
perde in silenzio. È una corsa, ed è per questo che sembrava capriccio: la stessa riga passava a
5,6 s e falliva a 6,9 s.

**Non era un difetto di collaudo.** È la navigazione principale di ogni famiglia: su una rete lenta
— un genitore col telefono davanti a scuola — toccare una voce del menu **non portava da nessuna
parte**, e nessuno se n'era accorto perché in ufficio la rete è veloce.

Corretto in `BottomNav.tsx` **e** in `TeacherBottomNav.tsx` (lo schema era copiato in tutte e due):
il foglio si chiude **quando la rotta è cambiata**, non quando si clicca — con l'aggiustamento di
stato in render, l'escape hatch documentato da React per lo stato derivato, così non c'è un giro di
render in più né una finestra col foglio aperto sulla pagina nuova. Unica eccezione, la voce della
rotta in cui si è già: lì nessuna navigazione avverrebbe e il foglio resterebbe aperto per sempre.
Lock: `__tests__/ui/bottom-nav-menu-navigazione.test.tsx`, tre casi, rosso prima e verde dopo.

**Tre commenti che sostenevano il falso sono stati rettificati sul posto**, non cancellati: quello
in `BottomNav.tsx` che attribuiva il guasto al focus trap (era un aggravante, non la causa — e ora
`useFoglioModale` si può riprovare), quello in `parent-news.spec.ts` che lo attribuiva all'overlay, e
il `catch` muto di `attendiFineCaricamento`, che ora almeno **avvisa** invece di arrendersi in
silenzio. In questo repo un documento che descrive una causa inesistente è già costato settimane.

### Submission App Store — quattro bloccanti trovati misurando, non leggendo

Sbloccata l'API di App Store Connect (`scripts/asc-api.mjs`, client JWT ES256 senza dipendenze;
chiave e Issuer ID restano **fuori** dal repository). Quello che la lettura dello stato reale ha
trovato, e che nessun documento sapeva:

1. 🔴 **Il revisore non sarebbe potuto entrare.** Il campo password dell'account demo su App Store
   Connect conteneva un valore di **9 caratteri** — la vecchia password comune degli account TEST,
   ruotata il 26 luglio — mentre la password dedicata sul disco ne ha 24. Provate entrambe contro la
   produzione: **respinte tutte e due**. L'account era stato ritoccato il 3 agosto e il valore
   corrente non esisteva da nessuna parte. Riallineato (`scripts/allinea-password-revisore.mjs`) e
   **verificato con un accesso vero**, non leggendo un campo. È il rigetto 5.1.1 più frequente in
   assoluto, ed era già armato.
2. 🔴 **Nessuna fascia di prezzo impostata**: una app nuova senza prezzo non si invia. Creata,
   gratuita, base Italia.
3. 🔴 **`contentRightsDeclaration` vuoto**: altro blocco all'invio. Dichiarato
   `USES_THIRD_PARTY_CONTENT` — la sezione News incorpora YouTube, Vimeo e Instagram, e sono nei
   `WKAppBoundDomains` dell'`Info.plist`: dichiarare il contrario sarebbe stato falso.
4. **Disponibilità mai impostata** (la risorsa non esisteva proprio): ora **solo Italia**, 1
   territorio su 175, con `availableInNewTerritories: false` — altrimenti ogni nuovo mercato che
   Apple aggiunge entrerebbe da solo.

**La chiave di servizio Supabase in `.env.local` è morta** (`sb_secret_…`, `401 Unregistered API
key`): qualunque script locale che usi il service role non funziona. La produzione non è toccata —
gira sulla `service_role` legacy su Vercel — ma va rigenerata.

### Dopo il merge — misurato, non atteso

**La produzione serve davvero il codice nuovo**, e questo chiude i tre controlli che il
changelog delle icone aveva lasciato aperti: `/manifest.webmanifest` risponde **`200`** con
`application/manifest+json` (non più un `307` verso il login — è la riga di `src/middleware.ts`
cambiata dal branch, quindi è anche il test perfetto che il deploy sia arrivato), `og:image`
risponde `200`, e **la favicon servita ha lo stesso MD5 di quella nel repo**: il triangolo di
Vercel non c'è più.

**Build `1.0 (2)`**: costruita con `CAP_SERVER_URL` di produzione, firmata `Apple
Distribution`, `aps-environment = production`, `get-task-allow = false`, `CFBundleVersion = 2`,
privacy manifest a 20 voci **letto dentro il bundle**. Caricata, `VALID`, agganciata alla
versione 1.0, `IN_BETA_TESTING` su TestFlight (scade il 2026-11-02). È la prima build in cui
`limitsNavigationsToAppBoundDomains` vale **`true`**: gli embed di News e il login vanno
riprovati su dispositivo, perché quella configurazione non è mai girata su hardware vero.

`ios/ExportOptions.plist` **ora esiste nel repository**, con `manageAppVersionAndBuildNumber:
false` — senza quel flag Xcode incrementa il build number da solo durante l'export e si aggancia
alla versione la build sbagliata.

**Un test fragile smascherato, non nascosto.** Dopo la correzione la CI è tornata rossa su un
test diverso — `notifications-panel.spec.ts:10` — e non per causa nostra: `isolamento-sedi.spec.ts`
pubblica un avviso che genera una notifica per lo **stesso** account genitore E2E, e se arriva
mentre il pannello è aperto il conteggio delle non lette risale dopo il «segna tutte lette».
Rilanciato il solo job, passa. È una **corsa fra spec che condividono un account**, non un difetto
del prodotto: resta aperta e andrebbe chiusa dando a quello spec un genitore tutto suo.

⚠️ **Resta un solo passaggio umano, e non è aggirabile**: la dichiarazione **DSA di operatore
commerciale**. Verificato sullo spec OpenAPI ufficiale 4.3 di App Store Connect: `trader` compare
**solo come enum in sola lettura**, non esiste alcun endpoint per dichiararlo. Si compila a schermo
in *Business → Agreements → Compliance*. Misurato via API che oggi il territorio **ITA porta
`TRADER_STATUS_NOT_PROVIDED`** (come tutti e 27 i paesi UE): finché non è dichiarato, l'invio in
revisione è bloccato.

---

## ✅ Changelog — L'identità visiva: via il triangolo di Vercel, e i link condivisi smettono di essere anonimi 2026-08-04 (branch `feat/icona-brand`)

Il mascotte Kidville diventa l'icona su **tutte** le piattaforme. Non era una sostituzione di
file: le tre cose qui sotto erano rimaste come le aveva lasciate `create-next-app`.

**Che cosa c'era davvero, misurato e non supposto**

- `src/app/favicon.ico` era **ancora il triangolo nero di Vercel**, non toccato dal commit
  `b34e3f0 "Initial commit from Create Next App"`. È l'icona che l'app ha mostrato nelle
  schede del browser per tutta la sua vita;
- i `metadata` avevano solo `title` e `description`: **nessun `openGraph`, nessuna immagine,
  nessun `metadataBase`**. Un link a `app.kidville.it` condiviso su WhatsApp arrivava senza
  anteprima, e i client ripiegavano proprio su quel triangolo;
- **non esisteva un manifest**: chi installava la web app da browser riceveva un'icona di
  ripiego scelta dal sistema.

**Come sono fatte le icone, e perché non è un ritaglio solo**

La sorgente è una: `assets/brand-lockup.png`, il file del grafico. Ma è un *lockup* — mascotte
in una card più il lettering — e nessuna piattaforma lo mostra così: iOS ci applica una
maschera «squircle» e rifiuta il canale alpha, Android mostra solo il 66% centrale (il
lettering sparirebbe), a 16px di una figura intera non resta niente di leggibile. Ogni
piattaforma vuole un ritaglio diverso della stessa immagine, e `scripts/genera-icone.mjs`
(`npm run icone`, `npm run icone:native`) li produce tutti da quel file solo: master nativi,
favicon `.ico` multi-risoluzione, `apple-icon`, icone del manifest e anteprima dei link.

**Quattro difetti che solo la prova a video ha fatto emergere** — i primi tre sarebbero
arrivati fino allo store, l'ultimo fino ai genitori:

1. la figura intera nella maschera circolare di Android usciva **col mento tagliato**;
   ridotta e ricentrata, restava fuori un pezzo di **mano mozzata** nell'angolo. Nel primo
   piano dell'adaptive icon ora va la testa, che non ha appendici da troncare;
2. `ic_launcher.xml` avvolge i livelli in un `<inset 16.7%>`: **la safe zone la applica già
   lui**. Applicarla anche al contenuto la contava due volte e l'icona usciva minuscola. Il
   riferimento non è una regola a memoria ma l'icona precedente, il cui primo piano riempiva
   il 71% del PNG; la nuova ne riempie il 69%;
3. `capacitor-assets` lascia in `public/` un `manifest.webmanifest` che punta a `.webp`
   inesistenti — e **`public/` ha la precedenza sulle rotte di Next**, quindi quel file
   sostituiva il manifest vero. Il comando ora lo rimuove, ed è documentato nello script;
4. `/manifest.webmanifest` **passava dal middleware** e sarebbe stato rediretto al login: il
   browser lo scarica fuori dalla sessione e avrebbe letto l'HTML del login al posto del
   JSON. `webmanifest` è ora fra le estensioni escluse dal `matcher`, accanto a `favicon.ico`.

**Verificato**, non dedotto: gate completo verde (eslint · `tsc --noEmit` · 7003 test su 725
file · `npm run build`), e con l'applicazione servita davvero — `/manifest.webmanifest`
restituisce il manifest giusto con `application/manifest+json`, i tag `og:image`,
`twitter:card`, `icon`, `apple-touch-icon` sono presenti nell'HTML e i sette asset rispondono
`200`. Pesi ridotti dove contava: `icon.png` da 464 a 68 KB, l'anteprima link da 580 a 64 KB
(JPEG: sopra qualche centinaio di KB certi client rinunciano a mostrarla).

**Non toccato di proposito**: le schermate di avvio native, che mostrano ancora il logo
precedente su fondo verde. Sono fuori dal perimetro «icona», e passare da
`capacitor-assets` senza `--splashBackgroundColor` le riscriveva col fondo bianco — cioè una
regressione silenziosa; il colore è ora fissato nel comando.

⚠️ **Da controllare dopo il deploy**: `og:image` è assoluto e si costruisce su
`NEXT_PUBLIC_APP_URL` (ripiego `https://app.kidville.it`). La variabile esiste su Production
ma il suo valore è cifrato e non è stato possibile leggerlo da qui: va verificato sull'HTML
servito. WhatsApp e iMessage tengono in cache l'anteprima per dominio: per vederla subito si
forza dal debugger di Facebook.

---

## ✅ Changelog — Il resto del collaudo: l'app smette di dire «ok» quando non ha guardato 2026-08-04 (branch `fix/collaudo-residuo-g4-g8`)

Chiusura dei gruppi lasciati fuori dalla PR #63: prestazioni (G4), osservabilità (G5),
residuo notifiche (G6), rilascio e infrastruttura (G7), interfaccia (G8).

**Prima di correggere, i 65 rilievi residui sono stati riverificati uno per uno.** Il
risultato ha cambiato il piano: **49 erano ancora veri, 12 già chiusi, 6 sbagliati nei
fatti, 2 non verificabili.** Di quelli sbagliati, il più istruttivo è `T20-F3` («due
variabili d'ambiente presenti solo in produzione»), che era una deduzione presentata come
misura. Correggerli alla cieca avrebbe prodotto lavoro inutile su un difetto inesistente.

### Il tema comune, che non era nell'elenco dei rilievi

Cinque delle correzioni di questa voce sono lo stesso difetto sotto forme diverse: **un
sistema che dichiara un esito senza aver verificato di poterlo dichiarare.**

- il cron dei promemoria scriveva `notifiche-promemoria: ok` subito dopo aver preso
  `PGRST205` su una tabella che in produzione non esiste — ogni notte, dal 13 luglio;
- il digest marcava un'edizione `inviata_il` con zero destinatari quando la lettura degli
  indirizzi falliva, e l'edizione non ripartiva più: persa;
- `npm run build` non girava in nessun punto della CI, quindi «gate verde» significava
  tre comandi su quattro;
- le migrazioni in attesa di approvazione si accumulavano senza che nulla le drenasse: tre
  pulsanti armati su produzione, da 12, 35 e 140 ore;
- e la CI su `main` era **rossa** mentre il commit che l'aveva resa tale si intitolava
  «gate verde».

Nessuno di questi era un errore di distrazione. Erano tutti casi in cui la strada del
successo e quella del fallimento finivano nello stesso posto.

### Cosa è cambiato

| Rilievo | Prima | Ora |
|---|---|---|
| `T20-F5` | l'unico rilevatore di guasti in produzione era la telefonata di un genitore | `GET /api/health` misura cinque cose e sa dire di **no** su ognuna: DB leggibile dal service role, schema atteso presente, battito di ogni cron dentro la sua finestra, impronte d'errore attive, variabili critiche. 200 su `ok`, 503 su `down` |
| `T20-F2` · `T12-F3` | il battito diceva `ok` senza aver guardato | terzo stato `ok-parziale`, che **nomina** la scansione saltata. E la tolleranza non inghiotte più il `42703`: una colonna mancante è una migrazione a metà, cioè un guasto |
| `T12-F2` | 62 dei 176 punti di log del browser perdevano la pagina | il default è la pagina vera, **redatta** prima di partire — `/m/<token>` ha la credenziale nel path |
| `T12-F4` | i job SQL notturni scrivevano `ambiente` NULL, fuori dal filtro con cui si legge la tabella | `DEFAULT` sulla colonna, 6 righe recuperate (migr. `20260804103151`) |
| `T11-F3` | la stessa GET chiesta 5 volte a ogni apertura, e la **CI rossa** | promise-cache di modulo (lo schema che il repo aveva già scritto per il docente e mai portato al genitore) |
| `T11-F4` | l'elenco iscrizioni restituiva ogni domanda con il `data` completo: 514 kB | paginato, e il payload esce dall'elenco: **−89%**, ed è un guadagno di privacy prima che di peso |
| `T11-F5` | `limit=1000` ribattuto a mano in **10** file (il rilievo ne diceva 4) | costante condivisa + `X-Total-Count` + un `warn` quando il tetto morde |
| `T11-F6` | le due tabelle ponte avevano solo la PK composita | due indici, l'indice duplicato di `parents` rimosso, statistiche rinfrescate (migr. `20260804103025`) |
| `T17-F4` | il digest si dichiarava inviato a zero destinatari | distingue «zero famiglie» da «non ho potuto leggere», e nel secondo caso **rimanda** |
| `T01-F2` | `npm run build` non era in CI | è nel job `quality` |
| `T20-F4` | tre esecuzioni di `DB migrate (prod)` ferme da giorni | `cancel-in-progress`: ne resta una sola, sempre quella della testa di `main` |
| `T03-F5` | `app_log` dichiarava «nessuna FK su `scuola_id`, il log sopravvive alla cancellazione di una sede» | la FK c'era dal 31/07 **senza `ON DELETE`**: cancellare una sede era *bloccata* da una tabella di log. Ora `ON DELETE SET NULL` |

### Due migrazioni, applicate e **rilette dopo**

`20260804103025` (indici delle tabelle ponte, indice duplicato rimosso, FK di `app_log` con
`ON DELETE SET NULL`, `ANALYZE`) e `20260804103151` (`DEFAULT` su `app_log.ambiente`).

Lo stato è stato misurato **prima e dopo**, perché il 3 agosto tre operazioni avevano
dichiarato successo senza fare niente: indici 2→**4**, indice duplicato 1→**0**, FK
`confdeltype` `a`→**`n`**, righe con `ambiente` NULL 6→**0**, statistiche 21→**36** righe
stimate su 36 reali. Advisor: **0 ERROR**.

La prima stesura della seconda migrazione **non poteva funzionare**: apriva con
`ALTER DATABASE … SET app.ambiente`, e su Supabase il ruolo `postgres` non è superuser
(`ERROR 42501`). Il ripiego è un letterale, con il limite scritto nel `COMMENT` della
colonna invece che nascosto: se un giorno quella migrazione finisse sul database E2E, quel
database scriverebbe `'production'` nei propri log mentendo.

### Un errore mio, corretto da un esecutore

Avevo archiviato `T12-F4` come falso misurando che «zero righe hanno `sorgente='sql'`».
Quella query non poteva restituire altro che zero: `app_log_sorgente_check` ammette solo
`'server'` e `'client'`. Cercare un valore che lo schema vieta non è una misura, è una
definizione. L'esecutore ha rifatto la misura incrociando `pg_cron` con gli orari e ha
trovato che le 6 righe sono **esattamente** i due job notturni che il rilievo denunciava.

### La seconda ondata, e il modo in cui si è dovuta chiudere

Sette esecutori paralleli sono stati **interrotti dal limite di sessione a metà lavoro**, e
il loro codice è rimasto nell'albero senza che nessuno di loro potesse dichiarare la propria
prova di validità. È la stessa situazione del 2026-08-03, e la lezione di allora è stata
applicata: **si è partiti da una misura dell'albero, non dalle note.** Quello che si è
trovato, e che nessun report avrebbe detto:

- `DiaryTodayCard.tsx` era **sintatticamente rotto** — un agente è morto fra l'apertura e la
  chiusura di un'espressione JSX;
- `rateLimit` era diventata asincrona e **nessuno dei 21 chiamanti** era stato aggiornato;
- `tabellaMancante` era stata estratta in un modulo condiviso e tolta da `promemoria`, ma
  l'import non era mai stato aggiunto;
- `ChunkErrorBoundary` aveva un commento che spiegava perché `capture: true` è indispensabile
  — e il codice **non lo passava**. Sei test rossi lo dicevano;
- tre commenti citavano un lock (`tolleranza-schema-un-posto-solo`) **che non esisteva**;
- `BottomNav` importava due moduli che non usava: il difetto `T08-F2` era diagnosticato,
  documentato e **non applicato**.

Tutto chiuso con il gate verde, **tranne una cosa che è stata ritirata di proposito**. Le tinte
delle funzioni sono ora prese da una mappa unica (`src/lib/ui/tinte-funzioni.ts`) e il lock che
lo tiene fermo esiste davvero: la sua prova di validità è stata eseguita rimettendo un hex a
mano nella nav del docente, e il lock è diventato rosso.

### ⏸️ `T09-F1` resta APERTO: la correzione è stata scritta, provata in CI e ritirata

Il difetto è vero: con l'overlay di caricamento a schermo, il `Tab` raggiungeva comandi
invisibili su ogni pagina. La correzione — rendere inerte il contenuto sotto l'overlay — è
corretta in linea di principio e **sbagliata nell'effetto**, e due run di CI l'hanno dimostrato:

- con l'inerzia attiva, tutti e tre i `storageState` fallivano (campo email **vuoto**, password
  piena): nessuno spec girava;
- sistemata quella, cadevano `admin-search`, `public-iscrizione` e `teacher-diary` — percorsi
  diversi, stessa forma: `fill()` non lancia, «riesce», e il valore non entra.

Cioè: **ogni interazione entro la finestra di visibilità dell'overlay viene persa, su ogni
pagina.** In CI la finestra c'è quasi sempre (l'E2E gira su `next dev`); in produzione è più
rara ma non teorica — è la rete lenta, cioè un genitore col telefono davanti a scuola.

Si sarebbe potuto mettere un'attesa in ogni spec e far diventare la CI verde. Sarebbe stato il
modo di rilasciare un cambiamento che tocca ogni pagina avendo provato soltanto che *i test
smettono di lamentarsi*. La causa a monte è `MIN_VISIBLE_MS`: l'overlay resta 700 ms **anche
quando la pagina è già pronta**, ed è lì che va guardato. La ragione per esteso, con le due
strade per chiuderlo, è nel commento di `src/components/providers/GlobalLoader.tsx`.

La primitiva `src/lib/accessibility/inerti.ts` resta, provata, dove il perimetro è chiuso: in
`ui/Modal` e nel bottom-sheet della navigazione — che era anch'esso `T08-F6`/`T09`, e lì è
**chiuso**: il menu del telefono ora si comporta da dialogo (`role`, `aria-modal`, `Escape`,
focus che entra e torna).

### Il tetto per IP non è più indeterminato

`V5`. Il rilievo diceva «61 richieste senza un solo 429, il tetto non esiste». Misurato su
`app_log`, era **falso**: i 429 esistono e sono centinaia. Il difetto vero non era l'assenza
del tetto ma la sua **indeterminatezza** — il contatore viveva in una `Map` per-istanza, e su
Vercel il tetto effettivo era `N × limite`, con `N` il numero di lambda calde in quel momento.

Ora il contatore è su Postgres (`tetto_frequenza`, migr. `20260804124245`), con la decisione
presa in **un solo statement** (`INSERT … ON CONFLICT DO UPDATE … RETURNING`): due query
separate sarebbero una corsa critica, e N richieste simultanee passerebbero tutte.

La domanda vera era un'altra, e la risposta non è nessuna delle due ovvie: **se il database è
lento, il tetto si apre o si chiude?** Fail-closed trasformerebbe un rallentamento del DB in
un blocco delle iscrizioni, su una porta da cui arrivano ~9 domande l'ora da famiglie vere.
Fail-open trasformerebbe un attacco al DB in un varco. La scelta è la terza: **si degrada al
contatore locale** — chi tira giù il database non ottiene «nessun tetto», ottiene il tetto di
ieri — e ogni degrado lascia una riga a livello `error`, strozzata a una al minuto perché un
database giù non riempia `app_log` della propria diagnosi. Un guasto costa PRECISIONE, non
PROTEZIONE.

Verificato in produzione dopo l'applicazione: su un tetto di 3, tre colpi passano e il quarto
è respinto con `riprova_fra_ms` coerente con la finestra.

### Tre lock hanno fatto il loro mestiere

`gate-coverage` ha preteso che `/api/health` fosse **dichiarata** pubblica con la ragione
scritta (e il tetto dell'allowlist **sale** per la prima volta: 14 → 15);
`isolamento-sede-coverage` ha preteso l'aggiornamento dei conteggi;
`testo-muted-allowlist` ha colto due righe nuove scritte nel grigio a basso contrasto — fra
cui, ironicamente, proprio l'avviso «mostrate N di TOT» introdotto in questo stesso lavoro
per segnalare il troncamento.

E `logging-tetto` ha colto una **terza primitiva di tetto** che stava nascendo dentro
l'endpoint di salute. La correzione non è stata dichiararla: è stata usare quella che
c'era già.

---

## ✅ Changelog — Il lavoro interrotto, ripreso e PROVATO: gate verde, 4 test rossi chiusi, 8 rilievi privacy/sicurezza 2026-08-03 (branch `chore/conferme-umane`)

**Questa voce sostituisce quella qui sotto**, che descriveva il lavoro come interrotto e a metà.
La ripresa è partita da una **misura dell'albero**, non dalle note — ed è stata la decisione più
utile della giornata: **le note erano sistematicamente in ritardo sul codice**. `X1`, `X2`, le
difese dei test contro la produzione, `T17-F1/F2/F3` e l'N+1 degli avvisi risultavano «non chiusi»
ed erano **già scritti**. Mancava la *prova*, non il codice.

### Il gate, adesso
`tsc --noEmit` ✅ · `eslint --max-warnings 0` ✅ · `vitest` **705 file / 6812 test, 0 rossi** ✅ ·
**`npm run build` ✅** — il comando che nella sessione interrotta non era mai stato eseguito.

### I 4 test rossi, chiusi per la ragione giusta
- **Un bug vero, non in nessuno dei 95 rilievi**: `media-bozza.ts` chiedeva l'URL pubblico al bucket
  di SOSTA dopo aver spostato il file in quello pubblico. `percorsoPubblicoNews` riconosce solo il
  marcatore di `news`, quindi **revoca, oblio e DELETE non trovavano più la foto del bambino**,
  che restava pubblica. Stessa classe di `V4`/`W1`/`X1`, rientrata dalla porta della promozione.
  Impatto misurato in produzione: 3 post, 0 con l'indirizzo sbagliato — latente, non incidente.
- `push-dispatch`: il test fissava il **difetto** `T17-F3` (push saltate *e* marcate come inviate).
- `errori-con-codice`: risposta nata con `T17-F2` senza codice e col messaggio grezzo del database.
- `catch-muti-allowlist`: `native-register` ripulito → voce tolta, tetti 58→57 e 88→87.

### La verifica adversariale: 6 voci su 7 erano già integre
Smontate con le cinque manomissioni del collaudo. `X1` (esclusi → un id solo) → 4 rossi su oblio e
revoca; `X2` (via il `global.fetch`) → 4 rossi, uno aspetta 30 s; `W7r` (×10 sui tetti, poi via
l'`AbortSignal`) → 14 rossi, tre aspettano davvero 5 s; `W34r` (sede dell'operatore invece del
media) → 7 rossi, la fixture separa le due sedi; `W8r` (passi post-auth fuori dal budget) → 10+
rossi. Riscritto il **caso perso**: «una foto sola, la sanificazione lancia» — saltando il ramo
senza ciclo cade **un test solo**, quello nuovo: gli altri 17 promuovono due media ed erano ciechi
sul caso più comune in produzione.

**`W9r` era l'unico rilievo vero, e diverso da come era scritto**: il test «nessun cookie nei log»
non è finto, *non esiste*, e la bonifica il cookie non lo toglieva. `sb-<ref>-auth-token` finisce
per `token=` — famiglia già coperta — ma il nome ammetteva solo `[A-Za-z0-9_]` e quello ha i
trattini. Terza volta che quel file impara la stessa lezione: prima i VALORI, poi i NOMI, ora
l'**alfabeto** del nome. Quel valore *è* la sessione. Esposizione reale: 1919 file, **0** con un
cookie in chiaro — correzione preventiva.

### Privacy e sicurezza (G1/G2)
- **`V1`** — `enrollment_submissions.consents_log` conserva ip e userAgent su **170 righe su 263**;
  l'oblio riscriveva `data` e lasciava quella colonna intatta. Ora si tolgono ip e userAgent e
  restano `accettato_il`/`versione_informativa`/`blocchi`, che sono la prova (art. 5 §2, 7 §1).
  *Il rilievo era esatto: l'avevo prima archiviato come sbagliato cercando una tabella con quel
  nome, che non esiste — è una colonna.*
- **`V2`** — trovata cercando `V1`: **`push_subscriptions`** (77 righe, 77 user-agent, 4 utenti) non
  era nominata neppure una volta nell'oblio. Ora la riga si cancella: l'`endpoint` è il recapito di
  quel telefono, e lasciarlo significa che il dispositivo di chi se n'è andato continua a ricevere
  le notifiche della scuola.
- **`V3`** — due decisioni del titolare a un giorno di distanza che si contraddicono («nessuna
  retention» il 31/07, «24 mesi» il 01/08). Le 93 domande raccolte senza informativa sono escluse
  dalla cancellazione automatica e il rinvio si vede con un `warn`. **Resta una decisione umana.**
- **`T06-F2`** — l'informativa non diceva per quanto si conservano le domande non accolte. Aggiunta
  la voce (24 mesi) **più un lock** che tiene allineati il testo pubblico e `MESI_CONSERVAZIONE`.
- **`T06-F4`** — «chi ha visto i dati di mio figlio?» non aveva risposta: si annotavano solo i
  tentativi respinti. Ora l'accesso riuscito lascia una riga persistita, senza il percorso.
- **`T06-F5`** — 93 famiglie mai informate, 119 indirizzi. Testo e query **pronti e NON inviati**:
  `docs/privacy/2026-08-03-informativa-tardiva-93-domande.md`. Serve una decisione del titolare.
- **`V5`** — `iscrizione/model:GET`, pubblica e anonima, apriva un client service-role e ci
  **scriveva**. Tolta la scrittura, aggiunto il tetto per IP.
- **`T04-F1`** — 14 funzioni di `public` eseguibili con la chiave pubblica. **La prima migrazione ha
  risposto `success` e non ha cambiato niente**: l'ACL era `{=X/postgres,…}`, cioè PUBLIC, e
  `REVOKE ... FROM anon` toglie un permesso che non c'è. A smascherarlo è stato rileggere i permessi
  DOPO. Gravità corretta **verso il basso**: nessuna è `SECURITY DEFINER`, la RLS reggeva comunque.
- **`T01-F1`** — Next **16.2.4 → 16.3.0**, che chiude il *Middleware/Proxy bypass in App Router*.
  In questo repo `src/middleware.ts` **è** il gate di autenticazione. 13 → 10 vulnerabilità.
  Restano dichiarate: `sharp` e `xlsx` (nessun fix a monte) e la catena `@capacitor/cli`, che è
  build tooling e non finisce nel bundle.

### Migrazioni
Disco e produzione **allineati a 94** (erano 93 vs 94: il no-op era stato applicato e non
esisteva su disco). Il file del no-op resta nel repo, con scritto perché non ha funzionato:
cancellarlo lascerebbe in `schema_migrations` una riga che nessuno sa spiegare.

### La lezione, che vale più delle correzioni
Tre volte in questa giornata un'operazione ha **dichiarato successo senza fare niente**: la
migrazione `REVOKE FROM anon`, un mio `echo "TSC OK"` stampato anche a `tsc` rosso (commit
`743dd76`), e — nel lavoro del giorno prima — la bonifica che contava i file selezionati invece di
quelli cambiati. L'unica cosa che le ha smascherate tutte e tre è **rileggere lo stato dopo**.
Un test che non hai visto fallire non sai se funziona; un comando che non hai riletto non sai se
ha fatto qualcosa.

---

## ⏹️ Changelog — Correzione del collaudo dei 20 tester: LAVORO A METÀ, interrotto dal limite settimanale 2026-08-03 (branch `chore/conferme-umane`)

**Questa voce sta in testa perché è quella che cambia come si leggono tutte le altre.** Le voci di
changelog qui sotto descrivono correzioni **reali e presenti nel codice**, ma in gran parte
**non verificate fino in fondo**: la sessione si è fermata a metà, con 36 agenti su 58 interrotti.

**Da dove veniva.** Nella notte fra il 2 e il 3 agosto sono girati **20 tester indipendenti** sul
commit `45491e6`. Diciannove hanno consegnato (manca il 15, iOS), tutti `FAIL`: **4 bloccanti,
45 gravi, 41 minori, 175 warning** — 90 rilievi. Dieci verificatori adversariali hanno poi riletto
il codice vero: **tutti e quattro i bloccanti sono scesi a `grave`** (nessuno è caduto, ma nessuno
reggeva la soglia «non si rilascia così»), e in cambio sono emersi **cinque difetti che nessun
tester aveva visto**, tre peggiori di quelli da cui erano partiti.

**Cosa è chiuso e provato: 12 rilievi.** Ognuno verificato **rimettendo il difetto** e controllando
che il test tornasse rosso. Fra questi: i tag di minori che attraversavano il confine di sede, le
foto pubblicate scavalcando il gate del consenso, la pagina offline che crollava, il login che
accusava l'utente quando il guasto era il database, i provider senza tetto (**misurato: 150 secondi
appeso senza mai un errore**), e `esegui.sh` — che **non ha mai lanciato un collaudo Maestro**, per
un array vuoto sotto `set -u` su bash 3.2: ogni verifica Android precedente era alla cieca.

**Cosa NON è chiuso: 11 voci a metà e 65 mai aperte.** Elenco completo, con lo stato di ciascuna, in
`docs/collaudo/risultati/000-SINTESI.md` (fuori da git: può contenere estratti del database di
produzione). Le due da guardare per prime:

1. 🔴 **Una regressione introdotta oggi e non ancora chiusa.** La correzione che impediva di
   cancellare i file di un altro post ha creato il difetto **opposto**: `percorsiCitatiDaAltriPost`
   esclude **un solo** post, quindi due articoli che condividono la copertina non liberano più
   niente. Tradotto: **il diritto all'oblio non toglie la foto del bambino** in quel caso. Va
   completata (un *insieme* di id da escludere, non uno).
2. 🔴 **I test potevano parlare con la produzione.** `src/lib/supabase/public-config.ts:20` ha
   l'indirizzo del Supabase di produzione **cablato come ripiego**, e `NEXT_PUBLIC_SUPABASE_URL`
   non è impostata nella shell di sviluppo. È stato aggiunto `env` a `vitest.config.ts` per forzare
   `localhost`, ma le due difese che quel commento promette — la guardia su `globalThis.fetch` e il
   lock `nessun-bersaglio-di-produzione.test.ts` — **non esistono ancora**.

**Stato del gate al commit**: `tsc` pulito · `eslint` 0 errori 0 warning · `vitest` **5 rossi su
6791** (695 file su 699) · `npm run build` **non eseguito** · E2E non eseguito · **nessuna migrazione
applicata, database di produzione mai toccato**. I 5 rossi sono descritti uno per uno nella sintesi:
due sono lock di contabilità, due sono comportamento da capire, e uno **fissa il comportamento
sbagliato** (le push saltate in silenzio e marcate come inviate) — lì il rosso potrebbe essere il
progresso.

**La lezione, che vale più delle correzioni.** Su 19 correzioni verificate adversarialmente
**11 non hanno retto al primo giro**, e oltre **20 test si sono rivelati finti**: restavano verdi
quando si toglieva ciò che dichiaravano di proteggere. Un verificatore ha chiamato un gate
**buttandone via il verdetto**: il lock d'architettura, che cerca il *nome* della funzione, è
rimasto **verde**. Un altro ha scoperto che una fixture usava lo stesso valore per la sede del
media e per quella dell'operatore: separandole, **2295 test** non distinguevano più niente.
*Un lock che cerca un nome è una rete a maglie larghe: ciò che tiene sono i test di comportamento.*

---

## 🗓️ Changelog — La porta di ogni richiesta non aveva tetto, sei route non avevano osservabilità, e per mezza giornata i test hanno parlato con la produzione 2026-08-03 (branch `chore/conferme-umane`)

**La strada più larga di tutte era rimasta scoperta.** `src/middleware.ts` costruiva il proprio
client Supabase **senza `global: { fetch }`** e subito dopo faceva `await supabase.auth.getUser()`.
Il `matcher` copre tutto tranne gli asset statici: **ogni pagina e ogni route API passa di lì
prima** di arrivare al codice protetto. È letteralmente lo scenario che `supabase-fetch.ts` cita
per motivare il proprio tetto — «se GoTrue accetta e tace, senza tetto nessuna route risponde
più» — su un percorso col raggio d'azione massimo. Ora il middleware prende il tetto dalla
primitiva condivisa (`@/lib/logging/tetto`, che non importa niente e gira anche sull'Edge): **15 s
di BUDGET sull'intera sequenza**, non per chiamata — `getUser()` fa **due** giri di rete (rinnovo
del token, poi `/user`), e con un tetto per chiamata il caso peggiore sarebbe il doppio. Degrada
**fail-closed** (redirect al login, non un 500 e non un passaggio libero) e lascia **una riga**,
`KV_ERR … evt=auth code=timeout|rete`, scritta a mano perché sull'Edge il logger non si carica.

**Sei route costruivano il proprio client con `createClient` di `@supabase/supabase-js`** —
`admin/regenerate-credentials`, `admin/credentials-pdf`, `admin/students/[id]`,
`admin/backfill-auth`, `admin/test-relations`, `admin/wipe` — cioè **muto e senza tetto**: nessuna
riga quando PostgREST risponde 4xx a una scrittura che il codice non guarda (AGENTS.md, regola 7),
nessuna scadenza quando il bersaglio accetta e tace. Fra quelle sei, le **due che gestiscono le
credenziali dei genitori**: il percorso da cui nasce l'intera regola 3. Tutte e sei portate a
`createAdminClient()`. **Un cambio di comportamento dichiarato**: `admin/students/[id]` perde il
ripiego sulla chiave anon e ora risponde **503 «configurazione mancante»** invece di un **403**
che travestiva un guasto di configurazione da esito applicativo — con il suo test, in entrambi i
versi. Resta una deroga: `admin/apply-enrollment-migration` (sei `fetch` a mano; `/pg/query` non
ha equivalente in supabase-js, ed è `sealDangerous` → 404 in produzione).

**🔴 E per mezza giornata la suite ha avuto come bersaglio la produzione.** Portando le sei route
al factory, sotto `vitest` hanno cominciato a puntare a `uimulkjyekgemjakmepp.supabase.co` — il
database con **227 domande d'iscrizione e 152 codici fiscali di minori**. La catena: `SUPABASE_URL`
(`public-config.ts`) ha un ripiego hard-coded sulla produzione, **serve** ed è codice di produzione;
è una `const` valutata **all'import**; sotto vitest `.env.local` non viene caricato; e i test che
«dirottavano su localhost» scrivevano `process.env` nel `beforeEach`, cioè **troppo tardi**. A
fermare il danno era rimasto solo il fatto che la chiave di servizio, in quel momento, fosse
assente: con una `SUPABASE_SERVICE_ROLE_KEY` vera in ambiente, `npx vitest run` avrebbe eseguito
`auth.admin.updateUserById` (il reset della password di un genitore) e il ciclo di **DELETE su 25
tabelle** di `admin/wipe` contro i dati veri. Chiuso con **tre difese**: `test.env` in
`vitest.config.ts` (URL e chiavi finti prima di ogni import — verificato che sovrascrivono anche
l'ambiente di shell), una **guardia su `globalThis.fetch`** in `test/setup.ts` che **lancia** su
quell'host, e il lock nuovo `__tests__/architecture/nessun-bersaglio-di-produzione.test.ts`, che
misura tutte e tre e **dichiara cosa non copre**. `public-config.ts` **non** è stato toccato.

**Due lock nuovi, e cinque aggiramenti chiusi dopo che un verificatore adversariale li ha
dimostrati uno per uno.**

1. **`__tests__/architecture/supabase-client-strumentato.test.ts`** — un client server-side nasce
   in un posto solo. Aggirabile in tre modi, tutti da una riga, tutti ora chiusi: un factory in
   forma di **arrow function** (`export const … = async () =>`) era invisibile allo scanner, e
   `blocchi.size >= 4` reggeva coi cinque vecchi → ora si pretende anche che **ogni**
   `createServerClient(` del file cada dentro un blocco riconosciuto; un **barrel**
   (`export { createClient } from '@supabase/supabase-js'`) non è un `import` e non veniva visto →
   ora le ri-esportazioni contano come gli import; e `globalThis.fetch(` sfuggiva perché la regex
   escludeva il punto — **un'esclusione scritta per non far diventare rosso il middleware, che
   apriva il buco a tutti gli altri file** → ora il middleware sta fra le deroghe **dichiarate**,
   con la sua ragione, e l'esclusione non copre più nessuno.
2. **Il limite dei 30 secondi si aggirava scrivendo il tetto come espressione.** L'inventario
   leggeva solo i letterali (`([0-9_]+)`): un `const TETTO_LENTO_MS = 15 * 60 * 1000` — mezz'ora,
   funzionalmente nessun tetto — non entrava mai nel confronto. Ora si cattura l'**espressione** e
   la si valuta; ciò che non è aritmetica di numeri diventa **rosso**, non invisibile.
3. **Il test del budget del middleware misurava la grandezza sbagliata.** Leggeva `tetto=` dalla
   **riga di log**, cioè il numero *dichiarato*, non quello *applicato* al `signal`: due
   manomissioni distinte (tetto per chiamata spacciato per budget; tetto su **una sola** delle due
   chiamate a GoTrue, lasciando il rinnovo del token senza scadenza) lasciavano **49/49 verdi**.
   Ora una spia su `AbortSignal.timeout` associa ogni signal ai millisecondi chiesti, e il test
   incrocia i due — **per identità del signal, non per ordine** — e pretende che la riga dichiari
   lo **stesso** numero che è finito sulla `fetch`.
4. **Sedici test preesistenti erano diventati rossi** (`regenerate-credentials`,
   `credentials-pdf-scope-sede`, `regenerate-credentials-bucket-log`): il loro
   `vi.mock('@supabase/supabase-js')` non intercettava più niente, e rispondevano 404 perché il
   client **vero** interrogava un database che nei test non c'è. Riparati mockando **entrambi** i
   moduli, con il finto client scritto **una volta sola**.

**Prove di validità** (ogni difetto rimesso, e tolto): tetto per chiamata → rosso · tetto su una
sola strada → rosso · sesto factory in arrow function senza `fetch` strumentato → rosso · barrel
`sdk.ts` → rosso · `globalThis.fetch` verso Supabase in `test-relations` → rosso ·
`TETTO_LENTO_MS = 15 * 60 * 1000` → rosso · `test.env` rimosso → **4 rossi**, fra cui la sonda che
vede il client puntare alla produzione · guardia disarmata → il test è arrivato **davvero** a
`uimulkjyekgemjakmepp` (401 senza chiave, sola lettura) · `global: { fetch: fetchStrumentato }`
tolto da `createAdminClient` → rosso, **i mock non nascondevano la regressione** ·
`requireEnv('SUPABASE_SERVICE_ROLE_KEY')` riportato all'URL → il 503 torna 200, rosso.

**File**: `src/middleware.ts` · le sei route `src/app/api/admin/**` · `src/lib/logging/tetto.ts` ·
`vitest.config.ts` · `test/setup.ts` · lock in
`__tests__/architecture/supabase-client-strumentato.test.ts`,
`__tests__/architecture/nessun-bersaglio-di-produzione.test.ts`,
`__tests__/lib/middleware-tetto.test.ts`, `__tests__/lib/logging-tetto.test.ts`,
`__tests__/api/anagrafica-scope-sede.test.ts` e i tre file di test riparati.
**Nessuna migrazione, nessuna variabile d'ambiente nuova in produzione** (le due di
`vitest.config.ts` esistono solo sotto test). Logging: la riga del middleware distingue
`code=timeout` («non risponde») da `code=rete` («non si raggiunge»), porta l'`x-request-id` che
correla con `withRoute` a valle, e riduce il path a **pattern** — in questo repo il path è una
credenziale (`/m/<token>`) e gli id dei minori sono segmenti di rotta.

---

## 🗓️ Changelog — Il tetto di tempo: il numero che si logga non era quello che scatta, e il lock si aggirava con un alias 2026-08-03 (branch `chore/conferme-umane`)

**Dove sta oggi il tetto di tempo su una `fetch`.** Il meccanismo vive in un posto solo,
`src/lib/logging/tetto.ts` (`conTetto` · `tettoSano` · `eTimeout` · `erroreTimeout`), e lo usano
tutte e quattro le strade: i 13 provider esterni (`logging/external.ts`), tutte le chiamate
PostgREST/Storage/auth (`logging/supabase-fetch.ts`), il middleware — la porta di ogni pagina e
di ogni route — e il calcolo del codice fiscale, che gira nel browser. I **numeri** restano
accanto alla loro ragione, in due tabelle **esportate** apposta perché un lock possa scorrerle:
`TETTI_MS_PROVIDER` (instagram 4 s, aruba 30 s, default 10 s) e `TETTI_MS_AREA` (storage 20 s,
default 15 s).

**La valvola del chiamante ha un limite superiore, e prima non ce l'aveva.** `tettoMs('resend',
3_600_000)` restituiva 3.600.000: un'ora, cioè funzionalmente nessun tetto, perché a tagliare
tornava la piattaforma. Adesso il richiesto viene tosato a `TETTO_MS_MAX` — **30 s** sui provider
(il valore di `aruba`, la deroga più larga), **20 s** su Supabase (il valore di `storage`). Il
`massimo` tosa il **richiesto** e **non il ripiego**, deliberatamente: il ripiego è il valore della
tabella, e su quello l'ancoraggio è un test che lo misura — tosarlo qui lo renderebbe verde per
costruzione, cioè una rete che nasconde il buco invece di segnalarlo.

**Sull'auth il tetto è di UN TENTATIVO, non della chiamata.** `@supabase/auth-js` avvolge qualunque
eccezione del fetch — la nostra scadenza compresa — in un `AuthRetryableFetchError`, e
`_refreshAccessToken` ritenta finché `Date.now() + backoff − inizio < 30_000`. Con 15 s di tetto
fanno **due tentativi, ~30,2 s**: il doppio di quanto il commento dichiarava. Il numero è ora
scritto dove prima si leggeva «15 s», ed è **calcolato dal test** sull'aritmetica letta nel
sorgente del pacchetto vero, non ricopiato.

**Cosa è stato corretto in questo giro (secondo passaggio del verificatore adversariale).**

1. **Il numero LOGGATO non era ancorato al numero APPLICATO.** Sono due grandezze diverse che
   condividevano una variabile, e ogni asserzione era un `toContain('250')` su un messaggio nato da
   quella stessa variabile: scollegandole con un `tetto * 10` **tutti e 83 i test restavano verdi**.
   In produzione significa che `app_log.messaggio` e l'errore consegnato al chiamante dichiarano un
   tetto che non è quello scattato — cioè mandano a cercare «il tetto è troppo stretto» quando è
   vero «il bersaglio è morto», che è precisamente la distinzione per cui `erroreTimeout` esiste.
   Adesso il tetto applicato si **spia** su `AbortSignal.timeout` e quello dichiarato si **estrae**
   dal testo (`/tetto di (\d+) ms/`), e si confrontano fra loro. **Prova di validità**: rimessi i
   `tetto * 10` (external.ts, supabase-fetch.ts ×2) e `TETTO_MS * 3` (fiscalCodeApi.ts) →
   **7 test rossi**; ripristinati → 86 verdi.
2. **Il lock si aggirava con un alias.** Cercava la stringa letterale `AbortSignal.timeout`:
   `const { timeout: scadenza } = AbortSignal` e `AbortSignal['timeout'](…)` sono lo stesso
   meccanismo e non venivano visti — misurato, 32/32 verdi con mezz'ora di attesa in un file nuovo.
   Ora il rilevatore è per **regex, in tutte le grafie**, e si prova su sé stesso (riconosce le tre
   evasioni, non si accende su `const { timeout } = opzioni`).
3. **Esisteva una TERZA primitiva, non dichiarata.** Allargando il lock è saltato fuori che
   `src/app/offline/script-offline.ts` assembla un tetto a mano (`new AbortController()` +
   `setTimeout(() => …abort())`) da settimane. Non è un condono: è **dichiarata** col suo perché —
   è la sola pagina che deve funzionare senza il bundle di Next e su WebView dove
   `AbortSignal.timeout` non esiste, e la sua sonda esiste due volte (TS + stringa ES5 inlinata).
   Il lock ora vede anche questa forma. **Prova di validità**: ricreato
   `src/lib/notifiche/consegna-lenta.ts` nelle tre varianti misurate → tutte e tre rosse
   (variante `AbortController` **3 rossi**, i due alias **2 rossi** ciascuno); file rimosso.
4. **L'inventario dei tetti dipendeva dal NOME della costante.** Pretendeva `const TETTO…_MS`:
   un tetto da mezz'ora chiamato `SCADENZA_CONSEGNA_MS` non entrava né nel controllo «nessuno è
   smisurato» né nel confronto con i file dichiarati — e infatti aveva già lasciato fuori
   `TIMEOUT_SONDA_MS`. Ora il filtro è sulle **parole di scadenza** (`TETTO`, `TIMEOUT`,
   `SCADENZA`, `ATTESA`); `MS` da solo è stato **escluso di proposito** (tirerebbe dentro
   `DEDUP_MS`, `FINESTRA_MS`, `MS_GIORNO` e i ritardi anti-flash della UI: otto voci di rumore, e
   un inventario che chiede di dichiarare tutto smette di essere letto). Non lascia un buco, perché
   un tetto non è un numero: è un numero **più un meccanismo**, e i tre meccanismi sono coperti.
5. **Nessuno enumerava le `fetch` NUDE lato server.** Il lock elencava i consumatori del tetto ma
   non il complemento: una strada nuova nasceva invisibile. Ora `FETCH_SENZA_TETTO` chiude
   l'elenco su `src/app/api/**` + `src/lib/**` — **11 voci**, dieci di browser verso nostre route
   (dove il tetto vive dentro la route) e una di **debito dichiarato**,
   `admin/apply-enrollment-migration/route.ts` (già motivata in
   `supabase-client-strumentato.test.ts`, mitigata da `sealDangerous`: 404 in produzione).
6. **Il lock sul commento dell'auth era sbagliato nei due versi.** Troppo stretto sulla grafia
   (vedeva solo «~30,2 s», non «circa 15 secondi»); troppo largo sul perimetro (qualunque «~N s»
   innocuo altrove nel file lo faceva diventare rosso, e un lock che si accende sui commenti
   innocenti viene indebolito invece che corretto). Ora si ritaglia il **solo blocco dell'auth** e
   si guardano le sole frasi che dichiarano un **totale**. **Prova di validità**: inserita
   «il tetto complessivo dell'accesso resta di circa 15 secondi» → rosso; aggiunto un «~5 s»
   innocuo altrove nel file → resta verde.
7. **Gate sbloccato**: `npx eslint __tests__/lib/logging-tetto.test.ts --max-warnings 0` era rosso
   per un helper morto (`codice()`, mai chiamato) — da solo bastava a bloccare il rilascio. Rimosso.

**File**: `src/lib/logging/tetto.ts` · `src/lib/logging/external.ts` · `src/lib/logging/supabase-fetch.ts` ·
`src/lib/utils/fiscalCodeApi.ts` · `src/middleware.ts` · lock in `__tests__/lib/logging-tetto.test.ts`,
`__tests__/lib/logging-external.test.ts`, `__tests__/lib/fiscal-code-api.test.ts`,
`__tests__/lib/middleware-tetto.test.ts`, `__tests__/lib/auth-tetto-accesso.test.ts`.
**Nessuna migrazione, nessuna variabile d'ambiente nuova.** Logging: la scadenza ha un codice suo
(`app_log.codice = 'timeout'`) e un nome proprio per il raggruppamento di `get_runtime_errors`,
distinto da «la rete non si raggiunge» — che si ripara in un modo opposto.

---

## 🗓️ Changelog — Si poteva far cancellare l'immagine di un altro articolo, anche di un'altra sede 2026-08-03 (branch `chore/conferme-umane`)

**La correzione di W1 (la copertina sostituita che restava nel bucket pubblico) ha introdotto una
falla**, ed è la voce più urgente di questo giro perché è l'unica che ha peggiorato lo stato del
repo. Dimostrata **eseguendola**, non deducendola.

Il bucket `news` è pubblico: l'indirizzo dell'immagine di un altro articolo lo conosce chiunque
legga il sito, e `/api/news/feed` lo distribuisce in chiaro. Bastavano due mosse, entrambe
legittime prese da sole:
1. un educator mette quell'indirizzo nel `contenuto_json` della **propria** bozza → `200`, riga
   scritta, nessuna rimozione;
2. una seconda `PATCH` toglie quel nodo → il percorso della vittima finisce fra gli `usciti` →
   `remove()` in **service-role** sul file altrui.
La riga della vittima continua a nominarlo: **immagine rotta, permanente e invisibile** — e nemmeno
la revoca del consenso o l'oblio possono più farci niente, perché arrivano su un file che non c'è
più. Stessa cosa via `DELETE`, su tutta la riga, e via **ritiro del tick** dichiarando nel proprio
post un bambino il cui consenso è caduto.

**Causa**: `percorsoPubblicoNews` valida la **forma** dell'indirizzo (`uploads/<utente>/<file>`),
mai la **proprietà**. La risposta era già scritta due volte in questo repo — la testata di
`EsitoPromozione.promossiPercorsi` («annullare a occhio significherebbe cancellare l'immagine di
qualcun altro») e `rimuoviSeNessunAvvisoLoUsa`, che prima di cancellare l'allegato di un avviso
chiede se un altro avviso lo referenzia — e non era stata portata qui.

**Correzione, in un posto solo.** `percorsiCitatiDaAltriPost` risponde a «c'è ancora qualcuno che
lo nomina?» e vive **dentro `liberaPercorsiPubblici`**, cioè nell'imbuto da cui passano tutte e tre
le strade (`PATCH`, `DELETE`, `ritiraPost`). Ricerca larga (`copertina_url`, `contenuto_html`,
`contenuto_testo`, a lotti di 8 percorsi) e **conferma esatta riga per riga**, perché i due modi di
sbagliare sono opposti: troppo stretto si cancella il file di un altro, troppo largo non si libera
più niente e tornano i file pubblici orfani del difetto V4. Il file che un'altra riga nomina resta
dov'è e l'operazione **prosegue**: è il file che non si tocca, non l'operazione. Guasto di lettura o
tetto raggiunto ⇒ «non lo so», che qui non vale «cancella»: `503` e log `error`.

**Difesa complementare, in aggiunta e non al posto**: `percorsiPubbliciEstranei`, usata da
`news/[id]:PATCH`, rifiuta con `403` + codice `NEWS_MEDIA_ESTRANEO` (tradotto IT/EN) un corpo che
cita indirizzi pubblici che il post non nomina già **e** che non ha caricato chi sta scrivendo. Il
secondo ramo non è un allentamento: finché la migrazione del bucket privato `news_bozze` non è
applicata, `news/upload:POST` ricade sul bucket pubblico e restituisce già un indirizzo pubblico —
senza quel ramo, su quegli ambienti nessuno potrebbe più aggiungere un'immagine a un articolo.

**Prova di validità** (rimesso il difetto, uno alla volta): senza la domanda sulla proprietà →
9 test rossi nel modulo e 5 sulle rotte; controllo **troppo largo** (difetto V4) → 19 rossi nel
modulo e 20 sulle rotte, fra cui tutti i controlli positivi; senza la difesa complementare → 2
rossi; senza i lotti → 1 rosso. Fixture separate apposta: «il post che si modifica», «il post che
possiede il file» e «chi ha caricato» sono tre grandezze distinte, con valori distinti.

---

## 🗓️ Changelog — La rete che teneva un ramo su tre, e una frase tradotta che nessuno vedeva 2026-08-03 (branch `chore/conferme-umane`)

Terzo giro del verificatore adversariale, sulle correzioni del giro precedente. **Il codice era
giusto: erano i test a non saperlo dimostrare** — e questo è il modo in cui una correzione muore
senza che nessuno se ne accorga, perché la prossima riscrittura la disfa col gate verde.

**La sede della riga di `segnalazioni` era provata per UN ramo su tre.** Il changelog qui sotto
diceva che la sede si deduce dall'oggetto per tutti i tipi; vero nel codice, ma solo il ramo
`media_galleria` aveva un caso che sapesse diventare rosso. Per `voce_diario` **nessun caso**
guardava la `scuola_id` della riga; per la sezione in comune la fixture usava `SEDE_A` sia per il
bambino-ponte sia per il primo plesso del segnalante — le due grandezze coincidevano, quindi
sostituire il ponte con `sedi[0]` restava verde; per il ripiego di `messaggio_chat` la tabella
`utenti` non era popolata, quindi `sedeDiUtente()` rispondeva sempre `null` e **invertire i due `??`
non faceva rosso niente**. Le fixture ora tengono separate le grandezze e le incrociano: una seconda
maestra (`DOCENTE_B`) che insegna nell'altro plesso, il bambino della sede B con una sezione propria,
e i due casi di chat con le sedi scambiate (bambino in B con maestra in A, bambino in A con maestra
in B) — così l'inversione fa rosso in tutti e due i versi, non solo in quello scritto per primo.

**E la sede dei DESTINATARI della notifica non era legata a niente.** Nei 201 con staff la sede
primaria di chi segnala coincideva sempre con quella dell'oggetto, e i casi bi-sede usavano un
genitore, che una sede primaria non ce l'ha: con quelle fixture
`staffScuola(supabase, segnalante.scuola_id ?? scuolaId, …)` restava verde. È l'altra metà del
guasto «la riga esiste, nessuno la vede»: una segreteria di Aversa che segnala una foto di Giugliano
avrebbe archiviato la riga a Giugliano e avvisato la Direzione di **Aversa**. Ora c'è un caso con
operatore bi-sede (primaria A, scope `[A, B]`, media in B) che asserisce insieme la sede della riga,
il destinatario di `staffScuola` e lo `scuolaId` dell'evento.

**`erroreSegnalazioneSenzaPlesso` era una frase irraggiungibile.** Il codice `SEGNALAZIONE_SENZA_PLESSO`
era dichiarato, tradotto in due lingue e documentato — e i due soli chiamanti
(`SegnalaContenuto`, `ChatConversationMenu`) il corpo della risposta non lo leggevano: `setErrore(true)`,
e a schermo usciva sempre la frase generica. Il lock `errori-con-codice` non poteva vederlo: il
codice c'era, le traduzioni pure; a mancare era il tratto fra il catalogo e lo schermo, che nessuno
misurava. Ora il corpo si legge — con `messaggioSoloCatalogo`, **non** con `messaggioErrore`, e
la differenza è deliberata: la prosa di questa route comprende «oggetto_id obbligatorio per questo
tipo di segnalazione», testo da log, con il nome di un campo dentro e italiano per costruzione;
davanti a un genitore con l'interfaccia in inglese sarebbe il fallimento F2 del collaudo del
2026-07-31 riaperto in una schermata nuova. Quindi: codice dichiarato ⇒ frase del catalogo; niente
codice ⇒ la frase del componente, che passa da `useTranslations`; **mai** la prosa del server. Il
legame è misurato in `__tests__/components/segnalazione-errore-tradotto.test.tsx`, che legge il
`role="alert"` nelle due lingue e ha il suo controllo negativo.

**Il lock `numeri-con-locale-esplicito` era più stretto del proprio titolo.** Fermava
`toLocaleString(undefined, …)` e lasciava passare `new Date(x).toLocaleDateString()`,
`n.toLocaleString()` e `new Intl.NumberFormat()` — stesso identico difetto, e per giunta la forma
che viene in mente per prima. Un lock che ferma la variante rara e lascia passare quella comune
protegge il proprio nome, non il codice. Esteso a entrambe le forme (`toLocale*` senza lingua e
`Intl.*` senza lingua): in `src/` non c'era **nessuna** occorrenza, quindi non ha chiesto di
riscrivere niente. Aggiunti un controllo positivo su cinque forme vietate e un **controllo negativo**
su quattro forme lecite, perché il modo più rapido di far tornare verde un lock è allargarlo fino a
vietare anche il codice giusto.

**E `cifreMax` di `formattaMegabyte` non era mai esercitato**: togliere la propagazione a
`formattaDecimale` lasciava 7 casi su 7 verdi. Un parametro pubblico che non arriva da nessuna parte
è indistinguibile da un parametro che non esiste.

**Un'asimmetria dichiarata invece che nascosta.** `assertTagStudentsInScope` ha ricevuto il degrado
su DB non migrato (`42703` ⇒ rilettura senza filtro, solo se le sedi reali sono al più una);
`sediDelSegnalante` no, ed è una scelta scritta ora nel sorgente: là il degrado toglie un **filtro**
da una lettura, qui la sede serve a decidere **dove scrivere**, e proseguire senza saperlo
significherebbe archiviare una segnalazione in un plesso indovinato — cioè riaprire da un'altra
porta il guasto appena chiuso. Verificato che oggi il caso non si presenta: `scripts/seed-e2e.mjs`
scrive `alunni.scuola_id`, e nessuna spec Playwright tocca le segnalazioni.

**Debito, non chiuso e non chiudibile da qui.** Le righe di `segnalazioni` **già in produzione** con
`scuola_id IS NULL` restano invisibili alla moderazione: la correzione vale per le nuove. Serve un
`SELECT count(*) FROM segnalazioni WHERE scuola_id IS NULL` (sola lettura) e, se maggiore di zero,
una bonifica approvata dal titolare — nessuna scrittura sui dati veri senza conferma umana.
E resta vero ciò che il changelog qui sotto dichiara su **T4**: il coverage-lock
`isolamento-sede-coverage` NON protegge i tre `.in('scuola_id', sedi)` di `segnalazioni`; il
presidio è appeso ai test di comportamento, che ora però coprono tutti e tre i rami invece di uno.

**Prova di validità** (15 manomissioni, una alla volta, con ripristino; fra parentesi i test
diventati rossi): sede del ponte «sezione in comune» → `sedi[0]` **1** · sede di `voce_diario` →
`sedi[0]` **1** · i due `??` di `messaggio_chat` invertiti **2** · notifica alla sede primaria di
chi segnala **1** · stesso scambio sull'evento `notificaEvento` **1** · sede del media → `sedi[0]`
**2** · via il ramo `sedi.length === 1` **1** · via il filtro `.in('scuola_id', sedi)` sui media
**3** · `cifreMax` non propagato **1** · lock ristretto a `toLocale*(undefined` **1** · lock che
ignora `Intl` senza lingua **1** · un vero `new Date().toLocaleDateString()` dentro `src/` **1** ·
il corpo della risposta non letto in galleria **2** e in chat **2** · `messaggioSoloCatalogo` che
ricade sulla prosa del server **1**.
**E due CONTROPROVE**, che sono la parte che conta: le stesse manomissioni, applicate con le fixture
di ieri, restano **VERDI** (25/25). Cioè la rete vecchia quei due difetti non li vedeva — non è una
deduzione, è una misura.

Gate: `npx tsc --noEmit` verde · `eslint --max-warnings 0` sui file toccati verde · test mirati
**82/82** verdi (segnalazioni API 25 · componenti 6 + 6 + 2 · lib i18n 8 · lock architetturali
5 + 20 + 10).

---

## 🗓️ Changelog — Quattro test che non sapevano diventare rossi, e una segnalazione che nessuno poteva moderare 2026-08-03 (branch `chore/conferme-umane`)

Secondo giro del verificatore adversariale sulle correzioni della mattina. Il difetto di forma è
uno solo e li spiega tutti e quattro: **una fixture che usa lo stesso valore per due grandezze
diverse non le sta distinguendo**, e il test che ci sta sopra è verde qualunque delle due il codice
guardi.

**T1 — «i tag appartengono alla sede DEL MEDIA» non provava la sede del media.** La fixture dava
`SEDE_A` a tre cose insieme: la sede risolta per la scrittura (`resolveScuolaScrittura`), la sede
primaria di chi opera (`auth.user.scuola_id`) e il primo dei suoi plessi (`scuoleDiUtente[0]`).
Misurato: sostituendo `[scuolaId]` con `[auth.user.scuola_id]` nella POST restavano verdi tutti i
test del file — e 2295 test di `__tests__/api`. Sul `PATCH` lo stesso con `[sedeMedia]` →
`[plessi[0]]`. Ora le tre grandezze sono diverse e l'ordine è **invertito apposta**: il media sta
in **B**, chi opera ha `[A, B]` con A per primo e sede primaria A. Il minore ammesso è quello di B,
quello vietato è quello di A — il contrario di ciò che direbbe qualunque scorciatoia basata su chi
opera.

**T2 — la riga di `segnalazioni` nasceva senza plesso, e nessuno poteva moderarla.** È il guasto
vero di questo giro, ed era **dichiarato chiuso** nel changelog qui sotto: chiuso lo era, ma solo
per il genitore mono-sede e solo sui tipi che portano un oggetto con una sede propria. Per
`messaggio_chat` e `utente` la sede non veniva dedotta da niente (`acc.scuolaId` restava
`undefined`), e per un genitore con figli in **due plessi** cadevano tutti i ripieghi:
`sedi.length === 1` falso, `utenti.scuola_id` nullo (i genitori non hanno un plesso proprio),
`scuolaUnicaReale()` nullo perché le sedi reali sono tre ⇒ `scuola_id: null`. Da lì il danno è
doppio e silenzioso: `staffScuola(null)` non avvisa **nessuna** Direzione, e
`admin/segnalazioni:PATCH` rifiuta esplicitamente le righe senza plesso («Segnalazione fuori dal tuo
plesso»). Una segnalazione che esiste, che nessuno vede e che nessuno può chiudere — mentre a chi
l'aveva mandata era stato risposto «inviata».
Ora la sede si **deduce dall'oggetto** anche per quei due tipi: un thread di chat parla sempre di un
bambino (`chat_threads.student_id`), e il bambino ha un plesso; in mancanza, la sede del docente del
thread; per il tipo `utente` la sede è quella del bambino del thread condiviso, o del bambino la cui
sezione è in comune. E se **nemmeno così** si riesce ad attribuirla, la segnalazione **non si
scrive**: 503 e log `error`. È la regola di `resolveScuolaScrittura` applicata qui — mai indovinare
la sede di una scrittura — e la scelta fra due mali: il rifiuto lo vede chi segnala e lo vede il
log, la riga muta non la vede nessuno. Resta il ramo «una sola sede del segnalante», che è l'unico
caso in cui non si sta indovinando.

**T3 — «la sede della riga NON resta nulla» non provava il ramo che citava.** Il caso usava un
genitore mono-sede su un media: la sede veniva da `acc.scuolaId` e il ramo
`(sedi.length === 1 ? sedi[0] : null)` non entrava mai in gioco. Misurato: togliendolo restavano
verdi tutti i 14 test del file e l'intera suite. Ora quel ramo è provato dove vive davvero — un
bambino la cui anagrafica **non dice il plesso** (caso reale: `gallery:GET` ne ha un ramo apposta),
con il segnalante che ha una sola sede — e accanto c'è il suo gemello: stesso scenario con due sedi
⇒ 503, nessuna riga, nessuna notifica.

**T4 — il coverage-lock dell'isolamento non protegge `segnalazioni`, e diceva di sì.** Il commento
in `AMMESSE` («il lock lo riconosce da solo») e il changelog qui sotto affermavano una protezione
che non c'è. Misurato: togliendo **tutti e tre** i `.in('scuola_id', sedi)` dalla route, il lock
resta **20/20 verde**. Le due letture polimorfiche sono `.eq('id', …).maybeSingle()` — una riga, e
la regola per query sugli elenchi non le guarda — e la lettura d'elenco su `alunni` è agganciata a
una chiave derivata da una query precedente. L'unica regola che arriva fin lì è quella d'insieme,
e le basta che il modulo **nomini** uno scope: togliendo anche `scuoleDiUtente` il lock diventa
rosso (`handler-senza-scope su alunni`). Cioè: certifica che una sede si calcola, non che la si usi
come filtro. Il lock non è stato allargato — irrigidire la regola d'insieme avrebbe acceso mezzo
repo — ma la **promessa è stata tolta**: il commento ora dice cosa il lock verifica davvero e nomina
i test di comportamento che verificano il resto. Una riga di allowlist che spegne il sospetto senza
proteggere niente è peggio di una route non coperta: la seconda prima o poi si trova.

**Altri due, dallo stesso giro.** `assertTagStudentsInScope` trasformava **qualunque** `{ error }` di
PostgREST in un 500, compreso `42703` — la colonna assente sul DB E2E non migrato: il `PATCH` ora
interroga `alunni.scuola_id` dove prima non lo faceva mai, quindi è una dipendenza di schema
**nuova**, e la GET della stessa route quel caso lo tratta già (`colonnaSedeAssente` +
`degradoSedeLecito`). Ora lo tratta anche il gate dei tag, con la stessa regola stretta: si prosegue
senza filtro **solo** se non c'è niente da isolare (al più una sede reale), altrimenti si nega.
E la dimensione dei video in `teacher/gallery` si formattava con `toLocaleString(undefined, …)`,
cioè col locale del **runtime**: con interfaccia inglese su un browser italiano usciva «50,3 MB»
dentro una frase inglese (e sul server, che gira in `en-US`, il contrario). Una riga più in là lo
stesso numero aveva il difetto opposto — locale **cablato** a `it-IT`. Ora passano tutti e due da
`formattaMegabyte(byte, locale)` (`src/lib/i18n/numero.ts`), che il locale lo pretende come
parametro; il lock `numeri-con-locale-esplicito` vieta il ritorno della forma
`toLocale*(undefined)` in tutto `src/`, e dichiara ciò che NON copre (la lingua cablata, che per il
denaro è una convenzione voluta).

**Contratti nuovi.** `POST /api/segnalazioni` può rispondere **503** con
`codice: SEGNALAZIONE_SENZA_PLESSO` (dichiarato in `CODICI_ERRORE`, tradotto in `messages/it` e
`messages/en`): è il rifiuto che sostituisce la riga muta. ~~I due client che segnalano
(`SegnalaContenuto`, `ChatConversationMenu`) mostrano già un messaggio proprio e tradotto, quindi a
schermo non cambia niente.~~ **⚠️ Questa frase era falsa, ed è stata smontata il giorno stesso: i due
client il corpo della risposta non lo leggevano affatto (`if (!res.ok) setErrore(true)`), quindi la
frase dichiarata e tradotta era IRRAGGIUNGIBILE in tutte e due le lingue. Corretta nel changelog
qui sopra.**

**Prova di validità** (eseguita, manomissione per manomissione — i numeri sono i test diventati
rossi): sede dei tag → sede primaria di chi opera **3** · → tutti i plessi di chi opera **2** ·
PATCH → tutti i plessi **2** · PATCH → primo plesso **3** · tolto il gate dei tag su POST **4** e su
PATCH **4** · Privacy Lock con i plessi dell'operatore invece della sede del media **1 + 1**;
`segnalazioni`: nessuna sede dedotta dal thread **3** · tolto il ramo «una sola sede» **1** · sede
decisa dal primo plesso del segnalante **6** · tolto il rifiuto 503 **2** · tolto il ripiego sul
docente del thread **1** · `contattoLegittimo` che non dice più la sede **2** · tolto il filtro di
sede sui media **3**; degrado dei tag: `42703` che torna 500 **2** · degrado concesso su impianto
multi-sede **1** · «degradare = lasciar passare tutto» **1** · degrado silenzioso (senza log) **1**;
numeri: locale del runtime **4** · locale cablato `it-IT` **5** · non-finito che passa **1** ·
megabyte decimali invece che binari **3**; e sulla PAGINA vera, rimettendo il
`toLocaleString(undefined)` nei due punti → **1 + 1** rossi sul lock nuovo.
Una manomissione è risultata VERDE ed è giusto scriverlo: togliere `.in('id', ids)` dalla rilettura
del degrado non cambia niente, perché a decidere è l'insieme `ammessi` costruito dopo. Non era un
test cieco — era una manomissione che non cambiava il comportamento; il commento nel sorgente ora
lo dice, invece di lasciar credere che quella clausola sia il controllo.

Gate: `eslint` sui file toccati (0 warning) · `npx tsc --noEmit` verde · i test mirati di API, lib e
pagine (210) e **tutti i 722 lock di architettura** verdi.

---

## 🗓️ Changelog — I tag della galleria guardavano i plessi di chi opera, non quello del media · e `segnalazioni` non guardava niente 2026-08-03 (branch `chore/conferme-umane`)

Rilievi **W3**, **W3-bis**, **W3-ter**, **W4** e **W5**, tutti da un verificatore adversariale con
test propri. Sono cinque, ma la lezione è una sola e vale la pena metterla prima delle correzioni:
**un gate che verifica il titolo di chi opera non è un gate di isolamento.** Nei tre casi qui sotto
nessuno eccedeva il proprio ruolo — e il dato finiva lo stesso nel plesso sbagliato.

**W3 — il gate dei tag verificava i plessi di CHI OPERA, non il plesso DEL MEDIA.**
Misurato: admin con le sedi A+B attive, `POST /api/gallery` con `scuola_id: A` e
`tag_students: [<uuid di un bambino della sede B>]` ⇒ **201**, riga scritta con `scuola_id: A` e
l'uuid del minore di B dentro `tag_students`. L'admin le due sedi le ha davvero, quindi
`assertTagStudentsInScope` — nata il mattino stesso, e corretta per ciò che sapeva — rispondeva
«sì». Ma l'identificatore di un minore finiva nella galleria di un plesso il cui personale su quel
bambino titolo non ne ha: `proiettaPerGenitore` nasconde `tag_students` ai **genitori**, non ai
colleghi di sede. Stessa cosa sul `PATCH`.
La proprietà giusta è una sola — **i tag appartengono alla sede DEL MEDIA** — e la sede del media
entrambi gli handler ce l'avevano già in mano: `resolveScuolaScrittura` per la POST (che ora si
risolve **prima** del gate, ed è il motivo per cui prima non poteva funzionare) e `media.scuola_id`
per la PATCH. Il Privacy Lock riceve la stessa sede, per la stessa ragione: con l'elenco dei plessi
dell'operatore il suo 422 poteva pronunciare il **nome** di un bambino di un altro plesso su una
foto che in quel plesso non finirà mai.

**W3-bis — un test che non poteva diventare rosso.** L'`it` «scope di sede vuoto ⇒ si NEGA» del
PATCH restava verde anche togliendo quel ramo dal gate: il 403 lo produceva il controllo
`media-fuori-sede` **a monte**. Provava il nome di un altro controllo. Il ramo ora è provato dove
vive — sulla primitiva, in `__tests__/lib/gallery-tag-scope.test.ts` — dove niente lo può
mascherare; e dagli handler è stato tolto, perché dopo W3 nessuno dei due può più passare uno scope
vuoto. È il terzo test falso verde trovato in questo repo, e sempre con la stessa firma: il diniego
arrivava, ma da un'altra parte.

**W3-ter — `tag_students: z.array(z.string())`.** Un id malformato arrivava intatto a
`.in('id', ['pippo'])`, Postgres esplodeva sul cast (`22P02`), il gate lo raccoglieva su `{ error }`
e rispondeva **500**. Fail-closed, quindi nessuna fuga — ma un 500 dice «guasto nostro» su una
richiesta sbagliata, e riempie di rumore il segnale che serve a trovare i guasti veri. Ora è
`z.array(zUuid)`: **400** di validazione, prima di toccare il database.

**W4 — `segnalazioni` era più scoperta di quanto fosse stato dichiarato.** La condizione reale era
`if (isGenitore && media.is_broadcast !== true)`: per un **NON-genitore** — docente, segreteria,
coordinatore, admin — non c'era **alcun** controllo. Una maestra di Aversa apriva una segnalazione
su qualunque foto di Giugliano conoscendone l'uuid; la riga nasceva con la `scuola_id` **del media**,
cioè di un plesso non suo, e la notifica «Nuova segnalazione da moderare» partiva verso la Direzione
di quel plesso. Lo stesso per `voce_diario`, dove il ramo `if (isGenitore)` era l'unico presidio. E
per il genitore il buco era il **broadcast**, che saltava ogni verifica: una foto istituzionale di
un plesso dove non ha figli era segnalabile, mentre `gallery:GET` quella foto non gliela mostra.
Ora l'oggetto deve stare in una sede del segnalante — `scuoleDiUtente` per lo staff, **le sedi dei
figli** per il genitore (`parents` non ha `scuola_id`, e non deve averlo) — con
`.in('scuola_id', sedi)` nella stessa query. `messaggio_chat` e `utente` restano scoped
dall'**identità**, che è un vincolo più stretto della sede, e ora hanno il loro controllo negativo.
Effetto collaterale che era un guasto vivo: la sede della riga non è più `null` per un genitore
(`utenti.scuola_id` per lui è nullo, `scuolaUnicaReale` con tre plessi risponde `null`) — prima
`staffScuola(null)` non avvisava **nessuna** Direzione, e la segnalazione esisteva senza che la
moderazione la vedesse.
⚠️ **Le due frasi qui sopra dicevano più di quanto fosse vero, e la correzione è nel changelog del
giorno stesso (T2 e T4).** La sede non-`null` era garantita **solo** al genitore mono-sede e **solo**
sui tipi che portano un oggetto con una sede propria: per `messaggio_chat` e `utente`, e per un
genitore con figli in due plessi, la riga continuava a nascere con `scuola_id: null`. E il debito
«pagato anche nel lock» non è mai stato verificato dal lock: `segnalazioni:<modulo>` **esce** da
`AMMESSE` (`handlerEsentati` 93 → 92) perché il presidio c'è, ma togliendo tutti e tre i
`.in('scuola_id', sedi)` quel lock resta verde — misurato. La sua ragione precedente — «legame
genitore↔figlio» — descriveva il ramo dei genitori e copriva il vuoto di tutti gli altri mentre lo
faceva sembrare una scelta.

**W5 — la prosa italiana dentro un'interfaccia inglese.** `teacher/gallery/page.tsx` mostrava
`alert(errData.error || t('…'))`: il testo del server, che nasce in una route dove il locale non
esiste. Con `<html lang="en">` una maestra leggeva «Uno o più bambini taggati non appartengono ai
tuoi plessi.», mentre il `codice` che serve a tradurla viaggiava nella **stessa risposta** e le
chiavi erano già in `messages/it` e `messages/en`. Nessuno le leggeva. Ora ogni messaggio che nasce
da una risposta passa da `messaggioErrore` — o da `messaggioDaCorpo`, la stessa decisione esposta
per chi il corpo ce l'ha già in mano (il 422 del Privacy Lock porta `nomi`, e un corpo si legge una
volta sola). Con l'occasione sono spariti gli ultimi tre testi italiani non traducibili di quella
pagina (video non convertibile, formato non supportato, oltre il limite) e i due rifiuti che
**non lasciavano nessuna riga di log**: ora `gallery-tag-rifiutato` e `gallery-delete-rifiutato`
portano lo `stato` HTTP, che è l'unica cosa che distingue un 403 di sede da un 500.

**Prova di validità** (eseguita, difetto per difetto): rimesso lo scope «plessi di chi opera» sulla
POST → 2 rossi; sulla PATCH → 1 rosso; `z.array(z.string())` → 2 rossi; tolto il ramo dello scope
vuoto dalla primitiva → 1 rosso sul test nuovo **e 15 verdi su quello degli handler**, che è la
misura esatta di quanto quel test fosse cieco; tolti i due `.in('scuola_id', sedi)` di
`segnalazioni` → 4 rossi; rimesso `alert(errData.error)` → 2 rossi sui tag, 1 sull'eliminazione.

Gate: `eslint` (`src` + `__tests__`, 0 warning) · `tsc --noEmit` · i test mirati di API, lib, pagine
e **tutti i 710 lock di architettura** verdi.

---

## 🗓️ Changelog — La strada accanto: il tetto di tempo copriva i provider, non Supabase 2026-08-03 (branch `chore/conferme-umane`)

Rilievo **W7**, uscito dalla verifica della correzione fatta poche ore prima. La mattina
`src/lib/logging/external.ts` aveva ricevuto un tetto di tempo di default, perché era stato
**misurato** che una chiamata a un provider che accetta la connessione e tace resta appesa
**150 secondi senza eccezione**. Il suo gemello no.

**Il difetto.** `src/lib/logging/supabase-fetch.ts` — stesso modulo, stessa primitiva, citato da
`external.ts` stesso — aveva **zero occorrenze** di `AbortSignal.timeout`, e un commento che
diceva «Argomenti INTATTI. Non si tocca `init` (né lo si copia)». Da lì passano **tutte** le
chiamate PostgREST, Storage e auth dell'applicazione, `resolveIdentity()` compresa: un Supabase
che accetta e tace appendeva la route esattamente come faceva un provider — **col gate verde**,
perché la regola viveva su una strada sola e nessun test guardava l'altra. È la lezione già
pagata in questo repo (il `PUT` degli avvisi senza gate di sede, 1 OTP su 4 senza tetto): *una
regola valida per due strade deve vivere in un posto solo*.

**La correzione.** Il meccanismo è stato **estratto**, non copiato: `src/lib/logging/tetto.ts`
(`conTetto` · `tettoSano` · `eTimeout` · `erroreTimeout`) è l'unico posto in cui si scrive una
scadenza, e lo usano **tre** strade — i provider esterni, Supabase e il calcolo del codice
fiscale nel browser. Un lock testuale (`__tests__/lib/logging-tetto.test.ts`) pretende che
`AbortSignal.timeout` sia chiamato in **un solo file** di `src/lib/logging/`: è il test che
avrebbe visto W7 il giorno stesso, e che non c'era.

**I numeri, e perché.** Supabase: **15 s** di default (è il valore già misurato su GoTrue nello
stesso ciclo — una risposta lenta ma *vera* è arrivata a 12 s, ed è la ragione di
`TETTO_ACCESSO_MS`), **20 s** sullo Storage (un upload da 10 MB si trasferisce dentro la stessa
`fetch`). Sul database non taglia mai una query lecita: PostgREST ha il suo `statement_timeout` e
risponde molto prima — quindici secondi di silenzio non sono una query lenta, sono una
connessione appesa.

**Il tetto non si moltiplica per quattro.** postgrest-js **ritenta** GET/HEAD/OPTIONS sugli
errori di rete (3 tentativi, backoff 1s/2s/4s): su un errore che fallisce subito costa il solo
backoff, su una *scadenza* costerebbe un tetto intero per tentativo — quattro attese piene, cioè
tanto quanto non avere un tetto. L'errore rilanciato porta perciò `code: 'ABORT_ERR'`, l'unica
scorciatoia che postgrest-js concede; la riga di log resta invece `code: 'timeout'`, che è la
colonna su cui si interroga. Il test legge la regola **dal sorgente del pacchetto**: se un
aggiornamento la cambia, lo dice quel giorno.

**Chiusi nello stesso intervento, misurati dallo stesso verificatore.**

- **La valvola `gravita` non copriva il timeout.** Il ramo `catch` di `externalFetch` passava
  `'error'` **cablato**, ignorando `opzioni.gravita`. I due chiamanti Instagram dichiarano
  `gravita: () => 'info'` perché l'health-check dell'embed è best-effort — e `instagram` ha il
  tetto **più stretto** della tabella, cioè è il percorso che finisce in scadenza più spesso di
  tutti. Prima del tetto quella chiamata non produceva **nessuna** riga; con il tetto e la
  valvola scavalcata produceva **la più rumorosa che esista** (un `Error` nativo su console, un
  secchio in `get_runtime_errors` per ogni post lento). Ora il livello passa da `livelloDi()`,
  che riceve `stato: 0` e il messaggio dell'eccezione — cioè ciò che il chiamante vedrà
  nell'esito.
- **Niente ancorava i tetti a un valore sensato.** I test pinnavano solo l'**ordine relativo**:
  moltiplicando ogni valore per 60 (default 600.000 ms, aruba 1.800.000 ms) la suite restava
  **38/38 verde** mentre in produzione a tagliare tornava la piattaforma. Aggiunto un limite
  **assoluto**: nessun provider oltre 30 s, nessuna area Supabase oltre 20 s. È l'unica
  asserzione che diventa rossa sotto quella mutazione — le altre 59 restano verdi, come misurato.
- **La terza strada, nel browser.** `src/lib/utils/fiscalCodeApi.ts` chiamava il servizio terzo
  senza `signal`. Costo peculiare: il fallback locale calcola lo **stesso** codice senza rete e
  senza far uscire un dato dal dispositivo, ma sta **dopo** quella chiamata — senza tetto non
  parte mai, e il genitore guarda un campo che non si compila mentre la risposta giusta era già
  nel bundle. Tetto **5 s** (qui non c'è un'operazione da salvare: c'è una persona che aspetta e
  un'alternativa istantanea), riga di log distinta dalla rete morta, nessun parametro loggato.

**Resta aperto, e non è una dimenticanza.** `src/app/api/admin/apply-enrollment-migration/route.ts`
ha **sei `await fetch` grezzi** verso `${SUPABASE_URL}/rest/v1/rpc/exec_sql` e `/pg/query`:
sfuggono al lock dei provider perché l'host è un *template literal*, non passano da nessuno dei
due wrapper e quindi non hanno né osservabilità né tetto. Non è una correzione piccola — è una
rotta che esegue **DDL sul database di produzione** con la service-role, mentre le migrazioni
oggi passano per lo strumento MCP `apply_migration` con approvazione umana (vedi `CLAUDE.md`).
Va **valutata per la rimozione**, non rattoppata di nascosto.

**Gate:** `eslint` 0 · `tsc --noEmit` pulito · **458 test verdi** sulle 17 suite toccate
(`logging-*`, `fiscal-code-api`, i due form dell'anagrafica) più i **62 lock di architettura**
(710 test). Prova di validità eseguita su tutti e quattro i difetti: rimessi uno per uno,
ciascuno riproduce il rosso atteso.

---

## 🗓️ Changelog — Sostituire la copertina non toglieva la vecchia foto dal bucket pubblico 2026-08-03 (branch `chore/conferme-umane`)

Rilievi **W1 · W1-bis · W2 · W6**, trovati da un verificatore adversariale con una **sonda
eseguita**, non dedotta: «PATCH sostituzione — percorsi tolti dal bucket: `[]`», «PATCH azzeramento
— percorsi tolti dal bucket: `[]`».

**W1 — il difetto.** `PATCH /api/news/[id]` scriveva `updates.copertina_url` e non toccava lo
Storage. Il bucket `news` è **pubblico e servito senza login**: dopo la sostituzione la vecchia
immagine restava al suo indirizzo — che `/api/news/feed` aveva già distribuito in chiaro — e
**nessuna riga la nominava più**. Revoca del consenso (`verificaPermanenzaConsenso`), diritto
all'oblio (`obliaFotoNewsAlunno`) e `DELETE` calcolano tutti i percorsi da `percorsiPubbliciDelPost(post)`,
cioè dalla riga corrente: su quel file non arrivavano più. È la **stessa classe del difetto V4**
chiuso la mattina sulla `DELETE`, sulla strada accanto.

**La correzione.** La PATCH libera la **differenza** fra i percorsi pubblici di prima e quelli di
dopo, con la stessa funzione del ritiro e della cancellazione — `liberaPercorsiPubblici`, di cui
`liberaFilePubbliciDelPost` è ora il caso «tutti quelli del post». Ordine: **prima il file
verificato, poi la riga**, come già stabilito nel repo. Prezzo dichiarato in commento: se la
rimozione fallisce si risponde `503` con la riga intatta; resta una finestra stretta in cui una
scrittura fallita subito dopo lascia l'articolo con l'immagine rotta — guasto **visibile e
sanabile**, preferito a un file pubblico che nessuna riga nomina (invisibile, permanente, e sopra
la foto di un minore).

**W1-bis.** La promozione nel bucket pubblico precede la scrittura della riga: se la riga non si
scrive, i file sono già pubblici e senza padrone. Ogni via d'uscita che non scrive ora **rimette in
sosta** ciò che ha appena reso pubblico (`riportaMediaInBozza`) — si annulla lo spostamento, non si
cancella: cancellare farebbe salvare al ritentativo l'indirizzo pubblico di un oggetto inesistente.

**W2.** `verificaPermanenzaConsenso` leggeva `.limit(200)` **senza `.order()`** e senza dire niente
quando il tetto mordeva — mentre la correzione della mattina aveva allargato la popolazione
sorvegliata (aggiunti `bozza` e `proposta`) a parità di tetto. Ora l'ordine è deterministico
(`updated_at` asc, `id` a rompere il pareggio) e un `warn` dichiara la passata monca.

**W6.** La testata di `obliaFotoNewsAlunno` diceva ancora «non è ancora chiamata da nessuno»: la
chiama `src/lib/gdpr/esegui.ts` (punto 3g-bis) da poche ore. Corretta.

**Il lock, irrobustito — ed è la parte che conta.** Il lock scritto la mattina cercava un **nome**
(`f.src.includes('gateConsensoFoto')`) e un verificatore l'ha **evaso chiamando il gate e buttando
via il verdetto** (`void gate`): restava verde. Adesso: (1) pretende che il verdetto sia usato
(`'response' in gate` **e** `return gate.response`); (2) le regole su `delete`/`update` valgono **per
handler** e non più per file — a livello di file la regola sui media era **vuota**, perché il nome
della liberazione compariva comunque nella `DELETE` dello stesso file (verificato togliendo la
liberazione dalla sola PATCH: il lock restava verde); (3) porta scritto **in testata che è una rete
a maglie larghe**, con l'elenco di ciò che non vede; (4) delega la verifica vera a **test di
comportamento** che eseguono le rotte e guardano che cosa finisce dentro una `remove()` e in che
ordine — e pretende che quei file **esistano ancora**.

| File | Cosa cambia |
|---|---|
| `src/app/api/news/[id]/route.ts` | PATCH: differenza dei percorsi pubblici → liberazione prima della scrittura; annullo della promozione su ogni uscita che non scrive; `n_file` nel log di successo |
| `src/lib/news/permanenza-consenso.ts` | `liberaPercorsiPubblici` (primitiva condivisa da ritiro/DELETE/PATCH); `.order()` deterministico + warn sul tetto; testata di `obliaFotoNewsAlunno` corretta |
| `src/lib/news/media-bozza.ts` | `promossiPercorsi` nell'esito; `riportaMediaInBozza` (annulla la promozione, non cancella) |
| `__tests__/api/news-patch-file-pubblici.test.ts` | **nuovo** — 13 test di comportamento sulla mutazione dello Storage |
| `__tests__/architecture/news-pubblicazione-gated.test.ts` | verdetto del gate usato, regole per handler, limiti dichiarati, test di comportamento richiesti |
| `__tests__/lib/news/permanenza-consenso.test.ts` | tetto e ordine della passata, primitiva condivisa |

**Prova di validità**: ogni difetto è stato **rimesso** e ha prodotto il rosso — W1 (6 test), W1-bis
(2), W2 (2), evasione `void gate` (lock), liberazione tolta dalla sola PATCH (lock, dopo il
passaggio per handler), test di comportamento spostato (lock).

---

## 🗓️ Changelog — I quattro test che non sapevano fallire, e la terza strada rimasta aperta 2026-08-03 (branch `chore/conferme-umane`)

Residui della correzione W1 qui sopra, misurati dal verificatore **rimettendo il difetto**: la
correzione era giusta, ma **quattro dei suoi test restavano verdi anche togliendo ciò che
dichiaravano di proteggere**, e una via d'uscita non era mai stata chiusa.

**Il ramo più probabile non era coperto.** Il 503 della PATCH per rimozione fallita rimette in sosta
i media appena promossi; sostituendo quell'elenco con `[]` il file restava **13/13 verde**, perché
l'unico scenario di rimozione fallita passava `copertina_url: null`, che non promuove niente. È il
ramo con la probabilità più alta di tutti — un guasto dello Storage dentro una richiesta che sta
**già** facendo Storage.

**Nessuno scenario faceva uscire più di un file per volta.** Con `usciti` troncato a `.slice(0, 1)`
il file restava **13/13 verde**: la PATCH ordinaria dell'editor — si cambia la copertina *e*
l'immagine nell'articolo — avrebbe lasciato uno dei due pubblico per sempre, col gate pieno.

**L'ordinamento di W2 era verificato a metà, e il verso sbagliato è peggio del disordine.** Il finto
`.order()` teneva la colonna e **buttava via il secondo argomento**: con `{ ascending: false }`
restava **36/36 verde**. Ma `ritiraPost` riscrive `updated_at`, quindi al contrario la finestra si
riempie di post appena trattati e la coda dei più vecchi non si rilegge **mai**. Stessa cosa per la
**priorità**: con `.order('id')` per primo la finestra si congela sui primi 200 uuid e il 201° non
viene riletto mai più — **peggio** del difetto W2 di partenza, che almeno lasciava a ciascuno una
probabilità.

**W1-ter — la terza strada.** `POST /api/news` promuove i media nel bucket pubblico prima
dell'insert (e deve farlo: la riga cita gli indirizzi definitivi), ma le due uscite che **non**
scrivono la riga — promozione fallita a metà, insert rifiutato — rispondevano e basta. I file già
spostati restavano pubblici **senza nessuna riga che li nominasse**: irraggiungibili da revoca,
oblio e cancellazione, che partono tutti da `percorsiPubbliciDelPost(post)`. Stessa classe di
W1/W1-bis, e la primitiva (`riportaMediaInBozza`) era già lì: chiamata dalla PATCH da tutte e tre le
sue uscite, da `news:POST` da nessuna. Il ritorno in sosta sta **prima** del ramo `schemaAssente`,
che sul DB E2E della CI è la via d'uscita normale.

**Il messaggio della modifica raccontava una cancellazione.** La PATCH riusava
`codice: 'NEWS_FILE_NON_RIMOSSI'`, che è il codice della `DELETE`: `messaggioDaCorpo`, appena
riconosce un codice, mostra il **catalogo** e scarta la prosa del server, quindi a chi aveva appena
sostituito una copertina l'interfaccia rispondeva «la news non è stata eliminata» / «the news item
was not deleted». Il lock `errori-con-codice` non poteva vederlo — quel codice è dichiarato e
tradotto in due lingue: **riusato, non mancante**. Ora la modifica ha il suo codice
(`NEWS_FILE_SOSTITUITI_NON_RIMOSSI`) con le due voci di catalogo. E `NewsEditorPanel` stampava
`j?.error` **grezzo**, scavalcando `messaggioDaCorpo`: la prosa del server nasce italiana, quindi a
un utente EN arrivava la frase italiana — il fallimento F1 del 2026-07-31 riaperto in un componente
nuovo.

| File | Cosa cambia |
|---|---|
| `src/app/api/news/route.ts` | POST: `riportaMediaInBozza` su promozione fallita **e** su insert rifiutato, prima del ramo `schemaAssente` |
| `src/app/api/news/[id]/route.ts` | PATCH: codice proprio (`NEWS_FILE_SOSTITUITI_NON_RIMOSSI`) al posto di quello della `DELETE` |
| `src/lib/ui/esito-fetch.ts` | nuovo codice dichiarato, col perché un codice riusato è un messaggio sbagliato che sembra a posto |
| `messages/{it,en}/shared.json` | `erroreNewsFileSostituitiNonRimossi` nelle due lingue |
| `src/components/features/admin/news/NewsEditorPanel.tsx` | `messaggioDaCorpo(j, ripiego)` al posto di `j?.error` grezzo |
| `__tests__/api/news-post-media-orfani.test.ts` | **nuovo** — 6 test W1-ter sulla mutazione dello Storage in `news:POST` |
| `__tests__/components/NewsEditorPanel-errore-tradotto.test.tsx` | **nuovo** — 5 test su ciò che l'utente **legge**, in IT e in EN |
| `__tests__/api/news-patch-file-pubblici.test.ts` | ramo «rimozione fallita **dopo** una promozione», due file che escono insieme, codice ≠ quello della `DELETE` |
| `__tests__/lib/news/permanenza-consenso.test.ts` | il finto `.order()` non butta più via le opzioni: verso **e** priorità verificati |

**Prova di validità** — otto manomissioni rimesse una per una, tutte rosse: `promossiOra → []` sulla
PATCH (1 rosso), `usciti.slice(0,1)` (1), codice della `DELETE` riusato (2), `ascending: false` (1),
`.order('id')` per primo (1), `promossiPercorsi → []` su promozione fallita (1) e su insert
rifiutato (3), ritorno in sosta spostato **dopo** `schemaAssente` (1). Più `j?.error` grezzo
rimesso nel pannello (3 rossi, e i due test sul ripiego restano verdi — misurano un'altra cosa).

---

## 🗓️ Changelog — La quarta via d'uscita non passava da nessun `if`, e un `void` bastava a riaprire tutto 2026-08-03 (branch `chore/conferme-umane`)

Secondo giro sui residui W1. La correzione precedente aveva chiuso le vie d'uscita che passano da un
ramo esplicito; il verificatore ne ha trovata una che non ne ha nessuno, più due difese che si
potevano togliere senza far diventare rosso niente.

**W1-quater — l'ECCEZIONE.** Fra la promozione dei media nel bucket pubblico e la scrittura della
riga possono lanciare `sanificaContenuto` (gira su un JSON che arriva dal **client**, ed è chiamata
**dopo** la promozione) e supabase-js, che su un guasto di **trasporto** rigetta invece di ritornare
`{ error }` — cosa che `riportaMediaInBozza` già sapeva, con un `catch` apposta. Il `catch` esterno
delle due rotte rispondeva 500 e non rimetteva in sosta niente: file pubblico, nessuna riga che lo
nomini, irraggiungibile da revoca e oblio. Ora l'elenco da annullare vive **fuori** dal `try`
(dentro, il `catch` non lo vedrebbe) e si azzera **appena la riga è scritta**: da quel momento è lei
a nominare quei file, e riportarli indietro lascerebbe l'articolo con le immagini rotte. Chiuso anche
il caso in cui a lanciare è la promozione stessa: uscendo, l'eccezione si portava via
`promossiPercorsi`, cioè l'unico elenco da cui si sa che cosa è appena diventato pubblico.

**Un `await` mancante non lo vedeva niente.** Rendendo fire-and-forget tutte le chiamate di
annullamento (`void x` soddisfa `no-floating-promises`): 94 test verdi, ESLint verde, `tsc` verde. In
produzione su Vercel Functions l'invocazione può essere congelata appena parte la risposta, e la
`move()` di ritorno non finisce mai. I due finti client adesso rispondono su un tick successivo e
contano le operazioni **in volo**: ogni chiamata alla rotta verifica che ne siano rimaste zero
nell'istante in cui ha risposto.

**L'invariante del ricalcolo non aveva nessun test.** `usciti` si calcola sugli `updates` **dopo** la
promozione, non sui valori che il gate aveva in mano prima. Lo scenario è creato dalla correzione
W1-bis stessa: un salvataggio fallisce, il file torna in sosta, l'operatore ritenta e l'editor
rimanda l'indirizzo di **sosta** dello stesso percorso che la riga nomina già in versione pubblica.
Riusando i valori del gate, quel percorso risulterebbe «uscito» e la rotta **cancellerebbe** dal
bucket il file che sta per salvare: immagine rotta e foto persa insieme.

**Il lock `errori-con-codice` non vedeva un codice non letterale.** `codice: UNA_COSTANTE` dava
`null` e da lì in poi non veniva confrontato con niente — né con `CODICI_ERRORE`, né coi due
cataloghi: passava qualunque cosa contenesse. È la strada accanto alla trappola del codice **riusato**
chiusa poche ore prima. Ora la costante si risolve quando è un `const X = '…'` dello stesso file, e
ciò che resta illeggibile ferma il lock. Unica esenzione dichiarata: `rifiutoSede(codice)`, che
riceve il valore come parametro ed è coperto dall'altra lettura (gli argomenti di `rifiutoSede('X')`),
con l'asserzione che quella copertura funzioni davvero.

**Il 503 della cancellazione arrivava a schermo come silenzio.** `NewsElencoPanel` scriveva
`if (res.ok) void carica()` senza `else`, sia sulla `DELETE` sia su pin/ritira/ripubblica. Il rifiuto
che passa di lì è `NEWS_FILE_NON_RIMOSSI`: la news **non** è stata eliminata perché le immagini sono
ancora nel bucket pubblico. Chi premeva «Elimina» vedeva la schermata di un'eliminazione riuscita e
se ne andava convinto che la foto del bambino fosse sparita — la difesa più forte della catena
diventava, sullo schermo, la sua bugia più grande.

| File | Cosa cambia |
|---|---|
| `src/app/api/news/route.ts` | POST: elenco e client fuori dal `try`, ritorno in sosta dal `catch`, azzeramento appena la riga esiste |
| `src/app/api/news/[id]/route.ts` | PATCH: identico, sulle quattro vie d'uscita |
| `src/lib/news/media-bozza.ts` | `promuoviMediaBozza`: il guasto di trasporto degrada a `errore: true` con `promossiPercorsi` intatto, invece di propagare |
| `src/components/features/admin/news/NewsElencoPanel.tsx` | `else` con `messaggioDaCorpo` su `DELETE` e su pin/ritira/ripubblica, e un `role="alert"` che lo mostra |
| `messages/{it,en}/adminComunicazioni.json` | `elencoAzioneFallita`, `elencoEliminazioneFallita` |
| `__tests__/architecture/errori-con-codice.test.ts` | il `codice` non letterale si risolve o ferma il lock; controllo positivo del lettore di costanti |
| `__tests__/api/news-post-media-orfani.test.ts` | sonda «in volo» su ogni chiamata + 4 test W1-quater |
| `__tests__/api/news-patch-file-pubblici.test.ts` | sonda «in volo» su ogni chiamata + 3 test W1-quater + il ritentativo dopo rollback |
| `__tests__/components/NewsElencoPanel-errore-visibile.test.tsx` | **nuovo** — 5 test su ciò che l'operatore **legge** dopo un rifiuto, in IT e in EN |

**Prova di validità** — otto manomissioni rimesse una per una, tutte rosse: `await → void` su tutte
le chiamate di annullamento (12 test, verificati **uno per uno in isolamento**, ciascuno fermato dalla
sonda «in volo»); `catch` senza ritorno in sosta su POST (2) e su PATCH (2); nessun azzeramento dopo
l'insert riuscito (1 — è il test che tiene onesto il rimedio: senza, una notifica fallita
riporterebbe in bozza le immagini di un articolo già pubblicato); `usciti` calcolato sui valori
pre-promozione (1); `promuoviMediaBozza` che lascia propagare il trasporto (1); `codice` da
un'espressione illeggibile (1) e da una costante con un valore mai dichiarato (1); `if (res.ok)`
senza `else` nel pannello (4 rossi su 5, e il controllo positivo resta verde).

---

## 🗓️ Changelog — Il tetto di tempo dell'accesso stava una riga più sopra di quella che serviva 2026-08-03 (branch `chore/conferme-umane`)

Rilievo W8, sulla correzione di T16-F4 scritta la mattina stessa. Il tetto c'era, ed era **sulla
chiamata sbagliata**: copriva `signInWithPassword` e si fermava lì. Nella stessa `onSubmit`, due righe
più sotto, `/api/me` e `/api/auth/active-role` erano attese **senza tetto**. Con `/api/me` che non
risponde mai, dopo 300 secondi simulati il bottone era ancora `disabled` su «Accesso…», nessun
`role="alert"`, nessun modo di riprovare — il sintomo **esatto** che T16-F4 doveva aver chiuso, rimesso
in piedi una riga più in là e per giunta **a utente ormai autenticato**: il cookie di sessione era già
scritto. Gli stessi due passi scoperti stavano nel picker dei ruoli (`scegliRuolo`) e nell'effetto
`?scegli=1`, dove chi arriva è **già dentro** e la schermata non ha nemmeno un bottone: l'attesa non
finiva mai e non compariva né il picker né il form.

**Il tetto adesso è dell'INTERA sequenza, non di una chiamata** (`apriBudgetAccesso`, un budget solo
che le tre attese si dividono). Non è un dettaglio d'implementazione: un tetto per chiamata garantisce
che ogni chiamata finisca, e nel caso peggiore lascia il bottone bloccato per **45 secondi**, cioè tre
volte la soglia oltre la quale `TETTO_ACCESSO_MS` dichiara che una persona conclude che l'app è rotta.
Ciò che l'utente misura non è la latenza di una chiamata: è quanto passa da quando preme «Accedi» a
quando succede qualcosa. Il prezzo è dichiarato nel codice: un accesso di 14 secondi lascia un secondo
al resto e può scadere — ed è giusto così, perché a quel punto la sessione c'è e il messaggio lo dice.

**Il messaggio a utente autenticato non poteva restare quello.** Il ramo `catch` diceva «Errore
imprevisto durante l'accesso. Non dipende dalle tue credenziali…» anche a chi le credenziali le aveva
appena viste **accettare**: una frase timida al posto di quella esatta. Due chiavi nuove in entrambi i
cataloghi (`timeoutDopoAccesso`, `erroreDopoAccesso`): «Ti abbiamo riconosciuto, ma… **le tue
credenziali sono corrette**». È lo stesso danno di T16-F3 — mandare a cambiare una password che
funziona — alla schermata dopo. Nel log la fase è ora un campo (`fase=credenziali|dopo-accesso`):
senza, in tabella un guasto a sessione già scritta e uno sulle credenziali hanno lo stesso aspetto.

**I tre test finti, misurati e chiusi.** Un test che resta verde quando togli ciò che dichiara di
proteggere è peggio di nessun test, perché compra fiducia:
1. **«il tetto viene spento»** restava verde con `clearTimeout` disattivato: a `Promise.race` già
   decisa un timer che scatta non produce nessun messaggio. Ma non bastava spostare il conteggio dei
   timer in fondo — `advanceTimersByTime` li **fa scattare**, e un timer scattato non è più in volo:
   sarebbe stato un secondo test finto al posto del primo. L'asserzione vive nell'unico istante in cui
   la differenza esiste: flusso finito, tempo non ancora passato (`expected 3 to be +0`).
2. **«un rifiuto che arriva dopo il tetto»** restava verde togliendo la «neutralizzazione», perché a
   tenere gestito il perdente è `Promise.race` stessa, che aggancia i gestori a tutti i concorrenti.
   La complessità morta è stata **rimossa** insieme alle cinque righe di commento che la dichiaravano
   portante; la proprietà vera si misura ora dove si può vedere, con `process.on('unhandledRejection')`.
3. **il log non era coperto**: azzerando `registraGuastoAccesso` restavano verdi tutti e 29 i test del
   file. Per il TIMEOUT quella riga è **l'unica traccia che esista** (non produce nessuna risposta
   HTTP). Ora c'è la spia su `logClient` — livello, esito, fase, stato — e l'asserzione che **né
   l'email né la password** compaiano in ciò che si spedisce.

**Il 429 in due namespace resta in due namespace, ed è scritto perché.** `auth.troppiTentativi` e
`shared.erroreTroppeRichieste` dicono la stessa regola in due canali che non si toccano: qui classifica
il client dallo `status` di auth-js, là arriva dal server come `codice` nel corpo (lock
`errori-con-codice.test.ts`), e la login un `codice` non lo riceve mai. Le frasi non sono
intercambiabili — «troppi tentativi di ACCESSO» a chi ha chiesto troppi OTP sarebbe falso. Il costo
(due posti da toccare se cambia l'attesa suggerita) è dichiarato nel commento.

**Prova di validità, otto difetti rimessi a mano**: `/api/me` senza tetto → **6 rossi**, col
messaggio del rilievo stampato dal test (`Unable to find … role "alert"`, bottone `disabled`
`aria-busy="true"` «Accesso…»); `active-role` senza tetto (submit + picker) → 2 rossi; l'effetto
`?scegli=1` senza tetto → 2 rossi; `clearTimeout` disattivato → 4 rossi nell'unitario + 1 nel
componente (`expected 3 to be +0`: i tre tetti della sequenza); il lavoro agganciato al solo ramo
`resolve` → 2 rossi, uno dei quali è l'`unhandledrejection` contato; `registraGuastoAccesso` azzerata
→ 6 rossi; il messaggio inesatto rimesso → 6 rossi; la distinzione «autenticato» tolta dal `catch` → 1
rosso. Test: `login-errori-servizio` 29 → **45**, più il nuovo
`__tests__/lib/auth-tetto-accesso.test.ts` (**9**).

---

## 🗓️ Changelog — La terza strada non aveva nessun `catch`, e quattro test dichiaravano più di quanto misurassero 2026-08-03 (branch `chore/conferme-umane`)

Rilievo W8-ter, sulla correzione W8-bis. La correzione **tiene**; il verificatore ha trovato la strada
accanto e quattro asserzioni che non sapevano diventare rosse.

**Il `catch` che non c'era proprio (bloccante).** Delle tre strade post-accesso, l'effetto `?scegli=1`
usciva con `void load();` e basta. Dentro `load` c'è `router.replace(...)`, che **lancia** se la
navigazione viene rifiutata: con profilo unico si otteneva un `unhandledrejection` e la pagina restava
su «Caricamento dei profili…» **per sempre**, a utente già autenticato — nessun messaggio, nessun log,
nessun form, nemmeno un bottone da premere. Il sintomo W8 esatto sulla terza strada. Le altre due il
loro `catch` ce l'avevano (`onSubmit`, `scegliRuolo`); è anche la regola 6 di AGENTS.md nella forma
più grave, perché non è un `catch` che tace, è un `catch` che manca. Ora `void load().catch(…)`, con
la guardia `cancelled` anche lì.

**`kv_user_role` restava scritto per un ruolo che il server aveva rifiutato.** Due percorsi su tre
persistevano prima della chiamata, e `onSubmit` scriveva perfino `me.role` prima di sapere quale ruolo
sarebbe andato in gioco (cioè `educator` a chi stava per premere «Genitore»). Finché si navigava
comunque, l'incoerenza durava un istante e la guardia d'area la risolveva; da W8-bis non si naviga
più, quindi **resta** sulla pagina di login, e `useSessionIdentity` legge quella chiave. La sonda del
verificatore leggeva `educator | educator | educator` dopo un 403. Ora si persiste **dopo**
l'accettazione del server, su tutte e tre le strade.

**403 e 401 non sono lo stesso guasto — decisione presa, e da ratificare.** Il ragionamento scritto nel
codice e in questo PRD giustificava il «non navigare» col solo **401** («la sessione non si vede»,
transitorio), mentre la fixture dei test usava solo **403** («Ruolo non disponibile per questo utente»,
permanente in astratto): l'argomento copriva metà dei casi che decideva, e i test lucchettavano proprio
il caso che l'argomento non nominava. **Si è scelto di tenere il trattamento unico**, con la ragione
vera scritta accanto: la causa più probabile di un 403 in questa app è ancora **transitoria** — una
lettura degradata in `getProfiliForAuthUid` — e la guardia d'area chiama **la stessa**
`getSessionProfili()`, quindi non ha nessun fallback da offrire per un ruolo che a quella fonte manca.
Costo dichiarato: se un 403 fosse davvero permanente, prima quell'utente entrava (guardia + fallback
ruolo unico) e ora legge un messaggio. Si accetta perché l'alternativa era portarlo in un'area con un
ruolo che il server non ha riconosciuto, per poi farlo rimbalzare in silenzio.
⚠️ **È una decisione di prodotto e va ratificata dal titolare prima del merge.** Se un giorno si
volesse distinguere (401 non naviga, 403 naviga), il punto da toccare è **uno**: lo `stato` dentro
`eseguiPasso`, non i tre chiamanti.

**E il `/api/me` → 401 «Utente non trovato»**, che è una risposta *legittima* per un utente autenticato
senza riga in `utenti` né in `parents` (la classe di bug di `parents.id != auth.user.id`): resta
classificato come **guasto**, di proposito. Non entrava nemmeno prima — finiva su `/`, e la guardia lo
rispediva al login in silenzio; ora almeno lo legge e lascia una riga in `app_log`.

**Quattro test che dichiaravano più di quanto misurassero.** `segnalaGuastoDopoAccesso` promette quattro
cose e i test ne asserivano tre: mai `aria-invalid`. Il `catch` di `scegliRuolo` non era raggiunto da
nessun test. La guardia `cancelled` non era misurata. E la fixture delle «tre strade» usava un solo
stato per due grandezze diverse.

| File | Cosa cambia |
|---|---|
| `src/app/auth/login/page.tsx` | `.catch` sull'effetto `?scegli=1` · `persisti('kv_user_role')` dopo il controllo nelle tre strade · rimossa la persistenza anticipata di `me.role` · commenti su 401/403, su `/api/me → 401` e sulle garanzie ora misurate |
| `__tests__/components/login-errori-servizio.test.tsx` | 68 → **86**: le tre strade in prodotto con **401 e 403** (lo stato entra nell'asserzione del log, non è più scritto a mano) · `aria-invalid` spezzato fra le strade col form e quella col picker · `kv_user_role` · il `catch` di `scegliRuolo` · l'effetto smontato in volo |
| `login-navigazione-singola.test.tsx` · `login-smistamento.test.tsx` | il mock di `/api/me` non deriva più `ok`/`status` da `h.me`: era **un interruttore per due grandezze**, e dopo W8-bis quel ramo 500 era codice morto che dava l'apparenza di coprire «/api/me giù» |

**Prova di validità, sei difetti rimessi uno per uno, tutti rossi**: `.catch` tolto dall'effetto → **1**
(il test che senza di lui non esiste); campi marcati non validi su `erroreRuolo` (M-A) → **4**;
`catch` di `scegliRuolo` con `fase=credenziali` e stato buttato via (M-D) → **1**; `persisti` rimesso
prima del controllo → **6**, due per strada; guardia `cancelled` scavalcata (M-E) → **1**. E il
**controllo in direzione opposta**, che prova che la fixture distingue davvero i due stati: fatto
tornare il 403 a navigare → **12 rossi, tutti e soli quelli del 403**, nessuno dei sei del 401.

---

## 🗓️ Changelog — La categoria «guasto dopo l'accesso» era nuova, e la strada accanto non la usava 2026-08-03 (branch `chore/conferme-umane`)

Rilievo W8-bis, sulla correzione W8 scritta poche ore prima. Il tetto di tempo tiene; ciò che non
teneva è la **categoria** che quella correzione aveva appena inventato (`fase=dopo-accesso`), applicata
al timeout e a nient'altro. Sonda su `/api/me → 500` dopo un'autenticazione riuscita:

    replace: [['/']] | alert: NESSUNO | log: []

**Un `/api/me` che risponde male non è un «profilo non disponibile».** `leggiProfilo()` collassava
**tre guasti diversi** — `fetch` che rifiuta, `!res.ok`, `res.json()` che rifiuta — sullo stesso `null`
con cui diceva «questo utente non ha profili», e il ramo di degrado li spediva su `/` senza una parola.
Da lì la guardia d'area, senza cookie di ruolo, rimandava a `?scegli=1`, dove la stessa fetch falliva
di nuovo, `elenco` tornava vuoto e si ricadeva sul form credenziali **muto**: due schermate e un giro
senza uscita, per un guasto che in `app_log` non lasciava niente (il 401, in particolare, il patch di
`fetch` non lo spedisce nemmeno — vedi `livelloFetch`). I due `.catch(() => null)` erano anche la
violazione diretta della regola 6 di AGENTS.md. Ora `passoDiRete` restituisce un esito **discriminato**
(`{guasto:false, dato}` / `{guasto:true, errore, stato}`) e il degrado graceful resta, ma solo per ciò
che è davvero un degrado: una risposta **arrivata e valida** da cui non si ricava un ruolo.

**Lo stesso `false` del server aveva tre trattamenti su tre strade.** `POST /api/auth/active-role` ha
tre chiamanti: `onSubmit` lo **ignorava** e navigava, il picker mostrava `erroreRuolo` **senza
loggare**, l'effetto `?scegli=1` non leggeva nemmeno il valore di ritorno. È la forma esatta del difetto
che W8 doveva chiudere. L'autorizzazione scritta nel codice — «best-effort sull'esito, la guardia ha il
fallback ruolo unico» — **decade**: quel fallback vale solo se il server riesce a leggere la sessione,
cioè precisamente ciò che un 401 da quella route dice che non riesce a fare; navigare comunque non è un
degrado gentile, è un rimbalzo muto. Adesso i tre passi passano da `eseguiPasso` + un'unica
`segnalaGuastoDopoAccesso` (messaggio · `aria-invalid` fermo · fine dell'attesa · log con la fase).
⚠️ **Corretto il 2026-08-03 (W8-ter, voce sopra): questo paragrafo argomentava sul solo 401 e la
regola la applicava anche al 403** — che è un guasto diverso, con una prognosi diversa. La regola resta
unica, ma la ragione per il 403 è un'altra ed è ora scritta accanto al codice (`impostaRuoloAttivo`).

**Il campo `fase` non era asserito dove serviva di più.** Nell'effetto `?scegli=1`, cambiare
`'dopo-accesso'` in `'credenziali'` lasciava arrivare i rossi **solo dal messaggio**: in tabella un
timeout della guardia d'area sarebbe finito nel conteggio dei guasti sulle credenziali — la confusione
che quel campo è stato introdotto per eliminare. Ora è lockato su tutti e due i percorsi dell'effetto.

**Un commento più forte del vero, corretto.** `conTettoDiTempo` dichiarava che un `AbortController`
«non può esserlo col client Supabase singleton». Falso: `createBrowserClient` accetta
`{ global: { fetch } }` esattamente come fa già `server-client.ts` con `creaFetchStrumentato()`. La
scelta di **abbandonare** invece di annullare resta difendibile — il costo è far viaggiare il segnale
per richiesta su un singleton condiviso da tutte le pagine — ma è una scelta, non un'impossibilità:
«impossibile» chiude la ricerca a chi legge, «costoso» la lascia aperta.

| File | Cosa cambia |
|---|---|
| `src/app/auth/login/page.tsx` | `passoDiRete` (esito discriminato) · `eseguiPasso` · `segnalaGuastoDopoAccesso` in `useCallback` · i tre passi post-accesso allineati |
| `src/lib/auth/errore-accesso.ts` | il commento su `AbortController`: da «non può» a «costa, e si è scelto di no» |
| `__tests__/components/login-errori-servizio.test.tsx` | +23 test (45 → **68**): le 4 rotture di `/api/me`, le 3 strade del ruolo attivo, il `fase=` dell'effetto, il degrado VERO |
| `__tests__/components/login-navigazione-singola.test.tsx` · `login-smistamento.test.tsx` | il degrado si prova con «profilo senza ruolo», non più con «/api/me giù» — che ora è un guasto dichiarato |

**Prova di validità, dieci manomissioni rimesse una per una, tutte rosse**: `!res.ok` inghiottito come
prima → **16 rossi**; `fase=dopo-accesso` → `credenziali` → 12; `onSubmit` che ignora il `false` del
ruolo → 3; il picker che mostra ma non logga → 1; l'effetto `?scegli=1` che non legge l'esito → 3;
`res.json()` senza rete → 1; la risposta non-ok privata del proprio nome di classe → 5; lo stato HTTP
tolto dal log → 7; `useCallback` tolto (l'effetto si rilancia: 2 fetch invece di 1) → 1. E il
**controllo in direzione opposta**: tolto il ramo di degrado graceful → **4 rossi**, fra cui il test
«degrado VERO» — la prova che i test nuovi misurano la *distinzione* e non un «non si naviga mai più».

---

## 🗓️ Changelog — I due lock nativi che si difendevano da soli: una denylist evasa e un modello più permissivo del codice vero 2026-08-03 (branch `chore/conferme-umane`)

Rilievo W9, sui lock scritti la mattina stessa per T14-F2 e T14-F3 (voce qui sotto). Nessuno dei due
proteggeva ciò che diceva di proteggere, ed erano **verdi**.

**1. La clausola «il flush è sincrono» era una denylist, e la denylist è stata evasa.** Vietava per
nome `new Thread`, `runOnUiThread`, `.post(`, `Executor`, `CompletableFuture`. Misurato:
`android.os.AsyncTask.execute(() -> CookieManager.getInstance().flush())` dentro `onPause`
passava **tutti e otto i test** — cioè esattamente la «correzione sbagliata» che il lock dichiarava
di vietare, con il flush di nuovo su un thread di pool in corsa con la morte del processo. Una
denylist è lunga quanto la fantasia di chi la scrive. Ora è una **allowlist di forma** che non nomina
nessuna API: il flush dev'essere un'istruzione diretta del corpo — nessuna lambda (`->`) né
riferimento a metodo (`::`) fra `super.onPause()` e la chiamata, profondità di graffe ≤ 1 — perché
qualunque costrutto capace di portarsi via la chiamata deve **aprirsi prima** di lei. Commenti e
stringhe vengono neutralizzati prima dell'analisi, così una graffa in una nota non falsa il conteggio.
È la stessa lezione dei lock delle news dello stesso giorno: si cerca il **comportamento**, non un
nome. Nel commento del lock è ora scritto **cosa non copre** (un flush reso irraggiungibile invece che
asincrono passa; un flush spostato in un metodo privato lo fa diventare rosso anche se è corretto).

**2. Il modello del test era più permissivo del codice nativo.** `mascheraCorrisponde` faceva
`.replace(/^https?:\/\//, '')` sulla maschera, ma **né `HostMask.Simple.parse` (Android) né
`doesHost(_:match:)` (iOS) tolgono lo schema**: spezzano su `.` e confrontano i pezzi, quindi
`allowNavigation: ['https://app.kidville.it']` non corrisponderebbe a niente su **nessuna** delle due
piattaforme, e «Riprova» tornerebbe a uscire dall'app. Il modello lo dava per buono: col difetto
rimesso restavano verdi 11 test su 12. Oggi la configurazione vera è scritta **senza** schema, quindi
funziona — ma per come è scritta, non per progetto. Ora ci sono **due porti fedeli**, uno per
piattaforma, e non è un dettaglio di stile: le due implementazioni **non sono equivalenti**. Su
Android `if (maskSize > 1 && hostSize != maskSize)` fa saltare il controllo di lunghezza quando la
maschera ha un pezzo solo, cioè `allowNavigation: ['it']` farebbe entrare **qualunque sito `.it`**
dentro la WebView, accanto ai cookie di un genitore; iOS lo rifiuterebbe. Il lock ora vieta gli schemi
e le maschere di un segmento solo.

**3. Un test ridefiniva `document.cookie` e non lo rimetteva a posto.** Innocuo finché è l'ultimo del
file; il primo test aggiunto dopo avrebbe ereditato il finto archivio. Ripristinato in `afterEach`
(`vi.unstubAllGlobals()` non annulla `Object.defineProperty`) e **verificato da un test**, non promesso.

**Conseguenza dichiarata e NON chiusa — `URL_APP` resta un letterale di produzione.** In una build di
collaudo (`CAP_SERVER_URL=http://10.0.2.2:3100`) «Riprova» ora carica `app.kidville.it` **dentro la
WebView, ma senza bridge**: `Bridge.loadWebView` limita `addDocumentStartJavaScript` alla sola origine
configurata (`Collections.singleton(allowedOrigin)`, `Bridge.java:266-274`), quindi su produzione
`window.Capacitor` non esiste — niente fotocamera, push, biometria, share, badge. Prima di T14-F2 quel
pulsante portava su produzione **in Chrome**, con barra degli indirizzi e via d'uscita; ora inchioda
l'utente su produzione in una WebView senza barra e con le funzioni native morte. In entrambi i casi
**sui dati veri delle famiglie**. Il rimedio sarebbe rendere `URL_APP` funzione della build, e **non è
stato fatto**: `cap sync` non passa da nessuno script npm né dalla CI — è digitato a mano in una
decina di punti fra `docs/mobile.md`, `docs/store-submission.md`, i prompt dei tester e il README dei
flow Maestro — e la pagina non ha nessun segnale a runtime da cui dedurre il server (vive su
un'origine diversa, senza bridge e senza storage condiviso). Un generatore agganciato a un wrapper npm
che nessuna di quelle righe invoca renderebbe il file *sembrare* corretto lasciando le build di
collaudo puntate a produzione: un falso verde peggiore del difetto. Chi rifà il giro sulla shell
nativa lo chiuda insieme al cambio del modo di compilare, aggiornando anche quei documenti.

**Prova di validità, quattro difetti rimessi a mano**: l'evasione `AsyncTask.execute(() -> …)` →
rosso il criterio della lambda (prima: 8 verdi su 8); la stessa cosa con una classe anonima → rosso il
criterio della profondità (3 > 1); lo strip dello schema rimesso nel modello → 2 rossi; lo schema
rimesso nella configurazione vera → **6 rossi** dove il modello vecchio ne dava 1. Il lock del
ripristino cookie: tolto l'`afterEach`, rosso. Test dei due file: 20 → **26**.

---

## 🗓️ Changelog — Il tasto «Riprova» che usciva dall'app, e la sessione che moriva in trenta secondi 2026-08-03 (branch `chore/conferme-umane`)

Collaudo Android T14-F2 + T14-F3. Due difetti dell'app nativa, cause radice diverse, un tratto in
comune: **nessuno dei due era visibile ai test formali**, e nessuno dei due sta nel codice
dell'applicazione web.

**T14-F2 — «Riprova» apriva il browser di sistema.** Dalla schermata di ripiego nativo
(`mobile/www/offline.html`, `server.errorPath`) il pulsante faceva uscire l'utente dall'app: fuori la
sessione nativa, fuori biometria e push, dentro Chrome — e **su produzione**, anche con una build di
collaudo puntata altrove. Causa radice letta sul sorgente di Capacitor, non dedotta: la pagina vive
sullo **schema locale** (`https://localhost` su Android, `capacitor://localhost` su iOS), quindi la
sua navigazione verso `app.kidville.it` è fuori origine, e finisce in
`startActivity(ACTION_VIEW)` (`Bridge.java:389-417`) o in `UIApplication.shared.open`
(`WebViewDelegationHandler.swift:95-115`) **a meno che l'host non sia in `server.allowNavigation`** —
che non era configurato: `HostMask.Parser.parse(null)` restituisce una maschera che non corrisponde a
nulla. L'unica cosa che tratteneva l'utente dentro l'app era la **coincidenza** fra l'URL cablato
nella pagina e `server.url`: vera in produzione, **falsa** sull'emulatore (`10.0.2.2`) e falsa in una
build fatta senza `CAP_SERVER_URL` (dove `appUrl` ripiega su `https://localhost`). Due configurazioni
su tre uscivano dall'app. Correzione: `server.allowNavigation: ['app.kidville.it']` in
`capacitor.config.ts` — un host solo, scritto per esteso, con i link esterni che continuano ad
aprirsi fuori.

**T14-F3 — la sessione moriva se si chiudeva l'app entro ~30 secondi dal login.** L'ipotesi che il
rilievo suggeriva («un cookie di sessione senza scadenza») **è stata falsificata prima di correggere
qualsiasi cosa**: `@supabase/ssr` scrive ogni cookie con `Max-Age` di 400 giorni, sia dal browser sia
dal middleware — ed è persistente. E quell'ipotesi non spiegava il dato che contava, la **finestra**:
un cookie di sessione si perde sempre, non solo entro trenta secondi. La causa vera è nativa e sta
scritta nella documentazione dell'SDK Android (`android/webkit/CookieSyncManager`): «browser cookies
are saved in RAM. A separate thread saves the cookies between, **driven by a timer**». Fra la
scrittura del cookie e il suo arrivo su disco c'è una finestra, e **nessuno la chiudeva**: in
`@capacitor/android` 8.4.2 l'unico `flush()` vive nel plugin `CapacitorCookies` e
`Bridge.onPause/onStop/onDestroy` non toccano i cookie. `MainActivity` era una classe dal corpo
vuoto. Correzione: `CookieManager.getInstance().flush()` **sincrono** dentro `onPause` — il primo
callback garantito quando l'app perde il foreground — con log di successo *e* di errore, e un `catch`
che non fa crashare l'app. Resta scoperto, ed è detto nel codice: un processo che muore **senza**
passare da `onPause` (crash del render process, «Arresta» dalle impostazioni) perde ancora la
finestra.

**Difesa.** Due lock nuovi, 20 casi. `riprova-offline-resta-nella-webview` **riproduce** le due
decisioni native citate sopra e le applica alla configurazione vera nelle tre build possibili, con i
controlli negativi che contano (un dominio estraneo deve **ancora** aprirsi fuori; nessun jolly in
`allowNavigation`, che trasformerebbe la WebView in un browser aperto con dentro la sessione di un
genitore). `cookie-sessione-persistito-android` blinda il flush dov'è e **com'è** — spostarlo su un
thread lo rimetterebbe in corsa con la morte del processo — e tiene ferma l'ipotesi falsificata con
un test di comportamento che guarda la stringa che finisce in `document.cookie`.

**Prova di validità, tre difetti rimessi a mano**: `MainActivity` riportata al corpo vuoto → 7 test
rossi; il flush spostato su un `new Thread` → rosso il test che lo vieta; `allowNavigation` rimosso →
6 rossi, cioè esattamente le due configurazioni che uscivano dall'app su entrambe le piattaforme.

**Limite da non abbellire: la prova sul dispositivo NON è stata eseguita.** `KV_TEST_PASSWORD` non era
nell'ambiente e senza credenziali il percorso «login → chiudi → riapri» non è percorribile
(`.claude/maestro-flows/esegui.sh` esce con codice 1). Questi lock dicono che il codice **c'è** e che
la configurazione soddisfa la condizione che il codice nativo valuta; non che la WebView si comporti
così su un telefono. La verifica su emulatore resta da fare. Nessuna migrazione, nessuna scrittura
sul database.

---

## 🗓️ Changelog — Nessuna chiamata a un provider esterno aveva un tetto di tempo 2026-08-03 (branch `chore/conferme-umane`)

Collaudo T16-F2 + T18-F3. **`fetch` non ha nessun timeout di suo**, e in questo repo nessuno gliene
dava uno: email (Resend), push (FCM/APNs), fatturazione (Aruba/SDI), SIDI, health-check Instagram.
Se il provider accetta la connessione e non risponde, la promise **non si risolve mai**: chi ha
premuto «invia» aspetta senza limite e senza errore, e la funzione resta occupata fino al taglio di
piattaforma.

**Misurato, non dedotto**: un server locale che accetta e tace, chiamato con la stessa primitiva, è
rimasto appeso **150 secondi senza eccezione né timeout**. `AbortSignal` compariva in `src/` **due
volte sole**, entrambe nella sonda della pagina offline — nessuno dei 13 chiamanti di
`externalFetch` ne passava uno.

**Causa radice**: `src/lib/logging/external.ts` — `await globalThis.fetch(url, init)` senza
`signal`. Il modulo era nato come strato di **osservabilità** e non aveva mai preso in carico la
**resilienza**, pur essendo l'unica porta da cui passano tutti i provider (lo impone il lock
`provider-esterni-osservati`).

**Correzione, in un posto solo invece di tredici**: un tetto di default *dentro* `externalFetch`
(`signal: init?.signal ?? AbortSignal.timeout(...)`). Default **10 s**; tabella per provider dove il
default è il numero sbagliato — **Instagram 4 s** (unica chiamata sincrona con un operatore che
aspetta: si stringe da qui senza toccarne la route) e **Aruba 30 s** (upload FatturaPA e PDF in
base64). Sovrascrivibile per chiamata (`opzioni.timeoutMs`); un `init.signal` del chiamante vince su
tutto. Fail-open: un runtime senza `AbortSignal.timeout` perde il tetto, non la chiamata.

**Il timeout diventa visibile** — era il buco silenzioso. L'interruzione passa dal ramo `catch` che
c'era già, ma il `DOMException` di piattaforma viene **rietichettato**: `code: 'timeout'` (colonna
`app_log.codice`, cioè `where codice = 'timeout'`), nome proprio `ExternalTimeoutError` per il
raggruppamento di Vercel, il tetto in millisecondi dentro il messaggio, e il motivo originale
conservato come `cause`. Senza, in tabella sarebbe finito **`23`** — il codice legacy di
`DOMException` — indistinguibile da uno status: di nuovo il numero che non dice nulla. «Il provider
non risponde» e «il provider non si raggiunge» ora si separano in SQL.

**Difesa**: 13 casi in `__tests__/lib/logging-external.test.ts`, di cui tre **misurati contro un
server vero** che accetta e non risponde. Prova di validità doppia: togliendo il `signal` i tre test
muoiono per scadenza (il difetto, alla lettera); togliendo la rietichettatura il codice torna `23`.
Nessuna migrazione, nessuna scrittura sul DB.

---

## 🗓️ Changelog — La pagina «non sei in rete» che si vedeva solo la prima volta 2026-08-03 (branch `chore/conferme-umane`)

Collaudo T16-F1. Senza rete, chi aveva già usato l'app non vedeva la pagina «non sei in rete» ma
l'error boundary — **«QUALCOSA È ANDATO STORTO»**. Riprodotto 3 volte su 3 su una build di
produzione, ed era lo **stato stazionario**, non un caso limite: l'offline funzionava appena
installata l'app e si rompeva man mano che la si usava.

**Causa radice**: `precarica()` in `public/sw.js` faceva `fetch('/offline')` e metteva in cache **un
solo oggetto**, il documento. La `fetch` di un Service Worker scarica dei byte, non apre una pagina:
non c'è parser HTML, quindi nessuna sotto-risorsa veniva mai richiesta. Il documento `/offline`
referenzia 15 chunk, 14 dei quali **condivisi con `/auth/login`**; l'unico esclusivo è
`ContenutoOffline` (~3,8 kB). Da qui il comportamento che sembrava assurdo: ad app appena installata
in cache non c'è quasi nulla, React non parte e disegna lo script inline — com'è progettato; dopo un
po' di navigazione i 14 condivisi ci sono (ce li mette `assetStatico` durante l'uso normale), React
**parte**, non trova il quindicesimo e muore, e l'error boundary sostituisce l'intero albero,
cancellando anche ciò che lo script inline aveva già disegnato. **Mezzo bundle è peggio di nessun
bundle.**

**Correzione** (decisione del titolare, «salvo anche i pezzi della pagina»): `precarica()` legge
l'HTML del documento appena scaricato — da un `res.clone().text()` preso **prima** di
`ricostruisci()`, che consuma il corpo — ne estrae gli attributi `src`/`href` che cominciano per
`/_next/` e li scarica e conserva insieme al documento (`precaricaSottoRisorse`). Il filtro su cosa
si può scrivere resta **`conservabile()`, che esisteva già**: in sviluppo i chunk non sono immutabili
e continuano a non entrare in cache. Un pezzo che non arriva non porta via il documento, ma non è
muto: `sw-precache-pezzi-offline-incompleta` (un pre-cache a metà è il seme dell'error boundary).
Scartata l'alternativa «rendere /offline una pagina senza componenti client»: riaprirebbe l'incidente
del doppio elenco già chiuso il 02/08.

**L'assunto sbagliato viveva in quattro commenti** — «un chunk che non carica = idratazione
impossibile», vero solo se falliscono **tutti** — e sono stati riscritti (`script-offline.ts` ×3,
`ContenutoOffline.tsx`). Difesa: 7 casi nuovi in `__tests__/offline/sw.test.ts`, fra cui uno che
rilegge dalla cache il documento **salvato** e pretende che ogni `/_next/` che referenzia sia a sua
volta in cache. Impronta `IMPRONTA-PAGINA-OFFLINE` aggiornata; ⚠️ **`VERSIONE` (`v4`) va alzata al
rilascio**, com'è scritto sopra la sua dichiarazione. Nessuna migrazione, nessuna scrittura sul DB.

---

## 🗓️ Changelog — Il gemello scoperto: `PATCH /api/gallery` rispondeva col NOME di un minore di un'altra sede 2026-08-03 (branch `chore/conferme-umane`)

Collaudo T05-F1. Il 31/07 il tagging della galleria era stato chiuso: `POST /api/gallery` verifica
che ogni bambino in `tag_students` sia nei plessi di chi pubblica, e nega **403 senza dire quali**.
Il presidio però era stato scritto **dentro l'handler della POST** — venti righe, non una primitiva —
e il `PATCH`, che i tag li accetta esattamente allo stesso modo, non l'ha mai avuto:

```
PATCH /api/gallery {"id":"<un mio media>","tag_students":["<uuid di un minore di un'altra sede>"]}
  ⇒ 422 { "nomi": ["<nome e cognome veri>"], "ids": [...] }
```

cioè il nome di un bambino di un altro plesso, **più l'informazione che gli manca la liberatoria
fotografica**, servito a chiunque ne conosca l'uuid — e un uuid non è un segreto. È la stessa fuga
del 31/07, riaperta un metro più in là.

**La causa non è una dimenticanza, è dove viveva la regola.** La precondizione di
`alunniSenzaConsenso` («il chiamante ha già verificato che quegli alunni siano suoi») stava in un
**commento**, che per giunta rimandava a una riga di `gallery/route.ts` diventata nel frattempo
un'altra cosa. Un compilatore i commenti non li legge: dei due chiamanti uno rispettava la
precondizione e l'altro no. **Una precondizione che non sta nella firma è un auspicio.**

**Cosa cambia.** (a) Nasce `src/lib/gallery/tag-scope.ts` con `assertTagStudentsInScope(supabase,
tag, sedi, operazione)`: **una** funzione, chiamata da POST *e* PATCH, 403 senza nomi né id nel corpo
e log di soli conteggi. La copia dentro la POST è stata tolta, non affiancata. (b)
`alunniSenzaConsenso` prende un terzo parametro **obbligatorio** `sedi` e filtra
`.in('scuola_id', sedi)` — stesso modello di `verificaConsensoSito` (news): un id che non torna
indietro non è «senza consenso», è **non verificabile**, blocca lo stesso ma **senza pronunciare
nessun nome**. Scope vuoto ⇒ nega. (c) Nel PATCH si guardano i tag **effettivi** (gemello del
controllo sul broadcast): un media che porta ancora un tag fuori sede non si modifica finché quel tag
c'è, e la via d'uscita è la stessa richiesta con i tag corretti. (d) Due codici d'errore nuovi,
tradotti IT/EN: `TAG_FUORI_SEDE` (403, non dice **quali** bambini di proposito) e
`VERIFICA_TAG_NON_RIUSCITA` (500: un guasto di lettura non si traveste da «non sono tuoi»).

**I test che dicevano il falso, e sono la parte che conta.** L'intestazione di
`gallery-tag-students-scope.test.ts` prometteva «POST/PATCH» ma il file importava **solo `POST`**:
tre `it` su un handler solo, mentre l'altro era scoperto. Ora i casi girano su entrambi. In
`gallery-privacy.test.ts` il finto client rispondeva alla `.in('scuola_id', …)` con **tutte** le
righe di quella sede ignorando il filtro sugli id: la sua `it` sul PATCH sarebbe rimasta verde anche
coi tag di un altro plesso — un mock che tace è peggio di un mock che manca. La voce di allowlist
`gallery:PATCH` del lock d'isolamento esentava l'**intero** handler: ora nomina la singola query che
copre (i media caricati da chi chiama, chiave = la sua stessa identità).

Prova di validità eseguita tre volte: tolto il gate dal PATCH → 5 test rossi (422 dove serve 403);
tolto `.in('scuola_id', sedi)` dalla primitiva → il test torna «Uno Prova / Due Prova» invece degli
uuid, cioè il nome esce davvero; tolto il gate dalla POST → 4 test rossi. Nessuna migrazione, nessuna
scrittura sul DB: in produzione `galleria_media_v2` è vuota, il difetto era **latente**.

---

## 🗓️ Changelog — La quarta rotta che pubblicava senza chiedere, e la foto che restava pubblica dopo la cancellazione 2026-08-03 (branch `chore/conferme-umane`)

Collaudo T18-F1 + V4. Il bucket `news` è l'unico **PUBBLICO** dei tredici: servito a chiunque
conosca l'indirizzo, senza login. Il consenso al canale «sito» era già controllato in tre punti, e
tre punti non bastavano — sempre per la stessa causa, **una regola valida per N strade e scritta su
N-1**. Quattro buchi chiusi, e un lock perché non ce ne sia un quinto.

**(a) `POST /api/news/[id]/approva` non chiamava il gate.** La segreteria approva la proposta di un
docente e, nel ramo normale (`pubblica_subito !== false`), la rende visibile nello stesso istante:
`grep gateConsensoFoto src/` dava tre chiamanti e questa rotta non era fra loro. Un docente propone
l'articolo con la foto di un bambino, la famiglia revoca, la segreteria approva → foto online, gate
formale verde. Ora il gate sta fra il controllo di stato e la costruzione di `updates`, **solo sul
ramo che rende visibile subito**: approvare tenendo il post in bozza, programmarlo e RIFIUTARE non
mettono niente online, e bloccare il rifiuto renderebbe il gate un ostacolo alla revoca stessa.

**(b) `DELETE /api/news/[id]` cancellava la riga e lasciava il file.** L'articolo spariva dal sito,
l'immagine del minore restava al suo indirizzo pubblico — e senza più nessuna riga che la nominasse:
né `verificaPermanenzaConsenso` (legge `news_posts`) né `obliaFotoNewsAlunno` (cerca l'uuid in
`bambini_ritratti`) potevano più arrivarci. Guasto **invisibile e permanente**, prodotto dal gesto
che sembra il più definitivo. La regola «PRIMA il file (verificato), POI la riga» esisteva già dentro
il ritiro: è stata **estratta** in `liberaFilePubbliciDelPost` e chiamata da entrambi. Se i file non
escono, la riga non si tocca → 503 `NEWS_FILE_NON_RIMOSSI` (codice nuovo, tradotto IT/EN).

**(c) Le foto ferme in BOZZA non le guardava nessuno.** Un media diventa pubblico alla **creazione**
(`promuoviMediaBozza`), non alla pubblicazione; la sorveglianza però passava solo su
`pubblicata`/`programmata`. Un articolo abbandonato in bozza teneva la foto del bambino a un
indirizzo pubblico a tempo indeterminato, e la revoca non ci arrivava mai. `STATI_ESPOSTI` diventa
**`STATI_SORVEGLIATI`** (`+ bozza, proposta`); `nascosta` resta fuori di proposito, ed è ciò che
rende la passata idempotente. La domanda giusta non è «questo post si vede?» ma «un file di questo
post può stare nel bucket pubblico?».

**(c-bis) `obliaFotoNewsAlunno` era scritta, testata e non chiamata da nessuna parte.** Ora
`anonimizzaAlunno` la chiama (punto 3g-bis): l'oblio toglie l'articolo dalla vista, il file dal
bucket e l'uuid dalla dichiarazione **subito**, invece di aspettare fino a dieci minuti il tick.
`REGISTRO_BUCKET_OBLIO.news` passa da `coperto-fuori-oblio` a **`coperto` / canale `alunno`** — e il
lock che verifica il registro contro il codice (`gdpr-oblio-completo`) adesso lo copre davvero.

**(d) Il lock, perché non ci sia una quinta strada** —
`__tests__/architecture/news-pubblicazione-gated.test.ts`: enumera da solo le rotte sotto
`src/app/api/news/**` che mettono un post in `pubblicata` o che inseriscono in `news_posts` e
pretende che ciascuna nomini `gateConsensoFoto`; chi cancella deve nominare
`liberaFilePubbliciDelPost`. Una sola eccezione, il tick del cron, **con motivo scritto e controllo
positivo** che il meccanismo alternativo (`verificaPermanenzaConsenso`) sia davvero nel file: una
allowlist che si limitasse a esentare sarebbe un modo elegante di riaprire il buco.

In produzione oggi: 3 post pubblicati, 0 con `copertina_url`, 0 con `bambini_ritratti` — il difetto
era **latente, non in atto**. Nessuna migrazione, nessuna scrittura sul DB.

---

## 🗓️ Changelog — Venti collaudi in venti chat: il kit di collaudo manuale 2026-08-03 (branch `chore/conferme-umane`)

Nessuna riga di prodotto toccata: questo lavoro aggiunge **documentazione operativa**. Il repo
aveva già `/ship-cycle`, che collauda da solo con 11 tester dentro una chat sola. Mancava il modo
di collaudare **a mano, in parallelo, con venti chat separate** — che è quello che serve quando si
vuole guardare una cosa alla volta fino in fondo, e quando il collaudo deve poter essere ripetuto
senza far girare la pipeline.

### 1. Il catalogo dei tipi di test — `docs/collaudo/00-TIPI-DI-TEST.md`

Ricerca su cosa si collauda prima di un rilascio, riportata sul prodotto vero: livelli della
piramide, intenti (smoke, sanity, regressione, esplorativo, limiti, migrazione dati), non
funzionali (prestazioni, sicurezza, privacy, accessibilità, compatibilità, localizzazione,
osservabilità, resilienza), **processo di rilascio** (parità d'ambiente, rollback, canary, smoke
post-deploy, backup), mobile e store, contenuti. La tabella che conta è quella finale: **cosa il
gate automatico copre già, e cosa resta scoperto**. La colonna di destra è costruita sui difetti
che qui sono passati **col gate verde** — le email ferme con un `403` senza corpo, l'isolamento fra
sedi con 3424 test verdi, il loop biometrico Android.

### 2. Venti prompt atomici — `docs/collaudo/prompt/tester-01…20`

Uno per collaudo, autosufficienti. Ognuno porta i comandi veri di questo repo, i lock architetturali
che lo riguardano, e **le trappole già pagate** nel suo dominio (`VERSIONE` in `sw.js` che tiene
ferme le correzioni offline sui telefoni; `10.0.2.2` su Android contro `localhost` su iOS;
`-project` e non `-workspace` per Capacitor 8; `waitFor` su un'asserzione già vera che passa
subito e non prova niente).

Due vincoli sono cablati in ogni prompt perché venti chat girano **insieme sullo stesso albero di
lavoro**: nessun `git`, nessun `npm install`, e una tabella di proprietà delle risorse (la suite
intera e la build sono del tester 01, l'emulatore Android del 14, il simulatore iOS del 15).
Il terzo vincolo è il database: `.env.local` punta a **produzione**, quindi **solo `SELECT`**,
solo `GET` verso le API, e nessun salvataggio dall'interfaccia.

Ogni prompt chiede una **prova di validità** prima di concedere un `PASS`: dimostrare che il
collaudo *saprebbe* fallire. È la regola che qui ha già smascherato due test falsi verdi.

### 3. Il formato e la sintesi — `MODELLO-REPORT.md`, `SINTESI.md`

Lo schema del report è quello già in uso dagli agenti `tester-opus-*` (categoria · comandi ·
verdetto · fallimenti con `file:riga`, causa radice e riproduzione · **warning anche quando il
verdetto è PASS**), con in testa un blocco YAML che rende i venti report sommabili senza
rileggerli. `SINTESI.md` è il prompt della chat finale: deduplica, **verifica adversariale dei
bloccanti**, ricerca della causa radice comune, piano di correzione ordinato, e l'elenco di cosa
è rimasto scoperto.

### 4. Dove finiscono i risultati

`docs/collaudo/risultati/` è **esclusa da git** (`.gitignore`): i report nascono leggendo il
database di produzione, il repository è pubblico. I prompt sono versionati, i risultati no.

`CLAUDE.md` guadagna il collegamento che fa funzionare la frase in una chat nuova: **«tu sei il
tester n. X»** → apri `docs/collaudo/prompt/tester-XX-*.md` e seguilo.

Gate a repo fermo: nessuna modifica a `src/`, nessuna migrazione, nessuna variabile d'ambiente
nuova. Documentazione e `.gitignore`.

---

## 🗓️ Changelog — I sei E2E rossi: un puntino di sospensione, e una sede in meno di quante ce ne sono 2026-08-02 (branch `fix/multisede-audit-globale`)

`Lint · Typecheck · Unit` verde, `E2E (Playwright)` rosso: **6 test su 48**, merge bloccato
(run `30765844979`). Nessuno dei sei era un difetto di prodotto nuovo. Erano **due** cause, e
tutte e due hanno la stessa forma: un'informazione che vive in due posti e nessuno che li tenga
insieme.

### 1. Quattro selettori accecati da un carattere — `...` diventato `…`

`admin-students`, `isolamento-sedi` (× 2) e `teacher-avvisi` fallivano tutti con
`locator.fill: Test timeout … waiting for getByPlaceholder('…')`. L'applicazione era **sana**:
il 1° agosto un rilievo di localizzazione aveva sostituito nei cataloghi i tre punti ASCII con
l'ellissi tipografica `…` — la forma corretta, in una quarantina di stringhe. Ma
`getByPlaceholder()` senza `exact` cerca per **sottostringa**, e `...` non esiste dentro `…`:
quattro selettori sono diventati ciechi nello stesso istante, in tre file di test che nessuno
aveva toccato.

Difetto di **selettore**, non di codice: il testo nuovo è migliore e resta. I selettori ora si
fermano prima della punteggiatura, così un'altra virgola in coda non li ricompra.

La correzione vera però non è quella, è il **lock**:
`__tests__/architecture/e2e-selettori-placeholder.test.ts` estrae ogni `getByPlaceholder('…')`
degli spec e verifica che almeno un placeholder del prodotto — cataloghi `messages/it/**` o
letterali di `src/` — lo possa soddisfare, con la stessa semantica di Playwright. Girava rosso
sui quattro selettori **prima** della correzione. È il gemello mancante della regola R5 del lock
dei flow Maestro: la stessa disciplina esisteva già per una delle due suite. Costo di scoprirlo
prima: due secondi in `vitest run`, sulla macchina di chi rinomina l'etichetta. Costo di
scoprirlo dopo: trenta minuti di CI e un merge fermo.

### 2. L'iscrizione pubblica: due sedi di collaudo, e nessuna sede da dichiarare

`public-iscrizione` compilava tutti e quattro i passi — anagrafica del minore, codice fiscale,
documento d'identità — e all'invio riceveva
`400 {"error":"Specificare la scuola per l'iscrizione"}`. Il secondo test della coppia
(«l'import mostra il degrado email») falliva di conseguenza: senza domanda, non c'è niente da
importare.

Le due metà della causa stavano in due file, e **ciascuna era corretta da sola**:

- il wizard trattava «elenco pubblico delle sedi **vuoto**» come «una sede sola, vai avanti».
  L'assunzione era scritta in un commento: *«o sul DB E2E, dove l'elenco pubblico è vuoto — il
  flusso resta identico a prima»*;
- `POST /api/iscrizione` deduce la sede solo se ne esiste **una**. Dal 2026-07-31 il seed della
  CI ne crea **due** — serviva una seconda sede per poter provare l'isolamento fra plessi — ed
  entrambe portano il prefisso `e2e00000-…`, quindi `isScuolaE2E` le esclude da ogni elenco
  pubblico: `reali` vuoto, `tutte` due. Il 400 è la risposta **giusta**, e resta: con due
  candidate, indovinare significa archiviare la domanda di un minore nel plesso sbagliato senza
  dirlo a nessuno.

L'assunzione del wizard è decaduta quel giorno e nessuno l'ha riletta. Difetto di **ambiente**
per il test, di **codice** per il silenzio: un elenco pubblico vuoto vuol dire *«nessuna sede su
cui iscriversi»*, ed è lo stesso difetto che il ramo d'errore aveva appena chiuso, con un'altra
faccia. Ora il wizard lo dice **prima** che la domanda cominci, con una frase propria — «Nessuna
sede riceve iscrizioni online» — e senza il pulsante «Riprova», che ripeterebbe la stessa
risposta. In produzione il ramo non si attiva: verificato sul server vivo,
`GET /api/iscrizione/sedi` risponde con le tre sedi vere (Aversa, Cesa, Giugliano).

La suite E2E entra ora dal **link targato** `/iscrizione?scuola=<id>` — la scorciatoia per
plesso che il modulo prevede da sempre, e che il POST valida contro *tutte* le sedi, di collaudo
comprese, proprio per questo percorso.

**Due test che difendevano il comportamento vecchio** sono stati riscritti, non cancellati:
`EnrollmentWizard-sede` e `EnrollmentWizard-sedi-errore` dichiaravano «elenco vuoto → si compila»
sotto l'etichetta *NON-REGRESSIONE*. Erano veri quando il database della CI aveva una scuola
sola. Al loro posto c'è il caso nuovo, più quello del link targato, più — in
`__tests__/api/iscrizione-scuola.test.ts` — le **due sedi di collaudo** che il database della CI
ha davvero: 400 senza sede dichiarata, 201 con.

Gate a repo fermo: `eslint 0` · `tsc 0` · **vitest 673 file / 6308 test** · `build ok`.
Nessuna migrazione, nessuna variabile d'ambiente nuova.

---

## 🗓️ Changelog — L'arretrato: 152 rilievi, e la firma che chiunque poteva chiedere 2026-08-02 (branch `fix/multisede-audit-globale`)

Il secondo giro di collaudo aveva restituito 152 voci — 17 gravi, 16 minori, 119 warning — quasi
tutte **preesistenti** e su aree che il ciclo del collaudo non aveva mai toccato. Il titolare ha
deciso di chiuderle tutte, warning compresi, prima di qualunque merge. Dieci esecutori in
parallelo, divisi per file.

### La firma elettronica che chiunque poteva chiedere

`POST /api/forms/send-otp` non verificava **nessuna identità** e accettava un `signerEmail`
arbitrario su una submission altrui: chi conosceva un `submissionId` si faceva recapitare il codice
all'indirizzo che voleva e **firmava al posto del genitore**, su un documento con valore legale.
Chiuso con il gate d'identità su POST *e* PATCH, la verifica del titolo sulla firma, e il
destinatario vincolato ai **tutori registrati in anagrafica** invece che al corpo della richiesta.

Strada facendo sono emersi due difetti che nessuno aveva chiesto di cercare: la sospensione per
morosità si aggirava **omettendo** `userId` dal body, e tre letture PostgREST ignoravano `{ error }`
— un guasto di lettura usciva come «non trovata». La regola vale per POST e PATCH e vive in **una
funzione sola**: è la lezione che questo branch ha già pagato due volte.

### L'upload anonimo, e i 500 che raccontavano il database

`POST /api/iscrizione/upload` accettava caricamenti **anonimi** nel bucket dei documenti
d'iscrizione dei minori, senza tetto per IP e senza allowlist di tipo — mentre le tre rotte sorelle
ce l'avevano. Ancora la porta accanto. E sei route di upload rispondevano `500` a un errore del
**client**: un `Content-Type` sbagliato è un 400, e il 500 dice «ho un guasto io», sporcando ogni
misura di salute. Due di esse rimandavano al chiamante il messaggio interno del runtime.

### Le foto dei minori, e il consenso che non si poteva revocare

La fotografia di un minore pubblicata sul blog finiva in `news`, l'unico bucket **pubblico** dei
tredici, dichiarato escluso dall'oblio: se la famiglia esercitava il diritto all'oblio, la foto
restava online per sempre. E la **revoca** del consenso fotografico non aveva effetto sugli articoli
già pubblicati — il consenso era verificato alla creazione, alla modifica e alla pubblicazione, e
poi non lo ricontrollava più nessuno. *Un consenso che non si può revocare non è un consenso.*

Insieme: l'oblio dichiarava `n_file_non_rimossi: 0` **anche quando lo Storage non aveva tolto
niente**, perché quando la risposta non era un array si assumeva che fossero stati rimossi tutti.
Una richiesta di oblio risultava evasa mentre i file di un bambino restavano nell'archivio.

### Accessibilità: 68 bottoni senza nome, non 17

Il tester ne aveva contati 17; il lock scritto per impedirne il ritorno ne ha trovati **68**. È la
differenza fra un campione e un inventario, ed è il motivo per cui ogni correzione di questo ciclo
finisce in una regola su tutti i file invece che in una lista di file. Chiusi anche: il modale con
cui il genitore **firma con valore legale** (non annunciato come dialogo, campo del codice senza
nome, errore mai letto, niente Esc), i quattro campi senza etichetta del «Nuovo acquisto», il
registro protocolli che si apriva solo col mouse, e i colori di marchio usati come inchiostro.

### La domanda d'iscrizione che si perdeva

Sul modulo pubblico — ~9 domande l'ora da famiglie vere — se l'elenco delle sedi non arrivava
(429 o 500) il passo «Sede» **spariva senza dire niente**: il genitore compilava tutta la domanda e
la perdeva all'invio. La causa: `sedi.length > 1` non distingue un elenco vuoto **per errore** da
«c'è una sede sola».

### La difesa che valeva solo fino ad Android 14

`windowSoftInputMode="adjustResize"`, aggiunto il giorno prima come «unica correzione difendibile»,
è stato **misurato** compilando un APK gemello con `adjustPan`: su **API 33** è decisivo — senza, il
composer della chat sparisce davvero sotto la tastiera — ma su **API 36 è inerte**, perché da
Android 15 le app con `targetSdk ≥ 35` sono edge-to-edge per forza e non ridimensionano più la
finestra. Questa app dichiara `targetSdk 36`. La riga resta, il commento no: nessuno deve credere
che sia la difesa su un telefono nuovo.

Nella stessa misura è emerso un difetto **nuovo e non chiuso**: in orizzontale il bottone «Invia»
è tagliato dal bordo (API 36), e su API 33 ruotando dentro una conversazione **la conversazione si
chiude** — perché non sta nell'URL, quindi il cambio di configurazione la butta via. È debito
dichiarato.

### Il terzo collaudo, e perché il ciclo non converge a «tutto verde»

Rieseguito il collaudo sulle correzioni: **sicurezza, localizzazione e log passano**; le due porte
sui dati di minori sono chiuse e confermate da chi non le ha chiuse. Ma restano 19 rilievi gravi, e
la loro natura è il dato che conta:

- **tre erano errori introdotti oggi**, e sono stati corretti: la password degli account TEST di
  produzione in chiaro in 303 file (Maestro la scrive anche in JSON, e la bonifica mascherava solo
  la forma shell); le due migrazioni applicate con una `version` che in produzione era diversa dal
  nome del file — con il lock scritto apposta **verde**, perché confrontava il repo con una
  fotografia presa prima; e una quarta affermazione mia più forte della misura;
- **gli altri sono arretrato profondo dell'app**, non regressioni: 239 campi con un'etichetta
  visiva non associata al campo, 1184 punti di testo a 2,51:1, 25 pannelli che si comportano da
  modale senza esserlo, 324 file nel bucket delle iscrizioni (430 MB) che nessuna riga del database
  cita — quindi né la retention né l'oblio possono raggiungerli.

Gli undici tester collaudano **l'intero prodotto**, non il diff: ogni giro troverà qualcosa finché
l'app non sarà perfetta. Chiamare «ciclo non convergente» questo comportamento sarebbe sbagliato —
sta facendo esattamente il suo mestiere. Ma significa che *«tutti gli undici in PASS»* non è una
condizione raggiungibile in un giro: è la descrizione di un prodotto finito.

### La coda: il gate che stava sotto la lettura del corpo

Tre difetti sopravvissuti al giro, chiusi dopo il terzo collaudo:

- **`POST /api/primaria/fascicolo` rispondeva `500` a un anonimo**, restituendogli il messaggio
  interno del runtime. La causa non era una funzione mancante ma **l'ordine**: `formData()` sta
  sopra il gate, *lancia* se il Content-Type non è multipart, e l'eccezione scavalcava
  l'autenticazione finendo nel `catch` generico. Su una rotta che custodisce diagnosi, PEI, PDP e
  verbali della 104. Ora `401`.
- **`POST /api/public/forms/<token>/submit` rispondeva `500` su un token malformato**, e la causa
  era **scritta in un commento**: *«il token pubblico è una stringa opaca, non un uuid»* — ma nella
  baseline la colonna è `public_token uuid` e la valorizza `randomUUID()`. Il token storto arrivava
  fino alla query e Postgres rispondeva `22P02`. Ora `404`, byte-identico alla risposta di un uuid
  inesistente: chi prova a indovinare non impara niente dalla differenza.
- Le **sei route** che leggevano `request.formData()` nudo sono sulla primitiva condivisa, e il
  nuovo lock verifica due cose separate: che si usi la primitiva, **e che il gate preceda la
  lettura del corpo** — perché è l'ordine, non il nome della funzione, ad aver causato il primo.

Rimosso anche il file di prova che il collaudo aveva lasciato nel bucket di produzione (5 byte,
contenuto letterale `test`): 961 file rimasti, i due documenti veri caricati quel giorno intatti.

E un difetto **introdotto durante la correzione**, dichiarato da chi l'ha fatto: il `codice` del
nuovo 404 usciva come chiave di catalogo invece che di `CODICI_ERRORE`, e il lock `errori-con-codice`
era **verde** — perché verifica che un codice ci sia, non che si risolva. Se ne è accorto solo
guardando il corpo della risposta sul server vivo.

Gate a repo fermo: `eslint 0` · `tsc 0` · **vitest 672 file / 6302 test** · `build ok`.
Migrazioni **applicate in produzione** con l'approvazione del titolare, una per una:
`20260802173254` (sorveglianza sulla conservazione a 24 mesi) e `20260802200000` — il bucket
`form_attachments`, che custodisce carte d'identità, certificati e fotografie di minori, era
configurato **senza alcun limite** (`file_size_limit` e `allowed_mime_types` entrambi `NULL`)
ed era raggiungibile da due rotte anonime. Ora dichiara cinque tipi e un tetto di 8 MB.
Verificato prima di applicare: i 962 file presenti sono tutti dei tipi ammessi e il più grande
pesa 4,49 MB — nessun caricamento reale viene respinto. `get_advisors`: **0 ERROR**.

È la rete che resta quando la prossima rotta di upload dimenticherà il gate applicativo, e non
è un'ipotesi: `iscrizione/upload` è nata senza controlli ed è vissuta così finché il collaudo
non l'ha misurata.

---

## 🗓️ Changelog — Il collaudo sui dispositivi: quando il gate verde certificava l'assenza della prova 2026-08-02 (branch `fix/multisede-audit-globale`)

Il ciclo del 1° agosto si era chiuso col gate verde — `eslint 0` · `tsc 0` · 5741 test · `build ok`
— e con una riga di debito scritta nero su bianco: **i tre flow Maestro iOS non erano mai stati
eseguiti** dopo la correzione dei selettori. Erano iscritti in `FLOW_SENZA_ESECUZIONE_VERDE`, e
questo è il punto che conta: **il verde certificava che la prova mancava, non che il collaudo
fosse stato fatto.** Chi leggesse «gate verde» come «mobile collaudato» sbaglierebbe, e il registro
esiste apposta perché quell'assunzione diventi una riga in diff invece di un commento rassicurante.

Questo ciclo ha eseguito le prove che mancavano. Tutte e quattro hanno cambiato una conclusione che
sembrava già scritta.

### I tre flow iOS: verdi — e la spiegazione che avevo scritto era più forte della misura

| flow | esito | esecuzioni |
|---|---|---|
| `ios-percorso-segreteria` | 33 COMPLETED, 0 FAILED | 2 su 2 |
| `ios-percorso-genitore` | 27 COMPLETED, 0 FAILED | 2 su 2 |
| `ios-percorso-docente` | 27 COMPLETED, 0 FAILED | 2 su 2 |

**La prima versione di questo paragrafo diceva due cose false, e le ha smontate il collaudo di
questo stesso ciclo** — il tester mobile-iOS, a cui era stato chiesto per iscritto di cercare
«un'affermazione più forte di quanto le misure dimostrino». Le ha trovate, ed è il motivo per cui
quella richiesta va messa in ogni collaudo:

1. *«I tre flow erano in `FLOW_SENZA_ESECUZIONE_VERDE` e nessuno li aveva più lanciati.»* Falso.
   Sotto `~/.maestro/tests` ci sono **sette esecuzioni iOS del 1° agosto**, fra le 12:51 e le
   13:32, tutte con 0 FAILED. I flow erano già verdi undici ore dopo la correzione dei selettori.
   Il registro dice ciò che qualcuno ha **scritto nel file**, non ciò che è stato **eseguito sulla
   macchina**: il debito era stato iscritto alle 01:10 e nessuno l'ha tolto quando le esecuzioni
   sono arrivate. È lo stesso difetto che il registro esiste per combattere, preso dal verso opposto
   — e dimostra che un registro va letto **anche** contro gli artefatti, non solo contro il diff.
2. *«Senza toccare un solo selettore.»* Falso rispetto al rosso del 31 luglio. Fra quel rosso e
   questo verde sono cambiate **due** variabili, non una: il commit `462630c` del 1° agosto ha
   riscritto i selettori dei tre flow (175 righe aggiunte, 54 tolte) — «Buongiorno!» → «Dashboard»,
   «Apri la bacheca» → «Menu · tutte le sezioni», «Modifica appello» → «Fai l'appello ora|Modifica
   appello», più la gestione dei dialoghi dei permessi. Attribuire il verde al solo cambio di server
   era una conclusione a una variabile su un esperimento a due.

**Cosa dicono davvero le misure**, senza aggiungerci niente: con i selettori di oggi e l'app servita
da `next start`, i tre flow passano, due esecuzioni su due ciascuno; con gli stessi selettori
passavano già il 1° agosto; il rosso del 31 luglio aveva selettori diversi *e* un server diverso,
quindi non è isolabile su una causa sola. Che `next dev` sia inadatto resta documentato per Android
da una misura propria («l'emulatore non idrata `next dev`», 17 luglio); su iOS resta una
raccomandazione prudenziale, non un esperimento controllato.

Per il flow **docente** la spiegazione del verde è invece chiara e non ambigua, perché non passa
dall'ambiente: il rosso era su «Buongiorno!», il saluto **orario** che alle 22:07 diventa
«Buonasera!»; l'ancora è ora la tab «Dashboard», che non cambia mai, e le due esecuzioni di oggi
sono di pomeriggio. Il flow non collauda più l'orologio.

Il **tap cieco a coordinate** `68%,93%` per il tab «Mensa» del cockpit funziona, e il controllo
negativo `assertNotVisible: "Tutti i moduli"` dimostra che lo schermo si è mosso invece di restare
fermo. Anche qui la prima stesura esagerava: non è la prima volta che gira su iOS — lo stesso flow
era passato 36/36 il 1° agosto.

`TETTO_FLOW_SENZA_ESECUZIONE_VERDE`: **4 → 1**. Resta `android-screenshot-playstore.yaml`, fuori
dal perimetro di oggi e dichiarato come tale.

### I sei login (S28): il difetto non si riproduce, e il limite è scritto

Il lock diceva che i sei login consecutivi sull'app vera non erano mai stati eseguiti — e la
versione ancora precedente di quel commento affermava il falso, cioè che la prova fosse «riportata
nel PRD». Eseguiti: sei esecuzioni **separate** con `clearState: true`, 6 su 6 arrivate alla home,
`assertNotVisible` sui tre testi di `offline.html` verde ogni volta, e nel log di sistema sei righe
«filtro annullamenti agganciato» con **PID diversi** — cioè sei avvii veri. «mostro la schermata
offline»: **0**.

Il limite, che resta scritto nel lock e non va abbellito: **«navigazione annullata» compare 0
volte**. In quelle sei sessioni l'annullamento non è avvenuto, quindi il filtro era agganciato ma
non *esercitato*. È l'atteso dopo la correzione a monte del login, ma la prova sul dispositivo
dimostra «non si riproduce in 6 su 6», non «il filtro intercetta». Quella metà la dimostra
`ios/prove/filtro-annullamenti/esegui.sh`, rieseguita: 10 verifiche su 10, compresi i due controlli
**negativi** (−1009 rete assente e −1004 server irraggiungibile *arrivano* a Capacitor, cioè la
schermata offline compare ancora quando serve davvero).

### La tastiera Android sulla chat: non riprodotta, e la garanzia che era solo un default

Il rilievo era aperto perché la volta scorsa era stato misurato su una **sonda** che riproduceva il
layout, non sulla chat vera. Rifatto sulla schermata vera, genitore e docente, due versioni di
Android, con la tastiera confermata da `dumpsys input_method` invece che dedotta:

| | tastiera chiusa | tastiera aperta | «Invia» |
|---|---|---|---|
| **API 36** (411×731) | `innerHeight` 731 | 399 | bottom 695 → 387, **visibile** |
| **API 33** (393×778) | `innerHeight` 778 | 499 | bottom 766 → 487, **visibile** |

`visualViewport.offsetTop` sempre 0, 12px di margine sotto il bottone. **Non riprodotto.** Anche
l'ipotesi alternativa — un `transform` su un antenato che diventa blocco contenitore per i `fixed`
— è **falsificata a runtime**, risalendo l'intera catena da `[aria-label="Invia messaggio"]` fino a
`documentElement`: nessun antenato con `transform` diverso da `none`.

Nessun rimedio applicativo è stato aggiunto, e in particolare **non**
`interactive-widget=resizes-content`: i numeri dicono che il comportamento che quella direttiva
imporrebbe è già quello di default. **Un rimedio che non fa niente è peggio del rilievo aperto**,
perché chiude la voce e toglie a chiunque la ragione di guardarci ancora.

L'unica correzione difendibile è un'altra, ed è stata fatta: il comportamento misurato dipendeva da
un **default di sistema**, non da una nostra scelta. Senza `windowSoftInputMode` vale
`adjustUnspecified` e decide la ROM; sulle versioni provate risolve in `adjustResize`, ma una che
risolvesse in `adjustPan` farebbe scorrere la finestra e il composer uscirebbe davvero dallo
schermo. Ora è dichiarato in `AndroidManifest.xml`, con un lock che ha superato la **prova di
validità** (tolta la riga → rosso; rimessa → verde).

### Gli 8 errori del pannello «Problemi»: il rimedio ovvio era inerte

Non erano difetti del progetto e non hanno mai toccato il gate, `npm run build` o la build Android.
Sono l'estensione Java dell'editor che importa come progetti a sé quattro cartelle Android dentro
`node_modules`. Ma il rimedio che sembrava ovvio — «escludi `node_modules` dall'import» — **è
inerte**: quei quattro pattern sono già il default di `redhat.java`, parola per parola. E i quattro
progetti non arrivano da una scansione di `node_modules`: li include per nome
`android/capacitor.settings.gradle`, un file che Capacitor rigenera e che si apre con «DO NOT EDIT
THIS FILE». La documentazione dell'estensione chiude la via di mezzo: *«Gradle projects cannot be
partially imported»*.

Applicata la scelta del titolare: puntare il Gradle dell'IDE al **JDK 21 che Android Studio si
porta dietro**, senza installare nulla. Con una riserva scritta nel file, perché i log dicono che i
due problemi sono distinti — 99 occorrenze di «Can't read root project location» sui quattro
progetti che danno errore, e 10 di `ToolchainProvisioningException` su `capacitor-camera`, che
invece non ne dà. Se dopo «Java: Clean Java Language Server Workspace» il pannello resta a 8, la
causa è la prima e l'unica cosa che li toglie è non importare affatto i progetti Gradle.

### Il collaudo ha trovato due porte aperte sui dati di minori

Gli undici tester hanno collaudato **l'intero branch** (48 commit, 767 file), non i quattro commit
della giornata, e hanno restituito 10 FAIL su 11. Due rilievi erano falle di autenticazione vere,
verificate a mano col server vivo:

- **`GET /api/admin/primaria/docenti-materie` rispondeva `200` a un anonimo**, con
  `createAdminClient()` — cioè il client service-role, con la RLS scavalcata per costruzione:
  nome e cognome del personale, materie e id di sezione di qualunque classe di qualunque sede.
  `POST` e `DELETE` dello stesso file avevano già `requireStaff` + `assertSezioneInScope`. È
  ancora **la porta accanto**, per la quarta volta in questo branch.
- **`GET /api/diary?alunno_id=` non aveva alcun gate** e restituiva `500` col messaggio interno
  del database. Il ramo `classe_id` aveva `requireDocente`, il ramo del genitore no. Oggi non
  espone dati perché quella tabella in produzione non esiste — il giorno in cui esistesse,
  restituirebbe il diario di qualsiasi bambino a un anonimo.

Chiuse entrambe (`200 → 401`, `500 → 401`). Ma il pezzo che conta è il lock, e la ragione per cui
ragiona **per ramo e non per handler**: un rilevatore ingenuo «c'è un gate in questa funzione?»
sarebbe stato **verde sulla seconda falla**, perché un gate c'era — solo, non su quella strada.
`gate-coverage.test.ts` verifica che ogni accesso ai dati sia preceduto da un gate **nel suo ramo**,
con 16 rotte pubbliche in allowlist verificate una per una.

### Gli altri ventidue rilievi, chiusi su richiesta del titolare

Fra i quali: la scheda di un alunno non si apriva **da tastiera** (25 schede irraggiungibili senza
mouse); 26 caselle di selezione senza nome per lo screen reader; il nome della **sede** scritto a
2,51:1, sotto la soglia AA, proprio nelle righe nuove del multi-sede; l'Alto Contrasto assente sul
modulo pubblico d'iscrizione, da cui arrivano ~9 domande l'ora; gli importi della Contabilità in
formato anglosassone; il client **Aruba/SDI** che buttava via il corpo dell'errore — la riproduzione
esatta del guasto storico delle email; la fattura che non loggava né il successo né lo scarto; il
lavoro notturno della conservazione che **non poteva accorgersi di fallire** (`pg_net` è asincrono:
l'`EXCEPTION` non vedrà mai un 4xx del worker); la guardia che bloccava in modo permanente la
cancellazione a 24 mesi dell'intero lotto; l'oblio GDPR che non svuotava 5 magazzini di file su 7;
l'elenco duplicato su `/offline`; l'appello che falliva in silenzio.

Ricorre una forma sola, ed è la stessa da tre cicli: **una regola giusta applicata a una lista
chiusa**. Il divieto del grigio illeggibile valeva su sei file elencati a mano, e il ciclo dopo l'ha
riscritto altrove; l'oblio è stato costruito per rilievo invece che partendo dall'elenco dei bucket;
`formatEuro` esisteva e non era obbligatorio. Le correzioni di oggi sostituiscono ogni lista chiusa
con una regola su tutti i file più un'allowlist esplicita e un tetto che può solo scendere.

### Il flow Android che sembrava rotto, e non lo era

Quattro esecuzioni fallite di fila sul gate «Dashboard», con un sospetto scritto nel registro che
puntava all'app. La causa era altrove e vale come metodo: **il server `:3100` girava da ore su una
build che era stata sostituita**, e serviva HTML con chunk che su disco non esistevano più. Niente
CSS, React non idrata, i campi restano vuoti — e `tapOn: "Accedi"` risulta `COMPLETED` senza inviare
niente, lasciando a schermo il messaggio nativo del browser «Please fill out this field». Il flow
moriva due passi dopo, su un'asserzione che parlava di tutt'altro. **Un `next build` non lo ripara:
il manifest è in memoria, serve il riavvio.** Dopo il riavvio: genitore 27/27 e docente 31/31, due
esecuzioni su due, senza toccare i selettori.

### Quello che questo ciclo NON ha provato

- Tutte le misure Android sono su **emulatore**, con Gboard, in verticale, a schermo intero.
  Restano non provati un dispositivo fisico, le tastiere di terze parti, l'orizzontale, lo
  split-screen. **API 30 è bloccata** per una ragione diversa: quella WebView è Chrome 91 e il
  bundle non ci gira (`SyntaxError: Unexpected token '{'`), quindi non dice niente sulla tastiera.
- Il conteggio del pannello «Problemi» a 0 **non è dimostrato**: richiede la clean del Language
  Server e il riavvio dell'editor, che si fanno dall'interfaccia.
- `android-screenshot-playstore.yaml` resta senza esecuzione verde dal 28 luglio.

Gate a repo fermo: `eslint 0` · `tsc 0` · **vitest 648 file / 5943 test** · `build ok`.

**Non ri-collaudato dagli undici tester dopo le correzioni**: il gate formale è verde e ogni
correzione porta la sua prova di validità (difetto rimesso → rosso; tolto → verde), ma il giro
completo dei tester su questo albero non è stato rifatto. Va detto, perché è esattamente la
distinzione che questo ciclo ha passato la giornata a difendere.

---

## 🗓️ Changelog — Il ciclo di correzione ripreso dopo uno spegnimento, e i quattro difetti che nessun collaudo aveva visto 2026-08-01 (branch `fix/multisede-audit-globale`)

Alle **03:50 del 1° agosto** il computer si è spento mentre undici esecutori scrivevano l'ultima
ondata del piano di correzione. Il codice era tutto su disco; i loro report — compresa la voce
«cosa NON ho chiuso» — sono andati persi tutti e undici.

Ricostruirli a posteriori ha insegnato più del lavoro stesso: **il gate verde non dice che il
lavoro è finito, dice che ciò che è stato scritto non è rotto.** Uno step lasciato a tre quarti —
il codice c'è, il test c'è, ma manca il pezzo che chiudeva il difetto — passa senza fare rumore.
Undici verificatori sui singoli step: **3 chiusi, 8 parziali**.

### Le otto migrazioni in produzione, e la prova che nessuno aveva fatto

Applicate una per una con l'approvazione del titolare, e verificate **contro il database** invece
che contro i propri commenti: 3 job di conservazione (24 mesi per le domande mai evase, i dati
sanitari che escono dalla domanda accolta, il contenuto del registro docenti a 12 mesi), la colonna
delle password in chiaro rimossa, i consensi fotografici per canale, la dichiarazione di chi
pubblica una foto, l'allowlist MIME dei bucket, l'ultimo link firmato a 365 giorni della chat
riportato a percorso, le policy dell'orario per sede, 1 notifica orfana su 60. `get_advisors`:
0 ERROR. In tutto **3 righe di dati cambiate** su 249 domande intatte.

**La policy dell'orario non era mai stata provata**, e non poteva esserlo: quelle tabelle sono
vuote in produzione, quindi «il genitore vede 0 righe» non dimostra niente — è vuoto per tutti, e
il rilievo di sicurezza era una porta senza niente dietro. Con due righe di prova sulle due sezioni
**omonime** «TEST Infanzia» (Giugliano e Aversa — il caso che ha aperto l'intero audit) e una
sessione vera via PostgREST: `1 riga, quella di Giugliano` · `[] sulla riga di Aversa`. Controllo
positivo e negativo nella stessa misura.

### Quattro difetti che il collaudo non aveva visto

1. **Due migrazioni con lo STESSO timestamp.** Sul disco una collisione non fa rumore; si
   manifesta quando si applica, e delle due ne entra una sola — l'altra viene rifiutata o
   considerata «già applicata» e **saltata in silenzio**. Il repo avrebbe detto che i genitori di
   Aversa non leggono più l'orario di Giugliano, e il database non l'avrebbe mai saputo. Il lock
   esistente non poteva vederla: guardava i duplicati in produzione, dove la `version` è chiave
   primaria e la collisione è impossibile per costruzione.
2. **Il PUT degli avvisi non ha mai avuto il gate di sede.** Il POST l'ha dal 30 luglio; la
   MODIFICA aveva solo il gate di ruolo, poi scriveva `target_classes` grezzo. Bastava modificare
   un avviso per assegnarlo a una classe di un altro plesso — o a un id di sezione invece che a un
   nome — ricevendo **200 con la riga aggiornata**. In produzione due avvisi veri avevano l'id:
   10 alunni in sezione, 10 genitori agganciati, **0 raggiunti**.
3. **La password degli account TEST era in chiaro in 70 file** di log Maestro (278 occorrenze). Lo
   strumento per toglierla esisteva; nessuno l'aveva mai eseguito, perché il README insegnava
   `maestro test` a mano e non nominava lo script. E la bonifica inseguiva **un valore** — quello
   corrente — quindi era cieca sulle password già ruotate (altre 156 righe) e lo sarebbe
   ridiventata a ogni rotazione.
4. **Un OTP a sei cifre provabile un milione di volte, che firmava.**
   `PATCH /api/forms/send-otp` non aveva nessun tetto sui tentativi. Non l'ha trovato una ricerca:
   l'ha trovato un **lock scritto per un altro step**, che invece di elencare rotte spezza ogni
   file nei singoli handler HTTP — un lock per file sarebbe passato, perché in quella route la
   parola `rateLimit` c'è, ma sta nel POST.

### La forma ricorrente: la porta accanto

Tre dei quattro hanno la stessa forma, ed è la stessa del rilievo C8 del piano: *una regola chiusa
su una strada e lasciata aperta su quella accanto*. Il POST corretto e il PUT no; i promemoria che
ricevono il massimo di lunghezza e gli avvisi no (dove il `500` con dentro il tipo della colonna
era ancora riproducibile parola per parola); il tetto OTP su una firma su quattro. Ogni volta
perché due esecutori diversi avevano in mano i due lati, e chi teneva l'uno non aveva ragione di
guardare l'altro. La contromisura non è «stare più attenti»: è che **una regola che vale per due
strade viva in un posto solo** — da qui `@/lib/avvisi/classi-sede` e `@/lib/validation/avvisi`.

### Debito dichiarato (non chiuso, ma scritto)

- I tre flow Maestro **iOS non sono mai stati eseguiti** dopo la correzione: sono iscritti in
  `FLOW_SENZA_ESECUZIONE_VERDE`, quindi il gate è verde **perché** la prova manca, non nonostante.
  Vale anche per i sei login consecutivi di S28, che restano da fare sul simulatore.
  → **Chiuso il 2026-08-02**: i tre flow eseguiti due volte ciascuno e i sei login fatti sull'app
  vera. Vedi la voce di changelog in cima. Questa riga resta com'era scritta quel giorno: è la
  fotografia di ciò che allora era vero, non un errore da correggere.
- Il rate-limit conta **in memoria, per istanza**: su Vercel il tetto reale è N × il limite
  dichiarato. Regge perché i tentativi non si accumulano su un codice solo (il ticket vive dieci
  minuti), ma il numero non è garantito finché il contatore non passa a uno store condiviso.
- Il **login non ha un tetto applicativo**: autentica dal client con Supabase, quindi non esiste
  una nostra route su cui appenderlo. È una decisione di prodotto, non una riga di codice.
- Un **allegato orfano storico** in `avvisi_allegati` (24/05/2026, nessun avviso lo referenzia) e i
  file di prova dei collaudi attendono una decisione: rimuoverli con la service key o dichiararli.
- Restano dal ciclo precedente: i **452 messaggi d'errore italiani** nelle route (l'inventario può
  solo rimpicciolirsi), le **11 policy `using(true)`** accettate con la motivazione scritta accanto,
  e le **93 domande con `raccolta_senza_informativa = true`** — dove il flag documenta il problema,
  non lo chiude.

Gate a repo fermo: `eslint 0` · `tsc 0` · **vitest 617 file / 5573 test** · `build ok`.

---

## 🗓️ Changelog — Audit globale multi-sede: 140 rilievi chiusi col gate verde, dal 400 che non arrivava mai alle foto dei bambini leggibili senza login 2026-07-31 (branch `fix/multisede-audit-globale`)

Il 2026-07-29 Kidville è passata da un plesso a **tre**. Per due giorni il gate formale è rimasto
verde — 3540 test — e non perché l'isolamento tenesse: **un filtro di sede mancante non rompe
niente, restituisce solo più righe**. Non c'è nulla da vedere finché non esistono due sedi.

Venti agenti hanno riletto il codice riga per riga e interrogato il database di produzione:
**140 rilievi confermati** (10 bloccanti · 55 gravi · 42 minori · 33 note), raccolti in
`docs/audit/2026-07-31-audit-globale-multisede.md`. I piani di correzione — con la **prova di
validità obbligatoria** su ogni step (rimettere il difetto, vedere il test diventare rosso) — sono
in `docs/superpowers/plans/2026-07-31-multisede-audit-globale.md` e nel piano di chiusura (12 step,
3 ondate). Chiusi **tutti**, non solo i bloccanti: oltre 360 file toccati, **84 route API**,
**19 migrazioni** applicate in produzione.

### Il presupposto che era falso: «pre-lancio, nessun dato reale»

`CLAUDE.md` autorizzava merge, deploy e migrazioni automatiche in produzione con una ragione sola:
*«siamo pre-lancio, e in produzione non c'è ancora nessun dato reale di famiglie e bambini»*.
Misurato il 31/07: `enrollment_submissions` contiene **227 domande di iscrizione vere**, con
**152 codici fiscali distinti di minori**, 51 righe con allergie e 36 con note mediche in testo
libero, raccolte **dal 16 luglio** dal modulo pubblico — circa **nove invii l'ora** (erano 156 la
mattina, 227 a sera: la tabella cresceva mentre la si contava). Il lancio commerciale non c'è
stato; i dati sono arrivati lo stesso, e nessuno aveva più riletto quel promemoria da quando il
modulo pubblico è andato online.

**La lezione, scritta in cima al file perché non torni:** «pre-lancio» è una frase sul calendario,
non una misurazione. L'unica domanda che conta è *quante righe reali ci sono adesso*, e ha una
risposta che si ottiene con una query. Decisione del titolare del 2026-07-31, ora nel PRD e in
`CLAUDE.md`: ogni migrazione e ogni merge si mostrano e si fanno approvare, uno per uno. I cinque
punti operativi (permessi in `ask`, `defaultMode`, conferma esplicita nel comando, *required
reviewers* su GitHub) restano da applicare come **ultimo atto** del rilascio — attivarli a metà
lavoro avrebbe bloccato la sessione che li scrive, e il testo lo dice a chi legge dopo.

### La causa radice comune: il 400 promesso non esisteva

`resolveScuolaScrittura` deve rispondere **400 «Specificare la sede»** a chi ha più plessi e non ne
indica nessuno — lo dice AGENTS.md dal 29 luglio. Non è mai successo: il ripiego su
`user.scuola_id` **precedeva** la condizione d'errore, quindi il ramo che nega era codice morto.
La Direzione che lavorava su Aversa, guardando Aversa, si vedeva scrivere i dati su Giugliano.
Senza un errore, senza un log, senza un test rosso.

Il file non aveva **un solo test proprio**: 83 file di `__tests__/` lo *mockavano*, zero lo
importavano — cioè l'unico modulo su cui poggia l'intera tenancy era l'unico mai verificato. Ora ne
ha 55, ed è il primo che lo importa davvero.

**Il gemello del difetto, chiuso in chiusura d'audit.** Lo stesso primitivo accettava la sede
*dichiarata* solo se accessibile — e se **non** lo era tirava dritto: decadeva a «non dichiarata» e
scriveva altrove, con 200/201 e senza un log. Misurato: `POST /api/mensa/alternative` con lo
`scuola_id` di Cesa fatto da un utente di Aversa → **200, riga scritta su Aversa**; idem
`POST /api/gallery`. Il difetto era noto e tamponato route per route, ma le chiamate sono **65 in
54 file**: un tampone su 54 non è una difesa, è un promemoria. Il controllo è ora **dentro** il
primitivo (sede dichiarata e non accessibile ⇒ **403** + log `warn`) e i tamponi locali sono
spariti; in lettura `restringiASedeRichiesta` rispondeva già 403 per lo stesso caso — erano due
risposte diverse alla stessa domanda. **Quattro test asserivano il comportamento sbagliato** e sono
stati riscritti, non aggirati: uno mentiva in modo istruttivo — mockava `resolveScuolaScrittura`
con «dice sempre di sì» e verificava il 403 prodotto dal tampone, cioè verificava il tampone e non
la regola. Le asserzioni nuove sono sulla **mutazione**, non sullo status: con la sede fuori scope
nessuna riga viene scritta da nessuna parte, e accanto c'è sempre il controllo positivo.

### Le tredici famiglie di guasti

| | Famiglia | Il caso peggiore che conteneva |
|---|---|---|
| **F1** | La sede la sceglieva il server invece di pretenderla | Ogni scrittura senza sede dichiarata finiva nel plesso primario dell'operatore |
| **F2** | Route chiuse a metà: gate di **ruolo** scambiato per gate di **tenant** | `admin/students` PATCH rileggeva per intero la scheda di un minore di un'altra sede — note mediche, codice fiscale, indirizzo — a fronte di una scrittura innocua; il DELETE la cancellava. `admin/sections` PATCH con schema `.loose()` lasciava **riscrivere `scuola_id`**: la chiave di tenancy stessa |
| **F3** | Il nome della classe usato come identità | Due «Girasoli» in due plessi: `.limit(1)` senza `ORDER BY` sceglieva a caso fra due gruppi di bambini |
| **F4** | RLS dell'era mono-sede: policy che rispondono «che ruolo hai» e mai «su quale sede» | 33 tabelle con firme, pagelle e audit leggibili da **qualunque autenticato**; le policy di `presenze` davano a ogni genitore lettura **e scrittura** sull'intera sede |
| **F5** | Due semantiche opposte per `scuola_id NULL`, e un trigger che deduceva la sede da un `ORDER BY` di uuid | `fn_form_submission_etl` archiviava **ogni minore iscritto a Cesa**, qualunque plesso avesse scelto la famiglia |
| **F6** | Destinatari delle notifiche risolti senza il ponte `utenti_scuole` | Per Aversa e Cesa l'allarme allergie e il **panic alert** non arrivavano a nessuno, e il cron marcava l'invio come riuscito |
| **F7** | Oggetti di collaudo dentro la produzione | La password del seed E2E era un letterale in un repository **pubblico**, su un account `ruolo='admin'` che il provisioning del 29/07 aveva collegato a **due sedi vere** |
| **F8** | I lock e i test non tenevano | Il finto client Supabase accettava `.or()`, `.neq()`, `.not()` e li **ignorava**, e non aveva `insert()` né `delete()`: con un mock così un test d'isolamento è verde anche senza il filtro nella route |
| **F9** | L'inventario dell'audit del 30/07 mentiva | 12 voci marcate CHIUSA che `git show --name-only` dice non essere mai state toccate |
| **F10** | Il cockpit non era multi-sede | Sotto i 1024px l'avviso «scegline una dal menu in alto» indicava un menu che su mobile **non esisteva** |
| **F11** | Lo schema non difendeva il tenant | 31 tabelle accettavano qualunque uuid come `scuola_id`: non una fuga, una **sparizione** — quella riga non appartiene a nessun plesso e diventa invisibile a ogni filtro |
| **F12** | Una sede nuova nasceva vuota | Cesa aveva cinque classi di primaria senza una sola disciplina e senza scala dei giudizi. Nessun errore, da nessuna parte |
| **F13** | Fail-open nelle librerie condivise | Scope non calcolato ⇒ si procedeva **senza filtro**, invece di negare |

### I file: quello che il database proteggeva e lo Storage no

Il gate di ruolo, l'isolamento per sede e la regola «foto privata» giravano tutti **sul database e
mai sul file**. Il bucket `gallery` era **pubblico**: bastava avere — o indovinare — l'indirizzo per
vedere la foto di un bambino **senza login, senza scadenza e fuori da ogni controllo**. Era un
limite noto e messo per iscritto nel codice («hardening con signed-URL in un follow-up»), rimasto
innocuo solo perché la galleria non è mai entrata in esercizio: `galleria_media_v2` e
`galleria_media` hanno **zero righe** in produzione. Stessa forma su `avvisi_allegati` (1 file) e
`task_allegati`, dove però l'indirizzo pubblico era proprio quello che l'app mandava al browser di
ogni famiglia — e l'allegato di un avviso è il modulo di una gita coi nomi dei bambini.

I tre bucket sono **chiusi** (`public: false`) e il codice ci parla come si parla a un bucket
privato: in tabella si archivia il **percorso**, non un indirizzo; `GET /api/gallery` genera i link
**firmati a 10 minuti**, in blocco (`createSignedUrls`: una chiamata per pagina, non una per foto),
**dopo** il gate e lo scope di sede. `gallery/upload` non chiama più `getPublicUrl` — quell'indirizzo
oggi risponde **400**, misurato — e restituisce `path` più un `previewUrl` firmato; `POST /api/gallery`
riconosce e normalizza gli URL pubblici completi che un client vecchio potesse ancora rimandare, e
le righe storiche salvate come URL vengono firmate lo stesso. Il fallimento della firma **non è
silenzioso** (AGENTS §3): `error` col corpo del provider e i soli conteggi — mai il percorso, che
porta con sé l'uuid di chi ha caricato — media con `file_url: null`, e `MediaGrid` mostra
«Anteprima non disponibile» invece di un `<img src="">` che avrebbe fatto ripartire una richiesta
sulla pagina stessa. **Effetto collaterale voluto**: il link «Condividi» ora **scade**. Prima era un
indirizzo eterno e pubblico — chi lo riceveva poteva rigirarlo a chiunque, per sempre.

**Il presidio che teneva chiuso il bucket non c'era.** Il blocco «assicura il bucket» chiamava
`createBucket`/`updateBucket` **senza guardare il valore di ritorno** — e come PostgREST, lo Storage
non lancia: ritorna `{ error }`. «Lo rimettiamo privato a ogni caricamento» era una promessa che
nessuno verificava. Ora un fallimento si logga col corpo, e trovare il bucket **ancora pubblico**
produce una riga `error` dedicata **prima** di richiuderlo (richiuderlo e tacere cancellerebbe la
traccia). La stessa cecità aveva già lasciato passare una discrepanza viva: `gallery` aveva
`file_size_limit` **50 MB** mentre il codice ne dichiara 200 — il video di una recita superava tutti
i controlli dell'applicazione e veniva respinto dallo Storage. Il bucket `news`, che non esisteva e
sarebbe nato **pubblico dentro un `try`** al primo caricamento, è ora dichiarato in migrazione:
pubblico **per decisione del titolare** — è un blog rivolto all'esterno e un link firmato scadrebbe
— che è una scelta scritta, non una configurazione subita.

### Privacy: quattro schermate consegnavano più di quanto mostrassero

Con 227 domande di famiglie vere in produzione, il peso di ogni risposta HTTP cambia.

- **La dashboard restituiva il modulo d'iscrizione intero.** Il widget «iscrizioni in attesa» mostra
  «Richiesta N · da gestire» e una data; la riga che lo alimentava leggeva la colonna JSONB
  `enrollment_submissions.data`, che non è una data: è il modulo compilato dalla famiglia — 19 campi
  per adulto (tipo e **numero del documento**, `documento_path`) e 17 per minore (**codice fiscale**,
  data di nascita, residenza, **allergie**, **note mediche**). Il cast `as string | null` impediva a
  TypeScript di accorgersene. Misurato prima della correzione: 5 voci, 8486 byte, CF del minore in
  5 casi su 5, dato sanitario in 1 su 5 — **a ogni caricamento**. Ora la query chiede
  `id, created_at` e la variabile si chiama `invio`, così `data` torna a significare «la data».
- **Le password dei genitori erano archiviate in chiaro**, e rilette a ogni apertura di pagina.
  L'import di una domanda crea l'account del referente e ne mostra le credenziali all'operatore:
  quello è il flusso previsto. Il difetto era che le stesse credenziali finivano anche in
  `enrollment_submissions.credentials` (JSONB) e tornavano da `GET /api/admin/iscrizioni`, che
  faceva `select('*')`, a **chiunque abbia un ruolo di staff nella sede** — senza scadenza. In
  produzione due righe valorizzate, entrambe di famiglie reali. Ora la password torna **solo** nella
  risposta della PATCH che la genera; per riaverla c'è `admin/regenerate-credentials`, che la
  rigenera lasciando traccia. Le due righe esistenti **non sono state toccate**: la bonifica è
  scritta e commentata in `scripts/bonifica-credenziali-iscrizioni.sql` e la decide il titolare.
- **Le liste d'anagrafica consegnavano il fascicolo.** `GET /api/admin/students` restituiva 43
  colonne per alunno (`note_mediche`, `allergies`, `is_bes_dsa` — art. 9 —, `documento_path`,
  `importo_retta_mensile`, `genitori_separati`, residenza) più l'embed `student_parents ( … parents (*) ),
  delegates (*)`: con `limit=1000`, il valore che usano tutte le pagine, **una sola chiamata
  consegnava il fascicolo dell'intera scuola**. `GET /api/admin/parents` faceva `select('*')`. Le
  proiezioni sono ridotte a ciò che i componenti leggono davvero — verificato leggendo i componenti,
  non a intuito — e il dettaglio resta il posto dove il fascicolo si apre.
- **La nota medica esce come segnale, non come testo**: la lista accende un indicatore «Allergie», e
  la route restituisce il solo booleano `ha_note_mediche`. La card mobile era già così; la riga di
  tabella scriveva la nota grezza in un attributo `title` del DOM.

**Metodo, e perché conta.** `finto-supabase` non emula la proiezione di `select()` — le righe tornano
intere — e su un difetto di privacy la limitazione è dirimente: un test sul corpo sarebbe verde con
e senza la correzione. È stato aggiunto `__tests__/fixtures/proiezione.ts`, che proietta come
PostgREST, così «il codice fiscale del minore non esce» è una proprietà verificata sulla RISPOSTA.

### L'oblio usciva dalla sua sede, e da due giorni non riusciva più a nascere

Due difetti opposti sullo stesso diritto, entrambi nati il 2026-07-29 con la terza sede. Uno faceva
**troppo**: `POST /api/admin/gdpr/richieste` verificava la sede *della richiesta* — correttamente —
e poi raccoglieva i figli del genitore da `student_parents` **senza alcun filtro di sede**. Bastava
un genitore con figli in due plessi perché la Direzione di uno rendesse **irreversibilmente anonimo**
il bambino dell'altro, e ne cancellasse il documento d'identità dallo storage, senza che la
Direzione competente lo vedesse mai — mentre la route gemella `admin/gdpr/erase` fa
`assertAlunnoInScope` proprio perché *«è l'operazione più grave dell'applicazione e non esiste un
annulla»*. Ora i figli si filtrano su `scuoleDiUtente` — le sedi **accessibili**, non quelle
spuntate nel SedeSelector: una preferenza di vista non può decidere quale minore riceve l'oblio che
suo padre ha chiesto. Un figlio con `scuola_id` nullo è fuori scope (fail-closed), e il residuo non
si tace: compare nella risposta, nell'`esito` salvato, in un log persistito e nel riquadro di
conferma che la Direzione legge prima di digitare `ANONIMIZZA`.

L'altro non faceva **niente**: i due canali di richiesta scrivevano `scuola_id` come
`X ?? await scuolaUnicaReale(admin)`, funzione deprecata che con tre sedi risponde **sempre `null`**.
Una riga con sede nulla è invisibile al `GET` della Direzione (`.in('scuola_id', …)` scarta i NULL),
negata per sempre dalla POST di evasione e irripresentabile per via dell'indice unico parziale su
`stato='pending'`: il genitore avrebbe letto «richiesta in corso» all'infinito. Non è scattato solo
perché tutti i 57 utenti hanno una `scuola_id`. Oggi la sede si ricava dai **figli**
(`src/lib/gdpr/sede-richiesta.ts`), e se resta indeterminabile la richiesta si **rifiuta con un 422
leggibile** invece di nascere in un limbo. Sotto, due vincoli `NOT NULL` (richieste di cancellazione
e domande d'iscrizione) come rete: se un domani un terzo canale tornasse a scrivere NULL fallirebbe
subito e a voce alta. E `consensi_accettazioni` conservava `ip` e `user_agent` **senza scadenza e
fuori dall'oblio** — la tabella nasce senza FK su `parent_id` per sopravvivere all'anonimizzazione,
scelta giusta per il valore probatorio che però la lasciava fuori dalla cancellazione: ora l'oblio
li azzera e il job pg_cron **`consensi-retention`** li azzera comunque dopo 12 mesi. La prova resta:
tipo, versione e data non si toccano — sono loro a valere per l'art. 7 §1 GDPR e l'art. 1341 c.c.,
non l'indirizzo di rete di una famiglia.

### Osservabilità: i log non arrivavano in tabella, e quelli che arrivavano mentivano

- **Una riga che attribuiva l'accaduto alla causa sbagliata.** I 18 log aggiunti dall'audit passano
  `tipo:` (`classe-fuori-sede`, `sedi-attive-non-accessibili`…) ma non `esito:`, e `testoEvento()`
  non guardava `tipo`: in `app_log.messaggio` finiva il nome **nudo** dell'evento — **diciassette
  righe `messaggio = "auth"`** che raccontavano cinque fatti diversi. Il danno vero è a valle:
  `messaggio` entra nell'**impronta**, il `contesto` no, quindi due segnali diversi sulla stessa
  route+utente+giorno cadevano nella stessa chiave e l'`ON CONFLICT` li **sommava in una riga sola**.
  Su `/api/diary/students` un `sedi-attive-non-accessibili` è stato assorbito in una riga
  `classe-fuori-sede`. Corretto in un punto solo — `tipo` entra in `testoEvento`, **dopo**
  `operazione` — e cambiando il messaggio cambia l'impronta, quindi le righe si separano
  **retroattivamente**. Non si è toccata `impronta()`: metterci il contesto avrebbe fatto entrare i
  contatori che cambiano a ogni richiesta e ucciso la deduplica.
- **Il `sede_id` della pubblicazione non arrivava mai**: quegli eventi sono `info` e
  `galleria`/`modulistica`/`multi_sede` non erano in `EVENTI_PERSISTITI` — in 30 giorni **non una
  riga**. Aggiunti dopo aver **misurato** il volume (0 media, 4 compilazioni, 10 avvisi, contro le
  23,7 righe/giorno che `app_log` già assorbe). **`auth` non è stato aggiunto**, ed è la scelta che
  conta: i suoi `info` non sono segnali di dominio ma i rifiuti dei gate, cioè le righe che il design
  esclude per non fare di `app_log` una tabella di rumore.
- **Tre sinonimi spezzavano le query in silenzio** (`galleria`/`gallery`, `modulistica`/`forms`,
  `pagamento`/`pagamenti`) — e `EVENTI_PERSISTITI` conteneva `pagamento` al **singolare**, quindi un
  `logEvento('pagamenti', 'info', …)` di successo non sarebbe stato persistito affatto. Nomi
  unificati e vocabolario **chiuso** (`EVENTI_NOTI`) col lock `eventi-log`.
- **Il log di produzione raccontava un incidente inventato**: otto righe `error`,
  `ambiente=production`, «variabile d'ambiente critica mancante: `LOG_HASH_SALT`». A smascherarle è
  `app_versione = null` — nessuno sha di commit, cioè **nessun deploy**. Erano i `npm run build`
  fatti in locale: `next build` imposta `NODE_ENV='production'` su qualunque macchina, e la regola
  era `VERCEL_ENV ?? NODE_ENV`. Il portatile di uno sviluppatore scriveva incidenti di produzione
  nel log di produzione, al livello su cui si filtra per primo. Ora l'ambiente lo dichiara **solo
  Vercel**; le otto righe scadono da sole con la retention a 30 giorni.
- **Il rumore, misurato: il 79% del canale client.** `GET /api/notifiche — Failed to fetch` con
  `stato_http = 0`: 372 occorrenze su 37 righe in 30 giorni, a livello **`error`** (in tutto, `stato 0`
  faceva 763 occorrenze su 964). Su una WebView è ciò che il motore dice quando la richiesta viene
  troncata da un cambio pagina o dal telefono che si addormenta. E sotto ci stava un guasto vero:
  **41 occorrenze in un giorno** di `POST /api/iscrizione/upload → 413`, genitori che non riuscivano
  ad allegare i documenti. Le fetch mai partite sono ora `warn`; quelle annullate da noi
  (`AbortError`) non si spediscono affatto.
- **Il 413 non era nostro, e il client non sapeva leggerlo.** Verificato dal vivo su produzione con
  un multipart senza file: 4.000.000 byte → 400 della route; 5.000.000 → `HTTP/2 413`,
  `x-vercel-error: FUNCTION_PAYLOAD_TOO_LARGE`, `content-type: text/plain`. Il limite è della
  **piattaforma** (~4,5 MB): il «max 8MB» dichiarato dalle route era una promessa che il loro codice
  non poteva mantenere, perché sopra soglia non viene eseguito affatto. E il client faceva
  `await res.json()` **prima** di `res.ok`, quindi il parse lanciava `SyntaxError` e al genitore
  usciva «Caricamento non riuscito. Riprova.» — l'invito a rifare l'unica cosa che non poteva
  funzionare. Ora `src/lib/upload/limite-piattaforma.ts` (tetto 4 MB), controllo **prima di spedire**,
  lettura dell'errore che guarda `res.ok` e il `content-type`, e 413 **con corpo JSON**.
- **La data di nascita di un minore usciva in chiaro, per 30 giorni.** Nelle righe `iscrizione warn`
  nome, cognome e CF escono hashati, ma `data_nascita` e `birth_date` passavano intatti: le date
  erano in lista bianca **per tipo**, non per chiave. Accanto alla provincia di residenza e
  all'orario dell'invio, quella data identifica una persona — e la persona è un bambino, in un
  repository pubblico. `redact.ts` ora decide sulla **chiave** (radici `nascita`/`birth`): le
  stringhe conservano la lunghezza (serve a diagnosticare il `22001` della provincia), `null` resta
  `null`, e le date legittime continuano a passare.
- **Un servizio terzo riceve i dati di un minore, e il suo errore veniva buttato.**
  `fiscalCodeApi.ts` chiama `api.codicefiscale.it` dal browser mandandogli nome, cognome, sesso,
  data e comune di nascita; sul ramo `!res.ok` non leggeva **né status né corpo**. Ora si loggano
  entrambi, con la stretta che tiene insieme la regola 3 e la regola 8: i sei valori che abbiamo
  appena spedito noi vengono **tolti dal corpo** prima di scriverlo. ⚠️ **La chiamata è rimasta**:
  che i dati anagrafici di un minore vadano a un servizio terzo — senza consenso a monte e senza
  comparire in nessuna informativa — è una decisione di titolarità, non di codice. Il fallback
  locale calcola lo stesso codice senza far uscire niente dal dispositivo.
- **Le notifiche alle famiglie uscivano mute.** I due imbuti da cui passa ogni notifica alle
  famiglie — `notificaEvento` ed `enqueueNotifiche` — uscivano con un `return` nudo sulla lista
  vuota, e il codice lo ammetteva in due commenti senza rimediarci. La condizione è viva: 2 alunni
  su 25 a Giugliano non hanno alcuna riga in `student_parents`, quindi un avviso di classe raggiunge
  meno famiglie di quante ce ne siano — con 201 al chiamante e nessuna traccia. Ora entrambi
  emettono `warn` con `tipo` e `sede_id`, e `POST /api/avvisi` — che non scriveva **nulla**, né esito
  né sede — e `POST /api/gallery` portano `n_destinatari` nella riga di successo: `n_destinatari: 0`
  accanto a `nTag: 2` è il dato che rende leggibile «due bambini nella foto, zero famiglie avvisate».
- **`POST /api/avvisi` poteva sfilare `scuola_id` dalla riga, in silenzio.** Su `PGRST204`/`42703`
  l'insert ritentava fino a 4 volte **cancellando dal record la colonna nominata dall'errore**:
  bastava che PostgREST nominasse `scuola_id` perché l'avviso nascesse **senza chiave di tenancy** —
  invisibile nel cockpit di ogni plesso e nel feed di ogni famiglia. Ora ogni colonna sfilata lascia
  un `warn` col proprio nome, e su `scuola_id` si passa da `degradoSedeLecito` (si prosegue senza
  isolamento solo se non c'è niente da isolare): in produzione, con tre sedi, **500** invece di un
  avviso orfano.
- **Il push web (VAPID) era l'ultimo provider fuori da `externalFetch`.** `webpush.sendNotification()`
  rifiuta con una `WebPushError` che porta `statusCode`, `headers` **e `body`** — il testo che dice
  *perché* — e il `catch` teneva il solo `err.message`. **È la forma identica al guasto storico delle
  email di credenziali**, sopravvissuta sull'unico canale non riscritto. Ora la richiesta passa da
  `externalFetch`, il corpo del provider finisce in `app_log.messaggio`, il **successo** si logga,
  410/404 restano `info` e l'assenza delle chiavi VAPID emette `config`/`error` coi nomi delle
  variabili. A valle, `POST /api/push/dispatch` guardava solo `ok`/`gone`: qualunque altro rifiuto
  non incrementava nulla e la notifica veniva marcata inviata comunque, mentre il battito diceva
  `esito:'ok'`. Aggiunto il contatore `fallite` e una riga `warn` `invii-rifiutati`.

### Il cockpit ingoiava i rifiuti del server, e la rete giù sembrava «non ci sono alunni»

Difetti di **interfaccia** con la stessa radice: l'esito di una chiamata non arrivava mai a chi
stava usando l'app. Non producevano nessun test rosso — non c'era niente da rendere rosso.

`/admin/students/sezioni/[id]` aveva tre scritture e nessuna guardava com'era andata: cambiando il
grado il menu lampeggiava e tornava indietro, la `PATCH` era partita e il server aveva risposto
**400 «Specificare la sede»**, gli elementi `[role="alert"]` sulla pagina erano **zero**, la console
muta. Dall'esterno è indistinguibile da un click non registrato, e `addTeacher` azzerava il modulo
**prima** di sapere l'esito. In `/admin/students` le tre fetch degli elenchi erano `try { … } finally`
**senza `catch`**: un `TypeError: Failed to fetch` usciva dall'effetto, nessuno stato d'errore,
nessun log, e la pagina mostrava contatori a zero e «Nessun alunno trovato» — cioè un operatore
deduce che l'archivio è vuoto, la conclusione peggiore che si possa indurre su un archivio che
contiene le famiglie reali. **Il `try/finally` senza `catch` non era una svista**:
`react-hooks/set-state-in-effect` (nel gate è un **errore**) fa fallire eslint se una funzione
chiamata da un `useEffect` contiene un `setState` dentro un `catch` — verificato aggiungendone uno.
La via d'uscita non era rinunciare al ramo d'errore ma spostarlo su **`.catch()` della promise**,
tenendo il `finally`; entrambi i vincoli sono scritti accanto al codice, con la misura.

Sulla stessa pagina, **«← Tutte le sezioni» lasciava lo spinner per sempre**: il ramo `sections`
montava con `isLoading = true` e nessuno lo spegneva, perché `setIsLoading(false)` vive solo dentro
i tre fetch che quel ramo non lancia — e riaprire dal menu non riparava (stessa rotta, il componente
non si rimonta): bisognava uscire dall'area. Difetto **preesistente**, su un percorso quotidiano
della segreteria, trovato dal collaudo iOS. La causa vera erano tre decisioni separate che leggevano
lo stesso fatto in tre modi; ora leggono un unico predicato dichiarato una volta, `attendeElenco(v)`.

`/admin/avvisi` stampava `target_classes.join(', ')` su un campo **eterogeneo** (il form ci scrive i
nomi, due avvisi in produzione ci hanno l'**id**): un uuid dove ci si aspetta una classe. Ora ogni
voce si risolve contro le classi dei plessi consentiti e l'etichetta porta la sede — ma **solo se
deducibile**: un nome omonimo in due plessi resta il nome nudo, perché attribuirlo a uno dei due
sarebbe indovinare, l'errore che tutto questo audit sta chiudendo. E il selettore di sede desktop,
con una sede sola, diceva «TUTTE LE SEDI · 1 struttura» aprendo un menu con due voci equivalenti: la
guardia esisteva ma valeva solo sul ramo mobile — ora vale su entrambi, e cade anche la chiamata a
`/api/admin/dashboard` che quel ramo faceva su **ogni** pagina del cockpit.

**La bottom-nav docente serviva `href="/teacher?userId=null"` a ogni caricamento.**
`getCurrentTeacherId()` legge `window.localStorage` **dentro il corpo del componente**: sul server
ritorna `null`, nel browser l'uuid vero. React segnalava il mismatch a livello **ERROR** su ogni
caricamento di `/teacher`, `/teacher/diary`, `/teacher/chat`, `/teacher/gallery` — e gli attributi
**non li ripara** («This won't be patched up»): alla docente restava sotto il dito un link con la
stringa «null» al posto della sua identità, che viaggiava poi come `?userId=` dentro le route
`/api/*` e diventava un 401 senza spiegazione. Lo stesso schema stava in `ClasseShell` e in
`/teacher/primaria`. Nuovo `src/lib/auth/use-teacher-identity.ts`, gemello di `useAdminIdentity`:
`useSyncExternalStore` con `getServerSnapshot` = il `?userId=` della URL e `getSnapshot` = l'identità
reale; il suo `withUser()` **omette** il parametro finché l'uuid non è risolto, così `userId=null`
diventa impossibile per costruzione e non per disciplina di chi scriverà il prossimo href. Il doppio
passaggio raddoppiava la rete (`/api/primaria/me` due volte per pagina): chiuso con un flag `pronta`
e con le `fetch` che partono una sola volta.

**Sull'app nativa, tre difetti con la stessa radice: funzionava per chi guarda lo schermo, non per
il sistema operativo.** La modale «Nuovo avviso» **non esisteva** per lo screen reader — nessun
`role="dialog"`, nessun `aria-modal`, nessun focus-trap, contenuto retrostante raggiungibile: su
Android l'albero di accessibilità continuava a esporre solo la pagina sotto, e il bottone di
chiusura era 32×32 px e muto. Rifatta sul modello di `AdminMenuSheet`, che era già esposto
correttamente: in questo repo esisteva già un modo giusto di fare una modale, ora ce n'è **uno solo**
(sistemato anche lo z-index: la bottom-nav copriva «Pubblica avviso»). Il **tasto Indietro** di
Android navigava nella cronologia anche con un overlay aperto — se stavi scrivendo un avviso, lo
perdevi: ora un registro degli overlay chiude prima quello in cima. E **il flow Maestro committato
era rotto, e accusava l'app di un difetto che non aveva**: `tapOn: "Mensa"` prendeva la scorciatoia
della dashboard (fuori viewport, altezza 0) invece del tab della bottom-nav. L'app era ed è sana; la
trappola dei nodi duplicati è ora scritta nel README dei flow.

### Le diciannove migrazioni (applicate in produzione via MCP, `get_advisors` 0 ERROR)

| Migrazione | Cosa fa |
|---|---|
| `20260731094558_chiudi_policy_scaffolding_rls_aperte` | Via 6 policy `auth.role()='authenticated'` lasciate da Studio: davvero **chiunque** poteva scrivere il registro di qualsiasi sede, annotare note disciplinari su qualsiasi minore e **inserire firme docenti a nome altrui** (valore probatorio) |
| `20260731101818_fn_form_submission_etl_sede` | Il trigger ETL dell'iscrizione prende la sede da `NEW.scuola_id`; se manca **non crea nulla** e lo scrive in `app_log` |
| `20260731102245_rls_multisede_pulizia` | 42 policy riviste: 37 droppate, 5 riscritte col vincolo di plesso, 1 `REVOKE`. Verificato file per file che **nessun** percorso client-side dipendesse da quelle policy |
| `20260731112535_mensa_unique_per_sede` | Unicità della configurazione mensa per sede: due menu attivi dalla stessa data rendevano nondeterministici **gli allergeni del giorno** |
| `20260731113406_sections_nome_per_sede` | UNIQUE `(scuola_id, name)`: l'invariante viveva solo in tre docstring, e un invariante che vive nei commenti è una speranza |
| `20260731114449_presenze_armadietto_scuola_id` (+ `…114828_…_revoke`) | Trigger dall'alunno + backfill (12 presenze, 4 armadietti) + `NOT NULL` |
| `20260731115341_genera_rette_per_sede` | `genera_rette_mensili/anno` con `p_scuola_id` **obbligatorio** (nessun default) + `schools.operativa`. Non è teoria: l'unica esecuzione registrata in produzione ha emesso 21 rette su Giugliano **e 4 sulla sede finta della CI** — un clic, due sedi |
| `20260731122800_fk_scuola_id` | FK `scuola_id → schools(id)` su 31 tabelle (da 34/65 a **65/65**) e disarmo della colonna morta `alunni.fiscal_code` |
| `20260731123052_provisiona_sede_v2` | Corredo minimo automatico per una sede nuova + **backfill idempotente** di Aversa e Cesa; ciò che resta umano esce come checklist |
| `20260731140243_note_firme_sola_lettura_per_authenticated` | La policy sopravvissuta alla pulizia del mattino: `WITH CHECK (maestra_id = auth.uid())` vincola l'**autore** a sé stesso e nient'altro — non il ruolo (ogni utente con sessione è `authenticated`, genitori compresi), non la sede, non che insegni in quella sezione. Dimostrato con INSERT reali in transazioni annullate: un **genitore** ha scritto una nota disciplinare su un minore non suo, la segreteria di **Aversa** sul fascicolo di un minore di **Giugliano** |
| `20260731142105_oblio_sede_obbligatoria_retention_consensi` | `richieste_cancellazione.scuola_id` e `enrollment_submissions.scuola_id` → **NOT NULL** (0 righe nulle su 227 domande) + retention 12 mesi su `ip`/`user_agent` dei consensi |
| `20260731170007_galleria_lettura_genitore_con_sede` | La policy di lettura della galleria non nominava la sede: una foto di gruppo di Cesa era leggibile dal genitore di Giugliano. Si **aggiunge** una condizione, non se ne toglie — sbagliare deve significare «non vedono», mai «vedono troppo» |
| `20260731191948_pagamenti_rls_senza_ricorsione` | `pagamenti` ⇄ `pagamenti_quote`: due policy che si leggevano a vicenda (**42P17**), difetto **preesistente**. La cura non è stata riscriverle ma togliere la metà del cerchio **già morta** — si appoggiava a `legame_genitori_alunni`, che ha la RLS accesa e **zero policy**. Prova rosso→verde sui dati veri: prima `42P17`, dopo il genitore legge **1** pagamento su 98. Né 0 (negava tutto) né 98 (fuga) |
| `20260731192005_bucket_gallery_limite_200mb` | Il bucket accettava 50 MB mentre il codice ne dichiarava 200: il video di una recita superava ogni controllo dell'app e veniva respinto dallo Storage |
| `20260731192029_drop_test_table` | Via `public.test_table`, residuo del baseline: in un database che contiene i codici fiscali di **152 minori**, una tabella che nessuno rivendica è un rischio anche da vuota |
| `20260731192048_bucket_news` | Il bucket `news` esiste in migrazione invece di nascere **pubblico dentro un `try`** al primo caricamento: pubblico per scelta scritta del titolare, con limiti e tipi dichiarati |
| `20260731192108_allegati_avvisi_task_bucket_privati` | `avvisi_allegati` e `task_allegati` → `public = false`. L'indirizzo pubblico era quello che l'app mandava al browser di ogni famiglia: bastava copiarlo da un avviso e girarlo a chiunque |
| `20260731192131_task_interni_scuola_obbligatoria` | `task_interni.scuola_id` **NOT NULL** + FK: un promemoria senza plesso non compare nella bacheca di **nessuna** sede — non una fuga, una sparizione. Fatto adesso perché la tabella è vuota: fra un mese sarebbe costato una riconciliazione riga per riga |

### La decisione sulla semantica di `scuola_id NULL`

Era la cosa più pericolosa dell'elenco, perché non era un bug: erano **due convenzioni opposte
convissute nello stesso schema**. In scrittura `NULL` voleva dire «tutte le sedi»; in lettura le
query filtrano `.in('scuola_id', plessi)`, e in SQL `NULL IN (…)` non è vero — quindi la stessa
riga significava «di tutti» a chi la scriveva e «di nessuno» a chi la leggeva. Dal 2026-07-31 vale
una regola sola, scritta qui perché la prossima persona non debba dedurla:

1. **Dato di una famiglia ⇒ `scuola_id` mai NULL.** `form_submissions` compresa: se al momento
   dell'invio la sede non è risolvibile, la risposta è **400** e non si scrive niente. Una
   compilazione senza sede non la vedrebbe nessuno — e sarebbe un modulo d'iscrizione perso in
   silenzio, non un dato «globale».
2. **Dato di configurazione ⇒ `NULL` significa «globale».** Vale per `form_models` e
   `payment_categories`: si **legge** da tutte le sedi, si **modifica** solo da chi ha in scope
   **tutte** le sedi reali. Un admin di un plesso solo non può cambiare sotto i piedi degli altri
   una riga che vale per tutti.
3. **Chi risolve una configurazione preferisce la sede al globale**: `ORDER BY scuola_id NULLS
   LAST` — la riga di sede vince, quella globale è il ripiego.
4. **Chi espande un «per tutti» lo fa esplicitamente**, sede per sede su `sediReali` (la finta di
   collaudo esclusa): una news globale notificava **zero** genitori e restava marcata inviata per
   sempre.

### Il repo aveva smesso di ricostruire il database

`supabase/migrations/` non ricostruiva più il database, e lo si è scoperto misurando il registro
reale (`supabase_migrations.schema_migrations`) invece di fidarsi dei nomi dei file. **Sei
migrazioni vivevano solo in produzione**: applicate, mai scritte nel repo — recuperate dal registro
e riportate integrali col timestamp vero. E **quindici file già presenti portavano un timestamp
inventato a mano**, diverso dalla `version` con cui erano stati applicati: `supabase db push` non li
avrebbe riconosciuti come già applicati e li avrebbe **riapplicati tutti e quindici**, e **tre
coppie erano in ordine invertito** rispetto all'applicazione reale (`fk_scuola_id` prima di
`provisiona_sede_v2`, `presenze_armadietto` prima di `genera_rette`, `mensa_unique` prima di
`sections_nome`) — ricostruendo il DB dai file si sarebbe rotto sulle dipendenze. Rinominati con
`git mv` e riallineati tutti i riferimenti in PRD, audit, lock, `src/` e `scripts/`. Oggi repo e
database coincidono: **94 migrazioni**, stessi nomi, stesso ordine.

Il presidio che lo tiene: il lock `migrazioni-complete` gira **offline** (in CI le credenziali di
produzione non ci sono e non devono esserci) e confronta la cartella con una **fotografia versionata**
del registro. Tre accorgimenti perché non sia teatro: la fotografia porta un `sha256` del contenuto
normalizzato, così chi la ritocca a mano per far tacere il lock fa fallire un test dedicato; il
generatore **non legge** la cartella delle migrazioni — se la leggesse, il lock confronterebbe quella
cartella con sé stessa, verde per costruzione, e c'è un test che lo verifica leggendo il sorgente del
generatore; un file nuovo **in coda** è lecito, uno che si **intercala** nella storia già applicata
no. Prova di validità in due modi: tolto un file → rosso, e dice *quale* manca; rinominato un file
con un timestamp che ne inverte l'ordine → 3 test rossi.

### I lock — quelli che avrebbero trovato tutto questo

Un difetto corretto senza un lock è un difetto in attesa di tornare.

- **`isolamento-sede-coverage` riscritto** — la prima versione (2026-07-30) era **verde su tutti i
  140 rilievi**, per quattro difetti d'impianto che vale la pena ricordare: (1) **guardava il file,
  non l'handler** — `admin/students` importava lo scope per il suo GET, PATCH e DELETE nello stesso
  file non lo usavano affatto, e il lock vedeva un file «coperto»; (2) l'elenco delle tabelle era
  **scritto a memoria**, sette nomi su 65 con `scuola_id`; (3) era **cieco alle scritture**; (4)
  l'allowlist era **per prefisso**, quindi esentava anche le route non ancora nate. Ora la
  granularità è l'**export**, come in `logging-coverage`, le tabelle le dice il database
  (`__tests__/fixtures/tabelle-scuola-id.json`), le scritture hanno regole proprie (la clausola di
  sede sta **nell'istruzione che scrive**, non «da qualche parte nell'handler») e ogni voce di
  allowlist è un `route:METODO` a match esatto.
- **`rls-per-sede`** — fotografia versionata di `pg_policies`: fallisce se una `USING (true)`
  ricompare su una tabella sensibile, se una policy di scrittura su tabella con `scuola_id` non
  nomina né sede né identità, o se la fotografia non corrisponde più al database. **Prima di oggi
  nessun test guardava la RLS.**
- **`rls-senza-ricorsione`** — nessuna policy può leggere una tabella la cui policy rilegge la prima.
- **`fk-scuola-id`** — una colonna `scuola_id` nuova senza chiave esterna fa rosso il gate.
- **`etl-form-submission-sede`** — il trigger dell'iscrizione non può tornare a dedurre la sede.
- **`scope-vuoto-nega`** — vieta la **forma** del fail-open: una guardia `X.length > 0` senza ramo
  `else` che governa un filtro su `scuola_id` costruito con la stessa lista. Allowlist inesistente,
  per scelta.
- **`nome-classe-con-sede`** — ogni filtro su `classe_sezione`, e ogni filtro su `name` dentro una
  query su `sections`, deve avere `scuola_id` nella **stessa** query.
- **`destinatari-con-ponte`** — vieta `from('utenti')` + `.eq('scuola_id', …)`, la forma che ha reso
  muti quattro canali di notifica. L'esenzione è per **funzione**, non per file. Il lock ha subito
  trovato una **quinta** occorrenza viva, che l'ondata precedente non aveva visto.
- **`identita-client-negli-attributi`** — vieta che un valore letto da `localStorage` nel render —
  anche passando per una variabile intermedia — finisca dentro un `href`/`src`.
- **`eventi-log`** — vocabolario chiuso degli eventi: nessun `logEvento` può usare un nome non
  dichiarato, `EVENTI_PERSISTITI` dev'esserne un sottoinsieme, e i tre sinonimi non possono
  rientrare nemmeno aggiungendoli all'elenco.
- **`bucket-storage-dichiarati`** — un bucket non nasce più dentro un `try` di una route.
- **`inventario-audit-verita`** — estrae dal markdown dell'audit le route marcate CHIUSA e pretende
  che superino il criterio del lock di copertura. Da oggi il documento non può divergere dal codice
  in silenzio: è un file di prosa che il gate legge.
- **`migrazioni-complete`** e **`residui-di-collaudo`** — il repo ricostruisce il database; gli
  oggetti di prova non restano in produzione.
- **`niente-password-nel-repo`** — allowlist **svuotata**: è caduta l'ultima eccezione, quella del
  seed E2E. La lezione non era «serviva un'eccezione più stretta» ma «una password committata non
  resta dove l'hai messa» — e il lock l'ha subito dimostrato, trovando la password degli account TEST
  finita in chiaro dentro un prompt committato il giorno prima. ⚠️ Tolta, ma **il repository è
  pubblico e resta nella storia git: va ruotata, toglierla non basta.**
- **`migrazioni-senza-sede-cablata`** esteso da `supabase/migrations/` a `src/`, `scripts/`,
  `__tests__/` ed `e2e/`: gli uuid reali dei tre plessi sono usciti da 30 file, sostituiti dalle
  fixture finte di `__tests__/fixtures/sedi.ts`.
- **Il finto Supabase ora filtra e scrive davvero** (89 → 736 righe) e **lancia** su ciò che non sa
  emulare. Ha smascherato subito **quattro test falsi verdi**: due passavano su un 500, due non
  asserivano nulla.
- **Il seed E2E semina due sedi** con una sezione omonima, e `e2e/isolamento-sedi.spec.ts` fa quattro
  percorsi reali attraverso il confine. Finora la suite era verde perché **non c'era un confine da
  attraversare**.

### L'inventario che dichiarava chiuso ciò che non lo era

Dodici voci dell'audit del 30/07 erano marcate CHIUSA mentre `git log` diceva che quei file non
erano mai stati toccati. Ognuna è stata riverificata — storia del file più lettura del codice
attuale — e riallineata: chi era chiusa davvero cita adesso il commit vero, chi non lo era è tornata
**APERTA**. Nessuna è stata giustificata «per intenzione»: o c'è il codice, o è aperta. Aggiunte
anche le **verifiche negative** del 31/07 — le cose che sembravano rotte e non lo erano: un
inventario che elenca solo i difetti costringe il prossimo audit a riscoprire ogni volta i
non-difetti.

### Collaudabilità: gli account TEST sulle altre sedi

Con tre plessi l'isolamento non era **collaudabile**: non esisteva un «utente di Aversa» a cui
chiedere se vede Cesa. Ora ci sono sei account (`test.aversa.*` e `test.cesa.*`: segreteria, docente,
genitore per sede) creati da `scripts/seed-test-sedi.mjs` in modo idempotente, con le sedi risolte
**per nome** e mai per uuid — elenco completo, vincoli e procedura di rimozione nella sezione
«Account TEST sulle altre sedi» più avanti in questo documento. In ogni sede nasce con loro una
sezione **omonima** «TEST Infanzia», deliberatamente: senza tre classi con lo stesso nome in tre
plessi, la famiglia F3 non si può né dimostrare chiusa né vedere riaprire.

Restava un ramo non provabile: il **selettore di sede**. Dei 57 utenti di produzione ne aveva più
d'una **soltanto l'admin del titolare**, quindi l'unico modo di esercitarlo era usare le credenziali
di una persona vera. `--multisede` crea `test.multisede.admin@kidville.test` col ponte
`utenti_scuole` verso le tre sedi reali: deroga esplicita alla regola scritta in cima allo script —
«un account di collaudo sta nella SUA sede» — autorizzata dal titolare e tenuta stretta. Un account
solo, nessun bambino, nessun genitore, nessun legame: solo accesso; la sede finta della CI resta
fuori **per costruzione** (`isSedeE2E`, lo stesso filtro che già protegge `risolviSedi`); e il ruolo
`admin` non è comodità — `scuoleDiUtente` concede il ponte multi-plesso ai soli admin per decisione
di prodotto del 30/07, quindi un `segreteria` multi-sede avrebbe le righe in `utenti_scuole` e
continuerebbe a vedere una sede sola: un oggetto inerte che sembra funzionare. I test lo inchiodano,
così chi domani allargasse il ponte se ne accorge. Le credenziali stanno nel gestore del titolare e
si leggono da `KV_TEST_PASSWORD`: **nessun valore in nessun file**.

### Il gate che verificava un ruolo solo: venti route di dati di minori, cinque in scrittura

`requireParentOfStudent` è il presidio di venti endpoint che leggono o scrivono i dati di **un
bambino indicato dal client**: diario, assenze con la giustificazione, note, pagella, armadietto,
galleria. Verificava il legame **solo a chi era `genitore`**; ogni altro ruolo passava. E non per
distrazione: la testata del file lo dichiarava — *«staff/educator passano: il loro scope è applicato
altrove nelle rispettive query»*. Contati uno per uno: **diciotto call site su venti non avevano
nulla**; `gallery:GET` aveva il solo controllo di plesso (non di sezione), aggiunto il giorno prima
come tampone locale; `diary/students:GET` era l'unico col gate completo, scritto a mano. Il client è
`createAdminClient()` (service-role), che scavalca la RLS: dove l'altrove non c'era, non c'era
nessuna difesa.

Misurato in produzione, non dedotto. `GET /api/diary/entries?alunno_id=<minore di Giugliano>` con la
sessione di un educator di **Aversa** rispondeva **200** con quindici voci di diario; `GET
/api/parent/primaria/assenze` restituiva le assenze col `giustificazione_testo`, che è testo libero
di natura sanitaria. Ripetuto su cinque minori e **sette attori** — docenti e segreterie delle altre
sedi, e perfino la **cuoca**: 200 per tutti. L'unico 403 arrivava all'altro genitore. In `app_log`
nemmeno un warn: senza gate non esiste neppure il segnale che qualcuno ci abbia provato.

Fra i venti call site ce n'erano **cinque in scrittura**, e il primo ha valore legale: la
**giustifica con firma FES** (`giustificazione_firma`, `giustificata_da`), la presa visione della
pagella, la comunicazione d'assenza, la giustifica didattica e il carico dell'armadietto. Un
operatore di un'altra sede poteva firmare al posto della famiglia.

La correzione sta **in un punto solo**: `genitore` → `genitoreHasFiglio` (invariato: al legame di
famiglia la sede non si applica, due fratelli possono stare in due plessi); **chiunque altro** →
`assertAlunnoInScope`, cioè plesso e — per l'`educator` — sezione assegnata, con **403** e un
`warn` persistito `alunno-fuori-sede`. I percorsi legittimi non si stringono: l'educator vede i
bambini delle proprie sezioni, la segreteria tutte le classi del proprio plesso, la Direzione tutti
i plessi che ha in `utenti_scuole`. Riprovata la stessa misura sul dev server con i sette attori:
**403 su tutte e sei le rotte per i quattro fuori scope, 200 per i tre legittimi**, e 24 righe
`alunno-fuori-sede` in `app_log`, correlabili per ruolo e rotta.

**E il lock ratificava la falla.** `isolamento-sede-coverage` esentava tredici handler «per scope
famiglia»; undici di quelle voci descrivevano uno scope che per i ruoli diversi da genitore **non
esisteva**, e tre dicevano testualmente «di UN alunno, verificato prima». Non sono state riscritte
meglio: sono state **tolte**, perché il debito è stato pagato e il lock riconosce da solo il gate dal
suo corpo. `handlerEsentati` scende da 109 a **96** — il calo più grosso mai registrato su quel
numero. Resta una sola voce, riscritta per dire il vero: `parent/presenze/comunica-assenza:POST` fa
un `upsert` su `presenze` **senza `scuola_id`** — l'attore è verificato, la riga nasce senza plesso.
Debito aperto e dichiarato, non una giustificazione.

### Le lezioni

- **Una voce di allowlist che afferma il falso è peggio di una route non coperta**, perché spegne il
  sospetto: la route scoperta prima o poi si trova, quella coperta a torto no. Undici righe dicevano
  «scope famiglia» su venti endpoint dove il legame di famiglia era verificato a un ruolo su sei.
- **Un commento che descrive una difesa non è una difesa.** *«Lo scope è applicato altrove nelle
  rispettive query»* è stato vero, forse, per una route su venti; scritto in cima al gate condiviso è
  diventato il permesso di non applicarlo in nessuna.
- **Il gate verde non misura l'isolamento.** 3540 test verdi mentre 140 cose erano rotte, perché un
  filtro di sede mancante non produce un errore: produce righe in più. Finché la sede è una sola non
  esiste una differenza da osservare — la prima cosa che serviva era un secondo plesso su cui
  chiedere «e questo lo vedi?».
- **Un lock che guarda il file invece dell'handler non protegge niente**, e in più *rassicura*: un
  import in cima al file rendeva «coperti» un PATCH e un DELETE che non chiamavano nulla. Vale per
  ogni presidio: la granularità dev'essere quella dell'unità che può sbagliare.
- **«Pre-lancio» è una frase sul calendario, non una misurazione.** L'unica domanda è quante righe
  reali ci sono adesso.
- **Un mock che ignora ciò che non sa emulare rende verdi i test sbagliati.** Il finto Supabase
  accettava `.or()`/`.neq()` e li scartava: quattro test erano falsi verdi. Ora lancia.
- **Un inventario che nessun test legge diverge in silenzio** — dodici voci «chiuse» senza una riga
  di codice.
- **La prova di validità è la sola cosa che distingue un test da una decorazione**: ogni step di
  questo lavoro ha rimesso il difetto per vedere il test tornare rosso, e proprio così sono emersi
  quattro test che asserivano il comportamento sbagliato e uno che verificava un tampone al posto
  della regola.

### Cosa NON è stato toccato

I permessi decisi il 30/07 (segreteria = la sua sede; educator = le sue sezioni; cross-sede solo
admin): questi step li **applicano** dove mancavano, non li ridiscutono. Il modulo pubblico
`/iscrizione`, vivo e appena rifatto, resta com'è: le route di submit sono cambiate solo restando
compatibili col payload che il wizard già manda. Il vincolo UNIQUE globale sul codice fiscale
rimane: è voluto e presidiato. Le due righe con le credenziali in chiaro restano in tabella finché
il titolare non lancia la bonifica scritta. Restano **aperti e dichiarati**: la chiamata al servizio
terzo per il calcolo del codice fiscale (decisione di titolarità) e la rotazione della password TEST
pubblicata nella storia git.

**Gate:** eslint **0** · tsc **0** · vitest **4827 test / 555 file** (erano 3540 / 429) · build ok ·
`get_advisors` **0 ERROR** (riverificato a chiusura: restano solo INFO e WARN preesistenti). E2E
Playwright in CI. Prompt dell'esecutore della pipeline allineato: `.claude/agents/esecutore-opus.md`
non dichiara più «sede di produzione unica» con l'uuid pronto da incollare.

---

## 🗓️ Changelog — Informativa e consensi: i testi legali riscritti e il modulo pubblico che finalmente li mostra 2026-07-31 (branch `fix/testi-legali-revisione`)

Chiude l'ultimo punto rimasto del prompt sull'isolamento: il modulo pubblico d'iscrizione
raccoglieva **allergie, note mediche (BES, DSA, patologie) e il documento d'identità del minore**
senza mostrare alcuna informativa e senza registrare nulla. Non mancava un filtro: mancava il posto
dove scrivere la prova.

### La correzione controintuitiva: sui dati sanitari il consenso era la base SBAGLIATA

Sembra più garantista chiedere il consenso. Non lo è. Se un genitore non comunica l'allergia, la
Scuola non può preparare il pasto in sicurezza: quel «consenso» **non è rifiutabile**, e un consenso
non libero non vale nulla. Fondarci sopra il trattamento significa trattare **senza base giuridica**
dati sanitari di minori, credendo di averne una.

L'informativa ora fonda quei dati su **art. 9.2.g GDPR + art. 2-sexies, c. 2, lett. bb** del Codice
privacy (interesse pubblico rilevante nell'istruzione). Il consenso resta **solo su foto e video**,
dove rifiutare non costa nulla al bambino — ed è **granulare per canale** (galleria riservata, sito,
social: provv. Garante 725/2025).

### Cosa cambia nel modulo

Nuovo passo **Consensi** fra l'ultimo adulto e il riepilogo, con l'informativa al punto di raccolta
(art. 13) e **una sola spunta obbligatoria: la presa visione**. Nessuna casella sui dati sanitari.
La verifica è **server-side** (`consensiObbligatoriMancanti`), perché un invio fatto fuori dal
wizard non esegue il codice del wizard.

Migrazione `iscrizione_consents_log`: colonna `consents_log` su `enrollment_submissions`, stessa
forma già usata da `form_submissions` — si riusa il meccanismo invece di inventarne un secondo, così
esiste **un solo modo** di provare un consenso in questo sistema. Lo snapshot **congela il testo
mostrato** dentro la riga: la prova deve dire *cosa* è stato accettato, non solo *che* qualcosa è
stato accettato. `versione` dalla costante server-side, **mai dal client**.

### Informativa e Termini riscritti

**Informativa**: Apple/APNs nominata fra i destinatari (era taciuta pur essendo un destinatario
noto); trasferimenti dichiarati **per fornitore**; conservazione allineata agli obblighi archivistici
che valgono anche per le paritarie (fascicolo dell'alunno: **conservazione illimitata**); base
giuridica dei log dichiarata; sezione su responsabilità genitoriale e genitori separati; come si
revoca il consenso; cookie; riscontro «entro un mese»; indirizzo del Garante.

**Termini**: accettazione **espressa** (la formula «utilizzando il servizio dichiari di accettare»
non vincola nessuno — e senza accettazione la limitazione di responsabilità **non protegge**);
clausola di responsabilità riscritta stretta con salvezza delle norme inderogabili (il genitore
verso una paritaria è un **consumatore**, Cass. 10910/2017: le esclusioni per inadempimento sono
nulle); modifiche con giustificato motivo e 30 giorni di preavviso; foro del consumatore
inderogabile; ADR **senza** la piattaforma ODR europea, chiusa dal 20/07/2025 (Reg. UE 2024/3228).

**La sezione RPD/DPO NON è pubblicata** (`RPD_RECAPITO = null`): scrivere «la Scuola ha designato un
RPD» prima di averlo designato sarebbe un'affermazione falsa in un documento legale, ed è anche la
più facile da smentire — la comunicazione al Garante passa da una procedura tracciata. Torna con una
riga quando la nomina è perfezionata.

Versioni alzate a **2026-07-31**: chi ha accettato la 2026-07-28 ha accettato un documento diverso.

### Verificato sul codice, non solo asserito

Prima di pubblicare affermazioni di fatto in un documento legale: **nessun analytics o tracker** (e
quindi «solo cookie tecnici, nessun banner» è vero), **log 30 giorni**, **copia locale 7 giorni**,
**backup Android esclusi**, **due canali di cancellazione**, **log senza nomi, recapiti né dati
sanitari** (lista bianca in `redact.ts`). ⚠️ Restano da confermare al Titolare: che il database sia
davvero in **Irlanda** (l'indirizzo del server è compatibile, la prova è nella dashboard) e le
**certificazioni DPF** dei fornitori, che cambiano nel tempo.

**Test**: 7 casi nuovi sui consensi + 8 asserzioni nel lock delle pagine legali, che guardano il
**testo** e non i commenti — i commenti citano di proposito le formule sbagliate per spiegarle, e un
lock che cercasse quelle stringhe nel file intero verificherebbe il contrario di ciò che intende.
**Prova di validità**: tolto il controllo del consenso, 5 test su 7 cadono; rimesso l'art. 9.2.a
sulla salute, il lock legale cade.

**Gate**: eslint **0** · tsc **0** · vitest **3540 / 429 file** · build ok · advisors **0 ERROR**.

⚠️ **I testi NON sono un parere legale** e nessun professionista abilitato li ha sottoscritti.

---

## 🗓️ Changelog — Audit sistematico dell'isolamento fra sedi: chat, GDPR, anagrafica e il vincolo che sovrascriveva il registro 2026-07-30 (branch `fix/isolamento-audit`)

Seguito dell'hotfix qui sotto. Inventario completo delle **282 route** in
`docs/audit/2026-07-30-isolamento-fra-sedi.md`: **59 da proteggere**, di cui 12 chiuse in questo
rilascio, più la migrazione che chiude l'unico difetto che *corrompe* dati.

**Il modello, verificato prima di applicarlo.** Le due regole decise dal titolare — segreteria
sulla sola propria sede, educator sulle sole sezioni assegnate — **erano già scritte negli helper**:
`scuoleDiUtente` restituisce solo la sede propria a chi non è admin, e `vedeTutteLeClassi` esclude
l'`educator`. Non è stato toccato il cuore dell'autorizzazione: è stato **applicato** alle route che
non lo chiamavano.

### Il vincolo che faceva sovrascrivere il registro fra sedi — migrazione `registro_orario_unique_per_sede`

```sql
-- prima: UNIQUE (classe_sezione, data, ora_lezione)          ← senza sede
-- dopo:  UNIQUE (scuola_id, classe_sezione, data, ora_lezione)
```
Gli upsert di `register/lessons:139` e `primaria/registro:245` **scrivevano sulla stessa riga**:
argomento, compiti e firme del «2 ANNI» di Aversa sovrascrivevano quelli di Cesa, **in silenzio**.
È l'unico difetto dell'audit che corrompe dati invece di esporli, ed era invisibile in lettura
perché il gate di scope sulle due route c'era già. Al momento della migrazione: **14 righe, 0
collisioni** — nulla da riconciliare. Advisors Supabase **0 ERROR**.
Chiave centralizzata in `src/lib/registro/chiave-orario.ts`, con ripiego `42P10` per il **solo** DB
E2E non migrato (che ha una sede sola, quindi le due chiavi vi coincidono). Lock architetturale
`__tests__/architecture/chiave-registro-per-sede.test.ts`: nessun file di `src/` può usare una
chiave di conflitto che parte da `classe_sezione`.

### Chat e GDPR (7 route)

- **`admin/chat/contacts`** — nome e classe di **tutti** i minori delle tre sedi e dei loro genitori,
  a qualunque segreteria, con la chat già apribile. ⚠️ La correzione del 29/07 aveva toccato il
  **gemello** `chat/contacts` (lato docente): questa route non era mai stata guardata.
- **`admin/chat/threads`** — tutte le conversazioni genitore↔docente delle tre sedi. `chat_threads`
  non ha `scuola_id` e **non serve**: `student_id` è FK verso `alunni`, la sede si deriva dal join.
- **`admin/chat/messages`** — bastava l'uuid di un thread per leggere il **contenuto** dei messaggi.
- **`chat/threads:POST`** — essere partecipante non basta: `student_id` arrivava dal client e non era
  verificato.
- **`admin/gdpr/erase`** — **anonimizzazione irreversibile** di un minore e dei suoi genitori di un
  altro plesso, autorizzata dal solo ruolo. Il gate scatta prima di ogni effetto, dry-run compreso.
- **`admin/gdpr/candidates`** e **`admin/gdpr/richieste`** — quest'ultima **leggeva** `scuola_id` e
  non lo confrontava con niente.

### Anagrafica (5 route) — l'insieme di PII più ampio del sistema

`admin/students/[id]` (`select *` + CF + note mediche + `parents (*)` con documento d'identità e
recapiti + `delegates (*)` col numero di documento di chi ritira), `admin/parents` GET/POST/PATCH,
`admin/parents/[id]`, `admin/regenerate-credentials` (reset password **e invio credenziali per
email** a un genitore o a un collega di un'altra sede).

**Due primitivi nuovi in `src/lib/auth/scope.ts`**, perché mancavano davvero:
- `assertParentInScope` — `parents` **non ha** `scuola_id` e **non deve averlo**: un genitore può
  avere figli in due sedi, quindi «la sua sede» non esiste. Lo scope si deriva dai **figli**. Un
  genitore senza legami non è raggiungibile da nessuno: è la risposta giusta, non c'è modo di
  stabilire il plesso.
- `assertUtenteInScope` — per le operazioni su un collega (reset credenziali, assegnazioni).

**Regola confermata**: scope vuoto ⇒ `.in(…, [])` ⇒ nessuna riga. Si **nega**, non si apre.

**Test**: 25 casi nuovi su `finto-supabase`. **Prova di validità su ogni blocco**: rimessi i
difetti, 10/12 (chat+GDPR) e 6/8 (anagrafica) tornano rossi — i verdi sono i casi di accesso
legittimo, ed è corretto che restino verdi. Dieci test preesistenti adeguati: dove il gate nuovo è
mockato concessivo, la ragione è scritta accanto col rinvio al file che quel gate lo prova. Usato
`importOriginal` e non un mock nudo — sostituire l'intero modulo di scope rendeva `undefined`
funzioni già in uso, e due test diventavano verdi per il motivo sbagliato (successo al primo
tentativo, corretto).

### Il resto dell'audit: note e voti, modulistica, galleria, mensa, contabilità, registro

- **Note disciplinari e valutazioni** (4 route) — `?alunnoId=` era libero e **senza
  parametro** tornava tutto di tutte le sedi; la POST scriveva su `alunnoIds` arbitrari e
  **notificava i genitori**. Qui entra anche la seconda regola decisa dal titolare: primitivo
  `sezioniVisibili`, l'`educator` vede le **sole sezioni assegnate**. Fail-closed: senza sezioni
  assegnate l'elenco è vuoto, non è tutto il plesso.
- **Modulistica** (7 route + 2 migrazioni) — l'unico caso in cui l'isolamento **non era
  rimediabile in codice**: non esisteva nessun dato da cui dedurre la sede di una compilazione.
  Migrazione `modulistica_sede_su_modelli_e_compilazioni` (sede sul modello, `null` = tutte; sede
  sulla compilazione, scritta all'invio) + `..._backfill_sede_compilazioni_storiche`: le 4 righe
  preesistenti sono del 7-9 luglio, quando esisteva **una sola sede reale** — la loro sede non è
  un'ipotesi. Zero righe orfane. Più il **selettore di sede nel costruttore di moduli**, con la
  scelta ri-validata server-side.
- **Galleria** (2) — l'autorizzazione passava dal ramo `isAdmin`, che include la **segreteria** e
  concedeva qualunque media di qualunque sede; per l'educator si basava sull'intersezione dei
  **nomi** di classe. **Mensa** (1) — il ramo staff prenotava e disdiceva per qualunque alunno.
- **Contabilità** (12) — si incassava, stornava, scontava e fatturava sulle rette di un altro
  plesso. Primitivo `assertPagamentoInScope`: una retta appartiene a un **plesso**. Il **credito**
  invece è della **famiglia** e passa da `assertParentInScope` — un genitore non ha una sede
  propria. Sugli elenchi di uuid un solo id fuori scope fa fallire l'**intera** richiesta.
- **Registro primaria e competenze** (10) — `sectionId` non era verificato: si assegnavano docenti
  e materie, si generavano e si **scaricavano** certificati delle competenze (documenti nominativi
  di minori) su sezioni altrui; `fascicolo-audit` rivelava **quali** minori hanno un PEI/PDP/104.
- **Migrazione `locker_config_per_sezione`** — era l'unica tabella con la sede **non deducibile**
  (classe = nome libero): la configurazione dell'armadietto di «2 ANNI» era *una sola*, condivisa
  fra Aversa e Cesa. Ora punta alla sezione vera. Tabella vuota: nessun backfill.

### Quattro difetti fuori perimetro, corretti su decisione del titolare

`primaria/allegati` creava il bucket **pubblico e senza scadenza** (compiti, verifiche, foto di
lavagne coi nomi dei bambini leggibili da chiunque avesse l'URL) → bucket privato + link firmati a
10 minuti; `panic-alert` chiedeva una sessione ma **non il ruolo** (un genitore poteva far scattare
l'allarme «ritiro non autorizzato» su qualunque bambino); `pagamenti/genera` scartava l'esito
dell'audit con `.then(() => {}, () => {})`; `pre-inscriptions` non scrive più `password_segreta` in
chiaro (la colonna in produzione **non esiste**: falliva già in silenzio).

### Tre GET completamente aperti, trovati durante il lavoro

`admin/primaria/materie`, `/orario`, `/materia-obiettivo` rispondevano **200 senza credenziali**
(verificato in produzione). Non espongono dati di minori — sono configurazione — e le POST gemelle
il gate ce l'avevano già: un'asimmetria che nessun test coglieva.

### Il lock che impedisce la ricomparsa

`__tests__/architecture/isolamento-sede-coverage.test.ts`: ogni route service-role che legge
tabelle di persone **deve** dichiarare uno scope, o comparire in un'allowlist **con la ragione
scritta accanto**. Copertura totale, nessuna lista di prefissi. Appena scritto ha trovato **9 route
che l'inventario non copriva**: tre corrette (fra cui `educator-sections`, che derivava i nomi di
classe dai media taggati senza vincolo di sede), sei legittime e motivate.

**Prova di validità su ogni blocco.** In due casi ha smascherato test **falsi verdi**: quelli della
galleria passavano anche col difetto rimesso, perché usavano il ruolo sbagliato e un campo con una
guardia propria. Riscritti. Un test che non si è visto fallire non è una prova.

**Gate**: eslint **0** · tsc **0** · vitest **3525 / 428 file** · build ok · advisors **0 ERROR**.

---

## 🗓️ Changelog — Tre dati sanitari di minori autorizzati male, uno **senza alcuna autenticazione** 2026-07-30 (branch `fix/isolamento-hotfix-sanitari`)

Primo tempo dell'audit sistematico dell'isolamento fra sedi (piano completo in
`docs/prompts/PROMPT-ISOLAMENTO-SEDI.md`). Perimetro deliberatamente **minimo**: solo i tre punti
in cui un dato sanitario di un minore era leggibile da chi non doveva, isolati in una PR a sé per
poter andare in produzione **subito**, senza aspettare le altre 56 route dell'audit.

- 🔴 **`GET /api/diary/students?id=` non aveva alcun gate.** `requireDocente` era invocato solo
  **dopo** il `return` del ramo `?id=`: bastava conoscere (o indovinare) un uuid per ottenere, da
  internet e **senza credenziali**, nome, cognome, classe, **`note_mediche`** del bambino e
  nome/cognome/**email dei suoi genitori**. Verificato in produzione il 2026-07-30 con un uuid
  inesistente: **HTTP 200**. Non era una perdita fra sedi — era aperto a chiunque. Ora il gate sta
  prima della lettura: genitore → legame genitore↔figlio (`requireParentOfStudent`); staff →
  `assertAlunnoInScope` (plesso, e per `educator` sezioni assegnate). `cuoca` non ha né legame né
  sezioni: nessun ruolo resta scoperto.
- 🔴 **`GET /api/parent/medical-certificates/file` autorizzava il solo RUOLO.** Il ramo `isStaff`
  saltava ogni verifica di appartenenza: chiunque fosse `educator` di qualunque plesso scaricava il
  **PDF del certificato medico** (art. 9 GDPR) di un minore di un'altra sede conoscendo l'id del
  certificato. Aggiunto `assertAlunnoInScope` anche per lo staff — coerente con la `PATCH` di
  `teacher/medical-certificates`, che lo applicava già, e col modello di
  `src/lib/primaria/fascicolo-rbac.ts` (che nega con motivo `cross-tenant`).
- 🔴 **`GET /api/teacher/medical-certificates`: il gate c'era, il filtro no.** `assertClasseNomeInScope`
  scattava **solo** con `?class_name=`, e il filtro righe era in JavaScript sul nome-classe. Senza
  parametro tornavano i certificati di **tutte le sedi** (periodo di malattia, note cliniche libere,
  `file_path`); con `?class_name=2 ANNI` entravano anche gli omonimi dell'altro plesso. Aggiunto
  `.in('alunno.scuola_id', resolveScuoleAttive(…))` con `!inner` sul join. È il caso di scuola
  descritto nel commento di `assertClasseNomeInScope`: **gate e filtro sono due presidi diversi e
  servono entrambi**.

**Regola confermata sui degradi:** scope vuoto ⇒ `.in(…, [])` ⇒ nessuna riga. Si **nega**, non si
apre — un test dedicato lo mette a contratto (`utente senza alcun plesso: elenco vuoto, non elenco
completo`).

**Test**: 17 nuovi casi in `__tests__/api/diary-students-id-gate.test.ts` (8) e
`__tests__/api/certificati-medici-scope-sede.test.ts` (9), su `finto-supabase` — il finto client che
applica davvero `.eq`/`.in` anche sulle risorse embedded (con un mock piatto un test d'isolamento è
verde **anche senza** il filtro). **Prova di validità eseguita su tutti e tre**: rimessi i difetti,
5 test rossi per file. `diary-students-genitori-unione.test.ts` aggiornato — il suo oggetto è
l'unione dei legami, non l'autorizzazione, e i due gate nuovi sono mockati concessivi di proposito.

**Gate**: eslint **0** · tsc **0** · vitest **3477 / 420 file** verdi · build ok · E2E in CI al
push. Nessuna migrazione, nessuna variabile d'ambiente nuova.

**Un test E2E rotto che non era una regressione.** `teacher-diary` ha cominciato a fallire in modo
riproducibile su questa PR. Non era il nuovo codice: **lo stesso commit di `main` (`2d85d08`) è
passato alle 10:28 e fallito alle 13:40 dello stesso giorno**, verificato rilanciando il job su
`main`. Nella traccia Playwright la `POST /api/diary/entries` risulta con **status −1** — nessuna
risposta, nessun errore lato server: la richiesta viene abortita dal test scaduto. La causa è che
quel salvataggio fa **una ventina di viaggi al database in sequenza** (select+insert per bambino,
audit, notifica ai titolari, e per ogni figlio: sede, toggle, delete di debounce, insert notifiche):
con due bambini in sezione sfiora i **5 secondi** del timeout di default di `toBeVisible`, e quando
il DB E2E rallenta li supera. Le altre attese dello stesso file usavano già 15 secondi; le due
asserzioni sul toast erano rimaste al default. Corretto aspettando la **risposta** della POST invece
di una soglia, e asserendo lo status (se il salvataggio fallisce, il messaggio dice *quale* stato è
tornato). **Resta aperto**: venti round-trip sequenziali per salvare una merenda sono un costo reale
anche in produzione, e vanno guardati a parte.

### Resta aperto dopo questa PR (dall'audit, 59 route)

Il difetto più grave che **non** è una route da filtrare: **`unique_registro_orario UNIQUE
(classe_sezione, data, ora_lezione)` non contiene `scuola_id`** — verificato sul DB di produzione.
Gli upsert `onConflict: 'classe_sezione,data,ora_lezione'` (`register/lessons:139`,
`primaria/registro:245`) **condividono la stessa riga fra sedi omonime**: argomento, compiti e firme
del «2 ANNI» di Aversa sovrascrivono quelli di Cesa. È l'unico che **corrompe** dati invece di
esporli, ed è invisibile in lettura perché il gate di scope c'è. Oggi 14 righe e **0 collisioni**:
la migrazione è ancora indolore. Poi: `admin/chat/contacts` (la correzione del 29/07 riguardava il
gemello lato docente, non questa), `admin/students/[id]`, `admin/parents`, `admin/gdpr/erase`, i 4
endpoint che leggono l'identità da header aggirando `ALLOW_HEADER_IDENTITY`, e i ~10 punti dove
`if (plessi.length > 0)` rende lo scope vuoto un «nessun filtro».

**Smentito**: le 15 route `admin/wipe`/`seed-*`/`debug-*`/`apply-*-migration` **non** sono aperte —
passano tutte da `sealDangerous()` (`src/lib/security/seal.ts:14`), che in produzione risponde 404
(verificato live: `POST /api/admin/wipe` → 404). E **`pre_inscriptions` non esiste** nel database di
produzione: il `POST` anonimo del flusso legacy non può scrivere nulla.

---

## 🗓️ Changelog — Collaudo end-to-end della catena di onboarding, e i quattro difetti che ha scoperto 2026-07-29 (branch `fix/audit-legami`)

La catena *link → modulo → segreteria → credenziali → alunno in classe → genitore che vede il
figlio* è stata percorsa **per intero in produzione**, con una famiglia fittizia su **Aversa** e
un'email reale. Non una simulazione: modulo compilato nel browser, import fatto dalla segreteria,
email ricevuta in casella, login del genitore.

### Cosa è stato verificato, passo per passo

| Passaggio | Prova |
|---|---|
| Link pubblico con tre sedi | passo di scelta sede, «Passo 1 di 4» |
| Invio | riga `enrollment_submissions` su Aversa, provincia normalizzata `CE`, due documenti |
| Notifica alla segreteria | **2 admin** raggiunti (via ponte `utenti_scuole`) |
| Pannello segreteria | badge «SEDE: KIDVILLE AVERSA», tendina con le **sole 5 sezioni di Aversa** |
| Import in «3 ANNI» | alunno `stato: iscritto` |
| Alunno agganciato alla classe | `section_id` valorizzato dal trigger `sync_alunno_section_id` |
| Credenziali | email **ricevuta** da `noreply@mail.kidville.it`; successo registrato in `app_log` |
| Login genitore | area `parent`, figlio in home |
| Il genitore vede il figlio | home · diario · **galleria** · agenda · pagamenti · chat · mensa · notifiche → tutti `200` |
| **Il gate regge ancora** | galleria di un bambino **non suo** → **403** |

L'ultima riga è la più importante: la correzione dei legami ha **allargato l'accesso ai figli veri
senza aprire un varco**. Un fix che avesse semplicemente disattivato il controllo avrebbe prodotto
gli stessi `200` — e sarebbe stato molto peggio del difetto.

### I quattro difetti che solo il collaudo poteva trovare

1. **Il wizard si inchiodava al primo passo** (dettaglio nella voce precedente).
2. **Un'iscrizione su una sede nuova non la annunciava nessuno.** `staffScuola` guardava solo
   `utenti.scuola_id` e ignorava il ponte `utenti_scuole` attraverso cui la Direzione è
   multi-plesso: su Aversa e Cesa restituiva zero destinatari, e `notificaEvento` con zero
   destinatari esce in silenzio. Dieci punti di notifica interessati. Ora l'unione col ponte, e
   «nessun destinatario» viene **loggato**: senza quella riga, «nessuno è stato avvisato» e «tutto
   a posto» sono indistinguibili.
3. **L'import poteva archiviare l'alunno nella sede sbagliata.** Il `PATCH` caricava l'invio per id
   **senza filtro di scope**; per una segreteria le sedi accessibili sono solo la propria, quindi
   la sede preferita non risultava accessibile e si ricadeva sull'unica disponibile: **il bambino
   veniva creato nella sede dell'operatore, in silenzio**. Ora `403`, per l'accettazione e per il
   rifiuto.
4. **L'audit dei legami non è mai stato scritto.** `audit_scritture_docente.entita_id` è una
   colonna uuid, ma sei chiamanti passavano una chiave composta (`"studentId:parentId"`) perché
   quelle entità sono **relazioni** e un uuid proprio non ce l'hanno: Postgres rifiutava l'INSERT
   e la riga non veniva scritta **affatto**. Per i legami genitore↔figlio — tutte e tre le vie di
   creazione — e per le assegnazioni docente↔sezione non è **mai** esistita una traccia di chi
   avesse collegato chi a chi. Trovato leggendo `app_log` dopo il primo import reale.

> **Il filo comune, che vale più dei singoli difetti**: tutti e quattro erano **invisibili con una
> sede sola**, e nessun test poteva vederli perché né jsdom né il DB della CI hanno mai avuto due
> sedi. 3411 test verdi e l'E2E verde convivevano con un modulo di iscrizione inutilizzabile.
> Non è una colpa dei test: è il limite di collaudare una condizione che l'ambiente di prova non
> sa riprodurre.

### Il collaudo degli 11 tester: sette route perdevano dati di minori fra sedi

Gli 11 tester-opus hanno riportato **FAIL su tutte le categorie** e quattro bloccanti. Tre erano
falle di **isolamento fra sedi**, tutte con la stessa firma: la query filtrava gli alunni per
**nome della classe** senza vincolo di `scuola_id`, su route che girano con service-role — quindi
con la RLS scavalcata e il gate applicativo come unico presidio.

**Erano latenti da sempre e le ha attivate l'apertura delle sedi nuove**: con un plesso solo il
nome della classe era di fatto una chiave univoca; con tre plessi «2 ANNI» esiste sia ad Aversa sia
a Cesa, «5 ANNI» pure, e quel nome ha smesso di identificare una classe sola.

L'audit sistematico delle **17** occorrenze dello schema ne ha trovate **sette** da correggere —
cinque oltre le due segnalate:

| Route | Cosa perdeva |
|---|---|
| `admin/documents-merge` | nome, cognome e **codice fiscale** dei minori di un'altra sede |
| `teacher/modulistica` (GET) | nome e cognome; bastava il ruolo `educator` di qualunque plesso |
| `teacher/modulistica` (POST) | si allegava una scansione al fascicolo di un bambino di un'altra sede |
| `attendance/daily` | nomi e presenze |
| `attendance/delegates` | delegati al ritiro, con **numero di documento** |
| `chat/contacts` | i **genitori** dell'altra sede fra i contatti, chat già apribile |
| `register/lessons` (GET) | registro: argomenti, compiti, firme |
| `pagamenti/genera` (POST) | **scrittura**: `alunno_ids` non validati, sede del client non verificata |

Corrette estendendo `assertClasseNomeInScope` (che ora sa anche restringere l'`educator` alle
proprie sezioni, senza toccare segreteria/coordinator/admin che per progetto vedono tutte le classi
del plesso) e aggiungendo il filtro per sede sulle query — gate e filtro insieme, perché il primo
impedisce di *nominare* una classe altrui e il secondo impedisce che l'omonimia porti dentro i
bambini dell'altra sede.

**Quarto bloccante — la dedup dell'alunno per codice fiscale era globale.** Il modulo pubblico
accetta qualunque CF senza verificarlo, e il codice fiscale italiano si deduce da nome, cognome,
data e luogo di nascita: i dati che il genitore di un compagno di classe conosce. Su
corrispondenza la dedup riusava il bambino e ne **sovrascriveva la classe** con una sezione di
un'altra sede — che il trigger non risolve, lasciando `section_id` NULL e facendo sparire
l'alunno dal registro della propria sede. Fino a stamattina era un difetto anagrafico; da quando
l'import scrive anche `legame_genitori_alunni` (la tabella su cui fanno il join le policy RLS di
pagamenti, incassi e note disciplinari) era diventato **accesso reale**. La dedup è ora vincolata
alla sede, e un CF già iscritto altrove è un **errore bloccante** che dice all'operatore che serve
un trasferimento, non un'iscrizione.

> **Nota di metodo.** Nessuna di queste falle era visibile al gate formale: 3424 test verdi ed E2E
> verde convivevano con sette route che perdevano dati di minori fra plessi. Le ha trovate un
> collaudo condotto *sapendo* che le sedi erano diventate tre — cioè cercando la classe di difetti
> che quel cambiamento poteva attivare, non rieseguendo i test esistenti.

### Restano aperti (decisioni del titolare, non difetti)

- `admin.e2e@kidville.test` è un account di collaudo con password nota che, per effetto di
  `provisiona_sede` (collega **tutti** gli admin a ogni sede nuova), è ora amministratore di
  Aversa e Cesa in produzione.
- **Aversa e Cesa non hanno personale**: nessun docente, nessuna segreteria. Le notifiche arrivano
  solo agli admin, e i solleciti restano spenti finché non li si accende a mano.
- Il **riepilogo del modulo pubblico non mostra la sede scelta**: con tre plessi il genitore non ha
  modo di accorgersi di aver sbagliato nell'ultimo momento utile.
- La sede `Kidville E2E` ha `funzioni_matrice` vuota: i suoi docenti prendono 403 su tutto.
- La protezione di `main` richiede un'approvazione che, su un repository con un solo sviluppatore,
  **nessuno può dare**: oggi è stata sospesa e ripristinata identica tre volte, verificandola
  campo per campo. È una toppa, non una soluzione.
- **Dati di collaudo lasciati in produzione** su richiesta: alunno «Collaudo ProvaAversa»
  (`CLLPRV22E50H501W`) in Aversa/«3 ANNI» e genitore «Ines ProvaAversa». Da cancellare quando non
  servono più.

---

## 🗓️ Changelog — Aversa e Cesa aperte, 33 sezioni · e il wizard che si inchiodava al primo passo 2026-07-29 (branch `fix/wizard-congelato-main`)

### Le tre sedi sono in produzione

Create **Kidville Aversa** e **Kidville Cesa** con la RPC `provisiona_sede` (che dopo la correzione
dello stesso giorno crea anche `admin_settings`, quindi non nascono senza registro). Verificato per
entrambe: riga in `schools` e in `scuole` **con lo stesso id**, `attiva`, matrice funzioni popolata
per infanzia e primaria, due admin collegati, **solleciti spenti** di proposito.

**33 sezioni** create dall'*ordine bracciali definitivo a.s. 2026/2027*: Cesa 12, Aversa 5,
Giugliano 16 — che si affiancano alle due sezioni TEST di Giugliano, lasciate intatte perché
servono ai revisori Apple e Google. Due normalizzazioni rispetto al file sorgente, entrambe
confermate dal titolare: la `VI` della primaria di Giugliano è un refuso per `IV`, e Aversa non ha
primaria attiva quest'anno. Nessun nome ambiguo dentro la stessa sede — condizione necessaria
perché il trigger agganci l'alunno alla classe giusta. *(I nomi delle sezioni non sono riportati
qui: alcuni contengono il nome di battesimo della docente e il repository è pubblico.)*

**Backfill dei legami**: `legame_genitori_alunni` passa da 35 a 45 righe, coppie orfane residue
**0**. Le 11 non convertibili (anagrafiche senza account) restano tali di proposito e si
ripareranno da sole al primo invio di credenziali. Controllo di sicurezza contabile eseguito
**prima**: zero alunni con genitori separati coinvolti, quindi nessuna fattura è passata da
intestatario unico a 50/50.

### Il wizard si inchiodava al primo passo — trovato collaudando in produzione

Aperte le due sedi, il modulo pubblico è diventato **inutilizzabile**: scelta la sede e premuto
«Avanti», il contatore avanzava e il pannello no.

Causa radice, misurata nel browser: lo stato React era **corretto** (`step` 0→1→2, passo corrente
sede→bambino→adulto) mentre il DOM restava fermo sulla sede. I pannelli stavano dentro
`AnimatePresence mode="wait"`, che monta il pannello nuovo **solo dopo** che l'uscita del vecchio si
è conclusa; quell'uscita non si concludeva mai, e il contatore — fuori dall'animazione — avanzava da
solo.

**La parte grave non è l'estetica**: il pannello mai montato non registra i propri campi in
react-hook-form, quindi la validazione non trovava nulla da validare e rispondeva "valido". Un
genitore sarebbe arrivato all'invio con **bambini e adulti vuoti**, fermato solo dal 400 del server.

Corretto togliendo `AnimatePresence` da attorno ai passi — *un'animazione non può decidere se un
modulo funziona* — e non dipingendo alcun passo finché non si sa se il passo sede esiste (secondo
innesco indipendente dello stesso guasto).

**Perché 3411 test verdi e l'E2E non lo vedevano**: il difetto richiede **due o più sedi**, e né
jsdom né il DB della CI ne hanno mai avute due. Il test di regressione non asserisce «il pannello
cambia» (in jsdom le animazioni risolvono all'istante e passerebbe anche col bug) ma l'invariante
che rende il difetto impossibile.

> **Lezione operativa**: durante il collaudo il service worker ha servito per un po' codice vecchio
> dalla cache `kidville-shell-v3`, facendo sembrare inefficace una correzione che invece funzionava.
> È lo stesso inganno già registrato per `/offline`. Prima di misurare qualunque cosa nel browser:
> disiscrivere il service worker e svuotare le cache.

---

## 🗓️ Changelog — Multi-sede reale: il modulo pubblico, il legame genitore↔figlio e la sede che nasceva mutilata 2026-07-29 (branch `feat/screenshot-play-store`)

Preparazione all'onboarding degli alunni **reali** in produzione, con l'apertura di Aversa e Cesa
accanto a Giugliano. Il lavoro è nato come collaudo della catena *link → modulo → segreteria →
credenziali → alunno in classe → genitore che vede il figlio*, e il collaudo ha trovato cinque
difetti che esistevano da mesi ma che **si manifestano solo quando le sedi diventano più di una**
o quando il genitore arriva dal modulo pubblico invece che dal seed.

### 1. Il modulo pubblico si sarebbe spento all'arrivo della seconda sede

`src/app/api/iscrizione/route.ts` risolveva la scuola così: se il body non porta `scuola_id`,
scarta le scuole di collaudo e usa **l'unica reale rimasta**; con più di una, `400 «Specificare la
scuola»`. Con una sola sede funzionava. Con tre, ogni genitore avrebbe ricevuto un errore secco —
e il bottone «Copia link» della segreteria copiava proprio l'URL nudo, senza parametro.

Scelta: **selettore di sede dentro il modulo**, non un link diverso per plesso. Un unico
indirizzo da diffondere; è il genitore a scegliere la sede al primo passo, e `?scuola=<uuid>`
resta come scorciatoia che quel passo lo salta. Il passo compare **solo** con più di una sede
reale: con una sola il flusso è identico a prima, ed è ciò che tiene verde l'E2E in CI, dove il
DB ha una scuola sola.

- Nuovo `src/lib/scuole/reali.ts` — fonte unica del predicato «sede reale» (esclude le sedi di
  collaudo, scarta le disattivate **fail-open**). Prima quel predicato era duplicato inline in due
  punti; ora è uno solo, e `src/lib/notifiche/destinatari.ts` ci è stato ricondotto.
- Nuova `GET /api/iscrizione/sedi`, anonima e rate-limited, che espone **solo id e nome**.
- Il `400` resta come ultima difesa per chi invia fuori dal wizard: un'iscrizione finita nella
  scuola sbagliata è peggio di un errore.

Un bug è emerso **scrivendo i test**, non leggendo il codice: `?scuola=` *vuoto* produceva `''`,
falsy ma non `null`, e `scuolaId ?? sedeScelta` restituiva `''` — il POST sarebbe partito
ignorando la sede appena scelta dal genitore.

### 2. Il genitore importato non vedeva il proprio figlio (e non riceveva gli avvisi)

Il legame genitore↔bambino vive in **due tabelle in spazi-id diversi**: `legame_genitori_alunni`
(`genitore_id` = account) e `student_parents` (`parent_id` = anagrafica, legata all'account solo
dal ponte `parents.auth_user_id`). L'accettazione di un'iscrizione scriveva **solo la seconda**,
mentre mezza applicazione leggeva **solo la prima**.

Misurato sul database di produzione prima dell'intervento: 35 coppie runtime, 22 anagrafiche,
**10 coppie esistenti solo come anagrafica**. Quei dieci genitori prendevano **403 sulla galleria
del proprio figlio**, e non lo vedevano in agenda, chat, diario, pagamenti. Ogni famiglia in
arrivo dal modulo pubblico sarebbe finita nella stessa condizione.

Peggio ancora la **direzione inversa** (*alunno → genitori destinatari*): `notifiche/destinatari`,
mensa, merchandise, primaria, solleciti e uscite leggevano tutte la sola tabella runtime — un
genitore importato non avrebbe ricevuto **nemmeno gli avvisi**.

- L'import ora scrive **entrambe** le righe, con `ignoreDuplicates` perché un re-import non deve
  mai sovrascrivere una quota corretta a mano dalla segreteria. Solo per gli adulti che hanno
  davvero un account: un `parents` senza email non ne ha uno, e non se ne inventa uno.
- Ventiquattro file convertiti agli helper di unione già esistenti in `src/lib/anagrafiche/legami.ts`,
  più i nuovi `getGenitoriDiAlunni`/`getGenitoriDiAlunno` per il verso inverso (batch, mai N+1).
- Nuovo `sincronizzaLegamiRuntime`, chiamato dopo ogni emissione di credenziali riuscita: è così
  che gli **11 `parents` senza account** si riparano **da soli** il giorno in cui ne ricevono uno.
- Restano volutamente sulla lettura grezza: i due endpoint diagnostici (devono poter *mostrare* la
  divergenza), le due scritture, e `pagamenti/tutori` che usa un embed PostgREST con le colonne di
  ripartizione, che l'unione non saprebbe ricostruire.
- Le **policy RLS** del baseline su `pagamenti`, `incassi` e `note_disciplinari` fanno il join
  proprio su `legame_genitori_alunni`: nessuna riga di TypeScript le corregge, si sanano solo
  popolando la tabella. È l'argomento per cui la scrittura non era opzionale.

Quattro difetti gemelli, non previsti, sono emersi durante la conversione: lo split 50/50 fra
genitori separati **saltava** e la fattura finiva intestata a una persona sola
(`src/lib/pagamenti/intestatari.ts`); la segreteria non poteva aprire una chat con i genitori
arrivati dal modulo pubblico, che non comparivano proprio in elenco; il modulo cartaceo veniva
archiviato con `parent_id` nullo; e `src/lib/pagamenti/sospensione.ts` conteneva una **copia
locale** dell'unione che **scartava l'errore PostgREST**, presentando una lettura fallita come
«nessun genitore coinvolto».

### 3. Una sede nuova nasceva senza registro

Né la RPC `provisiona_sede` né il suo fallback creavano la riga `admin_settings` della nuova sede.
Senza quella riga la matrice delle funzioni è vuota e **ogni funzione docente risponde 403**:
Aversa e Cesa sarebbero nate senza registro elettronico. La riga ora la crea la RPC, che è l'unico
collo di bottiglia del provisioning — nella route sarebbe stata una quarta scrittura non
transazionale dopo una RPC già committata, cioè di nuovo una sede a metà.

I **solleciti nascono spenti** sulle sedi nuove, ed è una decisione, non una dimenticanza:
le prime rette di un import hanno scadenze retrodatate e il primo livello scatta a un giorno,
quindi col cron acceso il primo giro delle 06:00 manderebbe **solleciti di morosità veri a
famiglie vere** per debiti che sono un artefatto dell'import. Si accendono a mano da Impostazioni,
a dati verificati. La configurazione è stata inoltre riscritta **per insieme**: nessuna migrazione
nuova contiene più l'uuid di una sede, e un lock lo impedisce d'ora in poi.

### 4. L'accettazione poteva archiviare l'alunno nella sede sbagliata, in silenzio

Il `PATCH` di accettazione caricava l'invio **per id, senza alcun filtro di scope**, e passava la
sede dell'invio a `resolveScuolaScrittura`. Ma per un utente `segreteria` le sedi accessibili sono
solo la propria: la sede preferita non risultava accessibile, si ricadeva sull'unica accessibile e
**il bambino veniva creato nella sede dell'operatore**, senza il minimo errore. Ora l'invio di
un'altra sede risponde **403** — per l'accettazione *e* per il rifiuto, che aveva lo stesso buco.

### 5. Una sezione dal nome non combaciante lasciava l'alunno senza classe

La classe assegnata all'import è **testo**; un trigger risolve la sezione confrontando il nome
dentro la stessa scuola, e se non lo trova lascia il collegamento **nullo senza dire niente**. Con
tre sedi e sezioni quasi omonime era la ricetta per alunni senza classe. Ora un pre-flight rifiuta
come bloccante una sezione inesistente in quella sede **prima di ogni scrittura**, replicando alla
lettera la normalizzazione del trigger; e la tendina della segreteria mostra solo le sezioni della
sede dell'invio, con il nome della sede visibile su ogni riga.

### Gate

`eslint --max-warnings 0` · `tsc --noEmit` · **410 file, 3411 test** · `build` — tutti verdi.
Due migrazioni applicate, advisors **0 ERROR**. Quattro nuovi lock di architettura: nessuna
migrazione nuova può cablare l'uuid di una sede, e il default della matrice funzioni resta gemello
fra SQL e TypeScript.

---

## 🗓️ Changelog — Informativa privacy riscritta sull'art. 13 · App Privacy labels pubblicate · incidente chiave di servizio chiuso 2026-07-28 (branch `feat/screenshot-play-store`)

Sessione di lavoro sulle console (Supabase, GitHub, Apple) più il lavoro sul repo che ne è
disceso. Tre cose meritano di stare in cima.

**1. L'informativa privacy era incompleta, e su un punto diceva il falso.** Un confronto puntuale
di `/privacy` con l'art. 13 GDPR, le linee guida trasparenza **WP260**, la sentenza **CGUE
C-154/21** e la *User Data policy* di Google Play ha trovato **nove lacune**. La più seria non era
un'omissione: la pagina affermava che *«i dati sono trattati all'interno dello Spazio Economico
Europeo»* e che i trasferimenti erano «eventuali». È vero per la banca dati — la region Supabase è
`eu-west-1`, Irlanda, verificata in dashboard — ma **Google LLC** (notifiche push) e **Resend**
sono soggetti statunitensi: il trasferimento è strutturale, non eventuale. Un'informativa
*inesatta* è un problema diverso, e peggiore, di una incompleta.

Riscritta di conseguenza (`src/app/privacy/page.tsx`, `VERSIONE_PRIVACY` → `2026-07-28`):

| Rif. | Cosa mancava | Ora |
|---|---|---|
| 13(1)(a) | ragione sociale **abbreviata** in `Soc. Coop.` | per esteso: `SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA` + REA. Google pretende che l'entità della scheda store **compaia** nell'informativa: era una discrepanza banale da contestare, e stessa correzione in `/termini` |
| 13(1)(c) | base giuridica dei dati sanitari solo come «consenso» | condizione **art. 9(2)(a)** esplicitata, con l'interesse vitale (lett. c) per le emergenze |
| 13(1)(e) | destinatari solo per categoria | **nominati**: Supabase, Vercel, Google/FCM, Resend, Aruba/SDI. WP260 vuole i nomi quando identificarli è possibile; le categorie si ammettono solo quando è *impossibile* (C-154/21) |
| 13(1)(f) | «dati nello SEE», trasferimenti «eventuali» | sezione veritiera: banca dati in Irlanda, fornitori USA dichiarati, garanzie del Capo V (adeguatezza / clausole tipo) |
| 13(2)(a) | nessun tempo di conservazione | **numeri**: log 30 giorni, cache sul dispositivo 7 giorni, contabili **10 anni** (art. 2220 c.c.) |
| 13(2)(e) | **assente** | nuova sezione «Natura del conferimento»: cosa è obbligatorio, cosa facoltativo, conseguenze del rifiuto |
| 13(2)(f) | **assente** | nuova sezione: nessuna decisione automatizzata né profilazione (art. 22) |
| Play | nessuna sezione sulla sicurezza | nuova sezione «Misure di sicurezza» (art. 32) |
| Play | nessun ancoraggio | `id="cancellazione"` + `scroll-mt`, con entrambe le vie (in-app e pagina pubblica) |

🔴 **Il testo NON è validato dal legale.** Restano da confermare a un professionista: la
condizione dell'art. 9(2) scelta per i dati sanitari, **se la Scuola debba nominare un RPD/DPO**
(le fonti trattano gli istituti scolastici, anche paritari, come organismi di diritto pubblico ai
fini dell'art. 37 — per questo la sezione DPO **non è stata scritta**: non si dichiara ciò che non
si sa), e i tempi di conservazione qui fissati. Il Passo 5 del DSA resta bloccato da questo.

**2. App Privacy labels pubblicate su App Store Connect**, e il manifest allineato. Erano
**mai state compilate**, e anche l'URL dell'informativa era **vuoto**. Pubblicate **20 tipologie**
— Health, Sensitive Info e Product Interaction incluse, per decisione del titolare — tutte con
*Tracking = No*, unico scopo *App Functionality*, e *Linked to You = Yes* su tutte, diagnostica
compresa. `ios/App/App/PrivacyInfo.xcprivacy` passa da 8 a **20** voci: **parità raggiunta**, che
è la verifica che conta. ⚠️ Il manifest viaggia dentro l'`.ipa`: perché Apple lo veda serve una
**build nuova**. Nella stessa sessione: età **4+** in 172 paesi confermata, e chiusa la domanda
nuova *«Social media disabilitati per minori di 13 anni»* (scadenza **7 settembre 2026**) con
**No** — rispondere Sì avrebbe significato dichiarare di aver implementato l'**API Declared Age
Range**, che non usiamo.

**3. L'incidente della chiave di servizio è chiuso.** Verificato in dashboard: *«No secret API
keys found»*, nessuna chiave `secret` attiva. Resta viva la **`service_role` legacy** (JWT), che è
la credenziale su cui gira oggi la produzione — ⚠️ **non premere «Disable legacy API keys»**:
`SUPABASE_SERVICE_ROLE_KEY` la contiene, e disabilitarla spegnerebbe tutte le route admin. La
legacy **non è mai finita nel repo**: decodificati tutti i JWT dei 553 commit, sono `"role":"anon"`.

Altro, in breve:

- **Android**: il `domain-config` cleartext verso `10.0.2.2`/`localhost`/`127.0.0.1` è stato
  spostato da `src/main/res/xml/` a **`src/debug/res/xml/`**. Erano indirizzi irraggiungibili da un
  telefono vero, quindi innocui nei fatti — ma è la riga che uno scanner automatico segnala, e la
  dichiarazione «tutti i dati cifrati in transito» del modulo Sicurezza dei dati ora regge anche a
  un'analisi statica dell'AAB. ⚠️ **L'AAB va ricompilato** (`versionCode 1` non è ancora bruciato).
- **`docs/store-submission.md`**: chiusa l'ambiguità sulle righe finanziarie. Vale A2, e il repo
  ora dichiara tutte e tre — `PaymentInfo`, `OtherFinancialInfo`, `PurchaseHistory`.
- **`docs/submission/assets/README.md`**: diceva ancora «8 screenshot non prodotti». Sul disco ce
  ne sono **5**, verificati 1080×1920 RGB senza alpha.
- **GitHub**: repo di nuovo **pubblico** per scelta del titolare, dopo aver verificato che nella
  storia non resta nessun segreto vivo. Ripristinate le protezioni che il piano Free non concedeva
  ai repo privati: **Required reviewers** su `production` (il gate che mancava a `migrate.yml` sul
  DB di produzione) e branch protection su `main` con `approvals: 1` + `enforce_admins`.
  ⚠️ Con un solo sviluppatore **nessuna PR è mergiabile** senza abbassare temporaneamente il
  conteggio delle approvazioni.
- **Ticket Apple** per la conversione Individual → Organization **inviato**: pratica
  **`20000121958970`**.

🔴 **Bloccante nuovo, da correggere a mano prima dell'invio**: il campo *Password* dell'account
demo su App Store Connect contiene un valore **diverso** da quello dedicato al revisore
(confrontato per hash, senza mai leggerlo), e la password comune dei 41 account TEST è stata
ruotata il 2026-07-26. Se l'app partisse così, il revisore **non riuscirebbe ad accedere** — il
motivo di rigetto più comune in assoluto.

---

## 🗓️ Changelog — L'account del revisore non funzionava · 5 screenshot Play catturati 2026-07-28 (branch `feat/screenshot-play-store`)

**Il difetto più grave non era negli screenshot.** `test.inf.genitore1@kidville.test` — l'account
che questo PRD, `docs/store-submission.md` e le note di review indicano di consegnare ai revisori
Apple e Google — **esisteva in `auth.users` ma non in `utenti`**: si autenticava e restava senza
identità applicativa (`ensureParentIdentity` è invocata solo dalle route admin, mai al login).
E, difetto indipendente, **nessuno dei 10 alunni della sezione TEST Infanzia era collegato ad
alcun genitore**: ogni account genitore Infanzia vedeva un'app **vuota**. Un revisore avrebbe
fatto login e trovato il nulla.

Corretto con `scripts/seed-screenshot-play.mjs`: riga `utenti` creata, 10 alunni collegati,
consensi GDPR e onboarding impostati (senza, il genitore finisce sul flusso di onboarding invece
che sulla home, e il gate Termini di C5 blocca la chat). L'account demo ha ora una **password
dedicata**, fuori dal repository, così ruotarla dopo la review non romperà gli altri 40.

**Screenshot Play** — 5 catturati a **1080×1920** esatti (avvisi, diario, presenze, mensa,
pagamenti), su AVD `KV-play-phone`. Play ne chiede minimo 2 per pubblicare e 4 a ≥1080 px in 9:16
per l'idoneità alle promozioni: la soglia è superata. Mancano modulistica, news e profilo.

**Lezioni pagate, tutte nuove.**
- Gli AVD vanno **clonati** da uno funzionante: `avdmanager create` lascia `avd.id = <build>` e
  `disk.dataPartition.path = <temp>` non sostituiti e l'emulatore si chiude durante il boot.
- **La bottom nav non è raggiungibile per testo**: le sue etichette non compaiono nell'albero di
  accessibilità. `tapOn: "MENU"` fallisce; `tapOn: "Avvisi"` non naviga ma l'asserzione successiva
  passa lo stesso (il testo atteso esiste più in basso nella pagina corrente) → **si cattura la
  schermata sbagliata senza accorgersene**. Si apre il foglio con un tap a coordinate.
- Maestro fa **full-match**: `visible: "Ecco le novità di oggi"` non trova il nodo
  «Ecco le novità di oggi 🌈». Tutti i marcatori vanno avvolti in `.*…*`.
- Il foglio MENU va aperto **dalla home**: aprirlo da una pagina interna fallisce.
- `mensa_menu_rotazione.settimana` è l'indice di **rotazione** 1..N, non la settimana dell'anno.
- `presenze.giustificata` è NOT NULL: va valorizzata anche sulle presenze.
- Il menù mensa è per **scuola**: pubblicato per la foto e **rimosso subito dopo** (24 righe).

## 🗓️ Changelog — Chiave di servizio di produzione in chiaro nel repository: quattro script rimossi 2026-07-28 (branch `fix/gdpr-oblio-parent-id-space`)

Scoperto mentre si verificavano i presupposti per gli screenshot Play. **Quattro** script committati
contenevano in chiaro una chiave `sb_secret_…` del progetto di **produzione** più il suo URL:
`scripts/seed_armadietto_rest.mjs`, `scripts/seed_mock_data.mjs`, `scripts/apply_migration.mjs`,
`scripts/apply_fase3_migration.mjs`. Tracciati da git **dal 2026-05-12** (commit `ee4fc70`), con il
repository **pubblico fino al 2026-07-26**: circa due mesi e mezzo di esposizione di una credenziale
che scavalca tutte le RLS su un database che contiene dati di minori.

**Aggravante.** In produzione esiste `public.exec_sql`, funzione `SECURITY DEFINER` di proprietà di
`postgres` che esegue SQL arbitrario. È correttamente ristretta (`postgres=X/postgres |
service_role=X/postgres`: né `anon` né `authenticated`), ma è esattamente il ruolo che quella chiave
conferisce — quindi la fuga della chiave non dava solo accesso ai dati, dava esecuzione di SQL
arbitrario come `postgres`.

**Seconda esposizione, indipendente.** Due di quegli script contenevano anche **nome e cognome di
due bambini reali** in chiaro (commento: «Alunni reali trovati nel DB»), in violazione della regola
di progetto che vieta PII reali nel codice.

**Rimedio applicato.** Tutti e quattro gli script sono stati **eliminati**, non riparati: erano
codice morto. Puntavano a due `alunni` con uuid cablati che **non esistono più** (verificato in
produzione: 0 e 0) e alla classe «Girasoli», anteriore al reset del 2026-07-04; le migrazioni si
applicano da tempo con lo strumento MCP `apply_migration`, come impone `CLAUDE.md`.
`seed_armadietto_rest.mjs` per giunta faceva `DELETE` seguito da `INSERT` ciechi su produzione,
ignorando ogni variabile d'ambiente.

**Non chiuso da questo intervento** — la **rotazione** della chiave richiede la dashboard Supabase:
`supabase projects api-keys` sa elencare ma non creare né revocare. L'elenco odierno del progetto
mostra solo `anon` legacy, `service_role` legacy e una `publishable`, **nessuna chiave di tipo
`secret` attiva**, il che suggerisce che quella esposta sia già stata revocata — ma va **confermato
a schermo**. Le due route che chiamano `exec_sql` (`admin/apply-migration`,
`admin/apply-enrollment-migration`) sono sigillate da `sealDangerous`, che in produzione risponde
404: non sono una falla viva.

---

## 🗓️ Changelog — L'oblio self-service non anonimizzava nessuno: spazio-id `parents.id` vs `auth.user.id` 2026-07-27 (branch `fix/gdpr-oblio-parent-id-space`)

Il diritto alla cancellazione (art. 17 GDPR, App Store 5.1.1(v), Google Play Data safety) era
**funzionante solo in apparenza**, su **entrambi** i canali. Nessuna migrazione, nessuna colonna
nuova: è un difetto di sola logica applicativa, e il residuo dello stesso refuso già corretto in
`parent/onboarding` e `onboarding/consensi.ts` con C5.

**Causa radice — due spazi-id confusi per uno.** `parents.id` è un uuid indipendente
(`gen_random_uuid()`); `auth.user.id` è l'id della riga `utenti` con `ruolo='genitore'`. Non
coincidono mai: verificato in produzione (sola lettura) — **46 righe `parents`, 35 con
`auth_user_id` valorizzato, 0 coincidenze fra un `parents.id` e un `utenti.id` qualsiasi**. Il
ponte è `parents.auth_user_id`, ed è il pattern già in produzione in `/api/me` e in
`lib/pagamenti/intestatari.ts`. `richieste_cancellazione.parent_id` è per contratto un
**`parents.id`**: è così che lo leggono `/admin/gdpr` e `anonimizzaParent`.

**Cosa era rotto.**
- **Canale in-app** (`/api/parent/account/richiesta-cancellazione`): il `POST` risolveva già
  correttamente la riga `parents` dal ponte, ma poi **inseriva `parent_id: auth.user.id`** —
  una richiesta che la Direzione avrebbe evaso anonimizzando *un id che non esiste in `parents`*,
  cioè nessuno, riportando comunque «fatto». `GET` e `DELETE` filtravano per `auth.user.id`:
  il genitore non vedeva mai la propria richiesta e non poteva revocarla.
- **Canale pubblico** (`/cancellazione-account`, il requisito Google Play): la risoluzione
  email → genitore interrogava `parents` con `.eq('id', utente.id)` e restituiva
  `parentId: utente.id`. Non trovava **mai** un genitore reale → il magic-link di conferma non
  partiva per nessuno. E siccome la risposta è **sempre `{ok:true}` per anti-enumerazione**, il
  guasto era **invisibile dall'esterno**: la pagina richiesta da Google Play era, di fatto, un
  fondale. È la scoperta più seria dell'intervento.

**Nessun incidente reale.** `richieste_cancellazione` ha **0 righe in produzione**: nessuna
falsa evasione è mai avvenuta, e non serve alcun backfill. Il difetto era **latente ma totale** —
la funzionalità era morta per ogni utente reale, non degradata.

**Correzione.** Il ponte `parents.auth_user_id` in un punto solo per tutti e tre gli handler
in-app (helper `risolviParent`, così i tre non possono più divergere) e `parent.id` sia in
scrittura sia nei filtri; `risolviGenitorePerEmail` interroga il ponte e restituisce l'id della
riga `parents` trovata. Comportamenti graziosi mantenuti: `GET` senza riga `parents` risponde
`{richiesta: null}` (è una probe di stato che il Profilo esegue a ogni apertura, non un'azione),
`DELETE` risponde `{ok:true, revocate:0}`, e lo schema assente sul DB E2E non migrato (`42703`
sulla colonna ponte) degrada senza 500. `src/lib/gdpr/esegui.ts` e `/api/admin/gdpr/richieste`
**non sono stati toccati**: erano già corretti, si aspettavano un `parents.id` — erano i
produttori a mentire.

**Perché nessun test lo aveva visto** (la lezione che vale più del fix). I fake Supabase dei test
esistenti **ignorano la colonna passata a `.eq()`** e restituiscono sempre la riga configurata, e
i fixture usavano **lo stesso uuid** per `utenti.id` e `parents.id`: con quel doppio appiattimento
una query giusta e una sbagliata sono *letteralmente indistinguibili*. 2859+ test verdi non
potevano cogliere questo bug nemmeno in linea di principio. I tre nuovi file
(`__tests__/lib/gdpr-cancellazione-pubblica.test.ts`,
`__tests__/api/parent-richiesta-cancellazione-route.test.ts`,
`__tests__/api/admin-gdpr-richieste-route.test.ts`) modellano i filtri **per davvero** (eq per
colonna, semantica ILIKE con escape) e tengono i due spazi-id **distinti**; uno dei casi prova il
danno peggiore — un `parents.id` che collide con l'`utenti.id` di un'altra famiglia farebbe
anonimizzare **la famiglia sbagliata**. TDD: 10 test rossi sul codice pre-fix, verdi dopo. Il
test sul consumatore `/admin/gdpr` (route corretta, quindi verde da subito) è stato validato
**rimettendo il bug** e verificando che diventasse rosso.

Gate verde: eslint 0 · `tsc --noEmit` 0 · vitest **390 file / 3221 test** · build ok.

### Secondo giro — i due difetti che il fix ha «svegliato»

Un collaudo adversariale sul branch corretto (tre tester indipendenti, tutti `PASS`) ha trovato
due difetti **adiacenti**: non li ha introdotti il fix, li ha resi **raggiungibili**. Prima il
percorso era inerte, e un percorso morto non ha bug visibili. Nessuna migrazione, nessuna colonna.

**1. `anonimizzaParent` — lo stesso refuso, in direzione opposta.** La bonifica del testo libero
UGC introdotto da C5 filtrava `segnalazioni` e `conversazioni_sospensioni` con il `parentId`
(`parents.id`), ma quelle colonne sono scritte **con l'identità del gate**, cioè `auth.user.id`:
`segnalazioni.segnalante_id` ← `segnalante.id` (`api/segnalazioni:POST`),
`conversazioni_sospensioni.sospesa_da` ← `auth.user.id` (`chat/threads/[id]/sospendi`), e
`sospesa_verso` ← `chat_threads.parent_id`, a sua volta confrontato con `auth.user.id` alla
creazione del thread. Il filtro non poteva **mai** trovare una riga: `motivo` e `note_gestione` —
testo libero che può citare il nome di un minore o un'allergia — non venivano anonimizzati da
questo percorso, e la Direzione leggeva «0 bonificate» credendo che non ci fosse nulla da
bonificare. È lo stesso errore del round 1, ma di segno inverso: là si usava un `utenti.id` dove
serviva un `parents.id`, qui un `parents.id` dove serve un `utenti.id`. Corretto usando
l'`authUserId` già raccolto in cima alla funzione (lo stesso ponte di `news_visualizzazioni`);
se il genitore non è mai stato bridgeato il ramo si **salta**, coerentemente con la DELETE news:
senza ponte non è raggiungibile in spazio-id `utenti`, e filtrare su un id che in quelle colonne
non comparirà mai sarebbe solo una finta. La UPDATE su `parents` resta — correttamente — su
`parents.id`. `anonimizzaAlunno` non è stato toccato: aggancia per **oggetto** segnalato
(diario/media/thread), ed era già giusto.

**2. `/api/public/cancellazione-account` (POST) — email-bombing.** Finché la route non trovava mai
un genitore non spediva mai niente, e l'assenza di rate-limit era innocua. Resa funzionante, 8 POST
consecutivi hanno prodotto 8 × 200 e nessun 429: chiunque, senza login, poteva riempire la casella
di una famiglia di email «Conferma la richiesta di cancellazione». Aggiunto il limite **5 richieste
/ 10 minuti per IP** (`rateLimit`/`clientIp`, gli stessi di `forms/send-otp`, ma più stretto: là il
reinvio di un codice da ritrascrivere è un gesto legittimo e ripetuto), come **prima istruzione**
del `POST` — prima di `parseBody` e della risoluzione del genitore. L'ordine è il punto: applicato
dopo, l'email sarebbe già partita e l'abuso resterebbe nascosto dietro la `{ok:true}` generica
dell'anti-enumerazione, che qui è la regola giusta ma è anche un ottimo mimetismo. Il 429 non
richiede log espliciti: `withRoute` persiste già ogni 429 a livello `warn`, trattandolo come
anomalia e non come 4xx di routine.

**Test.** `__tests__/lib/gdpr-esegui.test.ts` **asseriva il comportamento sbagliato**
(`segnalante_id.eq.p-1`): le asserzioni sono state riscritte sull'auth id e verificate **rosse**
contro il codice pre-fix — un test che passa su un filtro impossibile è un test che descrive il
bug, non il requisito. Aggiunti: genitore senza `auth_user_id` → nessuna UPDATE su
segnalazioni/sospensioni; e sei casi di rate-limit in
`__tests__/api/public-cancellazione-account.test.ts` (limite raggiunto → 429 con `Retry-After` e
**nessuna** chiamata a `createAdminClient`/`sendEmail`, cioè il limite blocca *prima* della logica
e non maschera una 200 già calcolata; IP distinti non condividono il contatore; anti-enumerazione
intatta sotto il limite; il 400 di validazione invariato). 7 test nuovi, tutti rossi prima e verdi
dopo.

Gate verde: eslint 0 · `tsc --noEmit` 0 · vitest **390 file / 3228 test** · build ok.

### C2 — build `.aab` firmata per Google Play

Lavoro tecnico di [`docs/submission/C2-build-aab.md`], sullo stesso branch (deroga esplicita
dell'utente alla regola "un branch alla volta": interventi scollegati — fix GDPR vs
infrastruttura di firma Play — con revisione/merge indipendenti in mente, ma un solo branch
fisico). Nessuna modifica applicativa: solo `android/**`.

**Buco chiuso prima di generare qualunque chiave.** `android/.gitignore` aveva le regole
`*.jks`/`*.keystore` **commentate** dal template Capacitor mai adattato; il `.gitignore` di
radice non ne aveva nessuna. Un `keytool` in `android/` seguito da un `git add` avrebbe
committato la chiave di firma **senza un solo avviso**. Corretto in entrambi i file
(+ `keystore.properties`, `key.properties`, `*.p12`, `*.pfx`, `*.pepk`), verificato con una prova
attiva (`git check-ignore -v` su file di prova, prima e dopo) — non solo dichiarato.

**Chiave di upload generata FUORI dal repo** (`~/Documenti/kidville-play/kidville-upload.jks`,
PKCS12, RSA 4096, validità 10.000 giorni → scade 2053-12-12, DN della cooperativa), con copia
offline in `~/Documenti/kidville-play-backup/`. La password è stata generata e scritta
**solo su file locali** (mai in questa conversazione, mai in un report d'agente — un primo
tentativo di delegare la generazione a un sub-agente è stato bloccato dal classificatore di
sicurezza proprio perché istruito a scrivere la password nel proprio report finale, che finisce
in trascrizione: correzione applicata, rifatto a mano con redirect di shell che non emettono mai
il valore in nessun output visibile). Sta in `~/Documenti/kidville-play/.upload-pw` e in
`android/keystore.properties` (gitignorato, `chmod 600`): **da spostare nel gestore di
credenziali del titolare e poi ripulire le copie su disco**.

**Gradle configurato**: `signingConfigs.release` legge env var (`KV_UPLOAD_STORE_FILE` e affini,
priorità CI) prima del file locale; `buildTypes.release.signingConfig` è un ternario che lascia
`null` se la chiave manca — build che fallisce, mai una firma silenziosa con la chiave di debug.
`versionCode`: contatore progressivo indipendente per Android (non agganciato al build number
iOS), documentato con un commento sopra `versionCode 1` in `build.gradle` per la prossima volta
che si carica un `.aab`.

**Build verificata**: `CAP_SERVER_URL=https://app.kidville.it npx cap sync android` + verifica
obbligatoria del `capacitor.config.json` sincronizzato (url/cleartext/errorPath/loggingBehavior
tutti corretti) **prima** di `./gradlew bundleRelease` (BUILD SUCCESSFUL, 32s). Firma verificata
con `jarsigner -verify -certs` (schema di firma dei bundle, non `apksigner`, che verifica APK):
`jar verified`, certificato con lo stesso CN della cooperativa, scadenza 2053-12-12.
`.aab` prodotto in `android/app/build/outputs/bundle/release/app-release.aab` (7,4 MB),
correttamente gitignorato (pattern `build/` già esistente).

### C3 (parziale) — icona e feature graphic per Google Play

Testi della scheda (titolo, descrizione breve, descrizione completa) **approvati dal titolare
così come in bozza** in `docs/submission/C3-scheda-testi-grafica.md` §1, nessuna modifica.

**Decisione sulla mascotte**: C4 §2 raccomanda grafica **sobria, senza mascotte cartoon**, per il
rischio di riclassificazione Google (*"youthful animation or young characters"*). Nel repo
**non esiste alcun asset di brand senza mascotte** (icona, logo e mascotte la mostrano tutti).
Il titolare ha scelto consapevolmente di **mantenere la mascotte** anche sulla scheda Play,
accettando il rischio segnalato da C4 §2.

**Icona 512×512 e feature graphic — v1 (scartata) e v2 (attuale).** Prima versione: icona
ritagliata da `public/mascot.png` (sfondo pieno, nessun mockup) + feature graphic disegnata da
zero (pannello bicolore Clay Village). **Il titolare l'ha giudicata "bruttissima" a confronto
con l'icona iOS** e ha chiesto esplicitamente di riusare la stessa immagine (2026-07-28).

**v2, attuale**: entrambi gli asset derivano ora da
`ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` — la stessa icona già in
produzione su App Store. `play-icon-512.png` (307 KB, PNG RGBA) è quell'immagine ridimensionata
1:1 a 512×512, nessun'altra modifica. `play-feature-graphic-1024x500.png` (271 KB, PNG RGB senza
alpha) è la stessa immagine scalata a 500×500 e centrata su tela 1024×500, con padding laterale
nel teal `(5,107,102)` campionato dalla banda inferiore dell'icona stessa (fusione praticamente
invisibile, nessun bordo visibile fra icona e sfondo).

⚠️ **Nota tecnica che resta valida, il titolare ne è consapevole**: quell'icona è un mockup con
angoli arrotondati e ombra dipinti nei pixel (non nel canale alpha). Google Play applica la
propria maschera/ombra sopra qualunque immagine caricata → risultato con **doppio bordo
arrotondato** visibile. Stesso trattamento già in produzione su App Store (coerenza fra le due
schede), ma non l'ideale per Play. Se in review risulta un problema, la correzione è tornare
alla v1 (da `public/mascot.png`, piena tela) — recuperabile dalla history del branch. Dettagli
in `docs/submission/assets/README.md`.

**Resta**: 8 screenshot telefono 1080×1920 + 4 tablet — rimandati a un intervento successivo
(richiedono emulatore Android, dati demo della classe TEST rinfrescati, flow Maestro).

## 🗓️ Changelog — C5: cancellazione account pubblica + moderazione UGC (segnalazioni, sospensione conversazione, gate Termini) 2026-07-27 (branch `feat/dossier-submission`)

Il codice che sblocca la fase C (`docs/submission/C5-sviluppo-obbligatorio.md`) — l'unica parte
del dossier di submission Google Play che è vero sviluppo, non un modulo da compilare. Due
requisiti Google Play che oggi non esistevano nel codice.

**§1 — Pagina pubblica di cancellazione account.** La User Data policy richiede un percorso
raggiungibile **senza login**, oltre a quello in-app (`/parent/profilo`) già esistente. Nuova
rotta **`/cancellazione-account`** (+ `/conferma`), bilingue, in `PUBLIC_PREFIXES`. Flusso:
email → link magic (riuso delle primitive HMAC di `otp-ticket.ts`, TTL 1h, anti-replay) →
conferma → INSERT in `richieste_cancellazione` (nuova colonna `canale='pubblico_email'`) →
notifica Direzione. **Non cancella nulla direttamente**: registra una richiesta `pending` che la
Direzione evade da `/admin/gdpr` come oggi. Risposta **sempre 200 generica** all'invio
(anti-enumerazione: mai rivelare se un'email è associata a un account). Testo riusato
letteralmente da `messages/{it,en}/profilo.json` → `eliminaSpiegazione` (copre già prerequisiti
e retention).

**§2 — UGC: segnalazione, sospensione conversazione, gate Termini.** Il grafo della chat non è
quello di un social (verificato nel codice, non ipotizzato): nessun genitore↔genitore, un
docente scrive solo alla propria sezione. **Decisione già presa dal titolare (2026-07-26)**:
sospensione della conversazione (non blocco stile social) + notifica dichiarata alla Direzione,
mai silenziosa. Implementato:
- **Segnalazione** contenuto (chat/galleria/diario) e utente — tabella `segnalazioni`, route
  `POST /api/segnalazioni` + `/api/admin/segnalazioni`, menu "⋮" sempre etichettato testualmente
  (mai solo icona) su chat/galleria/diario.
- **Sospensione conversazione** — tabella `conversazioni_sospensioni` (storico append-only, al
  più una sospensione attiva per thread via indice unico parziale), route
  `POST /api/chat/threads/[id]/{sospendi,riapri}`, guardia server-side
  `assertConversazioneNonSospesa` in `POST /api/chat/messages`. Riapertura da chi ha sospeso o
  dalla Direzione (`/admin/moderazione`, nuova pagina). Scoping **per conversazione**, non per
  utente: due figli in sezioni diverse restano indipendenti. Avvisi/giustifiche/diario/galleria/
  push **non toccati** — dimostrato con un test dedicato.
- **Gate Termini non saltabile** — `CONSENSI_RICHIESTI` esteso a `['privacy','termini']`, nuova
  tabella append-only `consensi_accettazioni` (data+versione, **server-side, mai spoofabile dal
  client** — chiude anche la lacuna E di [A3](docs/submission/A3-dossier-legale.md): oggi
  nessuno accetta i Termini, quindi la clausola di limitazione di responsabilità probabilmente
  non produce effetto). Il vero gate **non è la checkbox in onboarding** (aggirabile chiamando
  l'API): è la guardia `assertTerminiAccettatiSeGenitore` dentro `POST /api/chat/messages`,
  l'unico punto in cui un genitore produce UGC (galleria e diario restano `requireDocente`).

**Come è stato costruito.** Due filoni in un Dynamic Workflow — cancellazione pubblica (isolata)
e moderazione UGC (sequenziale sugli stessi file: guardie chat/messages, poi UI, poi pannello
Direzione) — 8 `esecutore-opus` in TDD, poi 5 `tester-opus` mirati (backend · sicurezza ·
privacy · frontend · log) in parallelo. **Tutti PASS.** Corretti nella stessa sessione due gap
segnalati dai tester: (1) `parent/onboarding/route.ts` non controllava `{ error }`
sull'`update` di `parents` — con la nuova guardia un update silenziosamente fallito avrebbe
lasciato un genitore permanentemente bloccato in chat senza alcuna diagnosi; (2) i successi di
sospensione/riapertura/segnalazione/cancellazione/consenso non erano in `EVENTI_PERSISTITI`
(regola 5 `AGENTS.md`: i successi degli eventi critici si loggano anche loro) — aggiunti i
canali `chat`/`gdpr`/`segnalazione`.

**Oblio GDPR esteso al testo libero UGC — decisione presa con l'utente.** Il tester privacy
aveva trovato un buco reale: `segnalazioni.motivo`/`note_gestione` e
`conversazioni_sospensioni.motivo` sono testo libero che può citare il nome di un minore o un
dato sanitario, e `src/lib/gdpr/esegui.ts` non li toccava — sopravvivevano per sempre
all'anonimizzazione del genitore/alunno (nessuna FK verso `parents`/`alunni`, per progetto). Alla
domanda esplicita, l'utente ha scelto **di estenderlo subito**. Fatto: `anonimizzaParent` ora
scrub-a `segnalazioni`/`conversazioni_sospensioni` dove il genitore è
segnalante/segnalato/sospendente/sospeso; `anonimizzaAlunno` risale al contenuto dell'alunno
(voci di diario, media di galleria taggati, thread di chat del figlio) e scrub-a le segnalazioni
e sospensioni collegate — copre anche il caso dei **due genitori**, quando solo uno dei due
chiede la cancellazione ma il figlio ha una conversazione con l'altro genitore o con la maestra.
Conteggi `segnalazioni_bonificate`/`sospensioni_bonificate` aggiunti a `richieste_cancellazione.esito`.
Gate rieseguito verde (387 file / 3181 test).

Altri warning minori dei tester, **non affrontati in questa sessione, restano annotati**: un
docente può segnalare contenuti fuori dalla propria sezione (scope di scrittura non ristretto);
latenza come debole canale laterale sull'anti-enumerazione email di `/cancellazione-account`; PII
reale di staff (due indirizzi Gmail) in due file di `docs/submission/` già tracciati — segnalato
dal tester perché `CLAUDE.md` dichiara ancora il repository pubblico, mentre altre note lo danno
come reso privato il 2026-07-26: da chiarire, e nel dubbio da bonificare comunque.

⚠️ **Nulla è stato committato**: modifiche sul branch `feat/dossier-submission`, in attesa di
richiesta esplicita.

## 🗓️ Changelog — Recapito legale sul dominio dell'ente + dossier di submission A1·A2·A3 2026-07-26 (branch `feat/scheda-app-store`)

Il recapito pubblicato sulle tre pagine legali era **`lerrico7@gmail.com`**, una casella **personale**, indicata come contatto del **Titolare del trattamento** e come **Support URL** per gli store. Faceva apparire una persona fisica come punto di contatto di una società cooperativa, ed esponeva il legale rappresentante a titolo personale. Ora è **`info@kidville.it`**, sul dominio dell'ente.

Non è solo igiene: Apple richiede, per l'iscrizione **Organization**, *«a work email address […] associated with your organization's domain name»* — una Gmail **non è accettabile**, e senza quell'indirizzo l'iscrizione dell'ente non parte.

- **`info@kidville.it`** sostituisce la casella personale in `/privacy` (3 punti), `/termini` e `/assistenza`.
- Il lock `__tests__/architecture/pagine-legali.test.ts` **non cabla l'indirizzo**: verifica che le tre pagine ne espongano **uno solo e lo stesso**, e che non sia una PEC. La sostituzione lo attraversa senza modifiche al test — ed è il test a garantire che le tre pagine non divergano.

**Nuovo dossier `docs/submission/`** — i tre bloccanti pre-submission, ognuno con la ricerca chiusa e le decisioni motivate: **A1** stato di operatore commerciale (DSA), **A1-bis** D-U-N-S e conversione dell'account, **A2** App Privacy labels, **A3** dossier per il legale.

Tre risultati che cambiano il quadro:

1. **Linea guida 5.1.1(ix)** — un'app che tratta *sensitive user information* (qui: dati sanitari di **minori**) *«should be submitted by a legal entity […] and not by an individual developer»*. L'account è oggi a nome di persona fisica.
2. **L'account non si rifà, si converte.** Apple: *«If you have enrolled as an individual and need to convert your individual account to an organization account, please contact us.»* Non è un *App Transfer* — che per un'app mai pubblicata **non è nemmeno disponibile**. Restano validi i 99 € già pagati e, secondo fonti secondarie concordi (**da farsi confermare per iscritto**), Team ID, certificato, bundle ID, scheda app e build su TestFlight.
3. **I Termini di servizio non vengono accettati da nessuno**: la casella dell'onboarding copre solo la privacy. La clausola di limitazione di responsabilità della §6 **con ogni probabilità non produce effetto** — e si somma all'art. 1341 c.c. e agli artt. 33-36 del Codice del Consumo.

Registrate inoltre in A3, per il legale: l'informativa dichiara il trattamento **nello SEE** mentre le push transitano da **Google (FCM)** e **Apple (APNs)**, entrambe USA; e l'ente ha **tre sedi** (Cesa, Aversa, Giugliano) sotto un'unica P.IVA, mentre le pagine ne nominano una.

> ⚠️ **Resta** la validazione legale di informativa e termini, e la verifica che `info@kidville.it` sia una casella **realmente presidiata**: è il recapito su cui il revisore Apple chiede chiarimenti e su cui arrivano le richieste GDPR.

**Fase C — Google Play (`docs/submission/C1`…`C5`).** Ricerca chiusa con 11 agenti, 3 dei quali avversariali sui claim che determinano il calendario. **Due dei tre claim di partenza erano sbagliati**, e uno dei due nella direzione che costa di più:

- **Il D-U-N-S vale per entrambi gli store.** Google lo richiede per gli account organizzazione esattamente come Apple, e **il numero è lo stesso**: *«You will not be able to create a developer account for an organization without one»*. La richiesta inviata stasera dallo sportello Apple sblocca due store. ⚠️ Numero unico, **pratiche di verifica distinte** — e mai aprirne una seconda su D&B: i duplicati bloccano la verifica su entrambi.
- **Il gate dei tester non è 20: sono 12**, dall'11 dicembre 2024, e riguarda gli account **personali** creati dopo il 13/11/2023. ⚠️ Ma **l'esenzione delle organizzazioni non è scritta da nessuna parte**: grep di `organi[sz]ation` sulla pagina Google → zero occorrenze. È esenzione **per silenzio, delimitata dall'ambito**. Vanno tenute **2 settimane di riserva** anche con l'account organizzazione.
- 🔴 **Due lavori di prodotto che oggi NON esistono e bloccano la pubblicazione** (`C5`): la **pagina pubblica di cancellazione account** — quella in-app non basta, e `docs/store-submission.md` §3 indicava `/assistenza`, che **non nomina mai la cancellazione** (documento corretto) — e **segnalazione, blocco utente e gate dei Termini non saltabile** richiesti dalla UGC policy, di cui Kidville è l'esempio nominato (gruppo chiuso con registrazione offline). **Non sono moduli da spuntare: è sviluppo.**
- **Il gate dei Termini chiude due problemi trovati per strade opposte**: il requisito UGC di Google e la lacuna E di `A3` (i Termini non li accetta nessuno → la clausola di limitazione di responsabilità è probabilmente inefficace).
- **La categoria è Istruzione, mai «Social»**: la Child Safety Standards policy si applica **per categoria dichiarata, non per pubblico** — *«the presence or absence of child users in your app is irrelevant to this policy»*. Una voce di menu a tendina che vale settimane di lavoro.
- **Il pubblico va dichiarato 18+**, ma la dichiarazione **non è autocertificante**: *«regardless of what you identify in the Google Play Console»*, Google può riclassificare in base a *«youthful animation or young characters in the graphic assets»*. L'app si chiama **Kid**ville e ha una mascotte cartoon: grafica sobria, screenshot dell'interfaccia gestionale, **niente volti di bambini**.
- **La Health apps declaration è obbligatoria** per tutte le app pubblicate, closed testing incluso — e per Kidville la risposta onesta non è «nessuna funzione sanitaria»: allergie, certificati e flag BES/DSA la attivano davvero.
- **Il buco che committa la chiave**: in `android/.gitignore` le regole `*.jks` e `*.keystore` sono **commentate**, e il `.gitignore` di radice non le ha. Un `keytool` nel posto ovvio seguito da `git add` committa la chiave di upload **senza un avviso**.
- **Verde dove conta**: `targetSdk 36` già conforme alla scadenza del 31 agosto 2026, allineamento 16 KB soddisfatto, `allowBackup="false"`, **nessun permesso CAMERA/READ_MEDIA_IMAGES** nel manifest fuso — un vantaggio da proteggere, perché dichiararli aprirebbe la Photo and Video Permissions policy su un'app che gestisce foto di bambini.
- **Sanata la contraddizione** fra `store-submission.md` §3 e `A2` sulla riga «Informazioni di pagamento»: vale A2 — `incassi.metodo` *è* «form of payment», quindi *Payment Info* **più** *Other Financial Info*.

> ⚠️ **Trappola tecnica da non dimenticare**: un `.aab` costruito dopo un `cap sync` senza `CAP_SERVER_URL` **si installa, si apre e mostra una schermata morta**. Il file è gitignorato: il difetto non è visibile in git, né nel gate, né in un build che riesce benissimo.

**✅ D-U-N-S ottenuto — `432360401`**, intestato a *SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA*. **Esisteva già**: D&B lo aveva assegnato d'ufficio all'iscrizione al registro imprese, quindi **attesa zero** invece dei 5-7 giorni lavorativi di Apple o dei fino a 30 giorni dichiarati da Google. Sblocca **entrambi** gli store: il passaggio Apple Individual→Organization e la creazione dell'account Play organizzazione. Resta da confermare la *legal binding authority* (chi è il legale rappresentante).

**✅ Decisione presa sul blocco UGC (`C5`).** Il grafo della chat è stato verificato nel codice, non ipotizzato: il docente scrive solo ai genitori della **sua** sezione, il genitore solo alle maestre della sezione dei **suoi** figli, **genitore↔genitore non esiste**, e in galleria carica solo chi passa `requireDocente`. **In Kidville non esiste UGC fra pari**: lo scenario che la policy di Google ha in mente — lo sconosciuto che molesta — è strutturalmente impossibile. L'unica coppia 1:1 è genitore↔maestra del proprio figlio.

Scelta: **sospensione della conversazione con notifica alla Direzione, dichiarata** (non blocco silenzioso). Il blocco stile social soddisfarebbe Google alla lettera ma produrrebbe una **rottura silenziosa**: la maestra continua a scrivere nel vuoto e nessuno se ne accorge finché non emerge un problema sul bambino. Regge perché **avvisi, circolari, giustifiche e notifiche viaggiano su un canale diverso dalla chat**: sospendere una conversazione non impedisce alla scuola di comunicare. La sospensione è **per conversazione** (`${parent.id}:${student.id}`), non per utente; la notifica passa dal Centro Notifiche esistente; il motivo è testo libero e va **redatto nei log**.

## 🗓️ Changelog — Scheda App Store compilata: 12 screenshot, dati demo, e la classe TEST che era vuota 2026-07-26 (branch `feat/scheda-app-store`)

La scheda dell'app **non è più vuota**. Su App Store Connect ci sono ora: **12 screenshot** (6 iPhone a **1320×2868**, 6 iPad a **2064×2752**, tutti `assetDeliveryState: COMPLETE`), descrizione, keyword, testo promozionale, URL di assistenza, categoria **Istruzione**, classificazione per età compilata, note di review in inglese con l'**account demo**, e la **build `1.0 (1)` agganciata alla versione** — che è un passo a sé: caricare una build non la seleziona.

### Il problema vero non erano gli screenshot: era che l'app non aveva niente dentro

Alla prima cattura, **sei schermate su sei** dicevano «NESSUNA VOCE», «NESSUN AVVISO», «ANCORA NESSUNA NEWS», «Menu non ancora pubblicato», «Saldo ticket esaurito» in rosso e «€ 150,00 scaduti» in rosso sulla home. È il 26 luglio, non c'è scuola, e il diario mostra solo 14 giorni indietro: la classe TEST era legittimamente vuota.

E qui la cosa che conta più della vetrina: **il revisore Apple entra con quello stesso account e vede quella stessa app vuota.** Un'app che a ogni schermata dice «non c'è niente» è precisamente ciò che alimenta la contestazione **4.2 *minimum functionality***. Non era un problema di grafica, era un problema di collaudo.

Sono stati scritti dati fittizi sulla **sola classe TEST Infanzia** (`219cab6a-…`): 50 eventi di diario per i 10 alunni (umore, merenda, attività con partecipazione, pranzo, bagno, con nota della maestra e «nota per te»), il menù della settimana con gli allergeni, 20 ticket mensa a testa, 3 avvisi, 3 news, la retta scaduta saldata e uno storico credibile. **Nessuna riga di alunni, famiglie o classi reali è stata toccata.**

### Due regole che rendono invisibili i dati appena inseriti

Entrambe hanno fatto sembrare rotto ciò che era corretto, e vanno sapute prima di rifare un seed:

- **Il diario ha una finestra di correzione.** Il genitore vede una voce solo trascorsi `buffer_visibilita_min` minuti (default **10**) da `creato_il`: un seed appena scritto è **invisibile per costruzione**. Va retrodatato `creato_il`.
- **Il menù dipende da `mensa_class_menu_assignment`, che in questa scuola è VUOTA.** Senza assegnazione si lavora in modalità «menù unico» e il server filtra `menu_config_id IS NULL`: una riga con quel campo valorizzato viene **esclusa in silenzio**, e la pagina continua a dire «menu non ancora pubblicato».

### Quattro trappole della cattura automatica, tutte con l'aria di funzionare

1. I **deep link `kidville://`** aprono un alert nativo iOS a ogni apertura, e gli alert **si accodano**: senza conferma la navigazione non avviene e ogni cattura successiva è la *stessa identica immagine*.
2. Nel foglio **MENU** i titoli brevi corrispondono anche alla barra inferiore che sta **dietro** l'overlay: una cattura chiamata «diario» conteneva News, una chiamata «avvisi» conteneva Pagamenti. Serve l'etichetta completa (`MENSA Menu e ticket pasto`).
3. **`waitForAnimationToEnd` non aspetta i dati**: una cattura ha colto «Caricamento…».
4. Il pulsante del menu espone l'**aria-label completo**: `MENU` non lo trova, serve `Menu · tutte le sezioni`.

### Un dettaglio dell'API che fa perdere tempo

**`APP_IPHONE_69` non esiste.** Il formato per gli screenshot iPhone 6,9" è **`APP_IPHONE_67`**; per l'iPad 13" è `APP_IPAD_PRO_3GEN_129`. L'API risponde `409` elencando tutti i valori validi, ed è il modo più rapido per scoprirli. Il caricamento è in **tre passi** (prenota → `PUT` dei byte → `PATCH uploaded:true` con checksum MD5): saltarne uno lascia una voce fantasma che l'interfaccia mostra vuota senza spiegare perché.

### Password degli account TEST

Su decisione esplicita del titolare la password comune dei **41 account `test.*`** è stata riportata a un valore facile da ricordare, **inclusi i tre account che leggono l'anagrafica reale della sede** (`test.segreteria`, `test.pri.segreteria`, `test.cuoca`). Il rischio è stato illustrato e accettato; resta valida la voce aperta in `docs/store-submission.md` §1: dare all'account demo una **password dedicata**, così ruotarla dopo la review non rompe nient'altro. Gli account `*.e2e` non sono stati toccati.

- **Gate** verde: eslint 0 · tsc 0 · vitest 365 file / 3041 test · build ok.

> ✅ **La scheda App Store è compilata e gli screenshot sono caricati.** Restano fuori solo le voci che richiedono una persona: DSA, validazione legale, App Privacy labels, e le due prove col telefono in mano.

> ⚠️ **Resta prima della submission:** lo **stato di operatore commerciale DSA** (bloccante); le **App Privacy labels** (con la decisione aperta sui dati sanitari); la **validazione legale** di informativa e termini; la **prova che una push arrivi in ambiente `production`** e l'**offline in modalità aereo**, entrambe da fare con un **iPhone fisico** e la build TestFlight; e tutta la **scheda Google Play** (descrizione, screenshot, modulo «Sicurezza dei dati», accesso all'app).

## 🗓️ Changelog — La build è su TestFlight: scheda app, upload, e la trappola «Missing Compliance» 2026-07-26 (branch `fix/conformita-export-ios`)

La build **è su App Store Connect**. Nell'ordine: creata la scheda app (`Kidville`, Apple ID **`6794883055`**), validato il pacchetto (**`VERIFY SUCCEEDED with no errors`**), caricato (**`UPLOAD SUCCEEDED`**, 5.027.386 byte in 3,0s, Delivery UUID `c912710a-…`), elaborato da Apple in circa due minuti e mezzo → **`processingState: VALID`**. Creato il gruppo TestFlight interno `Interni` con il titolare come tester.

### La trappola: una build valida che non arriva a nessuno, e nessun errore

Appena caricata, la build era `VALID` — e **non distribuibile**. Il motivo sta in un campo che nessuno guarda: **`usesNonExemptEncryption: null`**, cioè lo stato *«Missing Compliance»*. Né TestFlight né la revisione la vedono, e **l'upload non dà un solo errore**: riesce, la build risulta valida, e semplicemente non raggiunge nessuno. È lo stesso schema del `loggingBehavior` e delle email a `403`: **niente è rosso e niente funziona.**

Si sblocca rispondendo alla domanda sulla crittografia, e ora la risposta è **cablata nel sorgente** invece di essere ripetuta a mano a ogni build: `ios/App/App/Info.plist` → **`ITSAppUsesNonExemptEncryption = false`**, con un lock in `__tests__/architecture/native-privacy-lock.test.ts` (due test: la chiave esiste e vale `false`; e non è `true`, che farebbe scattare la richiesta dei documenti di esportazione bloccando la pubblicazione a tempo indefinito). **Prova di validità eseguita**: rimossa la chiave, il lock diventa rosso; ripristinata, torna verde.

**La dichiarazione `false` è verificata sul codice, non supposta**: nessuna cifratura applicativa in `src/`, `supabase/`, `scripts/` — zero `createCipheriv`, zero `crypto.subtle.encrypt`, nessuna dipendenza crittografica (né `crypto-js`, né `node-forge`, né `jose`, né `bcrypt`); ci sono solo `createHash('sha256')`, `timingSafeEqual` e `randomBytes`, cioè hashing, confronti e casualità. Il traffico è HTTPS/TLS fornito dal sistema, la biometria passa dal plugin di piattaforma: entrambi esenti. Se un domani l'app cifrasse dati per conto proprio, **la dichiarazione va rifatta**.

### Due cose da sapere per la prossima volta

- **La scheda app non si crea via API.** `POST /v1/apps` non esiste: si passa da *Apps → + → New App*. E nel menu «ID pacchetto» la voce da scegliere si chiama **`XC it kidville app - it.kidville.app`**, che è il nome dato da Xcode all'identificativo — non «Kidville».
- **I moduli di App Store Connect sono React controllati.** Impostare il valore di un `<select>` dal DOM non basta: il campo mostra ancora «Scegli» e la validazione lo segna come vuoto **pur avendo il valore dentro**. Va usato il setter nativo di `HTMLSelectElement` più gli eventi `input`/`change`.

### Un nuovo bloccante, e non è tecnico

App Store Connect avvisa che **manca lo stato di operatore commerciale (DSA)**: *«gli sviluppatori devono fornire il loro stato di operatore commerciale per inviare nuove app […] altrimenti le tue app verranno rimosse dall'App Store nell'UE»*. Non ha impedito il caricamento, **impedisce l'invio in revisione**, e riguarda proprio il mercato in cui l'app deve funzionare. Si compila in *Azienda* → conformità DSA e **non è lavoro da agente**: sono dichiarazioni legali sull'identità del titolare del conto.

- **Gate** verde: eslint 0 · tsc 0 · vitest 365 file / 3041 test · build ok.

> ✅ **La build è installabile da TestFlight.** Scheda app creata, pacchetto validato e caricato, elaborazione riuscita, conformità all'esportazione dichiarata e ora cablata nel sorgente con lock.

> ⚠️ **Resta prima della submission:** lo **stato di operatore commerciale DSA** (nuovo bloccante); la **prova che una push arrivi in ambiente `production`** e l'**offline in modalità aereo**, entrambe da fare con un **iPhone fisico** e la build TestFlight installata; la **validazione legale** di informativa e termini; le **App Privacy labels** e le note di review; la **scelta iPad** (screenshot o solo-iPhone) e gli **screenshot**. Invariate le decisioni fuori dallo store: **GitHub Pro** o gate solo disciplinare, e i **3 alunni orfani** in produzione.

## 🗓️ Changelog — Firma di distribuzione iOS: il pacchetto per l'App Store si produce (`aps-environment = production`) 2026-07-26 (branch `feat/firma-distribuzione-ios`)

Il changelog precedente dichiarava **bloccata a monte** la submission: «sulla macchina non esiste un certificato di distribuzione Apple». Quel blocco **non c'è più**. L'`.ipa` per l'App Store è stato **prodotto**, è firmato **`Apple Distribution: luigi errico (B5ULCGG2V3)`**, e porta **`aps-environment = production`** — la verifica che la catena delle push native aspettava da due changelog.

### Come si è sbloccato — e perché era stato diagnosticato male

Il certificato di distribuzione **esiste** (emesso il **2026-07-26 alle 14:19:23 GMT**, cioè dieci minuti prima che questa sessione lanciasse il primo comando: non è stato creato da un agente). Il punto interessante è **perché la diagnosi precedente aveva concluso il contrario**, perché è un errore che si può ripetere:

> Il certificato è **cloud managed** — gestito da Apple, non un file `.p12` in un keychain locale. E **`security find-identity -v -p codesigning` non lo mostra, nemmeno quando c'è e funziona**: continua a rispondere «1 valid identity found», elencando solo `Apple Development`. Nemmeno `security find-certificate -a -c "Apple Distribution"` lo trova.

L'assenza da quell'elenco **non è la prova che il certificato manchi**. La prova è l'export: se `xcodebuild -exportArchive` con `method: app-store-connect` riesce, il certificato c'è. Il collaudo precedente si era fermato a `find-identity`, e aveva letto come «manca il certificato» quello che era invece «il certificato è invisibile a questo comando».

Mancava però davvero una cosa: il **provisioning profile *App Store*** per `it.kidville.app`. Lo crea Xcode al volo, ma **solo** se glielo si consente — ed è tutta qui la differenza fra l'export che falliva e quello che riesce:

- `xcodebuild archive` **`-allowProvisioningUpdates`** → `ARCHIVE SUCCEEDED`
- `xcodebuild -exportArchive` … **`-allowProvisioningUpdates`** → `EXPORT SUCCEEDED`

Il profilo generato è **`iOS Team Store Provisioning Profile: it.kidville.app`** (`IsXcodeManaged = true`, creato dall'export stesso).

### La prova, misurata sull'artefatto

Sull'app estratta dall'`.ipa`, non sull'Archive:

- **`aps-environment = production`** (era `development`) · **`get-task-allow = false`** (era `true`) · **`beta-reports-active = true`** (TestFlight abilitato) · `application-identifier = B5ULCGG2V3.it.kidville.app`;
- catena di firma: **`Apple Distribution: luigi errico (B5ULCGG2V3)`** → *Apple Worldwide Developer Relations CA* → *Apple Root CA*.

### Due trappole da non ripagare

- **L'app dentro l'`.xcarchive` resta firmata in sviluppo, ed è corretto.** Anche con `-allowProvisioningUpdates`, l'Archive porta `aps-environment = development` e `get-task-allow = true`: è l'**export** a rifirmare in distribuzione. Controllare gli entitlement dell'Archive non dice nulla di utile — **vanno letti sull'`.ipa`**. Anche il sorgente `ios/App/App/App.entitlements` dice `development` e **va lasciato così**.
- **Scadenza a un anno, non a tre.** Certificato e profilo scadono entrambi il **2027-07-26**: è la durata dei certificati *cloud managed*. Da rinnovare prima, o non si firma più nulla per lo store.

Nota per una futura CI: non esiste un `.p12` da salvare (Xcode recupera il certificato dall'account su qualunque macchina autenticata sul team), ma **una pipeline senza sessione Xcode autenticata non firma**. Servirebbe una **App Store Connect API key**, che sulla macchina **non c'è**: cercata in `~/.appstoreconnect/private_keys/`, `~/private_keys/`, fastlane e variabili `ASC_*`; l'unico `.p8` presente è la chiave **APNs** `G2XN848ZNY`, che serve alle push e **non** autentica l'API di App Store Connect.

### Cosa resta su questo fronte

L'`.ipa` è firmato per la produzione, ma **non è ancora stato caricato** — e quindi la push in ambiente `production` è oggi **plausibile, non dimostrata**: la prova richiede una build installata da **TestFlight** su un device fisico. Per caricarla serve una credenziale che ancora non esiste: **App Store Connect API key** (*Users and Access → Integrations*), oppure una **password specifica per l'app** con `xcrun altool`, oppure l'**Organizer di Xcode** a mano.

- Dettaglio completo, comandi e `exportOptions.plist` in **`docs/store-submission.md` §5** (la sezione era marcata 🔴 bloccante: ora è ✅).
- **Gate** verde: eslint 0 · tsc 0 · vitest 365 file / 3039 test · build ok.

> ✅ **Il bloccante numero uno della submission è chiuso**: il pacchetto per l'App Store si produce, firmato in distribuzione, con `aps-environment = production` verificato sull'artefatto.

> ⚠️ **Resta prima della submission:** il **caricamento** della build su App Store Connect (serve una credenziale da creare) e con esso la **prova che una push arrivi** su un device di produzione; la **validazione legale** di informativa e termini; l'**account demo** e le **App Privacy labels**; la **scelta iPad** (screenshot o solo-iPhone); la **prova offline su iPhone fisico in modalità aereo**. Invariate le due decisioni del titolare fuori dallo store: **GitHub Pro** o gate solo disciplinare, e cosa fare dei **3 alunni orfani** in produzione.

## 🗓️ Changelog — Repository privato, password ruotata, e le verifiche iOS che mancavano 2026-07-26 (branch `fix/chiusura-pendenze`)

Questa voce chiude le pendenze rimaste aperte dai due changelog precedenti, e ne apre una sola — ma è quella che oggi **blocca davvero** la submission all'App Store. Il repository è diventato **privato**, la password degli account TEST è stata **ruotata**, e le verifiche iOS che il collaudo precedente aveva lasciato «da provare» sono state **fatte sul simulatore**: Face ID dall'inizio alla fine, gli embed dentro `WKAppBoundDomains`, e la resa dell'app su iPad. In compenso, il tentativo di produrre un pacchetto per lo store si è fermato al primo passo: **sulla macchina non esiste un certificato di distribuzione Apple**, e senza quello non si esporta niente e non si verifica niente.

### Il repository è privato — e con GitHub Free la protezione di `main` non esiste più

Il repository è stato reso **privato**. Era la cosa giusta da fare — fino a oggi conteneva in chiaro la password di account attivi in produzione — ma porta con sé una conseguenza che va scritta, non lasciata implicita: **su GitHub Free le branch protection rules non valgono sui repository privati**. L'API risponde `403` con «Upgrade to GitHub Pro», e la protezione che `main` aveva **non è più attiva**.

- Cosa c'era e non c'è più: check obbligatori **`Lint · Typecheck · Unit`** ed **`E2E (Playwright)`**, con `strict: true` (cioè: il branch doveva essere aggiornato rispetto a `main` prima del merge).
- **La CI continua a girare** su ogni push e su ogni PR, e continua a dire la verità. Quello che è sparito è l'**imposizione**: oggi niente impedisce *tecnicamente* un push diretto su `main` con i check rossi.
- Le opzioni sono due, ed è una decisione del titolare: **GitHub Pro** (che rimette le regole sui repository privati), oppure accettare che il gate resti quello che è sempre stato nella pratica — la **disciplina di `AGENTS.md`** più l'**hook locale** `.claude/hooks/verify_gate.sh`, che rigira eslint · tsc · vitest · build a ogni tentativo di chiudere un ciclo.

### Password degli account TEST — ruotata e verificata

La rotazione è **fatta**: nuova password accettata, vecchia respinta, su tutti e **41 gli account `test.*@kidville.test`**. Gli account **`*.e2e@kidville.test` non sono stati toccati**: li crea il seed della CI su un progetto Supabase usa-e-getta, spostarli romperebbe l'E2E finché non esiste il secret corrispondente. Il dettaglio completo — cosa era esposto, cosa resta nella storia git, cosa deve decidere il titolare — sta in **`docs/store-submission.md` §1**.

### Le verifiche iOS che mancavano — simulatore iPhone 17 Pro (iOS 26.2), build pulita

Il changelog precedente si fermava a «Face ID **riconosciuto**»: lo switch compariva, e questo dimostrava soltanto che `checkBiometry()` non rispondeva più «non disponibile». Ora il percorso è stato **percorso tutto**, e vale come **controprova su iOS del bloccante corretto su Android** (il loop infinito del prompt biometrico):

- **Attivazione**: tap sullo switch in **`/parent/profilo`** → compare il **prompt Face ID nativo** → match simulato (`notifyutil -p com.apple.BiometricKit_Sim.pearl.match`) → **lo switch resta attivato**.
- **Sblocco**: riavvio dell'app → **il gate biometrico compare** → un match **sblocca** → l'app è usabile.
- **Nessun loop**: dopo lo sblocco, **per 15 secondi non riparte alcun prompt**. È esattamente il sintomo che su Android chiudeva l'utente fuori dall'app, e su iOS non si presenta.
- **`WKAppBoundDomains` non ha rotto gli embed**: verificato con una news di collaudo temporanea (creata e **cancellata** a fine prova) — **YouTube**, **Vimeo** e **Instagram** caricano tutti dentro la WebView. Era il rischio implicito di quella chiave: dieci slot, sette occupati, e un embed fuori elenco diventa un riquadro nero che si scopre solo su un telefono.
- Nota di metodo per i collaudi futuri: il **deep link `kidville://parent/<rotta>`** funziona sul simulatore ed è **il modo più affidabile di navigare** durante una prova — non dipende dal tap su una coordinata né dal fatto che una schermata sia già stata renderizzata.

### iPad — l'app si vede bene, anche se non è ottimizzata per iPad

Provata sul simulatore **iPad Pro 13" (M5)**, che produce screenshot a **2064×2752** — esattamente la risoluzione che App Store Connect richiede per la classe iPad 13". Login e dashboard genitore verificati:

- la UI è **centrata in colonna, non stirata**: sfondo crema uniforme, topbar a tutta larghezza, bottom nav centrata;
- **non è «ottimizzata» per iPad**: niente split view, niente colonne multiple, nessun uso dello spazio orizzontale in più;
- ma **non è rotta**, e la resa è dignitosa. Il rischio sulla **linea guida 4.2** resta **moderato**, non trascurabile e non grave.

La decisione registrata in `docs/store-submission.md` §4 — **produrre gli screenshot iPad** *oppure* dichiarare l'app **solo-iPhone** (`TARGETED_DEVICE_FAMILY = "1"`) — **resta aperta**. Cambia però di natura: prima era una scommessa al buio su come si vedesse l'app, adesso è una **scelta informata**.

### 🔴 ~~Il blocco vero alla submission: manca il certificato di distribuzione~~ — SUPERATO

> ⚠️ **Questa diagnosi era sbagliata**, e il changelog del 2026-07-26 «Firma di distribuzione iOS» (in cima) la corregge: il certificato **c'era**, ma è *cloud managed* e **`security find-identity` non lo mostra**. Mancava solo il provisioning profile *App Store*, che Xcode crea con **`-allowProvisioningUpdates`**. L'`.ipa` è stato prodotto con `aps-environment = production`. Il testo che segue resta per memoria del percorso.

È stato eseguito un **Archive vero** (`xcodebuild archive -configuration Release`), ed è **riuscito**. È lì che si è fermato tutto:

- nell'Archive **`aps-environment` risulta `development`** (insieme a `get-task-allow`), perché la firma automatica ha usato il profilo di **sviluppo** — l'unico disponibile;
- l'**export per l'App Store** (`xcodebuild -exportArchive` con `method: app-store-connect`) **FALLISCE**: *«No signing certificate "iOS Distribution" found»* e *«No profiles for 'it.kidville.app' were found»*;
- sulla macchina c'è **una sola identità di firma**: `Apple Development: lerrico7@icloud.com`.

**La conseguenza è netta.** Finché non esiste un certificato **Apple Distribution** e il relativo **provisioning profile** per `it.kidville.app`, **non si può esportare per l'App Store** e **non si può verificare che `aps-environment` diventi `production`** — quindi non si può nemmeno accertare che **le push funzionino in produzione**, che è la verifica lasciata aperta dal changelog precedente. Non è un adempimento di fine corsa da sbrigare il giorno dell'invio: è il **primo** passo pratico della submission, e tutto il resto della catena (build firmata, upload, TestFlight, review) ci passa attraverso. Si crea da **Xcode → Settings → Accounts → Manage Certificates → + → Apple Distribution**, oppure dal portale Apple Developer. **Non è lavoro da agente**: richiede le credenziali dell'account sviluppatore del titolare.

### Zero `console.*` in `src/` e password fuori dal repo (già in `073e9c8`)

Le **soppressioni ESLint sono passate da 94 a 51, poi a 35, e ora a 0**: `eslint-suppressions.json` **non esiste più**, e il lock è diventato **doppio** — guarda il sorgente *e* l'assenza del file — perché `eslint --suppress-all` da solo si lascia zittire, ricreando il file e riportando il verde senza toccare una riga di codice. In parallelo, la password degli account TEST è **fuori da tutti i file committati**: gli script la leggono da **`KV_TEST_PASSWORD`** e falliscono subito se manca.

### Un rilievo aperto sui dati in produzione — da decidere, non da eseguire

In produzione ci sono **3 alunni senza sezione** e con **zero presenze** (id `a4e1fa70-…`, `64160569-…`, `a6220363-…`): due hanno un genitore collegato, uno ha il codice fiscale valorizzato, e **nessuno dei tre è riconducibile ai seed** di collaudo. Sembrano **iscrizioni o prove incomplete**. **Non sono stati cancellati**, di proposito: sono anagrafiche **potenzialmente reali** — e potenzialmente di minori — e la cancellazione è irreversibile. La decisione spetta al titolare, che è l'unico a poter dire se quei tre nomi corrispondono a qualcuno.

- **Gate** verde: eslint 0 · tsc 0 · vitest 365 file / 3039 test · build ok.

> ✅ **Repository privato, password ruotata, e le tre verifiche iOS rimaste in sospeso ora sono chiuse**: Face ID dall'attivazione allo sblocco senza loop, embed funzionanti con `WKAppBoundDomains`, resa su iPad vista e accettabile.

> ⚠️ **Resta prima della submission:** il **certificato Apple Distribution** (bloccante, primo passo — senza non si esporta né si verifica `aps-environment = production`); la **validazione legale** di informativa e termini; l'**account demo** e le **App Privacy labels** in App Store Connect; la **scelta iPad** (screenshot o solo-iPhone); la **prova offline su iPhone fisico in modalità aereo**. E due decisioni del titolare fuori dallo store: **GitHub Pro** o gate solo disciplinare, e cosa fare dei **3 alunni orfani** in produzione.

## 🗓️ Changelog — Offline dimostrato sul device: il Service Worker funziona, il vicolo cieco no 2026-07-26 (branch `fix/offline-device-store`)

Il collaudo del 2026-07-25 aveva concluso che a freddo, senza rete, rispondeva il **ripiego nativo** (`mobile/www/offline.html`) invece della pagina `/offline` del Service Worker. La misura diretta sulla WebView dice l'opposto: **il Service Worker funziona**, e quel ripiego compariva perché l'app era stata **appena installata** — senza un SW già registrato non c'è nulla da servire. La diagnosi era sbagliata, ma sotto c'era un difetto vero e più fastidioso: la pagina offline **prometteva** pagine consultabili e non offriva alcun modo di raggiungerle. Per il genitore la differenza è tutta qui: prima, senza rete, l'app diceva «le pagine che hai già aperto restano consultabili» e poi lo lasciava a premere «Riprova» all'infinito; adesso gliele **elenca** e ce lo porta.

### Android — misurato sulla WebView via Chrome DevTools Protocol (emulatore, build su `https://app.kidville.it`)

- **Il Service Worker si registra, si attiva e controlla il documento** dentro la WebView (`controller` presente, stato `activated`): non è una funzione da solo-browser.
- **Intercetta le navigazioni di main frame.** Dopo un giro nell'app la cache `kidville-shell-v2` conteneva `/auth/login`, `/parent`, `/parent/avvisi` e `/parent/diary` oltre a `/offline` precachata, più gli asset statici.
- **A freddo, senza rete e con il SW installato, vince il Service Worker**: compare `/offline` sull'origine `https://app.kidville.it`, **non** il ripiego nativo. È anche il modo più rapido di capire cosa si sta guardando: origine `localhost` = `errorPath`, origine dell'app = Service Worker.
- **Le pagine già visitate sono davvero consultabili offline**: `/parent/avvisi` si apre dai dati Dexie con la pill «Dati non aggiornati — offline».
- Il ripiego nativo `https://localhost/offline.html` compare **solo** quando il SW non esiste ancora — prima installazione o dati cancellati: riprodotto con `pm clear`. È il comportamento voluto, non un guasto.
- Un **404 di main frame non dirotta** al ripiego nativo: mostra la pagina 404 dell'app.

### Il vicolo cieco della pagina offline — il difetto vero

La pagina `/offline` prometteva «le pagine che hai già aperto restano consultabili», ma l'unico link era «Riprova» con `href="/"`, e la root **non è mai in cache** (risponde 307 e `public/sw.js` la lascia passare senza salvarla). Misurato: «Riprova» → `/` → di nuovo la pagina offline → **loop**. Una promessa che l'interfaccia non permette di mantenere è un difetto, non un dettaglio di copy.

- **`src/app/offline/page.tsx`** + nuovo **`src/app/offline/script-offline.ts`**: la pagina ora **elenca le pagine davvero disponibili offline**, leggendole dalla CacheStorage, con etichette tradotte. Se in cache non c'è nulla, la sezione resta nascosta **e il paragrafo che prometteva sparisce**: senza cache non si promette niente.
- **«Riprova» non naviga più alla cieca**: **sonda la rete** e prosegue solo se risponde, altrimenti mostra «Ancora nessuna connessione» **senza far sparire l'elenco**. La sonda è una `HEAD` su `/offline`, e la scelta è tecnica: `public/sw.js` esce subito sulle richieste non-GET, quindi la sonda **misura la rete e non la cache** — una GET avrebbe letto la copia salvata, avrebbe detto «c'è rete» e avrebbe rimesso l'utente nel loop da cui la pagina lo sta tirando fuori.
- **`mobile/www/offline.html`**: stesso criterio per il ripiego nativo, che prima faceva `location.href` alla cieca. Nota tecnica: lì la sonda è **cross-origin senza CORS**, quindi la risposta è **opaca** (`ok:false`, `status:0`) e un `if (res.ok)` non navigherebbe **mai** — vale come «raggiungibile» il fatto stesso che la promise si risolva.
- **`messages/{it,en}/offline.json`**: chiavi nuove, incluse le **etichette leggibili delle rotte** (l'elenco è bilingue come il resto della pagina).

### La correzione che non arrivava a nessuno — due difetti indipendenti, uno sopra l'altro

La riscrittura della pagina `/offline` è andata in produzione con il gate verde, 21 test nuovi verdi e il deploy riuscito. Poi è stata provata **sul device**, ed era **inefficace per due motivi distinti**, ciascuno sufficiente da solo ad annullarla: (1) la copia precachata non si aggiornava, perché `public/sw.js` non era cambiato; (2) anche con la pagina nuova, **l'idratazione di React cancellava il lavoro dello script inline**. Il primo si vedeva solo confrontando rete e CacheStorage, il secondo solo guardando il DOM nel tempo. Nessuno dei due era visibile ai test — ora entrambi hanno il proprio lock.

#### 1. La copia precachata non si aggiorna senza bump di `VERSIONE`

La misura sull'emulatore Android **contro la produzione appena rilasciata**: `https://app.kidville.it/offline` serviva la pagina **nuova** (267.987 byte, con `data-kv-elenco` e `data-kv-riprova`), ma la voce `/offline` nella **CacheStorage del dispositivo** era ancora la **vecchia** (252.415 byte, senza nessuno dei due). La correzione non stava raggiungendo **nessuno** di quelli che avevano già usato l'app — cioè tutti quelli per cui era stata scritta.

**Causa radice**: `precarica()` gira solo in `install` e `activate`, e quei due eventi scattano solo quando il browser si accorge che **i byte di `public/sw.js`** sono cambiati. Il confronto è sul file del Service Worker, non sulle pagine che quel Service Worker mette in cache: la PR non aveva toccato `sw.js`, quindi nessuna reinstallazione, nessun `activate`, copia precachata vecchia **a tempo indeterminato**. Nessun test poteva vederlo, perché non c'era niente di sbagliato nel codice — mancava solo il segnale di aggiornamento. È il tipo di difetto che si vede **solo sul device, e solo dopo il deploy**.

- **`public/sw.js`**: `VERSIONE` passa da `v2` a `v3`. Cambia i byte del file (il browser reinstalla) e cambia `CACHE_SHELL` (`activate` cancella la cache precedente e `precarica()` riscarica `/offline`). Da ora la cache dello shell si chiama **`kidville-shell-v3`**.
- **Nuovo lock `__tests__/architecture/sw-versione-offline.test.ts`**: calcola lo **sha256 dei quattro file** che compongono il documento `/offline` (`page.tsx`, `script-offline.ts`, `messages/{it,en}/offline.json`) e lo confronta con l'impronta dichiarata **nella riga subito sotto `VERSIONE`**, dentro `public/sw.js`. Se qualcuno tocca la pagina senza passare di lì, il gate diventa rosso e **spiega cosa fare e perché**.
- L'impronta sta in `sw.js` e non nel test **di proposito**: tenerla nel test si potrebbe aggiornare senza mai aprire `sw.js`, cioè commettendo esattamente il difetto che il lock deve impedire. Lì invece per rimettere il verde bisogna aprire il file, e `VERSIONE` è la riga immediatamente sopra. In più, aggiornare l'impronta **cambia da sé i byte di `sw.js`** — che è precisamente il segnale che mancava.
- Il caso «activate cancella le cache vecchie» in `__tests__/offline/sw.test.ts` non cabla più `v1`/`v2`: **legge la versione corrente dal sorgente**, così continua a dimostrare la cancellazione a ogni bump futuro invece di diventare rosso per conto suo. Accanto, un caso nuovo dimostra che dopo il bump `activate` **butta la copia vecchia di `/offline` e riscarica quella nuova**.

#### 2. L'idratazione di React annullava lo script inline

Tracciata la pagina in produzione con un `MutationObserver` installato **prima** del caricamento del documento (CDP `Page.addScriptToEvaluateOnNewDocument`):

```
t=  33ms  DOMContentLoaded   elenco nascosto, 0 voci
t= 134ms  mutazione          elenco visibile, 2 voci   ← lo script inline funziona
t= 151ms  load               elenco visibile, 2 voci
t= 500ms  tick               elenco nascosto, 0 voci   ← annullato
t=1000…8500ms                elenco nascosto, 0 voci   (resta annullato)
```

Lo script inline trovava `/auth/login` e `/parent` in cache e disegnava l'elenco; poi React idratava, trovava un DOM diverso da quello reso dal server e lo riportava allo stato del server. Al genitore restava l'elenco nascosto **e** il paragrafo «su questo dispositivo non c'è ancora nessuna pagina salvata da consultare» — la variante sbagliata, perché le pagine c'erano. **La regola generale, che vale ben oltre questa pagina: su un documento che React idrata, chi scrive nel DOM da fuori perde.** I 21 test non potevano vederlo perché eseguono lo script su markup statico in un contesto `vm`: niente React, niente idratazione.

- **Nuovo `src/app/offline/ContenutoOffline.tsx`** (`'use client'`): elenco e lingua diventano **stato di React**. Il primo render è identico byte per byte a quello del server (lingua `it`, elenco vuoto), così l'idratazione combacia; subito dopo un effetto rilegge la CacheStorage, e la lingua si legge con `useSyncExternalStore` (snapshot server `it`, snapshot client dal cookie `KV_LOCALE`). `/offline` **resta statica**: la build la riporta ancora come `○ (Static)`.
- **Lo script inline resta**, e non è ridondanza: quando l'app è appena installata e non c'è rete, il Service Worker ha in cache il **documento** `/offline` ma non i chunk di Next (`precarica()` salva la pagina, non il suo bundle). Lì React non idrata affatto e l'unico codice che gira è quello inline. Copre il pre-idratazione e il senza-bundle; il componente client copre tutto il resto.
- **Anche la lingua era esposta allo stesso difetto** (`SCRIPT_LINGUA` mostra e nasconde i blocchi `data-kv-lang` toccando `hidden` da fuori). Misurato: con il codice vecchio sopravviveva, ma solo perché React non riconcilia gli attributi dei nodi che non ricostruisce — un dettaglio non contrattuale, cioè una garanzia che non esiste. Ora la lingua è stato di React, quindi il comportamento è deterministico, e c'è il test che lo dimostra.
- **Nuovo `__tests__/offline/idratazione-offline.test.tsx`**: idrata **davvero** con `hydrateRoot` su jsdom e verifica che dopo l'idratazione l'elenco sia ancora lì, che il paragrafo mostrato sia quello giusto e che la lingua scelta regga. Un caso ricostruisce l'intera sequenza del device: lo script disegna, React idrata, l'elenco resta.
- **Nuovo `__tests__/offline/equivalenza-offline.test.ts`**: due implementazioni (ES5 inline e TS) sullo stesso ingresso devono dare lo **stesso** elenco, in entrambe le lingue, su 8 casi (filtri, duplicati, ordine, query, escape malformata, path ostile). Il rischio di avere due strade non è che esistano — servono entrambe — ma che divergano in silenzio.

### iOS — simulatore iPhone 17 Pro (iOS 26.2), build pulita

- **Face ID riconosciuto**: lo switch «Attiva lo sblocco biometrico» **compare** in `/parent/profilo`, e compare solo se `checkBiometry()` riporta la biometria disponibile. La correzione del 25 luglio (`NSFaceIDUsageDescription`) regge sul dispositivo.
- **`WKAppBoundDomains` non ha rotto gli embed**: verificati in una news di collaudo temporanea (creata e **cancellata** a fine prova) — **YouTube** (`youtube-nocookie.com`), **Vimeo** e **Instagram** caricano tutti dentro la WebView.
- Il **Service Worker è registrato** (`scopeURL` `/`, `scriptURL` `/sw.js`) e la **CacheStorage è popolata**: `cacheslist` riporta `kidville-shell-v2` con circa 70 record.
- ⚠️ **Il comportamento offline vero e proprio su iOS non è stato dimostrato**: il simulatore condivide la rete del Mac e il **Network Link Conditioner non esiste sul simulatore**. Le precondizioni sono tutte verificate, ma la prova va chiusa su **iPhone fisico in modalità aereo**.

### Un errore di metodo corretto, che valeva per ogni collaudo futuro

La prova forense della CacheStorage su iOS puntava a `…/data/Containers/Data/Application/*/Library/Caches/it.kidville.app/WebKit/CacheStorage`, che su **iOS 26 contiene solo `salt`** anche quando il Service Worker sta lavorando. Il percorso reale è `…/Library/WebKit/it.kidville.app/WebsiteData/Default/<hash>/<hash>/CacheStorage`. Con il percorso vecchio si sarebbe concluso — **sbagliando** — che su iOS l'offline non funziona. Il percorso giusto, i selettori Maestro per piattaforma e il metodo di ispezione della WebView sono ora in **`docs/mobile.md`**.

### Privacy manifest, log e lock

- **`ios/App/App/PrivacyInfo.xcprivacy`**: `NSPrivacyCollectedDataTypes` non è più **vuoto** — 8 categorie (nome, email, telefono, foto, dati di pagamento, ID utente, crash e diagnostica), tutte `Linked` e **nessuna** per tracciamento; aggiunte le API types `FileTimestamp`, `DiskSpace` e `SystemBootTime` accanto a `UserDefaults`. Un manifest vuoto su un'app che tratta dati di minori non è una svista formale: è la dichiarazione che non si raccoglie nulla, ed è un rischio concreto di rigetto in review.
- **16 `console.*` lato server bonificati** e portati su `logErrore`/`logEvento`: finivano nei **Runtime Logs di Vercel non redatti**, e alcuni interpolavano identificativi in chiaro dentro il messaggio (`src/lib/anagrafiche/parents.ts`, `src/lib/primaria/fascicolo-rbac.ts` sul percorso del fascicolo BES/DSA). Il tetto del lock `__tests__/architecture/console-suppressions.test.ts` **scende da 51 a 35**, e il lock ora legge anche il **sorgente** dei 12 moduli bonificati: rigenerare le soppressioni non basta più a farle ricomparire.
- **`__tests__/architecture/native-privacy-lock.test.ts`** blinda ora **tutti e 7** i domini di `WKAppBoundDomains` (prima ne verificava 2: togliere `vimeo.com` non faceva fallire nulla) e il contenuto del privacy manifest. Una voce tolta lì non si vede in review, si scopre su un telefono con un embed nero, e si ripara solo con un aggiornamento sullo store.
- **Nuovo `docs/store-submission.md`**: account demo per il revisore, note di review, mappa delle App Privacy labels dato per dato, screenshot per classe di device (**iPad compreso**, l'app è universale) e checklist di submission.
- **Gate** verde: eslint 0 · tsc 0 · vitest 363 file / 3029 test · build ok.

> ✅ **L'offline è dimostrato su Android, non più solo implementato**, e il vicolo cieco della pagina offline è chiuso. Su iOS sono verificate tutte le precondizioni (Face ID, embed con `WKAppBoundDomains`, SW registrato, cache popolata).

> ⚠️ **Resta prima della submission:** la **validazione legale** di informativa e termini; l'**account demo** e le **App Privacy labels** da compilare in App Store Connect; la verifica che `aps-environment` risulti **`production`** nell'export dell'Archive; e la **prova offline su iPhone fisico in modalità aereo** — sul simulatore non è dimostrabile.

## 🗓️ Changelog — Recapito di supporto: casella ordinaria al posto della PEC 2026-07-26 (branch `fix/email-supporto`)

Le tre pagine legali riportavano una **PEC** come unico recapito. Come contatto del Titolare era corretto, ma come recapito di **supporto** no: quasi tutti i gestori PEC rifiutano la posta ordinaria, quindi un genitore che scrive da Gmail — e il revisore Apple, che usa `/assistenza` come Support URL — avrebbe ricevuto un errore di consegna. Un recapito che rimbalza è peggio di nessun recapito, perché sembra funzionare.

- **`lerrico7@gmail.com`** sostituisce la PEC in `/privacy` (3 punti), `/termini` e `/assistenza`. Recapito unico per tutte e tre.
- **Nuovo lock** `__tests__/architecture/pagine-legali.test.ts`: niente segnaposto, nessuna PEC come recapito, stesso indirizzo sulle tre pagine, il Titolare resta identificato, le sezioni «Dati conservati sul dispositivo» e «Sblocco con impronta o volto» non spariscono, e le tre rotte restano in `PUBLIC_PREFIXES`. Queste pagine erano già andate in produzione **coi segnaposto dentro**, senza che nessun test le guardasse.
- **Gate** verde: eslint 0 · tsc 0 · vitest 358 file / 2967 test · build ok.

> ⚠️ **Resta** la validazione legale di informativa e termini.

## 🗓️ Changelog — Correzione dei difetti del collaudo native: biometria, offline, privacy nei log, pagine legali 2026-07-25 (branch `fix/collaudo-native-fase2`)

Le Fasi 2 e 3 sono andate in produzione col gate verde — eslint 0, tsc 0, 2859 test, build ok — e poi l'app è stata provata **sui telefoni**: 5 simulatori iOS e 2 emulatori Android. Sono usciti 6 difetti bloccanti e 9 minori, **nessuno dei quali era visibile ai test**: vivono tutti nel confine fra la WebView e il sistema operativo, dove jsdom non arriva. Due chiudevano l'utente fuori dall'app (si usciva solo col force-stop), uno stampava la foto di un bambino in chiaro nei log del telefono, uno lasciava in produzione pagine legali con i segnaposto. Sono chiusi tutti, e **ogni correzione porta con sé il test che l'avrebbe colta**.

### I sei bloccanti

- **Loop infinito del prompt biometrico su Android** (`BiometricGate.tsx`): l'`AuthActivity` del plugin è **traslucida**, quindi la MainActivity riceve `onPause`/`onResume` anche quando il prompt si apre e si chiude — e il listener `resume` ri-bloccava incondizionatamente, annullando lo sblocco appena riuscito. Passare ad `appStateChange` non risolveva (su Android l'`isActive:false` non viene mai emesso, su iOS l'evento scatta persino per il Centro di Controllo): la correzione **pretende di aver visto un'uscita vera** prima di ri-bloccare — guardia di reentrancy, `pause` accettato solo se nessuna verifica è in volo, più una finestra di grazia di 1,5 s per le ROM che consegnano il ciclo di vita fuori ordine. Il re-lock legittimo resta intatto.
- **Face ID morto su ogni iPhone**: mancava `NSFaceIDUsageDescription`. Non era un crash — il plugin forza `isAvailable=false` e la UI diceva «non disponibile su questo dispositivo», anche al revisore Apple.
- **L'opt-in biometrico sopravviveva al logout e bloccava il LOGIN**: `doLogout()` ora chiama `impostaBiometria(false)` (non aggiunge la chiave a `LOCAL_KEYS`: sarebbe una seconda fonte di verità), e il gate si arma solo con una sessione — flag dai cookie nel root layout **+** `!isPublicPath(pathname)`, che rende impossibile coprire `/auth/*` qualunque cosa dicano le altre condizioni.
- **Offline rotto su entrambe le piattaforme** (`public/sw.js` v1→v2): una navigazione ha `redirect:'manual'`, quindi il 307 della root produceva una **opaqueredirect** che `if (res.ok)` scartava — nessun documento entrava mai in cache, e `install` non pre-cachava nulla. Ora: pre-cache di `/offline`, chiave di cache **senza query**, ricostruzione della Response (una risposta `redirected` il browser la rifiuta), catena di ripiego che non rigetta mai. Su iOS mancava anche `WKAppBoundDomains`, senza cui WKWebView **non registra alcun Service Worker**. Le richieste RSC restano **deliberatamente non intercettate**: è il loro fallimento a far scattare il fallback a navigazione MPA di Next, ed è così che funziona la navigazione interna offline.
- **Pagine legali con i segnaposto in produzione**: `/privacy`, `/termini` e `/assistenza` riportano ora i dati reali del Titolare (Scuola dell'Infanzia La Favola Soc. Coop., Cesa CE, P.IVA 03394870616). In `/privacy` due sezioni nuove su ciò che l'app fa davvero: **dati conservati sul dispositivo** (cache offline, cancellata al logout e comunque dopo 7 giorni, esclusa dai backup Android) e **sblocco biometrico** (facoltativo, i dati biometrici non lasciano mai il telefono).
- **La foto scattata nei log in chiaro**: la causa era il **bridge di Capacitor**, non codice applicativo (`native-bridge.js` stampa il payload intero di ogni risposta nativa quando `isLoggingEnabled`). Chiuso con `loggingBehavior: 'none'` — e **non** `'production'`, che nel codice nativo significa «log sempre attivi, anche nelle build di rilascio».

### I nove minori

- **TTL e pulizia della cache offline** (`src/lib/offline/pulizia-cache.ts`): l'indice `aggiornato_il`, dichiarato «per pulizia per età» dalla `version(11)`, non era mai stato interrogato. Ora 7 giorni di TTL più un tetto di 200 voci, con svuotamento al logout. Si tocca **solo** `cache_read`: gli altri store contengono scritture `pending`, cancellarle butterebbe via il lavoro offline di una docente.
- **Badge dell'icona azzerato al logout**, con `await` **prima** del redirect (dopo, la hard navigation cancellerebbe il lavoro in volo).
- **Doppio prompt del permesso notifiche**: `Badge.requestPermissions()` su iOS chiedeva la sola autorizzazione *badge* mentre la push chiedeva `[alert, sound, badge]`; se vinceva la prima, l'app restava autorizzata al solo badge, i banner non arrivavano **mai** e la push rispondeva comunque `granted`. Ora `badge.ts` non chiede alcun permesso e ne verifica solo lo stato. Invariante: **`registerNativePush` è l'unico punto che chiede il permesso notifiche**.
- **Overlay biometrico a `z-[9999]`** (era `z-[100]`, sotto chrome admin e toast), con lock che impedisce a chiunque di superarlo.
- **Foto ridimensionata a 1600 px** + `correctOrientation` (che ri-codificando lascia indietro l'EXIF, GPS compreso) + `saveToGallery: false`; e nel fascicolo il `try/finally` che mancava — un 413 risponde HTML, il `r.json()` lanciava e **lo spinner restava appeso per sempre**.
- **Etichette del picker e prompt biometrico localizzate**: `camera.ts` e `biometric.ts` sono lib e non possono tradurre da sé, quindi i testi arrivano come parametro dai componenti.
- **I 5 bottoni «Scatta foto» cablati**: il testo visibile viene ora dalla **stessa** chiave dell'`aria-label` (`shared.scattaFoto`). Zero chiavi nuove, e le due etichette dello stesso bottone non possono più divergere.
- **Backup Android disattivato** (`allowBackup="false"` + `data_extraction_rules.xml` con `<device-transfer>` + `backup_rules.xml`): l'IndexedDB della WebView contiene presenze, diario, armadietto, galleria, appello e registro — dati di minori che finivano su Google Drive.
- **Bonifica dei `console.*` a rischio**: scoperto un `eslint-suppressions.json` con **94 violazioni `no-console` su 38 file**. Bonificati i 6 file che girano nel client e stampavano oggetti o errori con dati di minori (43 violazioni, fra cui 25 nel motore di sincronizzazione offline): si scende a **51**, congelate da un lock che le rende monotone decrescenti.

### Test e lock

Nuovi: `sw.test.ts` (il Service Worker si carica con `vm` in uno scope finto: 19 casi), `BiometricGate.test.tsx` (il ciclo di vita nativo si simula con un registro di listener), `pulizia-cache`, `native-badge`, `session-cookie`, `scatta-foto-i18n`. Estesi: `native-biometric`, `native-camera`, `logout`, `ServiceWorkerRegister`, `middleware-rules`. Quattro lock architetturali nuovi: `native-privacy-lock` (loggingBehavior, WKAppBoundDomains, Face ID, backup Android, z-index) e `console-suppressions`.

**Prova di validità eseguita**, non dichiarata: rimettendo a mano la vecchia `networkFirst` **6** test del Service Worker tornano rossi; rimettendo il listener `resume` incondizionato ne tornano rossi **6** del gate biometrico. Un test che non fallisce sul bug originale non è un test — e la prima stesura di quei test *non* falliva, perché `waitFor` su «è stata chiamata una volta» passa prima che la seconda chiamata parta.

- **Gate** verde: eslint 0 · tsc 0 · vitest 357 file / 2959 test · build ok.

> ✅ **I 6 bloccanti e i 9 minori sono chiusi.** Limiti dichiarati, non risolti: l'**oblio GDPR non raggiunge l'IndexedDB di un telefono** (`gdpr/esegui.ts` gira sul server) — lo coprono logout e TTL; su **iOS il backup iCloud resta scoperto** (l'esclusione richiede codice nativo su `Library/WebKit`); su **iOS l'offline non si collauda in dev su IP di LAN**; dopo un logout l'interruttore biometrico **va riattivato** (è per dispositivo, e il prossimo utente di quel telefono non deve ereditarlo).

> ⚠️ **Due rilasci distinti.** Le correzioni dentro `src/` arrivano **col deploy Vercel**, anche sui telefoni già installati (la WebView carica `server.url`). Quelle in `Info.plist`, `AndroidManifest.xml` e `capacitor.config.ts` — Face ID, `WKAppBoundDomains`, backup Android, log del bridge — arrivano **solo col prossimo build nativo** (`cap sync` + Xcode/Android Studio + store).

> ⚠️ **Resta prima della submission:** la **validazione legale** di informativa e termini; la sostituzione della **PEC** con una casella ordinaria in `/assistenza` (quasi tutti i gestori PEC rifiutano la posta ordinaria: un genitore che scrive da Gmail — e il revisore Apple — riceverebbe un errore di consegna); account demo e App Privacy labels.

## 🗓️ Changelog — Fase 3 i18n COMPLETA: app bilingue IT/EN (genitore · docente · admin · pubblico · condivisi · date) 2026-07-25 (branch `feat/native-fase2`)

Terza fase: internazionalizzazione (inglese). **Fondazione** posata e **pilota** tradotto; la migrazione a tappeto delle restanti pagine/componenti procede a lotti.

- **next-intl 4** *senza routing per-locale*: la lingua sta nel cookie `KV_LOCALE` (default `it`), risolta in `src/i18n/request.ts` — nessun `/[locale]` nell'albero delle rotte, middleware invariato. Plugin in `next.config.ts`, provider + `<html lang>` dinamico nel `RootLayout`.
- **Cataloghi** `messages/it.json` (sorgente) + `messages/en.json` (traduzione), namespace `common` + `auth`.
- **Selettore lingua** `LanguageSwitcher` (IT/EN: scrive il cookie e ricarica) sulla login e in «Profilo e deleghe».
- **Pilota**: pagina di **login** interamente migrata a `useTranslations` (titoli, label, placeholder, errori, aria-label).
- **Test**: mock globale di `next-intl` in `test/setup.ts` (risolve le chiavi sui testi italiani reali) → i test che renderizzano componenti tradotti passano senza wrapper.
- **Cataloghi per-namespace**: `messages/<locale>/<ns>.json` (un file per area), assemblati in `src/i18n/request.ts` — abilita la migrazione in parallelo (più agenti) senza conflitti sui file dei messaggi.
- **Tutta l'area GENITORE tradotta** (7 namespace, ~374 chiavi): `nav` (BottomNav + ChildSwitcher), `home` (dashboard + card), `avvisi` (page + AvvisoCard/DetailsContent/Drawer), `diario`, `mensa`, `pagamenti` (summary/storico/causale/push), `profilo`.
- **Tutta l'area DOCENTE tradotta** (7 namespace, ~874 chiavi): `teacherNav`, `teacherDiario`, `teacherPresenze` (giorni via `Intl`), `teacherComunicazioni`, `teacherPrimaria` (10 pagine), `teacherTasks`, `teacherServizi`.
- **Tutta l'area ADMIN/SEGRETERIA tradotta** (9 namespace, ~2673 chiavi): `adminNav` (shell+dashboard), `adminStudents` (anagrafiche), `adminContabilita` (pagamenti/riconciliazione/cassa/merch — 835 chiavi), `adminMensa`, `adminModulistica` (moduli + form builder), `adminComunicazioni` (avvisi+news+messaggi), `adminPrimaria`, `adminSettings` (impostazioni+scuole+SIDI), `adminAltro` (GDPR+protocolli+iscrizioni). **Catalogo totale: 3921 chiavi/lingua su 25 namespace, parità IT/EN verificata.** Gate verde: eslint 0 · tsc 0 · vitest 345 file / 2825 test · build ok. Aggiornato il lock `settings-sistema-design` per accettare l'eyebrow via i18n.

- **Cornice condivisa** (`shared`, 77 chiavi): `ui/` (Esci, Alto Contrasto, DateField, cockpit, PageHeader), `shell/` (AppBar, campanella), `sede-context`, `BiometricGate`, e i componenti **galleria** (MediaGrid/StudentTagger/MediaUploader/ScattaFotoButton).
- **Librerie di etichette** (`etichette`, 153 chiavi): ruoli, allergeni, tipi notifica, eventi diario, umore, aging pagamenti, config nav admin — via hook locale-aware (`useLabelRuolo`…), funzioni pure conservate come fallback.
- **Formati data/ora** locale-aware: helper `src/lib/i18n/date.ts` (`useDateFormat`/`nomeMese` via `Intl`) applicato a tutti i display client; giorni/mesi si localizzano in EN.
- **Area PUBBLICA** (`public`, 28 chiavi): pre-iscrizione (`EnrollmentWizard`, `/iscrizione`, compilazione modulo via magic-link `/m/[token]`).

**Catalogo finale: ~4554 chiavi/lingua su 33 namespace, parità IT/EN verificata su tutti.** Selettore lingua (IT/EN) su login e in «Profilo e deleghe». Gate verde: eslint 0 · tsc 0 · vitest 348 file / 2851+ test · build ok. Sweep finale: 0 residui utente cablati.

> ✅ **i18n completa lato UtenTE.** Restano in italiano **di proposito** (non-UI o contratti): i **PDF** e i documenti (ricevute/certificati/pagelle — atti legali), i **CSV/export** (formato-dato), i **log** applicativi, i **corpi delle notifiche persistite** (dato inviato; la localizzazione richiederebbe la lingua del destinatario al momento dell'invio), i **formati numero/valuta** (Euro), il **marchio «Kidville»** e i **placeholder-esempio**. Due form anagrafica sono dead-code (non renderizzati).

> 🚀 **IN PRODUZIONE** dal 2026-07-25 — Fase 2 (native) + Fase 3 (i18n) mergiate in `main` via **PR #42** (squash `c6dde7d`) e deployate su Vercel. CI verde: «Lint · Typecheck · Unit» + **E2E Playwright** (la suite runtime nel browser gira con i18n e Service Worker attivi). Nessuna nuova migrazione DB. **Fix CI:** `npm ci` falliva per `package-lock.json` fuori sync (dipendenze optional/Linux dei plugin nativi omesse — npm bug 4828); lock rigenerato da zero.
>
> ⚠️ **Le funzioni native** (fotocamera/biometria/badge) diventano operative sui **telefoni** solo col prossimo **build nativo** dell'app (`npx cap sync` + Xcode/Android Studio + store): il deploy web serve i18n, offline (Service Worker) e la UI a web e WebView. La **prova su dispositivo** di Fase 2 resta da fare prima della submission agli store.

## 🗓️ Changelog — Fase 2 native: offline (avvisi·diario·menu) + fotocamera nativa + login biometrico + badge/condivisione 2026-07-24 (branch `feat/native-fase2`)

Seconda fase della preparazione allo store: **funzioni native**. Primo tassello, l'**offline** (l'unico pienamente verificabile col gate web; le altre native — fotocamera, biometria, badge — seguono e richiedono verifica su dispositivo).

- **Service Worker con caching del guscio** (`public/sw.js`, prima solo Web Push): `install`/`activate`/`fetch` — asset statici cache-first, navigazioni network-first con fallback alla cache (l'app si apre anche senza rete), `/api/` sempre in rete (mai dati stale). Registrato ora su web **e** nativo (`ServiceWorkerRegister` in `RootProviders`).
- **Cache dati con Dexie** (riuso di `KidvilleOfflineDB`, nuova `version(11)` con store `cache_read`): helper `fetchConCache` (`src/lib/offline/read-cache.ts`) che serve l'ultima copia salvata quando la rete manca. Agganciato a **avvisi**, **diario** (entries) e **menu mensa**; indicatore «Dati non aggiornati — offline» (`OfflineBadge`). Saldo ticket e prenotazioni NON cachati (stato mutabile).
- **Fotocamera nativa** (`@capacitor/camera`): sull'app nativa il caricamento foto apre lo scatto/scelta nativo; su web resta l'`<input type=file>`. Agganciata a galleria e news (i punti che accettano anche PDF restano su input per non perdere l'allegato documento). Helper `src/lib/native/camera.ts` + hook `useImagePicker`.
- **Login biometrico** (`@aparajita/capacitor-biometric-auth`, opt-in): interruttore in «Profilo e deleghe»; la sessione Supabase è su cookie, quindi la biometria **sblocca** l'app (overlay `BiometricGate` all'avvio e al ritorno in foreground), non ri-autentica. Anti-lockout con «Esci».
- **Badge icona** (`@capawesome/capacitor-badge`) = numero di notifiche non lette (dal Centro Notifiche). **Condivisione nativa** (`@capacitor/share`, fallback Web Share/clipboard): pulsanti «Condividi» su news e avvisi.
- **Gate** verde: eslint 0 · tsc 0 · vitest 341 file / 2809 test · build ok. Nuovi test: read-cache, ServiceWorkerRegister, camera, use-image-picker, share, biometric.

- **Rifinitura nativa** (bottone condiviso `ScattaFotoButton`): ripristinato il caricamento **foto/video dalla galleria** sul nativo in galleria; aggiunto il bottone additivo **«Scatta foto»** accanto a **tutti i 9** gli input che accettano anche PDF (certificato medico, fascicolo, registro, giustificativo cassa, chat, avvisi, moduli, modulistica docente, incarichi/risoluzione sub-task) — l'allegato PDF resta intatto, il bottone appare solo su nativo dove `accept` ammette immagini.

> ⚠️ **Non ancora in produzione.** Tutte e 4 le funzioni native della Fase 2 sono implementate e passano il gate web (eslint 0 · tsc 0 · vitest 343 file / 2815 test · build ok), ma il comportamento runtime (Service Worker nella WebView, scatto foto, prompt biometrico, badge sull'icona, foglio di condivisione) **va verificato su dispositivo/simulatore** (`npx cap sync` + build nativa) prima del deploy. Fase 3 (i18n EN completo) da avviare.

## 🗓️ Changelog — App Store & Play readiness (Fase 1): stringhe d'uso iOS, cancellazione account, pagine legali, privacy manifest, cleartext Android 2026-07-24 (branch `feat/app-store-readiness`)

Prima fase di preparazione alla pubblicazione su App Store/Google Play (a valle di una review simulata «nei panni di Apple App Review»). Corregge i motivi di rigetto bloccanti e le carenze di privacy, senza toccare le fasi 2 (funzioni native) e 3 (i18n inglese completo), previste in cicli successivi.

- **Crash foto iOS (Guideline 2.1)** — aggiunte in `ios/App/App/Info.plist` le stringhe d'uso `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSMicrophoneUsageDescription`. Senza, iOS terminava l'app al primo accesso a fotocamera/foto (upload in galleria, chat, diario, moduli).
- **Cancellazione account self-service (Guideline 5.1.1(v) + GDPR art. 17)** — nuova pagina genitore `/parent/profilo` («Profilo e deleghe», prima placeholder «in arrivo»): il genitore avvia la richiesta con doppia conferma (digita `ELIMINA`), revocabile finché «in lavorazione». Nuove route `GET/POST/DELETE /api/parent/account/richiesta-cancellazione` (`withRoute` + `requireUser` + zod). La Direzione la evade dal pannello **Privacy & Diritto all'Oblio** (`/admin/gdpr`, nuova route `admin/gdpr/richieste`): anonimizza il genitore (`patchParent`) e i figli **non iscritti** (`patchAlunno` + bonifica finanziaria), mantenendo audit e documenti fiscali. Notifica alla Direzione via Centro Notifiche (nuovo tipo `richiesta_cancellazione_account`). Nuova tabella `richieste_cancellazione` (solo `service_role`) + libreria riusabile `src/lib/gdpr/esegui.ts`; l'oblio admin esistente resta invariato.
- **Informativa privacy inesistente (Guideline 5.1.1/5.1.2 + GDPR)** — nuove pagine pubbliche `/privacy`, `/termini`, `/assistenza` (server component; `PUBLIC_PREFIXES` aggiornata in `src/lib/auth/middleware-rules.ts`). Il consenso in onboarding ora **linka** l'informativa (prima rimandava a un documento inesistente). Testi bozza con segnaposto `[...]` per i dati dell'ente e l'email di supporto: **da far validare da un legale** e completare prima del lancio.
- **Metadati/config iOS** — `CFBundleDevelopmentRegion=it` + `CFBundleLocalizations [it,en]`; orientamento **solo verticale** su iPhone; rimossa la capability obsoleta `armv7`. `aps-environment` resta gestito da Xcode (Automatic), da verificare `production` in Archive. Aggiunto il **privacy manifest** `ios/App/App/PrivacyInfo.xcprivacy`.
- **Android/Play** — nuovo `network_security_config.xml`: HTTP in chiaro **bloccato in release**, riaperto solo verso gli host locali di sviluppo (10.0.2.2/localhost/127.0.0.1). Nota di build in `docs/mobile.md` (rigenerare i config con `CAP_SERVER_URL` HTTPS prima dello store).
- **Gate** — `eslint`/`tsc`/`vitest` (334 file, 2780 test, inclusi i lock logging/zod)/`build` verdi. Nuovo test `__tests__/lib/gdpr-esegui.test.ts`; gruppo `parent/account` aggiunto al lock `zod-coverage`.

> ⚠️ **Da completare prima della submission**: email di supporto reale nelle pagine legali; validazione legale di informativa e termini; account demo pre-onboardato nelle note di review Apple; App Privacy nutrition labels (dati di minori + Firebase/FCM). **Fasi 2 (funzioni native) e 3 (i18n EN) in cicli successivi.**

## 🗓️ Changelog — Sezione «News»: blog rich-text, embed Instagram, comunicati, digest mensile email 2026-07-20 (branch `feat/news`)

Nuovo canale editoriale interno («News», «Kidville News» nel digest) visibile ai soli utenti autenticati (genitori, docenti, segreteria/direzione, cuoca). Quattro tipi di contenuto: **articolo** rich-text, **comunicato breve**, **post Instagram** embeddato da URL, **digest mensile**. Workflow editoriale **bozza → proposta → programmata → pubblicata → nascosta**: admin/direzione/segreteria pubblicano direttamente; i docenti *propongono* bozze che lo staff approva (subito o programmata) o rifiuta con motivo. Targeting per **sede / grado / classi** con feed genitore **derivato server-side dai figli** (fail-closed: nessun figlio con sede determinabile → nessuna news). Ricerca full-text italiana (`search_tsv` + `websearch_to_tsquery`), pinned «In evidenza», notifiche push opt-out per post, archivio per mese, visualizzazioni = famiglie uniche (statistiche **solo staff**).

- **Schema (2 migrazioni additive, prod advisors 0 ERROR):** `20260720191506_news_base` (5 tabelle: `news_categorie` con 5 categorie di sistema seed, `news_posts` con `search_tsv` GENERATED + indici parziali, `news_media`, `news_visualizzazioni`, `news_digest_edizioni`; RLS abilitata su tutte, **nessuna** policy INSERT/UPDATE/DELETE per `authenticated` — le mutazioni passano solo dalle route service-role; SELECT difensive fail-closed) e `20260720191525_news_cron` (2 funzioni `SECURITY DEFINER` + `SET search_path`, **REVOKE da PUBLIC, anon, authenticated** + GRANT a service_role, job `news-tick` `*/10 * * * *` e `news-digest` `0 8 1 * *`). *(Nomi file riallineati ai version del ledger di produzione nel ciclo 2 — vedi changelog di correzione in testa.)*
- **14 route API service-role** (`/api/news/*`): gestione (`GET/POST`, `[id] GET/PATCH/DELETE`, `[id]/pubblica`, `[id]/approva`, `[id]/statistiche`), categorie CRUD, upload (bucket `news`, sniff video → 415), instagram/valida (health-check via `externalFetch`), lettura (`feed`, `feed/[id]` con conteggio visualizzazioni solo-genitore), digest (`digest`, `digest/[id]`, `digest/genera`), cron (`cron/run`, gate `x-cron-secret`). Ogni route: `withRoute` + `zod` + gate ruolo (`requireDocente`/`requireStaff`/`requireUser`) + scope di sede RC2 + **degrado schema-assente** (DB E2E CI non migrato → `{disponibile:false}`/liste vuote, mai 500). Il client invia **solo `contenuto_json`**: HTML e testo li produce il **chokepoint unico di sanificazione** server-side (`src/lib/news/sanitizza.ts`: TipTap→`generateHTML`→`sanitize-html` a lista bianca; niente `<script>`/`<iframe>`/`style`/handler inline; `<img>` solo https dallo storage Supabase; link forzati a `rel="noopener noreferrer"`).
- **Health-check Instagram robusto:** `esitoHealthCheck` pura su corpo+status — **429/403/5xx → `indeterminato`** (NON incrementa il contatore né nasconde il post: un rate-limit non è un post morto); solo un 404 o un corpo «rimosso/privato» valgono `fallito`, e a **2 fallimenti consecutivi** il post passa a `nascosta` (`instagram-non-raggiungibile`).
- **Frontend:** cockpit `/admin/news` (pattern `/admin/pagamenti`, editor TipTap `ssr:false`), pagina docente `/teacher/news` (Salva bozza / Invia proposta), feed genitore `/parent/news` con dettaglio, archivio digest e widget in home; voce **News** nel Menu sheet (gruppo «Comunicazioni», tab fisse intatte). Embed Instagram WebView-safe: link **«Apri su Instagram» sempre presente** (mai condizionale); video `youtube-nocookie`/`player.vimeo.com`/upload con `playsInline`; token Clay Village ovunque.
- **GDPR — digest mensile = comunicazione istituzionale (decisione esplicita):** inviato via email a **tutte le famiglie della sede**, **indipendentemente dai toggle di notifica**; footer che dichiara «comunicazione istituzionale, inviata a tutte le famiglie della sede»; **destinatari mai in chiaro nei log** (hash correlabile via `sendEmailDetailed`/`externalFetch`); nessuna PII di minori nel template oltre ai contenuti redazionali. Invio sequenziale con throttle (~2/s), idempotente (`UNIQUE(scuola_id,anno,mese)` + `ON CONFLICT DO NOTHING` + guardia `inviata_il IS NULL`).
- **Responsabilità consenso foto:** al **primo caricamento** di una foto in un post, dialog **bloccante** con checkbox «Verifica di avere il consenso foto per i bambini riconoscibili» (l'upload non parte finché non è spuntata); la responsabilità della verifica è dell'operatore.
- **Nota multi-sede:** i post e le categorie **globali** (`scuola_id NULL`) sono gestibili da qualunque admin (sede di produzione unica, seed condiviso) — **da rivedere in un multi-sede reale**.
- **Logging:** canale `news` **persistito** (aggiunto a `EVENTI_PERSISTITI`, altrimenti i successi non finirebbero in `app_log`); notifica di pubblicazione e digest loggano **successo E errore**; ogni `{ error }` PostgREST controllato; corpo errori Instagram/Resend conservato via `externalFetch`. Nuova voce notifica `news` in `TIPI_NOTIFICA` (opt-out genitore). Additivo su `src/lib/email/send.ts`: campo `html?` opzionale (semantica mittente invariata). Nessuna nuova variabile d'ambiente (riuso `CRON_SECRET`, `RESEND_API_KEY`, `OTP_FROM_EMAIL`, origine da `app.push_dispatch_url`).
- **Gate:** `eslint 0 · tsc 0 · vitest 2746 · build ok`; 2 spec E2E nuovi (`admin-news`, `parent-news`) tolleranti al degrado CI; migrazioni applicate in produzione via MCP (advisors security+performance **0 ERROR**; WARN pre-esistenti + `auth_rls_initplan` sulle 2 policy SELECT difensive, non sul percorso reale server-derived); job `news-tick`/`news-digest` schedulati. Avvisi, `destinatari.ts` e `.env.local` **intoccati** (perimetro chiuso).

---

## 🗓️ Changelog — Modulo «Cassa» · correzioni ciclo 2 (contratto null-tollerante, scope di sede, log persistito, date reali, contrasti AA, segno storni) 2026-07-20 (branch `feat/cassa`)

Secondo giro del `/ship-cycle` sul modulo Cassa: 11 tester-opus hanno prodotto 7 cause radice, tutte sanate su file disgiunti.

- **Contratto client/server null-tollerante (RC1, era BLOCCANTE)**: registrare un'uscita/entrata lasciando vuoti i campi facoltativi **Descrizione**/**Note** dava `400 «Dati non validi»` su web, Android e iOS (il client inviava `null`, lo zod `.optional()` accettava solo `undefined`). Ora lo schema di `POST /cassa/movimenti` è `.nullish()` sui facoltativi (`descrizione`/`note`/`allegato_path`/`categoria_id`/`data`) → il caso d'uso base (solo importo + categoria) salva regolarmente. In più il **400 è azionabile**: la modale legge `details` e **nomina i campi** in italiano («Controlla il campo: Note»), con `aria-invalid`/`aria-describedby` sugli input (WCAG 3.3.1).
- **Scope di sede sulle mutazioni per-id (RC2, sicurezza)**: lo storno di un movimento e il PATCH/DELETE di una categoria di sede ora verificano che la `scuola_id` sia **nello scope dell'operatore** (`resolveScuoleAttive`) → **403** fuori scope (prima l'`id` da solo bastava, col client service-role che scavalca la RLS). Rigenerazione dello slug alla rinomina, `is_sistema` protetto anche in PATCH.
- **Osservabilità durevole (RC3, log)**: il canale `'cassa'` è ora **persistito** in `app_log` (era solo su stdout: «nessun log» non distingueva «tutto ok» da «mai partito»). Gli audit/marcature via PostgREST non scartano più il `{ error }` (niente `.then(() => {})`), il bucket dei giustificativi non fallisce più in silenzio. **Mai** descrizioni/note/motivi nei log (fuori lista bianca `redact`).
- **Date di calendario reali (RC4, backend)**: `?da=`/`?a=` con una data **inesistente** (es. `2026-02-30`) davano **500**; il validatore condiviso `zDataYMD` ora rifiuta col **400** le date non valide (beneficio esteso ad attendance/mensa che usano lo stesso validatore).
- **Contrasti AA app-wide (RC5, accessibilità)**: i toni informativi del `Badge` condiviso (success/warn/error → testo **-strong**; neutral → **-sub**) e le primitive `cockpit` (etichette/sub delle StatCard e intestazioni di tabella → **-sub**) passano da 2,5–3,7:1 a ≥4,5:1; nel modulo Cassa gli **importi colorati**, i **banner** e i **messaggi di stato** usano le varianti `-strong`, gli hint/metodi/«Storna»/icona «X» il **-sub**. Aggiunti `scope="col"` alle intestazioni, `role="img"` all'icona lucchetto e target touch più ampi (header ≥44px, «X» 40px). I toni decorativi `unread`/`info`/`read` del Badge restano invariati.
- **Segno degli storni (RC6)**: i contro-movimenti mostravano un **doppio segno** («− € -20,00»). Ora il segno deriva dalla **direzione** (XOR tipo×segno) su valore assoluto: lo storno di un'uscita è una restituzione **«+ € 20,00»** (verde), quello di un'entrata **«− € 50,00»** (rosso); le righe di storno portano un **badge «storno»**. A 320px il gestore categorie non genera più scroll orizzontale (RC7).
- **Rifiniture**: label dei metodi capitalizzate ovunque (`metodoLabel`) e mese report in `MM/AAAA` (`meseItaliano`); data di default del form nel fuso **Europe/Rome** (`oggiFiscaleISO`); **hint privacy** sotto Descrizione («niente nomi di bambini o famiglie»); empty-state soppresso quando c'è un errore di caricamento; oblio GDPR esteso a `cassa_movimenti` (descrizione/note/motivo bonificati per CF).

Gate: `eslint 0 · tsc 0 · vitest (suite completa verde) · build` + ri-collaudo dei domini toccati. Nessuna migrazione DB in questo giro. Solo token `kidville-*` (zero hex).

## 🗓️ Changelog — Modulo «Cassa»: registro di cassa contanti per sede, KPI solo admin 2026-07-20 (branch `feat/cassa`)

La Contabilità aveva tutto (scadenziario, incassi, incasso unico, riconciliazione, causali, solleciti, fiscale) tranne un **registro di cassa**: non c'era modo di sapere quanto contante deve esserci fisicamente nel cassetto, né di registrare le **uscite** (spese). Nuova **tab «Cassa»** dentro Contabilità (`/admin/pagamenti?vista=cassa`, `CassaPanel` lazy; nav `ContabilitaNav`).

- **Ledger immutabile `cassa_movimenti`** (`tipo` = entrata/uscita/prelievo/rettifica; `importo` con `CHECK (<> 0)`; `metodo` contanti/bonifico/carta/altro; `categoria_id` → `cassa_categorie`; `descrizione`/`note`/`allegato_path`; `incasso_id UNIQUE`; `chiusura_id`; `registrato_da`; `storno_di`/`stornato_il`/`storno_motivo`). Correzioni **solo per storno tracciato** (contro-movimento con stesso `tipo` e importo **negato** + motivo), mai UPDATE/DELETE. Storno vietato (**409**) su movimento già stornato, su uno storno, su un'entrata auto o su un movimento di chiusura.
- **Entrate automatiche dagli incassi contanti** calcolate a **query-time** (zero duplicazione): il saldo somma gli `incassi` con `metodo='contanti'` della sede. ⚠️ **Correttezza storni**: lo storno di un incasso contanti crea un contro-incasso con `metodo='storno'`/`'altro'` e `storno_di` → il calcolo lo **sottrae** risalendo al metodo dell'originale, così il saldo non resta gonfiato. Trappola `pagamenti.scuola_id` NULL gestita col fallback su `alunni.scuola_id`. Logica **pura e testata** in `src/lib/cassa/saldo.ts`.
- **Saldo atteso** «che prevede tutto» = `fondo` (config) + entrate contanti − uscite contanti − prelievi ± rettifiche. **Solo le uscite in contanti muovono il saldo**; le altre (bonifico/carta) entrano solo nel report spese. Card **«entrato oggi»** per metodo (Europe/Rome), solo nella tab.
- **Svuotamento/chiusura** on-demand (`cassa_chiusure`): si inserisce il **totale contato**, la **differenza** (ammanco/eccedenza) è registrata come `rettifica`, il **prelievo** = contato − fondo; dopo lo svuotamento il saldo riparte esattamente dal **fondo**. Atomico via RPC `registra_chiusura_cassa` (SECURITY DEFINER + `SET search_path` + REVOKE PUBLIC/anon/authenticated + GRANT service_role — lock `security-definer-revoke`). Il saldo atteso è ricalcolato **server-side** (il client non lo invia).
- **Categorie di uscita** (`cassa_categorie`, pattern `payment_categories`): seed Forniture didattiche · Alimentari/mensa · Pulizie e igiene · Manutenzione · Cancelleria · Rimborsi · **Versamento in banca** (`is_sistema`, non eliminabile → 409) · Varie — personalizzabili dall'admin. **Giustificativo foto facoltativo** su Storage **privato** (`cassa-giustificativi`, URL firmati 5 min).
- **Permessi**: la **segreteria opera** (registra uscite/entrate, storna, vede la lista) **ma senza KPI** — saldo atteso, «entrato oggi», totali, report e svuotamento sono **solo admin** (gate `requireStaff(request, ['admin'])`). I `totali` **non compaiono nemmeno nel payload JSON** per i non-admin; la lista segreteria è senza saldo progressivo né totali.
- **Notifiche** (`TIPI_NOTIFICA`, gruppo staff): **`cassa_soglia`** (contante atteso oltre la soglia configurabile — **solo alla transizione** sotto→sopra, anti-spam via flag `soglia_notificata_il`) e **`cassa_uscita`** (uscita registrata da un membro dello staff non admin), destinatari = admin della sede.
- **Report** filtrabile per periodo/categoria + riepilogo mensile + **filtro per categoria di pagamento** sulle entrate cross-mese (join `incassi → pagamenti → payment_categories`; es. una quota incassata in più acconti scaricabile **per intero**) + **export CSV** (BOM, separatore `;`, virgola decimale, it-IT).
- **Impostazioni** dentro la tab: `admin_settings.cassa_config` JSONB `{ fondo, soglia_avviso }` (whitelist `ALLOWED_FIELDS` + `mergedKeys`, shallow-merge server; il flag interno `soglia_notificata_il` lo scrive solo il server).
- **API** `/api/pagamenti/cassa/*` (movimenti GET/POST, storno, saldo, chiusura GET/POST, report, categorie, allegato upload-url/GET) — tutte `withRoute('pagamenti/cassa/…')` + zod + `createAdminClient()`, `logEvento('cassa',…)` sui successi (**mai** descrizioni/motivi/note nei log — **non** in lista bianca `redact`), **degradazione pulita** sul DB E2E CI non migrato (`42P01`/`42703`/`PGRST202`/`PGRST204`/`PGRST205` → `{ disponibile: false }`, mai 500; empty-state «Modulo cassa non ancora attivo su questo ambiente»).
- **Migrazioni** `20260720100000_cassa_base` + `20260720101000_cassa_config` (via MCP `apply_migration`, `get_advisors` 0 ERROR). **Solo token** `kidville-*` nei componenti (nessun hex letterale); modali accessibili (`ui/Modal`), differenza di cassa annunciata **a parole** oltre che a colore. Gate: `eslint 0 · tsc 0 · vitest · build` + collaudo 11 tester-opus.

## 🗓️ Changelog — Causali del bonifico personalizzabili per categoria (sezione «Causali» in Contabilità) 2026-07-19 (branch `feat/causali-config-per-categoria`)

La causale consigliata era un formato fisso. Ora la segreteria ha, in **Contabilità → «Causali»** (`/admin/pagamenti?vista=causali`, `CausaliPanel`), un pannello per personalizzare il **modello** della causale **per ogni categoria** di pagamento (Rette, Iscrizione, Mensa, Divisa, Materiale, Gita) + un «Predefinito», con **anteprima dal vivo** e segnaposto cliccabili (`{descrizione} {nome_completo} {codice_fiscale} {sede} {mese} {anno} {importo} {scadenza}`). Motore puro `renderCausale` (`src/lib/pagamenti/causale.ts`): sostituisce i segnaposto e **omette i segmenti** (separatore « - ») coi soli segnaposto vuoti; **guardia** sui template non-stringa (config malformata → predefinito, mai 500). I modelli vivono in `admin_settings.causali_config` (JSONB per-scuola indicizzato per **slug**, merge shallow lato `PATCH /api/admin/settings`; una **stringa vuota RIMUOVE la chiave** = reset al predefinito, e i valori non-stringa sono scartati). La causale è composta **server-side** in `GET /api/pagamenti` (`causale_suggerita` per voce, col modello della categoria o il predefinito), e usata dalla card genitore `CausaleBonifico` e dall'email di **sollecito**. Migrazione `20260719110000_causali_config` (colonna `causali_config jsonb`), advisors 0 ERROR. Degrada su DB E2E CI non migrato (`getModuleConfig` → `{}` → predefinito; `PGRST204` sul PATCH). Collaudo mirato **5/5 PASS** (backend·frontend·design·accessibilità·privacy; findings minore sanati: guardia non-stringa→500, reset affidabile, anteprima = runtime, contrasto AA della label). Gate: `eslint 0 · tsc 0 · vitest 2382 · build`. Il CF del minore resta **fuori dai log**.

## 🗓️ Changelog — Causale bonifico completa: «{descrizione} - per il minore {Nome Cognome} - {CF} - {SEDE}» 2026-07-19 (branch `feat/causale-bonifico-completa`)

Rifinitura della causale consigliata introdotta con la Riconciliazione v2 (sotto): dal formato minimo «Nome Cognome CF» a una **causale completa per singola voce** — `{descrizione del pagamento} - per il minore {Nome Cognome} - {CODICE FISCALE} - {SEDE}` (es. «Retta Settembre 2026 - per il minore Mario Rossi - «CF» - GIUGLIANO»). Così il bonifico porta con sé descrizione, mese, nome, CF e sede: l'abbinamento in riconciliazione è a **margine d'errore zero**. La card genitore `CausaleBonifico` mostra ora **una causale per ogni voce ancora aperta** (non più una per figlio); il nome sede è risolto da `scuole.nome` (query batch best-effort in `GET /api/pagamenti`) e reso «GIUGLIANO» (maiuscolo, senza il prefisso «Kidville») da `sedeCausale`. Il motore dei solleciti usa lo stesso builder `rigaCausaleSollecito`, col CF sempre **fuori dai log**. Le parti assenti (CF/sede) sono omesse con grazia. Gate: `eslint 0 · tsc 0 · vitest 2361 · build`; nessuna migrazione.

## 🗓️ Changelog — Riconciliazione bancaria v2: codice fiscale prioritario, estratto conto unico cross-sede, lista a semaforo con popup 2026-07-19 (branch `feat/riconciliazione-v2`)

Quando arriva un bonifico, *di chi è, per quale minore, per cosa?* Il matcher indovinava da nome+importo+periodo (ambiguo: due rette da 150€ senza nome non si distinguono), la lista mostrava due soli colori senza i confermati, e l'estratto conto era **legato a una singola sede** (`riconciliazione_movimenti.scuola_id NOT NULL`), mentre il conto corrente è **uno solo per tutte le sedi**. Questo ciclo (pipeline `/ship-cycle`) riscrive la riconciliazione attorno a tre decisioni del titolare.

**1. Codice fiscale del minore = chiave di abbinamento.** `estraiCodiciFiscali` (regex CF italiana, con ramo **omocodia** e variante senza spazi) estrae i CF dalla causale; un CF che combacia con l'alunno di una voce aperta è l'**aggancio dominante** (`CF_BONUS`, ordina primo) e porta la riga a **GIALLA (suggerita, conferma umana — mai auto-conferma)**. CF assente/errato/senza voce aperta → **fallback** al punteggio nome/importo/periodo/descrizione (nessuna regressione). Comunicato ai genitori: nuova card **«Causale consigliata per il bonifico»** (Nome + CF, copiabile) nella pagina Pagamenti + riga col CF nell'**email di sollecito** (destinatario = il tutore; il CF **non** entra nei log, resta redatto/hash).

**2. Estratto conto UNICO cross-sede.** Migrazione `20260719100000_riconciliazione_v2_cross_sede` (applicata in prod, advisors 0 ERROR): `scuola_id` **nullable** su `riconciliazione_movimenti`/`_import`, **UNIQUE globale** su `hash_movimento` (dedup su tutto il registro, non più per sede), indici `(stato, data_operazione)` + `(pagamento_id)`. Il movimento **nasce senza sede**: la Direzione carica un unico estratto, **tutte le segreterie vedono tutte le righe** (GET globale, `requireStaff`, **mai genitori** — scelta consapevole di visibilità cross-sede), ma la **conferma resta vincolata alla sede del pagamento** abbinato (`sediAttive.includes(pag.scuola_id)`), che diventa la sede del movimento. Degradazione E2E CI (DB non migrato): insert `scuola_id:null` → retry su `23502`.

**3. Lista a semaforo + popup, e il bonifico cumulativo.** La lista mostra ora **tutti** i movimenti a **4 colori** — 🟢 confermato · 🟡 suggerito · 🔴 da_abbinare · ⚪️ ignorato (token pieni Clay Village, contrasto AA, override Alto Contrasto per il giallo) — con **filtri** per stato e **righe cliccabili** → popup centrale `MovimentoDialog` (su `ui/Modal` accessibile): suggerimenti ordinati con badge «CF», ricerca manuale, conferma/ignora/riapri, e a **saldo avvenuto** Ricevuta + Fattura SdI. Nuovo **guard**: confermare un bonifico su un pagamento **già saldato** (residuo ≤ 0, es. registrato a mano) → **409** senza doppio incasso (il CAS ottimistico anti-doppione resta). Un bonifico **multi-CF** (più figli) mostra **«Apri Incasso unico»**: il nuovo `GET /api/pagamenti/pagante-comune` risolve il genitore comune ai bambini agganciati e apre il wizard «Incasso unico» **precompilato** (pagante, totale, riferimento, voci) — realizza la *«pre-compilazione transazione dalla riconciliazione»* prima censita per il futuro.

**Verifica.** Gate formale verde (`eslint 0` · `tsc 0` · `vitest 2323` · `build`); migrazione in prod (advisors 0 ERROR, ledger allineato al file). Collaudo `/ship-cycle`: **11/11 tester-opus PASS** al ri-collaudo (ciclo 2; il ciclo 1 aveva trovato 6 FAIL — accessibilità/privacy/backend/log/debug/localizzazione — tutti sanati per causa radice: controllo `{error}` PostgREST, date reali → 400, **409 su bonifico oltre il residuo** contro il sovra-incasso silenzioso, minimizzazione dei nomi dei minori cross-sede in lista, oblio GDPR esteso a riconciliazione/incassi, import da tastiera + contrasto AA). **Nota di visibilità**: la riga bancaria (data/importo/causale) dell'estratto è condivisa tra tutte le segreterie per scelta del titolare; l'arricchimento identificante (nome del minore) è minimizzato alla sola sede dell'operatore. **PSP/pagamento online** resta fuori (roadmap).

## 🗓️ Changelog — Notifica di pagamento anche sulla riconciliazione bancaria 2026-07-19 (branch `feat/notifiche-pagamento`)

La notifica automatica al genitore quando la segreteria **registra un pagamento** (`pagamento_registrato`,
campanella subito + push dopo la finestra di 10′) era già attiva su tutte le strade a mano — incasso singolo
(`/api/pagamenti/incassi`), transazione unica di famiglia (`/api/pagamenti/transazioni`) e marcatura manuale
«pagato» (`PATCH /api/pagamenti/[id]`) — e abilitata per la sede di produzione (toggle assente = attivo).
Restava **una sola strada muta**: la **conferma della riconciliazione bancaria** (`PATCH
/api/pagamenti/riconciliazione/[id]`), che abbina un bonifico dell'estratto conto e crea l'incasso **direttamente**,
senza passare dalle route sopra → il genitore non veniva avvisato. Ora anche quella conferma invia
`pagamento_registrato` (titolo «Pagamento/Acconto registrato» secondo lo stato ricalcolato dal trigger, corpo con
l'importo in formato it-IT) **e** riaggancia `verificaRevocaSospensioneMorosita` (un bonifico che salda lo scaduto
revoca la sospensione, come per gli incassi a mano — era l'altro buco della stessa strada). Best-effort, coerente
col contratto «una notifica persa non trasforma in 500 un salvataggio riuscito, ma lascia una riga di log».
Verifica end-to-end su produzione: `notifiche` contiene già righe `pagamento_registrato` con `push_inviata_il`
valorizzata (catena campanella→push funzionante). Gate verde (`eslint` · `tsc` · `vitest` 2247 · `build`); nessuna
migrazione.

## 🗓️ Changelog — Contabilità v2: fonte unica dello stato, transazione unica di famiglia, sospensione a famiglia, sconti/pro-rata, solleciti schedulati 2026-07-18 (branch `feat/contabilita-v2`)

Riscrittura della contabilità in **7 slice** committabili (S1..S7) via pipeline `/ship-cycle`, che chiude i
5 findings di contabilità lasciati aperti dai collaudi E2E (esclusi di proposito dalla PR precedente) e aggiunge
la funzione più richiesta dall'operatività: **un genitore paga con un solo bonifico più cose insieme**. Gate verde
(`eslint --max-warnings 0` · `tsc --noEmit` · `vitest` · `build`); migrazioni via MCP con `get_advisors` **0 ERROR**.
Il DB E2E della CI **non è migrato** → il codice degrada in modo pulito (SELECT colonne nuove: retry `42703`;
scritture: best-effort `PGRST204`; RPC assenti: `503` senza scritture parziali; tabelle nuove su GET:
`{ data: [], disponibile: false }`; config assente: regole spente = comportamento odierno).

**Fonte unica dello stato/residuo (S1).** `aging.ts` diventa la sola verità: `residuoEffettivo(p) = max(0, importo −
sconto − pagato)` (clamp **per voce**, mai compensazioni fra voci) e `statoEffettivo(p, oggi)` deriva «scaduta»
**sempre dalle date** (il cron resta solo per notifiche/solleciti). Tutti i consumatori migrati (GET pagamenti,
`PagamentiSummary`, `StoricoPagamenti`, dashboard, bucket aging, solleciti, revoca). **Home genitore tri-stato**:
rosso «€X scaduti» · ambra «€Y da pagare» · verde solo a zero. Finding «home in regola con €70 scaduti» chiuso
(prima `PagamentiSummary` sommava residui **negativi** che compensavano gli scaduti).

**Regole d'incasso (S3).** Il **doppio incasso** è fermato: un versamento oltre il residuo effettivo dà **409
`{ eccedenza }`** finché la segreteria non conferma esplicitamente «credito famiglia» (o riallocazione) — **mai
silenzioso**; lo spill fra rate dello stesso piano resta invariato. `PATCH` voce: `importo ≥ 0` (zero ammesso per
le esenzioni) e mai sotto il già incassato (409 «storna prima»). I **DELETE secchi** degli incassi diventano
**storno tracciato**: contro-incasso negativo collegato + `storno_di`/`stornato_il`/`storno_motivo`, **motivo
obbligatorio** e audit in `registro_modifiche` (niente cancellazioni mute). **Sconto/abbuono** su singola voce
(importo, con motivo) + scorciatoia «salda con abbuono della differenza» all'incasso; residuo = importo − sconto −
pagato.

**Transazione unica di famiglia (S4).** Nuova vista **«Incasso unico»** in `/admin/pagamenti` (`TransazioniPanel`,
wizard a 3 passi: pagante → importi con voci per figlio, **proposta automatica** «più vecchie prima» e **quadratura
live**, ricariche mensa in euro + ticket → conferma). Un solo versamento salda **più voci di più figli** e ricarica
la mensa, con campi dedicati **metodo, riferimento/CRO, data valuta, note**. L'atomicità è di due RPC
`SECURITY DEFINER` **service-role only** (`REVOKE` da `PUBLIC, anon, authenticated`): `registra_transazione_contabile`
(transazione + incassi + ricariche + eventuale credito) e `utilizza_credito_famiglia`. L'**eccedenza non è mai
silenziosa**: dialog esplicito «€X in eccesso → credito famiglia» (conferma/annulla). Il **credito famiglia** è un
ledger tracciato (`crediti_famiglia`), **visibile solo alla segreteria**, riutilizzabile sulle voci future.
**Ricevuta unica di famiglia** numerata (dettaglio per figlio, intestata al pagante) **oppure** «dividi in fatture»
(riusa il flusso fattura elettronica esistente, una per voce). Registro transazioni con dettaglio, **annullo con
motivo obbligatorio** (storna ogni incasso collegato e l'eventuale credito; 409 se il credito è già stato speso) e
**ristampa ricevuta**. **Intestatario di famiglia predefinito** (`parents.intestatario_default`, sceglierne uno
azzera l'altro tutore) con **eccezione per-figlio** (`alunni.intestatario_fatture`) che **vince** e resta.

**Sospensione a livello famiglia v2 (S5).** Il flag vive su `alunni.sospeso` (+ `sospeso_causa` `morosita`|`altro`)
su **tutti i figli** del genitore moroso; attivazione manuale della Direzione. I guard risalgono ai figli
sull'**unione canonica dei legami** (`legame_genitori_alunni` + `student_parents` via ponte `parents.auth_user_id`):
il finding «un legame solo in `student_parents` sfugge al blocco» è chiuso. **Revoca automatica** quando **tutto lo
scaduto della famiglia è saldato** (solo causa `morosita`), agganciata a incassi/storno/transazione/credito/sconto/
PATCH + safety-net nel cron; **banner** esplicito al genitore. Matrice: bloccate adesioni avvisi, ordini divise,
tutti i moduli di tutti i sistemi **tranne** quelli col nuovo flag «essenziale salute/sicurezza: sempre firmabile»;
chat e comunica/giustifica assenza restano bloccate; **mensa via di mezzo** (prenotazione solo con credito ticket
già caricato, mai a debito). **Non** bloccati: locker, giustifiche didattiche, firme note/pagelle, certificati medici.

**Rette configurabili (S6).** `genera_rette_mensili` v2 (firma invariata → la CI degrada gratis) legge `rette_config`:
**sconto fratelli** (percentuale automatica sui figli in posizione ≥2, famiglie via unione legami) e **pro-rata solo
per iscrizioni tardive** (mai per assenze), a **soglie a scaglioni** sul giorno di `alunni.data_iscrizione`. Pannello
**«Rette»** nelle Impostazioni con anteprima; entrambi resi come `sconto` con motivo. Config vuota = comportamento
odierno. Chiuso il workaround rotto «tutto su un figlio, gli altri a 0» (lo 0 veniva NULLIF-ato).

**Solleciti schedulati (S7).** Accesa la schedulazione (`pagamenti_solleciti_tick()` pattern Vault +
`cron.schedule('…','0 6 * * *')`, sede prod `d53b0fbc`): livelli **1-2 automatici**, **3° manuale**. Il run
aggiorna gli stati e invia; anteprima obbligatoria invariata.

**Bonifica pre-lancio & migrazioni.** Bonifica dei dati esistenti (importi `<0` → 0, sovraincassi → contro-incassi
negativi) **tracciata** in `registro_modifiche`, niente cancellazioni mute, poi `CHECK (importo >= 0)` NOT VALID →
VALIDATE (mai un CHECK su `importo_pagato ≤ importo`: spill transiente + legacy). Migrazioni S2a/S2b/S7 applicate via
MCP (`sconto`, storno su `incassi`, `sospeso_causa`, `intestatario_default`, `rette_config`, `sempre_firmabile`,
`pagamenti_transazioni`, `crediti_famiglia`, `incassi.transazione_id`, `ricevute_emesse.transazione_id + righe`,
le due RPC, il cron); `ricalcola_stato_pagamento`/`ricalcola_stato_padre` sconto-aware **a firma invariata**.

**Nuove/aggiornate API** (tutte `withRoute` + `requireStaff` + `zod`): `POST/GET /api/pagamenti/transazioni`
(+`[id]`, `[id]/annulla`, `[id]/ricevuta`), `GET /api/pagamenti/famiglia`, `GET/POST /api/pagamenti/credito`,
`POST /api/pagamenti/incassi/storno`, `POST /api/pagamenti/[id]/sconto`; `incassi` POST con gate eccedenza→credito;
`[id]` PATCH con guardie importo/scadenza. **Logging**: successi espliciti (transazione registrata con conteggi/uuid,
storno, sconto/abbuono, credito utilizzato, revoca automatica) — i **motivi liberi vivono in `registro_modifiche`,
mai nei log**; nessuna chiave nuova in lista bianca (sono dati di minori).

**Decisioni.** Pagamento online in app (**PSP**): **fuori** da questo ciclo, resta in roadmap. Credito famiglia
**non visibile al genitore** (solo segreteria). «Scaduta» **derivata dalle date** ovunque. **Censite per il futuro**
(nota, non ora): pre-compilazione transazione dalla riconciliazione bancaria, rimborsi monetari veri (oggi coperti
da storno+credito), deposito cauzionale, registro cassa/prima nota, voucher/contributi comunali, chiusura esercizio,
eventuale visibilità del credito al genitore.

## 🗓️ Changelog — Igiene migrazioni (ledger↔file) + lock CI su SECURITY DEFINER 2026-07-18 (branch `fix/migrazioni-ledger-e-lock-secdef`)

Follow-up di igiene/sicurezza al changelog sottostante. **(1) Allineamento ledger↔file**: le 4 migrazioni del 2026-07-17 erano state applicate via MCP con version diversi dai nomi file (drift: file `20260717230000…230300` vs ledger di produzione `212758`/`212830`/`212832`/`212834`/`221651`). I file sono stati **rinominati ai version del ledger** e il file mensa **splittato in due** (`212758` RPC transazionale + `221651` revoke anon/authenticated) per il match 1:1 con lo storico di produzione, così `supabase db push`/`migrate.yml` non ri-applicherà nulla. Nessuna modifica al DB (già applicato). **(2) Lock CI** (`__tests__/architecture/security-definer-revoke-lock.test.ts`): fallisce se una migrazione introduce una funzione `SECURITY DEFINER` senza `REVOKE … FROM PUBLIC, anon, authenticated` — impedisce il ripetersi della regressione RPC mensa (in Supabase il `REVOKE … FROM PUBLIC` non toglie l'EXECUTE ad anon/authenticated). Allowlist documentata: `baseline` e `anagrafiche_residenza` (funzioni SECURITY DEFINER pre-esistenti, da rivedere prima del lancio).

## 🗓️ Changelog — Correzione findings collaudo E2E: sicurezza · morosità · avvisi · OTP · mensa · prodotto 2026-07-18 (branch `feat/collaudo-giornata-e2e`)

Correzione, via pipeline `/ship-cycle`, dei findings prodotti dalle due campagne di collaudo E2E qui sotto —
**escluse per scelta le voci di contabilità**. Esecutori paralleli su file disgiunti → 11 tester-opus → correzione
per **causa radice**; gate verde (`eslint` · `tsc` · `vitest` 2080 test · `build`), advisor Supabase **0 ERROR**.
Il collaudo del ciclo ha intercettato una regressione (RPC mensa eseguibili da `anon`: `REVOKE FROM PUBLIC` non
basta in Supabase) subito chiusa nel 2° giro.

**Sicurezza — gate applicativo** (le route usano service-role, la RLS è bypassata → il gate è l'unica difesa):
- `admin/documents-merge` GET → `requireStaff` (chiude il dump anonimo di CF/firme di classe).
- `diary/checkin` GET e `diary/entries` GET (ramo genitore) → `requireParentOfStudent` (chiude l'IDOR presenze e
  protegge la nuova nota per-bambino del diario).
- `fea/receipt` GET → identità sessione-first (`requireUser`, niente header `x-user-id`), deny-by-default se il
  firmatario è null o diverso dall'utente.
- `avvisi` GET ramo genitore → **server-derived** dalla sessione (ignora i parametri client), isolamento di plesso
  **fail-closed**; `avvisi/[id]/risposte` POST → `requireUser` + `genitoreHasFiglio` + `parent_id` di sessione
  (chiude la forgiatura di adesione/consenso gita), enum risposta `si`/`no`.
- `locker/inventory` POST → `requireParentOfStudent`; `locker/requests` PATCH → `requireDocente` + scope;
  `locker/materials` GET → `requireUser`.
- **Sospensione morosità** estesa a tutte le azioni di servizio del genitore (prenotazione mensa, moduli Sistema B,
  chat, adesione avvisi, comunica/giustifica assenza); le **letture** (diario, registro/presenze) restano sempre
  accessibili.

**Avvisi:** autore preso sempre dalla sessione (niente spoofing); avviso «classe» con classi vuote → 400; feed
genitore **unificato su tutti i figli**, con il nome del/i figlio/i su ogni avviso, adesione tracciata per-figlio.

**Firma OTP:** Sistema B con **consumo del ticket** (tabella `otp_ticket_consumati` → niente replay) + unicità
`(form_id, student_id)` sulle firmate (ri-firma vietata, 409); Sistema A con **scadenza OTP a 10 minuti**
(`form_submissions.otp_generato_il`).

**Mensa:** l'alert allergie raggiunge anche il ruolo `segreteria`; prenotazione/disdetta ticket **transazionale**
via RPC `scala_ticket_e_prenota` / `riaccredita_ticket_e_disdici` (SECURITY DEFINER, EXECUTE **solo** a
`service_role`; fallback pulito se la RPC manca).

**Prodotto:** diario 0-6 con nota di sezione (broadcast) **+** nota per singolo bambino (`eventi_diario.nota_bambino`,
solo al suo genitore); presenze primaria genitore con **riepilogo** (presenze/assenze/ritardi/uscite) oltre alla
lista; date dell'area primaria in **gg/mm/aaaa** (`DateField`) e `it-IT` nei `toLocaleDateString` della modulistica.

**Migrazioni** (via MCP, produzione): RPC mensa transazionali (+ `REVOKE` da `anon`/`authenticated`);
`otp_ticket_consumati` + indice unique parziale `forms_submissions(form_id,student_id) where is_signed`;
`form_submissions.otp_generato_il`; `eventi_diario.nota_bambino`. **Escluso** per scelta: **contabilità** (doppio
incasso, PATCH importi negativi, home «in regola»/`PagamentiSummary`, pagamenti accorpati, stato `scaduto` via cron).

---

## 🗓️ Changelog — Collaudo «360» E2E (armadietto · mensa · contabilità · modulistica · avvisi) 2026-07-17 (branch `feat/collaudo-giornata-e2e`)

Seconda campagna di collaudo end-to-end «l'agente si comporta come l'utente», su **produzione** (account/sezioni
**TEST**, tutto reversibile e ripulito), via **Chrome** + oracolo **DB** + **email reali** (kidville-mail MCP), con
corsia negativa `curl` anonimo. Cinque funzioni testate in ogni fattispecie (happy path, casi limite, negativi).
**Nessun codice di prodotto modificato** — è collaudo: produce findings. Report: `e2e/collaudo-giornata/run/report-giornata.html`;
elenco completo per la correzione: **`e2e/collaudo-giornata/FINDINGS-CORREZIONE.md`**.

**🔴 Bloccante**: `admin/documents-merge` ri-confermato live — dump di nome/cognome/**CF**/firme di un'intera classe
**senza auth** (nomi di bambini esposti). **🟠 Gravi**: `diary/checkin` IDOR e `fea/receipt` header `x-user-id`
ri-confermati; **NUOVI** `GET /api/avvisi?parentId=` (lettura feed avvisi senza auth) e `POST /api/avvisi/[id]/risposte`
(forgiatura adesione/consenso gita senza auth). **🟡 Medi (nuovi)**: doppio incasso accettato (`importo_pagato>importo`);
`PATCH` voce accetta importo negativo (arriva alla UI genitore come «€ -999»); **home «Pagamenti in regola» con €70
scaduti** (`PagamentiSummary` somma i residui senza clamp → un sovra-incasso maschera la morosità); **sospensione
morosità quasi inefficace** (guardia solo su moduli Sistema A; mensa/avvisi/Sistema B non bloccati); **OTP di firma FES
ripetibile entro 10′** (replay → firme duplicate); **alert allergie mensa non raggiunge il ruolo `segreteria`**;
spoofing autore avviso; avviso «classe» con classi vuote accettato; `locker/inventory|requests|materials` senza gate.
**🟢 Verificati OK** (doppio oracolo): ricarica/prenotazione/cutoff/allergeni mensa, acconto-su-scaduta-resta-moroso,
**sollecito con email realmente consegnata**, firma OTP end-to-end, adesione avvisi. «Pagamenti accorpati» inesistenti
(fratelli = voci separate, intestatario per-figlio).

## 🗓️ Changelog — Collaudo «giornata» E2E multi-ruolo su produzione: 3 vulnerabilità di sicurezza + findings 2026-07-17 (branch `feat/collaudo-giornata-e2e`)

Campagna di collaudo end-to-end «giornata simulata» eseguita da agenti-utente su **produzione** (app
nativa via Maestro su iOS+Android + cockpit), su account/sezioni **TEST**. Infra committata in
`e2e/collaudo-giornata/` (config personas, seed idempotente, report HTML con screenshot inline,
`seed/cleanup.sql`). Non modifica codice di prodotto: **produce findings** (dati TEST reversibili, tag
`[E2E-GIORNATA]`).

**🔴 3 vulnerabilità di sicurezza confermate (dati di minori) — CORRETTE nel changelog di correzione del 2026-07-18 in testa:**
- **F1 [BLOCCANTE]** `src/app/api/admin/documents-merge/route.ts:16-94`: dump di nome, cognome,
  **codice fiscale** e firme di un'intera classe **senza autenticazione** (nessun `requireStaff`;
  `createAdminClient()` bypassa la RLS). Confermato live con `curl` anonimo. Fix: `requireStaff` in
  testa alla GET.
- **F2 [grave]** `src/app/api/diary/checkin/route.ts:18-40`: `GET ?alunno_id=` anonimo → presenza e
  orario d'entrata di qualunque alunno (IDOR). Fix: `requireUser` + `assertAlunnoInScope`.
- **F3 [grave]** `src/app/api/fea/receipt/route.ts:71-87`: identità via header `x-user-id` accettata
  anche in prod (bypassa il sigillo `ALLOW_HEADER_IDENTITY`), scope saltato se `signerId` è null →
  ricevuta firmata di un altro genitore. Fix: `resolveIdentity` sessione-first + deny-by-default.
- **Positivo**: gli endpoint distruttivi (`wipe`/`seed-full`/`apply-*`/`debug-*`) sono **sigillati**
  in produzione (`sealDangerous()` → 404 prima di ogni operazione); RLS scoping genitore corretto
  (intersezione figli = 0); `ALLOW_HEADER_IDENTITY='false'` in prod.

**Findings di prodotto (non bloccanti, dati di minori — da valutare):**
- **Diario 0-6**: la **nota libera** di «salva merenda per tutti» viene scritta nel diario di **tutti**
  i bambini della sezione → la stessa nota è visibile a tutti i genitori (verificato: 10 righe
  `eventi_diario` con nota identica).
- **Presenze primaria**: la vista genitore espone **solo le assenze**; un bambino presente non ha
  alcun indicatore positivo (indistinguibile da «appello non ancora fatto»).
- **Registro primaria**: **date in formato US** (MM/DD/YYYY) invece di DD/MM/YYYY (bug it-IT).
- **Anagrafica**: **roster TEST 1A duplicato** (un nominativo con doppia grafia) → 12 alunni invece
  di 10 (dato sporco preesistente, da bonificare).

**Verificati end-to-end (UI + oracolo DB):** handshake Avvisi (segreteria→genitore, `avvisi_risposte`
letto+adesione), Diario (docente infanzia→genitore, `eventi_diario`), Presenze (docente→`presenze`).
Corsie native contro prod verificate: Android e iOS (`CAP_SERVER_URL=https://app.kidville.it`). Report:
`e2e/collaudo-giornata/run/report-giornata.html`.

## 🗓️ Changelog — Cockpit Direzione/Segreteria responsive per mobile: bottom-nav a pillola, topbar verde brand, Anagrafica a card 2026-07-17 (branch `feat/segreteria-mobile`)

Il re-skin del 2026-07-16 aveva portato l'area `/admin/**` (il cockpit Direzione & Segreteria) sul design dell'app, ma solo **su desktop**: sotto i 1024px la topbar restava bianca (badge K + hamburger → drawer laterale), non c'era bottom-nav né campanella, e le tabelle scorrevano orizzontalmente senza rifinitura. Questo intervento chiude il cockpit sul mobile allineandolo a genitore/docente, mantenendo l'impianto desktop appena rilasciato. Pipeline `/ship-cycle` (esecutori paralleli file-disgiunti a ondate → 11 tester-opus → correzioni per causa radice). **Intervento SOLO design per l'impianto: zero route API, zero DB, zero migrazioni, nessuna variabile d'ambiente** — la struttura dati/rotte e ogni testo utente restano invariati. I **micro-fix funzionali** ammessi (bug piccoli sulle pagine toccate) sono dichiarati sotto; i difetti strutturali pre-esistenti restano segnalati soltanto. Il perimetro condiviso (`BottomNav`/`TeacherBottomNav`/`AppBar`/`PageHeaderCard`/`HeroCard`/`Btn`/`Card`/`Badge`/`Modal`) **non è stato toccato**: la nav admin è codice nuovo che ne mutua il linguaggio, non il codice, così genitore/docente restano identici al pixel.

- **Bottom-nav mobile a pillola** (`AdminBottomNav`, `<lg`): stessa pillola bianca fluttuante della BottomNav genitore/docente, composizione decisa dall'utente — **Home · Avvisi · Contabilità · Mensa + «Menu»**. I 4 tab coprono le rotte ad alta frequenza (Home = `/admin` match esatto; Mensa acceso anche su `/admin/mensa/cucina`); il bottone **Menu** (`aria-haspopup="dialog"`, `aria-expanded`) apre il bottom-sheet con tutte le altre sezioni. Stato attivo con `aria-current="page"` calcolato da `activeHref` (match più lungo, sorgente condivisa) e **mutua esclusività** col Menu aperto (una sola voce accesa). Colori **solo via token** (`bg-kidville-green`/`text-kidville-yellow`, lock `design-tokens-admin` su `features/admin/**` verde), touch target ≥44px, `paddingBottom: max(12px, env(safe-area-inset-bottom))`, href con `?userId=` via `withUser` (identità cockpit two-pass SSR-safe → niente hydration mismatch).
- **Bottom-sheet «Menu» accessibile** (`AdminMenuSheet`): a differenza del vecchio drawer (non modale, senza focus-trap né Esc — warning del ciclo precedente), nasce **modale vero** — `role="dialog"` + `aria-modal="true"` + `aria-labelledby`, focus iniziale su «Chiudi», **focus-trap ciclico** (Tab/Shift+Tab), **Esc** chiude, **ritorno del focus** al bottone Menu, overlay click-chiude, `max-h-[70vh]` con scroll e safe-area bottom. Contenuto: **Anagrafica in evidenza** in cima, poi i gruppi (Didattica, Operativo, Amministrazione, Comunicazione, Sistema) filtrati per ruolo **escludendo** gli href dei 4 tab già in bottom-nav; in fondo i comandi Alto Contrasto e Logout. Il **gating per ruolo** riusa `visibleItem` della config condivisa (es. Registro protocolli riservato ad admin+segreteria) — è solo UI: il gate vero resta nelle API.
- **Config nav unica** (`admin-nav-config.ts`): estratti da `AdminSidebar` `NAV_GROUPS`/`ALL_HREFS`/`activeHref`/`visibleItem` come **sorgente unica** per le tre superfici (sidebar desktop, bottom-nav, sheet). `AdminSidebar` diventa **solo-desktop** (`<aside hidden lg:flex>`): perde la topbar mobile e il drawer (stato `mobileOpen`/`AnimatePresence` rimossi — niente codice morto), il `layoutId` framer della voce attiva resta solo qui.
- **TopBar mobile = barra verde del brand** (`AdminTopBarMobile`, `<lg`): sostituisce la topbar bianca con la stessa barra verde persistente dell'AppBar genitore/docente — **wordmark Kidville** bianco (`logo-light.png`, metrica AppBar, link home admin) + **campanella notifiche** (`AdminNotificationsPanel`). **Niente hamburger, niente badge K**: la navigazione è la bottom-nav. `sticky top-0`, gancio safe-area nativa (`.kv-appbar-admin` → `padding-top: env(safe-area-inset-top)` sotto `.cap-native`).
- **TopBar desktop rifinita al wordmark** (`AdminTopBar`, `≥lg`): badge K + span testuale → **wordmark** `logo-light.png` con la metrica dell'AppBar; ricerca e chip coerenti per altezze/raggi. `aria-label="Ricerca globale"` e i placeholder **invariati** (vincolo E2E `admin-search.spec.ts`).
- **Layout admin come shell** (`admin/layout.tsx`): wrapper con `data-kv-shell` (gancio safe-area), `AdminTopBarMobile` sopra `AdminTopBar`, `AdminBottomNav` in fondo, `<main pb-28 lg:pb-0>` per liberare lo spazio della bottom-nav flottante. Nessun `useSearchParams` nel layout → niente Suspense, inline su ogni route (anche le dinamiche `/admin/primaria/[sectionId]/*`, il cui **contenuto non è stato toccato**: la shell le incornicia soltanto).
- **Anagrafica a card sotto sm — dual render** (`StudentTable` + nuovo `StudentRowCard`): la `<table>` è avvolta in `hidden sm:block` con scroll rifinito; sotto sm compare una lista di **card** (`.kv-admin-rowcard`, stile `PagamentoCardMobile`) con gli **stessi identici dati** di riga (cognome+nome, classe/sezione o ruolo+sede staff, badge stato, triangolo note mediche/BES, contatti adulto), checkbox di selezione ≥44px e tap-card verso il dettaglio; ordinamento come select compatto sopra la lista (riusa `sortField`/`sortDir`). **Nessuna logica dati nuova** — a viewport desktop E2E la tabella resta visibile, nessun testo di riga sparisce.
- **Contabilità e Mensa marcate per l'Alto Contrasto**: le card mobile esistevano già (sotto lg/sm); ricevono il marker `.kv-admin-rowcard` (`PagamentoCardMobile`, card classe di `MensaReport`/`PrenotazioneSegreteria`) e touch target ≥44px sulle azioni, senza cambi di breakpoint né stringhe visibili (es. «Report cucina» identica). I marker `.kv-mensa-alt` e le regole HC mensa preesistenti restano intatti.
- **Scroll tabelle rifinito** (`.kv-table-scroll`): tutte le altre tabelle che tengono lo scroll orizzontale passano da `TABLE_WRAP` in `cockpit.tsx` (`kv-table-scroll overflow-x-auto`) con **indicatore di scorrimento CSS-only** (ombre-bordo) e `-webkit-overflow-scrolling: touch`. Troncamenti eventuali solo sotto sm (mai a viewport desktop E2E).
- **Alto Contrasto su tutte le superfici nuove** (`globals.css`, solo blocco `kv-admin-*` + aggiunte): il blocco HC `.kv-admin-topbar`, scritto per la barra bianca, è **riscritto** per la barra verde (fondo nero + inset ring, wordmark/campanella bianchi, via i selettori orfani del badge K); nuove regole `[data-contrast="high"]` per `.kv-admin-bottomnav` (pillola bianca bordo nero, attiva nera con icona gialla), `.kv-admin-sheet` (bianco, bordo/divisori neri) e `.kv-admin-rowcard` (bordo nero, badge a coppie esplicite). `@theme inline` inlinea gli hex nelle utility → la coppia HC va scritta a mano, superficie per superficie.
- **Collaudo mobile — flow Maestro aggiornati alla bottom-nav** (`android-`/`ios-percorso-segreteria.yaml`, README): il percorso non usa più il drawer («Apri menu» rimosso ovunque) ma la nuova nav — login → «Dashboard Direzione» → tab «Avvisi» → «Nuovo avviso» → back → «Mensa» → back → «Menu» → sheet → «Anagrafica» (in evidenza) → «Anagrafica Generale» → back. Selettori per testo italiano; Android contro `next start`, iOS con `--device <UDID>`.
- **Micro-fix funzionale dichiarato**: il dropdown della campanella notifiche (`AdminNotificationsPanel`) sborda a 320px → clamp `w-[min(340px,calc(100vw-24px))]` (unico ramo funzionale toccato, sulla stessa superficie del re-skin).

**Ciclo 2 di correzione** — il collaudo `/ship-cycle` (11 tester-opus) ha isolato **5 cause radice** su frontend/design/mobile-iOS/accessibilità, chiuse per causa radice a file disgiunti (perimetro invariato: nessuna route/logica/testo utente, nessun DB/migrazione/variabile d'ambiente):

- **Overflow Contabilità chiuso** (`/admin/pagamenti`): a 320-390px la vista sforava per una larghezza intrinseca non comprimibile. `ContabilitaNav` perde l'edge-bleed `-mx-4 … px-4` (ora `min-w-0 overflow-x-auto`); la `StatCard` (`cockpit.tsx`) riceve `min-w-0` sul contenitore radice e passa da `flex items-baseline` a `flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5` (valore € e sub vanno a capo invece di allargare la card); la griglia KPI da `grid-cols-2` fissa a `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`. Esito: `scrollWidth === innerWidth` a 320/390/768/1280, nessun importo clippato.
- **Campanella notifiche unica** (`AdminNotificationsPanel`): la campanella è montata due volte (topbar desktop + mobile, entrambe sempre nel DOM) → senza guardia fetch e poll a `/api/notifiche` raddoppiavano. Nuova prop `attivoSu` (media query) risolta con `useSyncExternalStore` su `matchMedia` (pattern idiomatico del repo, niente `setState` sincrono negli effect · react-hooks 7): la topbar desktop passa `(min-width: 1024px)`, la mobile `(max-width: 1023.98px)`, e fetch/poll partono **solo** sulla topbar effettivamente visibile → una sola chiamata per load e una per poll a ogni breakpoint (retro-compatibile: senza prop resta sempre attiva). Touch target campanella a **44px** (`h-11 w-11`) e **Esc** chiude il dropdown.
- **Stato attivo del Menu sulle sezioni dello sheet** (`AdminBottomNav`): quando la rotta corrente è una sezione dello sheet (es. `/admin/students`) e nessuno dei 4 tab è attivo, il bottone «Menu» ora si accende — `menuActive` = sheet aperto **oppure** (rotta ∈ voci sheet **e** nessun tab attivo) → pill `bg-kidville-green`, icona `text-kidville-yellow`, `aria-current="true"` a sheet chiuso (per la copertura HC); resta la mutua esclusività (una sola voce accesa) e `aria-expanded` legato al solo `menuOpen`.
- **Contrasti AA** (`AdminBottomNav`/`AdminMenuSheet`/`StudentRowCard`/`StudentTable`): i token decorativi usati come **testo** passano da `text-kidville-muted` a `text-kidville-sub` (label nav inattive, sottotitolo dello sheet, data/email/telefono/CF delle card anagrafica); nuovo token **`--color-kidville-success-strong`** (`#1B5E20`, ≈8:1 su `success-soft`; `#00E676` in Alto Contrasto) per il badge stato «iscritto», con `text-kidville-warn-strong` per «sospeso»/BES — **parità tra card mobile e tabella desktop** (stesso swap nella `getStatoBadge` di entrambe). L'occhiello (grabber) del bottom-sheet e le nuove superfici ricevono regole `[data-contrast="high"]` esplicite **estese** (`.kv-admin-bottomnav`: `sub`/`green` a nero; `.kv-admin-rowcard`: badge success/warn a coppie fondo-nero + colore-brand).
- **Scroll-lock del bottom-sheet** (`AdminMenuSheet`): a sheet aperto `body { overflow: hidden }` con ripristino nel cleanup (prima del ritorno del focus al bottone Menu) → lo sfondo non scorre più sotto il modale.
- **Title generico sull'indicatore allergie** (`StudentRowCard`): il triangolo note mediche mostra `title="Allergie/note mediche presenti"` — **mai** la nota grezza (dato sanitario di minore); la tabella desktop non espone la nota.
- **Selettori Maestro cross-platform** (`android-`/`ios-percorso-segreteria.yaml`): il passo Menu→Anagrafica usa ora regex **non ancorate** (`.*Alunni, famiglie e personale.*`, `.*Anagrafica.*`), che reggono sia il nodo Android separato sia il nodo iOS combinato senza rompersi.

**Log**: nessuno. Intervento presentazionale — nessuna route nuova (quindi nessun `withRoute`), nessun `catch`, nessun `console.*` in `src/`; il diff non rimuove log esistenti e il micro-fix del dropdown non introduce rami d'errore.
**Test**: nuovi file mirati — `admin-nav-config` (config/`activeHref`/`visibleItem`/gating), `admin-bottom-nav` (5 tab, `aria-current` sul solo attivo, Menu apre `dialog aria-modal`, gating Protocollo cuoca vs segreteria, Esc chiude, sheet senza gli href dei 4 tab), `admin-topbar-mobile`, `admin-layout-shell` (lock testuale `data-kv-shell`/`AdminBottomNav`/`AdminTopBarMobile`), `student-table-dual` (table sm:block + card sm:hidden con stessi dati, click/checkbox), `prenotazione-segreteria-design`; estesi `cockpit-primitives` (`TABLE_WRAP` = `kv-table-scroll`), `PagamentoCardMobile` e `mensa-report-design` (marker `.kv-admin-rowcard`). Ciclo 2: nuovo `admin-notifications-poll` (`attivoSu` non-match → 0 fetch, match/assente → 1 fetch, stub `matchMedia`); estesi `cockpit-primitives` (StatCard `min-w-0` + `flex-wrap` col `sub`), `admin-bottom-nav` (Menu acceso sulle sezioni sheet + mutua esclusività) e `student-table-dual` (badge «iscritto» `success-strong`, `title` indicatore ≠ `note_mediche`). Fixture finte, mai PII.
**Gate**: eslint **0** · tsc **0** · vitest **1994 / 251 file** verdi · build ok (`✓ Compiled successfully`, 294 pagine) · E2E in CI al push. Nessuna variabile d'ambiente nuova, nessuna migrazione.

## 🗓️ Changelog — Cockpit Direzione/Segreteria sul design dell'app: PageHeaderCard, HeroCard, pillole, bonifica hex 2026-07-16 (branch `feat/ship-cycle-superpowers`)

L'area `/admin/**` (il cockpit Direzione & Segreteria, ~28 pagine reali) era l'ultima superficie rimasta fuori dal re-skin dell'app: header a chip, tab sottolineate, dashboard con header animato bespoke (`AuroraHeader`) e punti fuori-token (hex cablati in form builder, graduatorie, grafici, Donut, pannelli impostazioni). Il PRD l'aveva **volutamente escluso** («Restano verdi: … cockpit admin», §Changelog 2026-07-12 tab gialla): quell'esclusione **decade con questo intervento**. Ora la segreteria è **visivamente lo stesso prodotto** di genitore e docente — stesso linguaggio «tab gialla + mascotte», stesse pillole, stessi raggi/ombre. Pipeline `/ship-cycle` (esecutori paralleli file-disgiunti a ondate per gruppo di navigazione → 11 tester-opus → correzioni per causa radice). **Intervento SOLO design: zero route API, zero DB, zero migrazioni, zero logica** — la struttura di navigazione (sidebar+topbar desktop, drawer mobile) e ogni testo utente restano invariati. I difetti funzionali pre-esistenti emersi in collaudo sono **segnalati soltanto**, non toccati (il re-skin non li può correggere senza uscire dal perimetro).

- **Un solo punto di cambio, header nuovo su tutte le ~28 pagine**: `PageHeader` (`src/components/ui/cockpit.tsx`) diventa un **adapter** su `PageHeaderCard` — la stessa card (tab gialla + mascotte, flag `TAB_GIALLO_OVUNQUE`) di genitore/docente. Firma invariata (`icon/title/subtitle/actions/eyebrow`; `eyebrow` di default «Direzione & Segreteria», specializzata per gruppo nav dalle ondate). Le `actions` **NON** finiscono nello slot `action` della card (pensato per UNA pill compatta e dentro il remap `.kv-tab-giallo`): si rendono in una **riga wrappabile `flex flex-wrap` SOTTO la card** — (a) ripristina il flex-wrap su mobile (sotto 1024px i bottoni non coprono più il titolo, il sottotitolo non va a una parola per riga, `/admin/protocolli` con 5 bottoni non deborda), (b) esce dal remap (niente CTA green-dark-su-verde 1,36:1), (c) libera lo slot `action` → **mascotte su TUTTE le pagine admin** (design scelto). Il CTA primario di quella riga usa la costante condivisa **`HEADER_BTN`** (bianco su verde ≈ **6,5:1**, AA), che sostituisce il pattern giallo-su-verde brand nei 6 header con azione (`avvisi`, `compiti`, `armadietto`, `protocolli` ×2, `students`, `modulistica`); `Btn`/`btnClass`/`BTN_PRIMARY` restano per drawer/modali. L'`<h1>` resta il `title` passato: i 7 spec e2e admin lo asseriscono con `getByRole('heading', { exact: true })` e restano verdi. `PageHeaderCard`/`HeroCard`/`HeroMascot`/`Btn`/`Card`/`Badge` e la BottomNav **non sono state toccate** (condivise, invarianti al pixel su genitore/docente).
- **Home admin: da `AuroraHeader` a `HeroCard`** (`admin/page.tsx`) come le altre home — saluto neutro per fascia oraria (calcolato client-side, hydration-safe) + data + mascotte a mezzo busto. Il testo esatto **«Dashboard Direzione» resta VISIBILE** come heading di sezione sotto la hero (vincolo e2e `admin-dashboard.spec.ts`); KPI/StatCard/Donut/Live/AlertPanel e i testi asseriti («Pagamenti scaduti», «Presenze in tempo reale», «Live · 60s», tile exact) invariati. `AuroraHeader` rimosso (non più referenziato). Reveal (`TiltCard`/`RevealGroup`/`AnimatedNumber`) conservati. L'**eyebrow** di sezione della dashboard è portato a **contrasto pieno** (`text-kidville-green/70`→`text-kidville-green`, ≈5,8:1 su crema) e la HeroCard riceve `loading` finché il saluto per fascia oraria non è calcolato client-side (anti pop-in, stesso pattern delle home genitore/docente).
- **Tab a pillole** (`cockpit.tsx` `Tabs`): da sottolineate a pillole (attiva verde-piena testo bianco, inattiva bianca con ring `kidville-line`), API `{value,options,onChange}` invariata, stato attivo esposto con `aria-pressed` e focus da tastiera sempre visibile. Le pillole ricevono **copertura Alto Contrasto** esplicita (marker `kv-cockpit-tabs` sul contenitore + regole `[data-contrast="high"]` in `globals.css`): attiva nero su giallo, inattiva bianco su nero bordato — `@theme inline` inlinea gli hex, quindi la coppia HC va scritta a mano. `ContabilitaNav` e gli hub a tab dell'admin ereditano il linguaggio; rifiniti anche `StatCard`/`Toolbar`/`CockpitSelect`/`Drawer` (raggi, focus-ring visibile, hover) senza cambiare API né semantica.
- **Sidebar/topbar/drawer re-skinnati** (`AdminSidebar`, `AdminTopBar`): struttura e UX intatte, voce attiva allineata alla BottomNav dell'app (pillola verde scura + icona gialla + label bianca, `layoutId` framer conservato); drawer mobile curato, hover/focus rifiniti, safe-area topbar mobile verificata.
- **Bonifica hex completa + LOCK architetturale**: tutti gli hex cablati dell'area cockpit (Donut `#EEF1EE`/mappa toni, palette Recharts di `DashboardCharts`, inline-style di `forms/builder`, medaglie di `forms/rankings/RankingTable`, `settings/ui.ts`, pannelli pagamenti…) migrati sui token o convogliati nell'**unico modulo-specchio** `src/lib/ui/chart-colors.ts` (documentato come MIRROR dei token: serve dove `var(--color-kidville-*)` non è affidabile — attributi SVG di Recharts, `<circle>` del Donut, inline-style delle medaglie, lezione «hex→var mai su base-di-concat-alpha»). Nuovo lock `__tests__/architecture/design-tokens-admin.test.ts` (sul modello di `logging-coverage`): vieta gli hex colore letterali in `src/app/(dashboard)/admin/**`, `src/components/features/admin/**` e `cockpit.tsx`, unica eccezione `chart-colors.ts`, con messaggio d'errore che elenca `file:riga`. `settings/ui.ts` verificato senza hex e senza `bg-white`/`text-white` nudi (che `@theme` non remappa).
- **Alto contrasto sulle superfici nuove** (`globals.css`, **solo aggiunte** nel blocco `[data-contrast="high"]`): `@theme inline` inlinea gli hex nelle utility → il remap dei token non le tocca. Regole esplicite per la nav laterale/drawer (`.kv-admin-nav`: voce attiva a pieno nero, icona gialla, hover bordato nero) e la topbar mobile (`.kv-admin-topbar`: verde→nera come `.kv-appbar`, wordmark/menu bianchi, badge giallo). La header card era già coperta da `.kv-header-card`/`.kv-tab-giallo`. Criterio: nessuna superficie toccata resta senza copertura HC; i buchi HC pre-esistenti non toccati restano warning.
- **Collaudo mobile — nuovo flow Maestro «percorso segreteria»** (`.claude/maestro-flows/android-percorso-segreteria.yaml`, `ios-percorso-segreteria.yaml`, README aggiornato): login `test.segreteria@kidville.test` → dashboard (hero) → drawer → Anagrafica → Avvisi → indietro. Selettori per testo italiano; a differenza di genitore/docente il cockpit **non ha bottom nav** su mobile, si naviga dal drawer laterale. Android contro `next start` (l'emulatore non idrata `next dev`).

**Log**: nessuno. Intervento puramente presentazionale — nessuna route nuova (quindi nessun `withRoute`), nessun catch, nessun `console.*` in `src/`; il diff non rimuove log esistenti.
**Test**: nuovi lock/spec di design — `design-tokens-admin` (divieto hex), `settings-sistema-design`, `cockpit-primitives` (adapter header + pillole), `header-cta-admin` (i 6 CTA header su `HEADER_BTN`, niente più giallo-su-verde), `admin-dashboard-hero` (HeroCard + heading «Dashboard Direzione»), `StudentTable-empty`, `pagamenti-contabilita`, `mensa-report-design` — che bloccano l'adapter, le pillole, gli stati vuoti e il divieto di hex.
**Gate**: eslint **0** · tsc **0** · vitest **1946 / 244 file** verdi (lock design-tokens e header-cta inclusi) · build ok · E2E in CI al push. Nessuna variabile d'ambiente nuova, nessuna migrazione. Collaudo `/ship-cycle`: **11/11 PASS al 2° ciclo**.

## 🗓️ Changelog — Fix import iscrizioni (provincia per esteso → 22001) e mensa genitore («Sessione non valida») 2026-07-16 (branch `feat/ship-cycle-superpowers`)

Due guasti raccolti sul campo, un solo branch, pipeline `/ship-cycle` (esecutori paralleli file-disgiunti). **Zero migrazioni**: entrambi i fix vivono nel codice applicativo e degradano in modo pulito sul DB E2E non migrato (PostgREST `PGRST204`/`42703`).

**1) Import «Modulo d'iscrizione standard» — la validazione dallo schema, finalmente applicata.** Il modello dichiara nei suoi campi `pattern`/lunghezze/`required` (`FormField.validation`), ma finora **nessuna** superficie li applicava: così una provincia scritta **per esteso** ("Caserta", 7 caratteri) attraversava tutto e faceva esplodere l'import in anagrafica contro le colonne `varchar(2)` con Postgres **22001 «value too long»**, mentre la UI segreteria diceva serenamente «Importata».

- **Sorgente unica di validazione, condivisa client/server**: nuovo `src/lib/forms/validate-fields.ts` (`validateField`/`validatePage`/`isProvinceField`) applica pattern, `min_length`/`max_length`, obbligatorietà e i controlli per tipo (email/data/numero/select-radio) dichiarati nello schema, con **messaggi in italiano** non tecnici (l'utente non deve mai leggere una regex). Non normalizza: valida e basta. È la sorgente unica usata **davvero** da tutte le superfici di compilazione — wizard pubblico `/iscrizione`, moduli genitore `/parent/forms`, link pubblico `/m/token` (tutte via `FieldRenderer`) — e dal server, così regole e messaggi vivono in un solo posto.
- **Cablaggio client nei wizard**: `FieldRenderer` applica `validateField` a ogni campo (messaggio visibile sotto il campo con `role="alert"`, `aria-invalid` + `aria-describedby`); i wizard (`EnrollmentWizard` sui template ripetibili N figli/adulti, `WizardContainer` sui moduli genitore e `/m/token`) **bloccano l'avanzamento** della pagina non valida e portano il **focus al primo errore**. Campi provincia: **auto-maiuscolo** in digitazione e **snap a sigla su blur** («Napoli» → «NA», mai troncature); un **400 dal server** viene mappato sui campi (stessa UI degli errori client, con salto alla pagina/istanza in errore) invece dell'alert generico.
- **Province a sigla**: nuovo `src/lib/anagrafiche/province.ts` — le **107** province / città metropolitane italiane attuali con `normalizzaProvincia()` (input libero → sigla ufficiale: "Napoli"/"na" → "NA"), `isSiglaProvincia()`, `PROVINCE`. Regola d'oro: **mai troncare o indovinare** — un input irriconoscibile torna `null` e il chiamante decide (segnalare, non salvare una sigla a caso).
- **Rete di sicurezza server-side nel `POST /api/iscrizione`**: il POST è pubblico, quindi qui c'è l'ultima difesa prima del DB. Ricarica i template child/adult del modello dal DB (fallback ai template in codice → degrado pulito sul DB E2E non migrato), **forza a maiuscolo e converte** le province a sigla, poi **ri-valida ogni record**: al primo campo non valido risponde **400** con la mappa `{ campi }` (gruppo/indice/id campo, **mai** i valori — sono dati di minori) e salva i dati già **normalizzati** (province a sigla). Log `warn` coi soli id di campo, mai i contenuti.
- **`PATCH /api/admin/iscrizioni` (import in anagrafica) — non mente più**: (a) **pre-flight province** che normalizza e valida **tutti** i record (adulti+bambini) **prima** di qualsiasi scrittura — una provincia irriconoscibile blocca l'import senza lasciare anagrafiche a metà; (b) **errori DB tradotti** in messaggi italiani per l'operatore (**22001** valore troppo lungo, **23505** duplicato, **23502** dato obbligatorio mancante), col messaggio grezzo tenuto **fuori** dai log (in `app_log` finiscono solo codice+campo); (c) distinzione **errori bloccanti** (impediscono l'approvazione) vs **warnings** (non bloccanti) e — cuore del fix — l'invio **NON viene più marcato `approved`** se il referente o anche **un solo figlio** non vengono creati: **resta `pending`**, torna tra i «Da importare», l'operatore corregge e riprova; (d) **dedup soft** per gli alunni senza codice fiscale (nome+cognome+data_nascita+scuola, guardia stretta con tutti e tre i campi) così il re-import dopo un fallimento parziale non genera doppioni (degrada su `42703` se la colonna manca in E2E).
- **UI segreteria (`ModuliRicevuti`)**: nuovo pannello d'errore **in evidenza** (bordo rosso, elenco «dove → messaggio») quando l'import torna `success:false`; il modulo resta selezionabile per riprovare, e il riquadro di successo compare solo su import completo. I due `console.error` sostituiti con `logClient` (una voce in meno in `eslint-suppressions.json`).

**2) Mensa genitore — via il «Sessione non valida» fantasma.** Causa radice: lo `studentId` in cache (`kv_student_id`) non veniva **mai** rivalidato. Dopo un cambio account senza logout, un deep-link vecchio o un alunno TEST ricreato, la pagina chiedeva le prenotazioni di un alunno non più tra i figli del genitore e il backend rispondeva un **403 deterministico**, mostrato come «Sessione non valida» — un vicolo cieco.

- **`useParentIdentity` rivalida l'identità figlio**: l'id «noto» (URL/localStorage) non è più preso per buono, ma **rivalidato** contro i figli reali del genitore (`/api/parent/students`) a ogni risoluzione. Se il noto non è tra i figli → pulisce la cache e passa al primo figlio (breadcrumb `warn` coi soli uuid); se la fetch fallisce → **degrada al noto senza toccare la cache** (un blip di rete non cancella una cache buona). La decisione è una funzione **pura** (`decidiFiglioRivalidato`) testata a parte; l'autorecupero vale ora per **tutte** le pagine genitore, non solo la mensa.
- **`MensaCalendar` distingue 401 da 403**: **401** = sessione scaduta → messaggio dedicato e bottone «Accedi di nuovo» verso `/auth/login`; **403** = alunno non collegato → **un** autorecupero automatico (pulisce `kv_student_id`, ri-risolve il primo figlio reale, ricarica), con guardia `recuperoTentato` contro i loop; se persiste, messaggio onesto («questo alunno non risulta collegato al tuo account, contatta la segreteria»). Classificatore **puro** `decidiAzioneMensaAuth(status, recuperoGiàTentato)`. Log `warn` (uuid genitore/alunno, mai nomi) su ciascun ramo — esattamente la traccia che avrebbe reso visibile il 403 ricorrente.

**Log aggiunti**: `iscrizione` → `warn` (campi respinti, solo id) e `info` (fallback template); `admin/iscrizioni` → `error` (provincia non valida, insert adulto/bambino fallito, import incompleto/bloccato) e `info` (dedup soft non disponibile); client → `logClient warn` (rivalidazione figlio, 401/403 mensa) e `error` (fallimenti fetch/import in `ModuliRicevuti`).

**Test**: 9 file nuovi, **82 casi** — `anagrafiche-province` (12), `forms-validate-fields` (20), `iscrizione` route (5, incl. rifiuto 400 provincia per esteso e salvataggio normalizzato), `iscrizioni-import-provincia` (4, incl. blocco pre-flight e stato che resta `pending`), `parent-identity-rivalidazione` (20, decisione pura + fetch + degrado offline), `MensaCalendar-auth` (7, 401 vs 403 + autorecupero + guardia loop), `FieldRenderer-validation`/`WizardContainer-validation`/`EnrollmentWizard-validation` (14, blocco avanzamento, snap provincia su blur, mappatura del 400 server sui campi).

**Gate**: eslint **0** · tsc **0** · vitest **1893 / 236 file** verdi · build locale ok · E2E in CI al push. Nessuna variabile d'ambiente nuova, nessuna migrazione.

## 🗓️ Changelog — Batch 15 fix da collaudo sul campo: multi-sede reale, alternativa mensa, spunte chat, mobile, sicurezza 2026-07-16 (branch `feat/batch-fix-multisede-mensa-chat`)

Quindici problemi raccolti usando l'app reale (web + native iOS/Android), risolti in un unico branch con la pipeline `/ship-cycle` (12 esecutori paralleli file-disgiunti → 11 tester-opus → correzioni per causa radice → **11/11 PASS** al 2° ciclo). Quattro migrazioni additive già applicate in produzione (advisor 0 ERROR).

**Fase A — otto fix puntuali**
- **Diario 0-6, evento bagno**: emoji vasino 🪣→🚽 (docente + genitore + config) e griglia dei tipi bagno da `grid-cols-3` fissa a `grid-cols-1 sm:grid-cols-3` con label testuale visibile solo impilata → niente overflow su schermi stretti.
- **Armadietto — «Registra Carico»**: lo stepper +/- va **di 1** (non più di 5), default 10 invariato, aggiunto input numerico per digitare la quantità (font-size inline ≥16px anti-zoom iOS).
- **Prospetto valutazioni primaria**: la media col filtro per materia divergeva dalla panoramica perché mediava **tutte** le modalità; nuova funzione pura `giudiziSintetici()` (`lib/primaria/media.ts`) usata da entrambi i rami → medie identiche. Lista per-obiettivo invariata.
- **Attestazione 730**: rimossa dal lato genitore (`StoricoPagamenti`); la route `GET /api/pagamenti/attestazione` passa da `requireUser` a **`requireStaff`** (la emette la segreteria su richiesta, via `FiscalePanel`). Ricevute/fatture del genitore intatte.
- **Appello 0-6 — rettifica**: i 3 bottoni di stato sono ora **sempre visibili** con `aria-pressed` (pattern dell'appello primaria); da «assente» si torna a «presente» (il server già supportava la correzione con revoca notifica entro il buffer di 10′). Via la X hardcoded che rimetteva sempre «assente».
- **Avvisi — badge classi**: una pill per ogni classe target (`bg-kidville-green-soft`) + pill «🌐 Tutti» per i globali → il docente con due classi capisce a colpo d'occhio dove è andato l'avviso.
- **Avvisi — gate docente (buco server chiuso)**: un educator poteva pubblicare `globale` (tutto il plesso) o a classi arbitrarie via API. Nuovo `verificaTargetAvvisoDocente` (`lib/avvisi/target-gate.ts`) applicato a POST e PUT: per gli educator rifiuta scope≠`classe`, classi vuote (footgun: `classe`+[] degradava a globale) e classi non proprie (`nomiSezioniDiUtente`) → 403 loggato. UI `AvvisoForm` con prop `soloClassiProprie` (niente toggle «Tutti», classi proprie preselezionate).
- **Mensa docente — report scoped**: l'educator è limitato alle proprie sezioni (`sezione ∈ nomiSezioniDiUtente`, 403 altrimenti).

**Fase B — strutturali**
- **Compiti/argomenti per singoli alunni (primaria)**: il docente sceglie «tutta la classe / alunni selezionati» per qualsiasi tipo di firma (prima solo il sostegno), riusando l'infrastruttura esistente (`registro_destinatari` + `firme_docenti.argomento_proprio/compiti_propri`); il genitore vede solo ciò che riguarda il figlio. **Difesa in profondità** (scoperta in collaudo): un'assegnazione mirata non deve mai toccare i contenuti condivisi di classe (`sopprimeCondivisi = haDestinatari` + i campi condivisi vuoti non sovrascrivono più), altrimenti azzerava argomento/compiti del titolare. `data_consegna_propri` rinviata.
- **Chat — spunta «consegnato»** (migrazione `chat_messages.delivered_at`): tre stati (✓ inviato · ✓✓ consegnato · ✓✓ letto giallo) con `aria-label`; helper `marcaConsegnati` con UPDATE **separato** dal mark-read (degrada da solo su DB E2E senza la colonna); realtime esteso agli UPDATE.
- **Mensa — alternativa per allergia**: il report giornaliero risolve ora il menu **per classe** (`resolveMenuConfigId`, prima ignorava `mensa_class_menu_assignment`) e per ogni prenotato con conflitto allergene↔menu emette «Alternativa per allergia per …» (automatica, zero storage). Nuova tabella `mensa_alternative` + route `GET/POST/DELETE /api/mensa/alternative` (segreteria) per l'alternativa **su richiesta del genitore**; il testo della richiesta non finisce mai nei log.

**Fase C — mobile & media**
- **Zoom tastiera iOS**: regola CSS non-layered `input,select,textarea { font-size: max(16px,1em) }` sotto `(hover:none) and (pointer:coarse)` (il desktop resta invariato) + `maximum-scale=1, user-scalable=no` iniettati a runtime **solo nella shell nativa** (il web conserva il pinch-zoom, WCAG 1.4.4).
- **Login fermo, niente striscia panna**: in app nativa il `padding-top: env(safe-area-inset-top)` sul body rendeva il documento più alto del viewport, scoprendo una striscia di un panna diverso. Ora sfondo unificato sul token `--color-kidville-cream`, `.page` che assorbe la safe-area (`margin-top` negativo su `html.cap-native`) e `overscroll-behavior: none` scoped al nativo.
- **Video HEVC**: sniff del codec (`lib/media/codec-sniff.ts`, container QuickTime / fourcc HEVC) → conversione **bloccante** (niente più fallback silenzioso all'originale non riproducibile su Android), con messaggio azionabile («iPhone → Impostazioni → Fotocamera → Formati → Più compatibile»); difesa server con **415** su `gallery/upload`; corretto anche il bug audio (i video convertiti uscivano muti).

**Fase D — multi-sede completo**
- **Provisioning reale** (migrazione `provisiona_sede` SECURITY DEFINER + riconciliazione idempotente): la UI «Gestione Multi-Sede» creava una sede solo nel registry `scuole`, scollegato dal tenant vero `schools` → sede fantasma. Ora `POST /api/admin/schools` crea `schools` + `scuole` con lo **stesso id** + `utenti_scuole` per gli admin; `GET /api/admin/sedi` esclude le sedi disattivate.
- **Coerenza filtri sede**: `resolveScuoleAttive` (rispetto del SedeSelector) portato su avvisi (ramo staff), diario, sezioni-primaria e presenze mensili (che prima non filtravano affatto per scuola).
- **Galleria isolata per sede** (migrazione `galleria_media_v2.scuola_id` + backfill): POST valorizza la sede, GET docente/genitore filtrano per plesso (prima i nomi-classe omonimi collidevano cross-tenant), con degrado pulito sul DB E2E non migrato.
- **Staff per sede**: verificato che il flusso reale (`StaffPanel` su `/admin/staff`) permette già di assegnare sede e classi; il componente orfano `AdultRegistryForm` resta dead-code (cleanup rinviato).

**Correzioni di sicurezza (2° ciclo — route toccate dal batch, chiuse su dati di minori)**
- `DELETE /api/gallery` non accetta più `?userId=` come identità (spoofing admin → `requireDocente`); `GET/POST /api/chat/messages` e `PATCH /api/chat/messages/read` ora hanno `requireUser` con verifica del partecipante **sempre** (prima la lettura senza `markRead` era libera, e `sender_id`/`userId` erano fidati dal body): IDOR e impersonazione chiusi, RLS a difesa in profondità verificata.

**Accessibilità (2° ciclo)**: contrasto del testo allergia mensa e delle label appello portato ≥4,5:1 (token `error-strong`/`warn-strong`/`sub`/`green`), override Alto Contrasto mirati per le schermate safety-critical, `role="alert"` e label associate nel form alternative.

**Gate finale**: eslint **0** · vitest **1810 / 227 file** verdi (14 test nuovi) · build ok · E2E in CI al push. Collaudo: 11 tester-opus (backend con sessioni reali, mobile-iOS e mobile-Android con percorso utente completo via Maestro su simulatore/emulatore, sicurezza/privacy/accessibilità/localizzazione). Flow Maestro committati riallineati alla UI reale.

**Follow-up dichiarati** (non bloccanti, pre-lancio): Alto Contrasto completo sulle utility Tailwind (sistemico: `@theme inline` inlina l'hex); `text-kidville-muted` dei timestamp su fondo chiaro (~2,5:1, pre-esistente); rimozione del componente orfano `AdultRegistryForm`; scoping chat per sede; `data_consegna_propri` per i compiti mirati; hardening `assertClasseNomeInScope` con verifica docente (4 route); alternativa mensa self-service lato genitore; vincolo `author_id = auth.user.id` negli avvisi educator; signed-URL sul bucket galleria. **Nota tecnica**: un `*/` nel testo di un commento CSS chiude il commento in anticipo — rompe Turbopack (dev) ma **non** `next build`; verificare sempre il dev server, non solo il build.

## 🗓️ Changelog — Batch: diario che scorre, foto private, anagrafica Staff viva, mensa allo sportello 2026-07-13 (branch `feat/batch-diario-galleria-staff-mensa`)

Quattro guasti indipendenti, un solo branch (spec completo in `docs/superpowers/specs/2026-07-13-batch-diario-galleria-staff-mensa-design.md`).

- **Diario 0-6 — la scelta dell'evento diventa una riga scorrevole** (docente + cockpit segreteria, componente condiviso `DiaryEventEditor`): via la griglia 3×N di tessere quadrate grandi, ora **card compatte 92px** a scorrimento orizzontale (scrollbar nascosta, snap, auto-scroll della selezionata). L'**indicatore di selezione** è un **bordo pieno verde dentro il bottone** + `aria-pressed` → visibile anche in **alto contrasto** (il colore da solo non bastava); **reduced-motion** rispettato (scroll-smooth via CSS, mai forzato in JS). Rimosso il componente legacy morto `StudentDiaryRow`. Nuovo test componente che blocca il contratto `aria-label "Registra <label>"` usato dall'E2E.
- **Galleria — l'upload docente non è più sempre rotto (DL-051/052)**: causa radice — `alunni.consenso_privacy` (la "liberatoria") nasce `false` e **nessuna API poteva impostarla** (il `PATCH` la scartava via zod, non era in `allowedFields`), quindi il server **422-ava ogni foto** con un taggato senza liberatoria mentre il tagging resta obbligatorio. Ora: **(a) regola "foto privata"** — un alunno **senza liberatoria è taggabile DA SOLO**, la foto resta visibile ai soli suoi genitori (filtro di visibilità esistente); la liberatoria serve solo per le **foto di gruppo** (>1 taggato), dove è richiesta a tutti; broadcast invariato e ora **riservato alla Direzione anche lato server** (conseguenza accettata: due fratelli entrambi senza liberatoria non stanno nella stessa foto). **(b) Toggle "Liberatoria foto/video firmata"** nella scheda alunno dell'anagrafica, persistito via `PATCH /api/admin/students` (`consenso_privacy` in schema + `allowedFields`, audit già presente). **(c) Errori parlanti** (422 coi nomi, il client mostra l'errore vero del server). **(d) MIME video normalizzato** (codec suffix vs allow-list bucket). **(e) Hardening gate**: `GET /api/gallery` mai più anonima (genitore → `requireParentOfStudent` col PROPRIO `parentId`; docente/staff → `requireDocente`), PATCH con identità **dal gate** (body `userId` ignorato), header `x-user-id` su tutti i call-site (incl. `syncEngine` offline). **Follow-up dichiarati**: bucket storage pubblico → signed URL; DELETE galleria ancora su identità legacy da query.
- **Anagrafica, tab Staff — non è più sempre vuota (DL-053)**: interrogava l'endpoint dei genitori filtrando su un workaround morto (ruolo in `citizenship`); ora legge da `utenti` via `GET /api/admin/staff` (**lettura estesa alla Segreteria**; scritture restano Direzione). Righe nella **stessa tabella** dell'anagrafica con colonne dedicate (Email/Ruolo/Sede/Classi, badge ruolo, niente bulk), ricerca funzionante, **export CSV** dedicato; nuova scheda `StaffDetailPanel` (dati + classi assegnate; modifica ruolo/sede/sezioni e **"Rigenera credenziali" SOLO Direzione**, server **403** come backstop). Pannello Gestione Staff: errori ora **visibili** (prima inghiottiti), azioni nascoste ai non-Direzione. E2E rafforzato (la tab Staff deve mostrare la docente E2E seminata). **Follow-up**: pruning `section_ids` al cambio sede.
- **Mensa, sportello segreteria — non è più 403 (DL-054)**: `STAFF_FORZA = admin|coordinator|segreteria` su GET/POST/DELETE di `/api/mensa/prenotazioni` → la Segreteria può **inserire pasti su chiamata fuori orario** (salta cutoff e vincolo saldo>0; il saldo può andare **negativo** → compare nei morosi; origine derivata server-side = `segreteria`; ledger `mensa_ticket_movimenti` tracciato) e **disdire oltre il cutoff** (anche date passate: rettifica con riaccredito, tracciata con `creato_da`/`creato_il`); `requireKitchenRead` ora include la Segreteria → il tab **Report Cucina** funziona (inserisci → controlli il report). Catena ticket verificata da test route-level (prenotazione genitore scala saldo+ledger; blocchi saldo 0/cutoff/non legato; multi-data con saldo parziale; disdetta riaccredita; segreteria forza a −1; report con gate reale). **Follow-up dichiarati**: atomicità saldo (read-then-write non transazionale → RPC futura), controllo errori di scrittura nella DELETE.
- **Convergenza con il logging strutturato (merge di `origin/main`, PR #24+#25)**: le 4 route del batch (galleria `POST`/`PATCH`, `gallery/upload`, mensa `POST`/`DELETE`) sono ora avvolte in `withRoute` come le altre 239; conflitti risolti preservando ENTRAMBE le funzionalità (skeleton loro + logica nostra ri-applicata: gate GET galleria, broadcast-Direzione, `STAFF_FORZA`, `LETTURA` staff, 403 credenziali-staff, `consenso_privacy`). **Appendice di osservabilità applicata** alle superfici nuove, seguendo la loro tassonomia: 422 privacy-lock → `logEvento('galleria','info')` coi **soli conteggi** (`taggati`/`senzaConsenso`, MAI nomi/id dei bambini); pubblicazione riuscita → `logEvento('galleria','info', esito:'pubblicata', nTag, broadcast)`; mensa prenotazione/disdetta → `logEvento('mensa','info')` con `esitiOk`/`esitiKo`/`saldoDopo`/`origine`; forzatura staff che porta il saldo in negativo → `logEvento('mensa','info', tipo:'saldo-negativo', alunno_id)` (uuid, in lista bianca). L'errore di upload storage era **già** coperto dalla loro strumentazione (`logErrore(evento:'storage')` in `gallery/upload`) → nessun doppione. `logOk`/`logEvento('route')` di `withRoute` restano la riga di esito per richiesta; gli eventi di dominio aggiungono i conteggi che quella riga non porta. Test estesi (`gallery-privacy`, `mensa-prenotazioni`) asseriscono le nuove chiamate **e la privacy** (nessun nome nel payload del log).
- **Gate** (dopo la convergenza): eslint **0** · tsc **0** · vitest **1684 / 213 file** verdi · build + E2E in CI al push.

## 🗓️ Changelog — Resend: il dominio `mail.kidville.it` verificato, l'email credenziali esce dalla sandbox 2026-07-13 (branch `fix/resend-from-mail-kidville`)

**Il seguito del guasto che il logging aveva portato a galla.** L'osservabilità aveva svelato il *perché* le credenziali non arrivavano (`403 the domain is not verified`); l'agenzia ha poi messo i record DNS. Ma il dominio su Resend è rimasto in stato **"Not Started" per 6 giorni**: i record c'erano ed erano propagati, semplicemente **nessuno aveva mai premuto "Verify"** nel pannello. Era quello, l'ultimo tassello.

- **Il dominio verificato è il SOTTODOMINIO `mail.kidville.it`, non il radice `kidville.it`** — come invece davano per scontato il codice e questo PRD (§S6bis e §Changelog 2026-07-06). Conseguenza operativa non negoziabile: **il mittente DEVE stare su `@mail.kidville.it`**; un `from` su `@kidville.it` è rifiutato con 403 anche a dominio verificato.
- **Diagnosi via DNS pubblico** (la chiave API di prod è send-only, non legge lo stato dei domini): la tripletta Resend è presente e propagata su Cloudflare e Google — DKIM `resend._domainkey.mail`, Return-Path MX `send.mail` → `feedback-smtp.eu-west-1.amazonses.com`, SPF `send.mail` → `include:amazonses.com`. Region **EU (Irlanda, `eu-west-1`)**.
- **Nessun disallineamento di account**: l'account Resend della `RESEND_API_KEY` di produzione è quello personale dell'amministratore (in sandbox), e `mail.kidville.it` è su *quello stesso* account — non su un account dell'agenzia. Identificato **senza login**, leggendo l'email dell'owner che Resend cita nel 403 di un invio-esca in sandbox.
- **Verifica completata**: premuto "Verify" → `DNS verified` → `Domain verified`. Ri-test di invio reale da `noreply@mail.kidville.it` → **HTTP 200** verso due caselle di prova dell'amministratore (le stesse davano 403 pochi minuti prima). La sandbox è superata.
- **Codice/config**: corretto il commento fuorviante di `src/lib/email/send.ts` (era `kidville.it`, ora `mail.kidville.it`, con data e vincolo del sottodominio); `.env.local` scommentato con `OTP_FROM_EMAIL=Kidville <noreply@mail.kidville.it>`.
- **Residuo operativo — necessario perché la PRODUZIONE ne benefici**: impostare `OTP_FROM_EMAIL="Kidville <noreply@mail.kidville.it>"` tra le env di **Vercel (Production)** e fare **redeploy**. Su Vercel la variabile **non esisteva affatto** (verificato con `vercel env ls`): finché non c'è + redeploy, la produzione resta sul fallback sandbox `onboarding@resend.dev` e le credenziali NON raggiungono i genitori reali. Nessun altro codice da toccare: `send.ts` legge già `process.env.OTP_FROM_EMAIL`.

## 🗓️ Changelog — Delegati al ritiro: via la sonda a una tabella morta, e la lista vuota smette di mentire 2026-07-13 (branch `fix/delegati-tabella-morta`)

**È il primo guasto trovato dal logging strutturato, poche ore dopo il suo rilascio** — e nessuno lo avrebbe mai visto altrimenti, perché la route *funzionava*.

- **Il rumore**: `GET /api/attendance/delegates` interrogava prima la tabella `delegati` (schema originale) e ripiegava su `delegates`. Ma `delegati` **non esiste più** (DB ripulito il 2026-07-04): PostgREST rispondeva 404, il codice ripiegava in silenzio, e l'utente non si accorgeva di nulla. Con il `fetch` strumentato, però, quel 404 scriveva una riga `livello=error` in `app_log` a **ogni chiamata** — rumore ricorrente proprio nel canale che serve a trovare i guasti veri. Sonda rimossa (era anche un round-trip in più a ogni appello, per una tabella che non tornerà).
- **La bugia**: l'errore della query su `delegates` veniva **scartato** dalla destrutturazione (PostgREST non lancia: ritorna `{ error }`), e la route rispondeva `[]` — cioè «nessun delegato» quando in realtà la lettura si era rotta. L'elenco vuoto **resta** (al ritiro è la direzione sicura: nessuno autorizzato, si chiama il genitore), ma ora la differenza fra «non ci sono delegati» e «non si è potuto leggere» esiste, ed è nei log.
- **Test**: nuovo `__tests__/api/attendance-delegates.test.ts` (3 casi: la tabella morta non viene più interrogata; il formato per il frontend è invariato; un errore di lettura si logga con l'errore VERO, non un riassunto). Verificato per mutazione: sul codice precedente diventa rosso. Gate: **eslint 0 · tsc 0 · vitest 1640 · build ok**.

## 🗓️ Changelog — Logging strutturato pervasivo: l'app smette di fallire in silenzio 2026-07-13 (branch `feat/logging-strutturato`)

**Perché.** Per mesi nessuna email di credenziali è arrivata a destinazione: il provider rispondeva `403` e il codice registrava il numero `403`, senza il corpo della risposta che diceva *perché* (`the domain is not verified`). Nessun test era rosso, nessuno se n'è accorto. Un codice che fallisce in silenzio è un codice rotto anche quando i test passano: questo lavoro rende osservabile ogni superficie che può fallire.

**Architettura** — `src/lib/logging/`, zero dipendenze esterne, due canali con vita e forma diverse:
- **Vercel Runtime Logs** (ritenzione 1 giorno): una riga `marker + logfmt` per richiesta (`KV_OK` / `KV_ERR` / `KV_WARN` / `KV_EVT`). Il marker è un token alfanumerico perché su Vercel la ricerca è full-text ed è l'unica àncora che sopravvive alla tokenizzazione.
- **Tabella `app_log`** (migrazione `20260713090000`, ritenzione 30 giorni, RLS deny-all + solo `service_role`, purge a lotti via pg_cron): la memoria lunga, interrogabile in SQL. Deduplica su `(fingerprint, giorno)` — il giorno sta nella *chiave*, non nell'impronta: `occorrenze` conta l'oggi, `group by fingerprint` ricostruisce la storia («è nuovo o va avanti da una settimana?»).

**Copertura, ottenuta da pochi colli di bottiglia**: `withRoute()` su **tutte le 239 route**; `fetch` strumentato su tutti i client Supabase (rende visibili le scritture il cui `catch` non scattava mai — PostgREST non lancia, ritorna `{ error }`); `parseBody`/`parseQuery` depositano il payload **già redatto** nel contesto; i gate depositano l'identità; `AsyncLocalStorage` correla tutto con un `requestId` che nasce nel middleware; `src/instrumentation.ts` è la rete di sicurezza per ciò che le route non vedono (render, Server Action, middleware); `src/lib/logging/client.ts` + `POST /api/logs` coprono browser e WebView nativa; le due error boundary loggano da sé (**obbligatorio**: con una boundary esplicita Next smette di chiamare `reportError()`, quindi `window.onerror` vedrebbe *meno* errori di prima — i due meccanismi non si sommano, si sottraggono).

**Nessun dato personale nei log.** La redazione (`redact.ts`) è a **lista bianca**: passano in chiaro solo uuid, numeri, booleani, date e le chiavi esplicitamente permesse (metadati di dominio: `tipo`, `esito`, `operazione`, `provider`…). Nomi, email e codici fiscali diventano un hash correlabile (fail-closed senza `LOG_HASH_SALT`: mai un hash debole). Testo libero, diagnosi, allergie, valutazioni, firme, OTP e password sono redatti. In più: i **path sono credenziali** in questo repo (`/m/<token>`, `?userId=`, `?email=`) e vengono ridotti a pattern ovunque compaiano — compreso l'header dello stack, che in V8 *è* il messaggio; e `sanificaMessaggio` maschera email e codici fiscali incorporati nel testo degli errori Postgres (`Key (email)=(…)`), che scavalcherebbero la redazione dal basso.

**Guasti silenziosi trovati e chiusi mentre si costruiva l'osservabilità** (nessuno di questi faceva fallire un test):
- **Le notifiche potevano sparire senza lasciare traccia**: `enqueueNotifiche` faceva `await supabase.from('notifiche').insert(...)` dentro un `try/catch` senza controllare il valore di ritorno. PostgREST non lancia: quando l'insert falliva non succedeva *niente* — nessuna eccezione, nessun log, nessuna notifica. Un genitore non avrebbe saputo della nota del figlio, del rifiuto della domanda, della mensa sospesa. Il log è ora sulla sorgente, con un test che sul codice precedente muore.
- **La revoca della notifica di assenza** non controllava l'errore: un genitore che aveva già comunicato l'assenza poteva ricevere lo stesso l'avviso di assenza non giustificata.
- **~40 `catch` non loggavano nulla** (29 in `admin/primaria`, i cinque `apply-*-migration`, `seed-full`, `backfill-auth`, e l'unico `catch {}` vuoto del repo, in `admin/wipe`).
- **49 rami `if (error)` di PostgREST che rispondono 500** non erano coperti da nessun log, proprio perché il `catch` attorno non scatta mai.
- **FCM** leggeva il corpo dell'errore e lo buttava (`fcm_http_400`); il `catch` finale di `sendNativePush` inghiottiva l'eccezione (una chiave PEM malformata dava zero push, zero log e un cron che si dichiarava a posto).
- **`getModuleConfig`** restituiva `{}` sia per «questa scuola non ha impostazioni» sia per «non si è potuto leggere»: il fail-open dei toggle notifiche si appoggiava su quel silenzio.
- **I 5 cron** ora battono all'avvio e alla chiusura (si sorveglia l'*assenza*: chiamati da pg_net in fire-and-forget, se non partono non arriva niente e quindi non si logga niente) — ma il battito, da solo, avrebbe **mentito**: le `SELECT` non controllavano l'errore, quindi su query fallita il codice cadeva nel ramo «zero elementi» e avrebbe scritto `esito=ok, inviate=0`. Tutte le 14 query dei 5 file ora controllano `{ error }`, escono con 500 e non emettono il battito di successo.

**Igiene**: `no-console` è `error` su `src/` (eccezioni: il logger stesso, il middleware e l'instrumentation, che girano dove il logger non è caricabile); i 108 `console.*` legacy di componenti e pagine sono in baseline di soppressioni (`eslint-suppressions.json`): non se ne aggiungono altri.

**Lock in CI** — `__tests__/architecture/logging-coverage.test.ts`: ogni export HTTP è avvolto, ogni `catch` logga, e il **nome** passato a `withRoute` corrisponde alla posizione reale del file (un nome copiaincollato non rompe niente e non si vede: produce una colonna `operazione` che *mente*, ed è peggio di una colonna che manca, perché ci si crede).

**Collaudo live** (dev, solo dinieghi e letture): cron con secret errato → `401` + `KV_ERR evt=cron esito=secret-errato`; `POST` anonimo sullo stesso cron → `401` e **nessun** falso allarme; `/api/me` senza sessione → `401` con `x-request-id` in risposta che correla con la riga di log; `POST /api/logs` → `{ok:true, ricevuti:1}`. Zero password, zero email, zero token nelle righe emesse. Gate: **eslint 0 · tsc 0 · vitest 1637 · build ok**.

**Aperto (operativo, prima del rilascio)**: applicare la migrazione `20260713090000_app_log.sql` in produzione (finché non c'è, il circuit breaker si apre su `PGRST202` e i log restano solo su Vercel — comportamento voluto, ma va chiuso) e impostare `LOG_HASH_SALT` su Vercel (`openssl rand -hex 32`, tutti gli ambienti): senza, ogni identità esce come `[redatto]` e la correlazione è persa.

## 🗓️ Changelog — Identità genitore completa alla creazione + invio credenziali auto-riparante (S6bis) 2026-07-12 (branch `fix/identita-genitore`)

- **Problema segnalato**: creando un'anagrafica genitore e provando a inviare le credenziali, la Segreteria riceveva `409 "Genitore senza account auth: eseguire prima il backfill (S6)"` — un vicolo cieco: la route del backfill in produzione risponde 404 by design (`sealDangerous`), e comunque NON creava la riga `utenti`, indispensabile (senza, il login riesce ma ogni route dati risponde 401 "Utente non trovato" perché `loadAppUser` legge solo `utenti`).
- **Causa radice**: l'identità di un genitore vive in 4 record senza alcun automatismo che li allinei (zero trigger su `auth.users`, verificato): `auth.users` + `utenti` ruolo genitore + ponte `parents.auth_user_id` (UNIQUE) + legame col figlio. Ogni flusso ne creava un sottoinsieme diverso: anagrafica (`linkOrCreateParent`) solo `parents`+legame; approvazione iscrizioni auth+`utenti` ma senza ponte (genitore che entra e non vede i figli) e con upsert `utenti` **rotto in prod** (colonna `password_segreta` inesistente → PGRST204 silenzioso) e capace di sovrascrivere il ruolo di uno staff omonimo; backfill S6 auth+ponte ma senza `utenti`.
- **Fix — nuovo modulo unico `src/lib/auth/parent-identity.ts`** (`ensureParentIdentity`, idempotente, non lancia mai): crea/riusa l'account per email (dedup, scansione paginata), scrive il ponte (23505 → messaggio parlante "email già di un'altra anagrafica"), garantisce la riga `utenti` ruolo `genitore` SOLO se manca (un docente-genitore conserva il ruolo staff; `email/nome/cognome/scuola_id` NOT NULL rispettati, colonne generate mai scritte). Innestato in:
  - `linkOrCreateParent` (anagrafica: POST `/api/admin/parents` e POST `/api/admin/students`): ogni genitore con email nasce con identità completa (best-effort + audit `credenziali`; i record-staff della tab Staff esclusi);
  - `POST /api/admin/regenerate-credentials`: **auto-riparante** — completa i pezzi mancanti e procede; il 409 S6 non esiste più (rimpiazzato da 400 "senza email" azionabile, 409 conflitto email, 500). Risposta con `identita_creata`;
  - approvazione iscrizioni (`/api/admin/iscrizioni`): identità completa per il referente (ponte incluso), niente più `password_segreta`, ruoli staff mai sovrascritti;
  - backfill S6 (`backfillParentsAuth`): ora crea anche `utenti` (report `utentiCreated`).
- **Rimosso codice morto pericoloso**: azione `invite` di `/api/admin/parents` (creava `auth.users` orfani senza ponte né `utenti`) + `ParentRegistryForm.tsx` (mai importato).
- **Dati prod riparati** (script una tantum `scripts/repair_parent_identities.mjs`, dry-run + apply): le 2 anagrafiche reali interessate hanno ora identità completa (account+profilo+ponte) e le credenziali sono emettibili. Le 10 "Madre* Test PRI" sono risultate **DOPPIONI del seed** (stesse email dei gemelli "GenitoreN Test PRI" già funzionanti): il vincolo UNIQUE sul ponte le ha correttamente bloccate — restano anagrafiche senza accesso, eventuale pulizia da decidere. 1 anagrafica senza email esclusa. Nessuna email inviata dallo script. (Nessun dato personale nel repo: i dettagli dei casi restano nell'audit a DB.)
- **EMAIL CREDENZIALI SEMPRE AUTOMATICA + motivo dei fallimenti (stessa giornata)**: scoperto via audit (`emailed:false` su TUTTI i tentativi storici) che **l'email credenziali non è mai stata consegnata a genitori reali**: il mittente è il sandbox `onboarding@resend.dev` e **il dominio kidville.it non è mai stato verificato su Resend** → Resend consegna solo al titolare dell'account e rifiuta gli altri destinatari con 403 (la chiave API prod è send-only: la verifica va fatta dal pannello Resend + 3 record DNS su Serverplan, che NON toccano le caselle esistenti; poi `OTP_FROM_EMAIL="Kidville <noreply@kidville.it>"` in Vercel). Interventi: (1) `sendEmailDetailed` in `src/lib/email/send.ts` legge e propaga il corpo dell'errore Resend (prima si loggava solo lo status); (2) **invio automatico delle credenziali alla creazione anagrafica** in `linkOrCreateParent` per ogni account appena creato (tutte le vie: anagrafica genitore, alunno+genitori, iscrizioni già coperta) con esito in audit (`emailed`/`emailError`) e nella risposta (`credenziali_email`); (3) warning veritieri ovunque (via il fuorviante "provider non configurato"); (4) UI FamilyRegistryManager: riepilogo per-genitore dell'esito invio + toast sui fallimenti.
- **Test**: nuovo `__tests__/lib/parent-identity.test.ts` (13 casi: idempotenza, conflitti, fallback mono-sede, ruolo staff preservato, client monco); nuovo `__tests__/lib/email-send.test.ts` (motivo del provider propagato, caso sandbox 403); nuovo `__tests__/lib/anagrafiche-parents-credenziali.test.ts` (invio automatico: inviata/rifiutata/riuso/senza email/staff); aggiornati `regenerate-credentials.test.ts` (auto-riparazione al posto del 409, warning col motivo) e `backfill-parents.test.ts` (riga `utenti`).

## 🗓️ Changelog — 🎉 PUSH NATIVA COMPLETA su iOS **E ANDROID** 2026-07-12 notte (branch `fix/apns-collaudo`)

### Android — collaudo superato su emulatore
- **APK compilato** (`assembleDebug`, 7,7 MB) con `CAP_SERVER_URL=https://app.kidville.it` (punta alla PROD) e installato sull'AVD `Medium_Phone_API_36.1` (API 36, con Play Services). **JDK 21 obbligatorio**: usare quello incluso in Android Studio (`/Applications/Android Studio.app/Contents/jbr/…`) — il JDK di sistema è il 25 e Gradle non lo digerisce.
- **Catena verificata end-to-end**: login in app → **token FCM `android` registrato** in `push_subscriptions` (auto-registrazione + permesso runtime Android 13+) → riga in `notifiche` → `notifiche_dispatch_tick()` → dispatch prod → **`{native_inviate: 2}`** (iOS+Android insieme) → **notifica nella tendina Android** → **tap = deep-link corretto**: app aperta sulla pagina **Avvisi**, badge campanella a 2. ✅
- **Fix applicato**: mancava il **canale notifiche di default** (FirebaseMessaging avvisava `Missing Default Notification Channel metadata` e usava un canale di ripiego) → aggiunta `meta-data com.google.firebase.messaging.default_notification_channel_id` in `AndroidManifest.xml` + stringa `kidville_notifiche`. Verificato: avviso sparito.

### iOS — APNs collegata

- **APNs Auth Key creata e collegata**: iscrizione Apple Developer Program attivata (team **`B5ULCGG2V3`** — è il team personale *promosso a pagamento*, NON il `6B67YBF64P` che appariva negli errori di propagazione). Key **`G2XN848ZNY`** («Kidville Push», ambiente **Sandbox & Production**, Team Scoped) creata su developer.apple.com e caricata su **Firebase → Cloud Messaging** su ENTRAMBE le righe (sviluppo + produzione) dell'app `it.kidville.app`. Il file `.p8` è in `~/.kidville/` (fuori dal repo, non ri-scaricabile da Apple).
- **Collaudo end-to-end SUPERATO** (simulatore iPhone 17 Pro, Apple Silicon): (1) invio diretto FCM v1 → **HTTP 200** (prima: 401 `THIRD_PARTY_AUTH_ERROR`) e **banner realmente consegnato** sulla lock screen; (2) flusso di **PRODUZIONE completo**: riga in `notifiche` → `SELECT notifiche_dispatch_tick()` (pg_cron) → pg_net → `https://app.kidville.it/api/push/dispatch` → risposta **`{native_inviate: 1}`** → notifica sul dispositivo + badge campanella a 1 nell'app. La catena DB → cron → dispatch → FCM → APNs → iPhone è verificata in ogni anello.
- **Gotcha registrato**: il token FCM è stabile, ma la mappatura FCM↔APNs si aggiorna solo quando l'app chiama `registerForRemoteNotifications` — che nel nostro flusso avviene **dopo il login** (`NativePushAutoRegister`). Se l'app resta sulla schermata di accesso, FCM accetta il messaggio (200) ma APNs non lo consegna: nei collaudi va sempre fatto prima il login.
- **Restano** (fuori dal perimetro push): collaudo Android su emulatore/device (config già completa) e pubblicazione sugli store.


## 🗓️ Changelog — Loader di pagina: comparsa "solo sui caricamenti lenti" 2026-07-12 (branch `feat/loader-slow-loads`)

Ritocco al comportamento del loader globale ([[loader]] `GlobalLoader`): oltre all'anti-flash già presente (niente loader sotto ~180 ms, quindi le navigazioni istantanee restano pulite), quando l'overlay **compare** su un caricamento lento ora resta a schermo per una **durata minima di ~0,7 s** (`MIN_VISIBLE_MS`). Prima spariva appena la pagina era pronta → mostrava solo un frammento del riflesso, praticamente invisibile; ora sui caricamenti realmente lenti è ben visibile. L'avvio dell'app resta invariato (visibile solo se il boot è lento). Gate: **eslint 0 · vitest 1065 · build ok**.
## 🗓️ Changelog — Cron prod risvegliati (Vault) + env Vercel complete 2026-07-12 sera (branch `fix/docente-primaria-home`)

- **Scoperta**: TUTTI i cron pg di produzione (notifiche-dispatch 5′, mensa-allergie 07:00, fatture-SDI 30′) erano **no-op silenziosi dal reset DB del 2026-07-04**: le GUC `app.*` non erano mai state riconfigurate e su questo progetto `ALTER DATABASE … SET app.*` è **negato anche al ruolo postgres** (42501, pure dal SQL editor). Da qui il backlog di ~530 notifiche mai spedite (drenato in collaudo).
- **Fix strutturale (migr `20260712220000_cron_config_vault`, applicata in prod)**: helper `public.cron_config(nome)` che legge da **supabase_vault** (fallback GUC), `REVOKE` da anon/authenticated (restituisce segreti); le 4 funzioni tick (dispatch, promemoria, mensa, fatture) ora passano da lì. Valori inseriti una tantum nel Vault (`app.cron_secret`, `app.push_dispatch_url`, `app.notifiche_promemoria_url`, `app.mensa_allergie_url`, `app.fattura_sync_url` → dominio prod **`app.kidville.it`**); mai nel repo. Cron `notifiche-promemoria` schedulato (06:00 UTC). `genera_solleciti` conserva il nudge GUC inline (non schedulata; copre il dispatch dei 5′).
- **Env Vercel COMPLETE** (erano solo 5): aggiunte le 9 mancanti — VAPID (3), `CRON_SECRET`, `RESEND_API_KEY`, `NEXT_PUBLIC_APP_URL=https://app.kidville.it`, `FCM_*` (3) — Production+Preview, redeploy eseguito. **Verifica end-to-end prod**: `SELECT notifiche_dispatch_tick()` → pg_net → `https://app.kidville.it/api/push/dispatch` → **HTTP 200 success:true**. Web push e email prod ora operativi; push nativa iOS in attesa SOLO della APNs key: l'iscrizione Apple Developer è stata pagata, team a pagamento **`6B67YBF64P`** in propagazione ("Unable to find a team…", si sblocca a attivazione completata — poi: key APNs + upload Firebase + switch signing Xcode dal personal team B5ULCGG2V3 al 6B67YBF64P).

## 🗓️ Changelog — Push iOS: hook nativi mancanti + «Traduci» solo quando serve 2026-07-12 (branch `fix/docente-primaria-home`)

- **Diagnosi push native dal simulatore** (0 righe in `push_subscriptions`): la registrazione del token non è mai partita perché sul lato nativo iOS mancavano tre pezzi. Fix: (1) **`AppDelegate.swift`** — aggiunti gli hook `didRegisterForRemoteNotificationsWithDeviceToken`/`didFail…` OBBLIGATORI per Capacitor (senza, l'evento `registration` non scatta mai) + integrazione **Firebase Messaging gated** (`#if canImport(FirebaseMessaging)` + check `GoogleService-Info.plist` a runtime: compila e funziona anche prima di aggiungere il pacchetto; con Firebase attivo consegna al plugin il token FCM richiesto dal server, non l'APNs grezzo); (2) **capability Push** — creato `ios/App/App/App.entitlements` (`aps-environment`) + `CODE_SIGN_ENTITLEMENTS` nel pbxproj; (3) **`presentationOptions`** (badge/sound/alert) in `capacitor.config.ts` — senza, iOS sopprime il banner ad app aperta. Android era già pronto (build.gradle gated su `google-services.json`).
- **Restano gate di provisioning** (non di codice, checklist in `docs/mobile.md`): progetto Firebase (`GoogleService-Info.plist` + pacchetto SPM `firebase-ios-sdk` da Xcode, `google-services.json` per Android), APNs Auth Key caricata su Firebase, env `FCM_*` sul server. ⚠️ Le push remote sul **simulatore** iOS funzionano solo su Mac Apple Silicon (Xcode 14+): il collaudo affidabile è su device reale.
- **Chat «Traduci» (DL-042) solo quando serve**: il pulsante compariva su OGNI messaggio in arrivo; ora compare solo se una delle due lingue non è l'italiano — messaggio che non sembra italiano (mittente straniero) oppure dispositivo del lettore non italiano. Euristica client-safe `src/lib/translate/lingua.ts` (`sembraItaliano`: alfabeti non latini, stopword italiane, corto-circuito su emoji/parole corte) + 5 vitest.
- **Provisioning Firebase COMPLETATO** (stessa giornata, in autonomia via browser): progetto Firebase esistente **`kidville-registro-elettronico`** riusato; app iOS+Android registrate (`it.kidville.app`), `GoogleService-Info.plist` nel bundle (Resources) e `google-services.json` in `android/app/`; **pacchetto SPM `firebase-ios-sdk` (12.x, prodotto FirebaseMessaging)** agganciato al target App direttamente nel pbxproj (⚠️ l'oggetto `XCSwiftPackageProductDependency` va DEFINITO, non solo referenziato: xcodebuild ignora silenziosamente i riferimenti pendenti); service account → env `FCM_*` in `.env.local` (chiave privata in `~/.kidville/`, MAI nel repo). **Collaudo su simulatore (Apple Silicon)**: permesso concesso → token FCM (`…:APA91b…`) registrato in `push_subscriptions` ✅; dispatch → OAuth 200 → chiamata FCM v1 ✅; banner in foreground verificato con `xcrun simctl push` ✅. **Unico anello mancante: la consegna FCM→APNs** (`THIRD_PARTY_AUTH_ERROR`): la APNs Auth Key richiede l'**iscrizione all'Apple Developer Program** (99 €/anno — l'account attuale non è iscritto, "Access Unavailable"). All'iscrizione: creare la key su developer.apple.com → Certificates → Keys → caricarla in Firebase → Cloud Messaging (Team ID `B5ULCGG2V3`). Android è già completo (manca solo il collaudo su emulatore/device). NB: il primo dispatch con FCM attivo ha drenato il backlog storico di notifiche mai inviate (marcate senza push, comportamento previsto).

## 🗓️ Changelog — Centro notifiche genitore/docente + push native + 26 trigger con toggle 2026-07-12 (branch `fix/docente-primaria-home`)

- **Campanella = centro notifiche** per genitore E docente: `NotificationsPanel` condiviso in `src/components/features/shell/` (porting del pannello admin) — badge non lette, dropdown ultime 20, poll 60″, segna letta/tutte, deep-link, footer «Tutti gli avvisi». La campanella non è più un link a `/avvisi`; **il badge cambia semantica**: da "avvisi non letti" (solo genitore) a "notifiche non lette" (entrambe le aree); `useAvvisiUnread` eliminato. Gli avvisi confluiscono nel feed (trigger `avviso`) → niente doppio conteggio.
- **Toggle per tipo** (decisione utente: «notifiche per qualsiasi cosa, ogni funzione attivabile/disattivabile dalle impostazioni»): colonna `admin_settings.notifiche_config` (`{toggles:{tipo:bool}}`, assente=attiva, migr `20260712180000`), catalogo canonico di **39 tipi** in `src/lib/notifiche/tipi.ts` (gruppi genitore/docente/staff, flag `sicurezza` con warning), pannello **Impostazioni → Notifiche**, gate server `isNotificaAbilitata` (cache 60″, **fail-open**: colonna mancante su DB E2E CI → tutto attivo) applicato nel punto di strozzatura `enqueueNotifiche(scuolaId)` + percorsi diretti mensa. `segreteria_scrittura` in **AND** col toggle storico `segreteria_config.notifica_docente`.
- **Push native iOS/Android end-to-end**: auto-registrazione token FCM/APNs al primo accesso autenticato nella shell Capacitor (`NativePushAutoRegister` nei layout parent/teacher — prima solo dal bottone pagamenti) + **deep-link al tap** (`pushNotificationActionPerformed` → `data.url`, solo percorsi interni). Egress reale ancora gated dalle env `FCM_*` (Firebase/APNs, checklist ops `docs/mobile.md`); web push VAPID già attivo.
- **Nuovo layer trigger** `src/lib/notifiche/`: `destinatari.ts` (genitoriDiAlunni/Classi/Scuola via `legame_genitori_alunni`, staffScuola role|ruolo, controparteThread, scuolaUnicaReale) + `triggers.ts` (`notificaEvento`: toggle → destinatari → debounce per tipo+entita_id → enqueue, sempre best-effort).
- **16 trigger nuovi lato genitore**: avviso/consenso uscita/modulo da compilare (UN solo enqueue con tipo per priorità — mai doppioni), chat (corpo senza testo, privacy), nota 0-6 (stesso toggle primaria), compiti 0-6 (solo se compiti presenti, debounce per sezione), **assenza all'appello** (primaria SOLO se non comunicata — incrocio `giustificata/giustificata_da` sullo snapshot pre-upsert; 0-6 sempre, testo neutro — decisione utente; buffer 10′ = finestra correzione, assente→presente **revoca** la pending), giustifica vista, richiesta armadietto (cron), nuova retta/rata (1 notifica per genitore, rispetta `visibile_dal`), incasso/acconto registrato, sospensione morosità (testo neutro, anche riattivazione), ricarica ticket, modulo promemoria (cron), galleria (debounce 30′ per uploader), esito iscrizione (accolta→referente, respinta→match email best-effort).
- **8 trigger lato docente**: chat dal genitore, assenza comunicata, giustifica ricevuta (OTP + didattica), firma FEA ricevuta (nota 0-6/primaria → autore; pagella → docenti sezione), risposte avvisi (all'autore, solo prima lettura/risposta, riassuntiva 60′), incarico assegnato, scritture segreteria e scorte armadietto (esistenti, ora gated).
- **Staff/segreteria**: modulo compilato (entrambi i sistemi form, riassuntiva 60′), nuova pre-iscrizione, onboarding completato, allergie cambiate dall'anagrafica → cuoca (buffer 0), documenti in scadenza (vedi sotto), fattura scartata/credenziali/mensa (esistenti, gated).
- **Cron promemoria giornaliero**: `POST /api/notifiche/promemoria` (`x-cron-secret`; tick pg `notifiche_promemoria_tick()`, schedulazione prod da SQL editor documentata nella migration) — (1) moduli non compilati dopo N giorni (`modulistica_config.promemoria_giorni`, ora attivo: tolto ComingSoon; dedup interrogando `notifiche`), (2) richieste armadietto pending (`reminder_inviato_il`; sostituisce la edge fn `locker-reminder` che simulava soltanto), (3) documenti in scadenza ≤30gg → segreteria (**sostituisce la edge fn `document-expiry-alert`, rotta da sempre**: insert con colonne inesistenti).
- **Test**: 25 vitest nuovi (config fail-open/cache/alias, gating enqueue, notificaEvento/destinatari, transizioni appello) + spec Playwright `notifications-panel.spec.ts` (genitore+docente, seed notifiche dedicate). Gate: eslint 0, vitest 1144/1144, build ok.
- **Note operative**: dispatch invariato (cron 5′, 500 righe/tick — anche con buffer 0 la push arriva entro ~5′); `entita_id` è **uuid** → mai chiavi sintetiche di debounce; enqueue sempre best-effort (mai blocca la route).

## 🗓️ Changelog — Icona app aggiornata (iOS + Android) 2026-07-12 (branch `fix/docente-primaria-home`)

- **Nuova app icon Kidville** (personaggio col cilindro che saluta, pannello bianco + banda teal con wordmark "Kidville®") in sostituzione della precedente (personaggio a figura intera su cartello giallo, sfondo teal). Rigenerate tutte le densità: iOS `AppIcon-512@2x.png` (full-bleed) e Android `mipmap-*/ic_launcher{,_round,_foreground,_background}.png`.
- **Pipeline sorgenti in `assets/`** (modalità manuale `@capacitor/assets` v3 — **NB: legge da `assets/`, non `resources/`**): `icon-only.png` 1024² full-bleed (iOS + Android legacy), `icon-foreground.png` (artwork scalato al 70% per la safe-zone adaptive 66–72dp: il wordmark "Kidville" resta leggibile su maschera a cerchio) + `icon-background.png` (teal pieno `#056B66`). Comando: `npx capacitor-assets generate --ios --android`.
- **Full-bleed ricostruito** dal PNG orizzontale sorgente via floodfill per connettività (lo sfondo grigio esterno, isolato dal bordo teal dell'icona, non intacca il pannello bianco né il testo) + ricostruzione dello sfondo agli angoli (bianco sopra / teal sotto) e dilatazione maschera per eliminare gli aloni antialiasati.
- **Fuori scope (invariati)**: splash screen (iOS/Android) e `assets/logo.png` — l'intervento tocca solo l'icona.

## 🗓️ Changelog — Registro Protocolli DPR 445/2000 (admin+segreteria) 2026-07-12 (branch `fix/docente-primaria-home`)

- **Nuovo modulo `/admin/protocolli`** (voce sidebar "Protocollo", gruppo Amministrazione, `roles: ['admin','segreteria']` — primo uso reale del gating per-voce). Perimetro definito con **24 decisioni approvate una-per-una dall'utente**; spec completo in `docs/superpowers/specs/2026-07-12-registro-protocolli-design.md`.
- **Registrazione a norma (art. 53)**: numero `0000042/2026` (≥7 cifre, azzeramento annuale, per sede — funzione atomica `prossimo_numero_protocollo`), data/ora automatiche, mittente/destinatario, oggetto, **impronta SHA-256**, mezzo, riferimenti del documento del mittente, categoria (titolario configurabile, 7 default), allegati multipli, collegamenti "risponde al prot. n. X", inserimento **da registro di emergenza** (data/ora dichiarata + badge).
- **Fascia di segnatura (art. 55)** con pdf-lib in testa alla 1ª pagina — pagina originale incorporata e riscalata, **nulla viene mai coperto**: logo + denominazione + numero + tipo + data/ora italiana (corretta anche su runtime UTC). Foto JPG/PNG convertite in PDF e timbrate. **Originale intatto + copia timbrata** conservati per sempre nel bucket privato `protocollo`, download SOLO via URL firmato.
- **Upload diretto client→storage** con URL firmato (fino a 25 MB, oltre il limite body Vercel) + **auto-compilazione dei campi** dal testo del PDF (unpdf + euristiche "OGGETTO:", "Prot. n. … del …", intestazione mittente) + **avviso duplicati non bloccante** via impronta.
- **Immutabilità WORM a livello DB** (trigger validi anche per service_role): mutabili solo note/categoria/collegamento; **annullamento a norma art. 54** (riga visibile barrata, motivo obbligatorio + data + operatore, definitivo); **eliminazione totale SOLO admin** via `protocollo_elimina()` (GUC transaction-locale), file compresi, **senza alcuna traccia nemmeno tecnica** (scelta esplicita dell'utente; i buchi di numerazione che ne derivano sono accettati).
- **«Verifica integrità»** (ricalcolo impronta dall'archivio), **export XLSX + PDF impaginato** sui filtri attivi (righe annullate visibili col motivo; il registro giornaliero è l'export del singolo giorno), **«Genera documento»** su richiesta (certificato di frequenza/iscrizione — riuso builder self-service —, nulla osta, testo libero su carta intestata; protocollato in USCITA in un click), **pulsanti «Protocolla»** sui certificati competenze (uscita) e sui moduli firmati della modulistica (ingresso, via documents-merge).
- **Migrazione** `20260712150000_registro_protocolli.sql` applicata in prod via MCP (advisor security 0 ERROR). DB E2E CI non migrato → la GET degrada (`nonMigrato`) e la pagina rende l'empty-state dedicato: spec `e2e/admin-protocolli.spec.ts` + voce `/admin/protocolli` in coverage-matrix. **52 test nuovi** (lib in TDD: segnatura, euristiche, timbro con verifica testuale via unpdf, store, documenti, carta intestata; route: gate 401/403, DELETE solo admin senza audit, degradazione, zod). Nuove dipendenze: `pdf-lib`, `unpdf`.
- **Rettifica (solo admin, decisioni #25-26)**: sostituzione del documento (originale rimpiazzato, **timbro rigenerato con lo stesso numero/data/tipo**, impronta ricalcolata) e correzione dei dati descrittivi (oggetto, mittente/destinatario, mezzo, riferimenti mittente, descrizione allegati, nome file) — **senza alcuna traccia**. L'identità del protocollo (numero, anno, data/ora di registrazione, tipo) resta blindata dal trigger anche in rettifica; vietata sulle registrazioni annullate. Migr `20260712200000` (funzione `protocollo_rettifica` + GUC dedicato) applicata in prod via MCP. UI nella scheda: «Sostituisci file» + «Modifica dati» (solo admin). Route `rettifica` con zod, 4 test dedicati. Collaudo live ripetuto: ha intercettato (e fatto correggere) un NULL-bug di `current_setting` che avrebbe disattivato l'intero WORM.
- **Fuori scope dichiarato** (decisioni utente): conservazione a norma accreditata, segnatura XML AgID, snapshot giornaliero automatico, OCR/AI, tracciamento dei download, audit interno su crea/annulla/elimina/rettifica, protocollazione automatica email/PEC, moduli del sistema legacy senza `pdf_path`.

## 🗓️ Changelog — Home docente senza lessico 0-6 per i solo-primaria 2026-07-12 (branch `fix/docente-primaria-home`)

- **Rimosso il banner "Nessuna attività infanzia/nido per il tuo profilo · Vai alla Primaria"** (richiesta utente): per un docente solo-primaria nessun riferimento a infanzia/nido deve mai comparire — le funzioni 0-6 restano attivabili solo dalle impostazioni admin (eccezione E24 già gestita). La navigazione al mondo primaria è già garantita dal tab Registro e dalla scorciatoia.
- **Lessico per grado** nella home docente: per i solo-primaria "Sezione"→"Classe" e "bambini"→"alunni" (sottotitolo hero, banner allergie, card appello, titolo agenda); `TeacherAgendaCard` con nuova prop `gruppo: 'sezione' | 'classe'` per gli empty-state.
- **Fix bug visivo header (segnalazione utente)**: la mascotte sbordava di qualche pixel oltre l'angolo arrotondato in basso a destra della card (visibile su Appello/Mensa/Galleria). `HeroMascot` ora si aggancia a `right-0` con `borderBottomRightRadius` che replica l'angolo della card ospite (28px hero, 24px header) e margine visivo via padding interno: il ritaglio segue la curva, zero sbordi. Audit visivo su tutte le pagine docente + prod: in produzione il remap colori `.kv-tab-giallo` è attivo e corretto (pill leggibili); il dev server locale può servire un chunk CSS stantio dopo modifiche a `globals.css` → riavviare `next dev` per vederle.
- **Empty-state armadietto** (`teacher/settings/locker`): "Nessuna sezione nido/infanzia disponibile." → "Nessuna sezione disponibile per l'armadietto." (niente riferimenti 0-6 ai docenti primaria).

## 🗓️ Changelog — Loader globale di pagina hydration-safe (variante Riflesso) 2026-07-12 (branch `feat/page-loader`)

Reintrodotto il **loader globale a pagina intera** (variante "Riflesso": logo Kidville fermo + banda di luce ogni 2,4 s), stavolta **hydration-safe** dopo il revert `6cdd620` (il vecchio root `app/loading.tsx` avvolgeva l'app in Suspense e in `next dev` bloccava l'`useEffect` dell'appello → "Caricamento alunni"). Gate verdi: **eslint 0 · vitest 1065/1065 · build ok**.

- **Architettura**: NON è un `app/loading.tsx`/boundary Suspense. È un **overlay puramente client** (`src/components/ui/PageLoader.tsx` + `.module.css`) pilotato da `src/components/providers/GlobalLoader.tsx`, montato come **fratello** di `{children}` in `RootProviders` → il contenuto si idrata normalmente. Usa solo `usePathname` (mai `useSearchParams`, che deopterebbe l'app). Token `--color-kidville-*` → alto contrasto automatico; `prefers-reduced-motion` rispettato (niente riflesso/puntini).
- **Trigger**: caricamento iniziale (nascosto al primo paint post-hydration, fallback 2 s) + navigazioni via click su link interni (bubble phase) + back/forward (gated sul pathname) + trigger imperativo `showPageLoader()` per `router.push`/`replace`. Anti-flash 180 ms, safety 4 s, **failsafe CSS-only** (auto-hide a 10 s se il JS non parte → mai blocco permanente).
- **Verifica**: review adversariale multi-agente (4 lenti) → 10 fix (StrictMode/popstate/`window 'load'`/failsafe/patch pushState inerte rimosso/click bubble/live-region/safety/reduced-motion/rel). Lente hydration: **nessun rischio**. La resa è stata verificata a schermo nel dev server. ⚠️ La prova runtime dell'hydration dell'appello va lasciata alla **E2E `teacher-attendance` in CI** (il Browser pane locale non idrata l'app; anche il login non è interattivo lì).

**Pendente**: push del branch + validazione E2E in CI prima del merge (è la rete che intercettò la regressione la volta scorsa).

---

## 🗓️ Changelog — Docente per grado, testi neutri, hero dal prototipo, TEST tab gialla 2026-07-12 (branch `feat/docente-primaria-tab-giallo`)

- **Gating docente per grado (mirror genitore)**: nuovo hook `useTeacherGradi` (`utenti.gradi` via `/api/primaria/me`, promise-cache condivisa tra home, GradeWorldSwitch e bottom-nav) + helper puro `visibileDocente`/`diarioVisibile` (14 unit test). Un docente **solo primaria** non vede più le voci 0-6: niente **Diario** né **Armadietto** nel menu, tab #2 = **Registro**; un solo-infanzia non vede Registro; i misti restano col comportamento per-URL. **Eccezione E24**: se l'admin attiva il diario 0-6 per la primaria (`diario_primaria_visibile`), la voce Diario ricompare. Scorciatoie della home per grado (Registro ora appare ai docenti con primaria; prima non compariva mai), banner allergie → "Vai al registro" per i solo-primaria. Coverage-matrix e2e: metadato `inNav` aggiornato per Diario/Armadietto.
- **Testi neutri (niente tecnologia esposta)**: "Caricamento alunni da Supabase..." → "In caricamento…"; hint admin "applicati dal server" → "automaticamente"; graduatorie "calcolati dal database" → "calcolati automaticamente"; empty-state fiscale/riconciliazione ed errore 503 senza "(migrazione da applicare)"; "Il record" → "L'alunno"; "record audit" → "traccia di audit". Nessun test asseriva le stringhe.
- **Hero fedele al prototipo "tab gialla app"**: nuovo `HeroMascot` (ritaglio ancorato al fondo card + overflow-hidden, immagine top-anchored) — mascotte **a mezzo busto** ~150px (~38% della card; prima 119px, figura intera), cappello che sbuca ~20px dal bordo alto, busto tagliato esattamente al bordo basso, margine destro 20px; data dell'hero in verde pieno. Nessun asset nuovo (`mascot-hero.png` invariata, derivata trasparente della mascotte ufficiale `mascot.png`).
- **TEST reversibile "tab gialla ovunque"**: flag `TAB_GIALLO_OVUNQUE` (`src/lib/ui/tab-theme.ts`, ora **true**) → tutti i `PageHeaderCard` (~28 pagine docente+genitore) passano dal verde allo stile del prototipo: fondo giallo, testi verdi, mascotte a mezzo busto dove non c'è lo slot `action`. I contenuti dei caller disegnati per il verde sono rimappati dal blocco CSS scoped `.kv-tab-giallo` in `globals.css` (nessun caller toccato); alto contrasto coperto (override `.kv-header-card` + eccezione pill). **REVERT in un clic: `TAB_GIALLO_OVUNQUE = false`** (o `git revert` del commit dedicato). Restano verdi: AppBar, ClasseShell, header chat fullscreen, cockpit admin.

---

## 🗓️ Changelog — Fix status bar iOS (viewport-fit statico) + hero con mascotte grande 2026-07-12 (branch `feat/login-design-fidelity`)

- **AppBar sotto la status bar iOS (tutte le pagine)**: il `viewport-fit=cover` era aggiunto a runtime dalla shell nativa ma veniva perso quando Next riconcilia i meta del `<head>` → `env(safe-area-inset-*)` restava 0 e la barra verde finiva sotto l'orologio. Ora è **dichiarato staticamente** (`export const viewport` nel root layout). `--kv-appbar-h` spostata da inline style a `globals.css` così l'override `.cap-native` (`calc(58px + env())`) vince: ClasseShell sticky, `calc()` della chat e fallback Suspense seguono l'altezza reale della barra. Verificato con simulazione inset 59px. **Da ricontrollare sul dispositivo/simulatore dopo il rebuild** (`npx cap sync ios`).
- **Hero delle home (mockup utente)**: mascotte **trasparente** `mascot-hero.png` grande (178px su card 160) ancorata in basso a destra, **il cappello scavalca il bordo alto della card**; eliminata la cucitura dello sfondo giallo opaco di `mascot.png`; testo al 60%.

---

## 🗓️ Changelog — Chat sul design export + adattamento a ogni viewport mobile 2026-07-12 (branch `feat/login-design-fidelity`)

Secondo passaggio del re-skin: **interno della chat** portato al design export (componenti condivisi docente/genitore) e **audit responsive automatico** su tutta l'app mobile. Gate verdi: **eslint 0 · vitest 1051/1051 · build ok**.

- **Chat — lista thread** (`ChatThreadList`): avatar 48px con iniziali Barlow 800, nome Barlow 800 uppercase verde, riga ruolo/classe muted, anteprima Maven 12.5 `kidville-sub` (bold se non letta); **non-letto in giallo** (badge pill giallo/verde + riga `yellow-soft`, mai rosso — regola del design).
- **Chat — conversazione** (`ChatMessageArea`): bolle con **angoli asimmetrici del design** (18px, coda 6px) — in uscita verdi con ombra `rgba(0,84,75,.7)`, in entrata bianche bordate `kidville-line` su **fondo crema**; testo Maven 13.5/1.42; separatori giorno e "Nuovi Messaggi" **a pillola** (Barlow 800, il secondo giallo); chip "Traduci" pill green-soft.
- **Chat — composer** (`ChatInput`): allega = cerchio 40 `green-soft`, campo bianco r22 bordo `line` focus verde, **invio = cerchio 44 verde/giallo** con glow del design. **Header conversazione mobile**: barra verde con back `white/15`, avatar giallo (genitore) / tinta persona (docente), nome Barlow 800 bianco. Selettori e2e invariati (placeholder "Scrivi un messaggio", "Invia messaggio", "📎 Allegato", "Nuova Chat").
- **Responsive**: audit Playwright automatico **33 rotte × 3 viewport (320/360/430)** con rilevamento overflow di pagina ed elementi fuori viewport (esclusi i contenitori scrollabili voluti) → 3 difetti trovati e corretti, **99/99 puliti**: riga appello docente (wrap dei controlli Presente/Ritardo/Assente), valutazioni classe (`grid-cols-1` esplicito → `minmax(0,1fr)`, `min-w-0` sui select, wrap `DimToggle`), mensa genitore (wrap navigazione settimana). Ultimi grigi hardcoded `MensaCalendar` → token.

---

## 🗓️ Changelog — App genitore sulla linea design docente: AppBar persistente + header unificati 2026-07-12 (branch `feat/login-design-fidelity`)

Re-skin coerente delle aree **genitore e docente** sul design dell'export Claude ("kidville web", cartella `ins/`): barra app verde persistente, hero gialla nelle home, card-header verde su tutte le sottopagine, pulsanti pill unificati. Gate verdi: **eslint 0 · vitest 1050/1050 · build ok**; verifica visiva Playwright (390×844) su docente/genitore/alto contrasto e regressione admin.

- **AppBar persistente** (`src/components/features/shell/AppBar.tsx`, montata nei layout `/teacher` e `/parent`): wordmark Kidville **bianco** sempre presente (nuovo asset `public/logo-light.png`, estratto dal `LOGO_LIGHT` dell'export — quello di `index.html` è la variante gialla), back pill sulle sottopagine (derivazione statica del path padre + eccezioni `forms→modulistica`, `settings/locker→locker`; soppresso sotto ClasseShell e onboarding), campanella con **badge non-letti lato genitore** calcolato dagli endpoint esistenti (`/api/diary/students` + `/api/avvisi`, stessa cascata di `AvvisiPreview` — zero endpoint/colonne nuovi, vincolo drift DB E2E). Lato docente niente badge (non esiste read-state, v1).
- **`PageHeaderCard`** (`src/components/ui/PageHeaderCard.tsx`): estrazione della card verde (DR) prima **copia-incollata su 8 pagine docente**; ora unico componente per docente E genitore. Badge conteggi **fuori dall'`<h1>`** (vincolo e2e `exact:true`); slot `subtitle`/`action` per pill sezione, chip alunno, icon button.
- **`HeroCard`** (`src/components/features/shell/HeroCard.tsx`): hero gialla unificata delle due home (data SSR-safe interna, saluto fornito dalla pagina per i vincoli e2e, mascotte con fallback); wordmark/campanella interni **rimossi** (vivono nella AppBar). `greetingByHour` deduplicato in `src/lib/ui/greeting.ts`.
- **Docente**: 8 header→componente a parità visiva; le 3 pagine divergenti (mensa, hub primaria, chat) allineate alla card; chat rititolata "Comunicazioni / Messaggi" (subtitle e2e invariato). `ClasseShell` sticky sotto la barra via `--kv-appbar-h` (fallback 0px → **/admin invariato**, verificato).
- **Genitore (~19 pagine)**: tutte le sottopagine passano dall'header piatto alla card verde (copy: Comunicazioni/Avvisi·Messaggi, La giornata/Il mio diario·Segnala assenza, Momenti/Le mie foto, Documenti/Modulistica, Servizi/Mensa·Pagamenti·Armadietto, Didattica · Primaria/…); chip alunno nello slot `action` (pill white/15 + iniziali gialle); container normalizzati `px-4 pt-5 pb-24` (i `max-w-*` per-pagina erano inerti dentro la shell 430px); pulsanti → `Btn`/`btnClass` (etichette/id invariati per gli e2e); sweep grigi hardcoded → token `kidville-*` (modulistica ~42 righe, chat, diary — blocchi jsPDF intatti); chat: altezza pannello desktop compensata con `var(--kv-appbar-h)`.
- **Alto contrasto**: `.kv-appbar`/`.kv-header-card` su sfondo nero con bordo (fix del bianco-su-bianco latente: `--color-kidville-green→#FFF` azzerava i testi bianchi degli header verdi). **Capacitor**: safe-area top dentro la barra (commit separato `d2d7938`, da validare su simulatore iOS).
- **Nota nota bene**: mismatch di hydration **pre-esistente** della `TeacherBottomNav` (`?userId=null` in SSR) osservato durante la verifica — non introdotto né corretto in questo intervento.

---

## 🗓️ Changelog — Login: allineamento 1:1 al design Claude + fix accessibilità 2026-07-12 (branch `feat/login-design-fidelity`)

Ri-import del design **"Kidville - Login (standalone).html"** (MCP DesignSync, projectId `85d814d5-…`) e allineamento fedele di `/auth/login`, che nella prima implementazione (changelog sotto) aveva reinterpretato diversi valori. **Logica di autenticazione invariata**. Gate verdi: **eslint 0 · tsc 0 · vitest 1050/1050 · build ok**.

> **Nota sul design**: `get_file` tronca il file a 256 KiB (immagini base64 inline) e il markup della card si perde. Il blocco `<style>` però arriva **completo**: la card è stata ricostruita dalle sue classi e la resa validata confrontando due screenshot Playwright a 402×874 (render di riferimento del design vs pagina reale).

- **Sfondo decorativo — la differenza principale**: il design ha **blob angolari a colori pieni del brand** (cuneo verde in alto a destra, collina verde/teal `#0A8072` in basso a sinistra, collina gialla + onda verde in basso a destra), non blob sbiaditi al 10% come nella versione precedente. Portati i **path SVG originali** (spazio 402×874), ritagliati per angolo così restano agganciati ai bordi del viewport. Doodle (stella/nuvola/cerchio/casa) alle coordinate del mockup, ancorati alla colonna centrale. Il 5° doodle `abc` del design è **volutamente omesso**: nel mockup è interamente coperto dalla card, non è mai visibile.
- **Sfondo pagina**: tinta piatta `#FAF6EF` (`--kv-cream` del design), page-scoped. Rimosso il `radial-gradient(… #fff7ec …)` cablato, che in Alto Contrasto **non si ribaltava** (restava chiaro mentre card e testi si invertivano).
- **Geometria del design**: logo 208px, mascotte 278px che **scavalca la card di 40px**, card a 18px dai bordi (366px), padding `30/26/26`, raggio 34px, ombre `.34/.15`; titolo 38px, sottotitolo 15,5px, label 16px, campi con gap 9px e passo 26px. Nuovo token `--color-kidville-sub` (`#55615C`, il `--kv-sub` del design).
- **Toggle "alto contrasto" fuori dalla card**: nel design la card **chiude con "Accedi"**. Spostato sotto, come pastiglia chiara — necessaria perché lì sotto passano i blob e il testo cadrebbe su verde/giallo.
- **Picker multi-profilo**: rimossi Barlow Condensed + uppercase (nel design l'unico Barlow è l'h1): eredita la tipografia del CTA.
- **Scostamenti voluti dal design (accessibilità)**: bottone "Accedi" a **44px** (design 40px, sotto il minimo touch target); input a **16px** (design 14,5px → iOS zooma al focus); area cliccabile dell'occhio portata a **44×44** via `::before` senza cambiarne l'aspetto (34×34).
- **Accessibilità — difetti corretti**: rimosso `outline: none` dagli input (uccideva l'anello di focus **da tastiera**: il CSS module vince sul globale a parità di specificità); stato `:disabled` del CTA non più a `opacity .6` (portava "Accesso…" a 2,8:1) ma su verde scuro; testo d'errore su nuovo token `--color-kidville-error-strong` (`#C62828`, 4,9:1 — prima 3,7:1); icona occhio su `--color-kidville-sub` (unico segno visivo del controllo → serve 3:1); **il logo resta in Alto Contrasto** invertito in bianco (prima spariva: l'utente ipovedente perdeva l'unica identificazione del brand).
- **Accessibilità — ARIA**: focus spostato sul gruppo "Scelta del ruolo" quando il picker sostituisce le credenziali (prima il focus cadeva su `<body>`); stato `?scegli=1` non più card vuota ma "Caricamento dei profili…" annunciato; `aria-busy` sul CTA; errore collegato ai campi (`aria-invalid` + `aria-describedby`); `aria-controls` sulla nota "Password dimenticata?"; nome dell'occhio reso statico (`aria-pressed` portava già lo stato); h1 con suffisso `sr-only` descrittivo.
- **Selettori load-bearing preservati** (gate E2E): `#email`/`#password`, label "Email"/"Password", bottone "Accedi", `role="alert"`, `role="group" aria-label="Scelta del ruolo"`, toggle con `aria-pressed` e nome che matcha `/alto contrasto/i`.
- **Gap noto, non corretto per fedeltà**: bordo input (`#EFE7DC`) e placeholder restano sotto le soglie WCAG di contrasto — come nel design stesso (`#EAE2D6` / `#9FB0AB`). La risposta del progetto resta la **modalità Alto Contrasto** dedicata.
- **Copy** (richiesta utente): titolo **"Benvenuto/a!"** (era "Ciao!") e sottotitolo **"Accedi al tuo account Kidville"** (era "Riservato a personale e famiglie. Accesso solo su invito della Segreteria."). Il vincolo "solo su invito" resta comunque nel messaggio d'errore credenziali e nella nota "Password dimenticata?".
- **Toggle Alto Contrasto: via dalla login → nei menu account di TUTTE le aree** (richiesta utente). Nuovo componente riusabile `src/components/ui/ContrastMenuButton.tsx` (gemello di `LogoutMenuButton`), agganciato accanto a "Esci" in: sidebar/drawer Direzione, bottom nav Genitore, bottom nav Docente, dropdown account della TopBar cockpit. **Migliora la conformità invece di ridurla**: prima il toggle esisteva SOLO nella pagina di login, quindi chi era già dentro l'app non poteva più attivare/disattivare l'alto contrasto. Provider, cookie `kv_contrast` e rimappaggio dei token restano invariati (baseline AgID / Legge Stanca, P1 DL-008). La login continua a *leggere* `highContrast` (per nascondere mascotte e decori). Test `login-contrast.test.tsx` riscritto sul nuovo componente, più l'asserzione che la login NON esponga più il toggle.
- **Login a tutto schermo, senza scroll** (richiesta utente): `.page` passa da `min-height` a **`height: 100dvh` + `overflow: hidden`**. Poiché così l'eccedenza verrebbe *tagliata* e non scrollata, la colonna si compatta a scaglioni — `@media (max-height: 720px)` e `@media (max-height: 600px)` — fino a entrare anche su iPhone SE 1ª gen (320×568), dove altrimenti il logo restava mozzato. Verificato **misurando il riquadro reale della colonna contro il viewport** (non a occhio) su 320×568, 375×667, 390×844, 430×932, 412×915 e 768×1024: entra tutto, niente scroll, CTA sempre visibile. Unica deroga: `@media (max-height: 480px)` (landscape) ripristina lo scroll e nasconde logo/mascotte — meglio scorrere che tagliare via "Accedi".
- **Ottimizzazione mobile**: tastiera dedicata (`inputMode="email"`, `autoCapitalize="none"`, `autoCorrect="off"`, `spellCheck={false}`, `enterKeyHint` next/go); `touch-action: manipulation` su CTA e occhio (via il ritardo da doppio-tap) e `-webkit-tap-highlight-color: transparent` (come nel design).
- **Verifica sul simulatore iOS**: app nativa Capacitor compilata e avviata su iPhone 17 Pro (`CAP_SERVER_URL` → dev server locale) — login resa correttamente a tutto schermo nella WebView.

---

## 🗓️ Changelog — Login: implementazione dal design Claude ("Kidville · Login standalone") 2026-07-11 (branch `feat/fix-contabilita-merchandise`)

Riscrittura della grafica di `/auth/login` importando il design **"Kidville - Login (standalone).html"** dal progetto Claude Design (MCP DesignSync, projectId `85d814d5-…`). Sostituisce il precedente tentativo di redesign login (mai committato, non presente nel working tree: su disco c'era ancora la versione storica "Accesso Kidville"/"Entra"). Nuovo CSS module co-locato `src/app/auth/login/page.module.css`; **logica di autenticazione invariata** (smistamento per ruolo M4B.3, picker multi-profilo `role="group"`, alto contrasto, degrado graceful, anti open-redirect). Gate tutti verdi: **eslint 0 · tsc 0 · vitest 1050/1050 · build ok**.

- **Grafica (1:1 col design)**: sfondo crema con gradiente radiale + **blob organici d'angolo** (verde in alto-dx e basso-sx, giallo in basso-dx) e doodle outline tenui (stella/nuvola/cerchio/casa), tutti decorativi (`aria-hidden`, `pointer-events:none`). Wordmark **Kidville** grande (`public/logo-kidville.png`), **mascotte a figura intera su fondo trasparente** (`public/mascot-hero.png`) che sporge sopra la card bianca a bottom-sheet (raggio 34px, ombra morbida). Titolo **"Ciao!"** in Barlow Condensed verde, sottotitolo con il messaggio "solo su invito".
- **Campi**: label verdi in grassetto, input con **icona guida inline** (busta/lucchetto, SVG inline) e per la password il toggle **occhio** show/hide; focus con bordo verde + alone. Link **"Password dimenticata?"** che rivela inline la nota "Contatta la Segreteria: riemette le credenziali via email". Bottone primario **"Accedi"** (verde, testo bianco, 60px, raggio 16px). Toggle "alto contrasto" preservato in fondo alla card.
- **Asset**: `public/mascot-hero.png` rigenerata con **Higgsfield `remove_background`** su `public/mascot.png` (il chroma-key locale non era praticabile: sash/fascia del cappello sono gialli come lo sfondo → il flood-fill "bucava" la fascia). `public/mascot.png` (fondo giallo) resta invariata per le altre pagine.
- **Alto Contrasto**: la card usa i token `--color-kidville-*` → rimappati da `html[data-contrast="high"]`; mascotte/logo/blob nascosti in HC; override mirati nel CSS module per testo bottone (nero) e bordi card. Rispetta `prefers-reduced-motion`.
- **Copy/test**: il bottone submit passa da "Entra" a **"Accedi"** (fedeltà al design); aggiornati i 5 riferimenti nei test che lo cercavano (`e2e/fixtures.ts`, `e2e/auth.spec.ts`, `e2e/primaria-360/auth.setup.ts`, `e2e/primaria-360/journeys/50-logout.spec.ts`, `e2e/primaria-360/native/android-smoke.mjs`, `__tests__/components/login-smistamento.test.tsx`). Preservati intatti gli altri selettori load-bearing: `#email`/`#password`, label "Email"/"Password", alert `role="alert"` "Credenziali non valide", picker "Scelta del ruolo", toggle "alto contrasto" (`aria-pressed`).
- **Verifica resa**: screenshot Playwright a viewport telefono su anteprima standalone con CSS/markup identici → match col design (logo, mascotte tucked, "Ciao!", campi con icone, "Accedi").

**Pendente**: commit (working tree misto — solo i file del login) e deploy, su richiesta utente.

---

## 🗓️ Changelog — Loader globale di pagina (flip 3D + riflesso) 2026-07-11 (branch `feat/fix-contabilita-merchandise`)

Aggiunta la **schermata di caricamento a pagina intera** finora assente: nuovo `src/app/loading.tsx` (+ `src/app/loading.module.css`), il boundary di Suspense del segmento root che Next.js mostra automaticamente durante il caricamento delle pagine. Prima non esisteva alcun `loading.tsx` né un componente spinner condiviso (le pagine usavano ~112 spinner `animate-spin` copia-incollati inline). Gate tutti verdi: **eslint 0 · vitest 1050/1050 · build ok**.

- **Grafica**: overlay `fixed inset-0` con sfondo crema del brand e due aloni sfumati (verde in alto-sx, giallo in basso-dx), coerente con la login. Il logo `public/logo-kidville.png` esegue un **flip 3D** (`rotateY` 0→360, un giro per ciclo + pausa frontale) con un **riflesso** (banda di luce mascherata sulla sagoma del logo) che entra da sinistra, attraversa mentre il logo è frontale ed **esce completamente dal bordo destro** prima del salto di ciclo (il riflesso non si ferma mai a metà). Caption "Caricamento…" con puntini pulsanti.
- **Temi/accessibilità**: usa i token `--color-kidville-*` (con fallback hex) → si adatta da solo all'**alto contrasto** (`data-contrast="high"`: sfondo nero, logo reso in chiaro con `filter`, riflesso giallo). Rispetta `prefers-reduced-motion` (niente flip/riflesso, solo un respiro lento). Server Component, zero JS lato client; logo+riflesso resi come `<span>` con `background`/`mask` (nessun `<img>`, quindi nessun warning eslint `no-img-element`). `role="status"` + testo sr-only "Caricamento in corso…".
- **Verifica**: animazione validata visivamente su anteprima standalone con CSS identico (fotogrammi congelati: al 68% il riflesso attraversa, all'84% è già fuori dal bordo destro → logo uniforme); la build conferma la compilazione di componente + CSS module reali.

**Pendente**: commit e deploy, su richiesta utente (working tree ancora misto con login+scadenziario).

---

## 🗓️ Changelog — Login: redesign grafico identico al mockup 2026-07-11 (branch `feat/fix-contabilita-merchandise`)

Riscrittura della sola grafica di `/auth/login` (`src/app/auth/login/page.tsx`) per renderla **identica al mockup fornito** (`~/Downloads/image.webp`): sfondo crema con blob d'angolo (teal in alto-destra, teal+giallo in basso) e doodle outline tenui (stella/nuvola/casa/cerchio/blocco), wordmark **Kidville** grande, **mascotte a figura intera su fondo trasparente** (non più nel cerchio giallo), card bianca a bottom-sheet con "Benvenuto!" / "Accedi al tuo account Kidville", campi Email/Password con icone inline (busta/lucchetto + occhio show-hide), "Password dimenticata?" e bottone "Accedi". **La logica di autenticazione è invariata** (smistamento per ruolo M4B.3, picker multi-profilo, alto contrasto, degrado graceful, anti open-redirect). Gate tutti verdi: **eslint 0 · tsc 0 · vitest 1050/1050 · build ok**; reso verificato via screenshot Playwright a viewport telefono (match col mockup).

- **Asset**: nuova mascotte trasparente `public/mascot-hero.png` prodotta con la pipeline gstack→**Higgsfield** (`remove_background` su `public/mascot.png`; il chroma-key semplice non era praticabile perché sash/cappello/cravatta sono gialli come lo sfondo). `public/mascot.png` (fondo giallo) resta invariata per le altre pagine. Nuovo logo ritagliato `public/logo-kidville.png` (trim dei margini trasparenti di `logo_green.png`, così il wordmark risulta grande come nel mockup).
- **Icone**: `lucide-react` (`Mail`/`Lock`/`Eye`/`EyeOff`) — nessun asset raster per le icone.
- **Decisioni prodotto** (confermate dall'utente): l'app è ad accesso **solo su invito**, quindi il link "Registrati" del mockup è **omesso**; resta solo "Password dimenticata?" che rivela inline il messaggio "Contatta la Segreteria: riemette le credenziali via email". La nota "Accesso riservato — solo su invito della Segreteria" è mantenuta in piccolo sotto il form.
- **Copy/test**: il bottone submit passa da "Entra" a **"Accedi"** (fedeltà al mockup); aggiornati i 4 riferimenti nei test che lo cercavano (`e2e/fixtures.ts`, `e2e/auth.spec.ts`, `e2e/primaria-360/auth.setup.ts`, `__tests__/components/login-smistamento.test.tsx`). Preservati intatti tutti gli altri selettori load-bearing: `#email`/`#password`, label "Email"/"Password", alert `role="alert"` con "Credenziali non valide", picker `role="group"` "Scelta del ruolo", toggle "alto contrasto" (`aria-pressed`), zero violazioni jest-axe.
- **Font**: heading in Maven Pro (già a brand, tondeggiante) invece di Barlow Condensed — unica differenza non pixel-identica dal mockup; nessun webfont nuovo introdotto.
- **Round 2 (correzioni fedeltà)**: analisi pixel del mockup → sfondo reale **bianco** `#fdfbf9` (non crema): root portato a `bg-white`. Scala resa più ariosa (hero `pt-16`, logo `w-52`, mascotte `w-48`, campi `py-3`, bottone `py-3.5 text-base`) perché gli elementi risultavano "ingranditi". Risolta la fascia crema sotto il notch nell'app nativa (`.cap-native body{padding-top:env(safe-area-inset-top)}` + body crema): `SfondoDecorato` reso layer `fixed inset-0 -z-10 bg-white` full-viewport, così il bianco arriva sotto la status bar come nel mockup senza toccare il body globale. Verificato su **app nativa iOS** (simulatore iPhone 17, `npx cap run ios`, `CAP_SERVER_URL=http://localhost:3210`). Gate ancora verdi (eslint 0 · tsc 0 · vitest 1050 · build).

**Pendente**: commit (solo i file del login, il working tree è misto con lo scadenziario) e deploy, su richiesta utente. Nota: eccezione ATS temporanea in `ios/App/App/Info.plist` (HTTP localhost per l'app nativa in dev) da ripristinare prima del commit.

---

## 🗓️ Changelog — Scadenziario: visuale unificata, morosità con acconto, ticket mensa 2026-07-11 (branch `feat/fix-contabilita-merchandise`)

Cinque interventi sullo scadenziario contabilità (`/admin/pagamenti`) e sui ticket mensa. Gate tutti verdi: **eslint 0 · tsc 0 · vitest 1050/1050 · build ok**.

- **A — Visuale unificata a tutte le categorie** (`PaymentsDashboard.tsx`): la "vista retta" (tabella con allarme rosso sui morosi + dettagli espandibili nel `PagamentoDrawer`) è ora applicata a **tutte** le categorie non-retta, che prima erano una semplice griglia di card senza stato/scadenza né morosità. Nuova tabella 1-riga-per-pagamento (Alunno/Descrizione/Scadenza/Importo/Acconto/Stato/Azioni), riga rossa sui morosi, chip "Acconto € X", azioni Incassa/Dettagli/Rateizza/Modifica + selettore "Nuovo acquisto". Il filtro **"Morosi"** è ora disponibile in ogni categoria (prima solo retta).
- **B — Acconto che NON azzera la morosità** (migr `20260711170000`): `ricalcola_stato_pagamento`/`ricalcola_stato_padre` riordinate — un pagamento **scaduto e non saldato resta `scaduto` (moroso) anche con un acconto** (prima l'acconto lo declassava a `parziale`, facendolo sparire dai morosi). Vale per **ogni** tipo di pagamento (singolo/rata/split/padre). Il padre usa `MIN(scadenza) FILTER (importo_pagato < importo)` per non falsare i piani con rate scadute già saldate. Backfill idempotente dei record esistenti. Nuovo helper condiviso `isMoroso(p, oggi)` date-aware (allarme rosso immediato, senza attendere il cron solleciti).
- **B (sblocco)** — la Segreteria pulisce la morosità **spostando la scadenza** del singolo pagamento: `PATCH /api/pagamenti/[id]` ora ricalcola lo stato anche al cambio `scadenza` (prima solo al cambio importo), tipo-aware (padre→aggregato). Lato genitore (`StoricoPagamenti`) l'acconto/residuo resta visibile ("(resta € X)") anche sugli scaduti.
- **C — Animazione di conferma ticket mensa** (`TicketMensaPanel.tsx`): spunta animata `SaveCheck` (idiom cockpit) dopo ogni ricarica, con `key` che la ri-anima a ogni operazione ripetuta.
- **D — Storico ticket per-alunno su ledger dedicato** (migr `20260711180000`): nuova tabella `mensa_ticket_movimenti` (ricarica/consumo/disdetta/rettifica + `saldo_dopo`), scritta going-forward da ricarica (`/api/pagamenti/ticket`) e prenotazioni (`/api/mensa/prenotazioni` POST/DELETE) in best-effort (il saldo `ticket_mensa` resta autoritativo), con backfill idempotente + riconciliazione di apertura. Nuovo `GET /api/pagamenti/ticket/storico` (staff, `requireStaff`+scope) mostra, cliccando l'alunno, tutti i ticket acquistati (con metodo/stato, "Gratuita" se costo 0) e i consumi/disdette.
- **E — Morosità ticket (saldo negativo)** (`GET /api/pagamenti/ticket/morosi`, scoping `resolveScuoleAttive` + join `!inner` su alunni): banner rosso in cima al pannello ticket con gli alunni a saldo negativo, cliccabili per aprirne saldo+storico.

**Rilascio**: 2 migrazioni **APPLICATE a prod** via MCP + verificate (parziale-scaduti 0, ledger quadra `SUM(delta)==saldo_ticket`, advisor 0 ERROR; versioni riallineate ai timestamp-file). Deploy via PR #16→`main`. **Hardening E2E flaky** (pre-esistenti, non correlati al lavoro: `teacher-attendance`/`teacher-agenda`/`public-iscrizione`): `test.slow()` + timeout espliciti generosi sui render/transizioni lenti sotto carico CI (gli elementi si renderizzano, solo tardi) — la diagnosi via artefatti Playwright ha escluso il loader (non presente negli snapshot di fallimento).

---

## 🗓️ Changelog — Test completo + correzione difetti Contabilità+Merchandise 2026-07-11 (branch `feat/fix-contabilita-merchandise`)

**Test completo** del rilascio PR #15 (Contabilità Fase A + Merchandise Fase B): gate (eslint/tsc/vitest/build tutti verdi), review adversariale a 10 lenti (58 agenti, ogni rilievo confutato) e verifica read-only del DB di produzione (5 migrazioni allineate, advisor **0 ERROR**). Esito: **39 rilievi confermati** — 1 alto, 16 medi, 21 bassi, 0 critici. Referto navigabile prodotto come artifact.

Correzione difetti in fasi (1 commit per fase, gate verde per fase):

- **Fase 1 🟠 (ALTA)** — `PaymentsDashboard`: i KPI contavano due volte i piani rateali (contenitore `padre` + rate). Logica estratta in `calcolaTotaliPagamenti()` pura con guard `padre`; "Da incassare" non è più gonfiato in modo permanente. +test di regressione.
- **Fase 2a 🟡** — `attestazione` 730: classificazione detraibile/non-tracciabile sul **netto** per voce (uno storno in contanti compensa il detraibile invece di gonfiarlo). `riconciliazione` conferma: update del movimento con **CAS ottimistico** + storno dell'incasso se la corsa è persa (anti doppio-incasso). +test.
- **Fase 3 🟡** — scoping di sede su `pagamenti/[id]` (GET/PATCH/DELETE), `genera-rette` (GET) e `attestazione`: niente più lettura/modifica/PDF cross-sede per UUID (impatto pratico basso con sede unica, chiude il gap multi-sede). +test.
- **Fase 4 🟡🔵** — magazzino: `giacenze` con filtro sede a livello DB prima del cap (no oversell da troncamento) + errori reali propagati invece di degradare a stock zero; `cambio-taglia` con guard sullo stato sorgente (una riga `annullato` non resuscita a prezzo 0); `export`/`da-ordinare` filtro sede a DB; `evadi-magazzino`/`consegna`/`checkin` contano e notificano solo le righe realmente transitate + post-check anti over-allocazione. +test.
- **Fase 5 🟡** — frontend contabilità: reset del mese al cambio A.S.; stato di errore con banner+Riprova (niente KPI a 0,00 su load fallito); `StoricoPagamenti` genitore mostra residuo affidabile sugli split.
- **Fase 6 🔵** — UX `/admin/merchandise`: conferme su evasione/annullo, empty-state, registra-arrivo non più no-op, dropdown ricerca non-stale, prezzo con virgola italiana, toggle catalogo con busy/errore, checkbox accessibili.
- **Fase 7 🔵** — UX/grafica contabilità: rimossa fascia nera in `StudentDetailPanel`; skeleton KPI in loading; barra filtri nascosta in vista agenda; `aria-label` sui pulsanti icona (dashboard, FiscalePanel).

- **Fase 9 🔵** — +31 test di regressione sui percorsi critici (rollback PO + `poCompleto`, evadi-magazzino gate 403/404/503, riconciliazione riapri/scope, solleciti cron+split, export/da-ordinare cross-plesso).
- **Fatture 🟡 — numerazione allineata ad Aruba** (scelta utente: la numerazione fiscale la detta Aruba). `arubaUltimoNumeroFattura` legge da Aruba (`findByUsername`) l'ultimo numero emesso nell'anno; l'emissione usa la nuova RPC `prossimo_numero_fattura_sync` = `GREATEST(contatore interno, ultimo Aruba)+1` così il progressivo non si accavalla con fatture emesse anche fuori dall'app; rimosso il fallback `?? 1`; con IVA>0 si scorpora l'imponibile e `ImportoTotaleDocumento` torna congruente (=lordo incassato).
- **Migrazione `20260711140000_fatture_sync_e_fk_hardening` APPLICATA a prod** (advisor 0 ERROR, version riallineata al timestamp-file): RPC sync numerazione + `ricevute_emesse.pagamento_id` `CASCADE→SET NULL` (registro fiscale immune alla cancellazione del pagamento) + `merch_rettifiche.articolo_id` `SET NULL→RESTRICT` (niente movimenti orfani, giacenze integre — chiude anche il rilievo FK articolo).

- **Fase 10 (low-risk) 🔩** — chiusi 3 rischi trasversali: date a valenza fiscale su **Europe/Rome** (nuovo helper `src/lib/format/fiscal-date`; prima UTC → a cavallo di mezzanotte/31-dic la data documento e l'anno di numerazione slittavano); **PII negli export** → `logScrittura` per accountability GDPR (scadenzario, AdE con CF, merchandise); **congruenza quote split** (Σ quote esplicite pareggiata al totale del pagamento sulla prima quota, niente sotto/sovra-fatturazione). +test.

- **T5 — Conservazione/WORM** (migr `20260711150000` APPLICATA a prod): trigger append-only su `fatture_emesse`/`ricevute_emesse` (vietano DELETE e l'UPDATE dei campi fiscali; restano solo lo stato SDI e l'annullo), `fatture_emesse.pagamento_id` → `RESTRICT`, route DELETE pagamento con pre-check 409. Enforcement a livello DB (anche service-role).
- **T2 — Idempotenza ordini** (migr `20260711160000` APPLICATA a prod): `divise_ordini.idempotency_key` univoca, il client genera la chiave per invio, la route ritorna l'ordine già creato su `23505` (niente ordine+addebito doppi su retry/doppio click). +test.

**Pendente — T1 atomicità/transazioni**: la creazione ordine (ordine+righe+pagamento) resta una sequenza di await con rollback best-effort. Con T2 (idempotenza) + rollback + post-check evasione, il caso residuo (crash/timeout tra due insert) è raro e a basso impatto per il contesto (sede unica, bassa concorrenza); la RPC transazionale piena richiede la riscrittura in PL/pgSQL + doppio path per il DB CI non migrato. Rimandata alla decisione dell'utente.

---

## 🗓️ Changelog — Contabilità: redesign UX + moduli fiscale/solleciti/riconciliazione (Fase A) 2026-07-10 (branch `feat/contabilita-merchandise`)

Redesign completo della sezione **Contabilità** (`/admin/pagamenti`, etichetta sidebar rinominata da "Pagamenti") in 12 step committati (A1-A12), con 3 nuove migrazioni (`20260710130000_contabilita_fiscale`, `20260710140000_contabilita_solleciti`, `20260710150000_contabilita_riconciliazione`) — **applicate a prod il 2026-07-11** (vedi Stato in fondo). Piano in `~/.claude/plans/dobbiamo-rendere-la-sezione-zippy-simon.md`. Fase B (Merchandise) a seguire sullo stesso branch.

### Shell & anti-errore (A1-A3)
- Pagina a 6 viste deep-linkabili con `?vista=` (scadenzario · genera · solleciti · riconciliazione · fiscale · ticket): pills scrollabili su mobile, Tabs cockpit su desktop; viste secondarie lazy (`next/dynamic`).
- KPI → `StatCard` responsive (2/4 colonne) col nuovo **"Da fatturare"**; `AgendaScadenze` (bucket aging cliccabili: scaduti >30gg / ≤30gg / settimana / 30gg) con vista agenda piatta; `FatturaChip` su ogni pagamento (Fatturata/In attesa SDI/Scartata/Da fatturare — **emissione sempre e solo manuale** via `FatturaButton`); `PagamentoDrawer` (timeline incassi/storni, quote, rate, tutte le azioni); card-list mobile al posto delle tabelle.
- Anti-errore: warning **contanti = non detraibile** (RegistraIncasso e QuickAcquisto), bottone con importo esatto, anti-duplicato con "Conferma comunque" (stesso alunno/categoria/importo ±15gg), anteprima OBBLIGATORIA sul generatore per categoria (candidati reali + saltati-per-gruppo mostrati prima).
- Fix: `GET /api/pagamenti` e `GET /api/pagamenti/[id]` ora riconoscono la **segreteria** come staff (prima ramo genitore → lista vuota/403).

### Fiscale (A4-A8)
- **Ricevute numerate** (`ricevute_emesse` + RPC `prossimo_numero_ricevuta`): emissione idempotente al primo download (una sola attiva per pagamento, indice parziale), snapshot intestatario/struttura/metodi, **annullo automatico su storno/modifica incasso** (numero bruciato con motivo); stesso numero per admin e genitore; conforme Bonus Nido INPS (denominazione+P.IVA, mensilità, PAGATO, metodo annotato = prova tracciabilità).
- **Attestazione annuale 730** (`GET /api/pagamenti/attestazione`): criterio di cassa, versato vs **tracciabile detraibile** (contanti e divise/materiale esclusi); scaricabile da admin (vista Fiscale) e genitore ("Documenti fiscali" in `/parent/pagamenti`).
- **Export comunicazione AdE** (`GET /api/pagamenti/export?tipo=ade&anno=`, obbligo dal 2022, scadenza 16/3): due fogli "Da comunicare" (CF alunno+pagatore) ed "Escluse" con motivo (opposizione — nuovo toggle `alunni.opposizione_ade` in anagrafica —, contanti, categorie escluse, CF mancante). Export scadenzario XLSX anche dalla toolbar.
- **Marca da bollo virtuale** su FatturaPA (`<DatiBollo>` + `fatture_emesse.bollo_virtuale`) e ricevute, gated da `admin_settings.fiscale_config` (soglia 77,47/€2, default OFF → XML invariato); IVA parametrica per causale da `aruba_config.iva[]` (prima inutilizzata). Nuovo pannello settings "Dati fiscali & bollo".

### Solleciti (A9-A10)
- `solleciti_config` (3 livelli con template e segnaposto, cadenza minima, **automatico OFF di default**) + tabella `solleciti` (log col testo effettivo). Pannello settings dedicato.
- Vista Solleciti: coda morosi con giorni ritardo/ultimo invio, selezione multipla, **anteprima obbligatoria** → conferma esplicita; email (Resend) + push; livelli sequenziali mai saltati.
- `POST /api/pagamenti/solleciti/run` (`x-cron-secret`, nel regression-lock cron): refresh stati `scaduto` + invio automatico livelli 1-2 solo per scuole abilitate. **Sostituisce `genera_solleciti()` SQL (deprecata, mai schedulata)**; schedulazione pg_cron rinviata al deploy (come fattura/sync).

### Riconciliazione bancaria (A11-A12)
- Import CSV estratto conto (parser puro: separatori/intestazioni-sinonimo/importi it, SOLO accrediti; il file grezzo non si salva — PII), hash anti re-import per scuola, matcher a punteggio (+50 importo esatto, +25 nome in causale, +15 periodo, +10 descrizione) → suggerimento solo con best ≥60 e distacco ≥20, **mai auto-conferma**. Conferma → incasso `bonifico` con data operazione; ignora/riapri; coda persistente.

### Verifica
- Gate per ogni commit: `npx eslint . --max-warnings 0` → 0 · `npx vitest run` → 929/929 (116 test nuovi, TDD) · `npx tsc --noEmit` → 0 · `npm run build` → ok.
- E2E: nuovo `e2e/admin-contabilita.spec.ts` (viste deep-link, KPI anche su viewport mobile) + `parent-pagamenti` esteso (download ricevuta = PDF vero). Tutte le route nuove degradano sul DB CI non migrato (42P01/PGRST204 → empty-state).

### Rifiniture A14-A15 (2026-07-11): data di iscrizione + giorno di paga per alunno
- **`alunni.data_iscrizione`** (migr. `20260710160000_contabilita_iscrizione_scadenze`, 4ª — **applicata a prod il 2026-07-11**): le rette si generano SOLO dal mese di iscrizione in poi — iscrizione precedente al 1° settembre = tutto l'anno; NULL = alunno storico, iscritto da sempre. Filtro replicato in `genera_rette_mensili` (CREATE OR REPLACE) e nella preview TS (con retry 42703 su DB non migrati). Campo in anagrafica (Classe e Stato) e nel form di creazione (default oggi).
- **`alunni.giorno_scadenza_pagamenti`** (1-28, NULL = default scuola): "giorno di paga" per alunno (es. genitore che paga col 15 dello stipendio); usato dalla RPC via COALESCE col default `admin_settings.retta_giorno_scadenza` (5, già editabile in Impostazioni — etichetta chiarita). Al salvataggio le scadenze delle rette APERTE future vengono riallineate (`src/lib/pagamenti/scadenze.ts`), e uno "scaduto" torna aperto se la nuova scadenza è futura. Campo in anagrafica → Dati economici.
- **Solo frequentanti in contabilità**: il filtro iscritto+sezione esisteva già in SQL e nei pannelli; chiuso l'unico gap (`FiscalePanel` attestazioni).

**Stato**: Fase A + rifiniture A14-A15 COMPLETE su branch `feat/contabilita-merchandise` (15 commit, PR draft #15, CI verde). **Migrazioni 20260710* (fiscale · solleciti · riconciliazione · iscrizione_scadenze) APPLICATE a prod il 2026-07-11** — MCP Supabase non disponibile in questa sessione non-interattiva, applicate via `supabase db push --linked` (approvazione utente) sul progetto linkato `uimulkjyekgemjakmepp` (unica sede Kidville Giugliano). Verifiche verdi: le 4 risultano `remote` nello storico (`supabase migration list`), le 5 tabelle nuove (`ricevute_numerazione`, `ricevute_emesse`, `solleciti`, `riconciliazione_import`, `riconciliazione_movimenti`) esistono e sono vuote, le colonne nuove risolvono (`alunni.opposizione_ade/data_iscrizione/giorno_scadenza_pagamenti`, `fatture_emesse.bollo_virtuale`, `admin_settings.fiscale_config/solleciti_config`), la funzione `genera_rette_mensili` è stata sostituita col nuovo corpo (apply riuscito). Advisor: nessun ERROR nuovo atteso — tutte le tabelle nuove hanno RLS attiva + policy `service_role`, entrambe le funzioni fissano `search_path` (il `get_advisors` letterale richiede l'MCP, da rieseguire quando disponibile). Schedulazione pg_cron dei solleciti NON attivata (invio automatico resta OFF, si attiva al deploy col pattern fattura/sync). Fase B Merchandise a seguire (chat dedicata).

---

## 🗓️ Changelog — Merchandise: da "Divise" a gestione completa (Fase B) 2026-07-11 (branch `feat/contabilita-merchandise`)

Il modulo minimale **Divise** diventa **Merchandise** (`/admin/merchandise`): catalogo multi-categoria, anagrafica fornitori, ordini creati dalla segreteria, ciclo logistico per riga, ordini d'acquisto (PO) numerati con PDF, giacenze automatiche, consegne con notifica ai genitori. 8 step committati (B1-B8), TDD. Piano in `~/.claude/plans/dobbiamo-rendere-la-sezione-zippy-simon.md`. **Decisioni utente vincolanti**: ordini SOLO dalla segreteria (il genitore vede l'addebito in Contabilità, niente più shop lato genitore), giacenze AUTOMATICHE, stato logistico PER RIGA, un PDF d'ordine PER FORNITORE.

### DB (B1) — migrazione `20260711120000_merchandise` (idempotente, 5ª del branch, DA APPLICARE a prod)
- Tabelle legacy `divise_*` **NON rinominate** (nessuna rottura su `intestatari.ts`/baseline/dati prod). Nuove: **`merch_fornitori`** (anagrafica per scuola), **`merch_ordini_fornitore`** (PO, uno per fornitore, `numero` UNIQUE per scuola) + **`merch_po_numerazione`** + RPC **`prossimo_numero_po`** (pattern fatture/ricevute, `service_role`), **`merch_rettifiche`** (movimenti magazzino → giacenza automatica).
- `divise_articoli` += `categoria` (divisa/materiale/libri/gadget/altro), `fornitore_id`, `prezzo_acquisto`. `divise_ordini_righe` += **stato logistico PER RIGA** (da_ordinare/ordinato/arrivato/consegnato/annullato) + `origine` (fornitore/magazzino) + `ordine_fornitore_id` + `ordinato_il/arrivato_il/consegnato_il/consegnato_da` + `nota`; **backfill** degli stati dallo stato legacy della testata. RLS deny-by-default + policy `service_role` su ogni tabella nuova.

### API (B2-B5, B8) — tutte sotto `/api/admin/merch/**`, requireStaff + zod + scoping + audit + degrade
- **Move** delle 2 route admin (`divise/{articoli,ordini}` → `merch/{articoli,ordini}`); catalogo esteso con degrade (SELECT 42703 → colonne base, INSERT/UPDATE PGRST204 → record legacy).
- **`fornitori`** CRUD; **`ordini`** POST creazione segreteria (`assertAlunnoInScope`, prezzi/snapshot **server-side**, taglia obbligatoria SOLO se l'articolo ha taglie — fix del bug latente, `parent_id NULL`, pagamento `da_pagare` categoria `divisa` con descrizione "Merchandise: …") + GET filtri `stato_riga`/`q` + embed pagamento.
- **`da-ordinare`** (aggregato per fornitore: matrice articolo×taglia×qty + righe_ids, bucket "Senza fornitore"); **`ordini-fornitore`** (POST genera PO **PO-AAAA-NNN** + marca `ordinato`, o marca senza PO; GET; PATCH annulla → righe tornano `da_ordinare`); **`ordini-fornitore/pdf`** (PDF ristampabile, committente da fiscale/aruba config); **`ordini-fornitore/checkin`** (arrivi anche parziali, chiude il PO quando completo, **notifica genitori "arrivato"**).
- **Giacenze automatiche** (`src/lib/merch/giacenze.ts`, formula pura `disponibile = Σ rettifiche − Σ righe magazzino arrivato/consegnato`): `giacenze` GET matrice+storico / POST rettifica; **`evadi-magazzino`** (`da_ordinare→arrivato` origine=magazzino, **409 se stock insufficiente**); **`consegna`** (`arrivato→consegnato`, **warning "non pagato" NON bloccante**, notifica genitori); **`righe`** PATCH transizione manuale (macchina a stati enforced); **`export`** XLSX flat; **`cambio-taglia`** (nuova riga a prezzo 0 `da_ordinare` + reso a stock opzionale).
- Macchina a stati `src/lib/merch/stati.ts` (`puoTransire`, `derivaStatoTestata` → sincronizza il campo legacy `divise_ordini.stato`, `poCompleto`); notifiche `src/lib/merch/notify.ts` (via `enqueueNotifiche`, link a `/parent/pagamenti`); PDF `src/lib/merch/pdf.ts`.

### UI & pulizia lato genitore (B6-B7)
- Pagina cockpit **`/admin/merchandise`** (`?vista=` deep-link, responsive) con 4 KPI e 8 viste: Ordini (Drawer con stati/azioni per riga + warning non-saldato + cambio taglia + export XLSX), Nuovo ordine (ricerca alunno debounce), Da ordinare (per fornitore, Genera PO+PDF, evadi magazzino), Arrivi (check-in per PO + ristampa PDF), Consegne (banner ambra non-pagato), Catalogo (categoria/fornitore/prezzo acquisto), Giacenze (matrice + rettifiche), Fornitori (CRUD). Sidebar Operativo: **"Divise" (Shirt) → "Merchandise" (ShoppingBag)**; `/admin/divise` → `redirect('/admin/merchandise')`.
- Ordini creati **solo dalla segreteria**: eliminati `/parent/divise` (pagina), `/api/parent/divise` (route) e la voce "Divise" della BottomNav genitore; `coverage-matrix` primaria-360 aggiornata. `intestatari.ts` con `parent_id NULL` ricade su intestatario/split standard (test di regressione).

### Verifica
- Gate per ogni commit: `npx eslint . --max-warnings 0` → 0 · `npx vitest run` → 1002/1002 (65 test nuovi, TDD) · `npx tsc --noEmit` → 0 · `npm run build` → ok.
- Tutte le route nuove degradano sul DB E2E CI non migrato (42P01/42703 su SELECT, PGRST204 su INSERT/UPDATE, **PGRST200** su embed di relazioni nuove → empty-state/legacy).
- **Review adversariale multi-agente** del diff Fase B prima del push (5 lenti → verifica scettica per-finding): 2 difetti confermati + hardening difensivo → fix nel commit finale: (1) `cambio-taglia` non chiudeva la riga originale (doppione consegnabile) → ora pre-consegna annulla l'originale, post-consegna reso a stock; (2) `evadi-magazzino` check-then-act non atomico (possibile over-allocazione con concorrenza reale) → guard `.eq('stato',…)` + limite documentato (bassa concorrenza segreteria, lock DB fuori scope); + rollback ordine su errore addebito, guard di stato su tutte le transizioni batch, degrade `PGRST200`.

**Stato**: Fase B COMPLETA su branch `feat/contabilita-merchandise` (9 commit: B1-B8 + fix review). **Migrazione `20260711120000_merchandise` DA APPLICARE a prod** (con backfill stati righe) su conferma esplicita dell'utente — poi `get_advisors` = 0 ERROR (tutte le tabelle nuove hanno RLS + policy `service_role`, la RPC fissa `search_path`). Merge/deploy secondo AGENTS.md a valle della conferma.

---

## 🗓️ Changelog — De-hardcode dati dinamici + Anagrafica di sede (multi-sede) 2026-07-10 (branch `feat/logout-anagrafica-fullscreen`)

Audit esaustivo dei valori "di realtà" scritti fissi nel codice runtime (`src/`, esclusi e2e), con classificazione **A** (bug reale: cablato che finisce a schermo/scope/documento) / **B** (fallback benigno: DB letto prima o default irraggiungibile) / **C** (non-codice: commenti, placeholder, seed, dead code). **Categoria A svuotata**. In più, su richiesta, predisposizione **multi-sede** con **anagrafica di sede** completa. Piano in `docs/superpowers/plans/2026-07-10-dehardcode-sezioni.md`. **Zero migrazioni DB** (anagrafica in `scuole.config` JSONB già esistente; unica scrittura dati di test sulla sede fittizia "Kidville E2E", **Giugliano intatta** — verificato via MCP).

### Hardcoded eliminati (casi A)
- **Bacheca avvisi docente** (`teacher/avvisi/page.tsx`): rimossa `AVAILABLE_CLASSES=['Girasoli','Margherite','Tulipani','3A','4B']` → classi reali da `/api/educator-sections` (pattern locker); default dei componenti `AvvisoDetailsDrawer`/`AvvisoDetailsContent` portati a `[]`. Le statistiche del drawer per avvisi globali ora si calcolano sulle classi reali del docente. `admin/avvisi` intoccata (passava già liste reali da `/api/admin/sections/scoped`).
- **Certificati self-service genitore** (`parent/modulistica/page.tsx`): il PDF diceva sempre "sezione dei Girasoli", "anno scolastico 2026/2027", "Milano, lì". Ora: sezione = `alunni.classe_sezione` reale del figlio; anno = `annoScolasticoCorrente()` (NUOVO helper `src/lib/anno-scolastico.ts`, regola decisa: a.s. **settembre→luglio**, da agosto scatta il nuovo → `mese≥8 ? y/y+1 : y-1/y`); città = `scuole.citta` dal DB (degrado "Lì <data>" se assente); **intestazione sede reale** nel PDF (denominazione, indirizzo, CAP città (prov.), Cod. Mecc.) via `buildIntestazioneSede`, righe omesse se mancanti (mai inventate). Testi in builder puri testati (`src/lib/certificati/self-service.ts`). Resta `children[0]` (il tab non ha selettore figlio — follow-up).
- **Gallery docente** (`teacher/gallery/page.tsx`): `useState('Girasoli')` → `''` con fetch educator-sections; con 0 sezioni lo spinner si spegne (prima restava "Girasoli" per sempre + fetch transitorio errato al mount).
- **Default API a nome sezione** (latenti, raggiungibili solo omettendo il parametro): `attendance/daily`, `attendance/monthly`, `diary/entries` `.default('Girasoli')` → `.default('')`; `diary/students` `?? 'Girasoli'` → `?? ''`. Parametro omesso ora degrada a `[]` (ogni route aveva già l'early-return), niente più leak dei dati Girasoli.
- **Mappe email→sezione** (`maestra.anna/chiara@kidville.it → Girasoli/Tulipani`) rimosse da `api/tasks` e `api/educator-sections` (Method 3): verificato in prod via MCP che le email **non esistono** e che **tutti i 9 docenti** hanno legami in `utenti_sezioni`. Sostituite dal metodo canonico `nomiSezioniDiUtente` (NUOVO in `src/lib/sezioni/docenti.ts`, riusato da entrambe le route); in `api/tasks` l'euristica sui media taggati resta come fallback secondario. Degrado a `[]` senza legami.
- **`api/tasks/meta`**: fallback `['Girasoli','Margherite','Tulipani','Coccinelle']` → `[]`; **`MonthlyAttendanceTable`** (`features/teacher/attendance/`): default prop `'Girasoli'` → `''`.
- **Dead code '3A'**: eliminati `GradesTab/LessonsTab/NotesTab` (`features/teacher/register/`, zero import, pagina register già redirect a `/teacher/primaria`). Le API legacy grades/notes/register-lessons restano (coperte da `__tests__/api`) — follow-up: deprecarle.

### Anagrafica di sede (multi-sede, NUOVO)
- **Modello**: `scuole.config.anagrafica` (JSONB esistente → zero DDL) con denominazione ufficiale, codice meccanografico, CAP, provincia, telefono, email, PEC, P.IVA/CF; `citta`/`indirizzo` restano colonne. Helper `src/lib/scuole/anagrafica.ts` (`zAnagraficaSede`; `normalizzaAnagraficaSede` — trim, vuoti→null, cod. mecc. e sigla provincia MAIUSCOLI; `parseAnagraficaSede` safe da JSONB, mai throw).
- **API**: `PATCH /api/admin/schools` accetta `anagrafica` zod-validata con **merge server-side** in `config` (preserva le altre chiavi; gate Direzione invariato; audit `logScrittura` già copre).
- **UI**: `SchoolsPanel` (Impostazioni → Gestione Multi-Sede) con bottone "Anagrafica" per sede → form inline (città/indirizzo + 8 campi) e cod. mecc. nella riga riassuntiva. Dati reali di Giugliano da inserire dal pannello (a cura utente).
- **Multi-sede by design**: `/api/parent/students` arricchita **per figlio** (`scuola_nome/citta/indirizzo/cap/provincia/codice_meccanografico` via lookup `scuole` sul `scuola_id`, best-effort senza FK) → fratelli in sedi diverse = certificati con intestazioni diverse; campi additivi (ChildSwitcher/use-parent-identity intoccati).

### B/C documentati come benigni (non toccati)
Default orari/soglie degli editor `admin_settings` (DB letto prima); placeholder UI "Es. Girasoli"; route di seed e commenti/JSDoc; `STANDARD_ENROLLMENT_MODEL_ID` (identità applicativa fissa); formule anno scolastico duplicate in `appello`/`GeneratoreRette`/`PaymentsDashboard`/`ScrutinioPeriodiManager` (follow-up: unificare su `annoScolasticoCorrente`); `sidi_config.codice_meccanografico` globale (follow-up: raccordo per-sede quando ci sarà >1 sede accreditata SIDI).

### Verifica (loop)
- **NUOVA journey assertiva** `e2e/primaria-360/journeys/90-dehardcode.spec.ts` (9 test: educator-sections/avvisi/gallery docente1 anti-Girasoli, default `''` su attendance/daily senza parametro, tasks 200, parent/students con classe+città+nome sede reali, download PDF certificato, PATCH+rilettura anagrafica su sede E2E, form Anagrafica nel pannello).
- **Diagnosi flakiness**: il primo loop 50× su **dev server** ha mostrato ~10 flake su D2/D7 — causa radice accertata via error-context = **stallo del dev server sotto 450 esecuzioni consecutive** (compilazione on-demand di Next + pressione memoria), **non** un bug di prodotto. Verifica quindi spostata sulla **build di produzione** (`next start`, ciò che si deploya).
- **Loop 50× su PRODUZIONE**: **450/450 passed** (9.3m), 0 flake. Journey **89** (non-regressione fix precedenti, incl. locker/educator-sections toccati) **10/10**. Sweep copertura **70-72** (26 personas, 420 visite) **26/26**, report `run/report-360.html` rigenerato → **0 difetti** (0 visivi/funzionali/sicurezza, 2 note-artefatto).
- **Unit test nuovi**: 17 (`anno-scolastico` 5, `certificati-self-service` 9, `scuole-anagrafica` 3). 1 rosso intermedio nel primo smoke (sigla provincia non maiuscola) → corretto nell'helper (non nel test) → verde.
- **Riscontri DB via MCP**: 9/9 docenti con `utenti_sezioni`, email cablate inesistenti, `scuole.citta='Giugliano'`, sede E2E `config.anagrafica` salvata/normalizzata (`NA1E000E2E`) e **Giugliano `config={}` intatta**.
- **Gate**: `eslint . --max-warnings 0` = **0** · `vitest run` = **818/818** (136 file) · `tsc --noEmit` = **0** · `npm run build` = **ok**.
- **Nativo**: non eseguibile (nessun emulatore/simulatore) — dichiarato, non finto.

**Stato**: categoria A svuotata (0 valori di sezione/classe/anno/città cablati nei percorsi runtime); B/C censiti come benigni; anagrafica di sede pronta per il multi-sede. Nessuna migrazione DB, nessun deploy. Codice su branch `feat/logout-anagrafica-fullscreen`, **non committato**.

---

## 🗓️ Changelog — Correzione 11 difetti Test 360° Primaria 2026-07-09 (branch `feat/logout-anagrafica-fullscreen`)

Risoluzione degli **11 difetti** aperti dal giro diagnostico 360° (vedi voce sotto). Piano in `docs/superpowers/plans/2026-07-09-primaria-360-11-difetti.md`, una **fase per difetto** con ragionamento sulla soluzione più pulita/performante senza regressioni, poi verifica a loop. **Nessuna migrazione DB** (unica scrittura dati: un `UPDATE admin_settings.diario_config` su Giugliano per allineare il default di F9). Decisioni F9 e F3/F4 prese con l'utente.

### Difetti risolti (codice)
**GRAVI (2)**
- **F1 · Mensa genitore data-binding** (`MensaCalendar.tsx:61-67`): la GET ritorna `{success, data:{saldo,prenotazioni,cutoffOra}}` e la fetch la avvolge in `{status, data}`, quindi il payload è `pRaw.data.data.*`. Estratto `const payload = pRaw.data.data ?? {}` e lette da lì `saldo (?? 0)`, `cutoffOra`, `prenotazioni`. Ora il badge mostra il **saldo reale** (0 se nessun ticket), compare il **banner cutoff** e i pulsanti "Prenota pranzo" sono **attivi** con saldo>0. Rami POST/DELETE invariati (`j.data.*` già corretti).
- **F2 · Armadietto docente sezione hardcoded** (`teacher/locker/page.tsx`): rimosso `const SEZIONE='Girasoli'`; aggiunto fetch `/api/educator-sections` → stato `sezione`/`availableSections` (pattern delle sorelle attendance/modulistica/diary), i 3 fetch usano `encodeURIComponent(sezione)`, effetti guardati su `sezione`, header "Sezione {sezione}", **selettore a pill** per docenti multi-sezione, `LoadStockModal classeSezione={sezione}`. Spinner chiusi anche quando il docente non ha sezioni.

**MEDI (6)**
- **F5 · Bottom-nav DOCENTE doppio-attivo** (`TeacherBottomNav.tsx`) e **F6 · GENITORE** (`BottomNav.tsx`): introdotto `const anyMainTabActive = mainTabs.some(t => t.href && isActive(t.href))`; il tab MENU è attivo solo con `isMenuSectionActive && !anyMainTabActive`. Rimossa l'esclusione parziale `!== '/teacher/attendance'` (mascherava attendance). Ora **una sola voce attiva** per rotta; corretto anche il bug latente per cui su `/teacher/attendance` nessun tab era attivo.
- **F7 · Impostazioni armadietto spinner permanente** (`teacher/settings/locker/page.tsx`): `setLoading(false)` su tutti i rami terminali senza sezioni nido/infanzia (`!d.success`, `names.length===0`, `.catch`). Niente più spinner eterno per la primaria.
- **F8 · Note genitore plurale** (`parent/primaria/note/page.tsx:94`): rimosso il ternario no-op; ora `{n>1 ? 'note' : 'nota'} in attesa di firma` → "4 note", "1 nota".
- **F3 · KPI "Alunni iscritti" 19 vs 23 → FALSO ALLARME** (nessuna modifica): verificato sul DB prod che gli iscritti sono **23** (tutti `stato='iscritto'`, sede unica) e la query KPI (`.in scuola_id .eq stato='iscritto'`) restituisce 23; il "19" era un **artefatto di seed transitorio** del 07-08. Verificato live: `GET /api/admin/dashboard` → `studenti.iscritti = 23`.
- **F4 · Grafico "Alunni per classe" barre a ~0 → FALSO ALLARME** (nessuna modifica): il `BarChart` usa `dataKey="count"` con `<YAxis>` a dominio Recharts di default `[0, dataMax]`, baseline 0; il payload `perClasse` = TEST 1A **11**, TEST Infanzia **10**. Le "barre a ~0" erano uno **screenshot catturato durante l'animazione** `animationDuration={1200}`/compilazione dev. Verificato live via API.

**MINORI / ESTETICO (3)**
- **F9 · Diario 0-6 fail-closed per la primaria** (decisione utente, **inverte** il default fail-open della voce precedente): `diario_primaria_visibile` ora è esposto in primaria **solo se attivato** dall'admin. Modificati `api/diary/config/route.ts` (`=== true`), `teacher/diary/page.tsx` (`=== true`), `DiarioSettings.tsx` (default `?? false` + copy "Disattivo di default"); `UPDATE admin_settings` Giugliano → `false`; aggiornato il commento del test e2e `84-diario-primaria` (il `finally` ora ripristina a `false`). Coerente con la dashboard "Nessuna attività infanzia/nido". Infanzia/nido invariati; e2e 84 verde.
- **F10 · Overflow avatar classe** (`teacher/primaria/page.tsx:66`): il badge quadrato 52×52 ora ha `overflow-hidden px-1 text-center text-sm uppercase leading-tight [word-break:break-word]` → "TEST 1A" contenuto entro i bordi.
- **F11 · Grafico Incassi asse Y** (`DashboardCharts.tsx`): asse Y con **tick uniformi** a passo adattivo (500/1000/2000/5000, ~5 tick) e formato it-IT (`tickFmt`), `domain=[0,top]`, `ticks` espliciti → spariti i tick disuniformi `450/900` e il formato misto `k`.

### Verifica (loop)
- **Suite assertiva dedicata** `e2e/primaria-360/journeys/89-fix-360.spec.ts` (10 test su UI+backend per F1–F11 con sessioni reali): **>50 iterazioni consecutive verdi** (`--repeat-each` 15+18+18 = **510 esecuzioni, 0 flake**) + passate singole.
- **Non-regressione**: sweep di copertura `70-72` (26 personas, **420 visite**) → **0** issue grave/medio/minore su tutte le pagine; adversarial/scoping **0 violazioni**; journey 84-88 verdi (incl. `84-diario-primaria` con il nuovo fail-closed).
- **Riscontri DB via MCP**: iscritti 23, saldi ticket TEST 1A (es. Alunno1=57), 4 note in attesa per Alunno1, config diario Giugliano `false`.
- **Gate**: `eslint . --max-warnings 0` = **0** · `vitest run` = **801/801** (133 file) · `tsc --noEmit` = **0** · `npm run build` = **ok**.
- **Report** `run/report-360.html` **rigenerato** → **0 difetti** (0 visivi/funzionali/sicurezza, 2 note-artefatto, 420 visite). Diagnostico preservato in `run/visual-findings-diagnostic-2026-07-09.json`.
- **Nativo**: non rieseguito (nessun emulatore Android/AVD; iOS Simulator non ripilotato) — dichiarato, non finto.

**Stato**: **11/11 difetti chiusi** (9 fix di codice + 2 falsi allarmi documentati con prova DB). Nessun deploy. Codice su branch `feat/logout-anagrafica-fullscreen`, non committato.

---

## 🗓️ Changelog — Ripetizione Test 360° Primaria (diagnostico) 2026-07-09 (branch `feat/logout-anagrafica-fullscreen`)

Ripetizione **completa** della campagna 360° sulla classe **TEST 1A** con 26 personas reali. **Giro DIAGNOSTICO**: ha **scoperto 11 difetti reali ancora aperti** (nessuna correzione applicata in questo giro). Metodo: seed idempotente → rigenerazione storageState (26 login reali) → sweep Playwright di ogni route + journey d'azione + adversarial + logout → **Workflow multi-agente** di ispezione visiva sugli screenshot **freschi** (un ispettore per batch, **verifica adversarial per ogni difetto**, critico di completezza) → riconciliazione + root-cause nel codice.

### Esito sintetico
- **Sicurezza: 0 violazioni** — riverificato dal vivo (IDOR cross-alunno lettura/scrittura → 403; endpoint docente da genitore → 403; PII `/api/admin/students/[id]` e letture parent senza sessione → 401).
- **Funzionali (backend/azioni): 0 difetti** su sweep (420 visite, 0 5xx/403) + journey d'azione (firma, valutazioni O.M. 3/2025, note, avviso+adesione gita, firma FEA/OTP, mensa, chat, pagamenti, logout). La prenotazione mensa **via API** è accettata.
- **Ispezione visiva: 23 candidati → 17 confermati** dopo verifica adversarial → **11 difetti distinti** (dedup). **Falsi positivi eliminati**: indicatore dev Next.js (cerchio "N" in basso a sx), date-input nativi in formato en-US del browser headless, bottom-nav resa a metà pagina negli screenshot full-page, dati di test `[E2E360]`.

### Difetti APERTI (da correggere in un giro successivo)
**GRAVI (2)**
- **Mensa genitore — regressione data-binding** (`MensaCalendar.tsx:51,62-65,113,180,234`): la GET `/api/mensa/prenotazioni` ritorna `{success, data:{saldo,...}}` (route.ts:89) e il client la avvolge in `{status, data}` ma poi legge `pRaw.data.saldo` invece di `pRaw.data.data.saldo` → `saldo=undefined` → badge "— ticket", banner cutoff assente e **pulsanti "Prenota pranzo" disabilitati (il genitore non può prenotare dalla UI)**. Il menu (`mRes.data`) legge un solo livello: asimmetria = origine della regressione.
- **Armadietto docente — sezione hardcoded** (`teacher/locker/page.tsx:15,76,94,107,175`): `const SEZIONE = 'Girasoli'` cablato → per il docente di primaria header "Sezione Girasoli" e **scope dati sbagliato** (lista alunni/consumo/mensile su sezione errata). Le pagine sorelle (attendance:461, modulistica:65) erano già de-hardcodate; locker è rimasta indietro.

**MEDI (6)**
- Dashboard Direzione KPI **"Alunni iscritti" = 19** mentre presenze/topbar/Anagrafica dicono **23** (sotto-conteggio della query KPI).
- Dashboard grafico **"Alunni per classe"**: barre appiattite a ~0 pur con 11/10 alunni (errore di scala data-viz).
- **Bottom-nav a doppio-attivo** DOCENTE (`TeacherBottomNav.tsx:97-99,110`) e GENITORE (`BottomNav.tsx:59,99,111-113`): `isMenuSectionActive` accende MENU anche su rotte con tab dedicato → due voci "attive" insieme.
- **Impostazioni armadietto materiali** (`teacher/settings/locker/page.tsx:37,56,67,70`): senza sezioni nido/infanzia `loading` non va mai a `false` → spinner "Caricamento..." **permanente** insieme all'empty-state (dead-end per la primaria).
- **Note genitore**: banner **"4 nota in attesa di firma"** (pluralizzazione rotta, `parent/primaria/note/page.tsx:94`).

**MINORI / ESTETICI (3)**
- **Diario 0-6 esposto di default alla primaria** (`teacher/diary/page.tsx:40`, fail-open): mostra le routine nido NANNA/SVEGLIA/BAGNO a una classe di primaria (mitigabile col toggle admin, ma il default è visibile).
- **Overflow testo** nell'avatar "CLASSE TEST 1A" (Le mie classi / Registro) su più docenti.
- Grafico **"Incassi · ultimi 6 mesi"**: tick asse Y non uniformi (`2k·1k·900·450·0`) e formato misto.

### Nativo (dichiarazione onesta, non finto)
- **Android — BLOCCO ambiente**: nessun emulatore/AVD e `adb` non disponibile → APK non installabile/pilotabile. **Ripiego dichiarato**: docente/genitore provati in **web mobile 390×844** (sweep Playwright).
- **iOS — non rieseguito**: Simulator disponibile ma build non rieseguita + limite noto (contesto WebView non esposto ad Appium sul Simulator). Nessuno screenshot nativo di questo ciclo incluso.

### Deliverable
- `e2e/primaria-360/run/report-360.html` **rigenerato** (solo difetti, screenshot **freschi** compressi, causa dal codice, sezioni sicurezza/nativo/lacune) + pubblicato come **Artifact** condivisibile.
- Nuovo generatore `e2e/primaria-360/scripts/build-report-fresh.mjs`; `visual-findings.json`/`lacune.json` rigenerati dal Workflow; `native/native-declaration.json`.

**Gate** (ri-verificati; nessuna modifica a `src/`, solo file sotto `e2e/primaria-360/**` ignorati da eslint): `eslint . --max-warnings 0` = **0** · `vitest run` = **801/801** (133 file) · `npm run build` = **ok**.

**Stato**: giro **diagnostico** completato; **11 difetti reali APERTI** (2 gravi, 6 medi, 3 minori/estetici) da pianificare per la correzione. Nessun deploy. Codice su branch `feat/logout-anagrafica-fullscreen`.

---

## 🗓️ Changelog — Residui Test 360° Primaria 2026-07-09 (branch `feat/logout-anagrafica-fullscreen`)

Chiusura dei **5 rilievi residui** della campagna 360° (E24 diario, E25 minori/i18n, estetici, findings stali), trattati per gravità con **verifica a loop** (≥30 giri verdi per fase, **50× finali**; ogni test copre backend+frontend+debug+grafica; al primo rosso si torna alla causa radice). **Nessuna migrazione DB** (toggle = JSONB additivo con default nel codice; CRUD campanelle su colonne già esistenti). Decisioni prese voce per voce con l'utente.

### Fase 1 — Diario 0-6 configurabile per la primaria (E24) ✅
Decisione utente: il diario resta **comunque esposto** in primaria di default, ma l'admin può disattivarlo dalle Impostazioni. Nuovo toggle `diario_config.diario_primaria_visibile` (default `true`, **fail-open**).
- `DiarioSettings.tsx`: nuovo `CheckField` "Esponi il diario 0-6 ai docenti di primaria" (merge server-side già esistente su `/api/admin/settings`, nessuna modifica alla route).
- `GET /api/diary/config`: espone `diario_primaria_visibile` (`!== false`).
- `GET /api/educator-sections`: aggiunta **backward-compatible** di `sections[].school_type` (invariato `sectionNames`, letto da 7 consumer).
- `/teacher/diary`: se il toggle è OFF filtra le sezioni `school_type === 'primaria'`; empty-state dedicato per il docente di sola primaria ("usa il Registro"). Verifica: loop **60/60** (spec `84-diario-primaria`, workers=1).

### Fase 2 — Registro con slot esclusi visibili + editor orari admin ✅
Decisione utente: **opzione B** (mostrare gli slot esclusi) + l'admin deve poter modificare gli orari.
- `teacher/primaria/[sectionId]/registro`: rimosso il filtro client `tipo==='lezione'` → intervallo/mensa resi come **righe non firmabili** (la numerazione ore non "salta" più: lo slot escluso è visibile). Firma/conteggi ricalcolati sulle sole lezioni (`ordine` invariato = chiave di `registro_orario.ora_lezione`).
- Nuovo **CRUD campanelle**: `POST /api/admin/primaria/orario?action=add-campanella|update-campanella|delete-campanella` (gate `requireStaff` + zod: enum tipo, `ora_fine>ora_inizio`, cleanup cella orfana se il tipo lascia `lezione`). UI in `OrarioManager` ("Modifica campanelle": orari/tipo inline + aggiungi/elimina). Verifica: loop **60/60** (spec `85-registro-orario`).

### Fase 3 — Minori testuali (E25) ✅
- **"Task" → "Attività"** (testo visibile): `teacher/tasks/page.tsx` (tab "Tutte le attività", empty-state, loading), `TaskResolutionModal` ("Risolvi attività", placeholder), `TeacherBottomNav` (sub). Identificatori di codice invariati.
- **Tab con scroll orizzontale** (affordance, niente troncamento): tab-bar di `/teacher/tasks` → `overflow-x-auto` + `shrink-0 whitespace-nowrap`.
- **Casing nomi**: `nomeCompleto`/`titleCaseNome` applicato ai nomi grezzi del registro (docente firmatario, destinatari sostegno).
- **"si" → "Sì"**: verificato via grep → **non-issue** (i toggle usano già `'sì'`; gli altri `si` sono valori enum non visibili). Verifica: loop **30/30** (spec `86-minori-testuali`).

### Fase 4 — i18n date pagamenti genitore ✅
`isoToIt` (da `lib/format/data`, con fallback al grezzo) su `StoricoPagamenti.tsx` e `PagamentiSummary.tsx` → la scadenza è resa `gg/mm/aaaa`, mai ISO. Verifica: loop **30/30** (spec `87-pagamenti-date`, scadenza `07/07/2026`).

### Fase 5 — Estetici (tutti e 3) ✅
Decisione utente: includere tutti.
- Pulsante "Carica file compilato" (`ImportExportClient`) da **blu off-brand** (`bg-kidville-info`) a **verde brand**.
- Input file SIDI (`SidiPanel`) da nativo "Choose File" a **label italiana** "Scegli file .zip" (input nascosto).
- **Muri di trattini** negli slot orario vuoti (`OrarioGrid`) → placeholder tenue (`·`). Verifica: loop **90/90** (spec `88-estetici`).

### Fase 6 — Findings stali rigenerati ✅
- **Mensa 401 "userId mancante" (era grave)**: **artefatto** confermato — la route `/api/mensa/prenotazioni` usa già `requireUser` + `genitoreDiAlunno` (identità dalla sessione, mai dal client). Il 401 era la sessione storageState di genitore1 scaduta tra journey 30 e 60. Rieseguito `60-fixups` con sessione fresca → **verde**, 0 occorrenze 401.
- **PII bloccante** `admin/students/[id]` → confermato stale: adversarial-anon = **401**.
- Rieseguiti journey `10-60` + copertura `70/71/72` (**26/26**, 420 visite, 0 5xx/403) + adversarial `80` (**2/2**) + bucket `81/82/83` (**8/8**). Findings: **0 bloccanti, 0 gravi** (funzionali/sicurezza/grafici); marcati risolti nel `visual-findings` i 6 rilievi ora chiusi (blu→verde, Choose File, trattini, 2× date ISO pagamenti, TASK).
- **Native Appium NON rieseguiti** (nessun emulatore Android/simulatore iOS nell'ambiente): i 2 rilievi "login landing" restano stali dal ciclo precedente (limite dell'harness nativo login-through, non difetto dell'app web) → documentati nel report con disclaimer.
- Report `run/report-360.html` rigenerato: **bloccanti 0**, sezione sicurezza resa positiva ("✓ 0 bloccanti — verificato dal vivo").
- **Nota di metodo (scoperta):** il journey `50-logout` invalida le sessioni server-side (signOut) → gli spec eseguiti dopo ricevono 401; va eseguito **per ultimo** o le sessioni vanno rigenerate. Lo storageState va rigenerato ogni ~1h (scadenza token).

**Gate finali**: `eslint . --max-warnings 0` = **0** · `vitest run` = **801/801** · `tsc --noEmit` = **0** · `npm run build` = **ok**.

**Stato**: 5 residui **RISOLTI e verificati** (loop 50× verdi per fase; copertura 26 personas senza 5xx/403; adversarial verde; gate verdi). Codice su branch `feat/logout-anagrafica-fullscreen`, **NON mergiato/deployato**.

---

## 🗓️ Changelog — Correzione rilievi Test 360° Primaria 2026-07-08 (branch `feat/logout-anagrafica-fullscreen`)

Chiusura dei rilievi della campagna 360° (bloccanti sicurezza + gravi + medi + minori testuali), un commit per bucket, con **verifica a loop**: ogni fase ha un test dedicato (backend+frontend+debugging+grafica) eseguito ≥30× consecutive verdi; al primo rosso si torna alla causa radice.

### BUCKET A — Sicurezza (bloccanti IDOR / PII / auth-bypass) ✅
- Nuovo helper condiviso `src/lib/auth/require-parent.ts` → `requireParentOfStudent(request, studentId)`: `requireUser` (identità legata alla **sessione**, `ALLOW_HEADER_IDENTITY=false` → niente `?userId=` spoofabile) + `genitoreHasFiglio` (unione `legame_genitori_alunni` + `student_parents`/ponte) → **403** se l'alunno non è del genitore; staff/educator passano.
- **E1 — IDOR letture** migrate al gate: `parent/primaria/{valutazioni,note,assenze,pagella,orario,scrutinio}`, `parent/presenze`, `parent/mensa/allergie`, `parent/competenze` (rimosso il `parentOwnsStudent` bacato che saltava il ponte `parents.auth_user_id`).
- **E2 — IDOR scritture**: `parent/primaria/pagella/firma`, `parent/giustifiche-didattiche`, `parent/presenze/comunica-assenza`, `parent/presenze/giustifica`, e `persist-submission` (`parent/submissions` POST + `parent/forms/otp` PATCH) validano che `student_id` sia del genitore (onboarding con `student_id` null ammesso).
- **E3 — PII anonima**: `admin/students/[id]` GET ora richiede `requireStaff` (era service-role senza gate).
- **E4 — Locker**: rami genitore `?alunno_id` di `locker/inventory` e `locker/requests` ora passano da `requireParentOfStudent` (erano aperti in anonimo → IDOR).
- **E5 — Auth-bypass**: chiuso dal passaggio a `requireUser`/`resolveIdentity`.
- **Verifica**: `80-adversarial.spec.ts` riscritto con asserzioni reali (fallisce se una violazione persiste) + copertura E2/E4/extra-E1 → **60/60 verdi (30 loop × 2 test)**. Nuovo unit test `require-parent.test.ts`; aggiornati `competenze/fea-giustifica/fea-pagella-firma/orario/presenze` (mock del nuovo gate). Gate: `eslint . --max-warnings 0` = 0 · `vitest run` = **798/798**.

### BUCKET B — Gravi funzionali ✅
- **E6/E7/E8 — Sezione "Girasoli" hardcoded** rimossa: `teacher/attendance` e `teacher/modulistica` derivano la sezione reale da `/api/educator-sections` (+ selettore multi-sezione); `parent/avvisi` non parte più da 'Girasoli' (attende la classe del figlio).
- **E9 — Certificati medici**: `/api/teacher/medical-certificates` aperto al DOCENTE (`requireDocente` + scope sezione/plesso + audit) invece di `requireStaff` → niente più 403 sul tab certificati.
- **E10 — Hydration gallery/attendance**: nuovo hook `useOnlineStatus` (`useSyncExternalStore`, SSR-safe) al posto di `useState(navigator.onLine)` → niente mismatch né setState-in-effect.
- **E11 — Locker `alunno_id=null`**: guardia identità in `fetchData` (+ empty-state "nessun bambino collegato") → niente 400/500.
- **E12 — `/api/parent/submissions` 500**: GET reso difensivo (niente embed FK annidato; arricchimento con query separate) → onboarding/modulistica non vanno più in 500.
- **E13/E14 — Chat docente/genitore bloccata su skeleton**: consumo di `ready` di `useSessionIdentity` + `loadThreads` che azzera `loading` con identità valida → niente skeleton infinito, titolo sempre visibile dopo il caricamento.
- **E15 — Dashboard direzione, 6 KPI vuote**: consumo di `ready` (skeleton solo durante la risoluzione identità; stato "sessione non valida" esplicito) → i KPI si popolano.
- **Verifica**: nuovo `81-copertura-bucketB.spec.ts` (docente1/genitore1/segreteria; backend API + frontend/hydration/no-5xx) → **90/90 verdi (30 loop × 3 test)**. Gate: `eslint` 0 · `vitest` 798/798 · `build` ok.

### BUCKET C — Roster/dati primaria ✅
- **Diagnosi (MCP)**: i dati di TEST 1A risultano **già corretti** (sezione `school_type='primaria'`, `scuola_id` giusto, 11 alunni `stato='iscritto'` con `section_id`) → **E16 "0 in classe" ed E17 "nessuna sezione primaria" erano artefatti dello screenshot originale, già risolti** (nessuna scrittura dati necessaria).
- **E18 — Default `school_type`**: `POST /api/admin/sections` ora valida `school_type ∈ {nido,infanzia,primaria}` (zod enum) → niente valori spazzatura; default 'infanzia' solo se omesso (la UI passa sempre il grado, `SectionsView`).
- **Verifica**: `82-copertura-bucketC.spec.ts` (segreteria: sezioni→TEST 1A primaria, roster→11 alunni, school_type invalido→400) → **90/90 verdi (30 loop × 3 test)**. Gate: `eslint` 0 · `vitest` 798/798.

### BUCKET D — Medi UI/i18n + testuali ✅
- **E19 — i18n date**: nuovo componente `DateField` (gg/mm/aaaa deterministico, SSR-safe, senza setState-in-effect) + helper puri `lib/format/data` (isoToIt/itToIso/maskItDate con validazione di calendario) → sostituiti gli `<input type=date>` in anagrafica alunno/genitore (`Scrollable{Student,Adult}Form`), mensa eccezioni (`MenuBuilder`), impostazioni mensa (`MensaSettings`), report cucina (`MensaReport`).
- **E20 — Placeholder mensa troncato**: placeholder ingredienti accorciato ("Ingredienti…") → niente clipping "…basil".
- **E21 — Refuso "primaria.La"**: già corretto nel sorgente (lo spazio dopo `</strong>` è preservato da JSX) — nessun intervento.
- **E22 — Empty-state scrutinio**: messaggio consapevole del ruolo (staff → "configuralo da Impostazioni → Didattica primaria"; docente → "chiedi alla segreteria") invece del circolare unico.
- **E23 — Banner ClasseShell ripetuto**: mostrato una sola volta (solo su Panoramica), non su ogni tab della classe.
- **Verifica**: `format-data.test.ts` + `83-copertura-bucketD.spec.ts` (report cucina gg/mm/aaaa; banner solo Panoramica) → **60/60 verdi (30 loop × 2 test)**. Gate: `eslint` 0 · `vitest` **801/801** · `build` ok.
- **Rinviati ai residui** (prompt atomico): **E24** (diario 0-6 con voci nido NANNA/BAGNO esposto in primaria — fix architetturale su componente condiviso nido/infanzia: non esporlo in primaria o rendere le routine configurabili per grado) e **E25** (minori testuali da localizzare con certezza); estetici puri fuori scope per decisione utente. → **RISOLTI il 2026-07-09** (vedi changelog "Residui Test 360°" in cima: E24 = toggle admin `diario_primaria_visibile`; E25 + date pagamenti + estetici tutti chiusi).

### FASE FINALE — Verifica end-to-end ✅
- **Copertura completa** (26 personas reali: 1 segreteria + 5 docenti + 20 genitori) `70/71/72` + `80-adversarial`: **28/28 verde**, **0 findings 5xx/403 spuri** (dopo il fix locker).
- **Fix supplementare scoperto in verifica**: `/api/locker/requests` dava 500 perché la tabella `locker_requests` **non è migrata su prod** (esistono solo `armadietto`/`locker_config`) → degrado a vuoto su errore tabella-mancante (42P01).
- **Loop 50× consecutivi verdi** per ogni dominio: adversarial **100/100**, BUCKET B **150/150**, C **150/150**, D **100/100** (i page-visit del cockpit richiedono ≤2 worker per evitare timeout di contesa; le sessioni Playwright vanno rigenerate ogni ~1h per la scadenza del token).
- **Gate finali**: `eslint . --max-warnings 0` = 0 · `vitest run` = **801/801** · `npm run build` = ok.
- **Report** `run/report-360.html` rigenerato: **bloccanti 0** (tutti i findings di sicurezza chiusi e verificati 50×). Marcati risolti nel `visual-findings` i 5 gravi (gallery/appello/chat×2/dashboard) + i medi Girasoli/mensa/scrutinio/banner/roster (17 findings). Residui nel report: **3 gravi STALI** da journey d'azione/nativo NON rieseguiti in questo ciclo (es. `60-fixup` mensa/prenotazioni 401; test nativi Appium) e **medi residui** (date ISO in pagamenti — fuori dal perimetro DateField; E24 diario; E25 minori testuali; estetici puri). → **Aggiornato 2026-07-09**: il `60-fixup` mensa 401 era un **artefatto di sessione** (route già corretta, riverificata verde); date pagamenti/E24/E25/estetici **risolti**; restano solo i 2 findings nativi Appium (non rieseguibili senza emulatore), documentati con disclaimer nel report.

**Stato**: bloccanti + gravi + medi in scope **RISOLTI e verificati** (adversarial 50× verde; copertura 26 personas senza 5xx/403; gate verdi). Codice su branch `feat/logout-anagrafica-fullscreen` (5 commit: 59461bb, 8ff4217, f7f52bd, e546e37 + fix locker), **NON mergiato/deployato**.

---

## 🗓️ Changelog — Campagna Test 360° ULTRA Primaria 2026-07-08 (branch `feat/logout-anagrafica-fullscreen`)

Campagna di test 360° multi-agente ultra-scrupolosa su **TEST 1A** (Giugliano, DB prod). Roster **26 personas** con login reale a sessione (1 segreteria desktop + 5 docenti + **20 genitori = 10 alunni × madre+padre**). Seed esteso idempotente (`e2e/primaria-360/`): 10 account padre su auth prod + collegamento dual-parent (`parents.auth_user_id`, `student_parents`, `student_guardians`, `legame_genitori_alunni`) — riconciliato via MCP (20 legami / 20 student_parents / 20 guardians).

**Copertura**: matrice canonica route×ruolo (`config/coverage-matrix.ts`); sweep Playwright di **420 route-visite** su tutte le personas (journeys `70/71/72`) + journey d'azione `10-60` (firma, valutazioni, note, avvisi, adesione gita, FEA/OTP, mensa, chat, pagamenti, logout). **App NATIVA Capacitor pilotata via Appium** su **Android** (UiAutomator2, context `WEBVIEW_`, APK ri-buildato con `CAP_SERVER_URL`; shell/safe-area/tasto back/deep-link `kidville://` verificati) e **iOS Simulator** (XCUITest; app caricata dal server, safe-area ok). Ispezione visiva multi-agente (Workflow, 9 agenti + critico completezza) su 494 screenshot → 92 rilievi grafici/UX/testuali.

**🔴 Findings BLOCCANTI di sicurezza (access control) — verificati empiricamente, DA CHIUDERE:**
- **IDOR** `/api/parent/primaria/{valutazioni,note,assenze,pagella}`: usano solo `getRequestUserId`, **nessun** `genitoreHasFiglio(userId, studentId)` → un genitore legge i dati di un alunno altrui via `?studentId=` (confermato: genitore1 → dati Alunno2, HTTP 200).
- **PII senza auth** `/api/admin/students/[id]` GET: service-role **senza gate** → alunno + genitori + CF + indirizzi esposti a client anonimo (HTTP 200).
- **Auth bypass**: `parent/primaria/valutazioni` con `userId` arbitrario e nessuna sessione → 200.
- Fix indicato: `requireUser`+`genitoreHasFiglio` sulle route parent/primaria; `requireStaff` su `admin/students/[id]`. (Cross-role write genitore→docente correttamente 401.)

**Findings funzionali (medi)**: `SEZIONE='Girasoli'` hardcoded in `teacher/attendance/page.tsx:13` e `CLASS_NAME='Girasoli'` in `teacher/modulistica/page.tsx:10` → 403 delegates/certificati per docente primaria; `/parent/locker` 500 (`alunno_id=null`), `/api/parent/submissions` 500 (onboarding/modulistica); hydration error `/teacher/gallery`; dashboard direzione con 6 card KPI vuote; date in formato USA `mm/dd/yyyy`; classe TEST 1A "0 alunni" vs 11 in anagrafica; refuso "primaria.La"; placeholder mensa troncato.

Deliverable: **Artifact HTML** self-contained (matrice, findings per gravità con screenshot data-URI, sezione nativo, lacune). Cleanup: 9 prenotazioni mensa + 1 firma FEA di test eliminate. **Gate verdi**: eslint 0, tsc 0, vitest 790/790, build ok. Le vulnerabilità bloccanti restano **da correggere** (segnalate, non ancora fixate in questo giro).

---

## 🗓️ Changelog — Risoluzione problematiche Test 360° Primaria 2026-07-08 (branch `feat/logout-anagrafica-fullscreen`)

Risolte tutte le 19 problematiche emerse dal test 360° (decise voce per voce con l'utente). Fasi con gate verdi tra l'una e l'altra.

- **Fase A — UI/estetici** (voci 5,8,9,10,11,12,13,14,15): padding bottom-nav genitore `pb-16→pb-24` (avvisi/diary/gallery); `ChatListSkeleton` condiviso al posto dello spinner (parent+teacher); mensa genitore mostra il **cutoff** (GET `/api/mensa/prenotazioni` restituisce `cutoffOra`); valutazioni genitore auto-espanse con singola materia + anteprima giudizio; logo login `h-7→h-12`; saluto home fallback **neutro** + skeleton anti-flash (genitore) e docente time-aware (no “maestra”); registro “**orario da completare**” muted al posto di “materia non assegnata”; helper `src/lib/format/nome.ts` (titleCase) sui nomi lista alunni; compiti genitore **data unica** (chip it-IT).
- **Fase B — Compiti** (voce 4): datepicker “Consegna compiti” nella `FirmaModal` primaria (l'API già accettava `dataConsegnaCompiti`).
- **Fase C — Dashboard** (voce 1): il “16 vs 23” era transitorio (verificato: tutti i 23 di Giugliano sono `iscritto`, admin mono-plesso). **Solo etichette** (numeri invariati): KPI “stato iscritto · sedi attive”, anagrafica “Totale (tutti gli stati)”.
- **Fase D — Firma registro** (voce 6): guard applicativo (409) + indice DB parziale `UNIQUE(registro_id) WHERE tipo='principale'` (migr. `20260708174412`, de-dup incluso). Una sola firma principale per ora.
- **Fase E — Cockpit** (voce 16): nuovo `AdminIdentityProvider` (`useSyncExternalStore`, two-pass SSR-safe) → **fix hydration-mismatch** sidebar + dedup di `userId` (3 letture → 1: AdminSidebar/AdminTopBar/SedeProvider).
- **Fase F — Mensa docente** (voce 3): nuova vista read-only `/teacher/mensa` (per sezione) riusando `/api/mensa/report` + voce nav (rimosso “In arrivo”).
- **Fase G — Bridge & mensa genitore** (voci 2,17): helper condiviso `src/lib/anagrafiche/legami.ts` (**union** runtime `legame_genitori_alunni` + anagrafica `student_parents` via `parents.auth_user_id`) → contesto figlio robusto; `/api/parent/students` + mensa authorization migrati; `/parent/mensa` stato “nessun alunno collegato”. **Item 2 risolto** (verificato: genitore1 figlio-unico → saldo 29 + prenotazione). Consolidamento fisico (voce 17, deciso “drop+view in più step con cautela”): scoperti blocchi (colonne split pagamenti assenti in student_parents, embed PostgREST che si rompono su view, identità `parents.auth_user_id` disconnesse, **nessuna famiglia reale in DB**) → **Step 1** consegnato = fondazione additiva sicura: tabella canonica **`student_guardians`** (migr. `20260708174430`, rebuild validato via rollback, idempotente) + helper union come fonte logica unica. Il cutover fisico (DROP+VIEW + refactor embed) resta step finale documentato.
- **Fase H — Iscrizione pubblica** (voce 18): risoluzione scuola robusta (`?scuola=` o scuola reale escludendo la seed E2E). **Verificato**: POST persiste su Giugliano (riga di test rimossa). Sblocca gli E2E public-iscrizione.
- **Fase I — FEA gita** (voce 19): `avvisi.form_model_id` (migr. `20260708174440`, POST/GET resilienti) + semaforo **per-gita** (`/api/teacher/uscite?form_model_id=`). Copertura harness 360 (seed modulo firmabile + firma OTP genitore1 in 30-genitori + verifica semaforo in 40-riscontri). **Verificato end-to-end**: send-otp POST→devCode, PATCH→completed+signed_at; semaforo autorizzato solo per il modulo firmato.
- **By-design (nessun codice)**: voce 7 (label 2° tab bottom-nav adattiva primaria/infanzia); voce 13 salto ore = intervallo/mensa esclusi.

Migrazioni prod (`20260708174412/174430/174440`) **APPLICATE a prod via MCP Supabase** e verificate (indice firma creato + duplicato 5→1 risolto; `student_guardians` popolata 34 righe/24 alunni; `avvisi.form_model_id` presente; advisor security = 0 ERROR). Il DB E2E CI non migrato resta gestito con degrado grazioso (PGRST204/42703).

Gate: `eslint . --max-warnings 0` = 0 · `vitest run` = 790/790 (aggiunti `format-nome.test.ts`, `legami.test.ts`) · `tsc --noEmit` = 0 · `build` ok.

---

## 🗓️ Changelog — Logout + Anagrafica fullscreen + Test 360° Primaria 2026-07-07 (branch `feat/logout-anagrafica-fullscreen`)

Interventi UI su richiesta utente + campagna di test funzionale end-to-end sulla scuola primaria.

- **(a) Pulsante Log out in TUTTE le aree.** Prima non esisteva alcun logout nell'app (né Direzione/Segreteria,
  né Docente, né Genitore). Aggiunti: helper client `doLogout()` (`src/lib/auth/logout.ts` — chiude la sessione
  Supabase `auth.signOut()`, azzera i cookie server-side via `POST /api/auth/logout` [`kv-active-role`,
  `sedi_attive`], ripulisce l'identità applicativa in `localStorage` [`kv_user_id`/`_role`/`_parent_id`/
  `_student_id`/`_teacher_id`], reindirizza a `/auth/login`); nuovo endpoint `src/app/api/auth/logout/route.ts`;
  componenti `UserMenu` (dropdown sulla scritta ruolo "Segreteria/Direzione" in alto a destra della TopBar cockpit)
  e `LogoutMenuButton` riusabile (drawer mobile Direzione, bottom-sheet Docente e Genitore).
- **(b) Scheda anagrafica a TUTTA AREA (non più drawer laterale).** Il dettaglio alunno/genitore si apriva come
  pannello laterale stretto sopra la lista. Ora apre nella nuova route `/admin/students/[id]` (full-screen, pattern
  `CockpitPage` + back-link, coerente con `/admin/students/sezioni/[id]`). `StudentDetailPanel`/`ParentDetailPanel`
  hanno una prop `variant='page'|'drawer'`; la tabella naviga alla route (propaga `?userId=`+`kind=`); rimosso
  l'overlay `selectedStudent` dalla lista. Logica di salvataggio/associazione invariata (stessi endpoint PATCH/DELETE).
- **(c) Test funzionale 360° Primaria (TEST 1A prod) → resoconto condivisibile — ESEGUITO.** Completate le anagrafiche
  di test (11 alunni + 10 famiglie collegate via parents+student_parents+legame), portati i docenti primaria a **5**
  + creata la Segreteria di test, assegnazioni materia complete, password note verificate al login. Harness Playwright
  dedicato in `e2e/primaria-360/` (config isolata, 16 storageState, journeys 10/20/30/40/50/60), 70 screenshot, ispezione
  visiva da agenti + riconciliazione DB. **Esiti**: Segreteria (anagrafica fullscreen, orario, pagamenti €525 incassati,
  ticket) ✓; 5 docenti (firma+lezione+voti+compiti+3 note ciascuno, avviso gita) ✓; genitori (orario, visione,
  2 chiarimenti chat con risposta docente, 10/10 adesioni gita, 5/5 prenotazioni mensa) ✓; riscontri cross-ruolo
  (mensa→segreteria “5 pasti”, voto→genitore, incassi→segreteria, chat bidirezionale) ✓; logout ✓ in tutte le aree.
  **Problematiche (solo report)**: dashboard “16 vs 23 alunni”; mensa genitore non mostra saldo/prenotazioni (contesto
  figlio non risolto); docente senza vista mensa (“In arrivo”); data-consegna-compiti assente in UI docente;
  bottom-nav che copre contenuto in alcune viste; cutoff mensa 09:30 blocca “oggi” (corretto); chat con spinner lazy;
  overlay dev Next “1 Issue” = hydration-mismatch pre-esistente sidebar (solo dev). Firma FEA del modulo gita (OTP) non
  inclusa (meccanismo separato). Resoconto HTML condivisibile pubblicato come Artifact.

Gate feature: `eslint . --max-warnings 0` = 0 · `vitest run` = 776/776 (aggiunti `logout.test.ts`,
`auth-logout-route.test.ts`) · `build` ok (route `/admin/students/[id]` generata).

---

## 🗓️ Changelog — Hardening DB (ETL sede + REVOKE EXECUTE) 2026-07-06 (branch `fix/db-hardening`)

Migrazione `20260706210352` (applicata a prod via MCP `apply_migration` e verificata; repo allineato).

- **(a) ETL moduli d'iscrizione — sede non più hardcoded.** `fn_form_submission_etl` (trigger su
  `form_submissions`) inseriva i nuovi alunni con `scuola_id = '11111111-…'`, sede **inesistente**:
  la FK `alunni_scuola_id_fkey → schools(id)` falliva e l'`EXCEPTION` best-effort inghiottiva l'errore
  → l'alunno **non veniva mai creato** (silenzioso). Ora la sede è risolta da `public.schools` (mono-sede
  in prod → Kidville Giugliano); se nessuna sede, skip pulito. Bug era **latente** (`form_submissions`/
  `enrollment_submissions` a 0 righe: sarebbe scattato al 1° modulo d'iscrizione inviato dal builder).
- **(b) Superficie RPC ridotta (advisor SECURITY DEFINER).** `REVOKE EXECUTE` ad `anon`/`authenticated`
  su `fn_form_submission_etl` (solo trigger), `notifiche_dispatch_tick`, `rls_auto_enable`,
  `mensa_check_allergie_giornaliero` (non-trigger, non-RLS, non `.rpc` app; `service_role` mantenuto).
  Su `is_staff_or_admin` tolto **solo** ad `anon` (le sue policy RLS sono tutte `TO authenticated`).
  Esito advisor: **anon SECURITY DEFINER 5 → 0**; **authenticated 6 → 2** (restano `is_staff_or_admin`
  e `current_parent_student_ids`, **necessari** alle policy RLS del "parents space" — non rimovibili
  senza rompere RLS).

Non toccati (per scelta/rischio): `pg_net` in schema `public` (spostarlo può rompere webhook/push) e
**leaked-password protection OFF** (è un toggle Auth, da abilitare in dashboard Supabase → Authentication).
Gate: `eslint` 0, `vitest` 773/773, `build` ok.

---

## 🗓️ Changelog — Allineamento migrazioni DB ↔ repo 2026-07-06 (branch `chore/db-migration-align`)

Housekeeping post-deploy (verifica via MCP Supabase su prod `uimulkjyekgemjakmepp`). La migrazione
anagrafiche era nel repo come `20260767_*` — **nome-versione NON valido** (il CLI Supabase esige un
timestamp a 14 cifre `YYYYMMDDHHMMSS`) — mentre in prod risultava già applicata e registrata come
**`20260706105201`**. Verificato che lo schema prod è allineato: baseline `20260704120000` = dump completo
(include divise/fatture/certificati/sidi/push…), e `20260706105201` applicata **per intero** (4 colonne su
alunni+parents + funzione ETL). **Rinominato il file** → `20260706105201_anagrafiche_residenza_provincia_civico.sql`:
repo e prod coincidono, `supabase db push` resta un no-op pulito. Nessuna modifica a schema/dati.

Note residue emerse (non-bloccanti, da valutare a parte): (a) `fn_form_submission_etl` hardcoda una sede
inesistente (`11111111-…`) → il trigger ETL su `form_submissions` inserirebbe alunni orfani (path non usato
dall'import via API, che passa da `enrollment_submissions`); (b) advisor Supabase **WARN** pre-esistenti:
funzioni SECURITY DEFINER esposte via RPC ad anon/authenticated, `pg_net` in schema `public`, leaked-password
protection off. Gli INFO `rls_enabled_no_policy` sono **by-design** (pattern service-role, non RLS).

---

## 🗓️ Changelog — Fix pre-deploy gate E2E 2026-07-06 (branch `feat/batch-segreteria`)

Tre regressioni emerse in CI (E2E Playwright rosso) sul batch segreteria, tutte risolte senza
alterare il comportamento di prodotto voluto:

- **`/api/admin/students` (GET) resiliente al 42703** — il commit del batch anagrafiche aveva
  aggiunto `residence_street_number`/`residence_province` (migrazione `20260767`) alla SELECT della
  lista, ma solo a POST/PATCH era stato dato il retry "pre-migration"; la GET no. Su un DB privo di
  quelle colonne (progetto E2E CI, o finestra pre-migrate di un deploy) PostgREST rispondeva 42703 →
  HTTP 500 → tabella anagrafica vuota. Ora la GET rimuove le colonne mancanti e riprova, come già
  facevano POST/PATCH. In prod le colonne esistono già → nessun cambiamento funzionale.
- **Diario genitore E2E** — il buffer visibilità 10' (introdotto nel batch) filtra su `creato_il`;
  il seed inseriva l'evento umore con `creato_il = now()` → nascosto ai genitori. Il seed ora
  retrodata `creato_il` di 30' (solo dati di test; il buffer di prod resta invariato).
- **Iscrizione pubblica E2E** — (a) `/admin/iscrizioni` ora reindirizza a *Modulistica → Moduli
  ricevuti*: aggiornata l'asserzione heading del test; (b) i 4 campi resi obbligatori sul form
  pubblico (Nazione/Cittadinanza/Civico/Provincia residenza) **restano obbligatori** (scelta
  confermata: dati completi per SIDI) → il test happy-path ora li compila; (c) **import iscrizione
  resiliente al 42703**: la PATCH `/api/admin/iscrizioni` scriveva `residence_street_number`/
  `residence_province` (mig. 20260767) su `parents`/`alunni`; su DB senza quelle colonne l'INSERT
  falliva e il `continue` saltava la creazione dell'account referente (nessuna credenziale emessa).
  Ora rimuove le colonne mancanti e riprova, come la GET students. In prod le colonne esistono → nessun impatto.

Gate: `eslint` 0, `vitest` verde, `build` ok, E2E Playwright verde in CI.

---

## 🗓️ Changelog — Configurazione invio email Resend 2026-07-06 (branch `feat/batch-segreteria`)

Attivazione dell'invio email reale tramite **Resend** (provider transazionale già cablato in
`src/lib/email/send.ts`, chiamata REST via `fetch` — nessuna libreria aggiuntiva). Consumatori:
OTP firma moduli (`/api/forms/send-otp`, `otp-ticket`), credenziali genitori
(`/api/admin/regenerate-credentials`, `/api/admin/iscrizioni`).

- **Fix bug link login nelle credenziali:** `credentialsEmailBody` puntava a `${NEXT_PUBLIC_APP_URL}/login`
  (rotta inesistente → 404); corretto in **`/auth/login`**, coerente con la rotta reale e con
  `regenerate-credentials`. Senza il fix i genitori avrebbero ricevuto un link rotto all'accensione delle email.
- **Scaffolding env** in `.env.local`: `RESEND_API_KEY` (vuoto → fallback log, nessun invio),
  `OTP_FROM_EMAIL` (fase 1 sandbox `onboarding@resend.dev` → fase 2 `noreply@kidville.it` a dominio verificato),
  `NEXT_PUBLIC_APP_URL` (base dei link nelle email).
- **Attivazione produzione (residuo, lato servizi esterni):** creare account Resend + API key, verificare
  il dominio `kidville.it` (record DNS SPF/DKIM), impostare le stesse env su Vercel (`RESEND_API_KEY`,
  `OTP_FROM_EMAIL`, `NEXT_PUBLIC_APP_URL` = URL prod).

Gate: `eslint` 0, `vitest` verde, `build` ok.

---

## 🗓️ Changelog — Unificazione Iscrizioni → Modulistica 2026-07-06 (branch `feat/batch-segreteria`)

Unificate le due voci di sidebar **Iscrizioni** e **Modulistica** in un'unica voce **Modulistica**.
Gate verde: `eslint` 0, `vitest` 773/773, `build` ok.

- La sidebar perde la voce **Iscrizioni**; la sezione «Anagrafica & Iscrizioni» è rinominata **«Anagrafica»**.
- La pagina **Modulistica** ha ora 4 tab: **Moduli inviabili** + **Moduli ricevuti** (spostate da Iscrizioni),
  **Moduli Genitori** e **Template Certificati ODT**. Rimossa la tab **Moduli Esterni**.
- «Moduli ricevuti» = le iscrizioni ricevute (invariato rispetto alla vecchia «Ricevute»): il link SIDI è preservato.
- I due motori restano separati (form-builder vs moduli-genitori OTP).
- I componenti sono stati estratti in `src/components/features/admin/iscrizioni/` (`ModuliInviabili`, `ModuliRicevuti`);
  `/admin/iscrizioni` è ora un **redirect** a `/admin/modulistica?tab=ricevuti` (link/segnalibri preservati).
  Modulistica legge `?tab=`; il back-link del builder punta a `?tab=inviabili`. Le tab inviabili/ricevuti
  operano multi-sede (fuori dalla guardia sede-singola che resta per Moduli Genitori/ODT).
- **Dashboard**: i link/KPI/alert che puntavano a Iscrizioni ora vanno a `/admin/modulistica?tab=ricevuti`;
  rimosso il doppione «Iscrizioni» dal menu rapido (già presente «Modulistica»). Fix `withUser` per usare
  `&` quando l'href ha già una query string (evita il doppio `?`).

---

## 🗓️ Changelog — Fix Segreteria/Didattica/Modulistica 2026-07-06 (branch `feat/batch-segreteria`)

Batch di 7 interventi correttivi. Gate verde: `eslint` 0, `vitest` 773/773, `build` ok
(e2e in CI su push). **Richiede l'applicazione della migrazione `20260767`** (colonne
residenza + ETL) sul DB prod prima dell'uso dei nuovi campi.

1. **Anagrafiche complete e allineate (alunno ≡ genitore).** Alunno e genitore hanno ora lo
   stesso set anagrafico completo; unica differenza i contatti (email/telefono, solo genitore).
   Aggiunti **Cittadinanza** (`citizenship`), **Nazione di nascita** (`birth_nation`),
   **Numero civico** (`residence_street_number`) e **Provincia di residenza** (`residence_province`,
   sigla) a: form di creazione (`ScrollableStudentForm`/`ScrollableAdultForm`), route
   `POST/PATCH/GET /api/admin/students`, e **schede di modifica** (`StudentDetailPanel`/`ParentDetailPanel`,
   prima incomplete). Migrazione `20260767`: `residence_province`+`residence_street_number` su
   `alunni` e `parents`. Insert/patch resilienti alle colonne non ancora esistenti (42703 → retry).
2. **Bug "nuovo alunno + mamma non salvata né associata" risolto.** Nuovo helper condiviso
   `src/lib/anagrafiche/parents.ts` (`linkOrCreateParent`): CF vuoto → `null` (chiude la violazione
   UNIQUE che causava il 500 silente); cittadinanza reale per i genitori, col ruolo solo per lo
   staff (preserva il workaround tab Staff). `POST /api/admin/students` accetta ora `parents[]`
   opzionale → **salvataggio atomico** alunno+genitori in un'unica richiesta (niente più genitori
   persi né alunni duplicati al retry). `FamilyRegistryManager` fa una sola fetch e mostra l'esito
   reale (niente più finto "salvato" a fallimento parziale).
3. **Anagrafica sezione — insegnanti di riferimento.** Nuova API
   `/api/admin/sections/[id]/teachers` (GET/POST/DELETE, gate Direzione, add/remove) sulla ponte
   `utenti_sezioni`; card "Insegnanti di riferimento" nel dettaglio sezione. Aggiungendo/rimuovendo
   un docente si aggiorna automaticamente la sua anagrafica ("Classi assegnate" in StaffPanel).
4. **Didattica primaria — classe nell'associazione Materie–Docenti.** Il modello DB/API era già
   class-aware (`utenti_sezioni_materie.section_id`): la classe è ora esplicita **in entrambi i modi**
   (tendina Classe nel form di `DocentiMaterieManager` + selettore in alto condiviso + classe mostrata
   in ogni riga).
5. **Mensa — Livello (tendina) + Sezioni (multi-select).** `SezioniMultiSelect` ha una prop
   `withLivelloFilter`: tendina Livello (Nido/Infanzia/Primaria) che filtra le sezioni multi-select.
   Attiva nel MenuBuilder; storage e vista genitore invariati.
6. **Armadietto — materiale assegnato alle classi con tendina.** Stessa UX del punto 5
   (`withLivelloFilter`) nel form "Nuovo Materiale"; rimosso il vincolo fisso a nido/infanzia
   (ora copre anche primaria).
7. **Modulo d'iscrizione standard — campi nuovi + editor segreteria + "Reimposta".** I 4 campi
   nuovi sono nel template (visibili+obbligatori). Il modulo standard è ora un modello `form_models`
   editabile dal builder (nuovo `src/lib/forms/enrollment-default-schema.ts` con
   `ENROLLMENT_DEFAULT_SCHEMA` + id stabile + `ensureStandardEnrollmentModel`): card in `/admin/iscrizioni`
   con **"Modifica"** (builder) e **"Reimposta"** (`POST /api/admin/form-models/reset`, solo per il
   modello standard). Il wizard `/iscrizione` è ora schema-driven (`GET /api/iscrizione/model`, fallback
   al template); **flusso invariato** (invio a `enrollment_submissions`, revisione in "Ricevute").
   ETL import e trigger `fn_form_submission_etl` estesi ai 4 nuovi campi; catalogo builder
   (`anagrafica-fields.ts`) aggiornato. **Fix builder**: il form-builder non caricava mai un modello
   esistente (`?id=` ignorato → apriva sempre "Nuovo Modello" vuoto, bug pre-esistente anche per i
   moduli personalizzati). Aggiunto `GET /api/admin/form-models/[id]` + caricamento nel builder
   (schema/titolo/pubblicazione) e salvataggio in **PATCH** quando si modifica (non duplica più).
   Ora "Modifica" sul modulo standard apre i 36 campi (2 pagine) già presenti.

---

## 🗓️ Changelog — Batch Segreteria 2026-07-05 (branch `feat/batch-segreteria`)

Batch di 9 interventi segreteria/didattica + creazione di 2 classi di prova. Gate verde:
`eslint` 0, `vitest` 765/765, `build` ok (e2e in CI su push). Branch non ancora
pushato/mergeato al momento della scrittura.

1. **Diario 0-6 — buffer visibilità 10'.** Il ramo genitore di `GET /api/diary/entries`
   nasconde le voci create da meno di `diario_config.buffer_visibilita_min` minuti
   (default 10), replicando la finestra di correzione delle valutazioni primaria. Campo
   regolabile in Impostazioni → Diario. Il ramo docente/segreteria vede tutto in tempo reale.
2. **Materie primaria — accessibilità.** Il preset `materie_preset` è già seedato (65 righe);
   la causa reale di "mancano le materie" era l'**assenza di sezioni di primaria** in prod
   (le materie sono per-sezione). Il pannello Didattica primaria mostra ora un empty-state con
   CTA "Crea una sezione primaria" invece del selettore vuoto.
3. **Anagrafiche — salvataggio unico + fix bug.** Un solo pulsante "Salva anagrafica" fuori
   dalle schede salva alunno + tutti i genitori insieme e collegati (schede genitore vuote
   saltate; se l'alunno fallisce non si crea nulla → niente genitori orfani). I form alunno/adulto
   sono `forwardRef` con `validate()/reset()/isEmpty()`, tutti montati. **Bug "campi genitore
   vuoti alla riapertura" risolto**: `parents` ha RLS ON con **zero policy**, e la route
   `GET /api/admin/parents/[id]` usava il client con RLS (`createClient`) tornando sempre vuoto;
   ora usa `createAdminClient` (service-role) come le altre route admin.
4. **Import anagrafiche — prestampato CSV.** Nuovo `src/lib/import/template.ts` (intestazioni
   italiane alunno + 2 genitori) + `POST /api/admin/import/anagrafiche` che crea alunni + genitori
   collegati con dedup sul codice fiscale. In Strumenti: "Scarica prestampato CSV" + import server.
5. **Mensa — assegnazione sezioni multi-select.** Nuovo componente riusabile `SezioniMultiSelect`
   (da `/api/admin/sections/scoped`); nel MenuBuilder, selezionando un menu, compare l'elenco
   sezioni a selezione multipla. Nuovo `PUT /api/mensa/class-assignments` (semantica set).
6. **Armadietto — materiale per classi + carico a tutta la sezione.** `POST /api/locker/materials`
   accetta `classi_sezioni[]` (crea il materiale su più sezioni); la config materiali usa sezioni
   reali (non più lista hardcoded) con `SezioniMultiSelect`; il modale di carico ha l'opzione
   "Assegna a tutta la sezione" (distribuzione a tutti gli alunni della classe).
7. **Rigenera credenziali — PDF nelle notifiche (genitori + staff).** `regenerate-credentials`,
   oltre alla mail, genera un PDF (`src/lib/pdf/credentials-pdf.ts`) salvato nel bucket privato
   `credenziali` e accoda una notifica alla segreteria con link di download
   (`GET /api/admin/credentials-pdf?key=`, staff-gated). Pulsante reale in ParentDetailPanel e StaffPanel.
8. **Messaggi alla segreteria (nuova sezione).** Voce sidebar "Messaggi" + pagina `/admin/messaggi`
   con 2 tab: "Con i genitori" (chat segreteria↔genitore; riusa `/api/chat/*` con la segreteria
   come `teacher_id`) e "Tutti i messaggi" (**supervisione sola-lettura** di tutte le chat
   genitore↔insegnante, filtrabile per insegnante/genitore/classe; `/api/admin/chat/{threads,messages,contacts}`).
9. **Iscrizioni — UI unica.** `/admin/iscrizioni` divisa in "Ricevute" (le richieste, invariate) +
   "Moduli inviabili via link" (i modelli del builder con pubblica/copia-link; il wizard `/iscrizione`
   compare come "modulo predefinito"). *Follow-up*: unificare nella lista Ricevute anche le
   submission dei moduli d'iscrizione (ETL dedicato) — non fatto per contenere il rischio.

**Classi di prova (produzione, sede Kidville Giugliano `d53b0fbc-…`).** Create 2 sezioni etichettate
TEST — **"TEST Infanzia"** (school_type infanzia) e **"TEST 1A"** (primaria) — ognuna con 10 alunni,
2 insegnanti e 10 genitori con login (password comune a tutti gli account TEST). Email:
`test.inf.docente{1,2}` / `test.inf.genitore{1..10}` / `test.pri.*` `@kidville.test`. Dati fittizi
ripulibili (etichetta TEST). In più (dal collaudo del 2026-07-13): **`test.segreteria@kidville.test`**
(ruolo `segreteria`, stessa password) per verificare i flussi di sportello (anagrafica Staff, mensa,
report cucina).

> 🔐 **La password non è più scritta qui — e non va scritta in nessun file del repo.** Fino al
> 2026-07-26 era in chiaro in questo PRD e in altri 8 file committati, con il repository
> **pubblico**: chiunque leggesse il repo entrava nel registro come genitore, come docente e —
> con `test.segreteria` — con vista sull'anagrafica dell'intera sede, comprese le famiglie
> **reali**. Il 2026-07-26 la password è stata **ruotata** su tutti i 41 account `test.*` e i
> valori sono stati tolti dai file. Ora si reperisce nel **gestore di credenziali del titolare**;
> gli script di collaudo la leggono dalla variabile d'ambiente **`KV_TEST_PASSWORD`** (vedi
> `e2e/lib/test-password.mjs`) e falliscono subito se manca. Il lock
> `__tests__/architecture/niente-password-nel-repo.test.ts` impedisce che ne rientri una.
> Resta il fatto che **la password vecchia è nella storia git**: è morta perché ruotata, non
> perché cancellata.

**Account TEST sulle altre sedi (dal 2026-07-31) — `scripts/seed-test-sedi.mjs`.** I 41 account
qui sopra vivono tutti a **Giugliano**. Con tre plessi in produzione questo rende l'isolamento fra
sedi **non collaudabile**: non esiste un «utente di Aversa» a cui chiedere se vede Cesa, ed è uno
dei motivi per cui l'audit del 2026-07-31 ha trovato 140 rilievi col gate formale verde. Lo script
`scripts/seed-test-sedi.mjs` crea — in modo **idempotente**, risolvendo le sedi **per nome** e mai
per uuid — il minimo necessario alla prova incrociata:

| Sede | Account | Ruolo |
|---|---|---|
| Kidville Aversa | `test.aversa.segreteria@kidville.test` | `segreteria` |
| Kidville Aversa | `test.aversa.docente@kidville.test` | `educator` (sezione «TEST Infanzia» di Aversa) |
| Kidville Aversa | `test.aversa.genitore@kidville.test` | `genitore` di *Alunno1 Test Aversa* |
| Kidville Cesa | `test.cesa.segreteria@kidville.test` | `segreteria` |
| Kidville Cesa | `test.cesa.docente@kidville.test` | `educator` (sezione «TEST Infanzia» di Cesa) |
| Kidville Cesa | `test.cesa.genitore@kidville.test` | `genitore` di *Alunno1 Test Cesa* |

Con gli account nasce, **in ogni sede, una sezione omonima «TEST Infanzia»** — lo stesso nome della
sezione TEST di Giugliano. È deliberato: il nome-classe scambiato per identità è la famiglia di
difetti F3 dell'audit, e senza tre classi omonime in tre plessi non si può dimostrare né che è
chiusa né che si riapre.

Due vincoli che valgono più delle righe create. **(1)** Nessuno di questi sei account viene
agganciato a una sede col ponte `utenti_scuole`: la sua sede è una sola, `utenti.scuola_id`. È
esattamente il difetto chiuso il 2026-07-31 — il provisioning di Aversa e Cesa aveva collegato lì
`admin.e2e@kidville.test`, cioè una Direzione, su due plessi veri. **(2)** La password arriva da
`KV_TEST_PASSWORD` e lo script **fallisce subito se manca**: nessun default, nessun valore in un
file. Lo script gira in **dry-run** per default (`node scripts/seed-test-sedi.mjs`) e scrive solo
con `--apply`; la sua logica è collaudata da `__tests__/lib/seed-test-sedi.test.ts` sul finto
client Supabase (fra cui «non scrive mai `utenti_scuole`» e «non tocca le righe dell'altra sede»).

**L'unica deroga, esplicita: `test.multisede.admin@kidville.test`** (`--multisede`, dal
2026-07-31). Il **selettore di sede** non era collaudabile: dei 57 utenti di produzione ne aveva più
d'una soltanto l'admin del titolare, e l'unico modo di esercitare quel ramo era usare le credenziali
di una persona vera. Questo account ha il ponte `utenti_scuole` verso le tre sedi reali, ed è tenuto
stretto: **uno solo**, nessun bambino, nessun genitore, nessun legame — **solo accesso**; la sede
finta della CI resta fuori **per costruzione** (`isSedeE2E`, lo stesso filtro che protegge
`risolviSedi`); il ruolo `admin` non è comodità ma necessità, perché `scuoleDiUtente`
(`src/lib/auth/scope.ts`) concede il ponte multi-plesso ai soli admin per decisione di prodotto del
30/07 — un `segreteria` multi-sede avrebbe le righe in `utenti_scuole` e continuerebbe a vedere una
sede sola, cioè sarebbe un oggetto inerte che sembra funzionare. I test lo inchiodano, così chi
domani allargasse il ponte se ne accorge. Si rimuove come gli altri: riga in `utenti_scuole` →
`utenti` → account in Supabase Auth.

**Come si rimuovono.** Nell'ordine, per ciascuna sede (`<slug>` = `aversa`/`cesa`), dopo aver
cancellato le eventuali righe prodotte dal collaudo (presenze, diario, pagamenti, avvisi):
`legame_genitori_alunni` → `student_parents` → `parents` (per `auth_user_id`) → `alunni` (per
`scuola_id` + cognome «Test <Sede>») → `utenti_sezioni` → `utenti` (`email LIKE 'test.<slug>.%'`) →
`sections` (`scuola_id` + `name = 'TEST Infanzia'`) → infine i sei account in **Supabase Auth**
(`auth.admin.deleteUser`, o dalla dashboard). Nessuna di queste righe è referenziata da dati reali:
sono nate isolate e restano isolate.

**Nota di regressione nota (aggiornata 2026-07-13):** in `parents` la colonna `citizenship` conserva in
realtà il *ruolo* (`mother`/`father`/`educator`…) come workaround storico; la cittadinanza reale digitata
viene sovrascritta. La tab Staff dell'anagrafica **non dipende più** da questo workaround (ora legge da
`utenti`), ma il valore viene ancora scritto da `seed-full` e letto da `tasks`. Non toccato per non rompere
`students/page.tsx`. Da bonificare separatamente con un campo ruolo dedicato.

---

# PRD - Kidville App: Modulo Anagrafica e Account Famiglia

## 1. Obiettivo del Modulo
Il modulo Anagrafica rappresenta il core relazionale del sistema Kidville. Centralizza i dati di
studenti, genitori e personale, fungendo da sorgente di verità per tutte le altre funzionalità (Mensa,
Pagamenti, Diario, Valutazioni). La struttura è progettata per supportare un modello SaaS multi-
sede, garantire l'operatività offline per i docenti e mantenere la rigorosa conformità GDPR.

## 2. Struttura Dati (Data Model)
### 2.1 Anagrafica Alunno (StudentModel)
***Dati Principali:** Nome, Cognome, Data di nascita, Luogo di nascita, Sesso, Codice Fiscale,
Indirizzo di residenza, Cittadinanza, Sede di appartenenza, Classe/Sezione.
***Stato dell'Alunno:** Iscritto, Non iscritto, Ritirato, Sospeso.
***Dati Medico/Mensa:** Allergie e Intolleranze (con blocco visivo in fase di appello/mensa).
Flag **"Usa pannolino"** (Si/No): se attivo, ogni evento "Bagno/Igiene" registrato nel Diario 0-6
scala automaticamente un pannolino dall'Armadietto del bambino (vedi Modulo Armadietto §2.2). Per i
bambini senza questo flag, gli eventi Bagno non generano alcuno scalo di materiale.
***Dati Didattici:** Profilo BES (Si/No), Storico valutazioni, Note disciplinari, Accesso allo storico
del "Diario 0-6" degli anni precedenti.
***Gestione Delegati:** Lista dinamica di persone autorizzate al ritiro. Non vi è limite numerico.
Richiede esplicito caricamento del documento di identità del delegato. Nel caso di fratelli, la
delega va replicata per singolo alunno.
***Dati Finanziari (Connessione Payments):** Importo retta, Scadenza mensile del pagamento,
Eventuali sconti applicati (es. sconto fratelli).

### 2.2 Account Genitore (ParentModel)
***Dati Principali:** Corrispondenti a quelli dell'alunno, con l'obbligo di inserimento di Numero di
cellulare e Indirizzo Email.
***Gestione Identità:** Le famiglie sono gestite creando un account univoco e separato per
ciascun genitore. Nel caso in cui un membro dello staff (es. insegnante) sia anche genitore,
l'accesso avviene tramite un unico account globale che gestisce permessi incrociati.

## 3. Gestione Ruoli e Permessi (RBAC)
| Ruolo | Permessi di Lettura | Permessi di Azione e Scrittura |
|---|---|---|
| **Direzione** (ruolo tecnico `admin`) | Accesso illimitato ai dati di **tutti i plessi associati** (ponte `utenti_scuole`; in assenza di righe, ricade sul proprio `scuola_id`). | Tutte le azioni della Segreteria, ma estese a **ogni plesso associato**. Mai cross-tenant fuori dai plessi assegnati. Chiusura/pubblicazione scrutinio (operazione di dirigenza) e sblocco voci time-lockate restano riservati alla dirigenza (`requireStaff`). |
| **Segreteria** (ruolo tecnico `segreteria`) | Accesso illimitato ai dati del **proprio plesso** (`utenti.scuola_id`), mai cross-tenant. | Creazione, modifica e importazione dati del proprio plesso. **Accesso in scrittura a TUTTE le funzioni docente** di qualunque classe del proprio plesso (registro, appello, valutazioni, note, scrutinio, fascicolo, diario 0-6, armadietto), **riusando** le schermate/endpoint del docente (nessun fork UI). Vincoli: l'**autore/valutatore ufficiale** (firma FEA — *vero valutatore*) resta **sempre il docente** (`maestra_id`/`proposto_da` invariati); ogni scrittura è tracciata in `audit_scritture_docente` (diff `valore_prima`/`valore_dopo`); le voci time-lockate/firmate richiedono lo sblocco motivato della dirigenza (`sblocchi_audit`). Gestione inviti genitori e reset password staff del proprio plesso. **Dashboard gestionale completa** (`/admin`: anagrafe/iscrizioni, pagamenti, mensa, impostazioni, modulistica) via `requireStaff` (default include `segreteria`). **Escluse** (solo dirigenza `admin`/`coordinator`): chiusura/pubblicazione scrutinio, generazione pagella ufficiale, sblocco time-lock — vincolo O.M. 3/2025 + FEA. |
| **Insegnante** (ruolo tecnico `educator`) | Visibilità completa sull'anagrafica degli alunni in carico (dati medici, didattici e deleghe), con l'**esclusione assoluta** dei recapiti di contatto dei genitori. Visibilità limitata alle **proprie sezioni** (`utenti_sezioni`) e allo storico dell'anno in corso. | Scrittura sulle funzioni didattiche **solo per le proprie sezioni/materie** (registro, appello, valutazioni, note, ...). Modalità *Sola Lettura* sui record anagrafici core: nessuna modifica autonoma dell'anagrafe. |
| **Genitore** (ruolo tecnico `genitore`) | Accesso all'anagrafica dei propri figli e al proprio profilo personale. | Può aggiornare in autonomia esclusivamente i propri recapiti di contatto e i documenti di identità in scadenza. Nessuna modifica ai dati core dell'alunno. **Escluso da tutti gli endpoint docente** (`requireDocente`). **Login reale** (Supabase Auth, identità risolta dalla sessione su `parents.auth_user_id = auth.uid()`); **nessuna auto-registrazione** né self-service reset password (DL-002/DL-005, Fase P0). |

## 4. Flussi Operativi e Funzionalità Core
### 4.1 Onboarding e Acquisizione Dati
***Form di Pre-iscrizione Esterno:** II sistema genera un link sicuro inviato ai nuovi iscritti. I
genitori compilano i moduli esternamente; la Segreteria importa i dati con un click, popolando in
automatico il database senza data-entry manuale.
***Assegnazione Massiva (Bulk):** Implementazione di una Ul tabellare nella dashboard Admin
che consente la selezione multipla degli alunni per l'assegnazione rapida a classi, sezioni o gruppi
mensa.

### 4.2 Amministrazione, Sicurezza e GDPR
***Audit Log di Sistema:** Tracciamento immutabile di tutte le modifiche anagrafiche in una
collection separata. La dashboard permette alla Segreteria di filtrare l'elenco cronologico delle
operazioni per singolo utente (Insegnante o Genitore).
**Recupero Credenziali (DL-005, Fase P0):** Un pulsante **"Rigenera credenziali"** dedicato
all'interno dell'anagrafica del genitore (e del record staff) permette alla Segreteria di
forzare il reset della password (`auth.admin.updateUserById` con password random) e di
**inviarla automaticamente via email** all'utente. **Nessun self-service "password
dimenticata"**: il recupero passa sempre dalla Segreteria.
***Gestione Diritto all'Oblio:** In base alle normative GDPR, in caso di esplicita richiesta del
genitore, è previsto un flusso di *Hard Delete* che rimuove fisicamente i dati dai server,
bypassando il normale "Soft Delete" applicato in fase di ritiro/sospensione.

## 5. Specifiche Architetturali e di Sincronizzazione
***Moduli Coinvolti:** `src/app/(dashboard)/teacher/` (Pagine docente), `src/app/(dashboard)/parent/` (Pagine genitore), `src/app/api/` (API Routes server-side), `src/lib/supabase/` (Client DB).
***Database:** PostgreSQL. In fase demo il software si collega a **Supabase** (PostgreSQL gestito con API REST e Row Level Security). In produzione si collegherà a un **PostgreSQL self-hosted** sul server dell'istituto. Il cambio avviene modificando le variabili d'ambiente `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` nel file `.env.local`.
***Flusso Dati:** Ogni operazione dell'insegnante (compilazione entrata, pranzo, nanna, bagno, attività) genera una chiamata API al server che esegue un **UPSERT** sulla tabella `eventi_diario`: se per quel bambino+tipo_evento+data esiste già un record, viene aggiornato (UPDATE); altrimenti viene creato (INSERT). La lettura degli alunni avviene tramite SELECT sulla tabella `alunni` filtrata per `classe_sezione`.
***Cloud Authentication:** Relazione rigorosa e vincolata. I genitori non dispongono di codici di auto-invito; è unicamente la Segreteria a creare il legame parent_id <-> student_id ed effettuare l'onboarding. L'autenticazione è gestita tramite **Supabase Auth** (`auth.users` + `auth.identities`) con email/password.
***Offline-First per Docenti:** Le anagrafiche degli studenti vengono salvate in un database locale IndexedDB (tramite **Dexie.js**) per permettere l'appello e il registro offline. Un **Sync Engine** personalizzato (`src/lib/offline/syncEngine.ts`) si occupa di allineare i dati locali con il database centrale PostgreSQL non appena il dispositivo torna online. Le fotografie e i media pesanti sono esclusi dal caching per minimizzare l'impatto sulla memoria del dispositivo.
***Multi-Tenant:** La proprietà `scuola_id` (Sede di appartenenza) è la chiave di tenancy e ha una **FK verso `schools(id)` su tutte le 65 tabelle** che la portano (dal 2026-07-31: prima erano 34, e sulle altre il database accettava qualunque uuid — una riga così non appartiene a nessun plesso e diventa invisibile a ogni filtro, senza errore e senza log). L'isolamento poggia su tre strati che devono dire la stessa cosa: **schema** (FK, `NOT NULL` dove il dato è di una famiglia, UNIQUE `(scuola_id, name)` su `sections`), **RLS** vincolata alla sede e non al solo ruolo, e **strato applicativo** (`resolveScuoleAttive` in lettura, `resolveScuolaScrittura` in scrittura — che risponde **400** quando l'utente ha più plessi e non ne indica nessuno: la sede si dichiara, non si indovina). Dal 2026-07-29 i plessi reali sono **tre**, più una sede finta di collaudo esclusa da elenchi pubblici, digest e contabilità.

---

# PRD - Kidville App: Modulo Segreteria/Direzione (Accesso Scrittura per Classe)

## 1. Obiettivo del Modulo
Dare ai ruoli **Segreteria** e **Direzione** accesso in **scrittura a tutte le funzioni del docente**, per qualunque classe della propria scuola/plesso, **riusando le stesse schermate/endpoint del docente** (nessuna duplicazione di UI). In questo modo la conformità **O.M. 3/2025** e la **firma FEA** restano intatte, perché si opera sugli stessi flussi certificati del docente.

- **Segreteria** (`segreteria`): vede e scrive **solo sul proprio plesso** (`utenti.scuola_id`).
- **Direzione** (`admin`): può seguire **più plessi**, tramite il ponte `utenti_scuole` (fallback al proprio `scuola_id`).
- Provisioning ruolo Segreteria: valore applicativo in `utenti.ruolo = 'segreteria'` (free-text; l'enum non viene alterato — `loadAppUser` legge `role || ruolo`).

## 2. Modello di Sicurezza (gate uniforme + scope + audit)
Ogni endpoint docente applica, nell'ordine:
1. **Gate ruolo** — `requireDocente` (allowlist `educator/admin/coordinator/segreteria`; **genitore e cuoca esclusi**). Chiude anche la falla che lasciava raggiungere gli endpoint docente al genitore.
2. **Scope per tenant/classe** — helper in `src/lib/auth/scope.ts`:
   - `scuoleDiUtente(user)` → plessi consentiti (proprio `scuola_id`; per `admin` la lista in `utenti_scuole`).
   - `assertSezioneInScope(user, sectionId)` → aree section-keyed (appello, registro, note, scrutinio, orario).
   - `assertAlunnoInScope(user, alunnoId)` → aree student-keyed (valutazioni, prospetto, fascicolo, diario, ...).
   - Regola: `educator` → solo sezioni assegnate (`utenti_sezioni`); `segreteria`/`coordinator`/`admin` → tutte le classi dei propri plessi. **Mai cross-tenant.**
3. **Audit** — `logScrittura()` (`src/lib/audit/scrittura.ts`) registra in `audit_scritture_docente`: attore (id+ruolo), plesso, classe, entità, azione e **diff `valore_prima`/`valore_dopo`**. Log immodificabile (RLS: solo INSERT/SELECT).

## 3. Vincoli di Conformità
- **Firma FEA / vero valutatore**: l'autore ufficiale resta **sempre il docente**. I campi `valutazioni.maestra_id`, `note_disciplinari.maestra_id`, `firme_docenti.maestra_id`, `scrutinio_giudizi.proposto_da` **non** assumono mai l'identità della Segreteria; l'attore Segreteria figura **solo** in `audit_scritture_docente.attore_id`. Per una **nuova** scrittura valutativa la UI Segreteria deve **selezionare il docente** titolare/contitolare (validato su `utenti_sezioni`/`utenti_sezioni_materie`); senza un docente valido → **422** (mai forgiare la firma).
- **O.M. 3/2025**: sui documenti ufficiali solo **giudizi sintetici**; la **media numerica** resta ausilio interno, mai su pagella/viste famiglie (già garantito; la Segreteria non la espone).
- **Conflitti**: last-write-wins + audit; voci in time-lock/firmate richiedono lo sblocco motivato della dirigenza (`sblocchi_audit`). *Conflitti → segnala, non forzare.*

## 4. Notifiche
Toggle `admin_settings.segreteria_config.notifica_docente` (Settings Hub): se attivo, quando Segreteria/Direzione scrive su una classe non propria, il docente titolare riceve notifica (riuso del sistema notifiche esistente).

## 5. Selettore Classe (unica UI nuova — stub)
Riuso di `RegistriClassePanel` (deep-link `/teacher/primaria/[sectionId]/[seg]?userId=`), con elenco classi filtrato per `scuoleDiUtente`. **Stub minimale, da rifinire con Claude Design.** Nessun fork delle viste docente.

## 6. Stato per area (aggiornato a ogni commit)
| Area | Gate | Scope | Audit | Stato |
|---|---|---|---|---|
| Fondamenta (ruolo, `utenti_scuole`, `audit_scritture_docente`, helper, fix grado) | — | — | — | ✅ Fatto |
| classe/[sectionId], classi | `requireDocente` | `assertSezioneInScope` / `scuoleDiUtente` | — (read) | ✅ Fatto |
| Leak in lettura (sezioni, prospetto, fascicolo-rbac, bypass pagella) | `requireDocente` dove serve | `scuoleDiUtente`/`assertAlunnoInScope` (tenant) | — (read) | ✅ Fatto |
| appello, registro, note, valutazioni, scrutinio, orario | `requireDocente` | `assertSezioneInScope`/`assertAlunnoInScope` | `logScrittura` + `notificaTitolariScrittura` | ✅ Fatto (valutatore preservato via `risolviValutatore`; nuove valutazioni/firme della segreteria richiedono `docenteId` → 422 senza UI selezione docente) |
| fascicolo | `puoAccedereFascicolo` (RBAC + tenant + segreteria) | alunno | `fascicolo_accessi_audit` + `logScrittura` (upload) | ✅ Fatto |
| diary 0-6 | `requireDocente` (rami genitore aperti) | `assertAlunnoInScope` / nome→plesso | `logScrittura` | ✅ Fatto (UI cablata a `getCurrentTeacherId`; verifica runtime lato utente — vedi nota) |
| armadietto | `requireDocente` (carico/ack genitore aperti) | `assertAlunnoInScope` / `assertClasseNomeInScope` | `logScrittura` | ✅ Fatto (consumo/materiali/catalogo gatati; carico + "preso in carico" + reads alunno genitore aperti; verifica runtime lato utente) |
| tasks | `requireDocente` (intero modulo) | `task_interni.scuola_id` (migrazione 20260719) | `logScrittura` | ✅ Fatto (proxy author → backfill via real_author_id; UI cablata; verifica runtime lato utente dopo migrazione) |
| avvisi | `requireDocente` (staff; genitore lettura/risposte aperte) | `avvisi.scuola_id` (migrazione 20260719) | `logScrittura` | ✅ Fatto (GET ramo genitore + POST risposte aperti; create/edit/delete/risposte-GET/upload gatati; UI cablata) |
| Selettore classe Segreteria (stub) + toggle notifica | `requireDocente` (via /classi) | `scuoleDiUtente` | — | ✅ Fatto (stub, Claude Design) |
| **FEA — Servizio firma in-house (P1)** | firmatario = sessione | per-firmatario (`fea_signatures`, policy `any-one`/`all-required`) | `fea_audit_log` (immutabile) | ✅ Fatto (DL-001/006/007/009/010): `src/lib/fea/`, ricevuta PDF `GET /api/fea/receipt`, 3 consumatori ricablati; migrazioni `20260730/31/32` |
| **Push — Servizio notifiche bufferizzate (P1)** | `x-cron-secret` su dispatch | per-utente | — | ✅ Fatto: `enqueueNotifiche` generico + cron dispatch generico (`notifiche_dispatch_tick`, ogni 5′) → il buffer 10′ ora parte (prima solo pagamenti). Migrazioni `20260733/733b` |
| **Accessibilità — Baseline (P1, DL-008)** | — | — | — | 🔶 Baseline: provider HC globale (cookie SSR, no-FOUC), token HC + focus-ring + reduced-motion, Modal accessibile, landmark/skip-link/aria-current, smoke `jest-axe`. WCAG-AA = DoD; audit AA per-pagina incrementale |
| **P2 — Valutazione ↔ obiettivo (DL-015)** | `requireDocente` | `assertSezioneInScope` | `logScrittura` | ✅ Fatto: enforcement condizionale ≥1 obiettivo (`obiettiviDisponibili`), righe `valutazione_obiettivi`, UI checkbox docente |
| **P2 — Presa visione note FEA (DL-014)** | OTP/FES (sessione) | per-firmatario (`fea_signatures` `nota`) | `fea_audit_log` | ✅ Fatto: `nota_ricezioni` (migr. `20260740`), `POST /api/parent/primaria/note/firma` (+otp); vecchio POST → 410 |
| **P2 — Orario visibile alle famiglie** | `getRequestUserId` | sezione del figlio | — (read) | ✅ Fatto: `GET /api/parent/primaria/orario` + pagina genitore |
| **P2 — Finalità accesso Fascicolo (DL-011)** | `puoAccedereFascicolo` | alunno | `fascicolo_accessi_audit.finalita` | ✅ Fatto: `finalita` cablata in list/download/upload + campo UI |
| **P2 — Panic Alert push (DL-016)** | sessione | plesso alunno | — | ✅ Fatto: notifica simultanea Segreteria/Direzione + genitori (push P1, best-effort). Blocco-uscita UI/banner/clear = sequenziati |
| **P2 — AES Fascicolo (DL-011) / Export MIUR (DL-012) / Account sospeso (DL-013)** | — | — | — | 🔶 Decisi: AES = at-rest gestita (no app-crypto); Export = XLSX+PDF (impl. sequenziata); sospensione rinviata a P3 |
| **P3 — Fatturazione Elettronica Aruba/SDI (DL-017..020)** | `requireStaff` (emissione) / `x-cron-secret` (sync) | pagamento → scuola; genitore via `legame_genitori_alunni` (download PDF) | `fatture_emesse` (XML + stato SDI + numerazione) | ✅ Fatto (P3.1): client REST reale, XML FatturaPA (B2C/N4/no-bollo), numerazione interna, scarti polling + notifica Segreteria + copia cortesia PDF. Migrazione `20260741`. **Verifica live SDI gated su credenziali Aruba del committente** |
| **P3 — Pagamenti residui: sospensione moroso + vista categorie + ricevuta (DL-021..023)** | `requireStaff(['admin','coordinator'])` (sospensione) / guard `assertGenitoreNonSospeso` (azioni) | `assertAlunnoInScope`; genitore via `legame_genitori_alunni` | `logScrittura` (sospensione) | ✅ Fatto (P3.2): flag soft per-alunno (`alunni.sospeso`, migr. `20260742`) + banner/badge + enforcement su firme moduli; vista genitore a categorie; ricevuta PDF non fiscale. Login/letture preservati |
| **P3 — Logica condizionale form (DL-024)** | — (motore puro) | — | — | ✅ Fatto (P3.3a): `src/lib/forms/conditional.ts` (eq/neq/contains/gt/lt); wizard mostra/nasconde + valida solo visibili + strip valori nascosti; editor condizione nel builder. Singola condizione per campo, nessuna migrazione |
| **P3 — Delibera ammissioni + scoring (DL-025)** | `requireStaff` (delibera/override) | per `model_id` | `esito_da`/`esito_il` su `form_submissions` | ✅ Fatto (P3.3b): scoring applicato in live (migr. `20260743`), `calcolaDelibera` (soglia+posti), esito ammesso/lista/non + override, export PDF delibera, UI RankingTable |
| **P3 — ETL form→anagrafiche (DL-026)** | trigger `SECURITY DEFINER` | scuola default / match anagrafico | `RAISE NOTICE` best-effort | ✅ Fatto (P3.3c): `fn_form_submission_etl` riscritto su `parents`/`alunni`/`student_parents` (migr. `20260744`); traduzioni `db_mapping`, upsert su `fiscal_code`/`codice_fiscale`, link. Verificato con dry-run live. Completa il deferral DL-025 |
| **P3 — Certificato medico self-service (DL-027)** | `requireUser` (upload) / `requireStaff` (validazione) | scope `legame_genitori_alunni` | `logScrittura` (validazione) | ✅ Fatto (P3.3d): tabella corretta (migr. `20260745`, era drift), periodo dal/al + stato, bucket privato; upload genitore → validazione Segreteria (Valida/Rifiuta + nota) + download scoped. Nessun sollecito automatico |
| **P3 — Staff RBAC (DL-028)** | `requireStaff(['admin','coordinator'])` (Direzione) | scuola/classi (`utenti_sezioni`) | `logScrittura` (`staff_rbac`) | ✅ Fatto (P3.4a): `GET/PATCH /api/admin/staff` + pannello `/admin/staff` (ruolo/sede/classi); self-lockout guard; ruoli assegnabili no-genitore. Nessuna migrazione |
| **P3 — Blocchi Consensi & Allegati + upload (DL-029)** | `requireStaff` (builder) / `requireUser` (upload) | per `model_id` / service-role | `consents_log` snapshot GDPR | ✅ Fatto (P3.3e): tipo campo `consent` (testo+link+checkbox) reso e configurabile nel builder, snapshot legale `consents_log` (migr. `20260746`); endpoint upload generico `/api/forms/upload` (ripara wizard autenticato) + `/api/forms/submit` (insert server-role); gate `requireStaff` su `/api/admin/form-models` (era ungated). Allegati: service-role + scoping app |
| **P3 — Pubblica modello + link pubblico (DL-030)** | `requireStaff` (publish) / token pubblico (compilazione) | `public_token` + `access_mode` | submission anonima `consents_log` | ✅ Fatto (P3.3f): `published_at`/`public_token`/`access_mode` (migr. `20260747`); `POST /api/admin/form-models/publish` (publica/ritira, link `/m/{token}`); pagina pubblica `/m/[token]` (WizardContainer anonimo); `POST /api/public/forms/[token]/submit|upload` token-scoped (consensi applicati); config accessi pubblico/registrati; builder con pannello Pubblica/Copia link |
| **P3 — Firma congiunta + reinvio OTP (DL-031)** | OTP email (FEA) | slot `fea_signatures` per submission | `signature_log` per-slot + `logFeaEvent` | ✅ Fatto (P3.3g): `signature_mode` single/joint su form_models (migr. `20260748`); send-otp slot-aware (completa per policy `all-required`); 2° firmatario email-only + reinvio OTP; UI `OtpSignatureModal` (reinvia + step 2° genitore) + toggle nel builder. Riusa slot FEA P1 (DL-007) |
| **P3 — Proxy upload cartaceo (DL-032)** | `requireDocente` | `legame_genitori_alunni` (parent) | `logScrittura` (`modulistica_cartaceo`) | ✅ Fatto (P3.3h): `POST /api/teacher/modulistica` riscritto (era stub ungated con path finto) → upload **reale** della scansione su `form_attachments/cartaceo/`, gate docente, `origine='cartaceo'` (migr. `20260749`), evidenza strutturata + audit. UI teacher con File reale (multipart); merge PDF classe marca "(CARTACEO)" |
| **P3 — Multi-Sede CRUD (DL-033)** | `requireStaff(['admin','coordinator'])` (Direzione) | tabella `scuole` (registry) | `logScrittura` (`multi_sede`) | ✅ Fatto (P3.4b): tabella `scuole` (migr. `20260750`, era `scuola_id` hardcoded; seed sede esistente); `GET/POST/PATCH /api/admin/schools` aggiungi/rinomina/disattiva (soft) + `config` jsonb isolata; UI `/admin/schools` (`SchoolsPanel`). No FK su scuola_id (soft-reference); hard-delete fuori scope |
| **P3 — GDPR diritto all'oblio (DL-034)** | `requireStaff(['admin','coordinator'])` (Direzione) | `alunni`/`parents` + `student_parents` | `logScrittura` (`gdpr_oblio`) | ✅ Fatto (P3.4c): lista non-iscritti (`/api/admin/gdpr/candidates`) → `POST /api/admin/gdpr/erase` **solo anonimizzazione** (placeholder `CANCELLATO-{hash}`, no DELETE), genitore anonimizzato solo se orfano, file PII rimossi (escluso `fatture`); preserva audit+fisco; **dry-run + doppia conferma**; `anonimizzato_il` (migr. `20260751`); UI `/admin/gdpr` (`OblioPanel`) |
| **P0 — Letture parent-facing via route server (DL-035)** | `requireStaff`/`requireUser` | service-role + scoping app | — (read) | ✅ Fatto: 6 siti anon migrati; nuove route `/api/me`, `/api/admin/forms/{models,rankings,submissions[+id]}`; riuso `/api/parent/students`, `/api/forms/upload`. `grep getSupabase` → solo auth+realtime |
| **P0 — Gate + audit mutazioni anagrafiche (DL-036/037)** | `requireStaff(['admin','coordinator','segreteria'])` | service-role | `logScrittura` (`alunni`/`genitori`/`legame`/`sezioni`/`iscrizione`) | ✅ Fatto: `/api/admin/{students,parents,sections,iscrizioni}` ora gatati + auditati (erano ungated/unaudited). Bulk iscrizioni: una riga audit per entità creata |
| **P0 — RLS lockdown S9a+S9b (DL-038/039/040/041/044/046)** | — | RLS prod (default-deny anon; service-role passa) | — | ✅ **LOCKDOWN COMPLETO**: droppate **TUTTE** le policy permissive (migr. `20260752`→`20260759`); `pg_policies qual='true'` su anon/public = **0**. Chat realtime con policy `authenticated` partecipante. `get_advisors` **0 ERROR**. 🔶 **S13** (`ALLOW_HEADER_IDENTITY='false'`) = solo flip env operativo dopo onboarding di massa |
| **P4 — Diario 0-6 · D1 (DL-040)** | `requireDocente` (cattura); ramo genitore service-role (gate proprietà → S13) | `assertAlunnoInScope` | `logScrittura` (`diario`) | ✅ Push genitore 1×/figlio (buffer 10' + debounce, `enqueueDiarioGenitori`); "Entrata" read-only da Presenze (`/api/diary/checkin`); filtro solo-presenti + toggle; bulk "Nanna per tutti"; input nota libera docente. **S9b Diario:** `/api/diary/entries` → service-role + DROP `eventi_diario_*_anon` (migr. `20260753`), advisors 0 ERROR. 🔶 D2: traduzione/dashboard Segreteria/riconciliazione `daily_routines` |
| **P4 — Galleria · G1 (DL-041)** | `requireDocente` (POST); ruolo per delete/patch | service-role (visibilità tagged/broadcast in API) | — | ✅ **Privacy Lock server-side**: tag di alunni senza `consenso_privacy` → **422 con nomi** (POST+PATCH, bypass broadcast); helper `src/lib/gallery/privacy.ts`. **S9b Galleria:** DROP `galleria_media_v2` permissive (migr. `20260754`, tutti gli accessi già service-role), advisors 0 ERROR. *(broadcast, delete admin, interconnessione Diario già presenti.)* 🔄 **2026-07-13 (DL-051/052):** 422 **solo per foto di gruppo** (>1 taggato senza liberatoria); **singolo taggato = foto privata** ai soli genitori; **GET gated** (genitore→`requireParentOfStudent`, staff→`requireDocente`); **broadcast solo Direzione**; **liberatoria ora scrivibile** dall'anagrafica (`consenso_privacy` in `PATCH /api/admin/students`). 🔶 Follow-up: bucket pubblico→signed URL, DELETE su identità legacy |
| **P4 — Comunicazione · C1 (DL-042)** | `requireUser` + rate-limit (`/api/chat/translate`) | service-role | — | ✅ **Traduzione automatica chat** via Claude `claude-haiku-4-5`, **gated su `ANTHROPIC_API_KEY`** (503 + UI nasconde se assente): servizio `src/lib/translate/claude.ts`, endpoint `/api/chat/translate`, pulsante "Traduci" sui messaggi in arrivo (target = lingua dispositivo). 🔶 S9b chat realtime (`chat_messages`/`chat_threads`) = gated onboarding; note vocali/file/super-admin lettura = slice successive |
| **P4 — Mensa · M1 (DL-043)** | `requireUser` (`/api/parent/mensa/allergie`) | service-role; alunno per id | — | ✅ **Icona pericolo allergeni genitore**: cross menù-del-giorno↔allergeni figlio (riuso helper puri 14 UE), banner rosso nella pagina mensa genitore. *(Infra allergeni cuoca/segreteria + cron già presenti.)* 🔶 Resta: isolamento UI Cuoca, dashboard real-time tipologia, semaforo scorte, esclusioni classe |
| **P4 — Armadietto · S9b (DL-044)** | `requireDocente` + scope (`/api/locker/materials`) | service-role | `logScrittura` (`armadietto_config`) | ✅ Migrata a service-role + **DROP** `locker_config` permissive (migr. `20260755`), advisors 0 ERROR. *(Flusso richiesta→chiusura ciclo già presente in `locker/requests`.)* 🔶 Resta: carico merci, lista spesa genitore, dashboard inadempienze, reminder 07:00 |
| **P4 — Anagrafica · onboarding (DL-045)** | `requireUser` (`/api/parent/onboarding`) | service-role; genitore self | — | ✅ **Onboarding genitore** `/parent/onboarding`: consensi GDPR obbligatori (422 se mancanti) + set password Supabase Auth (se bindato) + `parents.onboarded_at`/`consensi_gdpr` (migr. `20260756`). **Prerequisito S13** (sessione reale). 🔶 Resta: PIN dispositivo, stato Non-iscritto, trasferimento sedi, dati finanziari; **flip S13 = operativo** (onboarding di massa) |
| **P5 — Certificato Competenze (DL-047)** | `requireStaff` (read/seed) / `['admin','coordinator']` (genera+firma) | alunno; genitore via `student_parents`/`legame` | slot FEA `certificato_competenze` + `fea_audit_log` (`logFeaEvent`) | ✅ Fatto: tabelle `certificati_competenze`+`_livelli` (migr. `20260760`, RLS default-deny), modello D.M.14/2024 (8 competenze × 4 livelli A/B/C/D), PDF (riuso pagella) + firma applicativa dirigente, seed da scrutinio finale classe-quinta (guard 422/409), download admin+genitore. UI `/admin/competenze` + card pagelle genitore |
| **P5 — Numero domanda + Import ZIP SIDI (DL-048)** | `requireStaff` (upload/preview) / `['admin','coordinator']` (apply) | service-role | `logScrittura` (`alunni`/`genitori`/`legame`) | ✅ Fatto: `alunni.numero_domanda_sidi` + staging `sidi_import_batches` (migr. `20260762`); parser **jszip pluggable** (`normalizeSidiRow` sostituibile), matching numero domanda→CF-fallback→crea, genitori dedup CF, **idempotente**. Route `/api/admin/sidi/import`. UI in `SidiPanel` |
| **P5 — Client SIDI + flussi + sync (DL-049)** | `['admin','coordinator']` (trasmissioni) / `requireStaff` (legami/sync-state) | service-role; legami validati Segreteria | `logScrittura` (`legame_sidi`) | ✅ Fatto (**egress gated**): `src/lib/sidi/client.ts` (503 `non_configurato`/`non_accreditato`), builder neutri + serializer sostituibili, guardie sequenza (Fase A→freq→PU, 409), `sidi_config` + `sidi_sync_state` + `student_parents.validato_*` (migr. `20260763`). Route `/api/admin/sidi/{fase-a,frequentanti,piattaforma-unica,legami,sync-state}` + `settings/sidi` (password mascherata). UI `/admin/sidi` indicatore a cascata. **Invio reale subordinato all'accreditamento ministeriale** |
| **P5 — Bulk gruppi mensa (DL-050)** | `requireStaff` | service-role | `logScrittura` (`alunni`/`gruppo_mensa`) | ✅ Fatto: `gruppi_mensa` + `alunni.gruppo_mensa_id` (migr. `20260761`), `PATCH /api/admin/students` ramo `gruppo_mensa_id` + CRUD `/api/admin/gruppi-mensa`, `BulkAssignBar` esteso |

### 6.1 Nota — moduli 0-6 / tasks / avvisi: cablaggio auth COMPLETATO
Prerequisito **risolto**: le UI docente di diary, armadietto, tasks e avvisi sono state
cablate al modello auth (`getCurrentTeacherId` → `userId` su TUTTE le chiamate, incl.
`meta`/`upload`/by-id; `syncEngine` incluso) e i relativi endpoint ora applicano
gate `requireDocente` + scope per tenant + `logScrittura`, **distinguendo i flussi
GENITORE che restano aperti** (carico armadietto, "preso in carico" richieste, timeline
diario, lettura/risposte avvisi). Aggiunta la migrazione `20260719` con `scuola_id` su
`armadietto`/`task_interni`/`avvisi` (backfill via join canonici: alunno→scuola,
autore→scuola; per `task_interni` via `real_author_id` JSON, non il proxy `author_id`).

**Da fare lato utente (ambiente agent offline verso Supabase):** applicare la migrazione
`20260719` e verificare a runtime (genitore 200 sulle sue azioni / 403 sulle azioni staff;
pagine esistenti senza 401; cross-tenant 403). NB: la lista `tasks` è vuota finché la
migrazione non è applicata (filtra per `scuola_id`). La primaria — cuore conforme
O.M. 3/2025 + FEA — resta pienamente coperta.

---

# PRD - Kidville App: Modulo Diario 0-6 anni (Nido e Infanzia)

## 1. Obiettivo del Modulo
Il modulo Diario 0-6 anni ha lo scopo di documentare la routine quotidiana dei bambini del Nido e
dell'Infanzia. È progettato per essere uno strumento di data-entry ultra-rapido per l'insegnante e
un feed di aggiornamento costante per il genitore, garantendo che ogni evento rilevante (pasti,
nanna, igiene) sia comunicato istantaneamente.

## 2. Logica degli Eventi e Routine
### 2.1 Categorie di Routine
Il sistema gestisce i seguenti eventi, ciascuno con campi specifici:
• Entrata: Registrazione dell'orario di arrivo.
• Attività: Tipo di attività, flag di partecipazione e modalità di coinvolgimento (descrizione testuale libera).
• Merenda Mattutina: Tipologia e quantità.
• Pranzo (Multi-Pasto): Diviso per portate (Primo, Secondo, Contorno, Frutta).
• Compilazione automatica: Se il menu del giorno è inserito nel modulo Mensa, i campi "portata" vengono popolati automaticamente.
• Livelli di consumo: Niente, Poco, Metà, Quasi tutto, Tutto, Bis.
• Nanna: Registrazione obbligatoria dell'orario di Inizio e Fine.
• Bagno / Igiene: Monitoraggio specifico di: Pipì, Cacca, Uso del Vasino (per potty training).

## 3. Esperienza Utente: Insegnante (Data-Entry)
### 3.1 Operatività e Velocità — Flusso Event-First + Bottom Sheet
Il data-entry segue un flusso sequenziale in **due step** per ridurre gli errori cognitivi:
- **Step 1 — Selezione Tipo di Evento:** La schermata principale mostra esclusivamente una griglia di pulsanti grandi e touch-friendly, uno per ciascun tipo di routine (Entrata, Attività, Merenda, Pranzo, Nanna, Sveglia, Bagno). La lista degli alunni non è visibile in questa fase.
- **Step 2 — Bottom Sheet con Controlli Inline:** Dopo aver toccato un evento, un pannello scorre dal basso (bottom sheet) mostrando la lista completa dei bambini presenti. I controlli specifici per l'evento appaiono **inline, accanto ad ogni bambino** — senza navigare su nuove pagine o aprire modali aggiuntivi. Il pulsante "Salva per tutti" chiude il pannello e sincronizza i dati.
- **Filtro Presenze:** Le sezioni di inserimento mostrano esclusivamente i bambini segnati come "Presenti" nel modulo Presenze. Gli assenti vengono rimossi automaticamente dalla lista per evitare errori di input.
- **Note Libere:** Ogni evento può essere integrato con note scritte a mano per una personalizzazione totale della comunicazione.

### 3.1.1 Campi Specifici per Tipo di Evento
- **Entrata:** Campo orario d'ingresso (pre-compilato con l'ora corrente, modificabile manualmente) per ogni bambino.
- **Attività:** Quattro pulsanti di partecipazione per ogni bambino: "Non fatta", "Con difficoltà", "Con aiuto", "In autonomia". Codice colore: rosso, arancio, giallo, verde.
- **Pranzo (Multi-Portata):** Per ogni bambino, una riga di pulsanti quantità (✗ Niente / ¼ Poco / ½ Metà / ¾ Quasi tutto / ★ Tutto) per **ciascuna portata del giorno** (Primo, Secondo, Contorno, Frutta). Se il menu del giorno prevede N portate, compaiono N righe per bambino. I bambini con allergie appaiono evidenziati in rosso.
- **Merenda:** Come il Pranzo, ma con una sola portata generica.
- **Nanna (Inizio):** evento con **pulsante dedicato e distinto**; campo orario d'inizio del riposo pomeridiano per ogni bambino. *(Decisione definitiva — incongruenza #6: Nanna e Sveglia restano DUE pulsanti separati, non un pulsante unico.)*
- **Sveglia (Fine Nanna):** evento con **pulsante dedicato e distinto** dalla Nanna; campo orario di fine riposo per ogni bambino. La coppia Nanna→Sveglia documenta il riposo nella forma "dalle … alle …".
- **Bagno/Igiene:** Tre contatori cumulativi per bambino — **Pipì** (💧), **Cacca** (💩) e **Vasino** (🚽, potty training) — con pulsanti + e − per incrementare/decrementare il conteggio. Il valore viene salvato come numero intero (es. "Pipì: 2, Cacca: 1, Vasino: 1"). *(Decisione definitiva — incongruenza #7: il Vasino è un controllo previsto e implementato.)* Ogni evento Bagno scala 1 pannolino dall'Armadietto solo per i bambini con flag "Usa pannolino" (vedi Anagrafica §2.1 e Armadietto §2.2; incongruenza #9).


### 3.2 Sicurezza e Validazione
• Dashboard Allergie: Fin dal mattino, la dashboard dell'insegnante evidenzia le allergie/intolleranze del giorno.
• Allerta Mensa: Nella sezione pasto, i bambini con allergie o intolleranze compaiono con il nome in rosso per richiamare l'attenzione immediata dell'operatore.
• Buffer di Modifica (10 Minuti): Per prevenire l'invio di notifiche errate, il sistema prevede una finestra di 10 minuti dal salvataggio durante la quale l'insegnante può modificare o annullare l'evento prima che la notifica push venga inoltrata al genitore.

## 4. Esperienza Utente: Genitore (Timeline)
### 4.1 Visualizzazione e Feedback
• Timeline Unificata: II genitore visualizza un flusso cronologico unico e verticale di tutti gli eventi della giornata (Timeline Feed).
• Notifiche Push: Il sistema invia una notifica push per ogni singolo evento registrato (dopo il buffer di 10 min), garantendo una trasparenza totale in tempo reale.
• Modalità Sola Lettura: La timeline è puramente informativa; non è prevista interazione (like o commenti) da parte del genitore.
• Multilingua Dinamico: Tutte le voci standard delle routine (es. "Ha dormito", "Pasto completo") vengono tradotte automaticamente nella lingua impostata sul dispositivo del genitore.

### 4.2 Privacy e Media
• Privacy Tagging: Le foto caricate nel diario possono taggare più bambini. La foto sarà visibile esclusivamente nella timeline dei genitori dei bambini taggati.

## 5. Amministrazione e Monitoraggio (Segreteria)
### 5.1 Configurazione e Controllo
• Customizzazione per Classe: La Segreteria può abilitare o disabilitare specifiche categorie di routine in base alla classe (es. disabilitare "Bagno/Cambio" per le classi dell'Infanzia che non ne necessitano).
• Dashboard di Monitoraggio: Uno strumento dedicato permette alla Segreteria di vedere in tempo reale quali classi stanno compilando il diario e quali sono inattive, facilitando il coordinamento didattico.
• Archiviazione e Storico:
  • I dati del diario oltre i 14 giorni non sono più consultabili dal genitore per ottimizzare le performance, ma rimangono accessibili alla Segreteria per controlli o audit.
  • Al passaggio del bambino alla Scuola Primaria, la sezione "Diario 0-6" scompare automaticamente dalla Ul del genitore, rimanendo visibile solo lato insegnante come archivio storico.

## 6. Specifiche Tecniche di Sincronizzazione
• Timestamp Offline: In caso di assenza di rete, il sistema registra l'orario effettivo in cui l'evento è accaduto (timestamp manuale o di inserimento locale) e lo sincronizza appena la connessione viene ripristinata.
• Disaccoppiamento Mensa: L'inserimento del consumo del pasto nel diario è logicamente separato dallo scalo del ticket mensa nel modulo pagamenti.

> [!NOTE]
> ### Stato Implementazione Diario 0-6
> **Implementato e operativo:**
> - ✅ Flusso Event-First con Bottom Sheet (Step 1 → Step 2)
> - ✅ Entrata: campo orario pre-compilato, inline per bambino
> - ✅ Attività: 4 livelli partecipazione (Non fatta / Con difficoltà / Con aiuto / In autonomia) con codice colore
> - ✅ Pranzo Multi-Portata: accordion per portata, pulsanti quantità (✗/¼/½/¾/★) per bambino
> - ✅ Merenda: come pranzo ma con portata singola
> - ✅ Nanna: orario inizio + orario fine unificati in una riga
> - ✅ Bagno: contatori +/- per Pipì (💧) e Cacca (💩)
> - ✅ Alert allergie visivo (nome in rosso, banner con elenco allergie)
> - ✅ Persistenza dati su Supabase (`eventi_diario`) con logica UPSERT
> - ✅ Ripristino stato da database al cambio sezione
> - ✅ Badge ✅ per alunni salvati, toast di conferma
> - ✅ Alunni caricati da database (`alunni` filtrati per `classe_sezione`)
>
> **Differenze rispetto al PRD — decisioni definitive e correzioni pianificate (Blocco 3):**
> - 🔧 **Nanna/Sveglia (incongruenza #6 — RISOLTA):** oggi unificati in un unico pulsante "Nanna" con due input orario. Decisione: DUE pulsanti distinti "Nanna (Inizio)" e "Sveglia (Fine Nanna)" che registrano "dalle … alle …". *Da correggere nel codice.*
> - 🔧 **Filtro presenze (incongruenza #8 — RISOLTA):** oggi vengono mostrati tutti gli alunni della sezione. Decisione: requisito **ATTIVO** — mostrare solo i bambini "Presenti" nel modulo Presenze. *Da implementare.*
> - ✅ **Bagno/Igiene — Vasino (incongruenza #7 — RISOLTA):** contatori Pipì 💧, Cacca 💩 e **Vasino 🚽** (potty training) sono controlli previsti e implementati.
> - 🔧 **Armadietto/pannolino (incongruenza #9 — RISOLTA):** decisione — ogni evento Bagno scala 1 pannolino dall'Armadietto solo per i bambini con flag "Usa pannolino" in Anagrafica. *Da implementare.*
> - ⚠️ I nomi delle portate pranzo sono ancora mock (`MOCK_MEAL_COURSES`) — in futuro saranno caricati dal modulo Mensa via Supabase
> - ⚠️ Il buffer di modifica 10 minuti (§3.2) non è ancora implementato
> - ⚠️ Le note libere per evento non sono ancora esposte nell'interfaccia (il campo `nota_libera` esiste nel DB)
> - ⚠️ La timeline genitore (§4) non è ancora implementata

---

# PRD - Kidville App: Modulo Armadietto (Gestione Materiale Scolastico)

## 1. Obiettivo del Modulo
Il modulo Armadietto digitalizza la gestione dei materiali personali dei bambini (Nido e Infanzia),
sostituendo i biglietti cartacei e le comunicazioni verbali alla porta. Il sistema si basa su un
approccio ibrido: un inventario automatizzato a scalare per i beni di consumo continuo (es.
pannolini) e un sistema di alert "a semaforo" per le richieste puntuali, garantendo sempre la
massima chiarezza per i genitori e un basso carico cognitivo per lo staff.

## 2. Gestione Inventario e Tipologie di Materiale
### 2.1 Catalogo Materiali Multi-Tenant
• Materiali di Default: Il sistema prevede categorie base quali Pannolini, Asciugamani, Creme e Cambi completi.
• Personalizzazione Sede: Ogni scuola (tenant) ha la facoltà di configurare, aggiungere o rimuovere voci dalla propria lista predefinita tramite il pannello di Amministrazione.
• Richieste Custom: Oltre ai materiali in lista, l'insegnante dispone di un campo a testo libero per richiedere oggetti fuori standard.

### 2.2 Sistema a Scalare e Logica del Semaforo
La gestione delle scorte si basa su un algoritmo quantitativo:
• Carico Merci: Quando il genitore consegna il materiale, l'insegnante registra fisicamente l'ingresso nell'app, specificando i dettagli (es. marca, taglia e quantità totale di pannolini).
• Consumo Automatico: Ad **ogni evento "Bagno/Igiene"** registrato nel modulo Diario 0-6 il sistema scala automaticamente **un'unità di pannolino** dal totale disponibile nell'armadietto, **esclusivamente per i bambini con il flag "Usa pannolino" attivo in Anagrafica** (vedi §2.1 Anagrafica Alunno). I bambini senza tale flag non subiscono alcuno scalo, anche se per loro viene registrato un evento Bagno (es. solo uso del vasino). Lo scalo riguarda il solo materiale "pannolino"; gli altri materiali si scalano unicamente con consumo manuale registrato dall'insegnante.
• Alert Visivi (Semaforo): Il livello delle scorte viene comunicato cromaticamente:
  • Verde: Scorte sufficienti.
  • Giallo: Allerta di esaurimento (giacenza inferiore a 5 unità).
  • Rosso: Emergenza/Esaurito (giacenza inferiore a 2 unità).

## 3. Esperienza Utente: Insegnante (Data-Entry e Controllo)
• Indipendenza dalle Presenze: A differenza del Diario, le richieste di materiale non sono inibite se l'alunno è assente. L'insegnante può inoltrare l'avviso in modo che il genitore prepari il materiale per il rientro.
• Selezione Massiva (Bulk): Per ottimizzare i tempi, l'insegnante può selezionare più bambini contemporaneamente e inviare una richiesta collettiva per lo stesso materiale.
• Chiusura del Ciclo: Il ciclo di richiesta viene considerato "Chiuso" e risolto esclusivamente dall'insegnante nel momento in cui verifica la ricezione fisica del materiale in classe.
• Supporto Offline: Tutte le operazioni di richiesta o aggiornamento scorte sono garantite anche in assenza di connettività, salvate in cache locale e sincronizzate automaticamente alla ripresa del segnale di rete.

## 4. Esperienza Utente: Genitore (Notifiche e Interfaccia)
• UI "Lista della Spesa": All'interno dell'app del genitore, la sezione Armadietto mostra in modo chiaro le quantità residue dei materiali a scuola e funge da lista visiva per gli elementi mancanti richiesti dall'insegnante.
• Isolamento Profili: In caso di account multi-figlio, le notifiche e gli alert sono rigidamente associati al profilo (avatar) del singolo bambino.
• Notifiche e Reminder:
  • La richiesta genera un avviso immediato al momento dell'invio da parte dell'insegnante.
  • Il sistema prevede un Reminder Automatico schedulato per le ore 07:00 del mattino seguente, per massimizzare la probabilità che il genitore non dimentichi il materiale.
• Feedback di Rassicurazione: Alla ricezione della notifica, il genitore può cliccare un pulsante di acknowledgment (es. "Preso in carico" / "Lo porto domani"), che aggiorna in tempo reale lo stato lato insegnante.
• Accesso allo Storico: L'interfaccia genitore non prevede l'accesso a uno storico delle richieste pregresse per mantenere l'Ul pulita ed essenziale.

## 5. Amministrazione e Monitoraggio (Segreteria)
• Abilitazione per Grado Scolastico: La Segreteria può disattivare integralmente il widget Armadietto per specifiche classi o gradi d'istruzione (es. Scuola Primaria, dove la gestione cambia radicalmente rispetto a Nido/Infanzia).
• Dashboard delle Inadempienze: La Direzione ha a disposizione un pannello di controllo per monitorare le richieste inevase. Il sistema evidenzia i genitori che non hanno fornito il materiale dopo un periodo critico, permettendo solleciti mirati.
• Log degli Ingressi: Per ragioni di trasparenza, il sistema archivia e storicizza esclusivamente gli eventi di "Carico Materiale" (cosa è stato portato e quando). Le mere richieste transitorie non vengono storicizzate, mantenendo il database leggero e ottimizzato.

---

# PRD - Kidville App: Modulo Diario Scuola Primaria (Registro Elettronico)

## 1. Obiettivo del Modulo
Il modulo "Diario Scuola Primaria" funge da vero e proprio Registro Elettronico ufficiale. A
differenza del Nido/Infanzia, questo strumento gestisce logiche didattiche e ministeriali (valutazioni
conformi alla normativa, note, argomenti delle lezioni, presenze orarie). È progettato per garantire
l'isolamento delle discipline tra i docenti, fornire una reportistica chiara ai genitori e supportare la
direzione scolastica nella valutazione periodica e negli adempimenti di scrutinio.

## 2. Appello, Orario e Registro di Classe
### 2.1 Gestione Presenze
• Stati di Presenza: L'insegnante può registrare quattro stati: Presente, Assente, Ritardo e Uscita Anticipata.
• Firma del Docente: La validazione della presenza del docente (firma del registro) avviene tramite un semplice "tap" sull'ora di lezione di riferimento.
• Compresenza: Il sistema supporta l'assegnazione di più docenti alla stessa classe nella stessa ora. Ogni insegnante firma il registro in modo indipendente e personale per la propria quota oraria.

### 2.2 Orario delle Lezioni
• Configurazione Centralizzata: L'orario settimanale e l'assegnazione delle materie sono preimpostati e gestiti esclusivamente dalla Segreteria tramite il pannello Admin.
• Visualizzazione Genitore: Le famiglie hanno accesso a una sezione dedicata in app dove possono consultare l'orario settimanale completo e le materie specifiche previste per il proprio figlio.

## 3. Gestione della Didattica (Argomenti e Compiti)
• Compilazione della Lezione: Contestualmente alla firma dell'ora, l'insegnante è tenuto a inserire l'argomento svolto in classe e i compiti assegnati per casa.
• Allegati Multimediali: Per entrambe le voci (argomenti e compiti), il docente ha la possibilità di allegare file multimediali (es. foto della lavagna, pagina del libro o schede).
• Visibilità e Assegnazione Compiti:
  • I compiti appaiono in una bacheca dedicata nell'app genitore/alunno.
  • Nessuna Notifica: L'assegnazione dei compiti non genera notifiche push (modalità consultazione pull).
  • Sola Lettura: Non è prevista una funzione di spunta o contrassegno "Svolto" lato genitore/alunno.
  • Recupero Assenti: I compiti assegnati e gli argomenti svolti rimangono visibili alle famiglie degli alunni risultati "Assenti" in quella giornata, garantendo il diritto al recupero.

## 4. Sistema di Valutazione e Voti

> [!IMPORTANT]
> **Adeguamento normativo (L. 1 ottobre 2024, n. 150 e O.M. n. 3 del 9 gennaio 2025).**
> Nella scuola primaria i **voti numerici sono vietati**, sia in itinere sia in sede di scrutinio.
> Il modello precedente (voti 1-10 + livelli Base/Intermedio/Avanzato dei riferimenti 2020) è
> **superato** e va sostituito. Lo stato attuale del codice ([GradesTab.tsx](src/components/features/teacher/register/GradesTab.tsx),
> tabella `valutazioni` con `voto_numerico`/`giudizio_testo`) **non è conforme** per la primaria.

> [!IMPORTANT]
> **Decisioni definitive — incongruenze #1, #2, #3, #4 (vedi Appendice → Note di coerenza).** *(Aggiornate dopo revisione del committente: media e categorie di prova confermate.)*
> - **#1 (Voto visibile = giudizio sintetico):** alla **primaria** il voto **visibile/ufficiale** mostrato a docenti e famiglie è **esclusivamente il giudizio sintetico** (in itinere e a scrutinio); **non si mostrano voti numerici 1-10**. È però **mantenuta un'associazione numerica interna/nascosta** a ciascun giudizio (es. *Sufficiente* = 6), usata **solo internamente** per il calcolo della media (vedi #3). I voti numerici visibili restano possibili solo per i gradi non-primaria.
> - **#2 (Scala giudizi):** l'unica scala ammessa per i giudizi sintetici della primaria è quella dell'**Allegato A O.M. 3/2025** — *Ottimo, Distinto, Buono, Discreto, Sufficiente, Non sufficiente*. La vecchia scala **Base/Intermedio/Avanzato** è **SUPERATA**.
> - **#3 (Medie — MANTENUTE, solo docente):** alla primaria **il calcolo della media È PREVISTO**, basato sull'**associazione numerica nascosta** dei giudizi sintetici (#1). La media è uno strumento interno di sintesi **del docente**. **Visibilità: la media numerica è mostrata ESCLUSIVAMENTE al personale docente/segreteria e NON è MAI visibile al genitore** — né in itinere né nell'area famiglia, e non viene nemmeno inviata al client dell'app genitore. L'app genitore espone solo i giudizi (sintetici/descrittivi), mai valori numerici o medie. Il documento di valutazione resta espresso in giudizi.
> - **#4 (Scritto/Orale/Pratico — MANTENUTE):** la categorizzazione **Scritto/Orale/Pratico è mantenuta anche alla primaria**: serve sia come tipologia della prova sia per i **termini di immodificabilità §8** (orali 2gg / scritte-pratiche 15gg). La valutazione in itinere usa comunque obiettivi di apprendimento e quattro dimensioni.

### 4.1 Motore di Valutazione Ibrido (configurabile per grado)
Il sistema espone un **unico motore di valutazione**, il cui comportamento è determinato da una
configurazione a livello di Admin per **grado d'istruzione / sezione**:
• **Primaria:** modello a **giudizi** conforme O.M. 3/2025. La modalità a voti numerici è disabilitata
  e non selezionabile dal docente.
• **Altri gradi (es. eventuale secondaria di primo grado):** può essere abilitata la modalità a voti
  numerici classici (1-10) con categorizzazione Scritto/Orale/Pratico.
• La configurazione è impostata dalla Segreteria/Dirigenza e applicata automaticamente in base alla
  classe dell'alunno: il docente non sceglie il "sistema di voto", lo eredita dal contesto.

### 4.2 Valutazione in Itinere (Primaria) — per Obiettivi di Apprendimento
La valutazione quotidiana mantiene **funzione formativa** e si articola così:
• **Obiettivi di Apprendimento:** prima di inserire qualsiasi valutazione, il docente associa alla
  propria disciplina gli obiettivi di apprendimento estratti dal **curricolo d'istituto** (definiti per
  classi parallele). Gli obiettivi sono gestiti come anagrafica configurabile (Admin/Dirigenza).
• **Valutazione per Dimensioni:** una prova viene legata a uno o più obiettivi e descritta tramite le
  quattro dimensioni cardine:
  1. **Autonomia** (Sì / No)
  2. **Continuità** (Sì / No)
  3. **Tipologia della situazione** (Nota / Non nota)
  4. **Risorse mobilitate** (Interne / Esterne / Entrambe)
• **Giudizio descrittivo auto-generato:** sulla base delle dimensioni il sistema propone un giudizio
  descrittivo testuale, **pienamente modificabile** dall'insegnante.
• **Giudizio sintetico in itinere (alternativa):** in alternativa al descrittivo esteso, il docente può
  registrare direttamente un giudizio sintetico abbreviato (es. Buono, Sufficiente) correlato
  all'obiettivo testato, per semplificare la visualizzazione nel prospetto.
• **Nessun voto numerico** alla primaria, in nessuna delle due modalità.
• **Annotazione numerica privata (facoltativa):** sulla singola verifica in itinere il docente può registrare un **appunto numerico** (scala /10) come **strumento di lavoro personale**. Vincoli: (a) il valore **ufficiale** periodico/finale per disciplina resta il **giudizio sintetico** (Allegato A) scelto dal docente; (b) l'annotazione **non compare** sul documento di valutazione (pagella/scrutinio); (c) **non è MAI visibile al genitore** (endpoint docente con gate di ruolo; gli endpoint `/api/parent/**` non la espongono); (d) **non genera automaticamente** il giudizio e **non produce medie automatiche**. Il sistema può al massimo **suggerire** un giudizio sintetico a partire dal numero (giudizio col valore nascosto più vicino), ma il docente deve **confermarlo** esplicitamente.

### 4.3 Scrutinio Periodico e Finale (Primaria) — Sei Giudizi Sintetici
In sede di scrutinio (intermedio e finale), il team dei docenti contitolari attribuisce a ciascun
alunno, **per ogni disciplina del curricolo** (compresa l'**Educazione Civica**), un unico **giudizio
sintetico** correlato al livello di apprendimento raggiunto. La scala è quella dell'**Allegato A
dell'O.M. 3/2025**, implementata in modo rigido (non rimodulabile nelle definizioni standard):

| Giudizio sintetico | Livello |
|--------------------|---------|
| **Ottimo** | Autonomia e consapevolezza piene anche in situazioni complesse e non note |
| **Distinto** | Buona autonomia, errori rari, gestione positiva di situazioni nuove simili a quelle note |
| **Buono** | Attività portate a termine con autonomia, in situazioni note |
| **Discreto** | Autonomia parziale, prevalentemente in situazioni note e con risorse fornite |
| **Sufficiente** | Attività essenziali svolte solo in situazioni note e con supporto/risorse esterne |
| **Non sufficiente** | Esecuzione incerta e non adeguata al contesto, anche con supporto |

• **Declinazioni locali (PTOF):** pannello di configurazione lato Admin/Dirigente per importare le
  declinazioni dei descrittori deliberate dagli organi collegiali, che integrano/sostituiscono i testi
  standard in pagella (le definizioni della scala restano comunque ancorate all'Allegato A).
• **Giudizio di comportamento:** espresso collegialmente come giudizio sintetico (no decimi).
• Il giudizio di scrutinio può essere proposto a partire dal quadro delle valutazioni in itinere, ma
  resta **modificabile/sovrascrivibile** collegialmente dal team docenti.

### 4.4 Isolamento delle Materie e Riservatezza tra Colleghi
• La visibilità delle valutazioni è limitata alla **propria disciplina**: un docente non accede alle
  valutazioni assegnate allo stesso alunno da docenti di altre materie.
• Eventuali aggregazioni/prospetti d'insieme sono riservate al team in sede di scrutinio e alla Dirigenza.

### 4.5 Comunicazione alle Famiglie
• **Solo giudizi, mai numeri:** l'area genitore mostra **esclusivamente i giudizi** (sintetici e/o
  descrittivi) e l'argomento della prova. **Nessun voto numerico e nessuna media** sono visibili al
  genitore, in itinere o a scrutinio; la media numerica resta uno strumento riservato al docente (vedi
  §4 #3) e non viene neppure trasmessa al client dell'app genitore.
• **Buffer di Sicurezza (a tempo):** una valutazione in itinere diventa visibile al genitore (e la
  notifica push parte) solo **trascorso il buffer dalla creazione** — `notif_buffer_valutazioni_min`,
  default 10 minuti — per consentire correzioni. La visibilità è calcolata sul **tempo di creazione**
  (`creato_il`), non su un flag di pubblicazione separato: il docente vede subito la propria valutazione,
  il genitore solo dopo il buffer.
• **Nessuna firma richiesta** per le normali valutazioni in itinere.
• **Persistenza Visiva:** in caso di account genitore sospeso (ritardi amministrativi), i dati del
  registro (valutazioni e compiti) restano comunque visibili, a tutela del diritto all'informazione didattica.

### 4.6 Note di Migrazione Dati
La struttura attuale (`valutazioni.voto_numerico`, `valutazioni.giudizio_testo`, `materia` testo libero)
va evoluta verso un modello che supporti: riferimento a **materia master** (vedi §6 Orario e Materie),
**obiettivi di apprendimento**, le **quattro dimensioni**, il **giudizio sintetico** (enum vincolato per
la primaria) e una distinzione tra valutazione *in itinere* e *di scrutinio*. La modalità a voti numerici
resta supportata a schema solo per i gradi non-primaria.

## 5. Note e Provvedimenti Disciplinari
• Categorizzazione Cromatica: Le note sono suddivise in tre categorie distinte, differenziate visivamente (tramite colori/icone) sull'app del genitore:
  1. Nota Disciplinare (Comportamento)
  2. Nota Didattica (Es. materiale dimenticato)
  3. Compiti a casa non svolti
• Assegnazione Massiva: L'insegnante può selezionare più alunni (o l'intera classe) e assegnare una nota collettiva con un'unica operazione.
• Firma per Presa Visione: A differenza dei voti, le Note Disciplinari richiedono obbligatoriamente l'interazione del genitore, che deve apporre una firma digitale per "presa visione" direttamente dall'applicazione, confermando la ricezione della comunicazione.

## 6. Orario, Tempo Scuola e Materie
La primaria adotta la **contitolarità** (più docenti sulla stessa classe) e diversi modelli di tempo
scuola. Il sistema supera la logica "una materia in testo libero per ora" introducendo dati strutturati.

### 6.1 Materie Master (Discipline)
• Anagrafica delle **discipline** gestita dalla Segreteria/Dirigenza (es. Italiano, Matematica, Storia,
  Geografia, Scienze, Inglese, Arte, Musica, Ed. Fisica, Tecnologia, Religione/Alternativa).
• **Educazione Civica** come disciplina trasversale dedicata (oggetto di valutazione autonoma a scrutinio).
• **Mensa** modellabile come **turno/disciplina** del tempo scuola (vedi §6.3), associabile anche a
  gruppi-classe quando gli alunni provengono da classi diverse.
• Valutazioni (§4) e firme di lezione si **agganciano alla materia master** (non più testo libero).

### 6.2 Campanelle e Matrice Oraria
• Definizione delle **"campanelle"** (intervalli orari di lezione) per plesso/classe.
• Matrice oraria settimanale che associa, per ciascuna campanella, **classe → materia → docente/i**.
• Gestione molti-a-molti per contitolarità (più docenti sulla stessa ora/classe).

### 6.3 Modelli di Tempo Scuola
• Configurazione per plesso/classe dei modelli: **Tempo Normale (27 o 29 ore)** e **Tempo Pieno (40 ore)**.
• Nel tempo pieno, l'orario include mensa e ricreazione come tempo scuola a tutti gli effetti.

### 6.4 Configurazione e Visibilità
• L'orario settimanale e l'assegnazione materie sono **gestiti dalla Segreteria** (pannello Admin).
• Le famiglie consultano in app l'**orario settimanale** e le materie previste per il proprio figlio.

## 7. Compresenza e Firma del Registro
### 7.1 Firma di Lezione
• La firma dell'ora avviene con un "tap" sulla campanella; contestualmente il docente inserisce
  **argomento svolto** e **compiti** (con eventuali allegati, vedi §3).

### 7.2 Compresenza — Cofirma Digitale
• Più docenti possono accedere alla **stessa ora/classe**. Il secondo docente (es. sostegno o
  potenziamento) può apporre la propria **cofirma** sull'argomento inserito dal docente ordinario,
  selezionando la **tipologia di compresenza** dal pannello.

### 7.3 Firma Indipendente per Alunni Specifici (oscuramento)
• Quando il docente di sostegno svolge **attività individualizzate** non coincidenti con la
  programmazione di classe, può firmare la medesima ora ma indirizzare **argomento, compiti e note
  esclusivamente a uno o più alunni selezionati**.
• Tali contenuti sono **oscurati alle famiglie degli altri alunni** per ragioni di riservatezza
  (visibilità ristretta ai soli destinatari).

## 8. Vincoli Temporali e Immodificabilità delle Registrazioni
Il registro elettronico ha natura di **atto pubblico**: inserimenti e modifiche sono tracciati e
sottoposti a vincoli temporali.

| Operazione | Termine massimo (default, configurabile) |
|------------|------------------------------------------|
| Modifica annotazioni del registro di classe | 2 giorni dall'evento |
| Inserimento valutazioni per prove orali | 2 giorni dallo svolgimento |
| Inserimento valutazioni per prove scritte/pratiche | 15 giorni dallo svolgimento |

• **Configurabilità:** i termini sono impostabili dall'istituto (con i valori di default sopra).
• **Blocco automatico:** oltre la scadenza il sistema impedisce inserimenti/modifiche.
• **Sblocco riservato:** solo Dirigente/Supervisor può sbloccare, **previa richiesta motivata**.
• **Tracciamento:** ogni inserimento, modifica e sblocco è registrato nell'audit (`registro_modifiche`):
  utente, azione, valore precedente/nuovo, timestamp, IP.

## 9. Scrutinio e Pagella Online
### 9.1 Workflow di Scrutinio
• Sessione collegiale del **team docenti contitolari**: per ogni alunno si consolidano i giudizi
  sintetici per disciplina + Educazione Civica + comportamento (vedi §4.3).
• La Dirigenza coordina e chiude la sessione di scrutinio (periodico e finale).

### 9.2 Documento di Valutazione (Pagella) — Livello Base
• Al termine dello scrutinio il sistema **genera il documento di valutazione in PDF statico** non modificabile.
• Le famiglie scaricano la pagella dall'area riservata, con l'**autenticazione attuale dell'app**.

> [!NOTE]
> **Conformità firma rimandata.** In questa fase la pagella **non** prevede firma digitale qualificata
> del Dirigente, né contrassegno elettronico, né download previa autenticazione forte SPID/CIE.
> Tali requisiti (integrazione certificatori di firma qualificata e identità digitale) sono pianificati
> come **fase successiva** e andranno aggiunti per la piena dematerializzazione a norma.

---

# PRD - Kidville App: Modulo Foto e Video (Galleria Multimediale)

## 1. Obiettivo del Modulo
Il modulo "Foto e Video" funge da hub centralizzato per la condivisione dei media scolastici. È un
widget trasversale, abilitato per tutti i gradi d'istruzione (Nido, Infanzia, Primaria). Il sistema è
progettato attorno a un rigoroso meccanismo di "Privacy Tagging", garantendo la totale aderenza
al GDPR e tutelando l'immagine dei minori, pur mantenendo un'esperienza di consultazione fluida
per le famiglie.

## 2. Caricamento e Gestione Media (Lato Insegnante)
### 2.1 Upload e Organizzazione
• Selezione Multipla (Bulk Upload): I docenti possono caricare simultaneamente più foto e video dalla galleria del proprio dispositivo.
• Nessun Limite di Formato: Non sono previsti limiti stringenti sulla durata dei video caricati.
• Feed Cronologico Unico: Non è prevista la creazione di cartelle o "Album" tematici. Tutti i media confluiscono in un unico feed verticale ordinato cronologicamente dal più recente al meno recente.
• Pubblicazione Diretta: L'upload da parte dell'insegnante è istantaneo e non richiede l'approvazione o la moderazione preventiva da parte della Segreteria.

### 2.2 Meccanismo di Tagging e Privacy Lock
• Regola del Tag Obbligatorio: Un contenuto multimediale viene caricato sui server, ma non è visibile a nessun genitore finché l'insegnante non effettua il tagging esplicito.
• Lista Completa: L'interfaccia di tagging mostra la lista completa degli alunni della classe (non filtrata per presenze giornaliere), permettendo al docente di selezionare chi è ritratto.
• Blocco Liberatoria Privacy: Il sistema implementa un blocco di sicurezza (Privacy Lock). Se per un determinato alunno la famiglia non ha firmato la liberatoria per l'uso delle immagini, il sistema inibisce l'interfaccia, impedendo fisicamente all'insegnante di selezionare e taggare quel bambino.
  🔄 **Aggiornamento 2026-07-13 (DL-051):** la liberatoria è richiesta **solo per le foto di gruppo** (più di un alunno taggato). Un alunno **senza liberatoria può essere taggato da solo**: la foto diventa **privata**, visibile ai soli suoi genitori. Il blocco `422` (coi nomi) scatta quindi solo quando in una foto con più taggati almeno uno è senza liberatoria; il broadcast (bypass tagging) resta riservato alla Direzione. La liberatoria è impostabile dalla scheda alunno dell'anagrafica (`consenso_privacy`, DL-052).

## 3. Esperienza Utente: Genitore (Visualizzazione e Interazione)
### 3.1 Visualizzazione Isolata
• Filtro Assoluto: II genitore ha accesso unicamente ai contenuti multimediali in cui il profilo del proprio figlio è stato esplicitamente taggato dall'insegnante. Foto di gruppo o di altri bambini in cui il figlio non compare sono totalmente invisibili e inaccessibili.
• Interazione in Sola Lettura: La galleria ha uno scopo puramente documentale. Non sono previste interazioni social (nessun "Mi piace", né commenti).

### 3.2 Azioni sui Media
• Download: I genitori sono autorizzati a scaricare liberamente foto e video sulla memoria locale del proprio smartphone.
• Condivisione Nativa: È presente un pulsante "Condividi" che permette di esportare il media verso app di terze parti (es. WhatsApp, Telegram) sfruttando le funzionalità native del sistema operativo del telefono.

## 4. Strumenti di Amministrazione e Sicurezza (Segreteria)
### 4.1 Moderazione e Controllo
• Cancellazione Globale: La Direzione/Segreteria detiene i diritti di amministrazione assoluta e può eliminare istantaneamente qualsiasi foto o video dal database e dal feed di tutti gli utenti, intervenendo rapidamente in caso di segnalazioni.

### 4.2 Comunicazioni Istituzionali (Bypass Tagging)
• L'Amministrazione ha a disposizione uno strumento per caricare "Media Generici" (es. locandine di eventi, foto della struttura vuota, comunicazioni visive). Per questi caricamenti, la Segreteria può bypassare il meccanismo di tagging e inviare il file in broadcast a tutti i genitori dell'istituto o a classi specifiche.

### 4.3 Tutela dell'Immagine (Watermark)
• Watermark Automatico: Per tutelare la provenienza e la proprietà delle immagini scolastiche, l'applicazione applica in automatico in fase di caricamento un watermark contenente il logo della scuola. Questo viene posizionato di default al centro in basso su ogni singola foto caricata dai docenti.

## 5. Interconnessioni Architetturali
• Sincronizzazione con "Diario 0-6": Il modulo Galleria funziona come collettore centrale. Le foto scattate e taggate direttamente all'interno delle attività del Diario Nido/Infanzia (es. lavoretto, momento della merenda) confluiscono automaticamente e in tempo reale in questo widget, evitando duplicazioni di caricamento per il docente.

---

# PRD - Kidville App: Modulo Presenze e Check-in/Check-out

## 1. Obiettivo del Modulo
Il modulo Presenze è il sistema centrale per il tracciamento fisico degli alunni all'interno della
struttura scolastica. Copre l'intero ciclo giornaliero (dall'ingresso all'uscita), gestisce in modo
sicuro le deleghe di ritiro e funge da "sorgente di verità" per abilitare o disabilitare l'operatività di
altri moduli (come il Diario e il Registro di Classe).

## 2. Esperienza Utente: Insegnante (Appello e Uscita)
### 2.1 Fase di Check-in (Ingresso)
• Vista di Classe: L'insegnante visualizza esclusivamente la lista degli alunni assegnati alla propria classe.
• Logica "Empty State": All'apertura della schermata di appello, la lista si presenta non compilata (nessun "Presente" di default).
• Timestamp Automatico e Modificabile: Un semplice tap sul nome dell'alunno segna lo stato "Presente" e l'app registra automaticamente l'orario di ingresso (Check-in) basato sull'orologio di sistema. Qualora l'alunno fosse entrato precedentemente e l'insegnante stesse compilando il registro in ritardo, l'orario di Check-in può essere modificato manualmente.

### 2.2 Fase di Check-out (Uscita) e Sicurezza
• Registrazione Uscita: A fine giornata (o in caso di uscita anticipata), l'insegnante esegue il "Check-out", registrando l'orario effettivo di uscita dalla struttura.
• Verifica Delegati: L'insegnante non è tenuto a selezionare manualmente chi ha ritirato il bambino, ma ha a disposizione un rapido accesso in sola lettura alla lista dei delegati autorizzati.
• Riconoscimento Visivo: Aprendo la scheda delegati, l'insegnante visualizza in tempo reale la foto del documento d'identità caricato in precedenza dalla famiglia, permettendo un riconoscimento visivo immediato e sicuro.
• Allarme Ritiro Non Autorizzato (Panic Alert): Qualora si presenti una persona non presente nella lista dei delegati, l'insegnante ha a disposizione un pulsante di blocco/allerta. La pressione del tasto genera una notifica istantanea simultanea alla Segreteria e all'App del Genitore, bloccando l'uscita dell'alunno.

### 2.3 Operatività Offline
• Caching Locale: Tutte le operazioni di Check-in e Check-out sono garantite anche in assenza di rete. I dati vengono salvati nella cache locale e sincronizzati automaticamente con il cloud al ripristino della connettività.

## 3. Esperienza Utente: Genitore (Assenze e Giustifiche)
• Comunicazione Silenziosa: Non sono previste notifiche push in tempo reale per i normali eventi di Check-in e Check-out, per evitare di sovraccaricare il genitore con avvisi considerati di routine.
• Preavviso di Assenza: Il genitore può inserire preventivamente, in totale autonomia tramite l'App, un avviso di assenza (es. per malattia o motivi familiari) prima dell'inizio delle lezioni.
• Caricamento Certificati Medici: In caso di assenza prolungata (es. superiore ai giorni previsti dal regolamento), l'interfaccia richiede e permette al genitore l'upload diretto del certificato medico di riammissione, che andrà in validazione alla Segreteria.

### 3.1 Libretto Web — Giustificazione Online (con PIN dispositivo)
• **Giustificazione online:** in presenza di assenza, ritardo o uscita anticipata registrati dal docente,
  l'area genitore abilita la funzione di **giustificazione digitale** dell'evento.
• **PIN dispositivo:** l'operazione è protetta dall'inserimento di un **codice PIN dispositivo** scelto
  dal genitore, per prevenire utilizzi non autorizzati (equivalente digitale del libretto cartaceo).
• **Tracciamento:** ogni giustificazione registra autore, evento giustificato, motivazione, timestamp e
  presa visione; lo storico è consultabile da genitore e Segreteria.
• **Integrazione:** la funzione si lega agli eventi del modulo `presenze` e al flusso certificati medici
  esistente; più tutori dello stesso alunno mantengono libretti/PIN distinti.

## 4. Dashboard Amministrazione e Cucina
### 4.1 Monitoraggio Segreteria
• Fotografia Globale: La dashboard della Segreteria mostra una panoramica in tempo reale degli alunni presenti in tutta la struttura, con la possibilità di cliccare ed effettuare un "drill-down" (dettaglio) per visualizzare i numeri specifici di ogni singola classe.
• Sovrascrittura Dati: La Direzione possiede i permessi di amministrazione per modificare, correggere o sovrascrivere eventuali errori di registrazione (presenze/assenze) commessi dagli insegnanti.
• Export Ministeriale: È presente una funzione di esportazione (in formato Excel/PDF) dei registri di presenza validi ai fini dei controlli MIUR per Nido, Infanzia e Primaria.

### 4.2 Dashboard Cucina e Cut-off Mensa
• Orario di Cut-off: II limite orario (es. 09:30) per l'invio dei numeri definitivi dei pasti viene gestito direttamente dalla Dashboard della Cucina.
• Approvazione Ritardi: Se un alunno entra in Ritardo (post cut-off), la sua presenza viene registrata, ma l'aggiunta del suo pasto alla lista della cucina richiede un'approvazione manuale da parte della Segreteria.
  🔄 **Sportello Segreteria (2026-07-13, DL-054):** la Segreteria (oltre a Direzione) può **forzare l'inserimento** di un pasto **fuori cut-off** su `/api/mensa/prenotazioni` (salta cutoff e vincolo saldo>0; il saldo può andare **negativo** → l'alunno confluisce nei **morosi**; origine `segreteria`, movimento tracciato su `mensa_ticket_movimenti` con `saldo_dopo`) e **disdire oltre il cut-off** (anche date passate: rettifica con riaccredito, tracciata con `creato_da`/`creato_il`). Il **Report Cucina** è ora leggibile anche dalla Segreteria (`requireKitchenRead`). Il genitore resta vincolato a cut-off + saldo positivo.

## 5. Interconnessioni Architetturali e di Flusso
• Isolamento Finanziario: II tracciamento delle presenze/assenze non ha alcun impatto automatizzato sulla fatturazione o sulle rette mensili gestite nel modulo Pagamenti.
• Disaccoppiamento Mensa: Segnare un bambino "Presente" non consuma automaticamente il ticket pasto. Le due azioni (Check-in fisico e consumo del pasto nel Diario) rimangono logicamente separate per l'insegnante.
• Sincronizzazione Diario 0-6: Un alunno che non è marcato "Presente" in questo widget globale scompare automaticamente dalle liste di selezione multipla del Diario di Bordo (Nido/Infanzia), prevenendo l'inserimento accidentale di routine (es. pasti, nanna) per bambini non a scuola.
• Sincronizzazione Primaria: Allo stesso modo, lo stato di "Assente" nel modulo Presenze generale si riflette in automatico nel Registro di Classe della Scuola Primaria.

---

# PRD - Kidville App: Modulo Comunicazione (Chat e Bacheca Avvisi)

## 1. Obiettivo del Modulo
Il modulo Comunicazione centralizza tutti i flussi informativi della piattaforma Kidville. È suddiviso
in tre macro-aree logiche: la messaggistica istantanea (Chat) per il dialogo quotidiano e privato tra
scuola e famiglia, la Bacheca per le comunicazioni ufficiali (Circolari/Avvisi) e un sistema di Task
interno per il coordinamento dello staff. Il modulo è progettato per abbattere le barriere
linguistiche e garantire il pieno controllo amministrativo da parte della Direzione.

## 2. Chat Privata (Scuola - Famiglia)
### 2.1 Logica e Inoltro Messaggi
***Comunicazione 1-a-1:** La messaggistica è rigorosamente individuale. Non sono previsti "Gruppi Classe" tra genitori.
***Isolamento Genitoriale:** In caso di più tutori per lo stesso bambino (es. genitori separati), le chat rimangono distinte. Ogni genitore ha un thread separato con l'insegnante.
***Vincolo di Contatto:** I genitori possono avviare e intrattenere chat esclusivamente con gli insegnanti assegnati alla classe del proprio figlio.
***Operatività H24:** II sistema permette l'invio e la ricezione di messaggi 24 ore su 24, senza blocchi orari imposti dal sistema.

### 2.2 Funzionalità Multimediali e Accessibilità
***Condivisione File:** All'interno della chat è pienamente supportato l'invio di allegati multimediali, inclusi documenti (PDF), fotografie e note vocali.
***Traduzione Automatica:** Per favorire l'inclusione, il modulo integra un sistema di traduzione automatica in tempo reale, permettendo agli insegnanti e alle famiglie straniere di comunicare efficacemente ciascuno nella propria lingua madre.

## 3. Bacheca e Avvisi Ufficiali (Circolari)
### 3.1 Creazione e Targeting
***Permessi di Invio:** La Segreteria può inviare comunicazioni a livello globale (intero istituto) o filtrarle per classi specifiche. Anche il singolo Insegnante ha i permessi per creare e pubblicare avvisi, limitatamente alla propria classe di competenza.
***Tipologia di Avviso:**
***Presa Visione:** L'apertura e la lettura dell'avviso da parte del genitore registra automaticamente la "Presa visione" a sistema (Read Receipt).
***Richiesta di Adesione:** Per avvisi che richiedono un'autorizzazione (es. gita scolastica), il sistema abilita pulsanti interattivi che permettono al genitore di esprimere una conferma (Si) o un diniego (No) esplicito.

### 3.2 Monitoraggio
***Dashboard Avvisi:** L'interfaccia di Segreteria e dell'Insegnante include un cruscotto di monitoraggio per ogni avviso inviato. Mostra in tempo reale l'elenco di chi ha letto la comunicazione e un recap tabellare delle risposte per le richieste di adesione.

## 4. Comunicazione Interna (Gestione Task Staff)
***Dashboard Segreteria-Insegnanti:** La comunicazione organizzativa interna non avviene tramite chat, ma attraverso un sistema a bacheca/task.
***Assegnazione Comunicazioni:** Se un genitore lascia un messaggio in Segreteria o se c'è una direttiva interna, la Direzione crea un "Task/Comunicazione" assegnandolo a una classe intera (visibile a tutti i docenti di quella sezione) oppure a un singolo insegnante specifico.

## 5. Sicurezza e Amministrazione (Direzione)
### 5.1 Permessi di "Super-Admin"
* La Direzione/Segreteria dispone di privilegi di livello Super-Admin. Questo garantisce la facoltà di accedere in sola lettura e in chiaro a tutte le chat private intercorse tra insegnanti e genitori, al fine di tutelare l'istituto e risolvere eventuali controversie. *(P0: l'identità Super-Admin è risolta dalla sessione (`requireStaff` → `resolveIdentity`), non più da `?userId=`.)*

### 5.2 Persistenza dei Dati
***Conservazione Storico:** I thread di chat non vengono mai cancellati automaticamente (nemmeno al termine dell'anno scolastico), ma fungono da storico. La cancellazione di una chat può avvenire solo tramite intervento manuale e insindacabile della Direzione.
***Sempre Attivo (Emergenze):** Il modulo di comunicazione è considerato un canale critico. Pertanto, anche nel caso in cui l'account di un genitore venga sospeso per motivazioni amministrative (es. insolvenze), la chat privata rimane pienamente operativa per garantire la comunicazione in caso di emergenze.

---

# PRD - Kidville App: Modulo Gestione Form di Raccolta Dati (Kidville)

## 1. Descrizione Generale
La funzione "Form" di Kidville rappresenta il motore avanzato per la creazione, compilazione, gestione e validazione di moduli digitali. Pensato per sostituire integralmente il cartaceo, il sistema gestisce l'intero ciclo di vita del dato: dalla raccolta tramite interfacce utente lussuose e guidate, fino all'importazione automatizzata nelle anagrafiche principali del gestionale, passando per la validazione legale tramite Firma Elettronica Avanzata (FEA).

## 2. Obiettivi
- **Digitalizzazione Completa:** Gestire iscrizioni, deleghe, consensi (es. privacy/foto), sondaggi e creazione automatica di graduatorie.
- **Esperienza Premium (UX):** Offrire ai genitori un flusso di compilazione "wizard" (passo-passo, una pagina per persona) fluido e privo di stress cognitivo.
- **Gestione Staff Intuitiva:** Fornire agli amministratori un costruttore di form Drag & Drop altamente visivo.
- **Sicurezza e Validità Legale:** Garantire la protezione dei dati (tramite RLS in Supabase) e la validità delle firme tramite verifica OTP via Email.
- **Integrazione Nativa:** Automatizzare i flussi di ETL (Extract, Transform, Load) verso le anagrafiche direttamente tramite PostgreSQL.

## 3. Stack Tecnologico di Riferimento
- **Frontend:** Next.js 19, React, Tailwind CSS, Framer Motion (per micro-animazioni nei wizard), @dnd-kit/core (per il builder).
- **Backend & Database:** Supabase (PostgreSQL per dati relazionali e JSONB per campi dinamici), Supabase Auth.
- **Storage:** Supabase Storage.
- **Automazioni & ETL:** Trigger e funzioni PL/pgSQL nativi, pg_cron per task schedulati.
- **Generazione Documenti:** Server-side via API Routes (Next.js) integrato con librerie di generazione PDF (es. Puppeteer o PDFKit).

## 4. Requisiti Funzionali
### 4.1. Creazione e Configurazione Modelli (Form Builder)
- **Interfaccia Costruttore:** Area dedicata allo staff (Form > Modelli) dotata di un'interfaccia Drag & Drop per assemblare rapidamente i moduli.
- **Componenti Dinamici:** Possibilità di inserire blocchi predefiniti (Dati Bambino, Dati Adulto, Consensi, Caricamento Allegati) o campi personalizzati. **✅ (P3.3e, DL-029)** blocco **Consensi/Privacy** (tipo `consent`: testo del consenso + link informativa + checkbox obbligatoria) e blocco **Allegati** (tipi file ammessi + dimensione max) disponibili nella palette del builder e configurabili nel `PropertiesPanel`; l'accettazione dei consensi è archiviata con **snapshot legale** (`form_submissions.consents_log`: testo + timestamp, evidenza GDPR).
- **Logica Condizionale:** Impostazione di regole di visibilità e obbligatorietà basate sulle risposte precedenti. **✅ (P3.3a, DL-024)** motore puro `src/lib/forms/conditional.ts` (operatori =, ≠, contiene, >, <): il wizard mostra/nasconde i campi a runtime, valida solo i visibili (un campo nascosto, anche obbligatorio, non blocca) e rimuove i valori nascosti dalla submission; editor condizione nel `PropertiesPanel`. Modello a singola condizione per campo (`FormField.condition`).
- **Scoring per Graduatorie:** Il builder deve permettere l'assegnazione di un "peso" o "punteggio" (scoring) a specifiche risposte o blocchi (es. +5 punti per genitori lavoratori, +3 punti per fratelli già iscritti) per automatizzare la generazione delle graduatorie. **✅ (P3.3b, DL-025)** scoring applicato in live (migr. `20260743`: colonne+trigger+indice); **delibera ammissioni** automatica (soglia+posti, `calcolaDelibera`) con esito ammesso/lista_attesa/non_ammesso, override per-candidato ed **export PDF** della delibera. *(NB: trigger ETL form→anagrafiche deferito per drift `adults`/`student_adults`.)*
- **Configurazione Accessi:** Definizione di chi può compilare il form (utenti registrati o tramite link pubblico). Nota: Nessuna integrazione SPID richiesta. **✅ (P3.3f, DL-030)** **Pubblica modello**: dal builder la Segreteria pubblica/ritira il modello e ottiene un **link pubblico** `/m/{public_token}` (`POST /api/admin/form-models/publish`, colonne `published_at`/`public_token`/`access_mode` — migr. `20260747`). **Config accessi**: `public` (chiunque col link) o `authenticated` (solo registrati). La compilazione anonima passa da `/m/[token]` → endpoint **token-scoped** `/api/public/forms/[token]/submit|upload` (consensi obbligatori applicati; snapshot `consents_log`). *(La firma OTP su form pubblici — raccolta email firmatario — è rinviata alla slice firma congiunta.)*
- **Impostazioni FEA:** Abilitazione della Firma Elettronica Avanzata, definendo i firmatari richiesti (firma singola o congiunta di entrambi i genitori). *(DL-001: FEA realizzata in-house come servizio trasversale Fase P1 — OTP email + ricevuta PDF con log IP/Timestamp/Hash SHA-256.)* **✅ Implementato (P1):** servizio `src/lib/fea/` riusabile — builder `signature_log` canonico, **slot firmatari** `fea_signatures` con policy di completamento configurabile (default `any-one`, opzione `all-required` — DL-007), **audit immutabile** `fea_audit_log` (DL-009), **ricevuta PDF inattaccabile** `GET /api/fea/receipt` (hash documentale SHA-256 + IP/UA/timestamp, libreria **jsPDF** — DL-006). Consumatori ricablati: wizard moduli, ricezione pagella, giustifica assenza. *(Nota legale: implementazione in-house "FEA" per DL-001; informativa/processo da validare col committente.)* **✅ Firma congiunta + reinvio OTP (P3.3g, DL-031):** `signature_mode` `single`/`joint` su `form_models` (migr. `20260748`, toggle nel builder). In `joint` la submission resta `pending_signature` finché entrambi i genitori non firmano: `/api/forms/send-otp` è **slot-aware** (registra uno slot `fea_signatures` per firmatario, completa con policy `all-required`); il **2° firmatario** è email-only (POST send-otp con `submissionId`+`signerEmail`). **Reinvio OTP** = POST send-otp con `submissionId` (rigenera+reinvia). UI `OtpSignatureModal`: bottone "Reinvia codice" (cooldown) + step "2° genitore".

### 4.2. Compilazione Form (Lato Utente/Genitore)
- **Modalità di Rete:** Compilazione strettamente "Online-Only" per garantire l'immediata validazione degli OTP e la sicurezza dei caricamenti.
- **UX / UI Design:** Flusso "Wizard" (Step-by-step). L'interfaccia mostrerà una sezione alla volta (es. "Pagina 1: Dati Madre", "Pagina 2: Dati Padre", "Pagina 3: Dati Bambino") con transizioni fluide gestite da Framer Motion.
- **Firma Elettronica e OTP:** Al termine della compilazione, il sistema invierà un codice OTP via Email al firmatario per validare legalmente il documento prima dell'invio definitivo.
- **Caricamento Allegati:** Supporto per l'upload di documenti (es. carte d'identità, certificati medici) direttamente all'interno dei passaggi del wizard. **✅ (P3.3e, DL-029)** endpoint upload generico server-side `POST /api/forms/upload` (service-role, validazione tipo/dimensione, bucket privato `form_attachments`): ripara l'upload nel wizard **autenticato** (il client browser anon non può scrivere su bucket deny-by-default). Sicurezza allegati = **service-role + scoping app** (nessuna policy `storage.objects`, coerente con P0).

### 4.3. Gestione Compilazioni (Raccolta Dati)
- **Dashboard Raccolta:** Vista a tabella/lista per lo staff con filtri avanzati (data, stato, modello, tag).
- **Anteprima e Modifica:** Visualizzazione chiara dei dati JSONB raccolti. Possibilità per lo staff di applicare correzioni amministrative mantenendo un log della versione originale compilata dall'utente.
- **Generazione ed Esportazione:**
  - **Generazione PDF:** Gestita lato server per garantire un layout impeccabile e non gravare sul dispositivo dell'utente. I PDF escluderanno gli allegati fisici dalla stampa.
  - **Esportazione XLSX:** Download dell'intero dataset per analisi esterne.
  - **Integrazione Anagrafiche (ETL nativo):** I dati raccolti nei moduli di "Iscrizione" vengono riversati nelle tabelle anagrafiche principali di Kidville (Utenti, Bambini, Relazioni). Questo processo di mapping ed estrazione dai campi JSONB avviene direttamente nel database tramite funzioni e trigger PostgreSQL SQL, garantendo massima velocità e consistenza relazionale.

### 4.4. Gestione Graduatorie
- **Calcolo Punteggi:** Generazione automatica di liste di ammissione basate sui pesi/punteggi configurati nel Form Builder.
- **Dashboard Graduatorie:** Possibilità per lo staff di visualizzare il ranking, applicare correzioni manuali (override di punteggio per casi eccezionali) e deliberare le ammissioni.

## 5. Requisiti Non Funzionali e Sicurezza
### 5.1. Sicurezza e Storage (RLS)
- **Row Level Security (RLS) Rigorosa:** Le policy su Supabase Storage e Database devono essere strettissime. Gli allegati caricati durante la compilazione devono essere accessibili esclusivamente al compilatore originale e al personale amministrativo autorizzato (Staff). Nessun accesso pubblico o inter-utente.

### 5.2. Automazioni e Cron Jobs
- **Motore di Automazione Interno:** L'invio di solleciti per firme non completate, promemoria di scadenza moduli e altri task periodici sono gestiti interamente dal database utilizzando l'estensione pg_cron di PostgreSQL su Supabase. Nessun servizio esterno per l'orchestrazione dei job.

### 5.3. Performance e Accessibilità
- L'approccio server-side per i documenti complessi e l'utilizzo di viste materializzate / query JSONB ottimizzate in PostgreSQL garantiranno altissime performance anche con migliaia di compilazioni storiche archiviate.
- Compatibilità totale della web app su browser desktop e mobile.

---

# PRD - Kidville App: Modulo Menu e Mensa

## 1. Obiettivo del Modulo
Il modulo "Menu e Mensa" automatizza la filiera della ristorazione scolastica. Gestisce in modo
integrato la pianificazione ciclica dei pasti, la sicurezza alimentare tramite il matching automatico
degli allergeni, l'amministrazione dei "Ticket Pasto" a scalare e fornisce interfacce dedicate sia
per lo staff didattico che per il personale di cucina.

## 2. Configurazione Menu e Gestione Cucina
### 2.1 Menu Builder e Ciclicità
• Menu Builder Digitale: La Segreteria non carica PDF statici, ma utilizza un "Menu Builder" nativo per strutturare i pasti (Primo, Secondo, Contorno, Frutta).
• Ciclicità Programmabile: Il sistema supporta la creazione di menu ciclici. La Segreteria imposta la durata del ciclo (es. 4 settimane) e il sistema autocompila il calendario futuro, riducendo il data-entry.
• Variazioni Giornaliere: È possibile applicare eccezioni e variazioni al menu giornaliero (es. sostituzione di un ingrediente non consegnato dal fornitore), che generano in automatico una notifica di aggiornamento alle famiglie.
• Gestione Calendario Chiusure: La Segreteria imposta i giorni di festività/chiusura a livello globale. In tali giorni, l'intero modulo mensa si disattiva, inibendo richieste pasti e scali di ticket.

### 2.2 Dashboard Dedicata (Ruolo "Cuoca")
• Isolamento dell'Interfaccia: Il sistema prevede un Ruolo Auth specifico per il personale di cucina. Accedendo con questo ruolo su un tablet, la "Cuoca" visualizza esclusivamente la dashboard mensa.
• Dati Operativi: La dashboard mostra in tempo reale i numeri definitivi dei pasti da preparare, raggruppati per tipologia (Pasti Standard, Diete in Bianco, Diete Speciali per intolleranze), garantendo massima privacy e oscurando il resto delle funzioni dell'app (es. chat, valutazioni).

## 3. Sicurezza Alimentare e Intolleranze
• Tracciamento Obbligatorio: Durante l'inserimento dei piatti nel Menu Builder, è obbligatorio specificare i relativi allergeni (es. glutine, lattosio, uova).
• Matching Automatico e Alert: Il sistema incrocia costantemente gli allergeni del piatto con i dati medici dell'Anagrafica dell'alunno.
• Interfaccia Genitore: Nel calendario menu del genitore, se è previsto un pasto pericoloso per il bambino, il piatto viene automaticamente contrassegnato con un'icona di allerta visiva inequivocabile (es. semaforo rosso).

## 4. Ticketing e Modello Economico
### 4.1 Logica "Prepagato a Scalare"
• Saldo Separato: Il sistema funziona a "Ticket Pasto" a scalare. Ogni alunno possiede un proprio saldo individuale (nessun "portafoglio famiglia" condiviso in caso di fratelli).
• Ricarica Offline (Solo Segreteria): L'acquisto di nuovi pacchetti di ticket non avviene tramite pagamento in-app (es. Stripe). Le famiglie acquistano i ticket tramite la Segreteria, la quale ha un'interfaccia dedicata per accreditare manualmente il numero di ticket e il relativo importo al profilo dell'alunno.
• Reminder Esaurimento Scorte: Quando il saldo di un alunno scende sotto una soglia critica preimpostata, il sistema invia in automatico una notifica push al genitore ("Attenzione, ticket mensa in esaurimento").

### 4.2 Consumo e Rimborsi
• Scatto del Ticket: II ticket viene scalato nel momento in cui il genitore (tramite la propria app) spunta/prenota attivamente la consumazione del pasto per la giornata.
• Storni Manuali: La Segreteria possiede i permessi amministrativi per effettuare rimborsi manuali o riaccreditare ticket in caso di uscite anticipate impreviste.

## 5. Operatività Quotidiana (Docenti e Famiglie)
### 5.1 Flusso Insegnante e Richieste Speciali
• Vista Menu e Consumi: L'insegnante visualizza il menu in un tab separato dell'app, corredato dalla lista degli alunni che hanno regolarmente prenotato il pasto per quel giorno.
• Diete in Bianco: L'insegnante può richiedere una dieta in bianco per un alunno (es. in caso di malessere temporaneo). Questa operazione deve avvenire rigorosamente entro l'orario di cut-off (es. 09:30) per aggiornare tempestivamente i monitor della cucina.
• Esclusioni di Classe: In caso di gita scolastica, l'insegnante ha a disposizione un comando di "blocco massivo" per annullare la mensa per tutta la classe con un solo click.

### 5.2 Specificità Scuola Primaria
• Poiché alla Scuola Primaria non si utilizza il Diario 0-6 per la rendicontazione dei pasti, è prevista una sezione speciale "Cucina/Mensa". In questo tab, la Segreteria o l'insegnante compila in modo rapido l'elenco dei bambini effettivamente presenti in refettorio, permettendo al sistema di allineare e scalare correttamente i ticket.

### 5.3 Esportazioni e Fatturazione Esterna
• Report Catering: La Direzione scolastica dispone di uno strumento di esportazione che genera un report di fine mese (Excel/PDF) con i numeri esatti e aggregati dei pasti consumati (divisi per standard e speciali). Questo documento è pronto per essere inviato all'azienda di catering esterna per la rendicontazione e fatturazione.

---

# PRD - Kidville App: Modulo Pagamenti e Gestione Economica

## 1. Obiettivo del Modulo
Il modulo Pagamenti (lib/features/payments/) è il sistema di tracciamento finanziario della
piattaforma. La scelta architetturale fondamentale è l'assenza di pagamenti in-app: l'applicazione
funge da scadenziario, promemoria e registro di stato per le famiglie, mentre la transazione
economica reale avviene esternamente (bonifico, contanti, POS) e viene validata manualmente
dalla Segreteria.

## 2. Creazione e Assegnazione Pagamenti (Lato Segreteria)
### 2.1 Generatore Universale
La Segreteria dispone di un tool per generare qualsiasi tipologia di pagamento (es. Rette, Quote d'iscrizione, Divise, Gite).
• Assegnazione Flessibile: I pagamenti possono essere assegnati massivamente a un'intera classe oppure singolarmente a specifici studenti.
• Rateizzazione: In fase di creazione di un pagamento ad alto importo, la Segreteria ha la facoltà di abilitare un piano di rateizzazione predefinito.

### 2.2 Rette Mensili e Quote
• Automazione Rette: Il sistema genera automaticamente le rette ricorrenti. Di default, la retta applicata e la data di scadenza sono standard per tutti.
• Override Anagrafico: Non ci sono sconti automatici. Eventuali modifiche all'importo della retta (es. sconti fratelli) o alla data di scadenza devono essere impostate manualmente dalla Segreteria all'interno dell'Anagrafica dello studente.
• Quote d'Iscrizione: A differenza delle rette, la quota di iscrizione annuale non si autogenera all'importazione dell'alunno, ma deve essere assegnata manualmente.
• Split Pagamenti (Genitori Separati): Su richiesta delle famiglie, la Segreteria può impostare dall'Anagrafica la divisione del debito (es. $50/50$) su due account genitoriali distinti.

## 3. Registrazione, Fatturazione e Morosità
### 3.1 Registrazione Incassi
• II genitore non può pagare tramite l'app.
• Quando la Segreteria riceve il pagamento, lo registra manualmente a sistema. L'aggiornamento dello stato in "Pagato" è istantaneo e si riflette in tempo reale sull'app del genitore.
• Fatturazione su Richiesta: Il sistema non invia fatture automaticamente. La Segreteria ha a disposizione un pulsante "Invia Fattura/Ricevuta" per generare e inoltrare il documento al genitore.

### 3.2 Cruscotto Insoluti
• Dashboard Morosità: La Direzione ha una visuale completa sui pagamenti in sospeso. Gli utenti insoluti e i pagamenti scaduti sono evidenziati cromaticamente in rosso.
• Sospensione Manuale: Il blocco dell'account per grave morosità (es. inibizione delle funzioni app) non è automatico, ma richiede un'azione manuale e consapevole da parte della Direzione. **✅ (P3.2, DL-021)** flag soft per-alunno (`alunni.sospeso`), set dalla Direzione (`POST /api/admin/pagamenti/sospensione` + audit); il genitore legge ma le azioni di servizio (firme moduli) sono inibite; banner genitore + badge admin. *(Login e info di sicurezza sul minore preservati.)*

## 4. Esperienza Utente Genitore e Reminder
### 4.1 Visualizzazione a Categorie
• L'interfaccia genitore categorizza i pagamenti per tipologia (es. "Rette", "Quote di iscrizione", "Mensa", "Gite"). **✅ (P3.2, DL-022)** vista raggruppata per `payment_categories` (`raggruppaPerCategoria`), storico saldati + pendenze per categoria. Ricevuta PDF non fiscale scaricabile sul saldato **✅ (DL-023)**.
• Ogni categoria mostra chiaramente lo storico dei pagamenti saldati e le pendenze future.
• Voci Facoltative: Per i pagamenti non obbligatori, il genitore può semplicemente ignorarli; resteranno visibili nell'elenco fino alla data di naturale scadenza.

### 4.2 Sistema di Reminder Aggressivo
• Per combattere le insolvenze, il sistema prevede una logica di notifica push automatizzata per i pagamenti obbligatori:
  1. Notifica nel giorno esatto della scadenza.
  2. Reminder ricorrente inviato ogni due giorni finché la Segreteria non contrassegna la voce come saldata.

## 5. Interconnessioni Modulari
• Widget Mensa: La vendita dei pacchetti ticket mensa è gestita unicamente dalla Segreteria, che inserisce manualmente nel sistema il numero di pasti acquistati a seguito del pagamento esterno.
• Widget Form (Gite): II flusso amministrativo per le gite richiede un doppio check. Nell'elenco riepilogativo della Segreteria e dell'insegnante, l'alunno avrà il "Semaforo Verde" per partecipare all'uscita solo se possiede sia l'autorizzazione firmata digitalmente (Modulo Form) sia la quota saldata (Modulo Pagamenti). **✅ Proxy upload cartaceo (P3.3h, DL-032):** se un genitore consegna il modulo **firmato a penna** alla porta, la maestra/Segreteria carica la **scansione** dal semaforo docente (`POST /api/teacher/modulistica`, **gate `requireDocente`**): upload reale su `form_attachments/cartaceo/`, la sottomissione è marcata `origine='cartaceo'` (migr. `20260749`) con evidenza strutturata (`method:'PROXY_CARTACEO'`, staff acquirente, IP/UA/timestamp) + audit `logScrittura`; il **merge PDF di classe** distingue "(CARTACEO)" dalla FES digitale. *(Era uno stub: salvava un path finto, senza upload né gate.)*

---

# PRD - Kidville App: Modulo Fatturazione Elettronica (Integrazione Aruba)

> **✅ Implementato (P3.1, 2026-06-26 — DL-017/018/019/020):** integrazione **reale** Aruba REST (no mock).
> Generatore XML FatturaPA in-house (B2C/FPR12, TD01, IVA 0% Natura N4, no bollo, IdTrasmittente Aruba PEC),
> client REST `signin/upload/getByFilename`, numerazione interna per scuola/anno, state machine stati SDI,
> monitoraggio scarti via cron `fatture-sdi-sync` con notifica realtime Segreteria + banner, copia di cortesia
> PDF al genitore. Credenziali mai esposte (env/vault). **La verifica live end-to-end con lo SDI è subordinata
> alle credenziali Aruba DEMO/PROD del committente** (codice pronto, attivazione con flag + credenziali).

## 1. Obiettivo del Modulo
Il modulo di Fatturazione Elettronica estende le capacità finanziarie del sistema interfacciandosi
nativamente con l'ecosistema Aruba. L'obiettivo è generare vere e proprie fatture elettroniche (in
formato XML destinate al Sistema di Interscambio - SDI dell'Agenzia delle Entrate) in modo
sicuro, rispettando le normative fiscali vigenti per gli enti scolastici, senza appesantire il flusso di
lavoro manuale della Segreteria.

## 2. Architettura Sicura e Flusso API
• Backend Proprietario per la Sicurezza: Per garantire la massima sicurezza e non esporre mai le chiavi API di Aruba nel codice frontend dell'applicazione, l'intera logica di comunicazione con Aruba avviene lato server. Il click sul pulsante nell'app innesca una chiamata API a un endpoint dedicato del nostro backend (es. Node.js/Python). Il backend, che dialoga in sicurezza con il database PostgreSQL, si occuperà di eseguire la chiamata protetta verso i server di Aruba in background, mantenendo nascoste le chiavi API.
• Azione Esclusivamente Manuale: Non è prevista alcuna automazione occulta. La generazione e l'invio della fattura ad Aruba avvengono solo ed esclusivamente se la Segreteria preme fisicamente il pulsante "Invia Fattura" in corrispondenza di un pagamento saldato. Se il pulsante non viene premuto, il pagamento risulta registrato internamente ma non viene emessa alcuna fattura.

## 3. Anagrafica e Dati di Fatturazione
• Intestatario Predefinito: All'interno dell'Anagrafica dell'alunno è presente un campo obbligatorio denominato "Intestatario Fattura". La Segreteria seleziona a quale dei due genitori (o tutori legali) dovranno essere intestate di default le fatture fiscali.
• Recupero Dati Automatico: Al momento dell'emissione, il sistema interroga l'anagrafica del Genitore Intestatario e compila automaticamente il tracciato XML con tutti i dati richiesti da Aruba per la validazione (es. Nome, Cognome, Indirizzo di Residenza completo, Codice Fiscale, Codice Destinatario/PEC).

## 4. Regole Fiscali e Numerazione
• Numerazione Sequenziale: Kidville delega completamente la gestione del progressivo numerico (es. Fattura n. 1, 2, 3...) al sistema Aruba, evitando conflitti di numerazione e garantendo l'allineamento fiscale sul cassetto fiscale della scuola.
• Regime IVA e Natura: Tutte le fatture emesse tramite questo flusso applicano automaticamente l'esenzione IVA per i servizi scolastici, utilizzando l'impostazione fissa: 0% di IVA, Natura N4 (Esente Articolo 10).
• Esclusione Marca da Bollo: Il sistema è configurato per non applicare in automatico alcuna riga relativa all'addebito della marca da bollo, lasciando l'importo della prestazione pulito.

## 5. Gestione Errori e Interfaccia Genitore
• Monitoraggio Scarti SDI: Se la fattura inviata ad Aruba viene successivamente scartata dal Sistema di Interscambio (SDI) dell'Agenzia delle Entrate (ad esempio per un Codice Fiscale errato nell'anagrafica del genitore), il backend di Kidville intercetta lo stato e invia una notifica di errore in tempo reale alla dashboard della Segreteria, specificando il motivo dello scarto per permettere una rapida correzione.
• Download Self-Service per le Famiglie: Una volta che la fattura è stata emessa con successo, l'interfaccia dell'App Genitore si aggiorna in automatico. In corrispondenza della voce di pagamento saldata (es. "Retta di Marzo"), comparirà un'icona di download che permette al genitore di scaricare sul proprio dispositivo la copia di cortesia in formato PDF generata da Aruba.

---

# PRD - Kidville App: Modulo Impostazioni (Pannello di Controllo Globale)

## 1. Obiettivo del Modulo
Il modulo Impostazioni (lib/features/admin/ e lib/core/) rappresenta la cabina di regia del SaaS
Kidville. Accessibile esclusivamente con privilegi di Direzione/Segreteria (Super-Admin), permette
di plasmare dinamicamente ogni singola funzionalità descritta nei moduli precedenti. Questo
garantisce che la piattaforma sia scalabile e totalmente personalizzabile per ogni singola sede
(Tenant) senza richiedere l'intervento degli sviluppatori.

## 2. Configurazione Globale, Sedi e Ruoli (Anagrafica)
• Gestione Multi-Sede (Tenant): Possibilità di aggiungere, rinominare o disattivare le sedi fisiche della scuola. Ogni sede ha la propria configurazione isolata. **✅ (P3.4b, DL-033)** creata la tabella registry `scuole` (migr. `20260750`, la sede era un `scuola_id` hardcoded; seed della sede esistente); `GET/POST/PATCH /api/admin/schools` **gated alla Direzione** (`requireStaff(['admin','coordinator'])`) per **aggiungi / rinomina / disattiva** (soft `attiva=false`) + `config` jsonb isolata + audit `logScrittura('multi_sede')`; UI `/admin/schools` (`SchoolsPanel`). *(Nessuna FK su `scuola_id` in questa slice: resta soft-reference; hard-delete sede fuori scope.)*
• Gradi d'Istruzione e Classi: Creazione e gestione dei gradi (Nido, Infanzia, Primaria) e delle relative sezioni/classi.
• Gestione Staff (RBAC): Pannello per l'onboarding del personale. La Segreteria può creare account assegnando ruoli rigidi (Docente, Segreteria, Cuoca, Direzione) e associare i docenti alle rispettive classi. **✅ (P3.4a, DL-028)** pannello `/admin/staff` per gestire ruolo/sede/classi del personale esistente (`GET/PATCH /api/admin/staff`), **gate riservato alla Direzione** (admin/coordinator) + self-lockout guard + audit; ruoli assegnabili Docente/Segreteria/Cuoca/Direzione/Amministratore (no genitore). *(Onboarding nuovi account con provisioning auth: resta il flusso invito/credenziali DL-005.)* 🔄 **(2026-07-13, DL-053)** la **tab Staff dell'anagrafica** legge ora da `utenti` (workaround `citizenship` **dismesso in lettura**) con **lettura estesa alla Segreteria**; scritture e «Rigenera credenziali» restano Direzione (**403** server come backstop); nuova scheda `StaffDetailPanel` (dati + classi assegnate) + **export CSV** dedicato.

## 3. Configurazione Moduli Didattici (Diario e Registro)
### 3.1 Diario 0-6 (Nido e Infanzia)
• Customizzazione Routine: La Segreteria può abilitare o disabilitare specifici widget di routine (es. "Bagno", "Nanna") a livello di singola classe (es. togliendo il modulo "Nanna" per le classi dell'Infanzia).

### 3.2 Diario Scuola Primaria
• Materie Master e Orario: Pannello per la gestione delle discipline (incl. Educazione Civica e Mensa-turno), delle campanelle e del palinsesto settimanale (modelli tempo scuola 27/29/40 ore), che si riflette automaticamente nei registri degli insegnanti (vedi Modulo Primaria §6).
• Sistema di Valutazione (motore ibrido per grado): Configurazione del modello di valutazione per grado/sezione. Per la **Primaria** è forzato il modello conforme **O.M. 3/2025** (giudizi per obiettivi in itinere + 6 giudizi sintetici allo scrutinio, voti numerici disabilitati); per eventuali gradi non-primaria è abilitabile il modello a voti numerici. Vedi Modulo Primaria §4.
• Declinazioni Locali (PTOF): Importazione delle declinazioni dei descrittori dei giudizi sintetici deliberate dagli organi collegiali, che integrano/sostituiscono i testi standard dell'Allegato A in pagella.
• Obiettivi di Apprendimento: Gestione del curricolo d'istituto (obiettivi per disciplina e classe) da rendere disponibili ai docenti per la valutazione in itinere.

## 4. Configurazione Armadietto e Mensa
• Inventario Armadietto: Gestione della "Lista Default" dei materiali (es. Pannolini, Salviette, Cambi). La Segreteria può aggiungere nuove voci personalizzate che appariranno poi nei menu a tendina degli insegnanti.
• Setup Cucina e Mensa:
  • Orario Cut-off: Impostazione dell'orario limite (es. 09:30) per la chiusura delle presenze e delle diete in bianco ai fini del calcolo dei pasti.
  • Menu Builder: Accesso allo strumento di creazione dei menu ciclici e associazione obbligatoria degli allergeni ai piatti.
  • Calendario Chiusure: Impostazione dei giorni festivi e di chiusura scolastica in cui il sistema disabilita in automatico scalo ticket e appello.

## 5. Configurazione Flussi Amministrativi e Finanziari
### 5.1 Pagamenti e Ticket
• Rette Default: Impostazione dell'importo standard della retta mensile e della data di scadenza globale (modificabile poi singolarmente dall'anagrafica del singolo alunno).
• Ticket Mensa: Configurazione del costo del singolo Ticket Pasto e dei "Pacchetti" acquistabili (es. pacchetto da 10 o 20 pasti) che la Segreteria utilizzerà per ricaricare i conti degli alunni.
• Gestione Insoluti: Impostazione della tolleranza (numero di giorni di ritardo) prima che un pagamento venga contrassegnato in rosso come "Insoluto".

### 5.2 Modulistica e Form Builder
• Accesso al motore di creazione template (Form Builder). Da qui la Segreteria genera i modelli per uscite didattiche e consensi privacy, impostando i campi dinamici richiesti ai genitori.

### 5.3 Fatturazione Elettronica (Integrazione Aruba)
• Credenziali API: Sezione sicura per l'inserimento e l'aggiornamento delle chiavi API di Aruba. **✅ (P3.1)** username in `admin_settings.aruba_config`; la **password non è mai salvata in chiaro** — si memorizza solo un riferimento (`password_ref`) risolto lato server da env/vault. Ambiente DEMO/PROD selezionabile.
• Dati Scuola: Inserimento dei dati di fatturazione dell'istituto (Partita IVA, Codice Fiscale, PEC, sede strutturata indirizzo/CAP/comune/provincia) necessari per la corretta generazione del tracciato XML. **✅ (P3.1)** consumati dal `CedentePrestatore`.
• Regime IVA: Pannello per mappare le causali di default (es. Retta = Esente IVA Art. 10). **✅ (P3.1)** campo `RegimeFiscale` (default RF01) nei dati fiscali; le fatture applicano comunque IVA 0%/Natura N4 fissa (DL-018).

---

# PRD - Kidville App: Modulo Fascicolo Personale dell'Alunno

## 1. Obiettivo del Modulo
Il Fascicolo Personale è l'archivio documentale e storico dello studente. Contiene dati amministrativi
comuni e **dati particolari (sensibili)** — stato di salute, documenti di inclusione — e deve quindi
sottostare a tutele rigorose di accesso e tracciamento, in conformità al GDPR (Reg. UE 2016/679).
Estende l'anagrafica esistente (oggi limitata a note mediche, flag BES/DSA e delegati).

## 2. Composizione del Fascicolo
### 2.1 Sezione Amministrativa
• Anagrafica studente e genitori/tutori (con **codice fiscale validato**).
• Recapiti telefonici ed e-mail per emergenze.
• **Deleghe al prelievo** all'uscita, con allegato il documento d'identità dei delegati (riusa `delegati`).
• Storico iscrizioni, **pagelle degli anni precedenti** e **certificati delle competenze**.

### 2.2 Sezione Consensi e Privacy
• Modulo di consenso al trattamento dati e informativa privacy firmata.
• **Consenso specifico** per riprese foto/video durante attività didattiche e uscite (collegato al
  Privacy Lock della Galleria).
• Consenso al **trasferimento del fascicolo** informatico ad altra scuola in caso di mobilità.

### 2.3 Sezione Riservata — Documenti di Inclusione (PEI/PDP)
• Diagnosi funzionali, certificazioni ASL e relazioni (L. 104/1992).
• **PEI** redatto dal GLO; **PDP** e certificazioni DSA (L. 170/2010).

## 3. Protezione e Controllo Accessi
> [!IMPORTANT]
> **Livello di protezione adottato (decisione di prodotto): RBAC ristretto + audit accessi.**
> La cifratura dei file è demandata allo storage gestito (Supabase Storage). Una crittografia
> applicativa dedicata (AES-256 a livello di tabella/file) **non** è prevista in questa fase e potrà
> essere introdotta successivamente se richiesto dal titolare del trattamento.

• **RBAC ristretto:** l'accesso (visualizzazione/modifica) a PEI/PDP e documenti sanitari è limitato ai
  **docenti contitolari della classe di riferimento**, al **Dirigente** e al personale di **segreteria
  espressamente autorizzato**. Vietato l'accesso a docenti di altre classi o utenti non profilati.
• **Audit log accessi:** ogni consultazione/modifica di un documento sensibile genera un log
  **immodificabile** (chi, quando, quale documento, finalità) — estensione di `registro_modifiche`.
• **Segregazione logica:** i documenti sensibili sono archiviati separatamente dalla documentazione
  amministrativa, con bucket/percorsi dedicati e ACL distinte.
• **Workflow firma GLO:** il PEI è atto che richiede la sottoscrizione di docenti contitolari,
  specialisti ASL e genitori. Area di collaborazione protetta dove i membri del GLO visualizzano la
  bozza, annotano e appongono la firma per accettazione (firma applicativa in linea con il livello
  "Base" del documento; firma qualificata rimandata, cfr. §9.2 modulo Primaria).

---

# PRD - Kidville App: Modulo Interoperabilità SIDI / Piattaforma Unica

## 1. Obiettivo del Modulo
Garantire l'interoperabilità bidirezionale con il **SIDI** (Sistema Informativo dell'Istruzione) e con
la **Piattaforma Unica** del Ministero, per l'efficienza amministrativa della segreteria e gli
adempimenti di legge. Il registro non opera come sistema isolato.

## 2. Importazione Nuovi Iscritti (Flusso SIDI)
• **Ricezione file ZIP ministeriale:** upload diretto del file `.zip` generato dal SIDI (dati nuovi
  iscritti e famiglie), **senza** che l'operatore debba rinominarlo o modificarlo.
• **Matching su Numero di domanda:** l'associazione/deduplica avviene confrontando il **Numero di
  domanda di iscrizione SIDI** contenuto nel flusso, evitando anagrafiche duplicate e garantendo il
  corretto aggancio dei documenti del fascicolo.
• **Sincronizzazione dati genitori:** sovrascrittura/integrazione dei contatti già presenti, usando il
  **codice fiscale** come chiave primaria di associazione.

## 3. Allineamento Strutturale e Invio Frequentanti
• **Fase A — Struttura di base:** ricezione dal SIDI di sedi, sezioni, classi e tempo scuola per
  allineare il database locale. Le modifiche strutturali lato SIDI vanno recepite **prima** dell'invio
  dei dati alunni.
• **Invio flusso di frequenza:** trasmissione telematica degli alunni effettivamente frequentanti per
  classe. La corretta trasmissione è prerequisito per l'accesso di docenti/famiglie ai servizi della
  Piattaforma Unica.

## 4. Flusso Genitori-Alunni (Piattaforma Unica)
• Flusso periodico (mensile/annuale) di **associazione Genitori-Alunni** trasmesso in cooperazione
  applicativa al SIDI, con le relazioni parentali validate dalla segreteria, così che solo i soggetti
  legalmente responsabili accedano ai dati riservati sulla piattaforma ministeriale.

## 5. Export Certificati delle Competenze (Classe Quinta)
• Generazione e trasmissione al SIDI della **scheda dei certificati delle competenze** di fine classe
  quinta, compilata in sede di scrutinio finale, secondo il **D.M. n. 14 del 30/1/2024**.

> [!NOTE]
> L'attivazione dei flussi SIDI in cooperazione applicativa richiede l'**accreditamento ministeriale**
> del software e le relative credenziali/canali. Le tempistiche (avvio anno scolastico, generalmente
> entro fine ottobre) vincolano la sequenza Fase A → frequentanti → servizi Piattaforma Unica.
>
> **Pianificazione (DL-004, 2026-06-25):** modulo incluso nel master plan come **Fase P5 (finale)**,
> dopo i moduli core. Oggi ~2/12 requisiti implementati.
>
> **Implementato (Fase P5, 2026-06-27, DL-047..050):** ✅ **§2** import `.zip` (parser jszip pluggable) + matching su **Numero domanda** (campo `alunni.numero_domanda_sidi`) + sync genitori per CF (DL-048); ✅ **§3** builder Fase A (sezioni+tempo scuola) + frequentanti (alunni iscritti per classe), con indicatore stato `Fase A → frequentanti → Piattaforma Unica` e guardie di sequenza (DL-049); ✅ **§4** builder associazioni Genitori-Alunni sui **legami validati dalla Segreteria** (DL-049); ✅ **§5** **Certificato delle Competenze** classe quinta (D.M. 14/2024) generato dallo scrutinio finale, PDF + firma FEA + download genitore (DL-047). 🔶 **La trasmissione telematica reale resta GATED** (`sidiTransmit` → 503) finché non si ottiene l'**accreditamento ministeriale** del software (credenziali/canali di cooperazione applicativa) — dipendenza esterna, come la verifica live Aruba/SDI. I serializer del tracciato XML sono **adapter sostituibili** al tracciato ufficiale.

---

# PRD - Kidville App: Accessibilità, Sicurezza e Compliance (Trasversale)

## 1. Obiettivo
Requisiti trasversali a tutti i moduli per garantire conformità ad AgID, MIM e Garante Privacy. Il
mancato rispetto può comportare l'esclusione dal mercato scolastico o sanzioni.

## 2. Accessibilità (Legge Stanca)
• Conformità a **L. 9/1/2004 n. 4 (Legge Stanca)** e s.m.i., **D.Lgs. 106/2018** e **Linee Guida AgID**
  sull'accessibilità (aggiornamento 29/5/2023), con riferimento WCAG.
• Interfaccia ad **alto contrasto** e compatibilità con i principali **screen reader**.
• L'accessibilità è criterio di accettazione per il frontend di tutti i moduli (parent, teacher, admin).
• **✅ Baseline P1 (DL-008):** toggle **alto contrasto globale** persistito su cookie SSR-safe (`<html data-contrast>`, applicato a tutta l'app senza FOUC), set token CSS HC + **focus-ring** visibile + `prefers-reduced-motion`; primitive **Modal accessibile** (`role="dialog"`/`aria-modal`/focus-trap/Escape/restore focus); **landmark** `nav`/`main` + **skip-link** + `aria-current` sulla navigazione; **smoke test `jest-axe`** su login/modale OTP/nav. **WCAG-AA = definition-of-done** dei nuovi frontend; l'audit AA per-pagina dei moduli esistenti è applicato **incrementalmente** nelle fasi successive (non un audit big-bang in P1).

## 3. Privacy e Adempimenti
• **Pubblicazione informative privacy** destinate ad alunni, genitori, docenti e personale ATA, sempre
  disponibili in una sezione dedicata.
• **Raccolta e tracciamento del consenso** per trattamenti che eccedono le attività istituzionali (es.
  pubblicazione foto/video su canali della scuola), con archiviazione sicura del consenso digitale.
• Per alunni con disabilità, BES o DSA, la raccolta del consenso per la trasmissione dati
  all'Anagrafe Nazionale degli Studenti è documentata e, ove necessario, con copia firmata.

## 4. Audit e Tracciabilità
• **Audit log immodificabile** degli accessi a dati e documenti sensibili (chi, quando, finalità),
  in conformità ai requisiti del Garante per le PA — estensione di `registro_modifiche` e
  `firme_documenti` esistenti.
• **RLS in produzione (DL-003, Fase P0):** attivazione effettiva della **Row Level Security** (oggi
  bypassata via `service_role`). Letture lato genitore via `createSessionClient()` (isolamento per
  figlio/sede, identità `parents.auth_user_id = auth.uid()`); scritture staff via `service_role` con
  **audit obbligatorio** (`audit_scritture_docente`). **Roll-out per famiglia-tabella** (alunni →
  presenze → eventi_diario → galleria → valutazioni/note → pagamenti → comunicazione), con
  `get_advisors(security)` a **zero ERROR** come gate tra una famiglia e l'altra; rimozione delle
  policy dev `TO anon`. Nota: lo **staff è già auth-backed** (`utenti.id` FK → `auth.users`, quindi
  `utenti.id = auth.uid()`); le policy staff esistenti restano valide.

## 5. Autenticazione e Accesso (DL-002, Fase P0)
• **Login reale invite-only** su Supabase Auth: pagina `/auth/login` (email+password), `src/middleware.ts`
  di protezione route con redirect anonimo → login, identità risolta **server-side dalla sessione**
  (`resolveIdentity()`: `auth.getUser()` → id app), non più via `?userId=`/header o fallback `DEV_*`.
• **Transizione incrementale (shim):** i gate preferiscono la sessione; l'header `x-user-id` è **ignorato
  se ≠ sessione** (anti-spoofing) e tollerato solo dietro flag `ALLOW_HEADER_IDENTITY` finché i ~104
  punti client non sono ripuliti. Nessun big-bang.
• **Cloud Auth rigida:** **nessuna auto-registrazione** dei genitori; il legame `parent_id ↔ student_id`
  è creato **esclusivamente dalla Segreteria**. Identità unificata: **staff già auth-backed**
  (`utenti.id` FK → `auth.users`); **genitori** autoritativi su `parents`+`student_parents`, resi
  auth-backed via colonna **`parents.auth_user_id`** (la PK `parents.id` non viene ripuntata perché
  referenziata da `student_parents`). `legame_genitori_alunni` resta come compat (record demo).
• **Recupero credenziali:** Segreteria-managed con invio automatico email (DL-005), nessun self-service.

---

# Appendice — Checklist Controlli Richiesti per Ruolo e Pagina

> [!NOTE]
> Questa appendice è la **spec OBIETTIVO**: elenca per ogni ruolo e pagina i pulsanti, le azioni, i badge e gli elementi UI chiave che la pagina **deve** avere, per consentire un confronto (diff visivo) col design implementato. I controlli previsti restano in lista anche se non ancora presenti nel codice. Consolidata da PRD + ROADMAP_TECNICA + prompts/ + codice applicativo.


## Genitore

### `/parent` — Home / Dashboard Genitore
_Modulo PRD: Trasversale + Mobile UI_

**Checklist controlli richiesti:**
- Selettore 'Seleziona figlio' (switch tra figli)
- Indicatore 'Figlio attivo' (avatar iniziali + nome + classe)
- Indicatore stato presenza 'A scuola'
- Widget 'Riepilogo presenze'
- Widget 'Avvisi non letti' (badge contatore)
- Widget 'Pagamenti in scadenza' (riepilogo)
- Indicatore 'Tutto in regola' (pagamenti saldati)
- Azione 'Vai a Pagamenti' (widget riepilogo cliccabile)
- Lista 'Accessi rapidi ai moduli' (griglia tile)
- Pulsante tile 'Pagamenti'
- Pulsante tile 'Mensa'
- Pulsante tile 'Avvisi'
- Pulsante tile 'Chat'
- Pulsante tile 'Diario' (infanzia/nido)
- Pulsante tile 'Galleria'
- Pulsante tile 'Moduli'
- Pulsante tile 'Registro' (primaria)
- Pulsante tile 'Lezioni' (primaria)
- Pulsante tile 'Compiti' (primaria)
- Pulsante tile 'Armadietto' (infanzia)
- Pulsante tile 'Presenze' (infanzia)
- Indicatore 'Saluto orario' (Buongiorno/pomeriggio/sera)
- Tab navigazione 'Home'
- Tab navigazione 'Avvisi'
- Tab navigazione 'Chat'
- Tab navigazione 'Scuola/Diario' (per grado)
- Pulsante 'Altro' (apre sheet sezioni)
- Pulsante 'Chiudi' sheet sezioni
- Lista 'Tutte le sezioni' (sheet Altro)

### `/parent/attendance` — Presenze & Assenze
_Modulo PRD: Presenze §3_

**Checklist controlli richiesti:**
- Selettore figlio (alunno)
- Campo 'Motivo dell'assenza' (opzionale)
- Selettore date assenza (da / a)
- Selettore tipologia (Assenza / Ritardo / Uscita anticipata)
- Pulsante 'Comunica Assenza'
- Banner 'Avviso Inviato' (conferma)
- Pulsante 'Torna Indietro'
- Pulsante 'Carica certificato medico'
- Indicatore stato validazione certificato (in attesa / approvato)
- Pulsante 'Giustifica' evento (assenza/ritardo/uscita)
- Campo PIN dispositivo (giustificazione)
- Campo 'Motivazione giustifica'
- Lista eventi da giustificare
- Lista storico giustificazioni
- Banner Panic Alert ricevuto (ritiro non autorizzato)

### `/parent/primaria/assenze` — Libretto Web / Giustificazioni
_Modulo PRD: Presenze §3.1_

**Checklist controlli richiesti:**
- Lista eventi presenza (assenza/ritardo/uscita anticipata)
- Badge stato 'Assente'
- Badge stato 'Ritardo'
- Badge stato 'Uscita anticipata'
- Badge '✓ Giustificata'
- Badge 'Da giustificare'
- Banner 'N assenze non ancora giustificate'
- Indicatore orario entrata (ritardo)
- Indicatore orario uscita (uscita anticipata)
- Indicatore testo motivazione giustifica
- Indicatore 'Nota docente'
- Pulsante 'Giustifica' su evento da giustificare
- Campo PIN dispositivo per confermare la giustifica
- Campo motivazione giustifica
- Pulsante 'Invia codice OTP' (firma FES via email)
- Campo inserimento codice OTP
- Pulsante 'Conferma giustifica'
- Pulsante 'Comunica assenza in anticipo'
- Selettore data assenza preventiva
- Azione upload certificato medico di riammissione
- Indicatore 'Presa visione' della giustifica
- Indicatore firma FES (autore/timestamp giustifica)
- Banner errore 'Giustifica non più possibile oltre N giorni'

### `/parent/avvisi` — Bacheca Avvisi / Circolari
_Modulo PRD: Comunicazione §3_

**Checklist controlli richiesti:**
- Lista Avvisi/Circolari (card cliccabili)
- Azione Apri/espandi avviso (registra presa visione automatica)
- Pulsante 'Sì, aderisco'
- Pulsante 'No'
- Pulsante 'Allegato File' (apre PDF/documento circolare)
- Pulsante 'Link Esterno'
- Badge 'Nuovo' (avviso non ancora letto)
- Indicatore stato risposta 'Hai aderito ✓' / 'Hai declinato'
- Banner Scadenza / 'Scaduto il' avviso
- Badge Tipo avviso (📢 presa visione / 📋 adesione)
- Indicatore Mittente e tempo pubblicazione
- Indicatore Classe/destinatario avviso
- Selettore/Indicatore Studente attivo (avatar + classe)
- Banner stato vuoto 'Nessun avviso'

### `/parent/chat` — Chat con Insegnante
_Modulo PRD: Comunicazione §2_

**Checklist controlli richiesti:**
- Pulsante 'Nuova Chat'
- Lista Thread insegnanti
- Campo Scrivi messaggio
- Pulsante 'Invia messaggio'
- Pulsante 'Allega file'
- Azione Invio nota vocale
- Indicatore Traduzione automatica messaggio
- Toggle Mostra originale/Traduzione
- Badge Messaggi non letti (contatore intestazione)
- Badge Non letti per thread
- Separatore 'Nuovi Messaggi'
- Indicatore Conferma di lettura (doppia spunta)
- Anteprima Allegato immagine
- Anteprima Allegato documento
- Banner Orario risposta docenti (fuori orario)
- Selettore Insegnante nel modal Nuova Chat
- Indicatore Insegnante e classe/sezione
- Pulsante 'Indietro' (vista mobile chat)
- Azione Rimuovi allegato dalla composizione

### `/parent/compiti` — Bacheca Compiti
_Modulo PRD: Primaria §3_

**Checklist controlli richiesti:**
- Lista 'Compiti' raggruppata per giorno
- Indicatore materia del compito
- Campo testo compiti assegnati
- Indicatore 'Consegna' (data scadenza compito)
- Indicatore 'Compiti' attività individualizzata (sostegno)
- Banner 'Nessun compito assegnato di recente'
- Azione 'Apri allegato' del compito (foto/scheda/PDF)
- Filtro per materia
- Filtro per data
- Banner 'Visibile anche se assente' (diritto al recupero)
- Indicatore 'Sezione disponibile solo per la primaria'
- Pulsante 'Vai al Diario'

### `/parent/diary` — Diario 0-6 (Timeline)
_Modulo PRD: Diario 0-6 §4_

**Checklist controlli richiesti:**
- Lista 'Timeline cronologica eventi della giornata'
- Indicatore 'Orario evento' su ogni card
- Card evento 'Entrata' (sola lettura)
- Card evento 'Attivita' (sola lettura)
- Card evento 'Merenda' (sola lettura)
- Card evento 'Pranzo' (sola lettura)
- Card evento 'Nanna' (sola lettura)
- Card evento 'Bagno/Igiene' (sola lettura)
- Indicatore 'Nota libera maestra' su card evento
- Pulsante 'Giorno precedente' (navigazione data)
- Pulsante 'Giorno successivo' (navigazione data, disabilitato su Oggi)
- Indicatore 'Etichetta giorno' (Oggi/Ieri/data)
- Sezione 'Le foto di oggi' (accordion collassabile)
- Lista 'Griglia foto taggate del giorno'
- Pulsante 'Scarica' foto
- Pulsante 'Condividi' foto
- Azione 'Apri foto a schermo intero' (lightbox)
- Pulsante 'Foto precedente/successiva' nel lightbox
- Badge 'Generale' su foto broadcast
- Banner 'Visibilita 14 giorni / contatta segreteria'
- Indicatore 'Chip nome bambino + sezione'
- Indicatore 'Stato vuoto - nessuna voce diario'
- Selettore 'Cambio bambino / avatar' (multi-figlio)
- Indicatore 'Traduzione multilingua delle routine'

### `/parent/forms/[id]` — Compilazione Form (Wizard)
_Modulo PRD: Form §4.2_

**Checklist controlli richiesti:**
- Indicatore barra di avanzamento wizard
- Indicatore 'Passo X di N'
- Indicatore titolo/descrizione pagina (step)
- Pulsante 'Indietro'
- Pulsante 'Avanti'
- Pulsante 'Invia' (ultimo step, senza firma)
- Pulsante 'Firma il modulo' (ultimo step, con firma)
- Indicatore stato 'Invio…' (caricamento submit)
- Campo testo/numero/email/telefono dinamico
- Campo data
- Campo area di testo (textarea)
- Selettore a tendina (select)
- Selettore a scelta singola (radio)
- Campo consenso a scelta multipla (checkbox)
- Pulsante 'Seleziona un file (PDF, JPG…)' upload allegato
- Indicatore caricamento allegato (spinner/'Caricamento…')
- Badge allegato caricato (icona FileCheck2 + nome file)
- Banner 'Allegato caricato' con percorso file
- Banner errore caricamento allegato
- Banner informativo firma OTP richiesta
- Indicatore campo obbligatorio (asterisco)
- Banner errore validazione campo
- Modale firma elettronica OTP/FEA
- Campo codice OTP a 6 cifre
- Indicatore 'Codice inviato a <email>'
- Pulsante 'Firma e completa' (verifica OTP)
- Pulsante 'Reinvia codice OTP'
- Pulsante chiudi modale firma (X)
- Banner errore verifica OTP
- Indicatore 'Modulo firmato!' (firma OTP riuscita)
- Indicatore 'Modulo inviato!' (conferma invio)
- Pulsante 'Torna ai moduli'
- Firma congiunta secondo firmatario (entrambi i genitori)
- Indicatore campo a visibilità/obbligatorietà condizionale

### `/parent/gallery` — Galleria Foto/Video
_Modulo PRD: Foto e Video §3_

**Checklist controlli richiesti:**
- Lista Feed media taggati del proprio figlio
- Pulsante 'Scarica' (download su card)
- Pulsante 'Scarica' (download in lightbox)
- Pulsante 'Condividi' (condivisione nativa su card)
- Pulsante 'Condividi' (condivisione nativa in lightbox)
- Azione Apri media a schermo intero (lightbox)
- Pulsante Navigazione 'Precedente' (lightbox)
- Pulsante Navigazione 'Successiva' (lightbox)
- Pulsante 'Chiudi' lightbox
- Icona Play video
- Pulsante 'Carica Altre Foto' (paginazione)
- Badge 'Generale' (media broadcast)
- Indicatore Conteggio foto disponibili
- Indicatore Caption + autore/uploader del media
- Banner 'Solo foto in cui tuo figlio è taggato'
- Indicatore Avatar/nome del proprio figlio (selezione profilo)
- Banner Stato vuoto 'Nessuna foto disponibile'

### `/parent/lezioni` — Orario Lezioni
_Modulo PRD: Primaria §2.2 / §6.4_

**Checklist controlli richiesti:**
- Indicatore griglia orario settimanale (matrice giorni x ore)
- Lista materie previste per il figlio
- Indicatore campanelle / fasce orarie (ora inizio-fine)
- Selettore giorno della settimana (Lun-Sab)
- Badge blocco 'Mensa'
- Badge blocco 'Intervallo'
- Indicatore docente per ora/materia
- Indicatore modello tempo scuola (27/29/40 ore)
- Lista lezioni recenti raggruppate per giorno
- Indicatore materia + argomento svolto per lezione
- Banner attività individualizzata (sostegno) per la lezione
- Icona allegato lezione (PDF / immagine) apribile
- Pulsante 'Aggiorna' (ricarica dati)
- Indicatore figlio selezionato (nome e cognome)
- Banner 'Sezione non disponibile' per non-primaria con link al Diario
- Banner stato vuoto 'Nessuna lezione registrata di recente'

### `/parent/locker` — Armadietto (Lista della Spesa)
_Modulo PRD: Armadietto §4_

**Checklist controlli richiesti:**
- Lista 'Situazione Materiale' (scorte residue per materiale)
- Indicatore semaforo scorte Verde/Giallo/Rosso
- Indicatore quantità residua numerica per materiale
- Lista 'Da portare a scuola' (materiali richiesti dall'insegnante)
- Badge contatore richieste pendenti
- Pulsante 'Preso in carico'
- Pulsante 'Lo porto domani' (acknowledgment alternativo)
- Indicatore stato 'Preso in carico' (richieste acknowledged)
- Banner notifica richiesta materiale (avviso immediato)
- Banner reminder automatico ore 07:00
- Selettore profilo figlio (isolamento multi-figlio)
- Indicatore nome figlio corrente
- Tab 'Panoramica'
- Tab 'Andamento Mensile'
- Pulsante mese precedente (andamento mensile)
- Pulsante mese successivo (andamento mensile)
- Toggle 'Storico richieste'
- Pulsante 'Aggiorna' (refresh manuale)
- Badge 'LIVE' (aggiornamento realtime)
- Indicatore 'Aggiornato alle' (ultimo refresh)
- Toast conferma salvataggio acknowledgment

### `/parent/mensa` — Menu & Mensa
_Modulo PRD: Mensa §3-§4_

**Checklist controlli richiesti:**
- Indicatore 'Saldo ticket' (pill verde con icona Ticket)
- Badge nome menu ciclico (es. 'Menu Primavera')
- Pulsante 'Aggiorna saldo' (refresh)
- Pulsante 'Settimana precedente' (chevron sinistra)
- Pulsante 'Settimana successiva' (chevron destra)
- Indicatore 'Intervallo settimana' (range date)
- Lista 'Calendario menu settimanale' (giorni con portate)
- Pulsante 'Prenota pranzo'
- Pulsante 'Disdici' (annulla prenotazione)
- Badge 'Prenotato' (giorno confermato, stile emerald)
- Icona 'Allerta allergeni del piatto' (semaforo rosso per pasto pericoloso al bambino)
- Badge 'Allergene presente' (etichetta allergene del giorno)
- Banner 'Reminder ticket in esaurimento / saldo esaurito'
- Indicatore 'Menu non ancora pubblicato'
- Indicatore 'Mensa chiusa' (giorno di chiusura/festività)
- Indicatore 'Inserito dalla segreteria' (origine prenotazione)
- Badge 'Prenotato' bloccato (giorno passato, icona Lock)
- Banner 'Sessione non valida' (errore auth)

### `/parent/modulistica` — Modulistica & Certificati
_Modulo PRD: Form + Presenze §3_

**Checklist controlli richiesti:**
- Tab 'Da Compilare'
- Tab 'Archivio Firmati'
- Tab 'Certificati Self-Service'
- Tab 'Certificati Medici'
- Lista moduli da compilare
- Badge 'Autorizzazione'
- Badge 'Sondaggio'
- Badge 'Gradimento'
- Badge figlio destinatario modulo
- Badge scadenza modulo 'Scade il'
- Pulsante 'Compila' (sondaggio/gradimento)
- Pulsante 'Compila e Firma' (autorizzazione)
- Campo dinamico testo/data/textarea
- Selettore radio risposta a opzioni
- Campo checkbox consenso GDPR
- Selettore rating 1-5
- Indicatore campo obbligatorio asterisco
- Banner FES 'Firma Elettronica Semplice'
- Indicatore 'Verifica via email'
- Pulsante 'Invia Risposte' (invio diretto)
- Pulsante 'Invia e Firma Ricevuta' (autorizzazione)
- Pulsante 'Annulla' compilazione
- Campo OTP a 6 cifre (modale firma)
- Pulsante 'Firma e completa' (modale OTP)
- Banner conferma 'Modulo firmato!'
- Lista archivio moduli firmati
- Badge 'Ricevuta FES Protetta'
- Pulsante 'Ricevuta PDF' (download)
- Pulsante 'Scarica PDF' Certificato Frequenza
- Pulsante 'Scarica PDF' Certificato Iscrizione
- Selettore 'Seleziona Figlio' (certificato medico)
- Pulsante 'Carica Certificato' (upload file)
- Campo 'Note di accompagnamento'
- Pulsante 'Invia Certificato Medico'
- Lista 'Ricevute Caricamenti Medici Recenti'
- Badge 'Giustificato' giorni coperti
- Badge 'In attesa di abbinamento assenza'
- Banner 'Non hai moduli da compilare'
- Wizard step-by-step (una sezione per persona)
- Indicatore firma congiunta entrambi i genitori
- Banner scadenza bloccante modulo

### `/parent/pagamenti` — Pagamenti & Fatture
_Modulo PRD: Pagamenti §4 + Aruba §5_

**Checklist controlli richiesti:**
- Lista pagamenti da pagare
- Lista storico pagamenti effettuati
- Indicatore importo voce (€)
- Indicatore importo residuo (resta €)
- Badge stato 'Pagato'
- Badge stato 'Scaduto' in rosso
- Badge stato 'Da pagare'
- Badge stato 'Parziale'
- Indicatore voce obbligatoria (•obbl.)
- Indicatore quota split 'tua quota'
- Icona download fattura PDF su voce saldata
- Indicatore fattura non disponibile su voce pagata
- Toggle 'Attiva promemoria pagamenti' (push opt-in)
- Badge 'Promemoria attivi'
- Indicatore alunno (nome/cognome) per voce
- Indicatore data scadenza voce
- Icona categoria voce (Rette/Mensa/Gite...)
- Filtro/Tab categorie (Rette/Quote/Mensa/Gite)
- Indicatore totale da pagare (riepilogo home)

### `/parent/primaria` — Hub Primaria Genitore
_Modulo PRD: Primaria (navigazione)_

**Checklist controlli richiesti:**
- Pulsante 'Lezioni' (Argomenti e compiti)
- Pulsante 'Valutazioni' (Giudizi e medie per materia)
- Pulsante 'Note' (Note disciplinari e didattiche)
- Pulsante 'Presenze' (Assenze, ritardi e giustifiche)
- Pulsante 'Pagelle' (Scarica e firma le pagelle)
- Pulsante 'Orario' (Orario settimanale e materie del figlio)
- Pulsante 'Compiti' (bacheca compiti dedicata)
- Indicatore 'Scuola Primaria' (titolo sezione con icona)
- Selettore figlio (per famiglie con più alunni primaria)

### `/parent/primaria/note` — Note Disciplinari (Presa Visione)
_Modulo PRD: Primaria §5_

**Checklist controlli richiesti:**
- Lista note del figlio
- Badge categoria 'Disciplinare' (rosso)
- Badge categoria 'Didattica' (blu)
- Badge categoria 'Compiti non svolti' (giallo/ambra)
- Pulsante 'Firma presa visione'
- Badge 'Firmata'
- Indicatore 'In attesa di firma'
- Banner 'N nota in attesa di firma'
- Campo testo della nota
- Indicatore data nota
- Indicatore stato firma in corso 'Firma…'
- Banner certificazione FES (IP/timestamp) presa visione
- Azione download ricevuta PDF della firma

### `/parent/primaria/pagelle` — Pagelle / Documento di Valutazione
_Modulo PRD: Primaria §9 + Fascicolo_

**Checklist controlli richiesti:**
- Lista pagelle per periodo (Intermedio/Finale)
- Campo 'Periodo' (es. Intermedio/Finale)
- Campo 'A.S. anno scolastico'
- Pulsante 'PDF' (download documento di valutazione)
- Lista giudizi sintetici per disciplina
- Indicatore giudizio sintetico Educazione Civica
- Indicatore 'Comportamento' (giudizio sintetico)
- Indicatore 'Giudizio globale'
- Toggle 'Dettaglio/Nascondi' giudizi
- Pulsante 'Firma' (avvia firma pagella OTP)
- Campo 'Codice OTP' (firma via email)
- Pulsante 'Conferma' (firma OTP)
- Pulsante 'Annulla' (firma OTP)
- Badge 'Firmata' (presa visione pagella)
- Banner esito firma (successo/errore)
- Indicatore 'Dev OTP code' (ambiente sviluppo)
- Banner 'Nessuna pagella disponibile' (stato vuoto)
- Lista pagelle anni precedenti (storico)
- ✅ Pulsante 'Scarica certificato delle competenze' _(P5/DL-047, card pagelle genitore + `/api/parent/competenze`)_
- Filtro 'Anno scolastico'

### `/parent/primaria/valutazioni` — Valutazioni / Andamento
_Modulo PRD: Primaria §4.5_

**Checklist controlli richiesti:**
- Lista Materie (prospetto valutazioni in itinere per disciplina)
- Azione 'Espandi/Comprimi materia' (accordion card materia)
- Filtro per materia
- Badge 'Giudizio sintetico' (es. Ottimo/Buono/Sufficiente)
- Campo 'Giudizio descrittivo' (testo della valutazione)
- Indicatore 'Tipo prova' (orale/scritto/pratica)
- Campo 'Argomento' della valutazione
- Indicatore 'Data valutazione'
- Indicatore 'Conteggio valutazioni per materia'
- Indicatore 'Media per materia'
- Banner 'Buffer visibilità 10 minuti' (ritardo pubblicazione valutazione)
- Banner 'Persistenza dati anche con account sospeso'
- Indicatore 'Stato vuoto' (Nessuna valutazione disponibile)

### `/parent/register` — Registro (vista Genitore) — ⛔ DEPRECATA
_Modulo PRD: Primaria (vista genitore)_

> [!WARNING]
> **Pagina DEPRECATA.** Sostituita dalle pagine genitore dedicate e conformi O.M. 3/2025:
> `/parent/primaria` (hub), `/parent/primaria/valutazioni`, `/parent/primaria/note`, `/parent/primaria/pagelle`, `/parent/primaria/assenze`, `/parent/compiti`, `/parent/lezioni`.
> La rotta legacy va **reindirizzata** a queste pagine (Blocco 3). I controlli sotto restano come snapshot storico; il target è distribuito nelle pagine canoniche elencate.

**Checklist controlli (legacy — snapshot storico, NON target):**
- Lista 'Valutazioni' (giudizi per materia)
- Indicatore giudizio sintetico/descrittivo per valutazione
- Indicatore materia/tipo prova per valutazione
- Indicatore argomento collegato alla valutazione
- Lista 'Compiti' (bacheca compiti per il genitore/alunno)
- Indicatore allegati multimediali dei compiti/argomenti
- Banner 'Recupero assenti' (compiti/argomenti visibili anche se assente)
- Lista 'Orario settimanale' (materie del figlio)
- Indicatore 'Andamento scolastico' (riepilogo andamento)
- Banner 'Note da firmare' (note in attesa di presa visione)
- Pulsante 'Firma' (presa visione nota disciplinare)
- Badge categoria nota (Disciplinare/Didattica/Compiti non svolti)
- Lista 'Pagelle' (documento di valutazione per periodo)
- Pulsante 'Firma e visualizza' (firma ricezione pagella)
- Campo 'Codice' OTP firma pagella
- Pulsante 'Conferma' codice firma pagella
- Pulsante 'Vedi a schermo' (giudizi pagella dopo firma)
- Pulsante 'Scarica PDF' pagella
- Lista 'Assenze da giustificare'
- Indicatore stato assenza (Assenza/Ritardo/Uscita anticipata)
- Badge 'presa visione / in attesa / da giustificare'
- Pulsante 'Giustifica' (avvia giustifica assenza)
- Campo 'Motivazione' giustifica assenza
- Campo 'Codice' OTP/PIN giustifica assenza
- Pulsante 'Conferma' codice giustifica
- Pulsante 'Comunica assenza in anticipo'
- Campo 'Data' assenza in anticipo
- Campo 'Motivo' assenza in anticipo
- Pulsante 'Invia' assenza in anticipo
- Campo upload certificato medico (riammissione)
- Pulsante 'Dichiara impreparato (a priori)'
- Selettore 'Materia' dichiarazione impreparato
- Campo 'Data' dichiarazione impreparato
- Campo 'Motivo' dichiarazione impreparato
- Pulsante 'Invia dichiarazione' impreparato
- Banner 'Diario 0-6' (redirect se figlio non in primaria)
- Indicatore 'Persistenza dati con account sospeso'

## Insegnante

### `/teacher` — Home / Dashboard Docente
_Modulo PRD: Diario §3.2 + Trasversale_

**Checklist controlli richiesti:**
- Banner Allergie del giorno
- Lista Allergie/intolleranze del giorno (nome alunno in rosso + badge)
- Indicatore Stato compilazione diario (classi compilate/inattive)
- Badge ✅ Diario del giorno completato
- Lista Accessi rapidi alle classi/sezioni
- Azione 'Registro di Classe' (accesso rapido modulo)
- Azione 'Presenze · Appello' (accesso rapido modulo)
- Azione 'Diario del Giorno' (accesso rapido modulo)
- Azione 'Galleria' (accesso rapido modulo)
- Azione 'Avvisi' (comunicazione)
- Azione 'Chat famiglie' (comunicazione)
- Azione 'Modulistica' (comunicazione)
- Azione 'Attività' (task/bacheca interna)
- Azione 'Armadietto' (gestione materiale)
- Selettore Mondo Infanzia/Nido ↔ Primaria (GradeWorldSwitch)
- Badge Grado abilitato (Infanzia / Nido / Primaria)
- Indicatore Data odierna
- Pulsante 'Vai alla Primaria' (fallback docente solo-primaria)
- Indicatore stato 'Nessuna funzione abilitata' (gating matrice)
- Bottom navigation docente

### `/teacher/attendance` — Appello Presenze (Nido/Infanzia)
_Modulo PRD: Presenze §2_

**Checklist controlli richiesti:**
- Tab 'Oggi'
- Tab 'Mese'
- Indicatore 'Presenti X/N'
- Indicatore 'Offline'
- Indicatore stato sync / sincronizzazione automatica
- Lista alunni della propria classe (empty state)
- Pulsante 'Presente' (per alunno)
- Pulsante 'Ritardo' (per alunno)
- Pulsante 'Assente' (per alunno)
- Badge stato alunno (Presente/Ritardo/Uscita Ant./Assente)
- Campo 'Orario Check-in' modificabile
- Indicatore 'Ingresso HH:MM' (orario check-in)
- Indicatore 'Uscita HH:MM' (orario check-out)
- Pulsante 'Uscita Ant.' (uscita anticipata rapida)
- Pulsante 'Uscita' (apri scheda delegati)
- Pulsante 'Reset / Cambia stato' (per alunno)
- Indicatore di caricamento riga alunno
- Lista 'Delegati Autorizzati' (sola lettura)
- Indicatore foto documento delegato
- Campo nome/relazione delegato
- Pulsante 'Conferma' uscita con delegato
- Pulsante 'Panic Alert - Ritiro Non Autorizzato'
- Banner 'Blocca uscita e notifica Segreteria + Genitore'
- Pulsante 'Chiudi' scheda delegati
- Selettore data (navigatore giorno)
- Pulsante 'Oggi' (torna a oggi)
- Pulsante 'Aggiorna presenze' (refresh)
- Indicatore legenda stati (Presente/Ritardo/Uscita Ant./Assente)
- Selettore mese (Mese precedente/successivo)
- Pulsante 'Esporta PDF' registro mensile
- Indicatore riepilogo P/A/R/U/ORE per alunno

### `/teacher/avvisi` — Bacheca Avvisi Docente
_Modulo PRD: Comunicazione §3_

**Checklist controlli richiesti:**
- Pulsante 'Nuovo' (crea avviso)
- Campo 'Titolo' avviso
- Campo 'Contenuto' avviso
- Selettore Tipo 'Presa visione'
- Selettore Tipo 'Adesione'
- Selettore Destinatari 'Per classe'
- Selettore Destinatari 'Tutti' (globale)
- Selettore classi target (chip multi-selezione)
- Campo 'Scadenza' avviso/adesione (data)
- Pulsante 'Carica File (PDF, Immagini)'
- Campo 'Link Esterno'
- Azione 'Rimuovi file allegato'
- Pulsante 'Pubblica Avviso'
- Pulsante 'Salva Modifiche' (avviso esistente)
- Lista avvisi pubblicati
- Azione 'Espandi avviso' (chevron card)
- Indicatore destinatari su card (classi/globale)
- Badge tipo avviso (Presa visione / Adesione)
- Indicatore 'X hanno letto' (read receipt)
- Indicatore conteggio adesioni 'Si'
- Indicatore conteggio adesioni 'No'
- Banner scadenza/scaduto su card
- Icona allegato 'Allegato File'
- Icona 'Link Esterno'
- Pulsante 'Dettaglio' (apre cruscotto monitoraggio)
- Pulsante 'Modifica' avviso
- Pulsante 'Elimina' avviso
- Tab 'Stato Lettura' (cruscotto)
- Tab 'Adesioni' (cruscotto)
- Indicatore 'Letti' su totale + percentuale
- Indicatore 'Non letti'
- Indicatore adesioni 'Si / No / Attesa'
- Filtro 'Classe' (cruscotto)
- Filtro 'Risposta' (Si/No/Attesa/Date)
- Campo ricerca 'Cerca alunno o genitore'
- Pulsante 'Azzera' filtri
- Sub-tab 'Letti' / 'Non letti'
- Lista alunni/genitori con stato lettura
- Lista risposte adesione per alunno (Si/No/Attesa)

### `/teacher/chat` — Chat Docente
_Modulo PRD: Comunicazione §2_

**Checklist controlli richiesti:**
- Pulsante 'Nuova Chat'
- Modal 'Nuova Chat' (selezione genitore)
- Lista contatti genitori della propria classe
- Lista conversazioni (thread 1-a-1)
- Indicatore associazione genitore-alunno nel thread
- Badge contatore messaggi non letti (per thread)
- Indicatore puntino non letto sull'avatar
- Badge contatore globale non letti (header)
- Campo 'Scrivi un messaggio'
- Pulsante 'Invia messaggio'
- Pulsante 'Allega file'
- Azione invio allegato foto/immagine
- Azione invio allegato documento/PDF
- Pulsante 'Nota vocale'
- Toggle 'Traduzione automatica'
- Indicatore messaggio tradotto
- Azione 'Mostra originale / traduzione'
- Indicatore stato lettura messaggio (spunte)
- Separatore 'Nuovi Messaggi'
- Indicatore data messaggi (Oggi/Ieri)
- Indicatore orario messaggio
- Banner chat sempre attiva (H24 / emergenze)

### `/teacher/diary` — Diario 0-6 Data-Entry
_Modulo PRD: Diario 0-6 §3_

**Checklist controlli richiesti:**
- Pulsante evento 'Entrata'
- Pulsante evento 'Attività'
- Pulsante evento 'Merenda'
- Pulsante evento 'Pranzo'
- Pulsante evento 'Nanna'
- Pulsante evento 'Sveglia'
- Pulsante evento 'Bagno'
- Pulsante 'Salva per tutti'
- Campo orario 'Entrata' per bambino
- Selettore livello partecipazione 'Non fatta'
- Selettore livello partecipazione 'Con difficoltà'
- Selettore livello partecipazione 'Con aiuto'
- Selettore livello partecipazione 'In autonomia'
- Selettore tipo attività
- Campo 'Descrizione attività'
- Pulsante 'Aggiungi attività'
- Pulsante 'Rimuovi attività'
- Selettore quantità pasto '✗ Niente'
- Selettore quantità pasto '¼ Poco'
- Selettore quantità pasto '½ Metà'
- Selettore quantità pasto '¾ Quasi tutto'
- Selettore quantità pasto '★ Tutto'
- Indicatore quantità 'Bis'
- Lista portate pranzo (Primo/Secondo/Contorno/Frutta)
- Banner 'Menu del giorno'
- Campo orario 'Si addormenta' (inizio nanna)
- Campo orario 'Si sveglia' (fine nanna)
- Contatore +/- 'Pipì'
- Contatore +/- 'Cacca'
- Contatore 'Vasino' (potty training)
- Campo 'Note libere' per evento
- Banner allergie
- Indicatore allergia nome in rosso
- Filtro presenze (solo bambini presenti)
- Badge ✅ alunno salvato
- Toast 'Salvato con successo'
- Indicatore 'Offline'
- Pulsante 'Chiudi' pannello evento (X)
- Indicatore conteggio compilati per attività
- Azione 'Bulk / Nanna per tutti' (selezione multipla alunni)
- Pulsante 'Indietro' (Step 1 da Step 2)

### `/teacher/gallery` — Galleria Upload & Tagging
_Modulo PRD: Foto e Video §2_

**Checklist controlli richiesti:**
- Pulsante 'Carica' (apre step upload)
- Pulsante 'Annulla' (esce dal flusso upload/tag)
- Selettore 'Sezione'
- Azione 'Selezione multipla / Bulk Upload' (drag&drop o file picker multiplo)
- Azione 'Trascina foto o video' (drop zone)
- Lista 'Anteprime file selezionati' (griglia preview pre-tag)
- Icona 'Rimuovi file' (X su anteprima)
- Pulsante 'Carica N file' (conferma selezione, va al tagging)
- Lista 'Miniature caricamento multiplo' (selettore foto attiva per tag)
- Badge 'Conteggio tag' (numero alunni taggati sulla miniatura)
- Badge '!' (foto senza tag, non pubblicabile)
- Badge 'G' Generale (miniatura broadcast)
- Indicatore 'Foto X di N'
- Pulsante 'Applica a tutte' (propaga tag/config a tutte le foto)
- Campo 'Cerca alunno o genitore'
- Lista 'Alunni della classe (completa, non filtrata per presenze)'
- Azione 'Tagga alunno' (toggle selezione nella foto)
- Indicatore 'Privacy Lock' (alunno senza liberatoria disabilitato)
- Icona 'EyeOff' (alunno senza liberatoria)
- Badge 'Solo genitori' (alunno senza liberatoria)
- Icona 'Check' (alunno taggato/selezionato)
- Pulsante 'Seleziona tutti' / 'Deseleziona tutti'
- Banner 'Foto Privata' (selezionato alunno senza liberatoria)
- Banner 'Info liberatoria/Privacy Lock'
- Pulsante 'Pubblica N file' (conferma upload con watermark)
- Indicatore 'Watermark automatico' (logo applicato in upload)
- Lista 'Feed cronologico unico' (griglia media sezione)
- Indicatore 'Tempo fa' (timestamp relativo media)
- Badge 'Generale' (media broadcast nel feed)
- Azione 'Apri lightbox media'
- Icona 'Naviga precedente/successivo' (frecce lightbox)
- Lista 'Bambini taggati nella foto' (riepilogo lightbox)
- Pulsante 'Modifica Tag' (ri-tagging media già pubblicato)
- Pulsante 'Salva' tag modificati
- Pulsante 'Elimina Media' (cancellazione dal feed)
- Toggle 'Caricamento in Broadcast' (invia a tutta la classe)
- Banner 'Offline' (upload salvato in locale)
- Pulsante 'Scarica' media (download)
- Pulsante 'Condividi' media nativo

### `/teacher/locker` — Armadietto Docente
_Modulo PRD: Armadietto §3_

**Checklist controlli richiesti:**
- Tab 'Carico Genitore'
- Tab 'Consumo'
- Tab 'Mensile'
- Pulsante 'Registra Carico Odierno'
- Pulsante 'Aggiungi carico per <alunno>'
- Selettore 'Alunno' (modale carico)
- Selettore 'Materiale' (modale carico)
- Campo 'Materiale custom (testo libero)'
- Campo 'Quantità' (stepper +/-)
- Campo 'Marca/Taglia' (dettagli carico)
- Pulsante 'Conferma Carico'
- Indicatore 'Stock Totale Attuale'
- Indicatore Semaforo scorte Verde/Giallo(<5)/Rosso(<2)
- Badge 'ESAURITO'
- Badge consegne odierne '✓ N'
- Badge '✅ Consegnato oggi'
- Pulsante riga materiale 'Registra consumo'
- Campo 'Quantità usata' (stepper consumo)
- Pulsante 'Conferma' (consumo)
- Pulsante 'Annulla' (form consumo)
- Azione 'Richiesta materiale al genitore'
- Azione 'Selezione massiva alunni (Bulk)'
- Pulsante 'Invia richiesta collettiva'
- Selettore 'Materiale richiesta' (anche custom)
- Azione 'Chiudi/Risolvi ciclo richiesta (ricezione)'
- Indicatore stato richiesta 'Preso in carico dal genitore'
- Banner 'Supporto offline (salvato in cache / sincronizza)'
- Indicatore 'Richiesta indipendente dalle presenze'
- Indicatore 'Scalo automatico pannolino da eventi Bagno (solo bambini con flag Usa pannolino)'
- Filtro materiale (vista Mensile)
- Pulsante 'Mese precedente'
- Pulsante 'Mese successivo'
- Icona 'Portato' / 'Non portato' (griglia mensile)
- Pulsante 'Aggiorna' (refresh)
- Icona/Link 'Impostazioni materiali'

### `/teacher/settings/locker` — Config Armadietto (Catalogo)
_Modulo PRD: Armadietto §2 / Impostazioni §4_

**Checklist controlli richiesti:**
- Pulsante 'Indietro' (torna ad Armadietto)
- Filtro Classe/Sezione (tab Girasoli/Coccinelle/Tulipani/Margherite)
- Lista materiali del catalogo per classe
- Pulsante 'Aggiungi Materiale per <classe>'
- Pulsante 'Elimina' materiale (Trash)
- Toggle 'Attivo/Disattiva' materiale
- Campo 'Nome materiale'
- Selettore 'Icona materiale'
- Campo 'Unita di misura'
- Campo 'Soglia Allerta (Giallo)'
- Campo 'Soglia Urgente/Esaurito (Rosso)'
- Indicatore semaforo soglie sulla card (Giallo Allerta / Rosso Urgente)
- Azione 'Riordina materiale' (frecce su/giu)
- Pulsante 'Salva Materiale'
- Pulsante 'Annulla' (form nuovo materiale)
- Banner informativo 'Come funziona' (semafori e visibilita)
- Indicatore stato vuoto 'Nessun materiale configurato'
- Indicatore salvataggio in corso (spinner per riga)
- Campo 'Richiesta materiale custom (testo libero)'
- Selettore default catalogo sede (Pannolini/Asciugamani/Creme/Cambi)
- Toggle abilitazione widget Armadietto per classe/grado

### `/teacher/modulistica` — Modulistica Docente (Cruscotto)
_Modulo PRD: Form §4 (cruscotto insegnante)_

**Checklist controlli richiesti:**
- Tab 'Semaforo Consensi'
- Tab 'Certificati Medici'
- Selettore 'Modulo di Autorizzazione'
- Indicatore 'Stato approvazioni classe' (semaforo verde/rosso)
- Badge 'N Firmati' (conteggio verdi)
- Badge 'N Mancanti' (conteggio rossi)
- Lista alunni con stato firma
- Badge 'FES OK' (consenso firmato)
- Pulsante 'Invia Sollecito' (campana)
- Pulsante 'Proxy' (upload cartaceo)
- Banner 'Proxy Upload Cartaceo' (modale)
- Campo 'Carica File' (modale proxy)
- Pulsante 'Registra Firma' (conferma proxy)
- Pulsante 'Annulla' (modale proxy)
- Pulsante 'Gestisci Giorni' (certificato medico)
- Badge 'Certificato Medico'
- Badge giorni coperti (date)
- Indicatore 'Da registrare giorni coperti'
- Campo 'Aggiungi Giorno' (data)
- Pulsante 'Aggiungi' giorno coperto
- Lista 'Giorni di Copertura Inseriti'
- Pulsante 'Salva Copertura'
- Pulsante 'Esporta PDF consensi classe'
- Indicatore semaforo Giallo (firma congiunta parziale)
- Indicatore 'Scadenza modulo' (deadline bloccante)

### `/teacher/register` — Registro Primaria (legacy) — ⛔ DEPRECATA
_Modulo PRD: Primaria §4_

> [!WARNING]
> **Pagina DEPRECATA.** Sostituita dalle pagine conformi O.M. 3/2025 basate sui **giudizi sintetici**:
> `/teacher/primaria/[sectionId]/registro` (firma lezione + argomenti/compiti), `/teacher/primaria/[sectionId]/valutazioni` (valutazione in itinere per obiettivi/dimensioni/giudizi), `/teacher/primaria/[sectionId]/prospetto`, `/teacher/primaria/[sectionId]/note`, `/teacher/primaria/[sectionId]/scrutinio`.
> La rotta legacy va **reindirizzata** a queste pagine (Blocco 3). Sono **SUPERATI** (non target) solo i controlli a **voti numerici visibili (1-10)** e alla scala **Base/Intermedio/Avanzato**, sostituiti dai **giudizi sintetici Allegato A**. Le pagine canoniche mantengono invece le **categorie Scritto/Orale/Pratico** e la **media** (calcolata sull'associazione numerica nascosta dei giudizi).

**Checklist controlli (legacy — snapshot storico, NON target):**
- Tab 'Lezioni'
- Tab 'Valutazioni'
- Tab 'Note'
- Indicatore 'Classe 3A Primaria'
- Lista ore di lezione (1ª-8ª ora)
- Pulsante 'Firma' (per ora)
- Selettore Materia (firma lezione)
- Campo 'Argomento svolto in classe'
- Campo 'Compiti per casa'
- Campo 'Data di consegna compiti'
- Pulsante 'Salva e Firma'
- Pulsante 'Modifica' (lezione firmata)
- Pulsante 'Allegato' (media lezione)
- Indicatore 'Firmato' (ora firmata)
- Azione Cofirma compresenza
- Selettore tipologia compresenza
- Azione Firma indipendente per alunni specifici (oscuramento)
- Indicatore stato presenza alunno (Presente/Assente/Ritardo/Uscita Anticipata)
- Pulsante 'Aggiungi Voto'
- Selettore Alunno (valutazione)
- Selettore Materia (valutazione)
- Selettore Tipo prova (Scritto/Orale/Pratico)
- Toggle modalità voto Numerico vs Giudizio
- Campo Voto numerico (1-10)
- Selettore Giudizio (Base/Intermedio/Avanzato)
- Selettore Obiettivo di apprendimento
- Toggle dimensione 'Autonomia' (Sì/No)
- Toggle dimensione 'Continuità' (Sì/No)
- Selettore dimensione 'Tipologia situazione' (Nota/Non nota)
- Selettore dimensione 'Risorse mobilitate' (Interne/Esterne/Entrambe)
- Campo Giudizio descrittivo auto-generato (modificabile)
- Selettore Giudizio sintetico in itinere (es. Buono/Sufficiente)
- Selettore Giudizio sintetico scrutinio (Ottimo/Distinto/Buono/Discreto/Sufficiente/Non sufficiente)
- Pulsante 'Salva Voto'
- Lista valutazioni inserite (tabella)
- Badge voto/giudizio colorato in tabella
- Banner 'Buffer Notifica 10 minuti'
- Badge 'Voto salvato!' (conferma)
- Lista selezione alunni (note)
- Pulsante 'Seleziona Tutti'/'Deseleziona Tutti'
- Selettore Categoria nota (Disciplinare/Didattica/Compiti non svolti)
- Campo 'Testo della nota'
- Toggle 'Richiedi Firma per Presa Visione'
- Pulsante 'Assegna Nota (n)'
- Lista 'Note Recenti' (storico)
- Badge stato firma nota ('Firmata'/'In attesa')
- Banner blocco modifiche oltre vincolo temporale

### `/teacher/tasks` — Task Staff
_Modulo PRD: Comunicazione §4_

**Checklist controlli richiesti:**
- Tab 'Assegnati a me'
- Tab 'Creati da me'
- Tab 'Archivio'
- Tab 'Da Controllare'
- Tab 'Tutti i Task'
- Pulsante 'Prendo in carico'
- Pulsante 'Risolvi Task'
- Pulsante 'Conferma Risolto'
- Campo 'Note di Risoluzione'
- Pulsante 'Scegli file' allegati risoluzione
- Pulsante 'Completa Compito'
- Pulsante 'Chiarimenti'
- Pulsante 'Invia' chiarimento
- Pulsante 'Vedi dettagli' / 'Nascondi dettagli'
- Pulsante 'Nuovo'
- Badge contatore task in sospeso
- Badge priorita' (Bassa/Media/Alta/Urgente)
- Badge stato 'Da Fare' / 'In Corso' / 'Da Controllare' / 'Completato'
- Badge categoria task
- Badge destinatario (singolo/classe/ruolo/globale)
- Badge 'In Attesa di Approvazione'
- Badge 'Aggiornato'
- Indicatore deadline / 'SCADUTO'
- Indicatore progresso 'Compiti Approvati'
- Badge allergie alunno collegato
- Lista allegati con anteprima/download
- Banner 'Revisione Richiesta'
- Indicatore lucchetto compito non proprio
- Pulsante 'Elimina task'
- Pulsante 'Modifica task'
- Pulsante 'Approva Task' / 'Approva Compito'
- Pulsante 'Richiedi Modifica' (revisione)
- Indicatore ruolo utente (Direzione/Coordinatore/Insegnante)
- Notifica browser nuovo task / compito risolto / revisione

### `/teacher/primaria` — Hub Sezioni Primaria
_Modulo PRD: Primaria (navigazione)_

**Checklist controlli richiesti:**
- Lista 'Le mie classi' (classi/sezioni in carico)
- Azione 'Seleziona classe' (card classe verso registro)
- Indicatore numero alunni della classe
- Indicatore anno scolastico della classe
- Icona ChevronRight (apertura classe)
- Selettore 'Mondo' Infanzia/Primaria (GradeWorldSwitch)
- Banner 'Nessuna classe primaria assegnata'
- Banner errore caricamento classi
- Indicatore di caricamento 'Caricamento…'

### `/teacher/primaria/[sectionId]` — Dashboard Sezione
_Modulo PRD: Primaria (sezione)_

**Checklist controlli richiesti:**
- Tab 'Registro'
- Tab 'Appello'
- Tab 'Valutazioni'
- Tab 'Note'
- Tab 'Orario'
- Tab 'Prospetto'
- Tab 'Scrutinio'
- Tab 'Fascicolo'
- Icona 'Indietro' (torna a Le mie classi)
- Indicatore 'Nome classe' (titolo sezione)
- Badge 'Primaria' (grado)
- Badge 'Modalità segreteria'
- Lista 'Alunni' della sezione con contatore
- Lista 'Le mie materie' (chip discipline assegnate)
- Banner 'Empty state alunni' (Nessun alunno)
- Banner 'Empty state materie' (Nessuna materia assegnata)
- Indicatore 'Hint navigazione schede' (usa le schede in alto)
- Indicatore 'Riepilogo presenze del giorno'
- Indicatore 'Allergie alunno' (nome in rosso + badge)

### `/teacher/primaria/[sectionId]/appello` — Appello Orario Primaria
_Modulo PRD: Primaria §2.1_

**Checklist controlli richiesti:**
- Pulsante 'Presente' (per alunno)
- Pulsante 'Assente' (per alunno)
- Pulsante 'Ritardo' (per alunno)
- Pulsante 'Uscita' (uscita anticipata, per alunno)
- Campo 'Entrata' (orario ritardo)
- Campo 'Uscita' (orario uscita anticipata)
- Pulsante 'Tutti presenti'
- Campo 'Data appello' (selettore data)
- Pulsante 'Giustificata · presa visione' (giustifica genitore)
- Badge 'giustif. vista'
- Selettore 'Alunno' (riepilogo ore assenze)
- Campo 'Dal' (periodo riepilogo)
- Campo 'Al' (periodo riepilogo)
- Indicatore 'Ore assenze' (totale)
- Indicatore 'Ore ritardi'
- Indicatore 'Ore permessi'
- Indicatore 'Totale ore' mancate
- Lista 'Ore mancate per materia'
- Indicatore sync offline appello
- Azione 'Firma docente (tap sull'ora di lezione)'
- Indicatore 'Compresenza' (firme docenti indipendenti)
- Selettore 'Tipologia compresenza' (cofirma)
- Campo 'Argomento svolto' (contestuale alla firma)
- Campo 'Compiti assegnati' (contestuale alla firma)
- Selettore 'Ora/Campanella' (griglia oraria)
- Indicatore 'Sync con presenze generali'

### `/teacher/primaria/[sectionId]/registro` — Registro di Classe / Firma Lezione
_Modulo PRD: Primaria §3 + §7_

**Checklist controlli richiesti:**
- Selettore data registro
- Lista campanelle (ore di lezione)
- Indicatore ora e fascia oraria
- Indicatore materia della lezione
- Pulsante 'Firma' lezione (tap sulla campanella)
- Pulsante 'Modifica' lezione firmata
- Badge ✅ firma apposta
- Campo 'Argomento svolto'
- Campo 'Compiti'
- Indicatore argomento lezione (riga)
- Badge 'Compiti' (riga)
- Azione 'Allega' file multimediale
- Lista allegati lezione
- Icona tipo allegato (PDF/Immagine)
- Selettore 'Tipo firma' (compresenza)
- Azione 'Cofirma' su argomento del docente ordinario
- Indicatore firme docenti sulla riga
- Selettore destinatari alunni (firma indipendente sostegno)
- Campo 'Argomento (per i destinatari)'
- Campo 'Compiti (per i destinatari)'
- Indicatore 'attività individualizzata' (riga)
- Banner privacy attività individualizzata
- Selettore 'Classe' (firma supplenza in altra sezione)
- Banner 'supplenza' altra classe
- Indicatore stato offline / coda di sincronizzazione
- Pulsante 'Annulla' modale firma
- Pulsante 'Firma' (conferma modale)
- Banner vincolo temporale / blocco immodificabilità
- Indicatore alunni 'Assenti' (recupero compiti)

### `/teacher/primaria/[sectionId]/valutazioni` — Valutazioni in Itinere
_Modulo PRD: Primaria §4.1-§4.2_

**Checklist controlli richiesti:**
- Selettore 'Alunno'
- Selettore 'Materia'
- Selettore 'Obiettivo di apprendimento'
- Pulsante 'Associa obiettivi alla disciplina'
- Selettore 'Tipo prova' (Orale/Scritto/Pratico)
- Tab 'Per dimensioni'
- Tab 'Giudizio sintetico'
- Toggle 'Autonomia' (Sì/No)
- Toggle 'Continuità' (Sì/No)
- Toggle 'Tipologia della situazione' (Nota/Non nota)
- Toggle 'Risorse mobilitate' (Interne/Esterne/Entrambe)
- Campo 'Giudizio descrittivo' (auto-generato, editabile)
- Selettore 'Giudizio sintetico in itinere'
- Campo 'Argomento' (obbligatorio)
- Pulsante 'Salva valutazione'
- Banner 'Buffer di sicurezza 10 minuti'
- Lista 'Valutazioni recenti'
- Indicatore 'Modalità valutazione' (Per dimensioni / sintetico) sulla valutazione recente
- Banner 'Voti numerici disabilitati alla primaria'
- Messaggio 'Valutazione salvata'
- Pulsante 'Segna impreparato (alunno selezionato)'
- Lista 'Impreparati giustificati — oggi'
- Badge origine impreparato (dal genitore / dal docente)

### `/teacher/primaria/[sectionId]/prospetto` — Prospetto Valutazioni
_Modulo PRD: Primaria §4.4_

**Checklist controlli richiesti:**
- Selettore 'Alunno'
- Selettore 'Materia'
- Filtro 'Tutte le materie' (panoramica)
- Lista panoramica medie per materia
- Indicatore 'Media' per materia (panoramica, da associazione numerica nascosta dei giudizi)
- Indicatore 'Valutazioni' (conteggio) per materia
- Azione 'Apri dettaglio per obiettivo' (riga panoramica)
- Indicatore 'Media matematica (giudizi sintetici)' per materia
- Lista valutazioni raggruppate per obiettivo
- Indicatore 'Codice obiettivo'
- Badge 'Giudizio sintetico'
- Indicatore 'Tipo prova' (scritto/orale/pratico)
- Indicatore 'Data valutazione'
- Indicatore 'Giudizio descrittivo' (testo)
- Banner 'Errore caricamento'
- Indicatore 'Nessuna valutazione registrata'
- Filtro per obiettivo di apprendimento
- Indicatore isolamento 'Solo la propria disciplina'

### `/teacher/primaria/[sectionId]/note` — Note Disciplinari (Docente)
_Modulo PRD: Primaria §5_

**Checklist controlli richiesti:**
- Selettore categoria 'Disciplinare (Comportamento)'
- Selettore categoria 'Didattica'
- Selettore categoria 'Compiti non svolti'
- Lista alunni con checkbox di selezione
- Pulsante 'Tutta la classe' / 'Deseleziona tutti'
- Campo 'Testo della nota'
- Toggle 'Richiedi firma di presa visione al genitore'
- Pulsante 'Invia nota'
- Lista 'Note recenti'
- Badge categoria sulla nota (cromatico)
- Indicatore stato 'attesa firma' / 'firmata'
- Banner errore caricamento alunni
- Banner conferma 'Nota inviata'
- Filtro alunni presenti per inserimento massivo
- Azione 'Modifica nota' (entro finestra temporale)
- Indicatore blocco temporale (immodificabilita oltre scadenza)

### `/teacher/primaria/[sectionId]/orario` — Orario Lezioni (Docente)
_Modulo PRD: Primaria §6_

**Checklist controlli richiesti:**
- Indicatore 'Orario settimanale' (titolo pagina)
- Lista Griglia oraria settimanale (matrice campanelle x giorni)
- Indicatore Intestazioni giorni (Lun-Sab)
- Indicatore Fascia oraria campanella (ora_inizio-ora_fine)
- Indicatore Materia per cella (nome disciplina master)
- Indicatore Docente assegnato per cella
- Badge Mensa (cella tipo mensa)
- Badge Intervallo/Ricreazione (cella tipo intervallo)
- Banner 'Orario non ancora configurato' (empty state)
- Indicatore Caricamento orario (loading)
- Indicatore Cella vuota '—' (campanella lezione senza materia)
- Indicatore Contitolarita (piu docenti sulla stessa ora/classe)
- Indicatore Gruppo-classe per disciplina (es. mensa/alternativa)
- Indicatore Modello tempo scuola (Tempo Normale 27/29h / Tempo Pieno 40h)

### `/teacher/primaria/[sectionId]/scrutinio` — Scrutinio & Pagella
_Modulo PRD: Primaria §4.3 + §9_

**Checklist controlli richiesti:**
- Selettore 'Periodo' (intermedio/finale + anno scolastico)
- Banner 'Nessun periodo di scrutinio configurato'
- Indicatore stato scrutinio 'Aperto — proposta giudizi' / 'Chiuso il <data>'
- Banner esito operazione (salvataggi/errori, badge ✓)
- Tabella 'Giudizi alunno x disciplina'
- Selettore 'Giudizio sintetico' per cella (scala Allegato A)
- Indicatore disciplina 'Educazione Civica' (marcatore *)
- Indicatore isolamento materie (celle disciplina altrui disabilitate)
- Pulsante 'Salva giudizi'
- Pulsante 'Template CSV'
- Pulsante 'Importa CSV'
- Azione 'Proponi giudizi da valutazioni in itinere'
- Campo 'Giudizio del comportamento'
- Campo 'Giudizio globale' (facoltativo)
- Pulsante 'Salva comportamento'
- Azione 'Override collegiale giudizio' (modifica/sovrascrittura)
- Pulsante 'Chiudi scrutinio' (solo Dirigente)
- Indicatore 'Scrutinio incompleto: mancano N giudizi'
- Pulsante 'Genera pagelle (tutte)' (solo Dirigente)
- Pulsante 'Pagella PDF' per alunno (post-chiusura)
- Indicatore 'Pubblicato ai genitori' / 'Non pubblicato (solo staff)'
- Pulsante 'Pubblica ai genitori' / 'Revoca pubblicazione' (solo Dirigente)
- Banner conferma 'Pubblicare i voti? I genitori riceveranno una notifica'
- Selettore 'Declinazione descrittori PTOF' applicata in pagella

### `/teacher/primaria/[sectionId]/fascicolo` — Fascicolo Personale Alunno
_Modulo PRD: Fascicolo Personale_

**Checklist controlli richiesti:**
- Selettore 'Alunno'
- Banner 'Accesso tracciato' (documenti riservati)
- Banner 'Accesso non autorizzato' (RBAC negato)
- Banner errore caricamento alunni
- Tab/Sezione 'Documenti ufficiali' (PEI/PDP/sanitari)
- Tab/Sezione 'Pagelle' (storico anni)
- Tab/Sezione 'Sezione amministrativa'
- Tab/Sezione 'Consensi e Privacy'
- Selettore 'Tipo documento' (Diagnosi/PEI/PDP/L.104)
- Campo 'Descrizione documento'
- Campo 'Data di scadenza' documento
- Campo 'File' (upload PDF/immagine)
- Pulsante 'Carica' documento
- Indicatore 'Caricamento…' (stato upload)
- Badge 'Documento caricato' (conferma salvataggio)
- Badge tipo documento (PEI/PDP/104) sulla riga
- Indicatore 'Scade il' (scadenza documento)
- Pulsante 'Apri' (download documento ufficiale)
- Pulsante 'Apri PDF' pagella
- Lista 'Pagelle per anno scolastico' (accordion)
- Toggle anno scolastico (espandi/chiudi)
- Indicatore 'Pubblicata il' (data pagella)
- ✅ Pulsante 'Apri/Scarica certificato delle competenze' _(P5/DL-047, admin `/admin/competenze` + genitore)_
- Indicatore 'Audit log accessi' (chi/quando/finalità)
- Campo 'Finalità di accesso' (motivazione consultazione)
- Sezione/Area 'Workflow firma GLO' (PEI)
- Pulsante 'Visualizza bozza PEI' (GLO)
- Campo 'Annotazione PEI' (collaborazione GLO)
- Pulsante 'Firma per accettazione PEI' (firma Base)
- Badge 'Firme GLO' (stato sottoscrizioni)
- Lista 'Deleghe al prelievo' (con documento delegato)
- Indicatore segregazione 'Documento sensibile' (bucket riservato)

## Segreteria/Admin

### `/admin` — Dashboard Segreteria
_Modulo PRD: Presenze §4.1 + Trasversale_

**Checklist controlli richiesti:**
- Indicatore 'Alunni presenti in tempo reale' (totale struttura)
- Azione 'Drill-down presenze per classe'
- Azione 'Sovrascrivi/correggi presenze docente'
- Pulsante 'Export registro presenze (Excel/PDF) MIUR'
- Indicatore 'Alunni in Ritardo post cut-off da approvare'
- Banner 'Panic Alert ritiro non autorizzato'
- Lista 'Accessi rapidi moduli' (hub Tutti i moduli)
- Pulsante 'Iscrizioni' (azione rapida header)
- Pulsante 'Genera rette'
- Indicatore KPI 'Alunni iscritti'
- Indicatore KPI 'Pagamenti scaduti'
- Indicatore KPI 'Incassato nel mese'
- Indicatore KPI 'Iscrizioni in attesa'
- Indicatore KPI 'Prenotazioni mensa oggi'
- Indicatore KPI 'Fatture da emettere'
- Indicatore 'Incassi ultimi 6 mesi' (grafico trend)
- Indicatore 'Alunni per classe' (grafico)
- Pannello 'Pagamenti scaduti' (alert con badge contatore)
- Pannello 'Iscrizioni da processare' (alert con badge contatore)
- Pulsante 'Apri' (link di dettaglio nei pannelli alert)
- Badge contatore notifiche su pannelli alert

### `/admin/students` — Anagrafica Alunni
_Modulo PRD: Anagrafica §2-§4_

**Checklist controlli richiesti:**
- Tab 'Alunni'
- Tab 'Genitori'
- Tab 'Sezioni'
- Tab 'Staff'
- Filtro 'Cerca per nome/cognome/codice fiscale'
- Filtro 'Classe / Sezione'
- Filtro 'Stato alunno'
- Tabella alunni (Cognome/Nome/Nascita/Classe/Stato/Info)
- Selettore 'Seleziona tutti' (checkbox header)
- Selettore riga alunno (checkbox)
- Azione 'Ordina colonna' (sort header)
- Indicatore 'Sezione: X (n alunni)' (group-by)
- Badge 'Allergie' (nome/badge ROSSO + AlertTriangle)
- Badge 'BES'
- Badge stato alunno (Iscritto/Ritirato/Sospeso)
- Indicatore 'Totale Alunni'
- Indicatore 'Iscritti'
- Indicatore 'Con BES'
- Indicatore 'Con Allergie'
- Pulsante 'Nuovo Alunno'
- Pulsante 'Esporta'
- Pulsante 'Importa pre-iscrizioni' (import dati con 1 click)
- Pulsante 'Genera link pre-iscrizione sicuro'
- Barra 'Assegnazione massiva (Bulk)' selezionati
- Selettore 'Classe destinazione' (bulk)
- Selettore 'Gruppo mensa' (bulk)
- Pulsante 'Assegna' (bulk)
- Pulsante 'Annulla selezione' (bulk)
- Pulsante 'Trasferisci alunno tra sedi'
- Azione 'Apri scheda alunno' (riga cliccabile)
- Campo 'Nome' alunno
- Campo 'Cognome' alunno
- Campo 'Data di nascita'
- Campo 'Codice Fiscale'
- Campo 'Luogo di nascita'
- Campo 'Sesso'
- Campo 'Indirizzo di residenza'
- Campo 'Cittadinanza'
- Selettore 'Sede di appartenenza'
- Selettore 'Classe / Sezione' (scheda)
- Selettore 'Stato alunno' (Iscritto/Ritirato/Sospeso)
- Campo 'Allergie / Intolleranze'
- Badge allergeni ROSSI (chip da note_mediche)
- Toggle 'BES (Bisogni Educativi Speciali)'
- Campo 'Note BES'
- Lista 'Famiglia e Delegati' (tab Madre/Padre/Delegato)
- Pulsante 'Aggiungi delegato'
- Indicatore 'Documento identità delegato' (tipo/numero)
- Pulsante 'Visualizza Allegato' documento delegato
- Pulsante 'Carica documento identità delegato'
- Lista 'Fratelli / Sorelle'
- Lista 'Segnalazioni e Reclami' (note disciplinari)
- Sezione 'Dati Economici / Retta' (connessione Payments)
- Pulsante 'Salva Modifiche' alunno
- Badge conferma salvataggio (toast ✅)
- Pulsante 'Elimina Alunno (GDPR)' (Hard Delete)
- Banner 'Conferma eliminazione definitiva (GDPR)'
- Pulsante 'Reset password / re-invio credenziali genitore'
- Pulsante 'Invita genitore / crea legame parent-student'
- Pulsante 'Reset password staff'
- Lista 'Audit Log modifiche anagrafiche'
- Filtro 'Audit log per utente (Insegnante/Genitore)'

### `/admin/students/new` — Nuovo Alunno
_Modulo PRD: Anagrafica §2_

**Checklist controlli richiesti:**
- Tab 'Alunno'
- Tab 'Madre'
- Tab 'Padre'
- Pulsante 'Aggiungi Componente'
- Icona Cestino rimozione tab componente
- Banner 'Salva prima l'alunno per collegamento automatico'
- Campo Nome alunno
- Campo Cognome alunno
- Selettore Sesso alunno
- Campo Data di Nascita alunno
- Campo Comune di Nascita
- Campo Provincia di Nascita (sigla)
- Campo Codice Fiscale alunno
- Indicatore 'Codice Fiscale Autocalcolato'
- Selettore Sede di appartenenza
- Selettore Sezione (Classe/Sezione)
- Campo Indirizzo di Residenza
- Campo Comune di Residenza
- Campo CAP residenza
- Campo Cittadinanza alunno
- Selettore Stato dell'Alunno (Iscritto/Non iscritto/Ritirato/Sospeso)
- Campo Allergie e Intolleranze
- Selettore Allergeni (14 allergeni UE, badge rosso)
- Toggle 'Studente BES / DSA'
- Campo Note BES / DSA
- Toggle 'Usa pannolino' (abilita scalo automatico pannolino dagli eventi Bagno del Diario — incongruenza #9)
- Selettore Intestatario Fattura (Madre/Padre/Altro)
- Campo Dettagli Intestatario alternativo (Nome/Cognome/CF)
- Campo Importo Retta
- Campo Scadenza mensile pagamento
- Campo Sconti applicati (es. sconto fratelli)
- Pulsante 'Salva Alunno'
- Badge 'Alunno Salvato!' (conferma con ID)
- Pulsante 'Vai alla lista alunni'
- Pulsante 'Nuovo alunno'
- Campo Nome adulto
- Campo Cognome adulto
- Selettore Ruolo Familiare/Operativo
- Selettore Sesso adulto
- Campo Data di Nascita adulto
- Campo Cittadinanza adulto
- Campo Nazione di Nascita adulto
- Campo Comune di Nascita adulto
- Campo Codice Fiscale adulto
- Campo Indirizzo Completo adulto
- Campo Città di Residenza adulto
- Campo CAP adulto
- Campo Numeri di Cellulare (multipli)
- Pulsante 'Aggiungi Numero'
- Campo Indirizzi Email (multipli, prima per Auth)
- Badge 'Primaria' su email principale
- Pulsante 'Aggiungi Email'
- Pulsante 'Rigenera Credenziali'
- Pulsante 'Salva Adulto'
- Azione Upload documento identità delegato
- Azione Upload documenti BES/PEI/Diagnosi

### `/admin/iscrizioni` — Iscrizioni & Onboarding (SIDI)
_Modulo PRD: Anagrafica §4.1 + SIDI_

**Checklist controlli richiesti:**
- Lista 'Richieste di iscrizione' (pending/totale)
- Indicatore 'In attesa (n) · Totale {n}'
- Badge stato 'In attesa'
- Badge stato 'Importata'
- Badge stato 'Rifiutata'
- Indicatore conteggio Bambini per richiesta
- Indicatore conteggio Adulti per richiesta
- Azione 'Apri dettaglio richiesta'
- Sezione 'Bambini' del dettaglio
- Campo 'Codice fiscale alunno'
- Selettore 'Classe / Sezione' per alunno
- Sezione 'Adulti' del dettaglio
- Campo 'Codice fiscale adulto'
- Selettore 'Referente / intestatario' (radio)
- Pulsante 'Documento' alunno
- Pulsante 'Documento' adulto
- Pulsante 'Importa nelle anagrafiche'
- Pulsante 'Rifiuta'
- Banner 'Iscrizione importata' con credenziali
- Indicatore 'Credenziali inviate via email al referente'
- Banner 'Email non inviata - comunicare manualmente'
- Lista 'Avvisi' import (warnings)
- Banner 'Nessuna richiesta ricevuta' (empty state)
- Indicatore 'Caricamento' (spinner)
- ✅ Pulsante 'Upload ZIP ministeriale SIDI' _(P5/DL-048, in `SidiPanel` → `/admin/sidi`)_
- ✅ Azione 'Matching su Numero di domanda SIDI' _(P5/DL-048, `applySidiRecords`)_
- ✅ Azione 'Sincronizzazione dati genitori (chiave CF)' _(P5/DL-048)_
- ✅ Campo 'Numero domanda iscrizione SIDI' _(P5/DL-048, `alunni.numero_domanda_sidi`)_
- ✅ Azione 'Fase A - Allineamento struttura (sedi/sezioni/classi/tempo scuola)' _(P5/DL-049, `buildFaseAReconcile`; egress gated)_
- ✅ Pulsante 'Invia flusso frequentanti al SIDI' _(P5/DL-049; egress gated 503 fino ad accreditamento)_
- ✅ Azione 'Trasmissione associazione Genitori-Alunni (Piattaforma Unica)' _(P5/DL-049, solo legami validati Segreteria; egress gated)_
- ✅ Indicatore stato sincronizzazione SIDI (Fase A → frequentanti → Piattaforma Unica) _(P5/DL-049, `sidi_sync_state` + 3 pill a cascata)_
- Pulsante 'Genera link sicuro pre-iscrizione'
- ✅ Azione 'Assegnazione massiva (bulk) a classi/sezioni/gruppi mensa' _(P5/DL-050, `BulkAssignBar` + `gruppi_mensa`)_

### `/admin/forms/builder` — Form Builder
_Modulo PRD: Form §4.1_

**Checklist controlli richiesti:**
- Campo 'Nome del modello'
- Pulsante 'Indietro' (torna a Modulistica)
- Lista 'Libreria Campi' (palette drag&drop)
- Azione 'Trascina campo dalla palette al canvas'
- Selettore tipo campo 'Testo Corto'
- Selettore tipo campo 'Testo Lungo'
- Selettore tipo campo 'Menu a Tendina'
- Selettore tipo campo 'Numero'
- Selettore tipo campo 'Allegato File'
- Selettore tipo campo 'Firma'
- Lista 'Campi Anagrafica' (blocchi predefiniti)
- Blocco predefinito 'Bambino' (collassabile)
- Blocco predefinito 'Madre' (collassabile)
- Blocco predefinito 'Padre' (collassabile)
- Blocco predefinito 'Delegato / Tutore' (collassabile)
- Toggle espandi/collassa gruppo anagrafica
- Indicatore 'Mapping ETL' del campo anagrafica (db_mapping)
- Tab pagine wizard (step del modulo)
- Pulsante 'Aggiungi pagina'
- Indicatore 'Step X / N' della pagina attiva
- Azione 'Trascina per riordinare i campi'
- Azione 'Seleziona campo per modificarne le proprietà'
- Pulsante 'Elimina campo' (cestino)
- Campo 'Etichetta' del campo
- Campo 'Testo Segnaposto' (placeholder)
- Toggle 'Obbligatorio'
- Campo 'Punteggio Graduatoria' (punti del campo)
- Editor 'Opzioni & Punteggi' (select/radio/checkbox)
- Campo punti per singola opzione
- Pulsante 'Aggiungi opzione'
- Pulsante 'Rimuovi opzione'
- Indicatore 'Mapping ETL' nel pannello proprietà
- Badge 'Obbligatorio' sul campo nel canvas
- Badge '+N pt' (punteggio) sul campo nel canvas
- Pulsante 'Salva Modello'
- Badge stato salvataggio 'Salvato!' (check)
- Banner errore 'Errore' salvataggio
- Indicatore conteggio 'N pagine · N campi'
- Editor 'Logica Condizionale' (regole di visibilità campo)
- Pulsante 'Pubblica modello' (attiva il modello)
- Pannello 'Impostazioni FEA' (abilita Firma Elettronica)
- Selettore 'Firmatari richiesti' (firma singola / congiunta genitori)
- Configurazione accessi 'Chi può compilare' (registrati / link pubblico)
- Campo 'Scadenza bloccante del modulo'
- Configurazione 'Scoring graduatoria' a livello modello (soglia / max punteggio)
- Blocco predefinito 'Consensi' (GDPR check-box separati)

### `/admin/forms/submissions` — Raccolta Compilazioni
_Modulo PRD: Form §4.3_

**Checklist controlli richiesti:**
- Campo 'Cerca per modello o contenuto'
- Filtro Stato compilazione
- Filtro Modello
- Filtro Data invio
- Filtro Tag
- Pulsante 'Esporta tutto (N)' XLSX massivo
- Azione 'Scarica PDF' (riga)
- Azione 'Esporta XLSX' (riga)
- Azione 'Apri anteprima compilazione' (riga)
- Lista campi compilati (dati JSONB)
- Badge Stato compilazione
- Indicatore 'Firma' / data firma
- Indicatore 'Modello rimosso'
- Pulsante 'Scarica PDF' (anteprima)
- Pulsante 'Esporta XLSX' (anteprima)
- Pulsante 'Chiudi' anteprima
- Pulsante 'Rimuovi filtri'
- Azione 'Modifica amministrativa compilazione'
- Indicatore 'Log versione originale'
- Azione 'Importa in Anagrafica (ETL)'
- Indicatore 'Allegati esclusi dal PDF'

### `/admin/forms/rankings` — Graduatorie
_Modulo PRD: Form §4.4_

**Checklist controlli richiesti:**
- Indicatore 'Candidati' (conteggio totale)
- Indicatore 'Punteggio medio'
- Indicatore 'Punteggio massimo'
- Campo Cerca candidato
- Filtro Modulo (selettore 'Tutti i moduli')
- Lista Ranking candidati ordinata per punteggio
- Indicatore Posizione/rank in classifica
- Badge Medaglia top 3 (1°/2°/3°)
- Indicatore Punteggio calcolato
- Indicatore Delta modifiche manuali (+/- accanto al punteggio)
- Indicatore Data firma (Firma)
- Icona Info tooltip 'Modifiche manuali'
- Azione Apri regolazione (click su riga candidato)
- Pulsante 'Rimuovi filtri'
- Modale 'Regola punteggio' (override manuale)
- Campo Bonus/Malus (stepper +/- e input numerico)
- Campo Motivazione (obbligatorio)
- Indicatore Punteggio base / Modifiche manuali / Totale attuale
- Lista Storico modifiche manuali nel modale
- Pulsante 'Applica' (salva override punteggio)
- Pulsante 'Annulla' (chiudi modale senza salvare)
- Azione Delibera ammissioni
- Indicatore Stato ammesso/non ammesso candidato
- Pulsante Esporta graduatoria (XLSX/PDF)

### `/admin/modulistica` — Modulistica Admin
_Modulo PRD: Form (gestione modelli)_

**Checklist controlli richiesti:**
- Tab 'Moduli Genitori'
- Tab 'Moduli Esterni'
- Tab 'Iscrizioni Nuovi Alunni'
- Tab 'Template Certificati ODT'
- Pulsante 'Nuovo Modulo Genitori'
- Pulsante 'Nuovo Modulo Esterni'
- Azione 'Form Builder Drag & Drop'
- Selettore 'Tipo di Modulo' (Sondaggio/Gradimento/Autorizzazione)
- Campo 'Titolo Modulo'
- Campo 'Descrizione / Istruzioni'
- Campo 'Scadenza Modulo'
- Selettore 'Classi Target'
- Pulsante 'Aggiungi Campo'
- Selettore 'Tipo Input' campo
- Campo 'Opzioni di scelta' (radio)
- Toggle 'Campo Obbligatorio'
- Pulsante 'Rimuovi Campo'
- Pulsante 'Salva Modulo'
- Azione 'Blocco Dati Bambino / Adulto / Consensi / Allegati'
- Azione 'Logica Condizionale campi'
- Campo 'Scoring / Punteggio per Graduatorie'
- Selettore 'Configurazione Accessi' (utenti registrati / link pubblico)
- Toggle 'Abilita Firma Elettronica (FEA/FES)'
- Selettore 'Firmatari richiesti' (singola/congiunta genitori)
- Badge 'Tipo Modulo' (etichetta)
- Badge 'OTP / Firma FES' (scudo)
- Badge 'Destinatari' (classi/esterni)
- Badge 'Scadenza' (semaforo scaduto/in scadenza)
- Pulsante 'Merge [Classe]' (export massivo PDF cumulativo)
- Indicatore 'Stato firma per alunno' (AUTORIZZATO/NON AUTORIZZATO)
- Indicatore 'Log FES' (IP / Timestamp / Hash SHA-256)
- Pulsante 'Modifica Scadenza'
- Pulsante 'Elimina Modulo'
- Azione 'Sollecito firme non completate'
- Pulsante 'Esporta XLSX dataset'
- Lista 'Dashboard Raccolta Compilazioni' con filtri (data/stato/modello/tag)
- Azione 'Anteprima e Modifica compilazione (con log versione)'
- Pulsante 'Genera PDF singola compilazione'
- Azione 'Dashboard Graduatorie (ranking + override + ammissioni)'
- Selettore 'Upload Template ODT Carta Intestata'
- Selettore 'Upload Template ODT Certificato Frequenza'
- Selettore 'Upload Template ODT Certificato Iscrizione'
- Badge 'Template ODT caricato' (conferma)

### `/admin/mensa` — Mensa Admin / Menu Builder & Ticket
_Modulo PRD: Mensa §2 + §4_

**Checklist controlli richiesti:**
- Tab 'Menu' (Menu Builder)
- Tab 'Report cucina'
- Tab 'Inserisci ticket'
- Pulsante 'Ricarica ticket' (vai a Pagamenti)
- Pulsante 'Impostazioni mensa'
- Selettore Menu (multi-menu / Menu unico legacy)
- Selettore Settimana ciclo (1..N)
- Campo 'Nome piatto' per portata
- Campo 'Ingredienti' per portata
- Toggle allergene per portata (14 allergeni UE)
- Pulsante 'Salva settimana N'
- Badge 'Salvato' (conferma rotazione)
- Campo 'Data' eccezione (override giornaliero)
- Toggle 'Mensa chiusa' (chiusura per data)
- Editor portate variazione giornaliera (override)
- Pulsante 'Aggiungi' eccezione
- Lista eccezioni/chiusure impostate
- Icona 'Elimina' eccezione (cestino)
- Indicatore impostazione durata ciclo (n. settimane)
- Azione autocompilazione calendario ciclico
- Banner notifica variazione alle famiglie
- Filtro 'Data' report cucina
- Filtro 'Sezione' report cucina
- Indicatore 'Totale pasti' del giorno
- Indicatore conteggio 'allergie nel menu di oggi'
- Lista 'Prenotati per sezione'
- Badge allergene per alunno (rosso se in conflitto)
- Indicatore conflitto allergene-menu (riga rossa + dettaglio portate)
- Indicatore numeri per tipo dieta (Standard/Bianco/Speciale)
- Pulsante 'Esporta report catering' (Excel/PDF)
- Campo ricerca alunno (inserimento ticket)
- Indicatore 'Saldo' ticket alunno
- Campo 'Data del pasto'
- Pulsante 'Inserisci ticket (scala 1)'
- Banner avviso forzatura saldo negativo (debito)
- Badge conferma 'Ticket inserito / nuovo saldo'
- Pulsante 'Ricarica manuale ticket' (accredito pacchetto+importo)
- Selettore 'Pacchetto ticket' (es. 10/20 pasti)
- Azione 'Storno / rimborso ticket'
- Indicatore semaforo scorte ticket (Verde/Giallo<5/Rosso<2)
- Banner reminder esaurimento scorte (soglia critica)

### `/admin/pagamenti` — Pagamenti, Morosità & Fatturazione
_Modulo PRD: Pagamenti §2-§3 + Aruba_

**Checklist controlli richiesti:**
- Tab 'Scadenziario'
- Tab 'Genera rette'
- Tab 'Genera pagamenti'
- Tab 'Ticket mensa'
- Pulsante 'Mensa & Cucina'
- Pulsante 'Impostazioni'
- Indicatore KPI 'Incassato'
- Indicatore KPI 'Da incassare'
- Indicatore KPI 'Scaduto (morosità)' in rosso
- Campo 'Cerca alunno o sezione'
- Filtro 'Categoria pagamento'
- Selettore 'Anno scolastico'
- Selettore 'Mese di competenza'
- Filtro 'Morosi'
- Pulsante 'Aggiorna' (refresh)
- Banner 'Alunni senza retta generata'
- Pulsante 'Genera mancanti'
- Indicatore 'Riga moroso in rosso'
- Badge stato pagamento (Da pagare/Parziale/Pagato/Scaduto)
- Badge 'Non generata'
- Pulsante 'Incassa'
- Icona 'Modifica pagamento' (matita)
- Pulsante 'Nuovo acquisto' (+)
- Icona 'Dividi in acconti'
- Lista 'Acquisti per alunno' (categoria)
- Selettore 'Anno scolastico / Mese singolo' (generatore rette)
- Selettore 'Anno scolastico' (generatore rette)
- Campo 'Mese di competenza' (generatore rette)
- Pulsante 'Anteprima' rette
- Indicatore 'Retta default'
- Indicatore 'Split (genitori separati)'
- Pulsante 'Genera N rette'
- Selettore 'Categoria' (generatore pagamenti)
- Selettore 'Classe (vuoto = tutti)'
- Campo 'Causale / descrizione'
- Campo 'Importo'
- Campo 'Scadenza'
- Campo 'Gruppo (evita duplicati)'
- Toggle 'Obbligatorio'
- Toggle 'Dividi in acconti'
- Campo 'N° rate'
- Pulsante 'Genera per N alunni'
- Campo 'Importo incassato'
- Selettore 'Metodo' (Contanti/Bonifico/POS/Assegno/Altro)
- Campo 'Data incasso'
- Campo 'Note incasso'
- Indicatore 'Pagamento parziale residuo'
- Toggle 'Riporta eccedenza sulla rata successiva'
- Pulsante 'Registra' (incasso)
- Badge 'Pagamento saldato'
- Pulsante 'Invia fattura'
- Campo 'Causale fattura'
- Pulsante 'Emetti' fattura
- Pulsante 'Riprova fattura'
- Pulsante 'Scarica fattura' (download PDF)
- Banner 'Scarto SDI' con motivo
- Campo 'Descrizione' (modifica pagamento)
- Campo 'Importo' (modifica/override retta)
- Campo 'Scadenza' (modifica)
- Selettore 'Categoria' (modifica)
- Toggle 'Pagamento obbligatorio' (modifica)
- Lista 'Incassi registrati'
- Azione 'Modifica incasso'
- Azione 'Storna incasso' (elimina)
- Pulsante 'Salva modifiche'
- Campo 'Descrizione' (nuovo acquisto)
- Campo 'Importo' (nuovo acquisto)
- Toggle 'Pagamento obbligatorio (genera solleciti)'
- Toggle 'Dividi in acconti (rate)' (nuovo acquisto)
- Toggle 'Già pagato (registra subito incasso)'
- Selettore 'Metodo di pagamento' (nuovo acquisto)
- Pulsante 'Registra acquisto'
- Pulsante 'Configura acconti'
- Pulsante 'Genera rate uguali'
- Campo 'Totale piano rateale'
- Campo 'N° rate' (piano)
- Campo '1ª scadenza' (piano)
- Azione 'Aggiungi rata'
- Azione 'Elimina rata'
- Indicatore 'Somma rate vs Totale'
- Pulsante 'Crea piano rateale'
- Campo 'Cerca alunno' (ticket mensa)
- Indicatore 'Saldo ticket'
- Selettore 'Pacchetto ticket'
- Campo 'Pezzi / Costo / Metodo' (ricarica)
- Pulsante 'Ricarica (crea pagamento Mensa saldato)'
- Pulsante 'Sospendi account moroso'
- Toggle 'Override retta da anagrafica (sconto fratelli / data)'
- Indicatore 'Reminder aggressivo insoluti'
- Indicatore 'Quota saldata per gita (semaforo verde)'

### `/admin/primaria` — Config Primaria (Materie/Orario/Valutazione)
_Modulo PRD: Impostazioni §3.2 + Primaria §6_

**Checklist controlli richiesti:**
- Selettore Classe/Sezione (primaria)
- Tab 'Orario'
- Selettore Tempo scuola (27/29/40 ore)
- Selettore Giorni settimana (5/6 giorni)
- Pulsante 'Genera orario'
- Pulsante 'Rigenera campanelle'
- Indicatore 'Attivo: Xh/Ygg'
- Selettore Materia per cella oraria
- Selettore Docente per cella oraria
- Indicatore cella Mensa 🍽
- Indicatore cella Intervallo ☕
- Lista Materie master di sezione
- Pulsante 'Applica preset materie per livello'
- Selettore Livello classe (1ª-5ª) per preset
- Campo 'Nome materia' + Codice
- Pulsante 'Aggiungi' materia
- Toggle 'attiva' materia
- Pulsante 'Elimina' materia
- Badge 'Ed. Civica' su materia
- Badge 'Mensa' (turno) su materia
- Selettore 'Obiettivo della classe' per materia
- Selettore Materia (gestione obiettivi curricolo)
- Selettore Livello (gestione obiettivi curricolo)
- Campo Codice + Descrizione obiettivo
- Pulsante 'Aggiungi' obiettivo
- Pulsante 'Elimina' obiettivo
- Banner motore valutazione forzato O.M. 3/2025 (Primaria)
- Selettore modello valutazione per grado/sezione
- Lista 'Scala giudizi sintetici' (6 ufficiali Allegato A)
- Campo 'Valore numerico' giudizio (media in itinere)
- Campo 'Giudizio descrittivo (pagella)'
- Toggle 'attivo' giudizio della scala
- Pulsante Aggiungi/Elimina giudizio scala
- Lista 'Template giudizio descrittivo' (PTOF/Allegato A)
- Editor giudizio di scrutinio per voto (livello×materia×periodo)
- Lista Assegnazione Docenti & Materie
- Toggle 'contitolare' docente-materia
- Campo Vincoli temporali registro (giorni orali/scritti)
- Campo Buffer notifiche valutazioni (min)
- Pulsante 'Salva impostazioni' (vincoli/notifiche)
- Tab 'Registri di classe'
- Tab 'Fascicoli/Accessi'

### `/admin/impostazioni` — Impostazioni Globali (Super-Admin)
_Modulo PRD: Modulo Impostazioni (tutto)_

**Checklist controlli richiesti:**
- Tab 'Funzioni & moduli'
- Tab 'Pagamenti & Fatturazione'
- Tab 'Modulistica'
- Tab 'Didattica primaria'
- Tab 'Pagelle & Scrutinio'
- Tab 'Diario'
- Tab 'Presenze & Giustifiche'
- Tab 'Note disciplinari'
- Tab 'Mensa'
- Tab 'Armadietto'
- Tab 'Avvisi'
- Tab 'Chat'
- Tab 'Galleria'
- Selettore sezione (sidebar/pills navigazione impostazioni)
- Pulsante 'Aggiungi sede'
- Azione 'Rinomina/Disattiva sede'
- Pulsante 'Crea grado/classe'
- Pulsante 'Aggiungi staff' (onboarding personale)
- Selettore 'Ruolo' (Docente/Segreteria/Cuoca/Direzione)
- Azione 'Associa docente a classe'
- Lista 'Categorie pagamento'
- Badge 'Categoria di sistema' (lucchetto)
- Campo 'Nuova categoria pagamento'
- Pulsante 'Aggiungi categoria pagamento'
- Icona 'Elimina categoria pagamento'
- Campo 'Retta default (€)'
- Campo 'Giorno scadenza retta (1-28)'
- Campo 'Visibile dal giorno (mese prec.)'
- Campo 'Tolleranza insoluti (giorni)'
- Toggle 'Generazione automatica rette mensili'
- Campo 'Causale fattura (template)'
- Pulsante 'Salva' (Retta e morosità)
- Lista 'Pacchetti ticket mensa'
- Campo 'Nome/Pezzi/Costo pacchetto ticket'
- Pulsante 'Aggiungi pacchetto'
- Icona 'Elimina pacchetto ticket'
- Pulsante 'Salva' (Pacchetti ticket)
- Campo 'Username Aruba'
- Campo 'Password Aruba (riferimento vault)'
- Campo 'Partita IVA'
- Campo 'Codice Fiscale'
- Campo 'PEC'
- Campo 'Ragione sociale'
- Campo 'Sede legale'
- Campo 'Regime fiscale'
- Selettore 'Mappatura aliquote/cause IVA'
- Toggle 'Abilita invio fatture (produzione)'
- Selettore 'Ambiente Aruba (test/prod)'
- Badge 'Scaffold' (Fatturazione Aruba)
- Pulsante 'Salva' (Fatturazione Aruba)
- Tabella 'Funzioni × Grado' (matrice attivazione moduli)
- Toggle 'Funzione attiva per grado'
- Pulsante 'Salva' (Funzioni & moduli)
- Badge 'Salvato ✓'
- Selettore 'Routine attive nel diario'
- Campo 'Compilazione diario dalle/alle'
- Campo 'Diario visibile ai genitori dalle'
- Toggle 'Note libere docenti abilitate'
- Badge 'Coming soon' (Diario)
- Pulsante 'Salva' (Diario)
- Campo 'Orario cut-off mensa'
- Selettore 'Giorni mensa attivi'
- Campo 'Settimane di rotazione menu'
- Campo 'Soglia avviso saldo basso'
- Pulsante 'Salva impostazioni mensa'
- Lista 'Menu mensa' (creazione menu per ordine)
- Pulsante 'Aggiungi menu'
- Icona 'Elimina menu'
- Pulsante 'Aggiungi assegnazione classe→menu'
- Selettore 'Menu' (assegnazione classe)
- Indicatore 'Assegnazione attiva/programmata' (✓/⏳)
- Calendario chiusure scolastiche (giorni festivi)
- Campo 'Costo singolo ticket pasto'
- Campo 'Soglia scorta bassa (pezzi)'
- Toggle 'Notifica genitore scorta bassa'
- Toggle 'Richieste materiale ai genitori abilitate'
- Lista 'Categorie materiale extra'
- Pulsante 'Aggiungi categoria armadietto'
- Pulsante 'Salva' (Armadietto)
- Tab 'Materie' (didattica primaria)
- Tab 'Docenti & Materie'
- Tab 'Obiettivi' (curricolo d'istituto)
- Tab 'Classificazione docenti'
- Tab 'Vincoli & notifiche'
- Selettore 'Classe/Sezione' (didattica primaria)
- Campo 'Orario/campanelle e palinsesto settimanale'
- Campo 'Time-lock registro orali (giorni)'
- Campo 'Time-lock scritti/pratici (giorni)'
- Campo 'Buffer notifiche valutazioni (min)'
- Tab 'Periodi scrutinio'
- Tab 'Scala giudizi'
- Tab 'Giudizi scrutinio' (declinazioni PTOF)
- Selettore 'Modello valutazione per grado'
- Selettore 'Chi può inviare moduli' (ruoli)
- Toggle 'Firma moduli con OTP'
- Campo 'Promemoria moduli non compilati (giorni)'
- Selettore 'Formato export submissions (CSV/XLSX)'
- Azione 'Apri Form Builder'
- Pulsante 'Salva' (Modulistica)
- Campo 'Giorni max per giustificare'
- Campo 'Soglia alert assenze (%)'
- Campo 'Appello entro le'
- Toggle 'Giustifica obbligatoria assenze'
- Toggle 'Giustifica con firma OTP genitore'
- Toggle 'Uscite anticipate richiedono delega'
- Toggle 'Presa visione nota con firma OTP'
- Toggle 'Nota visibile al genitore subito'
- Toggle 'Notifica segreteria a nuova nota'
- Lista 'Categorie nota disciplinare'

### `/admin/tools` — Strumenti / Audit / Export
_Modulo PRD: Anagrafica §4.2 + Presenze §4.1_

**Checklist controlli richiesti:**
- Pulsante 'Genera Esportazione' (Excel anagrafiche)
- Pulsante 'Scegli File .xlsx' (importa e sincronizza)
- Campo upload file Excel/CSV (.xlsx/.xls/.csv)
- Indicatore caricamento import/export (spinner)
- Badge 'Importati N su M record!' (esito import)
- Banner nota tecnica elaborazione lato browser
- Lista Audit Log cronologico modifiche anagrafiche
- Filtro Audit Log per singolo utente (Insegnante/Genitore)
- Pulsante 'Recupero credenziali / Reset password' utente
- Pulsante 'Export ministeriale registri presenze' (Excel/PDF)
- Selettore formato export (Excel / PDF)
- Filtro export presenze per grado (Nido/Infanzia/Primaria)
- Pulsante 'Importa pre-iscrizioni' (un click da form esterno)
- Azione 'Diritto all'oblio / Hard Delete' GDPR **✅ (P3.4c, DL-034)** — `/admin/gdpr` (`OblioPanel`): lista alunni **non iscritti** + genitori → cancellazione definitiva = **anonimizzazione** (no DELETE righe, zero rischio FK) con placeholder `CANCELLATO-{hash}` su `alunni`/`parents` (orfani) + rimozione file PII; **preserva audit + fisco** (obbligo legale); **dry-run + doppia conferma** (digitare il nominativo), gate Direzione, audit `gdpr_oblio`. Marcatore `anonimizzato_il` (migr. `20260751`).

## Cuoca

### `/admin/mensa/cucina` — Dashboard Cucina
_Modulo PRD: Mensa §2.2_

**Checklist controlli richiesti:**
- Indicatore 'Pasti Standard' (conteggio per tipologia)
- Indicatore 'Diete in Bianco' (conteggio per tipologia)
- Indicatore 'Diete Speciali' (conteggio per intolleranze)
- Indicatore 'Totale pasti del giorno'
- Indicatore 'Cut-off' (orario limite, es. 09:30)
- Banner 'Numeri provvisori / definitivi (pre/post cut-off)'
- Indicatore real-time / aggiornamento automatico pasti
- Pulsante 'Aggiorna' (refresh manuale dati)
- Lista 'Menu di oggi' (Primo/Secondo/Contorno/Frutta)
- Banner 'Mensa chiusa' (giorno di chiusura)
- Lista 'Allergeni del menu di oggi'
- Badge allergene piatto (nome in rosso + emoji)
- Lista 'Prenotati per sezione' (conteggio per classe)
- Indicatore 'Conflitti allergie nel menu di oggi'
- Badge alunno con allergia/conflitto (nome in ROSSO + alert)
- Filtro 'Data' (selettore giorno report)
- Filtro 'Sezione' (selettore classe)
- Azione 'Approvazione ritardi / richiesta oltre cut-off'
- Indicatore 'Isolamento interfaccia' (sola lettura, nessun dato sensibile)

## Pubblico/Onboarding

### `/iscrizione` — Form Iscrizione Pubblico
_Modulo PRD: Form §4.2 (pre-iscrizione)_

**Checklist controlli richiesti:**
- Indicatore 'Passo X di N'
- Indicatore barra di avanzamento wizard
- Banner 'Iscrizione Nuovo Alunno'
- Pulsante 'Avanti'
- Pulsante 'Indietro'
- Pulsante 'Invia richiesta'
- Tab Bambino (pagina dati minore)
- Tab Adulto (pagina genitore/tutore/delegato)
- Tab Riepilogo
- Pulsante 'Aggiungi un altro figlio'
- Pulsante 'Aggiungi adulto / tutore'
- Pulsante 'Rimuovi' (figlio/adulto)
- Campo Documento d'identità del minore (upload)
- Campo Documento d'identità adulto (upload)
- Indicatore stato upload allegato (caricamento/caricato)
- Campo Codice Fiscale alunno
- Campo Codice Fiscale adulto
- Campo Allergie / Intolleranze alunno
- Selettore Ruolo adulto (Madre/Padre/Tutore/Delegato)
- Banner 'È obbligatorio almeno un adulto / usa stesso CF'
- Banner conferma 'Richiesta inviata!'
- Indicatore stato invio in corso ('Invio…')
- Selettore consenso GDPR / privacy (check-box separati)
- Campo firma elettronica (FES/FEA)
- Pulsante 'Invia codice OTP' (email firmatario)
- Campo inserimento codice OTP
- Indicatore firmatari richiesti (singola/congiunta genitori)

### `/onboarding` — Onboarding Genitore
_Modulo PRD: Anagrafica + Auth_

**Checklist controlli richiesti:**
- Banner 'Benvenuto in Kidville' di primo accesso genitore
- Campo Email account (precompilato dall'invito Segreteria)
- Campo Numero di cellulare
- Campo Nuova password
- Campo Conferma password
- Indicatore robustezza password
- Toggle 'Mostra password'
- Toggle 'Accetto l'Informativa Privacy (GDPR)'
- Toggle 'Accetto i Termini e Condizioni del servizio'
- Toggle 'Consenso uso dati anagrafici/medici figli'
- Pulsante 'Leggi informativa completa' (apertura documento)
- Campo PIN dispositivo libretto
- Campo Conferma PIN dispositivo libretto
- Pulsante 'Completa attivazione account'
- Indicatore stato avanzamento step onboarding
- Banner 'Invito non valido / scaduto'
- Pulsante 'Vai al login' al termine onboarding
- Azione Redirect automatico a /iscrizione

### `/` — Login / Landing
_Modulo PRD: Trasversale (Auth/Accessibilità)_

**Checklist controlli richiesti:**
- Campo 'Email'
- Campo 'Password'
- Pulsante 'Accedi'
- Toggle 'Mostra password'
- Pulsante 'Password dimenticata? / Recupero credenziali'
- Banner 'Accesso solo su invito Segreteria (no auto-registrazione)'
- Toggle 'Alto contrasto'
- Indicatore 'Compatibilità screen reader (label/ARIA sui campi)'
- Banner messaggio errore credenziali
- Indicatore selezione Sede/Tenant
- Pulsante 'Deploy Now'
- Pulsante 'Documentation'

## Note di coerenza — Incongruenze PRD ↔ Roadmap/Prompt

> [!NOTE]
> **STATO: tutte le 9 incongruenze sono RISOLTE** con le decisioni definitive qui sotto recepite nel PRD (giugno 2026). Il PRD resta la fonte di verità.
> - Blocco 1 (questo PRD): decisioni recepite nel corpo e nelle checklist. ✅
> - Blocco 2 (`ROADMAP_TECNICA.md` + `prompts/`): contenuti in conflitto marcati come SUPERATI e allineati al PRD.
> - Blocco 3 (codice): correzioni applicate per #1–#4, #6, #8, #9 (vedi sezioni successive). La firma (#5, FEA) era esclusa dal Blocco 3 ma è stata **rimessa in scope** come servizio in-house — vedi **DL-001** nel Decision Log.

- ✅ **RISOLTA** — **Valutazione primaria: voti numerici vietati vs modello ibrido numerico/descrittivo** (alta). **Decisione recepita (rev. committente):** voto **visibile** = **giudizio sintetico** Allegato A; **nessun voto numerico 1-10 visibile** alla primaria. È **MANTENUTA l'associazione numerica nascosta** (es. *Sufficiente* = 6) usata solo internamente per la media (#3). I voti numerici visibili restano solo per i gradi non-primaria. *Analisi originale:* PRD: PRD §4 (Diario Scuola Primaria) è categorico: per la primaria i voti numerici sono VIETATI sia in itinere sia a scrutinio (L.150/2024, O.M.3/2025). Il motore è 'ibrido per grado': per la Primaria la modalità a voti numerici è 'disabilitata e non selezionabile dal docente'; i numerici (1-10) sono ammessi SOLO per gradi non-primaria. La valutazione in itinere è per obiettivi/4 dimensioni con giudizio descrittivo; lo scrutinio usa i 6 giudizi sintetici dell'Allegato A. Lo stato attuale del codice (GradesTab.tsx, valutazioni.voto_numerico) è dichiarato 'NON conforme'. · Roadmap/Prompt: ROADMAP_TECNICA.md (riga 15, Fase 1) prescrive per il registro primaria un 'Sistema di valutazione ibrido (voti numerici e giudizi descrittivi)' senza alcuna restrizione per grado. prompts/fase1_02_registro_primaria.md (punto 3) ordina esplicitamente: 'Valutazioni (Voti): Modello ibrido: numerici (es. 1-10) o descrittivi (es. Base, Avanzato)' come spec del modulo Primaria. Questo contraddice direttamente il divieto del PRD: la roadmap/prompt fanno implementare i voti numerici proprio dove sono vietati.
- ✅ **RISOLTA** — **Scala di giudizio primaria: Allegato A (Ottimo→Non sufficiente) vs 'Base/Avanzato'** (media). **Decisione recepita:** l'unica scala ammessa alla primaria è quella dell'**Allegato A O.M. 3/2025** (Ottimo, Distinto, Buono, Discreto, Sufficiente, Non sufficiente). La scala **Base/Intermedio/Avanzato è SUPERATA** e non va più usata. *Analisi originale:* PRD: PRD §4.3 impone in modo rigido la scala dell'Allegato A O.M.3/2025 a SEI giudizi sintetici (Ottimo, Distinto, Buono, Discreto, Sufficiente, Non sufficiente), 'non rimodulabile nelle definizioni standard'. Il box IMPORTANT di §4 dichiara esplicitamente SUPERATO e 'da sostituire' il vecchio modello a livelli 'Base/Intermedio/Avanzato' (riferimenti 2020). · Roadmap/Prompt: prompts/fase1_02_registro_primaria.md (punto 3) usa come esempio di giudizi descrittivi proprio 'Base, Avanzato', cioè la scala dichiarata superata dal PRD. Manca ogni riferimento alla scala a 6 livelli dell'Allegato A o all'enum vincolato per la primaria.
- ✅ **RISOLTA** — **Calcolo automatico delle medie dei voti (primaria)** (alta). **Decisione recepita (rev. committente):** il **calcolo della media è MANTENUTO**, basato sull'**associazione numerica nascosta** dei giudizi sintetici (#1). La media è uno strumento interno di sintesi per il docente (il documento di valutazione resta espresso in giudizi). *Analisi originale:* PRD: Il PRD non prevede alcun 'calcolo medie' per la primaria: la valutazione in itinere è formativa, per obiettivi di apprendimento e 4 dimensioni (Autonomia, Continuità, Tipologia situazione, Risorse), con giudizio descrittivo/sintetico; lo scrutinio aggrega in 6 giudizi sintetici per disciplina, modificabili collegialmente. Non esiste il concetto di media numerica alla primaria (coerente col divieto dei voti numerici). · Roadmap/Prompt: ROADMAP_TECNICA.md (riga 15) richiede 'calcolo automatico medie'. prompts/fase1_02_registro_primaria.md istruisce: 'I giudizi descrittivi devono avere un valore numerico nascosto per il calcolo delle medie' e (Istruzioni Operative, punto 2 Backend) 'Crea la logica per il calcolo asincrono delle medie'. Introdurre un valore numerico nascosto e una media reintroduce di fatto la valutazione numerica vietata dal PRD.
- ✅ **RISOLTA** — **Categorizzazione voti Scritto/Orale/Pratico applicata alla primaria** (media). **Decisione recepita (rev. committente):** le categorie **Scritto/Orale/Pratico sono MANTENUTE anche alla primaria** — servono come tipologia della prova e per i termini di immodificabilità §8 (orali 2gg / scritte-pratiche 15gg). *Analisi originale:* PRD: PRD §4.1 riserva la categorizzazione Scritto/Orale/Pratico (con voti 1-10) esclusivamente ai gradi NON-primaria ('eventuale secondaria di primo grado'). Per la primaria la valutazione è per obiettivi e dimensioni, senza categorie scritto/orale/pratico. · Roadmap/Prompt: prompts/fase1_02_registro_primaria.md (punto 3, modulo Primaria) elenca tra le specifiche delle Valutazioni: 'Categorizzazione: Scritto, Orale, Pratico', senza limitarla ai gradi non-primaria, quindi imponendola al registro primaria.
- ✅ **RISOLTA** — **Firma documenti modulistica: FEA (Avanzata) vs FES (Semplice)** (alta). **Decisione recepita:** la firma documenti è **FEA (Firma Elettronica Avanzata)**, come da PRD, confermata. I riferimenti a **FES** in roadmap/prompt sono **SUPERATI**. ⚠️ **Aggiornamento (DL-001, 2026-06-25):** l'implementazione tecnica della FEA è ora **in scope** e sarà realizzata **in-house** (OTP email + verifica identità + ricevuta PDF con log IP/Timestamp/User-Agent/Hash SHA-256) nella Fase P1 del master plan — non più a carico del committente. ✅ **Implementata (P1, 2026-06-25):** servizio `src/lib/fea/` (builder `signature_log`, slot firmatari `fea_signatures` con policy `any-one`/`all-required` — DL-007, audit `fea_audit_log` — DL-009, ricevuta `GET /api/fea/receipt` con hash documentale via **jsPDF** — DL-006); 3 consumatori ricablati (wizard moduli/pagella/giustifica). *Nota legale:* l'etichetta resta "FEA" per DL-001; il livello tecnico (OTP+identità da sessione+ricevuta inattaccabile) è una firma elettronica rafforzata in-house — informativa/processo da validare col committente. *Analisi originale:* PRD: PRD Modulo Form (prd.md e sezione omologa nel PRD principale) descrive la validazione legale tramite 'Firma Elettronica Avanzata (FEA)' — §1 Descrizione Generale e §4.1 'Impostazioni FEA: Abilitazione della Firma Elettronica Avanzata, definendo i firmatari richiesti'. La validità è garantita da OTP via email. · Roadmap/Prompt: ROADMAP_TECNICA.md (Fase 4, riga 50) parla di 'Integrazione Firma Elettronica Semplice (FES)'. prompts/fase4_01_modulistica.md intitola la sezione 'Scudo Giuridico e FES' e ripete 'Firma Elettronica Semplice (FES)' / 'efficacia legale della Firma Elettronica Semplice'. FEA e FES sono due livelli giuridici diversi (eIDAS): contraddizione sul tipo di firma da implementare e sul valore probatorio.
- ✅ **RISOLTA** — **Diario: pulsanti Nanna e Sveglia separati vs pulsante unico 'Nanna' (inizio+fine)** (media). **Decisione recepita:** **DUE pulsanti distinti** — "Nanna (Inizio)" e "Sveglia (Fine Nanna)" — che registrano l'orario "dalle … alle …". Il pulsante unico attuale va corretto (Blocco 3). *Analisi originale:* PRD: PRD §3.1 e §3.1.1 elencano DUE eventi/pulsanti distinti nella griglia: 'Nanna (Inizio)' (orario inizio riposo) e 'Sveglia (Fine Nanna)' (orario fine). La griglia Step 1 include esplicitamente sia 'Nanna' sia 'Sveglia' come pulsanti separati. La nota di implementazione del PRD segnala già come deviazione l'unificazione. · Roadmap/Prompt: prompts/fase2_01_diario_infanzia.md (punto 1 e Flusso UX) tratta 'Nanna (inizio e fine)' come singola routine/pulsante unico con due input. ROADMAP_TECNICA.md (Fase 2) elenca solo 'Nanna' tra le routine, senza 'Sveglia'. La griglia eventi quindi prevede un solo pulsante anziché i due richiesti dal PRD.
- ✅ **RISOLTA** — **Filtro presenze nel Diario 0-6 (mostrare solo i 'Presenti')** (bassa). **Decisione recepita:** requisito **ATTIVO** — le sezioni di inserimento del Diario mostrano **solo i bambini "Presenti"** nel modulo Presenze. Da implementare nel codice (Blocco 3). *Analisi originale:* PRD: PRD §3.1 (Filtro Presenze) richiede che le sezioni di inserimento del Diario mostrino esclusivamente i bambini 'Presenti' nel modulo Presenze, rimuovendo automaticamente gli assenti. Tuttavia la nota di implementazione dello stesso PRD avverte che 'Il filtro presenze ... non è ancora attivo — vengono mostrati tutti gli alunni della sezione'. · Roadmap/Prompt: prompts/fase2_01_diario_infanzia.md richiede ripetutamente il filtro presenze come requisito attivo (punto 2 'Filtro presenze: Mostra solo i bambini Presenti oggi', Flusso UX Step 2 'compare la lista dei bambini Presenti oggi', Istruzioni punto 3). Esiste quindi una incongruenza tra requisito di prodotto (filtro obbligatorio) e stato dichiarato nel PRD (filtro non implementato, lista completa mostrata).
- ✅ **RISOLTA** — **Diario Bagno/Igiene: 'Vasino/potty training' vs soli contatori Pipì/Cacca** (bassa). **Decisione recepita:** il **Vasino 🚽** è un **controllo previsto e già implementato**, accanto a Pipì 💧 e Cacca 💩 (documentato in §3.1.1). *Analisi originale:* PRD: PRD §2.1 indica per Bagno/Igiene il monitoraggio di Pipì, Cacca e 'Uso del Vasino (per potty training)'. La sezione §3.1.1 e la nota di implementazione descrivono però solo due contatori +/- (Pipì 💧 e Cacca 💩), senza il tracciamento Vasino. · Roadmap/Prompt: prompts/fase2_01_diario_infanzia.md (punto 1) elenca 'Bagno/Igiene (Pipì, Cacca, Vasino)' come routine da supportare, reintroducendo il Vasino che la parte operativa del PRD e l'implementazione non prevedono come controllo dedicato.
- ✅ **RISOLTA** — **Armadietto: trigger consumo su 'cambio pannolino' vs evento 'Bagno/Igiene'** (bassa). **Decisione recepita:** lo scalo di **1 pannolino** avviene ad **ogni evento Bagno** del Diario, ma **solo per i bambini con flag "Usa pannolino"** attivo in Anagrafica (§2.1). I bambini senza flag non subiscono scalo. Da implementare nel codice (Blocco 3). *Analisi originale:* PRD: PRD Armadietto §2.2 (Consumo Automatico) scala un'unità ad ogni azione specifica di consumo registrata nel Diario, citando esplicitamente l'esempio 'cambio pannolino'. Nel Diario, però, l'evento Bagno è modellato come contatori Pipì/Cacca, non come 'cambio pannolino' dedicato. · Roadmap/Prompt: prompts/fase2_02_armadietto_anagrafica.md (Istruzioni punto 1) prescrive un trigger che 'alla registrazione di un evento Bagno/Igiene nel Diario ... decrementa la disponibilità', legando lo scalo a qualunque evento Bagno (es. pipì) e non al solo cambio pannolino: ambiguità su quale azione consuma lo stock, con rischio di decremento errato.

---

# Decision Log (Implementazione)

> [!IMPORTANT]
> Registro cronologico delle decisioni prese durante l'implementazione del **Master Plan** (vedi `ROADMAP_GAP_2026.md` + piano `a-crea-un-piano`). Ogni voce è recepita anche **inline** nelle sezioni/checklist pertinenti del PRD. In caso di conflitto con testo più vecchio, **vince la voce più recente del Decision Log**.

### 2026-06-25 — DL-001 — [Fase P1] FEA: da "esclusa/committente" a "in scope, in-house"
- **Contesto:** il PRD (incongruenza #5 e nota Blocco 3) dichiarava la firma FEA **esclusa** dall'implementazione e "a carico del committente". Il committente ha deciso di **includerla nello scope** del prodotto.
- **Decisione:** la **FEA è in scope** e verrà realizzata **in-house** come servizio trasversale (Fase P1): slot firmatari (singola/congiunta genitori), invio/reinvio **OTP via email** (base `forms/send-otp` esistente), verifica identità, **ricevuta PDF inattaccabile** con log **IP / Timestamp / User-Agent / Hash SHA-256**. Consumata da: Modulistica/Form (§Form §4.1), Pagelle (§Primaria §9.2), firma di registro docente (§Primaria §8), consensi e workflow GLO del PEI (§Fascicolo).
- **Impatto PRD:** aggiornati la nota Blocco 3 e l'incongruenza **#5** (rimosso "esclusa dal Blocco 3"); annotato §Form §4.1; in `ROADMAP_TECNICA.md` Fase 4 rimossa la nota "a carico del committente".
- **Alternative scartate:** provider terzo certificato (Aruba Firma/Namirial/InfoCert) — scartato per costo/dipendenza esterna; rinvio della scelta — scartato perché la FEA è prerequisito di più moduli.

### 2026-06-25 — DL-002 — [Fase P0] Autenticazione reale invite-only su Supabase Auth
- **Contesto:** non esiste autenticazione reale. L'identità viaggia via `?userId=`/header `x-user-id` con fallback hardcoded (`DEV_TEACHER_ID`/`DEV_PARENT_ID`); il modello identità è frammentato (`utenti` staff scollegata da `auth.users`; `parents` + `legame_genitori_alunni` coesistenti). I gate RBAC si fidano dell'identità passata dal client.
- **Decisione:** implementare **login reale invite-only** su **Supabase Auth** (Fase P0): pagina `/auth/login` (email+password+recupero), `src/middleware.ts` di protezione route, identità risolta **server-side dalla sessione** (non da query param), unificazione identità (genitori autoritativi su `parents`+`student_parents`, `auth_user_id` su `utenti`), **nessuna auto-registrazione genitori**, legame `parent_id↔student_id` creato solo dalla Segreteria. Dettagli tecnici da fissare nello spec P0.
- **Impatto PRD:** annotati §Anagrafica §3 (RBAC), §Comunicazione §5 (Super-Admin), §Trasversale (nuova §5 Autenticazione e Accesso).
- **Alternative scartate:** mantenere il modello a query param (insicuro); magic-link only (preferito email+password per la pagina login da PRD).
- **Correzione (2026-06-25, da verifica DB live):** lo **staff è già auth-backed** — `utenti.id` ha FK → `auth.users(id)` (`utenti_id_fkey`), 10/10 staff presenti in `auth.users` (9 con password/confermati). Quindi **niente colonna `auth_user_id` su `utenti`** e niente backfill staff: per lo staff vale già `utenti.id = auth.uid()`. I **genitori reali** (92) vivono su `parents`/`student_parents`, **non** su `utenti(genitore)` (5 demo): `parents.id` è un uuid random **senza** FK ad auth, quindi si auth-backano aggiungendo **`parents.auth_user_id`** (la PK non si ripunta, è referenziata da `student_parents`). Le RLS pagamenti, oggi keyed sullo spazio `legame.genitore_id = auth.uid()`, vengono estese allo spazio `parents`/`student_parents` mantenendo il ramo legacy in `OR`. Strategia di transizione = **shim incrementale** dietro flag `ALLOW_HEADER_IDENTITY` (no big-bang).

### 2026-06-25 — DL-003 — [Fase P0] Attivazione RLS in produzione
- **Contesto:** 74 tabelle hanno RLS abilitata ma tutti gli endpoint usano `service_role` che la bypassa; le policy dev (`rls_policies_dev.sql`) sono aperte `TO anon`. In produzione la RLS è inattiva.
- **Decisione:** attivare la **RLS in produzione** (Fase P0): letture lato genitore via `createSessionClient()` (RLS applicata a DB, isolamento per figlio/sede); scritture staff via `service_role` **con audit obbligatorio** (`audit_scritture_docente`). Roll-out per famiglia-tabella su staging prima del prod; verifica con `get_advisors`.
- **Impatto PRD:** annotata §Trasversale §4 (Audit e Tracciabilità).
- **Alternative scartate:** RLS solo "teatro" via service_role ovunque (non conforme GDPR/multi-tenant).
- **Nota rollout (2026-06-25, da verifica):** la base RLS è pronta — `parents.auth_user_id` (S4) e le policy pagamenti additive per lo spazio `parents` (S7) sono applicate e verificate su dati reali (genitore vede solo i propri figli). Il **lockdown finale** (rimozione delle policy permissive `allow_all_*`/`TO anon`, S9) e l'attivazione delle letture genitore via `createSessionClient` (S8, helper `createParentReadClient` pronto dietro flag `PARENT_READS_USE_SESSION`) sono uno **step di rollout controllato**: vanno fatti DOPO l'onboarding dei genitori (login reale → sessione, via DL-005) e DOPO aver migrato le **letture anon dirette** del frontend (`alunni`/`legame_genitori_alunni`/`utenti`/`form_*`) verso API/policy `authenticated`. Attivarli prima romperebbe la produzione. Il sigillo `ALLOW_HEADER_IDENTITY='false'` (S13) chiude la fase.

### 2026-06-25 — DL-004 — [Fase P5] SIDI / Piattaforma Unica incluso come fase finale
- **Contesto:** il modulo Interoperabilità SIDI è nel PRD ma fuori dalle 5 fasi originali della roadmap (oggi ~2/12 requisiti implementati).
- **Decisione:** **incluso nel master plan come ultima fase (P5)**, dopo i moduli core, vincolato dall'accreditamento ministeriale e dalle tempistiche d'avvio anno scolastico.
- **Impatto PRD:** annotata §Interoperabilità SIDI (nota di pianificazione).
- **Alternative scartate:** parcheggiarlo come progetto separato (rischio di anagrafica non allineata al SIDI); solo ganci dati (rinviato del tutto il valore amministrativo).

### 2026-06-25 — DL-005 — [Fase P0] Recupero credenziali Segreteria-managed con invio automatico email
- **Contesto:** la pagina di login (spec P0) prevedeva un "password dimenticata" self-service. Non esiste oggi alcun login/reset reale; "Rigenera credenziali" è uno stub (solo toast). Per i genitori il modello è invite-only (nessuna auto-registrazione).
- **Decisione:** il recupero password è **gestito dalla Segreteria**, non self-service: un pulsante **"Rigenera credenziali"** dentro l'anagrafica del genitore (e del record staff) chiama un endpoint admin (`requireStaff`) che genera una nuova password random (`auth.admin.updateUserById`) e la **invia automaticamente via email** all'utente (riuso di `sendEmail`/Resend). **Niente "password dimenticata" self-service** sulla pagina di login. Coerente con l'impianto invite-only e con §Anagrafica §4.2.
- **Impatto PRD:** aggiornata §Anagrafica §4.2 (Recupero Credenziali), §Anagrafica §3 (riga Genitore), §Trasversale §5 (Autenticazione e Accesso).
- **Alternative scartate:** `resetPasswordForEmail` self-service di Supabase (scelta dall'utente: il recupero deve restare presidiato dalla Segreteria); reset senza invio email (più carico operativo, l'utente non riceve le credenziali).

### 2026-06-25 — DL-006 — [Fase P1] Libreria PDF = jsPDF (Puppeteer/PDFKit superati)
- **Contesto:** il PRD citava sia **Puppeteer** sia **PDFKit** per la generazione PDF; il codice però usa già **jsPDF** (`jspdf` + `jspdf-autotable`) per l'export moduli (`/api/forms/export/pdf`) e per la pagella (`src/lib/primaria/pagella-pdf.ts`).
- **Decisione:** la libreria PDF è **jsPDF**, riusata anche per la **ricevuta di firma** FEA (`src/lib/fea/receipt-pdf.ts`). Niente Puppeteer (headless Chrome: dipendenza pesante, costo cold-start serverless, gestione binario Chromium) né PDFKit. I riferimenti a Puppeteer/PDFKit nel PRD/roadmap sono **[SUPERATO]**.
- **Impatto PRD:** annotato §Form §4.1 e §5.3; coerente con DL-001 (ricevuta inattaccabile).
- **Alternative scartate:** Puppeteer (sovradimensionato/serverless-costoso); pdf-lib (nuova dipendenza, più verboso senza vantaggi qui).

### 2026-06-25 — DL-007 — [Fase P1] Modello firmatari FEA: una firma sufficiente, slot per entrambi
- **Contesto:** §Form §4.1 "Impostazioni FEA" prevede firma **singola o congiunta** di entrambi i genitori. Serviva fissare la regola di completamento.
- **Decisione:** il servizio FEA modella **N slot firmatari** (tabella additiva `fea_signatures`, 1 riga per slot, stato `pending/signed`). La **policy di completamento è configurabile**: default **`any-one`** (basta la firma di un genitore per completare), opzione **`all-required`** (richieste entrambe). Il modello prevede quindi la possibilità di entrambi i firmatari pur restando, di default, sufficiente una sola firma. Le colonne per-flusso esistenti (`pagella_ricezioni.firma`, `presenze.giustificazione_firma`, `form_submissions.signature_log`, `forms_submissions.signature_log`) restano source-of-truth del firmatario primario; `fea_signatures` è il ledger parallelo su cui si valuta la policy.
- **Impatto PRD:** annotato §Form §4.1 (Impostazioni FEA).
- **Alternative scartate:** solo firma singola (rework certo quando servirà la congiunta nel Form Builder P3); array JSON nelle colonne esistenti (niente stato per-slot né completamento parziale).

### 2026-06-25 — DL-008 — [Fase P1] Accessibilità: baseline + WCAG-AA come definition-of-done
- **Contesto:** L. 4/2004 (Legge Stanca)/AgID richiedono alto contrasto, ARIA/screen reader, WCAG. Esisteva solo un toggle alto-contrasto **locale alla pagina di login** (stato non persistito, non globale).
- **Decisione:** **baseline P1** = provider globale alto-contrasto (`src/lib/accessibility/`, persistito su cookie SSR-safe → `<html data-contrast>` senza FOUC) applicato a tutta l'app, set token CSS HC + focus-ring + `prefers-reduced-motion` in `globals.css`, primitive **Modal accessibile** (`role=dialog`/`aria-modal`/focus-trap/Escape/restore focus), landmark `nav`/`main` + skip-link, `aria-current` sulla navigazione, e **smoke test `jest-axe`** (login/modale OTP/nav). La conformità **WCAG-AA** diventa **definition-of-done** dei nuovi frontend; l'audit AA per-pagina dei moduli esistenti è applicato **incrementalmente** nelle fasi successive (non un audit big-bang in P1).
- **Impatto PRD:** aggiornati §Trasversale §2 (Accessibilità) e top-matter (riga Accessibilità AgID).
- **Alternative scartate:** audit WCAG 2.1 AA completo di ogni pagina ora (sconfina in P2-P4); solo toggle globale senza ARIA/focus/test (non difendibile come "alto contrasto + screen reader").

### 2026-06-25 — DL-009 — [Fase P1] Audit FEA su tabella dedicata `fea_audit_log`
- **Contesto:** serviva un'evidenza FES immutabile (CAD Art. 20 / DPR 445/2000) per tutti i flussi di firma. L'audit esistente `audit_scritture_docente` è **staff-scoped** (attore/ruolo docente, enum `azione insert/update/delete`, diff `valore_prima/dopo`): semantica incompatibile con la firma del genitore.
- **Decisione:** audit di firma su tabella **dedicata e immutabile `fea_audit_log`** (eventi `otp_sent`/`signed`/`verify_failed`, hash/IP/User-Agent), best-effort (un errore di audit non blocca la firma). Scritta da tutti i consumatori FEA (pagella, giustifica, forms-otp, wizard moduli).
- **Impatto PRD:** annotato §Trasversale §4 (Audit e Tracciabilità) e §Form §4.1.
- **Alternative scartate:** riuso di `audit_scritture_docente` (modello attore/azione errato); nessun audit dedicato (perdita dell'evidenza FES trasversale).

### 2026-06-25 — DL-010 — [Fase P1] `form_submissions` canonica, `forms_submissions` legacy (no migrazione dati)
- **Contesto:** coesistono due tabelle: **`form_submissions`** (usata dal wizard live `/api/forms/send-otp` + export PDF) e **`forms_submissions`** (path legacy onboarding/`persist-submission`). Il wizard live finora **non** salvava alcun `signature_log`.
- **Decisione:** **canonica = `form_submissions`**; `forms_submissions` resta **legacy**. Aggiunta colonna `signature_log JSONB` a `form_submissions` così anche il wizard registra l'evidenza FES canonica. **Nessuna migrazione dati** tra le due tabelle in P1 (consolidamento rinviato per non toccare un path di firma in produzione).
- **Impatto PRD:** annotato §Form §4.1.
- **Alternative scartate:** unificare/migrare i dati ora (rischio su un flusso di firma live, fuori scope P1); cambiare il meccanismo OTP del wizard (cambierebbe il contratto del client `OtpSignatureModal`).

### 2026-06-26 — DL-011 — [Fase P2] Crittografia Fascicolo: cifratura at-rest gestita (no AES applicativa)
- **Contesto:** il PRD §Fascicolo cita "crittografia AES-256" dei file sensibili (PEI/PDP/sanitari). La migrazione `20260630_fascicolo_rbac_audit.sql` aveva già scelto di demandare la cifratura a Supabase Storage (bucket privato `sensitive_documents` + signed URL TTL 60s + RBAC `puoAccedereFascicolo` + audit immutabile `fascicolo_accessi_audit`), senza crittografia applicativa.
- **Decisione:** il controllo "AES-256" è **soddisfatto dalla cifratura at-rest gestita** (Storage cifra at-rest in AES-256) + bucket privato + signed URL a TTL breve + RBAC + audit accessi. **Nessuna crittografia applicativa** (envelope/KMS): aggiungerebbe custodia chiavi a nostro carico e romperebbe lo streaming via signed URL, per un beneficio marginale dato l'accesso già mediato da API service_role. Lato UI restano da aggiungere il badge "Documento sensibile" (banner "Accesso tracciato" già presente) — slice sequenziato.
- **Impatto PRD:** §Fascicolo (sezione crittografia/sicurezza) + §6 Stato per area.
- **Alternative scartate:** envelope encryption applicativa AES-256 con KMS (XL, fuori core P2; eventualmente a carico committente per livello qualificato).

### 2026-06-26 — DL-012 — [Fase P2] Export ministeriale Presenze = registro mensile XLSX + PDF
- **Contesto:** per una scuola paritaria non esiste uno schema "ministeriale MIUR" unico per il registro presenze; il requisito era ambiguo. Esiste già un export **PDF** mensile (`MonthlyAttendanceTable.tsx`, jsPDF).
- **Decisione:** "Export ministeriale" = **registro mensile in XLSX + PDF**: griglia giorno×alunno con totali (presenze/assenze/ritardi/giustificate), layout istituzionale. XLSX via libreria **`xlsx`** (da verificare/aggiungere alla prima implementazione), PDF via jsPDF esistente. **Implementazione sequenziata** dopo il sottoinsieme "core compliance" di questa sessione.
- **Impatto PRD:** §Presenze (Export) + checklist `ROADMAP_GAP_2026`.
- **Alternative scartate:** tracciato XML SIDI (è P5/Interoperabilità, non Presenze); attendere un template dal committente (lo si potrà sostituire se fornito).

### 2026-06-26 — DL-013 — [Fase P2] Meccanismo "account sospeso" rinviato a P3
- **Contesto:** il requisito "persistenza visiva con account sospeso" presuppone un meccanismo di sospensione account che **non esiste** (nessun flag `sospeso` su `utenti`/`parents`, nessun gate auth) e che si sovrappone alla "sospensione account moroso" del modulo amministrativo/finanziario (P3).
- **Decisione:** il **meccanismo di sospensione** (flag + gate auth + stato UI read-only) è **materia di P3**; il requisito esce dallo scope P2 per non costruire mezzo meccanismo qui e rifarlo in P3.
- **Impatto PRD:** §Primaria Valutazione (nota di rinvio) + cross-ref §Pagamenti/Impostazioni P3 + §6 Stato.
- **Alternative scartate:** introdurre `sospeso` ora in P2 (anticipa lavoro P3 con rischio di disallineamento col modello morosità).

### 2026-06-26 — DL-014 — [Fase P2] Presa visione note → pattern FEA (OTP/FES) + `nota_ricezioni`
- **Contesto:** la firma di presa visione delle note disciplinari (interazione obbligatoria, PRD §Primaria) usava un semplice timestamp `note_disciplinari.firmata_il` via `POST /api/parent/primaria/note`, **senza** evidenza FES (IP/hash/audit).
- **Decisione:** la presa visione adotta lo **stesso pattern della pagella** (DL-006/007/009): OTP email (FES) → `buildSignatureLog` salvato in nuova tabella **`nota_ricezioni`** (`UNIQUE(nota_id, genitore_id)`, RLS service+read) + slot firmatari `fea_signatures` (`entita_tipo='nota'`) + audit immutabile `fea_audit_log`. Nuove route `POST /api/parent/primaria/note/firma` (+ `/firma/otp`); il vecchio `POST /api/parent/primaria/note` risponde **410** (deprecato). `note_disciplinari.firmata_il`/`firmata_da` restano valorizzati per retro-compat con la vista genitore.
- **Impatto PRD:** §Primaria (Note disciplinari, presa visione) + §6 Stato.
- **Alternative scartate:** mantenere il timestamp semplice (privo di valore probatorio FES); riusare `pagella_ricezioni` (semantica/entità diversa).

### 2026-06-26 — DL-015 — [Fase P2] Valutazione in itinere legata a ≥1 obiettivo (enforcement condizionale)
- **Contesto:** il PRD chiede la valutazione in itinere "legata a ≥1 obiettivo di apprendimento" (O.M. 172/2020). Il codice usava `argomento` (testo libero obbligatorio) **al posto** dell'obiettivo strutturato; la tabella `valutazione_obiettivi` esisteva ma quasi inutilizzata (1 riga). Su DB live **1 scuola ha 7 obiettivi** configurati (italiano/matematica/storia/geografia, livelli 1/3).
- **Decisione:** reintrodurre il collegamento strutturato a `valutazione_obiettivi` con **enforcement CONDIZIONALE**: ≥1 obiettivo obbligatorio **solo quando la scuola ha obiettivi configurati** per quella (materia, livello) — stesso filtro del selettore docente, estratto nel helper unico `src/lib/primaria/obiettivi.ts` (`obiettiviDisponibili`). Se non ce ne sono, **fallback su `argomento`** (sempre obbligatorio): non blocca le scuole senza curricolo seminato. `POST /api/primaria/valutazioni` valida ed inserisce le righe link; la UI docente mostra i checkbox obiettivi quando disponibili.
- **Impatto PRD:** §Primaria Valutazione + §6 Stato.
- **Alternative scartate:** enforcement rigido sempre (bloccherebbe le scuole senza obiettivi); considerare `argomento` sufficiente (non soddisfa il vincolo normativo dove il curricolo esiste).

### 2026-06-26 — DL-016 — [Fase P2] Panic Alert: notifica simultanea Segreteria/Direzione + genitore (push P1)
- **Contesto:** `POST /api/panic-alert` registrava solo il flag `presenze.panic_alert=true`, **senza** alcuna notifica (requisito PRD §Presenze: allerta istantanea simultanea Segreteria + App Genitore).
- **Decisione:** dopo il salvataggio, **notifica best-effort** via servizio push P1: a tutto lo **staff del plesso** dell'alunno con ruolo `segreteria`/`admin`/`coordinator` (`enqueueNotifiche`, `bufferMin:0`) **e** ai **genitori** dell'alunno (`enqueueNotifichePerAlunni`, `bufferMin:0`). Un errore di notifica **non invalida** il Panic Alert salvato. *(Il blocco-uscita UI + banner genitore + clear-con-audit restano slice sequenziati.)*
- **Impatto PRD:** §Presenze (Panic Alert) + §6 Stato.
- **Alternative scartate:** notifica solo Segreteria (il genitore deve essere allertato); risoluzione genitori via `student_parents` (incoerente con il resto delle notifiche primaria, che usano `legame_genitori_alunni` — allineamento rinviato a P0/rollout).

### 2026-06-26 — DL-017 — [Fase P3] Fatturazione Elettronica = integrazione REALE Aruba (REST), niente mock
- **Contesto:** il modulo Fatturazione (Aruba/SDI) era **1/11** — `src/lib/aruba/client.ts` era uno **stub** che restituiva sempre un esito `MOCK-…` "emessa", senza alcuna chiamata di rete. La P3.1 (slice "Aruba a sé") chiude la lacuna più compliance-critica.
- **Decisione:** sostituire lo stub con un **client REST reale** verso le API Aruba "Fatturazione Elettronica" (Bearer token: `POST /auth/signin` grant_type=password → access/refresh; `POST /services/invoice/upload` con `dataFile` base64; `GET /services/invoice/out/getByFilename` per stato/PDF). Credenziali **mai esposte al client**: username dal config, password risolta lato server da `process.env` via `password_ref` (env/vault). Ambiente DEMO/PROD da `aruba_config.ambiente`. Se Aruba non è configurato/credenziali assenti l'emissione ritorna **503 esplicito** (non più "successo finto"). Tutto il core è **TDD** mockando il boundary HTTP; la verifica live end-to-end con lo SDI resta **gated** sulle credenziali Aruba (DEMO per i test, PROD per l'esercizio) del committente — dipendenza esterna documentata (come SIDI in P5).
- **Impatto PRD:** §Fatturazione Elettronica (Aruba) §2/§5 + §Impostazioni §5.3 + §6 Stato. File: `src/lib/aruba/{client,fatturapa-xml,stato,emissione}.ts`, `src/app/api/pagamenti/fattura/{route,sync/route}.ts`, migrazione `20260741_aruba_fatturazione.sql`.
- **Alternative scartate:** mantenere il mock (non chiude i gap); integrazione reale "a scatola chiusa" senza confine testabile (non verificabile né TDD).

### 2026-06-26 — DL-018 — [Fase P3] Profilo fiscale FatturaPA = B2C privati (FPR12, IVA 0% Natura N4, no bollo)
- **Contesto:** gli intestatari fattura sono **persone fisiche** (genitori), non titolari di P.IVA/SDI; servizi scolastici esenti.
- **Decisione:** tracciato `FatturaElettronicaPrivati` **FPR12**, `TipoDocumento` **TD01**, `CodiceDestinatario` **0000000** (recapito via SDI nel cassetto fiscale, nessuna PEC per il privato). Regole fisse: **IVA 0% / Natura N4** "esente art. 10 DPR 633/1972", **nessuna marca da bollo**. `IdTrasmittente` = **Aruba PEC `01879020517`** (obbligatorio sul canale API, altrimenti errore 0094). `CedentePrestatore` dai dati fiscali scuola (`aruba_config.fiscal` + `RegimeFiscale`), `CessionarioCommittente` dall'intestatario (`alunni.intestatario_fatture.adult_id` → `parents`: CF, nome/cognome, residenza). Generatore XML in-house (`src/lib/aruba/fatturapa-xml.ts`), golden-file testato.
- **Impatto PRD:** §Fatturazione Elettronica §3/§4. **Alternative scartate:** FatturaPA PA (FPA12, ente pubblico — qui il cedente è privato); applicare IVA/bollo (contrario al regime esente scolastico).

### 2026-06-26 — DL-019 — [Fase P3] Numerazione interna per (scuola, anno fiscale)
- **Contesto:** il PRD §4 cita "numerazione delegata ad Aruba"; via **API `upload`** però il `<Numero>` deve già essere nell'XML (l'auto-numerazione è solo del pannello web Aruba).
- **Decisione:** Kidville genera una **sequenza monotòna per (scuola, anno)** persistita in `fatture_numerazione` via funzione `prossimo_numero_fattura()` (upsert con lock riga, `SECURITY DEFINER`, EXECUTE revocato ad anon/authenticated → solo `service_role`); il numero è scritto in `fatture_emesse.numero` e nell'XML. Lo **SDI assegna l'IdentificativoSDI** lato Aruba (memorizzato come `aruba_filename`/`fattura_aruba_id`). **Riconcilia** (e supera per il canale API) la dicitura PRD "delegata ad Aruba".
- **Impatto PRD:** §Fatturazione Elettronica §4 (annotato). **Alternative scartate:** lasciare la numerazione ad Aruba via API (non supportato dall'endpoint upload).

### 2026-06-26 — DL-020 — [Fase P3] Scarti SDI via polling cron + notifica realtime Segreteria + copia cortesia PDF
- **Contesto:** Aruba elabora in modo **asincrono** (entro 24h); lo stato SDI (scarto/consegna) arriva dopo l'upload. Requisito PRD §5: intercettare gli **scarti SDI** con motivo + alert Segreteria; copia di cortesia PDF per il genitore.
- **Decisione:** endpoint **service-to-service** `POST /api/pagamenti/fattura/sync` (gate `x-cron-secret`, pattern `push/dispatch`) schedulato via **pg_cron** (`fatture-sdi-sync`, ogni 30′, `pg_net` con GUC `app.fattura_sync_url`/`app.cron_secret`). Per ogni fattura non terminale interroga Aruba e mappa gli stati 1..10 sullo stato interno (`src/lib/aruba/stato.ts`): validi-SDI (6/7/8/10) → **emessa**; scarti (2 errore, 4 NS, 9 rifiuto) → **scartata**; in volo (1/3/5) → **in_attesa**. Su scarto **accoda notifica realtime** allo staff del plesso (`enqueueNotifiche` P1, tipo `fattura_scartata`) + **banner** su `/admin/pagamenti`. Su stato valido recupera il **PDF di cortesia** (`includePdf`) e lo salva nel bucket privato `fatture` (servito al genitore da `GET /api/pagamenti/fattura` con fallback all'anteprima). Stato pagamento UI: `in_attesa` → "In attesa SDI", `emessa` → download.
- **Impatto PRD:** §Fatturazione Elettronica §5 + §6 Stato. **Alternative scartate:** webhook Aruba (più complesso da accreditare; polling riusa l'infra cron esistente); attesa sincrona (Aruba è asincrona entro 24h).

### 2026-06-26 — DL-021 — [Fase P3] Sospensione account moroso = soft per-alunno (no login block)
- **Contesto:** la "sospensione manuale account moroso" (PRD §Pagamenti §3.2: "inibizione delle funzioni app", azione consapevole della **Direzione**) e la "persistenza visiva con account sospeso" (DL-013) richiedevano un meccanismo inesistente.
- **Decisione:** flag **per-alunno** su `alunni` (`sospeso` + `sospeso_motivo`/`sospeso_il`/`sospeso_da`, migr. `20260742`), impostato solo dalla **Direzione** (`POST /api/admin/pagamenti/sospensione`, `requireStaff(['admin','coordinator'])` + scope tenant + audit `logScrittura`). La sospensione è **soft**: il genitore **accede e legge** (presenze/diario/comunicazioni/pagamenti restano visibili — sicurezza del minore preservata), vede un **banner** "account sospeso per morosità" (`StoricoPagamenti`) + badge admin (`PaymentsDashboard`); le **azioni di servizio** sono inibite tramite guard riusabili `src/lib/pagamenti/sospensione.ts` (`assertAlunnoNonSospeso`/`assertGenitoreNonSospeso`). *Enforcement applicato:* nuove **firme/compilazioni moduli** (`POST /api/forms/send-otp` → 403). **Giustifiche/comunicazioni/diario NON bloccati** (child-safety): raffinamento dichiarato di "inibizione funzioni app"; il guard è pronto per estendere ad altre azioni commerciali.
- **Impatto PRD:** §Pagamenti §3.2/§4, §Primaria Valutazione (chiude il rinvio DL-013), §6 Stato. **Alternative scartate:** blocco di login (blocca info di sicurezza sul minore); flag per-genitore (la morosità è per-alunno; il guard genitore deriva comunque dai figli).

### 2026-06-26 — DL-022 — [Fase P3] Vista genitore pagamenti raggruppata per categoria
- **Contesto:** PRD §4.1 chiede la categorizzazione (Rette/Iscrizione/Mensa/Divisa/Materiale); la UI mostrava un elenco piatto Da pagare / Pagati.
- **Decisione:** raggruppamento per `payment_categories` con helper **puro** `raggruppaPerCategoria` (`src/lib/pagamenti/categorie.ts`, golden-tested): un gruppo per categoria (icona/colore), "Altro" in coda, split da-pagare/pagati interno. `StoricoPagamenti` consuma il payload `/api/pagamenti` (già con `payment_categories`).
- **Impatto PRD:** §Pagamenti §4.1 + §6 Stato. **Alternative scartate:** tab per categoria (più click; le sezioni in colonna sono più leggibili su mobile).

### 2026-06-26 — DL-023 — [Fase P3] Ricevuta locale non fiscale, distinta dalla fattura elettronica
- **Contesto:** PRD §3.1 cita "Invia Fattura/Ricevuta"; serviva una ricevuta scaricabile anche quando non si emette la fattura elettronica Aruba.
- **Decisione:** `GET /api/pagamenti/ricevuta?pagamento_id=` genera una **ricevuta PDF non fiscale** (jsPDF) per qualunque pagamento **saldato**, con scoping staff/genitore; indipendente da Aruba e dallo stato `fattura_stato`. UI: pulsante "Ricevuta" sul pagamento saldato (`StoricoPagamenti`), affiancato al "Fattura" (quando emessa).
- **Impatto PRD:** §Pagamenti §3.1/§4 + §6 Stato. **Alternative scartate:** riusare il PDF Aruba (è il documento fiscale, non sempre disponibile/voluto).

### 2026-06-26 — DL-024 — [Fase P3] Logica condizionale form: singola condizione, valutata a runtime
- **Contesto:** `FormField.condition` esisteva nello schema ma **non veniva mai valutata** — il wizard mostrava tutti i campi e l'editor non la configurava (condizioni "morte").
- **Decisione:** mantenuto il modello a **singola condizione** per campo (backward-compatible, niente migrazione). Motore **puro** `src/lib/forms/conditional.ts` (`valutaCondizione`/`campoVisibile`/`campiVisibili`/`pulisciNascosti`), operatori `eq/neq/contains/gt/lt`. **Runtime:** `StepRenderer` filtra i campi visibili (`useWatch`); `WizardContainer` valida solo i visibili (un campo nascosto, anche obbligatorio, non blocca) e **rimuove i valori nascosti** dalla submission. **Editor:** `PropertiesPanel` con toggle + select campo/operatore/valore (`campiDisponibili` dalla builder page). 10 test golden sul motore.
- **Impatto PRD:** §Form §4.1 (Form Builder) + §6 Stato. **Alternative scartate:** multi-condizione AND/OR (estende schema + editor; rimandata a una sotto-slice successiva).

### 2026-06-26 — DL-025 — [Fase P3] Delibera ammissioni (auto soglia+posti) + applicazione scoring; ETL deferito
- **Contesto:** mancavano lo **stato di ammissione** (ammesso/non/lista) e l'export delibera. Inoltre la migrazione `20260528` (scoring + ETL) **non era applicata in live** (assenti `score`/`manual_adjustments` su `form_submissions`) → le graduatorie non potevano funzionare.
- **Decisione:** (1) **Applicata la parte SCORING** di 20260528 (migr. `20260743`): colonne `score`/`manual_adjustments`, calcolo (`calc_form_base_score`/`calc_manual_delta` con `search_path` fisso), trigger BEFORE, indice, backfill → graduatorie operative. (2) **Esito ammissione** su `form_submissions` (`esito_ammissione` CHECK ammesso/lista_attesa/non_ammesso + `esito_il`/`esito_da`/`esito_note`). (3) **Motore puro** `src/lib/forms/delibera.ts` (`calcolaDelibera`): top-N sopra soglia = ammessi, sopra soglia oltre i posti = lista d'attesa, sotto soglia = non ammessi. (4) `POST /api/forms/delibera` (bulk per `modelId`+posti+soglia, e override singolo `submissionId`+esito) gated `requireStaff`. (5) **Export PDF** `GET /api/forms/export/delibera`. (6) UI `RankingTable`: badge esito + barra delibera (posti/soglia/applica/Esporta PDF) + override nel modale. 13 test.
- **⚠️ ETL deferito:** il trigger **ETL form→anagrafiche** di 20260528 è stato **escluso** perché referenzia tabelle **inesistenti in live** (`adults`/`student_adults` vs `parents`/`student_parents`, drift) — applicarlo romperebbe il completamento dei moduli d'iscrizione. Va riscritto sulle tabelle reali in una slice dedicata.
- **Impatto PRD:** §Form §4.1 (Scoring/Graduatorie) + checklist `/admin/forms/rankings` + §6 Stato. **Alternative scartate:** delibera solo manuale (la soglia+posti è il requisito); applicare l'ETL così com'è (romperebbe le iscrizioni).

### 2026-06-26 — DL-026 — [Fase P3] Fix ETL form→anagrafiche: `adults`/`student_adults` → `parents`/`student_parents`
- **Contesto:** il trigger `fn_form_submission_etl` (migr. 20260528) inseriva in `adults`/`student_adults` — **tabelle inesistenti in live** → al completamento di un modulo d'iscrizione sarebbe fallito (per questo era stato **deferito** in DL-025).
- **Decisione:** riscritto sulle tabelle **reali** (migr. `20260744`): **parents** (`id gen_random_uuid()`, nessuna FK ad auth → le pre-iscrizioni hanno `auth_user_id` NULL; upsert su `fiscal_code`), **alunni** (guard sui NOT NULL `nome`/`cognome`/`data_nascita`; match su `codice_fiscale` o `nome+cognome+data`; `scuola_id` default), **student_parents** (PK `(student_id,parent_id)`, `ON CONFLICT DO NOTHING`). I `db_mapping` sono raccolti in JSONB per-tabella e **tradotti** sulle colonne reali (`address→residence_address`, `phones→phone_numbers` come ARRAY, `birth_place→birth_city`); l'INSERT legge **solo colonne esistenti** (chiavi extra ignorate). Gestisce sia i prefissi `adults.*` (preset del builder) sia `parents.*` (template iscrizione). **Best-effort** (gli errori anagrafici non bloccano il completamento del modulo). **Verificato con dry-run d'integrazione sul DB live** (alunno+genitore+legame creati, wrapping ARRAY e traduzioni corretti) e poi ripulito.
- **Impatto PRD:** §Form §4.1 (ETL form→anagrafiche) + §Anagrafica + §6 Stato. Completa il deferral di DL-025.
- **Alternative scartate:** ETL applicativo in TS (il trigger DB garantisce coerenza transazionale al completamento); legare `parents.id` ad `auth.users` (le pre-iscrizioni non hanno ancora un account).

### 2026-06-26 — DL-027 — [Fase P3] Certificato medico self-service: upload genitore → validazione Segreteria
- **Contesto:** la tabella `certificati_medici` (20260526) **non era applicata in live** (drift), con `caricato_da` FK ad `auth.users` e `giorni_coperti DATE[]` "popolati dall'insegnante"; le route erano **stub pre-auth** (`parent_id` hardcoded, nessun upload file, nessuno stato di validazione).
- **Decisione:** schema corretto (migr. `20260745`): copertura come **periodo** `data_inizio`/`data_fine`, **stato** (`in_validazione`/`validato`/`rifiutato`), `validato_da`/`validato_il`/`nota_validazione`; `caricato_da` **senza FK** (identità dalla sessione); **bucket privato** `certificati-medici` (dato sanitario) + RLS con staff-read. Il **genitore carica** (multipart: file→bucket + periodo) via `POST /api/parent/medical-certificates` (`requireUser` + scope `legame_genitori_alunni`) → stato `in_validazione`; la **Segreteria valida/rifiuta** via `PATCH /api/teacher/medical-certificates` (`requireStaff` + audit `logScrittura`, può correggere il periodo); **download scoped** `GET …/file` (staff o genitore collegato). UI: form upload genitore (file + dal/al) + modale di validazione staff (apri documento, Valida/Rifiuta + nota). Helper puro `periodoValido`/`isEsitoValidazione`. **Nessun sollecito automatico sui certificati** (scelta di prodotto esplicita).
- **Impatto PRD:** §Modulistica (certificato medico) + §6 Stato. **Alternative scartate:** `giorni_coperti` array (il periodo dal/al è più chiaro per un certificato); solleciti automatici (esclusi per scelta).

### 2026-06-26 — DL-028 — [Fase P3] Staff RBAC: gestione ruoli/sede/classi riservata alla Direzione
- **Contesto:** `utenti.ruolo` è testo libero e non esisteva alcun pannello per gestire il personale; PRD §Impostazioni §2 chiede la "Gestione Staff (RBAC)".
- **Decisione:** `GET/PATCH /api/admin/staff` **gated alla Direzione** (`requireStaff(['admin','coordinator'])`). Il PATCH aggiorna `ruolo`/`scuola_id`/`gradi` e **rimpiazza** le assegnazioni classi (`utenti_sezioni`), con **audit** `logScrittura` (`staff_rbac`). Ruoli **assegnabili**: `educator` (Docente)/`segreteria`/`cuoca`/`coordinator` (Direzione)/`admin` — **NON `genitore`** (helper puro `src/lib/auth/ruoli.ts`). **Self-lockout guard**: la Direzione non può cambiare il proprio ruolo. La **creazione di nuovi account** (provisioning auth) **non è in scope** (resta il flusso invito/credenziali DL-005). UI: pannello `/admin/staff` (lista + edit ruolo/sede/classi). Nessuna migrazione (tabelle esistenti).
- **Impatto PRD:** §Impostazioni §2 (Gestione Staff RBAC) + §6 Stato. **Alternative scartate:** consentire alla Segreteria di assegnare ruoli (rischio di escalation → ristretto alla Direzione); creare account auth in questo slice (separato, via invito).

### 2026-06-26 — DL-029 — [Fase P3] Blocchi Consensi & Allegati nel Form Builder + upload generico server-side
- **Contesto:** il Form Builder (Sistema A `form_models.schema`) aveva già il blocco `file` ma **nessun blocco Consensi**; PRD §Form §4.1 chiede i "Componenti Dinamici" inclusi **Consensi** e **Caricamento Allegati**. Esplorazione live: l'upload allegati nel wizard **autenticato** era **rotto** (`storage.objects` ha zero policy → bucket deny-by-default; il client browser è anon e non può scrivere), e anche l'insert submission non-firma falliva (RLS `form_submissions` richiede sessione Supabase Auth, assente nel modello identità app-level). La route `/api/admin/form-models` era **ungated**.
- **Decisione:** (1) Nuovo tipo campo **`consent`** (`FormField.text`/`link`/`link_label`): reso da `FieldRenderer` come testo+link+**una checkbox** (se obbligatorio il wizard blocca finché non spuntata), configurabile nel builder (palette "Consensi/Privacy" + `PropertiesPanel`). **1 blocco = 1 consenso**. (2) **Evidenza legale GDPR**: helper puro `src/lib/forms/consensi.ts` (`estraiConsensi`/`consensiObbligatoriMancanti`) → **snapshot** `{field_id,label,text?,link?,accepted,accepted_at}` archiviato in `form_submissions.consents_log` (migr. `20260746`), popolato server-side da `send-otp` e dal nuovo `POST /api/forms/submit` (path senza firma, service-role, sostituisce l'insert client rotto). Guard server-side: consenso obbligatorio non accettato → 400. (3) **Upload generico** `POST /api/forms/upload` (service-role, `requireUser` + rate-limit, validazione tipo/dimensione, `form_attachments/models/{modelId}/…`), cablato nel wizard autenticato (`StepRenderer`). (4) Rifinitura blocco **Allegati**: `accept`/`max_size_mb` configurabili. (5) **Gate** `requireStaff` su `POST/PATCH /api/admin/form-models`.
- **Sicurezza allegati:** **service-role + scoping app** (coerente con tutto l'app e con P0): bucket privati, accesso solo via endpoint server-role; **nessuna** policy `storage.objects`. La variante upload **pubblica** (token-scoped per modello pubblicato) è rimandata alla slice "Pubblica modello".
- **Impatto PRD:** §Form §4.1 (Componenti Dinamici, Caricamento Allegati) + §6 Stato. **Test:** `consensi.test.ts` (7), `forms-upload.test.ts` (5), `forms-submit.test.ts` (4), `form-models-gate.test.ts` (4), `forms-send-otp-consensi.test.ts` (2) — tutti verdi; advisors security+performance **0 ERROR**. **Alternative scartate:** policy RLS esplicite su `storage.objects` (introduce un modello d'accesso diverso dal resto dell'app); blocco Consensi multi-checkbox (valore/evidenza più complessi → 1-blocco-1-consenso); consenso registrato solo come boolean senza snapshot (debole come evidenza legale).

### 2026-06-26 — DL-030 — [Fase P3] Pubblica modello + link pubblico + config accessi + submission pubblica
- **Contesto:** PRD §Form §4.1 chiede "Pubblica modello" + "Configurazione Accessi (registrati / link pubblico)". I `form_models` (Sistema A, builder) non avevano stato di pubblicazione né link; la compilazione pubblica esisteva solo per l'iscrizione hardcoded (`/iscrizione` → `EnrollmentWizard`). `/admin/modulistica` gestisce il sistema **legacy** `forms_templates`, distinto.
- **Decisione:** colonne `published_at` (NULL=bozza), `public_token` (uuid unico **stabile** tra unpublish/republish), `access_mode` (`public`|`authenticated`, default `public`) su `form_models` (migr. `20260747`). `POST /api/admin/form-models/publish` (gated `requireStaff`): publish genera/riusa token + `published_at` → ritorna link `/m/{token}`; unpublish azzera `published_at` (token preservato). Pagina pubblica **`/m/[token]`** (server component, carica via service-role; `notFound` se non pubblicato; schermata "accesso riservato" se `authenticated` senza sessione) che rende `WizardContainer` in **modalità pubblica** (`publicToken`, anonimo, **firma OTP disattivata**). Endpoint **token-scoped** anonimi `POST /api/public/forms/[token]/submit` (valida pubblicato+`public`; guard consensi obbligatori→400; `completed`+`consents_log`) e `…/upload` (validazione tipo/dimensione, `form_attachments/public/{token}/…`). Middleware: `PUBLIC_PREFIXES += '/m','/api/public'`. Builder: pannello **Pubblica/Copia link** + toggle accesso; le fetch admin del builder inviano ora `x-user-id` (id admin dev `…555555555555`).
- **Submission pubblica = senza firma:** l'intake pubblico (iscrizioni/sondaggi) non usa OTP; la **firma** pubblica (raccolta email del firmatario) è rinviata alla slice firma congiunta. Sicurezza: token-scoped + service-role + rate-limit (coerente DL-029).
- **Impatto PRD:** §Form §4.1 (Configurazione Accessi) + §6 Stato. **Test:** `publish.test.ts` (5), `middleware-rules.test.ts` (esteso `/m`,`/api/public`), `form-models-publish.test.ts` (5), `public-forms-submit.test.ts` (5), `public-forms-upload.test.ts` (4) — verdi; advisors **0 ERROR**. **Alternative scartate:** rigenerare il token a ogni pubblicazione (romperebbe i link già condivisi → token stabile); riusare l'insert client-side per il pubblico (bloccato da RLS → endpoint server-role); pubblicare i `forms_templates` legacy (sistema distinto, in via di dismissione).

### 2026-06-26 — DL-031 — [Fase P3] Firma congiunta (2° firmatario) + reinvio OTP
- **Contesto:** PRD §Form §4.1 chiede "firma singola o congiunta di entrambi i genitori" + "reinvia OTP". `/api/forms/send-otp` gestiva **un solo** firmatario con completamento immediato; l'infra FEA P1 (slot `fea_signatures`, policy `all-required` DL-007, `ReceiptPayload.slots`) era già predisposta ma inutilizzata per i moduli.
- **Decisione:** colonna **`signature_mode`** (`single`|`joint`, default `single`) su `form_models` (migr. `20260748`), impostata dal builder quando lo schema contiene un blocco Firma. Helper puro `src/lib/fea/firma-congiunta.ts` (`firmatariRichiesti`/`firmaCompleta`/`prossimoSlot`). **`POST /api/forms/send-otp`** con `submissionId` = **reinvio/2° firmatario** (rigenera `otp_secret`, invia a `signerEmail` o all'email del `user_id`; NON crea una nuova submission). **`PATCH`** ora **slot-aware**: indice slot = #slot già firmati (`getSlots`), `recordSignerSlot(slotIndex, policy)` con `policy = joint? all-required : any-one`; carica `signature_mode` e completa (`status=completed`) **solo** quando `firmaCompleta(mode, firmati+1)` — altrimenti resta `pending_signature` e risponde `{ completed:false, needsMoreSigners:true, signedSlots, requiredSigners }`. **2° firmatario email-only** (slot `signer_user_id` null ammesso). UI `OtpSignatureModal`: bottone **"Reinvia codice"** (cooldown 30s) + step **"2° genitore"** (email → invio → verifica); il builder mostra il toggle **Firma singola/congiunta**.
- **Retro-compat:** senza `signature_mode` (default `single`) il flusso completa al 1° codice come prima — i test di caratterizzazione send-otp restano verdi.
- **Impatto PRD:** §Form §4.1 (Impostazioni FEA) + §6 Stato. **Test:** `firma-congiunta.test.ts` (4), `forms-send-otp-firma-congiunta.test.ts` (5: reinvio 404/ok, joint 1°→pending, joint 2°→completed, single→completed) — verdi (17 test send-otp totali); advisors **0 ERROR**. **Alternative scartate:** firma parallela con OTP simultanei ai due genitori (più complessa, rischio di codici incrociati → sequenziale); >2 firmatari (YAGNI); firma OTP sui form **pubblici** (rinviata: richiede raccolta strutturata dell'email del firmatario anonimo).

### 2026-06-26 — DL-032 — [Fase P3] Proxy upload cartaceo reale (modulistica)
- **Contesto:** PRD §Form (Gite) prevede l'acquisizione del modulo **cartaceo** firmato a penna consegnato a scuola. `POST /api/teacher/modulistica` era uno **stub**: accettava `file_path` come **stringa** (nessun upload reale su Storage), **ungated** (`teacher_id` dal body), `signature_log` ad-hoc. Il **merge PDF di classe** (`/api/admin/documents-merge` + `handleExportMergePDF`) esisteva già come report cumulativo.
- **Decisione:** riscrittura del POST come **upload reale multipart**: `requireDocente` (educator/admin/coordinator/segreteria), validazione tipo/dimensione, file salvato in `form_attachments/cartaceo/{form_id}/…` (service-role), sottomissione `forms_submissions` con `is_signed=true`, **`origine='cartaceo'`** (nuova colonna, migr. `20260749`, CHECK `online|cartaceo`), `pdf_path` reale, **evidenza strutturata** (`signature_log` `{method:'PROXY_CARTACEO', acquisito_da, ip, user_agent, timestamp, compliance}` — **non** finge una FES digitale) + **audit** `logScrittura('modulistica_cartaceo')`. UI teacher: il modal tiene il **File** reale e invia `FormData`. Il merge PDF marca **"(CARTACEO)"** vs "FES FIRMATA DIGITALMENTE".
- **Impatto PRD:** §Form (Widget Form/Gite) + §6 Stato. **Test:** `teacher-modulistica-proxy.test.ts` (5: 401/400×3/201 con upload `cartaceo/`+`origine`+audit) — verdi; advisors **0 ERROR**. **Sollecito firme docente:** resta un toast informativo (nessun cron automatico, per regola di prodotto). **Alternative scartate:** mantenere il path-stringa (nessuna prova del documento); gate `requireStaff` solo Segreteria (la maestra acquisisce alla porta → `requireDocente`); concatenare i PDF reali nel merge (richiede `pdf-lib`; il merge resta report cumulativo).

### 2026-06-26 — DL-033 — [Fase P3] Multi-Sede CRUD (registry scuole)
- **Contesto:** PRD §Impostazioni chiede "Gestione Multi-Sede (aggiungi/rinomina/disattiva, config isolata)". In live **non esisteva** una tabella sedi: lo `scuola_id` era un **UUID hardcoded** (`11111111-…`) usato come soft-reference in `sections`/`utenti`/`alunni` (1 sola sede).
- **Decisione:** creata la tabella registry **`scuole`** (migr. `20260750`: `id, nome, citta, indirizzo, attiva, config jsonb, timestamps`) con **seed** della sede esistente (`ON CONFLICT DO NOTHING`). `GET/POST/PATCH /api/admin/schools` **gated alla Direzione** (`requireStaff(['admin','coordinator'])`, coerente con Staff RBAC DL-028) per **aggiungi / rinomina / disattiva** (soft `attiva=false`, **non** hard-delete) + aggiornamento `config` isolata, con **audit** `logScrittura('multi_sede')`. Helper puro `src/lib/scuole/validate.ts` (`validaNomeScuola`/`normalizzaScuola`). UI `/admin/schools` + `SchoolsPanel` (lista, aggiungi, rinomina inline, toggle attiva), gate Direzione lato server, fetch con `x-user-id`.
- **Scope/sicurezza:** **nessuna FK** su `scuola_id` (additivo e sicuro; resta soft-reference — la migrazione dati/FK è rinviata). La tabella `scuole` eredita il modello del progetto (RLS auto-abilitata da `rls_auto_enable`, **nessuna policy** → accesso solo via endpoint service-role gated; advisor `rls_enabled_no_policy` di livello **INFO**, come tutte le tabelle esistenti). **Hard-delete di una sede** fuori scope (pericoloso → eventualmente via diritto all'oblio).
- **Impatto PRD:** §Impostazioni §1 (Gestione Multi-Sede) + §6 Stato. **Test:** `scuole-validate.test.ts` (5), `schools-route.test.ts` (9: gate GET/POST/PATCH, nome vuoto, 404, crea+rinomina+disattiva+audit) — verdi; advisors **0 ERROR**. **Alternative scartate:** aggiungere subito FK + migrazione dati su tutte le tabelle `scuola_id` (invasivo/rischioso → soft-reference); hard-delete sede nel CRUD (distruttivo → solo soft-disable); gate `['admin']` puro (allineato a "Direzione" DL-028 = admin+coordinator).

### 2026-06-27 — DL-034 — [Fase P3] GDPR diritto all'oblio (anonimizzazione)
- **Contesto:** PRD §Impostazioni chiede "diritto all'oblio / hard delete GDPR". L'alunno è referenziato in ~20 tabelle operative (FK) + file storage; esistono audit immutabili e registri fiscali con obblighi di conservazione.
- **Decisione (flusso a 2 passi, fissato con l'utente):** **(1)** lista candidati `GET /api/admin/gdpr/candidates` = `alunni` con `stato <> 'iscritto'` e `anonimizzato_il IS NULL` + genitori collegati (via `student_parents`); **(2)** `POST /api/admin/gdpr/erase` = cancellazione definitiva come **SOLA ANONIMIZZAZIONE** (nessuna DELETE di righe → zero rischio FK): i campi PII di `alunni` (e dei `parents` **orfani**, cioè senza altri figli iscritti) vengono sovrascritti con placeholder deterministico `CANCELLATO-{hash}` e marcati `anonimizzato_il` (migr. `20260751`); l'`auth_user_id` del genitore viene sganciato; i **file PII** del soggetto vengono rimossi dallo storage (binari non anonimizzabili) **escluso il bucket `fatture`**. **Preserva audit + fisco** (`audit_scritture_docente`/`fascicolo_accessi_audit`/`sblocchi_audit`/`registro_modifiche` e `pagamenti`/`fatture_emesse`): righe intatte, de-identificate perché l'anagrafica a cui puntano è anonimizzata (GDPR art.17(3)(b)). **Sicurezza:** **dry-run** (conteggi senza scrivere) + **doppia conferma** (`confirm` = `COGNOME NOME`, via `confermaValida`), **rifiuto** se l'alunno è ancora iscritto (409), gate **Direzione**, audit `logScrittura('gdpr_oblio')`. Helper puri `src/lib/gdpr/anonimizza.ts` (`placeholderFor`/`patchAlunno`/`patchParent`/`nomeConferma`/`confermaValida`) + `src/lib/gdpr/orfano.ts`. UI `/admin/gdpr` (`OblioPanel`): lista + modale con anteprima dry-run e campo di conferma.
- **Impatto PRD:** §Impostazioni (Diritto all'oblio) + §6 Stato. **Test:** `gdpr-anonimizza.test.ts` (6), `gdpr-erase-route.test.ts` (7: gate/404/iscritto-409/dryrun/conferma-errata/execute/orfano-vs-non), `gdpr-candidates-route.test.ts` (2) — verdi; advisors **0 ERROR**. **Alternative scartate:** hard-delete fisico delle righe (rischio FK su ~20 tabelle + perdita di prove/fisco → solo anonimizzazione, scelta utente); purgare anche il bucket `fatture` (viola la conservazione fiscale); cancellazione automatica senza dry-run/conferma (operazione irreversibile → doppia conferma); propagazione automatica al genitore anche se ha altri figli iscritti (→ solo orfani).

### 2026-06-27 — DL-035 — [Fase P0] Letture parent-facing via route server service-role (End-state X)
- **Contesto:** chiusura P0. Restavano 6 siti client che leggevano/scrivevano tabelle sensibili col **client anon del browser** (`getSupabase().from()`): `parent/modulistica` (legame/alunni/utenti), `teacher/gallery` (utenti.ruolo), admin form `RankingTable`/`SubmissionsTable`/`RankingAdjustModal` (form_models/form_submissions), `FieldRenderer` (storage upload). Prerequisito per il drop delle policy permissive (S9).
- **Decisione:** migrare tutte le letture a **route server gated + service-role + scoping applicativo** (NON a RLS `authenticated`/sessione; `PARENT_READS_USE_SESSION` resta `false`, le policy authenticated additive `20260722` restano dormienti = opzione S8 futura). Nuove route: `GET /api/me` (profilo proprio, senza segreti), `GET /api/admin/forms/{models,rankings,submissions}` (`requireStaff`), `PATCH /api/admin/forms/submissions/[id]` (`requireStaff`+audit); riuso `/api/parent/students` e `/api/forms/upload`. Gate di uscita: `grep getSupabase\(\) src/` → solo `auth/login` + 3 file realtime (`.channel()`), **zero** `.from()` su tabelle.
- **Impatto PRD:** §Trasversale §4 (identità/letture), §6 Stato. **Test:** `me-route.test.ts` (3), `forms-admin-routes.test.ts` (8) — verdi. **Scoperta:** `form_models`/`form_submissions` avevano GIÀ RLS `authenticated` (`is_staff_or_admin()`); la migrazione è difesa-in-profondità + funziona anche con header-identity. **Alternative scartate:** flip `PARENT_READS_USE_SESSION` ora (richiede sessioni genitore = onboarding); policy `authenticated` per-tabella (più complesso, rinviato a S8).

### 2026-06-27 — DL-036 — [Fase P0] Gate Segreteria+Direzione sulle mutazioni anagrafiche
- **Contesto:** `/api/admin/{students,parents,sections,iscrizioni}` erano **senza gate ruolo** (il middleware protegge le pagine `(dashboard)`, non le API route) → chiunque raggiungesse l'endpoint poteva mutare l'anagrafica.
- **Decisione:** `requireStaff(request)` (allowlist default `['admin','coordinator','segreteria']`) in testa a POST/PATCH/DELETE (e GET) delle 4 route; educatori/genitori esclusi. Refactor a `createAdminClient` unico (rimosso il client `@supabase/supabase-js` a livello modulo in `parents`).
- **Impatto PRD:** §Anagrafica §3, §Trasversale §5, §6 Stato. **Test:** in `admin-anagrafica-audit.test.ts`/`iscrizioni-import-audit.test.ts` (gate 403). **Alternative scartate:** `['admin','coordinator']` (solo Direzione) — bloccherebbe l'operatività reale della Segreteria; affidarsi al middleware (non copre `/api/`).

### 2026-06-27 — DL-037 — [Fase P0] Audit immutabile su ogni mutazione anagrafica
- **Contesto:** P0 richiede "audit log immutabile delle modifiche anagrafiche". Solo schools/staff/gdpr/sospensione loggavano; alunni/parents/sezioni/iscrizioni **no**.
- **Decisione:** `logScrittura()` (helper esistente, tabella append-only `audit_scritture_docente`, RLS solo INSERT/SELECT) dopo OGNI mutazione: `entitaTipo` ∈ {`alunni`,`genitori`,`legame`,`sezioni`,`graduatoria`,`iscrizione`}, con `valorePrima` (fetch pre-update) / `valoreDopo`. Per il bulk iscrizioni: una riga per entità creata (alunno/genitore/legame) + esito import.
- **Impatto PRD:** §Anagrafica §3, §6 Stato. **Test:** `admin-anagrafica-audit.test.ts` (14), `iscrizioni-import-audit.test.ts` (3), `forms-admin-routes.test.ts` PATCH — verdi. **Alternative scartate:** nuovo helper/tabella dedicata (riuso `logScrittura`, già immutabile e filtrabile da `GET /api/admin/audit`).

### 2026-06-27 — DL-038 — [Fase P0] Lockdown RLS in due tempi (S9a sicuro / S9b per-famiglia)
- **Contesto:** il DB aveva **~20 policy permissive** (`allow_all`/`TO anon`/`TO public USING(true)`) su tabelle di ogni modulo — RLS di fatto bypassata, **dati sensibili leggibili via anon key** (es. `allow_all_valutazioni` = voti alunni). **Scoperta chiave:** non tutte le route server usano service-role; molte usano il **client di sessione** (`createClient`, anon per header-identity) e DIPENDONO dalle permissive — un drop indiscriminato romperebbe diary/gallery/note/registro/locker.
- **Decisione (S9a, migr. `20260752`, applicata):** droppare le permissive solo sulle tabelle **provatamente service-role-only** (nessuna route nel set session-client): `avvisi`, `avvisi_risposte`, `task_interni`, **`valutazioni`**, `mensa_menu_config`, `mensa_class_menu_assignment`, `forms_submissions`, `forms_templates`. RLS resta **abilitata** (default-deny per anon/authenticated; service-role passa). `get_advisors(security)` = **0 ERROR**, WARN `always_true` 18→8. **(S9b, rinviato — runbook in `P0_ROLLOUT_CHECKLIST.md`):** `eventi_diario`/`note_disciplinari`/`registro_orario`/`firme_docenti`/`galleria_media_v2`/`locker_config`/`schools`/`alunni` richiedono PRIMA la migrazione della route session-client → service-role (route dei moduli P2/P4); `chat_messages`/`chat_threads` (realtime) richiedono l'onboarding genitori (vedi DL-039). **pagamenti/incassi realtime: già coperti da policy S7, nessuna azione.**
- **Impatto PRD:** §Trasversale §4 (RLS produzione), §6 Stato. **Alternative scartate:** drop di tutte le permissive subito (romperebbe la prod via i client di sessione → split S9a/S9b); flip `PARENT_READS_USE_SESSION` (richiede onboarding).

### 2026-06-27 — DL-039 — [Fase P0] Revoca `exec_sql` da anon/authenticated + hardening funzioni
- **Contesto:** `public.exec_sql(text)` (SECURITY DEFINER) era **eseguibile da `anon`/`authenticated`** via `/rest/v1/rpc/exec_sql` → **SQL arbitrario dal public API** (buco critico). 12 funzioni avevano `search_path` mutabile.
- **Decisione (migr. `20260752`):** `REVOKE ALL ON FUNCTION exec_sql(text) FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE … TO service_role` (le route admin di migrazione girano service-role → restano funzionanti); `ALTER FUNCTION … SET search_path = public, pg_temp` su 12 funzioni segnalate. **Verifica:** `exec_sql` non più nell'elenco advisor "anon/authenticated executable"; 0 ERROR.
- **Impatto PRD:** §Trasversale §4 (sicurezza DB) + §6 Stato. **Alternative scartate:** drop di `exec_sql` (lo usano `/api/admin/apply-migration` via service-role → solo revoca dai ruoli pubblici); revocare anche `is_staff_or_admin` (usata nelle policy RLS di form_* → lasciata, solo search_path).

### 2026-06-27 — DL-040 — [Fase P4] Diario 0-6 · slice D1 (cattura + notifica + lockdown S9b)
- **Contesto:** prima slice di P4 (moduli 0-6). Stato: push parent bufferizzato pronto ma non agganciato al diario; filtro presenti già nell'endpoint (`/api/diary/students?onlyPresent=true`); "Entrata" rimossa dal Diario; `nota_libera` in schema + mostrata al genitore ma senza input docente; nessun bulk "Nanna"; gli accessi `eventi_diario` usavano il client di **sessione** (blocco S9b).
- **Decisioni (fissate con l'utente):** **(1)** Push genitore per aggiornamento diario = **1 per figlio** (no spam per-evento), con **buffer 10' + debounce** (`enqueueDiarioGenitori`: elimina la notifica diario pending del figlio e ri-accoda → la finestra di modifica è il buffer stesso). **(2)** **"Entrata" read-only dalle Presenze** (`/api/diary/checkin` → `presenze.orario_entrata`), nessun evento `eventi_diario` duplicato. **(3)** filtro **solo Presenti** di default in UI docente + toggle "Tutti"; **(4)** bulk **"Nanna per tutti"** (orario inizio = ora); **(5)** input **nota libera** docente (`nota_libera` nel payload). **(6) Lockdown S9b Diario:** migrati TUTTI gli accessi `eventi_diario` di `/api/diary/entries` a **service-role** (End-state X, DL-035) — `educator-sections`/`wipe` già admin, `debug-supabase` sigillato — poi **DROP** `eventi_diario_insert_anon/_select_anon/_update_anon` (migr. `20260753`). RLS resta abilitata (resta la policy genitore additiva `authenticated`; anon = default-deny).
- **Rinviato a S13/onboarding:** lo **scoping di proprietà** del ramo genitore (un genitore solo i propri figli): finché l'identità è via header (spoofabile) il gate non aggiunge sicurezza reale e romperebbe l'accesso demo (verificato: `DEV_PARENT_ID` non possiede l'alunno demo di default); la lettura passa comunque via service-role.
- **Rinviato a D2:** traduzione voci routine (i18n), dashboard monitoraggio Segreteria, riconciliazione `eventi_diario`/`daily_routines`, auto-fill quantità portate.
- **Impatto PRD:** §Diario 0-6 + §6 Stato. **Test:** `diario-notifiche.test.ts` (3: debounce/buffer/no-genitori), `diary-entries-scope.test.ts` (2: ramo genitore service-role + gate docente) — verdi; full suite **375 verdi**; advisors **0 ERROR** (WARN `eventi_diario` azzerati). **Alternative scartate:** push per-evento (spam → 1/figlio); ripristino evento `entrata` nel Diario (duplica il check-in di Presenze → read-only da Presenze); gate proprietà subito (rompe la demo header-identity → S13).

### 2026-06-27 — DL-041 — [Fase P4] Galleria · slice G1 (Privacy Lock server-side + lockdown S9b)
- **Contesto:** modulo Galleria. Già fatti (verificato): broadcast istituzionale, cancellazione globale admin, interconnessione Diario, e il **Privacy Lock in UI** (`StudentTagger` impedisce di selezionare alunni senza `consenso_privacy`). Mancava l'**enforcement server-side**: `POST/PATCH /api/gallery` accettavano qualsiasi `tag_students[]`. Colonna `alunni.consenso_privacy` **esiste** in prod (40/128 con consenso). **Scoperta:** TUTTI gli accessi a `galleria_media_v2` sono già service-role (il client di sessione in `gallery/route.ts` serve solo `auth.getUser()`), quindi il lockdown S9b non richiede migrazione route (smentita la mia euristica P0 che lo classificava session-blocked).
- **Decisione (fissata con l'utente):** **Privacy Lock invalicabile lato server** — se la foto NON è broadcast, ogni alunno in `tag_students` deve avere `consenso_privacy=true`; altrimenti **422 con i nomi** (rifiuto netto, no strip silenzioso). Helper puro `studentiSenzaConsenso` + async `alunniSenzaConsenso` (`src/lib/gallery/privacy.ts`), applicato in POST e in PATCH (sui tag EFFETTIVI dopo l'update, copre anche lo spegnimento del broadcast). **Lockdown S9b:** **DROP** `galleria_media_v2."Allow all for service role"` (migr. `20260754`); RLS resta abilitata, anon = default-deny, service-role passa.
- **Impatto PRD:** §Foto/Video (Galleria) + §6 Stato. **Test:** `gallery-privacy.test.ts` lib (5) + api (4: 422 con nome/201 consenso/broadcast bypass/403) — verdi; full suite **384 verdi**; advisors **0 ERROR** (WARN `galleria_media_v2` azzerato). **Alternative scartate:** strip silenzioso dei non-consenzienti (il docente non si accorge → rifiuto 422); migrare le route a session-client per la RLS (inutile: già tutte service-role → solo drop).

### 2026-06-27 — DL-042 — [Fase P4] Comunicazione · slice C1 (traduzione automatica chat)
- **Contesto:** PRD §Comunicazione chiede "traduzione automatica" chat insegnante↔famiglie straniere (requisito chiave mancante). Nel repo nessuna integrazione LLM/traduzione e nessuna chiave nel `.env.local`.
- **Decisione (fissata con l'utente):** traduzione on-demand via **Claude API** (modello **`claude-haiku-4-5`**, economico/veloce — consultata la reference `claude-api`), **gated su `ANTHROPIC_API_KEY`** (dipendenza esterna come Aruba/SDI): se la chiave manca il servizio ritorna `disabled` e l'UI nasconde il pulsante. Servizio `src/lib/translate/claude.ts` (`translateText`, client SDK ufficiale `@anthropic-ai/sdk`, client iniettabile per i test); endpoint `POST /api/chat/translate` (`requireUser` + rate-limit anti-abuso, 503 se disabilitato); UI: pulsante **"Traduci"** sotto ogni messaggio IN ARRIVO in `ChatMessageArea` (target = lingua del dispositivo `navigator.language`, toggle mostra/nascondi, traduzione mostrata sotto l'originale). *(Drop S9b chat realtime = onboarding, separato.)*
- **Impatto PRD:** §Comunicazione + §6 Stato. **Test:** `translate-claude.test.ts` (4: disabled/empty/traduce-con-model-haiku/errore-non-lancia), `chat-translate.test.ts` (4: 401/400/200/503) — verdi; full suite **392 verdi**; tsc 0 errori. **Alternative scartate:** provider esterno DeepL/Google (Claude più naturale per il progetto); raw `fetch` invece dell'SDK ufficiale (la reference impone l'SDK quando esiste); traduzione automatica su ogni messaggio (costo → on-demand 1 tap); `thinking`/`effort` su haiku (non supportati/non necessari per una traduzione).

### 2026-06-27 — DL-043 — [Fase P4] Mensa · slice M1 (icona pericolo allergeni genitore)
- **Contesto:** §Mensa chiede "alert incrociato anagrafica + icona pericolo personalizzata genitore". L'infra allergeni 14 UE è già completa (allergeni per portata su `mensa_menu_rotazione`, `alunni.allergeni`, job cuoca/segreteria `controllaAllergie` + cron `mensa_check_allergie_giornaliero`); mancava il **lato genitore**.
- **Decisione (autonoma):** `GET /api/parent/mensa/allergie?alunno_id=&date=` (`requireUser`, service-role) che **riusa gli helper puri già testati** (`allergeniAlunno`, `resolveMenuGiorno`, `conflittiAllergie`) per incrociare gli allergeni del figlio col menù del giorno → `{ conflitti, conflitti_label, dettaglio (portate), pericolo }`. UI: **banner pericolo** rosso nella pagina mensa genitore quando `pericolo` (mostra gli allergeni in conflitto).
- **Impatto PRD:** §Mensa + §6 Stato. **Test:** `parent-mensa-allergie.test.ts` (5: 401/400/pericolo-glutine/no-allergeni/mensa-chiusa) — verdi; full suite **400 verdi**; tsc 0 errori. **Alternative scartate:** ricalcolare la logica conflitti nell'endpoint (riuso degli helper puri); isolamento interfaccia Cuoca come prima slice (meno safety-critical della cross-allergeni genitore → sequenziato).

### 2026-06-27 — DL-044 — [Fase P4] Armadietto · S9b lockdown `locker_config`
- **Contesto:** il flusso richiesta materiale→**chiusura ciclo** è già presente (`/api/locker/requests` PATCH `acknowledged`/`fulfilled` + `preso_in_carico_il`). L'unico accessor di `locker_config` (`/api/locker/materials`) usava però il **client di sessione** → blocco S9b residuo.
- **Decisione (autonoma):** migrata `/api/locker/materials` a **service-role** (gate `requireDocente` + scope `assertClasseNomeInScope` + audit `logScrittura('armadietto_config')` invariati); **DROP** delle 2 policy permissive `auth_gestisce_locker_config` (ALL authenticated true) + `tutti_leggono_locker_config` (SELECT public), migr. `20260755`. Resta solo `service_role_locker_config` (esclusa dal lint). `get_advisors` 0 ERROR.
- **Impatto PRD:** §Armadietto + §6 Stato + `P0_ROLLOUT_CHECKLIST` (spunta `locker_config`). **Test:** full suite **400 verdi**, tsc 0 errori. **Alternative scartate:** aggiungere subito carico-merci/dashboard-inadempienze (feature ampie → sequenziate; la slice chiude il residuo P0).

### 2026-06-27 — DL-045 — [Fase P4] Anagrafica · onboarding genitore (primo accesso) — capstone S13
- **Contesto:** §Anagrafica chiede "onboarding genitore (`/onboarding`: primo accesso, password/PIN, consensi GDPR)". `/onboarding` era già occupato (redirect a `/iscrizione` pubblica) → nuova pagina **`/parent/onboarding`**. È il **prerequisito ingegneristico di S13**: dà al genitore una sessione reale.
- **Decisione (autonoma):** migr. `20260756` (`parents.onboarded_at` + `consensi_gdpr` jsonb); helper puro `consensiMancanti` (`CONSENSI_RICHIESTI=['privacy']`); `POST /api/parent/onboarding` (`requireUser`): **422** se consensi obbligatori mancanti, **400** se password <8, registra `consensi_gdpr`+`onboarded_at` su `parents`, e **aggiorna la password Supabase Auth** (`admin.auth.admin.updateUserById`) se il genitore è bindato (`auth_user_id`); pagina `/parent/onboarding` (password + checkbox consenso privacy GDPR). **Il flip S13** (`ALLOW_HEADER_IDENTITY='false'`) **resta operativo** (richiede l'onboarding di massa dei genitori reali — fuori da una sessione di codice).
- **Impatto PRD:** §Anagrafica §3 + §Trasversale (identità) + §6 Stato. **Test:** `onboarding-consensi.test.ts` (4), `parent-onboarding.test.ts` (5: 401/422/400/200-record/200-password) — verdi; full suite **406 verdi**; tsc 0 errori. **Alternative scartate:** sovrascrivere `/onboarding` (è il redirect all'iscrizione pubblica → `/parent/onboarding`); PIN dispositivo come primario (la password Supabase Auth è il meccanismo di sessione; PIN rinviato).

### 2026-06-27 — DL-046 — [Fase P0] Completamento lockdown RLS S9b (drop di TUTTE le policy permissive)
- **Contesto:** restavano permissive su `note_disciplinari`/`registro_orario`/`firme_docenti`/`schools` (in realtà già service-role: le route le leggevano via `createAdminClient`, `createClient` solo per `auth.getUser()` — euristica import era falso positivo), su `alunni` (`alunni_select_anon`, ancora letta in sessione da 4 route) e su `chat_messages`/`chat_threads` (realtime anon).
- **Decisione (autonoma):** **Wave 1** (migr. `20260757`) drop `note_disciplinari`/`registro_orario`/`firme_docenti`/`schools` (già service-role). **Wave 2** (migr. `20260758`): migrate a service-role gli ultimi lettori session-client di `alunni` (`attendance/monthly`, `diary/students`, `locker/requests`, `locker/inventory`) → drop `alunni_select_anon` (resta la policy genitore additiva). **Wave 3** (migr. `20260759`): **realtime RLS chat** — policy `authenticated` partecipante su `chat_messages`/`chat_threads` (`teacher_id`/`parent_id = auth.uid()` o genitore via `parents.auth_user_id`) + drop permissive. **Risultato:** `pg_policies` con `qual='true'` su anon/public/authenticated-ALL = **0** → **lockdown RLS S9b COMPLETO**. `get_advisors` 0 ERROR; restano solo advisory standard Supabase (pg_net in public, SECURITY DEFINER `is_staff_or_admin`/`current_parent_student_ids` necessarie alla RLS, leaked-password = toggle dashboard).
- **Nota realtime:** la chat **live** ora richiede sessione (authenticated); l'anon header-identity non onboardato non riceve più il push live (la cronologia resta via `/api/chat/messages` service-role). Reversibile (`CREATE POLICY`).
- **Restano OPERATIVI (non codice):** **S13** `ALLOW_HEADER_IDENTITY='false'` (env, da flippare dopo l'onboarding di massa) + invio credenziali genitori. **Test:** full suite **406 verdi**; tsc 0 errori. **Alternative scartate:** migrare anche `is_staff_or_admin`/`current_parent_student_ids` (servono alla valutazione RLS per authenticated → lasciate); toccare le funzioni cron (`notifiche_dispatch_tick`/`mensa_check_allergie_giornaliero`) (rischio rottura cron per WARN minore).

### 2026-06-27 — DL-047 — [Fase P5] Certificato delle Competenze (D.M. 14/2024, classe quinta)
- **Contesto:** il Certificato delle Competenze di fine primaria (PRD §Interoperabilità §5) era **totalmente assente** (nessuna tabella, generatore PDF o UI), pur essendo un adempimento di legge (D.M. 14 del 30/1/2024) e un documento di valore reale per le famiglie **indipendente dall'accreditamento SIDI**.
- **Decisione:** build **completo incl. firma FEA**. Tabelle `certificati_competenze` + `certificato_competenza_livelli` (migr. `20260760`, RLS default-deny). Modello statutario puro `src/lib/competenze/modello.ts` (8 **competenze chiave europee** + scala a **4 livelli A/B/C/D** — NB il 4° del certificato è «Iniziale», distinto dalla scala pagella O.M.172/2020 «In via di prima acquisizione»). Precompilazione euristica dei livelli dai giudizi di scrutinio (`livello-mapping.ts`, sovrascrivibile). Generatore PDF `certificato-pdf.ts` (riusa lo stile `buildPagellaPdf`, legenda 4 livelli + firma applicativa). Store `certificato-store.ts`: `validaScrutinioFinaleClasseQuinta` (gate livello-5 primaria + scrutinio chiuso → 422/409), `seedCertificato` (bozza idempotente su `(alunno, anno)`), `generaCertificato` → PDF su bucket privato + `stato='firmato'` + **slot FEA dirigente** (`recordSignerSlot` policy `any-one`, DL-007) + `logFeaEvent`. Route: `GET/POST/PATCH /api/admin/competenze` (seed/edit, gate Direzione), `POST /api/admin/competenze/genera` (genera+firma, **dirigenza** `['admin','coordinator']`), `GET /api/admin/competenze/download`, `GET /api/parent/competenze` (scope figlio, solo generato/firmato). UI `/admin/competenze` (editor livelli + genera/scarica) + card download nella pagina pagelle genitore.
- **Impatto PRD:** §Interoperabilità §5 → implementato; §6 Stato nuova riga; checklist pulsanti «Scarica certificato delle competenze». **TDD:** 17 test (modello/mapping/PDF/store/route/scope).
- **Alternative scartate:** auto-derivare i livelli dai voti senza intervento docente (l'attribuzione è un atto del team docente → solo suggerimento); firma OTP genitore (il certificato è atto del dirigente → firma applicativa dirigente come la pagella).

### 2026-06-27 — DL-048 — [Fase P5] Numero domanda iscrizione SIDI + import ZIP ministeriale
- **Contesto:** PRD §Interoperabilità §2: ricezione `.zip` SIDI senza rinomina, matching/dedup su **Numero di domanda**, sync genitori per CF. Non esisteva alcun campo `numero_domanda` né parser ZIP (jszip assente).
- **Decisione:** parser **pluggable su schema assunto** (deciso col committente: nessun campione SIDI reale disponibile). Campo `alunni.numero_domanda_sidi` + indice unico parziale per scuola + staging `sidi_import_batches` (migr. `20260762`, RLS default-deny). `src/lib/sidi/zip-parser.ts` (jszip; manifest `domande.csv`/`domande.json`; `normalizeSidiRow` = **unico punto sostituibile** al tracciato vero). `import-apply.ts` `applySidiRecords`: matching ① numero domanda → ② fallback CF (stampa il numero domanda) → ③ creazione, genitori dedup su `parents.fiscal_code`, link `student_parents`, **idempotente**, riusa la logica di upsert di `/api/admin/iscrizioni` + `logScrittura`. Route `POST/PATCH/GET /api/admin/sidi/import` (upload+preview gate staff; **apply** gate Direzione). UI in `SidiPanel` (link da `/admin/iscrizioni`).
- **Impatto PRD:** §Interoperabilità §2 → implementato; checklist `/admin/iscrizioni` (Upload ZIP / Matching numero domanda / Sync genitori CF / campo Numero domanda). **TDD:** 14 test (parser/normalize/apply/route).
- **Alternative scartate:** rinviare lo ZIP e usare solo un campo manuale (perde il flusso ministeriale); targettizzare un tracciato XML reale ora (ignoto → rischio rilavoro: isolato in `normalizeSidiRow`).

### 2026-06-27 — DL-049 — [Fase P5] Client SIDI gated + Fase A + frequentanti + Piattaforma Unica + indicatore sync
- **Contesto:** PRD §Interoperabilità §3/§4: allineamento strutturale Fase A, invio frequentanti, flusso associazioni Genitori-Alunni in cooperazione applicativa. La **trasmissione reale richiede l'accreditamento ministeriale** del software (credenziali/canali), oggi non disponibile — stessa dipendenza esterna della verifica live Aruba/SDI (DL-004/DL-017).
- **Decisione:** **fondamenta + boundary gated** (specchio Aruba). `src/lib/sidi/client.ts` (`SidiConfig`, `resolveSidiCredentials` via `password_ref`→env, `sidiBaseUrls` DEMO/PROD, `sidiTransmit` → **503** `non_configurato`/`non_accreditato`, mai successo finto). Builder **neutri** `payload.ts` (Fase A reconcile, frequentanti solo `stato='iscritto'` per sezione, genitori-alunni solo legami **validati Segreteria**); serializer XML **sottili e sostituibili** `serializer.ts`; guardie `sequenza.ts` (Fase A→frequentanti→Piattaforma Unica, 409 fuori ordine). Config `admin_settings.sidi_config` + route `settings/sidi` (clone Aruba, password mascherata). Validazione legami `student_parents.validato_sidi/_il/_da`. Stato `sidi_sync_state` (migr. `20260763`) + indicatore. Route gated `POST /api/admin/sidi/{fase-a,frequentanti,piattaforma-unica}` (dirigenza), `GET/PATCH /api/admin/sidi/legami`, `GET /api/admin/sidi/sync-state`. UI `SidiPanel`/`/admin/sidi`: indicatore 3 pill a cascata + banner «accreditamento in corso».
- **Impatto PRD:** §Interoperabilità §3/§4 → implementato (egress gated); checklist `/admin/iscrizioni` (Fase A / Invia frequentanti / Trasmissione Genitori-Alunni / Indicatore stato sync). **TDD:** 18 test (client/payload/sequenza/serializer/route gate/sequenza-guard/settings-mask).
- **Resta gated/follow-up:** invio telematico reale (accreditamento); tracciato XML reale (serializer sostituibili); inbound cooperazione applicativa + auto-apply struttura Fase A nel DB locale (no scritture distruttive da boundary non accreditato).
- **Alternative scartate:** serializzare subito i tracciati reali su specifiche assunte (rilavoro); rinviare del tutto i builder finché non accreditati (si perde il valore interno di prep-dati e l'indicatore).

### 2026-06-27 — DL-050 — [Fase P5] Assegnazione massiva a gruppi mensa
- **Contesto:** PRD checklist `/admin/iscrizioni`: «Assegnazione massiva (bulk) a classi/sezioni/gruppi mensa». La bulk classe/sezione esisteva; **nessun modello gruppi mensa**.
- **Decisione:** modello minimale `gruppi_mensa` (per scuola, unique nome) + `alunni.gruppo_mensa_id` (migr. `20260761`, RLS default-deny). Esteso `PATCH /api/admin/students` con ramo `{ids[], gruppo_mensa_id}` (`gruppo_mensa_id` null = rimozione) + audit per alunno; CRUD `GET/POST /api/admin/gruppi-mensa`. UI: `BulkAssignBar` esteso (controllo gruppo mensa retro-compatibile) + wiring `/admin/students`.
- **Impatto PRD:** checklist `/admin/iscrizioni` (Assegnazione massiva). **TDD:** 5 test (bulk mensa + regressione classe + gate CRUD).
- **Alternative scartate:** gruppo mensa come tabella ponte molti-a-molti (un alunno → un turno mensa, FK singola sufficiente, YAGNI).

### 2026-07-13 — DL-051 — [Fase P4] Galleria · foto privata (semantica ≤1 taggato) + broadcast Direzione
- **Contesto:** l'upload docente era **sempre rotto**: `alunni.consenso_privacy` (liberatoria) nasce `false` e il Privacy Lock server-side (DL-041) **422-ava ogni foto** con un taggato senza liberatoria, mentre il tagging resta obbligatorio → nessuna foto pubblicabile. La regola «tutti i taggati devono avere liberatoria» è troppo rigida per la fotografia quotidiana di un singolo bambino.
- **Decisione (fissata con l'utente — opzione B):** **regola "foto privata"** — un alunno **senza liberatoria è taggabile DA SOLO**; la foto resta visibile ai soli suoi genitori (riuso del filtro di visibilità tagged esistente). La liberatoria è richiesta **solo per le foto di gruppo** (>1 taggato), e allora per **tutti** i taggati; altrimenti **422 coi nomi**. Broadcast invariato e ora **riservato alla Direzione anche lato server** (prima solo UI). Conseguenza accettata: due fratelli entrambi senza liberatoria non possono comparire nella stessa foto. Applicato in POST e PATCH (sui tag effettivi); 422 parlanti mostrati dal client.
- **Impatto PRD:** §Foto/Video (Tagging e Privacy Lock) + §6 Stato (riga Galleria G1). **Follow-up:** bucket storage pubblico → signed URL; DELETE galleria ancora su identità legacy da query.
- **Alternative scartate:** mantenere il 422 su ogni taggato senza liberatoria (blocca l'uso reale); strip silenzioso dei non-consenzienti (il docente non se ne accorge → 422 esplicito quando serve).

### 2026-07-13 — DL-052 — [Fase P4] Liberatoria foto/video scrivibile dall'anagrafica (`consenso_privacy`)
- **Contesto:** la colonna `alunni.consenso_privacy` esisteva ma **nessuna API poteva impostarla**: `PATCH /api/admin/students` la scartava (assente da schema zod e `allowedFields`), quindi la liberatoria restava per sempre `false` e la Galleria era ingestibile (DL-051).
- **Decisione:** **toggle "Liberatoria foto/video firmata"** nella scheda alunno dell'anagrafica (checkbox nel blocco Dati Medici/Didattici), persistito via `PATCH /api/admin/students` — `consenso_privacy` aggiunto a schema + `allowedFields`, audit `logScrittura` già presente. Gate anagrafica invariato (Segreteria+Direzione, DL-036).
- **Impatto PRD:** §Anagrafica (scheda alunno) + §Foto/Video + §6 Stato. **Test:** copertura route-level della catena galleria/tagging.
- **Alternative scartate:** endpoint dedicato alla liberatoria (il PATCH students è già il punto di scrittura anagrafica auditato).

### 2026-07-13 — DL-053 — [Fase P3] Anagrafica tab Staff su `utenti` + lettura estesa alla Segreteria
- **Contesto:** la tab Staff dell'anagrafica era **sempre vuota**: interrogava l'endpoint dei **genitori** filtrando su un workaround morto (ruolo scritto in `citizenship`). Anche la scheda `kind=staff` caricava dai genitori (rotta).
- **Decisione:** la tab e la scheda leggono da `utenti` via `GET /api/admin/staff`, con **lettura estesa alla Segreteria** (costante `LETTURA`); le **scritture** (ruolo/sede/sezioni, «Rigenera credenziali») **restano riservate alla Direzione** (DL-028), con **403 server** come backstop. Righe nella stessa tabella dell'anagrafica (colonne Email/Ruolo/Sede/Classi, badge ruolo, niente bulk), ricerca + **export CSV** dedicati; nuova scheda `StaffDetailPanel` (dati + classi assegnate). Workaround `citizenship` **dismesso in lettura**. Pannello Gestione Staff: errori resi visibili (prima inghiottiti), azioni nascoste ai non-Direzione.
- **Impatto PRD:** §Impostazioni §2 (Gestione Staff RBAC) + §Anagrafica + §6 Stato. **Test:** E2E rafforzato (la tab Staff deve mostrare la docente E2E seminata). **Follow-up:** pruning `section_ids` al cambio sede.
- **Alternative scartate:** consentire alla Segreteria anche le scritture staff (rischio escalation → solo lettura); conservare il filtro `citizenship` (non contiene il ruolo).

### 2026-07-13 — DL-054 — [Fase P4] Mensa · la Segreteria forza inserimento/disdetta fuori cut-off + kitchen-read
- **Contesto:** `/api/mensa/prenotazioni` rispondeva **403** alla Segreteria (GET/POST/DELETE): impossibile inserire un pasto su chiamata fuori orario o leggere il Report Cucina, benché sia un'operazione di sportello quotidiana.
- **Decisione:** `STAFF_FORZA = admin|coordinator|segreteria` su GET/POST/DELETE. La Segreteria può **inserire fuori orario** (salta cutoff e vincolo saldo>0; il saldo può andare **negativo** → l'alunno compare nei morosi; **origine derivata server-side** = `segreteria`; movimento su `mensa_ticket_movimenti` con `saldo_dopo`) e **disdire oltre il cutoff** (anche date passate: rettifica con riaccredito, tracciata con `creato_da`/`creato_il`). `requireKitchenRead` ora include la Segreteria → tab **Report Cucina** leggibile. Il genitore resta vincolato a cutoff + saldo>0.
- **Impatto PRD:** §Presenze/Mensa (Dashboard Cucina e Cut-off) + §Mensa/Ticket + §6 Stato. **Test:** catena ticket route-level (prenotazione scala saldo+ledger; blocchi saldo 0/cutoff/non legato; multi-data saldo parziale; disdetta riaccredita; segreteria forza a −1; report con gate reale). **Follow-up:** atomicità saldo (read-then-write non transazionale → RPC futura); controllo errori di scrittura nella DELETE.
- **Alternative scartate:** endpoint separato per lo sportello segreteria (riuso della route con allowlist estesa); vietare il saldo negativo (serve per registrare il debito → confluisce nei morosi).
