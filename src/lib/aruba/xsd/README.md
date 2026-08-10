# Schema ufficiale FatturaPA — copia locale

Questi due file **non sono nostri**: sono scaricati tali e quali dalle fonti ufficiali e
committati qui perché la validazione del tracciato non dipenda dalla rete. Servono a
`__tests__/lib/aruba/valida-xsd.ts`, che li dà in pasto a `xmllint` (libxml2 compilato in
WebAssembly) per verificare che l'XML prodotto da `src/lib/aruba/fatturapa-xml.ts` sia
accettabile per lo SdI.

| File | Origine | Scaricato il | sha256 |
|---|---|---|---|
| `Schema_VFPR12_v1.2.3.xsd` | <https://www.fatturapa.gov.it/export/documenti/fatturapa/v1.4/Schema_VFPR12_v1.2.3.xsd> | 2026-08-09 | `152944f6eef9f5d69ef6e955ee173b32142b00a8c1c5222fc97dfab5910e8a8c` |
| `xmldsig-core-schema.xsd` | <https://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd> | 2026-08-09 | `35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c` |

Le due impronte sono verificate da un test in `__tests__/lib/aruba/fatturapa-xsd.test.ts`.
Non è una formalità: se lo schema si potesse ritoccare, il modo più rapido di far passare un
generatore rotto sarebbe allargare un `pattern` invece di correggere il codice, e il verdetto
«valido» non varrebbe più niente. Un aggiornamento legittimo si fa **riscaricando dagli URL
qui sopra** e aggiornando insieme file, impronta e data.

## Perché il secondo file

`Schema_VFPR12_v1.2.3.xsd` importa la firma XML **da un URL HTTP**:

```xml
<xs:import namespace="http://www.w3.org/2000/09/xmldsig#"
           schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd" />
```

Senza la copia locale, `xmllint` proverebbe a risolverlo: dentro il WASM non c'è stack di rete,
l'import fallirebbe, `ds:Signature` resterebbe irrisolto e **lo schema non compilerebbe affatto**
— cioè i test sarebbero rossi (o, peggio, verdi per il motivo sbagliato) per una ragione che non
ha niente a che vedere con la fattura. In CI sarebbe anche una dipendenza di rete verso w3.org
dentro il gate.

I file su disco restano **byte per byte** quelli pubblicati: la `schemaLocation` viene riscritta
**in memoria** all'atto della validazione (`valida-xsd.ts`). Modificare il file scaricato sarebbe
stato più semplice e avrebbe tolto l'unica cosa che rende credibile il verdetto: la provenienza.

## Cosa dicono le fonti ufficiali (misurato il 2026-08-09)

- Pagina *Norme e regole → Documentazione Fattura elettronica → FatturaPA*, sezione
  **«Documentazione valida dal 1 aprile 2025»**: schema del file xml **versione 1.2.3**,
  *Specifiche tecniche del formato della FatturaPA* **versione 1.4**.
- Sulla stessa pagina, «Schema del file xml FatturaPA versione 1.2.3» (`Schema_VFPA12_V1.2.3.xsd`,
  verso PA) e «Schema del file xml Fattura Ordinaria» (`Schema_VFPR12_v1.2.3.xsd`, verso privati)
  sono **due link allo stesso identico contenuto**: md5 `80d1e0b559a99aa1e2fd546ed4219c7a` per
  entrambi. Un solo schema copre `FPA12` e `FPR12` — infatti `FormatoTrasmissioneType` enumera
  tutti e due. Per questo qui ne sta **uno solo**: committare anche l'altro sarebbe committare
  due volte lo stesso file.
- Il *Sistema di Interscambio* è documentato a parte: le *Specifiche tecniche relative al SdI*
  **valide dal 15 maggio 2026** sono la **versione 1.8.4** (con l'*Elenco controlli* 2.0), e
  riguardano il canale, non il tracciato. **Non cambiano lo schema XML**, che resta 1.2.3.

Kidville emette **solo** `FPR12` (fatture verso privati, `CodiceDestinatario 0000000`): è il
formato che questo schema valida.
