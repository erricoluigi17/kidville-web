# C5 — 🔴 Sviluppo obbligatorio prima della submission

> **Questo non è un documento di configurazione. Sono due lavori di prodotto che oggi NON
> esistono nel codice e che bloccano la pubblicazione su Google Play.**
>
> È la sorpresa più costosa emersa dalla fase C: tutto il resto è compilare moduli e caricare
> file. **Questo è scrivere codice.**
>
> È anche **lavoro mio**, non tuo — ma il secondo dei due richiede **una tua decisione di
> prodotto** prima che io possa scriverlo.

---

## §1 — Pagina pubblica di cancellazione account

### Cosa manca

La **User Data policy** di Google richiede **due** percorsi di cancellazione:

1. uno **in-app** → ✅ **c'è**: `/parent/profilo` → `POST /api/parent/account/richiesta-cancellazione`;
2. uno via **risorsa web** → 🔴 **non c'è**.

Il link web va nel campo dedicato **dentro il modulo Data safety** [UFF, `answer/13316080`,
`answer/10787469`]. Oggi entrambi i percorsi Kidville sono **dietro login**.

### 🔴 La correzione di un errore nel repo

> `docs/store-submission.md` §3 afferma che si può indicare `/assistenza` *«che spiega la
> procedura»*. **È falso.**
>
> Ho verificato la pagina: 67 righe, contiene il titolo «Assistenza», l'email di supporto e un
> invito a rivolgersi alla Segreteria. **La parola «cancellazione» non compare.**

Un revisore che clicca quel link e non trova nulla produce il rifiuto
**«Invalid account/data deletion link on your Data safety»**. Il documento del repo va corretto.

### Requisiti Google della pagina

- si carica **senza errori**;
- il percorso di cancellazione è **prominente**;
- riporta **il nome dell'app o dello sviluppatore** come appare sulla scheda;
- permette la richiesta **senza rimandare l'utente all'app e senza costringerlo a riscaricarla**;
- esplicita eventuali **prerequisiti** e la **retention per obbligo di legge**.

### 🟢 Il testo esiste già, ed è buono

`messages/it/profilo.json` → `eliminaSpiegazione`:

> *«La richiesta viene inviata alla Direzione, che anonimizza in modo irreversibile i tuoi dati
> personali (nome, contatti, documenti) e sgancia l'accesso. I dati dei figli ancora iscritti
> restano gestiti dalla scuola; i documenti fiscali sono conservati per obbligo di legge.»*

Copre già prerequisiti e retention: sono esattamente i due punti che Google chiede. **Va messo su
una pagina pubblica**, non riscritto.

### Come lo farei

Una rotta dedicata **`/cancellazione-account`** — meglio di una sezione dentro `/assistenza`,
perché l'URL da incollare in Console deve essere *prominente* e un'ancora dentro una pagina di
supporto lo è meno.

Va aggiunta ai `PUBLIC_PREFIXES` in `src/lib/auth/middleware-rules.ts`. *(Verificato: oggi i
prefissi pubblici sono `/auth`, `/iscrizione`, `/api/iscrizione`, `/api/forms`,
`/api/panic-alert`, `/forms`, `/m`, `/api/public`, `/onboarding`, `/privacy`, `/termini`,
`/assistenza`, `/offline`.)*

### ⚠️ Una sfumatura che è deduzione, non testo ufficiale

> **La documentazione Google non dice testualmente «la pagina non deve richiedere login».**
> Dice che gli utenti *«potrebbero aver già disinstallato l'app o non poter accedere
> all'esperienza in-app»*.

L'interpretazione operativa sicura è: **pagina pubblica, usabile senza credenziali almeno per
*avviare* la richiesta**; la verifica d'identità può avvenire **dopo**, via email di conferma o
OTP. Lo scrivo come deduzione perché tale è — ma è la lettura che non rischia il rifiuto.

⚠️ **E porta con sé una decisione di sicurezza**: una pagina pubblica che avvia una cancellazione
è una superficie d'attacco. **Non deve cancellare nulla**: deve **registrare una richiesta** che
la Direzione evade, esattamente come fa oggi il percorso in-app. Con verifica via email prima che
la richiesta diventi lavorabile.

**Stima: mezza giornata.**

---

## §2 — 🔴 UGC: segnalazione, blocco e gate dei Termini

### Perché ci riguarda

Galleria di classe e chat genitore↔docente sono **UGC per definizione ufficiale**:

> *«content that users contribute to an app, and which is visible to or accessible by at least a
> subset of the app's users»*

E Kidville ricade nel caso che **Google nomina espressamente come esempio**: app a gruppo chiuso
con utenti identificati tramite registrazione offline. **Essere una scuola non è un'esenzione: è
l'esempio nel manuale.**

### Cosa richiede la policy [UFF, `answer/9876937`]

| Requisito | Stato oggi |
|---|---|
| **Segnalare contenuti** in-app | 🔴 non esiste |
| **Segnalare utenti** in-app | 🔴 non esiste |
| **Bloccare un utente** (richiesto per l'UGC con interazione 1:1 — la chat) | 🔴 non esiste |
| Entrambe *«readily accessible»* e *«clearly labeled»* | — |
| **Accettazione dei Termini non saltabile, PRIMA** di caricare o inviare UGC | 🔴 non esiste |
| I Termini definiscono **esplicitamente** contenuti e comportamenti vietati | 🟡 parziale — `/termini` §3 li elenca |

> 🔴 **Avere `/termini` raggiungibile dal menu NON soddisfa il requisito.** Serve un gate.

### 📌 Qui la fase C e il dossier legale convergono

Questo requisito **è lo stesso** della **lacuna E di [A3 §3-bis](A3-dossier-legale.md)**:
*«I Termini di servizio non vengono accettati da nessuno»*.

Erano due problemi trovati per strade completamente diverse — uno leggendo il Codice del Consumo,
l'altro leggendo la UGC policy di Google — **e hanno la stessa soluzione**: aggiungere i Termini
alla casella di accettazione dell'onboarding, con registrazione di data e versione.

> **Un solo intervento chiude un requisito Google e una lacuna contrattuale che oggi rende
> probabilmente inefficace la tua clausola di limitazione di responsabilità.** È il lavoro col
> miglior rapporto costo/beneficio di tutta la submission.

### 🟡 La decisione di prodotto che serve da te

#### Prima, i fatti — verificati nel codice, non ipotizzati

Ho letto `src/app/api/chat/contacts/route.ts` e le rotte della galleria. Il grafo di Kidville
**non è quello di un social**, ed è questo che decide la risposta:

| | Chi può fare cosa |
|---|---|
| **Chat — docente** | scrive **solo** ai genitori degli alunni della *sua* sezione |
| **Chat — genitore** | scrive **solo** alle maestre della sezione dei *suoi* figli |
| **Chat — genitore ↔ genitore** | 🔒 **non esiste.** Nessun genitore può contattarne un altro |
| **Galleria — caricamento** | `requireDocente`: **solo** personale docente. I genitori **guardano soltanto** |
| Chiave della conversazione | `${parent.id}:${student.id}` — ogni conversazione è **legata a un bambino preciso** |

**Conseguenza:** in Kidville **non esiste UGC fra pari**. Ogni contenuto è pubblicato da un
professionista identificato, oppure è una conversazione 1:1 fra due persone che hanno un rapporto
istituzionale. **Lo scenario che la policy di Google ha in mente — lo sconosciuto che ti
molesta — qui è strutturalmente impossibile.**

L'unica coppia 1:1 che esiste è **genitore ↔ maestra del proprio figlio**. Ed è lì che «blocca
utente» diventa una domanda seria: *cosa significa bloccare la maestra di tuo figlio?*

#### Le tre strade

| | Cosa fa | Soddisfa Google | Il problema |
|---|---|---|---|
| **A — Blocco classico** (stile social) | l'utente blocca, non vede più i messaggi, l'altro non può scrivere. Silenzioso | ✅ alla lettera | 🔴 **Rottura silenziosa.** Un genitore blocca la maestra dopo un diverbio; la maestra continua a scrivere nel vuoto; **nessuno se ne accorge**. Tre settimane dopo c'è un problema sul bambino e «non me l'ha detto nessuno». In una scuola non è un fastidio di UX: è un buco nella catena di comunicazione su un minore |
| **B — Sospensione + notifica alla Direzione** ⭐ | la conversazione si sospende, l'altro non può scrivere, **e la Direzione viene informata** e può mediare | ✅ l'utente **può** interrompere il contatto, subito, dall'app | nessuno grave. È un blocco che **lascia una traccia istituzionale** |
| **C — Solo segnalazione**, moderazione centralizzata | nessun blocco self-service: tutto passa dalla Direzione | 🔴 **rischioso**: la policy chiede il blocco per l'UGC 1:1. «Le nostre segnalazioni vanno alla Direzione» è un argomento, non una conformità | non vale il rigetto |

#### ✅ DECISIONE PRESA dal titolare — 2026-07-26: **B, sospensione + notifica alla Direzione**

Comportamento da implementare:

```
Menu ⋮ della conversazione → «Sospendi conversazione»
                            → conferma + motivo (facoltativo)

EFFETTO IMMEDIATO
  • l'altra parte non può più scrivere in quella conversazione
  • chi sospende non riceve più messaggi né notifiche da lì
  • l'altra parte vede «Conversazione sospesa»  (dichiarato, non silenzioso)
  • ✉ la DIREZIONE riceve una notifica e può mediare

RESTA ATTIVO — sono canali diversi dalla chat
  ✓ avvisi e circolari      ✓ giustifiche
  ✓ diario e galleria       ✓ notifiche push della scuola

RIAPERTURA
  • da chi ha sospeso, in qualsiasi momento
  • oppure dalla Direzione, dopo la mediazione

SIMMETRICO: identico se è la maestra a sospendere verso un genitore.
```

Note di implementazione che discendono dalla decisione:

- la sospensione è **per conversazione** (`${parent.id}:${student.id}`), non per utente: un
  genitore con due figli in sezioni diverse sospende un rapporto, non tutta la scuola;
- la notifica alla Direzione passa dal **Centro Notifiche** esistente (nuovo tipo di evento con
  il suo toggle), non da un canale nuovo;
- il **motivo** è testo libero dell'utente → **redatto nei log** (`@/lib/logging/redact`), mai in
  chiaro: vale la regola 8 di `AGENTS.md`;
- serve la voce anche in `messages/it` e `messages/en`, l'app è bilingue.

#### 🟢 Perché B — le ragioni della raccomandazione, per il futuro lettore

Quattro ragioni, in ordine di peso:

1. **Soddisfa Google davvero.** L'utente può interrompere il contatto con quella persona,
   immediatamente, da dentro l'app. È quello che la policy chiede.
2. **Non taglia il canale istituzionale.** Avvisi, circolari, giustifiche e notifiche **viaggiano
   su un canale diverso dalla chat**: sospendere una conversazione **non** impedisce alla scuola
   di comunicare. È il fatto che rende B possibile — e che rende A meno grave di quanto sembri,
   ma non meno silenzioso.
3. **La scuola lo viene a sapere.** Un rapporto scuola-famiglia che si rompe è **esattamente**
   ciò che una Direzione deve sapere. In A lo scopre per caso; in B glielo dice il sistema.
4. **Funziona in entrambe le direzioni.** Anche una maestra molestata da un genitore ha uno
   strumento — e la Direzione lo sa. È uno scenario reale nelle scuole, e A lo lascerebbe
   altrettanto muto.

#### Silenzioso o dichiarato — ✅ deciso: **dichiarato**

Nei social il blocco è **silenzioso**, per non allertare un molestatore. Qui i due sono
identificati e in rapporto istituzionale, quindi la scelta si ribalta: l'altro vede
«conversazione sospesa», così **nessuno scrive nel vuoto**.

Il caso in cui il silenzio sembrerebbe più protettivo — **un genitore che subisce da un
docente** — è coperto meglio dalla **notifica alla Direzione**, che è una tutela più forte del
silenzio: qualcuno con autorità viene a saperlo e può intervenire.

**Stima: 2-3 giorni, gate dei Termini incluso.**

---

## §3 — Perché queste due cose non erano nella checklist di ieri

Nessuna delle due nasce dalla submission su App Store, ed è per questo che non erano note:

- **Apple non chiede la pagina web di cancellazione**: gli basta la cancellazione in-app
  (linea guida 5.1.1(v)), che Kidville ha.
- **Apple non ha una UGC policy con requisiti così espliciti** su segnalazione e blocco per le
  app a gruppo chiuso.

> **Sono requisiti specifici di Google Play, e sono sviluppo — non moduli.**
> Vanno in coda **subito**, perché sono l'unica parte della fase C che non può correre in
> parallelo all'attesa del D-U-N-S: quando il numero arriva, devono essere già pronti.

---

## §4 — Checklist

**Pagina di cancellazione**
- [x] Decisa la rotta: `/cancellazione-account` (2026-07-27)
- [x] Testo riusato da `messages/it/profilo.json` → `eliminaSpiegazione`, IT + EN (2026-07-27)
- [x] Aggiunta a `PUBLIC_PREFIXES` (2026-07-27)
- [x] La pagina **registra una richiesta**, non cancella — con verifica via email (magic-link, riuso `otp-ticket.ts`) (2026-07-27)
- [x] Riporta il nome dell'app come appare sulla scheda (2026-07-27)
- [x] Corretto `docs/store-submission.md` §3, che oggi indica `/assistenza` **sbagliando** (2026-07-27)
- [ ] URL incollato nel modulo Data safety ([C4](C4-conformita-pubblico.md)) — **resta da fare in Play Console**, fuori da questo repo

**UGC**
- [x] ~~Decisione sul «blocco»~~ → ✅ **B: sospensione + notifica alla Direzione, dichiarata** (2026-07-26)
- [x] Segnalazione **contenuto** in-app (galleria, diario, chat) (2026-07-27)
- [x] Segnalazione **utente** in-app (2026-07-27)
- [x] Blocco / sospensione conversazione, secondo la decisione presa (2026-07-27)
- [x] Entrambe visibili e chiaramente etichettate (2026-07-27, verificato dal tester frontend)
- [x] **Gate dei Termini non saltabile** prima del primo invio di UGC (2026-07-27, guardia server-side in `POST /api/chat/messages`, non solo la checkbox)
- [x] Registrazione di **data e versione** dei Termini accettati → chiude anche **A3 lacuna E** (2026-07-27, tabella append-only `consensi_accettazioni`)
- [ ] `/termini` rivisto col legale perché definisca i contenuti vietati ([A3](A3-dossier-legale.md)) — **resta lavoro del legale**, non di sviluppo
- [x] Gate verde: eslint · tsc · vitest · build (2026-07-27 — 387 file / 3181 test, build 382 route)
- [x] PRD aggiornato (2026-07-27)
