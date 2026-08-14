# 31 — Richiesta di disponibilità ad accogliere l'alunno/a

**Genera** la segreteria da `/admin` · **Firma** legale rappresentante · **Protocollo** in uscita
**Destinatario** un altro istituto scolastico · **Fonte** `prestampato-09-richiesta-disponibilita_…docx` — testo invariato

È l'unico dei diciassette che **non riguarda la famiglia**: è una lettera da scuola a scuola.

---

## Testo del modello

> **RICHIESTA DI DISPONIBILITÀ AD ACCOGLIERE L'ALUNNO/A**
> {{scuola.ragione_sociale}} – Kidville (Nido · Infanzia · Primaria)
>
> Prot. n. `{{protocollo.numero}}`
> `{{luogo_data}}`
>
> Spett.le Istituto `[ISTITUTO: testo]`
> Indirizzo: `[INDIRIZZO_ISTITUTO: testo]`
>
> **Oggetto: Richiesta di disponibilità ad accogliere l'alunno/a ai fini del trasferimento**
>
> Con la presente si comunica che l'alunno/a sotto indicato/a, attualmente iscritto/a presso questa
> scuola, ha manifestato — tramite la propria famiglia — la volontà di trasferirsi presso codesto
> Istituto.
>
> Cognome e nome: `{{alunno.cognome}} {{alunno.nome}}`
> Data di nascita: `{{alunno.data_nascita}}`
> Classe/Sezione di provenienza: `{{alunno.sezione}}`
> Anno scolastico: `{{anno_scolastico}}`
>
> Decorrenza prevista del trasferimento: `[DECORRENZA: data]`
>
> Si richiede pertanto cortese conferma della disponibilità di un posto per l'alunno/a sopra
> indicato/a, al fine di procedere con il rilascio del nulla osta al trasferimento.
>
> Si resta in attesa di un cortese riscontro scritto, anche a mezzo email/PEC, e si ringrazia per la
> collaborazione.
>
> Il Legale Rappresentante
> `{{scuola.legale_rappresentante}}`
> `{{scuola.ragione_sociale}}`
>
> ✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
>
> **TAGLIANDO DI RISPOSTA — da restituire a Kidville**
>
> Alunno/a: `{{alunno.cognome}} {{alunno.nome}}`
> ☐ Si conferma la disponibilità di un posto per l'alunno/a sopra indicato/a
> ☐ Non si conferma la disponibilità
> Note: ______________________________
> Istituto: ______________________ · Data: ____________
> Timbro e firma: ______________________

---

## Il form chiede

| Campo | Tipo | Obbligatorio | Nota |
|---|---|---|---|
| Istituto destinatario | testo | sì | precompilato dalla richiesta del genitore |
| Indirizzo | testo | sì | idem |
| Email o PEC | email | no | se c'è, la lettera parte da sola |
| Decorrenza prevista | data | sì | idem |

## Il tagliando resta di carta, la sua risposta no

Il tagliando serve così com'è: l'istituto dall'altra parte lo compila a penna, ci mette il timbro e
lo rimanda. Nel PDF non si tocca.

Quello che cambia è **cosa succede quando torna**. La segreteria registra l'esito — confermato o
non confermato — e da lì:

- **confermato** → si sblocca il [30 — nulla osta](30-nulla-osta.md), già precompilato con
  l'istituto e la decorrenza di questa lettera;
- **non confermato** → la pratica si chiude e il genitore lo viene a sapere, invece di aspettare
  una risposta che non arriva.

Senza registrazione dell'esito, questa lettera è una raccomandata che parte e si dimentica: è
esattamente ciò che accade oggi con la versione Word.

## Dopo la generazione

1. Protocollo in uscita; la risposta, quando arriva, si protocolla in entrata e si collega
   (`protocolli.collegato_a_id`, campo che esiste già).
2. Invio per email/PEC se l'indirizzo c'è, altrimenti PDF da stampare.
3. Nessuna copia nel fascicolo dell'alunno: è corrispondenza fra istituti, sta nel registro
   protocolli.
4. Se dopo `[N] giorni` non è tornato nulla, promemoria alla segreteria. Un trasferimento fermo
   perché una scuola non ha risposto è un bambino in mezzo a due iscrizioni.
