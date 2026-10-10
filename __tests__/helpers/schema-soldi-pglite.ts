import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'

/**
 * SCHEMA MINIMO DEI SOLDI PER PGLITE — le sole colonne che le RPC della fase 5
 * (incassi, quote, ticket) leggono e scrivono, con i vincoli che contano
 * (CHECK importo <> 0, UNIQUE delle quote, FK quota → ON DELETE SET NULL).
 *
 * Le funzioni di ricalcolo e il trigger degli incassi sono LETTI dalle loro
 * migrazioni, non riscritti: se in produzione cambiano, cambiano anche qui.
 * Solo dati finti nei test che lo usano.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

export function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}

/** `CREATE [OR REPLACE] FUNCTION public.<nome>(…) … END $$;` tagliato dal testo. */
export function funzione(testo: string, nome: string): string {
  const m = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${nome}\\(`).exec(testo)
  if (!m) throw new Error(`corpo di ${nome} non trovato`)
  const fine = testo.indexOf('END $$;', m.index)
  if (fine < 0) throw new Error(`fine di ${nome} non trovata`)
  return testo.slice(m.index, fine + 'END $$;'.length)
}

export async function schemaSoldi(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;

    CREATE TYPE public.incasso_metodo AS ENUM
      ('contanti','bonifico','pos','assegno','altro','credito_famiglia','storno','rettifica');
    CREATE TYPE public.pagamento_tipo AS ENUM ('singolo','rata','padre','split');

    CREATE TABLE public.utenti (id uuid PRIMARY KEY);
    CREATE TABLE public.parents (id uuid PRIMARY KEY);
    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id uuid,
      alunno_id uuid,
      importo numeric(10,2) NOT NULL,
      sconto numeric(10,2) NOT NULL DEFAULT 0,
      sconto_motivo text,
      importo_pagato numeric(10,2) NOT NULL DEFAULT 0,
      parent_payment_id uuid REFERENCES public.pagamenti(id),
      tipo public.pagamento_tipo NOT NULL DEFAULT 'singolo',
      scadenza date,
      stato varchar DEFAULT 'da_pagare',
      data_incasso timestamptz,
      aggiornato_il timestamptz DEFAULT now()
    );
    CREATE TABLE public.pagamenti_quote (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      pagamento_id uuid NOT NULL REFERENCES public.pagamenti(id) ON DELETE CASCADE,
      adult_id uuid NOT NULL REFERENCES public.utenti(id),
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
  `)
  const base = migrazione('_baseline.sql')
  const v2 = migrazione('_contabilita_v2_regole.sql')
  await db.exec(funzione(v2, 'ricalcola_stato_padre'))
  await db.exec(funzione(v2, 'ricalcola_stato_pagamento'))
  await db.exec(funzione(base, 'trg_incassi_ricalcola'))
  await db.exec(`
    CREATE TRIGGER incassi_ricalcola AFTER INSERT OR DELETE OR UPDATE ON public.incassi
      FOR EACH ROW EXECUTE FUNCTION public.trg_incassi_ricalcola();
  `)
}

export const TABELLE_SOLDI =
  'public.registro_modifiche, public.crediti_famiglia, public.incassi, public.pagamenti_quote, public.pagamenti, public.parents, public.utenti'
