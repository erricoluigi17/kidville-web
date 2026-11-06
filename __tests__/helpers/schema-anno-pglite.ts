import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'

/**
 * SCHEMA MINIMO DELL'ANNO SCOLASTICO PER PGLITE.
 *
 * Una base di poche tabelle (ruoli, schema `extensions`, `schools`) sopra cui si applica l'INTERA
 * migrazione `*_anno_scolastico_schema.sql`, letta dal disco: se in produzione cambia, cambia anche
 * qui. Le tabelle che servono ai compiti dopo (sections, alunni, presenze…) le aggiungono i
 * compiti stessi in `SCHEMA_BASE`, PRIMA della migrazione: i test dei compiti precedenti devono
 * restare verdi dopo ogni estensione.
 *
 * Solo dati finti: gli uuid dei test sono inventati (`2222…`, `3333…`), mai di una sede vera.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

/** Il file della migrazione, trovato per suffisso (la version è l'istante in cui fu creato). */
export function fileMigrazioneAnno(): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith('_anno_scolastico_schema.sql'))
  if (!f) throw new Error('manca supabase/migrations/*_anno_scolastico_schema.sql')
  return join(CARTELLA, f)
}

/**
 * Le tabelle che la migrazione trova già in produzione. `schools` ha le sue colonne vere,
 * `operativa` compresa: nel DB della CI manca, e la migrazione non deve leggerla.
 */
export const SCHEMA_BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;

  CREATE SCHEMA extensions;

  CREATE TABLE public.schools (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nome text NOT NULL,
    indirizzo text,
    citta text,
    creato_il timestamptz DEFAULT now(),
    operativa boolean NOT NULL DEFAULT true
  );
`

export interface OpzioniDbAnno {
  /** Sedi già presenti PRIMA della migrazione, come in produzione: la migrazione dà loro gli anni. */
  sediPrimaDellaMigrazione?: string[]
}

/** Un PGlite con `btree_gist`, la base e l'intera migrazione dell'anno scolastico. */
export async function creaDbAnno(opzioni: OpzioniDbAnno = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(SCHEMA_BASE)
  for (const id of opzioni.sediPrimaDellaMigrazione ?? []) {
    await db.query('INSERT INTO public.schools (id, nome) VALUES ($1, $2)', [id, 'Sede di prova'])
  }
  await db.exec(readFileSync(fileMigrazioneAnno(), 'utf8'))
  return db
}
