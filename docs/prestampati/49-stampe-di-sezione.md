# 49 — Stampe di sezione

**Genera** segreteria o insegnante · **Nessuna firma** · **Non si archivia nel fascicolo**
**Fonte** ➕ **nuovo**

Tre fogli che oggi non esistono e che in una scuola si stampano di continuo. Non sono documenti
con valore legale: sono strumenti di lavoro. Per questo non si firmano e non entrano nel fascicolo
di nessuno — ma **contengono dati personali di minori**, e vanno trattati come tali.

---

## 49.a — Elenco alunni di sezione

> **ELENCO ALUNNI — SEZIONE {{sezione.nome}}**
> {{sede.nome}} · Anno scolastico {{anno_scolastico}}
>
> | # | Cognome e nome | Data di nascita | Insegnanti | Note |
> |---|---|---|---|---|
>
> Totale iscritti: `{{sezione.totale}}`
> Stampato il `{{data_oggi}}` da `{{utente.nome}}`

Opzioni: con o senza foto (griglia con foto per l'accoglienza di settembre), ordinato per cognome
o per data di nascita, solo attivi o anche sospesi.

---

## 49.b — Elenco allergie e diete per la cucina

Il più importante dei tre, e quello che oggi manca del tutto.

> **ALLERGIE, INTOLLERANZE E DIETE SPECIALI**
> {{sede.nome}} · Sezione {{sezione.nome}} · Anno scolastico {{anno_scolastico}}
> **Aggiornato al {{data_oggi}} — sostituisce ogni copia precedente**
>
> | Cognome e nome | Sezione | Allergie / intolleranze | Alimenti da escludere | Sostituzioni | Motivo | Documento |
> |---|---|---|---|---|---|---|
>
> Bambini con dieta speciale: `{{totale_diete}}` su `{{totale_iscritti}}`
> In caso di dubbio **non somministrare** e contattare la segreteria: `{{sede.telefono}}`

Si alimenta da `alunni.allergies`, `alunni.allergeni` e dalle richieste di
[07 — dieta speciale](07-dieta-speciale.md) prese in carico. È l'anello che chiude quel modulo: una
richiesta firmata che la cucina non vede non ha protetto nessuno.

Due accorgimenti che sembrano dettagli e non lo sono:

- **la data di aggiornamento in grande, in testa**, con la frase che invalida le copie precedenti.
  Il foglio in cucina resta appeso per mesi, e il rischio non è che manchi: è che sia vecchio;
- **una riga per bambino anche quando la dieta è la stessa**, invece di raggruppare per allergene.
  Chi prepara i piatti ragiona per bambino.

Va ristampato a ogni variazione, e l'app deve dirlo: quando una dieta cambia, notifica alla
segreteria che la stampa in cucina è superata.

---

## 49.c — Contatti d'emergenza

> **CONTATTI D'EMERGENZA — SEZIONE {{sezione.nome}}**
> {{sede.nome}} · Aggiornato al {{data_oggi}}
>
> | Cognome e nome | Genitori (in ordine di chiamata) | Altri contatti autorizzati | Pediatra | Note sanitarie rilevanti |
> |---|---|---|---|---|
>
> Numeri utili: 118 · `{{sede.telefono}}` · Direzione `{{direzione.telefono}}`

Si alimenta dai contatti d'emergenza raccolti con la
[05 — scheda sanitaria](05-scheda-sanitaria.md). Le «note sanitarie rilevanti» sono solo quelle che
servono in emergenza — allergia grave, epilessia, terapia salvavita — **non** l'intera anamnesi.

---

## Le regole comuni ai tre

1. **Sono PDF da stampare, non documenti archiviati.** Non entrano in `student_documents`, non si
   protocollano, non si firmano.
2. **Ogni generazione è tracciata** in `fascicolo_accessi_audit`: chi ha stampato l'elenco di quale
   sezione e quando. Un foglio con nomi, allergie e telefoni di venti bambini è un'estrazione di
   dati personali, anche se serve a lavorare.
3. **Filigrana con data e nome di chi ha stampato** su ogni pagina. Se un foglio finisce dove non
   deve, si sa da dove viene.
4. **Chi può stamparle**: la segreteria per le proprie sedi, l'insegnante solo per le proprie
   sezioni. La cucina riceve la 49.b dalla segreteria, non ha accesso all'app.
5. **Il contenuto non si logga**: nel log finiscono sezione, sede, numero di righe. Mai i nomi, mai
   gli allergeni.
