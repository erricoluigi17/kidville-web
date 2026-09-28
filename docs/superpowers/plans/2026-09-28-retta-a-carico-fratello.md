# «Paga il fratello …» al posto di «Non generata» — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nella Contabilità → vista Rette, il bambino la cui retta è a carico di un fratello mostra «Paga il fratello/la sorella Nome (Classe) · Stato» (colorato come la retta del fratello) invece di «Non generata»; esce dal conteggio «Genera mancanti»; entra nel filtro Morosi e nella ricerca per nome del pagante; e compare nell'export Excel con una riga a importi zero per ogni retta del pagante.

**Architecture:** un modulo puro (`rette-a-carico.ts`) con tipi e testi; un loader server (`rette-a-carico-server.ts`) che legge i legami con due query semplici; una route di sola lettura `GET /api/pagamenti/rette-a-carico` per il cruscotto; un componente `BadgeRettaACarico` che disegna badge e avvisi; l'export riusa lo stesso loader tramite `export-rette-a-carico.ts`. Lo stato della retta del pagante nel cruscotto viene dalla stessa mappa che disegna la riga del pagante.

**Tech Stack:** Next.js (App Router, route handlers), React client components, next-intl (ICU), Supabase/PostgREST, zod, SheetJS (`xlsx`), vitest + Testing Library + `__tests__/fixtures/finto-supabase`.

**Spec:** `docs/superpowers/specs/2026-09-28-retta-a-carico-fratello-design.md` (decisioni D1–D15).

**Regole del repo che valgono per ogni task** (AGENTS.md): mai `console.*` in `src/` (si usa `@/lib/logging/logger`); ogni route avvolta in `withRoute` + `zod`; PostgREST non lancia (si controlla `{ error }`); mai nomi o codici fiscali nei log; un `catch` che non logga è un bug; si legge con `Read`, si cerca con `Grep`; i comandi che stampano molto passano da `tail`. Il test si guarda **fallire** prima di scrivere il codice, e si controlla la riga `Test Files N passed`.

---

## File

| File | Stato | Responsabilità |
|---|---|---|
| `src/lib/pagamenti/rette-a-carico.ts` | nuovo | tipi `PaganteRetta`/`LegameRetta`, testi (`prefissoPaganteIt`, `testoPaganteIt`, `componiBadge`, `valoriPrefisso`), `anomaliaPagante`, `sessoDa`, `indicizzaLegami`, `legamiDaRisposta`. Puro. |
| `src/lib/pagamenti/rette-a-carico-server.ts` | nuovo | `caricaLegamiRetta(supabase, { sediBambini, sediPaganti, operazione })` |
| `src/app/api/pagamenti/rette-a-carico/route.ts` | nuovo | `GET` per il cruscotto |
| `src/lib/pagamenti/export-rette-a-carico.ts` | nuovo | `righeRetteACarico(...)` + tipo `RigaScadenzario` |
| `src/components/features/admin/pagamenti/BadgeRettaACarico.tsx` | nuovo | badge «Paga il fratello …», avviso D9, avviso anomalia D12 |
| `src/components/features/admin/pagamenti/PaymentsDashboard.tsx` | modifica | terza GET, badge desktop/mobile, mancanti, morosi, ricerca, banner d'errore |
| `src/components/features/admin/pagamenti/PagamentoCardMobile.tsx` | modifica | prop opzionale `avviso` (D9 su mobile) |
| `src/app/api/pagamenti/export/route.ts` | modifica | righe in più dei bambini a carico |
| `messages/it/adminContabilita.json`, `messages/en/adminContabilita.json` | modifica | 5 chiavi nuove |
| `__tests__/pagamenti/rette-a-carico.test.ts` | nuovo | unit del modulo puro + lock testo UI ↔ Excel |
| `__tests__/pagamenti/rette-a-carico-server.test.ts` | nuovo | loader |
| `__tests__/api/pagamenti-rette-a-carico.test.ts` | nuovo | route |
| `__tests__/api/pagamenti-export-rette-a-carico.test.ts` | nuovo | export |
| `__tests__/components/PaymentsDashboard-retta-a-carico.test.tsx` | nuovo | cruscotto |
| `PRD REGISTRO ELETTRONICO.md` | modifica | changelog in cima |

---

### Task 1: il modulo puro

**Files:**
- Create: `src/lib/pagamenti/rette-a-carico.ts`
- Test: `__tests__/pagamenti/rette-a-carico.test.ts`

- [ ] **Step 1: scrivi il test che fallisce**

```ts
import { describe, it, expect } from 'vitest'
import {
  anomaliaPagante, componiBadge, indicizzaLegami, legamiDaRisposta, nomeConClasse, nomePagante,
  prefissoPaganteIt, sessoDa, testoPaganteIt, valoriPrefisso, SEPARATORE_STATO,
  type LegameRetta, type PaganteRetta,
} from '@/lib/pagamenti/rette-a-carico'

const pagante = (extra: Partial<PaganteRetta> = {}): PaganteRetta => ({
  id: 'p1', nome: 'Mario', cognome: 'Rossi', sesso: 'M', classe_sezione: 'Sez. C',
  iscritto: true, scuola_id: 's1', ...extra,
})
const legame = (extra: Partial<PaganteRetta> = {}, sedeBambino = 's1'): LegameRetta => ({
  alunno_id: 'b1', scuola_id: sedeBambino, pagante: pagante(extra),
})

describe('rette a carico — i testi (D1, D2, D5)', () => {
  it('fratello, sorella, sesso assente', () => {
    expect(prefissoPaganteIt(pagante())).toBe('Paga il fratello Mario Rossi (Sez. C)')
    expect(prefissoPaganteIt(pagante({ sesso: 'F', nome: 'Anna' }))).toBe('Paga la sorella Anna Rossi (Sez. C)')
    expect(prefissoPaganteIt(pagante({ sesso: null }))).toBe('A carico di Mario Rossi (Sez. C)')
  })
  it('senza classe niente parentesi; spazi ripuliti', () => {
    expect(nomeConClasse(pagante({ classe_sezione: null }))).toBe('Mario Rossi')
    expect(nomeConClasse(pagante({ classe_sezione: '   ' }))).toBe('Mario Rossi')
    expect(nomePagante({ nome: ' Mario ', cognome: ' De  Luca ' })).toBe('Mario De Luca')
  })
  it('lo stato si aggiunge dopo il separatore, e solo se c’è', () => {
    expect(SEPARATORE_STATO).toBe(' · ')
    expect(testoPaganteIt(pagante(), 'Da pagare')).toBe('Paga il fratello Mario Rossi (Sez. C) · Da pagare')
    expect(testoPaganteIt(pagante(), null)).toBe('Paga il fratello Mario Rossi (Sez. C)')
    expect(componiBadge('X', '')).toBe('X')
  })
  it('valoriPrefisso: il sesso assente diventa «nd» (ICU vuole una stringa)', () => {
    expect(valoriPrefisso(pagante({ sesso: null }))).toEqual({ sesso: 'nd', nome: 'Mario Rossi (Sez. C)' })
    expect(valoriPrefisso(pagante())).toEqual({ sesso: 'M', nome: 'Mario Rossi (Sez. C)' })
  })
})

describe('sessoDa', () => {
  it('accetta M/F anche minuscole e con spazi; il resto è null', () => {
    expect(sessoDa('M')).toBe('M')
    expect(sessoDa(' f ')).toBe('F')
    expect(sessoDa('X')).toBeNull()
    expect(sessoDa('')).toBeNull()
    expect(sessoDa(null)).toBeNull()
    expect(sessoDa(1)).toBeNull()
  })
})

describe('anomaliaPagante (D12)', () => {
  it('nessuna anomalia: iscritto e stessa sede', () => {
    expect(anomaliaPagante(legame())).toBeNull()
  })
  it('non iscritto', () => {
    expect(anomaliaPagante(legame({ iscritto: false }))).toBe('non-iscritto')
  })
  it('altra sede', () => {
    expect(anomaliaPagante(legame({ scuola_id: 's2' }))).toBe('altra-sede')
  })
  it('il non iscritto vince sull’altra sede', () => {
    expect(anomaliaPagante(legame({ iscritto: false, scuola_id: 's2' }))).toBe('non-iscritto')
  })
})

describe('indicizzaLegami e legamiDaRisposta', () => {
  it('indicizza per alunno a carico', () => {
    const m = indicizzaLegami([legame()])
    expect(m.get('b1')?.pagante.id).toBe('p1')
    expect(m.size).toBe(1)
  })
  it('una risposta che non è un array è null (guasto, non «nessun legame»)', () => {
    expect(legamiDaRisposta(undefined)).toBeNull()
    expect(legamiDaRisposta({})).toBeNull()
  })
  it('scarta le voci malformate e tiene le buone', () => {
    const buona = legame()
    expect(legamiDaRisposta([buona, null, { alunno_id: 'x' }, { alunno_id: 'y', pagante: { id: 3 } }])).toEqual([buona])
  })
})
```

- [ ] **Step 2: guardalo fallire**

Run: `npx vitest run __tests__/pagamenti/rette-a-carico.test.ts 2>&1 | tail -15`
Expected: FAIL — `Failed to resolve import "@/lib/pagamenti/rette-a-carico"`.

- [ ] **Step 3: scrivi il modulo**

```ts
/**
 * ─── LA RETTA A CARICO DI UN FRATELLO, VISTA DALLA CONTABILITÀ ─────────────────
 *
 * `alunni.retta_a_carico_di` (dal 2026-08-16) dice che la retta di un bambino la paga un
 * fratello: entrambe le strade che generano le rette lo SALTANO. Fino al 2026-09-28 la
 * vista Rette lo mostrava comunque come «Non generata», cioè come un bambino dimenticato,
 * e «Genera mancanti» lo contava senza mai poterlo generare.
 *
 * Questo modulo è PURO: tipi, testi, anomalie. Il testo italiano qui sotto è lo stesso
 * del catalogo `it` (`adminContabilita.dashACarico`): lo usa l'export Excel, e un lock
 * (`__tests__/pagamenti/rette-a-carico.test.ts`) verifica che schermo ed Excel dicano
 * la stessa frase.
 */

export type SessoPagante = 'M' | 'F' | null

export interface PaganteRetta {
  id: string
  nome: string
  cognome: string
  sesso: SessoPagante
  classe_sezione: string | null
  /** `stato === 'iscritto'` e nessuna data di archiviazione. */
  iscritto: boolean
  scuola_id: string | null
}

export interface LegameRetta {
  /** Il bambino A CARICO. */
  alunno_id: string
  /** La sede del bambino a carico. */
  scuola_id: string | null
  pagante: PaganteRetta
}

export type AnomaliaPagante = 'non-iscritto' | 'altra-sede' | null

/** Fra chi paga e lo stato della sua retta: identico a schermo e nell'Excel. */
export const SEPARATORE_STATO = ' · '

export function sessoDa(gender: unknown): SessoPagante {
  if (typeof gender !== 'string') return null
  const g = gender.trim().toUpperCase()
  return g === 'M' || g === 'F' ? g : null
}

export function nomePagante(p: Pick<PaganteRetta, 'nome' | 'cognome'>): string {
  return `${p.nome ?? ''} ${p.cognome ?? ''}`.replace(/\s+/g, ' ').trim()
}

/** «Mario Rossi (Sez. C)»; senza classe, solo il nome (D5). */
export function nomeConClasse(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione'>): string {
  const nome = nomePagante(p)
  const classe = p.classe_sezione?.trim()
  return classe ? `${nome} (${classe})` : nome
}

/** I valori del messaggio ICU `dashACarico`/`dashACaricoVerifica`: ICU vuole una stringa, «nd» = sesso assente. */
export function valoriPrefisso(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>): { sesso: string; nome: string } {
  return { sesso: p.sesso ?? 'nd', nome: nomeConClasse(p) }
}

/** Il prefisso in italiano (D1): la stessa frase del catalogo `it`. */
export function prefissoPaganteIt(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>): string {
  const nome = nomeConClasse(p)
  if (p.sesso === 'M') return `Paga il fratello ${nome}`
  if (p.sesso === 'F') return `Paga la sorella ${nome}`
  return `A carico di ${nome}`
}

/** Prefisso + « · stato» (D2). Senza stato, il solo prefisso. */
export function componiBadge(prefisso: string, stato?: string | null): string {
  return stato ? `${prefisso}${SEPARATORE_STATO}${stato}` : prefisso
}

/** Il testo intero in italiano: la colonna «Stato» dell'export (D14). */
export function testoPaganteIt(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>, stato?: string | null): string {
  return componiBadge(prefissoPaganteIt(p), stato)
}

/**
 * D12. Il non iscritto vince: se chi paga è uscito, che sia anche in un'altra sede è un
 * dettaglio. Le sedi si confrontano come arrivano dal database (forma canonica).
 */
export function anomaliaPagante(l: LegameRetta): AnomaliaPagante {
  if (!l.pagante.iscritto) return 'non-iscritto'
  if (l.pagante.scuola_id !== l.scuola_id) return 'altra-sede'
  return null
}

export function indicizzaLegami(legami: readonly LegameRetta[]): Map<string, LegameRetta> {
  return new Map(legami.map((l) => [l.alunno_id, l]))
}

/**
 * Il corpo della GET, controllato. `null` = forma inattesa: è un GUASTO, non «nessun
 * legame», e il chiamante lo dice a schermo. Le voci malformate si scartano una a una.
 */
export function legamiDaRisposta(data: unknown): LegameRetta[] | null {
  if (!Array.isArray(data)) return null
  return data.filter((x): x is LegameRetta => {
    if (!x || typeof x !== 'object') return false
    const l = x as Partial<LegameRetta>
    const p = l.pagante as Partial<PaganteRetta> | undefined
    return typeof l.alunno_id === 'string' && !!p && typeof p === 'object'
      && typeof p.id === 'string' && typeof p.nome === 'string' && typeof p.cognome === 'string'
  })
}
```

- [ ] **Step 4: guardalo passare**

Run: `npx vitest run __tests__/pagamenti/rette-a-carico.test.ts 2>&1 | tail -6`
Expected: `Test Files  1 passed (1)`.

- [ ] **Step 5: commit**

```bash
git add src/lib/pagamenti/rette-a-carico.ts __tests__/pagamenti/rette-a-carico.test.ts
git commit -m "Rette a carico: modulo puro con testi, anomalie e indice dei legami

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: le chiavi di traduzione e il lock schermo ↔ Excel

**Files:**
- Modify: `messages/it/adminContabilita.json` (accanto a `"dashNonGenerata"`, riga ~259)
- Modify: `messages/en/adminContabilita.json` (accanto a `"dashNonGenerata"`, riga ~259)
- Test: `__tests__/pagamenti/rette-a-carico.test.ts` (aggiunta)

- [ ] **Step 1: aggiungi il test del lock** in fondo a `__tests__/pagamenti/rette-a-carico.test.ts`

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IntlMessageFormat } from 'intl-messageformat'

const catalogo = (lingua: string) =>
  JSON.parse(readFileSync(join(process.cwd(), `messages/${lingua}/adminContabilita.json`), 'utf8')) as Record<string, string>

describe('LOCK — schermo (catalogo it) ed Excel (prefissoPaganteIt) dicono la stessa frase', () => {
  const it_ = catalogo('it')
  for (const sesso of ['M', 'F', null] as const) {
    for (const classe of ['Sez. C', null]) {
      it(`sesso ${sesso ?? 'assente'}, classe ${classe ?? 'assente'}`, () => {
        const p = pagante({ sesso, classe_sezione: classe })
        const schermo = String(new IntlMessageFormat(it_.dashACarico, 'it').format(valoriPrefisso(p)))
        expect(schermo).toBe(prefissoPaganteIt(p))
      })
    }
  }
  it('l’avviso D9 usa la stessa forma di nome', () => {
    const p = pagante({ sesso: 'F', nome: 'Anna' })
    expect(String(new IntlMessageFormat(it_.dashACaricoVerifica, 'it').format(valoriPrefisso(p))))
      .toBe('A carico della sorella Anna Rossi (Sez. C): retta da verificare')
  })
  it('le cinque chiavi esistono in entrambe le lingue', () => {
    for (const lingua of ['it', 'en']) {
      const c = catalogo(lingua)
      for (const k of ['dashACarico', 'dashACaricoVerifica', 'dashPaganteNonIscritto', 'dashPaganteAltraSede', 'dashMsErrLegami']) {
        expect(typeof c[k], `${lingua}.${k}`).toBe('string')
      }
    }
  })
})
```

- [ ] **Step 2: guardalo fallire**

Run: `npx vitest run __tests__/pagamenti/rette-a-carico.test.ts 2>&1 | tail -15`
Expected: FAIL (le chiavi non esistono: `IntlMessageFormat` riceve `undefined`).

- [ ] **Step 3: aggiungi le chiavi** subito dopo `"dashNonGenerata"` in `messages/it/adminContabilita.json`:

```json
  "dashACarico": "{sesso, select, M {Paga il fratello {nome}} F {Paga la sorella {nome}} other {A carico di {nome}}}",
  "dashACaricoVerifica": "{sesso, select, M {A carico del fratello {nome}} F {A carico della sorella {nome}} other {A carico di {nome}}}: retta da verificare",
  "dashPaganteNonIscritto": "Chi paga non è più iscritto: retta da rivedere",
  "dashPaganteAltraSede": "Chi paga è in un’altra sede: retta da rivedere",
  "dashMsErrLegami": "Impossibile sapere chi paga la retta per un fratello: quei bambini risultano «Non generata». Riprova.",
```

e in `messages/en/adminContabilita.json`, stessa posizione:

```json
  "dashACarico": "{sesso, select, M {Paid by brother {nome}} F {Paid by sister {nome}} other {Paid by {nome}}}",
  "dashACaricoVerifica": "{sesso, select, M {Brother {nome} pays} F {Sister {nome} pays} other {{nome} pays}}: fee to be checked",
  "dashPaganteNonIscritto": "The payer is no longer enrolled: review the fee",
  "dashPaganteAltraSede": "The payer is at another school: review the fee",
  "dashMsErrLegami": "Could not load who pays the fee for a sibling: those children show as “Not generated”. Try again.",
```

(L'apostrofo tipografico `’` e non `'`: in ICU l'apostrofo dritto è un carattere di escape.)

- [ ] **Step 4: guardalo passare, più i lock dei cataloghi**

Run: `npx vitest run __tests__/pagamenti/rette-a-carico.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts __tests__/architecture/messaggi-plurali-e-glossario.test.ts 2>&1 | tail -8`
Expected: `Test Files  3 passed (3)`. (`messaggi-chiavi-orfane` resterà rosso finché il Task 5 non usa le chiavi: si verifica al Task 7.)

- [ ] **Step 5: commit**

```bash
git add messages/it/adminContabilita.json messages/en/adminContabilita.json __tests__/pagamenti/rette-a-carico.test.ts
git commit -m "Rette a carico: chiavi di traduzione e lock schermo = Excel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: il loader server

**Files:**
- Create: `src/lib/pagamenti/rette-a-carico-server.ts`
- Test: `__tests__/pagamenti/rette-a-carico-server.test.ts`

- [ ] **Step 1: scrivi il test che fallisce**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DBFinto } from '../fixtures/finto-supabase'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  return { ...vero, logEvento: h.logEvento }
})

import { caricaLegamiRetta } from '@/lib/pagamenti/rette-a-carico-server'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

const OP = 'test:GET'
const alunno = (id: string, extra: Record<string, unknown>) => ({
  id, nome: `N${id}`, cognome: `C${id}`, classe_sezione: `Sez ${id}`, section_id: `sez-${id}`,
  scuola_id: 's1', stato: 'iscritto', gender: 'M', archiviato_il: null, retta_a_carico_di: null, ...extra,
})

let db: DBFinto
const client = (errori: Record<string, { code: string }> = {}) =>
  creaFintoSupabase(db, [], { errori }) as unknown as SupabaseClient

beforeEach(() => {
  h.logEvento.mockClear()
  db = {
    alunni: [
      alunno('pag', {}),                                              // paga per «fig»
      alunno('fig', { retta_a_carico_di: 'pag', gender: 'F' }),
      alunno('rit', { retta_a_carico_di: 'pag', stato: 'ritirato' }), // non iscritto: escluso
      alunno('alt', { retta_a_carico_di: 'pag', scuola_id: 's9' }),   // sede fuori: escluso
      alunno('ex', { stato: 'ritirato', gender: 'F' }),               // pagante uscito
      alunno('orf', { retta_a_carico_di: 'ex' }),
      alunno('lon', { scuola_id: 's3' }),                             // pagante in sede NON accessibile
      alunno('nas', { retta_a_carico_di: 'lon' }),
    ],
  }
})

describe('caricaLegamiRetta', () => {
  it('legge i legami degli iscritti delle sedi, con il pagante', async () => {
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1', 's2'], operazione: OP })
    expect(e.ok).toBe(true)
    if (!e.ok) return
    const perAlunno = Object.fromEntries(e.legami.map((l) => [l.alunno_id, l]))
    expect(Object.keys(perAlunno).sort()).toEqual(['fig', 'orf'])
    expect(perAlunno.fig).toEqual({
      alunno_id: 'fig', scuola_id: 's1',
      alunno: { nome: 'Nfig', cognome: 'Cfig', classe_sezione: 'Sez fig', section_id: 'sez-fig' },
      pagante: { id: 'pag', nome: 'Npag', cognome: 'Cpag', sesso: 'M', classe_sezione: 'Sez pag', iscritto: true, scuola_id: 's1' },
    })
    expect(perAlunno.orf.pagante).toMatchObject({ id: 'ex', iscritto: false, sesso: 'F' })
  })

  it('pagante in una sede non accessibile: il legame si scarta e si conta in un warn', async () => {
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.map((l) => l.alunno_id).sort()).toEqual(['fig', 'orf'])
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'warn', expect.objectContaining({ operazione: OP, esito: 'legami-pagante-non-leggibile', n: 1 }))
  })

  it('un pagante archiviato non è iscritto anche se lo stato dice iscritto', async () => {
    db.alunni.find((a) => a.id === 'pag')!.archiviato_il = '2026-09-01T00:00:00Z'
    const e = await caricaLegamiRetta(client(), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami.find((l) => l.alunno_id === 'fig')?.pagante.iscritto).toBe(false)
  })

  it('nessuna sede: zero legami senza toccare il database', async () => {
    const e = await caricaLegamiRetta(client({ alunni: { code: '57014' } }), { sediBambini: [], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: true, legami: [] })
  })

  it('DB non migrato (42703): zero legami, log info, NON un guasto', async () => {
    const e = await caricaLegamiRetta(client({ alunni: { code: '42703' } }), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: true, legami: [] })
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({ esito: 'legami-colonna-assente' }), expect.anything())
  })

  it('guasto di lettura: ok=false e log error (PostgREST non lancia)', async () => {
    const e = await caricaLegamiRetta(client({ alunni: { code: '57014' } }), { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e).toEqual({ ok: false })
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'legami-bambini-non-letti' }), expect.anything())
  })
})

describe('caricaLegamiRetta — la seconda query (paganti)', () => {
  /** Client a copione: la N-esima `from()` risolve con la N-esima risposta, e registra select e filtri. */
  function copione(risposte: { data: unknown; error: unknown }[]) {
    const chiamate: { select: string; filtri: unknown[][] }[] = []
    const client = {
      from: () => {
        const c = { select: '', filtri: [] as unknown[][] }
        chiamate.push(c)
        const indice = chiamate.length - 1
        const b: Record<string, unknown> = {}
        for (const m of ['eq', 'in', 'not']) b[m] = (...a: unknown[]) => { c.filtri.push([m, ...a]); return b }
        b.select = (s: string) => { c.select = s; return b }
        b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risposte[indice]).then(ok, ko)
        return b
      },
    } as unknown as SupabaseClient
    return { client, chiamate }
  }
  const BAMBINO = { id: 'b', nome: 'B', cognome: 'X', classe_sezione: null, section_id: null, scuola_id: 's1', retta_a_carico_di: 'p' }
  const PAGANTE_BASE = { id: 'p', nome: 'P', cognome: 'X', classe_sezione: null, stato: 'iscritto', scuola_id: 's1' }

  it('42703 sui paganti: riprova senza gender e archiviato_il', async () => {
    const { client, chiamate } = copione([
      { data: [BAMBINO], error: null },
      { data: null, error: { code: '42703', message: 'column alunni.gender does not exist' } },
      { data: [PAGANTE_BASE], error: null },
    ])
    const e = await caricaLegamiRetta(client, { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })
    expect(e.ok && e.legami[0].pagante).toEqual({ id: 'p', nome: 'P', cognome: 'X', sesso: null, classe_sezione: null, iscritto: true, scuola_id: 's1' })
    expect(chiamate[1].select).toContain('gender')
    expect(chiamate[2].select).not.toContain('gender')
    expect(chiamate[2].select).not.toContain('archiviato_il')
    // Le due letture dei paganti restano ristrette per id E per sede.
    for (const c of [chiamate[1], chiamate[2]]) {
      expect(c.filtri).toContainEqual(['in', 'id', ['p']])
      expect(c.filtri).toContainEqual(['in', 'scuola_id', ['s1']])
    }
  })

  it('altro errore sui paganti: ok=false e log error', async () => {
    const { client } = copione([
      { data: [BAMBINO], error: null },
      { data: null, error: { code: '57014', message: 'timeout' } },
    ])
    expect(await caricaLegamiRetta(client, { sediBambini: ['s1'], sediPaganti: ['s1'], operazione: OP })).toEqual({ ok: false })
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ esito: 'legami-paganti-non-letti' }), expect.anything())
  })

  it('la prima query filtra iscritti, sedi e legame valorizzato', async () => {
    const { client, chiamate } = copione([{ data: [], error: null }])
    await caricaLegamiRetta(client, { sediBambini: ['s1', 's2'], sediPaganti: ['s1'], operazione: OP })
    expect(chiamate[0].filtri).toEqual(expect.arrayContaining([
      ['eq', 'stato', 'iscritto'], ['in', 'scuola_id', ['s1', 's2']], ['not', 'retta_a_carico_di', 'is', null],
    ]))
    expect(chiamate).toHaveLength(1)
  })
})
```

- [ ] **Step 2: guardalo fallire**

Run: `npx vitest run __tests__/pagamenti/rette-a-carico-server.test.ts 2>&1 | tail -15`
Expected: FAIL — modulo non trovato.

- [ ] **Step 3: scrivi il loader**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { sessoDa, type LegameRetta } from './rette-a-carico'

/**
 * ─── CHI PAGA LA RETTA DI CHI, LETTO UNA VOLTA PER DUE CONSUMATORI ───────────────
 *
 * La route del cruscotto (`/api/pagamenti/rette-a-carico`) e l'export dello scadenzario
 * leggono i legami da QUI: se le due strade leggessero in modo diverso, lo schermo e
 * l'Excel direbbero cose diverse sullo stesso bambino.
 *
 * DUE query semplici e non un embed della self-FK: la sintassi di PostgREST per una FK
 * verso la stessa tabella è fragile, e il client finto dei test non costruisce join —
 * con due query i filtri li verifica davvero.
 *
 * `sediPaganti` sono le sedi a cui l'utente ha ACCESSO (non solo quelle selezionate):
 * un pagante in un'altra sede accessibile si vede, e accende l'avviso «altra sede»; uno
 * in una sede non accessibile non si rivela — il legame si scarta, contato in un `warn`.
 */

export interface LegameRettaCompleto extends LegameRetta {
  /** Il bambino a carico: serve all'export, NON esce dalla route del cruscotto. */
  alunno: { nome: string; cognome: string; classe_sezione: string | null; section_id: string | null }
}

export type EsitoLegami = { ok: true; legami: LegameRettaCompleto[] } | { ok: false }

interface OpzioniLegami {
  /** Le sedi dei bambini a carico (il perimetro della schermata o dell'export). */
  sediBambini: string[]
  /** Le sedi in cui si può leggere il pagante: quelle accessibili all'utente. */
  sediPaganti: string[]
  /** L'operazione che chiama, per i log (`pagamenti/rette-a-carico:GET`, `pagamenti/export:GET`). */
  operazione: string
}

interface RigaBambino {
  id: string
  nome: string | null
  cognome: string | null
  classe_sezione: string | null
  section_id: string | null
  scuola_id: string | null
  retta_a_carico_di: string | null
}

interface RigaPagante {
  id: string
  nome: string | null
  cognome: string | null
  gender?: string | null
  classe_sezione: string | null
  stato: string | null
  archiviato_il?: string | null
  scuola_id: string | null
}

const COLONNE_BAMBINO = 'id, nome, cognome, classe_sezione, section_id, scuola_id, retta_a_carico_di'
const COLONNE_PAGANTE = 'id, nome, cognome, gender, classe_sezione, stato, archiviato_il, scuola_id'
/** Ripiego sul DB non migrato della CI: senza sesso («A carico di …») e senza archiviazione. */
const COLONNE_PAGANTE_BASE = 'id, nome, cognome, classe_sezione, stato, scuola_id'

const codiceDi = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

export async function caricaLegamiRetta(
  supabase: SupabaseClient,
  { sediBambini, sediPaganti, operazione }: OpzioniLegami,
): Promise<EsitoLegami> {
  if (sediBambini.length === 0) return { ok: true, legami: [] }

  const bambini = await supabase
    .from('alunni')
    .select(COLONNE_BAMBINO)
    .eq('stato', STATO_ISCRITTO)
    .in('scuola_id', sediBambini)
    .not('retta_a_carico_di', 'is', null)
  if (bambini.error) {
    if (codiceDi(bambini.error) === '42703') {
      // DB E2E della CI, non migrato: la colonna non c'è, quindi non c'è nessun legame.
      // Non è un guasto — il cruscotto resta quello di prima — e lo si dice a livello info.
      logEvento('pagamento', 'info', {
        operazione, esito: 'legami-colonna-assente',
        msg: 'retta_a_carico_di assente (DB non migrato): nessun legame, i bambini restano «Non generata»',
      }, bambini.error)
      return { ok: true, legami: [] }
    }
    logEvento('pagamento', 'error', { operazione, esito: 'legami-bambini-non-letti' }, bambini.error)
    return { ok: false }
  }

  const righe = (bambini.data ?? []) as unknown as RigaBambino[]
  const idPaganti = [...new Set(righe.map((r) => r.retta_a_carico_di).filter((x): x is string => !!x))]
  if (idPaganti.length === 0) return { ok: true, legami: [] }

  const leggiPaganti = (colonne: string) =>
    supabase.from('alunni').select(colonne).in('id', idPaganti).in('scuola_id', sediPaganti)
  let paganti = sediPaganti.length > 0 ? await leggiPaganti(COLONNE_PAGANTE) : { data: [], error: null }
  if (paganti.error && codiceDi(paganti.error) === '42703') paganti = await leggiPaganti(COLONNE_PAGANTE_BASE)
  if (paganti.error) {
    logEvento('pagamento', 'error', { operazione, esito: 'legami-paganti-non-letti', n: idPaganti.length }, paganti.error)
    return { ok: false }
  }

  const perId = new Map(((paganti.data ?? []) as unknown as RigaPagante[]).map((p) => [p.id, p]))
  const legami: LegameRettaCompleto[] = []
  let scartati = 0
  for (const r of righe) {
    const p = r.retta_a_carico_di ? perId.get(r.retta_a_carico_di) : undefined
    if (!p) {
      scartati++
      continue
    }
    legami.push({
      alunno_id: r.id,
      scuola_id: r.scuola_id ?? null,
      alunno: { nome: r.nome ?? '', cognome: r.cognome ?? '', classe_sezione: r.classe_sezione ?? null, section_id: r.section_id ?? null },
      pagante: {
        id: p.id,
        nome: p.nome ?? '',
        cognome: p.cognome ?? '',
        sesso: sessoDa(p.gender),
        classe_sezione: p.classe_sezione ?? null,
        iscritto: p.stato === STATO_ISCRITTO && !p.archiviato_il,
        scuola_id: p.scuola_id ?? null,
      },
    })
  }
  if (scartati > 0) {
    // Solo il conteggio: mai nomi (AGENTS.md, regola 8).
    logEvento('pagamento', 'warn', {
      operazione, esito: 'legami-pagante-non-leggibile', n: scartati,
      msg: 'pagante fuori dalle sedi accessibili o non più presente: quei bambini restano «Non generata»',
    })
  }
  return { ok: true, legami }
}
```

- [ ] **Step 4: guardalo passare**

Run: `npx vitest run __tests__/pagamenti/rette-a-carico-server.test.ts 2>&1 | tail -6`
Expected: `Test Files  1 passed (1)`. Se il client finto lancia su `.not('retta_a_carico_di', 'is', null)`, leggi il messaggio: il finto dichiara gli operatori che emula (`not(col,op,v)`), non aggirarlo con un altro operatore senza averlo capito.

- [ ] **Step 5: rompi il codice e guarda il test diventare rosso** — togli `.in('scuola_id', sediPaganti)` da `leggiPaganti`: il test «pagante in una sede non accessibile» deve fallire. Rimetti la riga.

- [ ] **Step 6: commit**

```bash
git add src/lib/pagamenti/rette-a-carico-server.ts __tests__/pagamenti/rette-a-carico-server.test.ts
git commit -m "Rette a carico: loader server condiviso (due query, 42703 degradato)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: la route `GET /api/pagamenti/rette-a-carico`

**Files:**
- Create: `src/app/api/pagamenti/rette-a-carico/route.ts`
- Test: `__tests__/api/pagamenti-rette-a-carico.test.ts`

- [ ] **Step 1: scrivi il test che fallisce**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  errori: {} as Record<string, { code: string }>,
  logEvento: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori }) }
})

import { GET } from '@/app/api/pagamenti/rette-a-carico/route'

const req = (qs = '') => new NextRequest(`http://localhost/api/pagamenti/rette-a-carico${qs ? `?${qs}` : ''}`)
const ADMIN_AB = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }

const alunno = (id: string, sede: string, extra: Record<string, unknown> = {}) => ({
  id, nome: `N-${id}`, cognome: `C-${id}`, classe_sezione: `Sez-${id}`, section_id: null,
  scuola_id: sede, stato: 'iscritto', gender: 'M', archiviato_il: null, retta_a_carico_di: null, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.errori = {}
  h.db = {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }, { id: SEDE_C, nome: 'Terza' }],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }, { id: SEDE_C, attiva: true }],
    utenti_scuole: [{ utente_id: 'admin-1', scuola_id: SEDE_A }, { utente_id: 'admin-1', scuola_id: SEDE_B }],
    alunni: [
      alunno('pa', SEDE_A), alunno('fa', SEDE_A, { retta_a_carico_di: 'pa' }),
      alunno('pb', SEDE_B, { gender: 'F' }), alunno('fb', SEDE_B, { retta_a_carico_di: 'pb' }),
      alunno('pc', SEDE_C), alunno('fc', SEDE_C, { retta_a_carico_di: 'pc' }),     // sede non accessibile
      alunno('fr', SEDE_A, { retta_a_carico_di: 'pa', stato: 'ritirato' }),        // non iscritto
    ],
  }
  h.requireStaff.mockResolvedValue({ user: ADMIN_AB })
})

describe('GET /api/pagamenti/rette-a-carico', () => {
  it('i legami delle sedi accessibili, con il solo pagante (niente dati del bambino)', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    const ids = (corpo.data as { alunno_id: string }[]).map((l) => l.alunno_id).sort()
    expect(ids).toEqual(['fa', 'fb'])
    const fb = corpo.data.find((l: { alunno_id: string }) => l.alunno_id === 'fb')
    expect(fb).toEqual({
      alunno_id: 'fb', scuola_id: SEDE_B,
      pagante: { id: 'pb', nome: 'N-pb', cognome: 'C-pb', sesso: 'F', classe_sezione: 'Sez-pb', iscritto: true, scuola_id: SEDE_B },
    })
    expect(JSON.stringify(corpo)).not.toContain('N-fb')
  })

  it('scuola_id restringe a quella sede', async () => {
    const corpo = await (await GET(req(`scuola_id=${SEDE_A}`))).json()
    expect(corpo.data.map((l: { alunno_id: string }) => l.alunno_id)).toEqual(['fa'])
  })

  it('scuola_id di una sede non accessibile: 403, mai «nessun legame»', async () => {
    const res = await GET(req(`scuola_id=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  it('scuola_id non uuid: 400', async () => {
    expect((await GET(req('scuola_id=abc'))).status).toBe(400)
  })

  it('senza staff: la risposta del gate, tale e quale', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await GET(req())).status).toBe(401)
  })

  it('DB non migrato (42703): 200 con zero legami', async () => {
    h.errori = { 'alunni:select': { code: '42703' } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
  })

  it('guasto di lettura: 500 con LETTURA_FALLITA, e il log dice perché', async () => {
    h.errori = { 'alunni:select': { code: '57014' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ operazione: 'pagamenti/rette-a-carico:GET', esito: 'legami-bambini-non-letti' }), expect.anything())
  })
})
```

- [ ] **Step 2: guardalo fallire**

Run: `npx vitest run __tests__/api/pagamenti-rette-a-carico.test.ts 2>&1 | tail -15`
Expected: FAIL — route non trovata.

- [ ] **Step 3: scrivi la route**

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { requireStaff } from '@/lib/auth/require-staff'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveScuoleAttive, restringiSedi, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { caricaLegamiRetta } from '@/lib/pagamenti/rette-a-carico-server'
import type { LegameRetta } from '@/lib/pagamenti/rette-a-carico'

/**
 * GET /api/pagamenti/rette-a-carico — chi paga la retta di chi, per la vista Rette.
 *
 * Il bambino con `retta_a_carico_di` non riceve la retta (la paga un fratello), e il
 * cruscotto lo mostrava «Non generata». Questa GET gli dà il nome di chi paga. Lo stato
 * della retta del pagante NON viaggia qui: il cruscotto lo prende dalla stessa mappa che
 * disegna la riga del pagante, così il badge non può divergere da quella riga.
 *
 * Proiezione minima: del bambino esce solo l'uuid (il cruscotto ha già il resto).
 */
const OPERAZIONE = 'pagamenti/rette-a-carico:GET'

const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())
const getQuerySchema = z.object({
  scuola_id: zUuidQueryOpzionale,
  /** Lo manda il cruscotto su tutte le sue GET; qui non serve a niente. */
  userId: z.string().optional(),
})

export const GET = withRoute(OPERAZIONE, async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const attive = await resolveScuoleAttive(request, supabase, user)
    const sedi = restringiSedi(attive, q.data.scuola_id)
    if (!sedi) return rifiutoSede('SEDE_NON_ACCESSIBILE')

    const esito = await caricaLegamiRetta(supabase, {
      sediBambini: sedi,
      sediPaganti: await scuoleDiUtente(supabase, user),
      operazione: OPERAZIONE,
    })
    if (!esito.ok) {
      return NextResponse.json(
        { error: 'Non è stato possibile leggere chi paga la retta per un fratello.', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      )
    }
    const data: LegameRetta[] = esito.legami.map(({ alunno_id, scuola_id, pagante }) => ({ alunno_id, scuola_id, pagante }))
    // Il conteggio, senza persistere: la GET parte a ogni apertura della Contabilità.
    logEvento('pagamento', 'info', { operazione: OPERAZIONE, esito: 'letti', n: data.length, sedi: sedi.length }, undefined, { persisti: false })
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
```

- [ ] **Step 4: guardalo passare, con i lock delle route**

Run: `npx vitest run __tests__/api/pagamenti-rette-a-carico.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts 2>&1 | tail -8`
Expected: `Test Files  5 passed (5)`. Se un lock chiede di registrare la route (allowlist o fotografia), leggi il suo messaggio e fai quello che chiede — non abbassare una soglia.

- [ ] **Step 5: commit**

```bash
git add src/app/api/pagamenti/rette-a-carico/route.ts __tests__/api/pagamenti-rette-a-carico.test.ts
git commit -m "Rette a carico: GET /api/pagamenti/rette-a-carico per il cruscotto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `BadgeRettaACarico` e l'avviso nella card mobile

**Files:**
- Create: `src/components/features/admin/pagamenti/BadgeRettaACarico.tsx`
- Modify: `src/components/features/admin/pagamenti/PagamentoCardMobile.tsx:53-66` (Props), `:69` (firma), `:91` (dopo la descrizione)

(I test di questo componente stanno nel Task 6, dove lo si vede nel cruscotto vero.)

- [ ] **Step 1: scrivi il componente**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { STATI_PAGAMENTO as STATI } from './stati';
import { anomaliaPagante, componiBadge, valoriPrefisso, type LegameRetta } from '@/lib/pagamenti/rette-a-carico';

interface Props {
    legame: LegameRetta;
    /** La retta del PAGANTE per il mese scelto — la stessa che disegna la sua riga — se c'è. */
    rettaPagante?: { stato: string } | null;
    /**
     * I pagamenti della sede del pagante sono caricati: allora «nessuna retta» vuol dire
     * «Non generata» (D4). Se non lo sono, lo stato NON si conosce e non si inventa.
     */
    sedeCaricata: boolean;
    /** Il bambino ha anche una retta PROPRIA del mese (D9): solo l'avviso «da verificare». */
    conRettaPropria?: boolean;
}

/**
 * «Paga il fratello Mario Rossi (Sez. C) · Da pagare» al posto di «Non generata» (D1–D5),
 * del colore della retta del fratello (D3). Più, se serve, l'avviso rosso quando chi paga
 * non è più iscritto o è in un'altra sede (D12). Nessuna azione: si incassa solo dalla
 * riga del fratello (D8).
 */
export function BadgeRettaACarico({ legame, rettaPagante, sedeCaricata, conRettaPropria = false }: Props) {
    const t = useTranslations('adminContabilita');
    const valori = valoriPrefisso(legame.pagante);
    const anomalia = anomaliaPagante(legame);
    const avvisoAnomalia = anomalia ? (
        <Badge tone="error" data-testid="retta-a-carico-anomalia">
            {anomalia === 'non-iscritto' ? t('dashPaganteNonIscritto') : t('dashPaganteAltraSede')}
        </Badge>
    ) : null;

    if (conRettaPropria) {
        return (
            <>
                <Badge tone="warn" data-testid="retta-a-carico-verifica">{t('dashACaricoVerifica', valori)}</Badge>
                {avvisoAnomalia}
            </>
        );
    }

    const st = rettaPagante ? (STATI[rettaPagante.stato] ?? STATI.da_pagare) : null;
    const stato = st ? st.label : sedeCaricata ? t('dashNonGenerata') : null;
    return (
        <>
            <Badge tone={st?.tone ?? 'neutral'} data-testid="retta-a-carico">
                {componiBadge(t('dashACarico', valori), stato)}
            </Badge>
            {avvisoAnomalia}
        </>
    );
}
```

- [ ] **Step 2: la prop `avviso` nella card mobile.** In `PagamentoCardMobile.tsx` aggiungi in `Props` (dopo `mostraSede?: boolean;`):

```tsx
    /** Un avviso sotto la descrizione (es. retta generata a un bambino a carico di un fratello, D9). */
    avviso?: React.ReactNode;
```

cambia la firma:

```tsx
export function PagamentoCardMobile({ pagamento, alunnoLabel, sezioneLabel, sospeso, mostraSede = false, avviso, onIncassa, onApri }: Props) {
```

e subito dopo `<p className="mt-1 truncate font-maven text-xs text-kidville-ink">{pagamento.descrizione}</p>`:

```tsx
            {avviso && <div className="mt-1 flex flex-wrap gap-1">{avviso}</div>}
```

Se `React` non è in scope per il tipo, usa `import type { ReactNode } from 'react';` in testa e `avviso?: ReactNode;`.

- [ ] **Step 3: controlla i tipi**

Run: `npx tsc --noEmit -p . 2>&1 | tail -5`
Expected: nessun errore.

- [ ] **Step 4: commit**

```bash
git add src/components/features/admin/pagamenti/BadgeRettaACarico.tsx src/components/features/admin/pagamenti/PagamentoCardMobile.tsx
git commit -m "Rette a carico: badge «Paga il fratello …» e avviso nella card mobile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: il cruscotto

**Files:**
- Modify: `src/components/features/admin/pagamenti/PaymentsDashboard.tsx`
- Test: `__tests__/components/PaymentsDashboard-retta-a-carico.test.tsx`

- [ ] **Step 1: scrivi il test che fallisce** (`__tests__/components/PaymentsDashboard-retta-a-carico.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

/**
 * «Paga il fratello …» al posto di «Non generata» (spec 2026-09-28, D1–D13).
 * ⚠️ `t` STABILE, come in `PaymentsDashboard-multisede.test.tsx`: `load` dipende da `t`.
 */
vi.mock('next-intl', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { IntlMessageFormat } = await import('intl-messageformat');
    const cartella = join(process.cwd(), 'messages/it');
    const cataloghi: Record<string, Record<string, unknown>> = {};
    for (const file of readdirSync(cartella)) {
        if (!file.endsWith('.json')) continue;
        cataloghi[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(cartella, file), 'utf8'));
    }
    const resolve = (ns: string | undefined, key: string): string => {
        const v = ns ? cataloghi[ns]?.[key] : undefined;
        return typeof v === 'string' ? v : ns ? `${ns}.${key}` : key;
    };
    const perNamespace = new Map<string, unknown>();
    const useTranslations = (ns?: string) => {
        const chiave = ns ?? '';
        const gia = perNamespace.get(chiave);
        if (gia) return gia;
        const t = (key: string, valori?: Record<string, unknown>) =>
            valori === undefined ? resolve(ns, key) : String(new IntlMessageFormat(resolve(ns, key), 'it').format(valori));
        const stabile = Object.assign(t, { rich: (k: string) => resolve(ns, k), markup: (k: string) => resolve(ns, k), raw: (k: string) => resolve(ns, k), has: () => true });
        perNamespace.set(chiave, stabile);
        return stabile;
    };
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    };
});
vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/admin-identity')>()),
    useRuoloCockpit: () => 'admin',
}));
const sediCtx = vi.hoisted(() => ({
    valore: { sedi: [{ id: 's1', nome: 'Kidville Uno' }], effettive: ['s1'], selezionate: [] as string[], sedeCorrente: 's1' as string | null, reFetchKey: 's1' },
}));
vi.mock('@/lib/context/sede-context', async (orig) => ({
    ...(await orig<typeof import('@/lib/context/sede-context')>()),
    useSediAttive: () => sediCtx.valore,
}));
const logSpia = vi.hoisted(() => ({ chiamate: [] as { livello: string; messaggio: string }[] }));
vi.mock('@/lib/logging/client', async (orig) => ({
    ...(await orig<typeof import('@/lib/logging/client')>()),
    logClient: (e: { livello: string; messaggio: string }) => { logSpia.chiamate.push(e); },
}));
vi.mock('@/components/features/admin/pagamenti/FatturaButton', () => ({
    FatturaButton: () => <span data-testid="fattura-button" />,
}));

import { PaymentsDashboard } from '@/components/features/admin/pagamenti/PaymentsDashboard';

const GIORNO_FISSO = '2026-10-10T10:00:00';
const CATEGORIE = { success: true, data: [{ id: 'c-retta', nome: 'Retta', slug: 'retta', scuola_id: null }] };

type Bimbo = { id: string; nome: string; cognome: string; section_id: string; classe_sezione: string };
const B = (id: string, nome: string, cognome: string, classe: string): Bimbo =>
    ({ id, nome, cognome, section_id: `sez-${classe}`, classe_sezione: classe });

const MARIO = B('a-mario', 'Mario', 'Rossi', 'Sez. C');   // paga per Luca e Teo
const LUCA = B('a-luca', 'Luca', 'Rossi', 'Sez. A');
const ANNA = B('a-anna', 'Anna', 'Bianchi', 'Sez. B');    // paga per Sara (pagato)
const SARA = B('a-sara', 'Sara', 'Bianchi', 'Sez. A');
const PINO = B('a-pino', 'Pino', 'Verdi', 'Sez. D');      // sesso assente, scaduto
const ELIO = B('a-elio', 'Elio', 'Verdi', 'Sez. A');
const NINO = B('a-nino', 'Nino', 'Neri', 'Sez. E');       // nessuna retta a ottobre
const DORA = B('a-dora', 'Dora', 'Neri', 'Sez. A');
const TEO = B('a-teo', 'Teo', 'Rossi', 'Sez. A');         // a carico di Mario MA con retta propria (D9)
const PIA = B('a-pia', 'Pia', 'Gialli', 'Sez. A');        // nessun legame, nessuna retta
const RITA = B('a-rita', 'Rita', 'Blu', 'Sez. A');        // pagante non più iscritto
const UGO = B('a-ugo', 'Ugo', 'Viola', 'Sez. A');         // pagante in un'altra sede

const STUDENTS = [MARIO, LUCA, ANNA, SARA, PINO, ELIO, NINO, DORA, TEO, PIA, RITA, UGO]
    .map((b) => ({ ...b, scuola_id: 's1', stato: 'iscritto' }));

function retta(id: string, b: Bimbo, extra: Record<string, unknown>) {
    return {
        id, alunno_id: b.id, descrizione: 'Retta Ottobre', importo: 250, importo_pagato: 0, stato: 'da_pagare',
        tipo: 'singolo', fattura_stato: 'non_richiesta', scadenza: '2026-10-20', categoria_id: 'c-retta',
        periodo_competenza: '2026-10-01', coda_stato: null, scuola_id: 's1', scuola_nome: 'Kidville Uno',
        alunni: { nome: b.nome, cognome: b.cognome, section_id: b.section_id, classe_sezione: b.classe_sezione, sospeso: false },
        ...extra,
    };
}
const PAGAMENTI = {
    success: true,
    data: [
        retta('p-mario', MARIO, {}),
        retta('p-anna', ANNA, { stato: 'pagato', importo_pagato: 250 }),
        retta('p-pino', PINO, { stato: 'scaduto', scadenza: '2026-10-05' }),
        retta('p-teo', TEO, { importo: 100 }),
    ],
};

const pag = (b: Bimbo, sesso: 'M' | 'F' | null, extra: Record<string, unknown> = {}) =>
    ({ id: b.id, nome: b.nome, cognome: b.cognome, sesso, classe_sezione: b.classe_sezione, iscritto: true, scuola_id: 's1', ...extra });
const LEGAMI = {
    success: true,
    data: [
        { alunno_id: LUCA.id, scuola_id: 's1', pagante: pag(MARIO, 'M') },
        { alunno_id: SARA.id, scuola_id: 's1', pagante: pag(ANNA, 'F') },
        { alunno_id: ELIO.id, scuola_id: 's1', pagante: pag(PINO, null) },
        { alunno_id: DORA.id, scuola_id: 's1', pagante: pag(NINO, 'M') },
        { alunno_id: TEO.id, scuola_id: 's1', pagante: pag(MARIO, 'M') },
        { alunno_id: RITA.id, scuola_id: 's1', pagante: { id: 'a-ex', nome: 'Ex', cognome: 'Blu', sesso: 'M', classe_sezione: 'Sez. F', iscritto: false, scuola_id: 's1' } },
        { alunno_id: UGO.id, scuola_id: 's1', pagante: { id: 'a-lontano', nome: 'Leo', cognome: 'Viola', sesso: 'M', classe_sezione: 'Sez. G', iscritto: true, scuola_id: 's2' } },
    ],
};

let fetchFinta: ReturnType<typeof vi.fn>;
function stub(opzioni: { legamiStatus?: number } = {}) {
    fetchFinta = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.startsWith('/api/pagamenti/rette-a-carico')) {
            const s = opzioni.legamiStatus ?? 200;
            return { ok: s === 200, status: s, json: async () => (s === 200 ? LEGAMI : { error: 'guasto', codice: 'LETTURA_FALLITA' }) };
        }
        const body = u.startsWith('/api/pagamenti?') ? PAGAMENTI
            : u.startsWith('/api/admin/students') ? STUDENTS
                : u.includes('/settings/categorie') ? CATEGORIE
                    : u.includes('/settings/aruba') ? { success: true, data: { abilitato: true } }
                        : { success: true, data: [] };
        return { ok: true, status: 200, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchFinta);
}

/** La riga della TABELLA che contiene quel testo (la card mobile è un `div` senza ruolo). */
function riga(testo: string): HTMLElement {
    const r = screen.getAllByRole('row').find((x) => x.textContent?.includes(testo));
    if (!r) throw new Error(`nessuna riga contiene «${testo}»`);
    return r;
}
async function apri() {
    render(<PaymentsDashboard userId="u1" scuolaId="s1" />);
    await waitFor(() => expect(riga('Luca Rossi')).toBeInTheDocument());
}

beforeEach(() => {
    logSpia.chiamate.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(GIORNO_FISSO));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('D1–D5 — il badge al posto di «Non generata»', () => {
    it('fratello: testo, classe, stato del fratello e tono neutro (da pagare)', async () => {
        stub(); await apri();
        const b = await within(riga('Luca Rossi')).findByTestId('retta-a-carico');
        expect(b).toHaveTextContent('Paga il fratello Mario Rossi (Sez. C) · Da pagare');
        expect(b).toHaveClass('bg-kidville-neutral-soft');
        expect(within(riga('Luca Rossi')).queryByText('Non generata')).toBeNull();
    });
    it('sorella, retta pagata: verde', async () => {
        stub(); await apri();
        const b = within(riga('Sara Bianchi')).getByTestId('retta-a-carico');
        expect(b).toHaveTextContent('Paga la sorella Anna Bianchi (Sez. B) · Pagato');
        expect(b).toHaveClass('bg-kidville-success-soft');
    });
    it('sesso assente: «A carico di»; retta scaduta: rosso', async () => {
        stub(); await apri();
        const b = within(riga('Elio Verdi')).getByTestId('retta-a-carico');
        expect(b).toHaveTextContent('A carico di Pino Verdi (Sez. D) · Scaduto');
        expect(b).toHaveClass('bg-kidville-error-soft');
    });
    it('D4 — il fratello non ha la retta del mese: «· Non generata», neutro', async () => {
        stub(); await apri();
        const b = within(riga('Dora Neri')).getByTestId('retta-a-carico');
        expect(b).toHaveTextContent('Paga il fratello Nino Neri (Sez. E) · Non generata');
        expect(b).toHaveClass('bg-kidville-neutral-soft');
    });
    it('il bambino senza legame resta «Non generata»', async () => {
        stub(); await apri();
        expect(within(riga('Pia Gialli')).getByText('Non generata')).toBeInTheDocument();
        expect(within(riga('Pia Gialli')).queryByTestId('retta-a-carico')).toBeNull();
    });
    it('anche nella card mobile (D13)', async () => {
        stub(); await apri();
        const testi = screen.getAllByTestId('retta-a-carico').map((e) => e.textContent);
        expect(testi.filter((x) => x === 'Paga il fratello Mario Rossi (Sez. C) · Da pagare')).toHaveLength(2);
    });
});

describe('D8 — nessuna azione di incasso sulla riga a carico', () => {
    it('niente Incassa, niente dettaglio, niente modifica', async () => {
        stub(); await apri();
        const r = riga('Luca Rossi');
        expect(within(r).queryByRole('button', { name: 'Incassa' })).toBeNull();
        expect(within(r).queryByTitle('Dettagli')).toBeNull();
        expect(within(r).queryByTitle('Modifica')).toBeNull();
    });
});

describe('D9 — retta generata a un bambino a carico', () => {
    it('la retta normale resta, più l’avviso arancio (tabella e card)', async () => {
        stub(); await apri();
        const r = riga('Teo Rossi');
        expect(within(r).getByRole('button', { name: 'Incassa' })).toBeInTheDocument();
        const avviso = within(r).getByTestId('retta-a-carico-verifica');
        expect(avviso).toHaveTextContent('A carico del fratello Mario Rossi (Sez. C): retta da verificare');
        expect(avviso).toHaveClass('bg-kidville-warn-soft');
        expect(screen.getAllByTestId('retta-a-carico-verifica')).toHaveLength(2);
    });
});

describe('D12 — pagante anomalo', () => {
    it('non più iscritto: badge + avviso rosso', async () => {
        stub(); await apri();
        const r = riga('Rita Blu');
        expect(within(r).getByTestId('retta-a-carico')).toHaveTextContent('Paga il fratello Ex Blu (Sez. F) · Non generata');
        expect(within(r).getByTestId('retta-a-carico-anomalia')).toHaveTextContent('Chi paga non è più iscritto: retta da rivedere');
    });
    it('in un’altra sede non caricata: niente stato inventato, avviso rosso', async () => {
        stub(); await apri();
        const r = riga('Ugo Viola');
        expect(within(r).getByTestId('retta-a-carico')).toHaveTextContent(/^Paga il fratello Leo Viola \(Sez\. G\)$/);
        expect(within(r).getByTestId('retta-a-carico-anomalia')).toHaveTextContent('Chi paga è in un’altra sede: retta da rivedere');
    });
});

describe('D6 — «Genera mancanti» non conta i bambini a carico', () => {
    it('restano solo Pia e Nino', async () => {
        stub(); await apri();
        expect(await screen.findByTestId('cta-genera-mancanti-frase')).toHaveTextContent('2 alunni senza retta generata');
    });
});

describe('D10 — filtro Morosi', () => {
    it('compare il bambino il cui pagante è moroso; sparisce quello del pagante in regola', async () => {
        stub(); await apri();
        fireEvent.click(screen.getByRole('button', { name: /Morosi/ }));
        await waitFor(() => expect(riga('Elio Verdi')).toBeInTheDocument());
        expect(riga('Pino Verdi')).toBeInTheDocument();
        expect(screen.getAllByRole('row').some((r) => r.textContent?.includes('Luca Rossi'))).toBe(false);
        expect(screen.getAllByRole('row').some((r) => r.textContent?.includes('Sara Bianchi'))).toBe(false);
    });
});

describe('D11 — ricerca per nome del pagante', () => {
    it('«Anna» trova anche Sara', async () => {
        stub(); await apri();
        fireEvent.change(screen.getByPlaceholderText('Cerca alunno o sezione…'), { target: { value: 'Anna' } });
        await waitFor(() => expect(screen.getAllByRole('row').some((r) => r.textContent?.includes('Luca Rossi'))).toBe(false));
        expect(riga('Sara Bianchi')).toBeInTheDocument();
        expect(riga('Anna Bianchi')).toBeInTheDocument();
    });
});

describe('la GET dei legami', () => {
    it('parte con la sede dichiarata', async () => {
        stub(); await apri();
        const u = fetchFinta.mock.calls.map(([x]) => String(x)).find((x) => x.startsWith('/api/pagamenti/rette-a-carico'));
        expect(u).toBe('/api/pagamenti/rette-a-carico?userId=u1&scuola_id=s1');
    });
    it('guasto: banner d’errore, e i bambini tornano «Non generata» (mai un badge inventato)', async () => {
        stub({ legamiStatus: 500 }); await apri();
        expect(await screen.findByTestId('errore-legami')).toHaveTextContent('Impossibile sapere chi paga la retta per un fratello');
        expect(within(riga('Luca Rossi')).getByText('Non generata')).toBeInTheDocument();
        expect(screen.queryByTestId('retta-a-carico')).toBeNull();
        expect(logSpia.chiamate.some((c) => c.livello === 'error' && c.messaggio.startsWith('scadenzario-legami'))).toBe(true);
    });
});
```

- [ ] **Step 2: guardalo fallire**

Run: `npx vitest run __tests__/components/PaymentsDashboard-retta-a-carico.test.tsx 2>&1 | tail -20`
Expected: FAIL (niente `retta-a-carico`, «Non generata» ovunque).

- [ ] **Step 3: gli import** in `PaymentsDashboard.tsx`, dopo `import { FiltroClassiContabilita } from './FiltroClassiContabilita';`:

```tsx
import { BadgeRettaACarico } from './BadgeRettaACarico';
import { indicizzaLegami, legamiDaRisposta, nomePagante, type LegameRetta } from '@/lib/pagamenti/rette-a-carico';
```

- [ ] **Step 4: lo stato**, dopo `const [erroreAlunni, setErroreAlunni] = useState(false);`:

```tsx
    /**
     * Chi paga la retta di chi (`alunni.retta_a_carico_di`), per alunno A CARICO. Vuota finché
     * non arriva, e vuota se la GET fallisce: allora quei bambini restano «Non generata» come
     * prima, e il banner `errore-legami` lo dice.
     */
    const [legami, setLegami] = useState<Map<string, LegameRetta>>(() => new Map());
    const [erroreLegami, setErroreLegami] = useState(false);
```

- [ ] **Step 5: la terza GET in `load`.** Sostituisci il blocco `const [pagRes, alRes] = await Promise.all([ … ]);` con:

```tsx
            const [pagRes, alRes, legRes] = await Promise.all([
                leggiJson<{ success?: boolean; data?: Pagamento[]; error?: string }>(`/api/pagamenti?userId=${userId}${sedeQs}`, userId, 'scadenzario-pagamenti'),
                leggiJson<Alunno[] | { data?: Alunno[] }>(`/api/admin/students?stato=iscritto${sedeQs}&limit=${LIMITE_ELENCO_ALUNNI}`, userId, 'scadenzario-alunni'),
                leggiJson<{ success?: boolean; data?: unknown }>(`/api/pagamenti/rette-a-carico?userId=${userId}${sedeQs}`, userId, 'scadenzario-legami'),
            ]);
```

e subito prima di `} finally {` di `load` aggiungi:

```tsx
            // I legami: un guasto NON è «nessun fratello paga». Si svuotano (niente badge di
            // prima spacciati per attuali) e lo si dice a schermo; il rifiuto l'ha loggato `leggiJson`.
            // (`listaLegami` e non `lista`: nel blocco degli alunni qui sopra c'è già una `lista`.)
            const listaLegami = legRes.ok && legRes.corpo?.success ? legamiDaRisposta(legRes.corpo.data) : null;
            if (listaLegami === null) {
                if (legRes.ok) logClient({ livello: 'error', evento: 'fetch', messaggio: 'scadenzario-legami-forma-inattesa', route: '/admin/pagamenti' });
                setLegami(new Map());
                setErroreLegami(true);
            } else {
                setLegami(indicizzaLegami(listaLegami));
                setErroreLegami(false);
            }
```

- [ ] **Step 6: ricerca e Morosi (D10, D11).** Sostituisci il corpo di `alunniFiltrati` con:

```tsx
    const alunniFiltrati = useMemo(() => {
        const q = search.trim().toLowerCase();
        return filtraPerClassi(alunni, scelteValide, (a) => a.section_id ?? null).filter((a) => {
            const legame = legami.get(a.id);
            if (q) {
                // D11: chi cerca il fratello che paga trova anche il bambino a suo carico.
                const pagante = legame ? nomePagante(legame.pagante) : '';
                const nome = `${a.nome ?? ''} ${a.cognome ?? ''} ${a.classe_sezione ?? ''} ${pagante}`.toLowerCase();
                if (!nome.includes(q)) return false;
            }
            if (isRettaView && onlyMorosi) {
                const p = rettaByAlunno.get(a.id);
                // D10: senza retta propria, conta la retta del fratello che paga.
                const pPagante = !p && legame ? rettaByAlunno.get(legame.pagante.id) : undefined;
                const riferimento = p ?? pPagante;
                if (!riferimento || !isMoroso(riferimento, oggiStr)) return false;
            }
            return true;
        });
    }, [alunni, scelteValide, search, isRettaView, onlyMorosi, rettaByAlunno, oggiStr, legami]);
```

- [ ] **Step 7: i mancanti (D6).** In `mancantiPerSede` sostituisci `if (rettaByAlunno.has(a.id)) continue;` con:

```tsx
            // D6: chi ha la retta a carico di un fratello non è «mancante» — la generazione
            // lo salta, e contarlo teneva il numero sopra zero per sempre.
            if (rettaByAlunno.has(a.id) || legami.has(a.id)) continue;
```

e aggiungi `legami` alle dipendenze: `}, [isRettaView, alunni, rettaByAlunno, sedeUnica, legami]);`.

- [ ] **Step 8: il banner d'errore**, subito dopo il blocco `{erroreAlunni && ( … )}`:

```tsx
            {/* Legami non caricati: i bambini a carico di un fratello tornano «Non generata», e
                questo NON deve sembrare vero. */}
            {erroreLegami && (
                <div data-testid="errore-legami" role="alert" className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="flex-1 font-maven text-sm font-bold">{t('dashMsErrLegami')}</span>
                    <button onClick={() => { setLoading(true); load(); }}
                        className="rounded-pill border border-kidville-error/40 bg-kidville-white px-3 py-1 font-maven text-xs font-bold text-kidville-error transition-colors hover:bg-kidville-error-soft">
                        {t('dashRiprova')}
                    </button>
                </div>
            )}
```

- [ ] **Step 9: la tabella (desktop).** Nel `alunniFiltrati.map((a) => { … })` della tabella Rette, dopo `const moroso = …;` aggiungi:

```tsx
                                const legame = legami.get(a.id);
```

e sostituisci il contenuto dello `<span className="inline-flex flex-wrap items-center gap-1">` della cella Stato con:

```tsx
                                                {st
                                                    ? <Badge tone={st.tone}>{st.label}</Badge>
                                                    : legame
                                                        ? <BadgeRettaACarico legame={legame} rettaPagante={rettaByAlunno.get(legame.pagante.id)} sedeCaricata={!!legame.pagante.scuola_id && sediVisibili.includes(legame.pagante.scuola_id)} />
                                                        : <Badge tone="neutral">{t('dashNonGenerata')}</Badge>}
                                                {/* D9: retta propria E legame col fratello — si mostra, e si segnala. */}
                                                {p && legame && <BadgeRettaACarico legame={legame} sedeCaricata conRettaPropria />}
                                                {p && moroso && Number(p.importo_pagato) > 0 && (
                                                    <Badge tone="warn">{t('dashAcconto')} {formatEuro(p.importo_pagato)}</Badge>
                                                )}
                                                {p && <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} codaStato={p.coda_stato} />}
```

(Le azioni restano come sono: senza `p` non c'è Incassa, dettaglio né modifica — D8 è già vero, e il test lo blocca.)

- [ ] **Step 10: le card (mobile).** Nel `alunniFiltrati.map` delle card, sostituisci il ramo `if (!p) { return ( … ); }` con:

```tsx
                        const legame = legami.get(a.id);
                        if (!p) {
                            return (
                                <div key={a.id} className="flex items-center justify-between gap-2 rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
                                    <div className="min-w-0">
                                        <p className="font-maven text-sm font-bold text-kidville-green">{a.nome} {a.cognome}</p>
                                        {mostraSede && <BadgeSede nome={nomeSede(a.scuola_id)} className="mt-1" />}
                                    </div>
                                    {legame ? (
                                        <span className="flex flex-wrap justify-end gap-1">
                                            <BadgeRettaACarico legame={legame} rettaPagante={rettaByAlunno.get(legame.pagante.id)} sedeCaricata={!!legame.pagante.scuola_id && sediVisibili.includes(legame.pagante.scuola_id)} />
                                        </span>
                                    ) : (
                                        <Badge tone="neutral">{t('dashNonGenerata')}</Badge>
                                    )}
                                </div>
                            );
                        }
```

e nella `<PagamentoCardMobile …>` di quella lista aggiungi la prop:

```tsx
                                avviso={legame ? <BadgeRettaACarico legame={legame} sedeCaricata conRettaPropria /> : undefined}
```

- [ ] **Step 11: guardalo passare, insieme ai test esistenti del cruscotto**

Run: `npx vitest run __tests__/components/PaymentsDashboard-retta-a-carico.test.tsx __tests__/components/PaymentsDashboard-multisede.test.tsx __tests__/components/PaymentsDashboard-coda.test.tsx __tests__/components/importi-euro-italiani.test.tsx __tests__/components/pagamenti-documenti-nativi.test.tsx __tests__/pages/admin-pagamenti-piu-sedi.test.tsx 2>&1 | tail -10`
Expected: `Test Files  6 passed (6)`. Se un test esistente conta le GET, la terza GET è nuova per costruzione: aggiorna il conteggio **scrivendo accanto perché** è cambiato.

- [ ] **Step 12: rompi e guarda il rosso** — (a) togli `|| legami.has(a.id)` dai mancanti: il test D6 deve fallire; (b) in `BadgeRettaACarico` metti `tone="neutral"` fisso: i test verde/rosso devono fallire. Rimetti tutto.

- [ ] **Step 13: commit**

```bash
git add src/components/features/admin/pagamenti/PaymentsDashboard.tsx __tests__/components/PaymentsDashboard-retta-a-carico.test.tsx
git commit -m "Contabilità, vista Rette: «Paga il fratello …» al posto di «Non generata»

Il badge prende nome, classe e stato della retta del fratello (e il suo colore);
i bambini a carico escono da «Genera mancanti», entrano nel filtro Morosi e nella
ricerca per nome del pagante; avvisi per la retta generata comunque e per il
pagante uscito o in un'altra sede.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: l'export Excel

**Files:**
- Create: `src/lib/pagamenti/export-rette-a-carico.ts`
- Modify: `src/app/api/pagamenti/export/route.ts` (import; blocco `const righe = …` → fine del ramo scadenzario)
- Test: `__tests__/api/pagamenti-export-rette-a-carico.test.ts`

- [ ] **Step 1: scrivi il test che fallisce**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  errori: {} as Record<string, { code: string }>,
  logEvento: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori }) }
})

import { GET } from '@/app/api/pagamenti/export/route'

const SEZ_A = '10000000-0000-4000-8000-00000000000a'
const SEZ_C = '10000000-0000-4000-8000-00000000000c'
const ADMIN_AB = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }

const alunno = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nome: `N${id}`, cognome: 'Rossi', classe_sezione: 'Sez. C', section_id: SEZ_C, scuola_id: SEDE_A,
  stato: 'iscritto', gender: 'M', archiviato_il: null, retta_a_carico_di: null, ...extra,
})
const RETTA = { nome: 'Retta', slug: 'retta' }
const voce = (id: string, alunnoId: string, periodo: string, extra: Record<string, unknown> = {}) => ({
  id, alunno_id: alunnoId, scuola_id: SEDE_A, descrizione: `Retta ${periodo.slice(0, 7)}`, importo: 250, importo_pagato: 0,
  scadenza: `${periodo.slice(0, 8)}05`, periodo_competenza: periodo, stato: 'da_pagare', tipo: 'singolo',
  fattura_stato: null, categoria_id: 'c-retta', payment_categories: RETTA,
  alunni: { nome: `N${alunnoId}`, cognome: 'Rossi', classe_sezione: 'Sez. C', section_id: SEZ_C, scuola_id: SEDE_A },
  ...extra,
})

async function righe(res: Response) {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Scadenzario)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.errori = {}
  h.db = {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }],
    utenti_scuole: [{ utente_id: 'admin-1', scuola_id: SEDE_A }, { utente_id: 'admin-1', scuola_id: SEDE_B }],
    alunni: [
      alunno('pag'),                                                                            // paga
      alunno('fig', { retta_a_carico_di: 'pag', classe_sezione: 'Sez. A', section_id: SEZ_A }), // a carico
      alunno('teo', { retta_a_carico_di: 'pag', classe_sezione: 'Sez. A', section_id: SEZ_A }), // a carico, ma con retta di ottobre
    ],
    pagamenti: [
      voce('p-set', 'pag', '2026-09-01', { stato: 'pagato', importo_pagato: 250 }),
      voce('p-ott', 'pag', '2026-10-01'),
      voce('t-ott', 'teo', '2026-10-01', { importo: 100 }),
    ],
    registro_modifiche: [],
  }
  h.requireStaff.mockResolvedValue({ user: ADMIN_AB })
})

describe('export scadenzario — righe dei bambini a carico (D14)', () => {
  it('una riga per ogni retta del pagante, a importi zero, con lo stato del pagante', async () => {
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(200)
    const fig = (await righe(res)).filter((r) => r.Alunno === 'Nfig Rossi')
    expect(fig).toEqual([
      expect.objectContaining({ Sede: NOME_SEDE_A, Sezione: 'Sez. A', Categoria: 'Retta', Descrizione: 'Retta 2026-09', Scadenza: '2026-09-05', 'Importo €': 0, 'Pagato €': 0, 'Residuo €': 0, Stato: 'Paga il fratello Npag Rossi (Sez. C) · Pagato' }),
      expect.objectContaining({ Descrizione: 'Retta 2026-10', Scadenza: '2026-10-05', 'Importo €': 0, Stato: 'Paga il fratello Npag Rossi (Sez. C) · Da pagare' }),
    ])
  })

  it('D9: il bambino con la sua retta del mese non riceve la riga in più per quel mese', async () => {
    const tutte = await righe(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario')))
    const teo = tutte.filter((r) => r.Alunno === 'Nteo Rossi')
    expect(teo.map((r) => [r.Descrizione, r['Importo €']])).toEqual([['Retta 2026-09', 0], ['Retta 2026-10', 100]])
  })

  it('le righe restano ordinate per scadenza', async () => {
    const tutte = await righe(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario')))
    const scadenze = tutte.map((r) => String(r.Scadenza))
    expect(scadenze).toEqual([...scadenze].sort())
  })

  it('filtro classi: conta la classe del BAMBINO, anche se il pagante è fuori filtro', async () => {
    const tutte = await righe(await GET(new NextRequest(`http://localhost/api/pagamenti/export?tipo=scadenzario&section_ids=${SEZ_A}`)))
    expect(tutte.some((r) => r.Alunno === 'Npag Rossi')).toBe(false)
    expect(tutte.filter((r) => r.Alunno === 'Nfig Rossi')).toHaveLength(2)
  })

  it('filtro stato: la riga del bambino segue lo stato della retta del pagante', async () => {
    const tutte = await righe(await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario&stato=pagato')))
    expect(tutte.filter((r) => r.Alunno === 'Nfig Rossi').map((r) => r.Descrizione)).toEqual(['Retta 2026-09'])
  })

  it('legami non letti: l’export esce lo stesso, senza righe in più, e il log lo dice', async () => {
    h.errori = { 'alunni:select': { code: '57014' } }
    const res = await GET(new NextRequest('http://localhost/api/pagamenti/export?tipo=scadenzario'))
    expect(res.status).toBe(200)
    expect((await righe(res)).some((r) => r.Alunno === 'Nfig Rossi')).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ operazione: 'pagamenti/export:GET', esito: 'export-senza-righe-a-carico' }))
  })
})
```

- [ ] **Step 2: guardalo fallire**

Run: `npx vitest run __tests__/api/pagamenti-export-rette-a-carico.test.ts 2>&1 | tail -15`
Expected: FAIL (nessuna riga per `Nfig Rossi`). Se fallisce per un'altra ragione (tabella mancante nel finto db: `registro_modifiche`, `audit_*` scritti da `logScrittura`), aggiungi al `db` la tabella che il messaggio nomina e rilancia finché il fallimento è quello atteso.

- [ ] **Step 3: scrivi `src/lib/pagamenti/export-rette-a-carico.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { caricaLegamiRetta } from './rette-a-carico-server'
import { testoPaganteIt } from './rette-a-carico'

/** Una riga del foglio «Scadenzario»: le chiavi SONO le intestazioni delle colonne. */
export interface RigaScadenzario {
  Sede: string
  Alunno: string
  Sezione: string
  Categoria: string
  Descrizione: string
  Scadenza: string
  'Importo €': number
  'Pagato €': number
  'Residuo €': number
  Stato: string
  Fattura: string
}

interface OpzioniExport {
  /** Il perimetro dell'export: la sede dichiarata, o le sedi attive. */
  sediBambini: string[]
  /** Le sedi accessibili all'utente (dove si possono leggere pagante e rette). */
  sediPaganti: string[]
  sectionIds?: string[]
  stato?: string
  nomiSedi: Map<string, string>
  etichettaStato: (stato: string) => string
}

interface RigaRetta {
  alunno_id: string
  descrizione: string
  scadenza: string | null
  periodo_competenza: string | null
  stato: string
  tipo: string | null
  payment_categories: { nome?: string | null; slug?: string | null } | null
}

const OPERAZIONE = 'pagamenti/export:GET'

/**
 * D14 — per ogni retta del fratello che paga, una riga per il bambino a carico: importi a
 * ZERO (i totali dell'Excel non raddoppiano) e, in «Stato», chi paga e come sta la sua
 * retta — la stessa frase del cruscotto.
 *
 * Le rette si leggono con una query A PARTE, ristretta agli uuid dei legami: le righe
 * principali dell'export restano quelle di prima, filtri compresi, e queste non dipendono
 * da quali di quelle sono passate (il filtro classi guarda il BAMBINO, come a schermo).
 *
 * Un guasto qui NON fa fallire l'export: esce senza le righe in più, e lo si logga.
 */
export async function righeRetteACarico(supabase: SupabaseClient, o: OpzioniExport): Promise<RigaScadenzario[]> {
  const esito = await caricaLegamiRetta(supabase, { sediBambini: o.sediBambini, sediPaganti: o.sediPaganti, operazione: OPERAZIONE })
  if (!esito.ok) {
    logEvento('pagamento', 'error', {
      operazione: OPERAZIONE, esito: 'export-senza-righe-a-carico',
      msg: 'legami non letti: l’export esce senza le righe dei bambini a carico di un fratello',
    })
    return []
  }
  const legami = o.sectionIds
    ? esito.legami.filter((l) => l.alunno.section_id != null && o.sectionIds!.includes(l.alunno.section_id))
    : esito.legami
  if (legami.length === 0) return []

  const ids = [...new Set(legami.flatMap((l) => [l.pagante.id, l.alunno_id]))]
  const { data, error } = await supabase
    .from('pagamenti')
    .select('alunno_id, descrizione, scadenza, periodo_competenza, stato, tipo, payment_categories!inner ( nome, slug )')
    .in('alunno_id', ids)
    .in('scuola_id', o.sediPaganti)
    .eq('payment_categories.slug', 'retta')
    .order('scadenza', { ascending: true })
  if (error) {
    logEvento('pagamento', 'error', { operazione: OPERAZIONE, esito: 'export-rette-paganti-non-lette', n: ids.length }, error)
    return []
  }

  // Per alunno: i mesi con una retta PROPRIA (D9), e la prima retta di ogni mese per scadenza.
  const mesiPropri = new Map<string, Set<string>>()
  const primaDelMese = new Map<string, Map<string, RigaRetta>>()
  for (const r of (data ?? []) as unknown as RigaRetta[]) {
    if (r.tipo === 'padre' || !r.periodo_competenza) continue
    const mesi = mesiPropri.get(r.alunno_id) ?? new Set<string>()
    mesi.add(r.periodo_competenza)
    mesiPropri.set(r.alunno_id, mesi)
    const perMese = primaDelMese.get(r.alunno_id) ?? new Map<string, RigaRetta>()
    if (!perMese.has(r.periodo_competenza)) perMese.set(r.periodo_competenza, r)
    primaDelMese.set(r.alunno_id, perMese)
  }

  const out: RigaScadenzario[] = []
  for (const l of legami) {
    const rette = primaDelMese.get(l.pagante.id)
    if (!rette) continue
    for (const [mese, r] of rette) {
      if (o.stato && r.stato !== o.stato) continue
      if (mesiPropri.get(l.alunno_id)?.has(mese)) continue
      out.push({
        Sede: l.scuola_id ? (o.nomiSedi.get(l.scuola_id) ?? '') : '',
        Alunno: [l.alunno.nome, l.alunno.cognome].filter(Boolean).join(' '),
        Sezione: l.alunno.classe_sezione ?? '',
        Categoria: r.payment_categories?.nome ?? '',
        Descrizione: r.descrizione,
        Scadenza: r.scadenza ?? '',
        'Importo €': 0,
        'Pagato €': 0,
        'Residuo €': 0,
        Stato: testoPaganteIt(l.pagante, o.etichettaStato(r.stato)),
        Fattura: '',
      })
    }
  }
  return out
}
```

- [ ] **Step 4: collega l'export.** In `src/app/api/pagamenti/export/route.ts`:

  a) import: `import { resolveScuoleAttive, scuoleDiUtente } from '@/lib/auth/scope'` (al posto dell'import di sola `resolveScuoleAttive`) e `import { righeRetteACarico, type RigaScadenzario } from '@/lib/pagamenti/export-rette-a-carico'`;

  b) tipizza le righe: `const righe: RigaScadenzario[] = ((data || []) as unknown as RigaPagamento[])` (resto del `.filter(...).map(...)` invariato);

  c) subito dopo il blocco `const righe = …` e prima di `const ws = XLSX.utils.json_to_sheet(righe)`, inserisci:

```ts
    // D14 — i bambini con la retta a carico di un fratello: una riga a importi zero per ogni
    // retta del pagante. Si intercalano per scadenza; il sort è STABILE, e le righe senza
    // scadenza restano in fondo come le mette Postgres (NULLS LAST).
    const aCarico = await righeRetteACarico(supabase, {
      sediBambini: scuolaId && sediAttive.includes(scuolaId) ? [scuolaId] : sediAttive,
      sediPaganti: await scuoleDiUtente(supabase, user),
      sectionIds,
      stato,
      nomiSedi,
      etichettaStato: (s) => STATO_LABEL[s] ?? s,
    })
    const chiave = (s: string) => s || '￿'
    const tutte = [...righe, ...aCarico].sort((a, b) => {
      const x = chiave(a.Scadenza), y = chiave(b.Scadenza)
      return x < y ? -1 : x > y ? 1 : 0
    })
```

  d) `XLSX.utils.json_to_sheet(righe)` → `XLSX.utils.json_to_sheet(tutte)`, e nel `logEvento` `export-scadenzario`: `n: tutte.length, a_carico: aCarico.length`.

- [ ] **Step 5: guardalo passare, con gli export di prima**

Run: `npx vitest run __tests__/api/pagamenti-export-rette-a-carico.test.ts __tests__/api/pagamenti-export.test.ts __tests__/api/pagamenti-export-sede-classi.test.ts __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts 2>&1 | tail -8`
Expected: `Test Files  5 passed (5)`. Se un test di prima fallisce perché il suo finto db non ha la tabella `alunni` e il finto client **lancia** su una tabella assente, la correzione è nel nuovo codice, non nel vecchio test: `caricaLegamiRetta` riceve `{ error }` e l'export deve continuare. Leggi il messaggio prima di decidere.

- [ ] **Step 6: rompi e guarda il rosso** — togli `'Importo €': 0` mettendo `Number(250)`: il test D14 deve fallire. Rimetti.

- [ ] **Step 7: commit**

```bash
git add src/lib/pagamenti/export-rette-a-carico.ts src/app/api/pagamenti/export/route.ts __tests__/api/pagamenti-export-rette-a-carico.test.ts
git commit -m "Export scadenzario: una riga a importi zero per il bambino a carico di un fratello

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: PRD e gate locale

**Files:**
- Modify: `PRD REGISTRO ELETTRONICO.md` (in cima, prima della riga 2)

- [ ] **Step 1: il changelog.** Inserisci in cima al PRD (dopo la riga 1, prima del primo `## … Changelog`):

```markdown
## 👪 Changelog — Retta a carico di un fratello: «Paga il fratello …» al posto di «Non generata» — 2026-09-28 (branch `feat/retta-a-carico-fratello`)

**Il difetto.** Dal 16/08 un bambino può avere la retta a carico di un fratello (`alunni.retta_a_carico_di`): la generazione lo salta, e la vista Rette lo mostrava **«Non generata»**, come un bambino dimenticato. «Genera mancanti» lo contava senza poterlo generare: il numero non scendeva mai a zero. Misurato il 28/09: **47 iscritti** in questa situazione (39 Giugliano, 5 Aversa, 3 Cesa).

**Cosa cambia** (decisioni del titolare, spec `docs/superpowers/specs/2026-09-28-retta-a-carico-fratello-design.md`):
- Vista Rette (tabella e card): «**Paga il fratello** Mario Rossi (Sez. C) · Da pagare» / «**Paga la sorella** …» / «**A carico di** …» se il sesso manca; il badge ha il **colore della retta del fratello** per quel mese, e «· Non generata» se nemmeno lui ce l'ha. Nessun «Incassa» sulla riga: si incassa dal fratello.
- «Genera mancanti» non conta più i bambini a carico.
- Filtro **Morosi**: compare anche il bambino il cui fratello pagante è moroso. **Ricerca**: il nome del pagante trova anche il bambino.
- Avvisi: arancio «retta da verificare» se il bambino a carico ha comunque una retta sua (3 casi a settembre); rosso se chi paga **non è più iscritto** o è **in un'altra sede**.
- **Export Excel**: per ogni retta del pagante, una riga in più per il bambino a carico, a importi 0 e con «Paga il fratello … · stato».
- Nuova GET di sola lettura `/api/pagamenti/rette-a-carico` (staff, per sede); loader condiviso `src/lib/pagamenti/rette-a-carico-server.ts`. Nessuna migrazione.

**Log.** `pagamento` · `legami-colonna-assente` (info, DB non migrato) · `legami-bambini-non-letti` / `legami-paganti-non-letti` (error) · `legami-pagante-non-leggibile` (warn, conteggio) · `export-senza-righe-a-carico` (error); lato client `scadenzario-legami-*`. Solo conteggi e uuid.
```

- [ ] **Step 2: il gate locale intero**

```bash
npx eslint . --max-warnings 0 2>&1 | tail -5
npx tsc --noEmit -p . 2>&1 | tail -5
npx vitest run 2>&1 | tail -8
npm run build 2>&1 | tail -8
```

Expected: eslint senza output d'errore; tsc senza errori; vitest con `Test Files  N passed` e **0 failed**; build ok. Ogni rosso si legge dal punto d'arresto e si corregge alla radice.

- [ ] **Step 3: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "PRD: changelog della retta a carico di un fratello

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Dopo il piano (fuori dai task)

1. Fino a **5 cicli critico ↔ correzione**: ogni critica la fa un sub-agente nuovo (contesto vuoto, «occhio fresco» equivalente a `/compact`), pignolo, sul diff `main...HEAD` confrontato con la spec; le correzioni si fanno qui, con il gate. Si esce prima se un critico non trova niente di sostanziale.
2. PR → CI verde (tutti i job, E2E compreso) → merge in `main` a mano → verifica del rilascio in produzione → pulizia dei branch (AGENTS.md, punto 3).
