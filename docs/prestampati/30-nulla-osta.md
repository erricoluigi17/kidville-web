# 30 — Nulla osta al trasferimento

**Genera** la segreteria da `/admin` · **Firma** legale rappresentante · **Protocollo** in uscita
**Archivia** `student_documents.document_type = 'nulla_osta'`
**Fonte** `prestampato-10-nulla-osta_iscrizioni_2026-07_TUTTE-LE-SEDI.docx` + quanto già in app

---

## Cosa c'è già, e cosa manca

Il nulla osta è già generabile e protocollabile: `buildDocumentoRichiesta('nulla_osta', …)` in
`src/lib/protocolli/documenti.ts`, emesso da `/api/admin/protocolli/genera-documento`.

Il testo in app è però **più povero del modello cartaceo**. Gli mancano quattro elementi che in un
nulla osta non sono ornamentali:

| Elemento | In app | Nel modello |
|---|---|---|
| Codice fiscale dell'alunno | ✗ | ✓ |
| Luogo e data di nascita | ✗ | ✓ |
| Istituto di destinazione, con sede | ✗ (testo generico «presso altro istituto») | ✓ |
| Decorrenza del trasferimento | ✗ | ✓ |
| **Dichiarazione di regolarità amministrativa** | ✗ | ✓ |

L'ultima è quella che conta: la scuola che riceve il bambino legge il nulla osta per sapere se la
posizione è regolare. Senza quella riga, il documento non risponde alla domanda per cui viene
richiesto.

---

## Testo del modello

> **NULLA OSTA AL TRASFERIMENTO**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> Prot. n. `{{protocollo.numero}}` del `{{protocollo.data}}`
>
> Si dichiara che l'alunno/a `{{alunno.cognome}} {{alunno.nome}}`, nato/a a
> `{{alunno.luogo_nascita}}` il `{{alunno.data_nascita}}`, codice fiscale
> `{{alunno.codice_fiscale}}`, è stato/a regolarmente iscritto/a presso questa scuola alla
> classe/sezione `{{alunno.sezione}}` per l'anno scolastico `{{anno_scolastico}}`.
>
> Vista la richiesta della famiglia, si rilascia NULLA OSTA al trasferimento del/la suddetto/a
> alunno/a presso l'Istituto `[ISTITUTO: testo]`, con sede in `[SEDE_ISTITUTO: testo]`, a decorrere
> dal `[DECORRENZA: data]`.
>
> Si dichiara altresì che la posizione amministrativa dell'alunno/a risulta regolare a tutti gli
> effetti.
>
> Il presente nulla osta viene rilasciato per gli usi consentiti dalla legge.
>
> `{{luogo_data}}`
> Il Legale Rappresentante
> `{{scuola.legale_rappresentante}}`

---

## Il form chiede

| Campo | Tipo | Obbligatorio | Nota |
|---|---|---|---|
| Istituto di destinazione | testo | sì | precompilato dalla richiesta del genitore, se c'è |
| Sede dell'istituto | testo | sì | idem |
| Decorrenza del trasferimento | data | sì | idem |
| Posizione amministrativa regolare | conferma esplicita | sì | vedi sotto |

## La riga sulla regolarità va verificata, non stampata

«La posizione amministrativa risulta regolare a tutti gli effetti» è una dichiarazione del legale
rappresentante. L'app sa se è vera: i pagamenti insoluti sono in banca dati.

Quindi la schermata, prima di generare, **mostra il saldo**: se ci sono rate scadute, lo dice con
l'importo, e chiede una conferma consapevole. Non blocca — il nulla osta non si nega per morosità,
e negarlo esporrebbe la scuola — ma non lascia neanche firmare alla cieca una dichiarazione che
l'app sa essere falsa.

## La catena del trasferimento

Questo documento è il terzo di tre, e i tre vanno collegati fra loro:

1. [richiesta di nulla osta del genitore](README.md) — istanza firmata con OTP;
2. [31 — richiesta di disponibilità all'istituto terzo](31-richiesta-disponibilita.md) — lettera in
   uscita con tagliando di risposta;
3. **nulla osta** — si emette quando il tagliando torna confermato.

Il modulo cartaceo 07 lo dice a chiare lettere nel riquadro di segreteria: *«☐ Nulla osta concesso
☐ In attesa di verifica disponibilità presso la nuova scuola»*. È una macchina a stati, non tre
fogli separati.

## Dopo la generazione

1. Protocollo in uscita.
2. PDF in `student_documents` + copia al genitore (email + app).
3. L'alunno passa in stato `in_trasferimento` alla data di decorrenza — **non si cancella**:
   si archivia, con la disciplina già stabilita nel ciclo di vita dell'alunno.
