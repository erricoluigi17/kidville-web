// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * INCASSO DI UNA VOCE · LA MIGRAZIONE PROVATA SU UN POSTGRES VERO.
 *
 * Fino al 2026-10-10 `POST /api/pagamenti/incassi` decideva il residuo in
 * JavaScript e scriveva incasso, credito, abbuono e audit con chiamate separate:
 * due operatori sulla stessa voce incassavano entrambi, oltre il dovuto. Ora tutto
 * sta in `registra_incasso_voce`, che blocca la riga del pagamento.
 *
 * PGlite ha UNA connessione sola: la concorrenza vera (due sessioni, la seconda che
 * aspetta il blocco) qui non si vede. Questo file prova ciò che il blocco rende
 * vero DOPO l'attesa — il secondo incasso legge il residuo aggiornato e viene
 * rifiutato — e il resto della logica. La presenza del `FOR UPDATE` la sorveglia
 * il lock `incassi-rpc-bloccata`; la prova con due sessioni vere sta nel PR.
 *
 * Le funzioni di ricalcolo sono LETTE dalla loro migrazione, non riscritte qui.
 * Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_registra_incasso_voce_bloccata.sql')

/** `CREATE OR REPLACE FUNCTION public.<nome>(…) … END $$;` tagliato dal file. */
function funzione(testo: string, nome: string): string {
  const inizio = testo.indexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`)
  const fine = testo.indexOf('END $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error(`corpo di ${nome} non trovato`)
  return testo.slice(inizio, fine + 'END $$;'.length)
}

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const OPERATORE = 'b0000000-0000-4000-8000-000000000001'
const GENITORE = 'c0000000-0000-4000-8000-000000000001'

let db: PGlite

async function schema(): Promise<void> {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TYPE public.incasso_metodo AS ENUM
      ('contanti','bonifico','pos','assegno','altro','credito_famiglia','storno','rettifica');

    CREATE TABLE public.parents (id uuid PRIMARY KEY);
    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id uuid,
      importo numeric(10,2) NOT NULL,
      sconto numeric(10,2) NOT NULL DEFAULT 0,
      sconto_motivo text,
      importo_pagato numeric(10,2) NOT NULL DEFAULT 0,
      parent_payment_id uuid REFERENCES public.pagamenti(id),
      scadenza date,
      stato varchar DEFAULT 'da_pagare',
      data_incasso timestamptz,
      aggiornato_il timestamptz DEFAULT now()
    );
    CREATE TABLE public.pagamenti_quote (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
      adult_id uuid NOT NULL,
      importo numeric(10,2) NOT NULL,
      etichetta text,
      UNIQUE (pagamento_id, adult_id)
    );
    CREATE TABLE public.incassi (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
      importo numeric(10,2) NOT NULL CHECK (importo <> 0),
      data_incasso date NOT NULL DEFAULT CURRENT_DATE,
      metodo public.incasso_metodo NOT NULL DEFAULT 'contanti',
      note text,
      quota_id uuid REFERENCES public.pagamenti_quote(id) ON DELETE SET NULL,
      registrato_da uuid,
      creato_il timestamptz DEFAULT now(),
      storno_di uuid, stornato_il timestamptz, storno_motivo text, transazione_id uuid
    );
    CREATE TABLE public.crediti_famiglia (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id uuid NOT NULL REFERENCES public.parents(id),
      scuola_id uuid NOT NULL,
      causale text NOT NULL,
      importo numeric(10,2) NOT NULL CHECK (importo <> 0),
      saldo_dopo numeric(10,2) NOT NULL CHECK (saldo_dopo >= 0),
      transazione_id uuid, incasso_id uuid, creato_da uuid,
      creato_il timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.registro_modifiche (
      id bigserial PRIMARY KEY,
      utente_id uuid, azione text NOT NULL, tabella_interessata varchar, record_id uuid,
      vecchio_valore jsonb, nuovo_valore jsonb, creato_il timestamptz DEFAULT now()
    );

    CREATE FUNCTION public.trg_incassi_ricalcola() RETURNS trigger
      LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
    BEGIN
      PERFORM public.ricalcola_stato_pagamento(COALESCE(NEW.pagamento_id, OLD.pagamento_id));
      RETURN NULL;
    END $$;
    CREATE TRIGGER incassi_ricalcola AFTER INSERT OR DELETE OR UPDATE ON public.incassi
      FOR EACH ROW EXECUTE FUNCTION public.trg_incassi_ricalcola();
  `)
  const v2 = migrazione('_contabilita_v2_regole.sql')
  await db.exec(funzione(v2, 'ricalcola_stato_padre'))
  await db.exec(funzione(v2, 'ricalcola_stato_pagamento'))
  await db.exec(NUOVA)
}

type Esito = Record<string, unknown> & { esito: string }

async function incassa(args: {
  pagamento: string
  importo: number
  metodo?: string | null
  quota?: string | null
  eccedenzaA?: string | null
  abbuono?: string | null
}): Promise<Esito> {
  const r = await db.query<{ r: Esito }>(
    `SELECT public.registra_incasso_voce(
       p_pagamento_id => $1, p_importo => $2, p_registrato_da => $3,
       p_metodo => $4, p_quota_id => $5, p_eccedenza_parent_id => $6, p_abbuono_motivo => $7) AS r`,
    [args.pagamento, args.importo, OPERATORE, args.metodo ?? null, args.quota ?? null, args.eccedenzaA ?? null, args.abbuono ?? null],
  )
  return r.rows[0].r
}

async function voce(importo: number, opz: { sconto?: number; padre?: string; sede?: string | null } = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.pagamenti (scuola_id, importo, sconto, parent_payment_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [opz.sede === undefined ? SEDE : opz.sede, importo, opz.sconto ?? 0, opz.padre ?? null],
  )
  return r.rows[0].id
}

async function stato(id: string) {
  const r = await db.query<{ importo_pagato: string; stato: string; sconto: string; n: number; somma: string }>(
    `SELECT p.importo_pagato, p.stato, p.sconto,
            (SELECT count(*)::int FROM public.incassi i WHERE i.pagamento_id = p.id) AS n,
            (SELECT COALESCE(sum(i.importo), 0) FROM public.incassi i WHERE i.pagamento_id = p.id) AS somma
       FROM public.pagamenti p WHERE p.id = $1`,
    [id],
  )
  return r.rows[0]
}

beforeAll(async () => {
  db = new PGlite()
  await schema()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.registro_modifiche, public.crediti_famiglia, public.incassi,
             public.pagamenti_quote, public.pagamenti, public.parents CASCADE;
  `)
  await db.query('INSERT INTO public.parents (id) VALUES ($1)', [GENITORE])
})

describe('registra_incasso_voce · il residuo deciso dal database', () => {
  it('la migrazione si riapplica senza errori (CREATE OR REPLACE)', async () => {
    await db.exec(NUOVA)
  })

  it('incasso dentro il residuo → ok, importo_pagato aggiornato dal trigger, audit scritto', async () => {
    const p = await voce(100)
    const e = await incassa({ pagamento: p, importo: 60 })
    expect(e.esito).toBe('ok')
    expect(Number(e.importo_incassato)).toBe(60)
    expect(Number(e.residuo_prima)).toBe(100)
    const s = await stato(p)
    expect(Number(s.importo_pagato)).toBe(60)
    expect(s.stato).toBe('parziale')
    const audit = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.registro_modifiche WHERE azione = 'registra_incasso'`,
    )
    expect(audit.rows[0].n).toBe(1)
  })

  it('🔴 il SECONDO operatore: dopo un incasso di 100 su 100, un altro 100 è rifiutato e non scrive niente', async () => {
    // È ciò che il blocco garantisce: chi aspetta legge il residuo del primo.
    const p = await voce(100)
    expect((await incassa({ pagamento: p, importo: 100 })).esito).toBe('ok')
    const secondo = await incassa({ pagamento: p, importo: 100 })
    expect(secondo.esito).toBe('eccedenza')
    expect(Number(secondo.eccedenza)).toBe(100)
    const s = await stato(p)
    expect(s.n).toBe(1)
    expect(Number(s.somma)).toBe(100)
    expect(s.stato).toBe('pagato')
  })

  it('il residuo tiene conto dello sconto', async () => {
    const p = await voce(100, { sconto: 30 })
    const e = await incassa({ pagamento: p, importo: 80 })
    expect(e.esito).toBe('eccedenza')
    expect(Number(e.eccedenza)).toBe(10)
    expect((await stato(p)).n).toBe(0)
  })

  it('una voce già pagata SENZA incassi (importo_pagato storico) non si reincassa', async () => {
    // In produzione 5 voci sono in questo stato (misura del 10/10): il residuo si
    // legge da importo_pagato, non dalla somma degli incassi.
    const p = await voce(150)
    await db.query(`UPDATE public.pagamenti SET importo_pagato = 150, stato = 'pagato' WHERE id = $1`, [p])
    const e = await incassa({ pagamento: p, importo: 150 })
    expect(e.esito).toBe('eccedenza')
    expect((await stato(p)).n).toBe(0)
  })

  it('eccedenza confermata → incassa il residuo e accredita il resto, nella stessa transazione', async () => {
    const p = await voce(100)
    const e = await incassa({ pagamento: p, importo: 150, eccedenzaA: GENITORE })
    expect(e.esito).toBe('ok')
    expect(Number(e.importo_incassato)).toBe(100)
    expect(Number(e.eccedenza)).toBe(50)
    const cred = e.credito as { saldo_dopo: string }
    expect(Number(cred.saldo_dopo)).toBe(50)
    const righe = await db.query<{ importo: string; saldo_dopo: string; incasso_id: string | null }>(
      'SELECT importo, saldo_dopo, incasso_id FROM public.crediti_famiglia',
    )
    expect(righe.rows).toHaveLength(1)
    expect(righe.rows[0].incasso_id).toBe((e.incasso as { id: string }).id)
    // un secondo accredito parte dal saldo del primo
    const p2 = await voce(10)
    const e2 = await incassa({ pagamento: p2, importo: 30, eccedenzaA: GENITORE })
    expect(Number((e2.credito as { saldo_dopo: string }).saldo_dopo)).toBe(70)
  })

  it('residuo zero ed eccedenza confermata → nessun incasso, tutto a credito', async () => {
    const p = await voce(100)
    await incassa({ pagamento: p, importo: 100 })
    const e = await incassa({ pagamento: p, importo: 40, eccedenzaA: GENITORE })
    expect(e.esito).toBe('ok')
    expect(e.incasso).toBeNull()
    expect(Number(e.importo_incassato)).toBe(0)
    expect((await stato(p)).n).toBe(1)
    const c = await db.query<{ incasso_id: string | null }>('SELECT incasso_id FROM public.crediti_famiglia')
    expect(c.rows[0].incasso_id).toBeNull()
  })

  it('accredito impossibile (pagante inesistente) → ROLLBACK: nemmeno l\'incasso resta', async () => {
    const p = await voce(100)
    await expect(
      incassa({ pagamento: p, importo: 150, eccedenzaA: 'c0000000-0000-4000-8000-0000000000ff' }),
    ).rejects.toThrow(/pagante/)
    expect((await stato(p)).n).toBe(0)
  })

  it('le rate non hanno il controllo dell\'eccedenza (ci pensa lo spill)', async () => {
    const padre = await voce(200)
    const rata = await voce(100, { padre })
    const e = await incassa({ pagamento: rata, importo: 130 })
    expect(e.esito).toBe('ok')
    expect(Number(e.importo_incassato)).toBe(130)
  })

  it('abbuono: lo sconto copre la differenza e la voce risulta pagata', async () => {
    const p = await voce(100)
    const e = await incassa({ pagamento: p, importo: 90, abbuono: 'arrotondamento' })
    expect(e.esito).toBe('ok')
    expect(Number(e.sconto_dopo)).toBe(10)
    const s = await stato(p)
    expect(Number(s.sconto)).toBe(10)
    expect(s.stato).toBe('pagato')
    const a = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.registro_modifiche WHERE azione = 'abbuono_incasso'`,
    )
    expect(a.rows[0].n).toBe(1)
  })

  it('una quota di un ALTRO pagamento è rifiutata', async () => {
    const p = await voce(100)
    const altro = await voce(50)
    const q = await db.query<{ id: string }>(
      `INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo) VALUES ($1, $2, 50) RETURNING id`,
      [altro, GENITORE],
    )
    const e = await incassa({ pagamento: p, importo: 20, quota: q.rows[0].id })
    expect(e.esito).toBe('quota_estranea')
    expect((await stato(p)).n).toBe(0)
  })

  it('la quota del pagamento giusto viene registrata sull\'incasso', async () => {
    const p = await voce(100)
    const q = await db.query<{ id: string }>(
      `INSERT INTO public.pagamenti_quote (pagamento_id, adult_id, importo) VALUES ($1, $2, 100) RETURNING id`,
      [p, GENITORE],
    )
    const e = await incassa({ pagamento: p, importo: 20, quota: q.rows[0].id })
    expect((e.incasso as { quota_id: string }).quota_id).toBe(q.rows[0].id)
  })

  it('pagamento inesistente → non_trovato; metodo fuori elenco → errore 22P02 senza scritture', async () => {
    expect((await incassa({ pagamento: 'd0000000-0000-4000-8000-000000000009', importo: 10 })).esito).toBe('non_trovato')
    const p = await voce(100)
    await expect(incassa({ pagamento: p, importo: 10, metodo: 'baratto' })).rejects.toThrow()
    expect((await stato(p)).n).toBe(0)
  })

  it('i permessi: EXECUTE solo alla service_role', async () => {
    const r = await db.query<{ ruolo: string; puo: boolean }>(`
      SELECT ruolo, has_function_privilege(ruolo,
        'public.registra_incasso_voce(uuid, numeric, uuid, date, text, text, uuid, uuid, text)', 'EXECUTE') AS puo
        FROM unnest(ARRAY['anon','authenticated','service_role']) AS ruolo`)
    expect(Object.fromEntries(r.rows.map((x) => [x.ruolo, x.puo]))).toEqual({
      anon: false, authenticated: false, service_role: true,
    })
  })
})
