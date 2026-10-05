# Metodi di pagamento ammessi e associazioni dei bonifici modificabili — design

**Data:** 2026-10-05 · **Stato:** approvato dal titolare · **Branch:** `feat/metodi-pagamento-riconciliazione`

## Perché

1. **Metodi ammessi.** Oggi la segreteria non può dire con quali metodi si paga una voce. Per una voce
   come «Materiale» da pagare in segreteria, il genitore vede lo stesso IBAN e la stessa causale del
   bonifico (`ComePagare.tsx`, solleciti via email). Il metodo esiste solo sull'**incasso**
   (`incassi.metodo`), cioè dopo il pagamento.
2. **Associazioni dei bonifici.** In Riconciliazione, una volta associato un bonifico, il popup non
   dice **a quale voce** è stato associato. Il pulsante «Riapri» esiste
   (`PATCH azione:'riapri'` → `riapriMovimento`), ma:
   - non si legge come «modifica» o «elimina»;
   - parte senza conferma;
   - dopo la riapertura obbliga a chiudere, ritrovare la riga e riaprirla.

   Il caso che l'ha fatto emergere, a Giugliano il 05/10, è stato corretto a mano sul DB (vedi la
   memoria di sessione):
   - un bonifico per una quota d'iscrizione mai registrata in app era finito sulla retta di
     settembre;
   - il bonifico della retta di settembre era finito su ottobre.

## Decisioni del titolare (05/10)

- Metodi selezionabili: **Contanti** e **Bonifico**. Di partenza sono spuntati entrambi, cioè il
  comportamento di oggi. **Causale e IBAN compaiono solo se il bonifico è ammesso.**
- Dove si sceglie: nel generatore «una tantum per categoria» e nella modifica di un pagamento.
  Rette, «Nuovo acquisto», rate e ticket restano contanti + bonifico.
- «Elimina associazione»: nella conferma si sceglie fra **«Rimetti da abbinare»** e **«Segna come
  ignorato»**.

## Parte B — Metodi ammessi

### Dati

Migrazione `pagamenti_metodi_ammessi`:

```sql
ALTER TABLE public.pagamenti
  ADD COLUMN metodi_ammessi text[] NOT NULL DEFAULT ARRAY['contanti','bonifico'];
ALTER TABLE public.pagamenti
  ADD CONSTRAINT pagamenti_metodi_ammessi_validi CHECK (
    cardinality(metodi_ammessi) >= 1
    AND metodi_ammessi <@ ARRAY['contanti','bonifico']::text[]
  );
```

Il default copre ogni insert esistente: RPC delle rette, ticket, composizione, merchandise.

### Helper puro

`src/lib/pagamenti/metodi-ammessi.ts` non ha import, perché lo usano anche componenti `'use client'`.

- `METODI_AMMESSI = ['contanti','bonifico'] as const`
- `normalizzaMetodiAmmessi(raw: unknown): MetodoAmmesso[]`:
  - valori ignoti → scartati;
  - assente, `null`, vuoto o tutto ignoto → entrambi;
  - ordine canonico.

  È la degradazione per il DB E2E della CI, che non è migrato.
- `ammetteBonifico(m)` / `ammetteContanti(m)`
- `soloUnMetodo(m): 'contanti' | 'bonifico' | null`

### API

| Route | Cambia |
|---|---|
| `POST /api/pagamenti/genera` | zod `metodi_ammessi` opzionale, `min(1)`, valori `contanti\|bonifico`. Va su `singolo`, `padre` e sulle sue `rata`. Su `PGRST204` si riprova senza la colonna e si logga a livello `warn`. |
| PATCH della modifica pagamento (`ModificaPagamentoModal`) | Stesso campo, stesso ripiego. |
| `GET /api/pagamenti` | Restituisce `metodi_ammessi`, normalizzato; su `42703` fa il ripiego come già per `sconto`. `causale_suggerita = null` sulle voci senza bonifico. Si decide a valle del motore della causale, che resta unico. |

### Interfaccia

**Segreteria**
- `GeneratoreCategoria` e `ModificaPagamentoModal`: un gruppo «Metodi di pagamento ammessi» con due
  caselle. Con zero caselle compare un messaggio d'errore e il salvataggio si blocca.
- Badge «Solo contanti» / «Solo bonifico» nella riga dello scadenzario e nel dettaglio della voce.

**Genitore**
- Badge sulla card della voce.
- `ComePagare`: le voci senza bonifico escono dall'elenco delle causali.
- Se nessuna voce aperta ammette il bonifico, la scheda Bonifico (IBAN compreso) non compare e la
  card mostra Contanti.

**Solleciti via email**
- Una voce senza bonifico non ha il riquadro «Dati per il bonifico»: al suo posto c'è una riga
  «da pagare in contanti presso la segreteria».

**Riconciliazione**: invariata. Un bonifico arrivato su una voce «solo contanti» si associa ancora a
mano.

## Parte C — Associazione visibile e modificabile

### C1. Lettura dell'associazione

`GET /api/pagamenti/riconciliazione/[id]` (staff, zod sull'uuid, `withRoute`) restituisce:

```ts
{
  success: true,
  data: {
    stato, importo, data_operazione,
    associazione: null | {
      tipo: 'singola' | 'composita',
      automatico: boolean,          // abbinato_auto_il valorizzato
      confermato_il: string | null,
      confermato_da: string | null, // nome dell'operatore
      voci: Array<{
        pagamento_id, descrizione, alunno, // «Nome Cognome»
        importo_voce, incassato_qui, stato_voce, fattura_stato,
        fattura_in_coda: 'in_coda' | 'in_invio' | 'errore' | null,
      }>,
    },
    // compatibilità: lo stato e la fattura della voce ancora (oggi letti da /api/pagamenti/[id])
    pagamento: null | { stato, fattura_stato },
  }
}
```

- Nel caso composito le voci si leggono dagli incassi della transazione, con lo stesso
  `transazione_id`.
- `MovimentoDialog` sostituisce la lettura di `/api/pagamenti/{pagamento_id}` con questa: **una sola
  lettura** all'apertura, come prima.

### C2. Popup

- Su un bonifico **confermato** compare il riquadro «Associato a», con una riga per voce: bambino,
  voce, importo, stato. Sotto: «Confermato da X il …», oppure «Abbinato in automatico il …».
- Le azioni sono **«Modifica associazione»** ed **«Elimina associazione»**, al posto di «Riapri».
- Su un bonifico **ignorato** l'azione è «Rimetti da abbinare».

### C3. Conferma

Il componente `ConfermaScollegaBonifico` elenca ciò che succederà:
- lo storno di ciascun incasso, voce per voce;
- le voci create dalla composizione, che restano da pagare;
- la ricevuta della transazione, che viene annullata;
- la fattura **emessa**, se c'è, che resta valida e va stornata con nota di credito a parte;
- la richiesta di fattura in coda, se c'è, che viene tolta.

Per «Elimina» la scelta è un radio: **«Rimetti da abbinare»** (predefinito) / **«Segna come
ignorato»**.

### C4. Server

`PATCH azione:'riapri'` accetta `poi?: 'da_abbinare' | 'ignorato'`.
- Dopo una riapertura riuscita, con `ignorato` si fa un update condizionale
  `stato='ignorato' WHERE id AND stato='da_abbinare'`, verificando le righe toccate.
- Se l'update non tocca niente, si risponde 200 con un avviso: la riapertura è avvenuta, l'ignora no.
- Si logga `logEvento('pagamento','info',{ esito: 'associazione-eliminata' | 'associazione-riaperta-per-modifica', … })`.

### C5. «Modifica»

Dopo la riapertura, `RiconciliazionePanel`:
1. ricarica lista e voci aperte;
2. **riapre il popup sulla riga aggiornata**, ora `da_abbinare`, con `key` = `id:stato` perché lo
   stato interno si azzeri.

L'operatrice associa con suggerimenti, ricerca o «Componi».

### C6. Fatture in coda

In `riapriMovimento`:
- **prima** di stornare, se una voce coinvolta ha una richiesta `in_invio` → **409**
  `FATTURA_IN_INVIO`, senza toccare niente;
- **dopo** lo storno, per ogni voce che non è più `pagato` e ha una richiesta `in_coda`/`errore` →
  `fatture_coda_togli`, riportato nell'esito come «richieste di fattura tolte».

### C7. Ricevuta del composito

La riapertura di un composito chiama `annullaRicevutaTransazioneAttiva`, come fa già
`transazioni/[id]/annulla`.

### C8. Storno: errori non più muti

In `eseguiStornoIncasso` i tre `.then(() => {}, () => {})` (su `stornato_il`, la RPC di ricalcolo e
`registro_modifiche`) diventano letture di `{ error }` con `logErrore`, oppure `logEvento` `info` su
`42883`/`42703` per il DB della CI.

## Approcci scartati

- **`solo_contanti boolean`**: non sa esprimere «solo bonifico».
- **RPC atomica «sposta associazione»**: duplicherebbe in SQL la conferma singola, la composizione,
  la guardia `BONIFICO_GIA_FATTURATO` e la sede di scrittura. «Riapri + riabbina» riusa percorsi già
  testati. Il passaggio intermedio è visibile («da abbinare»), non muto.

## Test

- **Helper**: normalizzazione, `soloUnMetodo`, `ammetteBonifico`.
- **API metodi**:
  - `genera` accetta `['contanti']`, rifiuta `[]` e `['pos']` con 400;
  - propagazione alle rate;
  - ripiego `PGRST204`;
  - PATCH della modifica;
  - `GET /api/pagamenti`: `causale_suggerita` null sulle voci senza bonifico.
- **Sollecito**: niente IBAN per una voce «solo contanti».
- **Componenti**:
  - caselle e errore sullo zero in `GeneratoreCategoria` e `ModificaPagamentoModal`;
  - badge;
  - `ComePagare` senza scheda Bonifico.
- **Riconciliazione**:
  - GET dell'associazione, singola e composita;
  - `poi:'ignorato'`;
  - `in_invio` → 409 senza storni;
  - `fatture_coda_togli` solo sulle voci non più pagate;
  - ricevuta annullata sul composito;
  - `MovimentoDialog`: riquadro, due azioni, conferma con la scelta, riapertura in abbinamento.
- **Lock**: zod, logging, gate, isolamento di sede, parità dei cataloghi, migrazioni complete, motori
  unici di causale e coordinate.
