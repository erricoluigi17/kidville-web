# Findings di collaudo — da riprendere per la CORREZIONE

Documento unico e ordinato per gravità. Consolida **due campagne** di collaudo E2E «l'agente si comporta
come l'utente» su **produzione** (`app.kidville.it`, account/sezioni **TEST**, tutto reversibile):

- **Parte A — Collaudo «giornata» (2026-07-17)**: già trovata, 3 vulnerabilità + findings di prodotto.
- **Parte B — Collaudo «360» (2026-07-17)**: armadietto · mensa · contabilità · modulistica · avvisi,
  testate in ogni fattispecie (happy path, casi limite, negativi/sicurezza) via Chrome + oracolo DB +
  email reali (kidville-mail MCP).

Stato di ogni voce: **APERTO** (nessun fix applicato: questa è una campagna di collaudo, produce findings).

Legenda gravità: 🔴 bloccante · 🟠 grave · 🟡 medio · 🔵 minore · 🟢 verificato-OK.

---

## 🔴 BLOCCANTE

### B1 — `admin/documents-merge`: dump di PII di minori SENZA autenticazione
- **File**: `src/app/api/admin/documents-merge/route.ts:16-94` (il `GET` non chiama alcun gate).
- **Cosa**: con solo `form_id` (uuid) + `class_name`, in **GET anonima** (nessuna sessione), restituisce per
  l'intera classe: `nome`, `cognome`, **`codice_fiscale`**, `answers`, `signature_log`, `is_signed`,
  `pdf_path`. `createAdminClient()` bypassa la RLS; nessun `requireStaff`.
- **Riprodotto LIVE (Parte B)**: `curl` anonimo su un template valido → `HTTP 200` con
  `results:[{student_id, nome_alunno:<nome proprio di una bambina>, cognome_alunno:<cognome>}]`.
  Nomi di bambini esposti a chiunque.
  <!-- Bonificato il 2026-08-08. Qui c'era, in chiaro, il nome proprio che quella GET anonima
       aveva restituito. Misurato prima di toglierlo: `select count(*) from public.alunni where
       nome ilike '<quel nome>'` → 1 riga, `stato='iscritto'`; lo stesso nome compare in 8 righe
       di `enrollment_submissions`. Non era un nome di fantasia, e il repository è pubblico.
       È il secondo dato personale trovato in questo file nello stesso giorno: il primo (nome,
       cognome e valore di `allergies` di un'alunna iscritta, riga 202) era stato bonificato
       poche ore prima. Il lock che ha visto questo è
       `__tests__/architecture/pii-nei-file-tracciati.test.ts` (P3). -->

  Per riprodurlo oggi non serve nessun dato vero: basta contare le chiavi della risposta.
- **Fix**: `const auth = await requireStaff(request); if (auth.response) return auth.response` in testa alla GET.

---

## 🟠 GRAVE

### G1 — `diary/checkin`: IDOR presenze senza autenticazione
- **File**: `src/app/api/diary/checkin/route.ts:18-40`.
- **Cosa**: `GET /api/diary/checkin?alunno_id=<uuid>` **anonimo** → `200 {"orario_entrata":…,"stato":"presente"}`
  per qualunque alunno noto l'UUID (lo scoping «deferito a S13» non è mai stato applicato).
- **Riprodotto LIVE**: `curl` anonimo → 200.
- **Fix**: `requireUser`/`requireDocente` + `assertAlunnoInScope`.

### G2 — `fea/receipt`: identità via header `x-user-id` accettata in produzione
- **File**: `src/app/api/fea/receipt/route.ts:71-87` (usa `getRequestUserId` legacy invece di `resolveIdentity`).
- **Cosa**: l'header `x-user-id` è accettato come identità **anche in prod** (dove `?userId=` è sigillato).
  Se `signerId` è null lo scope è saltato → si scarica la ricevuta PDF firmata (email, IP, risposte) di un
  altro genitore.
- **Riprodotto LIVE**: `curl -H 'x-user-id: <uuid>'` → `404 "Firma non trovata"` (NON 401): l'header è stato
  accettato e risolto; con `?userId=` invece → `401` ovunque. Conferma esatta.
- **Fix**: `resolveIdentity` sessione-first + diniego di default quando `signerId` è null.

### G3 — `GET /api/avvisi?parentId=`: lettura avvisi SENZA autenticazione (IDOR) 🆕
- **File**: `src/app/api/avvisi/route.ts:56-63` (il ramo genitore, con `?parentId`, non ha gate; solo il ramo
  staff è protetto da `requireDocente`).
- **Cosa**: passando un `parentId` qualsiasi, in **GET anonima** si legge l'intero feed avvisi di quel
  genitore (titoli, contenuti, classi bersaglio, allegati).
- **Riprodotto LIVE**: `curl "…/api/avvisi?parentId=<gprim>"` → `200` con 7 avvisi della sua classe.
- **Fix**: `requireUser` + verifica che `parentId == auth.userId` (o derivarlo dalla sessione).

### G4 — `POST /api/avvisi/[id]/risposte`: forgiatura adesione/presa-visione SENZA auth (IDOR write) 🆕
- **File**: `src/app/api/avvisi/[id]/risposte/route.ts:84-129` (nessun gate, nessun IDOR: accetta
  `parent_id`/`student_id` arbitrari).
- **Cosa**: chiunque, anonimo, può registrare presa-visione **e adesione** («sì»/«no») a nome di qualsiasi
  genitore/alunno → inquina i conteggi di adesione (rilevante per il **consenso alle uscite/gite** di minori).
- **Riprodotto LIVE**: `POST` anonima con `{parent_id, student_id, risposta:"si"}` → `200`, riga creata.
  (Riga rimossa a fine test.)
- **Fix**: `requireUser` + `genitoreHasFiglio(parent_id, student_id)` + `parent_id == sessione`.

---

## 🟡 MEDIO

### M1 — Doppio incasso accettato: `importo_pagato` può superare `importo` 🆕
- **File**: `src/app/api/pagamenti/incassi/route.ts` (POST: nessun controllo di duplicato/eccedenza sul POST diretto).
- **Cosa**: due incassi pieni sulla stessa voce da 40€ → `importo_pagato = 80.00` (stato `pagato`), **nessun
  blocco né avviso**. Sovra-incasso «fantasma» di 40€ senza nota di credito.
- **Riprodotto LIVE**: 2× `POST incassi {importo:40}` su voce da 40 → entrambi `201`; a DB `importo_pagato=80`.
- **Fix**: avvisare/bloccare quando l'incasso porta `importo_pagato > importo` (o registrare l'eccedenza come credito esplicito).

### M2 — `PATCH /api/pagamenti/[id]` accetta importi negativi (bypassa la validazione della POST) 🆕
- **File**: `src/app/api/pagamenti/[id]/route.ts` (il body PATCH usa `z.unknown()` → salta il check `importo>0` della POST).
- **Cosa**: `PATCH {importo:-999}` → `200`; a DB `importo=-999.00`. La voce assurda **arriva alla UI del
  genitore**: «€ -999.00 (resta € -1079.00)».
- **Riprodotto LIVE**: PATCH + screenshot lato genitore.
- **Fix**: validare `importo` (numero > 0) anche nel PATCH.

### M3 — Home genitore «Pagamenti in regola» mentre c'è una morosità scaduta 🆕
- **File**: `src/components/features/parent/pagamenti/PagamentiSummary.tsx:43-44` (`daPagare.reduce(residuo)`
  somma i residui **senza clamp** per voce).
- **Cosa**: una voce **sovra-incassata o con importo negativo** (residuo negativo) abbassa il totale sotto zero →
  la home mostra la card verde «PAGAMENTI IN REGOLA · Nessuna quota in scadenza» **anche con €70 scaduti**
  (che la pagina Pagamenti mostra correttamente come «Totale da saldare €70»).
- **Impatto**: un genitore che guarda la home crede di essere in regola mentre è moroso. Amplificato da M1/M2
  ma vale anche con un normale sovra-pagamento/eccedenza.
- **Fix**: `Math.max(0, importo - importo_pagato)` per voce nella somma; e considerare le voci `scaduto`.

### M4 — Sospensione morosità quasi senza effetto (guardia applicata solo ai moduli Sistema A) 🆕
- **File**: guardia `src/lib/pagamenti/sospensione.ts`; **usata solo** in `src/app/api/forms/submit/route.ts:48`
  e `src/app/api/forms/send-otp/route.ts:130`.
- **Cosa**: la Direzione sospende il moroso (route OK, DB `alunni.sospeso=true`), ma la guardia blocca **solo**
  invio/firma dei moduli **Sistema A**. Restano liberi: **prenotazione mensa**, adesione avvisi, **firma moduli
  Sistema B** (`parent/forms/otp`), chat, diario, armadietto. Il docstring dice «inibisce le azioni di servizio
  del genitore»: nella pratica è quasi inefficace come leva sulla morosità.
- **Riprodotto LIVE**: sospeso Alunno1 → la prenotazione mensa del genitore è passata (`201`).
- **Fix**: applicare `assertGenitoreNonSospeso`/`assertAlunnoNonSospeso` agli endpoint di servizio previsti dalla
  policy (almeno mensa e Sistema B), o correggere il docstring/aspettativa. Nota: non bloccare login/letture è
  corretto (sicurezza del minore).

### M5 — OTP di firma (FES Sistema B) ripetibile entro 10 minuti → firme duplicate/replay 🆕
- **File**: `src/app/api/parent/forms/otp/route.ts` (PATCH) + `src/lib/auth/otp-ticket.ts` (ticket HMAC stateless,
  TTL 10 min, **nessun uso-singolo/nonce**).
- **Cosa**: lo stesso `code`+`ticket` può essere inviato più volte finché non scade → ogni volta crea una nuova
  `forms_submissions` firmata. Replay dell'OTP e firme duplicate sullo stesso `(modulo, alunno)`.
- **Riprodotto LIVE**: PATCH con codice corretto → `201` (firma); **stesso** codice+ticket di nuovo → `201` (seconda firma).
- **Fix**: marcare il ticket/OTP come consumato (jti in tabella o `otp_used`), e/o unicità `(form_id, student_id)` sulle submission firmate.

### M6 — Alert allergie mensa NON raggiunge il ruolo `segreteria` 🆕
- **File**: `src/lib/mensa/notify.ts:41` — il set destinatari è `['admin','coordinator','cuoca']` e **omette
  `segreteria`**, benché il commento dica «segreteria».
- **Cosa**: quando un allergene del bambino è nel menu del giorno, l'alert va ad admin/coordinator/cuoca/docenti
  ma **non** a chi ha ruolo `segreteria` — proprio chi gestisce la mensa. Sicurezza alimentare di minori.
- **Riprodotto LIVE**: creato conflitto glutine → `allergie-check` alert:1 → notifiche a
  admin/coordinator/cuoca/5 docenti; **`test.segreteria` assente**.
- **Fix**: aggiungere `'segreteria'` al set `ruoliSegreteriaCuoca`.

### M7 — Spoofing dell'autore di un avviso 🆕
- **File**: `src/app/api/avvisi/route.ts` (POST usa `author_id` dal body senza verificare che coincida con la sessione).
- **Cosa**: autenticato come `segreteria` ho pubblicato un avviso con `author_id` di un **docente** → salvato e
  **mostrato al genitore come «Docente1 Test PRI»**. Autore falsificabile su comunicazioni ufficiali alle famiglie.
- **Riprodotto LIVE**: POST con `author_id` altrui → `201`, `author_id` salvato = docente; visibile in bacheca genitore.
- **Fix**: ignorare `author_id` dal client e usare l'identità di sessione.

### M8 — Avviso `target_scope='classe'` con `target_classes=[]` accettato (incoerenza) 🆕
- **File**: `src/app/api/avvisi/route.ts` (POST non vieta classi vuote ai non-educator); notifica in
  `src/lib/notifiche/destinatari.ts` lo tratta come **globale**.
- **Cosa**: avviso «di classe» senza classi → **visibile a nessuno** nel feed (filtro né globale né classe-match) ma
  la **notifica** parte come globale → incoerenza tra ciò che viene notificato e ciò che è visibile.
- **Riprodotto LIVE**: POST accettato `201`.
- **Fix**: rifiutare `target_scope='classe'` con `target_classes` vuoto.

### M9 — `POST /api/locker/inventory` e `PATCH /api/locker/requests`: scrittura armadietto SENZA gate 🆕
- **File**: `src/app/api/locker/inventory/route.ts:187` (POST, solo Zod) e `src/app/api/locker/requests/route.ts:128`
  (PATCH, solo Zod). Nessun `require*`.
- **Cosa**: un anonimo con body valido scrive un carico/consumo nell'armadietto di **qualsiasi** bambino (IDOR write).
- **Riprodotto LIVE**: `POST` anonima `{alunno_id, materiale, quantita:7}` → `200`, riga creata (con
  `scuola_id=null`, non scoping). Riga rimossa a fine test.
- **Fix**: `requireParentOfStudent` sul POST (carico), `requireDocente`+scope sul PATCH requests.

---

## 🔵 MINORE

- **m1 — `GET /api/locker/materials` senza gate** 🆕 (`src/app/api/locker/materials/route.ts:48`): lettura anonima
  della config materiali (nessuna PII, ritorna i default). Fix: `requireUser`+scope.
- **m2 — «Pagamenti accorpati» inesistenti** 🆕: non c'è un incasso unico che salda più voci/più figli; i **fratelli**
  hanno voci separate e intestatario **per-figlio** (in G-MULTI, gmulti è intestatario di Alunno2 ma non di Alunno3).
  Nessun «paga tutta la famiglia». L'unico cross-voce è lo *spill* eccedenza sulle rate dello stesso piano. Da
  valutare una vista/pagamento famiglia unificato. (`src/lib/pagamenti/spill.ts`, `intestatari.ts`).
- **m3 — Multi-figlio avvisi**: un genitore con 2+ figli in **classi diverse** vede solo gli avvisi del **primo
  figlio**; l'adesione è contata per un solo `student_id` (`src/lib/auth/use-parent-identity.ts:43-56`,
  `src/app/(dashboard)/parent/avvisi/page.tsx:39,56,70`).
- **m4 — OTP Sistema A senza scadenza**: l'`otp_secret` (Sistema A, `form_submissions`) resta valido finché non c'è
  successo/rigenerazione, a differenza del Sistema B (10 min). Divergenza da uniformare.
- **m5 — `pagamenti.stato` `da_pagare`→`scaduto` solo via cron**: una voce con scadenza passata **nasce
  `da_pagare`** (la UI compensa con `aging.ts`); possibili disallineamenti a mezzanotte (`Europe/Rome`).
- **m6 — Divergenza saldo↔ledger mensa (potenziale)**: se l'INSERT su `mensa_ticket_movimenti` fallisce, il saldo è
  già scalato/riaccreditato (`prenotazioni/route.ts:178-188`). Loggato ma non transazionale.

---

## 🟢 VERIFICATO OK (funziona, con doppio oracolo UI+DB)

**Mensa**: ricarica ticket segreteria (saldo 57→62, `pagamenti` `pagato` 25€, ledger `ricarica+5`/`consumo-1`,
notifica `mensa_ricarica` a **entrambi** i genitori); forza prenotazione oltre cutoff (origine `segreteria`);
alternativa manuale; **banner allergeni genitore** (`pericolo:true`); Report Cucina espone allergene + alternativa
automatica; `allergie-check` genera l'alert; prenotazione futura entro cutoff (origine `genitore`); **disdetta oltre
cutoff bloccata** («Oltre l'orario limite»); doppia prenotazione **idempotente** («Già prenotato», nessun doppio addebito).

**Contabilità**: creazione voce; incasso pieno → `pagato`; **acconto su voce scaduta resta `scaduto`/moroso**
(regola «l'acconto non toglie la morosità» confermata); notifica distingue «Acconto registrato» vs «Pagamento
registrato», a **entrambi** i genitori; **sollecito end-to-end** (anteprima → invio → **email reale consegnata** da
`noreply@mail.kidville.it` in casella, `solleciti` audit, `pagamenti.ultimo_sollecito_il`); il genitore vede le voci
in sola lettura con «Totale da saldare», stato `Scaduto`, e scarica le **ricevute**.

**Modulistica**: **firma FEA con OTP end-to-end** (email OTP → verifica → `forms_submissions` firmata); OTP errato → 400.

**Avvisi**: pubblicazione (segreteria); **presa visione + adesione** genitore (upsert `avvisi_risposte`, `letto_il` +
`risposta='si'`); il genitore vede la bacheca «da gestire / hai aderito».

**Sicurezza (positivi)**: correttamente **401** (gate presente) su: `avvisi` create, `mensa/prenotazioni`,
`pagamenti/incassi`, `pagamenti/ticket/morosi`, `admin/pagamenti/sospensione`, `locker/notify`; `?userId=` sigillato
ovunque (tranne l'header di G2). Endpoint distruttivi/seed/debug **404 in prod** (`sealDangerous()`).

---

## Parte A — Findings del collaudo «giornata» (già trovati, ancora aperti)

**Sicurezza** (le 3 falle sopra come B1/G1/G2 sono la ri-conferma live di F1/F2/F3 della giornata).

**Prodotto** (dati di minori, da valutare):
- **Diario 0-6**: la **nota libera** di «salva merenda per tutti» viene scritta nel diario di **tutti** i bambini
  della sezione → la stessa nota è visibile a tutti i genitori (10 righe `eventi_diario` con nota identica).
- **Presenze primaria**: la vista genitore espone **solo le assenze**; un bambino presente non ha alcun indicatore
  positivo (indistinguibile da «appello non ancora fatto»).
- **Registro primaria**: **date in formato US** (MM/DD/YYYY) invece di DD/MM/YYYY.
- **Anagrafica**: **roster TEST 1A duplicato** — la stessa bambina due volte, una riga con il nome
  normalizzato e una in minuscolo con doppio spazio, e su una delle due un valore in `allergies`
  → 12 alunni invece di 10. Dato sporco preesistente, da bonificare.
  <!--
    ⚠️ QUI C'ERANO IL NOME E IL COGNOME DI UNA BAMBINA VERA E IL SUO DATO SANITARIO.
    Redatti il 2026-08-08, trovati dal tester privacy del terzo collaudo.
    Questa riga era stata scritta incollando l'output di una query sul database di
    PRODUZIONE, e committata in un repository PUBBLICO: nome, cognome e il valore di
    `allergies` — categoria particolare ex art. 9 GDPR — di una persona che in
    produzione risulta ALUNNA ISCRITTA, con codice fiscale e note mediche.
    Verificato prima di redigere: `select` su `public.alunni` → 2 righe, entrambe
    `stato='iscritto'`, entrambe con codice fiscale, una con esattamente quel valore.
    Il difetto non è il duplicato nel roster: è che per descriverlo si è ricopiato un
    dato reale invece di contarlo. Un conteggio dice la stessa cosa e non pubblica
    nessuno. La stessa anagrafica era finita anche nelle fixture dei test e in un
    commento di `src/`: anche quelle sostituite.
    ⚠️ Il testo resta nella STORIA di git: toglierlo da qui non lo toglie da lì.
  -->


Report visivo con screenshot: `e2e/collaudo-giornata/run/report-giornata.html`.
