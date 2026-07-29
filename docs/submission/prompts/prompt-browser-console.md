# Prompt — Console a schermo (Play Console · App Store Connect · Supabase · GitHub)

> Da incollare in una **nuova chat con il connettore «Claude in Chrome» attivo**.
> L'utente è già autenticato nelle console; l'assistente pilota il browser e compila.
> Aggiornato al **2026-07-28**. Fonti: `docs/submission/A1`, `A1b`, `A2`, `C1`, `C3`, `C4`.
>
> **Copia tutto quello che sta fra i due marcatori qui sotto.** È lungo di proposito:
> contiene i valori campo-per-campo, così chi legge deve solo cliccare.

---

──────────────────────────── INIZIO PROMPT ────────────────────────────

Lavoriamo a schermo sulle console della submission di Kidville. **Parli SOLO in italiano.**

Operi nel browser tramite l'estensione Chrome. Io sono già autenticato in tutte le console
(Google Play Console, App Store Connect, Supabase, GitHub, Vercel): non devi fare login, e se
una pagina te lo chiede fermati e dimmelo invece di provare a entrare.

Non devi scrivere codice né toccare il repository, salvo dove esplicitamente indicato. Il tuo
lavoro è: navigare, leggere quello che c'è davvero a schermo, compilare campi con i valori
esatti che ti do qui sotto, e **fermarti a chiedere ogni volta che la realtà non coincide con
questo prompt**.

═══════════════════════════════════════════════════════════════════════════
1 — CONTESTO MINIMO INDISPENSABILE
═══════════════════════════════════════════════════════════════════════════

**Prodotto**: «Kidville», registro elettronico di una scuola dell'infanzia (e primaria
paritaria). Next.js + Supabase, app nativa Capacitor che è una WebView su
`https://app.kidville.it`. Bilingue it/en. **Tratta dati personali di MINORI, inclusi dati
sanitari** (allergie alimentari, intolleranze, certificati medici, flag BES/DSA).

**Titolare del trattamento e futuro intestatario degli account store**:

| Campo | Valore |
|---|---|
| Ragione sociale (per esteso, mai abbreviata) | `SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA` |
| Forma giuridica | società cooperativa italiana — persona giuridica riconosciuta |
| P.IVA / Codice fiscale | `03394870616` |
| REA | `CE 240763` |
| Costituita il | `11/12/2007` |
| Sede **legale** | `Via Silvio Pellico 7, 81030 Cesa (CE), Italia` |
| D-U-N-S | `432360401` |
| Sito web | `https://www.kidville.it` |
| Email di lavoro / pubblica | `info@kidville.it` |
| Telefono | `+39 081 503 2070` |
| Team ID Apple | `B5ULCGG2V3` |
| App — Apple ID | `6794883055` |
| Bundle ID / package name | `it.kidville.app` |

⚠️ **`Via Filippo Turati 2` è la sede OPERATIVA e non va usata in nessuno di questi moduli.**
⚠️ Mai `Soc. Coop.`, mai `La Favola`, mai nomi di fantasia o insegne: Apple e Google
confrontano con D&B e con la visura, e un nome abbreviato fa respingere la verifica.

**Chi sono io — dillo così, non diversamente**

- Il **legale rappresentante** della cooperativa è **ERRICO CESARIO**.
- Io, **Luigi Errico**, sono **SOCIO** della cooperativa e agisco su **delega scritta** del
  legale rappresentante.
- 🛑 **NON dichiarare MAI Luigi Errico come legale rappresentante**, in nessun modulo Apple,
  Google, D&B o bancario. Apple e Google confrontano con la visura camerale e la smentirebbero.
  Errico Cesario si indica come **reference** che conferma l'autorità a vincolare l'ente.

═══════════════════════════════════════════════════════════════════════════
2 — ⚠️ REGOLE DI SICUREZZA PER TE CHE PILOTI IL BROWSER
═══════════════════════════════════════════════════════════════════════════

**Sono vincolanti. Violarne una costa più di tutto il lavoro che risparmi.**

1. **Mai password, chiavi o segreti scritti in chiaro nella chat.** Se un campo vuole una
   credenziale (password dell'account demo, chiave di firma, chiave di servizio, PIN),
   **fermati e dimmi «digitalo tu»**, oppure chiedimela e lascia che la incolli io direttamente
   a schermo. Non riportarla nel tuo riassunto, non rileggerla dal campo, non metterla in un
   file. Vale anche per i valori che vedi già scritti in un campo password.
2. **Prima di ogni azione IRREVERSIBILE, fermati e chiedi conferma esplicita.** In particolare:
   - pagamento dei **25 USD** di Google Play (e la scelta del **tipo di account**, che si fa
     una volta sola e prima di pagare);
   - **invio** del modulo DSA (Passo 6 «Confirm»): da lì i recapiti diventano pubblici;
   - **firma** della certificazione di conformità UE (Passo 5 del DSA);
   - **invio in revisione** dell'app su uno dei due store;
   - **upload di un `.aab`**: il `versionCode 1` si brucia al primo upload, anche solo su
     Internal testing, e non si riusa nemmeno eliminando l'upload;
   - **revoca** di una chiave Supabase, **push/merge** su GitHub, **modifica** di una variabile
     d'ambiente su Vercel;
   - **cambio della lingua predefinita** in Play Console.
   In tutti questi casi: mostrami il modulo compilato o l'azione che stai per fare, e aspetta
   il mio «ok».
3. **Non inviare in revisione finché TUTTI i prerequisiti non sono verdi.** L'elenco dei
   bloccanti è al §5. Se ne trovi uno rosso, l'invio non si fa: si scrive perché.
4. **Non dichiarare il falso in nessun modulo.** Se un dato non è in questo prompt e non l'hai
   verificato a schermo, **fermati e chiedimelo**. Non riempire «per non lasciare vuoto».
   Su tutti questi moduli la falsa dichiarazione non è un errore formale: su Apple espone a
   rimozione dell'app e revoca dell'account, su Google la *misrepresentation* nel Play Console
   porta a rimozione o **sospensione dell'account sviluppatore**.
5. **Non modificare la scheda di un'app mentre è in revisione**: fa ripartire la revisione da
   capo. Si invia e non si tocca più nulla.
6. **Se una specifica di questo prompt si rivela sbagliata o impossibile a schermo, FERMATI e
   dimmelo** invece di aggirarla. Un campo che a schermo si chiama diversamente non è un
   dettaglio: è il segnale che il modulo è cambiato.

═══════════════════════════════════════════════════════════════════════════
3 — LE SEQUENZE DA NON INVERTIRE
═══════════════════════════════════════════════════════════════════════════

| # | Sequenza | Perché |
|---|---|---|
| 1 | **Lingua predefinita `it-IT` PRIMA di caricare qualunque grafica su Play** | La lingua predefinita fa da fallback ovunque, grafiche comprese: se resta `en-US`, testo **e screenshot** compaiono in inglese anche agli utenti italiani |
| 2 | **Conversione Apple Individual → Organization PRIMA del DSA** | Il DSA pubblica indirizzo e telefono **sulla scheda App Store in 27 paesi UE**: con account Individual sarebbero i recapiti personali della persona fisica |
| 3 | **Parere legale (dossier A3) PRIMA del Passo 5 del DSA** | Il Passo 5 non è una casella: è una **certificazione sostanziale** che il servizio rispetta il diritto UE (GDPR compreso) |
| 4 | **URL della privacy policy PRIMA del modulo Data safety** | Senza URL privacy il modulo Sicurezza dei dati **non si completa** |
| 5 | **Pubblico di destinazione PRIMA della casella Families Policy** | Il pubblico determina se la Families Policy scatta o no: la casella dentro Data safety si risponde dopo, non prima |
| 6 | **App Privacy labels (ASC) e `ios/App/App/PrivacyInfo.xcprivacy` si toccano INSIEME** | È la divergenza fra i due che si paga; e il manifest viaggia dentro l'`.ipa`, quindi modificarlo senza ricaricare una build non cambia nulla per Apple |
| 7 | **Chiave Supabase: ruota → aggiorna Vercel → verifica produzione → revoca la vecchia** | In quest'ordine non c'è downtime. Revocare prima di aver aggiornato Vercel spegne la produzione |
| 8 | **Selezionare «Organizzazione» PRIMA di pagare i 25 USD di Play** | Il tipo di account si sceglie una volta sola; org → personale **non è offerta**, ed è irreversibile |
| 9 | **A3 (legale) → A2 (App Privacy labels) → Passo 5 DSA** | È l'ordine imposto da A1 §2: A3 è la catena più lunga e sblocca sia il DSA sia le Data safety di Play |

═══════════════════════════════════════════════════════════════════════════
4 — COSA È GIÀ FATTO (non rifarlo, non riaprirlo)
═══════════════════════════════════════════════════════════════════════════

- ✅ **C5 in produzione** (PR #52, `3e8eb79`): cancellazione account pubblica + moderazione UGC.
  L'URL `https://app.kidville.it/cancellazione-account` esiste.
- ✅ **Fix GDPR dell'oblio in produzione** (PR #53, `8e5646c`): `parents.id` ≠ `auth.user.id`,
  il ponte è `parents.auth_user_id`. L'oblio self-service ora anonimizza davvero; corretti anche
  lo scrub UGC e l'email-bombing sul canale pubblico.
- ✅ **Chiave di servizio rimossa dal repository** (stessa PR): i 4 script che la contenevano in
  chiaro — `scripts/apply_migration.mjs`, `scripts/apply_fase3_migration.mjs`,
  `scripts/seed_armadietto_rest.mjs`, `scripts/seed_mock_data.mjs` — sono stati eliminati
  (erano codice morto). **Resta da confermare a schermo che la chiave sia revocata → BLOCCO B1.**
- ✅ **Account demo del revisore RIPARATO** (`9dca9e5`): `test.inf.genitore1@kidville.test`
  esisteva in `auth.users` ma **non** in `utenti` (nessuna identità applicativa), e **nessuno**
  dei 10 alunni della sezione TEST Infanzia era collegato a un genitore — un revisore avrebbe
  fatto login e trovato il nulla. Ora la catena è completa (riga `utenti`, 10 legami, consensi
  GDPR, onboarding). L'account ha una **password dedicata**, diversa da quella comune ai 41
  account di test, in `~/Documenti/kidville-play/.demo-revisore-pw` sul mio disco.
  ⚠️ **Va trascritta nel gestore di credenziali e incollata a mano** nei campi «Accesso
  all'app» di Play e «App Review Information» di Apple. Non chiedermela in chat: la digito io.
- ✅ **5 screenshot Play** catturati a **1080×1920 esatti**, **RGB senza alpha**, verificati a
  vista uno per uno, in
  `/Users/lerri/kidville-web/docs/submission/assets/playstore/screenshots/phone/`:
  `01-avvisi.png` · `02-diario.png` · `03-presenze.png` · `04-mensa.png` · `05-pagamenti.png`.
  Sono **pronti da caricare così come sono**: nessuna conversione necessaria.
- ✅ **Icona e feature graphic pronte** in `/Users/lerri/kidville-web/docs/submission/assets/`
  (dettagli e vincolo alpha nel BLOCCO B5).
- ✅ **Build iOS `1.0 (1)` su TestFlight**, firmata `Apple Distribution` con
  `aps-environment = production`. Scheda App Store già compilata con 12 screenshot.
- ✅ **`.aab` Android firmato e verificato** (`jarsigner -verify`: jar verified) in
  `/Users/lerri/kidville-web/android/app/build/outputs/bundle/release/app-release.aab`,
  `versionCode 1`, `versionName "1.0"`.
- ✅ **Decisioni chiuse, non da riaprire a schermo**: account Play = **Organizzazione**;
  categoria = **Istruzione**; pubblico = **18+**; ragione sociale per esteso; sede legale di
  Cesa; email pubblica `info@kidville.it`; **mascotte mantenuta** su icona e feature graphic
  (il titolare ha accettato consapevolmente il rischio di riclassificazione di C4 §2).

═══════════════════════════════════════════════════════════════════════════
5 — OROLOGI E BLOCCANTI
═══════════════════════════════════════════════════════════════════════════

- ⏰ **La build TestFlight `1.0 (1)` scade il 2026-10-24.** Dopo, va ricaricata una build nuova.
- ⏰ I dati demo della classe TEST Infanzia sono datati **2026-07-26** e il diario mostra
  14 giorni indietro: **dopo il 2026-08-09** le schermate del revisore si svuotano. Se la review
  cade dopo quella data, i dati vanno rinfrescati prima.
- 🔴 **Bloccanti umani ancora aperti** (nessuno dei due si chiude a schermo):
  1. **Validazione legale di `/privacy` e `/termini`** (dossier A3, da consegnare al legale).
     Blocca il **Passo 5 del DSA** *e* le **Data safety di Play**.
  2. **Due prove su iPhone FISICO** — push in ambiente `production` e offline in modalità aereo.
     Non osservabili da simulatore, aperte da tre changelog.
- 🟡 Tempi documentati da Google: verifica identità/pagamento **fino a 5 giorni**; prima
  revisione di un account nuovo **«da poche ore a 7 giorni o più»**; incoerenza fra ragione
  sociale D&B e profilo pagamenti = timer **28 giorni**, scaduto il quale account e app vengono
  rimossi. Stima complessiva **2-3 settimane** (D-U-N-S già in mano).

═══════════════════════════════════════════════════════════════════════════
BLOCCO B1 — SUPABASE · confermare che la chiave di servizio esposta sia REVOCATA
═══════════════════════════════════════════════════════════════════════════

**Priorità: prima di tutto il resto.** È l'unica voce di questa lista che è un incidente di
sicurezza aperto, non un adempimento.

**Il fatto**: quattro script committati contenevano in chiaro una chiave `sb_secret_…` del
progetto di **produzione** e il suo URL, tracciati da git **dal 2026-05-12**, con il repository
**pubblico fino al 2026-07-26**. Quella chiave scavalca tutte le RLS su un database che contiene
dati di minori, e in produzione esiste `public.exec_sql` (SECURITY DEFINER, di proprietà di
`postgres`, eseguibile dal solo `service_role`): la fuga non dava solo lettura, dava
**esecuzione di SQL arbitrario**. Gli script sono stati eliminati, ma **eliminare il file non
revoca la chiave**: resta nella storia di git e in qualunque clone.

**Dove andare**:
```
https://supabase.com/dashboard/project/uimulkjyekgemjakmepp/settings/api-keys
```
(se il percorso è cambiato: Dashboard → progetto di produzione → **Project Settings** → **API
Keys**; guarda sia la scheda delle chiavi nuove `sb_publishable_…`/`sb_secret_…` sia
l'eventuale scheda «Legacy API keys» con `anon`/`service_role` JWT).

**Cosa verificare a schermo, in quest'ordine:**

1. L'elenco delle chiavi **di tipo `secret`**. L'elenco via CLI del 2026-07-27 non mostrava
   alcuna chiave `secret` attiva, **ma la CLI sa elencare e non revocare**: la conferma vale solo
   se la vedi in dashboard.
2. Se **non** esiste nessuna chiave `secret` attiva → riportamelo e passa al blocco successivo,
   annotando data e ora della verifica.
3. Se **esiste ancora una chiave `secret` attiva**, e in particolare se il suo prefisso coincide
   con quella che era negli script (chiedimi il prefisso, **non incollarlo tu in chat per
   esteso**), allora si ruota. **In quest'ordine, senza saltare passi — così non c'è downtime:**

   | # | Azione | Dove |
   |---|---|---|
   | 1 | **Crea una nuova secret key** (non revocare ancora niente) | Supabase → Project Settings → API Keys → *Create new secret key* |
   | 2 | **Aggiorna `SUPABASE_SERVICE_ROLE_KEY`** su Vercel, ambiente **Production** (e Preview/Development se presenti) | `https://vercel.com/` → progetto `kidville-web` → Settings → Environment Variables |
   | 3 | **Ridistribuisci** l'ultimo deploy di produzione (le env var non si applicano ai deploy già fatti) | Vercel → Deployments → *Redeploy* sull'ultimo di produzione |
   | 4 | **Verifica che la produzione risponda**: apri `https://app.kidville.it`, fai un'azione che passa dal service-role (una pagina admin/segreteria, oppure `https://app.kidville.it/cancellazione-account` che deve rispondere **200** anche da finestra anonima) | browser |
   | 5 | **Solo ora revoca la chiave vecchia** | Supabase → API Keys → *Revoke* sulla chiave precedente |
   | 6 | Ricontrolla la produzione dopo la revoca | browser |

   ⚠️ Il passo 5 è irreversibile: chiedimi conferma esplicita prima.
   ⚠️ La chiave nuova **non va scritta in chat, né in un file del repo**: la copio io dalla
   dashboard e la incollo io su Vercel. Tu guidi, non trascrivi.

4. **Domanda collaterale da porre, non da risolvere di tua iniziativa**: `public.exec_sql`
   (SECURITY DEFINER, eseguibile dal solo `service_role`) serve ancora? Se no, va droppata —
   ma è una migrazione, cioè lavoro lato repo, **non lavoro tuo a schermo**. Segnalamelo e basta.

═══════════════════════════════════════════════════════════════════════════
BLOCCO B2 — GITHUB · protezione di `main` caduta + required reviewers su `production`
═══════════════════════════════════════════════════════════════════════════

**Il fatto**: il repository `erricoluigi17/kidville-web` è stato reso **privato** il 2026-07-26.
Su **GitHub Free le branch protection non valgono sui repository privati**: la protezione di
`main` è quindi **caduta**. Verificato via API:
`gh api repos/erricoluigi17/kidville-web/branches/main/protection` → **403 «Upgrade to GitHub
Pro»**. Oggi chiunque abbia accesso in scrittura può pushare direttamente su `main`, e la CI non
è un gate obbligatorio.

**B2.a — decisione da prendere con me (non decidere da solo):**

| Opzione | Costo | Conseguenza |
|---|---|---|
| **A — GitHub Pro** | abbonamento a pagamento | Il repo resta privato **e** le branch protection tornano valide |
| **B — repo di nuovo pubblico** | gratis | Le branch protection tornano valide, ma il codice torna leggibile a chiunque. ⚠️ Da valutare **solo dopo** aver chiuso B1: era proprio la combinazione repo-pubblico + chiave in chiaro a costituire la fuga |
| **C — accettare il rischio** | gratis | Nessuna protezione su `main`. Sconsigliato, ma è una decisione del titolare |

Fammi la domanda secca, con la raccomandazione, e **non muovere nulla finché non rispondo**.

**B2.b — Required reviewers sull'environment `production`** (indipendente dalla scelta sopra,
e da fare comunque):

```
https://github.com/erricoluigi17/kidville-web/settings/environments
→ environment "production" → Deployment protection rules → ☑ Required reviewers
→ aggiungere il titolare come reviewer → Save protection rules
```

**Perché**: l'environment `production` è quello usato dal workflow
`.github/workflows/migrate.yml`. Senza required reviewers, **una migrazione può toccare il
database di produzione senza approvazione umana** — e quel database contiene dati di minori.
È il punto 4 del promemoria pre-lancio in `CLAUDE.md`.

⚠️ Se anche gli environment protection rules risultassero indisponibili sul piano Free per repo
privati (**DA VERIFICARE a schermo**: GitHub li limita in modo diverso dalle branch protection),
riportamelo: cambia il peso dell'opzione A.

═══════════════════════════════════════════════════════════════════════════
BLOCCO B3 — GOOGLE PLAY CONSOLE · C1, l'account sviluppatore
═══════════════════════════════════════════════════════════════════════════

**Questo blocco viene prima di tutto il resto su Play**: senza l'account giusto, la scheda e i
moduli si compilano nel posto sbagliato.

**Situazione**: ho **già un account Play personale esistente**, e vorrei **tentare la
conversione** a organizzazione **recuperando i 25 USD** già pagati.

**Cosa dice il dossier (C1), alla lettera — riportamelo prima di agire:**

- La decisione presa è **ORGANIZZAZIONE, senza alternative**. Motivi: (1) su account personale
  comparirebbe una **persona fisica** come sviluppatore di un'app che tratta dati sanitari di
  minori; (2) il Titolare dichiarato su `/privacy` è la cooperativa — un account personale è una
  contraddizione «visibile al revisore e insanabile a posteriori»; (3) evita il gate dei tester;
  (4) Google impone l'account organizzazione per le app sanitarie (`answer/13634885`);
  (5) *«You can't change the account type from an organization to an individual account»* —
  org → personale è **irreversibile**.
- 🔴 **Sulla conversione, C1 §4 «trappola 1» è esplicito e la SCONSIGLIA**:
  > *«Apro personale per fare prima, poi converto.» È il contrario.*
  La conversione **esiste** come percorso, ma **non fa risparmiare un solo giorno**: richiede
  **comunque il D-U-N-S**, **più** la verifica del sito web, **più** **72 ore di attesa** prima
  di poter inviare nuove app, **e nessuna garanzia documentata che un gate 12-tester già
  scattato venga annullato**. La raccomandazione operativa di C1 è: **aprire direttamente un
  account nuovo di tipo Organizzazione**.
- ⚠️ **Il dossier non dice se e come i 25 USD si recuperano convertendo.** Questo è il punto che
  mi interessa e che **non è documentato**: → **DA VERIFICARE a schermo**.

**Cosa verificare a schermo, e riferirmi prima di qualunque azione:**

1. **Il tipo dell'account attuale** e la data di creazione:
   `Play Console → Impostazioni → Dettagli sviluppatore` (o `Account details`).
   La data serve per il gate tester: vale **solo per i nuovi account PERSONALI creati dopo il
   13 novembre 2023**.
2. **Se il gate «12 tester × 14 giorni» è già scattato** su quell'account:
   `Play Console → app → Test → Closed testing` / banner «production access».
   Valori documentati: **12 tester** (non 20, dall'11 dicembre 2024), **14 giorni continuativi**
   di opt-in, «un tester che esce spezza la continuità», servono **12 account Google reali e
   distinti** (NON i 41 account applicativi Kidville). **Non esiste la scorciatoia open
   testing**: *«Must have gained access to production to access open testing»*.
3. **Se in Console esiste davvero una voce di conversione** personale → organizzazione, e cosa
   dice esattamente su: quota già pagata, D-U-N-S richiesto, attesa di 72 ore, sorte del gate
   tester. **Riportami il testo letterale della schermata, non un riassunto.**
4. **Se `it.kidville.app` è ancora libero su Play** — prima di creare qualunque scheda. Una volta
   pubblicato, il package name non si cambia mai più.

**Se si procede con un account NUOVO di tipo Organizzazione — valori da inserire:**

| Campo a schermo | Valore |
|---|---|
| *Che tipo di account vuoi creare?* / *Account type* | **Organizzazione / Organization** — 🛑 **selezionare PRIMA di pagare i 25 USD** |
| Nome legale dell'organizzazione | `SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA` — deve coincidere **alla lettera** con D&B e con Apple |
| D-U-N-S | `432360401` — ⚠️ **i tentativi di inserimento sono limitati: non si tira a indovinare** |
| Indirizzo | `Via Silvio Pellico 7, 81030 Cesa (CE), Italia` |
| Sito web | `https://www.kidville.it` |
| Email di contatto pubblica | `info@kidville.it` — 🔴 **mai una PEC**: i gestori PEC rifiutano la posta ordinaria, il revisore Google e i genitori si prenderebbero un errore di consegna (lezione già pagata, documentata nel sorgente di `/assistenza`) |
| Telefono di contatto pubblico | numero del centralino — **DA CONFERMARE**: il dossier dice «numero del centralino» senza fissarne il valore; il numero usato altrove è `+39 081 503 2070` |
| Google Account proprietario | 🔴 **un Google Account ISTITUZIONALE della cooperativa. MAI `erricoluigi17@gmail.com`, mai un indirizzo personale.** Solo il **proprietario** può avviare e completare la verifica dell'identità; se quella casella diventa inaccessibile l'account si recupera solo via ticket. ⚠️ **La casella istituzionale risulta ANCORA DA CREARE** (riga B della tabella C1 §3): se non esiste, si crea prima |
| Costo | **25 USD** una tantum, da pagare **solo dopo** aver selezionato «Organizzazione» |

**Documenti da tenere pronti per la verifica**: **visura camerale** + **documento d'identità del
legale rappresentante (Errico Cesario)**, 🔴 **integri, senza alcun oscuramento** — *«No data in
the ID can be blocked»*, per obblighi antiriciclaggio UE. «È l'abitudine italiana di annerire il
numero di documento nelle copie, ed è la causa più banale di verifica respinta.»

**Sito web verificato**: prerequisito per gli account organizzazione creati dal 2024 — serve
accesso a **DNS o Search Console di `kidville.it`**. Se il dominio è gestito da terzi, l'accesso
va chiesto **adesso**, non quando il modulo lo pretende.

**Cosa NON fare in questo blocco**: non pagare, non selezionare il tipo di account, non inserire
il D-U-N-S, non caricare documenti — senza il mio ok esplicito su ciascuna di queste quattro cose.

═══════════════════════════════════════════════════════════════════════════
BLOCCO B4 — PLAY CONSOLE · C3 §0, la lingua predefinita (LA PRIMA COSA)
═══════════════════════════════════════════════════════════════════════════

🔴 **Da fare PRIMA di caricare qualunque grafica e qualunque testo.**

| Campo | Valore |
|---|---|
| **Gestisci traduzioni → Cambia lingua predefinita** | **`it-IT`** — Italiano (Italia). Va cambiata da `en-US` (default presunto oggi) |

**Perché**: *«la lingua predefinita fa da fallback ovunque, grafiche comprese. Se resta
`en-US`, in ogni locale non tradotto testo **e screenshot** compaiono in inglese — anche a
utenti italiani»*.

⚠️ Il documento riporta **solo il segmento finale del percorso** (`Gestisci traduzioni → Cambia
lingua predefinita`); il ramo di menu che lo precede — verosimilmente *Presenza nello store →
Scheda dello store principale* — **non è scritto nei documenti**: → **DA VERIFICARE a schermo**,
trovalo tu e riportami il percorso esatto.

⚠️ Il documento **non afferma** che l'operazione sia irreversibile: la definisce «la prima cosa
da fare» perché il fallback si propaga a tutto ciò che è già stato caricato. Chiedimi conferma
prima di cambiarla comunque.

═══════════════════════════════════════════════════════════════════════════
BLOCCO B5 — PLAY CONSOLE · C3, la scheda dello store (testi + grafica)
═══════════════════════════════════════════════════════════════════════════

Percorso: **Play Console → app «Kidville» → Presenza nello store → Scheda dello store principale**.

### B5.1 — Titolo (campo «Nome dell'app», max 30 caratteri)

| Campo | Valore |
|---|---|
| **Nome dell'app / App name** (it-IT) | `Kidville — Registro scuola` |

- **26 caratteri ✓**. Il trattino è un **em dash `—` (U+2014)**, non un trattino corto.
- Alternative già dentro il limite, se il campo protesta: `Kidville Registro Scuola` (24) ·
  `Kidville — Registro` (19).
- ⚠️ Nessuna emoji, nessun tutto-maiuscolo, nessun simbolo ripetuto.

### B5.2 — Descrizione breve (max 80 caratteri)

| Campo | Valore |
|---|---|
| **Descrizione breve** (it-IT) | `App per genitori e personale della Scuola dell'Infanzia La Favola` |
| **Short description** (en-US, solo se e quando si aggiunge la locale) | `For parents and staff of Scuola dell'Infanzia La Favola` |

- IT = **65 caratteri ✓**. EN = **55 caratteri ✓**.
- 🔴 Questa riga fa **doppio lavoro**: descrive il prodotto **e dichiara il pubblico adulto**,
  che è la difesa contro la riclassificazione d'ufficio come app «per bambini» (C4 §2).
  **Non alterarla.**

### B5.3 — Descrizione completa (tetto 4.000 caratteri)

Regole: i 4.000 sono **un tetto, non un obiettivo** — la policy metadati elenca «lunghezza
eccessiva, dettaglio, formattazione impropria o ripetizione» fra le cause di violazione.
🔴 **Nessuna parola «gratis»/«free»**: è dichiarazione di prezzo, vietata nei metadati.

**Testo da incollare — parola per parola questo, senza aggiungere né togliere nulla**
(≈1.919 caratteri, ampiamente sotto il tetto):

```
Kidville è l'app riservata ai genitori e al personale della Scuola dell'Infanzia La Favola. L'accesso avviene solo con le credenziali consegnate dalla Segreteria: non è prevista registrazione libera e l'app non è destinata ai bambini, che non hanno un account.

PER I GENITORI
• Diario giornaliero — come è andata la giornata: umore, entrata, pasti, sonno, attività, la nota della maestra e la foto del giorno.
• Assenze — segnala un'assenza e invia la giustifica direttamente dall'app.
• Mensa — menù della settimana con gli allergeni, prenotazione e disdetta del pasto entro l'orario di cutoff, saldo dei ticket.
• Avvisi e circolari — con presa visione e adesione.
• Chat con le insegnanti — comunicazione diretta con la sezione.
• Galleria — foto e video della classe, riservati alle famiglie della sezione.
• Pagamenti — scadenziario delle rette, storico e causale per il bonifico. I pagamenti avvengono fuori dall'app.
• Moduli e modulistica — compilazione e firma dei consensi, con verifica via codice.
• Armadietto — scorte e materiale del bambino.
• News — comunicati e notizie della scuola.
• Profilo e deleghe — gestione dell'account, sblocco con impronta o riconoscimento del volto, privacy e cancellazione dei dati.

PER IL PERSONALE
Appello della giornata, agenda della sezione, allergie e note mediche degli alunni, compilazione del diario, bacheca interna, registro di classe e valutazioni per la primaria.

NOTIFICHE
Avvisi, messaggi e scadenze arrivano come notifica sul telefono, con il contatore sull'icona dell'app.

ANCHE SENZA CONNESSIONE
Le pagine già visitate restano consultabili anche quando la rete manca.

PRIVACY
Nessuna pubblicità, nessun tracciamento, nessuno strumento di analisi del comportamento. I dati sono trattati da Scuola dell'Infanzia La Favola Soc. Coop. (Cesa, CE) secondo l'informativa pubblicata su app.kidville.it/privacy.

Kidville è disponibile in italiano e in inglese.
```

> Nota: nel file sorgente `C3-scheda-testi-grafica.md` questo blocco è **a capo fisso a ~68
> colonne** per leggibilità in Markdown. Quegli a-capo sono impaginazione, **non testo**: la
> versione qui sopra è la stessa, parola per parola, con le righe di continuazione unite.
> Intestazioni su riga propria, riga vuota fra i blocchi, un bullet `•` per riga.

**Descrizione completa in inglese: NON ESISTE nel dossier.** Il §1 di C3 fornisce la versione EN
**solo della descrizione breve**. **Raccomandazione: alla prima submission pubblicare la sola
locale `it-IT`** e aggiungere `en-US` in un secondo momento — così si evita anche di modificare
la scheda mentre è in revisione, cosa che fa ripartire la revisione da capo.

**Se e quando si scriveranno testi EN, la terminologia si prende dai cataloghi `messages/en/`,
tale e quale** — non si inventa:
**Canteen** (❌ mai «Cafeteria») · **Notices** · **Locker** · **My diary** · **My photos** ·
**Profile and delegations** · **Report absence** · **Chat with the teachers** · **Payments**.
> *«Una scheda che dice "Cafeteria" mentre l'app dice "Canteen" sembra un altro prodotto — e su
> Play l'incoerenza scheda↔app è materia di "Ingannevole", non di stile.»*

### B5.4 — Impostazioni della scheda

| Campo | Valore |
|---|---|
| **Categoria dell'app** | **Istruzione** *(Education)* — 🔴 **MAI «Social», MAI «Comunicazione»**, anche se c'è la chat genitore↔docente: la Child Safety Standards policy si applica **per categoria dichiarata, non per pubblico** (*«The presence or absence of child users in your app is irrelevant to this policy»*). Dichiarare «Social» farebbe scattare standard anti-CSAE pubblicati sul web, meccanismo di feedback in-app, gestione CSAM e **un punto di contatto nominativo per la sicurezza dei minori** |
| **Tipo** | **App** (non Gioco) |
| Email di contatto | `info@kidville.it` |
| Sito web | `https://www.kidville.it` |
| Telefono | **DA CONFERMARE** (vedi decisione aperta §6) |

### B5.5 — Grafica

Percorso: **Presenza nello store → Grafica**.

| Campo di Play Console | File (percorso assoluto) | Dimensioni | Alpha | Peso |
|---|---|---|---|---|
| **Icona dell'app** | `/Users/lerri/kidville-web/docs/submission/assets/play-icon-512.png` | **512 × 512** | **RGBA — alpha PRESENTE ✓** (obbligatorio) | 307 KB (limite 1024 KB) |
| **Immagine in evidenza** / Feature graphic | `/Users/lerri/kidville-web/docs/submission/assets/play-feature-graphic-1024x500.png` | **1024 × 500** | **RGB — SENZA alpha ✓** (alpha vietato) | 271 KB |

🔴 **Regola alpha — l'errore di upload più comune**: *«Icona = alpha OBBLIGATORIO. Immagine in
evidenza e screenshot = alpha VIETATO.»* Invertire i due profili **blocca il salvataggio della
scheda** con un messaggio d'errore non esplicito. I due file sopra sono già corretti.

**Screenshot del telefono** — cartella
`/Users/lerri/kidville-web/docs/submission/assets/playstore/screenshots/phone/`:

| File | Contenuto | Dimensioni | Alpha | Stato |
|---|---|---|---|---|
| `01-avvisi.png` | Comunicazioni con circolare da leggere | 1080 × 1920 ✓ | RGB ✓ | pronto |
| `02-diario.png` | Diario del giorno: umore, entrata, merenda | 1080 × 1920 ✓ | RGB ✓ | pronto |
| `03-presenze.png` | Segnalazione di un'assenza | 1080 × 1920 ✓ | RGB ✓ | pronto |
| `04-mensa.png` | Giornata e avvisi | 1080 × 1920 ✓ | RGB ✓ | pronto |
| `05-pagamenti.png` | Rette e scadenze | 1080 × 1920 ✓ | RGB ✓ | pronto |

- ✅ **Tutti RGB senza alpha**, verificati con `sips -g hasAlpha`. Le prime tre erano state
  catturate con `adb exec-out screencap`, che produce **RGBA**: sono state riconvertite. È
  l'errore di upload più comune e il messaggio di Play non è esplicito.
- Il formato **1080×1920** è quello «d'oro» prescritto (rapporto 1,78, dentro il vincolo «lato
  max ≤ 2× lato min», sopra la soglia promozionale). Minimo per pubblicare: **2** ✓. Minimo per
  l'idoneità alle promozioni: **4 a ≥1080 px in 9:16** ✓. **La soglia è superata: la scheda è
  caricabile così com'è.**
- ⚠️ **Mancano tre schermate telefono** (modulistica, news, profilo) e i **4 screenshot TABLET**.
  Non bloccano la pubblicazione. Le tre voci stanno in fondo al foglio MENU dell'app, dove il tap
  automatico non naviga: vanno catturate a mano o con un altro approccio.
  **DA VERIFICARE a schermo**: se Play pretende i tablet per pubblicare o solo per l'idoneità ai
  dispositivi grandi. Riportamelo.
- **Video promozionale**: campo **da lasciare VUOTO** — «omettere alla prima submission».

🔴 **MAI caricare** le immagini in `e2e/collaudo-giornata/run/screenshots/` (51 file) né
`e2e/primaria-360/run/screenshots/`: sono catture di collaudo su **produzione**, con viste
segreteria sull'anagrafica **reale** della sede. Sono gitignorate di proposito. Una scheda store
è pubblica e indicizzata mondialmente.

**Vincoli sugli screenshot**: vietati cornici di dispositivo e mockup · persone che toccano lo
schermo · badge/icone di Google Play o altri store · loghi e personaggi di terzi · immagini
sfocate/distorte/pixelate/stirate · call-to-action tipo «Scarica ora» · tagline oltre il **20%**
dell'immagine. Una **cornice iPhone** su Play somma **due** violazioni (cornice + marchio di
terzi).

**Nota sull'icona, già accettata dal titolare — non riaprirla**: `play-icon-512.png` è la stessa
immagine dell'icona iOS (`AppIcon-512@2x.png`), che è un mockup con **angoli arrotondati e ombra
dipinti nei pixel**; Play applica **la propria** maschera (raggio 30%) e ombra → l'icona avrà un
**doppio bordo arrotondato** visibile. Coerente con App Store, non ideale su Play. Se Play la
segnala in review, la correzione è rigenerare da `public/mascot.png`. **La mascotte è mantenuta
per scelta esplicita del titolare**, nonostante C4 §2 raccomandi grafica sobria: decisione
chiusa, non da riaprire a schermo.

═══════════════════════════════════════════════════════════════════════════
BLOCCO B6 — PLAY CONSOLE · C4, i moduli «Contenuti dell'app»
═══════════════════════════════════════════════════════════════════════════

Percorso base: **Play Console → app «Kidville» → Norme e programmi → Contenuti dell'app**
(`Policy → App content`).

### B6.0 — Ordine di compilazione (non è arbitrario)

| # | Modulo | Dipende da | Perché in quest'ordine |
|---|---|---|---|
| 1 | **Norme sulla privacy** (URL) | niente | Senza URL privacy **il modulo Sicurezza dei dati non si completa** |
| 2 | **Pubblico di destinazione e contenuti** | niente | Determina se scatta o no la Families Policy; va deciso prima di rispondere alla casella Families dentro Data safety |
| 3 | **Classificazione dei contenuti (IARC)** | categoria app già su *Istruzione* | Il questionario chiede la categoria; e va rifatto a ogni cambio di contenuto |
| 4 | **Health apps declaration** | niente | Blocca la pubblicazione **anche su closed testing** se manca |
| 5 | **Sicurezza dei dati (Data safety)** | 1 + URL cancellazione + decisione cleartext + verifica manifest | È l'ultimo perché consuma gli output di tutti gli altri |
| 6 | Annunci · Accesso alle app · Notizie · COVID · Governo · Funzionalità finanziarie | niente | Moduli brevi, ma tutti obbligatori per uscire dalla schermata senza avvisi |

**Prerequisiti da avere pronti prima di iniziare:**

| Cosa | Valore |
|---|---|
| URL Norme sulla privacy | `https://app.kidville.it/privacy` |
| URL cancellazione account | `https://app.kidville.it/cancellazione-account` |
| Email di contatto pubblica | `info@kidville.it` — **mai una PEC** |
| Categoria app | **Istruzione** *(Education)* |
| Account demo per il revisore | `test.inf.genitore1@kidville.test` (password dedicata, la incollo io) |

⚠️ **Prima di incollare l'URL di cancellazione**: apri `https://app.kidville.it/cancellazione-account`
**da una finestra anonima** e verifica che risponda **200**. Il prefisso è pubblico
(confermato in `src/lib/auth/middleware-rules.ts:34`), ma va visto.

### B6.1 — Norme sulla privacy (modulo 1)

| Campo | Valore |
|---|---|
| **URL** | `https://app.kidville.it/privacy` |

Requisito **separato** e **prerequisito** del Data safety. La pagina deve essere: attiva,
pubblicamente accessibile, **non geolocalizzata, non un PDF, non modificabile dall'utente**,
etichettata «Privacy Policy», con sviluppatore + contatto privacy, dati personali e sensibili
trattati, **sub-responsabili**, trattamento sicuro, conservazione, cancellazione. Il link è già
esposto dentro l'app (`/parent/profilo`) ✓.

🔴 **Bloccante noto**: `/privacy` **manca ancora la validazione legale (A3)** e **va verificato
che nomini**: Supabase, Vercel, Google FCM, Resend, Aruba/SDI, i tempi di conservazione, e una
sezione cancellazione raggiungibile via **anchor link**. Aprila e leggila a schermo prima di
dichiararla, e dimmi cosa manca.

### B6.2 — Pubblico di destinazione e contenuti (modulo 2)

| Campo a schermo | Valore |
|---|---|
| **Fasce d'età target** | spuntare **SOLO «18 anni e oltre»**. Lasciare vuote: *5 anni e meno · 6-8 · 9-12 · 13-15 · 16-17* |
| *La tua app potrebbe interessare involontariamente i bambini?* / *Appeal to children* | **NO** |
| **«Limita l'accesso ai minori» / Restrict Minor Access** | **NON attivare.** Obbligatoria solo per gioco d'azzardo con denaro reale, dating/matchmaking e — dal 26 agosto 2026 — chat anonime/casuali. Per Kidville è facoltativa e **sconsigliata**: bloccherebbe ricerca, download e installazione a chiunque Google classifichi come minore **o di età non determinata** (un genitore giovane con l'età mal impostata sul Google Account non riuscirebbe più a installare l'app della scuola, e il supporto non può sbloccarlo) |
| **Programma «Designed for Families» / «Progettata per le famiglie»** | **Non partecipare** — *«At least one of your app's target age groups must include children»*: con 18+ non si può e non si deve. Nessuna penalizzazione |

🔴 **L'antidoto grafico — è la condizione di validità della dichiarazione 18+.** Google può
**ribaltarla**: *«Regardless of what you identify in the Google Play Console, if you choose to
include imagery and terminology in your app that could be considered targeting children, this
may impact Google Play's assessment»*, e se la scheda contiene *«youthful animation or young
characters in the graphic assets»* può **rifiutare l'app**. **Kidville è la fattispecie
nominata**: si chiama «**Kid**ville», ha una mascotte cartoon 3D e una palette giocosa
(#FDC400, #FEF1E4). Quindi:

- Screenshot **dell'interfaccia gestionale** (presenze, pagamenti, avvisi, menù della
  settimana) — **niente bambini, niente volti**. → verifica gli 8 file prima di caricarli.
- Prima riga della descrizione completa e descrizione breve: dicono che l'app è per genitori
  adulti e personale ✓ (già così).
- **Il titolare ha scelto di mantenere la mascotte su icona e feature graphic**, accettando il
  rischio. Decisione chiusa — ma se Google solleva l'obiezione in review, è **questo** il punto
  da cui ripartire, e la correzione è rigenerare le grafiche da `public/mascot.png`.

⚠️ *«Misrepresentation of any information about your app in the Play Console, including in the
target audience and content section, may result in removal or suspension.»* Dichiarare 18+ e poi
vendere l'app come «per i bambini» nella descrizione è la strada più veloce alla sospensione.

⚠️ **Esente dalla Families Policy ≠ nessun obbligo sui minori**: restano obbligatorie Target
audience and content, IARC, Data safety, privacy policy e **Child Endangerment**. E l'esenzione
è da Google, **non dalla legge**: COPPA e GDPR restano interi.

### B6.3 — Classificazione dei contenuti (questionario IARC, modulo 3)

| Domanda a schermo | Risposta |
|---|---|
| Indirizzo email (referente IARC) | `info@kidville.it` |
| **Categoria dell'app nel questionario** | **Utility, produttività, comunicazione o altro** — ⚠️ vedi decisione aperta D4 al §6. L'unica esclusione categorica è **«non Game/Gioco»** |
| Violenza / sangue / crudeltà | **No** a tutto |
| Sessualità, nudità | **No** a tutto |
| Linguaggio volgare | **No** |
| Sostanze controllate (droga, alcol, tabacco) | **No** |
| Gioco d'azzardo / simulazione di gioco d'azzardo | **No** |
| Paura, orrore, contenuti disturbanti | **No** |
| Discriminazione | **No** |
| **Acquisti in-app / articoli digitali** | **NO** — le rette si pagano fuori dall'app: contanti, bonifico, POS, assegno. Va dichiarato coerentemente anche nella sezione dedicata della Console |
| **Condivisione della posizione dell'utente con altri utenti** | **NO** |
| **Gli utenti possono interagire o comunicare fra loro** | **SÌ** — chat genitore↔docente |
| **Condivisione di contenuti generati dagli utenti** | **SÌ** — galleria di classe, diario, foto |
| **Accesso a Internet** | ⚠️ **verificare la formulazione a schermo** (decisione aperta D5): se la domanda è *«l'app fornisce accesso NON FILTRATO a Internet (browser o motore di ricerca)»*, la risposta veritiera è **NO** — la WebView è confinata a `app.kidville.it`, vincolata da `WKAppBoundDomains`/`network_security_config`. Se chiede genericamente se l'app si connette a Internet → **SÌ**. **Rispondi alla domanda com'è scritta a schermo, non com'è riassunta qui** |
| L'app mostra annunci | **No** |

🔴 **Non nascondere chat e galleria per tenere il rating basso.** La UGC policy richiede
espressamente *«accurate responses to the content rating questionnaire regarding UGC»*, e la
misrepresentation porta a **rimozione o sospensione**. **Dichiararle non alza il rating**:
l'esito atteso resta **PEGI 3 / ESRB Everyone** col descrittore «interazione fra utenti».
**Nasconderle costa l'account. Il calcolo è a senso unico.**
Il questionario **va rifatto a ogni cambio di contenuto**.

### B6.4 — Health apps declaration (modulo 4)

Percorso: **Contenuti dell'app → Salute**.

**Obbligatoria per tutti**: *«All developers that have an app published on Google Play must
complete the Health apps declaration, including apps on closed testing, open testing, or
production tracks»*. Vale **anche** per chi non offre funzioni sanitarie: serve a **certificare
l'assenza**. **Non compilarla blocca la pubblicazione, anche solo su closed testing** — ed è il
modulo che la maggior parte degli sviluppatori scopre di dover compilare **solo dopo il rigetto**.

| Campo a schermo | Valore |
|---|---|
| *La tua app include funzionalità relative alla salute?* | **SÌ** — **non** rispondere «nessuna funzione sanitaria»: allergie, certificati medici e flag BES/DSA fanno cadere l'app nel perimetro *«accede a dati sanitari per supportare funzioni non sanitarie»*, che la Health Content and Services policy **include espressamente** |
| Caselle di categoria | **Servizi sanitari e gestione** *(Health services & management)* **e/o Gestione di malattie e condizioni** — ⚠️ decisione aperta D2 al §6 |
| *L'app è un dispositivo medico / è registrata presso un'autorità regolatoria?* | **NO** — né FDA né EU MDR/IVDR |
| *Ricerca sanitaria su soggetti umani / consenso informato / comitato etico* | **NO** |
| *App per la salute mentale · farmaci · telemedicina · test diagnostici · sesso e riproduzione · fitness e benessere* | **NO** |
| Disclaimer da esporre, testo suggerito da C4 | «*non è un dispositivo medico e non diagnostica, tratta, cura o previene alcuna condizione medica*» |

### B6.5 — Sicurezza dei dati / Data safety (modulo 5, per ultimo)

> 🔴 **Fonte: A2.** **NON** usare `docs/store-submission.md` §3 né
> `ios/App/App/PrivacyInfo.xcprivacy` (8 voci, incompleto): **si contraddicono**. Sulla riga
> «Informazioni di pagamento» **vale A2**. Vedi anche §7, contraddizioni note.
>
> **Vincolo WebView**: `app.kidville.it` è interamente nostro → ogni dato digitato nel registro
> (nome del bambino, allergie, chat, foto, riferimento del bonifico) è **«raccolto dall'app»**,
> anche se passa dalla WebView. «È solo un browser sul nostro sito» è il ragionamento che genera
> la violazione *«User Data policy: Invalid Data safety form»*.

**B6.5.a — Sezione «Raccolta dei dati e sicurezza»**

| Campo a schermo | Valore |
|---|---|
| *La tua app raccoglie o condivide uno dei tipi di dati utente obbligatori?* | **Sì** |
| *Tutti i dati utente raccolti dalla tua app vengono criptati in transito?* | **Sì** ⚠️ vedi decisione aperta D6 (cleartext `domain-config` verso `10.0.2.2`/`localhost`/`127.0.0.1` ancora nell'AAB di produzione) |
| *Fornisci un modo per consentire agli utenti di richiedere l'eliminazione dei propri dati?* | **Sì** |
| *URL per la richiesta di eliminazione dell'account* | `https://app.kidville.it/cancellazione-account` |
| *Gli utenti possono richiedere…* | **l'eliminazione dell'account e dei dati associati** (la pagina registra una richiesta pending evasa dalla Direzione, come il percorso in-app) |

**B6.5.b — Premesse valide su OGNI riga (impostarle sempre uguali)**

| Sotto-domanda ripetuta per ogni tipo di dato | Valore |
|---|---|
| *Questi dati vengono condivisi?* | **NO su tutto** — Supabase, Vercel, Resend, Aruba/SDI sono *service provider*, esclusi per definizione dalla «condivisione» |
| *Questi dati vengono elaborati temporaneamente (effimeri)?* | **NO su tutto** — `app_log` persiste 30 giorni |
| *Perché questi dati vengono raccolti?* | **Funzionalità dell'app** (+ *Gestione dell'account* solo dove indicato) |
| Scopi pubblicitari / analisi di terze parti | **MAI spuntati** — nessun `gtag`/`plausible`/`posthog`/`mixpanel`; unico SDK terzo = **Firebase Cloud Messaging** (solo Core + Messaging, niente Analytics/Crashlytics/Performance) |

**B6.5.c — Tipi di dato DA DICHIARARE (20 righe di form)**

| Sezione → Tipo di dato a schermo | Raccolto | Condiviso | Obbl./Facolt. | Scopo | Cifrato in transito | Cancellabile su richiesta | Nota |
|---|---|---|---|---|---|---|---|
| Informazioni personali → **Nome** | Sì | No | Obbligatorio | Funzionalità dell'app **+ Gestione dell'account** | Sì | Sì | nomi di bambini e genitori |
| Informazioni personali → **Indirizzo email** | Sì | No | Obbligatorio | Funzionalità dell'app **+ Gestione dell'account** | Sì | Sì | |
| Informazioni personali → **Numero di telefono** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | urgenze, ritiro |
| Informazioni personali → **Indirizzo** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | residenza in anagrafica |
| Informazioni personali → **ID utente** | Sì | No | Obbligatorio | Funzionalità dell'app **+ Gestione dell'account** | Sì | Sì | |
| Informazioni personali → **Altre informazioni** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | data/luogo di nascita, **codice fiscale**, documento, classe, presenze |
| Salute e fitness → **Informazioni sulla salute** | **Sì** | No | ⚠️ **decisione aperta D1** | Funzionalità dell'app | Sì | Sì | allergie, intolleranze, certificati medici, **flag BES/DSA**. 📌 Su Apple il BES/DSA sta in *Sensitive Info* (disabilità): **su Play quella casella non esiste**, si mappa qui |
| Foto e video → **Foto** | Sì | No | **Facoltativo** | Funzionalità dell'app | Sì | Sì | foto del giorno, galleria, profilo |
| Foto e video → **Video** | Sì | No | **Facoltativo** | Funzionalità dell'app | Sì | Sì | galleria di classe |
| **File e documenti** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | certificati, modulistica |
| Messaggi → **Altri messaggi in-app** | Sì | No | **Facoltativo** | Funzionalità dell'app | Sì | Sì | chat genitore↔docente |
| Attività dell'app → **Altri contenuti generati dagli utenti** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | diario, note, moduli, firme |
| Attività dell'app → **Interazioni con l'app** | **Sì** | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | `withRoute` registra rotta/esito/durata **per utente** in `app_log`, retention 30 gg |
| Informazioni finanziarie → **Informazioni di pagamento dell'utente** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | `incassi.metodo` = «form of payment» — **è la riga su cui i due documenti del repo divergono: vale A2** |
| Informazioni finanziarie → **Altre informazioni finanziarie** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | scadenziario rette (debiti, morosità, sconti, pro-rata) |
| Informazioni finanziarie → **Cronologia acquisti** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | storico pagamenti / ticket mensa / merchandise |
| **ID dispositivo o altri ID** | **Sì** | No | **Obbligatorio** | Funzionalità dell'app | Sì | Sì | 🔴 token FCM in `push_subscriptions` **+ Firebase Installation ID**: persistente, non effimero, **non disattivabile** (SDK Installations = dipendenza transitiva) |
| Prestazione app → **Log di arresto anomalo** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | |
| Prestazione app → **Diagnostica** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | |
| Prestazione app → **Altri dati sulle prestazioni dell'app** | Sì | No | Obbligatorio | Funzionalità dell'app | Sì | Sì | durata e stato HTTP delle richieste |

**B6.5.d — Tipi di dato da NON dichiarare (lasciare «No»)**

Posizione approssimativa · Posizione precisa · Informazioni sul fitness · **Contatti** · Eventi
di calendario · **Cronologia di navigazione web** · **Cronologia ricerche in-app** (le ricerche
non vengono persistite: `app_log` registra il *pattern* di rotta, non la stringa) · App
installate · File audio / voce e registrazioni sonore / file musicali · Razza ed etnia ·
Convinzioni politiche o religiose · Orientamento sessuale · Punteggio di credito · Email, SMS o
MMS (la messaggistica sta sotto *Altri messaggi in-app*).

> ✅ **Verificato sul manifest fuso release**
> (`android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml`):
> **nessun** `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `READ_CONTACTS`, **né**
> `CAMERA`/`READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO`/`RECORD_AUDIO`. Presenti solo: `INTERNET`,
> `USE_BIOMETRIC`, `USE_FINGERPRINT`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `WAKE_LOCK`,
> `c2dm.permission.RECEIVE`, `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` + ~20 permessi badge OEM
> (ShortcutBadger). ⚠️ **Da ri-verificare sull'AAB effettivamente caricato**, non sulla build
> locale: un permesso residuo è un indicatore di raccolta che **contraddice la dichiarazione**.
> 🔴 **Zero identificatori dichiarati con FCM dentro l'APK è la discrepanza più facile da
> rilevare con l'analisi statica** — è automatizzabile, e Google la automatizza.

**B6.5.e — «Pratiche relative alla sicurezza dei dati»**

| Campo a schermo | Valore |
|---|---|
| *Si impegna a seguire la Play Families Policy* | **NO — non spuntare.** Gli utenti sono adulti. Spuntarla «perché è una scuola dell'infanzia» **attiverebbe** la Families Policy con tutti i suoi obblighi |
| *L'app è stata sottoposta a una revisione indipendente sulla sicurezza (MASA)* | **NO** — facoltativa, costo inutile al primo rilascio |
| *Badge UPI* | **Non applicabile** (solo India) |

> Google dichiara che *«il processo di revisione non è progettato per verificare l'accuratezza e
> la completezza»* delle dichiarazioni. **L'approvazione iniziale non è una garanzia**: una
> dichiarazione minimizzata può passare e far rimuovere l'app sei mesi dopo, e le violazioni
> ripetute della User Data policy portano alla **sospensione dell'account sviluppatore**.
> **Vale la pena dichiarare un tipo di dato in più. Mai uno in meno.**

### B6.6 — Gli altri moduli (modulo 6)

Questi **non sono citati in C4**: sono dedotti dal repo e dal contesto → **DA VERIFICARE a
schermo**, campo per campo, prima di salvare.

| Modulo | Valore proposto |
|---|---|
| **Annunci** | «**La mia app non contiene annunci**» — nessuna pubblicità in nessuna forma, nessun SDK adv |
| **Accesso alle app** (istruzioni per il revisore) | «Tutte le funzionalità sono disponibili senza restrizioni di accesso» = **NO** → fornire credenziali, vedi sotto |
| **App di notizie** | **No** (la sezione «News» in-app è comunicazione scolastica, non testata giornalistica) |
| **App per il tracciamento dei contatti / COVID-19** | **No** |
| **App governative** | **No** |
| **Funzionalità finanziarie** | «**La mia app non fornisce funzionalità finanziarie**» — nessun prestito, wallet, crypto, banking, gateway: i pagamenti sono **registrati, non eseguiti** |
| **Dichiarazione permessi Foto e video** | **Non applicabile** — verificato: il manifest fuso non richiede `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO`/`CAMERA` |
| **Autorizzazioni sensibili** (SMS/chiamate/`MANAGE_EXTERNAL_STORAGE`/`QUERY_ALL_PACKAGES`/`AlarmManager` esatto) | **Nessuna richiesta** — nessun modulo da compilare |

**Accesso alle app — credenziali e istruzioni**

| Campo | Valore |
|---|---|
| **Nome utente / Username** | `test.inf.genitore1@kidville.test` |
| **Password** | 🔴 **NON è nel repository** (lock `__tests__/architecture/niente-password-nel-repo.test.ts`). L'account demo ha una **password dedicata** in `~/Documenti/kidville-play/.demo-revisore-pw` sul mio disco. **La incollo io a mano: non chiedermela in chat** |

🔴 **VIETATO consegnare al revisore `test.segreteria@kidville.test`, `test.pri.segreteria` o
`test.cuoca`**: leggono l'anagrafica **reale** dell'intera sede di Giugliano — famiglie e bambini
veri. È **comunicazione di dati di minori a un terzo senza base giuridica**. Se serve mostrare il
back-office, **si registra un video**.

**Testo da incollare nel campo «Istruzioni»** (verbatim da `docs/store-submission.md`, i
grassetti Markdown del sorgente vanno rimossi — qui sono già rimossi):

```
Kidville è il registro elettronico di una scuola dell'infanzia e primaria paritaria
(sede Kidville Giugliano). Lo usano solo le famiglie iscritte e il personale: i
genitori seguono i propri figli (diario giornaliero, presenze, mensa e menu, pagamenti
scolastici, messaggi con le insegnanti, foto della classe, moduli da firmare), le
insegnanti compilano il registro, la segreteria gestisce iscrizioni e amministrazione.
Non esiste registrazione pubblica: gli account li crea la scuola, quindi per la review
serve l'account demo indicato sopra, che è un account genitore su una classe di prova
con bambini fittizi. Nell'app non ci sono acquisti: le rette si pagano alla scuola per
bonifico o di persona, fuori dall'app.
```

**Frase da aggiungere in coda** — previene il fraintendimento più probabile:

```
L'utente dell'app è il genitore adulto o il personale scolastico, mai il bambino; il
bambino non ha un account.
```

**Versione inglese** (solo se e quando si aggiunge la locale `en-US`) — verbatim da
`docs/store-submission.md` righe 145-186, **con le due sostituzioni obbligatorie per Android**
prescritte da C3 §1: `native iOS share sheet` → **`native Android share sheet`**;
`Face ID / Touch ID` → **`fingerprint / biometric unlock`** (punto 7 e sezione
PERMISSIONS/NATIVE FUNCTIONALITY):

```text
Kidville is the school-record app of an Italian private nursery and primary school
(Kidville Giugliano). It is used exclusively by the families enrolled in the school and
by its staff: parents follow their own children (daily diary, attendance, meals and menu,
school payments, messages with teachers, class photos, forms to sign), teachers fill in
the register, and the school office manages enrolments and administration.

ACCOUNT
There is no public sign-up: accounts are created by the school for enrolled families
only, so a demo account is required to review the app. Please use the credentials in the
"Sign-in required" fields above. The demo account is a PARENT account on a test class
containing fictional children only — no real personal data of minors is exposed.

WHAT TO TRY
1. Sign in with the demo account.
2. Home: today's summary for the child.
3. "Diario" (daily diary): meals, sleep, mood, teacher notes.
4. "Avvisi" (announcements) and "News": school communications; the share button uses the
   native Android share sheet.
5. "Mensa" (school meals): weekly menu and meal booking.
6. "Pagamenti": school fees and receipts. There are NO in-app purchases and no digital
   goods: fees are paid to the school by bank transfer or in person, outside the app.
7. Profile: optional fingerprint / biometric unlock app lock, and account deletion request.
8. Turn Airplane Mode on and reopen the app: announcements, diary and menu remain
   readable from the offline cache.

NATIVE FUNCTIONALITY
The app is not a repackaged website. It integrates: native push notifications (Firebase
Cloud Messaging), custom URL scheme deep links (kidville://), native camera capture for
diary and gallery uploads, biometric app lock (fingerprint / biometric unlock), app icon
badge with the number of unread notifications, native share sheet, offline access to
announcements, diary and menu, native splash screen, icons and status bar integration.

PRIVACY
The app handles personal data of minors. It does not track users, contains no
advertising, no third-party analytics and no ATT prompt. Privacy policy:
https://app.kidville.it/privacy — Support: https://app.kidville.it/assistenza

PERMISSIONS
Camera / Photos: only to attach pictures to the diary, the class gallery and school
forms. Notifications: school announcements. Face ID: optional app lock, off by default.
```

⚠️ Nella versione EN qui sopra ho già applicato **due modifiche non prescritte dal dossier, ma
raccomandate**: tolto `APNs via` davanti a `Firebase Cloud Messaging` e tolto il riferimento a
`guideline 4.2` (sono riferimenti Apple, fuori posto su Play). L'ultima riga di PERMISSIONS cita
ancora `Face ID`: **DA DECIDERE se sostituirla anche lì** — il dossier non lo prescrive.

**URL correlati** (stessi valori usati su App Store): Privacy Policy
`https://app.kidville.it/privacy` · Assistenza `https://app.kidville.it/assistenza` · email
pubblica `info@kidville.it`.

═══════════════════════════════════════════════════════════════════════════
BLOCCO B7 — PLAY CONSOLE · caricamento dell'`.aab`
═══════════════════════════════════════════════════════════════════════════

🛑 **Non caricare nulla senza il mio ok esplicito.**

| Cosa | Valore |
|---|---|
| File | `/Users/lerri/kidville-web/android/app/build/outputs/bundle/release/app-release.aab` |
| `versionCode` | `1` |
| `versionName` | `1.0` |
| Package name | `it.kidville.app` |
| Firma | verificata con `jarsigner -verify -certs` → *jar verified* |

- 🔴 **`versionCode 1` si brucia al PRIMO upload, anche solo su Internal testing, e non si riusa
  nemmeno eliminando l'upload.** Prima di caricare, siamo sicuri che sia la build definitiva?
- ⚠️ Il `versionCode` Android è un **contatore progressivo indipendente** dal build number iOS
  (commentato in `android/app/build.gradle` sopra `versionCode 1`).
- ⚠️ Prima di caricare, verifica a schermo che **tutti** i moduli di «Contenuti dell'app» siano
  completi: Health apps declaration mancante **blocca la pubblicazione anche solo su closed
  testing**.
- ⚠️ Dopo l'upload, **ri-verifica il manifest dell'AAB caricato** (Play Console mostra i permessi
  richiesti dal bundle): deve combaciare con quanto dichiarato in B6.5.d. Se compare un permesso
  che lì abbiamo negato, la dichiarazione Data safety va corretta **prima** dell'invio.

═══════════════════════════════════════════════════════════════════════════
BLOCCO B8 — APP STORE CONNECT · conversione Individual → Organization
═══════════════════════════════════════════════════════════════════════════

🔴 **Va fatta PRIMA del DSA** (sequenza 2 del §3).

**Il testo del ticket è già pronto e NON va riscritto qui**: sta in
`/Users/lerri/kidville-web/docs/submission/prompts/prompt-ticket-apple.md`. Aprilo, usalo tale e
quale. Non riformulare le quattro domande numerate in fondo: sono la prova nero-su-bianco che il
lavoro già fatto non si perde.

| Campo | Valore |
|---|---|
| URL | `https://developer.apple.com/contact/` |
| Categoria di assistenza | **Membership / Account** → conversione del tipo di account (Individual → Organization) |
| Oggetto | `Convert Individual membership to Organization` |
| Regola operativa | **NON inviare senza mio ok esplicito**: mostrami prima il modulo compilato. Dopo l'invio, riportami il **numero del ticket** |

**I 4 punti su cui ottenere conferma SCRITTA da Apple** (sono le domande numerate del ticket):

1. Il **Team ID resta `B5ULCGG2V3`**.
2. Restano preservati: **record dell'app** (Apple ID `6794883055`), **bundle ID**
   `it.kidville.app`, **certificato di distribuzione** (scade 2027-07-26), **build TestFlight
   `1.0 (1)`**.
3. **Nessuna quota annuale aggiuntiva**: i 99 €/$ già pagati restano validi.
4. Il nome del **«Venditore»** sull'App Store diventa la **ragione sociale dell'organizzazione**.

⚠️ **La conservazione di Team ID/app/certificato è documentata da fonti secondarie concordi,
NON dalla pagina ufficiale Apple** → per questo servono le 4 conferme scritte.
⚠️ **La conversione NON è reversibile.**
⚠️ Se Apple risponde che uno dei 4 punti **non** si conserva, lo si scopre **prima** di muovere
qualsiasi altra cosa: fermati e dimmelo.

**Documenti da tenere pronti**: **visura camerale** recente (PDF, ultimi 3-6 mesi — serve
**anche** al Passo 4 del DSA) · **documento d'identità di Errico Cesario** · **delega scritta**
di Errico Cesario a Luigi Errico (obbligatoria, perché il richiedente non è il legale
rappresentante) · eventuali documenti **notarized** (Apple avvisa: *«you may be asked for
business documents that are notarized»*).

**Fatti da non riaprire**: ❌ **App Transfer non è la strada** — sposta un'app fra account e
**non è nemmeno disponibile per un'app mai pubblicata**. ✅ **D-U-N-S già ottenuto**
(`432360401`, 2026-07-26): **non aprire una seconda pratica su D&B**, i duplicati bloccano la
verifica su Apple **e** su Google Play.

**Perché serve** (linea guida 5.1.1(ix), testo Apple alla lettera):
> *«Apps that provide services in highly regulated fields […] or that require sensitive user
> information should be submitted by a legal entity that provides the services, and not by an
> individual developer.»*

Kidville tratta **dati sanitari di minori**: è esattamente «sensitive user information». E oggi
chi pubblica e chi eroga sono **due soggetti diversi** — il certificato dice `Apple
Distribution: luigi errico (B5ULCGG2V3)`, persona fisica, mentre il Titolare dichiarato in
`/privacy` e `/termini` è la cooperativa. Il revisore vede la discrepanza.

═══════════════════════════════════════════════════════════════════════════
BLOCCO B9 — APP STORE CONNECT · il modulo DSA (operatore commerciale)
═══════════════════════════════════════════════════════════════════════════

🔴 **Solo DOPO che la conversione a Organization è riuscita** (sequenza 2 del §3).
🔴 **Il Passo 5 NON si firma prima del parere legale su A3** (sequenza 3 del §3).

**Dove si trova — percorsi esatti**

Dichiarazione a livello di **ACCOUNT** (è quella che sblocca l'invio in revisione):
```
App Store Connect  →  Business  (in alto)
                   →  scheda Agreements / Contratti
                   →  sezione Compliance / Conformità
                   →  Digital Services Act  →  "Complete Compliance Requirements"
```

Dichiarazione per **SINGOLA APP** (facoltativa, solo se lo stato dell'app differisce da quello
dell'account):
```
App Store Connect  →  Apps  →  Kidville  →  App Information (colonna sinistra)
                   →  sezione "App Store Regulations and Permits"
                   →  Digital Services Act  →  Edit
```

**Ruolo necessario: `Account Holder` oppure `Admin`.** Con un ruolo inferiore **la voce non
compare** — non è un bug, è il gate dei permessi.

**Perché blocca**: dal **17 febbraio 2025** nessun invio in revisione è possibile senza. Non
blocca il *caricamento* della build (`1.0 (1)` è già su TestFlight), blocca l'**invio in
revisione**; le app non conformi vengono **rimosse dallo store UE**.

> Nota: A1 §2 elenca **6 passi**. I «5 passi» sostanziali sono 1-5; il Passo 6 è la sola
> conferma finale. Li riporto tutti.

**Passo 1 — Stato di trader**

| Campo esatto a schermo | Valore |
|---|---|
| ☑️ **«This is a trader account.»** / «Questo è un account di operatore commerciale.» | ✅ **SELEZIONARE QUESTA** |
| ☐ «This is not a trader account.» | ❌ NON selezionare |

Il DSA definisce trader *«qualsiasi persona fisica o giuridica […] che agisce per finalità che
rientrano nell'ambito della sua attività commerciale, industriale, artigianale o
professionale»*. Kidville è lo strumento con cui una cooperativa che eroga un servizio educativo
**a pagamento** gestisce il rapporto con le famiglie paganti. **La gratuità dell'app è
irrilevante: conta la finalità, non il prezzo.** Dichiararsi «non-trader» farebbe pubblicare
sulla scheda l'avviso che *«i diritti dei consumatori […] non si applicano ai contratti fra lo
sviluppatore e i consumatori»* — dichiarazione contraddetta dai fatti; una falsa dichiarazione
resa ad Apple ai sensi del DSA espone a **rimozione dell'app e revoca dell'account**.

**Passo 2 — Recapiti da pubblicare** 🔴 **QUESTI TRE CAMPI DIVENTANO PUBBLICI**

Dove finiscono: sulla **pagina App Store dell'app**, **visibili a chiunque senza login**, in
**tutti e 27 i paesi UE**, per tutta la vita dell'app, indicizzati dai motori di ricerca. Non
sono dati di fatturazione né del contratto Apple: sono **dati di pubblicazione**.

| Campo esatto a schermo | Valore |
|---|---|
| **Indirizzo / Address** | `Via Silvio Pellico 7, 81030 Cesa (CE), Italia` — ⚠️ **se l'account è Organization il campo è PRECOMPILATO dal D-U-N-S e NON modificabile** dal modulo DSA: eventuali errori si correggono alla fonte (D&B), non qui. Se fosse ancora Individual: si scrive a mano ed è ammessa **una casella postale** (unico modo per non pubblicare il domicilio personale) |
| **Telefono / Phone** | ⬜ **DECISIONE APERTA** — raccomandazione: `+39 081 503 2070` (fisso della sede di Cesa, dal sito ufficiale; è il numero già usato nel ticket Apple). Deve poter **ricevere SMS o chiamata di verifica**; è il numero che chiunque potrà chiamare |
| **Email** | `info@kidville.it` ✅ (decisione chiusa il 2026-07-26). Deve poter **ricevere un codice di verifica** |

⚠️ **Incongruenza interna al dossier da conoscere**: il riquadro d'esempio di A1 §4 mostra
`privacy@kidville.it`, mentre la DECISIONE 3 (chiusa) stabilisce `info@kidville.it`.
**Il valore operativo è `info@kidville.it`** — è quello già sostituito nel codice in `/privacy`,
`/termini`, `/assistenza`, ed è quello che sblocca l'iscrizione Organization.

**Passo 3 — Verifica in due fattori**

| Campo esatto a schermo | Azione / Valore |
|---|---|
| Codice di verifica **email** | Apple invia un codice a `info@kidville.it` → inserirlo. Il modulo avanza da solo |
| Codice di verifica **telefono** | Apple invia SMS **o chiamata vocale** al numero del Passo 2 → inserire il codice |
| **«Request manual verification»** | Da usare **se il numero non può ricevere codici**. Non è un ripiego di serie B: è la procedura prevista da Apple |

⚠️ **Prerequisito operativo**: verificare **prima** che `info@kidville.it` riceva davvero,
mandando una prova da un indirizzo esterno. È la casella su cui arrivano la risposta di Apple,
le richieste GDPR e le domande del revisore. ⚠️ Resta anche da verificare che sia **realmente
presidiata**: una risposta tardiva al revisore costa un giro di review.

**Passo 4 — Documento di verifica dell'attività**

| Campo esatto a schermo | Valore / File |
|---|---|
| Upload del documento di verifica | ✅ **Visura camerale** della cooperativa, PDF leggibile, non scaduto, recente (meglio ultimi 3-6 mesi) — riporta insieme ragione sociale, P.IVA e sede. **È la scelta migliore** |
| Alternative accettate | Certificato di attribuzione della partita IVA, o altro atto/registro ufficiale con nome + indirizzo |
| Documento AGGIUNTIVO — solo se al Passo 2 si è usata una casella postale o un indirizzo diverso dalla sede | Bolletta, ricevuta, o contratto della casella postale che associa il soggetto a quell'indirizzo |

**Passo 5 — Dati del conto + certificazione di conformità** 🔴 **NON FIRMARE ORA**

| Campo esatto a schermo | Valore / Azione |
|---|---|
| **Dati del conto di pagamento** (se non già in App Store Connect) | Da inserire — dato bancario dell'ente. 🔴 **Non chiedermi l'IBAN in chat: lo digito io** |
| **Certificazione che i prodotti/servizi offerti rispettano il diritto UE applicabile** | 🛑 **NON SPUNTARE / NON FIRMARE PRIMA DEL PARERE LEGALE (A3)** |

**Perché**: non è una casella da spuntare, è una **dichiarazione sostanziale**. Si certifica ad
Apple che il servizio è conforme al diritto UE — il che include **GDPR** e **tutela del
consumatore**. `/privacy` e `/termini` non sono ancora stati validati dal legale.
**Ordine imposto: A3 → A2 → Passo 5.**

**Passo 6 — Revisione e conferma**

| Campo | Azione |
|---|---|
| **Confirm** | Premere **solo dopo il mio ok esplicito** e dopo aver riletto tutto. **Da qui in avanti i recapiti sono pubblici.** Verifica di riuscita: l'avviso rosso in App Store Connect sparisce |

**Campo facoltativo — «Labels and Markings URL»**

| Campo | Valore |
|---|---|
| **Labels and Markings URL** | **LASCIARE VUOTO.** Kidville è software di servizio, non un prodotto fisico soggetto a marcatura CE o avvertenze di sicurezza prodotto. Compilarlo con qualcosa di improprio è **peggio** che lasciarlo vuoto. Resta modificabile in qualunque momento |

**Esito atteso sulla scheda App Store** (account Organization):
```
Venditore / Trader
Scuola dell'Infanzia La Favola Soc. Coop.
Via Silvio Pellico 7, 81030 Cesa (CE), Italia
+39 ...........
info@kidville.it
```

═══════════════════════════════════════════════════════════════════════════
BLOCCO B10 — APP STORE CONNECT · App Privacy labels (A2)
═══════════════════════════════════════════════════════════════════════════

Percorso: **App Store Connect → Apps → Kidville → App Privacy → Edit**.

🔴 **Etichetta ASC e `ios/App/App/PrivacyInfo.xcprivacy` devono dire la STESSA IDENTICA COSA, e
si toccano INSIEME** (sequenza 6 del §3). Il manifest è lavoro lato repo, non tuo a schermo: tu
compili l'etichetta, e mi riporti l'elenco esatto delle righe spuntate perché il manifest venga
allineato **nella stessa sessione**.
🔴 **Il manifest viaggia dentro l'`.ipa`**: modificarlo **senza ricaricare una nuova build** non
cambia nulla per Apple.

### B10.1 — Risposte trasversali (valgono su OGNI riga spuntata)

| Domanda a schermo | Risposta | Motivo |
|---|---|---|
| Prima domanda del wizard: *«Do you or your third-party partners collect data from this app?»* | **Yes, we collect data from this app** | — |
| *«Do you or your third-party partners use this data for tracking purposes?»* | **No** — su **TUTTE** le righe, nessuna eccezione | `NSPrivacyTracking = false`, nessun ATT prompt, nessuna pubblicità, nessun SDK analytics |
| *«How is this data used?»* (Purposes) | **App Functionality — SOLO questa**, su TUTTE le righe. Lasciare deselezionati: *Third-Party Advertising, Developer's Advertising or Marketing, Analytics, Product Personalization, Other Purposes* | La definizione Apple di App Functionality = autenticare, abilitare funzioni, sicurezza, uptime, crash, supporto: è esattamente e soltanto quello che fa Kidville |
| *«Is this data linked to the user's identity?»* | **Yes, this data is linked to the user** — su TUTTE le righe, **diagnostica INCLUSA** | App interamente autenticata: nessuna riga anonima; `app_log` porta `utente_id` |

⚠️ **La tentazione di marcare Crash Data / Performance Data / Other Diagnostic Data come «Not
Linked to You» (default delle SDK terze) va respinta: sarebbe falsa.**

### B10.2 — Tabella completa, riga per riga

Legenda «Stato manifest»: PRESENTE = già in `PrivacyInfo.xcprivacy` · MANCA = da aggiungere.

**Contact Info**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Name** | SÌ | Sì | No | App Functionality | PRESENTE |
| **Email Address** | SÌ | Sì | No | App Functionality | PRESENTE |
| **Phone Number** | SÌ | Sì | No | App Functionality | PRESENTE |
| **Physical Address** | SÌ | Sì | No | App Functionality | MANCA |
| **Other User Contact Info** | NO (non spuntare) | — | — | — | — |

**Health & Fitness**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Health** | SÌ (decisione aperta D-A2-1 — raccomandato SÌ) | Sì | No | App Functionality | MANCA |
| **Fitness** | NO | — | — | — | — |

**Financial Info**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Payment Info** | SÌ | Sì | No | App Functionality | PRESENTE |
| **Other Financial Info** | SÌ | Sì | No | App Functionality | MANCA |
| **Credit Info** | NO | — | — | — | — |

**Location**

| Campo a schermo | Collected |
|---|---|
| **Precise Location** | NO |
| **Coarse Location** | NO |

**Sensitive Info**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Sensitive Info** | SÌ (decisione aperta D-A2-1 — raccomandato SÌ) | Sì | No | App Functionality | MANCA |

**Contacts**

| Campo a schermo | Collected |
|---|---|
| **Contacts** | NO (nessun accesso alla rubrica; i recapiti inseriti dalla famiglia stanno sotto Contact Info) |

**User Content**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Emails or Text Messages** | SÌ | Sì | No | App Functionality | MANCA |
| **Photos or Videos** | SÌ | Sì | No | App Functionality | PRESENTE |
| **Audio Data** | NO | — | — | — | — |
| **Gameplay Content** | NO | — | — | — | — |
| **Customer Support** | SÌ | Sì | No | App Functionality | MANCA |
| **Other User Content** | SÌ | Sì | No | App Functionality | MANCA |

**Browsing History**

| Campo a schermo | Collected |
|---|---|
| **Browsing History** | NO |

**Search History**

| Campo a schermo | Collected |
|---|---|
| **Search History** | NO (le ricerche in-app non sono persistite; `app_log` registra il pattern di rotta) |

**Identifiers**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **User ID** | SÌ | Sì | No | App Functionality | PRESENTE |
| **Device ID** | SÌ | Sì | No | App Functionality | MANCA (oggi impropriamente accorpato nel commento di UserID; è anche la riga che copre l'SDK Firebase Cloud Messaging) |

**Purchases**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Purchase History** | SÌ | Sì | No | App Functionality | MANCA |

**Usage Data**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Product Interaction** | SÌ (decisione aperta D-A2-2 — raccomandato SÌ) | Sì | No | App Functionality | MANCA |
| **Advertising Data** | NO | — | — | — | — |
| **Other Usage Data** | NO | — | — | — | — |

**Diagnostics**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Crash Data** | SÌ | Sì | No | App Functionality | PRESENTE |
| **Performance Data** | SÌ | Sì | No | App Functionality | MANCA |
| **Other Diagnostic Data** | SÌ | Sì | No | App Functionality | PRESENTE |

**Surroundings / Body / Other Data**

| Campo a schermo | Collected | Linked to You | Used for Tracking | Purposes | Stato manifest |
|---|---|---|---|---|---|
| **Environment Scanning** | NO | — | — | — | — |
| **Hands** | NO | — | — | — | — |
| **Head** | NO | — | — | — | — |
| **Other Data Types** | SÌ | Sì | No | App Functionality | MANCA (copre: data e luogo di nascita del minore, codice fiscale, documento d'identità, classe e sezione, presenze/assenze, entrate e uscite) |

**Conteggio**: le righe da spuntare sono **20** se entrambe le decisioni aperte sono «SÌ»
(18 escludendo Product Interaction e contando Health+Sensitive Info come una voce sola, che è il
modo in cui A2 §6 arriva a «18»). Righe già coperte dal manifest: **8**. Nuove: **12** con
entrambe le decisioni a SÌ.

### B10.3 — Da riportarmi per il manifest (lavoro lato repo, non tuo)

`NSPrivacyTracking = false` e `NSPrivacyTrackingDomains` vuoto sono **corretti, non si toccano**.
Le 4 required-reason API (UserDefaults CA92.1, FileTimestamp C617.1, DiskSpace E174.1,
SystemBootTime 35F9.1) sono già dichiarate e non c'entrano con le label.

Già dichiarati (8): `NSPrivacyCollectedDataTypeName` · `…EmailAddress` · `…PhoneNumber` ·
`…PhotosorVideos` · `…PaymentInfo` · `…UserID` · `…CrashData` · `…OtherDiagnosticData`.

Mancanti — costanti esatte:

| # | Costante `NSPrivacyCollectedDataType…` | Copre |
|---|---|---|
| 1 | `NSPrivacyCollectedDataTypePhysicalAddress` | indirizzo di residenza della famiglia |
| 2 | `NSPrivacyCollectedDataTypeOtherFinancialInfo` | rette dovute, morosità, sconti, pro-rata |
| 3 | `NSPrivacyCollectedDataTypeEmailsorTextMessages` | chat scuola-famiglia (nota: «or» minuscolo, come `PhotosorVideos`) |
| 4 | `NSPrivacyCollectedDataTypeCustomerSupport` | richieste di assistenza alla segreteria |
| 5 | `NSPrivacyCollectedDataTypeOtherUserContent` | diario, note educative, moduli, firme, giustifiche |
| 6 | `NSPrivacyCollectedDataTypeDeviceID` | token push APNs/FCM in `push_subscriptions` |
| 7 | `NSPrivacyCollectedDataTypePurchaseHistory` | rette pagate, ticket mensa, merchandise |
| 8 | `NSPrivacyCollectedDataTypePerformanceData` | durata richieste e stato HTTP da `withRoute` |
| 9 | `NSPrivacyCollectedDataTypeOtherDataTypes` | data/luogo di nascita, CF, documento, classe/sezione, presenze |
| 10 | `NSPrivacyCollectedDataTypeHealth` | condizionata a D-A2-1 |
| 11 | `NSPrivacyCollectedDataTypeSensitiveInfo` | condizionata a D-A2-1 |
| 12 | `NSPrivacyCollectedDataTypeProductInteraction` | condizionata a D-A2-2 |

Tutte con la stessa forma delle esistenti: `NSPrivacyCollectedDataTypeLinked` = `true`,
`NSPrivacyCollectedDataTypeTracking` = `false`,
`NSPrivacyCollectedDataTypePurposes` = `[NSPrivacyCollectedDataTypePurposeAppFunctionality]`.

⚠️ **Una costante `NSPrivacyCollectedDataType*` inesistente non produce errore: viene ignorata in
silenzio.** Vanno verificate una a una sulla doc Apple prima di scriverle.

### B10.4 — Nella stessa sessione, da confermare a schermo

| Campo | Valore |
|---|---|
| **Age Rating / Fascia d'età** | **4+**, con pubblico adulto. **NIENTE Kids Category** |
| **App Review Information → Notes** | deve dire esplicitamente che *l'utente dell'app è il genitore o il personale scolastico, mai il bambino* (linea guida 5.1.4(b)) |

Il dossier segna entrambi come **«da verificare a schermo» su come è compilata oggi la scheda**:
→ **DA VERIFICARE**, riportami com'è ora prima di cambiare.

### B10.5 — Verifiche finali a schermo

- Nessuna riga risulta «Used to Track You».
- Ogni riga ha **solo** App Functionality.
- Il numero di voci dell'etichetta **coincide** con quello del manifest.

═══════════════════════════════════════════════════════════════════════════
6 — DECISIONI ANCORA APERTE — ponimele PRIMA di compilare i campi relativi
═══════════════════════════════════════════════════════════════════════════

**Fammele come domande secche, una alla volta, con la raccomandazione del dossier accanto.
Non deciderle tu.**

| # | Dove | Domanda | 🟢 Raccomandazione del dossier |
|---|---|---|---|
| **D-A2-1** | ASC → App Privacy | Dichiaro **Health** e **Sensitive Info**? | **SÌ, entrambi.** L'app tratta allergie/intolleranze, certificati medici e flag BES/DSA, e la definizione Apple di *Sensitive Info* nomina espressamente la **disabilità**; `/privacy` li dichiara già, quindi tacerli creerebbe una contraddizione fra due documenti nostri, mentre dichiararli non attiva alcun vincolo aggiuntivo (l'unico divieto Apple sui dati sanitari è l'uso pubblicitario, che non facciamo). NB: **la biometria NON è motivo di spunta** — impronta e volto non lasciano il dispositivo |
| **D-A2-2** | ASC → App Privacy → Usage Data | Dichiaro **Product Interaction**? | **SÌ, con scopo App Functionality.** `withRoute` scrive in `app_log`, per utente, quale rotta è stata chiamata, quando, con quale esito e durata, retention 30 giorni: letto dal revisore è «information about how the user interacts with the app». Non dichiararla è posizione sostenibile (è diagnostica, già coperta da *Other Diagnostic Data*) ma **va difesa**; dichiararla costa una riga e chiude l'appiglio |
| **D-DSA-2** | ASC → DSA Passo 2 | **Quale numero di telefono pubblico** metto sulla scheda App Store, visibile in 27 paesi UE? | **Un numero DELLA SCUOLA, mai il cellulare personale.** Il fisso della segreteria è la scelta naturale. Valore concreto già usato nel ticket Apple e in A1-bis: **`+39 081 503 2070`** (sede di Cesa, dal sito ufficiale). Vincolo: deve poter ricevere SMS **o chiamata vocale** di verifica; se non ci riesce → **«request manual verification»** |
| **D1** | Play → Data safety → *Salute e fitness → Informazioni sulla salute* | La riga è **Obbligatoria** o **Facoltativa**? (C4 la lascia esplicitamente aperta: «verificare nel form») | **Facoltativo** («gli utenti possono scegliere se fornire questi dati»): allergie, certificati e flag BES/DSA riguardano solo alcune famiglie, l'app funziona senza. **Se il form non offre l'opzione intermedia, ripiegare su Obbligatorio** — nel dubbio si sovra-dichiara, mai il contrario |
| **D2** | Play → Health apps declaration | Quale/i categoria/e spunto? | **Entrambe** (*Servizi sanitari e gestione* + *Gestione di malattie e condizioni*) se il form è a scelta multipla; se è a scelta singola, **Servizi sanitari e gestione** (il dato sanitario è conservato per gestire mensa e rientri, non per gestire una patologia) |
| **D3** | Play → Data safety → scopi | Su quali righe aggiungo **Gestione dell'account** oltre a *Funzionalità dell'app*? (C4 dice «dove indicato» ma **non indica mai dove**) | Solo su **Nome**, **Indirizzo email**, **ID utente** — le tre righe che servono a creare/autenticare l'account. **Non aggiungerlo altrove** (già riportato nella tabella B6.5.c) |
| **D4** | Play → IARC → categoria | Quale voce scelgo? C4 propone tre etichette («Utility / Produttività / Comunicazione») che a schermo possono essere **una voce sola o voci distinte** | Scegliere la voce che contiene **«Utility, Productivity, Communication or Other»**. **Mai «Gioco»**, **mai «Social networking»**. Non è obbligatorio che coincida con la categoria Play (*Istruzione*), ma se il questionario offre **«Riferimenti, notizie o istruzione»** quella è più coerente con la categoria dichiarata: preferirla |
| **D5** | Play → IARC → «Accesso a Internet» | Rispondo SÌ o NO? | **Rispondere alla domanda come è formulata a schermo.** Se parla di accesso **non filtrato** (browser/motore di ricerca) → **NO**. Se chiede genericamente se l'app si connette a Internet → **SÌ**. C4 scrive «SÌ», ma la domanda IARC standard riguarda l'accesso non filtrato |
| **D6** | Play → Data safety → cifratura in transito | Dichiaro «tutti i dati criptati in transito = Sì» col `domain-config` cleartext ancora nell'AAB? | Rispondere **Sì** è difendibile (quegli indirizzi — `10.0.2.2`, `localhost`, `127.0.0.1` — sono irraggiungibili da un telefono reale), **ma è la riga che uno scanner automatico segnala**. Se si può ancora ricompilare: spostare il `domain-config` in `src/debug/res/xml/` **prima** di dichiarare |
| **D-C1-1** | Play Console → account | Converto l'account personale esistente (recuperando i 25 USD) o ne apro uno nuovo di tipo Organizzazione? | Il dossier **sconsiglia la conversione** (C1 §4, trappola 1) e raccomanda **un account nuovo Organizzazione**: convertire non risparmia un giorno, richiede comunque D-U-N-S + verifica sito + **72 ore di attesa**, e non c'è garanzia che annulli un gate 12-tester già scattato. **Il recupero dei 25 USD non è documentato: DA VERIFICARE a schermo** |
| **D-C1-2** | Play Console → account | Con quale Google Account apro? | **Un Google Account ISTITUZIONALE della cooperativa. Mai `erricoluigi17@gmail.com`.** ⚠️ Risulta **ancora da creare** |
| **D-C1-3** | Play Console + scheda | Quale numero di telefono pubblico su Play? | Il dossier dice «numero del centralino» senza fissarlo. **DA CONFERMARE** — coerenza consigliata col numero del DSA |
| **D-GH-1** | GitHub | GitHub Pro, repo di nuovo pubblico, o accettare che `main` non sia protetto? | Vedi BLOCCO B2. Nessuna raccomandazione nel dossier: è una decisione del titolare |

═══════════════════════════════════════════════════════════════════════════
7 — CONTRADDIZIONI NOTE FRA DOCUMENTI (sapere quale vince evita un rigetto)
═══════════════════════════════════════════════════════════════════════════

1. 🔴 **Riga «Informazioni di pagamento» / Payment Info.** `docs/store-submission.md` §3 e
   `ios/App/App/PrivacyInfo.xcprivacy` (8 voci, incompleto) **divergono da A2**.
   **VALE A2**: la riga si dichiara. La contraddizione **non è ancora sanata nel repo**, quindi
   il prossimo che legge `store-submission.md` ricasca: segnalamelo a fine sessione perché venga
   allineato.
2. **Email pubblica del DSA.** Il riquadro d'esempio di A1 §4 mostra `privacy@kidville.it`; la
   decisione chiusa dice **`info@kidville.it`**. **Vale `info@kidville.it`.**
3. **Numero di righe delle App Privacy labels.** A2 §6 dice «18», la tabella riga-per-riga ne
   conta **20** (18 se si esclude Product Interaction e si contano Health+Sensitive Info come
   una voce). **Vale la tabella riga-per-riga.**
4. **Screenshot Play.** `docs/submission/assets/README.md` (aggiornato alle 14:21) dichiara che
   gli screenshot **non sono stati prodotti**. Sul disco ce ne sono **8**, creati più tardi.
   **Vale il filesystem** — vedi B5.5. Il README va aggiornato.
5. **Numero di passi del DSA.** A1 §2 elenca **6 passi**; i «5 passi» sostanziali sono 1-5, il
   Passo 6 è la sola conferma finale.

═══════════════════════════════════════════════════════════════════════════
8 — COME CHIUDIAMO
═══════════════════════════════════════════════════════════════════════════

Comincia dicendomi:
1. da quale blocco riparti e perché,
2. quali decisioni aperte del §6 ti servono **subito** per procedere,
3. cosa NON farai finché non ti do l'ok.

Poi vai un blocco alla volta. A ogni blocco chiuso, riportami: cosa hai compilato, cosa hai
trovato di diverso da questo prompt, e cosa resta aperto.

**Non inviare, non pagare, non firmare, non revocare, non pushare senza il mio ok esplicito.**

───────────────────────────── FINE PROMPT ─────────────────────────────
