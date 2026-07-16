---
name: maestro-mobile-testing
description: Pattern Maestro per collaudare l'app nativa Kidville (Capacitor WebView) su emulatore Android e simulatore iOS — readiness gate contro il boot a freddo, rami when: adattivi, verifiche a timeout corto, chiusura degli alert nativi, sub-flow riusabili, tag e screenshot. Selettori per TESTO italiano, NON testID.
when_to_use: Quando i tester mobile-android / mobile-ios scrivono, riparano o rendono meno fragili i flow Maestro dell'app Kidville.
---

# Maestro su Kidville — pattern per una WebView Capacitor

> **Crediti e adattamento.** Questi pattern sono adattati da
> [`tovimx/maestro-mobile-testing-skill`](https://github.com/tovimx/maestro-mobile-testing-skill)
> (licenza MIT dichiarata nei metadati dell'originale). L'originale è scritto per
> **React Native** e la sua tecnica centrale — selezionare gli elementi via **`testID`** —
> **NON si applica a Kidville**: la nostra app è HTML dentro una **WebView Capacitor**, quindi
> Maestro vede il **testo** e le etichette di accessibilità del DOM, non i `testID` nativi.
> Qui teniamo solo i pattern **indipendenti dal selettore** e li riscriviamo per il nostro
> runtime, il nostro italiano e le trappole che abbiamo già pagato.

L'app è `it.kidville.app`. I flow committati stanno in `.claude/maestro-flows/`. Questa skill
non li sostituisce: **sono loro la fonte di verità**. Serve a scriverne di più robusti e a
ripararli quando la UI cambia.

## 0. La regola dei selettori (la più importante, e la più diversa dall'originale)

- **Seleziona per TESTO italiano visibile**, non per `testID`. Esempi reali:
  `"Accedi al tuo account Kidville"`, `"Benvenuto/a!"`, `"Segnala assenza"`,
  `"Assenze e giustifiche"`, `"Comunicazioni"`, `"Circolari e avvisi alle famiglie"`.
- Le tab hanno **aria-label** parlanti: la tab menu è `"Menu · tutte le sezioni"` (non solo
  "Menu"). Preferisci il **sottotitolo univoco** di una voce quando ci sono testi vicini simili
  (es. `"Assenze e giustifiche"` invece del generico "Presenze").
- Per **scoprire i selettori** su una schermata nuova, ispeziona la WebView in esecuzione:
  ```bash
  maestro studio                 # builder interattivo
  maestro hierarchy              # dump dell'albero delle viste
  ```
  Non leggere il codice sorgente per indovinare gli id: guarda l'app viva.
- Se un'etichetta cambia nel prodotto, il flow che la cita va aggiornato **nello stesso
  lavoro**: un flow che punta a un'etichetta morta è un test che mente.

## 1. Readiness gate — batti il boot a freddo

Il difetto numero uno dei test mobile è partire prima che l'app sia pronta. Non usare attese
fisse: **aspetta un elemento stabile che dimostra che la pagina è idratata.**

```yaml
- launchApp:
    clearState: true
- extendedWaitUntil:
    visible: "Accedi al tuo account Kidville"   # marcatore di "login pronto"
    timeout: 60000
```

Perché generoso: l'app è una WebView che carica da rete (`server.url`). Il primo paint passa
dalla rete. E — trappola Kidville — **al login lascia respirare la pagina prima di digitare**:
l'idratazione di Next svuota i campi se scrivi troppo presto. `extendedWaitUntil` su un testo
stabile è proprio quel respiro.

## 2. Rami `when:` adattivi — un flow che non si rompe per una variante

Le condizioni (già loggato, dialog nativo presente, piattaforma) si gestiscono con `when:`,
non con un secondo flow.

```yaml
# Il primo avvio può mostrare il permesso notifiche nativo: chiudilo se c'è.
- runFlow:
    when:
      visible: "Non consentire"
    commands:
      - tapOn: "Non consentire"

# Rami per piattaforma quando serve (raro: preferisci un flow per OS).
- runFlow:
    when:
      platform: iOS
    commands:
      - tapOn: "Benvenuto/a!"    # vedi §5: chiude la tastiera su WebView iOS
```

## 3. Verifiche a timeout CORTO — per gli aggiornamenti ottimistici

Quando la UI aggiorna in modo ottimistico (spunta di consegnato, presenza segnata), verifica
con un timeout **breve** (~3 s): se l'ottimismo non compare subito, è un bug, non lentezza.

```yaml
- tapOn: "Presente"
- extendedWaitUntil:
    visible: "registrati"
    timeout: 3000        # corto di proposito
```

## 4. Sub-flow riusabili + tag

Il login si ripete in ogni percorso: estrailo, non copiarlo. Tagga i flow per poterli
filtrare.

```yaml
# login-genitore.yaml (sub-flow)
appId: it.kidville.app
tags: [android, login]
---
- runFlow: login-comune.yaml
```

## 5. Le trappole di Kidville già pagate (non ripagarle)

- **`hideKeyboard` fallisce su WebView iOS** ("Couldn't hide the keyboard"). Chiudi la tastiera
  con un **tap su un testo statico** (es. il titolo `"Benvenuto/a!"`), non con `hideKeyboard`.
  Su Android `hideKeyboard` va bene.
- **Server host: usa `npx next start` (build di produzione), NON `next dev`.** Con Turbopack
  l'HMR-websocket non completa l'handshake attraverso il bridge dell'emulatore e la WebView
  **non idrata** (React non monta i fiber → schermata "morta" ma senza errori).
- **Host dall'emulatore Android = `10.0.2.2`**, non `localhost`. Dal simulatore iOS = `localhost`.
- **Credenziali dagli env, mai nei file** (repo pubblico): `MAESTRO_KV_EMAIL_GENITORE`,
  `MAESTRO_KV_EMAIL_DOCENTE`, `MAESTRO_KV_PASSWORD`. Vanno **esportate** nell'ambiente prima di
  `maestro test` (`-e VAR=...` non sovrascrive il blocco `env:` del flow, e un `${...}` non
  risolto viene digitato come la stringa letterale "undefined").
- Screenshot in `/tmp/kv-<piattaforma>-<ruolo>-<n>-<schermata>` a ogni tappa: servono al report
  quando qualcosa va storto.

## 6. Scripting (solo se proprio serve)

Maestro usa **GraalJS**: niente `async/await`, niente `fetch`. Se ti serve leggere un'email
(OTP, magic link) usa un mock server locale (Mailpit/MailHog) e le API sincrone. Per Kidville
quasi mai serve: i percorsi di collaudo sono login + navigazione, non catene email.

## 7. Cosa NON aspettarti da questa skill

Non genera flow da sola, non legge la tua app, non si auto-guarisce. È un **prontuario**: sei
tu (l'agente tester) a scrivere ed eseguire i flow con `maestro test`, applicando questi pattern.
Gli screenshot di Maestro finiscono anche in `~/.maestro/tests/{timestamp}/`.
