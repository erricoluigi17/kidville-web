---
paths:
  - "__tests__/**/*.ts"
  - "__tests__/**/*.tsx"
  - "e2e/**/*.ts"
  - "vitest.config.ts"
  - "playwright.config.ts"
---

# Test — le trappole che hanno già prodotto verdi falsi

Il repo ha **141 lock** in `__tests__/architecture/`. Un lock che non può fallire non è un lock.

## 🔴 Le cinque forme di verde falso, tutte già viste qui

1. **Un mock piatto è verde CON e SENZA la correzione.** Se il finto restituisce sempre la stessa
   cosa, il test non misura il codice: misura il finto. **Rompi il codice di proposito e guarda il
   test diventare rosso.** Se resta verde, il test non esiste.
2. **`vitest run <file inesistente>` esce 0 e non lo dice.** Verde su un test mai eseguito. Si
   controlla la riga **`Test Files N passed`**: se `N` non è quello che ti aspetti, non hai provato
   niente.
3. **Un `waitFor` su un'ASSENZA passa prima che i dati arrivino.** «Non c'è il messaggio d'errore» è
   vero anche mentre la fetch è ancora in volo. Si aspetta la *presenza* di qualcosa.
4. **`getByText` pesca i sosia.** Su una pagina con più occorrenze prende la prima, che spesso non è
   quella che credi. E il **Service Worker aggira `page.route`**: l'intercettazione non vede la
   richiesta.
5. **Playwright con `retries: 2` nasconde la degradazione.** Un job «verde» può contenere 2
   fallimenti su 3 tentativi. Si guarda il conteggio dei retry, non il colore.

## Altre trappole misurate

- **In jsdom il `Blob` non ha `stream()`**: il corpo esce come `"[object Blob]"` e il test passa
  confrontando una stringa che non è il file.
- **Abbassare la soglia di un lock lo rende decorazione.** Se una soglia scende, si scrive
  **accanto al numero** perché è scesa — altrimenti fra sei mesi nessuno sa se era un miglioramento
  o una resa.
- **Un test che legge un file come TESTO legge anche i commenti**: un lock può immunizzarsi da solo
  perché la stringa che cerca compare nel proprio commento esplicativo.
- **Un test rosso che nessuno ha toccato può essere SCADUTO** (una data cablata che è passata).
  Congelare l'orologio è la correzione **sbagliata**: si rende il test indipendente dalla data.
- **Una fixture generata resta una fixture.** Eseguire `ffmpeg` davvero non basta se la *sorgente* è
  sintetica: `testsrc2` dichiara campi che un iPhone non scrive. E un difetto di forma si cerca su
  **tutti** i campi con quella forma, non solo su quello che è esploso.

## Shell, quando lanci i test

- **In zsh `PIPESTATUS` non esiste** (è `$pipestatus[1]`): stampa **vuoto**. E
  `comando | tail; echo $?` riporta l'uscita di `tail`, non del comando: **non verifica niente**.
- In vitest 4 **`--reporter=basic` non esiste**: esce 1 senza eseguire nulla.
- In zsh un `$VAR` non quotato **non viene diviso in parole**: `grep "$p" $files` con due file cerca
  in un file dal nome assurdo, e con `-s` l'errore è muto. Si usa `${=files}`.

## Il gate, prima di dire «fatto»

```
npx eslint . --max-warnings 0     # include no-console su src/
npx vitest run                    # include zod-coverage e logging-coverage
npm run build
```

E2E Playwright gira **in CI**: in locale `npm run e2e` e `npm run e2e:seed` sono in `deny`, perché
`.env.local` punta al database di **produzione** e il seed ci scriverebbe dentro.

Un E2E rosso si legge **dal punto d'arresto**, non dall'ultimo messaggio a schermo.
