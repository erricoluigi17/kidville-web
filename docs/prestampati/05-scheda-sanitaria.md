# 05 — Scheda sanitaria dell'alunno/a

**Compila** il genitore, da `/parent` · **Firma** OTP · **Archivia** `student_documents.document_type = 'scheda_sanitaria'`
**Fonte** `prestampato-01-scheda-sanitaria_iscrizioni_2026-07_TUTTE-LE-SEDI.docx` — testo invariato
**⚠️ Art. 9 GDPR**: dati sanitari di un minore. Bucket con oblio, mai nei log.

---

## Testo del modello

> **SCHEDA SANITARIA DELL'ALUNNO/A**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> **DATI DELL'ALUNNO/A**
> Sede: ☐ Kidville Cesa ☐ Kidville Aversa ☐ Kidville Giugliano → `{{sede.nome}}` già spuntata
> Cognome: `{{alunno.cognome}}` · Nome: `{{alunno.nome}}`
> Data di nascita: `{{alunno.data_nascita}}` · Luogo di nascita: `{{alunno.luogo_nascita}}`
> Sezione/Classe: `{{alunno.sezione}}` · Anno scolastico: `{{anno_scolastico}}`
>
> **DATI DEI GENITORI/TUTORI**
> Padre/Tutore – Cognome e nome: `{{genitore.padre.nome_completo}}` · Telefono: `{{genitore.padre.telefono}}`
> Madre/Tutrice – Cognome e nome: `{{genitore.madre.nome_completo}}` · Telefono: `{{genitore.madre.telefono}}`
> Email di riferimento: `{{genitore.email}}`
>
> **PEDIATRA DI RIFERIMENTO**
> Nome e cognome: `[PEDIATRA_NOME: testo]` · Telefono: `[PEDIATRA_TELEFONO: telefono]`
> ASL / Studio medico: `[ASL: testo]`
>
> **INFORMAZIONI SANITARIE**
> Allergie (alimentari, farmacologiche, da contatto, respiratorie): ☐ SÌ ☐ NO
> Se sì, specificare: `[ALLERGIE: testo lungo]` — *precompilato da `alunni.allergies`, modificabile*
> Intolleranze alimentari: ☐ SÌ ☐ NO — se sì: `[INTOLLERANZE: testo lungo]`
> Patologie croniche o condizioni particolari (asma, epilessia, diabete, cardiopatie, ecc.): ☐ SÌ ☐ NO
> Se sì, specificare: `[PATOLOGIE: testo lungo]`
> Terapie farmacologiche attualmente in corso: ☐ SÌ ☐ NO
> Se sì, farmaco / dosaggio / orario: `[TERAPIE: testo lungo]`
> Vaccinazioni aggiornate come da normativa vigente (L. 119/2017): ☐ SÌ ☐ NO
> Difficoltà motorie, sensoriali o utilizzo di ausili/dispositivi medici: ☐ SÌ ☐ NO
> Se sì, specificare: `[AUSILI: testo lungo]`
>
> **ALTRE INFORMAZIONI UTILI PER IL PERSONALE EDUCATIVO**
> `[NOTE_PERSONALE: testo lungo]`
>
> Il/La sottoscritto/a dichiara che le informazioni sopra riportate corrispondono al vero e si
> impegna a comunicare tempestivamente alla scuola qualsiasi variazione dello stato di salute
> del/la proprio/a figlio/a.
>
> I dati sopra riportati saranno trattati dalla scuola nel rispetto del Regolamento UE 2016/679
> (GDPR) esclusivamente per le finalità connesse alla tutela della salute, della sicurezza e della
> vita scolastica del minore.
>
> `{{luogo_data}}` — Firma del genitore/tutore: *firmato con OTP il {{firma.timestamp}}*

---

## Il form chiede

| Campo | Tipo | Obbligatorio | Poi diventa |
|---|---|---|---|
| Pediatra — nome e cognome | testo | sì | `alunni.pediatra_nome` |
| Pediatra — telefono | telefono | sì | `alunni.pediatra_telefono` |
| ASL / studio medico | testo | no | `alunni.asl` |
| Allergie | sì/no + testo | sì | aggiorna `alunni.allergies` |
| Intolleranze | sì/no + testo | sì | `alunni.intolleranze` |
| Patologie croniche | sì/no + testo | sì | `alunni.patologie` |
| Terapie in corso | sì/no + testo | sì | `alunni.terapie_in_corso` |
| Vaccinazioni aggiornate (L. 119/2017) | sì/no | sì | `alunni.vaccinazioni_aggiornate` |
| Ausili / difficoltà | sì/no + testo | sì | `alunni.ausili` |
| Note per il personale educativo | testo lungo | no | sul documento |
| **Contatti d'emergenza** | righe: nome, relazione, telefono, ordine | almeno 1 | tabella nuova |

I contatti d'emergenza non sono nel modulo cartaceo, ma sono il motivo per cui la scheda esiste:
senza, il documento è un archivio e non uno strumento. Vanno chiesti qui e mostrati
all'insegnante nella scheda del bambino, non solo nel PDF.

## Dopo la firma

1. PDF in `student_documents` con `document_type = 'scheda_sanitaria'`, `expiry_date` = fine anno
   scolastico (va riconfermata ogni anno).
2. I campi sanitari aggiornano l'anagrafica: la scheda **è** la fonte, non una copia.
3. La scheda precedente resta a storico, non si sovrascrive.
4. Se `ALLERGIE = SÌ`, l'app propone subito il [07 — dieta speciale](07-dieta-speciale.md).
   Se `TERAPIE = SÌ`, propone il [06 — autorizzazione farmaci](06-autorizzazione-farmaci.md).
