# Eliminare una voce di pagamento generata per errore — piano di implementazione

> **Per chi esegue:** REQUIRED SUB-SKILL: superpowers:executing-plans (scelto dal titolare: autonomia
> fino al deploy). I passi usano le caselle `- [ ]`.

**Obiettivo:** la segreteria e l'admin eliminano dalla finestra «Modifica» una voce generata per
errore, con le guardie fiscali e contabili di oggi; una ricarica di ticket si porta via i suoi ticket.

**Architettura:** le guardie traslocano in `src/lib/pagamenti/voce-eliminabile.ts`, usata da tre
route (DELETE della voce, nuova GET «eliminabile», POST delle rate con sostituzione). Lo storno
della ricarica + la DELETE stanno in una funzione SQL (`elimina_voce_ricarica_ticket`), una
transazione sola. L'interfaccia è un componente nuovo, `EliminaVoceZona`, dentro
`ModificaPagamentoModal`, che chiede il verdetto al server.

**Stack:** Next.js (App Router, route `withRoute`), Supabase/PostgREST con client service-role,
PL/pgSQL, vitest + finto Supabase (`__tests__/fixtures/finto-supabase.ts`) + PGlite, next-intl.

**Spec:** `docs/superpowers/specs/2026-10-12-elimina-voce-pagamento-design.md`.

**Regole di casa che valgono per ogni task** (AGENTS.md, `.claude/rules/`):
- mai `console.*` in `src/`: `logEvento` / `logErrore` da `@/lib/logging/logger`;
- PostgREST non lancia: si controlla sempre `{ error }`;
- mai PII nei log (solo uuid, numeri, booleani, codici);
- dati di test sintetici, repository pubblico;
- un test si vede ROSSO prima di vederlo verde, e si controlla la riga `Test Files N passed`.

---

## Mappa dei file

| File | Responsabilità |
|---|---|
| `src/lib/ui/esito-fetch.ts` (mod) | 6 codici nuovi in `CODICI_ERRORE` |
| `messages/it/shared.json`, `messages/en/shared.json` (mod) | testi dei 6 codici, in coda |
| `messages/it/adminContabilita.json`, `messages/en/adminContabilita.json` (mod) | testi della zona, in coda |
| `supabase/migrations/<UTC>_elimina_voce_ricarica_ticket.sql` (nuovo) | funzione SQL |
| `__tests__/lib/elimina-voce-ricarica-ticket-sql.test.ts` (nuovo) | la funzione su Postgres vero |
| `__tests__/architecture/elimina-voce-ricarica-una-transazione.test.ts` (nuovo) | lock: blocco prima del saldo, DELETE nella funzione |
| `src/lib/pagamenti/voce-eliminabile.ts` (nuovo) | le guardie, una volta sola |
| `__tests__/pagamenti/voce-eliminabile.test.ts` (nuovo) | la funzione delle guardie |
| `src/app/api/pagamenti/[id]/route.ts` (mod) | DELETE: gate, guardie condivise, RPC, revoca, log |
| `__tests__/api/pagamenti-elimina-voce.test.ts` (nuovo) | DELETE e GET eliminabile |
| `src/app/api/pagamenti/[id]/eliminabile/route.ts` (nuovo) | verdetto per l'interfaccia |
| `src/app/api/pagamenti/rate/route.ts` (mod) | sostituzione lato server |
| `__tests__/api/pagamenti-rate-sostituzione.test.ts` (nuovo) | sostituzione |
| `src/components/features/admin/pagamenti/RateizzaModal.tsx` (mod) | niente più DELETE dal browser |
| `__tests__/components/RateizzaModal-metodi.test.tsx` (mod) | idem |
| `src/components/features/admin/pagamenti/EliminaVoceZona.tsx` (nuovo) | zona «Elimina voce» |
| `src/components/features/admin/pagamenti/ModificaPagamentoModal.tsx` (mod) | monta la zona |
| `__tests__/components/EliminaVoceZona.test.tsx` (nuovo) | la zona |
| `PRD REGISTRO ELETTRONICO.md` (mod) | changelog + stato (anche mensa #226 🟡→✅) |

---

### Task 1: codici d'errore e testi

**Files:** `src/lib/ui/esito-fetch.ts` (dopo `ELIMINAZIONE_NON_RIUSCITA`, ~riga 3304) ·
`messages/{it,en}/shared.json` (in coda) · `messages/{it,en}/adminContabilita.json` (in coda)

- [ ] **Step 1: aggiungere i codici** in `CODICI_ERRORE`, subito dopo
  `ELIMINAZIONE_NON_RIUSCITA: 'erroreEliminazioneNonRiuscita',`:

```ts
    /**
     * 409 — eliminazione di una voce di pagamento (2026-10-12, «pagamenti generati per errore»).
     * Le guardie stanno in `src/lib/pagamenti/voce-eliminabile.ts`; la zona «Elimina voce» della
     * finestra Modifica mostra questi testi come motivo quando il pulsante non c'è.
     *  · VOCE_FATTURATA: fattura emessa sulla voce o su una rata (conservazione fiscale);
     *  · VOCE_RATA: si elimina il piano dalla voce principale, non la singola rata;
     *  · VOCE_NON_SOSTITUIBILE: Rateizza su una voce non singola o di un altro bambino;
     *  · ORDINE_DIVISE_ATTIVO: la voce è l'addebito di un ordine divise non annullato;
     *  · TICKET_GIA_USATI: i ticket della ricarica sono già stati consumati.
     * 503 — ELIMINAZIONE_RICARICA_NON_DISPONIBILE: la funzione SQL manca (DB non migrato), la voce resta.
     */
    VOCE_FATTURATA: 'erroreVoceFatturata',
    VOCE_RATA: 'erroreVoceRata',
    VOCE_NON_SOSTITUIBILE: 'erroreVoceNonSostituibile',
    ORDINE_DIVISE_ATTIVO: 'erroreOrdineDiviseAttivo',
    TICKET_GIA_USATI: 'erroreTicketGiaUsati',
    ELIMINAZIONE_RICARICA_NON_DISPONIBILE: 'erroreEliminazioneRicaricaNonDisponibile',
```

- [ ] **Step 2: testi in coda a `messages/it/shared.json`** (prima della `}` finale; aggiungere la
  virgola alla riga precedente):

```json
  "erroreVoceFatturata": "La voce ha una fattura emessa: non si elimina per conservazione fiscale. Annulla o storna prima la fattura.",
  "erroreVoceRata": "È una rata di un piano: si elimina il piano intero dalla voce principale.",
  "erroreVoceNonSostituibile": "Questa voce non si può sostituire con un piano rateale: deve essere una voce singola dello stesso bambino.",
  "erroreOrdineDiviseAttivo": "È l’addebito di un ordine divise ancora attivo: annulla prima l’ordine.",
  "erroreTicketGiaUsati": "I ticket di questa ricarica sono già stati usati: la voce non si può eliminare.",
  "erroreEliminazioneRicaricaNonDisponibile": "L’eliminazione di una ricarica di ticket non è disponibile su questo ambiente: la voce non è stata eliminata."
```

  e in `messages/en/shared.json`:

```json
  "erroreVoceFatturata": "This item has an issued invoice: it cannot be deleted for tax retention. Cancel or reverse the invoice first.",
  "erroreVoceRata": "This is an instalment of a plan: delete the whole plan from its main item.",
  "erroreVoceNonSostituibile": "This item cannot be replaced by an instalment plan: it must be a single item of the same child.",
  "erroreOrdineDiviseAttivo": "This is the charge of a uniform order that is still active: cancel the order first.",
  "erroreTicketGiaUsati": "The tickets of this top-up have already been used: the item cannot be deleted.",
  "erroreEliminazioneRicaricaNonDisponibile": "Deleting a ticket top-up is not available in this environment: the item was not deleted."
```

- [ ] **Step 3: testi della zona in coda a `messages/it/adminContabilita.json`:**

```json
  "eliminaTitolo": "Elimina voce",
  "eliminaPulsante": "Elimina voce",
  "eliminaDomanda": "Eliminare «{descrizione}», {importo}? Non si può annullare.",
  "eliminaConRate": "Si eliminano anche le sue {n} rate.",
  "eliminaConTicket": "Si tolgono anche i {n} ticket mensa di questa ricarica.",
  "eliminaAnnulla": "Annulla",
  "eliminaConferma": "Sì, elimina",
  "eliminaInCorso": "Eliminazione…",
  "eliminaNonControllabile": "Non riesco a controllare la voce: riapri la finestra.",
  "eliminaErrRete": "Connessione non riuscita: la voce non è stata eliminata.",
  "eliminaErrGenerico": "L’eliminazione non è riuscita."
```

  e in `messages/en/adminContabilita.json`:

```json
  "eliminaTitolo": "Delete item",
  "eliminaPulsante": "Delete item",
  "eliminaDomanda": "Delete “{descrizione}”, {importo}? This cannot be undone.",
  "eliminaConRate": "Its {n} instalments are deleted too.",
  "eliminaConTicket": "The {n} meal tickets of this top-up are removed too.",
  "eliminaAnnulla": "Cancel",
  "eliminaConferma": "Yes, delete",
  "eliminaInCorso": "Deleting…",
  "eliminaNonControllabile": "I can’t check this item: reopen the window.",
  "eliminaErrRete": "Connection failed: the item was not deleted.",
  "eliminaErrGenerico": "Deletion failed."
```

- [ ] **Step 4: lock dei cataloghi**

Run: `npx vitest run __tests__/i18n 2>&1 | tail -8`
Expected: `Test Files N passed` con N = numero dei file in `__tests__/i18n` (nessun fallimento).
Se un lock chiede la stessa chiave in altri cataloghi, aggiungerla dove lo chiede.

- [ ] **Step 5: commit**

```bash
git add src/lib/ui/esito-fetch.ts messages/it/shared.json messages/en/shared.json messages/it/adminContabilita.json messages/en/adminContabilita.json
git commit -m "Pagamenti: codici e testi per l'eliminazione di una voce"
```

---

### Task 2: la funzione SQL `elimina_voce_ricarica_ticket`

**Files:** Create `supabase/migrations/<UTC>_elimina_voce_ricarica_ticket.sql` ·
`__tests__/lib/elimina-voce-ricarica-ticket-sql.test.ts` ·
`__tests__/architecture/elimina-voce-ricarica-una-transazione.test.ts`

Il nome si prende con `date -u +%Y%m%d%H%M%S` nel momento in cui si crea il file (mai un orario
tondo, mai nel futuro). Nello SQL **non** scrivere le parole `unique`, `primary key`, `policy`, né
`REFERENCES public.utenti`: farebbero scattare le guardie delle fotografie senza motivo.

- [ ] **Step 1: test SQL rosso** — `__tests__/lib/elimina-voce-ricarica-ticket-sql.test.ts`:

```ts
// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { migrazione, schemaSoldi, TABELLE_SOLDI } from '../helpers/schema-soldi-pglite'

/**
 * ELIMINARE UNA VOCE DI RICARICA TICKET · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Una ricarica crea la voce e accredita SUBITO i ticket. Eliminare la voce senza togliere i
 * ticket lascerebbe pasti gratis (la FK del ledger è SET NULL): la funzione storna i ticket e
 * cancella la voce nella stessa transazione, e rifiuta se i ticket sono già stati usati.
 * Solo dati finti.
 */

const NUOVA = migrazione('_elimina_voce_ricarica_ticket.sql')
const SEDE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = 'e0000000-0000-4000-8000-000000000001'
const OPERATORE = 'b0000000-0000-4000-8000-000000000001'
const VOCE = 'c0000000-0000-4000-8000-000000000001'

let db: PGlite
type Esito = { esito: string } & Record<string, unknown>

async function elimina(id = VOCE): Promise<Esito> {
  const r = await db.query<{ r: Esito }>(
    'SELECT public.elimina_voce_ricarica_ticket(p_pagamento_id => $1, p_operatore => $2) AS r',
    [id, OPERATORE],
  )
  return r.rows[0].r
}

async function stato() {
  const r = await db.query<{ saldo: number | null; voci: number; ricariche: number; rettifiche: number; delta_rettifica: number | null }>(`
    SELECT (SELECT saldo_ticket FROM public.ticket_mensa WHERE alunno_id = $1) AS saldo,
           (SELECT count(*)::int FROM public.pagamenti WHERE id = $2) AS voci,
           (SELECT count(*)::int FROM public.mensa_ticket_movimenti WHERE tipo = 'ricarica') AS ricariche,
           (SELECT count(*)::int FROM public.mensa_ticket_movimenti WHERE tipo = 'rettifica') AS rettifiche,
           (SELECT delta FROM public.mensa_ticket_movimenti WHERE tipo = 'rettifica' LIMIT 1) AS delta_rettifica`,
    [ALUNNO, VOCE])
  return r.rows[0]
}

/** Una ricarica da `pezzi` ticket, come la scrive `ricarica_ticket_mensa`, più `consumati` già usati. */
async function ricarica(pezzi: number, consumati = 0) {
  await db.query(
    `INSERT INTO public.pagamenti (id, scuola_id, alunno_id, descrizione, importo, tipo, stato)
     VALUES ($1, $2, $3, 'Ricarica mensa — finta', 45, 'singolo', 'da_pagare')`, [VOCE, SEDE, ALUNNO])
  await db.query('INSERT INTO public.ticket_mensa (alunno_id, saldo_ticket) VALUES ($1, $2)', [ALUNNO, pezzi - consumati])
  await db.query(
    `INSERT INTO public.mensa_ticket_movimenti (alunno_id, scuola_id, tipo, delta, saldo_dopo, pagamento_id, origine)
     VALUES ($1, $2, 'ricarica', $3, $3, $4, 'segreteria')`, [ALUNNO, SEDE, pezzi, VOCE])
}

beforeAll(async () => {
  db = new PGlite()
  await schemaSoldi(db)
  await db.exec(NUOVA)
})
afterAll(async () => { await db.close() })
beforeEach(async () => {
  await db.exec(`TRUNCATE ${TABELLE_SOLDI} CASCADE;`)
  await db.query('INSERT INTO public.alunni (id, scuola_id) VALUES ($1, $2)', [ALUNNO, SEDE])
})

describe('elimina_voce_ricarica_ticket · voce e ticket insieme', () => {
  it('la migrazione si riapplica senza errori (CREATE OR REPLACE)', async () => {
    await db.exec(NUOVA)
  })

  it('ricarica intatta: saldo scende dei ticket della ricarica, una «rettifica», voce sparita', async () => {
    await ricarica(10)
    const e = await elimina()
    expect(e).toMatchObject({ esito: 'eliminata', ticket_tolti: 10, saldo_dopo: 0 })
    expect(await stato()).toEqual({ saldo: 0, voci: 0, ricariche: 1, rettifiche: 1, delta_rettifica: -10 })
  })

  it('saldo più alto della ricarica (altri ticket): toglie solo quelli della ricarica', async () => {
    await ricarica(10)
    await db.query('UPDATE public.ticket_mensa SET saldo_ticket = 14 WHERE alunno_id = $1', [ALUNNO])
    const e = await elimina()
    expect(e).toMatchObject({ esito: 'eliminata', ticket_tolti: 10, saldo_dopo: 4 })
  })

  it('🔴 ticket già usati (saldo sotto la ricarica) → «ticket_gia_usati», NIENTE scritto', async () => {
    await ricarica(10, 3)
    const prima = await stato()
    const e = await elimina()
    expect(e).toMatchObject({ esito: 'ticket_gia_usati', ticket: 10, saldo: 7 })
    expect(await stato()).toEqual(prima)
  })

  it('voce inesistente → «non_trovata»', async () => {
    expect((await elimina()).esito).toBe('non_trovata')
  })

  it('voce senza ricarica → «senza_ricarica», la voce resta', async () => {
    await db.query(
      `INSERT INTO public.pagamenti (id, scuola_id, alunno_id, descrizione, importo, tipo, stato)
       VALUES ($1, $2, $3, 'Gita finta', 10, 'singolo', 'da_pagare')`, [VOCE, SEDE, ALUNNO])
    expect((await elimina()).esito).toBe('senza_ricarica')
    expect((await stato()).voci).toBe(1)
  })

  it('🔴 un incasso sulla voce: la FK RESTRICT fa tornare indietro TUTTO (saldo e ledger invariati)', async () => {
    await ricarica(10)
    await db.query(`INSERT INTO public.incassi (pagamento_id, importo, metodo) VALUES ($1, 45, 'contanti')`, [VOCE])
    const prima = await stato()
    await expect(elimina()).rejects.toThrow(/foreign key|violates/i)
    expect(await stato()).toEqual(prima)
  })
})
```

- [ ] **Step 2: rosso**

Run: `npx vitest run __tests__/lib/elimina-voce-ricarica-ticket-sql.test.ts 2>&1 | tail -6`
Expected: FAIL — `migrazione *_elimina_voce_ricarica_ticket.sql non trovata`.

- [ ] **Step 3: la migrazione** (`F=supabase/migrations/$(date -u +%Y%m%d%H%M%S)_elimina_voce_ricarica_ticket.sql`):

```sql
-- =============================================================================
-- ELIMINARE UNA VOCE DI RICARICA TICKET · VOCE E TICKET IN UNA TRANSAZIONE
-- Richiesta del titolare del 2026-10-12: «eliminare pagamenti generati per errore».
--
-- Una ricarica (`ricarica_ticket_mensa`) crea la voce Mensa e accredita SUBITO i
-- ticket. La FK del ledger verso `pagamenti` è SET NULL: cancellare la voce da
-- sola lascerebbe i ticket accreditati senza più nessun debito dietro. Al
-- 12/10 le voci di ricarica non pagate erano 41.
--
-- Questa funzione storna i ticket della ricarica (movimento «rettifica» col
-- delta opposto) e cancella la voce nella STESSA transazione. Se i ticket sono
-- già stati usati (saldo sotto la ricarica) non scrive niente. Un incasso
-- arrivato nel frattempo fa scattare la FK RESTRICT degli incassi e riporta
-- indietro anche lo storno.
--
-- Blocco: lo stesso advisory lock di `ricarica_ticket_mensa`, così una ricarica
-- e un'eliminazione dello stesso bambino non si incrociano; la riga del saldo
-- è presa FOR UPDATE, così un consumo aspetta.
--
-- Solo una funzione: nessuna tabella, nessun indice.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.elimina_voce_ricarica_ticket(
  p_pagamento_id uuid,
  p_operatore    uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_alunno  uuid;
  v_scuola  uuid;
  v_ticket  integer;
  v_saldo   integer;
BEGIN
  SELECT alunno_id INTO v_alunno FROM public.pagamenti WHERE id = p_pagamento_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovata');
  END IF;

  -- 🔒 Lo stesso blocco delle ricariche di questo bambino.
  PERFORM pg_advisory_xact_lock(hashtextextended('ricarica_ticket_mensa:' || v_alunno::text, 0));

  -- Riletta DOPO il blocco, e bloccata: chi è arrivato prima può averla già tolta.
  SELECT alunno_id, scuola_id INTO v_alunno, v_scuola
    FROM public.pagamenti WHERE id = p_pagamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('esito', 'non_trovata');
  END IF;

  SELECT COALESCE(sum(delta), 0)::integer INTO v_ticket
    FROM public.mensa_ticket_movimenti
   WHERE pagamento_id = p_pagamento_id AND tipo = 'ricarica';
  IF v_ticket <= 0 THEN
    RETURN jsonb_build_object('esito', 'senza_ricarica');
  END IF;

  SELECT COALESCE(saldo_ticket, 0) INTO v_saldo
    FROM public.ticket_mensa WHERE alunno_id = v_alunno FOR UPDATE;
  IF NOT FOUND THEN
    v_saldo := 0;
  END IF;
  IF v_saldo < v_ticket THEN
    RETURN jsonb_build_object('esito', 'ticket_gia_usati', 'ticket', v_ticket, 'saldo', v_saldo);
  END IF;

  v_saldo := public.varia_saldo_ticket(v_alunno, -v_ticket);

  INSERT INTO public.mensa_ticket_movimenti
    (alunno_id, scuola_id, tipo, delta, saldo_dopo, pagamento_id, origine, note, creato_da)
  VALUES
    (v_alunno, v_scuola, 'rettifica', -v_ticket, v_saldo, NULL, 'segreteria',
     'Storno ricarica (voce eliminata)', p_operatore);

  DELETE FROM public.pagamenti WHERE id = p_pagamento_id;

  RETURN jsonb_build_object('esito', 'eliminata', 'ticket_tolti', v_ticket, 'saldo_dopo', v_saldo);
END $$;

-- In Supabase `REVOKE … FROM PUBLIC` non basta: `anon` e `authenticated` hanno
-- l'EXECUTE per GRANT esplicito (`pg_default_acl`), quindi vanno nominati.
REVOKE ALL ON FUNCTION public.elimina_voce_ricarica_ticket(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.elimina_voce_ricarica_ticket(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.elimina_voce_ricarica_ticket(uuid, uuid) IS
  'Elimina una voce di ricarica ticket mensa stornando i suoi ticket (movimento rettifica) nella stessa transazione; rifiuta se i ticket sono già stati usati. Dal 2026-10-12.';

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 4: verde**

Run: `npx vitest run __tests__/lib/elimina-voce-ricarica-ticket-sql.test.ts 2>&1 | tail -6`
Expected: `Test Files 1 passed`, `Tests 6 passed`. Poi ROMPERE di proposito (togliere la riga
`DELETE FROM public.pagamenti …`): il test «ricarica intatta» deve diventare rosso. Rimettere.

- [ ] **Step 5: lock** — `__tests__/architecture/elimina-voce-ricarica-una-transazione.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK · ELIMINARE UNA RICARICA TOGLIE I TICKET NELLA STESSA TRANSAZIONE.
 *
 * Una voce di ricarica cancellata da sola lascia i ticket accreditati (FK del ledger SET NULL).
 * Questo file tiene ferme le due metà: la funzione prende il blocco del bambino PRIMA di leggere
 * il saldo e cancella la voce DOPO lo storno; la route della voce non tocca il saldo da sé.
 */

const RADICE = process.cwd()
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
const ROUTE = join(RADICE, 'src', 'app', 'api', 'pagamenti', '[id]', 'route.ts')

function corpo(nome: string): { file: string; corpo: string } {
  const file = readdirSync(MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => new RegExp(`FUNCTION\\s+public\\.${nome}\\s*\\(`, 'i').test(readFileSync(join(MIGRAZIONI, f), 'utf8')))
    .pop()
  if (!file) throw new Error(`nessuna migrazione definisce public.${nome}`)
  const sql = senzaCommenti(readFileSync(join(MIGRAZIONI, file), 'utf8'))
  const inizio = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${nome}\\s*\\(`, 'i'))
  const fine = sql.indexOf('END $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error(`corpo di ${nome} non trovato in ${file}`)
  return { file, corpo: sql.slice(inizio, fine) }
}

const tsSenzaCommenti = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

describe('lock · elimina_voce_ricarica_ticket', () => {
  const { file, corpo: c } = corpo('elimina_voce_ricarica_ticket')

  it('blocco del bambino prima del saldo, storno prima della DELETE', () => {
    const blocco = c.search(/pg_advisory_xact_lock\s*\(\s*hashtextextended\(\s*'ricarica_ticket_mensa:'/i)
    const saldo = c.search(/FROM\s+public\.ticket_mensa[\s\S]{0,80}FOR\s+UPDATE/i)
    const storno = c.search(/public\.varia_saldo_ticket\s*\(/i)
    const rettifica = c.search(/INSERT\s+INTO\s+public\.mensa_ticket_movimenti/i)
    const cancella = c.search(/DELETE\s+FROM\s+public\.pagamenti/i)
    expect(blocco, `${file}: manca il blocco delle ricariche`).toBeGreaterThan(-1)
    expect(saldo).toBeGreaterThan(blocco)
    expect(storno).toBeGreaterThan(saldo)
    expect(rettifica).toBeGreaterThan(storno)
    expect(cancella, `${file}: la voce va cancellata DOPO lo storno, nella funzione`).toBeGreaterThan(rettifica)
  })

  it('la route della voce chiama la RPC e non tocca il saldo da sé', () => {
    const src = tsSenzaCommenti(readFileSync(ROUTE, 'utf8'))
    expect(src).toMatch(/\.rpc\(\s*'elimina_voce_ricarica_ticket'/)
    expect(src).not.toMatch(/varia_saldo_ticket/)
    expect(src).not.toMatch(/from\(\s*'(ticket_mensa|mensa_ticket_movimenti)'\s*\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/)
  })

  it('controllo positivo: il riconoscitore vede una cancellazione fuori posto', () => {
    const rotto = `PERFORM pg_advisory_xact_lock(hashtextextended('ricarica_ticket_mensa:' || x, 0));
      DELETE FROM public.pagamenti WHERE id = p;
      SELECT 1 FROM public.ticket_mensa WHERE a = b FOR UPDATE;
      v := public.varia_saldo_ticket(a, -1);
      INSERT INTO public.mensa_ticket_movimenti VALUES (1);`
    expect(rotto.search(/DELETE\s+FROM\s+public\.pagamenti/i)).toBeLessThan(rotto.search(/INSERT\s+INTO\s+public\.mensa_ticket_movimenti/i))
  })
})
```

  Il secondo `it` resta ROSSO fino al Task 4 (la route non chiama ancora la RPC): è previsto.

- [ ] **Step 6: lock delle migrazioni**

Run: `npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/soglia-fotografia.test.ts __tests__/architecture/security-definer-revoke-lock.test.ts __tests__/architecture/migrazioni-senza-sede-cablata.test.ts 2>&1 | tail -8`
Expected: tutti verdi. Se una guardia delle fotografie segnala il file, NON dichiararlo d'istinto:
leggere quale riconoscitore scatta e togliere dallo SQL la parola che lo fa scattare (Step 3).

- [ ] **Step 7: commit**

```bash
git add supabase/migrations/*_elimina_voce_ricarica_ticket.sql __tests__/lib/elimina-voce-ricarica-ticket-sql.test.ts __tests__/architecture/elimina-voce-ricarica-una-transazione.test.ts
git commit -m "Mensa: eliminare una voce di ricarica storna i suoi ticket nella stessa transazione"
```

---

### Task 3: le guardie in `src/lib/pagamenti/voce-eliminabile.ts`

**Files:** Create `src/lib/pagamenti/voce-eliminabile.ts` · `__tests__/pagamenti/voce-eliminabile.test.ts`

- [ ] **Step 1: test rosso** — `__tests__/pagamenti/voce-eliminabile.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type Riga } from '../fixtures/finto-supabase'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Le guardie dell'eliminazione di una voce, scritte una volta sola (2026-10-12). Le usano la
 * DELETE della voce, la GET «eliminabile» e la sostituzione di Rateizza. Ogni caso guarda il
 * VERDETTO e, dove conta, che una lettura guasta non diventi via libera. Dati sintetici.
 */

vi.mock('@/lib/logging/logger', async (orig) => ({ ...(await orig<object>()), logEvento: vi.fn(), logErrore: vi.fn() }))

import { controllaVoceEliminabile } from '@/lib/pagamenti/voce-eliminabile'

const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const PAG = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const RATA = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const GUASTO = { code: '57014', message: 'canceling statement due to statement timeout' }

let db: DBFinto
const voce = (extra: Riga = {}): Riga => ({
  id: PAG, alunno_id: ALU, scuola_id: SEDE_A, descrizione: 'Gita finta', importo: 30, importo_pagato: 0,
  stato: 'da_pagare', tipo: 'singolo', ...extra,
})
const sb = (errori?: Record<string, { code: string; message: string }>) =>
  creaFintoSupabase(db, [], errori ? { errori } : {}) as unknown as SupabaseClient
const controlla = (s: SupabaseClient, perSostituzione = false) =>
  controllaVoceEliminabile(s, PAG, { sedi: [SEDE_A], perSostituzione, operazione: 'test' })

beforeEach(() => {
  db = {
    pagamenti: [], incassi: [], fatture_emesse: [], fatture_coda: [],
    divise_ordini: [], mensa_ticket_movimenti: [], ticket_mensa: [],
  } as DBFinto
})

describe('controllaVoceEliminabile', () => {
  it('voce pulita → eliminabile, famiglia = sé stessa, 0 rate, 0 ticket', async () => {
    db.pagamenti = [voce()]
    const e = await controlla(sb())
    expect(e).toMatchObject({ ok: true, famiglia: [PAG], rate: 0, ticket: 0 })
  })

  it('voce fuori dalle sedi attive → 404', async () => {
    db.pagamenti = [voce({ scuola_id: 'f0f0f0f0-0000-4000-8000-000000000000' })]
    expect(await controlla(sb())).toMatchObject({ ok: false, stato: 404 })
  })

  it('rata → 409 VOCE_RATA', async () => {
    db.pagamenti = [voce({ tipo: 'rata', parent_payment_id: RATA })]
    expect(await controlla(sb())).toMatchObject({ ok: false, stato: 409, codice: 'VOCE_RATA' })
  })

  it('padre con 2 rate pulite → eliminabile con rate = 2', async () => {
    db.pagamenti = [voce({ tipo: 'padre' }), voce({ id: RATA, tipo: 'rata', parent_payment_id: PAG }),
      voce({ id: 'b3b3b3b3-3333-4333-8333-bbbbbbbbbbbb', tipo: 'rata', parent_payment_id: PAG })]
    expect(await controlla(sb())).toMatchObject({ ok: true, rate: 2 })
  })

  it('fattura emessa su una rata → 409 VOCE_FATTURATA', async () => {
    db.pagamenti = [voce({ tipo: 'padre' }), voce({ id: RATA, tipo: 'rata', parent_payment_id: PAG })]
    db.fatture_emesse = [{ id: 'f1', pagamento_id: RATA }]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'VOCE_FATTURATA' })
  })

  it('incasso stornato → 409 VOCE_CON_INCASSI', async () => {
    db.pagamenti = [voce()]
    db.incassi = [{ id: 'i1', pagamento_id: PAG, importo: 10, transazione_id: null }, { id: 'i2', pagamento_id: PAG, importo: -10, transazione_id: null }]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'VOCE_CON_INCASSI' })
  })

  it('coda fatture occupata → 409 VOCE_IN_CODA_FATTURE', async () => {
    db.pagamenti = [voce()]
    db.fatture_coda = [{ id: 'q1', pagamento_id: PAG, stato: 'in_coda' }]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'VOCE_IN_CODA_FATTURE' })
  })

  it('ordine divise attivo → 409 ORDINE_DIVISE_ATTIVO; annullato → eliminabile', async () => {
    db.pagamenti = [voce()]
    db.divise_ordini = [{ id: 'o1', pagamento_id: PAG, stato: 'inviato' }]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'ORDINE_DIVISE_ATTIVO' })
    db.divise_ordini = [{ id: 'o1', pagamento_id: PAG, stato: 'annullato' }]
    expect(await controlla(sb())).toMatchObject({ ok: true })
  })

  it('ricarica con ticket intatti → eliminabile con ticket = 10', async () => {
    db.pagamenti = [voce()]
    db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
    db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 12 }]
    expect(await controlla(sb())).toMatchObject({ ok: true, ticket: 10 })
  })

  it('ricarica con ticket già usati → 409 TICKET_GIA_USATI', async () => {
    db.pagamenti = [voce()]
    db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
    db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 7 }]
    expect(await controlla(sb())).toMatchObject({ ok: false, codice: 'TICKET_GIA_USATI' })
  })

  it('perSostituzione: ricarica e ordine attivo NON bloccano, ticket = 0', async () => {
    db.pagamenti = [voce()]
    db.divise_ordini = [{ id: 'o1', pagamento_id: PAG, stato: 'inviato' }]
    db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
    db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 0 }]
    expect(await controlla(sb(), true)).toMatchObject({ ok: true, ticket: 0 })
  })

  for (const tabella of ['pagamenti', 'incassi', 'fatture_emesse', 'fatture_coda', 'divise_ordini', 'mensa_ticket_movimenti', 'ticket_mensa']) {
    it(`🔴 ${tabella} non letta per un guasto → 500, mai via libera`, async () => {
      db.pagamenti = [voce()]
      db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
      db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 12 }]
      const e = await controlla(sb({ [`${tabella}:select`]: GUASTO }))
      expect(e.ok).toBe(false)
      expect('guasto' in e && e.guasto.status).toBe(500)
    })
  }

  it('tabelle assenti sul DB non migrato (42P01) → saltano, come oggi', async () => {
    db.pagamenti = [voce()]
    const assente = { code: '42P01', message: 'relation does not exist' }
    const e = await controlla(sb({ 'fatture_emesse:select': assente, 'fatture_coda:select': assente, 'divise_ordini:select': assente }))
    expect(e).toMatchObject({ ok: true })
  })
})
```

- [ ] **Step 2: rosso**

Run: `npx vitest run __tests__/pagamenti/voce-eliminabile.test.ts 2>&1 | tail -6`
Expected: FAIL — `Failed to resolve import "@/lib/pagamenti/voce-eliminabile"`.

- [ ] **Step 3: implementazione** — `src/lib/pagamenti/voce-eliminabile.ts`:

```ts
import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/pagamenti/guasto-db'
import { CODICI_COLONNA_ASSENTE } from '@/lib/pagamenti/metodi-ammessi'
import { STATI_CODA_OCCUPATA } from '@/lib/pagamenti/fatturazione-riga'

/**
 * LE GUARDIE DELL'ELIMINAZIONE DI UNA VOCE — scritte una volta sola (2026-10-12).
 *
 * Erano dentro `DELETE /api/pagamenti/[id]` (fase 7 della robustezza). Ora le usano tre route:
 * la DELETE, `GET /api/pagamenti/[id]/eliminabile` (il verdetto per la finestra Modifica) e la
 * sostituzione di Rateizza (`POST /api/pagamenti/rate`). Il primo controllo che rifiuta decide.
 *
 * Una lettura che fallisce per un guasto ferma tutto (500): una guardia che non ha potuto
 * guardare non dà via libera. Salta solo dove lo schema manca davvero (DB E2E non migrato).
 *
 * `perSostituzione`: Rateizza sostituisce la voce con un piano dello stesso importo, quindi il
 * debito continua — la ricarica di ticket e l'ordine divise non bloccano, e i ticket restano.
 */

/** Tabella assente sul DB non migrato. */
export const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

export type VoceDaEliminare = {
  id: string
  alunno_id: string | null
  scuola_id: string | null
  tipo: string
  [k: string]: unknown
}

export type EsitoEliminabile =
  | { ok: true; voce: VoceDaEliminare; famiglia: string[]; rate: number; ticket: number }
  | { ok: false; stato: 404 | 409; codice?: string; error: string }
  | { ok: false; guasto: NextResponse }

type Opzioni = { sedi: string[]; perSostituzione: boolean; operazione: string }

const rifiuto = (codice: string, error: string): EsitoEliminabile => ({ ok: false, stato: 409, codice, error })

export async function controllaVoceEliminabile(
  supabase: SupabaseClient,
  id: string,
  { sedi, perSostituzione, operazione }: Opzioni,
): Promise<EsitoEliminabile> {
  const guasto = (evento: string, error: unknown): EsitoEliminabile => ({ ok: false, guasto: rispostaGuastoDb(operazione, evento, error) })

  const { data: letta, error: errVoce } = await supabase.from('pagamenti').select('*').eq('id', id).maybeSingle()
  if (errVoce) return guasto('db:pagamenti', errVoce)
  const voce = letta as VoceDaEliminare | null
  if (!voce || !sedi.includes(String(voce.scuola_id))) return { ok: false, stato: 404, error: 'Pagamento non trovato' }

  if (voce.tipo === 'rata') {
    return rifiuto('VOCE_RATA', 'È una rata di un piano: si elimina il piano intero dalla voce principale.')
  }

  // La DELETE porta via in CASCADE rate e quote (`parent_payment_id`): ogni guardia guarda la
  // voce E le figlie (fase 7).
  const { data: figlie, error: errFiglie } = await supabase.from('pagamenti').select('id').eq('parent_payment_id', id)
  if (errFiglie) return guasto('db:pagamenti:figlie', errFiglie)
  const famiglia = [id, ...((figlie ?? []) as { id: string }[]).map((f) => f.id)]

  // Conservazione fiscale: FK RESTRICT + WORM.
  const fatt = await supabase.from('fatture_emesse').select('id').in('pagamento_id', famiglia).limit(1)
  if (fatt.error && !TABELLA_ASSENTE.has(fatt.error.code ?? '')) return guasto('db:fatture_emesse:guardia', fatt.error)
  if (!fatt.error && (fatt.data?.length ?? 0) > 0) {
    return rifiuto('VOCE_FATTURATA', 'Pagamento con fattura emessa: non eliminabile per conservazione fiscale. Annulla/storna prima la fattura.')
  }

  // Un incasso qualunque, anche stornato, è contabilità: la voce resta (fase 7).
  const inc = await supabase.from('incassi').select('id').in('pagamento_id', famiglia).limit(1)
  if (inc.error) return guasto('db:incassi:guardia', inc.error)
  if ((inc.data?.length ?? 0) > 0) {
    // Solo per dire la via d'uscita giusta: la decisione è già presa.
    const tx = await supabase.from('incassi').select('id').in('pagamento_id', famiglia).not('transazione_id', 'is', null).limit(1)
    if (tx.error && !CODICI_COLONNA_ASSENTE.includes(tx.error.code ?? '')) {
      logEvento('pagamento', 'warn', { operazione, esito: 'transazione-non-letta', pagamento_id: id }, tx.error)
    }
    const diTransazione = !tx.error && (tx.data?.length ?? 0) > 0
    logEvento('pagamento', 'info', { operazione, esito: 'eliminazione-rifiutata-incassi', pagamento_id: id, transazione: diTransazione })
    return diTransazione
      ? rifiuto('VOCE_IN_TRANSAZIONE', 'Pagamento con incassi di una transazione di famiglia: annulla prima la transazione.')
      : rifiuto('VOCE_CON_INCASSI', 'La voce ha incassi registrati (anche stornati): resta per la contabilità. Se è sbagliata, storna gli incassi e correggi la voce invece di eliminarla.')
  }

  // Una fattura in coda («in invio» = file forse già partito verso SDI) se ne andrebbe in CASCADE.
  const coda = await supabase.from('fatture_coda').select('id').in('pagamento_id', famiglia).in('stato', [...STATI_CODA_OCCUPATA]).limit(1)
  if (coda.error && !TABELLA_ASSENTE.has(coda.error.code ?? '')) return guasto('db:fatture_coda:guardia', coda.error)
  if (!coda.error && (coda.data?.length ?? 0) > 0) {
    return rifiuto('VOCE_IN_CODA_FATTURE', 'La voce ha una fattura in coda di emissione: toglila dalla coda prima di eliminare la voce.')
  }

  if (perSostituzione) return { ok: true, voce, famiglia, rate: famiglia.length - 1, ticket: 0 }

  // L'ordine divise perde il suo addebito (FK SET NULL): si elimina solo l'addebito di un ordine annullato.
  const ord = await supabase.from('divise_ordini').select('id').in('pagamento_id', famiglia).neq('stato', 'annullato').limit(1)
  if (ord.error && !TABELLA_ASSENTE.has(ord.error.code ?? '')) return guasto('db:divise_ordini:guardia', ord.error)
  if (!ord.error && (ord.data?.length ?? 0) > 0) {
    return rifiuto('ORDINE_DIVISE_ATTIVO', 'È l’addebito di un ordine divise ancora attivo: annulla prima l’ordine.')
  }

  // Ricarica ticket: i ticket accreditati se ne vanno con la voce (RPC), solo se ancora tutti lì.
  const mov = await supabase.from('mensa_ticket_movimenti').select('delta').in('pagamento_id', famiglia).eq('tipo', 'ricarica')
  if (mov.error && !TABELLA_ASSENTE.has(mov.error.code ?? '')) return guasto('db:mensa_ticket_movimenti:guardia', mov.error)
  const ticket = mov.error ? 0 : ((mov.data ?? []) as { delta: number }[]).reduce((s, m) => s + Number(m.delta), 0)
  if (ticket > 0) {
    const sal = await supabase.from('ticket_mensa').select('saldo_ticket').eq('alunno_id', String(voce.alunno_id)).maybeSingle()
    if (sal.error) return guasto('db:ticket_mensa:guardia', sal.error)
    const saldo = Number((sal.data as { saldo_ticket?: number | null } | null)?.saldo_ticket ?? 0)
    if (saldo < ticket) {
      return rifiuto('TICKET_GIA_USATI', 'I ticket di questa ricarica sono già stati usati: la voce non si può eliminare.')
    }
  }

  return { ok: true, voce, famiglia, rate: famiglia.length - 1, ticket }
}
```

- [ ] **Step 4: verde**

Run: `npx vitest run __tests__/pagamenti/voce-eliminabile.test.ts 2>&1 | tail -6`
Expected: `Test Files 1 passed`. Rompere di proposito: togliere `.neq('stato', 'annullato')` → il
caso «ordine annullato → eliminabile» diventa rosso. Rimettere.

- [ ] **Step 5: commit**

```bash
git add src/lib/pagamenti/voce-eliminabile.ts __tests__/pagamenti/voce-eliminabile.test.ts
git commit -m "Pagamenti: le guardie dell'eliminazione di una voce in una funzione condivisa"
```

---

### Task 4: `DELETE /api/pagamenti/[id]` — gate, guardie condivise, RPC, revoca, log

**Files:** Modify `src/app/api/pagamenti/[id]/route.ts:352-494` · Create
`__tests__/api/pagamenti-elimina-voce.test.ts` · i test esistenti in
`__tests__/api/pagamenti-errori-controllati.test.ts` restano verdi (stessi codici e stati).

- [ ] **Step 1: test rosso** — `__tests__/api/pagamenti-elimina-voce.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto, Riga, RispostaRpc, Scrittura } from '../fixtures/finto-supabase'

/**
 * Eliminare una voce generata per errore (2026-10-12): solo admin e segreteria; una ricarica di
 * ticket passa dalla RPC che storna i ticket; dopo l'eliminazione si ricontrolla la sospensione
 * per morosità e si logga il SUCCESSO. Il gate è emulato davvero (rispetta l'elenco dei ruoli
 * passato alla `requireStaff`), non un mock che dice sempre sì. Dati sintetici.
 */

const ALU = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const PAG = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const UTENTE = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  ruolo: 'segreteria',
  revoca: vi.fn(async () => ({ revocati: [] as string[] })),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>,
  rpcArgs: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => {
  const gate = async (_req: Request, ammessi: readonly string[] = ['admin', 'coordinator', 'segreteria']) =>
    ammessi.includes(h.ruolo)
      ? { user: { id: UTENTE, role: h.ruolo, scuola_id: SEDE_A } }
      : { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
  return { requireStaff: gate, requireUser: gate }
})
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => {} }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...(a as [])) }))
vi.mock('@/lib/logging/logger', async (orig) => ({ ...(await orig<object>()), logEvento: (...a: unknown[]) => h.logEvento(...a), logErrore: vi.fn() }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, [], {
        scritture: h.scritture as unknown as Scrittura[],
        rpc: Object.fromEntries(Object.entries(h.rpc).map(([n, f]) => [n, (args: Riga): RispostaRpc => {
          h.rpcArgs.push({ nome: n, ...args })
          return f(args) as RispostaRpc
        }])),
      }),
  }
})

import { DELETE } from '@/app/api/pagamenti/[id]/route'

const req = () => new NextRequest(`http://localhost/api/pagamenti/${PAG}`, { method: 'DELETE' })
const ctx = { params: Promise.resolve({ id: PAG }) }
const voce = (extra: Riga = {}): Riga => ({ id: PAG, alunno_id: ALU, scuola_id: SEDE_A, descrizione: 'Gita finta', importo: 30, importo_pagato: 0, stato: 'scaduto', tipo: 'singolo', ...extra })
const scritte = (t: string, op: string) => (h.scritture as Scrittura[]).filter((s) => s.tabella === t && s.operazione === op)
const eventi = (esito: string) => h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.ruolo = 'segreteria'
  h.db = {
    alunni: [{ id: ALU, scuola_id: SEDE_A }], pagamenti: [], incassi: [], fatture_emesse: [], fatture_coda: [],
    divise_ordini: [], mensa_ticket_movimenti: [], ticket_mensa: [], registro_modifiche: [],
  } as DBFinto
  h.scritture = []
  h.rpc = {}
  h.rpcArgs = []
})

describe('DELETE /api/pagamenti/[id] · chi può', () => {
  it('🔴 coordinatrice → 403, la voce resta', async () => {
    h.ruolo = 'coordinator'
    h.db.pagamenti = [voce()]
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(403)
    expect(h.db.pagamenti).toHaveLength(1)
  })

  for (const ruolo of ['admin', 'segreteria']) {
    it(`${ruolo} → 200, voce eliminata, audit, revoca sospensione, log del successo`, async () => {
      h.ruolo = ruolo
      h.db.pagamenti = [voce()]
      const res = await DELETE(req(), ctx)
      expect(res.status).toBe(200)
      expect(h.db.pagamenti).toHaveLength(0)
      expect(scritte('registro_modifiche', 'insert')).toHaveLength(1)
      expect(h.revoca).toHaveBeenCalledWith(expect.anything(), [ALU])
      expect(eventi('voce-eliminata')).toHaveLength(1)
    })
  }
})

describe('DELETE /api/pagamenti/[id] · ricarica di ticket', () => {
  const conRicarica = () => {
    h.db.pagamenti = [voce()]
    h.db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
    h.db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 10 }]
  }

  it('passa dalla RPC (non dalla DELETE diretta) e scrive ticket_tolti nell’audit', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => {
      h.db.pagamenti = []
      return { data: { esito: 'eliminata', ticket_tolti: 10, saldo_dopo: 0 }, error: null }
    }
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(200)
    expect(h.rpcArgs).toEqual([{ nome: 'elimina_voce_ricarica_ticket', p_pagamento_id: PAG, p_operatore: UTENTE }])
    expect(scritte('pagamenti', 'delete')).toEqual([])
    const audit = scritte('registro_modifiche', 'insert')[0] as unknown as { valori: { nuovo_valore?: { ticket_tolti?: number } }[] }
    expect(JSON.stringify(audit)).toContain('"ticket_tolti":10')
  })

  it('🔴 RPC «ticket_gia_usati» → 409 TICKET_GIA_USATI', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => ({ data: { esito: 'ticket_gia_usati', ticket: 10, saldo: 7 }, error: null })
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('TICKET_GIA_USATI')
  })

  it('🔴 RPC assente (DB non migrato) → 503 e la voce RESTA, nessuna DELETE diretta', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ELIMINAZIONE_RICARICA_NON_DISPONIBILE')
    expect(h.db.pagamenti).toHaveLength(1)
    expect(scritte('pagamenti', 'delete')).toEqual([])
  })

  it('🔴 RPC rifiutata dal freno (23503, incasso arrivato nel frattempo) → 409 VOCE_CON_CONTABILITA', async () => {
    conRicarica()
    h.rpc.elimina_voce_ricarica_ticket = () => ({ data: null, error: { code: '23503', message: 'violates foreign key constraint' } })
    const res = await DELETE(req(), ctx)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_CON_CONTABILITA')
  })
})
```

  Se il finto client registra le scritture con un'altra forma, adattare SOLO la lettura
  dell'audit (`JSON.stringify(...)` è voluto: non dipende dalla forma).

- [ ] **Step 2: rosso**

Run: `npx vitest run __tests__/api/pagamenti-elimina-voce.test.ts 2>&1 | tail -8`
Expected: FAIL (coordinatrice 200 invece di 403; nessun log `voce-eliminata`; RPC mai chiamata).

- [ ] **Step 3: implementazione** — in `src/app/api/pagamenti/[id]/route.ts`:

  1. import: aggiungere
     `import { controllaVoceEliminabile, TABELLA_ASSENTE } from '@/lib/pagamenti/voce-eliminabile'`;
     togliere la costante locale `TABELLA_ASSENTE` (righe 46-47) e l'import di
     `STATI_CODA_OCCUPATA` se non è più usato nel file. `CODICI_COLONNA_ASSENTE` resta (PATCH).
  2. sostituire tutto l'export `DELETE` (righe 352-494) con:

```ts
// DELETE /api/pagamenti/[id]  (admin e segreteria, 2026-10-12)
// Le guardie stanno in `controllaVoceEliminabile`. Una voce di ricarica ticket si elimina con
// la RPC che storna i suoi ticket nella stessa transazione.
export const DELETE = withRoute('pagamenti/[id]:DELETE', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response
    const { user } = auth
    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
    const c = await controllaVoceEliminabile(supabase, id, { sedi, perSostituzione: false, operazione: 'pagamenti/[id]:DELETE' })
    if (!c.ok) {
      if ('guasto' in c) return c.guasto
      return NextResponse.json({ error: c.error, ...(c.codice ? { codice: c.codice } : {}) }, { status: c.stato })
    }

    const frenoRisposta = (error: unknown) => {
      logEvento('pagamento', 'warn', { operazione: 'pagamenti/[id]:DELETE', esito: 'eliminazione-rifiutata-dal-freno', pagamento_id: id }, error)
      return NextResponse.json(
        { error: 'La voce è stata incassata o fatturata nel frattempo: non si può più eliminare. Ricarica la pagina.', codice: 'VOCE_CON_CONTABILITA' },
        { status: 409 },
      )
    }

    let ticketTolti = 0
    if (c.ticket > 0) {
      const rpc = await supabase.rpc('elimina_voce_ricarica_ticket', { p_pagamento_id: id, p_operatore: user.id })
      if (rpc.error) {
        if (RPC_ASSENTE.has(rpc.error.code ?? '')) {
          // Mai la DELETE diretta al posto della RPC: i ticket resterebbero accreditati.
          logEvento('pagamento', 'error', { operazione: 'pagamenti/[id]:DELETE', esito: 'rpc-eliminazione-ricarica-assente', pagamento_id: id }, rpc.error)
          return NextResponse.json(
            { error: 'Eliminazione di una ricarica non disponibile su questo ambiente', codice: 'ELIMINAZIONE_RICARICA_NON_DISPONIBILE' },
            { status: 503 },
          )
        }
        if (figlieTrattengono(rpc.error)) return frenoRisposta(rpc.error)
        logErrore({ operazione: 'pagamenti/[id]:DELETE', stato: 500, evento: 'rpc:elimina_voce_ricarica_ticket' }, rpc.error)
        return NextResponse.json({ error: 'Errore eliminazione', details: rpc.error.message }, { status: 500 })
      }
      const esito = (rpc.data ?? {}) as { esito?: string; ticket_tolti?: number }
      if (esito.esito === 'ticket_gia_usati') {
        return NextResponse.json({ error: 'I ticket di questa ricarica sono già stati usati: la voce non si può eliminare.', codice: 'TICKET_GIA_USATI' }, { status: 409 })
      }
      if (esito.esito === 'non_trovata') return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
      if (esito.esito !== 'eliminata') {
        // «senza_ricarica» o un esito ignoto: la voce è cambiata fra la guardia e la RPC.
        logEvento('pagamento', 'error', { operazione: 'pagamenti/[id]:DELETE', esito: 'rpc-esito-inatteso', pagamento_id: id, rpc_esito: esito.esito ?? null })
        return NextResponse.json({ error: 'La voce è cambiata nel frattempo. Ricarica la pagina.', codice: 'VOCE_CON_CONTABILITA' }, { status: 409 })
      }
      ticketTolti = Number(esito.ticket_tolti ?? c.ticket)
    } else {
      const { error } = await supabase.from('pagamenti').delete().eq('id', id)
      if (error) {
        // Un incasso o una fattura arrivati fra le guardie e la DELETE: il freno RESTRICT rifiuta.
        if (figlieTrattengono(error)) return frenoRisposta(error)
        logErrore({ operazione: 'pagamenti/[id]:DELETE', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: 'Errore eliminazione', details: error.message }, { status: 500 })
      }
    }

    // La voce è GIÀ cancellata: da qui niente cambia la risposta, ma ogni fallimento si dice.
    // Una voce scaduta tolta può azzerare lo scaduto della famiglia → revoca della sospensione.
    try {
      if (c.voce.alunno_id) await verificaRevocaSospensioneMorosita(supabase, [String(c.voce.alunno_id)])
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/[id]:DELETE', esito: 'revoca_non_verificata', pagamento_id: id }, e)
    }

    // Il `vecchio_valore` (descrizione, alunno…) vive nell'audit, MAI nei log.
    const audit = await erroreScrittura(
      supabase.from('registro_modifiche').insert({
        azione: 'elimina_pagamento',
        tabella_interessata: 'pagamenti',
        record_id: id,
        vecchio_valore: c.voce,
        ...(ticketTolti > 0 ? { nuovo_valore: { ticket_tolti: ticketTolti } } : {}),
        utente_id: user.id,
      }),
    )
    if (audit) {
      const assente = TABELLA_ASSENTE.has(audit.codice)
      logEvento('pagamento', assente ? 'info' : 'error', {
        operazione: 'pagamenti/[id]:DELETE',
        esito: assente ? 'audit-tabella-assente' : 'audit-eliminazione-non-scritto',
        pagamento_id: id,
      }, audit.errore)
    }

    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/[id]:DELETE',
      esito: 'voce-eliminata',
      pagamento_id: id,
      tipo: c.voce.tipo,
      rate: c.rate,
      ticket_tolti: ticketTolti,
    })
    return NextResponse.json({ success: true, ticket_tolti: ticketTolti })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/[id]:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
```

  Nota: il 409 della fattura ora porta `codice: 'VOCE_FATTURATA'` (prima non aveva codice): i
  test esistenti guardano solo lo stato, e restano verdi.

- [ ] **Step 4: verde, nuovi e vecchi**

Run: `npx vitest run __tests__/api/pagamenti-elimina-voce.test.ts __tests__/api/pagamenti-errori-controllati.test.ts __tests__/architecture/elimina-voce-ricarica-una-transazione.test.ts __tests__/architecture/logging-coverage.test.ts 2>&1 | tail -8`
Expected: `Test Files 4 passed`. Il lock della Task 2 ora è tutto verde. Rompere di proposito:
rimettere `requireStaff(request)` senza elenco → il test «coordinatrice → 403» diventa rosso.

- [ ] **Step 5: commit**

```bash
git add src/app/api/pagamenti/[id]/route.ts __tests__/api/pagamenti-elimina-voce.test.ts
git commit -m "Pagamenti: eliminare una voce solo admin e segreteria, ricarica con i suoi ticket, revoca della sospensione"
```

---

### Task 5: `GET /api/pagamenti/[id]/eliminabile`

**Files:** Create `src/app/api/pagamenti/[id]/eliminabile/route.ts` · aggiungere i casi a
`__tests__/api/pagamenti-elimina-voce.test.ts`

- [ ] **Step 1: test rosso** — in coda a `__tests__/api/pagamenti-elimina-voce.test.ts` (e
  aggiungere `import { GET as eliminabileGET } from '@/app/api/pagamenti/[id]/eliminabile/route'`
  accanto all'import della DELETE):

```ts
describe('GET /api/pagamenti/[id]/eliminabile · il verdetto per la finestra Modifica', () => {
  const get = () => eliminabileGET(new NextRequest(`http://localhost/api/pagamenti/${PAG}/eliminabile`), ctx)

  it('🔴 coordinatrice → 403', async () => {
    h.ruolo = 'coordinator'
    h.db.pagamenti = [voce()]
    expect((await get()).status).toBe(403)
  })

  it('voce pulita → 200 eliminabile, 0 rate, 0 ticket, e NIENTE scritto', async () => {
    h.db.pagamenti = [voce()]
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, eliminabile: true, rate: 0, ticket: 0 })
    expect(h.scritture).toEqual([])
    expect(h.db.pagamenti).toHaveLength(1)
  })

  it('voce con incassi → 200 non eliminabile col codice', async () => {
    h.db.pagamenti = [voce()]
    h.db.incassi = [{ id: 'i1', pagamento_id: PAG, importo: 10, transazione_id: null }]
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, eliminabile: false, codice: 'VOCE_CON_INCASSI' })
  })

  it('voce inesistente → 404', async () => {
    expect((await get()).status).toBe(404)
  })
})
```

- [ ] **Step 2: rosso**

Run: `npx vitest run __tests__/api/pagamenti-elimina-voce.test.ts 2>&1 | tail -6`
Expected: FAIL — import della route inesistente.

- [ ] **Step 3: la route** — `src/app/api/pagamenti/[id]/eliminabile/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { controllaVoceEliminabile } from '@/lib/pagamenti/voce-eliminabile'

// GET /api/pagamenti/[id]/eliminabile  (admin e segreteria, 2026-10-12)
// Il verdetto per la zona «Elimina voce» della finestra Modifica: le STESSE guardie della
// DELETE, così il browser non ricalcola niente. Positivo o negativo, il verdetto è un 200;
// 404 e 500 restano tali. Sola lettura.
export const GET = withRoute('pagamenti/[id]/eliminabile:GET', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response
    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
    const c = await controllaVoceEliminabile(supabase, id, { sedi, perSostituzione: false, operazione: 'pagamenti/[id]/eliminabile:GET' })
    if (c.ok) return NextResponse.json({ success: true, eliminabile: true, rate: c.rate, ticket: c.ticket })
    if ('guasto' in c) return c.guasto
    if (c.stato === 404) return NextResponse.json({ error: c.error }, { status: 404 })
    return NextResponse.json({ success: true, eliminabile: false, codice: c.codice, error: c.error })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/[id]/eliminabile:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
```

- [ ] **Step 4: verde + lock**

Run: `npx vitest run __tests__/api/pagamenti-elimina-voce.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/api/zod-coverage.test.ts 2>&1 | tail -6`
Expected: `Test Files 3 passed`.

- [ ] **Step 5: commit**

```bash
git add "src/app/api/pagamenti/[id]/eliminabile/route.ts" __tests__/api/pagamenti-elimina-voce.test.ts
git commit -m "Pagamenti: il verdetto «eliminabile» di una voce, con le stesse guardie della DELETE"
```

---

### Task 6: Rateizza — la sostituzione sul server

**Files:** Modify `src/app/api/pagamenti/rate/route.ts` · Create
`__tests__/api/pagamenti-rate-sostituzione.test.ts`

- [ ] **Step 1: test rosso** — `__tests__/api/pagamenti-rate-sostituzione.test.ts`. Copiare
  l'impalcatura (mock di `require-staff` con gate vero, `logger`, `server-client` col finto
  client, `h.db`, `h.scritture`, `scritte`, `eventi`) da `__tests__/api/pagamenti-elimina-voce.test.ts`,
  con `h.ruolo = 'coordinator'` di default (la coordinatrice rateizza ancora), più — se
  `assertAlunnoInScope` legge tabelle che il finto DB non ha — le stesse tabelle che usa
  `__tests__/api/pagamenti-rate-metodi-ammessi.test.ts` nel suo `beforeEach`. Poi:

```ts
import { POST } from '@/app/api/pagamenti/rate/route'

const corpo = (extra: Record<string, unknown> = {}) => ({
  alunno_id: ALU, descrizione: 'Retta finta a rate', importo_totale: 300,
  rate: [{ importo: 150, scadenza: '2026-11-05' }, { importo: 150, scadenza: '2026-12-05' }],
  sostituisce_pagamento_id: PAG, ...extra,
})
const post = (b: unknown) => POST(new NextRequest('http://localhost/api/pagamenti/rate', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}))
const piani = () => (h.db.pagamenti as Riga[]).filter((p) => p.tipo === 'padre')

describe('POST /api/pagamenti/rate · sostituisce la voce in un’operazione sola', () => {
  it('coordinatrice: piano creato, originale eliminato, audit con sostituito_da, log', async () => {
    h.db.pagamenti = [voce({ importo: 300 })]
    const res = await post(corpo())
    expect(res.status).toBe(201)
    expect((h.db.pagamenti as Riga[]).some((p) => p.id === PAG)).toBe(false)
    expect(piani()).toHaveLength(1)
    expect(JSON.stringify(scritte('registro_modifiche', 'insert'))).toContain('sostituito_da')
    expect(eventi('voce-sostituita-da-piano')).toHaveLength(1)
  })

  it('🔴 originale con incassi → 409 PRIMA di creare il piano', async () => {
    h.db.pagamenti = [voce({ importo: 300 })]
    h.db.incassi = [{ id: 'i1', pagamento_id: PAG, importo: 50, transazione_id: null }]
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_CON_INCASSI')
    expect(scritte('pagamenti', 'insert')).toEqual([])
  })

  it('🔴 originale di un altro bambino → 409 VOCE_NON_SOSTITUIBILE, nessun insert', async () => {
    h.db.pagamenti = [voce({ alunno_id: 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa' })]
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_NON_SOSTITUIBILE')
    expect(scritte('pagamenti', 'insert')).toEqual([])
  })

  it('🔴 originale «padre» → 409 VOCE_NON_SOSTITUIBILE', async () => {
    h.db.pagamenti = [voce({ tipo: 'padre' })]
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_NON_SOSTITUIBILE')
  })

  it('una ricarica di ticket si rateizza: i ticket NON si toccano, nessuna RPC', async () => {
    h.db.pagamenti = [voce({ importo: 300 })]
    h.db.mensa_ticket_movimenti = [{ id: 'm1', pagamento_id: PAG, alunno_id: ALU, tipo: 'ricarica', delta: 10 }]
    h.db.ticket_mensa = [{ alunno_id: ALU, saldo_ticket: 0 }]
    const res = await post(corpo())
    expect(res.status).toBe(201)
    expect(h.rpcArgs).toEqual([])
  })

  it('🔴 DELETE dell’originale respinta dal freno → piano tolto (compensazione) e 409', async () => {
    h.db.pagamenti = [voce({ importo: 300 })]
    h.errori = { 'pagamenti:delete': { code: '23503', message: 'violates foreign key constraint' } }
    const res = await post(corpo())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VOCE_CON_CONTABILITA')
    expect(eventi('sostituzione-annullata')).toHaveLength(1)
  })

  it('senza sostituisce_pagamento_id → comportamento di oggi (201, nessuna DELETE)', async () => {
    h.db.pagamenti = [voce({ importo: 300 })]
    const res = await post(corpo({ sostituisce_pagamento_id: undefined }))
    expect(res.status).toBe(201)
    expect(scritte('pagamenti', 'delete')).toEqual([])
  })
})
```

  Per il caso del freno: `h.errori` va passato al finto client come in
  `pagamenti-errori-controllati.test.ts` (`...(h.errori ? { errori: h.errori } : {})`). Con
  l'errore iniettato su `pagamenti:delete` fallisce ANCHE la compensazione: il test si aspetta
  comunque il 409 col log `sostituzione-annullata`, e in più `compensazione-piano-fallita` →
  allora la risposta è 500. Scegliere l'una o l'altra osservando il finto client: se
  l'iniezione colpisce ogni `delete` su `pagamenti`, il caso diventa «compensazione fallita →
  500 + log `compensazione-piano-fallita`», e va aggiunto un secondo caso con la sola prima
  DELETE respinta (iniezione condizionata dal filtro `id`, se il finto lo permette; altrimenti
  il ramo «compensazione riuscita» si prova nel test di unità della funzione estratta
  `sostituisciVoce`, vedi Step 3).

- [ ] **Step 2: rosso**

Run: `npx vitest run __tests__/api/pagamenti-rate-sostituzione.test.ts 2>&1 | tail -8`
Expected: FAIL (il campo è ignorato: l'originale resta, nessun 409).

- [ ] **Step 3: implementazione** — in `src/app/api/pagamenti/rate/route.ts`:

  1. import: `NextRequest` (tipo) da `next/server`, `resolveScuoleAttive` da `@/lib/auth/scope`,
     `zUuid` (se non già importato), `controllaVoceEliminabile, type VoceDaEliminare` da
     `@/lib/pagamenti/voce-eliminabile`, `figlieTrattengono` da `@/lib/db/figlie-trattengono`;
  2. nello schema `postBodySchema` aggiungere:

```ts
  // Rateizza (2026-10-12): la voce che il piano SOSTITUISCE. Il server controlla che sia
  // eliminabile PRIMA di creare il piano, e la elimina DOPO; se non ci riesce, toglie il piano.
  // Prima lo faceva il browser con una seconda chiamata, e un fallimento lasciava voce e piano.
  sostituisce_pagamento_id: zUuid.optional(),
```

  3. subito dopo `const scuolaId = al.scuola_id` (prima di `scadenze`):

```ts
    // Sostituzione: tutte le guardie PRIMA di scrivere qualunque cosa.
    let originale: VoceDaEliminare | null = null
    if (body.sostituisce_pagamento_id) {
      const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
      const c = await controllaVoceEliminabile(supabase, body.sostituisce_pagamento_id, { sedi, perSostituzione: true, operazione: 'pagamenti/rate:POST' })
      if (!c.ok) {
        if ('guasto' in c) return c.guasto
        return NextResponse.json({ error: c.error, ...(c.codice ? { codice: c.codice } : {}) }, { status: c.stato })
      }
      if (c.voce.alunno_id !== alunno_id || c.voce.tipo !== 'singolo') {
        return NextResponse.json(
          { error: 'Questa voce non si può sostituire con un piano rateale: deve essere una voce singola dello stesso bambino.', codice: 'VOCE_NON_SOSTITUIBILE' },
          { status: 409 },
        )
      }
      originale = c.voce
    }
```

  4. subito prima del `return NextResponse.json({ success: true, data: { padre, rate: created } }, { status: 201 })`:

```ts
    if (originale) {
      const del = await supabase.from('pagamenti').delete().eq('id', originale.id)
      if (del.error) {
        // Compensazione: senza, la famiglia avrebbe voce e piano insieme (debito doppio).
        const comp = await supabase.from('pagamenti').delete().eq('id', padre.id)
        if (comp.error) {
          logEvento('pagamento', 'error', {
            operazione: 'pagamenti/rate:POST', esito: 'compensazione-piano-fallita', padre_id: padre.id, originale_id: originale.id,
          }, comp.error)
          return NextResponse.json({ error: 'Errore sostituzione: il piano è stato creato ma la voce originale non è stata tolta.', codice: 'PAGAMENTI_SCRITTURA_FALLITA' }, { status: 500 })
        }
        const freno = figlieTrattengono(del.error)
        logEvento('pagamento', freno ? 'warn' : 'error', {
          operazione: 'pagamenti/rate:POST', esito: 'sostituzione-annullata', padre_id: padre.id, originale_id: originale.id,
        }, del.error)
        return freno
          ? NextResponse.json({ error: 'La voce è stata incassata o fatturata nel frattempo: non si può più sostituire. Ricarica la pagina.', codice: 'VOCE_CON_CONTABILITA' }, { status: 409 })
          : NextResponse.json({ error: 'Errore sostituzione', details: del.error.message }, { status: 500 })
      }
      const audit = await supabase.from('registro_modifiche').insert({
        azione: 'elimina_pagamento',
        tabella_interessata: 'pagamenti',
        record_id: originale.id,
        vecchio_valore: originale,
        nuovo_valore: { sostituito_da: padre.id },
        utente_id: user.id,
      })
      if (audit.error) {
        logEvento('pagamento', 'error', { operazione: 'pagamenti/rate:POST', esito: 'audit-sostituzione-non-scritto', originale_id: originale.id }, audit.error)
      }
      logEvento('pagamento', 'info', { operazione: 'pagamenti/rate:POST', esito: 'voce-sostituita-da-piano', originale_id: originale.id, padre_id: padre.id })
    }
```

  Verificare che `PAGAMENTI_SCRITTURA_FALLITA` esista in `CODICI_ERRORE` (sì: riga ~3283).

- [ ] **Step 4: verde**

Run: `npx vitest run __tests__/api/pagamenti-rate-sostituzione.test.ts __tests__/api/pagamenti-rate-metodi-ammessi.test.ts 2>&1 | tail -6`
Expected: `Test Files 2 passed`. Rompere: spostare il blocco di guardia DOPO l'insert del padre →
«originale con incassi → nessun insert» rosso. Rimettere.

- [ ] **Step 5: commit**

```bash
git add src/app/api/pagamenti/rate/route.ts __tests__/api/pagamenti-rate-sostituzione.test.ts
git commit -m "Rateizza: il server sostituisce la voce col piano in un'operazione sola, mai voce e piano insieme"
```

---

### Task 7: `RateizzaModal` smette di chiamare la DELETE

**Files:** Modify `src/components/features/admin/pagamenti/RateizzaModal.tsx:91-123` ·
`__tests__/components/RateizzaModal-metodi.test.tsx`

- [ ] **Step 1: aggiornare il test** — in `RateizzaModal-metodi.test.tsx` cercare le asserzioni
  sulla DELETE dell'originale (`method: 'DELETE'` / `/api/pagamenti/<id>`) e sostituirle con:

```ts
    expect(JSON.parse(String(s.post()[0].init?.body)).sostituisce_pagamento_id).toBe(/* l'id passato come replacePagamentoId nel test */)
    expect(fetchFinta.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
```

  (adattare i nomi `s.post()` / `fetchFinta` a quelli del file: leggerlo prima.)

- [ ] **Step 2: rosso**

Run: `npx vitest run __tests__/components/RateizzaModal-metodi.test.tsx 2>&1 | tail -6`
Expected: FAIL (manca `sostituisce_pagamento_id`, la DELETE parte ancora).

- [ ] **Step 3: implementazione** — nel corpo della POST aggiungere, dopo `metodi_ammessi`:

```ts
                    // La sostituzione la fa il SERVER (2026-10-12): controlla, crea il piano,
                    // elimina l'originale, e se non ci riesce toglie il piano. Prima la DELETE
                    // partiva da qui, e un suo fallimento lasciava voce e piano insieme.
                    ...(replacePagamentoId ? { sostituisce_pagamento_id: replacePagamentoId } : {}),
```

  e togliere tutto il blocco `if (replacePagamentoId) { … DELETE … }` (righe ~110-123). Togliere
  gli import rimasti inutilizzati (`logClient`, `nomeErrore`) se non servono altrove nel file.

- [ ] **Step 4: verde**

Run: `npx vitest run __tests__/components/RateizzaModal-metodi.test.tsx 2>&1 | tail -6`
Expected: `Test Files 1 passed`.

- [ ] **Step 5: commit**

```bash
git add src/components/features/admin/pagamenti/RateizzaModal.tsx __tests__/components/RateizzaModal-metodi.test.tsx
git commit -m "Rateizza: niente più DELETE dal browser, la voce la sostituisce il server"
```

---

### Task 8: la zona «Elimina voce» nella finestra Modifica

**Files:** Create `src/components/features/admin/pagamenti/EliminaVoceZona.tsx` · Modify
`src/components/features/admin/pagamenti/ModificaPagamentoModal.tsx` · Create
`__tests__/components/EliminaVoceZona.test.tsx`

- [ ] **Step 1: test rosso** — `__tests__/components/EliminaVoceZona.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * La zona «Elimina voce» della finestra Modifica (2026-10-12). Il verdetto lo dà il server
 * (`GET …/eliminabile`); la zona non esiste per chi non è admin o segreteria, e non chiama
 * nemmeno il server. Conferma in due passi. Dati sintetici.
 */

const h = vi.hoisted(() => ({ ruolo: 'segreteria' }));
vi.mock('@/lib/context/admin-identity', async (orig) => ({
    ...(await orig<object>()),
    useRuoloCockpit: () => h.ruolo,
}));

import { EliminaVoceZona } from '@/components/features/admin/pagamenti/EliminaVoceZona';

const pagamento = { id: 'p-0001', descrizione: 'Gita allo zoo', importo: 30 };
let verdetto: { status: number; body: unknown } | 'rete';
let cancella: { status: number; body: unknown } | 'rete';
let fetchFinta: ReturnType<typeof vi.fn>;

const chiamate = (metodo: string) => fetchFinta.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === metodo);
const rendi = (onEliminata = vi.fn()) => {
    render(<EliminaVoceZona pagamento={pagamento} userId="u1" onEliminata={onEliminata} />);
    return onEliminata;
};

beforeEach(() => {
    h.ruolo = 'segreteria';
    verdetto = { status: 200, body: { success: true, eliminabile: true, rate: 0, ticket: 0 } };
    cancella = { status: 200, body: { success: true } };
    fetchFinta = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const r = init?.method === 'DELETE' ? cancella : verdetto;
        if (r === 'rete') throw new TypeError('Failed to fetch');
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
    });
    vi.stubGlobal('fetch', fetchFinta);
});
afterEach(() => vi.unstubAllGlobals());

describe('EliminaVoceZona', () => {
    it('coordinatrice: niente zona e nessuna chiamata', () => {
        h.ruolo = 'coordinator';
        const { container } = render(<EliminaVoceZona pagamento={pagamento} userId="u1" onEliminata={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
        expect(fetchFinta).not.toHaveBeenCalled();
    });

    it('eliminabile: due passi, poi DELETE e onEliminata', async () => {
        const onEliminata = rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        expect(screen.getByText(/Eliminare «Gita allo zoo»/)).toBeInTheDocument();
        expect(chiamate('DELETE')).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }));
        await waitFor(() => expect(onEliminata).toHaveBeenCalledTimes(1));
        expect(String(chiamate('DELETE')[0][0])).toBe('/api/pagamenti/p-0001');
    });

    it('Annulla al secondo passo: torna indietro, nessuna DELETE', async () => {
        rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
        expect(await screen.findByRole('button', { name: 'Elimina voce' })).toBeInTheDocument();
        expect(chiamate('DELETE')).toHaveLength(0);
    });

    it('rate e ticket: la domanda li dice', async () => {
        verdetto = { status: 200, body: { success: true, eliminabile: true, rate: 3, ticket: 10 } };
        rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        expect(screen.getByText('Si eliminano anche le sue 3 rate.')).toBeInTheDocument();
        expect(screen.getByText('Si tolgono anche i 10 ticket mensa di questa ricarica.')).toBeInTheDocument();
    });

    it('non eliminabile: il motivo dal catalogo, nessun pulsante', async () => {
        verdetto = { status: 200, body: { success: true, eliminabile: false, codice: 'VOCE_CON_INCASSI', error: 'x' } };
        rendi();
        expect(await screen.findByText(/storna gli incassi e correggi la voce/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Elimina voce' })).toBeNull();
    });

    for (const caso of ['500', 'rete'] as const) {
        it(`verdetto non letto (${caso}): «non riesco a controllare», nessun pulsante`, async () => {
            verdetto = caso === 'rete' ? 'rete' : { status: 500, body: { error: 'guasto', codice: 'LETTURA_FALLITA' } };
            rendi();
            expect(await screen.findByText('Non riesco a controllare la voce: riapri la finestra.')).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Elimina voce' })).toBeNull();
        });
    }

    it('🔴 DELETE 409: messaggio in role=alert, si torna al primo passo, onEliminata NON chiamata', async () => {
        cancella = { status: 409, body: { error: 'x', codice: 'VOCE_CON_CONTABILITA' } };
        const onEliminata = rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/incassata o fatturata nel frattempo/);
        expect(screen.getByRole('button', { name: 'Elimina voce' })).toBeInTheDocument();
        expect(onEliminata).not.toHaveBeenCalled();
    });

    it('DELETE senza rete: «connessione non riuscita»', async () => {
        cancella = 'rete';
        rendi();
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina voce' }));
        fireEvent.click(screen.getByRole('button', { name: 'Sì, elimina' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Connessione non riuscita: la voce non è stata eliminata.');
    });
});
```

- [ ] **Step 2: rosso**

Run: `npx vitest run __tests__/components/EliminaVoceZona.test.tsx 2>&1 | tail -6`
Expected: FAIL — import inesistente.

- [ ] **Step 3: il componente** — `src/components/features/admin/pagamenti/EliminaVoceZona.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { useRuoloCockpit } from '@/lib/context/admin-identity';
import { BTN_SECONDARY } from './ui';

/**
 * Zona «Elimina voce» della finestra Modifica (2026-10-12, «pagamenti generati per errore»).
 *
 * Solo admin e segreteria (lo impone anche il server). Il verdetto «eliminabile o no, e perché»
 * lo dà `GET /api/pagamenti/[id]/eliminabile`, con le stesse guardie della DELETE: qui non si
 * ricalcola niente. Un verdetto non letto non è mai «eliminabile». Conferma in due passi, nella
 * stessa finestra.
 */

const RUOLI = new Set(['admin', 'segreteria']);

type Verdetto =
    | { stato: 'attesa' }
    | { stato: 'si'; rate: number; ticket: number }
    | { stato: 'no'; corpo: unknown }
    | { stato: 'ignoto' };

async function leggiVerdetto(id: string, userId: string): Promise<Verdetto> {
    try {
        const res = await fetch(`/api/pagamenti/${id}/eliminabile?userId=${userId}`, { headers: { 'x-user-id': userId } });
        const j = (await res.json().catch(() => null)) as { eliminabile?: boolean; rate?: number; ticket?: number } | null;
        if (!res.ok || !j || typeof j.eliminabile !== 'boolean') return { stato: 'ignoto' };
        return j.eliminabile ? { stato: 'si', rate: Number(j.rate ?? 0), ticket: Number(j.ticket ?? 0) } : { stato: 'no', corpo: j };
    } catch {
        return { stato: 'ignoto' };
    }
}

interface Props {
    pagamento: { id: string; descrizione: string; importo: number };
    userId: string;
    onEliminata: () => void;
}

export function EliminaVoceZona({ pagamento, userId, onEliminata }: Props) {
    const t = useTranslations('adminContabilita');
    const ammesso = RUOLI.has(useRuoloCockpit());
    const [verdetto, setVerdetto] = useState<Verdetto>({ stato: 'attesa' });
    const [conferma, setConferma] = useState(false);
    const [invio, setInvio] = useState(false);
    const [errore, setErrore] = useState<string | null>(null);

    useEffect(() => {
        if (!ammesso) return;
        let attivo = true;
        leggiVerdetto(pagamento.id, userId).then((v) => { if (attivo) setVerdetto(v); });
        return () => { attivo = false; };
    }, [ammesso, pagamento.id, userId]);

    if (!ammesso) return null;

    const elimina = async () => {
        setInvio(true); setErrore(null);
        try {
            const res = await fetch(`/api/pagamenti/${pagamento.id}?userId=${userId}`, { method: 'DELETE', headers: { 'x-user-id': userId } });
            if (res.ok) { onEliminata(); return; }
            const j = await res.json().catch(() => ({}));
            setErrore(messaggioDaCorpo(j, t('eliminaErrGenerico')));
            setConferma(false);
        } catch {
            setErrore(t('eliminaErrRete'));
            setConferma(false);
        } finally {
            setInvio(false);
        }
    };

    return (
        <section aria-labelledby="elimina-voce-titolo" className="mt-5 rounded-card border-[1.5px] border-kidville-error-soft p-3">
            <h4 id="elimina-voce-titolo" className="mb-2 flex items-center gap-1.5 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-error-strong">
                <Trash2 size={14} /> {t('eliminaTitolo')}
            </h4>
            {verdetto.stato === 'ignoto' && (
                <p className="font-maven text-xs text-kidville-sub">{t('eliminaNonControllabile')}</p>
            )}
            {verdetto.stato === 'no' && (
                <p className="font-maven text-xs text-kidville-sub">{messaggioDaCorpo(verdetto.corpo, t('eliminaNonControllabile'))}</p>
            )}
            {verdetto.stato === 'si' && !conferma && (
                <button type="button" onClick={() => { setErrore(null); setConferma(true); }}
                    className={cx(BTN_SECONDARY, 'w-full border-kidville-error-strong text-kidville-error-strong')}>
                    {t('eliminaPulsante')}
                </button>
            )}
            {verdetto.stato === 'si' && conferma && (
                <div className="space-y-2">
                    <p className="font-maven text-xs text-kidville-ink">
                        {t('eliminaDomanda', { descrizione: pagamento.descrizione, importo: formatEuro(pagamento.importo) })}
                    </p>
                    {verdetto.rate > 0 && <p className="font-maven text-xs text-kidville-ink">{t('eliminaConRate', { n: verdetto.rate })}</p>}
                    {verdetto.ticket > 0 && <p className="font-maven text-xs text-kidville-ink">{t('eliminaConTicket', { n: verdetto.ticket })}</p>}
                    <div className="flex gap-2">
                        <button type="button" onClick={() => setConferma(false)} disabled={invio} className={cx(BTN_SECONDARY, 'flex-1')}>
                            {t('eliminaAnnulla')}
                        </button>
                        <button type="button" onClick={elimina} disabled={invio}
                            className="flex-1 rounded-pill bg-kidville-error-strong px-4 py-2 font-maven text-sm font-bold text-kidville-white disabled:opacity-60">
                            {invio ? t('eliminaInCorso') : t('eliminaConferma')}
                        </button>
                    </div>
                </div>
            )}
            {errore && <p role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">{errore}</p>}
        </section>
    );
}
```

  Le classi colore vanno controllate contro i lock di contrasto (`__tests__/a11y`, lock
  trasversali): usare solo token già presenti nel file `ModificaPagamentoModal.tsx` o in
  `ui.ts` (`text-kidville-error-strong`, `border-kidville-error-soft` lo sono). Se un lock di
  contrasto boccia `text-kidville-white` su `bg-kidville-error-strong`, prendere la coppia che
  usa un altro pulsante distruttivo del repo (cercare `bg-kidville-error` in `src/components`).

- [ ] **Step 4: montarla nella finestra** — in `ModificaPagamentoModal.tsx`:
  import `import { EliminaVoceZona } from './EliminaVoceZona';` e, dopo il `div` dei pulsanti
  Chiudi / Salva (riga ~287, prima di `</Modal>`):

```tsx
            {/* Eliminare una voce generata per errore (2026-10-12): solo admin e segreteria,
                il verdetto lo dà il server. Dopo l'eliminazione la finestra si chiude come
                dopo un salvataggio. */}
            <EliminaVoceZona
                pagamento={{ id: pagamento.id, descrizione: pagamento.descrizione, importo: Number(pagamento.importo) }}
                userId={userId}
                onEliminata={onDone}
            />
```

- [ ] **Step 5: verde, nuovo e vecchio**

Run: `npx vitest run __tests__/components/EliminaVoceZona.test.tsx __tests__/components/ModificaPagamentoModal.test.tsx 2>&1 | tail -6`
Expected: `Test Files 2 passed` (senza provider il ruolo è `''`: la zona non c'è e i test vecchi
non vedono chiamate in più). Rompere: togliere `if (!ammesso) return;` dall'effetto → il caso
«coordinatrice: nessuna chiamata» diventa rosso. Rimettere.

- [ ] **Step 6: commit**

```bash
git add src/components/features/admin/pagamenti/EliminaVoceZona.tsx src/components/features/admin/pagamenti/ModificaPagamentoModal.tsx __tests__/components/EliminaVoceZona.test.tsx
git commit -m "Contabilità: «Elimina voce» nella finestra Modifica, per admin e segreteria"
```

---

### Task 9: PRD

**Files:** `PRD REGISTRO ELETTRONICO.md`

- [ ] **Step 1:** leggere con `Grep` la tabella di stato in cima e l'ultimo blocco
  «Changelog — …» per il formato; aggiornare:
  - la riga della contabilità/pagamenti: «eliminazione di una voce generata per errore» 🟡
    (rilasciata, in attesa della prova sul campo);
  - la voce della mensa staff della PR #226 da 🟡 a ✅ (in produzione dal 12/10, `93fabdd6`);
  - un blocco «Changelog — 2026-10-12 · Eliminare una voce di pagamento generata per errore»
    con: chi può (admin, segreteria), dove (finestra Modifica), cosa trattiene (incassi anche
    stornati, fattura emessa o in coda, rata, ordine divise attivo, ticket già usati), la
    ricarica che storna i ticket (funzione `elimina_voce_ricarica_ticket`), Rateizza come
    operazione unica del server, la revoca automatica della sospensione, la nuova route
    `GET /api/pagamenti/[id]/eliminabile`, i log `voce-eliminata` /
    `voce-sostituita-da-piano` / `compensazione-piano-fallita`. Niente PII, niente conteggi
    copiati come verità: le misure del 12/10 con la data accanto.

- [ ] **Step 2: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "PRD: eliminare una voce di pagamento generata per errore; mensa staff in produzione"
```

---

### Task 10: gate intero

- [ ] **Step 1:** `npx eslint . --max-warnings 0 2>&1 | tail -15` → 0 problemi.
- [ ] **Step 2:** `npx tsc --noEmit 2>&1 | tail -15` → nessun errore.
- [ ] **Step 3:** `npx vitest run 2>&1 | tail -15` → tutti verdi; leggere `Test Files N passed`
  e `Tests M passed`. Un rosso fuori dai file toccati: controllare se è uno dei test UI instabili
  noti (`ci_unit_job_instabile_test_ui`) rilanciandolo da solo; se resta rosso, è nostro.
- [ ] **Step 4:** `npm run build 2>&1 | tail -15` → build ok.
- [ ] **Step 5:** commit delle eventuali correzioni dei lock, un commit per motivo.

---

### Task 11: PR, CI, merge, deploy

- [ ] **Step 1:** `git push -u origin feat/elimina-voce-pagamento`; PR verso `main` con
  `gh pr create` (titolo e corpo in italiano: cosa, perché, decisioni del titolare, migrazione
  applicata dall'integrazione al merge, cosa resta fuori; ultima riga
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`). Poi `get_status` /
  `bind_pr` del ccd_pr.
- [ ] **Step 2:** attendere la CI (gli eventi arrivano dall'app; niente polling). Verde = TUTTI i
  job. Un E2E rosso si legge dal punto d'arresto. Un job «cancelled» per il gruppo
  `e2e-ci-db` si rilancia, non è rosso.
- [ ] **Step 3:** prima del merge, mostrare (non chiedere) la migrazione che l'integrazione
  applicherà in produzione. Merge squash a mano (`gh pr merge --squash`), MAI auto-merge.
- [ ] **Step 4:** dopo il merge: CI di `main` e «Verifica dopo il deploy» verdi; in produzione
  (sola lettura):

```sql
SELECT version, name FROM supabase_migrations.schema_migrations WHERE name LIKE '%elimina_voce_ricarica_ticket%';
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
FROM pg_proc p WHERE p.proname = 'elimina_voce_ricarica_ticket';
```

  Atteso: una riga sola nel registro; `anon` e `authenticated` falsi, `service_role` vero. Poi
  `get_advisors` (security) → 0 ERROR nuovi.
- [ ] **Step 5:** cancellare il branch locale e remoto; `main` resta l'unico.

### Task 12: PR-B — fotografie dalla produzione

- [ ] **Step 1:** nuovo branch `chore/fotografie-elimina-voce`; rigenerare la fotografia delle
  migrazioni come dice `_come_si_rigenera` in `__tests__/fixtures/migrazioni-applicate-snapshot.json`
  (`node __tests__/fixtures/migrazioni-fotografia.mjs --sql` → eseguire su prod con
  `execute_sql` → `node __tests__/fixtures/migrazioni-fotografia.mjs < risposta.json`).
- [ ] **Step 2:** `npx vitest run __tests__/architecture 2>&1 | tail -6` verde; commit, PR,
  CI verde, merge a mano, «Verifica dopo il deploy» verde, branch cancellati.

### Task 13: memoria

- [ ] Una memoria `project` per questo rilascio (stato, cosa resta: prova sul campo della
  segreteria) e la riga in `MEMORY.md` nella sezione «LAVORO APERTO»; aggiornare la memoria della
  #226 (PRD ✅ fatto).
