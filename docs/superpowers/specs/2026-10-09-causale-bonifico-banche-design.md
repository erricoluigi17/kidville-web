# Causale del bonifico accettata da tutte le banche — design

**Data:** 2026-10-09 · **Branch:** `fix/causale-bonifico-banche`

## Problema

Un genitore non riesce a fare il bonifico da Poste: la causale che l'app gli fa copiare contiene il
**cancelletto** del codice della voce (`Retta 10/2026 #K7MXN3P - per il minore …`). Il titolare ha
confermato che è il `#` a dare errore. Ma Poste rifiuta anche la `/` di «Retta 10/2026» e gli
apostrofi dei cognomi: il cancelletto è solo il primo carattere che si è fatto notare.

## Ricerca

| Fonte | Esito |
|---|---|
| EPC, schema SEPA SCT, set latino di base | `a-z A-Z 0-9 / - ? : ( ) . , ' +` e spazio. `#` e `*` sono fuori. Le banche possono essere più severe. |
| BancoPosta (Poste) | Rifiuta `" # $ % & ' / : ? \ ^ _ \| £ § ° € À Ç È É Ì Ò Ù`: toglie anche `/ : ? '` del set SEPA. |
| Fineco | Elenca come ammessi solo `A-Z a-z 0-9 / ? '`. |
| AgID, avviso SPID n. 32 (14/10/2020) | SEPA dice 140 caratteri, ma alcune banche tagliano la causale a 50. |

L'intersezione è una sola: **lettere `A-Z a-z`, cifre `0-9` e spazio**. Lunghezza massima 140, e i
dati che servono all'abbinamento (codice voce e codice fiscale) entro i primi 50.

## Misure su produzione (2026-10-09, solo conteggi — rifarle, non copiarle)

- `admin_settings.causali_config` è `{}` in tutte e quattro le sedi: ovunque vale il modello di fabbrica.
- `pagamenti.descrizione`: 1.636 voci su 2.205 contengono simboli fuori dall'intersezione. La sola
  forma `Retta MM/AAAA` ne fa 1.434; poi `—` (rate, ticket mensa) 188, `[ ]` 12, `:` 2, `×` 1.
- `alunni` (nome + cognome): `'` 12, `’` 8, `-` 8, lettere accentate 5.
- `riconciliazione_movimenti` dal 21/09 (cioè da quando esiste il codice): 451 movimenti, 220 con la
  formula dell'app, **zero con il `#`**. Davanti al codice arriva uno spazio (101), un punto (5), un
  trattino (4). Le banche il `#` non lo fanno passare: il sigillo non ha mai aiutato l'abbinamento.

## Decisione del titolare: «dati chiave in testa»

```
oggi:  Retta 10/2026 #K7MXN3P - per il minore Mario Rossi - RSSMRA85T10Z999X - GIUGLIANO
nuova: Retta 10 2026 K7MXN3P RSSMRA85T10Z999X Mario Rossi GIUGLIANO
✂ 50:  Retta 10 2026 K7MXN3P RSSMRA85T10Z999X Mario Ross        → codice e CF restano
```

## Disegno

1. **`src/lib/pagamenti/causale-banca.ts`** — modulo puro, zero import (finisce nel bundle client
   attraverso `causale.ts`). `causalePerBanca(testo)`: accenti tolti (NFD), `€` → `EUR`, `×` → `x`,
   ogni altro carattere fuori da `[A-Za-z0-9]` diventa uno spazio, spazi compressi, taglio a
   `LIMITE_CAUSALE_BANCA = 140` sull'ultimo spazio. Idempotente; un non-stringa dà `''`.
2. **`causale.ts`** — modello di fabbrica `{descrizione} {codice} {codice_fiscale} {nome_completo} {sede}`;
   `causaleBonifico` passa l'uscita di `renderCausale` per `causalePerBanca`. È l'unica porta del
   bonifico (elenco pagamenti del genitore, solleciti testo e HTML, anteprima della segreteria).
   `renderCausale` non cambia: è condiviso con la fattura elettronica, che ha le sue regole.
3. **Il codice voce resta canonico `#K7MXN3P` dentro l'app** (modulo congelato intatto, JSONB
   `suggerimenti` e interfaccia di riconciliazione invariati): il `#` sparisce solo nella stringa per
   la banca. L'estrattore riconosce già la forma nuda, e continua a riconoscere le causali vecchie.
4. **Riconciliazione, segnali deboli** — `norm()` non si tocca (è nell'impronta anti doppio import).
   Si affianca `normParole()` (simboli → spazi) per «nome in causale» e «descrizione in causale»,
   che altrimenti la nuova causale perderebbe (`retta 10/2026` ⊄ `retta 10 2026`, `d'angelo` ⊄ `d angelo`).
   Il confronto di prima resta: nessun abbinamento di oggi va perso.
5. **Pannello segreteria** — esempio del chip `{codice}` nella forma che esce davvero (`MNKPRTF`), e
   una frase che spiega che accenti e simboli vengono tolti apposta.

## Fuori perimetro, dichiarato

- I solleciti **già spediti** (`solleciti.corpo`) portano la causale vecchia col `#`: non si
  riscrivono email partite. La card del genitore cambia subito (la causale si ricalcola a ogni richiesta).
- La causale della fattura elettronica non cambia.

## Log

Nessuna route, integrazione esterna o percorso d'errore nuovo: sono funzioni pure. La causale non si
logga mai — contiene codice fiscale e nome di un minore.
