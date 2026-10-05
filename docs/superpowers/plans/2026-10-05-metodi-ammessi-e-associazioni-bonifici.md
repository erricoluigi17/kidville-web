# Metodi di pagamento ammessi e associazioni dei bonifici — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** permettere alla segreteria di dichiarare su una voce di pagamento i metodi ammessi (contanti, bonifico), nascondendo IBAN e causale quando il bonifico non è ammesso; e rendere visibile, modificabile ed eliminabile l'associazione di un bonifico in Riconciliazione.

**Architecture:**
- Colonna `pagamenti.metodi_ammessi text[]`, con default «tutti e due» e un helper puro che la normalizza. Nascondere causale e IBAN si decide **a valle** dei motori unici di causale e coordinate.
- Per l'associazione si riusa la riapertura esistente (`riapriMovimento`), a cui si aggiungono:
  - una lettura dell'associazione (`GET …/riconciliazione/[id]`);
  - un destino dopo la riapertura (`poi: 'ignorato'`);
  - la pulizia della coda fatture e della ricevuta.

**Tech Stack:** Next.js (App Router, versione del repo: leggere `node_modules/next/dist/docs/` prima di toccare API di Next) · Supabase/PostgREST · zod · next-intl · vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-05-metodi-ammessi-e-associazioni-bonifici-design.md`

---

## Regole che valgono per OGNI task (leggerle prima)

- **Lingua**: codice, commenti, test e messaggi in italiano, come il resto del repo.
- **Repo pubblico**: mai nomi veri di famiglie o bambini nei test. Solo dati sintetici («Mara Bianchi», uuid finti).
- **Logging** (`AGENTS.md`):
  - mai `console.*`: si usano `logErrore`/`logEvento` da `@/lib/logging/logger`;
  - un `catch` che non logga è un bug;
  - PostgREST non lancia: si controlla `{ error }`;
  - mai PII nei log, solo uuid, numeri e booleani.
- **DB E2E della CI non migrato**: una colonna nuova dà `PGRST204` su insert/update e `42703` su select. Ogni lettura e scrittura della colonna nuova deve degradare (ritentare senza la colonna) e loggare `warn`.
- **Lettura del codice**: `Read` con `offset`/`limit` sui file grossi. Mai `cat`.
- **Test**:
  - ogni test nuovo si **vede fallire** prima dell'implementazione, eseguendolo;
  - `npx vitest run <file>` esce 0 anche su un file inesistente: controllare che il riepilogo dica `Tests N passed` con N > 0.
- **Commit**: uno per task. Messaggio in italiano, che finisce con:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **Lavora SOLO sui file del tuo task.** Altri agenti lavorano in parallelo sullo stesso albero.
  - Mai `git stash`, `git checkout -- <file>` o `git add -A`: aggiungi per nome i file del tuo task.
  - I cataloghi `messages/*/*.json` li tocca **solo il Task 0**.

---

## Mappa dei file

| File | Responsabilità | Task |
|---|---|---|
| `messages/{it,en}/adminContabilita.json`, `messages/{it,en}/pagamenti.json`, `messages/{it,en}/shared.json` | Tutte le stringhe nuove | 0 |
| `supabase/migrations/20261005120000_pagamenti_metodi_ammessi.sql` | Colonna + CHECK | 1 |
| `src/lib/pagamenti/metodi-ammessi.ts` (nuovo, puro) | Normalizzazione e predicati | 1 |
| `src/lib/pagamenti/metodi-ammessi-zod.ts` (nuovo) | Schema zod condiviso dalle route | 1 |
| `src/app/api/pagamenti/genera/route.ts` | Scrittura alla generazione | 2 |
| `src/app/api/pagamenti/[id]/route.ts` | Scrittura alla modifica | 2 |
| `src/app/api/pagamenti/route.ts` | GET: `metodi_ammessi` + causale `null` | 3 |
| `src/lib/pagamenti/solleciti-invio.ts`, `src/lib/email/messaggi/sollecito.ts` | Email senza IBAN per «solo contanti» | 4 |
| `src/components/features/pagamenti/BadgeMetodoPagamento.tsx` (nuovo) | Badge «Solo contanti/bonifico» | 5 |
| `src/components/features/admin/pagamenti/ScegliMetodiAmmessi.tsx` (nuovo) | Le due caselle | 5 |
| `GeneratoreCategoria.tsx`, `ModificaPagamentoModal.tsx`, `PaymentsDashboard.tsx`, `PagamentoDrawer.tsx`, `RegistraIncassoModal.tsx` (solo il tipo) | Segreteria | 5 |
| `src/components/features/parent/pagamenti/StoricoPagamenti.tsx`, `ComePagare.tsx`, `CausaleBonifico.tsx` (solo il tipo) | Genitore | 6 |
| `src/app/api/pagamenti/incassi/storno/route.ts`, `src/lib/pagamenti/ricevute.ts` | Errori non più muti | 7 |
| `src/lib/pagamenti/riapertura-coda-fatture.ts` (nuovo), `src/lib/pagamenti/riapertura-movimento.ts`, `src/lib/ui/esito-fetch.ts` | Coda fatture e ricevuta nella riapertura | 8 |
| `src/lib/pagamenti/associazione-movimento.ts` (nuovo), `src/app/api/pagamenti/riconciliazione/[id]/route.ts` | GET dell'associazione + `poi` | 9 |
| `src/components/features/admin/pagamenti/ConfermaScollegaBonifico.tsx` (nuovo), `AssociazioneBonifico.tsx` (nuovo), `MovimentoDialog.tsx`, `RiconciliazionePanel.tsx`, `riconciliazione-ui.ts` | UI dell'associazione | 10 |
| `PRD REGISTRO ELETTRONICO.md` | Changelog e stato | 11 |

**Onde parallele**, su file disgiunti:
1. Task 0 e Task 1, in sequenza.
2. Task 2 ‖ 3 ‖ 4 ‖ 7.
3. Task 5 ‖ 6 ‖ 8.
4. Task 9.
5. Task 10.
6. Task 11.
7. Gate finale.

---

### Task 0: Stringhe (tutti i cataloghi, una volta sola)

**Files:**
- Modify: `messages/it/adminContabilita.json`, `messages/en/adminContabilita.json`
- Modify: `messages/it/pagamenti.json`, `messages/en/pagamenti.json`
- Modify: `messages/it/shared.json`, `messages/en/shared.json`
- Test (lock esistente): `__tests__/**/messaggi-parita-cataloghi*.test.ts`. Trovalo con `git ls-files | grep -i parita`.

- [ ] **Step 1: Aggiungi le chiavi.** Inseriscile in fondo all'oggetto JSON di ciascun file, nello **stesso ordine** in it e en. Non riordinare le chiavi esistenti: vedi la memoria `catalogo_messaggi_non_riordinare`.

`adminContabilita.json`, **it**:
```json
"metodiAmmessiLegenda": "Metodi di pagamento ammessi",
"metodiAmmessiContanti": "Contanti",
"metodiAmmessiBonifico": "Bonifico",
"metodiAmmessiAiuto": "Con il solo contanti il genitore non vede IBAN e causale.",
"metodiAmmessiAlmenoUno": "Scegli almeno un metodo di pagamento.",
"badgeSoloContanti": "Solo contanti",
"badgeSoloBonifico": "Solo bonifico",
"movdlgAssociatoA": "Associato a",
"movdlgAssociatoErrore": "Non è stato possibile leggere a cosa è associato questo bonifico.",
"movdlgAssociatoNessuna": "Nessuna voce risulta collegata a questo bonifico.",
"movdlgAssociatoIncassato": "{incassato} su {totale}",
"movdlgAssociatoConfermatoDa": "Confermato da {nome} il {data}",
"movdlgAssociatoConfermatoIl": "Confermato il {data}",
"movdlgAssociatoAutomatico": "Abbinato in automatico il {data}",
"movdlgModificaAssociazione": "Modifica associazione",
"movdlgEliminaAssociazione": "Elimina associazione",
"movdlgRimettiDaAbbinare": "Rimetti da abbinare",
"movdlgEsitoIgnorato": "Il bonifico è stato segnato come ignorato.",
"movdlgEsitoIgnoraNonApplicato": "Il bonifico è tornato da abbinare, ma non è stato possibile segnarlo come ignorato: fallo con «Ignora».",
"movdlgEsitoCodaTolte": "{n, plural, one {Tolta una richiesta di fattura in coda.} other {Tolte # richieste di fattura in coda.}}",
"scollegaTitoloModifica": "Modificare l’associazione?",
"scollegaTitoloElimina": "Eliminare l’associazione?",
"scollegaIntro": "Ecco cosa succede:",
"scollegaStorno": "si storna l’incasso di {importo} su «{voce}» ({alunno}): la voce torna da pagare;",
"scollegaVociComposte": "le voci create insieme a questo bonifico restano e tornano da pagare;",
"scollegaRicevuta": "la ricevuta di questo pagamento viene annullata;",
"scollegaFatturaEmessa": "su «{voce}» c’è una fattura emessa: resta valida, e va stornata con una nota di credito;",
"scollegaFatturaInCoda": "la richiesta di fattura in coda per «{voce}» viene tolta;",
"scollegaDopoModifica": "subito dopo scegli la voce giusta.",
"scollegaDestinoLegenda": "Dopo, il bonifico",
"scollegaDestinoDaAbbinare": "torna da abbinare",
"scollegaDestinoIgnorato": "viene segnato come ignorato",
"scollegaDestinoIgnoratoAiuto": "Per un bonifico che non corrisponde a nessuna voce in app, per esempio una quota mai registrata.",
"scollegaConferma": "Conferma",
"scollegaAnnulla": "Annulla"
```

`adminContabilita.json`, **en**:
```json
"metodiAmmessiLegenda": "Accepted payment methods",
"metodiAmmessiContanti": "Cash",
"metodiAmmessiBonifico": "Bank transfer",
"metodiAmmessiAiuto": "With cash only, parents do not see the IBAN and the payment reference.",
"metodiAmmessiAlmenoUno": "Choose at least one payment method.",
"badgeSoloContanti": "Cash only",
"badgeSoloBonifico": "Bank transfer only",
"movdlgAssociatoA": "Linked to",
"movdlgAssociatoErrore": "We could not read what this bank transfer is linked to.",
"movdlgAssociatoNessuna": "No item is linked to this bank transfer.",
"movdlgAssociatoIncassato": "{incassato} of {totale}",
"movdlgAssociatoConfermatoDa": "Confirmed by {nome} on {data}",
"movdlgAssociatoConfermatoIl": "Confirmed on {data}",
"movdlgAssociatoAutomatico": "Matched automatically on {data}",
"movdlgModificaAssociazione": "Change link",
"movdlgEliminaAssociazione": "Remove link",
"movdlgRimettiDaAbbinare": "Put back to match",
"movdlgEsitoIgnorato": "The bank transfer has been marked as ignored.",
"movdlgEsitoIgnoraNonApplicato": "The bank transfer is back to be matched, but we could not mark it as ignored: use «Ignore».",
"movdlgEsitoCodaTolte": "{n, plural, one {One queued invoice request removed.} other {# queued invoice requests removed.}}",
"scollegaTitoloModifica": "Change the link?",
"scollegaTitoloElimina": "Remove the link?",
"scollegaIntro": "This is what happens:",
"scollegaStorno": "the {importo} payment on «{voce}» ({alunno}) is reversed: the item becomes due again;",
"scollegaVociComposte": "items created together with this bank transfer stay and become due again;",
"scollegaRicevuta": "the receipt for this payment is cancelled;",
"scollegaFatturaEmessa": "«{voce}» has an issued invoice: it stays valid and must be reversed with a credit note;",
"scollegaFatturaInCoda": "the queued invoice request for «{voce}» is removed;",
"scollegaDopoModifica": "right after, choose the correct item.",
"scollegaDestinoLegenda": "Afterwards, the bank transfer",
"scollegaDestinoDaAbbinare": "goes back to be matched",
"scollegaDestinoIgnorato": "is marked as ignored",
"scollegaDestinoIgnoratoAiuto": "For a bank transfer that matches no item in the app, for example a fee never recorded.",
"scollegaConferma": "Confirm",
"scollegaAnnulla": "Cancel"
```

`pagamenti.json`, **it**:
```json
"badgeSoloContanti": "Solo contanti",
"badgeSoloBonifico": "Solo bonifico",
"bonificoEsclusiContanti": "{count, plural, one {Una voce si paga solo in contanti: la trovi nella scheda Contanti.} other {# voci si pagano solo in contanti: le trovi nella scheda Contanti.}}"
```
`pagamenti.json`, **en**:
```json
"badgeSoloContanti": "Cash only",
"badgeSoloBonifico": "Bank transfer only",
"bonificoEsclusiContanti": "{count, plural, one {One item can only be paid in cash: see the Cash tab.} other {# items can only be paid in cash: see the Cash tab.}}"
```

`shared.json`, **it**:
```json
"erroreRiaperturaFatturaInInvio": "Una fattura di questa voce è in invio proprio adesso: riprova fra un minuto. Non è stato stornato niente."
```
`shared.json`, **en**:
```json
"erroreRiaperturaFatturaInInvio": "An invoice for this item is being sent right now: please try again in a minute. Nothing has been reversed."
```

- [ ] **Step 2: Controlla che i JSON siano validi e i lock di parità verdi**

Run:
```bash
node -e "for (const f of ['adminContabilita','pagamenti','shared']) for (const l of ['it','en']) JSON.parse(require('fs').readFileSync('messages/'+l+'/'+f+'.json','utf8'))" && npx vitest run $(git ls-files '__tests__/**' | grep -iE 'parita|glossario' | tr '\n' ' ')
```
Atteso: nessuna eccezione e `Tests N passed` con N > 0.

- [ ] **Step 3: Commit**
```bash
git add messages/it/adminContabilita.json messages/en/adminContabilita.json messages/it/pagamenti.json messages/en/pagamenti.json messages/it/shared.json messages/en/shared.json
git commit -m "Stringhe: metodi ammessi, badge, associazione dei bonifici

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Migrazione + helper puro + schema zod

**Files:**
- Create: `supabase/migrations/20261005120000_pagamenti_metodi_ammessi.sql`
- Create: `src/lib/pagamenti/metodi-ammessi.ts`
- Create: `src/lib/pagamenti/metodi-ammessi-zod.ts`
- Test: `__tests__/lib/pagamenti/metodi-ammessi.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// __tests__/lib/pagamenti/metodi-ammessi.test.ts
import { describe, it, expect } from 'vitest'
import {
  METODI_AMMESSI, normalizzaMetodiAmmessi, ammetteBonifico, ammetteContanti, soloUnMetodo, sonoTuttiIMetodi,
} from '@/lib/pagamenti/metodi-ammessi'
import { zMetodiAmmessi } from '@/lib/pagamenti/metodi-ammessi-zod'

describe('metodi ammessi', () => {
  it('assente, null, vuoto o tutto ignoto ⇒ entrambi (degradazione del DB non migrato)', () => {
    for (const raw of [undefined, null, [], ['pos'], 'contanti', 42]) {
      expect(normalizzaMetodiAmmessi(raw)).toEqual(['contanti', 'bonifico'])
    }
  })
  it('ordine canonico, duplicati e ignoti scartati', () => {
    expect(normalizzaMetodiAmmessi(['bonifico', 'contanti', 'bonifico', 'pos'])).toEqual(['contanti', 'bonifico'])
    expect(normalizzaMetodiAmmessi(['contanti'])).toEqual(['contanti'])
  })
  it('predicati', () => {
    expect(ammetteBonifico(['contanti'])).toBe(false)
    expect(ammetteBonifico(null)).toBe(true)
    expect(ammetteContanti(['bonifico'])).toBe(false)
    expect(soloUnMetodo(['contanti'])).toBe('contanti')
    expect(soloUnMetodo(['bonifico'])).toBe('bonifico')
    expect(soloUnMetodo(['contanti', 'bonifico'])).toBeNull()
    expect(sonoTuttiIMetodi(undefined)).toBe(true)
    expect(sonoTuttiIMetodi(['contanti'])).toBe(false)
    expect(METODI_AMMESSI).toEqual(['contanti', 'bonifico'])
  })
  it('zod: almeno uno, solo valori noti', () => {
    expect(zMetodiAmmessi.safeParse(['contanti']).success).toBe(true)
    expect(zMetodiAmmessi.safeParse([]).success).toBe(false)
    expect(zMetodiAmmessi.safeParse(['pos']).success).toBe(false)
    expect(zMetodiAmmessi.safeParse(['contanti', 'bonifico', 'contanti']).success).toBe(false)
  })
})
```

- [ ] **Step 2: Verifica che fallisca**

Run: `npx vitest run __tests__/lib/pagamenti/metodi-ammessi.test.ts`
Atteso: FAIL, perché il modulo non esiste ancora.

- [ ] **Step 3: Scrivi la migrazione**

```sql
-- supabase/migrations/20261005120000_pagamenti_metodi_ammessi.sql
-- Metodi di pagamento AMMESSI su una voce (decisione del titolare, 2026-10-05):
-- la segreteria dichiara alla creazione se una voce si paga in contanti, con
-- bonifico o in entrambi i modi. Con il solo contanti il genitore non vede IBAN
-- e causale (la decisione si prende a valle dei motori unici di causale e
-- coordinate, non qui).
--
-- Il DEFAULT è «tutti e due», cioè il comportamento di prima: copre da solo
-- le RPC delle rette, i ticket, la composizione e il merchandise, che non
-- nominano la colonna. Nessun backfill: le righe esistenti nascono col default.
ALTER TABLE public.pagamenti
  ADD COLUMN IF NOT EXISTS metodi_ammessi text[] NOT NULL DEFAULT ARRAY['contanti', 'bonifico']::text[];

ALTER TABLE public.pagamenti
  DROP CONSTRAINT IF EXISTS pagamenti_metodi_ammessi_validi;
ALTER TABLE public.pagamenti
  ADD CONSTRAINT pagamenti_metodi_ammessi_validi CHECK (
    cardinality(metodi_ammessi) >= 1
    AND metodi_ammessi <@ ARRAY['contanti', 'bonifico']::text[]
  );

COMMENT ON COLUMN public.pagamenti.metodi_ammessi IS
  'Metodi con cui la voce si può pagare (contanti, bonifico). Senza bonifico il genitore non vede IBAN né causale.';
```

- [ ] **Step 4: Scrivi l'helper puro (zero import)**

```ts
// src/lib/pagamenti/metodi-ammessi.ts
// ─────────────────────────────────────────────────────────────────────────────
// I METODI CON CUI UNA VOCE SI PUÒ PAGARE (2026-10-05).
//
// ZERO IMPORT, ed è un vincolo: lo usano anche componenti `'use client'`
// (badge, «Come pagare»), e un import di server finirebbe nel bundle.
//
// `normalizzaMetodiAmmessi` è la porta UNICA da cui passa il valore letto dal
// DB o dal client. Assente, `null`, vuoto o fatto solo di valori ignoti ⇒
// ENTRAMBI: è la degradazione del DB E2E della CI (colonna assente) e il
// comportamento di prima della colonna. Mai «nessun metodo»: una voce che non
// si può pagare in nessun modo non esiste.
// ─────────────────────────────────────────────────────────────────────────────

export const METODI_AMMESSI = ['contanti', 'bonifico'] as const
export type MetodoAmmesso = (typeof METODI_AMMESSI)[number]

function eMetodo(v: unknown): v is MetodoAmmesso {
  return typeof v === 'string' && (METODI_AMMESSI as readonly string[]).includes(v)
}

export function normalizzaMetodiAmmessi(raw: unknown): MetodoAmmesso[] {
  if (!Array.isArray(raw)) return [...METODI_AMMESSI]
  const presenti = new Set(raw.filter(eMetodo))
  if (presenti.size === 0) return [...METODI_AMMESSI]
  return METODI_AMMESSI.filter((m) => presenti.has(m))
}

export function ammetteBonifico(raw: unknown): boolean {
  return normalizzaMetodiAmmessi(raw).includes('bonifico')
}

export function ammetteContanti(raw: unknown): boolean {
  return normalizzaMetodiAmmessi(raw).includes('contanti')
}

/** Il metodo, quando è UNO solo; `null` quando sono ammessi tutti e due. */
export function soloUnMetodo(raw: unknown): MetodoAmmesso | null {
  const m = normalizzaMetodiAmmessi(raw)
  return m.length === 1 ? m[0] : null
}

/** «Tutti e due»: il default della colonna, che non serve scrivere. */
export function sonoTuttiIMetodi(raw: unknown): boolean {
  return normalizzaMetodiAmmessi(raw).length === METODI_AMMESSI.length
}

/** Codici PostgREST/Postgres di «colonna assente» (DB E2E della CI, non migrato). */
export const CODICI_COLONNA_ASSENTE: readonly string[] = ['PGRST204', '42703']
```

```ts
// src/lib/pagamenti/metodi-ammessi-zod.ts
import { z } from 'zod'
import { METODI_AMMESSI } from './metodi-ammessi'

/**
 * Lo schema dei metodi ammessi negli ingressi delle route. Sta qui e non
 * nell'helper puro perché `zod` non deve entrare nei componenti client che
 * importano l'helper. Almeno uno, solo valori noti, senza doppioni.
 */
export const zMetodiAmmessi = z
  .array(z.enum(METODI_AMMESSI))
  .min(1, 'Scegli almeno un metodo di pagamento')
  .max(METODI_AMMESSI.length)
  .refine((a) => new Set(a).size === a.length, 'Metodo ripetuto')
```

- [ ] **Step 5: Verifica che passi**

Run: `npx vitest run __tests__/lib/pagamenti/metodi-ammessi.test.ts __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts`
Atteso: PASS, con N > 0 test.

- [ ] **Step 6: Commit**
```bash
git add supabase/migrations/20261005120000_pagamenti_metodi_ammessi.sql src/lib/pagamenti/metodi-ammessi.ts src/lib/pagamenti/metodi-ammessi-zod.ts __tests__/lib/pagamenti/metodi-ammessi.test.ts
git commit -m "Metodi ammessi sulla voce: colonna, helper puro e schema zod

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

⚠️ La migrazione **non** si applica a mano: la applica l'integrazione al merge, con la version del file (`.claude/rules/migrazioni.md`).

---

### Task 2: Scrittura dei metodi (genera + modifica)

**Files:**
- Modify: `src/app/api/pagamenti/genera/route.ts`
- Modify: `src/app/api/pagamenti/[id]/route.ts`
- Test:
  - `__tests__/api/pagamenti-genera-metodi-ammessi.test.ts` (nuovo). Copia lo scaffold dei mock da `__tests__/api/pagamenti-genera-sede-scrittura.test.ts`.
  - `__tests__/api/pagamenti-patch-metodi-ammessi.test.ts` (nuovo). Lo scaffold si prende da un test esistente della PATCH: `git ls-files __tests__ | xargs grep -l "pagamenti/\[id\]/route"`.

- [ ] **Step 1: Test che falliscono**

Asserzioni da coprire, ognuna un `it`:
1. `POST /genera` con `metodi_ammessi: ['contanti']` → 201, e la riga inserita in `pagamenti` porta `metodi_ammessi: ['contanti']`.
2. `POST /genera` senza `metodi_ammessi`, oppure con `['contanti','bonifico']` → la riga inserita **non** ha la chiave `metodi_ammessi` (decide il default del DB).
3. `POST /genera` con `metodi_ammessi: []` → 400; con `['pos']` → 400; nessun insert.
4. `POST /genera` con `rate` e `['contanti']`: il `padre` **e** tutte le `rata` portano `metodi_ammessi: ['contanti']`.
5. `POST /genera`, primo insert che risponde `{ error: { code: 'PGRST204' } }` → secondo insert senza `metodi_ammessi`, risposta 201, `logEvento` chiamato con `esito: 'metodi-ammessi-colonna-assente'`.
6. `PATCH /[id]` con `{ metodi_ammessi: ['contanti'] }` → l'update contiene `metodi_ammessi: ['contanti']`; `logEvento` con `esito: 'metodi-ammessi-modificati'`.
7. `PATCH /[id]` con `{ metodi_ammessi: [] }` → 400.
8. `PATCH /[id]`, update che risponde `PGRST204` con `metodi_ammessi` nel corpo → si ritenta senza; se `metodi_ammessi` era l'unico campo, risposta 200 con `avviso: 'metodi-non-salvabili'`.

- [ ] **Step 2: Esegui e verifica che siano rossi**

Run: `npx vitest run __tests__/api/pagamenti-genera-metodi-ammessi.test.ts __tests__/api/pagamenti-patch-metodi-ammessi.test.ts`
Atteso: FAIL.

- [ ] **Step 3: Implementa in `genera/route.ts`**

Import:
```ts
import { normalizzaMetodiAmmessi, sonoTuttiIMetodi, CODICI_COLONNA_ASSENTE } from '@/lib/pagamenti/metodi-ammessi'
import { zMetodiAmmessi } from '@/lib/pagamenti/metodi-ammessi-zod'
```
In `postBodySchema` aggiungi:
```ts
  // Metodi ammessi (2026-10-05). Assente = tutti e due (default della colonna).
  metodi_ammessi: zMetodiAmmessi.optional(),
```
Dopo `const categoriaId = body.categoria_id ?? null` aggiungi:
```ts
    // Si SCRIVE solo quando non sono tutti e due: il default lo mette il DB, e
    // così sul DB E2E della CI (colonna assente) il caso normale non tocca mai
    // la colonna.
    const metodiDaScrivere = body.metodi_ammessi && !sonoTuttiIMetodi(body.metodi_ammessi)
      ? normalizzaMetodiAmmessi(body.metodi_ammessi)
      : undefined
    const conMetodi = metodiDaScrivere ? { metodi_ammessi: metodiDaScrivere } : {}
    const colonnaMetodiAssente = (e: { code?: string } | null) =>
      !!e && !!metodiDaScrivere && CODICI_COLONNA_ASSENTE.includes(e.code ?? '')
    const senzaMetodi = <T extends Record<string, unknown>>(r: T): T => {
      const { metodi_ammessi: _m, ...resto } = r
      void _m
      return resto as T
    }
    const segnalaColonnaAssente = (ramo: string) =>
      logEvento('pagamento', 'warn', {
        operazione: 'pagamenti/genera:POST',
        esito: 'metodi-ammessi-colonna-assente',
        tipo: ramo,
      })
```
- Ramo `padre`: aggiungi `...conMetodi` al letterale dell'insert.
  - Se `pErr` soddisfa `colonnaMetodiAssente(pErr)`: ritenta con lo stesso letterale senza `...conMetodi` e chiama `segnalaColonnaAssente('padre')`.
  - Riassegna `padre`/`pErr` dal ritentativo. Per farlo, cambia `const { data: padre, error: pErr }` in `let`.
- Ramo `rata`: `figlie` prende `...conMetodi`. Su `rErr` con `colonnaMetodiAssente`: ritenta con `figlie.map(senzaMetodi)` e `segnalaColonnaAssente('rata')`, poi rivaluta `rErr`.
- Ramo `singolo`: `records` prende `...conMetodi`. Su `error` con `colonnaMetodiAssente`: ritenta con `records.map(senzaMetodi)`, `segnalaColonnaAssente('singolo')` e riassegna. Per questo `const { data: created, error }` diventa `let ins = …`, e poi si usa `ins.data`/`ins.error`.
- Nell'audit `nuovo_valore` aggiungi `metodi_ammessi: metodiDaScrivere ?? null`.
- Dopo l'audit aggiungi il log del successo, se ci sono metodi:
```ts
    if (metodiDaScrivere) {
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/genera:POST',
        esito: 'metodi-ammessi-scritti',
        solo_contanti: metodiDaScrivere.length === 1 && metodiDaScrivere[0] === 'contanti',
        generati,
      })
    }
```

- [ ] **Step 4: Implementa in `[id]/route.ts`**

Stessi import. Nello `patchBodySchema` aggiungi `metodi_ammessi: zMetodiAmmessi.optional(),` e in `CAMPI_EDITABILI` aggiungi `'metodi_ammessi'`. Dopo `if (body[f] !== undefined) updates[f] = body[f]` aggiungi:
```ts
    if (updates.metodi_ammessi !== undefined) updates.metodi_ammessi = normalizzaMetodiAmmessi(updates.metodi_ammessi)
```
Sostituisci l'update così:
```ts
    let upd = await supabase.from('pagamenti').update(updates).eq('id', id).select(SELECT).single()
    let metodiNonSalvati = false
    if (upd.error && updates.metodi_ammessi !== undefined && CODICI_COLONNA_ASSENTE.includes((upd.error as { code?: string }).code ?? '')) {
      // DB E2E della CI (colonna assente): si salva il resto e si DICE che i
      // metodi non sono stati salvati, invece di fingere.
      metodiNonSalvati = true
      logEvento('pagamento', 'warn', { operazione: 'pagamenti/[id]:PATCH', esito: 'metodi-ammessi-colonna-assente', pagamento_id: id })
      const { metodi_ammessi: _m, ...resto } = updates
      void _m
      upd = Object.keys(resto).filter((k) => k !== 'aggiornato_il').length > 0
        ? await supabase.from('pagamenti').update(resto).eq('id', id).select(SELECT).single()
        : await supabase.from('pagamenti').select(SELECT).eq('id', id).single()
    }
    const { data, error } = upd
    if (error) {
      logErrore({ operazione: 'pagamenti/[id]:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore aggiornamento', details: error.message }, { status: 500 })
    }
    if (updates.metodi_ammessi !== undefined && !metodiNonSalvati) {
      const m = updates.metodi_ammessi as string[]
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/[id]:PATCH',
        esito: 'metodi-ammessi-modificati',
        pagamento_id: id,
        solo_contanti: m.length === 1 && m[0] === 'contanti',
        solo_bonifico: m.length === 1 && m[0] === 'bonifico',
      })
    }
```
In fondo, `return NextResponse.json({ success: true, data, ...(metodiNonSalvati ? { avviso: 'metodi-non-salvabili' } : {}) })`.

- [ ] **Step 5: Verifica**

Run: `npx vitest run __tests__/api/pagamenti-genera-metodi-ammessi.test.ts __tests__/api/pagamenti-patch-metodi-ammessi.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/logging-coverage.test.ts $(git ls-files '__tests__/**' | grep -E 'pagamenti-genera|pagamenti-\[id\]|pagamenti-patch' | tr '\n' ' ')`
Atteso: PASS.

- [ ] **Step 6: Rompi e guarda il rosso.** Togli `...conMetodi` dal ramo `rata` e riesegui: il test 4 deve diventare rosso. Ripristina.

- [ ] **Step 7: Commit** (`genera/route.ts`, `[id]/route.ts`, i due test).

---

### Task 3: `GET /api/pagamenti` porta i metodi e tace la causale

**Files:**
- Modify: `src/app/api/pagamenti/route.ts`. Le righe di riferimento: SELECT a 74-81, `SELECT_GET` a 122-125, letture a 259-267, mappatura a 562-601.
- Test: `__tests__/api/pagamenti-causale-suggerita.test.ts` (estendilo).

- [ ] **Step 1: Test che falliscono** (nel file esistente, riusa i suoi mock):
1. Una riga con `metodi_ammessi: ['contanti']` → nella risposta `causale_suggerita === null` e `metodi_ammessi` uguale a `['contanti']`.
2. Una riga senza la chiave → `metodi_ammessi` uguale a `['contanti','bonifico']` e causale presente come prima.
3. Prima select che risponde `42703` → si ritenta con la select senza `metodi_ammessi` (asserisci sulle colonne chieste alla seconda lettura), poi con quella base.

- [ ] **Step 2: Esegui, è rosso.**

- [ ] **Step 3: Implementa.** Import: `import { normalizzaMetodiAmmessi, ammetteBonifico } from '@/lib/pagamenti/metodi-ammessi'`. Sotto `SELECT_GET`:
```ts
// Metodi ammessi (2026-10-05): un gradino in più della stessa scala. Ordine di
// ricchezza decrescente = ordine delle migrazioni, quindi le colonne presenti
// su un database sono sempre un PREFISSO: `metodi_ammessi` → `sconto` → base.
const SELECT_GET_METODI = SELECT_GET.replace(
  'fattura_stato, fattura_pdf_path,',
  'metodi_ammessi, fattura_stato, fattura_pdf_path,',
)
```
Sostituisci la lettura:
```ts
    let { data, error, blocchi, troncata } = await leggiTutte(SELECT_GET_METODI)
    for (const ripiego of [SELECT_GET, SELECT]) {
      if (!(error && (error as { code?: string }).code === '42703')) break
      logEvento('pagamento', 'warn', { operazione: 'pagamenti:GET', esito: 'select-in-degradazione', tipo: ripiego === SELECT ? 'base' : 'senza-metodi' })
      const retry = await leggiTutte(ripiego)
      data = retry.data
      error = retry.error
      blocchi = retry.blocchi
      troncata = retry.troncata
    }
```
Controlla che `logEvento` sia già importato: lo è, alla riga 14. Nella mappatura finale:
```ts
        const metodi_ammessi = normalizzaMetodiAmmessi(r.metodi_ammessi)
        // Senza bonifico la causale NON si compone: è ciò che toglie IBAN e causale
        // al genitore (decisione 2026-10-05). Si decide qui, a valle del motore
        // unico — `causaleBonifico` resta l'unica porta.
        const causale_suggerita = ammetteBonifico(metodi_ammessi) ? causaleBonifico({ /* invariato */ }, template) : null
        return { ...r, metodi_ammessi, scuola_nome: sede, causale_suggerita, ...(isStaff ? { coda_stato: codaPerPagamento.get(r.id) ?? null } : {}) }
```
Il commento `/* invariato */` vuol dire: lascia esattamente l'oggetto argomento che c'è oggi.

- [ ] **Step 4: Verifica.**

Run: `npx vitest run __tests__/api/pagamenti-causale-suggerita.test.ts __tests__/api/pagamenti-coordinate-bonifico.test.ts $(git ls-files '__tests__/architecture/**' | grep -E 'causale-bonifico-un-motore|coordinate-bonifico-un-motore' | tr '\n' ' ')`
Atteso: PASS.

- [ ] **Step 5: Rompi e guarda il rosso.** Metti `true ?` al posto di `ammetteBonifico(...)`: il test 1 deve diventare rosso. Ripristina.

- [ ] **Step 6: Commit.**

---

### Task 4: Sollecito senza IBAN per le voci «solo contanti»

**Files:**
- Modify: `src/lib/email/messaggi/sollecito.ts`, `src/lib/pagamenti/solleciti-invio.ts`
- Test: i test esistenti del messaggio di sollecito. Trovali con `git ls-files __tests__ | xargs grep -l messaggioSollecito`; aggiungi lì i casi nuovi. Estendi anche `__tests__/api/solleciti-causale-codice.test.ts`.

- [ ] **Step 1: Test che falliscono**
- `messaggioSollecito({ …, causale: null, iban: 'IT60X0542811101000000123456' }, sede)`:
  - l'`html` non contiene `IBAN` né `Dati per il bonifico`, e contiene `in contanti presso la segreteria`;
  - il `testo` non contiene `DATI PER IL BONIFICO`.
- `sollecitaPagamenti(..., { anteprima: true })` su una voce con `metodi_ammessi: ['contanti']` → il `corpo` non contiene il codice voce (`#`) e contiene `in contanti presso la segreteria`.

- [ ] **Step 2: Rosso.**

- [ ] **Step 3: Implementa `sollecito.ts`.**
- `DatiSollecito.causale` diventa `string | null`, documentato con «`null` ⇒ la voce non ammette il bonifico».
- In `messaggioSollecito`:
```ts
    const soloContanti = d.causale === null
    const FRASE_CONTANTI = 'Questo pagamento si salda in contanti presso la segreteria, negli orari di apertura.'
```
- `righeBonifico` si calcola solo se `!soloContanti`. Nel `corpo` sostituisci `h2('Dati per il bonifico'), tabellaDati(righeBonifico),` con:
```ts
        soloContanti
            ? unisci([h2('Come pagare'), p(h`${FRASE_CONTANTI}`)])
            : unisci([h2('Dati per il bonifico'), tabellaDati(righeBonifico)]),
```
Verifica nel file `../html` che `h` accetti un'interpolazione di stringa; altrimenti usa `p(h`Questo pagamento si salda in contanti presso la segreteria, negli orari di apertura.`)`.
- Preheader: con `soloContanti` diventa `${formatEuro(totale)} da saldare in contanti presso la segreteria.`. Il ramo `piuVoci` resta com'è.
- Testo: al posto del blocco `DATI PER IL BONIFICO … Intestato a`, con `soloContanti` metti `['COME PAGARE', `  ${FRASE_CONTANTI}`]`.

- [ ] **Step 4: Implementa `solleciti-invio.ts`.**
- Import `ammetteBonifico`.
- `COLONNE_PAG` prende anche `metodi_ammessi`, con una terza costante `COLONNE_PAG_METODI`. La scala diventa: `COLONNE_PAG_METODI` → (42703) `COLONNE_PAG` → (42703) `COLONNE_PAG_BASE`, con un `logEvento('pagamento','warn',{ operazione: 'solleciti:pagamenti', esito: 'select-in-degradazione' })` a ogni gradino.
- `PagRow` prende `metodi_ammessi?: string[] | null`.
- Dopo `datiCausale`:
```ts
        const bonificoAmmesso = ammetteBonifico(pag.metodi_ammessi)
        const rigaPagamento = bonificoAmmesso
            ? rigaCausaleSollecito(datiCausale, templateCausale)
            : 'Questo pagamento si salda in contanti presso la segreteria, negli orari di apertura.'
        const corpo = `${renderTemplate(liv.testo, ctx)}\n\n${rigaPagamento}`
```
- In `messaggioSollecito({...})`: `causale: bonificoAmmesso ? causaleBonifico(datiCausale, templateCausale) : null,`.

- [ ] **Step 5: Verifica.**

Run: `npx vitest run $(git ls-files '__tests__/**' | grep -iE 'sollecit' | tr '\n' ' ')`
Atteso: PASS.

- [ ] **Step 6: Commit.**

---

### Task 5: Segreteria — caselle, badge

**Files:**
- Create: `src/components/features/pagamenti/BadgeMetodoPagamento.tsx`
- Create: `src/components/features/admin/pagamenti/ScegliMetodiAmmessi.tsx`
- Modify:
  - `GeneratoreCategoria.tsx`;
  - `ModificaPagamentoModal.tsx`;
  - `PaymentsDashboard.tsx`, righe ~852 e ~1091;
  - `PagamentoDrawer.tsx`, titolo a riga ~92;
  - `RegistraIncassoModal.tsx`: solo il tipo `PagamentoRow`, aggiungendo `metodi_ammessi?: string[] | null`.
- Test:
  - `__tests__/components/ScegliMetodiAmmessi.test.tsx` (nuovo);
  - `__tests__/components/BadgeMetodoPagamento.test.tsx` (nuovo);
  - estendi `__tests__/components/GeneratoreCategoria.test.tsx`;
  - un test della modale: cercalo con `git ls-files __tests__ | grep -i ModificaPagamento`; se non esiste crealo, con lo scaffold di `QuickAcquistoModal.test.tsx`.

- [ ] **Step 1: Componenti nuovi**

```tsx
// src/components/features/pagamenti/BadgeMetodoPagamento.tsx
import { soloUnMetodo } from '@/lib/pagamenti/metodi-ammessi';

/**
 * «Solo contanti» / «Solo bonifico» accanto a una voce. Con entrambi i metodi
 * ammessi — il caso normale — non rende NIENTE: un badge che dice «tutto come
 * sempre» su ogni riga sarebbe rumore. I testi li passa il chiamante, perché
 * segreteria e genitore leggono da due cataloghi diversi.
 */
export function BadgeMetodoPagamento({
  metodi, testoSoloContanti, testoSoloBonifico, className,
}: {
  metodi: unknown;
  testoSoloContanti: string;
  testoSoloBonifico: string;
  className?: string;
}) {
  const uno = soloUnMetodo(metodi);
  if (!uno) return null;
  return (
    <span
      data-testid="badge-metodo-pagamento"
      className={`inline-flex items-center rounded-pill bg-kidville-warn-soft px-2 py-0.5 font-maven text-[11px] font-bold text-kidville-warn-strong ${className ?? ''}`}
    >
      {uno === 'contanti' ? testoSoloContanti : testoSoloBonifico}
    </span>
  );
}
```

```tsx
// src/components/features/admin/pagamenti/ScegliMetodiAmmessi.tsx
'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { METODI_AMMESSI, type MetodoAmmesso } from '@/lib/pagamenti/metodi-ammessi';

/**
 * Le due caselle «Contanti / Bonifico». Controllato: lo stato lo tiene il
 * chiamante. Zero caselle è uno stato raggiungibile (l'utente le toglie
 * entrambe) e si DICE con un messaggio collegato al gruppo, invece di
 * impedirlo in silenzio: chi salva vede perché non può.
 */
export function ScegliMetodiAmmessi({
  valore, onChange, disabled,
}: {
  valore: MetodoAmmesso[];
  onChange: (v: MetodoAmmesso[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('adminContabilita');
  const id = useId();
  const vuoto = valore.length === 0;
  const etichetta: Record<MetodoAmmesso, string> = {
    contanti: t('metodiAmmessiContanti'),
    bonifico: t('metodiAmmessiBonifico'),
  };
  const cambia = (m: MetodoAmmesso, on: boolean) => {
    const set = new Set(valore);
    if (on) set.add(m); else set.delete(m);
    onChange(METODI_AMMESSI.filter((x) => set.has(x)));
  };
  return (
    <fieldset aria-describedby={`${id}-aiuto${vuoto ? ` ${id}-errore` : ''}`} className="space-y-1">
      <legend className="font-maven text-xs text-kidville-muted mb-1">{t('metodiAmmessiLegenda')}</legend>
      <div className="flex flex-wrap gap-4">
        {METODI_AMMESSI.map((m) => (
          <label key={m} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={valore.includes(m)}
              disabled={disabled}
              onChange={(e) => cambia(m, e.target.checked)}
              className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
            />
            <span className="font-maven text-xs text-kidville-green">{etichetta[m]}</span>
          </label>
        ))}
      </div>
      <p id={`${id}-aiuto`} className="font-maven text-[11px] text-kidville-muted">{t('metodiAmmessiAiuto')}</p>
      {vuoto && (
        <p id={`${id}-errore`} role="alert" className="font-maven text-xs text-kidville-error-strong">
          {t('metodiAmmessiAlmenoUno')}
        </p>
      )}
    </fieldset>
  );
}
```

- [ ] **Step 2: Test dei componenti nuovi** (rossi prima dello Step 1, se li scrivi per primi; meglio così).
- Badge: `metodi={['contanti']}` → testo «Solo contanti»; `['bonifico']` → «Solo bonifico»; `undefined` o entrambi → `queryByTestId('badge-metodo-pagamento')` null.
- Caselle: partono entrambe spuntate con `valore={['contanti','bonifico']}`. Togliendo «Bonifico» si chiama `onChange(['contanti'])`. Con `valore={[]}` compare `role="alert"` con il testo «Scegli almeno un metodo di pagamento.».
- Il provider `next-intl` si prende dai test componenti esistenti (es. `__tests__/components/GeneratoreCategoria.test.tsx`), con i messaggi it veri.

- [ ] **Step 3: `GeneratoreCategoria.tsx`**
- Import `ScegliMetodiAmmessi` e `type MetodoAmmesso`.
- Stato: `const [metodi, setMetodi] = useState<MetodoAmmesso[]>(['contanti', 'bonifico']);`.
- Nel blocco `flex flex-wrap items-center gap-4`, dopo la casella «acconti», aggiungi `<ScegliMetodiAmmessi valore={metodi} onChange={(v) => { setMetodi(v); setAnteprima(null); }} disabled={loading} />`.
- In `caricaAnteprima`, in testa: `if (metodi.length === 0) { setError(t('metodiAmmessiAlmenoUno')); return; }`.
- In `genera`, nel `body`: `metodi_ammessi: metodi,`.
- Test, nel file esistente: togliendo «Bonifico» e generando, il body della POST contiene `metodi_ammessi: ['contanti']`; togliendole entrambe, «Anteprima» non chiama `fetch` e mostra l'errore.

- [ ] **Step 4: `ModificaPagamentoModal.tsx`**
- `PagamentoBase` prende `metodi_ammessi?: string[] | null`.
- Import `normalizzaMetodiAmmessi`, `type MetodoAmmesso`, `ScegliMetodiAmmessi`.
- Stato: `const iniziali = normalizzaMetodiAmmessi(pagamento.metodi_ammessi); const [metodi, setMetodi] = useState<MetodoAmmesso[]>(iniziali);`.
- Dopo la casella «obbligatorio» aggiungi `<ScegliMetodiAmmessi valore={metodi} onChange={setMetodi} disabled={saving} />`.
- In `salvaDati`, prima della fetch: `if (metodi.length === 0) { setError(t('metodiAmmessiAlmenoUno')); return; }`.
- Nel body: `...(metodi.join() !== iniziali.join() ? { metodi_ammessi: metodi } : {})`. Si manda solo se cambia, così sul DB della CI la modifica normale non tocca la colonna.
- Test: con `metodi_ammessi: ['contanti']` sul pagamento, «Bonifico» parte non spuntato. Rispuntandolo e salvando, il body contiene `metodi_ammessi: ['contanti','bonifico']`. Salvando senza cambiare, il body non ha la chiave.

- [ ] **Step 5: Badge in segreteria**
- In `PaymentsDashboard.tsx`, le due celle `<td className={cx(TD, 'text-kidville-ink')}>{p.descrizione}</td>` diventano:
```tsx
<td className={cx(TD, 'text-kidville-ink')}>
  {p.descrizione}
  <BadgeMetodoPagamento metodi={p.metodi_ammessi} testoSoloContanti={t('badgeSoloContanti')} testoSoloBonifico={t('badgeSoloBonifico')} className="ml-2 align-middle" />
</td>
```
  Controlla prima che `t` in quel componente sia `useTranslations('adminContabilita')`; se il namespace è un altro, usa un `useTranslations('adminContabilita')` dedicato, chiamato `tc`.
- In `PagamentoDrawer.tsx`, nel corpo del drawer subito sotto l'apertura (prima riga del contenuto), aggiungi `<BadgeMetodoPagamento metodi={pagamento.metodi_ammessi} … />`. Il `title` del Drawer resta una stringa.
- `PagamentoRow` in `RegistraIncassoModal.tsx` prende `metodi_ammessi?: string[] | null;`.

- [ ] **Step 6: Verifica.**

Run: `npx vitest run __tests__/components/ScegliMetodiAmmessi.test.tsx __tests__/components/BadgeMetodoPagamento.test.tsx __tests__/components/GeneratoreCategoria.test.tsx $(git ls-files '__tests__/**' | grep -E 'ModificaPagamento|PaymentsDashboard|PagamentoDrawer' | tr '\n' ' ') && npx tsc --noEmit -p . 2>&1 | head -20`
Atteso: PASS e nessun errore di tipo.

- [ ] **Step 7: Commit.**

---

### Task 6: Genitore — badge e «Come pagare»

**Files:**
- Modify: `src/components/features/parent/pagamenti/StoricoPagamenti.tsx`, `ComePagare.tsx`, `CausaleBonifico.tsx` (solo il tipo `VoceCausale`)
- Test: estendi `__tests__/components/ComePagare.test.tsx` e `__tests__/components/StoricoPagamenti-come-pagare.test.tsx`

- [ ] **Step 1: Test che falliscono**
1. `ComePagare` con due voci, una delle quali ha `ammetteBonifico: false`:
   - il pannello Bonifico mostra la causale **solo** dell'altra;
   - compare la frase «Una voce si paga solo in contanti: la trovi nella scheda Contanti.».
2. `ComePagare` con tutte le voci a `ammetteBonifico: false`:
   - non c'è nessun `role="tablist"`;
   - non c'è nessun IBAN, cioè il testo dell'IBAN della sede è assente;
   - il testo dei contanti è visibile.
3. `StoricoPagamenti` con una voce `metodi_ammessi: ['contanti']`:
   - la card mostra «Solo contanti»;
   - a `ComePagare` la voce arriva con `ammetteBonifico: false`. Asserisci sul DOM risultante, come al punto 2.

- [ ] **Step 2: Rosso.**

- [ ] **Step 3: Implementa.**
- `VoceCausale` (in `CausaleBonifico.tsx`) prende un campo:
```ts
    /** `false` quando la voce si paga SOLO in contanti: esce dal pannello del bonifico. Assente = ammesso. */
    ammetteBonifico?: boolean;
```
- `StoricoPagamenti.tsx`:
  - `Pagamento` prende `metodi_ammessi?: string[] | null`;
  - in `vociCausale` aggiungi `ammetteBonifico: ammetteBonifico(p.metodi_ammessi),` (import da `@/lib/pagamenti/metodi-ammessi`);
  - in `PagamentoCard`, dopo il badge «obbligatorio», aggiungi `<BadgeMetodoPagamento metodi={p.metodi_ammessi} testoSoloContanti={t('badgeSoloContanti')} testoSoloBonifico={t('badgeSoloBonifico')} />`.
- `ComePagare.tsx`:
  - dopo `if (voci.length === 0) return null;`:
```ts
    const vociBonifico = voci.filter((v) => v.ammetteBonifico !== false);
    const escluseContanti = voci.length - vociBonifico.length;
    // Nessuna voce aperta ammette il bonifico ⇒ niente tab e niente IBAN:
    // resta il solo pannello dei contanti (decisione del titolare, 2026-10-05).
    const soloContanti = vociBonifico.length === 0;
```
  - `const blocchi = raggruppaPerConto(sedi, vociBonifico);` è per il pannello bonifico.
  - Per i nomi delle sedi del pannello contanti usa `const nomiSediTutte = raggruppaPerConto(sedi, voci).flatMap((b) => b.nomi);` e calcola `mostraNomi` su `nomiSediTutte`. Lascia `mostraSedeNelBlocco` su `blocchi`.
  - Il `useState<Metodo>` iniziale resta `'bonifico'`. Al render: `const metodoAttivo: Metodo = soloContanti ? 'contanti' : metodo;`; sostituisci `metodo` con `metodoAttivo` negli `hidden` e in `tab()`.
  - Il `role="tablist"` e il pannello bonifico si rendono solo con `!soloContanti`.
  - Dentro il pannello bonifico, in testa, se `escluseContanti > 0`: `<p className="font-maven text-sm text-kidville-sub">{t('bonificoEsclusiContanti', { count: escluseContanti })}</p>`.
  - Con `soloContanti`, il pannello contanti perde `role="tabpanel"`/`aria-labelledby`, perché non ci sono tab. Usa attributi condizionali.
  - Nella regione `role="status"` della copia, `blocchi[0]` può non esistere con `soloContanti`; lì `esito` resta `null`, perché non c'è nessun comando di copia. Proteggi con `blocchi.find(...) ?? blocchi[0]` solo quando `blocchi.length > 0`.

- [ ] **Step 4: Verifica.**

Run: `npx vitest run $(git ls-files '__tests__/**' | grep -E 'ComePagare|StoricoPagamenti|CausaleBonifico' | tr '\n' ' ')`
Atteso: PASS.

- [ ] **Step 5: Rompi e guarda il rosso.** Togli il `.filter` su `vociBonifico`: i test 1 e 2 diventano rossi. Ripristina.

- [ ] **Step 6: Commit.**

---

### Task 7: Lo storno non ingoia più gli errori

**Files:**
- Modify: `src/app/api/pagamenti/incassi/storno/route.ts` (tre `.then(() => {}, () => {})`, righe ~105-141), `src/lib/pagamenti/ricevute.ts` (`annullaRicevutaTransazioneAttiva`, righe 45-63)
- Test: estendi `__tests__/pagamenti/incasso-storno.test.ts` e `__tests__/pagamenti/transazioni-annulla.test.ts` (o il test di `ricevute`, se esiste: `git ls-files __tests__ | xargs grep -l annullaRicevutaTransazioneAttiva`)

- [ ] **Step 1: Test che falliscono**
- L'update `stornato_il` risponde `{ error: { code: 'XX000' } }` → la risposta resta 200, perché il contro-incasso c'è, ma `logEvento` (o `logErrore`) è chiamato con `esito: 'storno-marcatura-non-scritta'`.
- `ricalcola_stato_pagamento` risponde `{ error: { code: '42883' } }` → `logEvento` livello `info` con `esito: 'ricalcolo-rpc-assente'`. Con `{ code: 'XX000' }` → livello `error`, `esito: 'ricalcolo-non-riuscito'`.
- L'audit su `registro_modifiche` risponde errore → `logEvento` livello `error`, `esito: 'audit-storno-non-scritto'`.
- `annullaRicevutaTransazioneAttiva` con l'update che risponde `{ error: { code: '42P01' } }` → `logEvento` `info` con `esito: 'ricevute-registro-assente'`. Con `XX000` → livello `error`, `esito: 'ricevuta-non-annullata'`. In nessun caso lancia.

- [ ] **Step 2: Rosso.**

- [ ] **Step 3: Implementa.** In `eseguiStornoIncasso` sostituisci i tre blocchi:
```ts
  const marca = await supabase
    .from('incassi')
    .update({ stornato_il: new Date().toISOString(), storno_motivo: motivo })
    .eq('id', orig.id)
  if (marca.error) {
    // Lo storno È avvenuto (il contro-incasso c'è): la marcatura è secondaria,
    // ma «muta» era il difetto. La riapertura non dipende più da lei
    // (`stornoGiaRegistrato` guarda il contro-incasso).
    logEvento('pagamento', COLONNA_ASSENTE_STORNO.has(marca.error.code ?? '') ? 'info' : 'error', {
      operazione: 'pagamenti/incassi/storno:POST', esito: 'storno-marcatura-non-scritta', incasso_id: orig.id as string,
    }, marca.error)
  }

  const ric = await supabase.rpc('ricalcola_stato_pagamento', { p_id: pagamentoId })
  if (ric.error) {
    const assente = ['PGRST202', '42883'].includes(ric.error.code ?? '')
    logEvento('pagamento', assente ? 'info' : 'error', {
      operazione: 'pagamenti/incassi/storno:POST', esito: assente ? 'ricalcolo-rpc-assente' : 'ricalcolo-non-riuscito', pagamento_id: pagamentoId,
    }, ric.error)
  }

  const audit = await supabase.from('registro_modifiche').insert({ /* oggetto invariato */ })
  if (audit.error) {
    logEvento('pagamento', 'error', {
      operazione: 'pagamenti/incassi/storno:POST', esito: 'audit-storno-non-scritto', incasso_id: orig.id as string,
    }, audit.error)
  }
```
- In cima al file: `const COLONNA_ASSENTE_STORNO = new Set(['42703', 'PGRST204'])`. Se `COLONNA_ASSENTE` è già dichiarata nel file, riusa quella: guarda in alto.
- Il trigger `incassi_ricalcola` ricalcola comunque. La RPC esplicita resta per i DB in cui il trigger è vecchio.

In `ricevute.ts`:
```ts
    try {
        const { error } = await supabase
            .from('ricevute_emesse')
            .update({ annullata_il: new Date().toISOString(), annullata_da: opts.da ?? null, annullo_motivo: opts.motivo })
            .eq('transazione_id', transazioneId)
            .is('annullata_il', null)
        if (error) {
            const assente = ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code ?? '')
            logEvento('pagamento', assente ? 'info' : 'error', {
                operazione: 'ricevute:annulla-transazione', esito: assente ? 'ricevute-registro-assente' : 'ricevuta-non-annullata', transazione_id: transazioneId,
            }, error)
        }
    } catch (err) {
        logEvento('pagamento', 'error', { operazione: 'ricevute:annulla-transazione', esito: 'ricevuta-non-annullata', transazione_id: transazioneId }, err)
    }
```
Aggiungi l'import `logEvento` se manca.

- [ ] **Step 4: Verifica.**

Run: `npx vitest run $(git ls-files '__tests__/**' | grep -E 'storno|ricevut|transazioni-annulla|riconciliazione-riapri' | tr '\n' ' ')`
Atteso: PASS. Controlla anche che i test di riapertura che asserivano «`.then(()=>{},()=>{})` muto» siano ancora coerenti. Se un commento di test descrive il comportamento vecchio, aggiorna il **commento**, non l'asserzione.

- [ ] **Step 5: Commit.**

---

### Task 8: La riapertura pulisce coda fatture e ricevuta

**Files:**
- Create: `src/lib/pagamenti/riapertura-coda-fatture.ts`
- Modify: `src/lib/pagamenti/riapertura-movimento.ts`, `src/lib/ui/esito-fetch.ts` (codice `RIAPERTURA_FATTURA_IN_INVIO`, accanto a `RIAPERTURA_NON_RIUSCITA` riga ~2466, chiave `erroreRiaperturaFatturaInInvio`)
- Test:
  - `__tests__/lib/riapertura-coda-fatture.test.ts` (nuovo);
  - estendi `__tests__/api/pagamenti-riconciliazione-riapri.test.ts`: aggiungi al finto Supabase le tabelle `fatture_coda` e `pagamenti` (stato) e la RPC `fatture_coda_togli`.

- [ ] **Step 1: Modulo nuovo**

```ts
// src/lib/pagamenti/riapertura-coda-fatture.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─────────────────────────────────────────────────────────────────────────────
// LA CODA FATTURE DAVANTI A UNA RIAPERTURA (2026-10-05).
//
// Il caso che l'ha fatta nascere: un bonifico associato alla retta sbagliata
// aveva messo in coda la fattura di QUELLA retta; riaperto il bonifico, la voce
// tornava da pagare ma la richiesta restava in coda («errore», poi «non
// saldato» a ogni giro). Due regole:
//  · PRIMA di stornare: una richiesta `in_invio` ferma tutto (409). Il lavoratore
//    sta parlando con Aruba proprio adesso, e stornare sotto di lui produce una
//    fattura su una voce non più pagata.
//  · DOPO lo storno: le richieste `in_coda`/`errore` delle voci che NON sono più
//    `pagato` si tolgono (`fatture_coda_togli`). Una voce ancora saldata da altri
//    incassi tiene la sua richiesta.
// Sul DB E2E della CI la tabella non c'è: si degrada a «nessuna richiesta».
// ─────────────────────────────────────────────────────────────────────────────

const ASSENTE = new Set(['42P01', 'PGRST205', 'PGRST202', '42883'])

/** Le voci toccate dalla riapertura: la voce singola, o quelle degli incassi della transazione. */
export async function vociDelMovimento(
  supabase: SupabaseClient,
  mov: { pagamento_id: string | null; transazione_id?: string | null },
  operazione: string,
): Promise<string[]> {
  const ids = new Set<string>()
  if (mov.pagamento_id) ids.add(mov.pagamento_id)
  if (mov.transazione_id) {
    const { data, error } = await supabase.from('incassi').select('pagamento_id').eq('transazione_id', mov.transazione_id)
    if (error) {
      logEvento('pagamento', 'warn', { operazione, esito: 'voci-transazione-non-lette' }, error)
    } else {
      for (const r of (data ?? []) as { pagamento_id: string | null }[]) if (r.pagamento_id) ids.add(r.pagamento_id)
    }
  }
  return [...ids]
}

/** `true` se una richiesta di fattura su queste voci è IN INVIO adesso. Fail-closed su errore. */
export async function codaInInvio(
  supabase: SupabaseClient,
  pagamentoIds: string[],
  operazione: string,
): Promise<{ inInvio: boolean } | { guasto: true }> {
  if (pagamentoIds.length === 0) return { inInvio: false }
  const { data, error } = await supabase
    .from('fatture_coda').select('id').in('pagamento_id', pagamentoIds).eq('stato', 'in_invio').limit(1)
  if (error) {
    if (ASSENTE.has(error.code ?? '')) return { inInvio: false }
    logErrore({ operazione, evento: 'coda_fatture_non_letta_riapertura', stato: 500 }, error)
    return { guasto: true }
  }
  return { inInvio: ((data ?? []) as unknown[]).length > 0 }
}

/** Toglie dalla coda le richieste delle voci che dopo lo storno non sono più saldate. Mai lancia. */
export async function togliCodaVociNonSaldate(
  supabase: SupabaseClient,
  pagamentoIds: string[],
  attoreId: string,
  operazione: string,
): Promise<number> {
  if (pagamentoIds.length === 0) return 0
  const { data: pag, error: errPag } = await supabase.from('pagamenti').select('id, stato').in('id', pagamentoIds)
  if (errPag) {
    logEvento('pagamento', 'error', { operazione, esito: 'coda-fatture-voci-non-lette' }, errPag)
    return 0
  }
  const nonSaldate = ((pag ?? []) as { id: string; stato: string }[]).filter((p) => p.stato !== 'pagato').map((p) => p.id)
  if (nonSaldate.length === 0) return 0
  const { data: righe, error: errCoda } = await supabase
    .from('fatture_coda').select('id').in('pagamento_id', nonSaldate).in('stato', ['in_coda', 'errore'])
  if (errCoda) {
    if (!ASSENTE.has(errCoda.code ?? '')) logEvento('pagamento', 'error', { operazione, esito: 'coda-fatture-non-letta' }, errCoda)
    return 0
  }
  const ids = ((righe ?? []) as { id: string }[]).map((r) => r.id)
  if (ids.length === 0) return 0
  const { data: n, error: errTogli } = await supabase.rpc('fatture_coda_togli', { p_ids: ids, p_attore: attoreId })
  if (errTogli) {
    logEvento('pagamento', ASSENTE.has(errTogli.code ?? '') ? 'info' : 'error', { operazione, esito: 'coda-fatture-non-tolta', n: ids.length }, errTogli)
    return 0
  }
  logEvento('pagamento', 'info', { operazione, esito: 'coda-fatture-tolta-dopo-riapertura', n: Number(n ?? 0) })
  return Number(n ?? 0)
}
```

- [ ] **Step 2: Test del modulo**, rossi prima. Casi da coprire:
- `vociDelMovimento` unisce `pagamento_id` e le voci della transazione, senza doppioni.
- `codaInInvio`:
  - `in_invio` → `{ inInvio: true }`;
  - errore `42P01` → `{ inInvio: false }`;
  - errore `XX000` → `{ guasto: true }`.
- `togliCodaVociNonSaldate`:
  - una voce `pagato` e una `da_pagare` con richiesta `errore` → la RPC parte con il solo id della seconda e il risultato è 1;
  - RPC in errore → 0 e log `error`.

- [ ] **Step 3: Integra in `riapriMovimento`.**
- Import dei tre helper.
- `RiaperturaRiuscita` prende `richiesteFatturaTolte: number`.
- Subito **prima** di `// ── 2. LO STORNO`:
```ts
  // ── 1b. LA CODA FATTURE: una richiesta IN INVIO ferma tutto ────────────
  const vociCoinvolte = await vociDelMovimento(supabase, mov, operazione)
  const coda = await codaInInvio(supabase, vociCoinvolte, operazione)
  if ('guasto' in coda) {
    return { status: 500, body: { error: 'Non è stato possibile verificare la coda fatture: la riapertura è stata fermata.', codice: 'RIAPERTURA_NON_RIUSCITA' } }
  }
  if (coda.inInvio) {
    logEvento('pagamento', 'warn', { operazione, esito: 'riapertura-fattura-in-invio', movimento_id: id })
    return { status: 409, body: { error: 'Una fattura di questa voce è in invio: riprova fra un minuto.', codice: 'RIAPERTURA_FATTURA_IN_INVIO' } }
  }
```
- Prima del `return` finale di successo:
```ts
  // ── 4. LA RICEVUTA del composito: si annulla come fa `transazioni/[id]/annulla`
  if (mov.transazione_id) {
    await annullaRicevutaTransazioneAttiva(supabase, mov.transazione_id, { da: attoreId, motivo: MOTIVO_RIAPERTURA })
  }
  // ── 5. LA CODA FATTURE delle voci che non sono più saldate
  const richiesteFatturaTolte = await togliCodaVociNonSaldate(supabase, vociCoinvolte, attoreId, operazione)
```
  Poi aggiungi `richieste_fattura_tolte: richiesteFatturaTolte` a `body.data` e `richiesteFatturaTolte` a `ok`. Import: `annullaRicevutaTransazioneAttiva` da `@/lib/pagamenti/ricevute`.
- In `esito-fetch.ts`, accanto a `RIAPERTURA_NON_RIUSCITA`, aggiungi `RIAPERTURA_FATTURA_IN_INVIO: 'erroreRiaperturaFatturaInInvio',`, con un commento JSDoc di 2 righe («409 — una richiesta della coda fatture è in invio: nessuno storno»).

- [ ] **Step 4: Test d'integrazione** (in `pagamenti-riconciliazione-riapri.test.ts`):
- `fatture_coda` con una riga `in_invio` → 409 `RIAPERTURA_FATTURA_IN_INVIO`, `inserts` su `incassi` vuoti, nessuna RPC chiamata.
- Voce singola con richiesta `errore` e voce che dopo lo storno risulta `da_pagare` → RPC `fatture_coda_togli` chiamata e `data.richieste_fattura_tolte === 1`.
- Composito → update su `ricevute_emesse` con `annullata_il` impostato.

- [ ] **Step 5: Verifica.**

Run: `npx vitest run __tests__/lib/riapertura-coda-fatture.test.ts $(git ls-files '__tests__/**' | grep -E 'riapri|annullo-riapre|errori-con-codice|annulla-import' | tr '\n' ' ')`
Atteso: PASS. `annulla-import` usa `riapriMovimento`: aggiorna i suoi mock **solo** se il finto Supabase non risponde alle tabelle nuove (deve rispondere `{ data: [], error: null }`).

- [ ] **Step 6: Commit.**

---

### Task 9: `GET` dell'associazione e `poi: 'ignorato'`

**Files:**
- Create: `src/lib/pagamenti/associazione-movimento.ts`
- Modify: `src/app/api/pagamenti/riconciliazione/[id]/route.ts`
- Test: `__tests__/api/pagamenti-riconciliazione-associazione.test.ts` (nuovo; scaffold da `pagamenti-riconciliazione-riapri.test.ts`), più i casi `poi` aggiunti a `pagamenti-riconciliazione-riapri.test.ts`

- [ ] **Step 1: Il lettore dell'associazione**

```ts
// src/lib/pagamenti/associazione-movimento.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

// ─────────────────────────────────────────────────────────────────────────────
// A CHE COSA È ASSOCIATO QUESTO BONIFICO? (2026-10-05)
//
// Il popup di Riconciliazione sapeva dire lo stato della fattura della voce
// àncora e basta: non la voce, non il bambino, non chi aveva confermato. Questa
// lettura risponde alla domanda intera, in UNA richiesta (lock: «aprire il
// popup costa una lettura sola»), e porta con sé anche ciò che prima arrivava da
// `/api/pagamenti/[id]` — stato e fattura della voce àncora.
// Le voci di un composito si leggono dagli INCASSI della transazione (vivi:
// senza storno), che è dove il denaro è stato davvero scritto.
// ─────────────────────────────────────────────────────────────────────────────

export interface VoceAssociata {
  pagamento_id: string
  descrizione: string
  alunno: string
  scuola_id: string | null
  importo_voce: number
  incassato_qui: number
  stato_voce: string
  fattura_stato: string | null
  fattura_in_coda: 'in_coda' | 'in_invio' | 'errore' | null
}

export interface Associazione {
  tipo: 'singola' | 'composita'
  automatico: boolean
  confermato_il: string | null
  confermato_da: string | null
  voci: VoceAssociata[]
}

interface MovimentoLetto {
  stato: string
  pagamento_id: string | null
  incasso_id?: string | null
  transazione_id?: string | null
  confermato_da?: string | null
  confermato_il?: string | null
  abbinato_auto_il?: string | null
}

type RigaIncasso = { pagamento_id: string | null; importo: number | string; stornato_il?: string | null; storno_di?: string | null }

export async function leggiAssociazione(
  supabase: SupabaseClient,
  mov: MovimentoLetto,
  operazione: string,
): Promise<{ associazione: Associazione | null; ancora: { stato: string; fattura_stato: string | null } | null } | { guasto: unknown }> {
  if (mov.stato !== 'confermato') return { associazione: null, ancora: null }

  // 1. Quanto il bonifico ha messo su ciascuna voce
  const incassatoPerVoce = new Map<string, number>()
  if (mov.transazione_id) {
    const { data, error } = await supabase
      .from('incassi').select('pagamento_id, importo, stornato_il, storno_di').eq('transazione_id', mov.transazione_id)
    if (error) return { guasto: error }
    for (const r of (data ?? []) as RigaIncasso[]) {
      if (!r.pagamento_id || r.stornato_il || r.storno_di) continue
      incassatoPerVoce.set(r.pagamento_id, (incassatoPerVoce.get(r.pagamento_id) ?? 0) + Number(r.importo))
    }
  } else if (mov.incasso_id) {
    const { data, error } = await supabase.from('incassi').select('pagamento_id, importo').eq('id', mov.incasso_id).maybeSingle()
    if (error) return { guasto: error }
    const r = data as RigaIncasso | null
    if (r?.pagamento_id) incassatoPerVoce.set(r.pagamento_id, Number(r.importo))
  }
  if (mov.pagamento_id && !incassatoPerVoce.has(mov.pagamento_id)) incassatoPerVoce.set(mov.pagamento_id, 0)
  const ids = [...incassatoPerVoce.keys()]

  // 2. Le voci, col bambino
  let voci: VoceAssociata[] = []
  if (ids.length > 0) {
    const { data, error } = await supabase
      .from('pagamenti')
      .select('id, descrizione, importo, stato, scuola_id, fattura_stato, alunni:alunno_id ( nome, cognome )')
      .in('id', ids)
    if (error) return { guasto: error }
    // 3. La coda fatture (degrada a «nessuna» dove la tabella non c'è)
    const coda = new Map<string, VoceAssociata['fattura_in_coda']>()
    const { data: righeCoda, error: errCoda } = await supabase
      .from('fatture_coda').select('pagamento_id, stato').in('pagamento_id', ids).in('stato', ['in_coda', 'in_invio', 'errore'])
    if (errCoda) logEvento('pagamento', 'warn', { operazione, esito: 'associazione-coda-non-letta' }, errCoda)
    for (const r of (righeCoda ?? []) as { pagamento_id: string; stato: VoceAssociata['fattura_in_coda'] }[]) coda.set(r.pagamento_id, r.stato)
    voci = ((data ?? []) as {
      id: string; descrizione: string | null; importo: number | string; stato: string; scuola_id: string | null
      fattura_stato: string | null; alunni: { nome?: string | null; cognome?: string | null } | null
    }[]).map((p) => ({
      pagamento_id: p.id,
      descrizione: p.descrizione ?? '—',
      alunno: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ') || '—',
      scuola_id: p.scuola_id,
      importo_voce: Number(p.importo),
      incassato_qui: incassatoPerVoce.get(p.id) ?? 0,
      stato_voce: p.stato,
      fattura_stato: p.fattura_stato ?? null,
      fattura_in_coda: coda.get(p.id) ?? null,
    }))
    // la voce àncora per prima, poi nell'ordine degli incassi
    voci.sort((a, b) => (a.pagamento_id === mov.pagamento_id ? -1 : b.pagamento_id === mov.pagamento_id ? 1 : ids.indexOf(a.pagamento_id) - ids.indexOf(b.pagamento_id)))
  }

  // 4. Chi ha confermato (nome dell'operatore: è staff, non un dato di una famiglia)
  let confermatoDa: string | null = null
  if (mov.confermato_da) {
    const { data } = await supabase.from('utenti').select('nome, cognome').eq('id', mov.confermato_da).maybeSingle()
    const u = data as { nome?: string | null; cognome?: string | null } | null
    confermatoDa = [u?.nome, u?.cognome].filter(Boolean).join(' ') || null
  }

  const ancoraVoce = voci.find((v) => v.pagamento_id === mov.pagamento_id) ?? null
  return {
    associazione: {
      tipo: mov.transazione_id ? 'composita' : 'singola',
      automatico: !!mov.abbinato_auto_il,
      confermato_il: mov.confermato_il ?? null,
      confermato_da: confermatoDa,
      voci,
    },
    ancora: ancoraVoce ? { stato: ancoraVoce.stato_voce, fattura_stato: ancoraVoce.fattura_stato } : null,
  }
}
```

- [ ] **Step 2: La `GET` nella rotta.** In `riconciliazione/[id]/route.ts`:
- `MOV_SELECT_BASE` resta. Per la GET usa la stessa scala `MOV_VARIANTI`, aggiungendo in coda a ogni variante `, confermato_da, confermato_il`. Queste due colonne esistono dalla migrazione base del 2026-07-10, quindi non serve degradarle.
- Estrai il ciclo di lettura del PATCH in una funzione `leggiMovimento(supabase, id, operazione)` che restituisce `{ mov, colonnaTransazione, colonnaMarca } | { response }`, e usala in entrambi gli handler. È lo stesso codice, spostato: nessun cambio di comportamento sul PATCH.
- Aggiungi:
```ts
// GET /api/pagamenti/riconciliazione/[id] — il movimento e A CHE COSA è associato (staff).
export const GET = withRoute('pagamenti/riconciliazione/[id]:GET', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data
    const supabase = await createAdminClient()
    const letto = await leggiMovimento(supabase, id, 'pagamenti/riconciliazione/[id]:GET')
    if ('response' in letto) return letto.response
    const mov = letto.mov
    // Gate di sede: un movimento CONFERMATO ha la sede della voce; uno libero è
    // della coda globale (come per `ignora`). Fuori sede → 404, come altrove.
    if (mov.stato === 'confermato') {
      const sedi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
      if (mov.scuola_id && !sedi.includes(mov.scuola_id)) {
        return NextResponse.json({ error: 'Movimento non trovato', codice: 'CONCILIAZIONE_MOVIMENTO_NON_TROVATO' }, { status: 404 })
      }
    }
    const esito = await leggiAssociazione(supabase, mov, 'pagamenti/riconciliazione/[id]:GET')
    if ('guasto' in esito) {
      logErrore({ operazione: 'pagamenti/riconciliazione/[id]:GET', evento: 'associazione_non_letta', stato: 500 }, esito.guasto)
      return NextResponse.json({ error: 'Errore nella lettura dell’associazione', codice: 'MOVIMENTO_NON_LETTO' }, { status: 500 })
    }
    return NextResponse.json({
      success: true,
      data: {
        id: mov.id, stato: mov.stato, importo: mov.importo, data_operazione: mov.data_operazione,
        associazione: esito.associazione,
        pagamento: esito.ancora,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/riconciliazione/[id]:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
```
Controlla con `grep -n "isolamento-sede" -r __tests__/architecture` come il lock `isolamento-sede-coverage` riconosce un gate. Se richiede `assertPagamentoInScope` o un elenco di handler esentati, adegua: per un movimento confermato senza `scuola_id`, usa `assertPagamentoInScope(supabase, auth.user, mov.pagamento_id)` come fa il PATCH.

- [ ] **Step 3: `poi` nel PATCH.**
- `patchBodySchema` prende `poi: z.enum(['da_abbinare', 'ignorato']).optional(),`.
- Nel ramo `riapri` → `mov.stato === 'confermato'` → `if (esito.ok) { … }`, dopo il `logEvento` esistente:
```ts
          let ignoraApplicato: boolean | undefined
          if (b.data.poi === 'ignorato') {
            const { data: ign, error: errIgn } = await supabase
              .from('riconciliazione_movimenti').update({ stato: 'ignorato' }).eq('id', id).eq('stato', 'da_abbinare').select('id')
            ignoraApplicato = !errIgn && (ign?.length ?? 0) > 0
            if (!ignoraApplicato) {
              logEvento('pagamento', 'warn', { operazione: 'pagamenti/riconciliazione/[id]:PATCH', esito: 'ignora-dopo-riapertura-non-applicato', movimento_id: id }, errIgn ?? undefined)
            }
          }
          logEvento('pagamento', 'info', {
            operazione: 'pagamenti/riconciliazione/[id]:PATCH',
            esito: b.data.poi === 'ignorato' ? 'associazione-eliminata' : 'associazione-riaperta',
            movimento_id: id,
            ignorato: ignoraApplicato === true,
          })
          if (ignoraApplicato !== undefined) {
            const corpo = esito.body as { data?: Record<string, unknown> }
            corpo.data = { ...(corpo.data ?? {}), stato: ignoraApplicato ? 'ignorato' : 'da_abbinare', ignorato: ignoraApplicato }
          }
```

- [ ] **Step 4: Test.**

GET:
1. Singola: voce, bambino, `incassato_qui`, `confermato_da` col nome dell'operatore, `automatico: false`, `pagamento.stato`.
2. Composita: due voci da due incassi, la voce àncora per prima; un incasso stornato è escluso.
3. Movimento `da_abbinare` → `associazione: null`.
4. Errore su `incassi` → 500 `MOVIMENTO_NON_LETTO`.
5. Sede fuori perimetro → 404.
6. `fatture_coda` assente (`42P01`) → `fattura_in_coda: null` e 200.

PATCH:
7. `poi: 'ignorato'` → update condizionale con `stato: 'ignorato'` e `eq('stato','da_abbinare')`; risposta `data.stato === 'ignorato'`.
8. Update che tocca 0 righe → 200 con `data.ignorato === false`.

- [ ] **Step 5: Verifica.**

Run: `npx vitest run __tests__/api/pagamenti-riconciliazione-associazione.test.ts $(git ls-files '__tests__/**' | grep -E 'riconciliazione|zod-coverage|logging-coverage|gate-coverage|isolamento-sede' | tr '\n' ' ')`
Atteso: PASS.

- [ ] **Step 6: Commit.**

---

### Task 10: UI dell'associazione

**Files:**
- Create: `src/components/features/admin/pagamenti/AssociazioneBonifico.tsx`
- Create: `src/components/features/admin/pagamenti/ConfermaScollegaBonifico.tsx`
- Modify:
  - `MovimentoDialog.tsx`: lettura a riga ~660, sezione «Documenti» a ~1056, piede a ~1460;
  - `RiconciliazionePanel.tsx`: montaggio del dialog a ~1639;
  - `riconciliazione-ui.ts`: tipi.
- Test:
  - `__tests__/components/MovimentoDialog-associazione.test.tsx` (nuovo; scaffold da `__tests__/components/MovimentoDialog-componi-riapertura.test.tsx`);
  - controlla che `MovimentoDialog-componi-riapertura.test.tsx` resti verde **adeguando i mock della lettura**: ora l'URL è `/api/pagamenti/riconciliazione/{id}` e non più `/api/pagamenti/{pagamento_id}`.

- [ ] **Step 1: Tipi** in `riconciliazione-ui.ts`:
```ts
export interface VoceAssociataUi {
  pagamento_id: string; descrizione: string; alunno: string; scuola_id: string | null
  importo_voce: number; incassato_qui: number; stato_voce: string
  fattura_stato: string | null; fattura_in_coda: 'in_coda' | 'in_invio' | 'errore' | null
}
export interface AssociazioneUi {
  tipo: 'singola' | 'composita'; automatico: boolean
  confermato_il: string | null; confermato_da: string | null
  voci: VoceAssociataUi[]
}
```

- [ ] **Step 2: `AssociazioneBonifico.tsx`.** Componente presentazionale, senza fetch. Riceve `associazione: AssociazioneUi | null`, `caricamento: boolean`, `errore: boolean` e rende:
- una `section` con classe `rounded-card bg-kidville-cream p-4` e un `h3` `OCCHIELLO` con `t('movdlgAssociatoA')`. `OCCHIELLO` si importa dallo stesso posto in cui lo prende `MovimentoDialog`;
- durante il caricamento: `t('movdlgCaricamento')`;
- su errore: `<p role="alert">{t('movdlgAssociatoErrore')}</p>`;
- con zero voci: `t('movdlgAssociatoNessuna')`;
- per ogni voce un `<li>`: in grassetto `{v.alunno} · {v.descrizione}`; a destra `t('movdlgAssociatoIncassato', { incassato: formatEuro(v.incassato_qui), totale: formatEuro(v.importo_voce) })`; sotto, lo stato della voce con le etichette già usate nel dialog. Cerca con `grep -n "STATI_PAGAMENTO\|statoPagato" MovimentoDialog.tsx`; se non ci sono, usa le chiavi `dash*` di `adminContabilita`;
- in fondo una riga piccola:
  - con `automatico` → `t('movdlgAssociatoAutomatico', { data })`;
  - altrimenti, con `confermato_da` → `t('movdlgAssociatoConfermatoDa', { nome, data })`;
  - altrimenti → `t('movdlgAssociatoConfermatoIl', { data })`.

  La data si formatta con `useDateFormat().dataBreve` (lo stesso hook di `GeneratoreCategoria`).

- [ ] **Step 3: `ConfermaScollegaBonifico.tsx`.** Una modale annidata, con il componente `Modal` di `@/components/ui/Modal` come in `ModificaPagamentoModal`.
```tsx
interface Props {
  modo: 'modifica' | 'elimina';
  associazione: AssociazioneUi;
  busy: boolean;
  onConferma: (poi: 'da_abbinare' | 'ignorato') => void;
  onAnnulla: () => void;
}
```
Contenuto:
- titolo: `scollegaTitoloModifica` oppure `scollegaTitoloElimina`;
- `scollegaIntro`, seguito da una `<ul>` con:
  - per ogni voce con `incassato_qui > 0`: `scollegaStorno` con importo, voce e alunno;
  - con `tipo === 'composita'`: `scollegaVociComposte` e `scollegaRicevuta`;
  - per ogni voce con `fattura_stato === 'emessa'`: `scollegaFatturaEmessa`;
  - per ogni voce con `fattura_in_coda` uguale a `in_coda` o `errore`: `scollegaFatturaInCoda`;
  - con `modo === 'modifica'`: `scollegaDopoModifica`.
- Con `modo === 'elimina'`: un `fieldset` con `legend` `scollegaDestinoLegenda` e due `radio`:
  - `da_abbinare` (predefinito) → `scollegaDestinoDaAbbinare`;
  - `ignorato` → `scollegaDestinoIgnorato`, con l'aiuto `scollegaDestinoIgnoratoAiuto`.
- Pulsanti: `scollegaAnnulla` (`BTN_SECONDARY`) e `scollegaConferma` (`BTN_PRIMARY`, `disabled={busy}`). La conferma chiama `onConferma(modo === 'modifica' ? 'da_abbinare' : scelta)`.

- [ ] **Step 4: `MovimentoDialog.tsx`**
1. Props: aggiungi
```ts
  /**
   * «Modifica associazione»: dopo la riapertura il popup NON si chiude, si
   * RIAPRE sulla stessa riga ora libera, in abbinamento. Lo fa il pannello,
   * che possiede `selezionato`. Assente ⇒ si comporta come «Elimina».
   */
  onRiapertoPerModifica?: (movimento: MovimentoUi) => void;
```
2. La lettura (useEffect alle righe ~660-682): l'URL diventa `/api/pagamenti/riconciliazione/${movimento.id}?userId=${userId}`.
   - Leggi `j.data.pagamento` per `setPagamentoStato`/`setPagamentoFattura`, come prima;
   - aggiungi lo stato `const [associazione, setAssociazione] = useState<AssociazioneUi | null>(null)` e `const [associazioneErrore, setAssociazioneErrore] = useState(false)`;
   - `setAssociazione(j.data.associazione ?? null)`;
   - su `!r.ok` → `setAssociazioneErrore(true)` e `logClient` livello `warn` con lo `stato` HTTP;
   - la condizione di partenza `if (stato !== 'confermato' || !movimento.pagamento_id) return;` diventa `if (stato !== 'confermato') return;`, e `loadingPag` iniziale diventa `movimento.stato === 'confermato'`. Rispetta la regola del file: `setState` solo nel `try` e nel `finally`, mai nel `catch`.
3. Dentro `{!esito && isConfermato && (...)}`, **prima** della sezione «Documenti», rendi `<AssociazioneBonifico associazione={associazione} caricamento={loadingPag} errore={associazioneErrore} />`.
4. `azione` riceve un terzo parametro opzionale `poi?: 'da_abbinare' | 'ignorato'`, che va nel body: `JSON.stringify({ azione: az, pagamento_id: pagamentoId, ...(poi ? { poi } : {}) })`. Dopo il successo di un `riapri`:
```ts
      if (az === 'riapri' && intentoRef.current === 'modifica' && onRiapertoPerModifica) {
        intentoRef.current = null;
        onRiapertoPerModifica({ ...movimento, stato: 'da_abbinare', confermato_il: null });
        return;
      }
```
   Servono due cose nuove:
   - `const intentoRef = useRef<'modifica' | 'elimina' | null>(null)`: è un `ref` e non uno stato, perché lo legge `azione` dentro `useCallback` senza entrare nelle dipendenze. Lo imposta `onConferma` della conferma (Step 4.5).
   - `const [confermaScollega, setConfermaScollega] = useState<'modifica' | 'elimina' | null>(null)`: decide se la conferma è montata.
   - `EsitoAzione` prende `ignorato?: boolean; richiesteFatturaTolte?: number`. Nel ramo che fa `setEsito`, passali da `j.data?.ignorato` e `j.data?.richieste_fattura_tolte`.
   - `CorpoAzione.data` prende `ignorato?: boolean; richieste_fattura_tolte?: number`.
   - Dove si rende l'esito della riapertura (cercalo con `grep -n "tipo === 'riapertura'\|esito.tipo"`), aggiungi:
     - con `esito.ignorato === true` → `t('movdlgEsitoIgnorato')`;
     - con `esito.ignorato === false` → `t('movdlgEsitoIgnoraNonApplicato')`;
     - con `richiesteFatturaTolte > 0` → `t('movdlgEsitoCodaTolte', { n })`.
5. Piede (riga ~1466): sostituisci il pulsante «Riapri» con
```tsx
        {!esito && !composto && isConfermato && (
          <>
            <button type="button" onClick={() => setConfermaScollega('modifica')} disabled={busy || loadingPag} className={cx(BTN_SECONDARY, 'min-h-11')}>
              {t('movdlgModificaAssociazione')}
            </button>
            <button type="button" onClick={() => setConfermaScollega('elimina')} disabled={busy || loadingPag} className={cx(BTN_SECONDARY, 'min-h-11')}>
              {t('movdlgEliminaAssociazione')}
            </button>
          </>
        )}
        {!esito && !composto && isIgnorato && (
          <button type="button" onClick={() => azione('riapri')} disabled={busy} className={cx(BTN_SECONDARY, 'min-h-11')}>
            {t('movdlgRimettiDaAbbinare')}
          </button>
        )}
```
   e monta la conferma:
```tsx
      {confermaScollega && (
        <ConfermaScollegaBonifico
          modo={confermaScollega}
          associazione={associazione ?? { tipo: 'singola', automatico: false, confermato_il: null, confermato_da: null, voci: [] }}
          busy={busy}
          onAnnulla={() => setConfermaScollega(null)}
          onConferma={(poi) => { intentoRef.current = confermaScollega; setConfermaScollega(null); void azione('riapri', undefined, poi); }}
        />
      )}
```
   Se la chiave `movdlgRiapri` non è più usata da nessuna parte (`grep -rn movdlgRiapri src`), **lasciala** nel catalogo: un catalogo non si riordina e non si sfoltisce in questo lavoro.

- [ ] **Step 5: `RiconciliazionePanel.tsx`.** Sul `<MovimentoDialog …>` aggiungi `key={`${selezionato.id}:${selezionato.stato}`}` e:
```tsx
          onRiapertoPerModifica={(m) => {
            // Il popup si riapre sulla STESSA riga, ora libera: l'operatrice
            // sceglie subito la voce giusta. `load()` rilegge anche le voci
            // aperte, dove quella appena stornata ricompare.
            setSelezionato(m);
            void load();
            riconta();
          }}
```

- [ ] **Step 6: Test** (`MovimentoDialog-associazione.test.tsx`), rossi prima dei passi 2-5:
1. Movimento confermato, con la GET che risponde un'associazione singola:
   - compaiono «Associato a», il nome del bambino, la voce e «Confermato da …»;
   - ci sono i pulsanti «Modifica associazione» ed «Elimina associazione»;
   - **non** c'è «Riapri».
2. «Elimina associazione»:
   - si apre la conferma con la frase dello storno;
   - scegliendo «viene segnato come ignorato» e confermando, la PATCH parte con body `{ azione: 'riapri', poi: 'ignorato' }`;
   - con la risposta `data.ignorato: true` compare «Il bonifico è stato segnato come ignorato.».
3. «Modifica associazione» + conferma → PATCH senza `poi` (oppure `poi: 'da_abbinare'`); `onRiapertoPerModifica` chiamato con `stato: 'da_abbinare'`.
4. «Annulla» nella conferma → nessuna PATCH.
5. Con una voce `fattura_stato: 'emessa'` la conferma mostra la frase della nota di credito.
6. GET in 500 → `role="alert"` con `movdlgAssociatoErrore`, e i pulsanti restano (la riapertura non dipende dalla lettura).
7. Movimento ignorato → pulsante «Rimetti da abbinare», che chiama la PATCH `riapri` senza conferma, come prima.

- [ ] **Step 7: Verifica.**

Run: `npx vitest run $(git ls-files '__tests__/**' | grep -E 'MovimentoDialog|RiconciliazionePanel|riconciliazione-a11y|riconciliazione-ui' | tr '\n' ' ') && npx tsc --noEmit -p . 2>&1 | head -20 && npx eslint src/components/features/admin/pagamenti --max-warnings 0`
Atteso: tutto verde. Attento al lock `riconciliazione-a11y-css`: i fondi in hover devono essere scuri o avere la loro regola di Alto Contrasto. Usa solo `BTN_SECONDARY`/`BTN_PRIMARY` esistenti.

- [ ] **Step 8: Commit.**

---

### Task 11: PRD

**Files:** `PRD REGISTRO ELETTRONICO.md`

- [ ] **Step 1:** Trova il blocco changelog più recente: `grep -n "^## Changelog\|^### Changelog\|Changelog —" "PRD REGISTRO ELETTRONICO.md" | head`. Aggiungi in cima ai changelog una voce **«Changelog — 2026-10-05: metodi di pagamento ammessi e associazioni dei bonifici»**, sul modello delle precedenti, con:
- **cosa**: colonna `metodi_ammessi`; caselle nel generatore per categoria e nella modifica; badge; «Come pagare» e solleciti senza IBAN e causale per le voci «solo contanti»; riquadro «Associato a»; «Modifica/Elimina associazione» con conferma e destino «da abbinare/ignorato»; coda fatture tolta e ricevuta annullata alla riapertura; storno che non ingoia più gli errori;
- **perché**: la richiesta del titolare, e il caso di un bonifico associato alla retta sbagliata a Giugliano, corretto a mano sul DB il 05/10. **Senza nomi**;
- **decisioni del titolare**: le cinque della spec;
- **cosa resta da provare sul campo**: un pagamento «solo contanti» visto da un genitore, e un'associazione modificata dalla segreteria.
- [ ] **Step 2:** Aggiorna §2 «Creazione e Assegnazione Pagamenti» (riga ~27424) e §4 «Esperienza Utente Genitore» (riga ~27446), più la sezione Riconciliazione (`grep -n "Riconciliazione" "PRD REGISTRO ELETTRONICO.md" | head`). Una o due frasi ciascuna; aggiorna anche la tabella di stato in cima, se elenca la contabilità.
- [ ] **Step 3: Commit.**

---

### Gate finale (orchestratore)

- [ ] `npx eslint . --max-warnings 0`
- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run`. Atteso: tutto verde tranne `offline-html-nativo`, che in un worktree senza `npx cap sync` è rosso per costruzione. **Va detto nel report, non nascosto.**
- [ ] `npm run build`
- [ ] Push, PR, CI (tutti i job; `grep -c flaky` nei log E2E), merge a mano e deploy verificato.
- [ ] Sul DB vero dopo il merge:
  - `SELECT column_name, column_default FROM information_schema.columns WHERE table_name='pagamenti' AND column_name='metodi_ammessi';`
  - il CHECK in `pg_constraint`;
  - `SELECT count(*) FROM pagamenti WHERE metodi_ammessi <> ARRAY['contanti','bonifico']` → 0.
- [ ] Pulizia dei branch, memoria aggiornata.
