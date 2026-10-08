# Non iscritti ed eliminazione definitiva — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** separare dall'elenco «Alunni» chi non frequenta (ritirati e iscritti senza sezione) in una linguetta «Non iscritti», da cui segreteria e Direzione possono eliminare definitivamente una scheda (o anonimizzarla quando ha contabilità), senza mai toccare il registro della primaria.

**Architecture:** una route `POST /api/admin/students/elimina` a due tempi (`dryrun` / `execute`) misura cosa c'è collegato, toglie prima i file con le funzioni dell'oblio già esistenti e poi chiama una funzione SQL `elimina_alunno_definitivo` che cancella tutto in UNA transazione e ricontrolla da sé ogni condizione. Il registro della primaria è una costante TS unica (`TABELLE_REGISTRO_PRIMARIA`) usata dalla nuova route, dall'oblio GDPR e dall'elenco dei candidati all'oblio; la funzione SQL ripete lo stesso elenco, tenuto allineato da un lock.

**Tech Stack:** Next.js (App Router, route avvolte in `withRoute`), Supabase/PostgREST (service role + gate applicativo), PL/pgSQL, zod, next-intl, vitest (+ PGlite per l'SQL, `finto-supabase` per le route, Testing Library per la UI).

**Spec:** `docs/superpowers/specs/2026-10-08-elimina-non-iscritti-design.md` (leggerla prima di cominciare).

---

## Regole del repo che valgono per OGNI task (leggere una volta)

- Branch: `feat/elimina-non-iscritti` (già creato). **Mai** committare su `main`.
- Lingua del codice, dei commenti e dei messaggi: **italiano**.
- Mai `console.*` in `src/`: `logOk` / `logErrore` / `logEvento` da `@/lib/logging/logger`; lato client `logClient` da `@/lib/logging/client`.
- PostgREST **non lancia**: si controlla sempre `{ error }`.
- Un `catch` che non logga è un bug.
- **Mai dati personali** in log, test, commenti, commit: il repo è pubblico. Nei test solo uuid inventati e nomi finti tipo «Bambino DiProva».
- Ogni risposta d'errore di una route porta un `codice` dichiarato in `CODICI_ERRORE` (`src/lib/ui/esito-fetch.ts`) con la frase in `messages/it/shared.json` **e** `messages/en/shared.json`.
- I cataloghi `messages/*/*.json` **non si riordinano**: le chiavi nuove si inseriscono nella posizione alfabetica, senza spostare le altre.
- Comandi di verifica: `npx vitest run <file>` per un file; alla fine `npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`.
- ⚠️ `npx vitest run <file inesistente>` esce 0 senza eseguire niente: controllare che nell'output compaia il numero di test eseguiti.
- ⚠️ In zsh `| tail` dopo un comando nasconde il suo exit code: per sapere se un test è passato si legge il riepilogo («Tests N passed»), non `$?`.
- Messaggi di commit in italiano, chiusi da `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Mappa dei file

| File | Ruolo |
|---|---|
| `src/lib/alunni/registro-primaria.ts` (nuovo) | `TABELLE_REGISTRO_PRIMARIA`, `leggiRegistroPrimaria`, `alunniConRegistroPrimaria` |
| `supabase/migrations/<UTC>_alunni_elimina_definitivo.sql` (nuovo) | funzione `elimina_alunno_definitivo` |
| `src/lib/alunni/archiviazione.ts` | + `RUOLI_ELIMINA_DEFINITIVO` |
| `src/lib/alunni/elimina-definitivo.ts` (nuovo) | `contaPerEliminazione`, `scelteDisponibili`, `rimuoviFileAlunno` |
| `src/lib/ui/esito-fetch.ts` + `messages/{it,en}/shared.json` | codici d'errore nuovi |
| `src/app/api/admin/students/elimina/route.ts` (nuovo) | la route |
| `src/app/api/admin/students/route.ts` | GET: parametro `elenco` |
| `src/app/api/admin/gdpr/erase/route.ts`, `src/app/api/admin/gdpr/candidates/route.ts`, `src/components/features/admin/settings/OblioPanel.tsx` | oblio: registro primaria intoccabile |
| `src/components/features/admin/EliminaDefinitivoDialog.tsx` (nuovo) | la finestra |
| `src/components/features/admin/AlunniArchiviatiView.tsx` | due gruppi, «Assegna sezione», «Elimina definitivamente» |
| `src/app/(dashboard)/admin/students/page.tsx` | elenco Alunni = frequentanti; filtri |
| `messages/{it,en}/adminStudents.json`, `messages/{it,en}/adminAltro.json` | testi |
| `PRD REGISTRO ELETTRONICO.md` | changelog |
| test: `__tests__/lib/registro-primaria.test.ts`, `__tests__/lib/elimina-alunno-definitivo-sql.test.ts`, `__tests__/lib/elimina-definitivo.test.ts`, `__tests__/api/admin-students-elimina.test.ts`, `__tests__/api/admin-students-elenco.test.ts`, `__tests__/api/gdpr-erase-registro-primaria.test.ts`, `__tests__/components/EliminaDefinitivoDialog.test.tsx` + aggiornamenti ai test esistenti indicati nei task |

---

### Task 1: Il registro della primaria — costante unica e letture

**Files:**
- Create: `src/lib/alunni/registro-primaria.ts`
- Test: `__tests__/lib/registro-primaria.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// __tests__/lib/registro-primaria.test.ts
import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import {
  TABELLE_REGISTRO_PRIMARIA,
  alunniConRegistroPrimaria,
  leggiRegistroPrimaria,
} from '@/lib/alunni/registro-primaria'

// Solo uuid inventati: il repository è pubblico.
const CON_VOTO = '10000000-0000-4000-8000-000000000001'
const CON_NOTA = '10000000-0000-4000-8000-000000000002'
const PULITO = '10000000-0000-4000-8000-000000000003'

function db(): DBFinto {
  return {
    valutazioni: [{ id: 'v-1', alunno_id: CON_VOTO }],
    pagelle: [],
    scrutinio_giudizi: [],
    scrutinio_comportamento: [],
    note_disciplinari: [{ id: 'n-1', alunno_id: CON_NOTA }],
    certificati_competenze: [],
  }
}

describe('registro della primaria', () => {
  it('l’elenco delle tabelle è quello deciso dal titolare, e non cambia per distrazione', () => {
    expect([...TABELLE_REGISTRO_PRIMARIA]).toEqual([
      'valutazioni',
      'pagelle',
      'scrutinio_giudizi',
      'scrutinio_comportamento',
      'note_disciplinari',
      'certificati_competenze',
    ])
  })

  it('un voto basta a rendere presente il registro', async () => {
    const esito = await leggiRegistroPrimaria(creaFintoSupabase(db()) as never, CON_VOTO)
    expect(esito).toEqual({ ok: true, presente: true })
  })

  it('senza righe nelle sei tabelle il registro è assente', async () => {
    const esito = await leggiRegistroPrimaria(creaFintoSupabase(db()) as never, PULITO)
    expect(esito).toEqual({ ok: true, presente: false })
  })

  it('una tabella assente dallo schema (DB E2E non migrato) vale «nessuna riga», non un guasto', async () => {
    const senzaScrutini = db()
    delete senzaScrutini.scrutinio_giudizi
    const supabase = creaFintoSupabase(senzaScrutini, [], {
      errori: { scrutinio_giudizi: { code: '42P01', message: 'relation does not exist' } },
    })
    const esito = await leggiRegistroPrimaria(supabase as never, PULITO)
    expect(esito).toEqual({ ok: true, presente: false })
  })

  it('una lettura FALLITA non è mai «assente»', async () => {
    const supabase = creaFintoSupabase(db(), [], {
      errori: { pagelle: { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    const esito = await leggiRegistroPrimaria(supabase as never, PULITO)
    expect(esito.ok).toBe(false)
  })

  it('in blocco restituisce SOLO gli alunni con registro', async () => {
    const esito = await alunniConRegistroPrimaria(creaFintoSupabase(db()) as never, [CON_VOTO, CON_NOTA, PULITO])
    expect(esito.ok).toBe(true)
    if (esito.ok) expect([...esito.conRegistro].sort()).toEqual([CON_VOTO, CON_NOTA].sort())
  })

  it('in blocco con lista vuota non legge niente e risponde vuoto', async () => {
    const esito = await alunniConRegistroPrimaria(creaFintoSupabase({}) as never, [])
    expect(esito).toEqual({ ok: true, conRegistro: new Set() })
  })
})
```

Prima di eseguirlo, controlla in `__tests__/fixtures/finto-supabase.ts` (testata, righe 1-140) la forma esatta di `opzioni.errori` (chiave `tabella` oppure `tabella:operazione`, campi dell'errore) e come risponde il finto a una tabella **assente** da `DBFinto`: se lancia invece di restituire un errore, nel test «tabella assente» lascia la tabella in `DBFinto` vuota e inietta solo l'errore `42P01`.

- [ ] **Step 2: Eseguilo e verifica che fallisca**

Run: `npx vitest run __tests__/lib/registro-primaria.test.ts`
Expected: FAIL — `Cannot find module '@/lib/alunni/registro-primaria'`.

- [ ] **Step 3: Scrivi l'implementazione**

```ts
// src/lib/alunni/registro-primaria.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAssente } from '@/lib/news/schema-assente'

// =============================================================================
// IL REGISTRO DELLA PRIMARIA NON SI CANCELLA E NON SI ANONIMIZZA.
//
// Decisione del titolare (2026-10-08): voti, pagelle, scrutini, note
// disciplinari e certificati delle competenze sono il registro ufficiale della
// scuola, che la legge obbliga a conservare — ed è la stessa eccezione che il
// GDPR scrive per l'oblio (art. 17 §3 lett. b). Vale per TRE porte:
// l'eliminazione definitiva (`admin/students/elimina`), l'oblio
// (`admin/gdpr/erase`) e l'elenco dei suoi candidati (`admin/gdpr/candidates`).
//
// L'elenco vive QUI e in nessun altro file TypeScript. La funzione SQL
// `elimina_alunno_definitivo` lo ripete (in SQL non si importa), e il test
// `__tests__/lib/elimina-alunno-definitivo-sql.test.ts` pretende che le due
// copie coincidano: aggiungere una tabella qui senza aggiungerla là fa rosso.
//
// «NON CI SONO RIGHE» E «NON LE HO POTUTE LEGGERE» NON SONO LA STESSA RISPOSTA:
// la seconda, qui, aprirebbe la porta a una cancellazione irreversibile del
// registro. Per questo l'esito non è un booleano: senza guardare `ok` non si
// arriva a `presente`. Una tabella che NON ESISTE (DB E2E della CI non migrato:
// 42P01/PGRST205) vale invece «nessuna riga», che su quel database è la verità.
// =============================================================================

export const TABELLE_REGISTRO_PRIMARIA = [
  'valutazioni',
  'pagelle',
  'scrutinio_giudizi',
  'scrutinio_comportamento',
  'note_disciplinari',
  'certificati_competenze',
] as const

export type TabellaRegistroPrimaria = (typeof TABELLE_REGISTRO_PRIMARIA)[number]

export type EsitoRegistroPrimaria =
  | { ok: true; presente: boolean }
  | { ok: false; errore: unknown }

export type EsitoRegistroPrimariaInBlocco =
  | { ok: true; conRegistro: Set<string> }
  | { ok: false; errore: unknown }

/** C'è almeno una riga del registro della primaria per questo alunno? */
export async function leggiRegistroPrimaria(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<EsitoRegistroPrimaria> {
  for (const tabella of TABELLE_REGISTRO_PRIMARIA) {
    const { count, error } = await supabase
      .from(tabella)
      .select('alunno_id', { count: 'exact', head: true })
      .eq('alunno_id', alunnoId)
    if (error) {
      if (schemaAssente(error)) continue
      return { ok: false, errore: error }
    }
    if ((count ?? 0) > 0) return { ok: true, presente: true }
  }
  return { ok: true, presente: false }
}

/**
 * Gli alunni, fra quelli dati, che hanno il registro della primaria.
 *
 * Un `count` per alunno e non una `select … in(…)` per tabella: la seconda è
 * troncata dal tetto di righe di PostgREST, e un bambino con molti voti in
 * fondo all'elenco sparirebbe dal risultato — cioè risulterebbe «senza
 * registro». Gli elenchi su cui si chiama sono corti (i candidati all'oblio).
 */
export async function alunniConRegistroPrimaria(
  supabase: SupabaseClient,
  alunnoIds: (string | null | undefined)[],
): Promise<EsitoRegistroPrimariaInBlocco> {
  const ids = [...new Set(alunnoIds.filter((v): v is string => typeof v === 'string' && v.length > 0))]
  const conRegistro = new Set<string>()
  for (const id of ids) {
    const esito = await leggiRegistroPrimaria(supabase, id)
    if (!esito.ok) return esito
    if (esito.presente) conRegistro.add(id)
  }
  return { ok: true, conRegistro }
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run __tests__/lib/registro-primaria.test.ts`
Expected: PASS, 7 test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/alunni/registro-primaria.ts __tests__/lib/registro-primaria.test.ts
git commit -m "$(printf 'Registro della primaria: elenco unico delle tabelle e letture che non scambiano un guasto per «assente»\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 2: La funzione SQL `elimina_alunno_definitivo`

**Files:**
- Create: `supabase/migrations/<VERSIONE>_alunni_elimina_definitivo.sql` — `<VERSIONE>` = output di `date -u +%Y%m%d%H%M%S` **nel momento in cui crei il file** (mai un orario tondo, mai nel futuro).
- Test: `__tests__/lib/elimina-alunno-definitivo-sql.test.ts`

- [ ] **Step 1: Crea il nome del file**

Run: `echo "supabase/migrations/$(date -u +%Y%m%d%H%M%S)_alunni_elimina_definitivo.sql"`
Annota il percorso stampato: è quello da usare nello Step 3.

- [ ] **Step 2: Scrivi il test su Postgres vero (PGlite) che fallisce**

```ts
// __tests__/lib/elimina-alunno-definitivo-sql.test.ts
// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { TABELLE_REGISTRO_PRIMARIA } from '@/lib/alunni/registro-primaria'

/**
 * ELIMINAZIONE DEFINITIVA DI UN ALUNNO · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Ciò che la migrazione consegna sono regole che solo il database può far
 * rispettare: l'ordine delle cancellazioni contro le FK senza CASCADE, il
 * «tutto o niente» di una transazione, i permessi sulla funzione. Un finto
 * client direbbe «sì» a tutto.
 *
 * Lo schema qui sotto è un MINIMO: colonne e FK riprendono la produzione
 * (lette in sola lettura il 2026-10-08 da `pg_constraint`), il resto è tolto.
 * Il file della migrazione è LETTO DAL DISCO e applicato DUE volte.
 *
 * Solo dati finti: uuid inventati, nessuna anagrafica.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_alunni_elimina_definitivo.sql'))
if (!FILE) throw new Error('migrazione *_alunni_elimina_definitivo.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const SEZ = 'c0000000-0000-4000-8000-000000000001'
const ADULTO = '10000000-0000-4000-8000-000000000001' // ritirato, legato al genitore che è lui stesso
const DOPPIONE = '10000000-0000-4000-8000-000000000002' // ritirato, una presenza
const ISCRITTO = '10000000-0000-4000-8000-000000000003' // frequenta: intoccabile
const SENZA_SEZ = '10000000-0000-4000-8000-000000000004' // iscritto ma senza sezione
const FRATELLO = '10000000-0000-4000-8000-000000000005'
const GENITORE = '20000000-0000-4000-8000-000000000001'

let db: PGlite

type PgErr = { code?: string; message: string }

async function elimina(alunno: string, conPagamenti = false): Promise<{ ok: boolean; code: string; righe?: Record<string, number> }> {
  const { rows } = await db.query<{ r: { ok: boolean; code: string; righe?: Record<string, number> } }>(
    `SELECT public.elimina_alunno_definitivo('${alunno}', ${conPagamenti}) AS r`,
  )
  return rows[0].r
}

async function numero(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
  return rows[0].n
}

async function schemaMinimo(conn: PGlite) {
  await conn.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    CREATE FUNCTION public.stati_alunno_non_piu_iscritto() RETURNS text[]
      LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['ritirato']::text[] $$;

    CREATE TABLE public.alunni (
      id uuid PRIMARY KEY,
      scuola_id uuid,
      stato varchar,
      section_id uuid,
      classe_sezione varchar,
      anonimizzato_il timestamptz,
      retta_a_carico_di uuid REFERENCES public.alunni(id) ON DELETE SET NULL
    );
    CREATE TABLE public.parents (id uuid PRIMARY KEY);
    CREATE TABLE public.student_parents (
      student_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE,
      parent_id uuid REFERENCES public.parents(id)
    );
    CREATE TABLE public.legame_genitori_alunni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id),
      parent_id uuid
    );
    CREATE TABLE public.presenze (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.eventi_diario (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.armadietto (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.ticket_mensa (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.forms_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid);
    CREATE TABLE public.galleria_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tag_alunni uuid[]);

    CREATE TABLE public.valutazioni (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.pagelle (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.scrutinio_giudizi (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.scrutinio_comportamento (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);
    CREATE TABLE public.note_disciplinari (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id));
    CREATE TABLE public.certificati_competenze (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE);

    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      alunno_id uuid REFERENCES public.alunni(id),
      parent_payment_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE
    );
    CREATE TABLE public.incassi (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE);
    CREATE TABLE public.ricevute_emesse (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid, pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL);
    CREATE TABLE public.fatture_emesse (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE RESTRICT);
    CREATE TABLE public.riconciliazione_movimenti (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE SET NULL);
    CREATE TABLE public.solleciti (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alunno_id uuid, pagamento_id uuid REFERENCES public.pagamenti(id) ON DELETE CASCADE);
  `)
}

beforeAll(async () => {
  db = new PGlite()
  await schemaMinimo(db)
  await db.exec(MIGRAZIONE)
  await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.solleciti, public.riconciliazione_movimenti, public.fatture_emesse, public.ricevute_emesse,
             public.incassi, public.pagamenti, public.valutazioni, public.pagelle, public.scrutinio_giudizi,
             public.scrutinio_comportamento, public.note_disciplinari, public.certificati_competenze,
             public.galleria_media, public.forms_submissions, public.ticket_mensa, public.armadietto,
             public.eventi_diario, public.presenze, public.legame_genitori_alunni, public.student_parents,
             public.parents, public.alunni CASCADE;

    INSERT INTO public.alunni (id, scuola_id, stato, section_id, classe_sezione) VALUES
      ('${ADULTO}',    '${SEDE}', 'ritirato', NULL,     NULL),
      ('${DOPPIONE}',  '${SEDE}', 'ritirato', NULL,     NULL),
      ('${ISCRITTO}',  '${SEDE}', 'iscritto', '${SEZ}', 'SEZIONE A'),
      ('${SENZA_SEZ}', '${SEDE}', 'iscritto', NULL,     NULL),
      ('${FRATELLO}',  '${SEDE}', 'iscritto', '${SEZ}', 'SEZIONE A');
    INSERT INTO public.parents (id) VALUES ('${GENITORE}');
    INSERT INTO public.student_parents (student_id, parent_id) VALUES ('${ADULTO}', '${GENITORE}'), ('${ISCRITTO}', '${GENITORE}');
    INSERT INTO public.legame_genitori_alunni (alunno_id, parent_id) VALUES ('${ADULTO}', '${GENITORE}');
    INSERT INTO public.presenze (alunno_id) VALUES ('${DOPPIONE}');
  `)
})

describe('elimina_alunno_definitivo — chi si può eliminare', () => {
  it('rifiuta chi FREQUENTA (iscritto con sezione) e non tocca niente', async () => {
    expect(await elimina(ISCRITTO)).toMatchObject({ ok: false, code: 'frequentante' })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${ISCRITTO}'`)).toBe(1)
  })

  it('risponde «non_trovato» su un id che non esiste', async () => {
    expect(await elimina('99999999-0000-4000-8000-000000000099')).toMatchObject({ ok: false, code: 'non_trovato' })
  })

  it('rifiuta una scheda già anonimizzata', async () => {
    await db.exec(`UPDATE public.alunni SET anonimizzato_il = now() WHERE id = '${DOPPIONE}'`)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: false, code: 'gia_anonimizzato' })
  })

  it('caso A — l’adulto inserito come bambino: via la scheda e i due legami, il GENITORE resta intatto', async () => {
    expect(await elimina(ADULTO)).toMatchObject({ ok: true, code: 'eliminato' })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.legame_genitori_alunni WHERE alunno_id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.student_parents WHERE student_id = '${ADULTO}'`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.parents WHERE id = '${GENITORE}'`)).toBe(1)
    // e il figlio vero di quel genitore resta collegato
    expect(await numero(`SELECT count(*) FROM public.student_parents WHERE student_id = '${ISCRITTO}'`)).toBe(1)
  })

  it('caso B — il doppione: la presenza se ne va in cascata', async () => {
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: true, code: 'eliminato' })
    expect(await numero(`SELECT count(*) FROM public.presenze WHERE alunno_id = '${DOPPIONE}'`)).toBe(0)
  })

  it('un iscritto SENZA sezione si può eliminare', async () => {
    expect(await elimina(SENZA_SEZ)).toMatchObject({ ok: true, code: 'eliminato' })
  })

  it('porta via diario, armadietto, ticket, moduli e il tag nella galleria storica', async () => {
    await db.exec(`
      INSERT INTO public.eventi_diario (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.armadietto (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.ticket_mensa (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.forms_submissions (student_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.galleria_media (tag_alunni) VALUES (ARRAY['${DOPPIONE}', '${ISCRITTO}']::uuid[]);
    `)
    const r = await elimina(DOPPIONE)
    expect(r).toMatchObject({ ok: true, code: 'eliminato' })
    expect(r.righe).toMatchObject({ diario: 1, armadietto: 1, ticket_mensa: 1, moduli: 1, tag_galleria: 1 })
    expect(await numero(`SELECT count(*) FROM public.eventi_diario`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.galleria_media WHERE '${DOPPIONE}' = ANY(tag_alunni)`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.galleria_media WHERE '${ISCRITTO}' = ANY(tag_alunni)`)).toBe(1)
  })

  it('il fratello che aveva la retta a carico di questa scheda la perde (SET NULL), non sparisce', async () => {
    await db.exec(`UPDATE public.alunni SET retta_a_carico_di = '${DOPPIONE}' WHERE id = '${FRATELLO}'`)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: true })
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${FRATELLO}' AND retta_a_carico_di IS NULL`)).toBe(1)
  })
})

describe('elimina_alunno_definitivo — il registro della primaria', () => {
  for (const tabella of TABELLE_REGISTRO_PRIMARIA) {
    it(`una riga in ${tabella} blocca TUTTO, anche con i pagamenti ammessi`, async () => {
      await db.exec(`INSERT INTO public.${tabella} (alunno_id) VALUES ('${DOPPIONE}')`)
      expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'registro_primaria' })
      expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
    })
  }

  it('le tabelle controllate in SQL sono ESATTAMENTE quelle di TABELLE_REGISTRO_PRIMARIA', () => {
    const blocco = /-- registro-primaria:inizio([\s\S]*?)-- registro-primaria:fine/.exec(MIGRAZIONE)
    expect(blocco, 'marcatori -- registro-primaria:inizio/fine assenti nella migrazione').not.toBeNull()
    const inSql = [...blocco![1].matchAll(/from public\.(\w+)/gi)].map((m) => m[1]).sort()
    expect(inSql).toEqual([...TABELLE_REGISTRO_PRIMARIA].sort())
  })
})

describe('elimina_alunno_definitivo — i pagamenti', () => {
  async function pagamento(alunno: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(`INSERT INTO public.pagamenti (alunno_id) VALUES ('${alunno}') RETURNING id`)
    return rows[0].id
  }

  it('con pagamenti e senza permesso: rifiuta «ha_pagamenti» e non tocca niente', async () => {
    await pagamento(DOPPIONE)
    expect(await elimina(DOPPIONE)).toMatchObject({ ok: false, code: 'ha_pagamenti' })
    expect(await numero(`SELECT count(*) FROM public.pagamenti`)).toBe(1)
  })

  it('con permesso e pagamenti puliti: via pagamenti e solleciti, poi la scheda', async () => {
    const p = await pagamento(DOPPIONE)
    await db.exec(`INSERT INTO public.solleciti (alunno_id, pagamento_id) VALUES ('${DOPPIONE}', '${p}')`)
    const r = await elimina(DOPPIONE, true)
    expect(r).toMatchObject({ ok: true, code: 'eliminato' })
    expect(r.righe).toMatchObject({ pagamenti: 1 })
    expect(await numero(`SELECT count(*) FROM public.pagamenti`)).toBe(0)
    expect(await numero(`SELECT count(*) FROM public.solleciti`)).toBe(0)
  })

  const BLOCCHI: [string, (p: string) => string][] = [
    ['incasso registrato', (p) => `INSERT INTO public.incassi (pagamento_id) VALUES ('${p}')`],
    ['ricevuta emessa', (p) => `INSERT INTO public.ricevute_emesse (alunno_id, pagamento_id) VALUES ('${DOPPIONE}', '${p}')`],
    ['fattura emessa', (p) => `INSERT INTO public.fatture_emesse (pagamento_id) VALUES ('${p}')`],
    ['bonifico abbinato', (p) => `INSERT INTO public.riconciliazione_movimenti (pagamento_id) VALUES ('${p}')`],
    ['quota di un fratello appesa', (p) => `INSERT INTO public.pagamenti (alunno_id, parent_payment_id) VALUES ('${FRATELLO}', '${p}')`],
  ]
  for (const [nome, sql] of BLOCCHI) {
    it(`${nome}: «pagamenti_non_cancellabili» anche col permesso, e niente si muove`, async () => {
      const p = await pagamento(DOPPIONE)
      await db.exec(sql(p))
      expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'pagamenti_non_cancellabili' })
      expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
      expect(await numero(`SELECT count(*) FROM public.pagamenti WHERE alunno_id = '${DOPPIONE}'`)).toBe(1)
    })
  }

  it('una ricevuta emessa SENZA pagamento basta a bloccare', async () => {
    await db.exec(`INSERT INTO public.ricevute_emesse (alunno_id) VALUES ('${DOPPIONE}')`)
    expect(await elimina(DOPPIONE, true)).toMatchObject({ ok: false, code: 'pagamenti_non_cancellabili' })
  })
})

describe('elimina_alunno_definitivo — tutto o niente, e chi può chiamarla', () => {
  it('un errore all’ultimo passo annulla anche le cancellazioni già fatte', async () => {
    // Una FK senza CASCADE che la funzione NON conosce: la DELETE finale fallisce.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.tabella_estranea (id serial PRIMARY KEY, alunno_id uuid REFERENCES public.alunni(id));
      INSERT INTO public.tabella_estranea (alunno_id) VALUES ('${DOPPIONE}');
      INSERT INTO public.eventi_diario (alunno_id) VALUES ('${DOPPIONE}');
    `)
    let err: PgErr | null = null
    try {
      await elimina(DOPPIONE)
    } catch (e) {
      err = e as PgErr
    }
    expect(err?.code).toBe('23503')
    expect(await numero(`SELECT count(*) FROM public.eventi_diario WHERE alunno_id = '${DOPPIONE}'`)).toBe(1)
    expect(await numero(`SELECT count(*) FROM public.alunni WHERE id = '${DOPPIONE}'`)).toBe(1)
    await db.exec(`DROP TABLE public.tabella_estranea`)
  })

  it('la porta è chiusa ad anon e authenticated, aperta al solo service_role', async () => {
    const firma = `'public.elimina_alunno_definitivo(uuid, boolean)'`
    const { rows } = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      SELECT has_function_privilege('anon', ${firma}, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', ${firma}, 'EXECUTE') AS auth,
             has_function_privilege('service_role', ${firma}, 'EXECUTE') AS svc`)
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true })
  })

  it('la migrazione non cancella mai da storage.objects', () => {
    expect(MIGRAZIONE.toLowerCase()).not.toContain('storage.objects')
  })
})
```

- [ ] **Step 3: Eseguilo e verifica che fallisca**

Run: `npx vitest run __tests__/lib/elimina-alunno-definitivo-sql.test.ts`
Expected: FAIL — `migrazione *_alunni_elimina_definitivo.sql non trovata`.

- [ ] **Step 4: Scrivi la migrazione** nel percorso annotato allo Step 1

⚠️ Nel corpo e nei commenti **non** usare le parole che accendono le guardie di freschezza delle fotografie: `unique`, `primary key`, `policy`, `row level security`, `drop table`, `add constraint`, `drop constraint`, `references utenti`. La migrazione è di sole funzioni.

```sql
-- =============================================================================
-- ELIMINAZIONE DEFINITIVA DI UN ALUNNO NON ISCRITTO — 2026-10-08
--
-- Decisione del titolare: dall'elenco dei «non iscritti» (ritirati e iscritti
-- senza sezione) segreteria e Direzione eliminano DAVVERO una scheda: un
-- doppione, un adulto inserito per errore come bambino, un ritirato senza
-- storia. La route `admin/students/elimina` toglie prima i file (Storage API,
-- con le funzioni dell'oblio) e poi chiama questa funzione, che fa tutte le
-- cancellazioni in UNA transazione: o tutto, o niente.
--
-- ─── PERCHÉ LA FUNZIONE RICONTROLLA TUTTO ──────────────────────────────────
-- La route misura e decide, ma fra la misura e questa chiamata può arrivare un
-- pagamento o un voto. Qui le condizioni si rileggono sotto `FOR UPDATE`.
--
-- ─── LA LEZIONE DEL 2026-08-12 ─────────────────────────────────────────────
-- La vecchia cancellazione scriveva l'audit PRIMA di una DELETE che falliva
-- (23503) e lasciava un'affermazione falsa con la copia della riga. Qui la
-- DELETE è preceduta dalla rimozione di ogni riga che la bloccherebbe, e la
-- traccia la scrive la route SOLO dopo una risposta `ok: true`.
--
-- ─── COSA RESTA, DI PROPOSITO ──────────────────────────────────────────────
--  · ricevute_emesse e fatture_emesse: WORM / RESTRICT. Il caso che le tocca è
--    rifiutato prima (pagamenti_non_cancellabili).
--  · chat_vigilanza_accessi: registro di accountability, solo uuid.
--  · enrollment_submissions: non è collegata per id; vive in Iscrizioni.
--
-- ─── IL REGISTRO DELLA PRIMARIA ────────────────────────────────────────────
-- Non si cancella (né si anonimizza: lo decide la route). L'elenco delle tabelle
-- fra i marcatori `registro-primaria` è la copia SQL di TABELLE_REGISTRO_PRIMARIA
-- (`src/lib/alunni/registro-primaria.ts`): il test PGlite pretende che coincidano.
--
-- ─── COME SI VERIFICA ──────────────────────────────────────────────────────
--   select has_function_privilege('anon', 'public.elimina_alunno_definitivo(uuid, boolean)', 'EXECUTE');          -- false
--   select has_function_privilege('authenticated', 'public.elimina_alunno_definitivo(uuid, boolean)', 'EXECUTE'); -- false
--   select has_function_privilege('service_role', 'public.elimina_alunno_definitivo(uuid, boolean)', 'EXECUTE');  -- true
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────
--   drop function if exists public.elimina_alunno_definitivo(uuid, boolean);
-- =============================================================================

create or replace function public.elimina_alunno_definitivo(
  p_alunno uuid,
  p_con_pagamenti boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_alunno    record;
  v_pagamenti int;
  v_bloccati  int;
  v_ricevute  int;
  v_n         int;
  v_righe     jsonb := '{}'::jsonb;
begin
  if p_alunno is null then
    raise exception 'elimina_alunno_definitivo: p_alunno obbligatorio';
  end if;

  select id, stato, section_id, anonimizzato_il
    into v_alunno
    from public.alunni
   where id = p_alunno
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'non_trovato');
  end if;
  if v_alunno.anonimizzato_il is not null then
    return jsonb_build_object('ok', false, 'code', 'gia_anonimizzato');
  end if;
  -- Elenco chiuso degli stati, mai la negazione di 'iscritto'.
  if not (v_alunno.stato = any(public.stati_alunno_non_piu_iscritto()) or v_alunno.section_id is null) then
    return jsonb_build_object('ok', false, 'code', 'frequentante');
  end if;

  -- registro-primaria:inizio
  if exists (select 1 from public.valutazioni where alunno_id = p_alunno)
     or exists (select 1 from public.pagelle where alunno_id = p_alunno)
     or exists (select 1 from public.scrutinio_giudizi where alunno_id = p_alunno)
     or exists (select 1 from public.scrutinio_comportamento where alunno_id = p_alunno)
     or exists (select 1 from public.note_disciplinari where alunno_id = p_alunno)
     or exists (select 1 from public.certificati_competenze where alunno_id = p_alunno) then
    return jsonb_build_object('ok', false, 'code', 'registro_primaria');
  end if;
  -- registro-primaria:fine

  select count(*) into v_pagamenti from public.pagamenti where alunno_id = p_alunno;
  select count(*) into v_ricevute from public.ricevute_emesse where alunno_id = p_alunno;

  if v_pagamenti > 0 or v_ricevute > 0 then
    if not coalesce(p_con_pagamenti, false) then
      return jsonb_build_object('ok', false, 'code', 'ha_pagamenti', 'pagamenti', v_pagamenti);
    end if;
    -- Un pagamento è contabilità vera se ha una ricevuta, una fattura, un
    -- bonifico abbinato, un incasso, oppure quote di un ALTRO alunno appese a lui
    -- (la cascata su parent_payment_id le porterebbe via).
    select count(*) into v_bloccati
      from public.pagamenti p
     where p.alunno_id = p_alunno
       and (exists (select 1 from public.ricevute_emesse r where r.pagamento_id = p.id)
         or exists (select 1 from public.fatture_emesse f where f.pagamento_id = p.id)
         or exists (select 1 from public.riconciliazione_movimenti m where m.pagamento_id = p.id)
         or exists (select 1 from public.incassi i where i.pagamento_id = p.id)
         or exists (select 1 from public.pagamenti c
                     where c.parent_payment_id = p.id
                       and c.alunno_id is distinct from p_alunno));
    if v_bloccati > 0 or v_ricevute > 0 then
      return jsonb_build_object('ok', false, 'code', 'pagamenti_non_cancellabili',
                                'bloccati', v_bloccati, 'ricevute', v_ricevute);
    end if;
  end if;

  -- Le cancellazioni: prima ciò che bloccherebbe la DELETE finale, poi la scheda.
  delete from public.solleciti where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('solleciti', v_n);

  delete from public.pagamenti where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('pagamenti', v_n);

  delete from public.eventi_diario where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('diario', v_n);

  delete from public.legame_genitori_alunni where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('legami', v_n);

  delete from public.armadietto where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('armadietto', v_n);

  delete from public.ticket_mensa where alunno_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('ticket_mensa', v_n);

  delete from public.forms_submissions where student_id = p_alunno;
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('moduli', v_n);

  update public.galleria_media
     set tag_alunni = array_remove(tag_alunni, p_alunno)
   where p_alunno = any(tag_alunni);
  get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('tag_galleria', v_n);

  -- Copia di sicurezza del diario creata a mano il 2026-09-08, senza migrazione:
  -- esiste solo in produzione, quindi la si nomina solo se c'è.
  if to_regclass('public.backup_diario_vuote_20260908') is not null then
    execute 'delete from public.backup_diario_vuote_20260908 where alunno_id = $1' using p_alunno;
    get diagnostics v_n = row_count; v_righe := v_righe || jsonb_build_object('backup_diario', v_n);
  end if;

  -- Il resto (presenze, deleghe, documenti, chat, servizi, registro_destinatari,
  -- certificati medici, ...) segue in CASCADE; retta_a_carico_di dei fratelli va
  -- a NULL da sé.
  delete from public.alunni where id = p_alunno;

  return jsonb_build_object('ok', true, 'code', 'eliminato', 'righe', v_righe);
end;
$$;

-- La porta, chiusa a chiave: in Supabase anon e authenticated ricevono
-- l'EXECUTE per GRANT esplicito, e vanno revocati per nome.
alter function public.elimina_alunno_definitivo(uuid, boolean) owner to postgres;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean) from public;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean) from anon;
revoke all on function public.elimina_alunno_definitivo(uuid, boolean) from authenticated;
grant execute on function public.elimina_alunno_definitivo(uuid, boolean) to service_role;

comment on function public.elimina_alunno_definitivo(uuid, boolean) is
  'Elimina davvero una scheda alunno NON iscritta (ritirata o senza sezione), in una sola transazione. Rifiuta il registro della primaria e la contabilita emessa. I file li toglie prima la route, con la Storage API.';

notify pgrst, 'reload schema';
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `npx vitest run __tests__/lib/elimina-alunno-definitivo-sql.test.ts`
Expected: PASS (circa 27 test). Se PGlite rifiuta `owner to postgres`, controlla con `SELECT current_user` nel `beforeAll`: il ruolo di PGlite è `postgres`; se così non fosse, crea il ruolo nello schema minimo (`CREATE ROLE postgres`) — **non** togliere la riga dalla migrazione.

- [ ] **Step 6: Esegui i lock sulle migrazioni**

Run: `npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/storage-delete-vietata-in-sql.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts`
Expected: PASS. Se `migrazioni-complete` chiede che la migrazione sia in coda (`IN_CODA`), aggiungi la voce come indica il messaggio, con il commento «applicata dall'integrazione al merge».
Run anche: `npx vitest run __tests__/architecture/soglia-fotografia` (o il file che importa `soglia-fotografia.ts`: trovalo con `grep -rl "soglia-fotografia" __tests__/architecture`). Expected: PASS senza voci nuove in `MIGRAZIONI_ATTESE_AL_MERGE`. Se una guardia scatta, cerca nella migrazione la parola che la accende e riformula.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/*_alunni_elimina_definitivo.sql __tests__/lib/elimina-alunno-definitivo-sql.test.ts
git commit -m "$(printf 'Migrazione: elimina_alunno_definitivo, tutto o niente in una transazione\n\nRicontrolla da sé non-iscritto, registro della primaria e contabilità emessa;\nprovata su Postgres vero (PGlite) rileggendo il file dal disco.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 3: Ruoli, misura, scelte e rimozione dei file

**Files:**
- Modify: `src/lib/alunni/archiviazione.ts` (dopo `RUOLI_LIBERA_SPAZIO`, riga ~55)
- Create: `src/lib/alunni/elimina-definitivo.ts`
- Test: `__tests__/lib/elimina-definitivo.test.ts`

- [ ] **Step 1: Aggiungi la costante dei ruoli** in `src/lib/alunni/archiviazione.ts`, subito dopo `export const RUOLI_LIBERA_SPAZIO = ['admin', 'coordinator'] as const`:

```ts
/**
 * Chi può ELIMINARE DEFINITIVAMENTE una scheda dai «non iscritti»
 * (`admin/students/elimina`). Decisione del titolare (2026-10-08): anche la
 * SEGRETERIA, che è chi corregge le anagrafiche ogni giorno — a differenza di
 * «Libera spazio», che resta della Direzione. Le difese sono altrove: anteprima
 * con i numeri, isolamento di sede, funzione SQL che ricontrolla tutto, traccia
 * scritta solo a cose fatte.
 *
 * Vive qui per la stessa ragione di `RUOLI_LIBERA_SPAZIO`: lo leggono il gate
 * del server e il filtro di cortesia del client, e due copie divergerebbero in
 * silenzio. Il test della route asserisce il valore LETTERALE passato a
 * `requireStaff`.
 */
export const RUOLI_ELIMINA_DEFINITIVO = ['admin', 'coordinator', 'segreteria'] as const
```

- [ ] **Step 2: Scrivi il test che fallisce**

```ts
// __tests__/lib/elimina-definitivo.test.ts
import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { contaPerEliminazione, scelteDisponibili } from '@/lib/alunni/elimina-definitivo'

const AL = '10000000-0000-4000-8000-000000000001'
const FRATELLO = '10000000-0000-4000-8000-000000000002'

function db(extra: Partial<DBFinto> = {}): DBFinto {
  return {
    alunni: [{ id: AL, stato: 'ritirato', section_id: null }],
    presenze: [{ id: 'pr-1', alunno_id: AL }],
    eventi_diario: [],
    student_parents: [{ student_id: AL, parent_id: 'p-1' }],
    pagamenti: [],
    ricevute_emesse: [],
    fatture_emesse: [],
    riconciliazione_movimenti: [],
    incassi: [],
    valutazioni: [],
    pagelle: [],
    scrutinio_giudizi: [],
    scrutinio_comportamento: [],
    note_disciplinari: [],
    certificati_competenze: [],
    certificati_medici: [],
    student_documents: [],
    galleria_media_v2: [],
    news_posts: [],
    chat_threads: [],
    chat_messages: [],
    ...extra,
  }
}

describe('scelteDisponibili — la tabella delle decisioni del titolare', () => {
  it('nessun pagamento e nessun registro: solo «elimina»', () => {
    expect(scelteDisponibili({ pagamenti: 0, pagamenti_bloccati: 0, registro_primaria: false })).toEqual({
      scelte: { elimina: true, elimina_con_pagamenti: false, anonimizza: false },
      motivo: null,
    })
  })

  it('pagamenti cancellabili: «cancella anche i pagamenti» oppure «anonimizza»', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 0, registro_primaria: false })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: true, anonimizza: true },
      motivo: 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI',
    })
  })

  it('un pagamento bloccato: resta solo «anonimizza»', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 1, registro_primaria: false })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: true },
      motivo: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI',
    })
  })

  it('il registro della primaria vince su tutto: nessuna scelta, nemmeno anonimizzare', () => {
    expect(scelteDisponibili({ pagamenti: 2, pagamenti_bloccati: 0, registro_primaria: true })).toEqual({
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'REGISTRO_PRIMARIA_DA_CONSERVARE',
    })
  })
})

describe('contaPerEliminazione', () => {
  it('conta presenze, legami e pagamenti, e dice se il registro c’è', async () => {
    const esito = await contaPerEliminazione(creaFintoSupabase(db()) as never, AL, 'test')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.conteggi).toMatchObject({
      presenze: 1,
      diario: 0,
      legami_genitori: 1,
      pagamenti: 0,
      pagamenti_bloccati: 0,
      registro_primaria: false,
    })
  })

  it('un pagamento con incasso è BLOCCATO, uno senza no', async () => {
    const supabase = creaFintoSupabase(
      db({
        pagamenti: [
          { id: 'pag-1', alunno_id: AL, parent_payment_id: null },
          { id: 'pag-2', alunno_id: AL, parent_payment_id: null },
        ],
        incassi: [{ id: 'inc-1', pagamento_id: 'pag-1' }],
      }),
    )
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti: 2, pagamenti_bloccati: 1 })
  })

  it('la quota di un fratello appesa a un suo pagamento lo blocca', async () => {
    const supabase = creaFintoSupabase(
      db({
        pagamenti: [
          { id: 'pag-1', alunno_id: AL, parent_payment_id: null },
          { id: 'pag-f', alunno_id: FRATELLO, parent_payment_id: 'pag-1' },
        ],
      }),
    )
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti: 1, pagamenti_bloccati: 1 })
  })

  it('una ricevuta senza pagamento conta come contabilità bloccata', async () => {
    const supabase = creaFintoSupabase(db({ ricevute_emesse: [{ id: 'r-1', alunno_id: AL, pagamento_id: null }] }))
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok && esito.conteggi).toMatchObject({ pagamenti_bloccati: 1 })
  })

  it('una lettura fallita non diventa uno zero: ok=false', async () => {
    const supabase = creaFintoSupabase(db(), [], { errori: { presenze: { code: '57014', message: 'timeout' } } })
    const esito = await contaPerEliminazione(supabase as never, AL, 'test')
    expect(esito.ok).toBe(false)
  })
})
```

Nota per chi esegue: `contaCosaDistrugge` legge altre tabelle (pagelle, certificati, fascicolo, galleria, news, chat). Se il finto risponde con un errore su una tabella che `db()` non dichiara, aggiungila vuota in `db()` — la lista sopra copre quelle note al 2026-10-08.

- [ ] **Step 3: Eseguilo e verifica che fallisca**

Run: `npx vitest run __tests__/lib/elimina-definitivo.test.ts`
Expected: FAIL — modulo `@/lib/alunni/elimina-definitivo` assente.

- [ ] **Step 4: Scrivi l'implementazione**

```ts
// src/lib/alunni/elimina-definitivo.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { contaCosaDistrugge, type ConteggiOblio } from '@/lib/gdpr/cosa-distrugge'
import {
  BUCKET_ISCRIZIONI,
  obliaAllegatiChat,
  obliaCertificatiMediciAlunno,
  obliaFascicoloAlunno,
  obliaFotoAlunno,
  obliaIntentiVideoAlunno,
} from '@/lib/gdpr/esegui'
import { obliaFotoNewsAlunno } from '@/lib/news/permanenza-consenso'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'
import { leggiRegistroPrimaria } from '@/lib/alunni/registro-primaria'
import { logErrore } from '@/lib/logging/logger'

// =============================================================================
// ELIMINAZIONE DEFINITIVA — il motore della route `admin/students/elimina`.
//
// Tre pezzi, ognuno con un compito solo:
//  · `contaPerEliminazione` — SOLE `SELECT`: che cosa è collegato alla scheda.
//    Dove non riesce a leggere risponde `ok: false`, mai uno zero: davanti a
//    un'operazione senza annulla «non lo so» non può travestirsi da «niente».
//  · `scelteDisponibili` — pura: dai numeri alle scelte offerte, con il motivo.
//    È la tabella delle decisioni del titolare (2026-10-08), in un posto solo.
//  · `rimuoviFileAlunno` — i FILE, prima del database, con le stesse funzioni
//    dell'oblio (nessuna copia: `gdpr-erase-canale-unico`). Le pagelle non ci
//    sono perché il registro della primaria blocca l'eliminazione a monte.
// =============================================================================

export type SceltaEliminazione = 'elimina' | 'elimina_con_pagamenti' | 'anonimizza'

export type MotivoBloccoEliminazione =
  | 'REGISTRO_PRIMARIA_DA_CONSERVARE'
  | 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI'
  | 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI'

export interface ConteggiEliminazione extends ConteggiOblio {
  presenze: number
  diario: number
  legami_genitori: number
  pagamenti: number
  /** Pagamenti con ricevuta, fattura, bonifico abbinato, incasso o quote altrui + ricevute senza pagamento. */
  pagamenti_bloccati: number
  registro_primaria: boolean
}

export type EsitoMisura = { ok: true; conteggi: ConteggiEliminazione } | { ok: false }

export function scelteDisponibili(c: {
  pagamenti: number
  pagamenti_bloccati: number
  registro_primaria: boolean
}): { scelte: Record<SceltaEliminazione, boolean>; motivo: MotivoBloccoEliminazione | null } {
  if (c.registro_primaria) {
    return {
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'REGISTRO_PRIMARIA_DA_CONSERVARE',
    }
  }
  if (c.pagamenti > 0 || c.pagamenti_bloccati > 0) {
    const bloccati = c.pagamenti_bloccati > 0
    return {
      scelte: { elimina: false, elimina_con_pagamenti: !bloccati, anonimizza: true },
      motivo: bloccati ? 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI' : 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI',
    }
  }
  return { scelte: { elimina: true, elimina_con_pagamenti: false, anonimizza: false }, motivo: null }
}

async function conta(
  supabase: SupabaseClient,
  tabella: string,
  colonna: string,
  id: string,
  op: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from(tabella)
    .select(colonna, { count: 'exact', head: true })
    .eq(colonna, id)
  if (error) {
    logErrore({ operazione: op, evento: `elimina_conta_${tabella}` }, error)
    return null
  }
  return count ?? 0
}

async function idsDove(
  supabase: SupabaseClient,
  tabella: string,
  colonnaId: string,
  colonnaFiltro: string,
  valori: string[],
  op: string,
): Promise<Set<string> | null> {
  if (valori.length === 0) return new Set()
  const { data, error } = await supabase.from(tabella).select(colonnaId).in(colonnaFiltro, valori)
  if (error) {
    logErrore({ operazione: op, evento: `elimina_blocchi_${tabella}` }, error)
    return null
  }
  return new Set(
    ((data ?? []) as unknown as Record<string, unknown>[])
      .map((r) => r[colonnaId])
      .filter((v): v is string => typeof v === 'string'),
  )
}

export async function contaPerEliminazione(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<EsitoMisura> {
  const oblio = await contaCosaDistrugge(supabase, alunnoId, op)
  if (Object.values(oblio).some((v) => v === null)) return { ok: false }

  const presenze = await conta(supabase, 'presenze', 'alunno_id', alunnoId, op)
  const diario = await conta(supabase, 'eventi_diario', 'alunno_id', alunnoId, op)
  const legami = await conta(supabase, 'student_parents', 'student_id', alunnoId, op)
  if (presenze === null || diario === null || legami === null) return { ok: false }

  const { data: pag, error: pagErr } = await supabase
    .from('pagamenti')
    .select('id')
    .eq('alunno_id', alunnoId)
  if (pagErr) {
    logErrore({ operazione: op, evento: 'elimina_conta_pagamenti' }, pagErr)
    return { ok: false }
  }
  const pagIds = ((pag ?? []) as { id: string }[]).map((p) => p.id)

  // Quali pagamenti sono contabilità vera: stessa regola della funzione SQL.
  const bloccati = new Set<string>()
  for (const [tabella] of [['ricevute_emesse'], ['fatture_emesse'], ['riconciliazione_movimenti'], ['incassi']] as const) {
    const ids = await idsDove(supabase, tabella, 'pagamento_id', 'pagamento_id', pagIds, op)
    if (ids === null) return { ok: false }
    ids.forEach((id) => bloccati.add(id))
  }
  if (pagIds.length > 0) {
    const { data: figli, error: figliErr } = await supabase
      .from('pagamenti')
      .select('parent_payment_id, alunno_id')
      .in('parent_payment_id', pagIds)
    if (figliErr) {
      logErrore({ operazione: op, evento: 'elimina_blocchi_quote' }, figliErr)
      return { ok: false }
    }
    for (const f of (figli ?? []) as { parent_payment_id: string | null; alunno_id: string | null }[]) {
      if (f.parent_payment_id && f.alunno_id !== alunnoId) bloccati.add(f.parent_payment_id)
    }
  }
  const ricevuteSenzaPagamento = await supabase
    .from('ricevute_emesse')
    .select('id, pagamento_id')
    .eq('alunno_id', alunnoId)
  if (ricevuteSenzaPagamento.error) {
    logErrore({ operazione: op, evento: 'elimina_conta_ricevute' }, ricevuteSenzaPagamento.error)
    return { ok: false }
  }
  const orfane = ((ricevuteSenzaPagamento.data ?? []) as { pagamento_id: string | null }[]).filter(
    (r) => r.pagamento_id === null || !pagIds.includes(r.pagamento_id),
  ).length

  const registro = await leggiRegistroPrimaria(supabase, alunnoId)
  if (!registro.ok) {
    logErrore({ operazione: op, evento: 'elimina_registro_primaria' }, registro.errore)
    return { ok: false }
  }

  return {
    ok: true,
    conteggi: {
      ...oblio,
      presenze,
      diario,
      legami_genitori: legami,
      pagamenti: pagIds.length,
      pagamenti_bloccati: bloccati.size + orfane,
      registro_primaria: registro.presente,
    },
  }
}

export interface EsitoFileAlunno {
  ok: boolean
  numeri: {
    foto_rimosse: number
    foto_sganciate: number
    news_ritirate: number
    certificati: number
    fascicolo: number
    allegati_chat: number
    documento: number
    restanti: number
  }
}

/**
 * Toglie i FILE del bambino, PRIMA del database. `ok: false` se anche un solo
 * file non è uscito o un inventario non si è potuto leggere: allora la route si
 * ferma e la scheda resta intatta.
 */
export async function rimuoviFileAlunno(
  supabase: SupabaseClient,
  alunno: { id: string; documento_path?: string | null },
  op: string,
): Promise<EsitoFileAlunno> {
  const foto = await obliaFotoAlunno(supabase, alunno.id, op)
  const news = await obliaFotoNewsAlunno(supabase, alunno.id, op)
  const video = await obliaIntentiVideoAlunno(supabase, alunno.id, op)
  const certificati = await obliaCertificatiMediciAlunno(supabase, alunno.id, op)
  const fascicolo = await obliaFascicoloAlunno(supabase, alunno.id, op)

  const { data: thread, error: threadErr } = await supabase
    .from('chat_threads')
    .select('id')
    .eq('student_id', alunno.id)
  if (threadErr) logErrore({ operazione: op, evento: 'elimina_thread_chat' }, threadErr)
  const chat = threadErr
    ? { rimossi: 0, nonRimossi: 0, fermi: [], letto: false }
    : await obliaAllegatiChat(supabase, ((thread ?? []) as { id: string }[]).map((t) => t.id), op)

  const documento = await rimuoviEVerifica(supabase, BUCKET_ISCRIZIONI, [alunno.documento_path], op)
  const documentoRestanti = bloccanti(documento).length + (documento.erroreRimozione ? 1 : 0)

  const restanti =
    foto.fileNonRimossi + news.fileNonRimossi + certificati.nonRimossi + fascicolo.nonRimossi + chat.nonRimossi + documentoRestanti
  const tuttoLetto = foto.letto && news.letto && video.letto && certificati.letto && fascicolo.letto && chat.letto

  return {
    ok: tuttoLetto && restanti === 0,
    numeri: {
      foto_rimosse: foto.fotoRimosse,
      foto_sganciate: foto.fotoSganciate,
      news_ritirate: news.ritirati,
      certificati: certificati.rimossi,
      fascicolo: fascicolo.rimossi,
      allegati_chat: chat.rimossi,
      documento: documento.rimossi.length,
      restanti,
    },
  }
}
```

Prima di compilare, verifica le firme reali (possono essere cambiate): `grep -n "export async function obliaFotoNewsAlunno" -A12 src/lib/news/permanenza-consenso.ts` (campi `ritirati`, `fileNonRimossi`, `letto`) e `sed -n 47,60p src/lib/storage/rimozione-verificata.ts` (`EsitoRimozione`). Adatta i nomi dei campi se differiscono, senza cambiare la regola `ok = tutto letto && nessun file restante`.

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `npx vitest run __tests__/lib/elimina-definitivo.test.ts`
Expected: PASS, 9 test. Poi `npx tsc --noEmit` → nessun errore nei due file nuovi.

- [ ] **Step 6: Commit**

```bash
git add src/lib/alunni/archiviazione.ts src/lib/alunni/elimina-definitivo.ts __tests__/lib/elimina-definitivo.test.ts
git commit -m "$(printf 'Eliminazione definitiva: ruoli, misura di cosa è collegato, scelte e rimozione dei file\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 4: I codici d'errore e le loro frasi

**Files:**
- Modify: `src/lib/ui/esito-fetch.ts` (dentro `CODICI_ERRORE`, dopo `ALUNNO_NON_ARCHIVIATO`)
- Modify: `messages/it/shared.json`, `messages/en/shared.json`

- [ ] **Step 1: Aggiungi i codici** in `CODICI_ERRORE`, subito dopo la voce `ALUNNO_NON_ARCHIVIATO: 'erroreAlunnoNonArchiviato',`:

```ts
    /** 404 — l'eliminazione definitiva non trova più l'alunno in elenco (`admin/students/elimina:POST`). */
    ALUNNO_ELIMINAZIONE_NON_TROVATO: 'erroreAlunnoEliminazioneNonTrovato',
    /** 409 — si elimina solo un ritirato o un iscritto senza sezione: questo frequenta. */
    ALUNNO_ELIMINAZIONE_FREQUENTANTE: 'erroreAlunnoEliminazioneFrequentante',
    /** 400 — `execute` senza `scelta`. */
    ALUNNO_ELIMINAZIONE_SCELTA_MANCANTE: 'erroreAlunnoEliminazioneSceltaMancante',
    /** 409 — la scelta inviata non è fra quelle che l'anteprima offre per questo bambino. */
    ALUNNO_ELIMINAZIONE_SCELTA_NON_DISPONIBILE: 'erroreAlunnoEliminazioneSceltaNonDisponibile',
    /** 409 — ci sono pagamenti: si sceglie se cancellarli o anonimizzare. */
    ALUNNO_ELIMINAZIONE_HA_PAGAMENTI: 'erroreAlunnoEliminazioneHaPagamenti',
    /** 409 — un pagamento ha ricevuta, fattura, bonifico abbinato, incasso o quote altrui: non si cancella. */
    ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI: 'erroreAlunnoEliminazionePagamentiBloccati',
    /**
     * 409 — il registro della primaria (voti, pagelle, scrutini, note, certificati delle
     * competenze) va conservato: né eliminazione né anonimizzazione. Lo usano
     * `admin/students/elimina:POST` e `admin/gdpr/erase:POST`: una regola, una frase.
     */
    REGISTRO_PRIMARIA_DA_CONSERVARE: 'erroreRegistroPrimariaDaConservare',
    /** 500 — non si è potuto misurare cosa è collegato: non si elimina niente. */
    ALUNNO_ELIMINAZIONE_NON_MISURATA: 'erroreAlunnoEliminazioneNonMisurata',
    /** 502 — alcuni file non sono usciti dall'archivio: la scheda resta intatta. */
    ALUNNO_ELIMINAZIONE_FILE_RESTANTI: 'erroreAlunnoEliminazioneFileRestanti',
    /** 500 — guasto durante l'eliminazione: la transazione è annullata, la scheda è intatta. */
    ALUNNO_ELIMINAZIONE_NON_RIUSCITA: 'erroreAlunnoEliminazioneNonRiuscita',
    /** 503 — la funzione SQL non esiste su questo database (DB E2E non migrato). */
    ALUNNO_ELIMINAZIONE_NON_DISPONIBILE: 'erroreAlunnoEliminazioneNonDisponibile',
```

- [ ] **Step 2: Aggiungi le frasi** in `messages/it/shared.json`, ciascuna nella sua posizione alfabetica (senza spostare le altre chiavi):

```json
  "erroreAlunnoEliminazioneFileRestanti": "Alcuni file non sono usciti dall’archivio: la scheda non è stata eliminata. Riprova fra qualche minuto.",
  "erroreAlunnoEliminazioneFrequentante": "Si elimina solo un bambino ritirato o senza sezione: questo frequenta ancora.",
  "erroreAlunnoEliminazioneHaPagamenti": "Questo bambino ha dei pagamenti: scegli se cancellarli o anonimizzare la scheda.",
  "erroreAlunnoEliminazioneNonDisponibile": "L’eliminazione definitiva non è disponibile su questo ambiente: nessuna modifica è stata fatta.",
  "erroreAlunnoEliminazioneNonMisurata": "Non è stato possibile leggere che cosa è collegato alla scheda: non è stato eliminato niente. Riprova.",
  "erroreAlunnoEliminazioneNonRiuscita": "Eliminazione non riuscita: la scheda è rimasta com’era. Riprova.",
  "erroreAlunnoEliminazioneNonTrovato": "Questo bambino non è più in elenco: ricarica la pagina.",
  "erroreAlunnoEliminazionePagamentiBloccati": "Uno o più pagamenti hanno una ricevuta, una fattura, un bonifico abbinato o un incasso registrato: non si possono cancellare. Puoi anonimizzare la scheda.",
  "erroreAlunnoEliminazioneSceltaMancante": "Scegli che cosa fare prima di confermare.",
  "erroreAlunnoEliminazioneSceltaNonDisponibile": "Questa scelta non è disponibile per questo bambino: riapri la finestra.",
  "erroreRegistroPrimariaDaConservare": "Il registro della primaria (voti, pagelle, scrutini, note) va conservato per legge: questa scheda non si elimina e non si anonimizza.",
```

e in `messages/en/shared.json`:

```json
  "erroreAlunnoEliminazioneFileRestanti": "Some files could not be removed from storage: the record was not deleted. Try again in a few minutes.",
  "erroreAlunnoEliminazioneFrequentante": "Only a withdrawn child or one without a class can be deleted: this child still attends.",
  "erroreAlunnoEliminazioneHaPagamenti": "This child has payments: choose whether to delete them or anonymise the record.",
  "erroreAlunnoEliminazioneNonDisponibile": "Permanent deletion is not available in this environment: nothing was changed.",
  "erroreAlunnoEliminazioneNonMisurata": "We could not read what is linked to this record: nothing was deleted. Please try again.",
  "erroreAlunnoEliminazioneNonRiuscita": "Deletion failed: the record is unchanged. Please try again.",
  "erroreAlunnoEliminazioneNonTrovato": "This child is no longer listed: reload the page.",
  "erroreAlunnoEliminazionePagamentiBloccati": "One or more payments have a receipt, an invoice, a matched bank transfer or a recorded collection: they cannot be deleted. You can anonymise the record.",
  "erroreAlunnoEliminazioneSceltaMancante": "Choose what to do before confirming.",
  "erroreAlunnoEliminazioneSceltaNonDisponibile": "This option is not available for this child: reopen the window.",
  "erroreRegistroPrimariaDaConservare": "The primary school register (marks, report cards, assessments, notes) must be kept by law: this record cannot be deleted or anonymised.",
```

- [ ] **Step 3: Verifica i lock dei codici e dei cataloghi**

Run: `npx vitest run __tests__/architecture/errori-con-codice.test.ts`
Expected: PASS (i codici non sono ancora usati da nessuna route; se il lock pretende che ogni codice dichiarato sia usato, rimanda la verifica alla fine del Task 5).
Run: `grep -rl "messages" __tests__/architecture | xargs grep -l "shared.json" | head` e lancia i test di parità dei cataloghi trovati. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ui/esito-fetch.ts messages/it/shared.json messages/en/shared.json
git commit -m "$(printf 'Codici d’errore dell’eliminazione definitiva e del registro della primaria\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 5: La route `POST /api/admin/students/elimina`

**Files:**
- Create: `src/app/api/admin/students/elimina/route.ts`
- Test: `__tests__/api/admin-students-elimina.test.ts`
- Modify (lock): `__tests__/architecture/isolamento-sede-coverage.test.ts`, `__tests__/architecture/registro-modifiche-senza-hard-delete.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Usa come stampo `__tests__/api/admin-students-libera-spazio.test.ts` (righe 1-160: `vi.hoisted`, mock di `require-staff`, `scope`, `audit/scrittura`, `logger`, `server-client` con `storage` finto). Il file:

```ts
// __tests__/api/admin-students-elimina.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// `POST /api/admin/students/elimina` — l'eliminazione definitiva dai «non iscritti».
// Le asserzioni sono sulla MUTAZIONE (che cosa è stato chiamato, scritto,
// tolto dai bucket) e sull'ORDINE: i file prima, il database dopo, la traccia
// solo a cose fatte. Un 200 da solo non dice niente.
// =============================================================================

const AL = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ISCRITTO = 'c3c3c3c3-3333-4333-8333-cccccccccccc'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  anonimizzaAlunno: vi.fn(),
  bonificaAuditScritture: vi.fn(),
  rpc: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  rimossi: [] as { bucket: string; percorsi: string[] }[],
  bloccati: [] as string[],
  ordine: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({
  logScrittura: (...a: unknown[]) => { h.ordine.push('audit'); return h.logScrittura(...a) },
}))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/gdpr/esegui', async (originale) => {
  const vero = await originale<typeof import('@/lib/gdpr/esegui')>()
  return {
    ...vero,
    anonimizzaAlunno: h.anonimizzaAlunno,
    bonificaAuditScritture: (...a: unknown[]) => { h.ordine.push('bonifica'); return h.bonificaAuditScritture(...a) },
  }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const client = () => {
    const base = creaFintoSupabase(h.db as DBFinto, [], {
      scritture: h.scritture as Scrittura[],
      rpc: {
        elimina_alunno_definitivo: (args) => { h.ordine.push('rpc'); return h.rpc(args) },
        video_intent_oblio_alunno: () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }),
      },
    }) as unknown as Record<string, unknown>
    base.storage = {
      from: (bucket: string) => ({
        remove: async (percorsi: string[]) => {
          h.ordine.push('storage')
          h.rimossi.push({ bucket, percorsi })
          return { data: percorsi.filter((p) => !h.bloccati.includes(p)).map((p) => ({ name: p })), error: null }
        },
        list: async (cartella: string, opzioni?: { search?: string }) => {
          const nome = opzioni?.search ?? ''
          const pieno = cartella ? `${cartella}/${nome}` : nome
          return { data: h.bloccati.includes(pieno) ? [{ name: nome }] : [], error: null }
        },
      }),
    }
    return base
  }
  return { createAdminClient: async () => client(), createClient: async () => client() }
})

import { POST } from '@/app/api/admin/students/elimina/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/students/elimina', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

function dbDiProva(): Record<string, Record<string, unknown>[]> {
  return {
    utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SEDE_A }],
    utenti_scuole: [],
    alunni: [
      { id: AL, nome: 'Bambino', cognome: 'DiProva', stato: 'ritirato', scuola_id: SEDE_A, section_id: null,
        anonimizzato_il: null, documento_path: 'iscrizioni/doc-finto.pdf', codice_fiscale: null, fiscal_code: null },
      { id: ISCRITTO, nome: 'Altro', cognome: 'DiProva', stato: 'iscritto', scuola_id: SEDE_A, section_id: 'sez-1',
        anonimizzato_il: null, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ],
    presenze: [{ id: 'pr-1', alunno_id: AL }],
    eventi_diario: [],
    student_parents: [{ student_id: AL, parent_id: 'p-1' }],
    pagamenti: [], ricevute_emesse: [], fatture_emesse: [], riconciliazione_movimenti: [], incassi: [],
    valutazioni: [], pagelle: [], scrutinio_giudizi: [], scrutinio_comportamento: [], note_disciplinari: [],
    certificati_competenze: [], certificati_medici: [], student_documents: [], galleria_media_v2: [],
    news_posts: [], chat_threads: [], chat_messages: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.rpc.mockReturnValue({ data: { ok: true, code: 'eliminato', righe: { legami: 0 } }, error: null })
  h.anonimizzaAlunno.mockResolvedValue({ riconciliazione: 0, incassi: 0, cassa: 0, file: 0 })
  h.bonificaAuditScritture.mockResolvedValue(0)
  h.db = dbDiProva()
  h.scritture = []
  h.rimossi = []
  h.bloccati = []
  h.ordine = []
})

describe('POST /api/admin/students/elimina — chi, su chi', () => {
  it('il gate riceve ESATTAMENTE [admin, coordinator, segreteria]', async () => {
    await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(h.requireStaff.mock.calls[0][1]).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it('403 dal gate: nessuna lettura, nessun effetto', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
  })

  it('fuori sede: rifiuto e nessun effetto', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-b', role: 'segreteria', scuola_id: SEDE_B } })
    h.db.utenti = [{ id: 'seg-b', ruolo: 'segreteria', scuola_id: SEDE_B }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBeGreaterThanOrEqual(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('chi FREQUENTA non si elimina: 409 ALUNNO_ELIMINAZIONE_FREQUENTANTE', async () => {
    const res = await POST(req({ alunno_id: ISCRITTO, mode: 'dryrun' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_FREQUENTANTE')
  })

  it('execute senza scelta: 400 ALUNNO_ELIMINAZIONE_SCELTA_MANCANTE', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute' }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_SCELTA_MANCANTE')
  })
})

describe('dryrun', () => {
  it('conta e propone le scelte, SENZA scrivere niente', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({
      dryrun: true,
      conteggi: { presenze: 1, legami_genitori: 1, pagamenti: 0, registro_primaria: false },
      scelte: { elimina: true, elimina_con_pagamenti: false, anonimizza: false },
      motivo: null,
    })
    expect(h.scritture).toEqual([])
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('con il registro della primaria: nessuna scelta, motivo REGISTRO_PRIMARIA_DA_CONSERVARE', async () => {
    h.db.valutazioni = [{ id: 'v-1', alunno_id: AL }]
    const j = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(j.scelte).toEqual({ elimina: false, elimina_con_pagamenti: false, anonimizza: false })
    expect(j.motivo).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
  })
})

describe('execute', () => {
  it('ORDINE: file → funzione SQL → bonifica audit → traccia', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith({ p_alunno: AL, p_con_pagamenti: false })
    const primoRpc = h.ordine.indexOf('rpc')
    expect(h.ordine.lastIndexOf('storage')).toBeLessThan(primoRpc)
    expect(h.ordine.indexOf('bonifica')).toBeGreaterThan(primoRpc)
    expect(h.ordine.indexOf('audit')).toBeGreaterThan(h.ordine.indexOf('bonifica'))
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunno_eliminato', azione: 'delete', entitaId: AL, scuolaId: SEDE_A }),
    )
  })

  it('la traccia non contiene la riga dell’alunno: niente nome, cognome, percorso', async () => {
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    const testo = JSON.stringify(h.logScrittura.mock.calls[0][1])
    expect(testo).not.toContain('DiProva')
    expect(testo).not.toContain('doc-finto')
  })

  it('un file che non esce ferma TUTTO prima del database: 502 e nessuna traccia', async () => {
    h.bloccati = ['iscrizioni/doc-finto.pdf']
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(502)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_FILE_RESTANTI')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('il database rifiuta (corsa: è arrivato un voto): 409 col codice giusto e nessuna traccia', async () => {
    h.rpc.mockReturnValue({ data: { ok: false, code: 'registro_primaria' }, error: null })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.bonificaAuditScritture).not.toHaveBeenCalled()
  })

  it('funzione assente (DB non migrato): 503 ALUNNO_ELIMINAZIONE_NON_DISPONIBILE', async () => {
    h.rpc.mockReturnValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_NON_DISPONIBILE')
  })

  it('una scelta non offerta dall’anteprima: 409 e nessun effetto', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina_con_pagamenti' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_SCELTA_NON_DISPONIBILE')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('con pagamenti cancellabili: «elimina_con_pagamenti» passa p_con_pagamenti=true', async () => {
    h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina_con_pagamenti' }))
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith({ p_alunno: AL, p_con_pagamenti: true })
  })

  it('«anonimizza» chiama la funzione dell’oblio sul solo bambino, mai la RPC', async () => {
    h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
    h.db.incassi = [{ id: 'inc-1', pagamento_id: 'pag-1' }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(200)
    expect(h.anonimizzaAlunno).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: AL }),
      expect.any(String),
      'admin/students/elimina:POST',
    )
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunno_anonimizzato' }),
    )
  })

  it('il successo lascia un log, con soli identificativi', async () => {
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'gdpr',
      'info',
      expect.objectContaining({ esito: 'alunno-eliminato', entita_id: AL }),
    )
  })
})
```

- [ ] **Step 2: Eseguilo e verifica che fallisca**

Run: `npx vitest run __tests__/api/admin-students-elimina.test.ts`
Expected: FAIL — modulo della route assente.

- [ ] **Step 3: Scrivi la route**

```ts
// src/app/api/admin/students/elimina/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { anonimizzaAlunno, bonificaAuditScritture } from '@/lib/gdpr/esegui'
import { eNonPiuIscritto } from '@/lib/alunni/stato'
import { RUOLI_ELIMINA_DEFINITIVO } from '@/lib/alunni/archiviazione'
import { contaPerEliminazione, rimuoviFileAlunno, scelteDisponibili } from '@/lib/alunni/elimina-definitivo'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// ELIMINAZIONE DEFINITIVA — dall'elenco dei «non iscritti» (2026-10-08).
//
// Decisione del titolare: segreteria e Direzione eliminano DAVVERO una scheda
// ritirata o senza sezione — un doppione, un adulto inserito come bambino.
// Con pagamenti la segreteria sceglie: cancellarli (solo se non sono
// contabilità emessa) oppure anonimizzare. Il registro della primaria non si
// tocca mai.
//
// ─── L'ORDINE È LA DIFESA ───────────────────────────────────────────────────
//  1. gate di ruolo e di sede, poi la scheda letta con la sede accanto;
//  2. la MISURA (sole SELECT): da lì le scelte disponibili;
//  3. i FILE, con le funzioni dell'oblio: se uno solo non esce ci si ferma, e
//     il database non è stato toccato;
//  4. il DATABASE, in UNA transazione (`elimina_alunno_definitivo`), che
//     ricontrolla tutto da sé;
//  5. SOLO DOPO un `ok: true`, la bonifica delle vecchie copie nel registro
//     delle scritture e la traccia nuova — uuid e numeri, mai la riga.
// Il 2026-08-12 una cancellazione era stata tolta perché scriveva la traccia
// PRIMA di una DELETE che falliva (lock `registro-modifiche-senza-hard-delete`).
// =============================================================================

const postBodySchema = z.object({
  alunno_id: z.string().uuid(),
  mode: z.enum(['dryrun', 'execute']),
  scelta: z.enum(['elimina', 'elimina_con_pagamenti', 'anonimizza']).optional(),
})

const OP = 'admin/students/elimina:POST'

/** Il rifiuto della funzione SQL → la risposta. I codici sono quelli di `CODICI_ERRORE`. */
const RIFIUTI_DB: Record<string, { status: number; codice: string }> = {
  non_trovato: { status: 404, codice: 'ALUNNO_ELIMINAZIONE_NON_TROVATO' },
  frequentante: { status: 409, codice: 'ALUNNO_ELIMINAZIONE_FREQUENTANTE' },
  gia_anonimizzato: { status: 409, codice: 'ALUNNO_ELIMINAZIONE_FREQUENTANTE' },
  registro_primaria: { status: 409, codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE' },
  ha_pagamenti: { status: 409, codice: 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI' },
  pagamenti_non_cancellabili: { status: 409, codice: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI' },
}

const ERRORE_INTERNO = { error: 'Errore interno', codice: 'ALUNNO_ELIMINAZIONE_NON_RIUSCITA' }

export const POST = withRoute('admin/students/elimina:POST', async (request: Request) => {
  const auth = await requireStaff(request, [...RUOLI_ELIMINA_DEFINITIVO])
  if (auth.response) return auth.response

  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { alunno_id, mode, scelta } = b.data

  if (mode === 'execute' && !scelta) {
    return NextResponse.json(
      { error: 'Scegli che cosa fare', codice: 'ALUNNO_ELIMINAZIONE_SCELTA_MANCANTE' },
      { status: 400 },
    )
  }

  try {
    const supabase = await createAdminClient()

    const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunno_id)
    if (fuoriScope) return fuoriScope

    // La sede ACCANTO al gate: due reti, non una — a valle c'è una cancellazione
    // che non torna indietro.
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('id, stato, section_id, scuola_id, anonimizzato_il, documento_path, codice_fiscale, fiscal_code')
      .eq('id', alunno_id)
      .in('scuola_id', plessi)
      .maybeSingle()
    if (alunnoErr) {
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, alunnoErr)
      return NextResponse.json(ERRORE_INTERNO, { status: 500 })
    }
    if (!alunno) {
      logEvento('multi_sede', 'warn', {
        operazione: OP,
        esito: 'alunno-non-piu-in-scope',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
      })
      return NextResponse.json(
        { error: 'Alunno non trovato', codice: 'ALUNNO_ELIMINAZIONE_NON_TROVATO' },
        { status: 404 },
      )
    }

    // Solo dai «non iscritti»: ritirato (elenco chiuso) oppure senza sezione.
    const nonIscritto = eNonPiuIscritto(alunno.stato as string | null) || alunno.section_id == null
    if (alunno.anonimizzato_il != null || !nonIscritto) {
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-rifiutata-frequentante',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        tipo: (alunno.stato as string | null) ?? 'assente',
      })
      return NextResponse.json(
        { error: 'Si elimina solo un bambino ritirato o senza sezione', codice: 'ALUNNO_ELIMINAZIONE_FREQUENTANTE' },
        { status: 409 },
      )
    }

    const misura = await contaPerEliminazione(supabase, alunno_id, OP)
    if (!misura.ok) {
      return NextResponse.json(
        { error: 'Misura non riuscita', codice: 'ALUNNO_ELIMINAZIONE_NON_MISURATA' },
        { status: 500 },
      )
    }
    const { scelte, motivo } = scelteDisponibili(misura.conteggi)

    if (mode === 'dryrun') {
      return NextResponse.json({ dryrun: true, conteggi: misura.conteggi, scelte, motivo })
    }

    const sceltaFatta = scelta!
    if (!scelte[sceltaFatta]) {
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-scelta-non-disponibile',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        tipo: motivo ?? sceltaFatta,
      })
      return NextResponse.json(
        motivo === 'REGISTRO_PRIMARIA_DA_CONSERVARE'
          ? { error: 'Registro della primaria da conservare', codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE' }
          : { error: 'Scelta non disponibile', codice: 'ALUNNO_ELIMINAZIONE_SCELTA_NON_DISPONIBILE' },
        { status: 409 },
      )
    }

    // ─── ANONIMIZZA: la stessa funzione dell'oblio, sul solo bambino ───────
    if (sceltaFatta === 'anonimizza') {
      const esito = await anonimizzaAlunno(
        supabase,
        {
          id: alunno_id,
          documento_path: (alunno.documento_path as string | null) ?? null,
          codice_fiscale: (alunno.codice_fiscale as string | null) ?? null,
          fiscal_code: (alunno.fiscal_code as string | null) ?? null,
        },
        new Date().toISOString(),
        OP,
      )
      await logScrittura(supabase, {
        attore: auth.user,
        entitaTipo: 'alunno_anonimizzato',
        entitaId: alunno_id,
        azione: 'update',
        scuolaId: (alunno.scuola_id as string | null) ?? null,
        valoreDopo: { alunno_id, scelta: sceltaFatta, pagamenti: misura.conteggi.pagamenti },
      })
      logEvento('gdpr', 'info', {
        operazione: OP,
        esito: 'alunno-anonimizzato',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
      })
      return NextResponse.json({ ok: true, scelta: sceltaFatta, esito })
    }

    // ─── ELIMINA: prima i file, poi il database ────────────────────────────
    const file = await rimuoviFileAlunno(
      supabase,
      { id: alunno_id, documento_path: (alunno.documento_path as string | null) ?? null },
      OP,
    )
    if (!file.ok) {
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-ferma-file-restanti',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
      })
      return NextResponse.json(
        { error: 'File restanti', codice: 'ALUNNO_ELIMINAZIONE_FILE_RESTANTI', file: file.numeri },
        { status: 502 },
      )
    }

    const { data: rpc, error: rpcErr } = await supabase.rpc('elimina_alunno_definitivo', {
      p_alunno: alunno_id,
      p_con_pagamenti: sceltaFatta === 'elimina_con_pagamenti',
    })
    if (rpcErr) {
      if ((rpcErr as { code?: string }).code === 'PGRST202') {
        logEvento('gdpr', 'error', {
          operazione: OP,
          esito: 'funzione-eliminazione-assente',
          entita_tipo: 'alunni',
          entita_id: alunno_id,
        })
        return NextResponse.json(
          { error: 'Non disponibile', codice: 'ALUNNO_ELIMINAZIONE_NON_DISPONIBILE' },
          { status: 503 },
        )
      }
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, rpcErr)
      return NextResponse.json(ERRORE_INTERNO, { status: 500 })
    }
    const risposta = rpc as { ok?: boolean; code?: string; righe?: Record<string, number> } | null
    if (!risposta?.ok) {
      const rifiuto = RIFIUTI_DB[risposta?.code ?? ''] ?? null
      // I file sono già usciti, la scheda è intatta: un esito onesto, che va
      // registrato perché un secondo tentativo lo completerà.
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'eliminazione-rifiutata-dal-db',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
        tipo: risposta?.code ?? 'risposta-illeggibile',
      })
      if (!rifiuto) return NextResponse.json(ERRORE_INTERNO, { status: 500 })
      return NextResponse.json({ error: 'Eliminazione rifiutata', codice: rifiuto.codice }, { status: rifiuto.status })
    }

    // ─── SOLO ORA la traccia ────────────────────────────────────────────────
    await bonificaAuditScritture(supabase, [alunno_id], OP)
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'alunno_eliminato',
      entitaId: alunno_id,
      azione: 'delete',
      scuolaId: (alunno.scuola_id as string | null) ?? null,
      valoreDopo: { alunno_id, scelta: sceltaFatta, righe: risposta.righe ?? {}, file: file.numeri },
    })
    logEvento('gdpr', 'info', {
      operazione: OP,
      esito: 'alunno-eliminato',
      entita_tipo: 'alunni',
      entita_id: alunno_id,
    })
    return NextResponse.json({ ok: true, scelta: sceltaFatta, righe: risposta.righe ?? {}, file: file.numeri })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json(ERRORE_INTERNO, { status: 500 })
  }
})
```

Nota: il lock `errori-con-codice` scansiona i letterali `codice: '…'`. Se segnala i valori dentro `RIFIUTI_DB` come non riconosciuti, è perché li legge già (bene); se invece pretende che ogni `codice` sia un letterale **nella risposta**, trasforma `RIFIUTI_DB` in uno `switch` che restituisce `NextResponse.json({ error, codice: '…' }, { status })` per ciascun caso.

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run __tests__/api/admin-students-elimina.test.ts`
Expected: PASS, 15 test. Se `assertAlunnoInScope` sul finto legge tabelle aggiuntive (es. `utenti_scuole`, `schools`), aggiungile vuote in `dbDiProva()` come fa lo stampo.

- [ ] **Step 5: Aggiorna i lock architetturali e guarda cosa dicono**

Run: `npx vitest run __tests__/architecture/ __tests__/api/zod-coverage.test.ts 2>&1 | tail -60`
Expected, e cosa fare:
- `isolamento-sede-coverage.test.ts`: fallisce sui contatori. Aggiorna `routeConServiceRole` (+1) e `handlerControllati` (+1) ai valori che il messaggio stampa, aggiungendo accanto un commento `// +1: admin/students/elimina:POST (2026-10-08)`. **`handlerEsentati` non deve crescere**: se cresce, la route ha perso il gate di sede — correggi la route, non il numero.
- `registro-modifiche-senza-hard-delete.test.ts`: dovrebbe restare verde (la route non scrive `hard_delete_gdpr`). Aggiorna la sola testata del file aggiungendo in fondo al primo blocco di commento un paragrafo:

```ts
 * ─── 2026-10-08: LA CANCELLAZIONE VERA È TORNATA, SENZA LA SUA CAUSA ─────────
 *
 * Il titolare ha chiesto di nuovo di poter eliminare una scheda (doppioni,
 * adulti inseriti come bambini). `admin/students/elimina` lo fa senza ripetere
 * il difetto: la cancellazione è UNA transazione SQL
 * (`elimina_alunno_definitivo`) che prima toglie ogni riga che la bloccherebbe,
 * e la traccia si scrive SOLO dopo una risposta `ok: true`, con uuid e numeri e
 * mai la riga. Questo lock resta: il letterale qui sotto continua a non poter
 * essere scritto da nessuno.
```

- `errori-con-codice.test.ts`: PASS (i codici del Task 4 ora sono usati).
- Ogni altro rosso: leggilo, correggi la route se è un difetto vero; aggiorna un lock solo se il messaggio lo prevede esplicitamente (contatori con commento del delta).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/students/elimina/route.ts __tests__/api/admin-students-elimina.test.ts __tests__/architecture/
git commit -m "$(printf 'Route admin/students/elimina: file prima, database in una transazione, traccia solo a cose fatte\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 6: L'elenco dell'anagrafica — parametro `elenco`

**Files:**
- Modify: `src/app/api/admin/students/route.ts` (schema `getQuerySchema` vicino a riga 58; `runQuery` righe 557-580)
- Modify: `__tests__/architecture/elenchi-operativi-solo-iscritti.test.ts` (riga ~765 `CHIAMANTI_SENZA_STATO`; riga ~812 `conStato`)
- Test: `__tests__/api/admin-students-elenco.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Prendi come stampo l'apertura di `__tests__/api/students-troncamento-visibile.test.ts` (mock di `requireStaff`, `resolveScuoleAttive`/`server-client` col finto) e scrivi:

```ts
// __tests__/api/admin-students-elenco.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

const h = vi.hoisted(() => ({ requireStaff: vi.fn(), db: {} as Record<string, Record<string, unknown>[]> }))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const c = () => creaFintoSupabase(h.db as DBFinto)
  return { createAdminClient: async () => c(), createClient: async () => c() }
})

import { GET } from '@/app/api/admin/students/route'

const riga = (id: string, stato: string, section_id: string | null, anonimizzato_il: string | null = null) => ({
  id, scuola_id: SEDE_A, nome: 'N', cognome: id, data_nascita: null, codice_fiscale: null,
  classe_sezione: section_id ? 'SEZ' : null, stato, section_id, note_mediche: null, allergies: null, allergeni: null,
  archiviato_il: null, archiviato_classe_sezione: null, spazio_liberato_il: null, anonimizzato_il,
})

beforeEach(() => {
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.db = {
    utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SEDE_A }],
    utenti_scuole: [],
    alunni: [
      riga('a-frequenta', 'iscritto', 'sez-1'),
      riga('b-sospeso', 'sospeso', 'sez-1'),
      riga('c-senza-sezione', 'iscritto', null),
      riga('d-ritirato', 'ritirato', null),
      riga('e-anonimizzato', 'ritirato', null, '2026-09-01T00:00:00Z'),
    ],
  }
})

const ids = async (qs: string) => {
  const res = await GET(new Request(`http://localhost/api/admin/students?${qs}`) as never)
  expect(res.status).toBe(200)
  return ((await res.json()) as { id: string }[]).map((r) => r.id).sort()
}

describe('GET /api/admin/students?elenco=…', () => {
  it('frequentanti = iscritti e sospesi CON sezione', async () => {
    expect(await ids('elenco=frequentanti')).toEqual(['a-frequenta', 'b-sospeso'])
  })
  it('non_iscritti = ritirati e senza sezione, anonimizzati esclusi', async () => {
    expect(await ids('elenco=non_iscritti')).toEqual(['c-senza-sezione', 'd-ritirato'])
  })
  it('senza parametro nulla cambia: tutta la sede', async () => {
    expect((await ids('')).length).toBe(5)
  })
  it('un valore sconosciuto è un 400, non «tutto»', async () => {
    const res = await GET(new Request('http://localhost/api/admin/students?elenco=tutti') as never)
    expect(res.status).toBe(400)
  })
})
```

Se `resolveScuoleAttive` legge altro (cookie, header `x-sedi`, tabella `schools`), copia dallo stampo i mock o le tabelle che servono.

- [ ] **Step 2: Eseguilo e verifica che fallisca**

Run: `npx vitest run __tests__/api/admin-students-elenco.test.ts`
Expected: FAIL — `elenco` ignorato (5 righe invece di 2) e nessun 400.

- [ ] **Step 3: Implementa**

In `getQuerySchema` aggiungi la chiave (accanto a `stato`):

```ts
    // Quale ELENCO vuole chi chiama (2026-10-08). Assente = la sede intera, come
    // sempre: pagamenti, sezioni e generatori di categoria non lo passano.
    //  · `frequentanti` — iscritti e sospesi CON una sezione: la linguetta «Alunni»;
    //  · `non_iscritti` — ritirati (elenco chiuso) o senza sezione, anonimizzati
    //    esclusi: la linguetta «Non iscritti».
    elenco: z.enum(['frequentanti', 'non_iscritti']).optional(),
```

Nella destrutturazione di `q.data` aggiungi `elenco`. In `runQuery`, dopo `if (stato) query = query.eq('stato', stato);`:

```ts
            if (elenco === 'frequentanti') {
                query = query.in('stato', [...STATI_CHE_FREQUENTANO]).not('section_id', 'is', null);
            } else if (elenco === 'non_iscritti') {
                query = query
                    .or(`stato.in.(${STATI_NON_PIU_ISCRITTO.join(',')}),section_id.is.null`)
                    .is('anonimizzato_il', null);
            }
```

e importa `STATI_CHE_FREQUENTANO`, `STATI_NON_PIU_ISCRITTO` da `@/lib/alunni/stato` (controlla se il file importa già qualcosa da lì e unisci l'import).

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run __tests__/api/admin-students-elenco.test.ts`
Expected: PASS, 4 test.

- [ ] **Step 5: Insegna al lock che `elenco=` dichiara lo stato**

In `__tests__/architecture/elenchi-operativi-solo-iscritti.test.ts`:
- nella funzione `chiamate()` sostituisci `conStato: /[?&]stato=/.test(url),` con:

```ts
          // `elenco=frequentanti|non_iscritti` (2026-10-08) è un insieme di stati
          // DICHIARATO, esattamente come `stato=`: chi lo passa ha detto chi vuole.
          conStato: /[?&](stato|elenco)=/.test(url),
```

- nel messaggio d'errore del primo `it` aggiungi «(o `elenco=`)» dopo «senza `stato=`».
- **dopo** il Task 9 la chiamata di `page.tsx` passerà `elenco=frequentanti`: allora la voce `'src/app/(dashboard)/admin/students/page.tsx'` di `CHIAMANTI_SENZA_STATO` diventa morta e va **tolta** (il test «nessuna voce morta» lo pretende). Lasciala per ora: la togli nel Task 9.

Run: `npx vitest run __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/students/route.ts __tests__/api/admin-students-elenco.test.ts __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts
git commit -m "$(printf 'Anagrafica: parametro elenco=frequentanti|non_iscritti, senza cambiare chi non lo passa\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 7: L'oblio GDPR non tocca il registro della primaria

**Files:**
- Modify: `src/app/api/admin/gdpr/erase/route.ts` (dopo il blocco `if (!eNonPiuIscritto(alunno.stato)) { … }`, riga ~138)
- Modify: `src/app/api/admin/gdpr/candidates/route.ts` (costruzione di `result`, riga ~153)
- Modify: `src/components/features/admin/settings/OblioPanel.tsx`
- Modify: `messages/it/adminAltro.json`, `messages/en/adminAltro.json`
- Test: `__tests__/api/gdpr-erase-registro-primaria.test.ts`; aggiorna se serve `__tests__/api/gdpr-erase-route.test.ts`, `__tests__/api/gdpr-candidates-route.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

Stampo: le prime ~120 righe di `__tests__/api/gdpr-erase-route.test.ts` (mock e dati). Il test nuovo:

```ts
// __tests__/api/gdpr-erase-registro-primaria.test.ts
// Copia da gdpr-erase-route.test.ts il blocco vi.hoisted/vi.mock e il db di prova,
// con un alunno `ritirato` AL nella sede dell'operatore (Direzione), poi:

describe('oblio GDPR — il registro della primaria si conserva', () => {
  it('dryrun su un bambino con un voto: 409 REGISTRO_PRIMARIA_DA_CONSERVARE, nessuna scrittura', async () => {
    h.db.valutazioni = [{ id: 'v-1', alunno_id: AL }]
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
    expect(h.scritture).toEqual([])
  })

  it('execute con conferma giusta: rifiuta lo stesso, e anonimizzaAlunno non parte', async () => {
    h.db.pagelle = [{ id: 'pg-1', alunno_id: AL, file_url: 'x.pdf' }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', confirm: 'DIPROVA BAMBINO' }))
    expect(res.status).toBe(409)
    expect(h.scritture.filter((s) => (s as { tabella?: string }).tabella === 'alunni')).toEqual([])
  })

  it('una lettura del registro FALLITA ferma l’oblio con 500', async () => {
    // inietta un errore non-schema su `note_disciplinari` con le opzioni `errori` del finto
    h.errori = { note_disciplinari: { code: '57014', message: 'timeout' } }
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(500)
  })

  it('il rifiuto lascia un log', async () => {
    h.db.valutazioni = [{ id: 'v-1', alunno_id: AL }]
    await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(h.logEvento).toHaveBeenCalledWith('gdpr', 'warn', expect.objectContaining({ esito: 'oblio-rifiutato-registro-primaria' }))
  })
})
```

Adatta i nomi (`h.scritture`, `h.errori`, `req`, il nominativo di conferma) a quelli dello stampo; se lo stampo non spia `logEvento`, aggiungi lo stesso mock di `@/lib/logging/logger` del Task 5.

- [ ] **Step 2: Eseguilo e verifica che fallisca**

Run: `npx vitest run __tests__/api/gdpr-erase-registro-primaria.test.ts`
Expected: FAIL — oggi il dryrun risponde 200.

- [ ] **Step 3: Implementa nella route dell'oblio** — subito dopo la chiusura del blocco `if (!eNonPiuIscritto(alunno.stato)) { … }`:

```ts
    // IL REGISTRO DELLA PRIMARIA NON SI ANONIMIZZA (titolare, 2026-10-08).
    // Voti, pagelle, scrutini, note e certificati delle competenze sono il
    // registro che la legge obbliga a conservare: è l'eccezione dell'art. 17 §3
    // lett. b. Vale in `dryrun` come in `execute`, e una lettura fallita FERMA:
    // «non ho potuto guardare» non può aprire un'anonimizzazione irreversibile.
    const registro = await leggiRegistroPrimaria(supabase, alunno_id)
    if (!registro.ok) {
      logErrore({ operazione: OP, stato: 500, evento: 'db' }, registro.errore)
      return NextResponse.json({ error: 'Errore interno', codice: 'GDPR_ERASE_NON_RIUSCITO' }, { status: 500 })
    }
    if (registro.presente) {
      logEvento('gdpr', 'warn', {
        operazione: OP,
        esito: 'oblio-rifiutato-registro-primaria',
        entita_tipo: 'alunni',
        entita_id: alunno_id,
      })
      return NextResponse.json(
        { error: 'Il registro della primaria va conservato', codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE' },
        { status: 409 },
      )
    }
```

e l'import `import { leggiRegistroPrimaria } from '@/lib/alunni/registro-primaria'`.

- [ ] **Step 4: Implementa nei candidati** — in `candidates/route.ts`, prima di `const parentById = …`:

```ts
  // Chi ha il registro della primaria resta IN elenco, con il motivo: un bambino
  // che sparisce in silenzio dall'elenco dell'oblio è il difetto già pagato qui
  // sopra (`candidati-esclusi-fuori-elenco`). Il pannello spegne il comando.
  const registro = await alunniConRegistroPrimaria(supabase, (alunni ?? []).map((a: { id: string }) => a.id))
  if (!registro.ok) {
    logErrore({ operazione: OP, stato: 500, evento: 'db' }, registro.errore)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
```

e nel `map` di `result` restituisci `{ ...a, genitori, registro_primaria: registro.conRegistro.has(a.id) }`. Usa il nome della costante d'operazione del file (`OP` o equivalente: controlla in testa al file) e importa `alunniConRegistroPrimaria`. Se le altre risposte d'errore del file hanno un `codice`, usa lo stesso.

- [ ] **Step 5: Il pannello** — in `OblioPanel.tsx`:
  1. `interface Candidato`: aggiungi `registro_primaria?: boolean;`.
  2. `apri`: all'inizio

```ts
    if (c.registro_primaria) {
      // Niente misura: la route risponderebbe 409. Si mostra il motivo e basta.
      setTarget(c);
      setDry(null);
      setMisura('assente');
      setConfirm('');
      return;
    }
```

  3. nella riga del candidato, dopo il badge dello stato:

```tsx
                    {c.registro_primaria && (
                      <span className="rounded-pill bg-kidville-warn-soft px-2 py-0.5 font-maven text-[10px] font-semibold uppercase text-kidville-warn-strong">{t('oblioRegistroPrimariaBadge')}</span>
                    )}
```

  4. nella colonna destra, dentro `<>…</>` dopo l'`<h3>`, avvolgi il resto in un ternario:

```tsx
                {target.registro_primaria ? (
                  <>
                    <p className="mt-2 mb-4 font-maven text-sm text-kidville-ink/80">{t('oblioRegistroPrimariaTesto')}</p>
                    <div className="flex justify-end">
                      <button onClick={() => { setTarget(null); setMisura('assente'); }} className="rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-muted hover:bg-kidville-cream">{t('annulla')}</button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* …tutto il contenuto attuale dal <p> dell'avviso fino ai bottoni… */}
                  </>
                )}
```

- [ ] **Step 6: Testi** — in `messages/it/adminAltro.json` (posizione alfabetica):

```json
  "oblioRegistroPrimariaBadge": "Registro da conservare",
  "oblioRegistroPrimariaTesto": "Questo bambino ha voti, pagelle, scrutini o note della primaria: il registro va conservato per legge (GDPR art. 17 §3 lett. b), quindi la scheda non si anonimizza.",
```

e in `messages/en/adminAltro.json`:

```json
  "oblioRegistroPrimariaBadge": "Register to keep",
  "oblioRegistroPrimariaTesto": "This child has primary school marks, report cards, assessments or notes: the register must be kept by law (GDPR art. 17(3)(b)), so the record cannot be anonymised.",
```

- [ ] **Step 7: Esegui i test dell'oblio**

Run: `npx vitest run __tests__/api/gdpr-erase-registro-primaria.test.ts __tests__/api/gdpr-erase-route.test.ts __tests__/api/gdpr-candidates-route.test.ts __tests__/api/gdpr-erase-canale-unico.test.ts __tests__/lib/gdpr-oblio-completo.test.ts`
Expected: PASS. Se un test esistente fallisce perché il finto non conosce le tabelle del registro, aggiungile **vuote** al suo db di prova (non cambiare le asserzioni). Se `gdpr-candidates-route.test.ts` confronta l'oggetto intero, aggiungi `registro_primaria: false` all'atteso.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/admin/gdpr src/components/features/admin/settings/OblioPanel.tsx messages/it/adminAltro.json messages/en/adminAltro.json __tests__/api/
git commit -m "$(printf 'Oblio GDPR: il registro della primaria non si anonimizza\n\nerase rifiuta 409 in dryrun ed execute, candidates porta il motivo,\nil pannello spegne il comando invece di nascondere il bambino.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 8: La finestra «Elimina definitivamente»

**Files:**
- Create: `src/components/features/admin/EliminaDefinitivoDialog.tsx`
- Modify: `messages/it/adminStudents.json`, `messages/en/adminStudents.json`
- Test: `__tests__/components/EliminaDefinitivoDialog.test.tsx`

- [ ] **Step 1: Testi** — in `messages/it/adminStudents.json`, in posizione alfabetica:

```json
  "elmAnnulla": "Annulla",
  "elmBloccoPagamenti": "Uno o più pagamenti hanno una ricevuta, una fattura, un bonifico abbinato o un incasso registrato: non si possono cancellare.",
  "elmBloccoRegistro": "Questo bambino ha voti, pagelle, scrutini o note della primaria: il registro va conservato per legge. La scheda resta fra i ritirati.",
  "elmBtnAnonimizza": "Anonimizza e tieni la contabilità",
  "elmBtnElimina": "Elimina definitivamente",
  "elmBtnEliminaConPagamenti": "Cancella anche i pagamenti",
  "elmChat": "{n, plural, one {# allegato nelle chat} other {# allegati nelle chat}}",
  "elmChiudi": "Chiudi",
  "elmCollegati": "Collegati a questa scheda:",
  "elmDiario": "{n, plural, one {# voce di diario} other {# voci di diario}}",
  "elmDocumenti": "{n, plural, one {# documento o certificato} other {# documenti o certificati}}",
  "elmErrore": "Non è stato possibile completare l’operazione.",
  "elmEsitoAnonimizzato": "{nome}: dati personali anonimizzati, contabilità conservata.",
  "elmEsitoEliminato": "{nome}: scheda eliminata definitivamente.",
  "elmFoto": "{n, plural, one {# foto o video solo suo} other {# foto o video solo suoi}}",
  "elmFotoGruppo": "{n, plural, one {# foto di gruppo: resta, si toglie solo il tag} other {# foto di gruppo: restano, si toglie solo il tag}}",
  "elmGenitoriIntatti": "I genitori non vengono toccati: si toglie solo il legame.",
  "elmInCorso": "Un momento…",
  "elmIrreversibile": "Non si torna indietro.",
  "elmLegami": "{n, plural, one {# legame con un genitore} other {# legami con genitori}}",
  "elmMisura": "Controllo che cosa è collegato…",
  "elmMisuraFallita": "Non è stato possibile leggere che cosa è collegato: non si elimina niente.",
  "elmNiente": "Nient’altro oltre alla scheda.",
  "elmPagamenti": "{n, plural, one {# pagamento} other {# pagamenti}}",
  "elmPresenze": "{n, plural, one {# presenza} other {# presenze}}",
  "elmRiprova": "Riprova",
  "elmSpiegaAnonimizza": "Anonimizzare cancella nome, codice fiscale, foto e documenti del bambino; pagamenti e ricevute restano, con il nome oscurato.",
  "elmTitolo": "Elimina definitivamente",
```

e in `messages/en/adminStudents.json`:

```json
  "elmAnnulla": "Cancel",
  "elmBloccoPagamenti": "One or more payments have a receipt, an invoice, a matched bank transfer or a recorded collection: they cannot be deleted.",
  "elmBloccoRegistro": "This child has primary school marks, report cards, assessments or notes: the register must be kept by law. The record stays among the withdrawn.",
  "elmBtnAnonimizza": "Anonymise and keep the accounts",
  "elmBtnElimina": "Delete permanently",
  "elmBtnEliminaConPagamenti": "Delete the payments too",
  "elmChat": "{n, plural, one {# chat attachment} other {# chat attachments}}",
  "elmChiudi": "Close",
  "elmCollegati": "Linked to this record:",
  "elmDiario": "{n, plural, one {# diary entry} other {# diary entries}}",
  "elmDocumenti": "{n, plural, one {# document or certificate} other {# documents or certificates}}",
  "elmErrore": "The operation could not be completed.",
  "elmEsitoAnonimizzato": "{nome}: personal data anonymised, accounts kept.",
  "elmEsitoEliminato": "{nome}: record permanently deleted.",
  "elmFoto": "{n, plural, one {# photo or video of this child only} other {# photos or videos of this child only}}",
  "elmFotoGruppo": "{n, plural, one {# group photo: it stays, only the tag is removed} other {# group photos: they stay, only the tag is removed}}",
  "elmGenitoriIntatti": "Parents are not touched: only the link is removed.",
  "elmInCorso": "One moment…",
  "elmIrreversibile": "This cannot be undone.",
  "elmLegami": "{n, plural, one {# link to a parent} other {# links to parents}}",
  "elmMisura": "Checking what is linked…",
  "elmMisuraFallita": "We could not read what is linked: nothing will be deleted.",
  "elmNiente": "Nothing else besides the record.",
  "elmPagamenti": "{n, plural, one {# payment} other {# payments}}",
  "elmPresenze": "{n, plural, one {# attendance record} other {# attendance records}}",
  "elmRiprova": "Try again",
  "elmSpiegaAnonimizza": "Anonymising removes the child's name, tax code, photos and documents; payments and receipts stay, with the name hidden.",
  "elmTitolo": "Delete permanently",
```

- [ ] **Step 2: Scrivi il test che fallisce**

Stampo per il rendering con i messaggi: le prime righe di `__tests__/components/AlunniArchiviatiView.test.tsx` (provider `NextIntlClientProvider` con i messaggi veri e mock di `fetch`). Il test:

```tsx
// __tests__/components/EliminaDefinitivoDialog.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
// importa il wrapper con i messaggi come fa lo stampo (es. renderConMessaggi)
import { EliminaDefinitivoDialog } from '@/components/features/admin/EliminaDefinitivoDialog'

const AL = { id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', nome: 'Bambino', cognome: 'DiProva' }

const anteprima = (scelte: Record<string, boolean>, motivo: string | null, conteggi: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    dryrun: true,
    conteggi: { presenze: 1, diario: 0, legami_genitori: 1, pagamenti: 0, pagamenti_bloccati: 0, registro_primaria: false,
      pagelle: 0, certificati_medici: 0, fascicolo_sanitario: 0, foto_solo_sue: 0, foto_di_gruppo: 0,
      foto_non_rimovibili: 0, articoli_pubblici: 0, allegati_chat: 0, ...conteggi },
    scelte, motivo,
  }),
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

describe('EliminaDefinitivoDialog', () => {
  it('senza pagamenti: mostra i numeri e un solo bottone rosso; il click esegue «elimina»', async () => {
    fetchMock
      .mockResolvedValueOnce(anteprima({ elimina: true, elimina_con_pagamenti: false, anonimizza: false }, null))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, scelta: 'elimina' }) })
    const onEliminato = vi.fn()
    render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />) // con il wrapper dei messaggi
    expect(await screen.findByText(/1 presenza/)).toBeInTheDocument()
    expect(screen.getByText(/I genitori non vengono toccati/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Anonimizza/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Elimina definitivamente' }))
    await waitFor(() => expect(onEliminato).toHaveBeenCalledWith(expect.stringContaining('eliminata definitivamente')))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ alunno_id: AL.id, mode: 'execute', scelta: 'elimina' })
  })

  it('con pagamenti bloccati: «Cancella anche i pagamenti» è spento col motivo, «Anonimizza» è attivo', async () => {
    fetchMock.mockResolvedValueOnce(
      anteprima({ elimina: false, elimina_con_pagamenti: false, anonimizza: true }, 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI', { pagamenti: 2, pagamenti_bloccati: 1 }),
    )
    render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
    const cancella = await screen.findByRole('button', { name: /Cancella anche i pagamenti/ })
    expect(cancella).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/non si possono cancellare/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Anonimizza e tieni la contabilità/ })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('con il registro della primaria: nessun comando distruttivo, solo «Chiudi»', async () => {
    fetchMock.mockResolvedValueOnce(
      anteprima({ elimina: false, elimina_con_pagamenti: false, anonimizza: false }, 'REGISTRO_PRIMARIA_DA_CONSERVARE', { registro_primaria: true }),
    )
    render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
    expect(await screen.findByText(/il registro va conservato per legge/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Elimina definitivamente|Cancella|Anonimizza/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Chiudi' })).toBeInTheDocument()
  })

  it('anteprima fallita: messaggio, «Riprova», nessun comando distruttivo', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ codice: 'ALUNNO_ELIMINAZIONE_NON_MISURATA' }) })
    render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Riprova' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Elimina definitivamente' })).toBeNull()
  })

  it('esecuzione rifiutata: la finestra resta aperta con il messaggio del server', async () => {
    fetchMock
      .mockResolvedValueOnce(anteprima({ elimina: true, elimina_con_pagamenti: false, anonimizza: false }, null))
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ codice: 'ALUNNO_ELIMINAZIONE_FILE_RESTANTI' }) })
    const onEliminato = vi.fn()
    render(<EliminaDefinitivoDialog alunno={AL} onChiudi={vi.fn()} onEliminato={onEliminato} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Elimina definitivamente' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/non sono usciti/)
    expect(onEliminato).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Eseguilo e verifica che fallisca**

Run: `npx vitest run __tests__/components/EliminaDefinitivoDialog.test.tsx`
Expected: FAIL — componente assente.

- [ ] **Step 4: Scrivi il componente**

```tsx
// src/components/features/admin/EliminaDefinitivoDialog.tsx
'use client';

/**
 * «ELIMINA DEFINITIVAMENTE» — la finestra della linguetta «Non iscritti».
 *
 * Due tempi, come «Libera spazio», ma senza nominativo da riscrivere (decisione
 * del titolare, 2026-10-08): all'apertura si CONTA (`mode: 'dryrun'`) e si
 * mostrano i numeri; poi si offrono SOLO le scelte che il server ha detto
 * disponibili. Il server ricontrolla comunque tutto: questa finestra non è una
 * difesa, è la spiegazione.
 *
 * Un comando che non si può usare resta a schermo, spento e con il motivo
 * accanto: sparire direbbe «non esiste», mentre la verità è «non qui, e perché».
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { btnClass } from '@/components/ui/Btn';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import type { ConteggiEliminazione, MotivoBloccoEliminazione, SceltaEliminazione } from '@/lib/alunni/elimina-definitivo';

export interface AlunnoDaEliminare {
    id: string;
    nome?: string | null;
    cognome?: string | null;
}

export interface EliminaDefinitivoDialogProps {
    /** `null` = finestra chiusa. */
    alunno: AlunnoDaEliminare | null;
    onChiudi: () => void;
    /** Chiamata a operazione riuscita, con la frase da mostrare nell'elenco. */
    onEliminato: (esito: string) => void;
}

interface Anteprima {
    conteggi: ConteggiEliminazione;
    scelte: Record<SceltaEliminazione, boolean>;
    motivo: MotivoBloccoEliminazione | null;
}

type Fase = 'misura' | 'pronta' | 'misura-fallita' | 'esecuzione';

export function EliminaDefinitivoDialog({ alunno, onChiudi, onEliminato }: EliminaDefinitivoDialogProps) {
    if (alunno === null) return null;
    return <Finestra key={alunno.id} alunno={alunno} onChiudi={onChiudi} onEliminato={onEliminato} />;
}

function Finestra({ alunno, onChiudi, onEliminato }: { alunno: AlunnoDaEliminare } & Omit<EliminaDefinitivoDialogProps, 'alunno'>) {
    const t = useTranslations('adminStudents');
    const [fase, setFase] = useState<Fase>('misura');
    const [anteprima, setAnteprima] = useState<Anteprima | null>(null);
    const [errore, setErrore] = useState<string | null>(null);
    const [epoca, setEpoca] = useState(0);
    /** Guardia di rientro: due click nello stesso tick non fanno due POST. */
    const inVolo = useRef(false);

    const nominativo = [alunno.cognome, alunno.nome].filter((v) => typeof v === 'string' && v !== '').join(' ');

    const misura = useCallback(async () => {
        let motivo = '';
        let prossima: Fase = 'misura-fallita';
        try {
            const res = await fetch('/api/admin/students/elimina', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: alunno.id, mode: 'dryrun' }),
            }).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            if (res === null) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-anteprima-non-riuscita: ${motivo}`, route: '/admin/students' });
                return;
            }
            if (!res.ok) {
                setErrore(await messaggioErrore(res, t('elmMisuraFallita')));
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'elimina-anteprima-non-riuscita', route: '/admin/students', stato: res.status });
                return;
            }
            const corpo = (await res.json().catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            })) as Anteprima | null;
            if (!corpo || typeof corpo !== 'object' || !corpo.scelte || !corpo.conteggi) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-anteprima-corpo-inatteso: ${motivo || 'forma'}`, route: '/admin/students', stato: res.status });
                return;
            }
            setAnteprima(corpo);
            setErrore(null);
            prossima = 'pronta';
        } finally {
            setFase(prossima);
        }
    }, [alunno.id, t]);

    useEffect(() => {
        void misura();
    }, [misura, epoca]);

    const esegui = async (scelta: SceltaEliminazione) => {
        if (inVolo.current || !anteprima?.scelte[scelta]) return;
        inVolo.current = true;
        setFase('esecuzione');
        setErrore(null);
        let motivo = '';
        try {
            const res = await fetch('/api/admin/students/elimina', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: alunno.id, mode: 'execute', scelta }),
            }).catch((e: unknown) => {
                motivo = nomeErrore(e);
                return null;
            });
            if (res === null) {
                setErrore(t('elmErrore'));
                logClient({ livello: 'error', evento: 'fetch', messaggio: `elimina-non-riuscita: ${motivo}`, route: '/admin/students' });
                return;
            }
            if (!res.ok) {
                setErrore(await messaggioErrore(res, t('elmErrore')));
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'elimina-non-riuscita', route: '/admin/students', stato: res.status });
                return;
            }
            onEliminato(
                scelta === 'anonimizza'
                    ? t('elmEsitoAnonimizzato', { nome: nominativo })
                    : t('elmEsitoEliminato', { nome: nominativo }),
            );
            onChiudi();
        } finally {
            inVolo.current = false;
            setFase((f) => (f === 'esecuzione' ? 'pronta' : f));
        }
    };

    const c = anteprima?.conteggi;
    const righe = c
        ? [
              c.presenze > 0 ? t('elmPresenze', { n: c.presenze }) : null,
              c.diario > 0 ? t('elmDiario', { n: c.diario }) : null,
              c.legami_genitori > 0 ? t('elmLegami', { n: c.legami_genitori }) : null,
              (c.certificati_medici ?? 0) + (c.fascicolo_sanitario ?? 0) > 0
                  ? t('elmDocumenti', { n: (c.certificati_medici ?? 0) + (c.fascicolo_sanitario ?? 0) })
                  : null,
              (c.foto_solo_sue ?? 0) > 0 ? t('elmFoto', { n: c.foto_solo_sue ?? 0 }) : null,
              (c.foto_di_gruppo ?? 0) > 0 ? t('elmFotoGruppo', { n: c.foto_di_gruppo ?? 0 }) : null,
              (c.allegati_chat ?? 0) > 0 ? t('elmChat', { n: c.allegati_chat ?? 0 }) : null,
              c.pagamenti > 0 ? t('elmPagamenti', { n: c.pagamenti }) : null,
          ].filter((v): v is string => v !== null)
        : [];

    const registro = anteprima?.motivo === 'REGISTRO_PRIMARIA_DA_CONSERVARE';
    const pagamentiBloccati = anteprima?.motivo === 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI';
    const occupato = fase === 'esecuzione';

    return (
        <Modal
            open
            onClose={onChiudi}
            title={t('elmTitolo')}
            labelledBy="elimina-definitivo-titolo"
            closeOnBackdrop={false}
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl"
        >
            <div className="mb-4 flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error-strong">
                    <Trash2 size={22} strokeWidth={1.9} aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <h2 id="elimina-definitivo-titolo" className="font-barlow text-lg font-bold uppercase text-kidville-green">
                        {t('elmTitolo')}
                    </h2>
                    <p className="font-maven truncate text-sm text-kidville-sub">{nominativo}</p>
                </div>
            </div>

            {fase === 'misura' && (
                <p role="status" className="flex items-center gap-2 font-maven text-sm text-kidville-sub">
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" /> {t('elmMisura')}
                </p>
            )}

            {fase === 'misura-fallita' && (
                <div role="alert" className="mb-4 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong">
                    <p className="mb-2 flex items-start gap-2">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> {errore || t('elmMisuraFallita')}
                    </p>
                    <button type="button" onClick={() => { setFase('misura'); setEpoca((e) => e + 1); }} className={btnClass('ghost', 'sm')}>
                        <RotateCcw size={14} strokeWidth={2} aria-hidden="true" /> {t('elmRiprova')}
                    </button>
                </div>
            )}

            {anteprima && fase !== 'misura' && fase !== 'misura-fallita' && (
                <>
                    <div className="mb-4 rounded-input bg-kidville-cream px-3 py-2.5 font-maven text-[13px] text-kidville-ink">
                        <p className="mb-1 font-semibold">{t('elmCollegati')}</p>
                        {righe.length === 0 ? (
                            <p>{t('elmNiente')}</p>
                        ) : (
                            <ul className="list-disc pl-5">
                                {righe.map((r) => <li key={r}>{r}</li>)}
                            </ul>
                        )}
                        {c && c.legami_genitori > 0 && <p className="mt-2">{t('elmGenitoriIntatti')}</p>}
                    </div>

                    {registro ? (
                        <p className="mb-4 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                            {t('elmBloccoRegistro')}
                        </p>
                    ) : (
                        <>
                            {pagamentiBloccati && (
                                <p className="mb-3 rounded-input bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn-strong">
                                    {t('elmBloccoPagamenti')}
                                </p>
                            )}
                            {anteprima.scelte.anonimizza && (
                                <p className="mb-3 font-maven text-[13px] text-kidville-sub">{t('elmSpiegaAnonimizza')}</p>
                            )}
                            <p className="mb-3 font-maven text-[13px] font-semibold text-kidville-error-strong">{t('elmIrreversibile')}</p>
                        </>
                    )}

                    {errore !== null && (
                        <p role="alert" className="mb-3 rounded-input bg-kidville-error-soft px-3 py-2.5 font-maven text-[13px] text-kidville-error-strong">
                            {errore}
                        </p>
                    )}
                </>
            )}

            <div className="flex flex-wrap justify-end gap-2">
                {anteprima && !registro && fase !== 'misura' && fase !== 'misura-fallita' && (
                    <>
                        {anteprima.scelte.elimina && (
                            <button type="button" onClick={() => void esegui('elimina')} aria-disabled={occupato} className={btnClass('danger', 'sm')}>
                                {occupato ? t('elmInCorso') : t('elmBtnElimina')}
                            </button>
                        )}
                        {(anteprima.scelte.elimina_con_pagamenti || pagamentiBloccati) && (
                            <button
                                type="button"
                                onClick={() => void esegui('elimina_con_pagamenti')}
                                aria-disabled={occupato || !anteprima.scelte.elimina_con_pagamenti}
                                className={btnClass('danger', 'sm')}
                            >
                                {t('elmBtnEliminaConPagamenti')}
                            </button>
                        )}
                        {anteprima.scelte.anonimizza && (
                            <button type="button" onClick={() => void esegui('anonimizza')} aria-disabled={occupato} className={btnClass('secondary', 'sm')}>
                                {t('elmBtnAnonimizza')}
                            </button>
                        )}
                    </>
                )}
                <button type="button" onClick={onChiudi} className={btnClass('ghost', 'sm')}>
                    {registro || fase === 'misura-fallita' ? t('elmChiudi') : t('elmAnnulla')}
                </button>
            </div>
        </Modal>
    );
}
```

Note:
- `set-state-in-effect` è un ERRORE del gate: lo stato si cambia solo dopo l'`await` (dentro `misura`), e il `try/finally` è la forma riconosciuta (vedi la memoria del progetto «il `try/finally` la SPEGNE»): se ESLint segnala `misura` chiamata nell'effetto, applica lo stesso schema di `useAlunniArchiviati` (funzione in `useCallback`, `void` nell'effetto, nessun `setState` sincrono prima del primo `await`).
- Se l'import `type` da `@/lib/alunni/elimina-definitivo` trascina nel bundle client moduli solo server, sposta `SceltaEliminazione`, `MotivoBloccoEliminazione` e `ConteggiEliminazione` in `src/lib/alunni/elimina-definitivo-tipi.ts` (solo tipi) e importali da lì in entrambi i file.

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `npx vitest run __tests__/components/EliminaDefinitivoDialog.test.tsx`
Expected: PASS, 5 test.

- [ ] **Step 6: Commit**

```bash
git add src/components/features/admin/EliminaDefinitivoDialog.tsx __tests__/components/EliminaDefinitivoDialog.test.tsx messages/it/adminStudents.json messages/en/adminStudents.json
git commit -m "$(printf 'Finestra «Elimina definitivamente»: i numeri prima, solo le scelte che il server offre\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 9: La linguetta «Non iscritti» e l'elenco «Alunni»

**Files:**
- Modify: `src/components/features/admin/AlunniArchiviatiView.tsx`
- Modify: `src/app/(dashboard)/admin/students/page.tsx`
- Modify: `messages/it/adminStudents.json`, `messages/en/adminStudents.json`
- Modify: `__tests__/architecture/elenchi-operativi-solo-iscritti.test.ts` (togli la voce morta di `page.tsx`)
- Test: `__tests__/components/AlunniArchiviatiView.test.tsx` (aggiorna + nuovi casi), test di pagina in `__tests__/pages/admin-students-*.test.tsx` (aggiorna gli URL se li confrontano)

- [ ] **Step 1: Testi** — in `messages/it/adminStudents.json` **cambia i valori** di queste chiavi esistenti (senza spostarle):

```json
  "arcSottotitolo": "Ritirati e iscritti senza sezione. Da qui si riportano dentro, si assegna una sezione o si eliminano definitivamente.",
  "arcTab": "Non iscritti",
  "arcTabellaDidascalia": "I bambini ritirati, con la classe da cui sono usciti e la data di archiviazione.",
  "arcTitolo": "Non iscritti",
  "arcVuotoTesto": "Tutti i bambini in anagrafica sono iscritti e hanno una sezione.",
  "arcVuotoTitolo": "Nessun bambino fuori elenco",
```

e **aggiungi** (posizione alfabetica):

```json
  "arcAzioneAssegnaSezione": "Assegna sezione",
  "arcAzioneAssegnaSezioneInCorso": "Assegno…",
  "arcAzioneElimina": "Elimina definitivamente",
  "arcErroreAssegnazione": "Non è stato possibile assegnare la sezione.",
  "arcEsitoSezioneAssegnata": "{nome} è in {classe}: ora è nell’elenco Alunni.",
  "arcGruppoRitirati": "Ritirati",
  "arcGruppoRitiratiVuoto": "Nessun bambino ritirato.",
  "arcGruppoSenzaSezione": "Iscritti senza sezione",
  "arcGruppoSenzaSezioneVuoto": "Ogni iscritto ha una sezione.",
  "arcNessunaSezioneInSede": "Nessuna sezione in questa sede",
  "arcSceltaSezione": "Sezione per {nome}",
  "arcSceltaSezioneVuota": "Scegli…",
  "arcSenzaSezioneDidascalia": "I bambini iscritti a cui manca la sezione.",
```

In inglese: `arcSottotitolo` «Withdrawn children and enrolled children without a class. From here you can move them back, assign a class or delete them permanently.», `arcTab`/`arcTitolo` «Not enrolled», `arcTabellaDidascalia` «Withdrawn children, with the class they left and the archiving date.», `arcVuotoTesto` «Every child on file is enrolled and has a class.», `arcVuotoTitolo` «No children outside the list»; nuove: `arcAzioneAssegnaSezione` «Assign class», `arcAzioneAssegnaSezioneInCorso` «Assigning…», `arcAzioneElimina` «Delete permanently», `arcErroreAssegnazione` «The class could not be assigned.», `arcEsitoSezioneAssegnata` «{nome} is in {classe}: now listed under Students.», `arcGruppoRitirati` «Withdrawn», `arcGruppoRitiratiVuoto` «No withdrawn children.», `arcGruppoSenzaSezione` «Enrolled without a class», `arcGruppoSenzaSezioneVuoto` «Every enrolled child has a class.», `arcNessunaSezioneInSede` «No classes at this site», `arcSceltaSezione` «Class for {nome}», `arcSceltaSezioneVuota` «Choose…», `arcSenzaSezioneDidascalia` «Enrolled children who have no class yet.».

Controlla con `grep -n "Non più iscritti\|non più iscritti" messages/it/*.json` se altre chiavi visibili nominano la linguetta col vecchio nome e allineale.

- [ ] **Step 2: Aggiorna/scrivi i test della vista**

In `__tests__/components/AlunniArchiviatiView.test.tsx`:
- dove il test confronta l'URL `stato=ritirato`, ora l'URL atteso contiene `elenco=non_iscritti`;
- le righe di prova dei ritirati devono avere `stato: 'ritirato'`; aggiungi alle props `sezioni={[]}` dove serve;
- aggiungi questi casi (adatta il wrapper dei messaggi e il mock di `fetch` a quelli del file):

```tsx
it('divide in due gruppi: Ritirati e Iscritti senza sezione', async () => {
  // esito con due righe: una `ritirato`, una `iscritto` con section_id null
  // → compaiono i titoli «Ritirati» e «Iscritti senza sezione», ciascuna riga nel suo gruppo
})

it('«Assegna sezione» manda la PATCH con la sola sezione della sede del bambino e rilegge', async () => {
  // sezioni: [{ id: 's1', name: 'SEZIONE A', scuola_id: SEDE_A }, { id: 's2', name: 'SEZIONE B', scuola_id: SEDE_B }]
  // riga senza sezione in SEDE_A → la tendina offre SOLO «SEZIONE A»
  // scelta + click → fetch('/api/admin/students', { method: 'PATCH', body: { ids: [id], classe_sezione: 'SEZIONE A' } })
  // → esito.ricarica chiamata, messaggio «… è in SEZIONE A …»
})

it('«Elimina definitivamente» compare a segreteria e Direzione, non a un docente', async () => {
  // ruolo 'segreteria' → bottone presente; ruolo 'educator' → assente
})
```

Scrivi ciascun caso per intero sul modello dei test già presenti nel file (stessa costruzione di `esito`, stessi `render`).

Run: `npx vitest run __tests__/components/AlunniArchiviatiView.test.tsx`
Expected: FAIL sui casi nuovi.

- [ ] **Step 3: Implementa la vista** — in `AlunniArchiviatiView.tsx`:

1. Import: aggiungi `Trash2` alle icone `lucide-react`; `import { EliminaDefinitivoDialog } from '@/components/features/admin/EliminaDefinitivoDialog';`; sostituisci `import { RUOLI_LIBERA_SPAZIO } from '@/lib/alunni/archiviazione';` con `import { RUOLI_ELIMINA_DEFINITIVO, RUOLI_LIBERA_SPAZIO } from '@/lib/alunni/archiviazione';`; sostituisci `import { STATO_RITIRATO } from '@/lib/alunni/stato';` con `import { eNonPiuIscritto } from '@/lib/alunni/stato';`.
2. Accanto a `const RUOLI_DISTRUZIONE = new Set<string>(RUOLI_LIBERA_SPAZIO);` aggiungi `const RUOLI_ELIMINA = new Set<string>(RUOLI_ELIMINA_DEFINITIVO);`.
3. `interface AlunnoArchiviato`: aggiungi `section_id?: string | null;`.
4. Nel hook, l'URL diventa ``/api/admin/students?elenco=non_iscritti&limit=${LIMITE_ELENCO_ALUNNI}`` (aggiorna anche il commento in testa al file e quello sopra la fetch: «ritirati e iscritti senza sezione, anonimizzati esclusi»).
5. Props: aggiungi `sezioni?: { id: string; name: string; scuola_id?: string | null }[];` a `AlunniArchiviatiViewProps` e destrutturala con default `sezioni = []`.
6. Stato nuovo, accanto a `daLiberare`:

```tsx
    /** Il bambino su cui è aperta «Elimina definitivamente». `null` = chiusa. */
    const [daEliminare, setDaEliminare] = useState<AlunnoArchiviato | null>(null);
    /** La sezione scelta nella tendina di ogni riga senza sezione: id alunno → nome classe. */
    const [classeScelta, setClasseScelta] = useState<Record<string, string>>({});
```

7. Dopo `visibili`:

```tsx
    const ritirati = useMemo(() => visibili.filter((r) => eNonPiuIscritto(r.stato)), [visibili]);
    const senzaSezione = useMemo(() => visibili.filter((r) => !eNonPiuIscritto(r.stato)), [visibili]);
    const sezioniDi = useCallback(
        (scuolaId: string | null | undefined) => sezioni.filter((s) => s.scuola_id === scuolaId),
        [sezioni],
    );
```

8. Dopo `riattiva`, la funzione di assegnazione (stessa disciplina di `riattiva`: guardia `inVoloRef`, log del `!ok`, niente `catch` muti):

```tsx
    const assegnaSezione = useCallback(
        async (r: AlunnoArchiviato) => {
            const classe = classeScelta[r.id];
            if (!classe || inVoloRef.current !== null) return;
            inVoloRef.current = r.id;
            setInVolo(r.id);
            setMessaggio(null);
            let motivo = '';
            try {
                const res = await fetch('/api/admin/students', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: [r.id], classe_sezione: classe }),
                }).catch((e: unknown) => {
                    motivo = nomeErrore(e);
                    return null;
                });
                if (res === null) {
                    setMessaggio({ tipo: 'errore', testo: t('arcErroreAssegnazione') });
                    logClient({ livello: 'error', evento: 'fetch', messaggio: `sezione-non-assegnata: ${motivo}`, route: '/admin/students' });
                    return;
                }
                if (!res.ok) {
                    setMessaggio({ tipo: 'errore', testo: await messaggioErrore(res, t('arcErroreAssegnazione')) });
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'sezione-non-assegnata', route: '/admin/students', stato: res.status });
                    return;
                }
                setMessaggio({ tipo: 'ok', testo: t('arcEsitoSezioneAssegnata', { nome: nominativo(r), classe }) });
                esito.ricarica();
            } finally {
                inVoloRef.current = null;
                setInVolo(null);
            }
        },
        [classeScelta, esito, nominativo, t],
    );
    const puoEliminare = RUOLI_ELIMINA.has(ruolo ?? '');
```

(`puoEliminare` va calcolato dopo i rami di caricamento/errore, accanto a `puoLiberare`, se il linter lamenta l'ordine degli hook; è una costante, non un hook.)

9. Nel render, sostituisci il blocco della sola tabella (da `<div className="rounded-card bg-kidville-white p-4 shadow-sm">` con `arcConteggio` fino alla sua chiusura, dentro il ternario dopo `visibili.length === 0 ? … :`) con DUE sezioni:

```tsx
                <div className="flex flex-col gap-4">
                    {/* ── RITIRATI ── */}
                    <section className="rounded-card bg-kidville-white p-4 shadow-sm" aria-labelledby="gruppo-ritirati">
                        <h3 id="gruppo-ritirati" className="mb-1 font-barlow text-base font-bold uppercase text-kidville-green">
                            {t('arcGruppoRitirati')} <span className="font-maven text-sm font-normal text-kidville-sub">({ritirati.length})</span>
                        </h3>
                        {ritirati.length === 0 ? (
                            <p className="font-maven text-[13px] text-kidville-sub">{t('arcGruppoRitiratiVuoto')}</p>
                        ) : (
                            <div className={TABLE_WRAP}>
                                <table className={TABLE}>
                                    {/* …la tabella attuale, IDENTICA, ma iterando `ritirati` invece di `visibili`;
                                        nei comandi, dopo il bottone «Libera spazio», aggiungi: */}
                                    {/*
                                    {puoEliminare && (
                                        <button type="button" onClick={() => setDaEliminare(r)} className={btnClass('ghost', 'sm', 'text-kidville-error-strong')}>
                                            <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                                            {t('arcAzioneElimina')}
                                        </button>
                                    )}
                                    */}
                                </table>
                            </div>
                        )}
                    </section>

                    {/* ── ISCRITTI SENZA SEZIONE ── */}
                    <section className="rounded-card bg-kidville-white p-4 shadow-sm" aria-labelledby="gruppo-senza-sezione">
                        <h3 id="gruppo-senza-sezione" className="mb-1 font-barlow text-base font-bold uppercase text-kidville-green">
                            {t('arcGruppoSenzaSezione')} <span className="font-maven text-sm font-normal text-kidville-sub">({senzaSezione.length})</span>
                        </h3>
                        {senzaSezione.length === 0 ? (
                            <p className="font-maven text-[13px] text-kidville-sub">{t('arcGruppoSenzaSezioneVuoto')}</p>
                        ) : (
                            <div className={TABLE_WRAP}>
                                <table className={TABLE}>
                                    <caption className="sr-only">{t('arcSenzaSezioneDidascalia')}</caption>
                                    <thead>
                                        <tr>
                                            <th scope="col" className={TH}>{t('arcColPersona')}</th>
                                            <th scope="col" className={TH}>{t('arcColNascita')}</th>
                                            {mostraSede && <th scope="col" className={TH}>{t('arcColSede')}</th>}
                                            <th scope="col" className={TH}>{t('arcColComandi')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {senzaSezione.map((r) => {
                                            const opzioni = sezioniDi(r.scuola_id);
                                            const nascita = typeof r.data_nascita === 'string' ? dataBreve(r.data_nascita) : '';
                                            return (
                                                <tr key={r.id} className={TROW}>
                                                    <td className={cx(TD, 'font-maven text-sm font-semibold text-kidville-ink')}>{nominativo(r)}</td>
                                                    <td className={cx(TD, 'font-maven text-sm text-kidville-sub')}>{nascita || t('arcSenzaData')}</td>
                                                    {mostraSede && <td className={cx(TD, 'font-maven text-sm text-kidville-sub')}>{nomeSede(r.scuola_id)}</td>}
                                                    <td className={TD}>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            {opzioni.length === 0 ? (
                                                                <span className="font-maven text-[13px] text-kidville-sub">{t('arcNessunaSezioneInSede')}</span>
                                                            ) : (
                                                                <>
                                                                    <label className="sr-only" htmlFor={`sez-${r.id}`}>{t('arcSceltaSezione', { nome: nominativo(r) })}</label>
                                                                    <select
                                                                        id={`sez-${r.id}`}
                                                                        value={classeScelta[r.id] ?? ''}
                                                                        onChange={(e) => setClasseScelta((m) => ({ ...m, [r.id]: e.target.value }))}
                                                                        className="rounded-input border-2 border-kidville-line px-2 py-1.5 font-maven text-sm"
                                                                    >
                                                                        <option value="">{t('arcSceltaSezioneVuota')}</option>
                                                                        {[...new Set(opzioni.map((s) => s.name))].map((nome) => (
                                                                            <option key={nome} value={nome}>{nome}</option>
                                                                        ))}
                                                                    </select>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => void assegnaSezione(r)}
                                                                        aria-disabled={inVolo !== null || !classeScelta[r.id]}
                                                                        className={btnClass('primary', 'sm')}
                                                                    >
                                                                        {inVolo === r.id ? t('arcAzioneAssegnaSezioneInCorso') : t('arcAzioneAssegnaSezione')}
                                                                    </button>
                                                                </>
                                                            )}
                                                            {puoEliminare && (
                                                                <button type="button" onClick={() => setDaEliminare(r)} className={btnClass('ghost', 'sm', 'text-kidville-error-strong')}>
                                                                    <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                                                                    {t('arcAzioneElimina')}
                                                                </button>
                                                            )}
                                                            <button type="button" onClick={() => apriScheda(r)} className={btnClass('ghost', 'sm')}>
                                                                {t('arcAzioneApriScheda')}
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                </div>
```

Il blocco commentato nella sezione Ritirati è un'istruzione, non codice da lasciare commentato: sposta lì dentro la tabella attuale (con `ritirati.map` al posto di `visibili.map`) e inserisci il bottone «Elimina definitivamente» fra i comandi, **non** commentato.

10. Accanto a `<LiberaSpazioDialog … />`, monta la finestra nuova:

```tsx
            <EliminaDefinitivoDialog
                alunno={daEliminare}
                onChiudi={() => setDaEliminare(null)}
                onEliminato={(testo) => {
                    setMessaggio({ tipo: 'ok', testo });
                    esito.ricarica();
                }}
            />
```

- [ ] **Step 4: Implementa la pagina** — in `src/app/(dashboard)/admin/students/page.tsx`:
1. `fetchStudents`: l'URL diventa ``/api/admin/students?elenco=frequentanti&limit=${LIMITE_ELENCO_ALUNNI}``. Aggiorna il commento in testa al blocco (dopo `useAlunniArchiviati`): la seconda lettura è `GET /api/admin/students?elenco=non_iscritti`.
2. Togli `<option value="">{t('filtroNonAssegnata')}</option>` dal filtro classe e `<option value="ritirato">{t('statoRitirato')}</option>` dal filtro stato (le chiavi dei cataloghi restano: `statoRitirato` è usata da `StudentDetailPanel`; `filtroNonAssegnata` controlla con `grep -rn "filtroNonAssegnata" src` — se non è più usata da nessuno lasciala nel catalogo comunque, non si riordina e non si sfoltisce in questo lavoro).
3. `<AlunniArchiviatiView esito={archiviati} ruolo={ruolo} userId={userId} />` diventa `<AlunniArchiviatiView esito={archiviati} ruolo={ruolo} userId={userId} sezioni={availableSections} />`.
4. Dopo un'assegnazione di sezione dalla linguetta «Non iscritti» il bambino entra nell'elenco Alunni: nessun lavoro in più, perché la linguetta «Alunni» rilegge a ogni cambio di tab (`useEffect` su `viewType`).

- [ ] **Step 5: Togli la voce morta dal lock** — in `__tests__/architecture/elenchi-operativi-solo-iscritti.test.ts` elimina la voce `'src/app/(dashboard)/admin/students/page.tsx': { … }` da `CHIAMANTI_SENZA_STATO` (la chiamata ora dichiara `elenco=frequentanti`).

- [ ] **Step 6: Esegui i test toccati**

Run: `npx vitest run __tests__/components/AlunniArchiviatiView.test.tsx __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts __tests__/pages/`
Expected: PASS. Dove un test di pagina confronta l'URL esatto della lettura alunni (`/api/admin/students?limit=…` o `?stato=ritirato…`), aggiornalo al nuovo URL: è un cambiamento voluto, non un difetto. Non cambiare altre asserzioni.

- [ ] **Step 7: Commit**

```bash
git add src/components/features/admin/AlunniArchiviatiView.tsx "src/app/(dashboard)/admin/students/page.tsx" messages/it/adminStudents.json messages/en/adminStudents.json __tests__/
git commit -m "$(printf 'Linguetta «Non iscritti» con ritirati e senza sezione; l’elenco Alunni mostra solo chi frequenta\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 10: PRD, gate completo, PR

**Files:**
- Modify: `PRD REGISTRO ELETTRONICO.md`
- Modify (se il lock lo chiede): fotografia/coda delle migrazioni

- [ ] **Step 1: PRD** — leggi le prime ~80 righe e l'ultimo blocco «Changelog — …» per la forma esatta, poi aggiungi una voce datata 2026-10-08 con: linguetta «Non iscritti» (ritirati + iscritti senza sezione, «Assegna sezione»); «Elimina definitivamente» per segreteria e Direzione con anteprima e le tre scelte; regola del registro della primaria (né eliminato né anonimizzato, oblio compreso); funzione SQL `elimina_alunno_definitivo` (transazione unica, ricontrolli); elenco Alunni = frequentanti con sezione; cosa resta di proposito (ricevute, fatture, accessi alla vigilanza chat, domande d'iscrizione). Aggiorna le tabelle di stato in cima se elencano le funzionalità dell'anagrafica. **Nessun nome di persona.**

- [ ] **Step 2: Gate completo**

Run, uno per volta, leggendo il riepilogo di ciascuno:
```bash
npx eslint . --max-warnings 0
```
```bash
npx tsc --noEmit
```
```bash
npx vitest run
```
```bash
npm run build
```
Expected: 0 errori ESLint, 0 errori tsc, tutti i test verdi, build ok. Ogni rosso si corregge alla causa (vedi le regole in testa al piano); un lock si aggiorna solo quando il suo messaggio lo prevede, con il commento del delta.

- [ ] **Step 3: Log presenti** — rileggi il diff (`git diff main --stat` e i file nuovi): ogni ramo d'errore nuovo ha `logErrore`/`logEvento`/`logClient`; i successi critici (eliminato, anonimizzato) hanno `logEvento` `info`. Nessun dato personale nei log.

- [ ] **Step 4: Commit del PRD**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(printf 'PRD: non iscritti, eliminazione definitiva, registro della primaria da conservare\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

- [ ] **Step 5: Push e PR**

```bash
git push -u origin feat/elimina-non-iscritti
```
Poi `gh pr create` con titolo «Non iscritti: elenco separato ed eliminazione definitiva» e corpo che riassume spec, decisioni del titolare, migrazione (applicata dall'integrazione al merge), test aggiunti; chiudere il corpo con `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. **Auto-merge vietato**: il merge si fa a mano dopo la CI verde (tutti i job, E2E compreso).

- [ ] **Step 6: Dopo il merge** (sessione principale, non un sotto-agente)
1. Verifica che l'integrazione abbia applicato la migrazione: `SELECT has_function_privilege('service_role','public.elimina_alunno_definitivo(uuid, boolean)','EXECUTE')` → `true`; per `anon` e `authenticated` → `false`.
2. Rigenera la fotografia delle migrazioni come indica `migrazioni-complete.test.ts` (`node __tests__/fixtures/migrazioni-fotografia.mjs --sql`, query su produzione, `node __tests__/fixtures/migrazioni-fotografia.mjs < risposta.json`) in una PR-B, se il lock lo richiede.
3. Deploy Vercel ok → elimina i branch secondari (locali e remoti).
4. Comunica al titolare che i due casi (adulto inserito come bambino, doppione) si eliminano dalla linguetta «Non iscritti».
```
