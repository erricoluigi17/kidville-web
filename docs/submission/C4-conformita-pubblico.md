# C4 — Moduli di conformità: Data safety, salute, pubblico, classificazione

> Quattro moduli distinti, tutti obbligatori, tutti compilati da te a schermo. **Qui sono già
> tutti decisi, riga per riga.**
>
> Uno dei quattro — la **Health apps declaration** — è quello che la maggior parte degli
> sviluppatori **scopre di dover compilare solo dopo il rigetto**.

---

## §1 — MODULO «SICUREZZA DEI DATI» (Data safety)

### 🔴 La fonte di verità, e la contraddizione da sanare

Si compila da **[A2 — App Privacy labels](A2-app-privacy-labels.md)** (18 categorie).

**NON** da `docs/store-submission.md` §3, e **NON** dalle 8 voci di
`ios/App/App/PrivacyInfo.xcprivacy` — che A2 dichiara esplicitamente incompleto.

> ⚠️ **I due documenti del repo si contraddicono sulla riga «Informazioni di pagamento».**
> **Vale A2**, che è più recente e ha in mano il testo di Apple: `incassi.metodo` *è*
> letteralmente «form of payment», quindi si dichiara **Payment Info** *e accanto* **Other
> Financial Info** per lo scadenziario. La divergenza va sanata nel repo, altrimenti il prossimo
> che li legge ricasca.
>
> 🔴 **E infatti è ricascato, il 2026-08-05.** Compilando il modulo a schermo, il passo 3
> (*Tipi di dati*) è stato salvato **senza** «Dati di pagamento dell'utente» e **senza**
> «Altri contenuti generati dagli utenti» (diario, note, moduli, firme). **Play Console non ha
> segnalato nulla**: il modulo risultava «completo» lo stesso, e sarebbe andato in revisione così.
> Entrambi aggiunti prima dell'invio. **Nessun controllo automatico protegge da una
> sotto-dichiarazione: l'unico controllo è rileggere questa tabella riga per riga contro lo
> schermo.**

### 🔴 La WebView non vi esenta da nulla: vi carica tutto

Google: i dati raccolti attraverso una WebView vanno dichiarati se *«l'app controlla il
codice/comportamento erogato in quella WebView»*, e *«"Collect" means transmitting data from your
app off a user's device… including from webviews the app controls»* [UFF].

`app.kidville.it` è interamente vostro. Quindi **ogni** dato digitato nel registro — nome del
bambino, allergie, chat, foto, riferimento del bonifico — è **«raccolto dall'app»**.

> **«È solo un browser sul nostro sito» è precisamente il ragionamento che genera la violazione
> «User Data policy: Invalid Data safety form».**

### Sezione 2 — Raccolta e sicurezza

| Domanda | Risposta | Motivazione |
|---|---|---|
| L'app raccoglie o condivide dati utente richiesti? | **SÌ** | vedi sopra |
| Tutti i dati sono **cifrati in transito**? | **SÌ** | HTTPS verso `app.kidville.it` e Supabase; `network_security_config.xml` con `cleartextTrafficPermitted="false"` in base-config. ⚠️ Prima di rispondere, chiudere **o accettare consapevolmente** il `domain-config` localhost — [C2 §8](C2-build-aab.md) |
| Fornite un modo per richiedere la **cancellazione dei dati**? | **SÌ** | ⚠️ **Vero solo dopo** aver creato la pagina pubblica — [C5](C5-sviluppo-obbligatorio.md). L'URL va incollato nel campo dedicato |

### Sezioni 3-4 — Tipi di dato

**Premesse valide su ogni riga** (da A2, verificate):

- **CONDIVISO = NO** su tutto. Supabase, Vercel, Resend, Aruba/SDI sono *service provider*, e i
  trasferimenti a service provider sono **esplicitamente esclusi** dalla definizione di
  «condivisione» [UFF].
- **EFFIMERO = NO** su tutto: `app_log` persiste 30 giorni.
- **SCOPO = Funzionalità dell'app** (+ *Gestione dell'account* dove indicato).
- **Nessuno scopo pubblicitario, nessuna analisi di terze parti** — verificato: nessun
  `gtag`/`plausible`/`posthog`/`mixpanel` in `src/`; unico SDK terzo = **Firebase Cloud
  Messaging**, solo Core + Messaging, niente Analytics/Crashlytics/Performance.

| Tipo di dato Play | Raccolto | Obbl./Facolt. | Nota |
|---|---|---|---|
| Info personali → **Nome** | SÌ | Obbligatorio | |
| Info personali → **Indirizzo email** | SÌ | Obbligatorio | |
| Info personali → **Numero di telefono** | SÌ | Obbligatorio | |
| Info personali → **Indirizzo** | SÌ | Obbligatorio | residenza in anagrafica |
| Info personali → **ID utente** | SÌ | Obbligatorio | |
| Info personali → **Altre info** | SÌ | Obbligatorio | data/luogo di nascita, **codice fiscale**, documento, classe, presenze |
| **Salute e fitness → Info sulla salute** | SÌ | **Facoltativo** ✅ *misurato* | allergie, intolleranze, certificati medici, **flag BES/DSA**. 📌 Su Apple il BES/DSA sta in *Sensitive Info* (disabilità): **quella casella su Play non esiste**, si mappa qui. ✅ **Sciolto il 2026-08-05 guardando il codice invece di dedurlo**: `src/lib/forms/enrollment-template.ts:33` dà `allergies` con `required: false`, e ogni schema zod la valida `.optional()` → il genitore **può non fornirlo**, quindi *facoltativo* |
| Foto e video → **Foto** | SÌ | Facoltativo | foto del giorno, galleria, profilo |
| Foto e video → **Video** | SÌ | Facoltativo | galleria di classe |
| **File e documenti** | SÌ | Obbligatorio | certificati, modulistica |
| Messaggi → **Altri messaggi in-app** | SÌ | Facoltativo | chat genitore↔docente |
| Attività → **Altri contenuti generati** | SÌ | Obbligatorio | diario, note, moduli, firme |
| Attività → **Interazioni con l'app** | **SÌ** | Obbligatorio | `withRoute` registra rotta/esito/durata **per utente** in `app_log`, retention 30 gg — è la DECISIONE 2 di A2 |
| Info finanziarie → **Info di pagamento** | SÌ | Obbligatorio | `incassi.metodo` = «form of payment» |
| Info finanziarie → **Altre info finanziarie** | SÌ | Obbligatorio | scadenziario rette (debiti) |
| Info finanziarie → **Cronologia acquisti** | SÌ | Obbligatorio | storico pagamenti/merchandise |
| **ID dispositivo o altri ID** | **SÌ** | **Obbligatorio** | 🔴 token FCM in `push_subscriptions` **+ Firebase Installation ID**: persistente, non effimero, **non disattivabile** (l'SDK Installations è dipendenza transitiva obbligatoria) |
| App → **Log arresti anomali** | SÌ | Obbligatorio | |
| App → **Diagnostica** | SÌ | Obbligatorio | |
| App → **Altri dati prestazioni** | SÌ | Obbligatorio | |

**NON dichiarare** (verificato assenti): posizione approssimativa e precisa · fitness · contatti ·
calendario · cronologia di navigazione web · app installate · file audio · razza/etnia,
convinzioni politico-religiose, orientamento sessuale · punteggio di credito.

> ⚠️ Prima di rispondere «no» a posizione e contatti, **confermare sul manifest fuso** che nessun
> plugin dichiari `ACCESS_FINE_LOCATION` o `READ_CONTACTS`: un permesso residuo è un indicatore
> di raccolta che **contraddice la dichiarazione** [UFF, chiarimento del 15 luglio 2026].

> 🔴 **Zero identificatori dichiarati con FCM dentro l'APK è la discrepanza più facile da
> rilevare con l'analisi statica.** Non è una svista teorica: è automatizzabile.

### Pratiche di sicurezza

- **«Si impegna a seguire la Play Families Policy»** → **NO, non spuntare.** Gli utenti sono
  adulti. Spuntarla «perché è una scuola dell'infanzia» **attiverebbe** la Families Policy con
  tutti i suoi obblighi. Vedi §2.
- **Revisione indipendente MASA** → **NO.** Facoltativa, è un costo che non serve al primo rilascio.
- **Badge UPI** → non applicabile (solo India).

### 🔴 Perché sovra-dichiarare, in una frase di Google

> Google dichiara che *«il processo di revisione **non è progettato per verificare l'accuratezza
> e la completezza** delle dichiarazioni di data safety»* e che lo sviluppatore è l'unico
> responsabile [UFF].

**L'approvazione iniziale non è una garanzia.** Una dichiarazione minimizzata può passare la
review e far rimuovere l'app **sei mesi dopo**, quando le famiglie la usano ogni giorno. E le
violazioni ripetute della User Data policy portano alla **sospensione dell'account sviluppatore**
— che su un account nuovo di zecca è la perdita totale.

> **Vale la pena dichiarare un tipo di dato in più. Mai uno in meno.**

---

## §2 — PUBBLICO DI DESTINAZIONE — e la trappola che si chiama «Kidville»

### La dichiarazione: **solo «Ages 18 and over»**

Il criterio della Families Policy è **chi USA l'app, non di chi parlano i dati**. Gli utenti sono
genitori e personale, tutti adulti; il bambino **non ha un account**. Nessuna clausola Google fa
scattare la Families Policy per il solo fatto di trattare dati o foto **di** minori — verificato
in avversariale su `answer/9893335`, `answer/17122218` e la pagina del programma Families.

**Il claim regge. Ma con quattro condizioni, e la prima riguarda Kidville da vicino.**

### 🔴 CONDIZIONE 1 — La dichiarazione non è autocertificante, e Google può ribaltarla

> *«Google Play reserves the right to conduct its own review of the app information that you
> provide to determine whether the target audience that you disclose is accurate.»*
>
> *«**Regardless of what you identify in the Google Play Console**, if you choose to include
> imagery and terminology in your app that could be considered targeting children, this may
> impact Google Play's assessment of your declared target audience.»* [UFF, `answer/9893335`]
>
> E se la scheda contiene *«marketing elements that suggest otherwise (such as **youthful
> animation or young characters** in the graphic assets)»*, Google può **rifiutare l'app**
> [UFF, `answer/9867159`].

**Kidville è esattamente la fattispecie nominata:**

- si chiama letteralmente «**Kid**ville»;
- ha una **mascotte cartoon 3D** (`public/mascot.png`, `public/mascot-hero.png`) usata nel brand
  e nella UI;
- ha una **palette giocosa** (#FDC400 giallo, #FEF1E4 crema).

E i rimedi previsti da Google sono **binari**: togliere quegli elementi dalla scheda, **oppure**
riclassificare includendo gli under 13 — cioè finire nella Families Policy **per via traversa**.

> ### 🟢 Antidoto, da applicare alla lettera — e prima di disegnare qualsiasi cosa
>
> - **Feature graphic e icona sobrie, senza mascotte cartoon.**
> - **Screenshot che mostrano l'interfaccia gestionale** (presenze, pagamenti, avvisi, menù della
>   settimana) — **non bambini, non volti.**
> - **Prima riga della descrizione completa** che dice che l'app è per genitori adulti e personale
>   *(già così nella bozza di [C3](C3-scheda-testi-grafica.md))*.
> - **Descrizione breve** che ripete la stessa cosa *(già così)*.
>
> Il nome dell'app non si può cambiare. **Tutto il resto della comunicazione deve remare
> nell'altra direzione.**

### Le altre tre condizioni

- **CONDIZIONE 2 — «esente dalla Families Policy» ≠ «nessun obbligo sui minori».** Restano
  obbligatori per tutte le app: Target audience and content, content rating IARC, Data safety,
  privacy policy e **policy Child Endangerment**.
- **CONDIZIONE 3 — la categoria può tirare dentro una policy gemella.** Child Safety Standards si
  applica **per categoria**, non per pubblico → è il motivo per cui la categoria è **Istruzione**
  e mai «Social» ([C1 §1](C1-account-play-e-tempi.md), D2).
- **CONDIZIONE 4 — l'esenzione è da Google, non dalla legge.** La stessa pagina impone comunque
  conformità a **COPPA, GDPR** *«and any other applicable laws»*. Restare fuori dalla Families
  Policy **non toglie nulla** agli obblighi GDPR di [A3](A3-dossier-legale.md).

> ⚠️ *«Misrepresentation of any information about your app in the Play Console, including in the
> target audience and content section, may result in removal or suspension of your app»* [UFF].
> **Dichiarare 18+ e poi vendere l'app come «per i bambini» nella descrizione è la strada più
> veloce alla sospensione dell'account**, non solo al rifiuto della build.

### «Restrict Minor Access» → **NON attivare**

Si sblocca selezionando 18+ come unica fascia, ed è **obbligatoria solo** per gioco d'azzardo con
denaro reale, dating/matchmaking e — dal 26 agosto 2026 — chat anonime/casuali [UFF].

Per Kidville è facoltativa e **sconsigliata**: bloccherebbe ricerca, download e installazione a
chiunque Google classifichi come minore **o di età non determinata**.

> Un genitore giovane con l'età mal impostata sul Google Account **non riesce più a installare
> l'app della scuola**, e il supporto non ha modo di sbloccarlo. Costo zero nel non attivarla,
> rischio concreto di supporto nell'attivarla.

### «Designed for Families» → fuori d'ufficio

*«At least one of your app's target age groups must include children»* [UFF]. Con 18+ non si può
e non si deve. Nessuna azione, nessuna penalizzazione: serve alla visibilità nella sezione
Bambini dello Store, che a Kidville non interessa.

---

## §3 — CLASSIFICAZIONE DEI CONTENUTI (IARC) — obbligatoria

*«We don't allow apps without a content rating on Google Play»*; l'annuncio del 15 luglio 2026
ribadisce che le app non classificate non sono ammesse [UFF].

**Risposte proposte:**

| Domanda | Risposta |
|---|---|
| Categoria di app | **Utility / Produttività / Comunicazione** — **non** «Game» |
| Acquisti in-app | **NO** — le rette si pagano fuori dall'app: contanti, bonifico, POS, assegno (`src/lib/pagamenti/fiscale.ts`). Va dichiarato anche nella sezione dedicata di Console |
| Condivisione della posizione | **NO** |
| Accesso a Internet | **SÌ** |
| **Gli utenti possono interagire fra loro** | **SÌ** — chat genitore↔docente |
| **Condivisione di contenuti generati dagli utenti** | **SÌ** — galleria di classe, diario, foto |

> 🔴 **Non nascondere chat e galleria per tenere il rating basso.**
> La UGC policy richiede espressamente *«accurate responses to the content rating questionnaire
> regarding UGC»*, e la misrepresentation porta a rimozione o sospensione [UFF].
>
> **Dichiararle non alza il rating** oltre la fascia più bassa: l'esito atteso resta
> **PEGI 3 / ESRB Everyone** col descrittore «interazione fra utenti».
> **Nasconderle costa l'account.** Il calcolo è a senso unico.

Il questionario **va rifatto a ogni cambio di contenuto**.

---

## §4 — 🔴 HEALTH APPS DECLARATION — il modulo che quasi nessuno sa di dover compilare

> *«All developers that have an app published on Google Play must complete the Health apps
> declaration, **including apps on closed testing, open testing, or production tracks**»*
> [UFF, `answer/16679511`]

Vale **anche** per chi non offre funzioni sanitarie — serve a **certificare l'assenza**.

**Ma per Kidville la risposta onesta non è «nessuna funzione sanitaria».** Allergie, certificati
medici e flag BES/DSA fanno cadere l'app nel perimetro *«accede a dati sanitari per supportare
funzioni non sanitarie»*, che la Health Content and Services policy **include espressamente**.

- Categoria verosimile: **Servizi sanitari e gestione** e/o **Gestione di malattie e condizioni**.
- **Non è un dispositivo medico** — né FDA né EU MDR/IVDR — e serve il disclaimer:
  *«non è un dispositivo medico e non diagnostica, tratta, cura o previene alcuna condizione
  medica»*.

> **La maggior parte degli sviluppatori scopre che questo modulo esiste solo dopo il rigetto.**
> Non compilarlo **blocca la pubblicazione**, anche solo su closed testing.

---

## §5 — PRIVACY POLICY — requisito separato e prerequisito del Data safety

Senza, **il Data safety non si completa** [UFF].

Requisiti della pagina: URL attivo, pubblicamente accessibile, **non geolocalizzato, non un PDF,
non modificabile dall'utente**, etichettato «Privacy Policy». Deve indicare sviluppatore e
contatto privacy, i dati personali e sensibili trattati, i **sub-responsabili**, le procedure di
trattamento sicuro, conservazione e cancellazione. **Il link va esposto anche dentro l'app**, non
solo sulla scheda.

**Stato reale, verificato oggi:**

- ✅ `/privacy` esiste, è pubblica, è in `PUBLIC_PREFIXES`, **non contiene segnaposto**
  *(l'incertezza sollevata dalla ricerca è stata sciolta: le pagine sono complete)*;
- ✅ il link è già esposto in-app da `/parent/profilo`;
- ⚠️ **manca ancora la validazione legale** — [A3](A3-dossier-legale.md);
- ⚠️ **da verificare che siano nominati**: Supabase, Vercel, Google FCM, Resend, Aruba/SDI, i
  tempi di conservazione, e una sezione cancellazione raggiungibile via **anchor link**. Sono
  esattamente le lacune 1, 2, 5 e 9 di [A3 §3](A3-dossier-legale.md).

> 📌 **Qui A3 e C4 si toccano**: la privacy policy che il legale sta validando **è la stessa** che
> Google pretende per sbloccare il Data safety. Chiudere A3 sblocca anche questo.

---

## §6 — Checklist

- [ ] Data safety compilato **da A2**, non da `store-submission.md` né dal manifest iOS
- [ ] Sanata nel repo la contraddizione su «Informazioni di pagamento»
- [ ] Verificato sul manifest fuso: nessun `ACCESS_FINE_LOCATION`, nessun `READ_CONTACTS`
- [ ] Deciso il `domain-config` localhost **prima** di dichiarare la cifratura in transito
- [ ] URL pubblico di cancellazione pronto e incollato *(dipende da [C5](C5-sviluppo-obbligatorio.md))*
- [ ] **Families Policy: NON spuntata**
- [ ] Target audience: **solo 18+**
- [ ] Grafica conforme all'antidoto §2 — **niente mascotte, niente volti di bambini**
- [ ] **Restrict Minor Access: NON attivata**
- [ ] Questionario IARC compilato **dichiarando chat e UGC**
- [ ] **Health apps declaration compilata** *(non saltarla)*
- [ ] Privacy policy validata dal legale e URL incollato
