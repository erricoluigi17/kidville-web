# 09 — Richiesta di permesso: entrata posticipata / uscita anticipata

**Compila** il genitore, da `/parent` · **Firma** OTP · **Archivia** `student_documents.document_type = 'permesso_orario'`
**Fonte** `prestampato-05-permesso-entrata-uscita_iscrizioni_2026-07_TUTTE-LE-SEDI.docx` — testo invariato

---

## Testo del modello

> **RICHIESTA DI PERMESSO — ENTRATA POSTICIPATA / USCITA ANTICIPATA**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> **DATI DELL'ALUNNO/A** — *nucleo comune*
>
> Data della richiesta: `{{data_oggi}}`
>
> **TIPO DI PERMESSO**
> ☐ Entrata posticipata — Orario previsto di arrivo: `[ORA_ARRIVO: ora]`
> ☐ Uscita anticipata — Orario previsto di uscita: `[ORA_USCITA: ora]`
>
> Motivo (facoltativo): `[MOTIVO: testo]`
>
> Persona che accompagna/ritira il bambino, se diversa dal genitore (allegare delega):
> `[ACCOMPAGNATORE: scelta fra i delegati attivi]`
>
> `{{luogo_data}}` — Firma del genitore/tutore: *firmato con OTP il {{firma.timestamp}}*
>
> **PRESA VISIONE — EDUCATRICE/SEGRETERIA**
> Data e firma: `{{presa_visione.timestamp}} — {{presa_visione.utente}}`

---

## Il form chiede

| Campo | Tipo | Obbligatorio | Nota |
|---|---|---|---|
| Giorno del permesso | data | sì | non nel cartaceo, che assume «oggi»: in app va detto |
| Tipo | entrata posticipata / uscita anticipata / entrambe | sì | |
| Orario | ora | sì | |
| Motivo | testo | no | resta facoltativo, come sul cartaceo |
| Chi accompagna o ritira | scelta fra i delegati attivi + «io stesso» | sì per l'uscita | da `delegates` |
| Permesso ricorrente | no / tutti i `[giorni]` fino al `[data]` | no | |

Il campo «ricorrente» non è sul cartaceo perché su carta si ricompila il foglio ogni volta. In app
è la differenza fra un modulo e uno strumento: la terapia settimanale, il fratello da prendere a
scuola, l'orario ridotto dell'inserimento sono situazioni che durano mesi.

**Se l'accompagnatore non è fra i delegati attivi**, il form non lascia scrivere un nome libero:
rimanda al [08 — delega al ritiro](08-delega-ritiro.md). Sul cartaceo c'è scritto «allegare
delega» e nessuno la allega mai.

## Dopo la firma

1. Il permesso compare **nel registro presenze del giorno**, davanti all'educatrice, prima che il
   bambino arrivi o esca. È lì che serve, non nel fascicolo.
2. La presa visione dell'educatrice è un'azione tracciata (chi, quando).
3. PDF in `student_documents` a fine giornata, `expiry_date` = giorno del permesso (o fine
   ricorrenza).
4. L'uscita anticipata comunicata qui **non conta come assenza** nel conteggio mensile.
