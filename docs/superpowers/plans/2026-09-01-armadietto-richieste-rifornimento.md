# Armadietto — richieste di rifornimento · Piano di implementazione

> **Per chi esegue:** SKILL RICHIESTA: usa `superpowers:subagent-driven-development` (consigliata) o
> `superpowers:executing-plans` per eseguire task per task. Gli step usano le caselle `- [ ]`.

**Obiettivo:** ricollegare la metà mancante del modulo Armadietto — la scuola che dice al genitore
cosa portare — su una tabella che esiste davvero, riparando il 403 che rende il bottone del genitore
inutilizzabile.

**Architettura:** una tabella nuova `armadietto_richieste` con la guardia anti-doppione nell'indice
unico parziale; un motore in `src/lib/armadietto/` chiamato dopo ogni movimento che apre e chiude le
richieste; il cron delle 06:00 che riconcilia tutto e manda le notifiche.

**Stack:** Next.js App Router, TypeScript, Supabase (PostgREST + service-role), zod, vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-armadietto-richieste-rifornimento-design.md`

---

## Da leggere prima di cominciare

- `AGENTS.md` — logging obbligatorio (le 9 regole), gate di verifica, branch, PRD.
- `src/lib/db/tolleranza-schema.ts` — perché `42P01`/`PGRST205` si tollerano e `42703` no.
- `src/app/api/locker/inventory/route.ts:113-130` — la formula dello stock, che il motore riusa.

### Tre trappole di questo repo, che costano ore

1. **`vitest -t 'nome-che-non-esiste'` esce 0.** Un test che non viene trovato *sembra* verde. Dopo
   ogni run leggi il conteggio («1 passed»), non l'exit code.
2. **`comando | tail; echo $?` non verifica niente**: `$?` dopo una pipe è l'uscita dell'ultimo
   anello. Non incatenare i gate a una pipe.
3. **`apply_migration` registra un timestamp SUO**, diverso dal nome del file locale. Se non
   rinomini il file dopo, al prossimo giro la migrazione si riapplica. Vedi Task 1 step 6.

### Stato di partenza

- Branch: `feat/candidature-cv-obbligatorio` (si continua, non se ne crea uno nuovo).
- Albero pulito, spec già committato in `4a1ffa0f`.
- ✅ **La suite è interamente verde**: 12.419 test, 986 file, misurati il 2026-09-01 durante il
  Task 1. Questo piano in una stesura precedente diceva di aspettarsi un rosso preesistente su
  `importi-euro-italiani.test.tsx` — era **falso**, quel test è stato riparato in `ef04d831`.
  La correzione conta: chi si aspetta un rosso lo perdona, e un rosso perdonato è un rosso invisibile.
  **Qualunque fallimento tu veda è tuo.**

---

## Struttura dei file

**Nuovi** — quattro file piccoli, uno per responsabilità:

| file | responsabilità |
|---|---|
| `src/lib/armadietto/materiali-default.ts` | i 4 materiali di ripiego, **unica** copia |
| `src/lib/armadietto/stock.ts` | `stockDiAlunno()` — la somma del libro giornale |
| `src/lib/armadietto/soglie.ts` | `soglieMateriali()` — `locker_config` con ripiego |
| `src/lib/armadietto/richieste.ts` | `riconciliaRichieste()`, `riconciliaTutto()` |

**Modificati:** `api/locker/requests/route.ts` (riscritta), `api/locker/inventory/route.ts`,
`api/locker/materials/route.ts`, `api/diary/entries/route.ts`,
`api/notifiche/promemoria/route.ts`, le tre pagine e due componenti.

**Cancellati:** `api/locker/catalog/route.ts`, `components/features/teacher/locker/InventoryCard.tsx`.

---

### Task 1: La migrazione

**File:**
- Crea: `supabase/migrations/20260901160000_armadietto_richieste.sql`
- Modifica: `__tests__/fixtures/migrazioni-applicate-snapshot.json`, `fk-scuola-id-snapshot.json`,
  `pg-policies-snapshot.json`

- [ ] **Step 1: Scrivi la migrazione**

```sql
-- ════════════════════════════════════════════════════════════════════════════
-- ARMADIETTO — le richieste di rifornimento, su una tabella che esiste
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── IL DIFETTO ─────────────────────────────────────────────────────────────
-- `/api/locker/requests` e la scansione 2 del cron `notifiche/promemoria`
-- interrogavano `locker_requests`, tabella del vecchio schema a saldo che vive
-- solo in `migrations_archive/20260503_armadietto_anagrafica.sql` e che NESSUNA
-- migrazione applicata crea. Il modulo era stato portato al nuovo schema a
-- metà: `inventory` e `materials` su `armadietto`/`locker_config`, `requests`
-- e il cron sulle tabelle vecchie.
--
-- ─── LA MISURA ──────────────────────────────────────────────────────────────
-- 226 errori `PGRST205` in 28 giorni su `app_log` (195 su `/api/locker/requests`,
-- 31 sul cron), dal 2026-08-04 al 2026-09-01, ultimo alle 14:59. Il degrado era
-- pulito (`tabellaMancante` → lista vuota), ed è per questo che nessuno se n'era
-- accorto: la lista «Da portare a scuola» è condizionata a `length > 0` e
-- restava semplicemente invisibile.
--
-- ─── COSA FA ────────────────────────────────────────────────────────────────
-- Crea `armadietto_richieste`, il ciclo aperta → presa_in_carico → evasa, con
-- nome italiano coerente con `armadietto`. NON riusa il nome `locker_requests`:
-- in questo repo quel nome significa «la tabella morta» in log, commenti e PRD,
-- e riesumarlo confonderebbe chi legge.
--
-- ─── PERCHÉ NON UN TRIGGER ──────────────────────────────────────────────────
-- La tentazione era un trigger su `armadietto` che apre la richiesta quando lo
-- stock scende. Non si può: `locker_config` è VUOTA per scelta del titolare (il
-- modulo non è ancora in uso, i materiali li aggiungeranno le maestre), quindi
-- le soglie vive stanno in `MATERIALI_DEFAULT`, cioè nel codice TypeScript. Un
-- trigger dovrebbe duplicarle in SQL — due sorgenti di verità per la stessa
-- regola, che è la lezione già pagata da questo repo. La logica sta nel codice.
--
-- ─── PERCHÉ `materiale` È TESTO E NON UNA FK ────────────────────────────────
-- Una FK verso `locker_config` legherebbe la funzione a righe che per scelta
-- non esistono. `armadietto.materiale` è già testo libero: stessa chiave.
--
-- IDEMPOTENTE: `IF NOT EXISTS` ovunque, nessun dato scritto.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.armadietto_richieste (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alunno_id             uuid NOT NULL REFERENCES public.alunni(id) ON DELETE CASCADE,
  scuola_id             uuid NOT NULL REFERENCES public.schools(id),
  materiale             text NOT NULL,
  livello               text NOT NULL CHECK (livello IN ('giallo','rosso')),
  quantita_residua      integer NOT NULL DEFAULT 0,
  stato                 text NOT NULL DEFAULT 'aperta'
                          CHECK (stato IN ('aperta','presa_in_carico','evasa')),
  presa_in_carico_il    timestamptz,
  presa_in_carico_da    uuid,
  evasa_il              timestamptz,
  promemoria_inviato_il timestamptz,
  creato_il             timestamptz NOT NULL DEFAULT now(),
  aggiornato_il         timestamptz NOT NULL DEFAULT now()
);

-- UNA sola richiesta viva per (bambino, materiale). La guardia sta nel DATABASE
-- e non in un SELECT-poi-INSERT applicativo, che sotto due scritture concorrenti
-- perde la corsa e apre il doppione — era il difetto del vecchio trigger
-- `fn_decrement_locker_on_bagno`. Le evase non vincolano nulla, così se lo stock
-- ri-scende domani se ne apre una nuova.
CREATE UNIQUE INDEX IF NOT EXISTS armadietto_richieste_viva_uniq
  ON public.armadietto_richieste (alunno_id, materiale) WHERE stato <> 'evasa';

CREATE INDEX IF NOT EXISTS armadietto_richieste_alunno_idx
  ON public.armadietto_richieste (alunno_id);

CREATE INDEX IF NOT EXISTS armadietto_richieste_scuola_idx
  ON public.armadietto_richieste (scuola_id);

-- Il cron delle 06:00 cerca esattamente questo insieme.
CREATE INDEX IF NOT EXISTS armadietto_richieste_da_ricordare_idx
  ON public.armadietto_richieste (creato_il)
  WHERE stato = 'aperta' AND promemoria_inviato_il IS NULL;

-- Nessuna policy, e RLS ACCESA: la tabella è raggiungibile solo dal service-role
-- (che la bypassa). Una tabella senza RLS in questo schema sarebbe leggibile con
-- la chiave anon pubblica via PostgREST. Il controllo di accesso vive nei gate
-- applicativi (`requireParentOfStudent` / `requireDocente` + scope).
ALTER TABLE public.armadietto_richieste ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.armadietto_richieste FROM PUBLIC, anon, authenticated;
GRANT  ALL ON TABLE public.armadietto_richieste TO service_role;

COMMENT ON TABLE public.armadietto_richieste IS
  'Richieste di rifornimento materiale ai genitori. aperta → presa_in_carico → evasa. '
  'Sostituisce `locker_requests` del vecchio schema, mai migrata in produzione (2026-09-01).';
COMMENT ON COLUMN public.armadietto_richieste.materiale IS
  'Testo libero, stessa chiave di `armadietto.materiale`. Non è una FK: `locker_config` '
  'può legittimamente essere vuota e le soglie arrivano da MATERIALI_DEFAULT.';
COMMENT ON COLUMN public.armadietto_richieste.presa_in_carico_da IS
  'auth.users.id del genitore che ha confermato «La porto». Nessuna FK: i genitori '
  'cancellati per oblio GDPR non devono bloccare lo storico.';
```

- [ ] **Step 2: Mostra la migrazione al titolare prima di applicarla**

🔴 In produzione ci sono dati reali di minori. I permessi non chiedono più conferma, ma **mostrare
non è chiedere, non costa niente, ed è l'unica cosa rimasta fra un errore e le famiglie**. Stampa il
file e di' che stai per applicarlo.

- [ ] **Step 3: Conta le righe vere prima di scrivere**

Usa `mcp__supabase__execute_sql`:

```sql
SELECT count(*) FROM enrollment_submissions;
```

CLAUDE.md lo impone a chi sta per scrivere in produzione. È una query sola e restituisce un intero.

- [ ] **Step 4: Applica**

`mcp__supabase__apply_migration` con `name: "armadietto_richieste"` e il corpo dello Step 1.

- [ ] **Step 5: Verifica gli advisor**

`mcp__supabase__get_advisors` con `type: "security"`. Atteso: **0 ERROR**. Comparirà un nuovo
`rls_enabled_no_policy` di livello INFO per `armadietto_richieste` — è **atteso e corretto**: è il
pattern service-role di tutto il repo.

- [ ] **Step 6: ⚠️ Rinomina il file col timestamp vero**

```sql
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;
```

Se la versione registrata è diversa da `20260901160000`, rinomina:

```bash
git mv supabase/migrations/20260901160000_armadietto_richieste.sql \
       supabase/migrations/<VERSIONE_VERA>_armadietto_richieste.sql
```

Saltare questo passo **arma una riapplicazione** al giro successivo.

- [ ] **Step 7: Rigenera le tre istantanee**

```bash
node __tests__/fixtures/migrazioni-fotografia.mjs
```

Poi rigenera `fk-scuola-id-snapshot.json` e `pg-policies-snapshot.json` con lo script che li
produce (cercalo: `ls __tests__/fixtures/*.mjs`). `armadietto_richieste` deve comparire in
`tabelle_rls_attiva`, **senza policy**, e in `tabelle_con_scuola_id`.

- [ ] **Step 8: I lock delle migrazioni sono verdi**

```bash
npx vitest run __tests__/architecture/migrazioni-complete.test.ts __tests__/architecture/fk-scuola-id.test.ts __tests__/architecture/rls-per-sede.test.ts
```

Atteso: 3 file, tutti passati. **Leggi il conteggio**, non l'exit code.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/ __tests__/fixtures/
git commit -m "$(cat <<'EOF'
Le richieste dell'armadietto ora hanno una tabella che esiste

`armadietto_richieste`, ciclo aperta → presa_in_carico → evasa. La guardia
anti-doppione e' l'indice unico parziale su (alunno_id, materiale) limitato alle
non evase: sta nel database e non in un SELECT-poi-INSERT, che sotto scritture
concorrenti perde la corsa — era il difetto del vecchio trigger.

Niente FK verso `locker_config`: quella tabella resta vuota per scelta e le
soglie arrivano da MATERIALI_DEFAULT. `materiale` e' testo, stessa chiave di
`armadietto.materiale`.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: I materiali di ripiego, in un posto solo

Oggi le stesse quattro voci esistono in **tre** copie: `materials/route.ts:268`,
`LoadStockModal.tsx:27-32` (`MATERIALI_FALLBACK`) e le soglie cablate nelle pagine. Prima di usarle
nel motore, si consolidano.

**File:**
- Crea: `src/lib/armadietto/materiali-default.ts`
- Modifica: `src/app/api/locker/materials/route.ts`,
  `src/components/features/teacher/locker/LoadStockModal.tsx`

- [ ] **Step 1: Trova tutte le copie**

```bash
grep -rn "MATERIALI_DEFAULT\|MATERIALI_FALLBACK" src/ __tests__/
```

Annota ogni file: vanno tutti a puntare al modulo nuovo.

- [ ] **Step 2: Crea il modulo**

```ts
// src/lib/armadietto/materiali-default.ts

/**
 * I materiali che l'armadietto traccia quando `locker_config` non ha righe.
 *
 * ⚠️ `locker_config` VUOTA NON È UN GUASTO. Decisione del titolare del 2026-09-01:
 * il modulo non è ancora in uso e i materiali li aggiungeranno le maestre man mano,
 * quindi la tabella resta a zero righe e questo è il listino che vale. Le soglie qui
 * sotto sono le soglie VERE del sistema finché la segreteria non ne scrive di proprie.
 *
 * Vive qui e non dentro una route perché lo leggono in tre: la route `materials`,
 * il motore delle richieste e il modale di carico. Tre copie della stessa lista è
 * esattamente come nasce il giorno in cui due schermate mostrano soglie diverse.
 */
export interface MaterialeSoglie {
    id: string;
    nome: string;
    icona: string;
    unita: string;
    livello_allerta: number;
    livello_emergenza: number;
    ordine: number;
    attivo: boolean;
}

export const MATERIALI_DEFAULT: readonly MaterialeSoglie[] = [
    { id: 'default-1', nome: 'Pannolini', icona: '🧷', unita: 'pz', livello_allerta: 5, livello_emergenza: 2, ordine: 1, attivo: true },
    { id: 'default-2', nome: 'Salviette', icona: '🧻', unita: 'pz', livello_allerta: 4, livello_emergenza: 2, ordine: 2, attivo: true },
    { id: 'default-3', nome: 'Crema',     icona: '🧴', unita: 'pz', livello_allerta: 3, livello_emergenza: 1, ordine: 3, attivo: true },
    { id: 'default-4', nome: 'Cambio',    icona: '👕', unita: 'pz', livello_allerta: 2, livello_emergenza: 1, ordine: 4, attivo: true },
];
```

- [ ] **Step 3: Punta la route al modulo**

In `src/app/api/locker/materials/route.ts`: cancella la costante in fondo al file (righe ~267-273) e
aggiungi in cima `import { MATERIALI_DEFAULT } from '@/lib/armadietto/materiali-default';`.
Se qualche test importava `MATERIALI_DEFAULT` dalla route (lo sai dallo Step 1), riesporta:
`export { MATERIALI_DEFAULT } from '@/lib/armadietto/materiali-default';`.

- [ ] **Step 4: Punta il modale al modulo**

In `LoadStockModal.tsx`: cancella `MATERIALI_FALLBACK` (righe 27-32) e usa `MATERIALI_DEFAULT`.
Le due liste avevano gli stessi quattro nomi, quindi il comportamento non cambia — e da qui in avanti
non possono più divergere.

- [ ] **Step 5: Verifica**

```bash
npx vitest run __tests__/components/LoadStockModal.test.tsx __tests__/api/locker-materials-auth.test.ts
npx tsc --noEmit
```

Atteso: 2 file passati, `tsc` senza output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/armadietto/materiali-default.ts src/app/api/locker/materials/route.ts src/components/features/teacher/locker/LoadStockModal.tsx
git commit -m "$(cat <<'EOF'
Le quattro voci di ripiego dell'armadietto erano in tre copie

`MATERIALI_DEFAULT` nella route e `MATERIALI_FALLBACK` nel modale erano la stessa
lista scritta due volte, piu' le soglie cablate nelle pagine. Con `locker_config`
vuota per scelta, quelle soglie sono le soglie VERE del sistema: tenerle in tre
posti e' come nasce il giorno in cui due schermate ne mostrano di diverse.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `stockDiAlunno` — la somma del libro giornale

**File:**
- Crea: `src/lib/armadietto/stock.ts`, `__tests__/lib/armadietto-stock.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// __tests__/lib/armadietto-stock.test.ts
import { describe, it, expect, vi } from 'vitest'
import { stockDiAlunno } from '@/lib/armadietto/stock'

function admin(rows: unknown[], error: unknown = null) {
  return {
    from: vi.fn(() => ({
      select: () => ({ eq: () => Promise.resolve({ data: rows, error }) }),
    })),
  } as never
}

describe('stockDiAlunno', () => {
  it('somma i carichi e sottrae i consumi', async () => {
    const s = await stockDiAlunno(admin([
      { materiale: 'Pannolini', quantita: 30, portato: true },
      { materiale: 'Pannolini', quantita: 4,  portato: false },
      { materiale: 'Crema',     quantita: 2,  portato: true },
    ]), 'a1')
    expect(s).toEqual({ Pannolini: 26, Crema: 2 })
  })

  it('non scende sotto zero: un consumo senza carico vale 0, non -3', async () => {
    const s = await stockDiAlunno(admin([
      { materiale: 'Cambio', quantita: 3, portato: false },
    ]), 'a1')
    expect(s).toEqual({ Cambio: 0 })
  })

  it('PostgREST non lancia: su errore ritorna null, non un oggetto vuoto', async () => {
    // «zero materiali» e «non ho potuto guardare» si leggono uguali e significano
    // l'opposto: chi chiama deve poterli distinguere.
    const s = await stockDiAlunno(admin(null as never, { code: '42P01', message: 'x' }), 'a1')
    expect(s).toBeNull()
  })

  it('nessun movimento → oggetto vuoto, non null', async () => {
    expect(await stockDiAlunno(admin([]), 'a1')).toEqual({})
  })
})
```

- [ ] **Step 2: Falliscilo**

```bash
npx vitest run __tests__/lib/armadietto-stock.test.ts
```

Atteso: FAIL, «Failed to resolve import "@/lib/armadietto/stock"».

- [ ] **Step 3: Implementa**

```ts
// src/lib/armadietto/stock.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore } from '@/lib/logging/logger'

/**
 * Lo stock per materiale di un alunno.
 *
 * `armadietto` è un LIBRO GIORNALE, non un saldo: ogni riga è un movimento
 * (`portato: true` carico, `false` consumo) e lo stock si ottiene sommando.
 * Stessa formula di `api/locker/inventory/route.ts:119-128`, da cui è presa —
 * qui perché la usano in tre (la route, il motore delle richieste, il cron).
 *
 * Ritorna `null` se la lettura fallisce. Non `{}`: «nessun materiale» e «non ho
 * potuto guardare» si leggono uguali e significano l'opposto, e chi chiama deve
 * poter decidere (il motore non chiude una richiesta su un dato che non ha letto).
 */
export async function stockDiAlunno(
    admin: SupabaseClient,
    alunnoId: string,
): Promise<Record<string, number> | null> {
    const { data, error } = await admin
        .from('armadietto')
        .select('materiale, quantita, portato')
        .eq('alunno_id', alunnoId)

    if (error) {
        logErrore({ operazione: 'armadietto/stock', evento: 'db' }, error)
        return null
    }

    const stock: Record<string, number> = {}
    for (const r of (data ?? []) as Array<{ materiale: string; quantita: number; portato: boolean }>) {
        stock[r.materiale] = (stock[r.materiale] ?? 0) + (r.portato ? r.quantita : -r.quantita)
    }
    for (const m of Object.keys(stock)) stock[m] = Math.max(0, stock[m])
    return stock
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run __tests__/lib/armadietto-stock.test.ts
```

Atteso: **4 passed**. Leggi il numero.

- [ ] **Step 5: Commit**

```bash
git add src/lib/armadietto/stock.ts __tests__/lib/armadietto-stock.test.ts
git commit -m "$(cat <<'EOF'
stockDiAlunno: la somma del libro giornale, in un posto solo

Ritorna null su errore di lettura invece di un oggetto vuoto: «nessun materiale»
e «non ho potuto guardare» si leggono uguali e significano l'opposto, e il motore
delle richieste non deve chiudere una richiesta su un dato che non ha letto.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `soglieMateriali` — configurazione con ripiego

**File:**
- Crea: `src/lib/armadietto/soglie.ts`, `__tests__/lib/armadietto-soglie.test.ts`

- [ ] **Step 1: Test che fallisce**

```ts
// __tests__/lib/armadietto-soglie.test.ts
import { describe, it, expect, vi } from 'vitest'
import { soglieMateriali } from '@/lib/armadietto/soglie'

function admin(rows: unknown[] | null, error: unknown = null) {
  return {
    from: vi.fn(() => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'in']) qb[m] = () => qb
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(res)
      return qb
    }),
  } as never
}

describe('soglieMateriali', () => {
  it('locker_config vuota → le soglie di MATERIALI_DEFAULT', async () => {
    const s = await soglieMateriali(admin([]), 'sec1')
    expect(s.Pannolini).toEqual({ allerta: 5, emergenza: 2 })
    expect(s.Cambio).toEqual({ allerta: 2, emergenza: 1 })
  })

  it('locker_config popolata → vincono le sue righe, non i default', async () => {
    const s = await soglieMateriali(admin([
      { nome: 'Pannolini', livello_allerta: 12, livello_emergenza: 6, attivo: true },
    ]), 'sec1')
    expect(s.Pannolini).toEqual({ allerta: 12, emergenza: 6 })
    // e i default NON si mescolano: una sezione configurata traccia solo ciò
    // che ha configurato, altrimenti togliere un materiale non lo toglierebbe
    expect(s.Cambio).toBeUndefined()
  })

  it('lettura fallita → default, e lascia un warn', async () => {
    const s = await soglieMateriali(admin(null, { code: 'PGRST205', message: 'x' }), 'sec1')
    expect(s.Pannolini).toEqual({ allerta: 5, emergenza: 2 })
  })

  it('senza sezione → default', async () => {
    const s = await soglieMateriali(admin([]), null)
    expect(Object.keys(s)).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Falliscilo**

```bash
npx vitest run __tests__/lib/armadietto-soglie.test.ts
```

Atteso: FAIL sull'import.

- [ ] **Step 3: Implementa**

```ts
// src/lib/armadietto/soglie.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { MATERIALI_DEFAULT } from '@/lib/armadietto/materiali-default'

export interface Soglia { allerta: number; emergenza: number }

const DEFAULT: Record<string, Soglia> = Object.fromEntries(
    MATERIALI_DEFAULT.map((m) => [m.nome, { allerta: m.livello_allerta, emergenza: m.livello_emergenza }]),
)

/**
 * Le soglie di allarme per materiale, per una sezione.
 *
 * `locker_config` popolata → vincono le sue righe, e SOLO quelle: se la segreteria
 * ha tolto «Cambio» da quella sezione, non deve rientrare dalla finestra dei
 * default, altrimenti togliere un materiale non lo toglierebbe davvero.
 *
 * `locker_config` vuota o illeggibile → i default. Non è un ripiego d'emergenza:
 * al 2026-09-01 la tabella ha ZERO righe per decisione del titolare, quindi questo
 * è il caso NORMALE. Stessa regola che applica già `api/locker/materials/route.ts`,
 * ed è il motivo per cui vive qui e non là: due percorsi di lettura per la stessa
 * soglia sono due schermate che un giorno mostrano numeri diversi.
 */
export async function soglieMateriali(
    admin: SupabaseClient,
    sectionId: string | null,
): Promise<Record<string, Soglia>> {
    if (!sectionId) return { ...DEFAULT }

    const { data, error } = await admin
        .from('locker_config')
        .select('nome, livello_allerta, livello_emergenza')
        .eq('attivo', true)
        .eq('section_id', sectionId)

    if (error) {
        // `warn` e non `error`: il ripiego è previsto e il risultato è salvo. Resta
        // un warn perché se la tabella C'È ed è la QUERY a fallire, questa riga è
        // l'unico indizio che le richieste stanno nascendo sulle soglie sbagliate.
        logEvento('db', 'warn', {
            operazione: 'armadietto/soglie',
            esito: 'locker-config-non-letta-uso-default',
        }, error)
        return { ...DEFAULT }
    }

    if (!data || data.length === 0) return { ...DEFAULT }

    return Object.fromEntries(
        (data as Array<{ nome: string; livello_allerta: number; livello_emergenza: number }>)
            .map((r) => [r.nome, { allerta: r.livello_allerta, emergenza: r.livello_emergenza }]),
    )
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run __tests__/lib/armadietto-soglie.test.ts
```

Atteso: **4 passed**.

- [ ] **Step 5: Commit**

```bash
git add src/lib/armadietto/soglie.ts __tests__/lib/armadietto-soglie.test.ts
git commit -m "$(cat <<'EOF'
soglieMateriali: locker_config se c'e', i default altrimenti

Una sezione configurata traccia SOLO cio' che ha configurato: i default non si
mescolano, altrimenti togliere un materiale non lo toglierebbe davvero.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `riconciliaRichieste` — il motore

> 🔴 **IL CODICE QUI SOTTO CONTIENE DUE DIFETTI, TROVATI IN ESECUZIONE E CORRETTI.
> La verità è in `src/lib/armadietto/richieste.ts` (commit `f0e15d22` + `b4bab171` + `b2832052`),
> non in questo blocco.** Resta scritto perché la misura vale più della correzione.
>
> **1. L'`upsert` non funziona, e sarebbe stato invisibile.** Il piano diceva
> `.upsert(…, { onConflict: 'alunno_id,materiale' })`. `EXPLAIN` sulla produzione risponde
> **`42P10 — there is no unique or exclusion constraint matching the ON CONFLICT specification`**:
> Postgres **non infersce un indice parziale** da un `ON CONFLICT (colonne)` nudo — pretende un
> `WHERE` che implichi il predicato — e PostgREST non ha modo di mandarlo. Ogni apertura sarebbe
> fallita, `aperte` sarebbe restato a zero, **il modulo non avrebbe mai aperto una richiesta**, e si
> sarebbe visto solo in `app_log`. I test restavano verdi: **un mock dice sempre di sì.**
> → `.insert()` nudo, e il `23505` è **benigno** (la guardia ha funzionato, non incrementa `aperte`).
>
> **2. `stock[materiale] ?? 0` avrebbe spedito notifiche false a centinaia di famiglie.** Siccome
> `locker_config` è vuota, `soglieMateriali` restituisce tutti e quattro i materiali per **ogni**
> bambino. Leggendo la chiave assente come `0`, il cron avrebbe aperto una richiesta **rossa** di
> Crema, Salviette e Cambio a ogni bambino che in armadietto ha solo i pannolini. Una chiave assente
> dal libro giornale dice «nessun movimento», **non** «esaurito».
> → i materiali senza movimenti si saltano.

**File:**
- Crea: `src/lib/armadietto/richieste.ts`, `__tests__/lib/armadietto-richieste.test.ts`

- [ ] **Step 1: Test che fallisce**

```ts
// __tests__/lib/armadietto-richieste.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  stock: vi.fn(),
  soglie: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  vive: { current: [] as unknown[] },
}))

vi.mock('@/lib/armadietto/stock', () => ({ stockDiAlunno: h.stock }))
vi.mock('@/lib/armadietto/soglie', () => ({ soglieMateriali: h.soglie }))

function admin() {
  return {
    from: vi.fn((t: string) => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'neq', 'order']) qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve({
        data: { section_id: 'sec1', scuola_id: 'sc1' }, error: null,
      })
      qb.upsert = (...a: unknown[]) => { h.upsert(t, ...a); return { select: () => Promise.resolve({ data: [], error: null }) } }
      qb.update = (...a: unknown[]) => { h.update(t, ...a); return qb }
      qb.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: h.vive.current, error: null }).then(r)
      return qb
    }),
  } as never
}

import { riconciliaRichieste } from '@/lib/armadietto/richieste'

beforeEach(() => {
  vi.clearAllMocks()
  h.vive.current = []
  h.soglie.mockResolvedValue({ Pannolini: { allerta: 5, emergenza: 2 } })
})

describe('riconciliaRichieste', () => {
  it('apre GIALLO quando lo stock tocca la soglia di allerta', async () => {
    h.stock.mockResolvedValue({ Pannolini: 5 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ materiale: 'Pannolini', livello: 'giallo', quantita_residua: 5, stato: 'aperta' }),
      expect.anything())
  })

  it('apre ROSSO alla soglia di emergenza', async () => {
    h.stock.mockResolvedValue({ Pannolini: 2 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ livello: 'rosso' }), expect.anything())
  })

  it('sopra soglia non apre niente', async () => {
    h.stock.mockResolvedValue({ Pannolini: 6 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('chiude quando il carico riporta lo stock sopra soglia', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 32 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ stato: 'evasa' }))
  })

  it('promuove giallo → rosso', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'giallo', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 1 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).toHaveBeenCalledWith('armadietto_richieste',
      expect.objectContaining({ livello: 'rosso' }))
  })

  it('NON declassa rosso → giallo: un allarme dato non si ritira', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue({ Pannolini: 4 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    const arg = h.update.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined
    expect(arg?.livello).not.toBe('giallo')
  })

  it('non tocca una presa_in_carico finche resta sotto soglia', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'presa_in_carico' }]
    h.stock.mockResolvedValue({ Pannolini: 2 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('stock illeggibile → non fa NIENTE, non chiude a vuoto', async () => {
    h.vive.current = [{ id: 'r1', materiale: 'Pannolini', livello: 'rosso', stato: 'aperta' }]
    h.stock.mockResolvedValue(null)
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('materiale senza soglia configurata: nessuna richiesta', async () => {
    h.stock.mockResolvedValue({ Sconosciuto: 0 })
    await riconciliaRichieste(admin(), { alunnoId: 'a1' })
    expect(h.upsert).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Falliscilo**

```bash
npx vitest run __tests__/lib/armadietto-richieste.test.ts
```

Atteso: FAIL sull'import.

- [ ] **Step 3: Implementa**

```ts
// src/lib/armadietto/richieste.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { stockDiAlunno } from '@/lib/armadietto/stock'
import { soglieMateriali } from '@/lib/armadietto/soglie'

const TAVOLA = 'armadietto_richieste'

export interface EsitoRiconciliazione { aperte: number; aggiornate: number; evase: number }

interface RichiestaViva {
    id: string
    materiale: string
    livello: 'giallo' | 'rosso'
    stato: 'aperta' | 'presa_in_carico'
}

/**
 * Allinea le richieste di rifornimento allo stock reale di un alunno.
 *
 * Apre a `stock <= allerta` (`rosso` sotto `emergenza`), chiude sopra la stessa
 * linea: la soglia di apertura e quella di chiusura coincidono, quindi non c'è
 * zona morta e non c'è ping-pong finché lo stock non attraversa davvero il confine.
 *
 * Promuove giallo → rosso ma NON declassa: un allarme già dato al genitore non si
 * ritira perché la maestra ha caricato due pezzi.
 *
 * ⚠️ Se lo stock non è leggibile non fa NULLA. Chiudere una richiesta su un dato
 * non letto significherebbe dire al genitore «non serve più» senza saperlo.
 */
export async function riconciliaRichieste(
    admin: SupabaseClient,
    { alunnoId }: { alunnoId: string },
): Promise<EsitoRiconciliazione> {
    const esito: EsitoRiconciliazione = { aperte: 0, aggiornate: 0, evase: 0 }

    const { data: al, error: alErr } = await admin
        .from('alunni').select('section_id, scuola_id').eq('id', alunnoId).maybeSingle()
    if (alErr || !al?.scuola_id) {
        logEvento('armadietto', 'warn', {
            operazione: 'armadietto/riconcilia', esito: 'anagrafica-non-leggibile',
        }, alErr)
        return esito
    }

    const stock = await stockDiAlunno(admin, alunnoId)
    if (stock === null) return esito   // già loggato da stockDiAlunno

    const soglie = await soglieMateriali(admin, (al.section_id as string | null) ?? null)

    const { data: viveRaw, error: viveErr } = await admin
        .from(TAVOLA).select('id, materiale, livello, stato').eq('alunno_id', alunnoId).neq('stato', 'evasa')
    if (viveErr) {
        logErrore({ operazione: 'armadietto/riconcilia', evento: 'db' }, viveErr)
        return esito
    }
    const vive = new Map((viveRaw as RichiestaViva[] ?? []).map((r) => [r.materiale, r]))

    const adesso = new Date().toISOString()

    for (const [materiale, soglia] of Object.entries(soglie)) {
        const q = stock[materiale] ?? 0
        const viva = vive.get(materiale)
        const sotto = q <= soglia.allerta
        const livello: 'giallo' | 'rosso' = q <= soglia.emergenza ? 'rosso' : 'giallo'

        if (!sotto) {
            if (viva) {
                const { error } = await admin.from(TAVOLA)
                    .update({ stato: 'evasa', evasa_il: adesso, aggiornato_il: adesso })
                    .eq('id', viva.id)
                if (error) logErrore({ operazione: 'armadietto/riconcilia:evade', evento: 'db' }, error)
                else esito.evase++
            }
            continue
        }

        if (viva) {
            // Solo verso il peggio. `quantita_residua` si aggiorna sempre: è il
            // numero che il genitore legge nella notifica.
            const nuovo = viva.livello === 'rosso' ? 'rosso' : livello
            const { error } = await admin.from(TAVOLA)
                .update({ livello: nuovo, quantita_residua: q, aggiornato_il: adesso })
                .eq('id', viva.id)
            if (error) logErrore({ operazione: 'armadietto/riconcilia:aggiorna', evento: 'db' }, error)
            else esito.aggiornate++
            continue
        }

        // `ON CONFLICT` sull'indice unico parziale: due scritture concorrenti sullo
        // stesso (alunno, materiale) non si rompono a vicenda.
        const { error } = await admin.from(TAVOLA).upsert({
            alunno_id: alunnoId,
            scuola_id: al.scuola_id as string,
            materiale,
            livello,
            quantita_residua: q,
            stato: 'aperta',
            creato_il: adesso,
            aggiornato_il: adesso,
        }, { onConflict: 'alunno_id,materiale', ignoreDuplicates: true }).select()
        if (error) logErrore({ operazione: 'armadietto/riconcilia:apre', evento: 'db' }, error)
        else esito.aperte++
    }

    return esito
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run __tests__/lib/armadietto-richieste.test.ts
```

Atteso: **9 passed**. Se qualcuno fallisce sul mock del query-builder, aggiusta il mock — **non** la
regola.

- [ ] **Step 5: Commit**

```bash
git add src/lib/armadietto/richieste.ts __tests__/lib/armadietto-richieste.test.ts
git commit -m "$(cat <<'EOF'
Il motore delle richieste: apre alla soglia, chiude sopra la stessa linea

Nessuna zona morta e nessun ping-pong: apertura e chiusura condividono il confine.
Promuove giallo → rosso ma non declassa — un allarme gia' dato al genitore non si
ritira perche' la maestra ha caricato due pezzi.

Se lo stock non e' leggibile non fa NULLA: chiudere una richiesta su un dato non
letto significherebbe dire al genitore «non serve piu'» senza saperlo.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `riconciliaTutto` — la passata del cron

**File:**
- Modifica: `src/lib/armadietto/richieste.ts`, `__tests__/lib/armadietto-richieste.test.ts`

- [ ] **Step 1: Test che fallisce**

Aggiungi in fondo al file di test:

```ts
describe('riconciliaTutto', () => {
  it('riconcilia ogni alunno con movimenti, non solo quelli mossi di recente', async () => {
    // La segreteria ieri ha alzato una soglia da 5 a 8: le richieste devono
    // comparire stamattina anche se nessun bambino si e' mosso.
    h.vive.current = [{ alunno_id: 'a1' }, { alunno_id: 'a2' }, { alunno_id: 'a1' }]
    h.stock.mockResolvedValue({ Pannolini: 6 })
    h.soglie.mockResolvedValue({ Pannolini: { allerta: 8, emergenza: 3 } })
    const { riconciliaTutto } = await import('@/lib/armadietto/richieste')
    const esito = await riconciliaTutto(admin())
    expect(esito.alunni).toBe(2)      // a1 una volta sola
    expect(esito.aperte).toBe(2)
  })
})
```

- [ ] **Step 2: Falliscilo**

```bash
npx vitest run __tests__/lib/armadietto-richieste.test.ts -t 'riconcilia ogni alunno'
```

Atteso: FAIL, «riconciliaTutto is not a function». ⚠️ Se vedi **0 test eseguiti** hai sbagliato il
nome nel `-t` e vitest esce comunque 0: leggi il conteggio.

- [ ] **Step 3: Implementa**

Aggiungi in fondo a `src/lib/armadietto/richieste.ts`:

```ts
/**
 * La passata completa, per il cron delle 06:00.
 *
 * Riconcilia OGNI alunno che ha almeno un movimento in `armadietto` — non solo
 * quelli mossi di recente. Serve proprio per i casi senza movimento: se ieri la
 * segreteria ha alzato una soglia da 5 a 8, le richieste devono comparire
 * stamattina, e nessun bambino si è mosso.
 */
export async function riconciliaTutto(
    admin: SupabaseClient,
): Promise<EsitoRiconciliazione & { alunni: number }> {
    const totale = { aperte: 0, aggiornate: 0, evase: 0, alunni: 0 }

    const { data, error } = await admin.from('armadietto').select('alunno_id')
    if (error) {
        logErrore({ operazione: 'armadietto/riconcilia-tutto', evento: 'db' }, error)
        return totale
    }

    const ids = [...new Set((data as Array<{ alunno_id: string }> ?? []).map((r) => r.alunno_id))]
    totale.alunni = ids.length

    for (const id of ids) {
        const e = await riconciliaRichieste(admin, { alunnoId: id })
        totale.aperte += e.aperte
        totale.aggiornate += e.aggiornate
        totale.evase += e.evase
    }

    return totale
}
```

- [ ] **Step 4: Verde**

```bash
npx vitest run __tests__/lib/armadietto-richieste.test.ts
```

Atteso: **10 passed**.

- [ ] **Step 5: Commit**

```bash
git add src/lib/armadietto/richieste.ts __tests__/lib/armadietto-richieste.test.ts
git commit -m "$(cat <<'EOF'
riconciliaTutto: la passata del cron su tutti, non sui mossi di recente

Se ieri la segreteria ha alzato una soglia, le richieste devono comparire
stamattina — e nessun bambino si e' mosso.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Agganciare il motore alle tre scritture

**File:**
- Modifica: `src/app/api/locker/inventory/route.ts` (POST dopo `:301`, PATCH dopo `:366`),
  `src/app/api/diary/entries/route.ts` (dopo `:337`)
- Crea: `__tests__/api/armadietto-riconcilia-agganci.test.ts`

- [ ] **Step 1: Test che fallisce**

```ts
// __tests__/api/armadietto-riconcilia-agganci.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ riconcilia: vi.fn(), requireParent: vi.fn(), logErrore: vi.fn() }))

vi.mock('@/lib/armadietto/richieste', () => ({ riconciliaRichieste: h.riconcilia }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/audit/scritture', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig() as object), logErrore: h.logErrore,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'insert', 'update']) qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve({ data: { section_id: 's1', scuola_id: 'sc1' }, error: null })
      qb.single = () => Promise.resolve({ data: { id: 'mov1' }, error: null })
      return qb
    },
  }),
}))

import { POST } from '@/app/api/locker/inventory/route'

const body = { alunno_id: '11111111-1111-1111-1111-111111111111', materiale: 'Pannolini', quantita: 30 }
function req() {
  return new Request('http://localhost/api/locker/inventory', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireParent.mockResolvedValue({ user: { id: 'p1', role: 'parent' } })
  h.riconcilia.mockResolvedValue({ aperte: 0, aggiornate: 0, evase: 1 })
})

describe('il carico riconcilia le richieste', () => {
  it('dopo un carico riuscito chiama riconciliaRichieste per quell alunno', async () => {
    const res = await POST(req() as never)
    expect(res.status).toBe(200)
    expect(h.riconcilia).toHaveBeenCalledWith(expect.anything(), { alunnoId: body.alunno_id })
  })

  it('se la riconciliazione esplode il CARICO resta salvo, e resta una riga di log', async () => {
    // Il carico e' il dato, la richiesta e' la conseguenza: la conseguenza non
    // puo' far fallire il dato.
    h.riconcilia.mockRejectedValue(new Error('boom'))
    const res = await POST(req() as never)
    expect(res.status).toBe(200)
    expect(h.logErrore).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Falliscilo**

```bash
npx vitest run __tests__/api/armadietto-riconcilia-agganci.test.ts
```

Atteso: FAIL — `riconciliaRichieste` non è mai chiamata.

- [ ] **Step 3: Aggancia, con lo stesso blocco in tutti e tre i punti**

Aggiungi l'import in cima a ciascuno dei due file:

```ts
import { riconciliaRichieste } from '@/lib/armadietto/richieste';
```

E questo blocco **subito dopo `logScrittura`** e **prima del `return`** — in
`inventory/route.ts` POST (dopo `:301`) e PATCH (dopo `:366`), e in `diary/entries/route.ts`
dopo lo scalo del pannolino (`:337`):

```ts
        // Il carico è il DATO, la richiesta è la CONSEGUENZA: la conseguenza non
        // può far fallire il dato. Se la riconciliazione esplode, il movimento
        // resta scritto e il cron delle 06:00 rimetterà le cose a posto.
        // Un catch che non logga sarebbe un bug (AGENTS.md regola 6).
        try {
            await riconciliaRichieste(supabase, { alunno_id: alunno_id } as never);
        } catch (e) {
            logErrore({ operazione: 'locker/inventory:POST', evento: 'armadietto' }, e);
        }
```

⚠️ Correggi tre cose per ogni punto: il nome del client (`supabase` o `admin` a seconda del punto),
l'argomento corretto `{ alunnoId: alunno_id }` — **senza** il cast `as never` — e la stringa
`operazione`, che deve essere quella della route in cui stai scrivendo
(`locker/inventory:PATCH`, `diary/entries:POST`).

- [ ] **Step 4: Verde**

```bash
npx vitest run __tests__/api/armadietto-riconcilia-agganci.test.ts __tests__/api/presenze-armadietto-sede-scrittura.test.ts __tests__/api/locker-inventory-auth.test.ts
```

Atteso: 3 file passati. Il terzo e il secondo esistevano già e **non devono rompersi**.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/locker/inventory/route.ts src/app/api/diary/entries/route.ts __tests__/api/armadietto-riconcilia-agganci.test.ts
git commit -m "$(cat <<'EOF'
Carico, consumo e scalo pannolino ora riconciliano le richieste

Agganciati i tre punti di scrittura. La riconciliazione non puo' far fallire il
movimento: il carico e' il dato, la richiesta e' la conseguenza. Se esplode, il
movimento resta scritto, resta una riga di log e il cron rimette a posto.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7-bis: ⚠️ Rigenerare `tabelle-scuola-id.json` — PRIMA del Task 8

**Aggiunto il 2026-09-01 dopo la revisione del Task 1. Era una lacuna di questo piano.**

`__tests__/fixtures/tabelle-scuola-id.json` è l'unica delle quattro istantanee **senza guardia di
freschezza**: le altre tre scadono su `generato_alle` (`migrazioni-complete.test.ts:290`,
`rls-per-sede.test.ts:300`, `fk-scuola-id.test.ts:290`), questa ha solo un tamper-check sha256 sul
*contenuto* (`isolamento-sede-coverage.test.ts:1166-1176`). Resta verde ed è **cieca**.

Fotografia del **2026-08-10**, 66 tabelle; il database ne ha **72**. Mancano `armadietto_richieste`,
`candidature_sedi`, `iscrizioni_elenco_caricamenti`, `iscrizioni_elenco_righe`,
`iscrizioni_import_esiti`, `pratiche_personale` — le ultime cinque scoperte da settimane.

`CON_SEDE` (riga 112) alimenta i tre controlli alle righe **688, 692, 696**, quelli che pretendono
che un handler service-role dichiari la sede in scrittura e verifichi la riga in lettura. **Una
tabella fuori da `CON_SEDE` non è sorvegliata**: senza questo task, le rotte dei Task 8 e 9
passerebbero il lock senza dichiarare mai una sede, su una tabella con `scuola_id NOT NULL`, tre
plessi di produzione e dati di minori.

- [ ] **Step 1: Rigenera**

```bash
node scripts/tabelle-sede-fotografia.mjs --sql
```

Esegui la query che stampa su Supabase **in sola lettura**, salva la risposta e passala allo script:

```bash
node scripts/tabelle-sede-fotografia.mjs < risposta.json
```

- [ ] **Step 2: Verifica che le sei tabelle siano entrate**

```bash
grep -c '"' __tests__/fixtures/tabelle-scuola-id.json
grep -n "armadietto_richieste" __tests__/fixtures/tabelle-scuola-id.json
```

Atteso: `armadietto_richieste` presente.

- [ ] **Step 3: Aspettati un rosso NON correlato, e non aggirarlo**

```bash
npx vitest run __tests__/architecture/isolamento-sede-coverage.test.ts
```

Le altre cinque tabelle erano scoperte da settimane: rendendole visibili al lock, **emergeranno
handler che non c'entrano niente con l'armadietto**. Non metterli in allowlist per far passare il
test: leggi ogni caso, e se l'handler davvero non dichiara la sede è un difetto vero che questo lock
esisteva per trovare. Se sono più di due o tre, **fermati e riferisci**: è un lavoro a sé e non deve
finire dentro questo piano di soppiatto.

Il `toEqual` esatto sui conteggi (`:1218`) andrà comunque aggiornato a mano.

- [ ] **Step 4: Commit**

```bash
git add __tests__/fixtures/tabelle-scuola-id.json __tests__/architecture/isolamento-sede-coverage.test.ts
git commit -m "$(cat <<'EOF'
La fotografia dell'isolamento per sede era cieca da tre settimane

E' l'unica delle quattro senza guardia di freschezza: le altre scadono su
`generato_alle`, questa ha solo un tamper-check sul contenuto — quindi restava
verde mentre non sapeva piu' niente. Ferma al 10 agosto, 66 tabelle su 72.

Fuori da CON_SEDE una tabella non e' sorvegliata: senza questa rigenerazione le
rotte su `armadietto_richieste` sarebbero passate senza dichiarare mai una sede,
su una tabella con scuola_id NOT NULL e tre plessi.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: La rotta — GET su `armadietto_richieste`

**File:**
- Modifica: `src/app/api/locker/requests/route.ts` (GET, righe 63-151)

- [ ] **Step 1: Riscrivi le due query**

Sostituisci `.from('locker_requests')` con `.from('armadietto_richieste')` e i due blocchi
`.select()` con embed (righe 80-84 e 125-129) con:

```ts
                .select('id, alunno_id, materiale, livello, quantita_residua, stato, presa_in_carico_il, evasa_il, creato_il, alunni (id, nome, cognome)')
```

Cambia l'ordinamento da `.order('creato_il', …)` — la colonna si chiama uguale, **non toccarlo**.

**Non toccare i gate** (`requireParentOfStudent` a `:75`, `requireDocente` +
`assertClasseNomeInScope` a `:99-107`) né la tolleranza `tabellaMancante`: serve ancora al DB E2E
della CI, che è un progetto separato e non migrato.

- [ ] **Step 2: I test esistenti restano verdi**

```bash
npx vitest run __tests__/api/locker-requests-colonna-assente.test.ts
```

Atteso: passato. Questo test verifica che `42703` (colonna assente) diventi **500** e non lista
vuota: se lo hai rotto, hai toccato la tolleranza.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/locker/requests/route.ts
git commit -m "$(cat <<'EOF'
GET /api/locker/requests legge la tabella che esiste

Via l'embed `locker_catalog`: `materiale` e' una colonna piatta. Gate e tolleranza
`tabellaMancante` intatti — quest'ultima serve ancora al DB E2E della CI, che e' un
progetto separato e non migrato.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: La rotta — PATCH, e la riparazione del 403

Il bottone «Preso in carico» della pagina genitore chiama una route protetta da `requireDocente`:
un genitore prende **403**. Il gesto è del genitore, il gate è della scuola.

**File:**
- Modifica: `src/app/api/locker/requests/route.ts` (PATCH, righe 157-214)
- Modifica: `__tests__/api/locker-requests-auth.test.ts`
- Verifica: `__tests__/architecture/corpo-letto-dopo-il-gate.test.ts`

- [ ] **Step 1: Riscrivi il test**

Sostituisci l'intero `describe` di `__tests__/api/locker-requests-auth.test.ts` con:

```ts
describe('PATCH /api/locker/requests — il gate segue il gesto', () => {
  const idReq = '22222222-2222-2222-2222-222222222222'
  const idAlunno = '11111111-1111-1111-1111-111111111111'
  const confermaGenitore = { id: idReq, alunno_id: idAlunno, stato: 'presa_in_carico' }
  const evasioneScuola = { id: idReq, alunno_id: idAlunno, stato: 'evasa' }

  it('401 anonimo sulla conferma del genitore: nessuna mutazione', async () => {
    h.requireParent.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    const res = await PATCH(req(confermaGenitore) as never)
    expect(res.status).toBe(401)
    expect(h.fromSpy).not.toHaveBeenCalled()
  })

  it('200: il genitore conferma «La porto» per il PROPRIO figlio', async () => {
    const res = await PATCH(req(confermaGenitore) as never)
    expect(res.status).toBe(200)
    expect(h.requireParent).toHaveBeenCalledWith(expect.anything(), idAlunno)
  })

  it('403: il genitore non conferma per il figlio di un altro', async () => {
    h.requireParent.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await PATCH(req(confermaGenitore) as never)
    expect(res.status).toBe(403)
  })

  it('404: la riga non appartiene all alunno dichiarato nel corpo', async () => {
    // Il gate ha creduto al corpo: dopo, si verifica che la riga sia davvero sua.
    h.rowResult.current = { data: { id: 'r1', alunno_id: 'ALTRO' }, error: null }
    const res = await PATCH(req(confermaGenitore) as never)
    expect(res.status).toBe(404)
  })

  it('403: il genitore NON puo evadere — quello e un gesto della scuola', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await PATCH(req(evasioneScuola) as never)
    expect(res.status).toBe(403)
    expect(h.requireParent).not.toHaveBeenCalled()
  })

  it('200: il docente evade dentro il proprio scope', async () => {
    const res = await PATCH(req(evasioneScuola) as never)
    expect(res.status).toBe(200)
    expect(h.assertAlunnoInScope).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'a1')
  })

  it('403: il docente non evade fuori dal proprio scope', async () => {
    h.assertAlunnoInScope.mockResolvedValue(NextResponse.json({}, { status: 403 }))
    const res = await PATCH(req(evasioneScuola) as never)
    expect(res.status).toBe(403)
  })

  it('tabella assente → degrada pulito', async () => {
    h.rowResult.current = { data: null, error: { code: '42P01', message: 'x' } }
    const res = await PATCH(req(evasioneScuola) as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, degraded: true })
  })
})
```

Aggiorna anche il blocco `h` in cima aggiungendo `requireParent: vi.fn()`, il `vi.mock` di
`require-parent` per puntarci, e il `beforeEach` con
`h.requireParent.mockResolvedValue({ user: { id: 'p1', role: 'parent' } })` e
`h.rowResult.current = { data: { id: 'r1', alunno_id: idAlunno }, error: null }`.

- [ ] **Step 2: Falliscilo**

```bash
npx vitest run __tests__/api/locker-requests-auth.test.ts
```

Atteso: FAIL sui casi del genitore (oggi prendono 403 da `requireDocente`).

- [ ] **Step 3: Implementa**

Sostituisci lo schema e il corpo della PATCH:

```ts
// Il gate deve sapere PER CHI decidere, e lo sa solo dal corpo: `alunno_id`
// accompagna `id`. È il pattern già in uso nei cinque `requireParentOfStudent(
// request, idDalCorpo)` del repo — l'unico possibile quando il soggetto del
// permesso sta nella richiesta e non nella sessione.
const patchBodySchema = z.object({
    id: zUuid,
    alunno_id: zUuid,
    stato: z.enum(['presa_in_carico', 'evasa']),
});

export const PATCH = withRoute('locker/requests:PATCH', async (request: NextRequest) => {
    try {
        const b = await parseBody(request, patchBodySchema);
        if ('response' in b) return b.response;
        const { id, alunno_id, stato } = b.data;

        // IL GATE SEGUE IL GESTO. Fino al 2026-09-01 questa route aveva un solo
        // gate, `requireDocente`, e la pagina genitore ci mandava il bottone
        // «Preso in carico»: ogni genitore che lo premeva prendeva 403. Il difetto
        // non era la tabella mancante — sarebbe rimasto anche dopo averla creata.
        //
        //   presa_in_carico → è il GENITORE che dice «la porto»
        //   evasa           → è la SCUOLA che dice «è arrivata»
        const auth = stato === 'presa_in_carico'
            ? await requireParentOfStudent(request, alunno_id)
            : await requireDocente(request);
        if (auth.response) return auth.response;

        const supabase = await createAdminClient();

        const { data: riga, error: rigaErr } = await supabase
            .from('armadietto_richieste')
            .select('id, alunno_id')
            .eq('id', id)
            .maybeSingle();
        if (rigaErr) {
            if (tabellaMancante(rigaErr)) return NextResponse.json({ ok: true, degraded: true });
            return erroreDb(rigaErr, 'locker/requests:PATCH');
        }
        if (!riga) return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 });

        // Il gate ha creduto al corpo: ora si verifica che la riga sia davvero di
        // quell'alunno, altrimenti `alunno_id` sarebbe una chiave per aprire la
        // porta di casa propria ed entrare in quella del vicino. 404 e non 403:
        // a chi non ha titolo non si conferma nemmeno che l'id esista.
        if (riga.alunno_id !== alunno_id) {
            return NextResponse.json({ error: 'Richiesta non trovata' }, { status: 404 });
        }

        if (stato === 'evasa') {
            const scopeErr = await assertAlunnoInScope(supabase, auth.user, riga.alunno_id);
            if (scopeErr) return scopeErr;
        }

        const adesso = new Date().toISOString();
        const updates: Record<string, unknown> = { stato, aggiornato_il: adesso };
        if (stato === 'presa_in_carico') {
            updates.presa_in_carico_il = adesso;
            updates.presa_in_carico_da = auth.user?.id ?? null;
        } else {
            updates.evasa_il = adesso;
        }

        const { data, error } = await supabase
            .from('armadietto_richieste')
            .update(updates).eq('id', id).select().single();

        if (error) {
            if (tabellaMancante(error)) return NextResponse.json({ ok: true, degraded: true });
            return erroreDb(error, 'locker/requests:PATCH');
        }
        return NextResponse.json(data);
    } catch (err) {
        logErrore({ operazione: 'locker/requests:PATCH', stato: 500 }, err);
        return NextResponse.json({ error: 'Errore interno del server' }, { status: 500 });
    }
});
```

- [ ] **Step 4: Verde, e il lock del corpo-dopo-il-gate**

```bash
npx vitest run __tests__/api/locker-requests-auth.test.ts __tests__/architecture/corpo-letto-dopo-il-gate.test.ts
```

Atteso: entrambi passati. Se il secondo è rosso, aggiungi `locker/requests:PATCH` all'allowlist
accanto a `locker/inventory:POST` (`:228`), con la motivazione: **il gate ha bisogno di
`alunno_id`, che sta nel corpo**.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/locker/requests/route.ts __tests__/
git commit -m "$(cat <<'EOF'
Il bottone del genitore prendeva 403, e non era colpa della tabella

`parent/locker/page.tsx:192` mostra «Preso in carico» e chiamava una PATCH protetta
da `requireDocente`: ogni genitore che lo premeva prendeva 403. Il difetto sarebbe
rimasto anche dopo aver creato la tabella.

Ora il gate segue il gesto: `presa_in_carico` e' il genitore («la porto»),
`evasa` e' la scuola. `alunno_id` viaggia nel corpo perche' il gate deve sapere
per chi decidere, e dopo il gate si verifica che la riga sia davvero sua — 404 e
non 403, a chi non ha titolo non si conferma nemmeno che l'id esista.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Cancellare `catalog/route.ts`

Rotta morta su una tabella morta, **senza chiamanti**, **senza tolleranza** (500 secco) e che
**propaga `error.message` di PostgREST** al chiamante — la fuga di schema già chiusa altrove.

**File:** Cancella `src/app/api/locker/catalog/route.ts`

- [ ] **Step 1: Verifica che non la chiami nessuno**

```bash
grep -rn "locker/catalog" src/ __tests__/ e2e/ 2>/dev/null
```

Atteso: **nessun risultato** fuori dal file stesso. Se ne trovi, fermati e riferisci.

- [ ] **Step 2: Cancella**

```bash
git rm src/app/api/locker/catalog/route.ts
```

- [ ] **Step 3: I lock reggono**

```bash
npx vitest run __tests__/architecture/logging-coverage.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts
```

⚠️ `isolamento-sede-coverage.test.ts:1218` fa un `toEqual` **esatto** sui conteggi di route: togliere
una rotta lo fa diventare rosso. Aggiorna i numeri a mano — è previsto.

- [ ] **Step 4: Commit**

```bash
git add -A src/app/api/locker/ __tests__/
git commit -m "$(cat <<'EOF'
Via /api/locker/catalog: morta, senza chiamanti, e perdeva lo schema

Unica rotta su `locker_catalog` (tabella inesistente), nessun consumatore in tutto
il repo, nessuna tolleranza (500 secco) e `error.message` di PostgREST restituito
al chiamante — nome dello schema, della tabella e della colonna.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Il cron delle 06:00

**File:**
- Modifica: `src/app/api/notifiche/promemoria/route.ts` (scansione 2, righe 222-275)

- [ ] **Step 1: Riscrivi la scansione**

Sostituisci il blocco `── 2. Richieste armadietto pending ──`:

```ts
    // ── 2. Richieste armadietto ───────────────────────────────────────────────
    try {
      // Prima si riconcilia, poi si legge: senza questa riga la scansione
      // lavorerebbe sullo stato di ieri sera, e una soglia alzata dalla segreteria
      // ieri non produrrebbe nessuna richiesta stamattina.
      const ric = await riconciliaTutto(supabase)
      logEvento('cron', 'info', {
        operazione: JOB, esito: 'armadietto-riconciliato',
        n: ric.alunni, aperte: ric.aperte, evase: ric.evase,
      })

      const { data: richieste, error } = await supabase
        .from('armadietto_richieste')
        .select('id, alunno_id, materiale, quantita_residua')
        .eq('stato', 'aperta')
        .is('promemoria_inviato_il', null)
      if (error) {
        if (!tabellaMancante(error)) throw error
        saltate.push('armadietto')
      } else {
        for (const r of (richieste ?? []) as Array<{
          id: string; alunno_id: string; materiale: string; quantita_residua: number | null
        }>) {
          const { data: alunno, error: errAlunno } = await supabase
            .from('alunni').select('nome, scuola_id').eq('id', r.alunno_id).maybeSingle()
          seFallita(errAlunno, 'lettura alunni (armadietto)')
          const genitori = await genitoriDiAlunni(supabase, [r.alunno_id])
          if (genitori.length > 0) {
            await notificaEvento(supabase, {
              tipo: 'locker_richiesta',
              scuolaId: (alunno?.scuola_id as string | undefined) ?? null,
              utenteIds: genitori,
              titolo: 'Materiale da portare a scuola',
              corpo: `${r.materiale} in esaurimento per ${alunno?.nome ?? 'tuo figlio'}${r.quantita_residua != null ? ` (${r.quantita_residua} rimasti)` : ''}.`,
              link: '/parent/locker',
              entitaTipo: 'armadietto_richiesta',
              entitaId: r.id,
              bufferMin: 0,
            })
            esiti.armadietto += 1
          }
          const { error: errMarca } = await supabase
            .from('armadietto_richieste')
            .update({ promemoria_inviato_il: new Date().toISOString() })
            .eq('id', r.id)
          // Questa marcatura È la garanzia di «un promemoria e uno solo»: se salta
          // in silenzio, la stessa richiesta viene ricordata ogni notte, per sempre.
          seFallita(errMarca, 'marcatura armadietto_richieste')
        }
      }
    } catch (e) {
      logEvento('cron', 'error', { operazione: JOB, esito: 'scansione-fallita', azione: 'armadietto' }, e)
      falliti.push('armadietto')
    }
```

Aggiungi l'import: `import { riconciliaTutto } from '@/lib/armadietto/richieste'`.

Aggiorna anche il commento alle righe 122-136, che descrive il guasto ormai chiuso: lascia la
spiegazione storica (serve), ma di' che dal 2026-09-01 la tabella è `armadietto_richieste` ed
esiste, e che `saltate` per l'armadietto ora significa **solo** DB E2E della CI.

- [ ] **Step 2: Verifica**

```bash
npx vitest run __tests__/api/ -t 'promemoria'
npx tsc --noEmit
```

⚠️ Se vedi «No test files found» o **0 test**, il filtro non ha agganciato niente e vitest esce
comunque 0. Cerca il file giusto con `ls __tests__/api/ | grep -i promemoria`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/notifiche/promemoria/route.ts
git commit -m "$(cat <<'EOF'
Il cron delle 06:00 guarda davvero l'armadietto

Punta `armadietto_richieste` e riconcilia PRIMA di leggere: senza, lavorerebbe
sullo stato di ieri sera e una soglia alzata dalla segreteria non produrrebbe
nessuna richiesta stamattina. `saltate` per l'armadietto ora significa solo «DB
E2E della CI», non piu' «funzionalita' morta».

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Chiudere la falla di scope su `materials`

`PATCH` e `DELETE` risolvono lo scope da `classe_sezione` (testo, **nullable**) invece che da
`section_id`, che dal 2026-07-30 è la chiave. Con quel campo a `null` **non c'è nessun controllo**.

**File:**
- Modifica: `src/app/api/locker/materials/route.ts:217-221`, `:249-253`
- Crea: `__tests__/api/locker-materials-scope-sezione.test.ts`

- [ ] **Step 1: Test che fallisce**

```ts
// __tests__/api/locker-materials-scope-sezione.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => {
  const riga = { current: { data: { section_id: 'sec-altra-sede', classe_sezione: null }, error: null } }
  return { requireDocente: vi.fn(), assertSezione: vi.fn(), riga, del: vi.fn() }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente, requireUser: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: h.assertSezione,
  assertClasseNomeInScope: vi.fn().mockResolvedValue(null),
  scuoleDiUtente: vi.fn().mockResolvedValue(['sc1']),
}))
vi.mock('@/lib/audit/scritture', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'update', 'in', 'order']) qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve(h.riga.current)
      qb.single = () => Promise.resolve({ data: { id: 'm1' }, error: null })
      qb.delete = () => { h.del(); return qb }
      return qb
    },
  }),
}))

import { DELETE } from '@/app/api/locker/materials/route'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator' } })
  h.assertSezione.mockResolvedValue(null)
})

describe('DELETE /api/locker/materials — lo scope segue section_id', () => {
  it('403: riga di un altra sede, anche con classe_sezione NULL', async () => {
    // Il buco: con `classe_sezione` a null il vecchio scope non controllava nulla
    // e la maestra di Aversa cancellava la configurazione di Cesa.
    h.assertSezione.mockResolvedValue(NextResponse.json({}, { status: 403 }))
    const url = 'http://localhost/api/locker/materials?id=11111111-1111-1111-1111-111111111111'
    const res = await DELETE(new Request(url, { method: 'DELETE' }) as never)
    expect(res.status).toBe(403)
    expect(h.del).not.toHaveBeenCalled()
  })

  it('lo scope viene risolto da section_id, non dal nome della classe', async () => {
    const url = 'http://localhost/api/locker/materials?id=11111111-1111-1111-1111-111111111111'
    await DELETE(new Request(url, { method: 'DELETE' }) as never)
    expect(h.assertSezione).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'sec-altra-sede')
  })
})
```

- [ ] **Step 2: Falliscilo**

```bash
npx vitest run __tests__/api/locker-materials-scope-sezione.test.ts
```

Atteso: FAIL — oggi lo scope passa da `classe_sezione`.

- [ ] **Step 3: Trova o scrivi il gate per sezione**

```bash
grep -n "export async function assert" src/lib/auth/scope.ts
```

Se esiste già un `assertSezioneInScope(admin, user, sectionId)`, usalo. Se **non** esiste, scrivilo
in `src/lib/auth/scope.ts` accanto agli altri, con la stessa forma: risolve la sede della sezione da
`sections.scuola_id`, la confronta con `scuoleDiUtente`, e ritorna `NextResponse` 403 o `null`.

- [ ] **Step 4: Sostituisci lo scope in PATCH e DELETE**

In entrambi i punti, leggi `section_id` invece di `classe_sezione` e passa quello:

```ts
        const { data: row } = await admin
            .from('locker_config').select('section_id').eq('id', id).maybeSingle();
        // Lo scope segue `section_id`, non il NOME della classe. Fino al 2026-09-01
        // passava da `classe_sezione`, che è testo LIBERO e NULLABLE: con quel campo
        // a null non c'era nessun controllo, e «2 ANNI» esiste ad Aversa e a Cesa.
        const scopeErr = await assertSezioneInScope(admin, auth.user, (row?.section_id as string | null) ?? null);
        if (scopeErr) return scopeErr;
```

Se `section_id` è `null` (righe legacy), `assertSezioneInScope` deve rifiutare: senza sezione non si
può dire di chi è la riga, e **non sapere di chi è non è un permesso**.

- [ ] **Step 5: Verde**

```bash
npx vitest run __tests__/api/locker-materials-scope-sezione.test.ts __tests__/api/locker-materials-auth.test.ts
```

Atteso: entrambi passati.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/locker/materials/route.ts src/lib/auth/scope.ts __tests__/api/locker-materials-scope-sezione.test.ts
git commit -m "$(cat <<'EOF'
Lo scope dei materiali passava da una colonna nullable

PATCH e DELETE di /api/locker/materials risolvevano lo scope da `classe_sezione`,
testo LIBERO e NULLABLE, invece che da `section_id` — la chiave dal 2026-07-30.
Con quel campo a null non c'era nessun controllo, e «2 ANNI» esiste sia ad Aversa
sia a Cesa: la maestra di una sede poteva cancellare la configurazione dell'altra.

Senza sezione ora si rifiuta: non sapere di chi e' una riga non e' un permesso.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: L'interfaccia del genitore

**File:**
- Modifica: `src/app/(dashboard)/parent/locker/page.tsx`

- [ ] **Step 1: Il tipo**

Sostituisci `LockerRequest` (righe 20-33): via l'oggetto annidato `locker_catalog`, dentro
`materiale: string`. Aggiorna gli usi alle righe 320, 324, 332, 374, 376, 445, 447 —
`req.locker_catalog?.nome` diventa `req.materiale`, e l'icona si prende dai materiali (Step 3).
Gli stati cambiano nome: `'pending' | 'acknowledged' | 'fulfilled'` →
`'aperta' | 'presa_in_carico' | 'evasa'`, e `livello_alert` → `livello`,
`preso_in_carico_il` → `presa_in_carico_il`.

- [ ] **Step 2: Il bottone**

Riga ~192, `handleAcknowledge`: il corpo diventa
`{ id, alunno_id: studentId, stato: 'presa_in_carico' }`. L'etichetta passa da
«Preso in carico» a **«La porto»** — è il genitore che parla, e «preso in carico» suona come una
risposta della scuola.

- [ ] **Step 3: Le soglie vere**

Riga ~400: cancella `const gialla = 5, rossa = 2`. Aggiungi al `fetchData` una terza chiamata a
`/api/locker/materials?classe_sezione=<sezione>` e usa `livello_allerta`/`livello_emergenza` per
materiale, con l'icona che arriva dalla stessa risposta invece che dagli `includes()` sul nome
(righe 395-399).

- [ ] **Step 4: Il `catch` mancante**

`fetchData` (`:115-142`) e `fetchMonthly` (`:145-173`) hanno `try/finally` **senza `catch`**: un
errore di rete diventa una unhandled rejection e l'utente vede «lista vuota» invece di un errore.
Aggiungi il `catch` con `logClient` e uno stato d'errore visibile. Un `catch` che non logga sarebbe
un bug (AGENTS.md regola 6) — ma qui il punto è che **oggi non c'è nemmeno il catch**.

- [ ] **Step 5: Verifica nel browser vero**

```bash
npm run dev
```

Apri `http://localhost:3100/parent/locker`. ⚠️ Il server locale parla col **DB di produzione**:
naviga, **non salvare**. Controlla che la console sia pulita e che la lista renderizzi.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/parent/locker/page.tsx"
git commit -m "$(cat <<'EOF'
Pagina genitore: «La porto», e le soglie vere invece di 5 e 2 cablati

Il bottone diceva «Preso in carico», che suona come una risposta della scuola:
lo dice il genitore, e ora dice «La porto». Le soglie arrivano da
/api/locker/materials invece che dalle due costanti a riga 400, e le icone dalla
stessa risposta invece che da includes() sul nome del materiale.

Aggiunto il catch che mancava su fetchData e fetchMonthly: un errore di rete si
vedeva come «lista vuota».

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: L'interfaccia della maestra

Il ramo `?classe_sezione` della GET esiste da sempre e **non ha mai avuto un consumatore**.

**File:**
- Modifica: `src/app/(dashboard)/teacher/locker/page.tsx`

- [ ] **Step 1: La quarta vista**

Aggiungi `richieste` all'unione delle viste (riga 48) e al toggle (righe 226-242), etichetta
«Da portare». Nel `fetch` chiama
`/api/locker/requests?classe_sezione=${encodeURIComponent(sezione)}` — **senza `&userId=`**: questo
piano in una stesura precedente lo includeva copiandolo dalle chiamate accanto, ma è la vecchia
identità-per-query, chiusa con `ALLOW_HEADER_IDENTITY=false`. `getQuerySchema` non lo dichiara,
quindi zod lo scarterebbe in silenzio: non un errore, solo un parametro che non fa niente e che il
prossimo copierebbe. Con lo stesso
schema di `fetchStock` (righe 112-120) — effetto guardato su `sezione`, `setLoading(false)` su
**tutti** i rami terminali, compreso il `catch`: la pagina ha già due spinner eterni nella sua
storia (F7 del collaudo), non aggiungerne un terzo.

- [ ] **Step 2: L'elenco**

Per ogni richiesta: nome del bambino, materiale, quantità residua, un pallino del colore del livello,
e lo stato. Per le `aperta`, **da quanti giorni** (`creato_il`): è l'informazione che rende utile la
vista — «Marco, pannolini, nessuna risposta da 3 giorni». Per le `presa_in_carico`, «in arrivo».
Un bottone «Arrivato» che manda `PATCH { id, alunno_id, stato: 'evasa' }` per i casi in cui il carico
si registra dopo.

- [ ] **Step 3: Verifica nel browser**

`http://localhost:3100/teacher/locker`. Console pulita, la vista si apre, l'elenco vuoto ha uno stato
vuoto leggibile (in produzione **sarà** vuoto: non ci sono ancora movimenti).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/teacher/locker/page.tsx"
git commit -m "$(cat <<'EOF'
La maestra vede le richieste della sua sezione

Il ramo ?classe_sezione della GET esisteva da sempre e non aveva mai avuto un
consumatore. Quarta vista «Da portare»: chi ha risposto, chi no, e da quanti
giorni — che e' l'informazione che la rende utile.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: La card della home e il codice morto

**File:**
- Modifica: `src/components/features/parent/home/LockerTodayCard.tsx`
- Cancella: `src/components/features/teacher/locker/InventoryCard.tsx`

- [ ] **Step 1: Soglie vere nella card**

Righe 18-19: via `SOGLIA_GIALLA = 5` e `SOGLIA_ROSSA = 2`. Prendile da
`/api/locker/materials`, come nella pagina genitore.

- [ ] **Step 2: Verifica che `InventoryCard` sia davvero morto**

```bash
grep -rn "InventoryCard" src/ __tests__/
```

Atteso: **solo il file stesso**. Se ci sono importatori, fermati.

- [ ] **Step 3: Cancella**

```bash
git rm src/components/features/teacher/locker/InventoryCard.tsx
```

- [ ] **Step 4: Verifica**

```bash
npx tsc --noEmit && npx eslint . --max-warnings 0
```

Atteso: nessun output da entrambi.

- [ ] **Step 5: Commit**

```bash
git add -A src/components/features/
git commit -m "$(cat <<'EOF'
Soglie vere anche nella card della home, e via un componente mai importato

LockerTodayCard mostrava il semaforo su 5 e 2 cablati: ora legge la
configurazione. InventoryCard non era importato da nessuno.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: PRD, gate finale e verifica in produzione

**File:**
- Modifica: `PRD REGISTRO ELETTRONICO.md`

- [ ] **Step 1: Sistema le due righe che si contraddicono**

Riga 23 dice «Schema creato, non ancora popolato», riga 65 dice «✅ Operativo». Allineale: il modulo
è operativo, `armadietto` è popolabile e `locker_config` è **vuota per scelta**. Alla riga 14803
spunta «reminder 07:00».

- [ ] **Step 2: Aggiungi la voce di changelog**

Datata 2026-09-01, sul modello delle altre. Cosa deve dire, oltre al lavoro fatto — sono i **due
debiti dichiarati**, e non annotarli significa perderli:

1. Le colonne relitto di `armadietto` (`nome_oggetto`, `quantita_residua`, `livello_allerta`,
   `livello_emergenza`): scritte a ogni insert, **mai lette**. `nome_oggetto` è `NOT NULL` senza
   default. Vanno tolte, ma è un lavoro a sé su una tabella viva.
2. `funzioni_matrice.<grado>.armadietto` esiste come dato e come pannello di Segreteria, ma
   **nessuna route lo legge**: `requireFunzione` non ha nemmeno un call site di produzione. La
   Segreteria crede di avere un interruttore che non è collegato a niente.

- [ ] **Step 3: Il gate completo**

```bash
npx eslint . --max-warnings 0
```
Atteso: nessun output.

```bash
npx tsc --noEmit
```
Atteso: nessun output.

```bash
npx vitest run
```
Atteso: **tutti verdi tranne** `importi-euro-italiani.test.tsx`, che era già rosso prima di questo
lavoro. Leggi il conteggio finale e confronta il numero di fallimenti con **1**.

```bash
npm run build
```
Atteso: build completata.

- [ ] **Step 4: Commit e push**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "$(cat <<'EOF'
PRD: l'armadietto e' operativo, e due debiti dichiarati

La riga 23 diceva «schema creato, non ancora popolato» e la 65 «Operativo»: si
contraddicevano da settimane. Allineate.

Annotati i due debiti trovati durante il lavoro: le colonne relitto di
`armadietto` (scritte a ogni insert, mai lette) e il fatto che
`funzioni_matrice.<grado>.armadietto` sia un interruttore che la Segreteria vede
nel pannello e che nessuna route legge.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Step 5: Verifica in produzione, in sola lettura**

Dopo il deploy, con `mcp__supabase__execute_sql`:

```sql
SELECT giorno, sum(occorrenze) AS occorrenze
FROM app_log
WHERE ambiente = 'production' AND codice = 'PGRST205'
  AND route IN ('/api/locker/requests', '/api/notifiche/promemoria')
  AND giorno >= current_date - 3
GROUP BY giorno ORDER BY giorno DESC;
```

Atteso: **zero occorrenze** dal giorno del rilascio in poi.

Il mattino dopo, il battito del cron:

```sql
SELECT giorno, messaggio, occorrenze
FROM app_log
WHERE evento = 'cron' AND route = '/api/notifiche/promemoria'
  AND giorno >= current_date - 1
ORDER BY visto_l_ultima DESC LIMIT 5;
```

Atteso: `ok`, **non** più `ok parziale — scansioni saltate (tabella assente): armadietto`.

- [ ] **Step 6: Prova a mano nell'app**

Con un account di prova, non su un bambino vero: registra un consumo che porta un materiale sotto
soglia → la richiesta compare alla maestra; premi «La porto» dal genitore → la maestra la vede presa
in carico; registra un carico → sparisce.

---

## Autorevisione del piano

**Copertura dello spec:** ogni sezione dello spec ha il suo task — tabella (1), motore (2-6),
rotta (8-9), catalog (10), cron (11), scope materials (12), interfaccia (13-15), PRD (16). Le due
voci «cosa non si tocca» diventano debiti scritti nel PRD al Task 16.

**Segnaposto:** nessun «TBD», nessun «gestisci gli errori». I due punti dove il piano dice *cerca*
invece di *scrivi* — lo script delle istantanee (Task 1 Step 7) e `assertSezioneInScope` (Task 12
Step 3) — sono deliberati: il primo dipende da quali script esistono, il secondo da una funzione che
potrebbe già esserci, e inventare un nome sbagliato costerebbe più del `grep`.

**Coerenza dei tipi:** `stockDiAlunno` ritorna `Record<string, number> | null` e il motore ne
controlla il `null` (Task 5); `soglieMateriali` ritorna `Record<string, Soglia>` e il motore itera
su `Object.entries` (Task 5); `riconciliaRichieste` prende `{ alunnoId }` — **attenzione**, il
frammento del Task 7 Step 3 mostra volutamente `{ alunno_id: alunno_id }` con un cast, e lo step dice
di correggerlo in `{ alunnoId: alunno_id }`: è il punto in cui è più facile sbagliare, ed è
segnalato. Gli stati sono `aperta | presa_in_carico | evasa` ovunque — tabella, motore, rotta,
interfaccia — e i vecchi `pending | acknowledged | fulfilled` sopravvivono solo nel Task 13 Step 1,
che è dove si cambiano.
