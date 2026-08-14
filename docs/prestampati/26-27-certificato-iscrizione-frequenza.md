# 26-27 — Certificato di iscrizione e frequenza

**Genera** la segreteria da `/admin` · **oppure** il genitore da sé (self-service, già attivo)
**Firma** legale rappresentante · **Protocollo** in uscita · **Archivia** `student_documents.document_type = 'certificato_iscrizione_frequenza'`
**Fonte** `prestampato-11-certificato-iscrizione-frequenza_…docx` + quanto già in app

---

## Cosa c'è già, e cosa cambia

In app esistono due certificati distinti — iscrizione e frequenza — generati da
`src/lib/certificati/self-service.ts`, scaricabili dal genitore e protocollabili dalla segreteria
via `src/lib/protocolli/documenti.ts`.

Il modello cartaceo è **uno solo e li unisce** («è regolarmente iscritto/a *e* frequenta con
assiduità»), e porta tre cose che la versione in app non ha:

1. il blocco **DATI IDENTIFICATIVI DELLA SCUOLA** con denominazione, P.IVA e sede legale — che è
   ciò che rende il certificato spendibile davanti a un ente;
2. il campo **Livello** (Nido / Infanzia / Primaria);
3. la dicitura **«in carta libera»**, che dichiara l'esenzione dal bollo.

Vanno aggiunte al generatore esistente. Il testo del corpo resta quello di
`buildCertificatoBody()`, che è già corretto e già degrada bene quando la sezione manca.

---

## Testo del modello

> **CERTIFICATO DI ISCRIZIONE E FREQUENZA**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> Prot. n. `{{protocollo.numero}}` del `{{protocollo.data}}`
>
> Sede: ☐ Kidville Cesa ☐ Kidville Aversa ☐ Kidville Giugliano → `{{sede.nome}}`
>
> Visti gli atti d'ufficio, si certifica che l'alunno/a `{{alunno.cognome}} {{alunno.nome}}`,
> nato/a a `{{alunno.luogo_nascita}}` il `{{alunno.data_nascita}}`, codice fiscale
> `{{alunno.codice_fiscale}}`, è regolarmente iscritto/a e frequenta con assiduità, per l'anno
> scolastico `{{anno_scolastico}}`, questa scuola, sezione/classe `{{alunno.sezione}}`.
>
> Livello: ☐ Nido ☐ Scuola dell'Infanzia ☐ Scuola Primaria → `{{alunno.livello}}`
>
> Il presente certificato viene rilasciato, in carta libera, per gli usi consentiti dalla legge.
>
> **DATI IDENTIFICATIVI DELLA SCUOLA**
> Denominazione: `{{scuola.ragione_sociale}}`
> P.IVA/C.F.: `{{scuola.piva}}`
> Sede legale: `{{scuola.sede_legale}}`
>
> `{{luogo_data}}`
> Il Legale Rappresentante
> `{{scuola.legale_rappresentante}}`

---

## Il form chiede

Nulla, quando lo genera il genitore. Alla segreteria chiede soltanto:

| Campo | Tipo | Obbligatorio |
|---|---|---|
| Uso dichiarato | testo | no — se valorizzato compare in calce |
| Numero di copie | numero | no |
| Consegna | a mano / email | no |

Sono i tre campi del [prestampato 08 «richiesta certificato»](README.md), che come modulo separato
non serve più: il genitore che vuole il certificato se lo scarica, non lo chiede. Restano qui come
opzioni di chi lo rilascia allo sportello.

## Firma e protocollo — il blocco che rende il certificato spendibile

Impaginazione e misure in **[00 — impaginazione](00-impaginazione.md)**, §4. In sintesi, tre cose
che viaggiano insieme e non si sostituiscono a vicenda:

1. **Prot. n. …/… del …** in testa, sotto l'intestazione di sede. Il numero si consuma solo quando
   emette la segreteria: la copia che il genitore scarica da sé porta al suo posto
   *«Copia a uso della famiglia — non protocollata»*. Due fogli che si somigliano ma valgono cose
   diverse devono dirlo, o il primo finisce a un ente al posto del secondo.
2. **Sottoscrizione del legale rappresentante**, nella forma che la Scuola già usa:

   > IL LEGALE RAPPRESENTANTE
   > **Errico Cesario**
   > *Firma autografa sostituita a mezzo stampa*
   > *ai sensi dell'art. 3, c. 2 D.Lgs n. 39/93*

   **Nessuna immagine di firma**: quella dicitura è precisamente la norma che sostituisce il tratto
   autografo con il nominativo a stampa — stamparli insieme sarebbe una contraddizione. E una firma
   scansionata dentro PDF che escono a centinaia di famiglie è estraibile e riusabile su qualunque
   altro foglio: non metterla è un rischio che non si corre. Il nome viene da
   `{{scuola.legale_rappresentante}}` (configurazione di sede, mai cablato: il repo è pubblico e il
   CdA cambia); la dicitura è una costante di legge e sta nel codice.
3. **Blocco di verifica** in fondo: numero di protocollo, **impronta SHA-256** del PDF (la stessa
   che finisce in `protocolli.impronta_sha256`, colonna già esistente) e l'indirizzo dove
   confrontarli. È ciò che rende il certificato verificabile da chi lo riceve.

⚠️ Le due formule si escludono: o «firma autografa sostituita a mezzo stampa», o «firmato
digitalmente ai sensi del CAD». **Mai entrambe**, e la seconda solo il giorno in cui esistesse una
firma qualificata vera — che oggi non c'è. Dettagli e limiti in
[00 — impaginazione](00-impaginazione.md), §4.4.

## Dopo la generazione

1. Numero di protocollo **solo quando lo emette la segreteria**. Il certificato self-service del
   genitore non consuma numerazione: è una copia conforme a uso della famiglia.
2. PDF in `student_documents`, senza scadenza.
3. Il livello (Nido/Infanzia/Primaria) si deduce dalla sezione: se la sezione manca, il campo si
   omette invece di indovinare — stessa disciplina di degrado già usata da `buildCertificatoBody()`.
4. Un alunno archiviato o anonimizzato non produce certificati: la route deve rifiutare, non
   stampare un foglio con i campi vuoti.
