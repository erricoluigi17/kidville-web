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

- 8 screenshot telefono 1080×1920 + 4 tablet — non prodotti in questa sessione. Richiedono
  emulatore Android, dati demo della classe TEST rinfrescati (`creato_il` retrodatato), e un
  flow Maestro che eviti le quattro trappole già documentate in
  `docs/submission/C3-scheda-testi-grafica.md` §3.
- Lingua predefinita Play Console → **it-IT** (oggi presumibilmente `en-US`): da cambiare
  **prima** di caricare qualunque grafica ([C3 §0](../C3-scheda-testi-grafica.md)).
