# Il menu della mensa non si salva — `42P10` sulla chiave di conflitto

> **Per chi esegue:** SKILL RICHIESTA: `superpowers:subagent-driven-development` (consigliata) o
> `superpowers:executing-plans`. I passi usano le caselle `- [ ]`.

**Obiettivo:** far sì che «Salva rotazione» e «Aggiungi variazione» del builder menu mensa scrivano
davvero sul database — in tutte e tre le sedi, sia col menu unico sia coi menu multipli — e mettere
un lock che impedisca alla categoria di ricrescere altrove.

**Architettura:** una sola chiave di conflitto per tabella, garantita da **un indice UNIQUE non
parziale** con `NULLS NOT DISTINCT` (PostgreSQL 17.6 in produzione), al posto delle due coppie di
indici **parziali** di oggi. La route smette di scegliere la chiave a runtime, gestisce `42P10` in
modo esplicito e non rimanda più a schermo la prosa inglese di PostgREST.

**Stack:** Next.js (route handler) · supabase-js `.upsert()` → PostgREST → PostgreSQL 17.6 ·
vitest (lock d'architettura) · migrazione via strumento MCP `apply_migration`.

---

## 1. Che cosa è successo, con le prove

**Sintomo.** Il 2026-09-05, dalle 08:58 alle 11:47 (ora locale), la segreteria di **Kidville Cesa**
ha provato **9 volte** a salvare la rotazione del menu. Ogni volta un `alert()` del browser con una
frase inglese che nomina `ON CONFLICT`.

**La riga in `app_log` (produzione), letta il 2026-09-06:**

| campo | valore |
|---|---|
| `route` | `/api/mensa/menu` |
| `codice` | **`42P10`** |
| `messaggio` | `there is no unique or exclusion constraint matching the ON CONFLICT specification` |
| `stato_http` | 400 (PostgREST) → la route lo ritrasmette come **500** |
| `occorrenze` | **9** · prima 2026-09-05 06:58:12Z · ultima 2026-09-05 09:47:01Z |
| `scuola_id` | `<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>` (**Cesa**) |
| `utente_ruolo` | `segreteria` |
| `contesto.payload.body` | `rotazione` di 5 righe (settimana 1, giorni 1-5), **`menu_config_id: null`** |

Accanto, dal client: `PUT /api/mensa/menu → 500`, 5 occorrenze.

**Causa radice.** [`src/app/api/mensa/menu/route.ts:216-220`](src/app/api/mensa/menu/route.ts#L216-L220)
sceglie la chiave di conflitto a runtime:

```ts
const rotConflict = menuConfigId
  ? 'scuola_id,menu_config_id,settimana,giorno_settimana'
  : 'scuola_id,settimana,giorno_settimana'
await supabase.from('mensa_menu_rotazione').upsert(rows, { onConflict: rotConflict })
```

In produzione quelle colonne sono coperte **solo da indici PARZIALI**:

```
uidx_mensa_rot_legacy  (scuola_id, settimana, giorno_settimana)                  WHERE menu_config_id IS NULL
uidx_mensa_rot_menu    (scuola_id, menu_config_id, settimana, giorno_settimana)  WHERE menu_config_id IS NOT NULL
uidx_mensa_ovr_legacy  (scuola_id, data)                                          WHERE menu_config_id IS NULL
uidx_mensa_ovr_menu    (scuola_id, menu_config_id, data)                          WHERE menu_config_id IS NOT NULL
```

**`ON CONFLICT (colonne)` non infersce un indice parziale.** Postgres pretende che
l'istruzione porti un `WHERE` che implichi il predicato dell'indice, e **PostgREST non ha modo di
mandarlo**: il parametro è `on_conflict=<elenco di colonne>` e basta. È la stessa trappola già
pagata sull'Armadietto il 2026-09-01 (`armadietto_richieste`).

**Prova diretta, eseguita sul database di produzione** (`EXPLAIN` non esegue l'INSERT):

```sql
-- ramo legacy  → ERROR 42P10
EXPLAIN INSERT INTO mensa_menu_rotazione (scuola_id, menu_config_id, settimana, giorno_settimana, portate)
VALUES ('<sede Cesa>'::uuid, NULL, 1, 1, '{}'::jsonb)
ON CONFLICT (scuola_id, settimana, giorno_settimana) DO UPDATE SET portate = EXCLUDED.portate;

-- ramo multi-menu → ERROR 42P10
EXPLAIN INSERT INTO mensa_menu_rotazione (…)
VALUES ('<sede Giugliano>'::uuid, '<menu della sede>'::uuid, 1, 1, '{}'::jsonb)
ON CONFLICT (scuola_id, menu_config_id, settimana, giorno_settimana) DO UPDATE SET …;

-- controprova: con il WHERE, l'indice si trova
EXPLAIN INSERT INTO mensa_menu_rotazione (…) VALUES ('<sede Cesa>'::uuid, NULL, 1, 1, '{}'::jsonb)
ON CONFLICT (scuola_id, settimana, giorno_settimana) WHERE menu_config_id IS NULL DO UPDATE SET …;
-- →  Conflict Arbiter Indexes: uidx_mensa_rot_legacy
```

**Quindi non è un difetto di Cesa: sono rotti tutti e quattro i rami**, per tutte le sedi, da
quando esistono gli indici parziali. Cesa se n'è accorta perché è la sede che sta configurando il
menu adesso.

### Perché nessuno se n'era accorto prima

- **`PUT /api/mensa/menu` non ha nessun test.** In `__tests__/` sono coperti solo `GET`
  (`veste-di-famiglia-scope-mensa.test.ts`) e `DELETE` (`mensa-config-scope-sede.test.ts`);
  nessuno spec Playwright tocca il salvataggio del menu. E un test coi mock non avrebbe potuto
  trovarlo: **un mock dice sempre di sì**, il vincolo vive nel database.
- **Le righe che ci sono in produzione non sono passate da qui.** Tutte e 20 le righe di
  rotazione sono di Giugliano, tutte con lo stesso `updated_at` (2026-08-04 19:02:02.354175Z),
  identico al `created_at` del menu «Menu classe TEST (demo App Review)»: sono state inserite da
  uno script per la review dello store. I 5 `override` di Giugliano sono del 2026-07-26, tutti
  con lo stesso istante, **prima** che il vincolo pieno venisse sostituito dagli indici parziali.
  Il menu vero di Giugliano — «menu nido», creato il 2026-07-06 — ha **zero** righe di rotazione:
  non è mai riuscito a salvarne una.

### Quanto è largo il danno, oggi

| | Cesa | Aversa | Giugliano |
|---|---|---|---|
| bambini | **194** | **105** | **310** |
| menu configurati | 0 | 0 | 2 (di cui 1 è il menu TEST della review) |
| righe di rotazione | **0** | **0** | 20, tutte del menu TEST |
| variazioni (`override`) | 0 | 0 | 5, di luglio |

**609 bambini non hanno un menu in app.** E il cron giornaliero
`/api/mensa/allergie-check` incrocia gli allergeni del bambino con quelli **del menu del giorno**:
senza menu confronta contro il vuoto e scrive `alert: 0` ogni mattina. Quello zero non è una prova
di sicurezza alimentare — è l'assenza del confronto. (Vedi
[[silenzio_assente_vs_segnale_falso]] nella memoria: qui il segnale è *assente*, non falso.)

### Lo stesso difetto, dormiente, in un secondo posto

Setaccio completo: tutte le 66 chiamate `.upsert()` di `src/`, ogni coppia (tabella, chiave di
conflitto) confrontata con gli indici UNIQUE reali della produzione. **Su 35 coppie distinte, le
uniche 5 senza un arbitro usabile sono:**

| tabella | chiave inviata | indice sulle stesse colonne | dove |
|---|---|---|---|
| `mensa_menu_rotazione` | `scuola_id,settimana,giorno_settimana` | `uidx_mensa_rot_legacy` **[PARZIALE]** | [menu/route.ts:220](src/app/api/mensa/menu/route.ts#L220) |
| `mensa_menu_rotazione` | `scuola_id,menu_config_id,settimana,giorno_settimana` | `uidx_mensa_rot_menu` **[PARZIALE]** | idem |
| `mensa_menu_override` | `scuola_id,data` | `uidx_mensa_ovr_legacy` **[PARZIALE]** | [menu/route.ts:236](src/app/api/mensa/menu/route.ts#L236) |
| `mensa_menu_override` | `scuola_id,menu_config_id,data` | `uidx_mensa_ovr_menu` **[PARZIALE]** | idem |
| `giudizio_template` | `scuola_id,dimensione,valore` | `uq_giudizio_template_scuola` **[PARZIALE]** | [giudizi/route.ts:165](src/app/api/admin/primaria/giudizi/route.ts#L165) |

L'ultimo è **latente e mai andato a segno**: `giudizio_template` ha 9 righe, tutte globali
(`scuola_id IS NULL`), nessuna per sede. La prima segretaria che salva un frammento di giudizio
della Primaria prende lo stesso `42P10`. Va chiuso adesso, con la stessa forma.

---

## 2. La correzione scelta, e le due che ho scartato

**Scelta — un solo indice UNIQUE non parziale, con `NULLS NOT DISTINCT`.**
Le colonne diventano `(scuola_id, menu_config_id, settimana, giorno_settimana)` sempre, anche
quando `menu_config_id` è `NULL`. `NULLS NOT DISTINCT` (PostgreSQL 15+, in produzione gira **17.6**)
fa sì che due `NULL` siano considerati **uguali**: le righe legacy restano uniche per
(sede, settimana, giorno) esattamente come oggi, e l'arbitro è inferibile da PostgREST.
La garanzia di unicità **non si indebolisce**: l'indice combinato ristretto ai `NULL` è
letteralmente l'indice parziale di oggi.

**Scartata — rendere non parziale l'indice legacy.** `(scuola_id, settimana, giorno_settimana)`
senza predicato vieterebbe lo stesso giorno su due menu diversi della stessa sede: ucciderebbe il
multi-menu.

**Scartata (per ora) — eliminare il `NULL`**: creare un vero «Menu unico» per sede, riportarci le
righe legacy e mettere `menu_config_id NOT NULL`. È il modello più pulito e toglie di mezzo la
semantica dei `NULL`, ma tocca dati di produzione e il concetto di «Menu unico (legacy)» in
interfaccia. Va annotato come debito nel PRD, non fatto qui.

**Sul database E2E della CI** (progetto separato, non migrato): oggi nessuno spec Playwright salva
il menu, quindi non c'è nulla da degradare. Non si aggiunge un ripiego di chiave alla
`chiave-orario.ts` — un ripiego che non scatta mai è un ripiego che nessuno vede rompersi. Si
aggiunge invece un **ramo esplicito su `42P10`**: messaggio leggibile, log con il codice.

---

## 3. File toccati

**Da creare**
- `supabase/migrations/<timestamp>_mensa_menu_chiave_conflitto_unica.sql` — i due indici mensa
- `supabase/migrations/<timestamp>_giudizio_template_chiave_conflitto_unica.sql` — l'indice giudizi
- `src/lib/mensa/chiave-menu.ts` — le due costanti di chiave
- `src/lib/db/vincolo-conflitto.ts` — `vincoloConflittoAssente` in un posto solo (oggi vive dentro
  `src/lib/registro/chiave-orario.ts`, che lo riesporterà)
- `__tests__/api/mensa-menu-put-chiave.test.ts` — che cosa la route MANDA
- `__tests__/architecture/onconflict-arbitro.test.ts` — che cosa il database ACCETTA (lock)
- `__tests__/fixtures/indici-unici-fotografia.mjs` — generatore della fotografia
- `__tests__/fixtures/indici-unici-snapshot.json` — la fotografia versionata

**Da modificare**
- `src/app/api/mensa/menu/route.ts:216-238` — chiave unica, log, messaggi con codice
- `src/components/features/admin/mensa/MenuBuilder.tsx` — i quattro `alert(j.error)` passano da
  `messaggioDaCorpo`, altrimenti il `codice` appena dichiarato non lo legge nessuno e le due voci
  di catalogo restano un debito che *sembra* pagato (rilievo della revisione di qualità)
- `src/lib/registro/chiave-orario.ts` — riesporta il predicato invece di definirlo
- `src/app/api/admin/primaria/giudizi/route.ts:168` — solo il ramo d'errore (la chiave inviata è
  già quella giusta: cambia l'indice sotto)
- `src/lib/ui/esito-fetch.ts` — due codici d'errore nuovi
- `messages/it/shared.json`, `messages/en/shared.json` — le due frasi (**chiavi in coda**, mai
  riordinare il catalogo)
- `docs/superpowers/errori-senza-codice-allowlist.json` — `mensa/menu/route.ts` da 9 a 7
- `__tests__/architecture/errori-con-codice.test.ts` — `MAX_OCCORRENZE` da 1433 a **1431**
  (`MAX_FILE` resta 278: il file non arriva a zero)
- `PRD REGISTRO ELETTRONICO.md` — changelog datato

**Da NON toccare**
- `resolveMenuConfigId`, `resolveMenuRange`, `loadResolveOptions` — la lettura funziona
- Il `GET` e il `DELETE` di `/api/mensa/menu` — hanno già gate di sede e test
- `uidx_mensa_menu_config_sede_nome` e `uidx_mensa_class_assign_sede_classe_dal` — non parziali,
  sani, e sono il presidio multi-sede della migrazione del 2026-07-31
- Le righe già presenti in produzione: **nessun backfill, nessun `DELETE`**

---

## Task 1 — Il branch

**File:** nessuno.

- [ ] **Passo 1: partire da `main` aggiornato**

L'albero è in `HEAD detached` sul merge della PR #119, cioè **dopo un deploy riuscito**: la regola 1
di `AGENTS.md` vuole un branch nuovo.
⚠️ `fix/alto-contrasto-news-e-tinte` è **preso da un altro worktree**: non toccarlo.

```bash
git fetch origin
git checkout -b fix/menu-mensa-onconflict origin/main
git status --short
```

Atteso: `M .claude/settings.json` e nient'altro (la modifica a `settings.json` non è nostra: **non
committarla**).

---

## Task 2 — Il test che dice che cosa la route MANDA

Questo test gira sui mock e non può vedere il database: prova solo che la route invii **una sola**
chiave, sempre completa. È la metà del controllo; l'altra metà è il lock del Task 3.

**File:**
- Creare: `src/lib/mensa/chiave-menu.ts`
- Creare: `__tests__/api/mensa-menu-put-chiave.test.ts`
- Modificare: `src/app/api/mensa/menu/route.ts`

- [ ] **Passo 1: scrivere il test che fallisce**

```ts
// __tests__/api/mensa-menu-put-chiave.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `PUT /api/mensa/menu` — LA CHIAVE DI CONFLITTO È UNA SOLA, E PORTA SEMPRE `menu_config_id`.
 *
 * Il 2026-09-05 la segreteria di Cesa ha provato 9 volte a salvare la rotazione e ha preso 9
 * volte `42P10` («there is no unique or exclusion constraint matching the ON CONFLICT
 * specification»): la route sceglieva la chiave a runtime — con `menu_config_id`, senza —
 * e in produzione ENTRAMBE erano coperte solo da indici PARZIALI, che `ON CONFLICT (colonne)`
 * non sa inferire perché PostgREST non può mandare il `WHERE`.
 *
 * Questo test guarda solo ciò che la route MANDA: coi mock il database dice sempre di sì.
 * Che il database ACCETTI quella chiave lo prova il lock
 * `__tests__/architecture/onconflict-arbitro.test.ts`. Servono tutti e due.
 */

const upsert = vi.fn(() => Promise.resolve({ error: null }))
const from = vi.fn(() => ({ upsert }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({ from }),
}))
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async () => ({ user: { id: 'u1', ruolo: 'segreteria' } }),
  requireUser: async () => ({ user: { id: 'u1', ruolo: 'segreteria' } }),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: '<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>' }),
  scuoleDiUtente: async () => ['<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>'],
}))

import { PUT } from '@/app/api/mensa/menu/route'
import { CHIAVE_ROTAZIONE, CHIAVE_OVERRIDE } from '@/lib/mensa/chiave-menu'

const put = (body: unknown) =>
  new NextRequest('http://localhost/api/mensa/menu', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify(body),
  })

describe('PUT /api/mensa/menu — una sola chiave di conflitto', () => {
  beforeEach(() => { upsert.mockClear(); from.mockClear() })

  it('col menu unico (menu_config_id null) manda comunque la chiave con menu_config_id', async () => {
    const res = await PUT(put({
      scuola_id: '<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>',
      menu_config_id: null,
      rotazione: [{ settimana: 1, giorno_settimana: 1, portate: {} }],
    }))
    expect(res.status).toBe(200)
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: CHIAVE_ROTAZIONE })
  })

  it('con un menu selezionato manda la STESSA chiave', async () => {
    await PUT(put({
      scuola_id: '<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>',
      menu_config_id: '<uuid di un menu della sede>',
      rotazione: [{ settimana: 1, giorno_settimana: 1, portate: {} }],
    }))
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: CHIAVE_ROTAZIONE })
  })

  it('anche le variazioni hanno una chiave sola, con menu_config_id', async () => {
    await PUT(put({
      scuola_id: '<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>',
      menu_config_id: null,
      override: [{ data: '2026-09-10', chiuso: false, portate: {} }],
    }))
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: CHIAVE_OVERRIDE })
  })

  it('le due chiavi contengono menu_config_id (se cade, il ramo legacy è tornato)', () => {
    expect(CHIAVE_ROTAZIONE.split(',')).toContain('menu_config_id')
    expect(CHIAVE_OVERRIDE.split(',')).toContain('menu_config_id')
  })

  it('42P10 non esce a schermo come prosa di PostgREST', async () => {
    upsert.mockResolvedValueOnce({
      error: { code: '42P10', message: 'there is no unique or exclusion constraint matching…' },
    })
    const res = await PUT(put({
      scuola_id: '<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>',
      menu_config_id: null,
      rotazione: [{ settimana: 1, giorno_settimana: 1, portate: {} }],
    }))
    const j = await res.json()
    expect(res.status).toBe(500)
    expect(j.codice).toBe('MENU_NON_SALVATO')
    expect(j.error).not.toMatch(/ON CONFLICT/i)
  })
})
```

- [ ] **Passo 2: eseguirlo e vederlo fallire**

```bash
npx vitest run __tests__/api/mensa-menu-put-chiave.test.ts
```

Atteso: rosso — `Cannot find module '@/lib/mensa/chiave-menu'`.
⚠️ Se esce **verde**, non fidarsi: `vitest -t 'nome-inesistente'` esce **0** anche senza eseguire
nulla. Controllare che il conteggio dei test sia 5.

- [ ] **Passo 3: creare il modulo delle chiavi**

```ts
// src/lib/mensa/chiave-menu.ts
/**
 * Chiavi di conflitto degli upsert del builder menu mensa.
 *
 * PERCHÉ UNA SOLA, E PERCHÉ PORTA SEMPRE `menu_config_id`.
 * Fino al 2026-09-06 la route ne sceglieva una delle due a runtime: con
 * `menu_config_id` quando un menu era selezionato, senza quando si usava il menu
 * unico. In produzione entrambe erano coperte SOLO da indici PARZIALI
 * (`… WHERE menu_config_id IS NULL` e `… WHERE menu_config_id IS NOT NULL`), e
 * `ON CONFLICT (colonne)` non infersce un indice parziale: Postgres pretende un
 * `WHERE` che implichi il predicato, e PostgREST non ha modo di mandarlo — il
 * parametro è `on_conflict=<colonne>` e basta. Risultato: `42P10` su OGNI
 * salvataggio, in ogni sede, in entrambi i rami. Nove volte a Cesa il 2026-09-05,
 * e nessun test poteva vederlo perché il vincolo vive nel database.
 *
 * Ora l'indice è UNO e non è parziale: `(scuola_id, menu_config_id, …)` con
 * `NULLS NOT DISTINCT`, che tratta due `NULL` come uguali. Le righe del menu unico
 * restano uniche per (sede, settimana, giorno) come prima — la garanzia non è
 * cambiata, è cambiato solo il modo di esprimerla.
 *
 * ⚠️ Se qualcuno rimette una chiave senza `menu_config_id`, la trova
 * `__tests__/api/mensa-menu-put-chiave.test.ts`; se qualcuno cambia le colonne
 * senza migrare l'indice, lo trova `__tests__/architecture/onconflict-arbitro.test.ts`.
 */
export const CHIAVE_ROTAZIONE = 'scuola_id,menu_config_id,settimana,giorno_settimana'
export const CHIAVE_OVERRIDE = 'scuola_id,menu_config_id,data'
```

- [ ] **Passo 3-bis: `vincoloConflittoAssente` in un posto solo**

Il predicato su `42P10` esiste già in `src/lib/registro/chiave-orario.ts`. Con la mensa diventano
due strade, col Task 5 diventano tre: **una regola valida per più strade vive in un posto solo.**

Creare `src/lib/db/vincolo-conflitto.ts`:

```ts
/**
 * `42P10` — la chiave di `ON CONFLICT` non corrisponde a nessun indice inferibile.
 *
 * Non è un errore sui DATI: è il database che dice «l'indice che questa route si aspetta qui non
 * c'è». Le due cause sono una migrazione non arrivata (il DB E2E della CI, non migrato) e un
 * indice PARZIALE, che `ON CONFLICT (colonne)` non sa inferire perché PostgREST non può mandare
 * il `WHERE`. La seconda ha tenuto fermo il menu della mensa fino al 2026-09-06.
 *
 * Sta qui, e non accanto a una delle chiavi, perché lo usano il registro (`chiave-orario`), la
 * mensa (`mensa/chiave-menu`) e i giudizi della Primaria.
 */
export function vincoloConflittoAssente(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P10'
}
```

In `src/lib/registro/chiave-orario.ts`, sostituire la definizione con una riesportazione, così i
chiamanti esistenti e `__tests__/architecture/chiave-registro-per-sede.test.ts` (che la importa da
lì) restano com'erano:

```ts
export { vincoloConflittoAssente } from '@/lib/db/vincolo-conflitto'
```

In `src/lib/mensa/chiave-menu.ts` **non** si aggiunge nulla, e la differenza fra i due casi va
scritta nel file: `chiave-orario.ts` riesporta perché ha tre chiamanti storici da non rompere;
`chiave-menu.ts` nasce oggi e non ne ha nessuno, quindi un alias lì creerebbe un terzo percorso
d'importazione per lo stesso predicato il giorno stesso in cui se ne crea il primo — e metterebbe
due responsabilità in un file che ne deve avere una. Chi ha bisogno del predicato lo importa da
`@/lib/db/vincolo-conflitto`.

- [ ] **Passo 4: modificare la route**

In `src/app/api/mensa/menu/route.ts`, sostituire il blocco `216-238` con:

```ts
    if (body.rotazione && body.rotazione.length > 0) {
      const rows = body.rotazione.map((r) => ({
        scuola_id: scuolaId,
        menu_config_id: menuConfigId,
        settimana: r.settimana,
        giorno_settimana: r.giorno_settimana,
        portate: r.portate ?? {},
        ingredienti: r.ingredienti ?? {},
        allergeni: r.allergeni ?? {},
        note: r.note ?? null,
      }))
      const { error } = await supabase
        .from('mensa_menu_rotazione')
        .upsert(rows, { onConflict: CHIAVE_ROTAZIONE })
      if (error) return rifiutoSalvataggio('rotazione', error)
    }

    if (body.override && body.override.length > 0) {
      const rows = body.override.map((o) => ({
        scuola_id: scuolaId,
        menu_config_id: menuConfigId,
        data: o.data,
        chiuso: o.chiuso ?? false,
        portate: o.portate ?? {},
        ingredienti: o.ingredienti ?? {},
        allergeni: o.allergeni ?? {},
        note: o.note ?? null,
      }))
      const { error } = await supabase
        .from('mensa_menu_override')
        .upsert(rows, { onConflict: CHIAVE_OVERRIDE })
      if (error) return rifiutoSalvataggio('override', error)
    }
```

e aggiungere sopra la `PUT`, dopo gli schemi:

```ts
/**
 * Il salvataggio del menu è fallito: si LOGGA il motivo vero (codice compreso) e si
 * risponde con un codice stabile, mai con la prosa di PostgREST.
 *
 * Fino al 2026-09-06 qui c'era `NextResponse.json({ error: error.message }, …)`: la
 * segretaria di Cesa si è vista un `alert()` che diceva «there is no unique or
 * exclusion constraint matching the ON CONFLICT specification». Inglese, e il nome
 * di un meccanismo interno del database, dentro l'interfaccia di chi carica il menu.
 *
 * `42P10` ha un ramo suo perché è l'unico che NON dipende dai dati: dice che il
 * database non ha l'indice che questa route si aspetta — cioè che una migrazione
 * non è arrivata. È l'informazione che serve a chi legge il log, e non serve a chi
 * legge lo schermo.
 */
function rifiutoSalvataggio(cosa: 'rotazione' | 'override', error: { code?: string; message?: string }) {
  const evento = vincoloConflittoAssente(error) ? 'schema' : 'db'
  logErrore({ operazione: `mensa/menu:PUT:${cosa}`, stato: 500, evento }, error)
  return NextResponse.json(
    {
      error: 'Non è stato possibile salvare il menu. Riprova; se l’errore resta, segnalalo.',
      codice: 'MENU_NON_SALVATO',
    },
    { status: 500 },
  )
}
```

e l'import:

```ts
import { CHIAVE_OVERRIDE, CHIAVE_ROTAZIONE } from '@/lib/mensa/chiave-menu'
import { vincoloConflittoAssente } from '@/lib/db/vincolo-conflitto'
```

Due import e non uno: il predicato non passa dal modulo delle chiavi della mensa. Vedi il Passo 3-bis.

- [ ] **Passo 5: dichiarare il codice d'errore**

In `src/lib/ui/esito-fetch.ts`, dentro `CODICI_ERRORE`, in coda:

```ts
    /**
     * 500 — il menu della mensa non è stato scritto. Copre sia il guasto di scrittura sia
     * `42P10` (l'indice che la route usa come arbitro non c'è: migrazione mancante). Il
     * motivo vero resta nel log: fino al 2026-09-06 usciva a schermo, in inglese.
     */
    MENU_NON_SALVATO: 'erroreMenuNonSalvato',
```

In `messages/it/shared.json` e `messages/en/shared.json`, **in coda** (⚠️ il catalogo **non** è
alfabetico: riordinarlo produce migliaia di righe di diff non nostre):

```json
  "erroreMenuNonSalvato": "Non è stato possibile salvare il menu. Riprova; se l’errore resta, segnalalo."
```

```json
  "erroreMenuNonSalvato": "The menu could not be saved. Try again; if the error persists, report it."
```

- [ ] **Passo 6: pagare il debito nell'allowlist**

In `docs/superpowers/errori-senza-codice-allowlist.json`: la voce
`src/app/api/mensa/menu/route.ts` passa da `"n": 9` a `"n": 7`; `totale_occorrenze` da `1433` a
`1431`; `aggiornato` a `2026-09-06`.
In `__tests__/architecture/errori-con-codice.test.ts`: `MAX_OCCORRENZE` da `1433` a `1431`
(**fino alla misura, non «di un po'»**), `MAX_FILE` resta `278`, e una riga di storia sopra le
costanti: `2026-09-06 · −2 (1433 → 1431). mensa/menu:PUT smette di rimandare la prosa di PostgREST.`

- [ ] **Passo 7: i test passano**

```bash
npx vitest run __tests__/api/mensa-menu-put-chiave.test.ts \
               __tests__/architecture/errori-con-codice.test.ts \
               __tests__/architecture/chiave-registro-per-sede.test.ts
```

Atteso: verde, 5 test nel primo file. Il terzo serve perché `chiave-orario.ts` è stato toccato:
importa `vincoloConflittoAssente` da lì e deve continuare a trovarla.

- [ ] **Passo 8: la prova che il test serve**

Rimettere a mano la chiave vecchia (`'scuola_id,settimana,giorno_settimana'`) in `chiave-menu.ts`,
rieseguire il file di test, **vedere il rosso**, poi rimettere il valore giusto con la modifica
inversa. ⚠️ Mai `git checkout -- <file>` per annullare: cancella il lavoro non committato.

- [ ] **Passo 9: commit**

```bash
git add src/lib/mensa/chiave-menu.ts src/lib/db/vincolo-conflitto.ts src/lib/registro/chiave-orario.ts \
        src/app/api/mensa/menu/route.ts src/lib/ui/esito-fetch.ts \
        messages/it/shared.json messages/en/shared.json \
        docs/superpowers/errori-senza-codice-allowlist.json \
        __tests__/api/mensa-menu-put-chiave.test.ts \
        __tests__/architecture/errori-con-codice.test.ts
git commit -m "fix(mensa): una sola chiave di conflitto per il menu, e l'errore non parla più di ON CONFLICT

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Il lock: che cosa il database ACCETTA

Il test del Task 2 gira sui mock e da solo sarebbe verde anche col difetto in atto. Questo lock
confronta ogni `onConflict` di `src/` con una **fotografia versionata degli indici UNIQUE reali**,
e cade se una chiave non ha un arbitro non parziale. Segue la forma già in casa
(`migrazioni-fotografia.mjs`, `rls-fotografia.mjs`, `fk-sede-fotografia.mjs`): `sha256` contro le
modifiche a mano e `generato_alle` contro l'invecchiamento silenzioso.

**File:**
- Creare: `__tests__/fixtures/indici-unici-fotografia.mjs`
- Creare: `__tests__/fixtures/indici-unici-snapshot.json`
- Creare: `__tests__/architecture/onconflict-arbitro.test.ts`

- [ ] **Passo 1: il generatore della fotografia**

Stessa forma esatta di `__tests__/fixtures/migrazioni-fotografia.mjs` (leggerlo prima): `--sql`
stampa la query, il JSON entra da **stdin**, e **lo script non si collega da sé al database** —
`.env.local` punta alla produzione, e uno script che si collega da solo è uno script che prima o
poi ci scrive.

🔴 **IL CODICE QUI SOTTO È LA STESURA INIZIALE, E NON È PIÙ LA FONTE.** La versione viva è il file
committato `__tests__/fixtures/indici-unici-fotografia.mjs`, che rispetto a questa aggiunge almeno
`con_espressioni`, `indisvalid`, le sole colonne chiave (`indnkeyatts`) e — la più importante —
**`ha_colonna_nullable`**. Chi deve rigenerare la fotografia esegue `node
__tests__/fixtures/indici-unici-fotografia.mjs --sql` e usa **quella** query: copiare da qui
produrrebbe una fotografia senza `ha_colonna_nullable`, e il controllo sugli arbitri senza
`NULLS NOT DISTINCT` **si spegnerebbe in silenzio** (rilievo I1-bis della revisione di qualità:
misurato, le orfane passano da 5 a 2 e il file sembra sano).

```js
#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata degli INDICI UNIQUE della produzione:
 *   __tests__/fixtures/indici-unici-snapshot.json
 *
 * Il lock `__tests__/architecture/onconflict-arbitro.test.ts` gira OFFLINE (vitest, in CI, senza
 * le credenziali di produzione — che in CI non ci sono e non devono esserci): la sua unica
 * sorgente di verita' e' questo file. Porta un `sha256` del contenuto normalizzato, cosi' non lo
 * si puo' addomesticare a mano per far tacere il lock, e un `generato_alle` per non restare verde
 * mentre non sa piu' niente.
 *
 * VA RIGENERATA DOPO OGNI `apply_migration` CHE TOCCHI UN INDICE UNIQUE.
 *
 * ─── COME SI RIGENERA ─────────────────────────────────────────────────────────
 * 1. `node __tests__/fixtures/indici-unici-fotografia.mjs --sql`
 * 2. esegui quella query sul DB di produzione (strumento MCP `execute_sql`: e' di SOLA LETTURA,
 *    guarda solo il catalogo di sistema, nemmeno una riga di dati)
 * 3. salva la risposta in un file
 * 4. `node __tests__/fixtures/indici-unici-fotografia.mjs < risposta.json`
 * 5. `npx vitest run __tests__/architecture/onconflict-arbitro.test.ts`
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// `indnullsnotdistinct` non serve al confronto (l'arbitro si infersce dalle sole colonne): sta
// nella fotografia perche' e' la differenza fra «unico davvero» e «unico tranne che sui NULL», ed
// e' l'informazione che serve a chi legge il diff della fotografia dopo una migrazione.
const SQL = `select json_build_object(
  'indici', (
    select coalesce(json_agg(json_build_object(
             'tabella', c.relname::text,
             'indice',  i.relname::text,
             'parziale', (x.indpred is not null),
             'nulls_not_distinct', x.indnullsnotdistinct,
             'colonne', (
               select coalesce(array_agg(a.attname::text order by a.attname::text), '{}')
               from unnest(x.indkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
             )
           ) order by c.relname, i.relname), '[]'::json)
    from pg_index x
    join pg_class c on c.oid = x.indrelid
    join pg_class i on i.oid = x.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and x.indisunique
  )
) as fotografia;`

if (process.argv.includes('--sql')) {
    process.stdout.write(SQL + '\n')
    process.exit(0)
}

/** Estrae l'oggetto fotografia da qualunque involucro l'MCP/psql gli metta intorno. */
function estrai(grezzo) {
    let v = JSON.parse(grezzo)
    if (Array.isArray(v)) v = v[0]
    if (v && typeof v === 'object' && v.fotografia) v = v.fotografia
    if (Array.isArray(v)) v = { indici: v }
    if (!v || !Array.isArray(v.indici)) {
        throw new Error('JSON non riconosciuto: manca `indici`. Rilancia la query di --sql.')
    }
    return v
}

/** Ordine stabile, campi in ordine fisso, niente `undefined`. */
export function normalizza(f) {
    const indici = f.indici
        .map((i) => ({
            tabella: String(i.tabella),
            indice: String(i.indice),
            parziale: !!i.parziale,
            nulls_not_distinct: !!i.nulls_not_distinct,
            colonne: [...(i.colonne ?? [])].map(String).sort(),
        }))
        .sort((a, b) => a.tabella.localeCompare(b.tabella) || a.indice.localeCompare(b.indice))
    return { indici }
}

/** Impronta del solo contenuto: i metadati restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

const ADESSO = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const normalizzata = normalizza(estrai(readFileSync(0, 'utf8')))
const uscita = {
    _come_si_rigenera:
        'node __tests__/fixtures/indici-unici-fotografia.mjs --sql | (esegui su prod) ; node __tests__/fixtures/indici-unici-fotografia.mjs < risposta.json',
    generato_il: ADESSO.slice(0, 10),
    generato_alle: ADESSO,
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'indici-unici-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
const parziali = normalizzata.indici.filter((i) => i.parziale).length
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  indici unique: ${normalizzata.indici.length} · di cui parziali: ${parziali}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
```

- [ ] **Passo 2: il lock**

```ts
// __tests__/architecture/onconflict-arbitro.test.ts
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sogliaFotografia } from './soglia-fotografia'
import { CHIAVE_OVERRIDE, CHIAVE_ROTAZIONE } from '@/lib/mensa/chiave-menu'
import { CHIAVE_REGISTRO, CHIAVE_REGISTRO_LEGACY } from '@/lib/registro/chiave-orario'

/**
 * Lock: ogni chiave di conflitto usata da un `.upsert()` di `src/` deve avere, nel database,
 * un indice UNIQUE **non parziale** sulle stesse colonne.
 *
 * PERCHÉ ESISTE. `ON CONFLICT (colonne)` NON infersce un indice PARZIALE: Postgres pretende un
 * `WHERE` che implichi il predicato dell'indice, e PostgREST non ha modo di mandarlo — il
 * parametro è `on_conflict=<colonne>` e basta. Un upsert contro un indice parziale non è «un po'
 * fragile»: è `42P10` a OGNI chiamata, sempre, e nessun test coi mock lo vede perché il vincolo
 * vive nel database — un mock dice sempre di sì. Il 2026-09-05 la segreteria di Cesa ci ha
 * sbattuto contro nove volte cercando di caricare il menu della mensa; il 2026-09-01 era toccato
 * all'Armadietto. Terza volta che la categoria si ripresenta: da qui in poi la trova questo file,
 * non una persona che sta lavorando.
 *
 * IL LOCK GIRA OFFLINE. La sua unica sorgente di verità è la fotografia versionata, che porta un
 * `sha256` del contenuto (chi la addomestica a mano fa cadere il test) e un `generato_alle` (una
 * fotografia vecchia non sa più niente, e un lock che non sa niente è verde per costruzione).
 * VA RIGENERATA DOPO OGNI `apply_migration` che tocchi un indice UNIQUE:
 * `node __tests__/fixtures/indici-unici-fotografia.mjs --sql` → esegui → `… < risposta.json`.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')
const FOTO_PATH = path.join(RADICE, '__tests__/fixtures/indici-unici-snapshot.json')

/**
 * Le chiavi che vivono in una COSTANTE invece che in una stringa letterale. Vanno risolte
 * importandole, non con una regex: sono le più importanti, perché una costante è esattamente
 * ciò che si scrive quando la chiave è delicata.
 */
const COSTANTI: Record<string, string> = {
  CHIAVE_ROTAZIONE,
  CHIAVE_OVERRIDE,
  CHIAVE_REGISTRO,
  CHIAVE_REGISTRO_LEGACY,
}

/** I nomi di tabella che vivono in una costante di modulo, e il loro valore. */
const TABELLE_COSTANTI: Record<string, string> = {
  TABELLA: 'anagrafica_personale', // e `pratiche_personale`: entrambe le voci sotto
  TABELLA_ANAGRAFICA: 'anagrafica_personale',
}

/**
 * Chiavi che NON devono avere un arbitro in produzione, con la ragione scritta.
 * Una sola voce, e non è un'eccezione di comodo: `CHIAVE_REGISTRO_LEGACY` esiste apposta per il
 * database E2E della CI, che è un progetto separato e non migrato — là il vincolo del registro
 * non ha ancora `scuola_id`. In produzione quella chiave NON deve trovare niente: se un giorno lo
 * trovasse, vorrebbe dire che il vincolo senza sede è tornato, cioè la falla multi-sede del
 * 2026-07-30 (il «2 ANNI» di Aversa e quello di Cesa sulla stessa riga di registro).
 */
const SENZA_ARBITRO_ATTESO = [{ tabella: 'registro_orario', chiave: CHIAVE_REGISTRO_LEGACY }]

type Chiave = { file: string; riga: number; tabella: string; chiave: string }

function filesTs(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...filesTs(full))
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Chiamate `.upsert(` il cui `onConflict` o la cui tabella non si è riusciti a risolvere. */
const nonRisolte: Chiave[] = []

function chiaviDaSrc(): Chiave[] {
  nonRisolte.length = 0
  const out: Chiave[] = []
  for (const f of filesTs(SRC)) {
    const righe = fs.readFileSync(f, 'utf8').split('\n')
    righe.forEach((riga, i) => {
      if (!/\.upsert\(/.test(riga)) return
      // Le righe di COMMENTO che nominano un upsert non sono chiamate.
      if (/^\s*(\*|\/\/)/.test(riga)) return

      let tabella: string | null = null
      for (let j = i; j >= Math.max(0, i - 8); j--) {
        const lett = righe[j].match(/\.from\(\s*['"`]([A-Za-z0-9_]+)['"`]\s*\)/)
        if (lett) { tabella = lett[1]; break }
        const cost = righe[j].match(/\.from\(\s*([A-Za-z0-9_]+)\s*\)/)
        if (cost) { tabella = TABELLE_COSTANTI[cost[1]] ?? `NON_RISOLTA:${cost[1]}`; break }
      }

      let chiave: string | null = null
      for (let j = i; j < Math.min(righe.length, i + 10); j++) {
        const lett = righe[j].match(/onConflict:\s*['"`]([^'"`]+)['"`]/)
        if (lett) { chiave = lett[1]; break }
        const cost = righe[j].match(/onConflict:\s*([A-Za-z0-9_]+)/)
        if (cost) { chiave = COSTANTI[cost[1]] ?? `NON_RISOLTA:${cost[1]}`; break }
      }

      // Nessun `onConflict` ⇒ l'arbitro è la chiave primaria: sempre presente, niente da provare.
      if (chiave === null) return

      const voce: Chiave = { file: path.relative(RADICE, f), riga: i + 1, tabella: tabella ?? '?', chiave }
      if (!tabella || tabella.startsWith('NON_RISOLTA:') || chiave.startsWith('NON_RISOLTA:')) {
        nonRisolte.push(voce)
        return
      }
      out.push(voce)
    })
  }
  return out
}

type Indice = { tabella: string; indice: string; parziale: boolean; nulls_not_distinct: boolean; colonne: string[] }
// `generato_il` NON è opzionale: `sogliaFotografia` lo pretende (vedi ./soglia-fotografia).
type Foto = { generato_il: string; generato_alle?: string | null; sha256: string; indici: Indice[] }

const foto: Foto = JSON.parse(fs.readFileSync(FOTO_PATH, 'utf8'))

const insieme = (cols: string) => [...cols.split(',').map((c) => c.trim())].sort().join(',')

const COME_RIGENERARE =
  'Rigenera la fotografia: `node __tests__/fixtures/indici-unici-fotografia.mjs --sql` → esegui ' +
  'la query sul DB → `node __tests__/fixtures/indici-unici-fotografia.mjs < risposta.json`.'

describe('ogni onConflict ha un arbitro non parziale', () => {
  it('la fotografia non è stata addomesticata a mano (sha256)', () => {
    // Stesse chiavi e stesso ordine di `normalizza()` in indici-unici-fotografia.mjs:
    // l'impronta copre il contenuto, non i metadati (`generato_il`, `generato_alle`, `sha256`).
    const contenuto = { indici: foto.indici }
    const atteso = createHash('sha256').update(JSON.stringify(contenuto)).digest('hex')
    expect(
      foto.sha256,
      `Il contenuto della fotografia non corrisponde al suo sha256: qualcuno l'ha modificata a ` +
      `mano invece di rigenerarla — cioè ha fatto tacere il lock invece di guardare il database. ` +
      COME_RIGENERARE,
    ).toBe(atteso)
  })

  it('la fotografia non è più vecchia dell’ultima migrazione applicata', () => {
    const soglia = sogliaFotografia(foto)
    const posteriori = fs
      .readdirSync(path.join(RADICE, 'supabase/migrations'))
      .filter((f) => f.endsWith('.sql') && f.slice(0, 14) > soglia)
      .filter((f) => /unique\s+index|add\s+constraint[^;]*unique/i.test(
        fs.readFileSync(path.join(RADICE, 'supabase/migrations', f), 'utf8'),
      ))
    expect(
      posteriori,
      `Queste migrazioni toccano un indice UNIQUE e sono POSTERIORI alla fotografia ` +
      `(${foto.generato_alle ?? foto.generato_il}): il lock starebbe confrontando le chiavi di ` +
      `oggi con gli indici di ieri, cioè non starebbe controllando niente. ${COME_RIGENERARE}`,
    ).toEqual([])
  })

  it('ogni upsert di src/ è stato risolto (tabella e chiave)', () => {
    chiaviDaSrc()
    expect(
      nonRisolte,
      `Di questi upsert non si è capito su quale tabella scrivono o con quale chiave. Saltarli ` +
      `renderebbe il lock cieco proprio dove il codice è meno leggibile: aggiungi il nome della ` +
      `costante a COSTANTI o a TABELLE_COSTANTI in questo file.`,
    ).toEqual([])
  })

  it('nessuna chiave di conflitto punta a un indice parziale o inesistente', () => {
    const attese = new Set(SENZA_ARBITRO_ATTESO.map((v) => `${v.tabella}|${insieme(v.chiave)}`))
    const orfane = chiaviDaSrc()
      .filter((k) => !attese.has(`${k.tabella}|${insieme(k.chiave)}`))
      .filter(
        (k) =>
          !foto.indici.some(
            (i) => i.tabella === k.tabella && !i.parziale && [...i.colonne].sort().join(',') === insieme(k.chiave),
          ),
      )
    expect(
      orfane,
      `Queste chiavi di conflitto non hanno, nel database, un indice UNIQUE NON PARZIALE sulle ` +
      `stesse colonne: ogni chiamata torna 42P10 e nessun test coi mock se ne accorge. Il rimedio ` +
      `NON è aggiungere un'eccezione qui: è una migrazione che crei l'indice (se la colonna può ` +
      `essere NULL, con NULLS NOT DISTINCT). ${JSON.stringify(orfane, null, 2)}`,
    ).toEqual([])
  })

  it('le eccezioni dichiarate sono ancora eccezioni (se cade, un vincolo è cambiato)', () => {
    for (const v of SENZA_ARBITRO_ATTESO) {
      const trovato = foto.indici.some(
        (i) => i.tabella === v.tabella && !i.parziale && [...i.colonne].sort().join(',') === insieme(v.chiave),
      )
      expect(
        trovato,
        `\`${v.chiave}\` su ${v.tabella} ADESSO ha un arbitro in produzione. Era il ripiego per il ` +
        `DB E2E non migrato, e in produzione non doveva trovare niente: se lo trova, il vincolo ` +
        `senza sede è tornato — è la falla multi-sede del 2026-07-30.`,
      ).toBe(false)
    }
  })

  it('ci sono chiavi da controllare (se cade, il lock si sta autoingannando)', () => {
    expect(chiaviDaSrc().length).toBeGreaterThan(50)
    expect(foto.indici.length).toBeGreaterThan(100)
  })
})
```

⚠️ Il numero `50` del penultimo test va **misurato** al primo giro (il setaccio del 2026-09-06 ha
trovato 66 chiamate `.upsert()` e 35 coppie distinte) e messo appena sotto la misura, mai «un
numero tondo che passa».

- [ ] **Passo 3: generare la fotografia con lo stato ATTUALE e vedere il lock ROSSO**

Eseguire la query del Passo 1 sul database di produzione (è una **lettura**: non chiede conferma),
salvare la risposta e:

```bash
node __tests__/fixtures/indici-unici-fotografia.mjs < risposta.json
npx vitest run __tests__/architecture/onconflict-arbitro.test.ts
```

Atteso: **ROSSO**, con **4 chiavi orfane in 5 voci** (`registro_orario` compare in due file) — una per `mensa_menu_rotazione`, una per
`mensa_menu_override`, `giudizio_template (scuola_id, dimensione, valore)` e
`registro_orario (scuola_id, classe_sezione, data, ora_lezione)`.

La quarta la fa emergere il criterio stretto di `arbitra()` (rilievo **I1** della revisione di
qualità): un indice UNIQUE con una colonna **nullable** e **senza** `NULLS NOT DISTINCT` non è un
arbitro sano. Non dà `42P10` — dà qualcosa di peggio: due `NULL` sono diversi, quindi la riga non
trova mai sé stessa e ogni salvataggio ne **inserisce una nuova invece di aggiornarla**. Duplicati
silenziosi al posto di un errore rumoroso. `unique_registro_orario` è esattamente così, e il Task 4
lo sostituisce.

⚠️ **Erano «5» in una stesura precedente di questo piano, ed era un numero invecchiato dal Task 2
stesso**: quando l'ho scritto la route mandava due chiavi per tabella (il ramo col
`menu_config_id` e quello senza), quindi le tuple mensa erano quattro. Il Task 2 le ha collassate
in una per tabella, e le attese sono diventate tre. Se ne trovi **meno di tre**, `chiaviDaSrc()`
non sta risolvendo le costanti: sistemarla prima di andare avanti. Se ne trovi **di più**, è una
scoperta: fermarsi e discuterla, non aggiungerla alle eccezioni.

**Una quarta è emersa davvero, il 2026-09-06, ed è di natura diversa**: `daily_routines`
(`src/lib/offline/syncEngine.ts:142`, `onConflict: 'id'`). Quella tabella **non esiste in
produzione** — il diario vero è `eventi_diario`, e `src/app/api/diary/route.ts:15-25` lo documenta
dal 2026-08-04 per la *route*, ma non per il motore di sincronizzazione offline, che ci scrive
lo stesso, prende `PGRST205` e lo inghiotte in `catch { logSync('sync-diario-fallito') }`. Non è
«nessun arbitro»: è «nessuna tabella», e il rimedio non è una migrazione — è che quel codice
smetta di scrivere in un posto che non c'è. Resta **dichiarata come eccezione con la ragione per
esteso** e come debito nel PRD: correggere la sincronizzazione offline del diario è una
funzionalità a sé, e infilarla qui la farebbe uscire senza collaudo.

- [ ] **Passo 4: commit del lock rosso**

```bash
git add __tests__/fixtures/indici-unici-fotografia.mjs __tests__/fixtures/indici-unici-snapshot.json \
        __tests__/architecture/onconflict-arbitro.test.ts
git commit -m "test(lock): un onConflict senza arbitro non parziale è un 42P10 in attesa

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — La migrazione della mensa

**File:** `supabase/migrations/<timestamp>_mensa_menu_chiave_conflitto_unica.sql`

- [ ] **Passo 1: verificare che non ci siano duplicati che impedirebbero l'indice**

```sql
SELECT scuola_id, menu_config_id, settimana, giorno_settimana, count(*)
FROM mensa_menu_rotazione GROUP BY 1,2,3,4 HAVING count(*) > 1;

SELECT scuola_id, menu_config_id, data, count(*)
FROM mensa_menu_override GROUP BY 1,2,3 HAVING count(*) > 1;
```

Atteso: `[]` per entrambe (misurato il 2026-09-06: 20 righe di rotazione e 5 di override, nessun
duplicato). **Se una delle due torna righe, fermarsi**: vanno decise a mano, non risolte da uno
script.

- [ ] **Passo 2: scrivere il file di migrazione**

```sql
-- =============================================================================
-- Menu mensa: UNA chiave di conflitto, e un indice che ON CONFLICT sa inferire
--
-- Fino a oggi l'unicità era espressa da due indici PARZIALI per tabella — uno
-- `WHERE menu_config_id IS NULL` (menu unico), uno `WHERE menu_config_id IS NOT
-- NULL` (multi-menu). La garanzia era giusta; il modo di esprimerla no.
-- `ON CONFLICT (colonne)` NON infersce un indice parziale: Postgres pretende un
-- `WHERE` che implichi il predicato, e PostgREST non ha modo di mandarlo (il
-- parametro è `on_conflict=<colonne>` e basta). Risultato: `42P10` su OGNI
-- salvataggio del builder menu, in ogni sede, in entrambi i rami, da quando gli
-- indici parziali esistono. Nove tentativi a Cesa il 2026-09-05, tutti falliti;
-- il menu vero di Giugliano («menu nido», 2026-07-06) non ha mai avuto una riga.
--
-- LA GARANZIA NON CAMBIA. `NULLS NOT DISTINCT` (PostgreSQL 15+; in produzione
-- gira 17.6) fa considerare uguali due `NULL`: l'indice combinato, ristretto alle
-- righe con `menu_config_id IS NULL`, È l'indice parziale di prima. Nessuna
-- coppia che era vietata diventa lecita, e viceversa.
--
-- SICUREZZA SUI DATI ESISTENTI: verificato prima di applicare — 20 righe in
-- `mensa_menu_rotazione`, 5 in `mensa_menu_override`, ZERO duplicati sulle nuove
-- chiavi. Nessun backfill, nessuna riga toccata.
--
-- Prima si creano i nuovi indici, poi si tolgono i vecchi: in nessun istante la
-- tabella resta senza presidio.
--
-- Il DB E2E della CI è un progetto separato e non migrato: là questi indici non
-- esistono e un upsert col nuovo elenco tornerebbe `42P10`. Oggi nessuno spec
-- Playwright salva il menu, quindi non scatta; se un domani ne nascerà uno, la
-- route risponde con `MENU_NON_SALVATO` e lascia `42P10` nel log — un ripiego di
-- chiave che non scatta mai è un ripiego che nessuno vede rompersi.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_rot_chiave
    ON public.mensa_menu_rotazione (scuola_id, menu_config_id, settimana, giorno_settimana)
    NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mensa_ovr_chiave
    ON public.mensa_menu_override (scuola_id, menu_config_id, data)
    NULLS NOT DISTINCT;

DROP INDEX IF EXISTS public.uidx_mensa_rot_legacy;
DROP INDEX IF EXISTS public.uidx_mensa_rot_menu;
DROP INDEX IF EXISTS public.uidx_mensa_ovr_legacy;
DROP INDEX IF EXISTS public.uidx_mensa_ovr_menu;

-- ─── E la stessa cura al registro, perché è lo stesso difetto ────────────────
-- Trovato dalla revisione di qualità del Task 3 (2026-09-06). `unique_registro_orario`
-- copre `(scuola_id, classe_sezione, data, ora_lezione)` e NON è parziale, quindi
-- `ON CONFLICT` lo infersce e `42P10` non scatta — ma `registro_orario.scuola_id`
-- ammette NULL, e senza `NULLS NOT DISTINCT` due `NULL` sono DIVERSI: una riga di
-- registro senza sede non troverebbe mai sé stessa, e ogni salvataggio ne
-- INSERIREBBE una nuova invece di aggiornarla. Duplicati silenziosi al posto di un
-- errore rumoroso: peggio del difetto che questo lavoro chiude.
-- Oggi non morde — misurato: 14 righe, ZERO con `scuola_id IS NULL` — ed è per
-- questo che si fa adesso, mentre non costa niente, e non il giorno in cui morderà.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_registro_orario_chiave
    ON public.registro_orario (scuola_id, classe_sezione, data, ora_lezione)
    NULLS NOT DISTINCT;

-- 🔴 `ALTER TABLE … DROP CONSTRAINT`, NON `DROP INDEX`. Verificato sul catalogo di
-- produzione il 2026-09-06: `unique_registro_orario` ha `contype = 'u'` — nasce da un
-- `ADD CONSTRAINT`, e l'indice omonimo è quello che il vincolo si porta dietro.
-- Postgres RIFIUTA `DROP INDEX` su un indice che regge un vincolo, e `IF EXISTS` non
-- salva perché l'indice c'è: la migrazione si sarebbe fermata QUI, dopo aver già
-- creato l'indice nuovo e droppato i quattro della mensa. A metà, in produzione.
-- Gli altri sei indici che questa migrazione lascia cadere non sono retti da nessun
-- vincolo (verificato nella stessa query): per loro `DROP INDEX` è giusto.
ALTER TABLE public.registro_orario DROP CONSTRAINT IF EXISTS unique_registro_orario;

COMMENT ON INDEX public.uidx_registro_orario_chiave IS
    '2026-09-06: sostituisce unique_registro_orario. Stesse colonne, più NULLS NOT DISTINCT: scuola_id è nullable, e senza questo una riga senza sede si duplicherebbe a ogni salvataggio invece di aggiornarsi.';

COMMENT ON INDEX public.uidx_mensa_rot_chiave IS
    '2026-09-06: chiave unica di rotazione. NULLS NOT DISTINCT perché il menu unico ha menu_config_id NULL e ON CONFLICT deve poterla inferire (i due indici parziali di prima davano 42P10).';
COMMENT ON INDEX public.uidx_mensa_ovr_chiave IS
    '2026-09-06: chiave unica delle variazioni di menu. Stessa ragione dell''indice di rotazione.';
```

- [ ] **Passo 3: MOSTRARE la migrazione, poi applicarla**

In produzione ci sono dati reali di minori. Prima di applicare, **contare** (è una lettura, non
chiede conferma) e **mostrare l'SQL esatto** che sta per partire:

```sql
SELECT count(*) FROM enrollment_submissions;
```

Poi applicare con lo strumento MCP `apply_migration`, nome
`mensa_menu_chiave_conflitto_unica`, e subito dopo `get_advisors` (atteso: **0 ERROR**).

- [ ] **Passo 4: allineare il nome del file al timestamp che il DB ha scelto**

`apply_migration` sceglie il **proprio** timestamp, che non è quello del file locale: committare il
nome sbagliato arma una riapplicazione.

```sql
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;
```

```bash
git mv supabase/migrations/<nome-locale>.sql supabase/migrations/<version-dal-DB>_mensa_menu_chiave_conflitto_unica.sql
```

- [ ] **Passo 5: la prova che l'arbitro adesso c'è**

```sql
EXPLAIN INSERT INTO public.mensa_menu_rotazione (scuola_id, menu_config_id, settimana, giorno_settimana, portate)
VALUES ('<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>'::uuid, NULL, 1, 1, '{}'::jsonb)
ON CONFLICT (scuola_id, menu_config_id, settimana, giorno_settimana) DO UPDATE SET portate = EXCLUDED.portate;
```

Atteso: `Conflict Arbiter Indexes: uidx_mensa_rot_chiave`. Ripetere per `mensa_menu_override` con
`(scuola_id, menu_config_id, data)`.

- [ ] **Passo 6: la prova che il `DO UPDATE` scatta davvero su una riga con `NULL`**

`EXPLAIN` dice che l'arbitro si trova; non dice che il conflitto viene riconosciuto quando la
colonna è `NULL`. Si prova per davvero, **e si rimette tutto com'era**, su una sede di prova
(`Kidville Demo`, `e2e00000-0000-4000-8000-00000000d000`, che ha 0 righe di menu):

```sql
BEGIN;
INSERT INTO mensa_menu_rotazione (scuola_id, menu_config_id, settimana, giorno_settimana, portate)
VALUES ('e2e00000-0000-4000-8000-00000000d000'::uuid, NULL, 1, 1, '{"primo":"prova A"}'::jsonb)
ON CONFLICT (scuola_id, menu_config_id, settimana, giorno_settimana)
DO UPDATE SET portate = EXCLUDED.portate;

INSERT INTO mensa_menu_rotazione (scuola_id, menu_config_id, settimana, giorno_settimana, portate)
VALUES ('e2e00000-0000-4000-8000-00000000d000'::uuid, NULL, 1, 1, '{"primo":"prova B"}'::jsonb)
ON CONFLICT (scuola_id, menu_config_id, settimana, giorno_settimana)
DO UPDATE SET portate = EXCLUDED.portate;

SELECT count(*) AS righe, max(portate->>'primo') AS primo
FROM mensa_menu_rotazione WHERE scuola_id = 'e2e00000-0000-4000-8000-00000000d000';
ROLLBACK;
```

Atteso: **`righe = 1`, `primo = 'prova B'`** — cioè il secondo INSERT ha aggiornato il primo invece
di duplicarlo. Se tornasse `righe = 2`, `NULLS NOT DISTINCT` non sta facendo il suo mestiere e
**questo piano va fermato**: si passa all'alternativa scartata (menu «unico» reale, `NOT NULL`).
Il `ROLLBACK` è parte della prova, non un ripensamento: verificare col `SELECT` finale che la sede
Demo sia tornata a 0 righe.

- [ ] **Passo 7: la route che fabbricò gli indici parziali smette di descrivere uno schema morto**

Rilievo della revisione di qualità del 2026-09-06.
`src/app/api/admin/apply-mensa-multi-menu-migration/route.ts:53-82` è la route che **creò** i
quattro indici parziali. Non è un rischio operativo — `sealDangerous` risponde **404** quando
`NODE_ENV !== 'test'`, quindi in produzione è morta — ma appena questo Task 4 li droppa, quel file
resta **l'unica descrizione dello schema mensa presente nel repository, e descrive uno schema che
non esiste più**. Un file così non è documentazione: è una trappola per chi lo leggerà fra sei mesi.

Aggiungere in testa a `steps_sql`, sopra la voce `DROP old unique constraint on rotazione`:

```ts
// ⚠️ QUESTO ELENCO È STORIA, NON LO SCHEMA DI OGGI (2026-09-06).
// I quattro indici PARZIALI creati qui sotto (`uidx_mensa_rot_legacy`, `uidx_mensa_rot_menu`,
// `uidx_mensa_ovr_legacy`, `uidx_mensa_ovr_menu`) NON ESISTONO PIÙ: li ha sostituiti un solo
// indice non parziale per tabella, con `NULLS NOT DISTINCT`, perché `ON CONFLICT (colonne)` non
// sa inferire un indice parziale e il salvataggio del menu falliva con `42P10` in ogni sede.
// Vedi le migrazioni `*_mensa_menu_chiave_conflitto_unica.sql`. Questa route risponde 404 fuori
// dai test (`sealDangerous`): rieseguirla ricreerebbe indici che non vogliamo più.
```

- [ ] **Passo 8: commit**

```bash
git add supabase/migrations/ src/app/api/admin/apply-mensa-multi-menu-migration/route.ts
git commit -m "feat(db): un solo indice UNIQUE per la chiave del menu mensa (NULLS NOT DISTINCT)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — La migrazione dei giudizi della Primaria

Stesso difetto, stesso rimedio, mai andato a segno perché quel ramo non è ancora in uso: 9 righe in
`giudizio_template`, tutte globali.

**File:** `supabase/migrations/<timestamp>_giudizio_template_chiave_conflitto_unica.sql`

- [ ] **Passo 1: verificare l'assenza di duplicati**

```sql
SELECT scuola_id, dimensione, valore, count(*)
FROM giudizio_template GROUP BY 1,2,3 HAVING count(*) > 1;
```

Atteso: `[]`.

- [ ] **Passo 2: scrivere la migrazione**

```sql
-- =============================================================================
-- giudizio_template: la stessa trappola della mensa, ancora dormiente
--
-- `POST /api/admin/primaria/giudizi` (action `template`) fa
-- `upsert(…, { onConflict: 'scuola_id,dimensione,valore' })`, ma quelle colonne
-- erano coperte solo da `uq_giudizio_template_scuola … WHERE scuola_id IS NOT
-- NULL`: indice PARZIALE, quindi `ON CONFLICT (colonne)` non lo infersce e la
-- chiamata torna `42P10`. Non è mai stato notato perché la tabella ha 9 righe,
-- tutte GLOBALI (`scuola_id IS NULL`): nessuno ha ancora salvato un frammento di
-- giudizio per una sede. La prima che ci prova prende l'errore della mensa.
--
-- `NULLS NOT DISTINCT` unifica i due indici in uno: per le righe globali
-- (`scuola_id` NULL) l'unicità su (dimensione, valore) resta esattamente quella
-- che garantiva `uq_giudizio_template_global`.
--
-- SICUREZZA SUI DATI ESISTENTI: 9 righe, zero duplicati sulla nuova chiave.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_giudizio_template_chiave
    ON public.giudizio_template (scuola_id, dimensione, valore)
    NULLS NOT DISTINCT;

DROP INDEX IF EXISTS public.uq_giudizio_template_scuola;
DROP INDEX IF EXISTS public.uq_giudizio_template_global;

COMMENT ON INDEX public.uq_giudizio_template_chiave IS
    '2026-09-06: chiave unica dei frammenti di giudizio. NULLS NOT DISTINCT perché i template globali hanno scuola_id NULL e ON CONFLICT deve poterli inferire.';
```

- [ ] **Passo 3: applicare, `get_advisors`, rinominare il file col `version` del DB**

Stessa procedura del Task 4, passi 3 e 4.

- [ ] **Passo 4: verificare l'arbitro**

```sql
EXPLAIN INSERT INTO public.giudizio_template (scuola_id, dimensione, valore, frammento)
VALUES ('<uuid della sede, da `SELECT id FROM schools WHERE nome = 'Kidville Cesa'`>'::uuid, 'x', 'y', 'z')
ON CONFLICT (scuola_id, dimensione, valore) DO UPDATE SET frammento = EXCLUDED.frammento;
```

Atteso: `Conflict Arbiter Indexes: uq_giudizio_template_chiave`.

- [ ] **Passo 5: togliere anche lì la prosa di PostgREST**

In `src/app/api/admin/primaria/giudizi/route.ts`, nel ramo `action === 'template'`, sostituire

```ts
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
```

con

```ts
      if (error) {
        // PostgREST non lancia: senza questo ramo il motivo vero non arriverebbe mai nel log.
        // `42P10` qui significa che l'indice arbitro non c'è, cioè che una migrazione non è
        // arrivata: è un'informazione per chi legge i log, non per chi legge lo schermo — fino
        // al 2026-09-06 usciva invece a schermo, in inglese e col nome di un meccanismo interno.
        logErrore(
          { operazione: 'admin/primaria/giudizi:POST:template', stato: 500, evento: vincoloConflittoAssente(error) ? 'schema' : 'db' },
          error,
        )
        return NextResponse.json(
          { error: 'Non è stato possibile salvare il frammento di giudizio. Riprova; se l’errore resta, segnalalo.', codice: 'GIUDIZIO_NON_SALVATO' },
          { status: 500 },
        )
      }
```

con l'import `import { vincoloConflittoAssente } from '@/lib/db/vincolo-conflitto'`.

⚠️ Lo spostamento in un posto solo **è già stato fatto al Task 2**: il predicato vive in
`src/lib/db/vincolo-conflitto.ts` e si importa **da lì**, non da un modulo di chiave. Questo passo
diceva `@/lib/mensa/chiave-menu`, ed era un errore di questo piano: avrebbe fatto importare la
route dei giudizi della **Primaria** da `lib/mensa`, cioè avrebbe legato due aree che non
c'entrano niente l'una con l'altra. `chiave-orario.ts` conserva una riesportazione perché ha tre
chiamanti storici da non rompere; `chiave-menu.ts` **non** ce l'ha, di proposito — un alias nato
lo stesso giorno del modulo è solo un secondo modo di sbagliare strada.

Dichiarare `GIUDIZIO_NON_SALVATO: 'erroreGiudizioNonSalvato'` in `CODICI_ERRORE` e le due frasi in
coda ai cataloghi, come al Task 2 Passo 5. Poi abbassare la voce
`src/app/api/admin/primaria/giudizi/route.ts` nell'allowlist di **1** (e `totale_occorrenze` e
`MAX_OCCORRENZE` di 1, da 1431 a **1430**).

Le altre `error.message` dello stesso file (rami `scala` e `scala-rename`) restano come sono:
sono debito già in allowlist, e convertirle qui allargherebbe lo scopo di questo lavoro.

- [ ] **Passo 6: commit**

```bash
git add supabase/migrations/ src/app/api/admin/primaria/giudizi/route.ts
git commit -m "fix(primaria): il template di giudizio per sede aveva lo stesso 42P10 della mensa

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Rigenerare la fotografia e vedere il lock diventare verde

- [ ] **Passo 1: rieseguire la query del Task 3 Passo 1 e rigenerare**

```bash
node __tests__/fixtures/indici-unici-fotografia.mjs < risposta.json
npx vitest run __tests__/architecture/onconflict-arbitro.test.ts
```

Atteso: **verde**, zero chiavi orfane.

- [ ] **Passo 2: la prova che il lock sa ancora cadere**

Cambiare a mano una colonna di `CHIAVE_ROTAZIONE` in `src/lib/mensa/chiave-menu.ts`, rieseguire il
lock, **vederlo rosso**, rimettere il valore giusto con la modifica inversa. Un lock mai visto
fallire non è un lock.

- [ ] **Passo 3: rigenerare anche `migrazioni-applicate-snapshot.json`**

Le due migrazioni nuove rendono rosso `__tests__/architecture/migrazioni-complete.test.ts` finché
la sua fotografia non viene rifatta: è voluto. Procedura in testa a
`__tests__/fixtures/migrazioni-fotografia.mjs`.

- [ ] **Passo 4: commit**

```bash
git add __tests__/fixtures/
git commit -m "test(lock): fotografie rigenerate dopo le due migrazioni

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — PRD

**File:** `PRD REGISTRO ELETTRONICO.md`

- [ ] **Passo 1: voce di changelog datata**

Aggiungere in cima al changelog, nella forma delle voci esistenti, una voce `2026-09-06` che dica:
che cosa era rotto (il salvataggio del menu, in tutte le sedi, dal giorno degli indici parziali),
come lo si è visto (9 `42P10` di Cesa in `app_log`), che cosa è cambiato (una chiave, un indice
`NULLS NOT DISTINCT`, il lock nuovo), e i **quattro debiti dichiarati**:

1. `PUT /api/mensa/menu` scrive rotazione e variazioni in **due istruzioni senza transazione**: se
   la prima riesce e la seconda no, resta un salvataggio a metà con una risposta 500.
2. Il «menu unico» resta un `menu_config_id NULL`. Il modello pulito — un vero menu «Standard» per
   sede e `NOT NULL` sulla colonna — è rimandato: tocca dati di produzione e l'interfaccia.
3. **Il `PUT` non verifica la sede del `menu_config_id` che riceve** (rilievo della revisione di
   qualità del 2026-09-06, difetto **preesistente**, non introdotto da questo lavoro). Il `DELETE`
   passa da `assertConfigMensaInScope`; il `PUT` no: la sede delle righe è quella dell'utente
   (`resolveScuolaScrittura`, e va bene), ma il `menu_config_id` arriva dal client senza che
   nessuno controlli che appartenga a quella sede. Con l'uuid del menu di un altro plesso in mano,
   chi lavora nella sede A scrive righe `scuola_id = A` appese a un menu di B. Non è una fuga di
   dati — in lettura quelle righe non le trova nessuno, perché `resolveMenuConfigId` per la sede A
   non restituirà mai un menu di B. È peggio in un modo più silenzioso: la `DELETE` di
   `mensa/menu-config` conta le rotazioni collegate **filtrando per la propria sede**, quindi non
   le vede e lascia cancellare il menu di B; la FK è `ON DELETE SET NULL`, e quelle righe
   diventano di colpo righe del **menu unico della sede A** — cioè compaiono in tavola.
   Chiuderlo è un lavoro a sé: il `PUT` deve passare da `assertConfigMensaInScope` sul
   `menu_config_id`, con un test che lo provi.
4. **La sincronizzazione offline del diario scrive su una tabella che non esiste** (trovata dal
   lock del Task 3 il 2026-09-06). `src/lib/offline/syncEngine.ts:142` fa
   `upsert(payload, { onConflict: 'id' })` su **`daily_routines`**, che in produzione non c'è: il
   diario vero è `eventi_diario`. La route `/api/diary` lo sa e lo dichiara dal 2026-08-04
   (`src/app/api/diary/route.ts:15-25`, degrada in 503 dichiarato); il **motore offline** no —
   prende `PGRST205` e lo inghiotte in `catch { logSync('sync-diario-fallito') }`. Significa che
   ciò che una maestra scrive nel diario **mentre è senza rete non arriva mai**, e a schermo non
   se ne accorge nessuno. È dichiarato come eccezione nel lock `onconflict-arbitro`, con la
   ragione scritta e l'istruzione di toglierla quando il ramo sarà corretto — **non** quando la
   tabella sarà creata.

- [ ] **Passo 2: commit**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "docs(prd): il menu mensa non si salvava, e perché

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Gate, rilascio, e la verifica che conta

- [ ] **Passo 1: il gate completo**

```bash
npx eslint . --max-warnings 0
npx tsc --noEmit
npx vitest run
npm run build
```

Tutti e quattro verdi. ⚠️ In zsh `$?` dopo una pipe è l'uscita dell'**ultimo anello**: non
verificare con `comando | tail; echo $?`. E `--reporter=basic` non esiste più in vitest 4.

- [ ] **Passo 2: PR**

```bash
git push -u origin fix/menu-mensa-onconflict
gh pr create --title "Il menu della mensa non si salvava in nessuna sede" --body "…"
```

Nel corpo: il `42P10`, le 9 occorrenze di Cesa, la spiegazione dell'indice parziale, le due
migrazioni **già applicate** in produzione, il lock nuovo. Attendere **entrambi** i check
(`Lint · Typecheck · Unit` ed `E2E (Playwright)`): «CI verde» vale solo contando tutti i job, e un
job E2E «success» può contenere fallimenti ripescati dai `retries` — guardare i `retry #`.

- [ ] **Passo 3: merge e deploy**

Merge in `main`, deploy Vercel `READY` su `app.kidville.it`. Poi annullare la run `migrate.yml` che
ogni merge arma (le migrazioni sono già applicate via MCP).

- [ ] **Passo 4: la verifica in produzione — e non è il deploy**

Non basta che il deploy sia `READY`. Il difetto si chiude quando **una riga di menu di Cesa esiste**:

```sql
SELECT s.nome, count(r.id) AS righe_rotazione
FROM schools s LEFT JOIN mensa_menu_rotazione r ON r.scuola_id = s.id
GROUP BY s.nome ORDER BY s.nome;

SELECT route, codice, occorrenze, visto_l_ultima
FROM app_log WHERE codice = '42P10' ORDER BY visto_l_ultima DESC LIMIT 5;
```

Atteso: Cesa **> 0** dopo che la segreteria ha rifatto il salvataggio, e **nessun `42P10` nuovo**
dopo l'ora del deploy (i 9 del 2026-09-05 restano: sono storia, non un guasto in corso).

- [ ] **Passo 5: dire alla segreteria di Cesa di rifare il caricamento**

Il salvataggio non ha mai scritto niente: **il menu di Cesa è ancora tutto da inserire**, non c'è
niente da correggere o ripulire. Va rifatto da capo, settimana per settimana. Fino a quel momento
i 194 bambini di Cesa non hanno menu in app — e il controllo allergeni delle 07:00 continua a
scrivere `alert: 0` perché non ha nulla con cui confrontare.

- [ ] **Passo 6: pulizia dei branch**

A deploy riuscito, eliminare `fix/menu-mensa-onconflict` in locale e su origin. ⚠️
`fix/alto-contrasto-news-e-tinte` è di un altro worktree: **non toccarlo**.

---

## Cosa questo piano NON fa, e va detto

- **Non riscrive il menu di Giugliano.** Le 20 righe del menu «TEST (demo App Review)» restano, e
  «menu nido» resta vuoto: sarà la segreteria a decidere.
- **Non rende atomico il `PUT`.** Debito dichiarato nel PRD.
- **Non mette il gate di sede sul `menu_config_id` del `PUT`.** Difetto preesistente trovato dalla
  revisione di qualità del 2026-09-06: il `DELETE` passa da `assertConfigMensaInScope`, il `PUT`
  no. Debito n. 3 nel PRD, con la conseguenza per esteso — non è una fuga di dati, è una via per
  cui le righe di un plesso finiscono in tavola in un altro. Chiuderlo è un lavoro a sé.
- **Non toglie il `NULL` da `menu_config_id`.** Debito dichiarato nel PRD.
- **Non copre il salvataggio del menu con un test E2E.** Il DB E2E è un progetto separato e non
  migrato: uno spec Playwright che salvasse il menu prenderebbe `42P10` là dentro. Prima va migrato
  quel database, e non è questo il lavoro.
- **Non verifica su un dispositivo.** Il builder menu è una schermata da scrivania.
