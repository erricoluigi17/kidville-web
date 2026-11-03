// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { MIGRAZIONI_ATTESE_AL_MERGE } from '../../architecture/soglia-fotografia'
import { migrazione, senzaCommentiSql } from '../sql-da-migrazioni'

/**
 * VIGILANZA CHAT · IL REGISTRO AMMETTE L'AZIONE «SCARICO» (foto della chat, compito 5).
 *
 * Due letture dello stesso file, perché una sola non basta:
 *
 *  1. TESTUALE — il file `supabase/migrations/<UTC>_chat_vigilanza_azione_scarico.sql` ha la forma che il
 *     resto del sistema presuppone: tocca il solo CHECK di `azione` (col nome letto in produzione), non
 *     concede niente al service_role, non scrive righe e non cabla nessuna sede.
 *  2. ESEGUITA — su un Postgres vero (PGlite, in memoria) si applicano le DUE migrazioni vere che creano il
 *     registro, poi questa, DUE volte (la seconda è la prova dell'idempotenza). Il vincolo si prova con righe
 *     finte: prima della migrazione `scarico` è rifiutato (23514), dopo si inserisce; `lettura` e `ricerca`
 *     restano ammesse, un valore fuori vocabolario no, e il CHECK dell'esito non si è mosso.
 *
 * ⚠️ PGlite è PostgreSQL 18, la produzione è PostgreSQL 17: qui si provano CHECK e privilegi, che non cambiano
 * fra le due versioni. Il test non tocca nessun database vero: il nome del vincolo (`…_azione_check`) è quello
 * letto in produzione il 2026-11-03 con la sola SELECT su `pg_constraint`.
 *
 * Solo dati finti: uuid inventati, nessuna anagrafica.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const SUFFISSO = '_chat_vigilanza_azione_scarico.sql'

const FILE = readdirSync(CARTELLA).filter((f) => /^\d{14}_chat_vigilanza_azione_scarico\.sql$/.test(f))
const NOME_FILE = FILE[0] ?? ''
const SQL_GREZZO = FILE.length === 1 ? migrazione(SUFFISSO) : ''
const SQL = senzaCommentiSql(SQL_GREZZO)
/** Le istruzioni, senza commenti e senza il CONTENUTO delle stringhe: il testo di un COMMENT ON nomina TRUNCATE e DELETE per dire che sono revocati. */
const ISTRUZIONI = SQL.replace(/'(?:[^']|'')*'/g, "''")

const VINCOLO = 'chat_vigilanza_accessi_azione_check'

describe('migrazione vigilanza «scarico» · forma del file', () => {
  it('esiste un solo file *_chat_vigilanza_azione_scarico.sql, con una version UTC che non è nel futuro', () => {
    expect(FILE).toHaveLength(1)
    const v = NOME_FILE.slice(0, 14)
    const ora = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    // Una version nel FUTURO rende rossa la fotografia delle FK anche rigenerata: il nome si prende con
    // `date -u` al momento di scrivere, mai con un orario tondo.
    expect(v <= ora, `version ${v} nel futuro rispetto ad ora (${ora})`).toBe(true)
    expect(v.slice(10), 'un orario tondo non è un istante vero').not.toBe('0000')
  })

  it('toglie e rimette il solo CHECK `chat_vigilanza_accessi_azione_check`, con i tre valori', () => {
    expect(SQL).toMatch(
      new RegExp(`alter\\s+table\\s+public\\.chat_vigilanza_accessi\\s+drop\\s+constraint\\s+if\\s+exists\\s+${VINCOLO}\\s*;`, 'i'),
    )
    expect(SQL).toMatch(
      new RegExp(
        `alter\\s+table\\s+public\\.chat_vigilanza_accessi\\s+add\\s+constraint\\s+${VINCOLO}\\s+check\\s*\\(\\s*azione\\s+in\\s*\\(\\s*'lettura'\\s*,\\s*'ricerca'\\s*,\\s*'scarico'\\s*\\)\\s*\\)\\s*;`,
        'i',
      ),
    )
    // L'altro CHECK della tabella (l'esito) non si tocca.
    expect(SQL).not.toMatch(/esito_check/i)
  })

  it('nessun GRANT: il registro resta in sola aggiunta', () => {
    expect(ISTRUZIONI).not.toMatch(/\bgrant\b/i)
    expect(ISTRUZIONI).not.toMatch(/\brevoke\b/i)
  })

  it('non scrive e non distrugge righe: nessun INSERT/UPDATE/DELETE/TRUNCATE/DROP TABLE', () => {
    expect(ISTRUZIONI).not.toMatch(/\binsert\s+into\b/i)
    expect(ISTRUZIONI).not.toMatch(/\bupdate\s+public\./i)
    expect(ISTRUZIONI).not.toMatch(/\bdelete\s+from\b/i)
    expect(ISTRUZIONI).not.toMatch(/\btruncate\b/i)
    expect(ISTRUZIONI).not.toMatch(/\bdrop\s+(table|column|schema)\b/i)
    // Controllo positivo: le istruzioni che la migrazione ESEGUE sono davvero viste (un ISTRUZIONI vuoto passerebbe tutto).
    expect(ISTRUZIONI).toMatch(/\bdrop\s+constraint\b/i)
    expect(ISTRUZIONI).toMatch(/\badd\s+constraint\b/i)
  })

  it('il COMMENT ON TABLE nomina la route nuova accanto alle altre che scrivono', () => {
    const m = /comment\s+on\s+table\s+public\.chat_vigilanza_accessi\s+is\s+'((?:[^']|'')*)'/i.exec(SQL)
    expect(m, 'manca il COMMENT ON TABLE').not.toBeNull()
    const testo = m![1]
    expect(testo).toContain('admin/chat/messages:GET')
    expect(testo).toContain('admin/chat/messages/scarico:POST')
    expect(testo).toContain('admin/chat/ricerca:GET')
    // Il testo della migrazione «sola aggiunta» resta vero: select+insert, niente UPDATE/DELETE.
    expect(testo).toMatch(/SOLA AGGIUNTA/)
    expect(testo).toMatch(/service_role ha SOLO select\+insert/)
  })

  it('è dichiarata fra le attese al merge, oppure è già nella fotografia delle migrazioni (mai nessuna delle due)', () => {
    // Fino al merge la applica l'integrazione e la si dichiara in MIGRAZIONI_ATTESE_AL_MERGE (un ADD/DROP
    // CONSTRAINT fa gridare la guardia delle FK verso `utenti`); dopo la PR-B sta nella fotografia, una riga
    // sola e con la version del file. Questo test regge entrambi gli stati.
    const foto = JSON.parse(
      readFileSync(join(process.cwd(), '__tests__', 'fixtures', 'migrazioni-applicate-snapshot.json'), 'utf8'),
    ) as { migrazioni: { version: string; name: string }[] }
    const righe = foto.migrazioni.filter((m) => m.name === 'chat_vigilanza_azione_scarico')
    const dichiarata = Object.keys(MIGRAZIONI_ATTESE_AL_MERGE).includes(NOME_FILE)
    const applicata = righe.length > 0
    expect(dichiarata || applicata, 'né dichiarata attesa al merge né applicata').toBe(true)
    expect(dichiarata && applicata, 'dichiarata attesa E già applicata: togli la voce (PR-B)').toBe(false)
    if (applicata) expect(righe.map((m) => m.version)).toEqual([NOME_FILE.slice(0, 14)])
  })

  it('niente uuid di sede cablato e niente dati personali', () => {
    expect(SQL_GREZZO).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })
})

// ─── la migrazione ESEGUITA ───────────────────────────────────────────────────

const OPERATORE = '00000000-0000-4000-8000-0000000000a1'

let db: PGlite

type PgErr = { code?: string; message: string }

async function errore(sql: string): Promise<PgErr | null> {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    return e as PgErr
  }
}

const riga = (azione: string, esito = 'ok') =>
  `INSERT INTO public.chat_vigilanza_accessi (operatore_id, operatore_ruolo, azione, esito)
   VALUES ('${OPERATORE}', 'segreteria', '${azione}', '${esito}');`

/** Dove si prova il «prima»: si salva qui, perché `beforeAll` lo calcola PRIMA di applicare la migrazione. */
let prima: { scarico: PgErr | null; vincoli: string[] }

beforeAll(async () => {
  db = new PGlite()
  // Lo schema MINIMO che la migrazione presuppone: i tre ruoli di Supabase e il registro, creato dalle sue
  // DUE migrazioni vere (la tabella e la «sola aggiunta»), non riscritto qui.
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  `)
  await db.exec(migrazione('_chat_vigilanza_accessi.sql'))
  await db.exec(migrazione('_chat_vigilanza_accessi_sola_aggiunta.sql'))

  // IL «PRIMA»: con il solo schema di oggi la riga `scarico` è rifiutata dal CHECK.
  const vincoli = await db.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'public.chat_vigilanza_accessi'::regclass AND contype = 'c' ORDER BY conname`,
  )
  prima = { scarico: await errore(riga('scarico')), vincoli: vincoli.rows.map((r) => r.conname) }

  // DUE volte: la seconda è la prova dell'idempotenza (nessun errore, nessun vincolo doppio)
  await db.exec(SQL_GREZZO)
  await db.exec(SQL_GREZZO)
}, 60_000)

afterAll(async () => {
  await db.close()
})

describe('migrazione vigilanza «scarico» · eseguita su Postgres', () => {
  it('PRIMA: i due CHECK hanno i nomi letti in produzione e `scarico` è rifiutato (23514)', () => {
    // Senza questo il resto sarebbe verde anche con una migrazione che non cambia niente.
    expect(prima.vincoli).toEqual([VINCOLO, 'chat_vigilanza_accessi_esito_check'])
    expect(prima.scarico?.code).toBe('23514')
  })

  it('DOPO: l’azione `scarico` si inserisce', async () => {
    expect(await errore(riga('scarico'))).toBeNull()
    expect(await errore(riga('scarico', 'fuori-scope'))).toBeNull()
  })

  it('`lettura` e `ricerca` restano ammesse', async () => {
    expect(await errore(riga('lettura'))).toBeNull()
    expect(await errore(riga('ricerca'))).toBeNull()
  })

  it('un’azione fuori vocabolario è rifiutata dal CHECK: 23514', async () => {
    const e = await errore(riga('altro'))
    expect(e?.code).toBe('23514')
    expect(e?.message).toContain(VINCOLO)
  })

  it('il CHECK dell’esito non si è mosso: `ok` e `fuori-scope` sì, il resto 23514', async () => {
    expect(await errore(riga('lettura', 'ok'))).toBeNull()
    expect(await errore(riga('lettura', 'fuori-scope'))).toBeNull()
    expect((await errore(riga('lettura', 'boh')))?.code).toBe('23514')
  })

  it('applicata due volte: un solo CHECK sull’azione, con i tre valori, e il vincolo non è “not valid”', async () => {
    const { rows } = await db.query<{ conname: string; def: string; convalidated: boolean }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
        WHERE conrelid = 'public.chat_vigilanza_accessi'::regclass AND contype = 'c' ORDER BY conname`,
    )
    expect(rows.map((r) => r.conname)).toEqual([VINCOLO, 'chat_vigilanza_accessi_esito_check'])
    const azione = rows.find((r) => r.conname === VINCOLO)!
    for (const v of ['lettura', 'ricerca', 'scarico']) expect(azione.def).toContain(`'${v}'`)
    expect(azione.convalidated).toBe(true)
  })

  it('i privilegi non sono cambiati: service_role ha SELECT e INSERT e nient’altro, anon e authenticated niente', async () => {
    for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('service_role', 'public.chat_vigilanza_accessi', '${p}') AS ok`)
      expect(rows[0].ok, `service_role ha ${p}`).toBe(false)
    }
    for (const p of ['SELECT', 'INSERT']) {
      const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('service_role', 'public.chat_vigilanza_accessi', '${p}') AS ok`)
      expect(rows[0].ok, `service_role non ha ${p}`).toBe(true)
    }
    for (const ruolo of ['anon', 'authenticated']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('${ruolo}', 'public.chat_vigilanza_accessi', '${p}') AS ok`)
        expect(rows[0].ok, `${ruolo} ha ${p}`).toBe(false)
      }
    }
  })

  it('il commento della tabella dice la route nuova, e quello della colonna dice «scarico»', async () => {
    const t = await db.query<{ c: string }>(`SELECT obj_description('public.chat_vigilanza_accessi'::regclass, 'pg_class') AS c`)
    expect(t.rows[0].c).toContain('admin/chat/messages/scarico:POST')
    const col = await db.query<{ c: string }>(
      `SELECT col_description('public.chat_vigilanza_accessi'::regclass, a.attnum) AS c
         FROM pg_attribute a WHERE a.attrelid = 'public.chat_vigilanza_accessi'::regclass AND a.attname = 'azione'`,
    )
    expect(col.rows[0].c).toContain('scarico')
  })
})
