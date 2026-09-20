// @vitest-environment node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * LE TRE MIGRAZIONI DELLA MARCA «ABBINATO DALLA MACCHINA», ESEGUITE DAVVERO.
 *
 * ─── PERCHÉ SU PGlite E NON LEGGENDO IL FILE ────────────────────────────────
 *
 * Un lock che legge un `.sql` come TESTO sorveglia l'intenzione scritta, ed è
 * quello che fa `__tests__/architecture/annullo-riapre-movimento.test.ts`. Non
 * può però rispondere alla domanda che fa cadere una migrazione al merge: **si
 * applica?** Un `/*` mai chiuso in coda al file, una virgola di troppo nella SET
 * list, un `CASE` senza `END` — tutte cose che a un lettore di stringhe non
 * dicono niente e che a `apply_migration` dicono `42601`, in produzione, quando
 * ormai il merge è passato.
 *
 * PostgreSQL valida la sintassi `plpgsql` al momento della creazione
 * (`check_function_bodies`, attivo di default): eseguire qui i tre file è quindi
 * un collaudo vero della loro compilabilità, non una lettura. I nomi delle
 * TABELLE dentro il corpo non vengono risolti alla creazione — quindi non serve
 * ricostruire lo schema intero — ma i TIPI del blocco `DECLARE` sì, ed è per
 * questo che lo stub qui sotto crea `public.incasso_metodo`.
 *
 * ⚠️ COSA QUESTO FILE **NON** DIMOSTRA, e va detto invece di lasciarlo credere:
 *   · che le funzioni facciano la cosa giusta a runtime. Il corpo non viene
 *     eseguito: le tabelle vere non ci sono;
 *   · che la funzione VIVA nel database sia questa. Quella prova la danno
 *     `apply_migration` e la fotografia di
 *     `__tests__/fixtures/migrazioni-applicate-snapshot.json`.
 *
 * Dati SINTETICI: nessuna riga vera, nessun uuid di sede (il repo è pubblico, e
 * `migrazioni-senza-sede-cablata` vieta di cablarne uno).
 */

const M = join(process.cwd(), 'supabase', 'migrations')
const leggi = (f: string) => readFileSync(join(M, f), 'utf8')

const COLONNA = leggi('20260920124742_riconciliazione_abbinato_auto.sql')
const ANNULLA = leggi('20260920124743_annulla_transazione_azzera_abbinato_auto.sql')
const REGISTRA = leggi('20260920124744_registra_transazione_marca_abbinato_auto.sql')

/**
 * Lo STUB: la sola tabella che le tre migrazioni toccano, più i ruoli e il tipo
 * che i `REVOKE`/`GRANT` e i blocchi `DECLARE` pretendono. Volutamente senza
 * `abbinato_auto_il`: è la colonna che la prima migrazione deve aggiungere, e
 * partire da un database che ce l'ha già renderebbe il primo `it` verde sul
 * nulla.
 */
const STUB = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;
  CREATE TYPE public.incasso_metodo AS ENUM ('contanti','bonifico','pos','altro','storno');
  CREATE TABLE public.riconciliazione_import (id uuid PRIMARY KEY);
  CREATE TABLE public.riconciliazione_movimenti (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id uuid NOT NULL REFERENCES public.riconciliazione_import(id) ON DELETE CASCADE,
    scuola_id uuid,
    data_operazione date,
    importo numeric(10,2),
    causale text,
    stato text NOT NULL DEFAULT 'da_abbinare'
      CHECK (stato IN ('da_abbinare','suggerito','confermato','ignorato')),
    suggerimenti jsonb NOT NULL DEFAULT '[]',
    pagamento_id uuid,
    incasso_id uuid,
    confermato_da uuid,
    confermato_il timestamptz,
    transazione_id uuid
  );
`

let db: PGlite

beforeEach(async () => {
  db = new PGlite()
  await db.exec(STUB)
})

afterEach(async () => {
  await db.close()
})

async function unaRiga<T extends Record<string, unknown>>(sql: string): Promise<T | undefined> {
  const r = await db.query<T>(sql)
  return r.rows[0]
}

describe('migrazione · la colonna `abbinato_auto_il`', () => {
  it('si applica, ed è un `timestamptz` che nasce VUOTO', async () => {
    await db.exec(COLONNA)

    const col = await unaRiga<{ data_type: string; is_nullable: string; column_default: string | null }>(`
      SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'riconciliazione_movimenti'
         AND column_name = 'abbinato_auto_il'`)

    expect(col, 'la colonna non è stata creata').toBeDefined()
    // `timestamptz` e non `boolean`: dice insieme SE e QUANDO. Un booleano, dopo
    // sei mesi, non distingue un abbinamento automatico di ieri da uno dell'anno
    // scorso — ed è la lezione già pagata con `utenti.attivo`.
    expect(col!.data_type).toBe('timestamp with time zone')
    expect(col!.is_nullable).toBe('YES')
    // Nessun DEFAULT: la colonna nasce NULL senza riscrivere la tabella, e senza
    // marcare come «automatiche» le righe che una persona ha confermato a mano.
    expect(col!.column_default).toBeNull()
  })

  it('l’indice è PARZIALE, su `import_id`, e solo dove la marca c’è', async () => {
    await db.exec(COLONNA)

    const idx = await unaRiga<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'riconciliazione_movimenti_abbinato_auto_idx'`,
    )

    // ⚠️ Si guarda `pg_indexes` e non `pg_constraint`: gli indici parziali lì
    // non compaiono, e chi li cerca nel posto sbagliato conclude che non esistono.
    expect(idx, 'nessun indice: l’annullamento in blocco scandirebbe l’estratto conto intero').toBeDefined()
    expect(idx!.indexdef).toContain('(import_id)')
    expect(idx!.indexdef).toContain('WHERE (abbinato_auto_il IS NOT NULL)')
  })

  it('il commento sullo schema spiega il perché a chi lo ispeziona', async () => {
    await db.exec(COLONNA)

    const c = await unaRiga<{ testo: string | null }>(`
      SELECT col_description('public.riconciliazione_movimenti'::regclass, ordinal_position) AS testo
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'riconciliazione_movimenti'
         AND column_name = 'abbinato_auto_il'`)

    expect(c!.testo ?? '', 'colonna senza commento: il perché vive solo nel file').not.toBe('')
    // Le tre decisioni che nessuno deve dover riscoprire leggendo il codice.
    expect(c!.testo!).toContain('NON è un quinto stato')
    expect(c!.testo!).toContain('confermato_da resta valorizzato')
    expect(c!.testo!).toContain('Nessun backfill')
  })

  it('è idempotente: riapplicarla non rompe niente', async () => {
    await db.exec(COLONNA)
    await expect(db.exec(COLONNA)).resolves.toBeDefined()
  })

  it('🔴 lo `stato` non guadagna un quinto valore: il CHECK non si tocca', async () => {
    await db.exec(COLONNA)

    const chk = await unaRiga<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'public.riconciliazione_movimenti'::regclass AND contype = 'c'`)

    // Un quinto stato avrebbe voluto dire rileggere ogni `.eq('stato','confermato')`
    // del repository — il lotto fatture e `intestatario-pagamento` (da cui passa la
    // detrazione 730) compresi. Qui si aggiunge un ATTRIBUTO, non uno stato.
    expect(chk!.def).toContain("'confermato'")
    expect(chk!.def).not.toContain('auto')
  })
})

describe('migrazione · `annulla_transazione_contabile` azzera la marca', () => {
  it('si applica e il corpo VIVO azzera `abbinato_auto_il` insieme agli altri legami morti', async () => {
    await db.exec(COLONNA)
    await db.exec(ANNULLA)

    const def = await unaRiga<{ d: string }>(
      `SELECT pg_get_functiondef('public.annulla_transazione_contabile(jsonb)'::regprocedure) AS d`,
    )
    // Si legge il corpo VIVO (`pg_get_functiondef`), non il file: è l'unico modo
    // di sapere che ciò che il database esegue contiene davvero quella riga.
    expect(def!.d).toMatch(/abbinato_auto_il\s*=\s*NULL/)
    expect(def!.d).toMatch(/transazione_id\s*=\s*NULL/)
    expect(def!.d).toMatch(/confermato_da\s*=\s*NULL/)
    // 🔴 E `pagamento_id` NON si azzera: è la memoria su cui poggia la guardia
    // «un bonifico non si fattura due volte».
    expect(def!.d).not.toMatch(/pagamento_id\s*=\s*NULL/)
  })

  it('🔴 la guardia MORDE: senza la colonna la migrazione si ferma, e dice quale manca', async () => {
    // Controllo positivo. Una guardia mai vista fallire è una decorazione: senza
    // questa prova, un `DO` svuotato lascerebbe creare una funzione che fallisce
    // al PRIMO annullo in produzione, con gli storni già dentro una transazione
    // che poi va in rollback.
    await expect(db.exec(ANNULLA)).rejects.toThrow(/abbinato_auto_il/)
  })

  it('resta chiusa: `service_role` sì, `anon` e `authenticated` no', async () => {
    await db.exec(COLONNA)
    await db.exec(ANNULLA)

    const p = await unaRiga<{ a: boolean; u: boolean; s: boolean }>(`
      SELECT has_function_privilege('anon', 'public.annulla_transazione_contabile(jsonb)', 'EXECUTE') AS a,
             has_function_privilege('authenticated', 'public.annulla_transazione_contabile(jsonb)', 'EXECUTE') AS u,
             has_function_privilege('service_role', 'public.annulla_transazione_contabile(jsonb)', 'EXECUTE') AS s`)

    // `CREATE OR REPLACE` conserva i privilegi esistenti: ometterne la
    // riconcessione lascerebbe in piedi ciò che c'era, che su Supabase include
    // l'EXECUTE concesso ad `anon`/`authenticated` per GRANT esplicito.
    expect([p!.a, p!.u, p!.s]).toEqual([false, false, true])
  })
})

describe('migrazione · `registra_transazione_contabile` scrive la marca nel CAS', () => {
  it('si applica e il corpo VIVO porta il `CASE` dentro l’UPDATE del movimento', async () => {
    await db.exec(COLONNA)
    await db.exec(REGISTRA)

    const def = await unaRiga<{ d: string }>(
      `SELECT pg_get_functiondef('public.registra_transazione_contabile(jsonb)'::regprocedure) AS d`,
    )
    expect(def!.d).toMatch(/abbinato_auto_il\s*=\s*CASE/)
    expect(def!.d).toContain("p->>'abbinato_auto'")
    // Chiave assente ⇒ `false` ⇒ `NULL`: la ricomposizione fatta a mano SPEGNE
    // la marca, che è il verso giusto.
    expect(def!.d).toMatch(/COALESCE\(\(p->>'abbinato_auto'\)::boolean,\s*false\)/)
    // E l'UPDATE sul movimento resta UNO: la marca vive o muore col CAS.
    expect((def!.d.match(/UPDATE public\.riconciliazione_movimenti/g) ?? []).length).toBe(1)
  })

  it('🔴 la guardia MORDE anche qui', async () => {
    await expect(db.exec(REGISTRA)).rejects.toThrow(/abbinato_auto_il/)
  })

  it('le tre migrazioni si applicano NELL’ORDINE del loro nome, una dopo l’altra', async () => {
    // È l'ordine in cui il CLI le applica (alfabetico, cioè per timestamp) ed è
    // l'unica cosa che una migrazione garantisce.
    await db.exec(COLONNA)
    await db.exec(ANNULLA)
    await db.exec(REGISTRA)

    const n = await unaRiga<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public'
         AND p.proname IN ('annulla_transazione_contabile', 'registra_transazione_contabile')`)
    expect(n!.n).toBe(2)
  })
})
