# 28 — Certificato di iscrizione e frequenza — NIDO (Bonus Asilo Nido INPS)

**Genera** la segreteria · **e lo riceve il genitore in automatico** (richiesta di Luigi)
**Firma** legale rappresentante · **Protocollo** in uscita · **Archivia** `student_documents.document_type = 'certificato_bonus_nido'`
**Fonte** `prestampato-12-certificato-nido-bonus_iscrizioni_2026-07_TUTTE-LE-SEDI.docx` — testo invariato

---

## Testo del modello

> **CERTIFICATO DI ISCRIZIONE E FREQUENZA — NIDO**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
> *(per la richiesta del Bonus Asilo Nido INPS)*
>
> Prot. n. `{{protocollo.numero}}` del `{{protocollo.data}}`
>
> Sede del Nido: ☐ Kidville Cesa ☐ Kidville Aversa ☐ Kidville Giugliano → `{{sede.nome}}`
>
> Visti gli atti d'ufficio, si certifica che il/la bambino/a `{{alunno.cognome}} {{alunno.nome}}`,
> nato/a a `{{alunno.luogo_nascita}}` il `{{alunno.data_nascita}}`, codice fiscale
> `{{alunno.codice_fiscale}}`, è regolarmente iscritto/a e frequenta con assiduità, per l'anno
> scolastico `{{anno_scolastico}}`, il Nido d'Infanzia gestito da questa scuola.
>
> Il presente certificato viene rilasciato per gli usi consentiti dalla legge, ivi compresa la
> richiesta del Bonus Asilo Nido INPS.
>
> **DATI IDENTIFICATIVI DELLA STRUTTURA**
> Denominazione: `{{scuola.ragione_sociale}}`
> P.IVA/C.F.: `{{scuola.piva}}`
> Sede legale: `{{scuola.sede_legale}}`
> Sede operativa del Nido: `{{sede.indirizzo_completo}}`
> Autorizzazione al funzionamento: N. `{{sede.autorizzazione.numero}}` del
> `{{sede.autorizzazione.data}}` rilasciata dal Comune di `{{sede.autorizzazione.comune}}`
>
> `{{luogo_data}}`
> Il Legale Rappresentante
> `{{scuola.legale_rappresentante}}`

---

## Gli estremi dell'autorizzazione: uno per sede

Sono l'unico dato che il certificato porta e che nessun altro documento ha. Vanno in
`scuole.config.anagrafica.autorizzazione_nido` — **uno per ciascuna delle tre sedi**, perché sono
tre autorizzazioni comunali diverse, con numeri, date e Comuni diversi. Cablarne una sola in
codice significa emettere due certificati su tre con gli estremi sbagliati.

I valori vivono nella configurazione di sede, non qui: il repository è pubblico.

## Disponibile al genitore, in automatico

Nella scheda «Certificati» di `/parent/modulistica`, accanto a iscrizione e frequenza, compare
**solo per i bambini del nido**. Il genitore lo scarica quando vuole, senza chiederlo a nessuno.

Perché sia possibile servono tre condizioni, e vanno verificate dalla route, non date per scontate:

1. il bambino è iscritto a un **servizio 0-3** (nido 1° o 2° anno) nell'anno in corso — la sezione
   primavera **non** dà diritto al Bonus Asilo Nido, e un certificato emesso per un bambino della
   primavera è una dichiarazione falsa a un ente pubblico;
2. la sede ha gli estremi dell'autorizzazione in configurazione — **se mancano, il pulsante non
   compare**, invece di produrre un certificato con `N. ______ del ______`;
3. il bambino è attivo, non archiviato né anonimizzato.

## L'invio automatico

Oltre al download su richiesta, il certificato parte da solo:

- **a inizio anno scolastico**, quando la frequenza è avviata, a tutte le famiglie del nido;
- **a gennaio**, quando si aprono le domande INPS per l'anno solare, che è il momento in cui le
  famiglie lo cercano davvero.

Email con PDF allegato + notifica push, un log di successo per invio (regola 5 del logging: senza,
«nessun log» non distingue «tutto ok» da «non è partito niente» — è esattamente ciò che ha
nascosto il guasto delle email per mesi).

## Dopo la generazione

1. Protocollo in uscita, uno per certificato emesso.
2. PDF in `student_documents`, senza scadenza (vale per l'anno scolastico che dichiara).
3. Il certificato attesta **l'iscrizione e la frequenza**, non gli importi pagati: per quelli c'è
   l'attestazione spese detraibili, che è un altro documento e già esiste.
