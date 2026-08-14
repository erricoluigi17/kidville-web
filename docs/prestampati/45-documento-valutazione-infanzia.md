# 45 — Documento di valutazione — Scuola dell'Infanzia

**Compila** l'insegnante di sezione · **Valida** la Coordinatrice Didattica · **Firma** presa visione del genitore con OTP
**Archivia** `student_documents.document_type = 'valutazione_infanzia'`
**Fonte** ➕ **nuovo** — nell'archivio esiste solo la pagella della primaria

La primaria ha già il suo documento, in app (`src/lib/primaria/pagella-pdf.ts`) e in archivio
(scala Avanzato / Intermedio / Base / In via di prima acquisizione, per materia e quadrimestre).
Per l'infanzia **non esiste nulla, né su carta né in app** — è annotato come dato mancante anche
nella scheda dell'archivio.

---

## Cosa non deve essere

Non è una pagella. Alla scuola dell'infanzia non si danno voti e non si valuta il bambino: si
osserva e si documenta un percorso. Il documento giusto segue i **campi di esperienza** delle
Indicazioni Nazionali, che sono già l'impianto del PTOF 2025-2028 della scuola, e restituisce alla
famiglia una descrizione, non una misura.

I cinque campi di esperienza:

1. Il sé e l'altro
2. Il corpo e il movimento
3. Immagini, suoni, colori
4. I discorsi e le parole
5. La conoscenza del mondo

---

## Testo del modello

> **DOCUMENTO DI OSSERVAZIONE E VALUTAZIONE**
> **Scuola dell'Infanzia**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> **DATI DELL'ALUNNO/A** — *nucleo comune*
> Anno di frequenza: ☐ 1° (3 anni) ☐ 2° (4 anni) ☐ 3° (5 anni) → `{{alunno.anno_frequenza}}`
> Periodo: ☐ Primo periodo ☐ Fine anno scolastico → `[PERIODO]`
> Insegnanti di sezione: `{{sezione.insegnanti}}`
>
> **CAMPI DI ESPERIENZA**
>
> Per ciascuno dei cinque campi:
> | Campo di esperienza | Livello | Osservazioni |
> |---|---|---|
> | Il sé e l'altro | `[LIVELLO]` | `[OSSERVAZIONI: testo]` |
> | Il corpo e il movimento | `[LIVELLO]` | `[OSSERVAZIONI: testo]` |
> | Immagini, suoni, colori | `[LIVELLO]` | `[OSSERVAZIONI: testo]` |
> | I discorsi e le parole | `[LIVELLO]` | `[OSSERVAZIONI: testo]` |
> | La conoscenza del mondo | `[LIVELLO]` | `[OSSERVAZIONI: testo]` |
>
> **Livelli**: `In fase di acquisizione` · `In via di consolidamento` · `Consolidato`
>
> **AUTONOMIA E RELAZIONE**
> Autonomia personale: `[LIVELLO]` · Relazione con i pari: `[LIVELLO]`
> Relazione con l'adulto: `[LIVELLO]` · Partecipazione alle attività: `[LIVELLO]`
> Rispetto delle regole: `[LIVELLO]`
>
> **OSSERVAZIONE COMPLESSIVA**
> `[OSSERVAZIONE_GLOBALE: testo lungo]`
>
> **PROPOSTE PER IL PERIODO SUCCESSIVO**
> `[PROPOSTE: testo lungo]`
>
> `{{luogo_data}}`
> Le insegnanti di sezione: `{{sezione.insegnanti}}`
> La Coordinatrice Didattica: `{{scuola.coordinatrice}}`
>
> **PRESA VISIONE DELLA FAMIGLIA**
> `{{presa_visione.timestamp}}` — *firmato con OTP*

---

## Tre livelli, non quattro

La primaria ne usa quattro perché deve mappare i voti ministeriali. Qui tre bastano e sono più
onesti: a quattro anni la differenza fra «base» e «in via di prima acquisizione» non descrive il
bambino, descrive il giorno in cui lo si è osservato.

## Il testo libero è il documento

Nella primaria la tabella è il documento e il giudizio è un contorno. Qui è il contrario: i livelli
servono all'insegnante per orientarsi, ma quello che la famiglia legge — e che vale — sono le
osservazioni. Il form deve incoraggiarle: campo ampio, nessun limite stretto di caratteri,
possibilità di riprendere e completare in più sedute prima di consegnare.

Una funzione utile e semplice: le osservazioni del periodo precedente visibili accanto, così il
documento di fine anno dialoga con quello di gennaio invece di ripartire da zero.

## Il legame con il certificato delle competenze

A fine terzo anno il bambino esce con il
[46 — certificato delle competenze](46-certificato-competenze.md), sulle 8 competenze chiave
europee del D.M. 14/2024. I cinque campi di esperienza confluiscono lì.

Il certificato non deve partire da un foglio bianco: le osservazioni dei tre anni sono già in
banca dati, e vanno proposte all'insegnante come punto di partenza — modificabili, mai automatiche.
Il giudizio resta suo.

## Dopo la firma

1. Lo stato è `bozza` finché la Coordinatrice non valida: un documento di valutazione non si
   consegna da soli.
2. Alla validazione → PDF in `student_documents` + notifica al genitore.
3. Il genitore firma la **presa visione** con OTP — stesso flusso già in uso per la pagella della
   primaria (`/api/parent/primaria/pagella/firma/otp`), da riusare tale e quale.
4. Nessuna scadenza. Il documento resta nel fascicolo e segue il bambino.
