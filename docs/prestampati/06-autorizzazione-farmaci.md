# 06 — Autorizzazione alla somministrazione di farmaci

**Compila** il genitore, da `/parent` · **Firma** OTP del genitore **+ accettazione della Direzione**
**Archivia** `student_documents.document_type = 'autorizzazione_farmaci'`
**Fonte** `prestampato-02-autorizzazione-farmaci_iscrizioni_2026-07_TUTTE-LE-SEDI.docx` — testo invariato
**⚠️ Art. 9 GDPR**: dati sanitari di un minore.

---

## Testo del modello

> **AUTORIZZAZIONE ALLA SOMMINISTRAZIONE DI FARMACI**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> **DATI DELL'ALUNNO/A** — *nucleo comune*
>
> **GENITORE/TUTORE RICHIEDENTE**
> Cognome e nome: `{{genitore.nome_completo}}` · Telefono: `{{genitore.telefono}}`
>
> **DATI DELLA TERAPIA FARMACOLOGICA**
> Nome del farmaco: `[FARMACO: testo]`
> Dosaggio: `[DOSAGGIO: testo]` · Modalità di somministrazione: `[MODALITA: testo]`
> Orario/frequenza: `[ORARIO: testo]`
> Durata del trattamento: dal `[DAL: data]` al `[AL: data]`
> ☐ Si allega prescrizione medica / piano terapeutico del pediatra (obbligatorio) → `[PRESCRIZIONE: file]`
>
> Il/La sottoscritto/a, genitore/tutore dell'alunno/a sopra indicato/a, autorizza il personale
> della scuola a somministrare il farmaco sopra descritto secondo le indicazioni fornite dal
> pediatra, sollevando la scuola e il personale incaricato da ogni responsabilità per le
> conseguenze derivanti da una corretta somministrazione conforme alla prescrizione medica
> allegata.
>
> **REGISTRO DI SOMMINISTRAZIONE**
> | Data | Ora | Dose somministrata | Firma operatore |
> |---|---|---|---|
> *(20 righe vuote nel cartaceo → in app diventa un registro digitale, vedi sotto)*
>
> `{{luogo_data}}` — Firma del genitore/tutore: *firmato con OTP il {{firma.timestamp}}*
>
> **PER ACCETTAZIONE — LA DIREZIONE**
> Nome: `{{direzione.nome}}` · Data e firma: `{{accettazione.timestamp}}`

---

## Il form chiede

| Campo | Tipo | Obbligatorio |
|---|---|---|
| Nome del farmaco | testo | sì |
| Dosaggio | testo | sì |
| Modalità di somministrazione | testo | sì |
| Orario / frequenza | testo | sì |
| Durata: dal — al | date | sì |
| Prescrizione medica / piano terapeutico | upload PDF o foto | **sì, bloccante** |

## Il registro di somministrazione

Nel cartaceo sono venti righe da riempire a penna. In app diventa una **tabella collegata**: ogni
dose registrata dall'operatore (data, ora, dose, chi — da `utenti`) si aggiunge, e il PDF si
rigenera con le righe già compilate. È la parte che su carta non funziona mai, perché il foglio è
nel raccoglitore e l'educatrice è in sezione.

Conseguenze pratiche:

- l'insegnante vede l'autorizzazione attiva nella scheda del bambino, con il pulsante «registra
  somministrazione»;
- il genitore vede in tempo reale che la dose è stata data;
- quando `AL` è passato, l'autorizzazione scade da sola e sparisce dalla sezione.

## Dopo la firma

1. Lo stato è **`in_attesa_accettazione`** finché la Direzione non accetta: un'autorizzazione
   firmata dal solo genitore non abilita nessuno a somministrare niente.
2. All'accettazione → PDF in `student_documents`, `expiry_date = AL`.
3. La prescrizione allegata segue lo stesso bucket con oblio del certificato medico.
4. Alla scadenza, notifica al genitore: rinnova o archivia.
