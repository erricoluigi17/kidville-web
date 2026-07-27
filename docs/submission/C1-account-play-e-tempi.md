# C1 — Account Google Play, D-U-N-S e percorso critico

> **Stato di partenza**: su Google Play **non esiste nulla**. Né account sviluppatore, né
> scheda, né `.aab` firmato.
>
> **Legenda**: **[UFF]** letto su dominio Google · **[SEC]** fonte secondaria o repo ·
> **[INC]** incerto, da verificare a mano.
>
> Ricerca chiusa con 11 agenti, di cui 3 avversariali sui claim che pesano sui tempi.
> **Due dei tre claim di partenza sono risultati sbagliati.**

---

> # ✅ D-U-N-S OTTENUTO — `432360401`
> **Esisteva già.** Attesa zero, invece dei **fino a 30 giorni** che Google dichiara.
> **Il percorso critico di questo documento si accorcia da 6-8 settimane a 2-3.**
> Vedi [A1-bis](A1b-duns-richiesta.md).

## 🟢 LA NOTIZIA: il D-U-N-S che hai appena richiesto vale anche qui

**Google richiede il D-U-N-S per gli account organizzazione esattamente come Apple**, e
**il numero è lo stesso**: è l'identificativo D&B dell'ente, non una pratica per piattaforma.

> *«You will not be able to create a developer account for an organization without one»*
> [UFF, `support.google.com/…/answer/13628312`] — confermato dalla fonte Google più recente
> trovata, aggiornata **2026-06-18**.

Quindi la richiesta che hai inviato stasera dallo sportello Apple **sblocca due store, non uno**.

⚠️ Ma attenzione a non tirare troppo la conclusione: **numero unico, pratiche distinte.** Le
due *verifiche* — Apple e Google — sono procedimenti separati su piattaforme separate. Avere il
numero non chiude nulla né di qua né di là: apre entrambe le porte, non le attraversa.

⚠️ **Non richiederne un secondo.** Se apri una pratica su D&B mentre quella di Apple è in corso,
rischi un **duplicato**, e i duplicati D&B poi bloccano la verifica su entrambi gli store. Una
sola pratica, quella già inviata.

---

## §1 — LE DECISIONI

### 🟡 D1 — Tipo di account: **ORGANIZZAZIONE**. E si sceglie una volta sola.

> **La decisione va presa PRIMA di pagare i 25 USD.** Il tipo di account non si sceglie due volte.

Le ragioni, in ordine di peso:

1. **Ti espone meno come persona fisica.** Sugli account organizzazione Google pubblica sulla
   scheda Play il nome sviluppatore, l'**email** e il **numero di telefono** — verificati via
   OTP e che *«must remain operational for the duration of your developer account»* [UFF]. Con
   un account personale comparirebbe **una persona fisica** come sviluppatore di un'app che
   tratta dati sanitari di minori. È lo stesso problema di [A1](A1-dsa-operatore-commerciale.md),
   sull'altro store.
2. **È la posizione corretta rispetto al GDPR.** Il Titolare dichiarato su `/privacy` è la
   cooperativa. Un account Play intestato a persona fisica, con dominio e informativa intestati
   all'ente, è una contraddizione **visibile al revisore e insanabile a posteriori**.
3. **Evita il gate dei tester** (D3).
4. **Toglie un argomento dal tavolo**: Google impone l'account organizzazione per le app
   sanitarie [UFF, `answer/13634885`]. Kidville **non** è un'app medica, ma tratta allergie,
   certificati medici e flag BES/DSA. Sceglierla comunque chiude la discussione prima che si apra.
5. **L'inverso non esiste**: *«You can't change the account type from an organization to an
   individual account»* [UFF]. Nascere organizzazione è l'unica direzione senza rimpianti.

**Costo:** il D-U-N-S (già in moto) e i dati societari pubblici. L'indirizzo completo **non** è
obbligatoriamente pubblico per un'app gratuita senza acquisti in-app, ma resta la clausola
regionale *«in certain regions… may be displayed»* [UFF]: metti in conto che la sede di Cesa
compaia. È la sede legale di un ente, non un domicilio privato — accettabile.

### 🔴 D1-bis — **Non aprire l'account con una casella personale**

Solo il **proprietario** dell'account può avviare e completare la verifica dell'identità [UFF,
`answer/10841920`]. Se domani quella casella non è più accessibile, l'account si recupera solo
via ticket di assistenza — e Google contempla esplicitamente il caso «il proprietario non è più
contattabile», il che dice quanto sia frequente e quanto costi.

> **🟢 Serve un Google Account istituzionale della cooperativa**, non `erricoluigi17@gmail.com`
> e non un indirizzo tuo. Credenziali nel gestore del titolare, quello dove sta già
> `KV_TEST_PASSWORD`.

**Recapiti pubblici**: `info@kidville.it` — già deciso stasera e già sostituito nelle tre pagine
legali — più il numero del centralino. ⚠️ **Mai una PEC**: i gestori PEC rifiutano la posta
ordinaria, e un genitore che scrive da Gmail o il revisore Google si prendono un errore di
consegna. È una lezione già pagata, documentata nel sorgente di `/assistenza`.

### 🟡 D2 — Categoria: **Istruzione (Education). MAI «Social», mai «Communication».**

Non è marketing, è compliance. La **Child Safety Standards policy** si applica **per categoria
dichiarata, non per pubblico**:

> *«The presence or absence of child users in your app is irrelevant to this policy»* — ambito:
> app **Social**, **Dating** e, dal 26 agosto 2026, chat anonime/casuali [UFF, `answer/14747720`].

Dichiarare «Social» perché c'è la chat genitore↔docente farebbe scattare: standard anti-CSAE
pubblicati su una pagina web che nomina l'app, meccanismo di feedback in-app, gestione CSAM,
conformità alle leggi sulla sicurezza dei minori, **e un punto di contatto nominativo per la
sicurezza dei minori**.

> **Per una scuola dell'infanzia è una casella di un menu a tendina che vale settimane di lavoro.**

---

## §2 — I DUE CLAIM CHE LA VERIFICA AVVERSARIALE HA SMONTATO

### ✅ «Servono 20 tester» → **sono 12**, e solo per gli account personali

- **12 tester** opted-in per **14 giorni continuativi**, dall'**11 dicembre 2024** [UFF, Android
  Developers Blog: *«starting today, we're requiring 12 instead of 20 testers for personal
  developer accounts»*].
- Ambito: *«App testing requirements for new **personal** developer accounts»*, account personali
  creati **dopo il 13 novembre 2023** [UFF, `answer/14151465`].

> 🔴 **Ma l'esenzione delle organizzazioni NON è scritta da nessuna parte.**
> Il verificatore ha fatto un grep case-insensitive di `organi[sz]ation` sul sorgente HTML della
> pagina: **zero occorrenze**. È un'esenzione **per silenzio, delimitata dall'ambito** — non una
> dichiarazione. Alcuni titolari di account organizzazione riportano nei forum di essersi visti
> chiedere comunque l'iter di *production access* [INC — thread scritti da Product Expert, non
> da Google].
>
> **Conseguenza pratica: tieni 2 settimane di riserva anche con l'account organizzazione.**
> Non è pessimismo: è che **non esiste una frase di Google da opporre a un gate che compare**.

Se comparisse: servono **12 account Google reali e distinti** — non i 41 account applicativi
Kidville. Sarebbero 12 genitori o dipendenti che tengono l'app installata e l'opt-in attivo per
14 giorni **senza interruzioni**: un tester che esce spezza la continuità.

⚠️ E non si aggira partendo dall'open testing: *«Open testing… Must have gained access to
production to access open testing»* [UFF]. L'open testing è **a valle**, non a monte.

### ✅ «Un'app usata da adulti che tratta dati di minori resta fuori dalla Families Policy» → **regge, ma con quattro condizioni**, e la prima riguarda Kidville da vicino

Il criterio è **chi USA l'app, non di chi parlano i dati**. Gli utenti sono genitori e personale,
tutti adulti; il bambino non ha un account. Nessuna clausola fa scattare la Families Policy per
il solo fatto di trattare dati di minori — verificato su tre pagine Google distinte.

**La condizione che pesa è in [C4](C4-conformita-pubblico.md) §2, ed è seria: l'app si chiama
letteralmente «Kid‑ville» e ha una mascotte cartoon.** Google si riserva di riclassificare
d'ufficio in base a *«youthful animation or young characters in the graphic assets»*. Va letta
prima di disegnare qualunque grafica.

---

## §3 — PERCORSO CRITICO

> **Il percorso critico non è il codice.** Il lavoro tecnico per l'AAB firmato è **circa un'ora**
> ([C2](C2-build-aab.md)). Il percorso critico è **amministrativo**, e in parte è già partito.

### Da fare oggi, in parallelo

| # | Azione | Perché oggi | Stato |
|---|---|---|---|
| A | D-U-N-S | l'unico passo non comprimibile | ✅ **richiesto stasera** via Apple |
| B | **Google Account istituzionale** della cooperativa | solo il proprietario può completare la verifica; rifarlo dopo = rifare tutto | ⬜ |
| C | **Verificare l'accesso DNS / Search Console di `kidville.it`** | gli account organizzazione creati dal 2024 devono **verificare un sito web**. Se il dominio è gestito da terzi, l'accesso va chiesto **adesso** | ⬜ |
| D | **Visura camerale + documento del legale rappresentante**, integri | vedi la trappola «no data in the ID can be blocked», §4 | ⬜ |
| E | **Coerenza ragione sociale ↔ record D&B** | se non coincidono scatta un timer di **28 giorni**, scaduto il quale *«your account and apps will be removed from Play»* [UFF] | ⬜ |

### Sequenza e durate

```
giorno 0    A  D-U-N-S  ─────────────────────────────►  fino a 30 gg [UFF]  ✅ già partito
            B-E  account Google, sito, documenti          (in parallelo, 1 giorno)
            │
            ├─ indipendenti dal D-U-N-S, si fanno intanto:
            │  • lavoro tecnico AAB firmato (C2)              ~1 ora
            │  • 🔴 pagina pubblica di cancellazione (C5)     ~mezza giornata
            │  • 🔴 segnalazione/blocco UGC + gate Termini    SVILUPPO VERO (C5)
            │  • screenshot + icona 512 + feature graphic     ~1 giorno
            │  • testi scheda (C3), Data safety (C4)          ~1 giorno
            ▼
+30 gg      D-U-N-S in mano → creazione account org + 25 USD
+30/+35     verifica identità: «up to 5 days» per il metodo di pagamento [UFF]
+35         primo upload AAB + invio scheda
+42         prima revisione: «a few hours or up to seven days (or longer)»,
            e le app di account NUOVI hanno revisioni più lunghe [UFF]
+42/+56     RISERVA 2 SETTIMANE se comparisse il gate production access [INC]
```

> **Stima realistica: 6-8 settimane se il D-U-N-S va richiesto · 2-3 settimane se esisteva già.**
>
> È esattamente per questo che il contenuto della casella `info@kidville.it` decide il calendario
> di tutto il progetto.

### Regole che allungano i tempi

| Regola | Costo | Certezza |
|---|---|---|
| D-U-N-S da richiedere | fino a **30 giorni**, non comprimibili | [UFF] |
| Gate 12 tester × 14 gg (account personali) | 14 gg + fino a 7 gg di revisione + reclutamento | [UFF] |
| Verifica del metodo di pagamento | «up to 5 days», può chiedere deposit challenge o documenti | [UFF] |
| Prima revisione, account nuovo | fino a **7 giorni o più**; Google raccomanda *«a buffer period of at least a week»* | [UFF] |
| **Modificare la scheda mentre è in revisione** | **fa ripartire la revisione da capo** | [UFF] |
| Incoerenza D&B ↔ profilo pagamenti | timer **28 giorni**, poi rimozione di account e app | [UFF] |
| Gate production access su account org | **+2 settimane di riserva** | [INC] |

### Due scadenze di calendario — nessuna delle due morde

- **31 agosto 2026 — target API level.** ✅ **Kidville è già conforme e in anticipo**:
  `android/variables.gradle` ha `compileSdkVersion = 36`, `targetSdkVersion = 36`,
  `minSdkVersion = 24`. Verificato. **È l'unico requisito tecnico Play su cui il progetto non ha
  debito.** [UFF]
- **30 settembre 2026 — Android developer verification.** ✅ **Non tocca Kidville**: riguarda
  l'installazione da store terzi su dispositivi certificati (rollout iniziale Brasile, Indonesia,
  Singapore, Thailandia). Chi distribuisce solo via Play non ha adempimenti. *(Le due ricerche
  divergevano; l'analisi tecnica ha prevalso.)* [UFF]

---

## §4 — TRAPPOLE AMMINISTRATIVE

1. 🔴 **«Apro personale per fare prima, poi converto.»** È il contrario. Il gate 12 tester × 14 gg
   scatta sugli account personali creati dopo il 13/11/2023; la conversione richiede **comunque**
   il D-U-N-S (zero giorni risparmiati), **più** la verifica del sito, **più** 72 ore di attesa
   prima di poter inviare nuove app, **e nessuna garanzia documentata** che un gate già scattato
   venga annullato. E org→personale è **irreversibile**. [UFF]
2. **Disallineamento D&B ↔ profilo pagamenti Google.** Devono coincidere **alla lettera**. In più
   **i tentativi di inserimento del D-U-N-S in Console sono limitati**: non si tira a indovinare.
   ⚠️ Qui si aggancia una cosa già nota da [A1-bis](A1b-duns-richiesta.md): la ragione sociale
   esatta del registro è **«SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA»**, non
   «Soc. Coop.», non «La Favola». **Il valore registrato in D&B stasera diventa il riferimento
   per entrambi gli store.** [UFF]
3. 🔴 **Oscurare dati sui documenti caricati.** *«No data in the ID can be blocked»*, per obblighi
   antiriciclaggio UE. **È l'abitudine italiana di annerire il numero di documento nelle copie, ed
   è la causa più banale di verifica respinta.** [UFF, `answer/15633622`, selettore Italia]
4. **Recapiti personali come contatti pubblici.** Email e telefono sono **mostrati sulla scheda**,
   verificati via OTP, e devono restare operativi per tutta la vita dell'account. Si possono solo
   **sostituire**, non togliere. [UFF]
5. **Dimenticare il sito web verificato.** Prerequisito per gli account organizzazione dal 2024.
   Serve accesso a DNS o Search Console di `kidville.it`. [UFF]
6. **Ritoccare la scheda mentre l'app è in revisione** → **la revisione riparte**. È la causa più
   comune delle attese «infinite» lamentate nei forum. **Si invia e non si tocca più nulla.** [UFF]
7. **`it.kidville.app` è ancora libero su Play?** L'app non è mai stata pubblicata, quindi
   dovrebbe esserlo, ma **va confermato prima di creare la scheda**: una volta pubblicato, il
   package name **non si cambia mai più**. [INC]

---

## §5 — Checklist

- [x] ~~D-U-N-S~~ — ✅ **`432360401`**, esisteva già (2026-07-26). **Attesa zero.** Vale anche qui
- [ ] **D1** — confermato: account **Organizzazione**
- [ ] **Google Account istituzionale** della cooperativa creato *(non una casella personale)*
- [ ] Verificato l'accesso a **DNS / Search Console di `kidville.it`**
- [ ] Visura camerale + documento del legale rappresentante, **senza oscuramenti**
- [ ] Confermata la ragione sociale **identica** fra D&B, Play e Apple
- [ ] Verificato che **`it.kidville.app`** sia libero su Play
- [ ] 25 USD pagati **solo dopo** aver scelto «Organizzazione»
- [ ] **D2** — categoria **Istruzione** *(mai Social, mai Communication)*

---

## Fonti principali

- [Play Console — tipi di account e requisiti](https://support.google.com/googleplay/android-developer/answer/13634885)
- [Play Console — D-U-N-S obbligatorio per le organizzazioni](https://support.google.com/googleplay/android-developer/answer/13628312)
- [Android Developer Console — verifica (agg. 2026-06-18)](https://developer.android.com/developer-verification/guides/android-developer-console)
- [Play — requisiti di test per i nuovi account personali](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Android Developers Blog — «Ensuring high-quality apps on Google Play» (12 tester)](https://android-developers.googleblog.com/2024/12/ensuring-high-quality-apps-on-google-play.html)
- [Play — Child Safety Standards policy](https://support.google.com/googleplay/android-developer/answer/14747720)
- [Play — informazioni sviluppatore pubblicate](https://support.google.com/googleplay/android-developer/answer/10788890)
- [Play — verifica dell'account per le organizzazioni](https://support.google.com/googleplay/android-developer/answer/15633622)
