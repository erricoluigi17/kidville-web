# C1-bis — La verifica del dispositivo Android

> **Cos'è**: l'unico blocco duro rimasto fra Kidville e Google Play. Google pretende la prova che
> lo sviluppatore abbia accesso a un telefono Android **fisico**. Finché non è fatta, in Play
> Console `Crea app` resta **col lucchetto**: non si può nemmeno creare la scheda.
>
> **Quanto costa**: meno di un minuto sul telefono di chiunque. **Misurato il 2026-08-05.**

---

## §1 — L'emulatore non funziona, ed è stato provato davvero

Non è una deduzione da forum. È una misura fatta su questa macchina il 2026-08-05:

| Passo | Esito |
|---|---|
| AVD `KV-play-phone`, immagine `google_apis_playstore` API 36.1 (Android 16), Play-certified | ✅ avviato |
| Account Google aggiunto sull'emulatore | ✅ |
| App **Google Play Console** cercata sul Play Store dell'emulatore | ✅ **installabile** — c'era il pulsante *Install* |
| Login nell'app come proprietario dell'account | ✅ `Continue as Luigi` |
| **Verifica** | 🔴 **RESPINTA** |

Il messaggio esatto:

> *«You can't verify using this device. To verify, use a device running Android 10 (SDK 29) or newer.»*

**Il messaggio mente sulla causa.** L'emulatore girava **Android 16**, cioè SDK 36 — ben oltre
l'SDK 29 che il testo pretende. Un errore che dà una spiegazione palesemente falsa è tipico di un
controllo che fallisce a monte e ricade su un testo generico sbagliato.

La causa vera è documentata altrove, nella pagina dei verdetti della **Play Integrity API**:

- `MEETS_DEVICE_INTEGRITY` — *«The app is running on a genuine and certified Android device. On
  Android 13 and higher, there is hardware-backed proof that the device bootloader is locked…»*
- `MEETS_VIRTUAL_INTEGRITY` — *«The app is running on an Android-powered **emulator** with Google
  Play services…»*

**Google ha creato un'etichetta separata apposta per gli emulatori.** Un emulatore, per quanto
Play-certified, non prende `MEETS_DEVICE_INTEGRITY`: non ha un TEE con root of trust di fabbrica.
**È esclusione per progetto, non configurazione sbagliata.** Nessuna opzione dell'AVD la aggira.

> ⚠️ **Una previsione caduta, e vale segnarla**: la ricerca preliminare dava l'app Play Console per
> «non compatibile» sugli AVD a 420 dpi, perché le varianti correnti sono distribuite a 480-640 dpi.
> **Falso**: il pulsante *Install* c'era e l'installazione è andata. Chi riprende non perda tempo a
> cambiare `hw.lcd.density`: non è lì il problema.

**Alternative cloud valutate e scartate**: Samsung Remote Test Lab (non si cambia l'account Google),
AWS Device Farm / BrowserStack (sconsigliano o impediscono il login con account Google personali).
L'unica ipotesi tecnicamente sensata resta **Android Device Streaming** di Firebase — dispositivi
*fisici* nei data center Google — ma **nessuno risulta averla usata per questa verifica**: è un
esperimento, non un piano.

---

## §2 — Le istruzioni da girare a chi presta il telefono

**Copia da qui in giù.**

> Ciao, mi serve un favore da un minuto sul tuo telefono Android. Non installo niente di strano:
> è l'app ufficiale di Google per chi pubblica app, e serve solo a confermare che ho accesso a un
> telefono vero.
>
> 1. Apri il **Play Store** e cerca **«Google Play Console»** (di Google LLC). Installala.
> 2. Aprila e accedi con l'account **erricoluigi17@gmail.com** (la password te la do io, oppure la
>    digito io sul tuo telefono).
> 3. Se ti chiede quale account sviluppatore, scegli **«Luigi Errico»**.
> 4. Tocca **«Verifica»** (*Verify*) e segui quello che dice a schermo.
> 5. Finito. Puoi disinstallare l'app e togliere il mio account dal telefono.
>
> **Cosa NON succede**, così stai tranquillo — sono le risposte ufficiali di Google:
> - *non prende il tuo numero di telefono*: «the phone number of the device used to verify is not
>   used or collected as part of device verifications»;
> - *non lega il tuo telefono al mio account per il futuro*: «We may ask you to verify in the
>   future, but you will not have to use same device»;
> - *non ti impedisce di fare lo stesso per qualcun altro*: «you can use the same device to verify
>   multiple accounts».

### Requisiti del telefono

| Requisito | Valore |
|---|---|
| Tipo | telefono o tablet **fisico** (mai emulatore) |
| Sistema | **Android 10 o superiore** |
| Root | **non rootato** |
| Rete | Wi-Fi o dati |

Testuale: *«You can use any non-rooted physical Android mobile device that runs at least the
Android 10 operating system.»*

### Chi deve fare l'accesso

**Solo il proprietario dell'account** (`erricoluigi17@gmail.com`) può completare la verifica — è
l'account con cui l'account sviluppatore è stato creato. Il telefono può essere di chiunque,
**l'accesso no**.

⚠️ Corollario di prudenza: se non vuoi digitare la tua password sul telefono di un altro, fallo tu
sul suo telefono e poi rimuovi l'account da *Impostazioni → Account*. La sessione resta finché non
la togli.

---

## §3 — Dove si clicca in Play Console

1. Play Console (web), **come proprietario dell'account**
2. **Home**
3. riquadro *«Completa la configurazione del tuo account sviluppatore»*
4. → **«Verifica di avere accesso a un dispositivo mobile Android»** → *Visualizza dettagli*
5. lì c'è un **QR code** che apre direttamente l'app sullo store del telefono

Fatta la verifica, **quella voce sparisce dalla Home**.

---

## §4 — La domanda ancora aperta, e come si scioglie

Il requisito è formulato così, in due articoli distinti della guida:

> *«developers with new **personal** accounts will be required to verify that they have access to a
> real Android mobile device»*
> *«**New personal accounts** will be required to verify that they have access to a real Android
> mobile device using the Play Console mobile app»*

**«personal accounts», non «all accounts».** Se la lettura regge, un account **organizzazione**
potrebbe non avere affatto questo adempimento — e la conversione (vedi
[C1](C1-account-play-e-tempi.md)) chiuderebbe **con una mossa sola** sia questo blocco sia quello
dei 12 tester.

🔴 **Non è una certezza, ed è onesto dirlo**: non esiste una frase di Google che dichiari esenti le
organizzazioni. È un'inferenza dal perimetro testuale.

**Come si scioglie, senza indovinare**: verificato il sito web, in
`Account sviluppatore → Dettagli account` si guarda se **`Cambia tipo di account`** si accende. Se
si accende con le verifiche ancora in sospeso, la conversione non le pretende — e la risposta
arriva da uno schermo invece che da un'interpretazione.

---

## §5 — Checklist

- [ ] Telefono Android fisico, non rootato, **Android 10+**, reperito in prestito
- [ ] App **Google Play Console** installata dal Play Store
- [ ] Accesso eseguito con **`erricoluigi17@gmail.com`** (il proprietario, non un delegato)
- [ ] Account sviluppatore **«Luigi Errico»** selezionato
- [ ] **Verifica** completata → la voce sparisce dalla Home di Play Console
- [ ] Account Google **rimosso** dal telefono prestato, app disinstallata
- [ ] Verificato a schermo se `Cambia tipo di account` è diventato cliccabile (§4)
