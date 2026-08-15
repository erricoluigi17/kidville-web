# Carta intestata reale e modulistica — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: usa `superpowers:test-driven-development` per ogni
> task e `superpowers:verification-before-completion` prima di dichiarare qualcosa fatto. Gli step
> usano la sintassi checkbox (`- [ ]`). **Non dichiarare mai un task completo senza aver incollato
> l'output del comando che lo prova.**

**Goal:** far uscire ogni PDF dell'app sulla carta intestata reale della scuola, compilare
l'anagrafica delle tre sedi, riparare l'archiviazione che oggi fa fallire il 100% delle firme, e
dare al genitore i certificati che oggi deve chiedere alla segreteria.

**Architecture:** un modulo `src/lib/carta/` diventa l'unico posto dove la carta intestata si
applica: jsPDF produce il contenuto su fondo trasparente, pdf-lib usa il PDF reale della scuola come
base e ci stampa sopra la pagina. I cinque motori PDF esistenti smettono di avere ciascuno la
propria testata. Sopra questo, tre riparazioni indipendenti (ENUM di archiviazione, anagrafica delle
sedi, collegamento gite) e due pulizie.

**Tech Stack:** Next.js App Router · TypeScript · jsPDF 4.2 + jspdf-autotable 5 · pdf-lib 1.17 ·
Supabase (PostgREST + Storage) · vitest · Playwright · Maestro

**Spec:** [`docs/superpowers/specs/2026-08-15-carta-intestata-e-modulistica-design.md`](../specs/2026-08-15-carta-intestata-e-modulistica-design.md)

---

## Regole che valgono per OGNI task

Non negoziabili, da `AGENTS.md`:

1. **Mai `console.*` in `src/`** — si usa `@/lib/logging/logger` (`logOk`, `logErrore`, `logEvento`).
2. **Ogni nuova route nasce in `withRoute`** — il lock `__tests__/architecture/logging-coverage.test.ts` lo verifica.
3. **Un `catch` che non logga è un bug.** `.catch(() => {})` è vietato.
4. **PostgREST non lancia**: `await supabase.from(…)` ritorna `{ error }`, va controllato il valore.
5. **Mai dati personali nei log.** Allergie, terapie, diete, CF, nomi → redatti o hash.
6. **Ogni scrittura dichiara la sua sede.** `resolveScuolaScrittura` risponde 400 se non è dichiarata.
7. **Il repository è pubblico**: mai segreti, mai PII reali di famiglie o bambini.
8. **Ogni modifica aggiorna il PRD** (`PRD REGISTRO ELETTRONICO.md`).

Gate formale prima di dichiarare finito un workstream:

```bash
npx eslint . --max-warnings 0
npx tsc --noEmit
npx vitest run
npm run build
```

⚠️ **`npm run e2e` e `npm run e2e:seed` sono in `deny` in locale**: `.env.local` punta al DB di
**produzione** e il seed scriverebbe dentro i dati veri di 324 bambini. L'E2E si verifica **in CI**.

---

## File Structure

### Creati

| File | Responsabilità |
|---|---|
| `src/lib/carta/asset/carta-intestata.pdf` | ✅ già in repo. Il PDF reale, byte per byte. **Non si modifica.** |
| `src/lib/carta/asset.ts` | Carica l'asset come `Uint8Array`, una volta sola (memoizzato). Nient'altro. |
| `src/lib/carta/geometria.ts` | Le misure della carta in mm, in un posto solo: banda brand 12,5→26,8 · piede 272,1→285,0 · area libera 27→272. |
| `src/lib/carta/applica.ts` | `applicaCartaIntestata(pdfBytes): Promise<Uint8Array>` — pdf-lib, la carta come base, il contenuto sopra. |
| `src/lib/carta/index.ts` | Superficie pubblica del modulo. |
| `supabase/migrations/20260815T2100_document_type_prestampati.sql` | `ALTER TYPE document_type_enum ADD VALUE` × 17. |
| `supabase/migrations/20260815T2110_drop_certificati_templates.sql` | `DROP TABLE IF EXISTS certificati_templates`. |
| `src/app/api/admin/registro-presenze/pdf/route.ts` | Registro presenze generato server-side (oggi è nel browser). |
| `__tests__/lib/carta-asset-lock.test.ts` | Blinda il SHA-256 dell'asset. |
| `__tests__/lib/carta-applica.test.ts` | La carta finisce su tutte le pagine, il contenuto sta nell'area libera. |
| `__tests__/lib/gdpr-bucket-sensitive.test.ts` | `sensitive_documents` è nel registro dell'oblio. |

### Modificati

| File | Cosa cambia |
|---|---|
| `src/lib/prestampati/impaginazione.ts:164-265` | Via banda verde, logo e piede predefinito. `LIMITE_CONTENUTO` 272→266, `Y_INTESTAZIONE` 38→40, `Y_TITOLO_MIN` 58→60, `piePagina` 287→268,5. |
| `src/lib/protocolli/documento-pdf.ts:26-48` | Smette di ridisegnare la testata: chiama il motore comune. |
| `src/lib/fea/receipt-pdf.ts` | Applica la carta. |
| `src/app/api/admin/merch/ordini-fornitore/pdf/route.ts` | Applica la carta. |
| `src/components/features/teacher/attendance/MonthlyAttendanceTable.tsx:210-306` | Non genera più: chiama la nuova route. |
| `src/lib/certificati/self-service.ts:38-52` | `buildIntestazioneSede` resta com'è; è `indirizzo` a ripulirsi. |
| `src/app/api/parent/prestampati/banco-famiglia.ts:177,245-280` | Via `CONTESTO_NON_DISPONIBILE`; il n.10 dipende da un'uscita reale. |
| `src/app/api/parent/prestampati/route.ts` | Il n.10 non compare se non c'è uscita. |
| `src/app/api/parent/prestampati/firma/route.ts` | Archiviazione con i nuovi valori dell'enum. |
| `src/app/api/prestampati/banco.ts:189-284` | I 17 modelli generabili, tre modalità (firmata/vuota/su carta). |
| `src/app/api/prestampati/genera/route.ts` | Riuso del certificato archiviato; «genera nuovo» esplicito. |
| `src/components/features/prestampati/PrestampatiGenitore.tsx` | Riscarico, «Generane uno nuovo», niente lucchetto sul n.10. |
| `src/components/features/prestampati/PrestampatiSegreteria.tsx` | Tre modalità sui moduli di famiglia. |
| `src/app/(dashboard)/parent/modulistica/page.tsx:111,452,858-890` | Via i due pulsanti legacy e `generateSelfServiceCertificate`. |
| `src/app/(dashboard)/admin/modulistica/page.tsx:106,137,165-168,552,721-806` | Via tab ODT e valore `attesa`. |
| `messages/{it,en}/adminModulistica.json:189,209-216` | Via le 9 chiavi ODT. |
| `messages/{it,en}/prestampatiGenitore.json` | Testi nuovi (riscarico, genera nuovo); via il motivo `uscita-non-creata`. |
| `__tests__/architecture/messaggi-plurali-e-glossario.test.ts:482` | Via la riga di allowlist. |
| `__tests__/lib/prestampati-impaginazione.test.ts:235-257,341-367` | Nuove attese: niente banda, carta su ogni pagina. |
| `src/lib/gdpr/esegui.ts` | `sensitive_documents` in `REGISTRO_BUCKET_OBLIO`. |
| `src/app/api/teacher/uscite/route.ts` | L'uscita accende il n.10 + notifica. Il Sistema B non crea più moduli gita. |
| `PRD REGISTRO ELETTRONICO.md` | Changelog datato + tabelle di stato. |

---

## Dipendenze fra workstream

```
W2 (ENUM) ──┬──→ W4 (genitore)
            └──→ W5 (segreteria)
W1 (carta) ─────→ W9 (motori residui)
W3 (anagrafica)  ─┐
W6 (gite)         ├── indipendenti, in parallelo
W7 (pulizia)      │
W8 (GDPR)        ─┘
```

**W2 e W1 partono per primi.** W4 e W5 non possono iniziare prima di W2: senza l'enum
misurerebbero un guasto invece di una funzione.

---

# W1 · Il motore della carta intestata

### Task 1.1: Il lock sull'asset

**Files:**
- Test: `__tests__/lib/carta-asset-lock.test.ts`
- Create: `src/lib/carta/asset.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { cartaIntestataBytes } from '@/lib/carta/asset'

// Il PDF è la carta intestata reale della scuola, fornita dal titolare il 2026-08-15.
// NON si ricomprime, non si ottimizza, non si ritaglia: una ricompressione lossless
// ridurrebbe il peso senza cambiare l'aspetto, ma cambierebbe i byte — e la carta di
// una scuola non è un asset da "migliorare" senza che nessuno se ne accorga.
const SHA256_ATTESO = '6946d21216594797b8b8e6feb3c582a64caae3baa9adbdf76aa2590b19b8cceb'

describe('asset della carta intestata', () => {
  it('è il file esatto fornito dalla scuola, byte per byte', () => {
    const bytes = cartaIntestataBytes()
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA256_ATTESO)
    expect(bytes.byteLength).toBe(1_097_589)
  })

  it('è un PDF di una pagina sola, A4 esatto', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.load(cartaIntestataBytes())
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(595.276, 2)
    expect(height).toBeCloseTo(841.89, 2)
  })

  it('si carica una volta sola', () => {
    expect(cartaIntestataBytes()).toBe(cartaIntestataBytes())
  })
})
```

- [ ] **Step 2: Verifica che fallisca**

Run: `npx vitest run __tests__/lib/carta-asset-lock.test.ts`
Atteso: FAIL, `Cannot find module '@/lib/carta/asset'`

- [ ] **Step 3: Implementa**

`src/lib/carta/asset.ts` — la lettura da filesystem **non è tracciata dal bundler su Vercel**
(è il motivo per cui `src/lib/protocolli/assets.ts` usa base64 inline). Verifica quale delle due
strade regge il `npm run build` **e** il deploy: se `readFileSync` con path risolto non arriva nel
bundle serverless, converti in base64 come già fa `assets.ts`. Decidi misurando, non per opinione.

- [ ] **Step 4: Verifica che passi**

Run: `npx vitest run __tests__/lib/carta-asset-lock.test.ts` → PASS (3 test)

- [ ] **Step 5: Commit**

```bash
git add src/lib/carta/asset.ts __tests__/lib/carta-asset-lock.test.ts
git commit -m "La carta intestata entra nel repo con il suo SHA-256 come lock"
```

### Task 1.2: La geometria, in un posto solo

**Files:**
- Create: `src/lib/carta/geometria.ts`
- Test: `__tests__/lib/carta-geometria.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest'
import { CARTA } from '@/lib/carta/geometria'

// Misure rilevate a 150 dpi sul rendering del PDF reale, non stimate.
describe('geometria della carta intestata', () => {
  it('conosce dove sta il marchio e dove sta il piede', () => {
    expect(CARTA.brandFine).toBeCloseTo(26.8, 1)
    expect(CARTA.piedeInizio).toBeCloseTo(272.1, 1)
    expect(CARTA.piedeFine).toBeCloseTo(285.0, 1)
  })

  it("l'area libera non tocca né il marchio né il piede", () => {
    expect(CARTA.contenutoInizio).toBeGreaterThan(CARTA.brandFine)
    expect(CARTA.contenutoFine).toBeLessThan(CARTA.piedeInizio)
  })

  it('lascia almeno 5 mm di aria sopra il piede stampato', () => {
    expect(CARTA.piedeInizio - CARTA.contenutoFine).toBeGreaterThanOrEqual(5)
  })
})
```

- [ ] **Step 2-5:** falla fallire, implementa (`contenutoInizio: 40`, `contenutoFine: 266`,
      `rigaServizio: 268.5`), falla passare, committa.

### Task 1.3: `applicaCartaIntestata`

**Files:**
- Create: `src/lib/carta/applica.ts`, `src/lib/carta/index.ts`
- Test: `__tests__/lib/carta-applica.test.ts`

L'ordine è **obbligatorio**: jsPDF non disegna un fondo bianco, quindi la carta va **sotto**. Con
pdf-lib: la pagina della carta è la **base**, la pagina jsPDF si stampa **sopra** con `drawPage`.
`embedPdf` una volta sola per documento — le pagine riusano lo stesso form XObject.

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest'
import { PDFDocument, rgb } from 'pdf-lib'
import { applicaCartaIntestata } from '@/lib/carta/applica'

async function pdfDiProva(pagine: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pagine; i++) {
    const p = doc.addPage([595.276, 841.89])
    p.drawText(`pagina ${i + 1}`, { x: 62, y: 700, size: 12, color: rgb(0.18, 0.18, 0.18) })
  }
  return doc.save()
}

describe('applicaCartaIntestata', () => {
  it('mette la carta su OGNI pagina, non solo sulla prima', async () => {
    const out = await applicaCartaIntestata(await pdfDiProva(3))
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(3)
    for (const p of doc.getPages()) {
      // ogni pagina porta un form XObject: è la carta incorporata
      const risorse = p.node.Resources()
      expect(risorse?.lookup(require('pdf-lib').PDFName.of('XObject'))).toBeDefined()
    }
  })

  it('non altera il numero di pagine né il formato', async () => {
    const doc = await PDFDocument.load(await applicaCartaIntestata(await pdfDiProva(2)))
    const { width, height } = doc.getPage(1).getSize()
    expect(width).toBeCloseTo(595.276, 2)
    expect(height).toBeCloseTo(841.89, 2)
  })

  it('incorpora la carta una volta sola anche su 5 pagine', async () => {
    const una = (await applicaCartaIntestata(await pdfDiProva(1))).byteLength
    const cinque = (await applicaCartaIntestata(await pdfDiProva(5))).byteLength
    // se l'asset fosse duplicato per pagina, cinque pesherebbe ~5×
    expect(cinque).toBeLessThan(una * 2)
  })

  it('non lancia su un PDF vuoto e non rompe il chiamante', async () => {
    const doc = await PDFDocument.create()
    await expect(applicaCartaIntestata(await doc.save())).resolves.toBeInstanceOf(Uint8Array)
  })
})
```

- [ ] **Step 2-5:** falla fallire, implementa, falla passare, committa.

⚠️ Il terzo test è quello che conta davvero: è la differenza fra 1,1 MB a documento e 1,1 MB a
pagina. Un registro presenze di 12 pagine peserebbe 13 MB invece di 1,2.

### Task 1.4: Il motore prestampati passa alla carta

**Files:**
- Modify: `src/lib/prestampati/impaginazione.ts:23,164-211,253-265`, costanti `:34-93`
- Modify: `__tests__/lib/prestampati-impaginazione.test.ts:235-257,341-367`

- [ ] **Step 1: Riscrivi le attese del test esistente**

Il test oggi asserisce *«la banda verde è alta 30 mm e il logo sta a 14 / 7,5 in 44 × 14,8»*.
Quell'asserzione **deve morire**: la banda copre il logo della carta vera. Sostituiscila con:

```ts
it('non disegna più né banda né logo: la carta ce li ha già', () => {
  const pdf = buildPrestampatoPdf(documentoDiProva())
  expect(immaginiDisegnate(pdf)).toHaveLength(0)
  const bande = ingombriPercorsi(pdf).filter(p => p.altezza > 25 && p.larghezza > 200)
  expect(bande).toHaveLength(0)
})

it('nessun elemento entra nella fascia del marchio né in quella del piede', () => {
  const pdf = buildPrestampatoPdf(documentoDiProva())
  for (const el of elementiTesto(pdf)) {
    expect(el.y).toBeGreaterThan(CARTA.brandFine)
    expect(el.y).toBeLessThan(CARTA.piedeInizio)
  }
})
```

- [ ] **Step 2:** `npx vitest run __tests__/lib/prestampati-impaginazione.test.ts` → FAIL
- [ ] **Step 3:** togli `rect(0,0,210,30,'F')`, `addImage(LOGO_LIGHT_PNG_BASE64,…)`, il piede
      predefinito e `Y_PIEDE`; porta `LIMITE_CONTENUTO` a `CARTA.contenutoFine`, `Y_INTESTAZIONE` a
      40, `Y_TITOLO_MIN` a 60; sposta `piePagina` e `Pagina n di m` a `CARTA.rigaServizio`.
- [ ] **Step 4:** `npx vitest run __tests__/lib/prestampati-impaginazione.test.ts` → PASS
- [ ] **Step 5:** commit

### Task 1.5: Prova visiva su un documento vero

- [ ] Genera un certificato di iscrizione e frequenza reale, salvalo, convertilo:
      `pdftoppm -r 150 -png out.pdf out`
- [ ] **Guardalo.** Il logo della carta è integro? La filigrana si vede sotto il testo senza
      renderlo illeggibile? Il piede a 4 colonne è intatto? Nessun testo lo tocca?
- [ ] Ripeti su un documento di 3 pagine (verbale d'infortunio) e su uno lungo (registro presenze).
- [ ] Commit.

---

# W2 · L'ENUM di archiviazione

**È il primo passo del piano.** Senza, W4 e W5 non possono funzionare.

### Task 2.1: La migrazione

**Files:**
- Create: `supabase/migrations/20260815T2100_document_type_prestampati.sql`

I 17 slug, presi da `src/lib/prestampati/registro.ts` (non inventati):
`scheda_sanitaria`, `autorizzazione_farmaci`, `dieta_speciale`, `delega_ritiro`, `permesso_orario`,
`autorizzazione_uscita`, `certificato_iscrizione_frequenza`, `certificato_bonus_nido`, `nulla_osta`,
`richiesta_disponibilita`, `sollecito_pagamento`, `verbale_infortunio`, `valutazione_infanzia`,
`certificato_competenze`, `certificato_servizio`, `stampe_sezione`, `registro_presenze`.

- [ ] **Step 1:** scrivi la migrazione con `ALTER TYPE document_type_enum ADD VALUE IF NOT EXISTS '…'`
      per ciascuno. **Postgres non ammette l'uso di un valore aggiunto nella stessa transazione che
      lo crea**: verifica se `apply_migration` esegue in transazione e, in caso, spezza in migrazioni
      separate o usa `COMMIT` espliciti.
- [ ] **Step 2:** **mostra la migrazione all'utente prima di applicarla.** In produzione ci sono
      dati reali di 324 minori e nessuno chiederà conferma: *mostrare non è chiedere, non costa
      niente, ed è l'unica cosa rimasta fra un errore e quei bambini.*
- [ ] **Step 3:** applica con `mcp__supabase__apply_migration`.
- [ ] **Step 4:** verifica: `SELECT enum_range(NULL::document_type_enum);` → 21 valori.
- [ ] **Step 5:** `mcp__supabase__get_advisors` → **0 ERROR**.
- [ ] **Step 6:** commit.

### Task 2.2: Degrado pulito sul DB E2E non migrato

- [ ] **Step 1:** test che un INSERT con slug nuovo su un DB senza l'enum esteso produca `22P02` e
      venga **classificato**, non propagato come 500.
- [ ] **Step 2-5:** falla fallire, implementa in `banco-famiglia.ts` (l'`ENUM_NON_AMMESSO` esiste già
      a `:592-595`), falla passare, committa.

---

# W3 · L'anagrafica delle tre sedi

### Task 3.1: Censimento dei lettori di `scuole.indirizzo`

- [ ] `grep -rn "\.indirizzo\|scuola_indirizzo" src/` — elenca **ogni** consumatore.
- [ ] Per ciascuno, decidi se la riduzione a sola via lo rompe. Scrivi l'esito nel commit.

### Task 3.2: Test sull'intestazione senza duplicazione

**Files:** `__tests__/lib/certificati-self-service.test.ts`

- [ ] **Step 1: Test**

```ts
it("non ripete città e provincia quando l'indirizzo è la sola via", () => {
  const righe = buildIntestazioneSede({
    scuola_nome: 'Kidville Giugliano',
    scuola_indirizzo: 'Via Prima Traversa Antica Giardini 5',
    scuola_cap: '80014',
    scuola_citta: 'Giugliano in Campania',
    scuola_provincia: 'NA',
    scuola_codice_meccanografico: 'NA1A079004 · NA1E094004',
  })
  expect(righe[1]).toBe('Via Prima Traversa Antica Giardini 5 — 80014 Giugliano in Campania (NA)')
  // il difetto stampato sul certificato reale del 15/08/2026:
  expect(righe[1]).not.toMatch(/\(NA\).*Giugliano/)
})
```

- [ ] **Step 2-5:** verifica, correggi se serve, committa.

### Task 3.3: Scrittura dei valori in produzione

**Dalla UI, non con `UPDATE`.** Il percorso applicativo esercita `normalizzaAnagraficaSede`, il gate
`requireStaff` e l'audit `logScrittura`; un `UPDATE` a mano li salta tutti e tre e non prova che la
schermata funziona.

- [ ] **Step 1:** avvia il server locale. ⚠️ La `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` **non è
      quella del progetto** e nessun account supera il login. Si aggira così:

```bash
K=$(supabase projects api-keys --project-ref uimulkjyekgemjakmepp --experimental -o json \
    | python3 -c "import json,sys;print([r['api_key'] for r in json.load(sys.stdin) if r['name']=='service_role'][0])")
echo "${#K}"   # deve stampare 219 e la chiave comincia per eyJhb
SUPABASE_SERVICE_ROLE_KEY="$K" npx next dev --port 3100
```

Senza `-o json` l'output è tabellare e un `awk '{print $NF}'` prende 444 caratteri di spazzatura che
cominciano per `key","` e danno `Invalid API key`.

- [ ] **Step 2:** apri **Impostazioni → Sede & Intestazione** e compila le tre sedi con la tabella
      §2.1 della spec. Una sede per volta, verificando dopo ogni salvataggio.
- [ ] **Step 3:** verifica in lettura:
      `SELECT nome, citta, indirizzo, config->'anagrafica' FROM scuole ORDER BY nome;`
- [ ] **Step 4:** genera un certificato per ciascuna delle tre sedi e **guardalo**: intestazione
      completa, nessuna duplicazione, Bonus Nido finalmente generabile.
- [ ] **Step 5:** commit (i valori stanno nel DB, il commit documenta l'operazione nel PRD).

---

# W4 · Il genitore

**Non iniziare prima che W2 sia verde.**

### Task 4.1: Via i due pulsanti legacy

- [ ] Rimuovi `generateSelfServiceCertificate` e i pulsanti a
      `src/app/(dashboard)/parent/modulistica/page.tsx:452,863,883` + `NotaCopiaFamiglia` se resta
      orfana. Verifica gli import inutilizzati (`eslint --max-warnings 0` li trova).
- [ ] Commit.

### Task 4.2: I certificati dal motore vero

- [ ] Test: il genitore genera 26·27 e 28 → PDF su carta intestata, protocollato, archiviato in
      `student_documents`, firma `legaleRappresentante` (**mai** «Il Dirigente Scolastico»).
- [ ] Test: il 28 senza `autorizzazione_nido` risponde 422 con motivo leggibile, non 500.
- [ ] Implementa, verifica, committa.

### Task 4.3: Il riscarico identico

Regola, testuale dal titolare: *«una volta che il genitore ha scaricato il suo certificato, quel
certificato resta salvato, e quando lo va a riprendere riscarica sempre lo stesso»*.

- [ ] Test: seconda richiesta dello stesso certificato per lo stesso alunno → **stesso file, stesso
      numero di protocollo**, nessun nuovo record in `protocolli`.
- [ ] Test: «Generane uno nuovo» → protocollo nuovo, data nuova, il precedente resta in archivio.
- [ ] Implementa, verifica, committa.

### Task 4.4: I moduli firmati riscaricabili

- [ ] Test: dopo la firma di 05/07/09, il documento compare nell'elenco del genitore e si riscarica.
- [ ] Implementa, verifica, committa.

---

# W5 · La segreteria

**Non iniziare prima che W2 sia verde.**

### Task 5.1: Le tre modalità

- [ ] Test per ciascuna: **copia firmata** (dal fascicolo), **copia vuota** (righe da firmare a
      penna invece del riquadro FEA), **compilazione al posto del genitore** (dicitura *«Modulo
      consegnato su carta il gg/mm/aaaa, firmato in originale agli atti»*, **nessuna scansione**).
- [ ] Test: nessun modulo di famiglia resta nella lista «non generabili» per `firma_da_raccogliere`.
- [ ] Implementa, verifica, committa.

---

# W6 · Le gite

### Task 6.1: Il n.10 dipende da un'uscita reale

- [ ] **Step 1: Test**

```ts
it('non compare affatto quando non ci sono uscite per la sezione', async () => {
  const elenco = await elencoFamiglia({ uscite: [] })
  expect(elenco.map(m => m.slug)).not.toContain('autorizzazione_uscita')
})

it("compare con destinazione, data e orari quando l'uscita esiste", async () => {
  const elenco = await elencoFamiglia({ uscite: [USCITA_DI_PROVA] })
  const dieci = elenco.find(m => m.slug === 'autorizzazione_uscita')
  expect(dieci?.firmabileOra).toBe(true)
  expect(dieci?.contesto?.destinazione).toBe(USCITA_DI_PROVA.titolo)
})
```

- [ ] **Step 2-5:** togli `CONTESTO_NON_DISPONIBILE` (`banco-famiglia.ts:177`), costruisci
      `DatiUscita` da `eventi_agenda` (`tipo='uscita'`), verifica, committa.

### Task 6.2: Notifica push + campanella

- [ ] Test: alla pubblicazione dell'uscita parte una push e nasce una voce nel Centro Notifiche per
      i genitori di quella sezione. **Nessuna email** — scelta esplicita.
- [ ] ⚠️ Il logging: l'evento va loggato **anche in caso di successo**. Con i soli errori, *«nessun
      log» non distingue «tutto ok» da «non è mai partito niente»* — è l'ambiguità che ha nascosto
      per mesi il guasto delle email.
- [ ] Implementa, verifica, committa.

### Task 6.3: Il Sistema B smette di creare moduli gita

- [ ] `src/app/api/teacher/uscite/route.ts` non crea più la riga in `forms_templates`.
- [ ] Le gite già pubblicate restano leggibili: si spegne la **creazione**, non la lettura.
- [ ] Implementa, verifica, committa.

---

# W7 · Pulizia

### Task 7.1: Tab ODT e residui

- [ ] Rimuovi da `src/app/(dashboard)/admin/modulistica/page.tsx`: `'odt'` (:106), `'attesa'` (:106),
      il ramo `tabParam === 'odt'` (:137), i 3 `useState` (:165-168), la voce Tabs (:552), il blocco
      (:721-806). Controlla gli import `Settings`/`Upload` rimasti orfani.
- [ ] Rimuovi le 9 chiavi da `messages/it/adminModulistica.json` **e** da `messages/en/…` (i test di
      architettura confrontano i due file).
- [ ] Rimuovi la riga di allowlist da `__tests__/architecture/messaggi-plurali-e-glossario.test.ts:482`.
- [ ] `npx vitest run __tests__/architecture/` → PASS. `npx eslint . --max-warnings 0` → 0.
- [ ] Commit.

### Task 7.2: `DROP TABLE certificati_templates`

- [ ] Verifica prima: `SELECT count(*) FROM certificati_templates;` — se ha righe, **fermati e
      chiedi**. Zero righe di codice la usano, ma il DB è quello vero.
- [ ] **Mostra la migrazione** prima di applicarla.
- [ ] Applica, `get_advisors` → 0 ERROR, commit.

---

# W8 · Oblio GDPR

### Task 8.1: `sensitive_documents` nel registro dell'oblio

- [ ] **Step 1: Test**

```ts
it('svuota anche il bucket dei documenti sanitari dei minori', () => {
  // Ci finiscono schede sanitarie, terapie farmacologiche e diete speciali:
  // dati dell'art. 9 GDPR. Una richiesta di cancellazione DEVE toccarli.
  expect(REGISTRO_BUCKET_OBLIO).toContain('sensitive_documents')
})
```

- [ ] **Step 2-5:** verifica il fallimento, aggiungi il bucket in `src/lib/gdpr/esegui.ts`, verifica,
      committa.

---

# W9 · I motori residui

### Task 9.1: Protocolli, FEA, merch

- [ ] `src/lib/protocolli/documento-pdf.ts` smette di ridisegnare la testata e chiama il motore
      comune. **È la fine della doppia manutenzione**: oggi ripete le stesse misure di
      `impaginazione.ts` e due copie divergono sempre.
- [ ] `src/lib/fea/receipt-pdf.ts` e il PDF merch applicano la carta.
- [ ] Verifica visiva su un documento per motore. Commit.

### Task 9.2: Registro presenze server-side

- [ ] Nuova route `src/app/api/admin/registro-presenze/pdf/route.ts` **in `withRoute`**, con gate di
      ruolo e validazione `zod` (il lock `zod-coverage` lo pretende).
- [ ] `MonthlyAttendanceTable.tsx` non genera più: chiama la route.
- [ ] Verifica: il bundle client **non** contiene l'asset da 1,1 MB.
- [ ] Commit.

---

# W10 · Chiusura

### Task 10.1: PRD

- [ ] Aggiorna `PRD REGISTRO ELETTRONICO.md`: tabelle di stato + voce di changelog datata
      **2026-08-15**. Rimuovi le voci del tab ODT (righe 12686, 12722-12725) e la menzione nel
      changelog del 2026-07-06 (righe 9974, 9980).
- [ ] **Non toccare** «Moduli Esterni» e «Iscrizioni Nuovi Alunni»: fuori scope, decisione esplicita.
- [ ] Commit.

### Task 10.2: Il gate

- [ ] `npx eslint . --max-warnings 0` → 0
- [ ] `npx tsc --noEmit` → 0 (la CI lo fa anche sui `__tests__`: build e vitest locali non lo colgono)
- [ ] `npx vitest run` → tutti verdi
- [ ] `npm run build` → ok
- [ ] Push, PR, **CI verde contando TUTTI i job**: `gh run view --json jobs`. `gh run watch` può
      uscire **0** seguendo un job solo mentre un altro dello stesso run è morto.
- [ ] ⚠️ La CI può cadere per **Google Fonts**: se fallisce lì, riesegui prima di indagare.

---

## Self-review — copertura della spec

| Sezione spec | Task |
|---|---|
| 1 · Carta intestata | W1 (1.1-1.5), W9 |
| 1.5 · Un motore solo | W9.1 |
| 2 · Anagrafica tre sedi | W3 (3.1-3.3) |
| 2.2 · Duplicazione indirizzo | W3.2 |
| 3 · ENUM archiviazione | W2 (2.1-2.2) |
| 4 · Genitore | W4 (4.1-4.4) |
| 5 · Segreteria | W5.1 |
| 6 · Gite | W6 (6.1-6.3) |
| 7 · Pulizia | W7 (7.1-7.2) |
| 8 · GDPR | W8.1 |
| 9 · Collaudo | il critico severo in loop, fuori piano |
| 10 · Ordine obbligato | dipendenze in cima |
