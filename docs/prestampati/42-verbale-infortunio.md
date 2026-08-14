# 42 — Verbale di infortunio e comunicazione alla famiglia

**Compila** l'educatrice che ha assistito · **Controfirma** la Direzione · **Riceve** il genitore
**Archivia** `student_documents.document_type = 'verbale_infortunio'` + registro infortuni di sede
**Fonte** ➕ **nuovo** — scritto sulla linea dei prestampati 01-06
**⚠️ Art. 9 GDPR**: dati sanitari di un minore.

Non esiste né su carta né in app. È il documento che manca con il rischio più concreto: oggi un
bambino che cade viene medicato e il genitore avvisato a voce, senza che resti traccia di cosa è
successo, quando, chi c'era e cosa è stato fatto.

---

## Testo del modello

> **VERBALE DI INFORTUNIO**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> Verbale n. `{{verbale.numero}}` del `{{verbale.data}}` · Prot. n. `{{protocollo.numero}}`
>
> **DATI DELL'ALUNNO/A**
> Sede: `{{sede.nome}}`
> Cognome: `{{alunno.cognome}}` · Nome: `{{alunno.nome}}`
> Data di nascita: `{{alunno.data_nascita}}` · Luogo di nascita: `{{alunno.luogo_nascita}}`
> Sezione/Classe: `{{alunno.sezione}}` · Anno scolastico: `{{anno_scolastico}}`
>
> **QUANDO E DOVE**
> Data: `[DATA: data]` · Ora: `[ORA: ora]`
> Luogo: ☐ Aula/sezione ☐ Giardino ☐ Palestra ☐ Refettorio ☐ Bagno ☐ Corridoio/scale
> ☐ Ingresso/uscita ☐ Fuori dalla struttura → `[LUOGO]`
> Attività in corso: `[ATTIVITA: testo]`
>
> **DINAMICA**
> `[DINAMICA: testo lungo]`
>
> **PERSONALE PRESENTE**
> Chi ha assistito: `{{operatore.nome_completo}}`
> Altro personale presente: `[ALTRO_PERSONALE: scelta multipla da utenti]`
> Altri bambini coinvolti: ☐ NO ☐ SÌ — *(i nomi non compaiono nel verbale consegnato alla
> famiglia: vedi nota sotto)*
>
> **LESIONE RILEVATA**
> Parte del corpo: ☐ Testa/viso ☐ Bocca/denti ☐ Occhi ☐ Arti superiori ☐ Arti inferiori
> ☐ Tronco ☐ Altro → `[PARTE_CORPO]`
> Tipo: ☐ Contusione ☐ Escoriazione ☐ Ferita ☐ Distorsione ☐ Sospetta frattura ☐ Trauma cranico
> ☐ Reazione allergica ☐ Altro → `[TIPO_LESIONE]`
> Descrizione: `[DESCRIZIONE_LESIONE: testo lungo]`
>
> **PRIMO SOCCORSO PRESTATO**
> ☐ Disinfezione ☐ Ghiaccio ☐ Medicazione ☐ Riposo e osservazione ☐ Nessuno necessario
> ☐ Altro → `[PRIMO_SOCCORSO]`
> Prestato da: `[SOCCORRITORE: scelta da utenti]` — *addetto al primo soccorso: `{{operatore.abilitato}}`*
> Ora del soccorso: `[ORA_SOCCORSO: ora]`
>
> **PROVVEDIMENTI**
> ☐ Rientro in sezione ☐ Osservazione prolungata ☐ Ritiro anticipato da parte della famiglia
> ☐ Accompagnamento al pronto soccorso ☐ Chiamata al 118
> Se 118 o pronto soccorso — ora della chiamata: `[ORA_118: ora]`
>
> **COMUNICAZIONE ALLA FAMIGLIA**
> Avvisata alle ore: `[ORA_AVVISO: ora]` · Modalità: ☐ Telefono ☐ App ☐ Di persona all'uscita
> Genitore contattato: `{{genitore.nome_completo}}` — `{{genitore.telefono}}`
>
> **NOTE PER LA FAMIGLIA**
> `[NOTE_FAMIGLIA: testo lungo]`
>
> Il presente verbale è redatto dal personale presente al momento dell'evento e non costituisce
> diagnosi medica. In caso di persistenza o peggioramento dei sintomi si invita a rivolgersi al
> pediatra o alla struttura sanitaria competente.
>
> `{{luogo_data}}`
> L'operatore che ha redatto: `{{operatore.nome_completo}}` — *firmato il {{firma.timestamp}}*
> La Direzione: `{{direzione.nome}}` — *controfirmato il {{controfirma.timestamp}}*
>
> **PRESA VISIONE DELLA FAMIGLIA**
> `{{presa_visione.timestamp}}` — *firmato con OTP*

---

## Il flusso, che è la parte importante

Un verbale che si scrive la sera non serve. Va scritto **mentre succede**, dal telefono, in
sezione:

1. **L'educatrice apre il verbale** dalla scheda del bambino. Data, ora, sede, sezione, chi
   redige: già compilati. Restano luogo, dinamica, lesione, soccorso — a caselle, non a testo
   libero, così si compila in due minuti.
2. **Il genitore viene avvisato dall'app nello stesso momento**, con una notifica che dice cosa è
   successo e cosa è stato fatto. È la parte che oggi manca e che le famiglie chiedono: sapere
   subito, non all'uscita.
3. **La Direzione controfirma** entro la giornata. Un verbale non controfirmato resta in evidenza.
4. **Il genitore firma la presa visione con OTP**. Non è un'ammissione di responsabilità né una
   liberatoria: è la prova che l'informazione è arrivata.

## Nomi di altri bambini: mai nel verbale consegnato

Se un altro bambino è coinvolto, il fatto si registra ma **il nome non compare nel PDF che va alla
famiglia**. Resta nel verbale interno, accessibile alla sola Direzione. Consegnare a una famiglia
un documento con il nome del figlio di un'altra, insieme alla dinamica di un incidente, è una
comunicazione di dati personali di un minore a un terzo non autorizzato.

Stessa disciplina per i log: del verbale si loggano id, sede, tipo di lesione e provvedimento —
mai la dinamica, mai i nomi.

## Il registro infortuni

I verbali di una sede compongono il **registro infortuni**, che è un documento con vita propria:
si consulta per anno, si esporta per l'assicurazione, e le sue statistiche dicono cose che i
singoli fogli non dicono — che in quel corridoio si cade tre volte al mese, che gli incidenti si
concentrano nella mezz'ora dopo il pranzo.

Serve anche per una ragione pratica: la denuncia all'assicurazione ha termini stretti, e oggi
nessuno sa quali infortuni sono avvenuti la settimana scorsa senza chiedere alle educatrici.

## Dopo la firma

1. PDF in `student_documents`, senza scadenza. Un infortunio non scade.
2. Copia al genitore: app + email.
3. Se il provvedimento è pronto soccorso o 118, il verbale entra in evidenza sul cruscotto della
   Direzione e **non si chiude** finché non è registrato l'esito.
4. Se il bambino ha una scheda sanitaria con patologie o allergie, il verbale la riporta in testa:
   chi soccorre deve saperlo prima, non dopo.
