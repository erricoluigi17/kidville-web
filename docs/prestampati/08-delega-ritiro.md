# 08 — Delega al ritiro dell'alunno/a

**Compila** il genitore, da `/parent` · **Firma** OTP di **entrambi** i genitori/tutori
**Archivia** `student_documents.document_type = 'delega_ritiro'`
**Fonte** `prestampato-04-delega-ritiro_iscrizioni_2026-07_TUTTE-LE-SEDI.docx` — testo invariato

Incorpora anche l'**autorizzazione al prelievo** (fino a 3 nominativi) che nel cartaceo sta dentro
la domanda di iscrizione: è lo stesso atto, non due.

---

## Testo del modello

> **DELEGA AL RITIRO DELL'ALUNNO/A**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> **DATI DELL'ALUNNO/A** — *nucleo comune*
>
> **GENITORI/TUTORI DELEGANTI**
> Cognome e nome (1): `{{genitore.1.nome_completo}}` · Telefono: `{{genitore.1.telefono}}`
> Cognome e nome (2): `{{genitore.2.nome_completo}}` · Telefono: `{{genitore.2.telefono}}`
>
> I sottoscritti, genitori/tutori dell'alunno/a sopra indicato/a, dichiarano di delegare al ritiro
> del/la proprio/a figlio/a da scuola le seguenti persone, assumendosene piena responsabilità:
>
> **PERSONE DELEGATE**
> | Cognome e nome | Relazione con il bambino/a | Documento d'identità (tipo e n.) |
> |---|---|---|
> | `[DELEGATO_NOME]` | `[DELEGATO_RELAZIONE]` | `[DELEGATO_DOCUMENTO]` |
> *(righe ripetibili — 5 nel cartaceo)*
>
> **VALIDITÀ DELLA DELEGA**
> ☐ Permanente (fino a revoca scritta) ☐ Periodo specifico ☐ Occasione specifica
> Dal: `[DAL: data]` · Al / In data: `[AL: data]`
>
> I sottoscritti si assumono ogni responsabilità civile e penale derivante dal ritiro del minore da
> parte delle persone sopra delegate ed esonerano la scuola da ogni responsabilità al riguardo.
>
> `{{luogo_data}}`
> Firma di entrambi i genitori/tutori:
> 1) *firmato con OTP il {{firma.1.timestamp}}*
> 2) *firmato con OTP il {{firma.2.timestamp}}*

---

## Il form chiede

| Campo | Tipo | Obbligatorio | Nota |
|---|---|---|---|
| Persone delegate | righe: nome, relazione, tipo+n. documento | almeno 1 | **precompilate da `delegates`** |
| Documento del delegato | upload foto/scansione | sì | `delegates.document_url` esiste già |
| Validità | permanente / periodo / occasione | sì | |
| Dal — Al | date | condizionale | diventa `expiry_date` |

La tabella `delegates` esiste già in produzione (`student_id, first_name, last_name, relation,
document_number, document_url`): il form la mostra precompilata e il genitore aggiunge o toglie
righe. Il modulo firmato è **la prova** di ciò che l'app già mostra; oggi l'app ha i dati senza
l'atto che li autorizza.

## Le due firme

È l'unico modulo che il cartaceo fa firmare a **entrambi** i genitori, e ha ragione: delegare un
terzo al ritiro di un minore non è un atto che un solo genitore compie da solo. In app:

1. il primo genitore compila e firma con OTP;
2. il secondo riceve una notifica e firma con il proprio OTP;
3. il PDF si genera **solo dopo la seconda firma** e riporta entrambe le tracce.

Se il secondo genitore è assente dall'anagrafica (famiglia con un solo tutore, `student_parents`
con una riga sola), la seconda firma non si chiede e il PDF lo dichiara esplicitamente.
Se i genitori sono separati (`alunni.genitori_separati`), la doppia firma resta obbligatoria.

## Dopo la firma

1. PDF in `student_documents`, `expiry_date` = `AL` per le deleghe a termine.
2. I delegati diventano attivi in `delegates` — **non prima**.
3. Alla scadenza i delegati a termine si disattivano da soli.
4. La revoca è un nuovo modulo firmato, non una cancellazione silenziosa: la delega precedente
   resta a storico con la data di revoca.
