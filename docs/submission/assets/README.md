# Asset grafici — Google Play (C3, parziale)

Prodotti in questa sessione, verificati e pronti per l'upload in Play Console → Presenza nello
store → Grafica.

**Rifatti su richiesta esplicita del titolare (2026-07-28): stessa immagine dell'icona iOS**
(`ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`), non più le versioni
composte da zero della sessione precedente — giudicate "bruttissime" a confronto.

| File | Specifica | Stato | Sorgente |
|---|---|---|---|
| `play-icon-512.png` | 512×512, PNG 32 bit **con** alpha, max 1024 KB | ✅ 307 KB, RGBA | `AppIcon-512@2x.png` (1024×1024) ridimensionata 1:1, nessun'altra modifica |
| `play-feature-graphic-1024x500.png` | 1024×500, PNG/JPEG 24 bit **senza** alpha | ✅ 271 KB, RGB | Stessa immagine, scalata a 500×500 e centrata su tela 1024×500; padding laterale nel teal `(5,107,102)` campionato dalla banda inferiore dell'icona stessa — fusione praticamente invisibile |

## ⚠️ Nota tecnica che resta valida (non bloccante, il titolare ne è consapevole)

`AppIcon-512@2x.png` è un mockup con angoli arrotondati e ombra **dipinti nei pixel** (non nel
canale alpha, che è assente/opaco). Google Play applica **la propria** maschera (raggio 30%) e
ombra sopra qualunque immagine caricata: il risultato sarà un'icona con **doppio bordo
arrotondato** visibile (uno dipinto, uno applicato da Play). È lo stesso trattamento già in
produzione su App Store — quindi coerente fra le due schede — ma non è l'ideale su Play, dove la
convenzione è caricare un quadrato pieno senza rifiniture pre-applicate. Se in fase di review
Play segnala l'icona o il risultato visivo non convince a schermo, la correzione è ri-generare
da `public/mascot.png` (piena tela, nessun mockup) — versione già prodotta e scartata in questa
sessione, recuperabile dalla history del branch.

## Decisione sulla mascotte — accettata dal titolare

`docs/submission/C4-conformita-pubblico.md` §2 raccomanda grafica sobria, **senza mascotte
cartoon**, per il rischio che Google riclassifichi l'app come rivolta ai minori. Il titolare ha
scelto consapevolmente di mantenerla anche sulla scheda Play, per coerenza con iOS. Dettagli nel
changelog PRD del 2026-07-27 (sezione "C3 (parziale)").

## Cosa manca ancora a C3

- ✅ **5 screenshot telefono PRODOTTI** (aggiornato il 2026-07-28) in
  `playstore/screenshots/phone/`: `01-avvisi` · `02-diario` · `03-presenze` · `04-mensa` ·
  `05-pagamenti`. Tutti **1080×1920 esatti** e **RGB senza canale alpha**, verificati uno per
  uno con `sips -g hasAlpha` (le prime tre erano state catturate con `adb exec-out screencap`,
  che produce RGBA, e sono state riconvertite: l'alpha su uno screenshot è l'errore di upload
  più comune e il messaggio di Play non è esplicito).
  Sono **sopra la soglia**: il minimo per pubblicare è 2, quello per l'idoneità alle promozioni
  è 4 a ≥1080 px in 9:16. La scheda è caricabile così com'è.
- Mancano ancora **3 schermate telefono** (modulistica, news, profilo — stanno in fondo al
  foglio MENU, dove il tap automatico non naviga) e i **4 screenshot tablet**. Non bloccano la
  pubblicazione; da verificare a schermo se Play pretenda i tablet per pubblicare o solo per
  l'idoneità ai dispositivi grandi.
- Lingua predefinita Play Console → **it-IT** (oggi presumibilmente `en-US`): da cambiare
  **prima** di caricare qualunque grafica ([C3 §0](../C3-scheda-testi-grafica.md)).
