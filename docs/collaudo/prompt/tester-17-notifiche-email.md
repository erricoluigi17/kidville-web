# Tester n. 17 — Notifiche ed email

Sei **il tester n. 17**. Fai **un solo collaudo**: i messaggi che escono dall'app — push, email,
notifiche in-app. Scrivi in italiano.

**Prima di tutto**: leggi `docs/collaudo/README.md` (regole comuni) e `docs/collaudo/MODELLO-REPORT.md`
(formato del report). Sono vincolanti.

**I divieti, in breve** — non modifichi codice, non usi `git`, non fai `npm install`; sul database di
produzione **solo `SELECT`**; non fermi né riavvii il server su `:3100`.

> ⚠️ **Non inviare niente a nessuno.** Non far partire email, non far partire push, non lanciare cron
> a mano: i destinatari sono genitori veri. Il collaudo si fa **leggendo il codice, i template, la
> configurazione e i log di ciò che è già partito**. Se un controllo richiede un invio, scrivi «non
> verificabile senza invio a destinatari reali» e di' cosa servirebbe (un ambiente separato).

---

## Il precedente che dà il tono

Per **mesi** nessuna email di credenziali è arrivata: il provider rispondeva `403` («the domain is not
verified») e il codice registrava solo il numero. Nessun test rosso, nessun allarme. Il tuo compito è
sapere, **oggi**, se le email e le push stanno davvero arrivando — non se il codice per mandarle esiste.

---

## Che cosa devi verificare

### 1. Stanno partendo? E stanno arrivando?
Con `SELECT` su `app_log` (solo aggregati, mai indirizzi):
- quanti invii di email negli ultimi 30 giorni, per tipo (credenziali, digest news, solleciti,
  notifiche), e quanti **riusciti** contro quanti **falliti**;
- quante push, per piattaforma, riuscite e fallite;
- **se il conteggio dei successi è zero**, o se non esiste un log di successo, sei già davanti al
  rilievo principale: senza il log del successo, «nessun log» non distingue «tutto ok» da «non è mai
  partito niente» (regola 5 di `AGENTS.md`).

Guarda anche i codici di errore restituiti dai provider, e verifica che nel log ci sia il **corpo**
della risposta e non solo lo status.

### 2. La configurazione
- Il dominio mittente è un **sottodominio verificato** (`mail.kidville.it`), non il dominio nudo: è
  esattamente il dettaglio che generava il `403`. Verifica che le variabili siano quelle giuste e che
  siano presenti in produzione (`docs/env.md`, e `mcp__claude_ai_Vercel__get_project` per l'elenco dei
  nomi — **mai i valori** nel report).
- Chiave APNs e progetto FCM: presenti? La mappatura FCM↔APNs avviene **dopo** il login (era rotta lì).
- Il canale Android `kidville_notifiche` esiste ed è quello usato?

### 3. I template
Email transazionali e **digest mensile** (`src/lib/news/digest-email.ts`, HTML a tabelle):
- rendono bene in un client vero? Guarda l'HTML: tabelle, larghezza fissa ≤ 600 px, stili in linea,
  niente CSS moderno che i client non capiscono, immagini con testo alternativo, versione testuale;
- c'è un link di disiscrizione dove serve?
- il testo contiene dati di minori? Un digest che finisce nella casella sbagliata è un incidente
  privacy, non un fastidio;
- i segnaposto sono tutti sostituiti? Cerca `{{`, `[...]`, `undefined`, `null` nei template renderizzati.

### 4. I trigger
Il centro notifiche dichiara **39 tipi con interruttore** e **26 trigger**. Verifica per lettura:
- ogni tipo ha davvero un trigger che lo produce, e ogni trigger un tipo dichiarato;
- gli interruttori del genitore vengono **rispettati** prima dell'invio (un opt-out ignorato è grave);
- non ci sono duplicati (lo stesso evento che manda due notifiche);
- i cron: quando girano, e **lasciano traccia del proprio esito**?
  ```bash
  npx vitest run __tests__/architecture/cron-http-esito-osservato.test.ts
  grep -rn "pg_cron\|cron" supabase/migrations | head -20
  ```

### 5. Le notifiche in-app
La campanella: il contatore è giusto? Si azzera quando si legge? Sopravvive al ricaricamento? Funziona
su mobile (è costruita su `matchMedia` + `useSyncExternalStore`: verifica che non abbia problemi di
idratazione)? Il pannello elenca le notifiche nell'ordine giusto?

### 6. Chi riceve cosa
Con `SELECT`: i destinatari di un avviso di sede sono **solo** quelli di quella sede? Il lock
`destinatari-con-ponte` copre la forma; tu verifica un caso vero contando le righe. Un avviso di
Aversa che raggiunge i genitori di Giugliano è un incidente su dati di minori.

---

## La prova di validità (obbligatoria)

- Prima di dire «le email partono», verifica che la tua query su `app_log` **trovi** qualcosa dove sai
  che c'è (un tipo di evento che sicuramente è avvenuto). Una query che torna vuota perché è scritta
  male sembra identica a un sistema che non manda niente.
- Prima di dire «gli opt-out sono rispettati», trova nel codice il punto esatto in cui vengono letti,
  e verifica che sia **prima** dell'invio e non dopo.

## Verdetto

| | Quando |
|---|---|
| **PASS** | successi e fallimenti loggati con il corpo dell'errore, configurazione presente, template puliti e senza segnaposto, trigger coerenti con i tipi, opt-out rispettati, destinatari filtrati per sede |
| **FAIL** | invii che falliscono senza che si veda, nessun log di successo, un opt-out ignorato, un destinatario di un'altra sede, un segnaposto in un'email reale |
| **BLOCCATO** | non puoi leggere i log degli invii |

## Il tuo report

`docs/collaudo/risultati/tester-17-notifiche-email.md` — front-matter con `tester: 17`,
`categoria: notifiche`. Apri con la **misura**: quanti invii, quanti riusciti, negli ultimi 30 giorni.
Nei **non verificati** metti tutto ciò che richiederebbe un invio vero.
