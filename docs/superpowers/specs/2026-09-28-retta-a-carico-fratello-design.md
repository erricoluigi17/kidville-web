# Retta a carico di un fratello: «Paga il fratello …» al posto di «Non generata»

**Data:** 2026-09-28 · **Branch:** `feat/retta-a-carico-fratello` · **Stato:** approvato dal titolare in chat

## Il problema

Dal 2026-08-16 un alunno può avere la retta **a carico di un fratello** (`alunni.retta_a_carico_di`,
self-FK). Entrambe le strade che generano le rette (RPC `genera_rette_mensili` e anteprima di
`/api/pagamenti/genera-rette`) lo **saltano**: la retta di tutta la famiglia sta su un figlio solo.

Nella Contabilità → vista **Rette** però quel bambino compare con il badge grigio **«Non generata»**,
come chi è stato dimenticato. E il riquadro giallo «N alunni senza retta generata → Genera
mancanti» lo **conta**: il bottone non lo genera mai, e il numero non scende mai a zero.

Misurato in produzione il 2026-09-28 (sola lettura): **47 iscritti** a carico di un fratello
(39 Giugliano, 5 Aversa, 3 Cesa); pagante sempre iscritto e nella stessa sede; nessuna catena;
sesso del pagante sempre valorizzato (26 M, 21 F). **3** di loro hanno comunque la retta di
settembre 2026 generata; **2** hanno il legame con un importo ≠ 0 (già segnalato in scheda).

## Le decisioni del titolare (domande in chat, 2026-09-28)

| # | Tema | Decisione |
|---|---|---|
| D1 | Testo | «**Paga il fratello** Mario Rossi (Sez. C)» / «**Paga la sorella** Anna Bianchi (Sez. B)», dal sesso del pagante. Sesso assente → «**A carico di** Mario Rossi (Sez. C)». |
| D2 | Stato | Nello **stesso badge**, dopo un « · », lo stato della retta **del fratello** per il mese scelto: «… · Da pagare». |
| D3 | Colore | Il badge prende il **tono dello stato del fratello** (lo stesso di `STATI_PAGAMENTO`): grigio da pagare, arancio parziale, verde pagato, rosso scaduto. |
| D4 | Retta del fratello non generata | Lo stato è «Non generata», tono neutro. |
| D5 | Classe | Il testo porta la classe del pagante tra parentesi (omessa se il pagante non ha classe). |
| D6 | Genera mancanti | I bambini a carico di un fratello **escono dal conteggio**. |
| D7 | Riga del pagante | **Invariata**. |
| D8 | Azioni sulla riga a carico | **Nessun «Incassa»** né dettaglio: si incassa solo dalla riga del fratello. Resta l'interruttore Sospensione come oggi. |
| D9 | Retta già generata a un bambino a carico (3 casi) | Si mostra la **retta normale** (importo, stato, Incassa, come oggi) **più** un badge d'avviso arancio «A carico del fratello Mario Rossi (Sez. C): retta da verificare». |
| D10 | Filtro «Morosi» | Il bambino a carico compare **anche** quando il fratello che paga è moroso per quel mese. |
| D11 | Ricerca | Scrivendo il nome del pagante compare anche il bambino a suo carico. |
| D12 | Pagante anomalo | Badge normale **più** un badge rosso: «Chi paga non è più iscritto: retta da rivedere» / «Chi paga è in un'altra sede: retta da rivedere». |
| D13 | Dove | Tabella Rette (desktop), card Rette (mobile), **export Excel dello scadenzario**. Non lato genitore. |
| D14 | Export | Per ogni retta del pagante, **una riga in più** per il bambino a carico: importi a 0 (i totali non raddoppiano), Stato «Paga il fratello Mario Rossi (Sez. C) · Da pagare». |
| D15 | Fine lavoro | Fino al **deploy in produzione**. |

## Approccio scelto (fra tre)

1. **Scelto — route di sola lettura dedicata + modulo puro condiviso.**
   `GET /api/pagamenti/rette-a-carico` restituisce i legami degli iscritti delle sedi visibili, con
   l'identità del pagante. Il cruscotto la chiama in parallelo alle due GET che fa già. Lo stato
   della retta del pagante **non** viaggia in questa risposta: il cruscotto lo prende dalla stessa
   mappa `rettaByAlunno` che disegna la riga del fratello, così il badge «segue» davvero quella riga
   (D3) e non può divergere da lei. Il caricamento dei legami sta in un modulo server condiviso con
   l'export: una lettura sola, due consumatori.
2. *Scartato* — estendere `GET /api/admin/students` con `retta_a_carico_di` e un embed del pagante:
   route enorme usata da molte schermate, col ciclo `42703` che toglie colonne una a una; e il
   pagante **non iscritto** (D12) non è nell'elenco degli iscritti.
3. *Scartato* — righe «virtuali» dentro `GET /api/pagamenti`: quella risposta alimenta KPI, agenda
   e totali, e una riga finta li sporcherebbe.

## I pezzi

### 1. `src/lib/pagamenti/rette-a-carico.ts` — modulo **puro** (nessun I/O)

```ts
export type SessoPagante = 'M' | 'F' | null
export interface PaganteRetta {
  id: string; nome: string; cognome: string
  sesso: SessoPagante
  classe_sezione: string | null
  /** stato === 'iscritto' E archiviato_il nullo */
  iscritto: boolean
  scuola_id: string | null
}
export interface LegameRetta {
  alunno_id: string
  /** sede del bambino a carico */
  scuola_id: string | null
  pagante: PaganteRetta
}
export type AnomaliaPagante = 'non-iscritto' | 'altra-sede' | null
```

Funzioni (tutte pure, testate con vitest):

- `sessoDa(gender: unknown): SessoPagante` — `'M'`/`'F'` (anche minuscole, con spazi) → quel
  valore; tutto il resto → `null`.
- `nomePagante(p)` — «Nome Cognome» ripulito dagli spazi.
- `anomaliaPagante(legame)` — `'non-iscritto'` se `!pagante.iscritto`; altrimenti
  `'altra-sede'` se le due sedi sono diverse; altrimenti `null`. Il non-iscritto vince.
- `testoPaganteIt(p, stato?)` — il testo **italiano** dell'export (D1, D2, D5, D14):
  `Paga il fratello Mario Rossi (Sez. C) · Da pagare`. È anche il riferimento per la UI (vedi lock).
- `indicizzaLegami(legami)` → `Map<alunno_id, LegameRetta>`.

### 2. `src/lib/pagamenti/rette-a-carico-server.ts` — il caricamento condiviso

`caricaLegamiRetta(supabase, { sediBambini, sediPaganti, operazione })` →
`{ ok: true, legami } | { ok: false }`. **Due query semplici, niente embed** della self-FK (la
sintassi dell'embed su una FK verso la stessa tabella è fragile, e il client finto dei test non
costruisce join: due query le verifica davvero):

1. i bambini: `alunni` con `stato = 'iscritto'`, `scuola_id IN sediBambini`,
   `retta_a_carico_di IS NOT NULL`;
2. i paganti: `alunni` con `id IN (…)` **e** `scuola_id IN sediPaganti` (le sedi a cui l'utente ha
   accesso, non solo quelle selezionate: così un pagante in un'altra sede *accessibile* si vede e
   accende l'anomalia D12; uno in una sede **non** accessibile non si rivela — il legame si scarta
   e si conta in un `warn`).

- **`42703`** sulla prima query (DB E2E della CI non migrato) → `ok: true` con **zero legami**,
  loggato a livello `info` spiegando perché (AGENTS.md, regola 6): il comportamento resta quello
  di oggi, non diventa un 500 — ma **solo se** il messaggio (o `details`) nomina
  `retta_a_carico_di` (revisione del 28/09, C5). Sulla seconda, `42703` → si riprova senza
  `gender` e `archiviato_il`, con un log `info` (`legami-paganti-colonne-assenti`), **solo se**
  il messaggio (o `details`) nomina una di quelle due (terza revisione, R5, 29/09);
- ogni altro `{ error }` — compreso un `42703` su un'altra colonna o senza messaggio →
  `ok: false`, loggato a livello `error` (PostgREST non lancia). Nessun ripiego su `PGRST200`:
  le due query non usano embed;
- gli id dei paganti vanno nell'`.in()` a pezzi di `ID_PER_QUERY` (`@/lib/db/blocchi`): la lista
  finisce nell'URL (terza revisione, R8);
- mai nomi nei log: solo conteggi, uuid ed errori.

### 3. `GET /api/pagamenti/rette-a-carico` — la route

`withRoute('pagamenti/rette-a-carico:GET', …)`, `requireStaff`, `zod` sulla query
(`scuola_id` uuid opzionale, `userId` opzionale come le altre GET del cruscotto), sedi da
`resolveScuoleAttive` (ristrette a `scuola_id` se dichiarata e accessibile, come
`/api/pagamenti`, ma con `restringiSedi` + `rifiutoSede('SEDE_NON_ACCESSIBILE')` come le route
più recenti: un uuid di sede non accessibile è un 403, non un «nessun legame»). Risponde
`{ success: true, data: LegameRetta[] }` (del bambino solo uuid e sede: nome, cognome e classe
il cruscotto li ha già — proiezione minima); su `ok: false` → 500 con `{ error, codice: 'LETTURA_FALLITA' }` (codice già
nel catalogo). Log di successo con il conteggio.

### 4. `PaymentsDashboard.tsx` — il cruscotto

- `load()` fa **tre** GET in parallelo; la terza è i legami. Un guasto dei legami **non** svuota
  le rette: si mostra un banner d'errore (`data-testid="errore-legami"`, con «Riprova») e si
  torna al comportamento di oggi («Non generata»), loggato da `leggiJson`.
- **Riga senza retta propria + legame** (desktop e mobile, D1–D5, D8, D12):
  badge unico col testo `dashACarico` + ` · stato`; tono = `STATI[pRettaPagante.stato].tone`,
  oppure neutro con stato «Non generata» (D4). Se la sede del pagante **non** è fra quelle
  visibili (i suoi pagamenti non sono caricati) lo stato si omette e il tono è neutro: non si
  inventa uno stato che non si conosce. Più il badge rosso d'anomalia se `anomaliaPagante ≠ null`.
  Colonne Importo/Pagato «—», nessun Incassa/dettaglio/modifica (D8), Sospensione invariata.
- **Riga con retta propria + legame** (D9): tutto come oggi, più il badge arancio
  «… : retta da verificare».
- **Genera mancanti** (D6): `mancantiPerSede` salta chi ha un legame.
- **Morosi** (D10): passa anche chi, senza retta propria, ha il pagante moroso sul mese.
- **Ricerca** (D11): la stringa cercata include nome e cognome del pagante.
- i18n: chiavi nuove in `messages/{it,en}/adminContabilita.json`, con `select` ICU sul sesso.

### 5. Export scadenzario (`/api/pagamenti/export`, `tipo=scadenzario`)

Dopo le righe di oggi, per ogni legame delle sedi dell'export e per ogni retta del pagante
(categoria `slug = 'retta'`, `tipo ≠ 'padre'`, `periodo_competenza` valorizzato, **una per
periodo**: se il pagante ne ha più d'una nello stesso mese vale la prima per scadenza) si aggiunge
una riga: Sede e Sezione **del bambino**, Alunno il bambino, Categoria/Descrizione/Scadenza della
retta del pagante, Importo/Pagato/Residuo **0**, Stato = `testoPaganteIt(pagante, stato)`,
Fattura vuota. Le righe restano ordinate per scadenza.

- **Le rette dei paganti** (e quelle proprie dei bambini, per D9) si leggono **sempre** con una
  query a parte, ristretta agli uuid dei legami: le righe principali dell'export restano quelle di
  oggi, filtri compresi, e le righe in più non dipendono da quali di esse sono passate.
- **Filtro classi**: la riga del bambino c'è se è **il bambino** a stare nelle classi scelte, anche
  se il pagante no (come nel cruscotto, dove il filtro guarda il bambino).
- **Filtro `stato`** (parametro della route, oggi non usato dal cruscotto): la riga del bambino
  segue lo stato della retta del pagante.
- Il bambino che ha **anche** una retta propria di quel mese (D9) **non** riceve la riga in più:
  la sua riga vera c'è già.
- Guasto nella lettura dei legami → l'export esce **senza** le righe in più ma non fallisce (un
  export che salta per un'informazione accessoria sarebbe peggio). La causa la logga il loader a
  livello `error`, la conseguenza (`export-senza-righe-a-carico`) l'export a livello `info`: un
  guasto, una riga `error` (terza revisione, R3).

## Errori e osservabilità

- Route nuova avvolta in `withRoute`, log di successo col conteggio dei legami, errori PostgREST
  gestiti dal valore di ritorno.
- Nel cruscotto: legami non caricati = banner visibile + `logClient` livello `error`.
- Nessun nome, nessun codice fiscale nei log: solo conteggi e uuid.

## Test

- **Unit** del modulo puro: tutte le forme del testo (M, F, null, con/senza classe, con/senza
  stato), `sessoDa`, `anomaliaPagante` (precedenza), `indicizzaLegami`.
- **Lock di coerenza**: il testo della UI in italiano (catalogo `it` + `createTranslator`) è
  identico a `testoPaganteIt` per gli stessi ingressi — così Excel e schermo non divergono.
- **Loader server**: ok; `42703` che nomina `retta_a_carico_di` → zero legami + log `info`;
  `42703` sui paganti che nomina `gender`/`archiviato_il` → ripiego + log `info`; ogni altro
  errore (anche un `42703` su un'altra colonna) → `ok: false` + log `error`; pagante non
  leggibile → fra i `nonVisibili`; liste di id oltre `ID_PER_QUERY` a pezzi.
- **Route**: 401/403 senza staff, 400 su `scuola_id` non uuid, 200 con i legami, 500 con codice.
- **Componente** (`PaymentsDashboard`): badge al posto di «Non generata» con testo e tono giusti
  (M, F, sesso assente, pagante non generato, pagante pagato/scaduto), avviso D9, anomalia D12,
  niente Incassa sulla riga a carico, mancanti esclusi, filtro Morosi, ricerca per nome del
  pagante, banner d'errore quando la GET dei legami fallisce.
- **Export**: righe in più a importi 0, filtro classi sul bambino, niente riga in più se il bambino
  ha la sua retta, guasto dei legami → export senza righe in più ma riuscito.
- **Rompere il codice e guardare il test diventare rosso** su almeno: esclusione dai mancanti,
  tono dal pagante, riga a importi zero nell'export.

## Fuori perimetro

Lato genitore; modifica del legame (già in scheda alunno); le 2 righe con importo ≠ 0 (già
segnalate in scheda); le 3 rette generate prima del legame (si segnalano, non si toccano).
