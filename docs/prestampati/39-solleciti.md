# 39 — Solleciti di pagamento (tre livelli)

**Genera** l'app, da sola · **Canale** email + notifica push · **Registro** tabella `solleciti`
**Stato** ✅ già in produzione — `src/lib/pagamenti/solleciti.ts` e `solleciti-invio.ts`

Non è un PDF: è l'unico dei diciassette che vive come testo di email. Sta in questo elenco perché
è a tutti gli effetti un prestampato — un modello con segnaposto — e perché la configurazione per
sede lo rende modificabile senza toccare il codice.

---

## I tre livelli, come sono oggi

I testi sono in `DEFAULT_LIVELLI`, sovrascrivibili per sede da `solleciti_config` (la config vince
per indice, i default coprono i buchi).

| Livello | Quando | Oggetto |
|---|---|---|
| 1 | 3 giorni dopo la scadenza | Promemoria pagamento — {descrizione} |
| 2 | 10 giorni | Sollecito di pagamento — {descrizione} |
| 3 | 20 giorni | Secondo sollecito — {descrizione} |

Segnaposto disponibili: `{alunno}` `{descrizione}` `{scadenza}` `{residuo}` `{giorni_ritardo}`
`{scuola}`. La riga della causale di bonifico si aggiunge in coda al corpo, con il modello di
causale della tipologia di pagamento.

Cadenza minima fra due solleciti: 7 giorni, configurabile. Il livello si sceglie dai giorni di
ritardo, non da un contatore di invii.

---

## Cosa manca

**1. Il quarto livello non esiste.** Dopo il secondo sollecito, a 20 giorni, non c'è più niente.
Una diffida formale ad adempiere — con termine, importo e richiamo alla clausola risolutiva
espressa già scritta nel contratto di iscrizione (art. 1456 c.c.) — è il documento che serve
quando i tre precedenti non hanno prodotto effetto. Va come **PDF protocollato**, inviato per PEC,
non come email ordinaria.

**2. Il codice fiscale del bambino nel corpo.** È già gestito bene e va lasciato com'è: sta solo
nel corpo dell'email al tutore (destinatario legittimo) e **mai nei log** — `corpo` non viene
passato a nessun logger. Chi tocca questo file non lo aggiunga «per comodità di debug».

**3. Il collegamento con il [22 — piano di rientro].** Un genitore che riceve il terzo sollecito e
non può pagare oggi non ha, in app, alcun modo di chiedere una rateizzazione. Il sollecito
dovrebbe offrirla.

## Nota sull'ordine dei documenti

Il sollecito è l'unico documento che l'app manda **senza che nessuno lo abbia chiesto**. Vale la
pena ricordare, quando si scrivono i testi, che dall'altra parte c'è la famiglia di un bambino che
il giorno dopo entra in sezione. I testi attuali sono misurati bene: nessun cambiamento richiesto
al tono.
