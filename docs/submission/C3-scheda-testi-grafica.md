# C3 — Scheda Play: testi e grafica

> **Stato**: nel repo **non esiste nessuno** degli asset di scheda Play. Ci sono solo asset di
> brand (`assets/icon-only.png`, `assets/logo.png`, `public/mascot.png`…).
>
> I testi qui sotto sono **bozze pronte, scritte da zero sulle funzionalità reali estratte dal
> codice** — non copiate da altrove. Vanno lette e corrette, non riscritte.

---

## §0 — 🔴 La prima cosa da fare in Console, prima di caricare qualsiasi cosa

**Cambiare la lingua predefinita da `en-US` a `it-IT`**
*(Gestisci traduzioni → Cambia lingua predefinita)*.

Perché prima: **la lingua predefinita fa da fallback ovunque, grafiche comprese.** Se resta
`en-US`, in ogni locale non tradotto testo **e screenshot** compaiono in inglese — anche a utenti
italiani [UFF].

---

## §1 — I testi

### Titolo — max 30 caratteri [UFF]

> **`Kidville — Registro scuola`** → **26 caratteri** ✓

Alternative dentro il limite: `Kidville Registro Scuola` (24) · `Kidville — Registro` (19).

⚠️ Nessuna emoji, nessun tutto-maiuscolo, nessun simbolo ripetuto [UFF].

### Descrizione breve — max 80 caratteri [UFF]

> **`App per genitori e personale della Scuola dell'Infanzia La Favola`** → **65 caratteri** ✓

Questa riga fa **doppio lavoro**: descrive il prodotto **e dichiara il pubblico adulto**, che è
la difesa di [C4 §2](C4-conformita-pubblico.md).

**EN**: `For parents and staff of Scuola dell'Infanzia La Favola` → 54 caratteri ✓

### Descrizione completa — tetto 4.000, bozza ≈1.480 [UFF]

> I 4.000 caratteri sono un **tetto, non un obiettivo**: la policy sui metadati elenca
> esplicitamente *«lunghezza eccessiva, dettaglio, formattazione impropria o ripetizione»* tra le
> cause di violazione [UFF]. E **nessuna parola «gratis»/«free»**: è una dichiarazione di prezzo,
> vietata nei metadati [UFF].

```
Kidville è l'app riservata ai genitori e al personale della Scuola
dell'Infanzia La Favola. L'accesso avviene solo con le credenziali
consegnate dalla Segreteria: non è prevista registrazione libera e
l'app non è destinata ai bambini, che non hanno un account.

PER I GENITORI
• Diario giornaliero — come è andata la giornata: umore, entrata,
  pasti, sonno, attività, la nota della maestra e la foto del giorno.
• Assenze — segnala un'assenza e invia la giustifica direttamente
  dall'app.
• Mensa — menù della settimana con gli allergeni, prenotazione e
  disdetta del pasto entro l'orario di cutoff, saldo dei ticket.
• Avvisi e circolari — con presa visione e adesione.
• Chat con le insegnanti — comunicazione diretta con la sezione.
• Galleria — foto e video della classe, riservati alle famiglie
  della sezione.
• Pagamenti — scadenziario delle rette, storico e causale per il
  bonifico. I pagamenti avvengono fuori dall'app.
• Moduli e modulistica — compilazione e firma dei consensi, con
  verifica via codice.
• Armadietto — scorte e materiale del bambino.
• News — comunicati e notizie della scuola.
• Profilo e deleghe — gestione dell'account, sblocco con impronta
  o riconoscimento del volto, privacy e cancellazione dei dati.

PER IL PERSONALE
Appello della giornata, agenda della sezione, allergie e note
mediche degli alunni, compilazione del diario, bacheca interna,
registro di classe e valutazioni per la primaria.

NOTIFICHE
Avvisi, messaggi e scadenze arrivano come notifica sul telefono,
con il contatore sull'icona dell'app.

ANCHE SENZA CONNESSIONE
Le pagine già visitate restano consultabili anche quando la rete
manca.

PRIVACY
Nessuna pubblicità, nessun tracciamento, nessuno strumento di
analisi del comportamento. I dati sono trattati da Scuola
dell'Infanzia La Favola Soc. Coop. (Cesa, CE) secondo l'informativa
pubblicata su app.kidville.it/privacy.

Kidville è disponibile in italiano e in inglese.
```

**Perché è scritta così** — ogni scelta risponde a una regola:

| Scelta | Ragione |
|---|---|
| Apre dichiarando il **pubblico adulto** | è la difesa di [C4 §2](C4-conformita-pubblico.md) contro la riclassificazione d'ufficio |
| **Nessuna funzione promessa che non esista** | verificato contro `src/app/(dashboard)/parent`: nessuna voce «In arrivo», nessun `soon: true` in `BottomNav.tsx` |
| **Nessuna promessa di back-office** (contabilità, protocolli DPR 445, SIDI, cassa, graduatorie) | l'account genitore non le mostra: promettere ciò che il revisore non può vedere è esattamente lo scarto che fa segnalare una scheda |
| **Funzioni native esplicitate** (notifiche, badge, biometria, offline) | è la difesa contro *Minimum Functionality* — [C2 §9](C2-build-aab.md) |
| Niente prezzi, testimonianze, keyword stuffing | policy metadati [UFF] |

### 🔴 Terminologia inglese: usare i cataloghi, non inventare

`messages/en/` contiene i termini già tradotti e revisionati: **Canteen** (non «Cafeteria»),
**Notices**, **Locker**, **My diary**, **My photos**, **Profile and delegations**,
**Report absence**, **Chat with the teachers**, **Payments**.

> Una scheda che dice «Cafeteria» mentre l'app dice «Canteen» **sembra un altro prodotto** — e su
> Play l'incoerenza scheda↔app è materia di **«Ingannevole»**, non di stile.

### Istruzioni di accesso (Contenuti dell'app → Accesso all'app)

Il testo **esiste già**, in `docs/store-submission.md` righe 190-198, ed era stato scritto
esplicitamente per «Google Play → Istruzioni di accesso». Va copiato quasi 1:1, sostituendo
«iOS share sheet» → «foglio di condivisione Android» e «Face ID / Touch ID» → «impronta /
sblocco biometrico». La versione inglese (righe 145-186) serve per la locale `en-US`.

**Credenziali demo**: `test.inf.genitore1@kidville.test`
*(password non scrivibile qui: il lock `__tests__/architecture/niente-password-nel-repo.test.ts`
fa fallire il gate — sta nel gestore di credenziali del titolare).*

> 🔴 **Mai dare `test.segreteria@kidville.test`, `test.pri.segreteria` o `test.cuoca`.**
> Leggono l'anagrafica **reale** dell'intera sede di Giugliano: famiglie e bambini veri. È
> **comunicazione di dati di minori a un terzo senza base giuridica**, non un formalismo. Se
> serve mostrare il back-office al revisore, **si registra un video**.

---

## §2 — La grafica

| Asset | Specifica esatta [UFF] | Stato |
|---|---|---|
| **Icona** | PNG **32 bit CON canale alpha**, esattamente **512×512**, max 1024 KB, quadrato **PIENO** | da produrre — resize da `assets/icon-only.png` |
| **Immagine in evidenza** | **JPEG o PNG 24 bit SENZA alpha**, esattamente **1024×500** | 🔴 **da disegnare da zero** — su App Store questo asset non esiste |
| **Screenshot telefono** | JPEG/PNG **24 bit senza alpha**, max 8 MB, lato min ≥320, lato max ≤3840, **lato max ≤ 2× lato min**. Min 2 per pubblicare; **min 4 a ≥1080 px in 9:16** per l'idoneità a promozioni; max 8 | da catturare — **target 8 a 1080×1920** |
| **Screenshot schermi grandi** | min **4**, lato 1.080-7.680 px, 16:9 o 9:16 | consigliati — 4 da emulatore 10" |
| **Video promozionale** | URL YouTube, ads disabilitate, nessun limite d'età, incorporabile | **omettere alla prima submission** |

### 🔴 L'icona iOS non si riusa

Play applica **da sé** la maschera (raggio 30% della dimensione) e l'ombra. Se l'asset ha già
angoli arrotondati o drop shadow «cotti» dentro, **l'icona esce con un bordo tagliato e un doppio
alone**. Serve un export **quadrato pieno 512×512 con alpha**.

### 🔴 Alpha invertito — l'errore di upload più comune

> **Icona = alpha OBBLIGATORIO. Immagine in evidenza e screenshot = alpha VIETATO.**

Invertire i due profili **blocca il salvataggio della scheda**, e il messaggio d'errore non è
esplicito.

### 🔴 I 12 screenshot dell'App Store sono inutilizzabili — per due ragioni indipendenti

1. **Rapporto d'aspetto.** Play impone «lato max ≤ 2× lato min». Gli screenshot su ASC sono
   6× iPhone 17 Pro Max a **1320×2868** (rapporto ~2,17) e 6× iPad a 2064×2752. **Rifiutati.**
   Idem 1080×2340 (Android tipico, 2,167) e 1290×2796.
   → **Formato d'oro: 1080×1920** — rapporto 1,78, dentro il 2:1, sopra la soglia promozionale,
   funziona ovunque.
2. **Non sono comunque nel repository**: non committati. Vanno **riprodotti**, non recuperati.

### Cosa è VIETATO negli screenshot [UFF]

Cornici di dispositivo e mockup · persone che interagiscono col dispositivo (dita sullo schermo) ·
badge o icone di Google Play o altri store · loghi e personaggi di terzi senza autorizzazione ·
immagini sfocate, distorte, pixelate, stirate · call-to-action tipo «Scarica ora» · tagline oltre
il **20%** dell'immagine.

> ⚠️ Mostrare una **cornice iPhone** in una scheda Android somma **due** violazioni: cornice di
> dispositivo **e** marchio di terzi. Su Apple si tollerano, qui no.

### Tagline e localizzazione — la scorciatoia onesta

Se si mettono tagline sugli screenshot, Google chiede **set separati per ciascuna lingua** →
8 IT + 8 EN (+4+4 tablet) = 24 immagini.

> **Se il budget grafico non c'è: screenshot con la UI localizzata ma senza sovrimpressioni.**
> Nessuna violazione, nessuna duplicazione, metà del lavoro.

### ⚠️ Il vincolo che decide la grafica non è in questo documento

**Feature graphic, icona e screenshot vanno disegnati leggendo prima
[C4 §2](C4-conformita-pubblico.md).** Google si riserva di riclassificare l'app come «per
bambini» in base a *«youthful animation or young characters in the graphic assets»* — e l'app si
chiama **Kid**ville e ha una mascotte cartoon. **Le regole grafiche di C4 vengono prima
dell'estetica.**

---

## §3 — La cattura degli screenshot

### Le trappole — ⚠️ due delle quattro erano SBAGLIATE per Android

> **Corretto il 2026-07-28**, verificando i selettori sul codice e sull'emulatore. Le quattro
> trappole qui sotto erano state ricavate da **iOS** e trascritte come se valessero ovunque. Due
> di esse sono **false su Android** — cioè proprio sulla piattaforma per cui esiste questo
> documento. Un flow scritto seguendo la versione precedente fallisce al primo tap e non produce
> nessuno screenshot oltre il login.
>
> Il flow corretto e funzionante è `.claude/maestro-flows/android-screenshot-playstore.yaml`.

1. ✅ **Vera.** I deep link `kidville://` aprono un **alert nativo** che si accoda e blocca la
   navigazione → navigare con la bottom nav e il foglio MENU.
2. ❌ **Falsa nell'area genitore.** «Nel foglio MENU il titolo breve `MENSA` colpisce anche la
   bottom nav dietro l'overlay» — la bottom nav del **genitore** non ha alcuna voce «Mensa»: ha
   Home · Diario · Avvisi · Chat · Menu. Quel tab esiste solo nel cockpit **segreteria**.
   Le collisioni vere sono su `Diario`, `Avvisi`, `Chat` e `Menu`, ambigui a foglio aperto perché
   la bottom nav è `z-50` **sopra** l'overlay `z-40`.
   → **Si tocca sempre il SOTTOTITOLO della voce, mai la label.**
3. ✅ **Vera, e la più insidiosa.** `waitForAnimationToEnd` **non aspetta i dati**. Ma non basta
   sapere: non esiste **un** testo di caricamento, ne convivono almeno sette, con ellissi
   tipografica `…` (U+2026) e tre punti ASCII `...` mescolati — «Caricamento…», «Caricamento...»,
   «Un attimo...», «Caricamento foto...», «Caricamento armadietto...». Una guardia scritta con
   l'ellissi sbagliata **sembra funzionare e non protegge**.
   → Usare una regex tollerante (`.*[Cc]aricamento.*` **e** `.*Un attimo.*`) e, prima di ogni
   scatto, attendere un testo che compare **solo a dati caricati**.
4. ❌ **Falsa su Android.** «Il pulsante menu espone l'aria-label `Menu · tutte le sezioni`, non
   `MENU`». L'aria-label esiste davvero nel codice (`nav.ariaMenu`, con middle dot U+00B7), ma la
   **WebView Android collassa il `<button>` col suo `<span>` figlio e pubblica solo il testo
   visibile**: l'aria-label NON diventa `contentDescription`.
   → Su Android il selettore è `tapOn: { text: "MENU" }`. Su iOS, e solo lì, vale la stringa
   concatenata.

**Sottotitoli da usare come selettori su Android** (da `messages/it/nav.json`, univoci):
`Assenze e giustifiche` · `Menu e ticket pasto` · `Rette e scadenze` · `Firme e certificati` ·
`Novità e comunicati` · `Account, privacy e cancellazione` · `Scorte e materiale` ·
`Galleria della classe`.

**Marcatori «dati caricati»** da attendere prima di scattare: Diario `Umore della giornata` ·
Mensa `Prenota pranzo` · Presenze `Segnala assenza` · Pagamenti `Totale da saldare` ·
Avvisi `Comunicazioni` · Profilo `Elimina account`.

**Lingua.** Vive nel cookie `KV_LOCALE` letto server-side; il default in assenza di cookie è `it`.
`clearState: true` lo azzera, ma un `tapOn: "Italiano"` sulla pagina di login rende il flow
deterministico ed è idempotente (l'etichetta è identica in IT e in EN).

⚠️ **I selettori Maestro Android ≠ iOS**: le trappole sono in parte le stesse, i selettori mai.

### 🔴 L'account del revisore NON funzionava — corretto il 2026-07-28

Questo documento, `store-submission.md` e le note di review dicono tutti di consegnare al revisore
**`test.inf.genitore1@kidville.test`**. Verificato in produzione il 2026-07-28: quell'account
**esisteva in `auth.users` ma non in `utenti`**. Si autenticava e restava **senza identità
applicativa** — `ensureParentIdentity` è invocata solo dalle route admin, mai al login, quindi non
si auto-riparava.

E c'era di peggio, indipendente dal primo difetto: **nessuno dei 10 alunni della sezione TEST
Infanzia era collegato ad alcun genitore** (`student_parents`: 0 righe per quella sezione). Ogni
account genitore Infanzia — non solo il primo — vedeva un'app **vuota**. Un revisore avrebbe fatto
login e trovato il nulla.

**Corretto** da `scripts/seed-screenshot-play.mjs`: riga `utenti` creata, 10 alunni collegati ai
rispettivi genitori di test, consensi GDPR e onboarding impostati (senza, il genitore finisce sul
flusso di onboarding invece che sulla home, e il gate Termini di C5 blocca la chat).

> L'account demo ha ora una **password dedicata**, non più quella comune ai 41 account di test:
> ruotarla dopo la review non romperà nient'altro. Vive fuori dal repository, in
> `~/Documenti/kidville-play/.demo-revisore-pw` (il lock `niente-password-nel-repo` vieta di
> scriverla qui). **Va trascritta nel gestore di credenziali e incollata nelle note di review.**

### Dati demo: le regole che rendono invisibili i dati appena inseriti

Si cattura sulla classe **TEST Infanzia** `219cab6a-2bf3-48d6-a443-b7aecda40f42` in produzione.

1. Il diario ha una **finestra di correzione**: il genitore vede una voce solo dopo
   `buffer_visibilita_min` minuti da `creato_il` → **il seed va retrodatato**. Il buffer non è
   fisso: è `admin_settings.diario_config.buffer_visibilita_min`, **assente per Giugliano**, quindi
   vale il fallback di 10 minuti (`src/app/api/diary/entries/route.ts`). Il filtro è **doppio**:
   `creato_il` dev'essere più vecchio della soglia **e** `orario_inizio` dentro la finestra
   richiesta (default 14 giorni).
2. `mensa_class_menu_assignment` è **VUOTA**: la scuola lavora in «menù unico» e il server filtra
   `menu_config_id IS NULL`. Una riga con `menu_config_id` valorizzato viene **esclusa in
   silenzio**, e la pagina continua a dire «menu non ancora pubblicato».
3. ⚠️ `mensa_menu_rotazione.settimana` **non è la settimana dell'anno**: è l'indice di rotazione
   `1..N` (`rotationWeekIndex` = `((settimanaISO - 1) % N) + 1`, con un vincolo `CHECK 1..8`).
   Scriverci la settimana ISO fa fallire l'inserimento. Per Giugliano `N = 4`, giorni attivi 1-6.
4. ⚠️ **Il menù è per SCUOLA, non per classe**: pubblicarlo per una foto lo rende visibile anche
   alle famiglie reali. `node scripts/seed-screenshot-play.mjs --revert` lo rimuove — va lanciato
   **subito dopo** la cattura.
5. `presenze.giustificata` è **NOT NULL**: va valorizzata su ogni riga, non solo sulle assenze.

> ⏰ I dati di scena si rigenerano con `node scripts/seed-screenshot-play.mjs --apply`, che
> retrodata `creato_il` di tre ore e riempie diario, presenze e menù. Non serve più preoccuparsi
> della scadenza del 2026-08-09: lo script ripopola sempre «oggi».

### 🔴 Le 51 immagini in `e2e/collaudo-giornata/run/screenshots/` — MAI

Sono le uniche immagini «di app» presenti sul filesystem e **sembrano pronte all'uso**.

Sono **gitignorate di proposito**: catture di collaudo su **produzione**, e i nomi dei file
(`10-segreteria-02-anagrafica-lista.png`, `…verifica-famiglia-collegata-nella-scheda-…`) dicono
che mostrano viste segreteria sull'**anagrafica reale della sede**.

> **Una scheda store è pubblica e indicizzata mondialmente.** Stessa cosa per
> `e2e/primaria-360/run/screenshots/`.

---

## §4 — ⚠️ La descrizione dell'App Store non è recuperabile dal repo

Il repository documenta **che** è stata compilata, non **cosa dice** (verificato con grep). Vive
solo su App Store Connect (app `6794883055`, localizzazione `it` `3eacbb21-…`).

Per rileggerla via API serve l'**Issuer ID**, che non è sulla macchina e va preso a mano da
App Store Connect → *Users and Access* → *Integrations*.

> Le bozze del §1 sono scritte **da zero**. Se vuoi che le due schede siano allineate, il recupero
> va fatto **prima** di pubblicare quella Play.

---

## §5 — Checklist

- [ ] **Lingua predefinita cambiata a `it-IT`** *(prima di caricare qualsiasi grafica)*
- [ ] Titolo, descrizione breve e completa approvati da te
- [ ] Versione EN dei testi, con la terminologia di `messages/en/`
- [ ] Istruzioni di accesso copiate da `store-submission.md` e adattate ad Android
- [ ] Letto **C4 §2** prima di disegnare qualsiasi cosa
- [ ] Icona 512×512 PNG 32 bit **con alpha**, quadrato pieno
- [ ] Immagine in evidenza 1024×500 **senza alpha**
- [ ] Dati demo rinfrescati con `creato_il` retrodatato
- [ ] 8 screenshot telefono a **1080×1920**
- [ ] 4 screenshot tablet
- [ ] Verificato: nessuna cornice di dispositivo, nessun volto di bambino, nessun marchio terzo
