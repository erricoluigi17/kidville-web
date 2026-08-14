# 10 — Autorizzazione a uscite didattiche / gite / attività esterne

**Compila** il genitore, da `/parent` · **Firma** OTP · **Archivia** `student_documents.document_type = 'autorizzazione_uscita'`
**Fonte** `prestampato-06-autorizzazione-uscite_iscrizioni_2026-07_TUTTE-LE-SEDI.docx` — testo invariato

> **Si genera da solo a ogni nuova gita.** La segreteria crea l'evento una volta; l'app produce
> un'autorizzazione per ciascun bambino della sezione, la manda ai genitori e tiene il conto di
> chi ha firmato. Nessuno stampa nulla, nessuno rincorre nessuno.

---

## Testo del modello

> **AUTORIZZAZIONE A USCITE DIDATTICHE / GITE / ATTIVITÀ ESTERNE**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> **DATI DELL'ALUNNO/A** — *nucleo comune*
>
> **DESCRIZIONE DELL'ATTIVITÀ** — *tutta precompilata dall'evento creato dalla segreteria*
> Tipo di attività: ☐ Uscita didattica ☐ Gita ☐ Laboratorio esterno ☐ Corso di piscina/nuoto ☐ Altro
> → `{{uscita.tipo}}`
> Destinazione: `{{uscita.destinazione}}`
> Data: `{{uscita.data}}` · Orario partenza: `{{uscita.ora_partenza}}` · Orario rientro previsto: `{{uscita.ora_rientro}}`
> Mezzo di trasporto: ☐ Scuolabus ☐ Pullman privato ☐ A piedi ☐ Altro → `{{uscita.mezzo}}`
>
> Per attività in acqua: il/la bambino/a sa nuotare ☐ SÌ ☐ NO → `[SA_NUOTARE: sì/no]`
>
> Si ricorda di segnalare eventuali informazioni sanitarie rilevanti già indicate nella scheda
> sanitaria dell'alunno/a.
>
> Il/La sottoscritto/a autorizza il/la proprio/a figlio/a a partecipare all'attività sopra
> descritta, sollevando la scuola da responsabilità per fatti non imputabili a negligenza del
> personale.
>
> Recapito telefonico reperibile durante l'uscita: `[RECAPITO: telefono]` — *precompilato con `{{genitore.telefono}}`*
>
> `{{luogo_data}}` — Firma del genitore/tutore: *firmato con OTP il {{firma.timestamp}}*

---

## La segreteria crea l'uscita, una volta

| Campo dell'evento | Tipo | Obbligatorio |
|---|---|---|
| Tipo di attività | 5 voci del cartaceo | sì |
| Destinazione | testo | sì |
| Data | data | sì |
| Orario partenza / rientro previsto | ora | sì |
| Mezzo di trasporto | 4 voci del cartaceo | sì |
| Sezioni coinvolte | multi-scelta | sì |
| Attività in acqua | sì/no | sì — se sì, attiva la domanda «sa nuotare» |
| Quota di partecipazione | importo | no — se valorizzata, genera il pagamento |
| Termine per autorizzare | data | sì |

## Il genitore risponde in due campi

Nome, sezione, destinazione, orari e mezzo sono già scritti. Al genitore restano:

| Campo | Tipo | Obbligatorio |
|---|---|---|
| Sa nuotare | sì/no | solo per attività in acqua |
| Recapito reperibile durante l'uscita | telefono | sì, precompilato e modificabile |
| Autorizzo / non autorizzo | scelta | sì |

Un'autorizzazione che si firma in due tocchi viene firmata. Una da stampare, compilare a penna e
riportare a scuola torna indietro nel 60% dei casi, e il giorno della gita la segreteria telefona.

## Il cruscotto della gita

Creata l'uscita, la segreteria vede una schermata sola: **quanti hanno firmato, chi manca, chi ha
negato**. Da lì un sollecito con un tocco, alla scadenza del termine. Il giorno dell'uscita,
l'insegnante ha l'elenco dei partecipanti autorizzati sul telefono, con i recapiti reperibili e le
informazioni sanitarie rilevanti — che è il momento in cui quel foglio serve davvero.

## Dopo la firma

1. PDF per bambino in `student_documents`, `expiry_date` = data dell'uscita.
2. Chi non ha firmato entro il termine **non è nell'elenco dei partecipanti**. Nessuna eccezione
   verbale: se il genitore autorizza fuori tempo, firma comunque in app e l'elenco si aggiorna.
3. Se l'uscita ha una quota, la firma genera il pagamento collegato.
4. Uscita annullata → le autorizzazioni si archiviano con la motivazione, non spariscono.
