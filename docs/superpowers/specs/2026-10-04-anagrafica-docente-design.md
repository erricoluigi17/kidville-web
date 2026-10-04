# Anagrafica alunni in sola lettura per le insegnanti — design

**Data:** 2026-10-04 · **Branch:** `feat/anagrafica-docente` · **Stato:** design approvato dal titolare

## Obiettivo

Le insegnanti devono poter **consultare**, senza poterla modificare, l'anagrafica dei **propri**
alunni: dati anagrafici, residenza, salute, consensi, famiglia e delegati. Oggi non esiste una
scheda per il docente: riceve a pezzi, sparsi in route diverse, solo nome, allergie, note mediche,
email dei genitori e delegati (`/api/diary/students`, `/api/primaria/classe/[sectionId]`,
`/api/attendance/delegates`, `/api/documenti-firmati`).

## Decisioni del titolare

| Tema | Decisione |
|---|---|
| Campi | **Scheda completa senza economia**: esclusi retta, fatturazione, intestatari e documenti d'identità |
| Chi è «mio alunno» alla primaria | **Tutti i docenti della classe**: assegnazione diretta (`utenti_sezioni`) **e** per materia (`utenti_sezioni_materie`), la stessa regola di `fascicolo-rbac` |
| Accesso | Nuova voce **«Alunni»** nel menu docente → elenco → scheda |
| Filtri | Ricerca per nome **e** ricerca avanzata: sezione e grado, salute, consensi foto, età e sesso |
| Approccio | **A — API dedicata in sola lettura** con componenti nuovi (scartati: riuso di `StudentDetailPanel` in modalità `readOnly`; vista SQL + RLS) |

## Perché un controllo nuovo e non `assertAlunnoInScope`

`assertAlunnoInScope` (`src/lib/auth/scope.ts`) per un educator conta **solo** `utenti_sezioni`:
il docente di sola materia della primaria ne resterebbe fuori. `puoAccedereFascicolo` e
`sezioniContitolari` (`src/lib/primaria/fascicolo-rbac.ts`) contano entrambe le tabelle, ma **non
controllano l'`error` di PostgREST**: un guasto esce come «nessuna sezione», cioè come un permesso
negato o un elenco vuoto, senza traccia. Per un dato di minori «non sono riuscito a leggere» e «non
è tuo» non possono avere la stessa risposta.

Serve quindi **una funzione sola** che decida le sezioni visibili per l'anagrafica, usata **sia**
dall'elenco **sia** dalla scheda, così i due non possono andare in disaccordo, e che distingua
l'errore di lettura (→ 500) dall'assenza di assegnazioni (→ elenco vuoto / 403).

## Architettura

### Server

**`src/lib/anagrafiche/docente/`** (nuovo modulo):

- **`visibilita.ts`** — `sezioniAnagraficaVisibili(supabase, user)` →
  `{ esito: 'tutte' } | { esito: 'sezioni', sezioni: string[] } | { esito: 'errore', errore }`.
  - `admin` / `coordinator` / `segreteria` (`vedeTutteLeClassi`) → `tutte` (il limite resta la sede).
  - `educator` → unione di `utenti_sezioni` e `utenti_sezioni_materie`; nessuna assegnazione →
    `sezioni: []` (nega per difetto).
  - Una delle due letture fallisce → `errore`, con log `error` e il codice PostgREST.
  - Le tabelle lette devono restare le stesse di `puoAccedereFascicolo`/`sezioniContitolari`. Il
    commento di `fascicolo-rbac.ts` cita un lock `__tests__/lib/documenti-registro-rbac.test.ts`
    che **non esiste**: nessun test tiene d'accordo le due funzioni gemelle. Si scrive un lock
    nuovo che verifica che **tutte e tre** leggano le stesse tabelle di assegnazione, e si corregge
    il commento perché punti al file vero.
- **`proiezione.ts`** — funzioni **pure** che costruiscono le risposte copiando **solo** i campi
  ammessi (lista bianca). Anche se la `select` venisse allargata per errore, nella risposta non
  entra niente che non sia elencato qui.
  - `proiettaVoceElenco(riga)` → `VoceElencoAlunno`
  - `proiettaScheda(riga, genitori, delegati, sezione)` → `SchedaAlunnoDocente`
- **`colonne.ts`** — le `select` scritte colonna per colonna. **Mai `select('*')`.**

**Route** (gruppo `/api/teacher/`, già presente; entrambe in `withRoute`, `requireDocente`, `zod`,
`createAdminClient`, `Cache-Control: no-store`; **unico metodo esportato: `GET`**):

#### `GET /api/teacher/alunni` — l'elenco

1. `requireDocente` → `resolveScuoleAttive` (sedi) → `sezioniAnagraficaVisibili`.
2. Errore → 500. `sezioni: []` → `{ sezioni: [], alunni: [] }` senza interrogare `alunni`.
3. Query su `alunni` con, nella **stessa** query: filtro di sede (`.in('scuola_id', plessi)`),
   `.eq('stato', STATO_ISCRITTO)` incondizionato (lock `elenchi-operativi-solo-iscritti`), esclusi
   archiviati e anonimizzati, e per l'educator `.in('section_id', sezioni)`.
4. Le sezioni (`id`, `name`, `school_type`) per i raggruppamenti, lette per id.

Ogni voce dell'elenco (`VoceElencoAlunno`):

| Campo | Origine |
|---|---|
| `id`, `nome`, `cognome`, `sectionId` | `alunni` |
| `dataNascita`, `annoNascita` | `data_nascita` |
| `sesso` | `gender` |
| `allergeni: AllergeneKey[]` | `allergeniAlunno(...)` del motore unico `src/lib/mensa/allergeni.ts` (legge anche il testo libero) |
| `haAllergie` | `haAllergiaOperativa(...)` dello stesso motore |
| `besDsa`, `usaPannolino` | booleani |
| `consensoFotoSito`, `consensoFotoSocial` | booleani |

**Mai nell'elenco:** il testo di `allergies`, `note_mediche`, codice fiscale, residenza, genitori.

#### `GET /api/teacher/alunni/[id]` — la scheda

Ordine **vincolante**, nessun dato anagrafico letto prima che tutti i controlli siano passati:

| Passo | Esito |
|---|---|
| Non autenticato | 401 (da `requireDocente`) |
| Ruolo non ammesso (es. genitore) | 403 (da `requireDocente`) |
| `id` non uuid | 400 (`zod`), senza toccare il database |
| Lettura minima `id, section_id, scuola_id, stato, archiviato_il, anonimizzato_il` | errore → 500 |
| Inesistente, non `iscritto`, archiviato o anonimizzato | 404 |
| Sede fuori da `scuoleDiUtente` | 403 |
| `sezioniAnagraficaVisibili` in errore | 500 |
| Educator e `section_id` non fra le sue sezioni | 403 + log `warn` (solo uuid di utente e alunno) |
| Lettura anagrafica + genitori + delegati + sezione | errore → 500 |
| Audit in `fascicolo_accessi_audit` | `logAccessoFascicolo(..., { azione: 'view', finalita: 'anagrafica-docente' })` |
| Risposta | 200 con `SchedaAlunnoDocente` |

**Audit.** Si scrive **dopo** i controlli e dopo una lettura riuscita, mai sopra un 403 (stesso
criterio di `api/parent/prestampati`). Se l'audit fallisce la scheda si restituisce comunque e il
guasto va in log `error` (comportamento di `logAccessoFascicolo`): negare a un'insegnante le allergie
di un bambino perché il registro ha avuto un guasto sarebbe peggio del registro mancante. L'elenco
**non** scrive righe di audit.

**`SchedaAlunnoDocente`:**

| Blocco | Campi |
|---|---|
| Identità | `id`, `nome`, `cognome`, `sesso`, `dataNascita`, `luogoNascita` (`birth_city`, `birth_province`, `birth_nation`), `cittadinanza`, `codiceFiscale` |
| Residenza | `indirizzo`, `civico`, `cap`, `comune`, `provincia` |
| Classe | `sezione` (`id`, `nome`, `grado`), `dataIscrizione` |
| Salute | `allergeni: AllergeneKey[]`, `allergieTesto` (`allergies`), `noteMediche`, `besDsa`, `usaPannolino` |
| Consensi | `consensoPrivacy`, `consensoFotoSito`, `consensoFotoSocial` |
| Genitori (`student_parents` → `parents`) | per ciascuno: `nome`, `cognome`, `parentela` (`relation_type`), `principale` (`is_primary`), `telefoni` (`phone_numbers`), `email` (`emails`), `codiceFiscale` (`fiscal_code`); esclusi i genitori anonimizzati |
| Delegati (`delegates`) | per ciascuno: `nome`, `cognome`, `parentela` |

**Mai nella scheda:** `importo_retta_mensile`, `retta_split_config`, `retta_a_carico_di`,
`genitori_separati`, `intestatario_fatture`, `invoice_holder_*`, `fiscale_config`,
`opposizione_ade`, `bollo_virtuale`, `giorno_scadenza_pagamenti`, `sospeso*`, `documento_path`,
`numero_domanda_sidi`, `archiviato_*`; dei genitori `documento_path`, `document_type`,
`document_number`, nascita, residenza, `consensi_gdpr`, `auth_user_id`; dei delegati
`document_number`, `document_url`.

**Database:** nessuna migrazione, nessun cambio di RLS.

### Client

**Menu** — voce `alunni` nel gruppo «In classe» di `TeacherBottomNav` (`grado: 'comune'`,
`href: '/teacher/alunni'`), etichetta «Alunni», sottotitolo «Anagrafica dei tuoi bambini»
(namespace `teacherNav`, `messages/it` e `messages/en`).

**Pagine** — gusci client che chiamano le API: **nessun dato del bambino nell'HTML**, che il
service worker salva per l'offline (`public/sw.js` non mette mai in cache `/api/`). La scheda **non**
passa dalla read-cache Dexie: un codice fiscale non deve finire su disco.

- `src/app/(dashboard)/teacher/alunni/page.tsx` → `ElencoAlunniDocente`
- `src/app/(dashboard)/teacher/alunni/[id]/page.tsx` → `SchedaAlunnoLettura`

**Componenti** — `src/components/features/teacher/anagrafica/`, piccoli e di sola visualizzazione:

| Componente | Compito |
|---|---|
| `ElencoAlunniDocente` | carica l'elenco, tiene lo stato dei filtri, raggruppa per sezione |
| `BarraFiltriAlunni` | ricerca per nome + pulsante «Filtri» col numero dei filtri attivi + etichette rimovibili + «Azzera filtri» + contatore «12 di 28 bambini» |
| `PannelloFiltriAlunni` | il pannello dei filtri (dal basso su telefono, sotto la barra su schermi larghi) |
| `SchedaAlunnoLettura` | carica la scheda e la impagina |
| `RiquadroScheda` | un blocco con titolo |
| `CampoLettura` | riga «etichetta: valore», «Non indicato» se vuoto |
| `SchedaGenitore` | un genitore con `tel:` e `mailto:` toccabili |

**Filtri** — `src/lib/anagrafiche/docente/filtri.ts`, funzione **pura**
`filtraAlunni(alunni, filtri)`:

| Gruppo | Filtri |
|---|---|
| Nome | testo libero su nome e cognome, con `testoCorrisponde` di `src/lib/ui/testo-ricerca.ts` (normalizza accenti e maiuscole; **non** `rangoDiMatch`, che pretende testo già normalizzato) |
| Sezione e grado | sezioni (scelta multipla fra quelle visibili), gradi (fra quelli presenti) |
| Salute | solo con allergie · allergeni precisi (dal catalogo `ALLERGENI`) · BES/DSA · usa il pannolino |
| Consensi foto | senza consenso per il sito · senza consenso per i social |
| Età e sesso | anno di nascita (fra quelli presenti) · sesso |

- Fra gruppi diversi valgono **tutti** (AND); dentro lo stesso filtro a scelta multipla basta
  **uno** (OR). Nessun filtro = tutti.
- Anno di nascita e non fascia d'età: non dipende dalla data di oggi.
- I filtri si salvano in `sessionStorage` per ritrovarli tornando dalla scheda — ogni accesso in
  `try/catch`, la pagina funziona anche senza — e **mai nell'URL**: un nome di bambino
  nell'indirizzo finirebbe nei log di accesso.

**Scheda** — in cima nome, cognome, sezione ed etichetta «Sola lettura»; se ci sono allergie, un
riquadro in evidenza con gli allergeni. Poi i riquadri Dati anagrafici, Residenza, Salute (note
mediche con gli a capo conservati), Consensi, Famiglia, Delegati al ritiro. In fondo: «Un dato è
sbagliato? Rivolgiti alla segreteria». **Nessun `input`, `textarea`, `select` o pulsante di
salvataggio.**

**Stati** — caricamento; errore con «Riprova»; docente senza classi («Non ti è stata assegnata
nessuna classe: rivolgiti alla segreteria»); nessun bambino corrisponde ai filtri. Scheda: 403 →
«Questo bambino non è in una delle tue classi»; 404 → «Scheda non trovata»; rete o 500 →
messaggio con «Riprova»; senza connessione → «Serve la connessione».

**Contorno obbligatorio** — testi in `messages/it` e `messages/en` (lock di parità e chiavi
orfane); etichetta della rotta nel dizionario di `/offline` (lock `offline-etichette-rotte`);
margini nativi (lock `fascia-safe-area-nativa`).

## Log

- `withRoute` su entrambe le route.
- 403 «fuori sezione» → `logEvento(..., 'warn', { utente_id, alunno_id, esito: 'fuori-sezione' })`.
- Errori di lettura → `error`, con l'errore PostgREST intero come quarto argomento.
- Solo uuid, conteggi e codici: mai nomi, codici fiscali o testi sanitari.

## Test (TDD)

**Funzioni pure**
- Proiezione: una riga piena di campi economici, documenti e `archiviato_*` non ne lascia passare
  nessuno; le chiavi in uscita sono fissate esatte.
- `filtraAlunni`: ogni filtro da solo, AND fra gruppi, OR dentro il gruppo, nessun filtro = tutti,
  accenti e maiuscole nella ricerca.
- `sezioniAnagraficaVisibili`: staff → `tutte`; unione delle due tabelle senza doppioni; nessuna
  assegnazione → `[]`; errore su una delle due letture → `errore`.

**Route** — sul modello di `__tests__/api/sezioni-assegnate-scope.test.ts`: controlli veri (lock
`predicati-ruolo-non-mockabili`), database finto (`__tests__/fixtures/finto-supabase.ts`).
- Scheda:
  - 200 per l'educator di sezione, per l'educator di sola materia e per la segreteria della sede;
  - 403 per un'altra sezione della stessa sede, **verificando che l'anagrafica non sia letta**;
  - 403 per un'altra sede e per il genitore, 401 anonimo, 400 `id` non valido;
  - 404 per inesistente, non iscritto, archiviato, anonimizzato;
  - 500 con log su guasto di ciascuna lettura;
  - audit scritto **solo** sul 200;
  - il modulo esporta **solo** `GET`; `Cache-Control: no-store`.
- Elenco: solo iscritti, solo sezioni visibili, filtro di sede, educator senza sezioni → vuoto senza
  interrogare `alunni`, nessun testo libero nella risposta, 500 su guasto.

**Componenti** (Testing Library)
- Scheda: nessun `input` / `textarea` / `select` / pulsante di salvataggio; «Non indicato»; riquadro
  allergie; `tel:` e `mailto:`; i messaggi di 403, 404 ed errore.
- Elenco: raggruppamento, stati vuoto ed errore, pannello che applica e azzera i filtri, contatore,
  ripristino dei filtri anche con `sessionStorage` che lancia.

**Lock trasversali** — gate intero: `npx eslint . --max-warnings 0`, `npx tsc --noEmit`,
`npx vitest run` completo, `npm run build`.

**E2E Playwright (CI)** — il docente E2E apre «Alunni», filtra, apre una scheda e non trova campi
modificabili; l'indirizzo di un bambino di un'altra sezione mostra l'accesso negato.

## Consegna

Branch `feat/anagrafica-docente` → piano → implementazione TDD → PRD (tabella di stato + changelog
datato) → revisione del codice → PR → CI verde su **tutti** i job → merge a mano (niente
auto-merge) → deploy → verifica in produzione con sole `SELECT` (righe di audit con
`finalita = 'anagrafica-docente'` dopo il primo uso vero) → pulizia dei branch.

## Fuori perimetro

- Nomi cliccabili nelle schermate esistenti (appello, diario, classe della primaria).
- Qualunque modifica dell'anagrafica da parte del docente.
- Consultazione offline della scheda.
- Unificare le route parziali esistenti (`/api/diary/students` e simili) con la nuova.
