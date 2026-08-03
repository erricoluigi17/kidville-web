# Informativa tardiva alle famiglie che si sono pre-iscritte prima del 30 luglio

> **Stato: PRONTO, NON INVIATO.** Serve una decisione del titolare del trattamento.
> Nessuna email è stata spedita. Questo documento contiene solo conteggi: nessun
> indirizzo, nessun nome, nessun dato di una famiglia.

Rilievo `T06-F5` del collaudo del 2026-08-03.

## Il fatto

Il modulo pubblico di pre-iscrizione riceve domande dal **2026-07-16**. La
registrazione dell'accettazione dell'informativa privacy è arrivata solo il
**2026-07-30** (PR #61).

Nel mezzo, le famiglie hanno compilato un modulo che chiedeva — e conserva — il nome e
il codice fiscale del bambino, la data di nascita, la residenza, **allergie e note
mediche in testo libero**, il documento d'identità del minore e quello degli adulti,
senza che venisse mostrata loro l'informativa e senza che venisse raccolto un consenso
documentabile.

La colonna `enrollment_submissions.raccolta_senza_informativa` le marca (migrazione
`20260731165941`), quindi si riconoscono con certezza.

## La misura, al 2026-08-03

| | |
|---|---|
| domande interessate | **93** |
| ancora in attesa (`pending`) | 90 |
| già accolte (`approved`) | 3 |
| respinte | 0 |
| periodo | dal **2026-07-16** al **2026-07-31** |
| indirizzi email distinti | **119** (una domanda può indicare due adulti) |

## Perché è una cosa da fare, e non solo da annotare

Gli art. 13 e 14 GDPR non chiedono un consenso: chiedono che l'interessato **sappia**.
Quelle 93 famiglie non hanno mai ricevuto le informazioni su chi tratta i dati del loro
bambino, per quali finalità, per quanto tempo e come si esercitano i diritti. Il dato
è stato raccolto lo stesso, ed è ancora lì.

La decisione del titolare del 2026-07-31 è stata di **non perdere** quelle domande
(«sono genitori che hanno compilato… dovranno diventare effettivi»): è una scelta
legittima, ma non sostituisce l'informazione — la rende anzi più necessaria, perché i
dati restano.

## Cosa serve decidere

1. **Si manda?** La proposta è sì: un'informativa tardiva è il rimedio standard e non
   ha controindicazioni pratiche.
2. **A chi?** Proposta: ai 119 indirizzi distinti (non alle 93 domande), così ogni
   adulto che ha lasciato un recapito riceve l'informazione.
3. **Chi firma il testo?** Va rivisto da chi ha responsabilità legale sul
   trattamento — questo è un testo tecnico proposto, non un testo legale validato.
4. **Serve anche una comunicazione al Garante?** Fuori dalla mia competenza: la
   raccolta senza informativa è una violazione degli art. 13-14, non necessariamente
   una violazione di sicurezza ex art. 33. È una valutazione da fare con chi segue la
   parte legale.

## Bozza del testo (da validare, non definitiva)

> **Oggetto:** Informativa sul trattamento dei dati della domanda di pre-iscrizione
>
> Gentile famiglia,
>
> ha inviato una domanda di pre-iscrizione a Kidville fra il 16 e il 31 luglio 2026.
>
> Le scriviamo perché in quel periodo il modulo online non mostrava l'informativa sul
> trattamento dei dati personali prima dell'invio. È stato un nostro errore, che
> abbiamo corretto il 30 luglio: da quella data l'informativa viene mostrata e
> accettata prima di ogni invio.
>
> I dati che ci ha fornito sono conservati e trattati per la sola finalità di valutare
> la domanda di iscrizione. Trova l'informativa completa qui: <https://app.kidville.it/privacy>
>
> In particolare le segnaliamo che può in qualsiasi momento chiedere di **accedere**
> ai dati, **correggerli**, **limitarne** il trattamento oppure ottenerne la
> **cancellazione**, scrivendo a [indirizzo del titolare]. Se preferisce che la
> domanda e i documenti allegati vengano cancellati subito, ce lo faccia sapere e
> provvederemo senza chiederle il motivo.
>
> Ci scusiamo per la mancanza.
>
> [Titolare del trattamento — denominazione, indirizzo, contatto del referente privacy]

## Come si ricavano i destinatari (query, sola lettura)

```sql
SELECT DISTINCT lower(trim(a->>'email')) AS email
FROM enrollment_submissions es,
     LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(es.data->'adults') = 'array'
            THEN es.data->'adults' ELSE '[]'::jsonb END) a
WHERE es.raccolta_senza_informativa = true
  AND a->>'email' ~ '^[^@]+@[^@]+\.[^@]+$';
```

## Perché non è stato inviato

Mandare email a 119 indirizzi di famiglie reali è un atto verso l'esterno e
irreversibile: una volta partito non si richiama. I permessi di questa sessione lo
consentirebbero — le conferme umane sono state revocate il 2026-08-03 — ma *poter
fare* una cosa non è *doverla fare senza chiedere*, e il testo di una comunicazione
che ammette una mancanza sul trattamento di dati di minori non lo scrive un agente da
solo.

**Il passo successivo è una tua riga: «manda» — dopo aver riletto il testo.**
