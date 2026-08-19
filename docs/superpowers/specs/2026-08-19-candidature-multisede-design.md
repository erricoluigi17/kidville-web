# «Lavora con noi»: marchio, candidatura su più sedi, copia alla sede

**Data:** 2026-08-19 · **Stato:** approvato · **Modulo:** `/lavora-con-noi`

Tre richieste che arrivano insieme e che il codice tiene insieme male se le si affronta
una per volta: il modulo pubblico va **brandizzato**, la sede deve diventare una
**scelta multipla**, e ogni invio deve recapitare alla sede una **copia completa** del
modulo con il curriculum allegato.

Il filo che le lega è che tutte e tre toccano il confine fra ciò che è pubblico e ciò
che è di una sede. Il logo è l'unico punto in cui il modulo dichiara di chi è; la sede
multipla rompe l'assunto «una candidatura appartiene a un plesso» su cui poggiano due
indici unici e un lock d'isolamento; la copia via email porta fuori dall'applicazione
dati che finora non ne erano mai usciti.

---

## 1 · Il logo verde in alto a destra

### Cosa si fa

Il wordmark verde entra nella riga di testa delle pagine pubbliche, a destra.

**Asset: `public/logo-kidville.png`, 2227×571.** Esiste già, è già il wordmark verde
ritagliato, ed è già in uso su `/auth/login`. Non se ne produce uno nuovo.

⚠️ **`public/logo_green.png` NON si usa.** È lo stesso logo ma 6000×3375, con il
marchio confinato nel terzo centrale e il resto bianco: reso a 28 px di altezza il
wordmark ne misurerebbe nove. Il file resta dov'è perché non è questo il lavoro che lo
rimuove, ma nessun componente lo importa.

### Dove

In `src/components/ui/PublicPageHeader.tsx`, cioè in **un posto solo**. È il componente
nato apposta perché la riga di testa non ricominci a divergere fra le cinque superfici
pubbliche, e questa è la seconda cosa che ci entra dopo il comando di Alto Contrasto.
Ne beneficiano `/lavora-con-noi`, `/iscrizione`, `/privacy`, `/termini`, `/assistenza`.

La riga diventa:

```
← Torna indietro                      [Alto contrasto]  [logo Kidville]
```

Il logo è l'ULTIMO elemento del gruppo di destra: «in alto a destra» vuol dire al
bordo, non accanto al bordo.

### Non è un link, e ha un `alt`

`alt="Kidville"`, non `alt=""`: è il marchio, e chi ascolta la pagina deve sapere di chi
è il modulo che sta compilando.

Non è cliccabile. La riga di testa ha già la sua unica via d'uscita (`← Torna
indietro`), e un secondo bersaglio accanto — che porterebbe altrove — le toglie la
proprietà che la rende utile: da questa schermata si esce in un modo solo.

### Le due misure da prendere sulla pagina viva, non da dedurre

1. **A 360 px la riga è già piena.** Misurato l'11-12/08/2026 su questa stessa testata:
   `Torna indietro` è 111×20 (poi portato a `min-h-11`), `Alto contrasto` è 148×46. Un
   logo alto 28 px ne misura 109 di larghezza, e 111 + 148 + 109 + gap non stanno in
   360. La riga è `flex-wrap`, quindi non si rompe: va **a capo**, e la testata cresce
   in altezza sopra ogni pagina pubblica.
   **Rimedio previsto:** altezza ridotta sotto `sm` (`h-6`, ≈ 71 px di larghezza).
   **Criterio di accettazione:** l'altezza della testata a 360 px, misurata sulla
   pagina viva, non aumenta rispetto a oggi.

2. **Alto contrasto.** Il verde `#006A5F` su fondo ad alto contrasto va **misurato**,
   non supposto. Se il rapporto non regge, sotto quella classe il sorgente passa a
   `logo-light.png`. Un logo che sparisce nella modalità nata per chi ci vede poco è il
   difetto peggiore dei due.

### Cosa NON si tocca

Il comando di Alto Contrasto, il link di ritorno, `ritornoInterno()`, il `<main>` di
`/lavora-con-noi` e la struttura per intestazioni del wizard.

---

## 2 · La sede in selezione multipla

### Il vincolo che decide la forma

Non è una scelta di gusto. In `candidature_insegnanti` ci sono **due indici UNIQUE
globali**:

| Indice | Su | Perché esiste |
|---|---|---|
| `candidature_insegnanti_email_viva` | `lower(email)` dove `stato in ('pending','in_approvazione')` | una sola candidatura viva per persona su **tutta la cooperativa** |
| `candidature_insegnanti_cv_unico` | `cv_path` dove non nullo | è il **gate anti-IDOR** del curriculum: impedisce di rivendicare il `cv_path` di un'altra sede e farselo firmare dalla propria segreteria |

Inserire una riga per sede fa fallire il secondo invio con `23505` su entrambi. Per
farlo funzionare bisognerebbe **allentare l'indice sul `cv_path`**, cioè riaprire di
proposito il buco che la migrazione `20260814225302` ha chiuso.

Quindi: **una candidatura, più sedi.**

### Lo schema

> **Nota sul vocabolario, e non è pignoleria.** Quella che segue si chiamerebbe, in
> gergo di database, «tabella figlia». In questo repo quella parola è ambigua fino al
> pericolo — `alunni`, `student_parents`, `parents`: qui i figli sono bambini veri — e ha
> già confuso una lettura. In tutto questo documento si dice **«le righe di sede»** e
> **«la tabella delle sedi scelte»**. Chi scriverà i commenti nel codice faccia lo stesso.

```sql
candidature_insegnanti                 -- LA PERSONA: una riga, un CV, una dedup
  scuola_id   uuid not null            -- resta: sede di PRIMO ARRIVO
  stato       text                     -- diventa DERIVATO (vedi trigger)
  …invariato

candidature_sedi                       -- LE SEDI SCELTE: una riga per plesso
  candidatura_id  uuid not null references candidature_insegnanti(id) on delete cascade
  scuola_id       uuid not null references schools(id)      -- ⚠️ FK OBBLIGATORIA
  stato           text not null default 'pending'
                  check (stato in ('pending','approvata','rifiutata'))
  evasa_il        timestamptz
  evasa_da        uuid references utenti(id)
  motivo_rifiuto  text
  creata_il       timestamptz not null default now()
  primary key (candidatura_id, scuola_id)
```

**`scuola_id` nelle righe di sede DEVE dichiarare la sua FK verso `schools(id)` nella stessa
migrazione.** Il lock `fk-scuola-id.test.ts` guarda le migrazioni più recenti della
fotografia e cade su una colonna `scuola_id` nuova senza riferimento — ed è un lock che
esiste perché trentuno tabelle su sessantacinque se n'erano dimenticate, producendo
righe che nessun filtro di sede vede più.

**`candidature_insegnanti.scuola_id` resta e non diventa nullable.** È la sede di primo
arrivo, tiene la fotografia FK invariata, e dà un valore certo a ogni codice che oggi la
legge senza sapere che esistano le righe di sede.

### Il trigger: `stato` della candidatura come aggregato delle sue sedi

`candidature_insegnanti.stato` smette di essere scritto a mano e diventa la sintesi
delle sedi scelte, mantenuta da un trigger
`after insert or update or delete on candidature_sedi`:

| Righe di sede | Candidatura |
|---|---|
| almeno una `pending` | `pending` |
| nessuna `pending`, almeno una `approvata` | `approvata` |
| tutte `rifiutata` | `rifiutata` |

**Non è zucchero.** È ciò che tiene in piedi, senza toccarlo, l'indice
`candidature_insegnanti_email_viva`. Se Giugliano rifiuta e Aversa sta ancora valutando,
la persona **è ancora in gioco**: la candidatura resta `pending`, l'indice continua a dire
«ne ha già una viva», e il modulo pubblico continua a rispondere `201` con esito
`duplicata` nei log senza diventare un oracolo di enumerazione.

E il cron di conservazione GDPR (`gdpr/retention-candidature`) continua a leggere la
colonna che ha sempre letto, con la semantica che ha sempre avuto. Nessuna riga di quel
job cambia.

`in_approvazione` **non** compare fra gli stati delle righe di sede: il claim in due tempi è
morto il 2026-08-15, quando approvare ha smesso di creare account e di spedire
password. Resta solo nel `check` di `candidature_insegnanti` perché lo storico lo contiene.

### La porta pubblica

`POST /api/iscrizione/insegnanti`:

- il corpo passa da `scuola_id: z.string().uuid()` a
  **`scuole_ids: z.array(z.string().uuid()).min(1).max(3)`**, deduplicato;
- **ogni** id va verificato contro `sediReali()`, non solo il primo: la validazione di
  oggi accetta una sede sola e la controlla, e un elenco che ne controlla una su tre è
  peggio di uno che non ne controlla nessuna, perché sembra difeso;
- si scrive `candidature_insegnanti` (con `scuola_id` = il primo dell'elenco) e poi una
  riga di sede per ciascun plesso scelto.

**Degrado sul DB E2E della CI, che non è migrato.** Se `candidature_sedi` non esiste
(`42P01` / `PGRST205`), la candidatura si registra **comunque** in
`candidature_insegnanti` con la prima sede e si logga un `warn` con esito `sedi-multiple-non-registrate`. Il `201` resta
un `201`: chi si candida non deve pagare una migrazione mancante. È lo stesso schema di
resilienza che il cockpit applica già con `TABELLA_ASSENTE`.

### Il cockpit

- **elenco e dettaglio** filtrano per sede **attraverso le righe di sede**
  (`candidature_sedi.scuola_id in (scuole attive)`), non più su `candidature_insegnanti`.
  ⚠️ Da qui in avanti `candidature_insegnanti.scuola_id` **non autorizza più niente**:
  è un dato storico («da dove è arrivata per prima»), non un criterio d'accesso. Due
  criteri di sede per la stessa risorsa sono due risposte diverse alla stessa domanda,
  e quella sbagliata la si scopre solo quando qualcuno vede ciò che non deve;
- **una candidatura compare UNA volta** nell'elenco, non una per sede: chi guarda cerca
  una persona, non una pratica. La riga porta lo stato **della propria sede**; le altre
  sedi si leggono aprendo la scheda;
- **`PATCH approva|rifiuta`** agisce sulla coppia `(candidatura, sede dell'operatore)`.
  Se chi opera ha più sedi e non ne indica una, la risposta è **400** — lo stesso
  contratto di `resolveScuolaScrittura`, che esiste perché una rotta che «indovina» la
  sede archivia i dati nel plesso sbagliato in silenzio;
- **il gate anti-IDOR sul curriculum** (`assertCurriculumInScope`) passa dalle righe di
  sede. Se restasse su `candidature_insegnanti`, una segreteria di Aversa non vedrebbe il curriculum di una
  candidatura che ha scelto anche Aversa ma è arrivata prima a Giugliano — e, cosa più
  grave, il senso del controllo diverrebbe «di chi era la prima sede» invece di «chi ha
  titolo»;
- la scheda mostra **le sedi scelte e lo stato di ciascuna**: chi valuta deve sapere che
  la stessa persona è in valutazione anche altrove. Nasconderlo non protegge nessuno e
  produce due colloqui che non si parlano;
- **l'email di esito nomina già la sede** (`La Segreteria di ${sede.nome}`). Con il
  rifiuto per sede quella frase diventa vera senza riscriverla: si passa lo `scuola_id`
  della sede che ha rifiutato, non quello di primo arrivo.

### Il lock d'isolamento

`isolamento-sede-coverage.test.ts` va aggiornato: ogni query nuova su
`candidature_sedi` porta il suo `.in('scuola_id', scuole)` e viene **dichiarata** nel
lock, con la soglia alzata di conseguenza. Nessuna finisce fra le esenzioni: le uniche
esenzioni legittime di questa funzionalità sono quelle che già esistono per il cron di
conservazione, che deve valere su tutte le sedi insieme.

### Il modulo

I radio della sede diventano checkbox; il passo si chiama «Sedi» e la sua validazione
è «almeno una».

**`?sede=<uuid>` non cambia di una virgola** (decisione del titolare, 19/08/2026).
Quando c'è, decide la sede e **salta** il passo, esattamente come oggi: l'invio parte con
quell'unica sede. `mostraSede` resta `sedeDaLink === null && (…)`.

Il motivo è che il link da diffondere è **uno solo, uguale per tutte e tre le sedi** — è
scritto nella testata di `src/app/lavora-con-noi/page.tsx` ed è la forma in cui il modulo
gira davvero. La scelta multipla vive **dentro quel link**, che è il caso normale.
`?sede=` resta quello che è sempre stato: lo strumento di chi vuole indirizzare una
candidatura a un plesso preciso, e che indirizzandola dichiara di volerne uno solo.

Conseguenza sul modulo, da tenere presente in fase di collaudo: con `?sede=` il corpo
inviato è `scuole_ids: [<uuid>]`, un elenco di uno. La porta pubblica non ha un ramo
speciale per questo caso — un elenco di uno è un elenco.

`use-sedi-pubbliche` è condiviso con `AnagraficaPersonaleWizard`. Si aggiunge una
modalità multipla **senza toccare** il comportamento a sede singola: quell'altro modulo
deve uscire da questo lavoro identico a com'è entrato.

---

## 3 · La copia completa alla sede

### Il pezzo che manca

`sendEmailDetailed` sa mandare `text` e `html`. **Non sa allegare.** Va esteso con:

- **`attachments?: { filename: string; content: string /* base64 */; contentType?: string }[]`**
  → Resend li accetta in `attachments`;
- **`replyTo?: string`** → la sede risponde direttamente a chi si è candidato, invece di
  ricopiarne l'indirizzo a mano dal corpo del messaggio.

Entrambi additivi: nessun chiamante esistente li passa, nessun comportamento cambia.

### Il corpo si GENERA dal template, non si scrive a mano

`src/lib/email/messaggi/candidatura-alla-sede.ts` costruisce la copia **iterando
`INSEGNANTE_FIELDS` e `CONSENSI_INSEGNANTI_FIELDS`**: le etichette e i valori leggibili
(«Laurea magistrale», non `laurea_magistrale`) sono già dichiarati lì, insieme alle
condizioni di visibilità.

Un elenco di campi ribattuto a mano nel generatore diverge al primo campo aggiunto al
modulo, **e diverge in silenzio**: la sede riceverebbe una copia «completa» a cui manca
esattamente il campo nuovo, e nessun test sarebbe rosso. È lo stesso difetto di famiglia
del riepilogo del wizard, che fino al 2026-08-11 mostrava due fatti su tredici.

Contenuto: tutti i campi compilati, i consensi con il loro esito, l'istante d'invio, le
sedi scelte, e l'indicazione di quale sede sta ricevendo questa copia.

### Il curriculum in allegato

Si scarica dal bucket (`supabase.storage.from('form_attachments').download(cv_path)`) e
si allega in base64. Il tetto reale del file è ~4 MB — il limite del corpo di una
funzione Vercel, non del bucket — contro i 40 MB di Resend: c'è margine, e in base64
4 MB diventano ~5,3.

Il nome dell'allegato si **ricostruisce** (`curriculum-<cognome>-<nome>.<est>`), non si
riusa il percorso nel bucket: `cv_path` è un identificativo tecnico ed è la chiave di un
gate, e non ha motivo di comparire in una casella di posta.

### Il destinatario

Da **`scuole.config.anagrafica.email`** — lo stesso campo che firma già il piè di pagina
di tutte le email della sede, popolato da Impostazioni → Anagrafica sede. Le tre caselle
esistono: `giugliano@`, `aversa@`, `cesa@kidville.it`.

Se per una sede è vuoto:

1. **log a livello `error`** — configurazione mancante è un incidente, non una nota a
   piè di pagina (AGENTS, logging §4);
2. ripiego su **`CANDIDATURE_EMAIL_FALLBACK`** (solo il nome: il valore si imposta su
   Vercel, mai nel repo, che è pubblico), da documentare nel lock
   `env-critiche-documentate`. Una candidatura non deve sparire per un campo che nessuno
   ha compilato;
3. se manca anche quella: `warn`, e nessuna email. La candidatura resta nel pannello.

### Come si comporta quando fallisce

Best-effort, esattamente come la conferma alla candidata: la candidatura **è già
registrata**, e un'email che non parte non trasforma un `201` in un `500`.

Ma non tace. Ogni sede scelta lascia la sua riga — `copia-sede-inviata` /
`copia-sede-non-inviata`, con `scuola_id` ed `entita_id` — perché «nessun log» non
distingua «tutte partite» da «non è mai partito niente». È l'ambiguità che ha tenuto
nascosto per mesi il guasto delle email delle credenziali, ed è il motivo per cui in
questo repo anche il successo si logga.

**Non parte nel ramo del duplicato**, per la stessa ragione per cui non parte la
conferma: una candidatura respinta perché ce n'è già una aperta non è una candidatura
nuova, e mandarne copia alla sede le farebbe aprire una pratica che non esiste.

### Le due cose che questo cambia, e che vanno dette

**Volume.** Oggi un invio produce **1** email. Dopo ne produce **1 + n sedi**, fino a 4.
Il tetto Resend è ~100 al giorno ed è già conteso con l'automazione delle iscrizioni.
Le candidature sono poche unità a settimana, quindi oggi non è un problema — ma il conto
non è più uno, e il `429` va trattato come «non oggi», non come «non si può».

**Conservazione.** `/privacy` promette che *«il curriculum allegato viene cancellato
insieme alla candidatura»* a 12 o 24 mesi. Una copia depositata in
`giugliano@kidville.it` **non la cancella nessun cron**. La finalità e il titolare non
cambiano — le tre sedi sono la stessa cooperativa, e la persona ha scelto lei a quali
scrivere — ma il **termine promesso** non è più vero per quella copia.

La voce nella privacy va quindi aggiornata perché dica il vero. **Confermato dal
titolare il 19/08/2026: si fa in questo lavoro**, non in un seguito. un'informativa che descrive una cancellazione che non avviene è
peggio di un'informativa che non la promette. È la stessa lezione, in piccolo, del
blocco di `CLAUDE.md` che per due settimane ha sostenuto «pre-lancio, nessun dato reale».

---

## Cosa NON si tocca

`AnagraficaPersonaleWizard` e il suo uso a sede singola · il cron
`gdpr/retention-candidature` e la sua logica · l'indice unico su `cv_path` e quello su
`lower(email)` · il flusso di creazione dell'accesso, che dal 2026-08-15 vive solo in
`admin/pratiche-personale:PATCH` · `public/logo_green.png`.

## Definizione di «fatto»

- `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` · `npm run build` verdi
- lock aggiornati **dichiarando**: `isolamento-sede-coverage`, `fk-scuola-id`,
  `env-critiche-documentate`, `logging-coverage`, `zod-coverage`
- logging su ogni ramo nuovo, successo compreso; nessun dato personale nei log
- migrazione applicata con `apply_migration` + `get_advisors` a **0 ERROR**
- **PRD aggiornato** (`PRD REGISTRO ELETTRONICO.md`) e voce `/privacy` corretta
- altezza della testata a 360 px **misurata**, non dedotta
