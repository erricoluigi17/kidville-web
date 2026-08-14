# 07 — Richiesta dieta speciale / intolleranze alimentari

**Compila** il genitore, da `/parent` · **Firma** OTP · **Archivia** `student_documents.document_type = 'dieta_speciale'`
**Fonte** `prestampato-03-dieta-speciale_iscrizioni_2026-07_TUTTE-LE-SEDI.docx` — testo invariato
**⚠️ Art. 9 GDPR** quando il motivo è sanitario.

---

## Testo del modello

> **RICHIESTA DIETA SPECIALE / INTOLLERANZE ALIMENTARI**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> **DATI DELL'ALUNNO/A** — *nucleo comune*
>
> **MOTIVO DELLA RICHIESTA**
> ☐ Allergia alimentare ☐ Intolleranza alimentare ☐ Motivi etico-religiosi
> ☐ Scelta alimentare (vegetariana/vegana) ☐ Altro
> Se altro, specificare: `[ALTRO_MOTIVO: testo]`
>
> **ALIMENTI DA ESCLUDERE E SOSTITUZIONI PROPOSTE**
> | Alimento da escludere | Sostituzione proposta |
> |---|---|
> | `[ALIMENTO: testo]` | `[SOSTITUZIONE: testo]` |
> *(righe ripetibili — 12 nel cartaceo)*
>
> **CERTIFICAZIONE MEDICA**
> ☐ Si allega certificato medico → `[CERTIFICATO: file]`
> Redatto dal Dott./Dott.ssa: `[MEDICO: testo]` · In data: `[DATA_CERTIFICATO: data]`
> Validità del certificato: `[VALIDITA: data o testo]`
>
> Il/La sottoscritto/a chiede che al/alla proprio/a figlio/a venga garantita la dieta sopra
> indicata e dichiara che le informazioni fornite corrispondono al vero.
>
> `{{luogo_data}}` — Firma del genitore/tutore: *firmato con OTP il {{firma.timestamp}}*
>
> **RISERVATO A SEGRETERIA/CUCINA**
> Preso in carico il: `{{presa_in_carico.data}}` da: `{{presa_in_carico.utente}}`

---

## Il form chiede

| Campo | Tipo | Obbligatorio | Nota |
|---|---|---|---|
| Motivo | scelta singola (5 voci) | sì | governa il resto |
| Se «Altro», specificare | testo | condizionale | |
| Alimenti da escludere → sostituzione | righe ripetibili | almeno 1 | precompilate da `alunni.allergeni` |
| Certificato medico | upload | **sì se il motivo è sanitario**, no se etico-religioso o scelta alimentare | |
| Medico redattore | testo | condizionale | |
| Data e validità del certificato | date | condizionale | diventa `expiry_date` |

La distinzione fra motivo sanitario e non sanitario non è formale: cambia **cosa è obbligatorio** e
**quale base giuridica** regge il trattamento. Una dieta vegetariana non richiede un certificato
medico, e chiederlo sarebbe una raccolta di dati non necessaria.

## Dopo la firma

1. PDF in `student_documents`, `expiry_date` = validità del certificato (o fine anno se assente).
2. **La richiesta entra in cucina, non solo nel fascicolo**: la dieta va collegata al gruppo mensa
   (`alunni.gruppo_mensa_id`) e comparire nella [stampa allergie di sezione](49-stampe-di-sezione.md).
   Un modulo firmato che la cuoca non vede è carta.
3. La presa in carico da parte di segreteria/cucina è un'azione tracciata, non una casella: finché
   non avviene, la richiesta resta in stato `da_prendere_in_carico` e il genitore lo vede.
4. Alla scadenza del certificato, notifica al genitore e alla cucina.
