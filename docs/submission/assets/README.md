# Asset grafici — Google Play (C3, parziale)

Prodotti in questa sessione, verificati e pronti per l'upload in Play Console → Presenza nello
store → Grafica.

| File | Specifica | Stato | Note |
|---|---|---|---|
| `play-icon-512.png` | 512×512, PNG 32 bit **con** alpha, max 1024 KB, quadrato pieno | ✅ 254 KB, RGBA, alpha=255 ovunque | Ritagliata da `public/mascot.png` (sfondo giallo pieno, nessun arrotondamento/ombra) |
| `play-feature-graphic-1024x500.png` | 1024×500, PNG/JPEG 24 bit **senza** alpha | ✅ 166 KB, RGB | Disegnata da zero: pannello bicolore Clay Village (teal + mascotte), nessun testo |

## Perché non sono un resize diretto degli asset di brand esistenti

`assets/icon-only.png`, `assets/logo.png`, `assets/icon-foreground.png` sono mockup con angoli
arrotondati e ombra **dipinti nei pixel** (non nel canale alpha — un `resize` diretto avrebbe
prodotto il doppio-arrotondamento/doppio-alone quando Play applica la propria maschera). Usato
invece `public/mascot.png`, che è un ritaglio pulito a piena tela senza trattamento da mockup.

## Decisione sulla mascotte — accettata dal titolare

`docs/submission/C4-conformita-pubblico.md` §2 raccomanda grafica sobria, **senza mascotte
cartoon**, per il rischio che Google riclassifichi l'app come rivolta ai minori. Nel repo non
esiste alcun asset di brand privo di mascotte: il titolare ha scelto consapevolmente di
mantenerla anche sulla scheda Play. Dettagli e motivazione completa nel changelog PRD del
2026-07-27 (sezione "C3 (parziale)").

## Cosa manca ancora a C3

- Icona: **rivedere il ritaglio** — il cilindro è leggermente tagliato in alto, verificare a
  schermo prima di caricare.
- 8 screenshot telefono 1080×1920 + 4 tablet — non prodotti in questa sessione. Richiedono
  emulatore Android, dati demo della classe TEST rinfrescati (`creato_il` retrodatato), e un
  flow Maestro che eviti le quattro trappole già documentate in
  `docs/submission/C3-scheda-testi-grafica.md` §3.
- Lingua predefinita Play Console → **it-IT** (oggi presumibilmente `en-US`): da cambiare
  **prima** di caricare qualunque grafica ([C3 §0](../C3-scheda-testi-grafica.md)).
