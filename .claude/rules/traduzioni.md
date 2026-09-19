---
paths:
  - "messages/**/*.json"
---

# Cataloghi di traduzione — `messages/it` e `messages/en`

39 file per lingua, uno per area (`adminContabilita.json`, `adminMensa.json`, `etichette.json`, …).

## 🔴 Un catalogo non si riordina

Riordinare le chiavi di un catalogo produce **migliaia di righe di diff che non sono tue** (è già
successo: 1.728). Il diff diventa illeggibile, la revisione impossibile, e la modifica vera
scompare dentro il rumore. **Si aggiunge in fondo al gruppo pertinente, e basta.**

## I quattro lock

- `__tests__/architecture/messaggi-parita-cataloghi.test.ts` — `it` ed `en` devono avere le stesse
  chiavi. Aggiungerne una sola da un lato fa rosso.
- `__tests__/architecture/messaggi-chiavi-orfane.test.ts` — una chiave che nessuno usa è un errore,
  non un residuo innocuo.
- `__tests__/architecture/messaggi-plurali-e-glossario.test.ts`
- `__tests__/architecture/numeri-con-locale-esplicito.test.ts` — numeri, date e valute vogliono il
  **locale esplicito**: mai affidarsi a quello di sistema, che in CI non è quello dell'utente.

## 🔴 Plurali ICU: un matcher a prefisso diventa cieco

Dopo un plurale ICU (`{n, plural, one {…} other {…}}`) un confronto che guarda solo il **prefisso**
della stringa smette di corrispondere, perché la parte variabile è in mezzo, non in coda. Se una
ricerca o un filtro su testi tradotti «funzionava e poi no», guarda se nel mezzo è comparso un
plurale.

## 🔴 La descrizione di una notifica non sta dove sembra

Per i testi delle notifiche, **`etichette.json` vince su `TIPI_NOTIFICA`**: se cambi la costante nel
codice e il testo non cambia, stai modificando il posto sbagliato.

## Lingua

L'interfaccia è **it-IT**. L'inglese esiste per parità di catalogo, non è ancora una lingua servita:
le stringhe lunghe vanno comunque provate sul layout, perché sono il caso peggiore.
