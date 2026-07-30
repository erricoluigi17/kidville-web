# Prompt — Isolamento fra sedi su TUTTE le funzioni

> Da usare così: `/ship-cycle` + il testo che segue (dal titolo «OBIETTIVO» in giù).
> Scritto il 2026-07-30, dopo che un collaudo ha trovato sette route che perdevano dati di
> minori fra plessi. Non è un'ipotesi: è la constatazione che il problema è **sistemico**.

---

## OBIETTIVO

Trova e correggi **ogni** difetto di isolamento fra sedi in tutta l'applicazione, funzione per
funzione, e chiudi la questione del consenso GDPR sul modulo pubblico d'iscrizione.

Non è un lavoro di correzione puntuale: è un **audit sistematico**. Le falle già trovate erano
tutte della stessa famiglia, e sono state trovate solo cercandole di proposito — il gate formale
era verde con 3424 test.

---

## 1. Il modello di autorizzazione da imporre (deciso dal titolare)

È **gerarchico**, e ogni funzione deve rispettarlo:

| Livello | Cosa vede e su cosa scrive |
|---|---|
| **La classe appartiene alla sede** | una sezione non esiste "in astratto": esiste **dentro** un plesso. Il suo nome **non è** un identificatore globale |
| **Admin / Direzione** | **tutte** le sedi |
| **Segreteria** | **solo la propria sede di riferimento** |
| **Coordinatore** | il proprio plesso (verificane la semantica attuale nel codice e chiedi se va allineata alla segreteria) |
| **Docente / educator** | il proprio plesso, e — dove ha senso — **solo le sezioni assegnate** (`utenti_sezioni`) |
| **Genitore** | **solo i propri figli**, indipendentemente dalla sede |

Il perno tecnico: **il nome della classe non identifica una classe.** Con un plesso solo era di
fatto una chiave univoca; con tre plessi «2 ANNI» esiste sia ad Aversa sia a Cesa, «5 ANNI» pure.
Ogni query che filtra per `classe_sezione` senza vincolo di `scuola_id` è una falla, oggi o domani.

---

## 2. Come devi lavorare: **una domanda per ogni funzione**

Questa è la parte non negoziabile del metodo.

Per **ogni funzione/area** che tocchi — non per l'intero lavoro — fermati e **chiedi al titolare
come vuole che si comporti**, prima di scrivere il codice. Usa `AskUserQuestion`, una chiamata per
funzione, con opzioni concrete e la tua raccomandazione per prima.

Ogni domanda deve contenere:

1. **Cosa fa oggi la funzione** e chi può chiamarla (ruolo e scope, con `file:riga`).
2. **Cosa perde o consente adesso** in concreto: *quali campi, di quali persone, verso chi*. Se
   sono dati di minori dillo. Se è un codice fiscale, un dato sanitario o un numero di documento,
   dillo esplicitamente.
3. **Le opzioni**, con il loro costo operativo reale. Tipicamente:
   - *stretto*: solo la propria sede, e per il docente solo le sezioni assegnate;
   - *intermedio*: la propria sede, tutte le classi del plesso;
   - *ampio*: tutte le sedi (da riservare ad admin/Direzione);
   - *migrazione necessaria*: la tabella non ha `scuola_id` e serve uno schema nuovo.
4. **Chi resta fuori** se si stringe: conta le persone vere in produzione prima di chiedere
   (es. «9 educator su 10 hanno sezioni assegnate; l'unico senza è un account TEST»). Una
   restrizione che chiude fuori personale reale va detta **prima**, non scoperta dopo.

Non accorpare più funzioni in una domanda per fare prima. Se una funzione è identica a una già
decisa, dillo e applica la stessa scelta senza richiedere — ma **dichiaralo**.

---

## 3. Il perimetro: dove cercare

Non fermarti alle route già segnalate. Cerca **tutti** gli schemi, e per ognuno riporta un
verdetto esplicito: *già protetta* · *da proteggere* · *non applicabile (col perché)*.

Schemi da cercare, come minimo:

```bash
grep -rn "eq('classe_sezione'" src/                 # il filtro per nome-classe
grep -rn "from('alunni')" src/app/api                # ogni lettura di anagrafica minori
grep -rn "from('parents')\|from('utenti')" src/app/api
grep -rn "createAdminClient" src/app/api             # RLS bypassata → il gate è l'unico presidio
grep -rn "requireStaff\|requireDocente" src/app/api  # ruolo verificato: e lo SCOPE?
grep -rn "getRequestUserId\|x-user-id\|userId=" src/  # identità dall'header/query
```

Poi verifica una per una le tabelle che **non hanno** `scuola_id` e che quindi non sono isolabili
senza migrazione: `locker_config` è un caso noto; `chat_threads` è un altro. Per ognuna, decidi
con il titolare se serve la migrazione o se il dato non è sensibile.

### Punti già noti e ancora aperti (verificali, non fidarti dell'elenco)

- **`GET /api/admin/chat/contacts`** — solo `requireStaff`, **nessuno scope di sede**: nomi di
  minori e genitori di tutte le sedi.
- **Certificati medici** — il download di un dato sanitario (art. 9 GDPR) autorizzato dal solo
  ruolo, senza verifica di appartenenza.
- **Rubrica completa dei minori** del deployment accessibile a qualunque membro dello staff.
- **`POST /api/parent/primaria/note/firma`** — identità presa da `?userId=`/header: va verificato
  contro `ALLOW_HEADER_IDENTITY`, che è già un punto aperto del progetto.
- **`POST /api/admin/pre-inscriptions`** — gira **senza autenticazione** e senza rate-limit. È il
  flusso legacy morto: valuta con il titolare se **rimuoverlo** invece di proteggerlo.
- **`pagamenti/genera`** — c'è un `.then(() => {}, () => {})` sull'audit: catch muto, viola le
  regole di logging del progetto.

### Cosa è GIÀ stato corretto il 2026-07-29 (non rifarlo, ma verifica che tenga)

`admin/documents-merge`, `teacher/modulistica` (GET e POST), `attendance/daily`,
`attendance/delegates`, `chat/contacts`, `register/lessons` (GET), `pagamenti/genera` (POST), e la
dedup dell'alunno per codice fiscale in `admin/iscrizioni`. L'helper `assertClasseNomeInScope`
(`src/lib/auth/scope.ts`) è stato esteso con `opts.soloSezioniAssegnate`.

---

## 4. Come si corregge (e come NON si corregge)

- **Gate e filtro insieme, sempre.** Il gate (`assertClasseNomeInScope`, `assertAlunnoInScope`,
  `assertSezioneInScope`) impedisce di *nominare* una risorsa altrui; il filtro sulla query
  (`.in('scuola_id', await resolveScuoleAttive(...))`) impedisce che l'**omonimia** porti dentro i
  record dell'altra sede. Uno solo dei due non basta, e va dimostrato con due prove di validità
  separate: rimuovi il gate → rosso; rimuovi il filtro → rosso.
- **Riusa gli helper esistenti** in `src/lib/auth/scope.ts` (`scuoleDiUtente`,
  `resolveScuoleAttive`, `resolveScuolaScrittura`, `assertClasseNomeInScope`,
  `assertAlunnoInScope`, `assertSezioneInScope`, `vedeTutteLeClassi`). Non scriverne di nuovi
  senza averli letti.
- **Mai un fallback che togliela il filtro.** Se la lettura di scope fallisce, si nega — non si
  apre. Un degrado che riapre la falla è peggio del difetto.
- **I mock devono applicare davvero i filtri.** Esiste `__tests__/fixtures/finto-supabase.ts` che
  onora `.eq`/`.in` anche su risorse embedded: usalo. Con un mock piatto un test d'isolamento è
  verde **anche senza** il filtro, e non prova niente.
- **Non stringere dove romperebbe l'operatività** senza aver chiesto: supplenze e compresenze
  possono legittimamente far lavorare un docente su una classe non assegnata.

---

## 5. Il consenso GDPR sul modulo pubblico — l'ultimo passo, con un cancello

Il modulo pubblico `/iscrizione` raccoglie **allergie, note mediche (BES, DSA, patologie) e il
documento d'identità del minore** senza mostrare alcuna informativa (art. 13 GDPR) e senza
raccogliere né registrare alcun consenso (artt. 7 e 9.2.a). Sono dati sanitari di minori, su un
modulo pubblico e anonimo, ora esteso a tre sedi e in attesa di famiglie vere.

**Alla fine del lavoro** — non prima, non in mezzo — devi:

1. Presentare al titolare **cosa serve**: l'informativa al punto di raccolta, il consenso
   esplicito e separato per i dati dell'art. 9, e la registrazione della prova (esiste già
   `consensi_accettazioni`, append-only, con la `versione` decisa server-side: **riusala**, non
   inventare un meccanismo nuovo).
2. **Chiedere esplicitamente: «L'avvocato ha validato i testi?»** con `AskUserQuestion`.
   - Se **sì** → chiedi i testi (o il percorso del file che li contiene), inseriscili
     **verbatim**, senza riscriverli né riassumerli, e versionali.
   - Se **no** → **non inserire nessun testo tuo al loro posto**, nemmeno provvisorio. Prepara
     tutto il resto (il passo nel wizard, la registrazione del consenso, la migrazione se serve,
     i test) con i testi come **segnaposto dichiarato**, e fermati lì dicendolo chiaramente.

Un'informativa scritta da te su dati sanitari di minori non è una bozza utile: è un documento
legale sbagliato che qualcuno potrebbe pubblicare per errore.

---

## 6. Vincoli d'ambiente e regole di progetto

- **`.env.local` punta a PRODUZIONE.** `npm run e2e` e `e2e:seed` in locale sono **vietati**;
  l'E2E gira solo in CI. **Non leggere e non copiare `.env.local`** in nessun modo.
- **Il DB E2E della CI è separato e non migrato**: degrada su `PGRST204`, `42703`, `42P01`
  loggando `info` — ma **senza** riaprire la falla (vedi §4).
- **Nel browser, disiscrivi il service worker e svuota le cache prima di ogni misura.** Il 29/07
  ha servito codice vecchio facendo sembrare inefficace una correzione che funzionava, e ha fatto
  perdere un'ora.
- Regole del repo: niente `console.*` in `src/`; ogni route in `withRoute` col nome uguale al
  path; validazione `zod`; PostgREST **non lancia** (si controlla `{error}`); nessun catch muto;
  log del **successo** sugli eventi critici; **mai PII nei log** (`@/lib/logging/redact` è a lista
  bianca — uuid, conteggi, indici, codici: mai nomi, email, CF, dati sanitari).
- **Il repository è pubblico**: niente segreti, niente PII reale in codice, test, PRD o messaggi
  di commit. I nomi di alcune sezioni contengono il nome di battesimo della docente: non
  finiscono in file committati.
- **PRD** (`PRD REGISTRO ELETTRONICO.md`) aggiornato nello stesso lavoro, con i numeri misurati.
- Gate: `npx eslint . --max-warnings 0` · `npx tsc --noEmit` · `npx vitest run` · `npm run build`
  · advisors Supabase **0 ERROR**.

## 7. Stato della produzione da cui parti

Tre sedi reali: Giugliano `d53b0fbc-a9eb-4073-b302-73d1d5abd529`, Aversa
`429da920-2c1f-47a8-82ed-a26f63ee0591`, Cesa `04accbfd-5890-4416-99f7-acd8b864dc2f`. Più la sede
finta `e2e00000-…` della CI, da **escludere** da ogni elenco pubblico. 33 sezioni, con nomi
**ripetuti fra sedi**. Aversa e Cesa **non hanno personale**: nessun docente, nessuna segreteria.

In produzione ci sono dati di collaudo da non toccare senza chiedere: alunno «Collaudo
ProvaAversa» (CF `CLLPRV22E50H501W`) in Aversa/«3 ANNI» e il genitore «Ines ProvaAversa».

## 8. Cosa consegnare

1. **La tabella dell'audit**: ogni occorrenza trovata, con verdetto e — per quelle corrette — la
   scelta del titolare che l'ha guidata.
2. Le correzioni, ognuna con test e **prova di validità** (rimetti il difetto, il test torna
   rosso: se non torna rosso, il test non prova niente).
3. Le migrazioni dove servono, applicate con l'MCP `apply_migration` + `get_advisors` a 0 ERROR.
4. Il PRD aggiornato.
5. Un elenco esplicito di **cosa hai lasciato aperto e perché** — comprese le decisioni che
   spettano al titolare o all'avvocato.

Se durante il lavoro trovi un difetto **fuori** dal perimetro dell'isolamento fra sedi, non
correggerlo di nascosto: segnalalo, e chiedi se va fatto adesso o in un ciclo dedicato.
