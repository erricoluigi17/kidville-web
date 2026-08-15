# Design — La carta intestata vera, e i certificati che il genitore si prende da sé

**Data**: 2026-08-15 · **Ramo**: `feat/carta-intestata-e-modulistica` · **Rilascio**: unico

---

## Perché

Il 15/08/2026 il titolare ha generato il primo certificato dall'app. Ne è uscito questo:

```
██ banda verde ███████████████████████████████
██ KIDVILLE SCHOOLS      Servizio Rilascio    ██
██ (giallo)              Certificati Automatici██
███████████████████████████████████████████████

Kidville Giugliano
Via Prima Traversa Antica Giardini 5, 80014 Giugliano in Campania (NA) — Giugliano

              CERTIFICATO DI FREQUENZA
              ───────────────────────
  …
                          Il Dirigente Scolastico
```

Quattro difetti in un foglio solo, tutti misurati sul file reale
(`~/Downloads/Certificato_CERTIFICATO_DI_FREQUENZA.pdf`, 4.847 byte):

1. **Non è la carta intestata della scuola.** È una banda verde inventata dal codice.
2. **«KIDVILLE SCHOOLS»** non è la ragione sociale, non è il marchio, non è niente.
3. **L'indirizzo è stampato due volte**: `…Giugliano in Campania (NA) — Giugliano`.
4. **«Il Dirigente Scolastico»** in una società cooperativa non esiste, e soprattutto non è
   chi firma: firma il **legale rappresentante** (Errico Cesario).

Questo documento descrive la riparazione, più le cinque richieste che il titolare ha allegato
alla segnalazione.

---

## Le decisioni prese in intervista

Ventisette domande, nessuna deduzione. Le risposte che vincolano il lavoro:

| Tema | Decisione |
|---|---|
| Testata | Riproduzione **1:1** della carta reale, mascotte in filigrana compresa |
| Il PDF della carta | **Non si modifica mai**: si incorpora così com'è, piede a 4 colonne incluso |
| Pagine | Carta **identica su tutte le pagine**, non solo sulla prima |
| Piede | Le tre sedi restano quelle stampate nell'asset; l'app nel piede **non scrive nulla** |
| Ambito | **Cinque motori PDF**: prestampati, protocolli, ricevuta FEA, registro presenze, merch |
| `denominazione` | «Kidville Giugliano / Aversa / Cesa» |
| `codice_meccanografico` | I due codici in un campo solo, separati da ` · ` |
| `indirizzo` | Ripulito alla **sola via**; CAP, città e provincia nei propri campi |
| `citta` Giugliano | Corretta in **«Giugliano in Campania»** |
| Ente dell'autorizzazione | **L'ente che ha emesso davvero** (Ambito socio-sanitario, non il comune) |
| Archiviazione | **Estensione dell'ENUM** `document_type_enum` con i 17 slug |
| Certificati del genitore | **Protocollati**, archiviati, **riscaricabili identici**; + pulsante «Generane uno nuovo» |
| Ricevuta FEA | **Fuori scope** — non richiesta |
| Segreteria | Copia firmata · copia vuota · compilazione al posto del genitore (**solo dicitura, niente scansione**) |
| Elenco dei non-firmatari | **Fuori scope** — non richiesto |
| Gite | **Invisibili** finché non esiste un'uscita; poi push + campanella. Sistema B spento per le gite |
| Pulizia | Tab ODT · valore di tab `attesa` · `DROP TABLE certificati_templates` |
| PRD stantio non correlato | **Fuori scope**: «Moduli Esterni» e «Iscrizioni Nuovi Alunni» restano come sono |
| Oblio GDPR | `sensitive_documents` **dentro** questo lavoro |
| Verde dei titoli | **`#006A5F`**, il token dell'app |
| Rilascio | **Un ramo, un merge** |

---

## 1 · La carta intestata

### 1.1 L'asset

`src/lib/carta/asset/carta-intestata.pdf` — copia byte-per-byte del file fornito dal titolare.

| Proprietà | Valore |
|---|---|
| SHA-256 | `6946d21216594797b8b8e6feb3c582a64caae3baa9adbdf76aa2590b19b8cceb` |
| Dimensione | 1.097.589 byte |
| Pagine | 1 · A4 esatto (595,276 × 841,89 pt) |
| Origine | Adobe Illustrator 29.8 → Adobe PDF library 17.00, 25/09/2025 |
| Contenuto | **Vettoriale puro**: 0 font incorporati (testo convertito in tracciati), 0 immagini raster |
| Sicurezza | Nessuna annotazione, nessun form, nessun JavaScript, non cifrato, nessun gruppo di trasparenza |

**Questo file non si modifica, non si ricomprime, non si ottimizza.** Istruzione esplicita del
titolare. La ricompressione lossless ridurrebbe il peso senza cambiare l'aspetto, ma cambierebbe
i byte: non si fa. Il SHA-256 qui sopra è il lock — un test lo verifica, così una «ottimizzazione»
ben intenzionata non passa inosservata.

### 1.2 La geometria, misurata

Rilievo a 150 dpi sul rendering del file reale, non stimato a occhio:

| Elemento | Estensione verticale |
|---|---|
| Logo «Kidville» + riga «NIDO · INFANZIA / PRIMARIA · CAMPO ESTIVO» | **12,5 → 26,8 mm** |
| Filigrana mascotte | tutta la pagina, grigio **#F4F4F4** (≈4%) |
| Piede a 4 colonne (ragione sociale · Giugliano · Aversa · Cesa · social) | **272,1 → 285,0 mm** |
| **Area libera** | **27,0 → 272,1 mm** |

Colori dell'asset: verde **#246A5F**, giallo **#FABC17**. Il testo che l'app scrive sopra usa i
token del prodotto (`#006A5F`, `#2D2D2D`, `#646464`): la differenza è impercettibile sul foglio e
un secondo verde nel progetto costerebbe più di quanto renda.

### 1.3 Le due collisioni da riparare

Il motore attuale (`src/lib/prestampati/impaginazione.ts`) è incompatibile con la carta in due punti
**certi**, non ipotetici:

| Costante oggi | Valore | Collisione | Nuovo valore |
|---|---|---|---|
| `BANDA_ALTEZZA` + `rect(0,0,210,30,'F')` | banda verde 0→30 mm | copre il logo della carta | **eliminata** |
| `LOGO_*` + `addImage(LOGO_LIGHT_PNG_BASE64)` | logo bianco a 14 / 7,5 | doppio logo | **eliminato** |
| `Y_PIEDE` | 287 | cade **dentro** il piede della carta (272→285) | **eliminato** |
| `PIEDE_PREDEFINITO` | «Documento generato dal registro elettronico Kidville» | idem | **eliminato**: la carta lo sostituisce |
| `LIMITE_CONTENUTO` | 272 | tocca il piede della carta | **266** |
| `Y_INTESTAZIONE` | 38 | ok, ma sale l'aria sotto il logo | **40** |
| `Y_TITOLO_MIN` | 58 | — | **60** |

`piePagina` per modello **resta**, ma si sposta: `modelloStampeSezione` stampa oggi
`Riservato — dati di minori · <data> · <nome>` a `y=287`. Va a **`y=268,5`**, sopra il piede della
carta, in 7 pt grigio. `Pagina n di m` idem, allineato a destra.

### 1.4 Il meccanismo

```
jsPDF                → pagine con SOLO il contenuto, fondo trasparente
   ↓
applicaCartaIntestata()   ← NUOVO, pdf-lib
   per ogni pagina: copia della carta come BASE, la pagina jsPDF stampata SOPRA
   ↓
applicaSegnatura()   → timbro di protocollo, come già oggi
```

La base è la carta, il contenuto ci si posa sopra. Questo ordine è obbligatorio: jsPDF non disegna
un fondo bianco, quindi stampare la carta *sopra* il contenuto lo coprirebbe con la filigrana.

`embedPdf()` incorpora l'asset **una volta sola** per documento e le pagine riusano lo stesso
form XObject: il costo è ~1,1 MB a documento, non a pagina. È il prezzo dichiarato della fedeltà 1:1
ed è accettato.

### 1.5 Un motore solo

`src/lib/protocolli/documento-pdf.ts:26-48` ripete oggi le stesse identiche misure di
`impaginazione.ts:164-211`. Due copie della stessa testata divergono sempre, prima o poi. La testata
diventa **una funzione sola**, in `src/lib/carta/`, e i cinque motori la chiamano:

| Motore | File |
|---|---|
| Prestampati (17 modelli) | `src/lib/prestampati/impaginazione.ts` |
| Protocolli | `src/lib/protocolli/documento-pdf.ts` |
| Ricevuta FEA | `src/lib/fea/receipt-pdf.ts` |
| Registro presenze | `src/components/features/teacher/attendance/MonthlyAttendanceTable.tsx` |
| Merch | `src/app/api/admin/merch/ordini-fornitore/pdf/route.ts` |

⚠️ Il registro presenze gira **nel browser** (`jspdf-autotable` in un componente client): l'asset da
1,1 MB non può entrare in un bundle client. **Decisione: la generazione si sposta server-side**, su
una route che restituisce il PDF già impaginato — stessa strada di tutti gli altri motori, un solo
posto dove la carta si applica. Servire l'asset da una route e comporre nel browser è l'alternativa
scartata: scaricherebbe 1,1 MB a ogni stampa e lascerebbe un sesto motore fuori dal motore comune.

---

## 2 · L'anagrafica delle tre sedi

Stato misurato in produzione il 2026-08-15 (`SELECT … FROM scuole`): compilati solo `email`,
`legale_rappresentante` (tutte e tre: **Errico Cesario**) e `denominazione` (solo Aversa). Tutto il
resto è `null`.

### 2.1 I valori da scrivere

| Campo | Giugliano | Aversa | Cesa |
|---|---|---|---|
| id | `d53b0fbc-a9eb-4073-b302-73d1d5abd529` | `429da920-2c1f-47a8-82ed-a26f63ee0591` | `04accbfd-5890-4416-99f7-acd8b864dc2f` |
| `denominazione` | Kidville Giugliano | Kidville Aversa | Kidville Cesa |
| `scuole.indirizzo` | Via Prima Traversa Antica Giardini 5 | Via dell'Archeologia 54 | Via Filippo Turati 2 |
| `scuole.citta` | Giugliano in Campania | Aversa | Cesa |
| `cap` | 80014 | 81031 | 81030 |
| `provincia` | NA | CE | CE |
| `codice_meccanografico` | NA1A079004 · NA1E094004 | CE1A178007 | CE1AE75008 · CE1E05400Q |
| `telefono` | 331 815 3108 | 340 728 7420 | 081 503 2070 |
| `email` | giugliano@kidville.it | aversa@kidville.it | cesa@kidville.it |
| `piva_cf` | 03394870616 | 03394870616 | 03394870616 |
| `pec` | scuolalafavola@pec.it | scuolalafavola@pec.it | scuolalafavola@pec.it |
| `legale_rappresentante` | Errico Cesario *(già presente)* | *(già presente)* | *(già presente)* |
| `autorizzazione_nido.numero` | 102A | 17 | 6/2018 |
| `autorizzazione_nido.data` | 2025-10-29 | 2024-10-01 | 2018-04-12 |
| `autorizzazione_nido.comune` | Comune di Giugliano in Campania | Ambito Socio-Sanitario C06 — Comune capofila Aversa | Ambito Socio-Sanitario C6 — Comune capofila Casaluce |

Fonti: carta intestata fornita dal titolare (recapiti, P.IVA) e archivio documentale
(autorizzazioni, codici meccanografici). La scelta di stampare **l'ente che ha emesso davvero**
invece del comune dove sta il nido è esplicita: il certificato Bonus Nido esce firmato e va
all'INPS, e se l'INPS controlla deve trovare il provvedimento vero.

### 2.2 La duplicazione dell'indirizzo

`buildIntestazioneSede()` (`src/lib/certificati/self-service.ts:38-52`) compone
`indirizzo — CAP CITTÀ (PROV)`. Con `indirizzo` che contiene già CAP, città e provincia, il
risultato è la riga stampata sul certificato reale del 15/08. Si ripara **alla fonte**: `indirizzo`
torna a essere la sola via. Nessuna logica di confronto stringhe a valle — sarebbe fragile e
nasconderebbe il difetto invece di toglierlo.

Prima di scrivere: censire **ogni** lettore di `scuole.indirizzo`, perché la riduzione del campo li
tocca tutti.

### 2.3 Come si scrivono

Tramite **Impostazioni → Sede & Intestazione** (`PATCH /api/admin/schools`), non con `UPDATE`
diretti: il percorso applicativo esercita `normalizzaAnagraficaSede`, il gate `requireStaff` e
l'audit `logScrittura`. Uno `UPDATE` a mano salterebbe tutti e tre e non proverebbe che la UI
funziona.

⚠️ `normalizzaAnagraficaSede` è **lista bianca in scrittura**: ricostruisce l'oggetto dai soli campi
elencati in `CAMPI`. Nessun campo nuovo va aggiunto in questo lavoro; se servisse, va messo **sia**
nello schema zod **sia** in `CAMPI`, altrimenti viene cancellato al primo salvataggio.

---

## 3 · L'archiviazione — la radice di tutto

`student_documents.document_type` è la ENUM `document_type_enum` con **quattro** valori:
`diagnosi`, `pei`, `104`, `pdp` (`supabase/migrations/20260704120000_baseline.sql:43-49`). Nessuno
dei 17 slug dei prestampati ci sta dentro.

**Conseguenza misurata**: il 100% delle firme del genitore fallisce l'archiviazione con `22P02`. Il
PDF torna una volta sola in `pdfBase64`, il file resta orfano nel bucket `sensitive_documents` e
nessun elenco lo ritrova più.

Riparazione: `ALTER TYPE document_type_enum ADD VALUE` per i 17 slug, una migrazione per valore o
comunque **fuori transazione** (Postgres non ammette l'uso di un valore aggiunto nella stessa
transazione che lo crea).

**Vincolo CI**: il DB E2E è un progetto separato e **non migrato**. Il codice nuovo deve degradare
pulito — `PGRST204` su INSERT/UPDATE, `42703` su SELECT, `22P02` su enum — senza rompere la suite.

Senza questa riparazione, **niente** dei punti 4 e 5 può funzionare. È il primo passo del piano.

---

## 4 · Il genitore

### 4.1 Cosa sparisce

I due pulsanti legacy di `src/app/(dashboard)/parent/modulistica/page.tsx:452`
(`generateSelfServiceCertificate`) — jsPDF nel browser, «KIDVILLE SCHOOLS» cablato, «Il Dirigente
Scolastico», nessun protocollo, nessuna archiviazione. **Si eliminano**, con il loro generatore.

### 4.2 Cosa arriva

| Documento | Firma | Protocollo | Archiviato |
|---|---|---|---|
| 26·27 Certificato di iscrizione e frequenza | legale rappresentante | **sì**, in uscita | sì |
| 28 Certificato Bonus Asilo Nido INPS | legale rappresentante | **sì**, in uscita | sì |
| 05·07·09 (+06·08) i propri moduli firmati | OTP già raccolta | no | sì, riscaricabili sempre |

### 4.3 La regola del riscarico

> Una volta che il genitore ha scaricato il suo certificato, quel certificato **resta salvato**, e
> quando lo va a riprendere **riscarica sempre lo stesso**.

Quindi: il certificato esistente si ripresenta **identico**, stesso file, **stesso numero di
protocollo**. Nessun numero bruciato, nessun duplicato nel registro WORM.

Accanto, un pulsante **secondario e meno vistoso**: «Generane uno nuovo». Emette data e protocollo
nuovi, consapevolmente — è il caso del datore di lavoro che vuole un certificato recente.

### 4.4 Fuori scope

La ricevuta di firma FEA (`src/lib/fea/receipt-pdf.ts`) resta senza pulsante: non è stata chiesta.
Il generatore esiste e la carta intestata gli si applica lo stesso, per non farlo divergere.

---

## 5 · La segreteria

Tutti e 17 i modelli **generabili davvero**, non solo elencati con un motivo di rifiuto. Oggi
`elencoPerRuolo('segreteria')` ne mostra 17 ma ne genera **uno**.

Tre modi di lavorare su un modulo di famiglia:

1. **Copia firmata** — il PDF che il genitore ha sottoscritto, ripescato dal fascicolo. Dipende
   interamente dal punto 3.
2. **Copia vuota** — modulo precompilato coi dati dell'alunno, senza firma, da consegnare su carta a
   chi non usa l'app. Il blocco firma stampa la riga da firmare a penna invece del riquadro FEA.
3. **Compilazione al posto del genitore** — per il modulo tornato compilato su carta. Il PDF porta
   la dicitura **«Modulo consegnato su carta il gg/mm/aaaa, firmato in originale agli atti»**.
   **Nessuna scansione allegata**: decisione esplicita del titolare.

Fuori scope: l'elenco per sezione di chi non ha ancora firmato.

---

## 6 · Le gite — due sistemi che ne diventano uno

Oggi il prestampato n. 10 è spento da un insieme scritto a mano:

```ts
// src/app/api/parent/prestampati/banco-famiglia.ts:177
const CONTESTO_NON_DISPONIBILE: ReadonlySet<string> = new Set(['autorizzazione_uscita'])
```

Resta spento **anche quando una gita esiste davvero**, perché le uscite di
`src/app/api/teacher/uscite/route.ts` vivono in `eventi_agenda` (`tipo='uscita'`) +
`forms_templates` — il «Sistema B» — e i due sistemi non si parlano. `DatiUscita` non lo costruisce
nessuno in tutto il repo.

**Dopo**:

- il `Set` sparisce; il n. 10 compare **solo** se esiste un'uscita pubblicata per la sezione di quel
  bambino, con destinazione, data e orari già dentro;
- niente uscita ⇒ **il modulo non compare affatto** nell'elenco del genitore (non «compare e non si
  apre»);
- alla pubblicazione: **notifica push nativa** + voce nel **Centro Notifiche**. Nessuna email —
  scelta esplicita;
- il modulo del Sistema B **per le gite** si spegne. Le autorizzazioni gita passano dalla carta
  intestata, dalla firma OTP e dal fascicolo, come tutti gli altri.

---

## 7 · Pulizia

| Cosa | Dove |
|---|---|
| Tab «Template Certificati ODT» | `admin/modulistica/page.tsx` righe 106, 137, 165-168, 552, 721-806 |
| 9 chiavi di traduzione × 2 lingue | `messages/{it,en}/adminModulistica.json` righe 189, 209-216 |
| Riga di allowlist | `__tests__/architecture/messaggi-plurali-e-glossario.test.ts:482` |
| Valore di tab `attesa`, morto | `admin/modulistica/page.tsx:106` |
| `DROP TABLE certificati_templates` | letta e scritta da **zero** righe di codice |

Il tab ODT è un mockup: gli `onChange` salvano il *nome* del file in `useState` e basta — nessun
upload, nessuna riga di DB, il badge sparisce al refresh. Duplica la linguetta «Prestampati» che
genera davvero i certificati.

Attenzione dopo la rimozione: se gli import `Settings` e `Upload` di `lucide-react` restano
inutilizzati, `eslint --max-warnings 0` fallisce.

Il PRD si aggiorna per ciò che tocchiamo (`AGENTS.md` lo impone). Le due voci stantie non correlate
(«Moduli Esterni», «Iscrizioni Nuovi Alunni») **restano come sono**: decisione esplicita.

---

## 8 · Oblio GDPR

Il bucket `sensitive_documents` **non è** in `REGISTRO_BUCKET_OBLIO` (`src/lib/gdpr/esegui.ts`). Ci
finiscono schede sanitarie, terapie farmacologiche e diete speciali di bambini — dati dell'art. 9
GDPR. Una richiesta di cancellazione oggi **non li tocca**.

Questo lavoro raddoppia ciò che entra in quel bucket: aggravare la lacuna senza ripararla non è
un'opzione. Il bucket entra nel registro dell'oblio, con un test che lo blinda.

---

## 9 · Come si collauda

Un esecutore per elemento, e su ciascuno un **critico severo in loop** che non firma finché il
risultato non è tripla A:

| Occhio | Cosa guarda |
|---|---|
| **PDF** | Ogni prestampato generato davvero, convertito in immagine e confrontato con la carta reale: nessuna collisione col piede (272,1 mm), nessun testo sopra il logo (26,8 mm), filigrana leggibile sotto il testo, margini, allineamenti |
| **Browser** | Modulistica segreteria e genitore in Chrome vero: stati vuoto/caricamento/errore, token Clay Village, console pulita |
| **Nativo** | iOS e Android via Maestro: i PDF si aprono davvero, niente sotto il piede dello schermo |
| **Accessibilità e lingua** | Contrasto, tastiera, screen reader; **nessun «Dirigente Scolastico», nessun «KIDVILLE SCHOOLS»**, date e numeri all'italiana |

Gate formale, come da `AGENTS.md`: `eslint --max-warnings 0` · `tsc --noEmit` · `vitest run` ·
`npm run build` · E2E in CI · **log presenti sul codice toccato**.

---

## 10 · Ordine obbligato

Il punto 3 (ENUM) viene prima di tutto: senza, i punti 4 e 5 non possono funzionare, e un collaudo
che li verifica prima misurerebbe un guasto invece di una funzione.

```
3 archiviazione ─┬─→ 4 genitore ─┐
                 └─→ 5 segreteria┤
1 carta ─────────────────────────┼─→ 9 collaudo → gate → merge
2 anagrafica ────────────────────┤
6 gite ──────────────────────────┤
7 pulizia ───────────────────────┤
8 GDPR ──────────────────────────┘
```

1, 2, 6, 7 e 8 sono indipendenti fra loro e si possono lavorare in parallelo.

---

## Rischi dichiarati

| Rischio | Mitigazione |
|---|---|
| L'asset da 1,1 MB entra in ogni bundle che lo importa | Modulo dedicato, importato solo dal codice server. Il registro presenze (oggi client) va spostato o servito da route |
| `ALTER TYPE` su un enum è irreversibile | Nomi degli slug già stabili e collaudati dal registro TypeScript |
| Il DB E2E non è migrato | Degrado pulito su `PGRST204`/`42703`/`22P02`, verificato dalla suite |
| `scuole.indirizzo` ridotto rompe altri lettori | Censimento di **ogni** consumatore prima della scrittura |
| Il piede a `y=268,5` è stretto | Verifica visiva su un documento reale, non solo per calcolo |
| Spegnere il Sistema B per le gite tocca un flusso in uso | Le gite già pubblicate restano leggibili; si spegne solo la creazione |
| Dati veri di minori in produzione | Nessun `UPDATE` a mano: si passa dalle route applicative, con audit |
