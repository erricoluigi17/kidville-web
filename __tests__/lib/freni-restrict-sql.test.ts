// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * I FRENI RESTRICT DELLA FASE 7 · LA MIGRAZIONE VERA, SU UN POSTGRES VERO.
 *
 * Fase 7 della roadmap di robustezza, PR 2: 22 chiavi esterne con valore legale
 * passano da ON DELETE CASCADE a RESTRICT. La verifica che la roadmap chiede è
 * una sola: «DELETE di un padre con figli rifiutato». Qui la si fa per tutti e
 * 22, applicando il FILE della migrazione così com'è su uno schema che riproduce
 * i vincoli di produzione (stessi nomi, tutti CASCADE: catalogo del 2026-10-11).
 *
 * Si provano anche le due cose scritte nella testata della migrazione, perché un
 * commento che nessuno ha mai eseguito non è una procedura:
 *  · il ROLLBACK riporta davvero i 22 vincoli in CASCADE;
 *  · la query di verifica n. 3 dice «rifiutato» coi freni e fallisce senza,
 *    senza cambiare niente in nessuno dei due casi.
 *
 * PGlite è Postgres 18: il rifiuto di RESTRICT arriva come 23001
 * (`restrict_violation`); la produzione (17.6) dice 23503. Si accettano entrambi,
 * come fa `figlieTrattengono()`. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).find((f) => f.endsWith('_freni_restrict_catene_legali.sql'))
if (!FILE) throw new Error('migrazione *_freni_restrict_catene_legali.sql non trovata')
const MIGRAZIONE = readFileSync(join(CARTELLA, FILE), 'utf8')
const ESEGUIBILE = MIGRAZIONE.split('\n').filter((r) => !r.trimStart().startsWith('--')).join('\n')

/** I 22 freni: [figlia, colonna, padre]. Il vincolo si chiama `<figlia>_<colonna>_fkey`. */
const FRENI: ReadonlyArray<readonly [string, string, string]> = [
  ['cassa_categorie', 'scuola_id', 'scuole'],
  ['cassa_chiusure', 'scuola_id', 'scuole'],
  ['cassa_movimenti', 'scuola_id', 'scuole'],
  ['certificati_competenze', 'alunno_id', 'alunni'],
  ['certificati_medici', 'alunno_id', 'alunni'],
  ['certificato_competenza_livelli', 'certificato_id', 'certificati_competenze'],
  ['form_submissions', 'model_id', 'form_models'],
  ['forms_submissions', 'form_id', 'forms_templates'],
  ['incassi', 'pagamento_id', 'pagamenti'],
  ['pagella_ricezioni', 'alunno_id', 'alunni'],
  ['pagella_ricezioni', 'scrutinio_id', 'scrutini'],
  ['pagelle', 'alunno_id', 'alunni'],
  ['pagelle', 'scrutinio_id', 'scrutini'],
  ['protocolli_allegati', 'protocollo_id', 'protocolli'],
  ['scrutini', 'periodo_id', 'scrutinio_periodi'],
  ['scrutini', 'section_id', 'sections'],
  ['scrutinio_comportamento', 'alunno_id', 'alunni'],
  ['scrutinio_comportamento', 'scrutinio_id', 'scrutini'],
  ['scrutinio_giudizi', 'alunno_id', 'alunni'],
  ['scrutinio_giudizi', 'materia_id', 'materie'],
  ['scrutinio_giudizi', 'scrutinio_id', 'scrutini'],
  ['student_documents', 'student_id', 'alunni'],
]

/** Restano CASCADE di proposito (vedi la testata della migrazione). */
const RESTANO_CASCADE: ReadonlyArray<readonly [string, string, string]> = [
  ['scrutinio_giudizio_descrittivo', 'periodo_id', 'scrutinio_periodi'],
  ['fatture_coda', 'pagamento_id', 'pagamenti'],
  ['firme_docenti', 'registro_id', 'registro_orario'],
]

const nomeVincolo = (figlia: string, colonna: string) => `${figlia}_${colonna}_fkey`

type PgErr = { code?: string; message: string }

/** Lo schema come in produzione PRIMA della migrazione: tabelle minime, vincoli CASCADE. */
async function schemaComeProduzione(conn: PGlite): Promise<void> {
  const tutti = [...FRENI, ...RESTANO_CASCADE]
  const colonne = new Map<string, Set<string>>()
  for (const [figlia, colonna, padre] of tutti) {
    if (!colonne.has(padre)) colonne.set(padre, new Set())
    if (!colonne.has(figlia)) colonne.set(figlia, new Set())
    colonne.get(figlia)!.add(colonna)
  }
  for (const [tabella, cols] of colonne) {
    const extra = [...cols].map((c) => `, ${c} uuid`).join('')
    await conn.exec(`CREATE TABLE public.${tabella} (id uuid PRIMARY KEY${extra});`)
  }
  for (const [figlia, colonna, padre] of tutti) {
    await conn.exec(
      `ALTER TABLE public.${figlia} ADD CONSTRAINT ${nomeVincolo(figlia, colonna)} ` +
        `FOREIGN KEY (${colonna}) REFERENCES public.${padre}(id) ON DELETE CASCADE;`,
    )
  }
}

async function regoleDiCancellazione(conn: PGlite): Promise<Map<string, string>> {
  const { rows } = await conn.query<{ conname: string; confdeltype: string }>(
    `select conname, confdeltype::text as confdeltype from pg_constraint where contype = 'f'`,
  )
  return new Map(rows.map((r) => [r.conname, r.confdeltype]))
}

/** Un uuid diverso per ogni riga finta, leggibile nel rosso. */
let progressivo = 0
const uuid = () => `f0000000-0000-4000-8000-${String(++progressivo).padStart(12, '0')}`

/** Padre con una figlia appesa; restituisce i due id. */
async function padreConFiglia(conn: PGlite, figlia: string, colonna: string, padre: string) {
  const idPadre = uuid()
  const idFiglia = uuid()
  await conn.query(`insert into public.${padre} (id) values ($1)`, [idPadre])
  await conn.query(`insert into public.${figlia} (id, ${colonna}) values ($1, $2)`, [idFiglia, idPadre])
  return { idPadre, idFiglia }
}

async function conta(conn: PGlite, tabella: string, id: string): Promise<number> {
  const { rows } = await conn.query<{ n: number }>(`select count(*)::int as n from public.${tabella} where id = $1`, [id])
  return rows[0].n
}

/** Il blocco n. 3 di «COME SI VERIFICA», letto dalla testata e senza i `--`. */
function verificaDelFreno(): string {
  const righe = MIGRAZIONE.split('\n')
  const inizio = righe.findIndex((r) => r.startsWith('-- 3. Il freno frena davvero'))
  if (inizio < 0) throw new Error('verifica n. 3 non trovata nella testata')
  const blocco: string[] = []
  for (const r of righe.slice(inizio + 1)) {
    if (!r.startsWith('--   ')) break
    blocco.push(r.slice(5))
  }
  return blocco.join('\n')
}

/** Le 22 istruzioni di ROLLBACK della testata, senza i `--`. */
function rollback(): string[] {
  return MIGRAZIONE.split('\n')
    .filter((r) => /^--\s+alter table public\.\w+ drop constraint \w+, add constraint .* on delete cascade;$/.test(r))
    .map((r) => r.replace(/^--\s+/, ''))
}

describe('la migrazione dei freni, letta', () => {
  it('dichiara ESATTAMENTE i 22 freni attesi: stesso nome, colonna e padre di produzione', () => {
    const trovati = [
      ...ESEGUIBILE.matchAll(
        /alter table public\.(\w+)\s+drop constraint (\w+),\s+add constraint (\w+)\s+foreign key \((\w+)\) references public\.(\w+)\(id\) on delete restrict;/gi,
      ),
    ].map((m) => {
      expect(m[2], `DROP e ADD devono nominare lo stesso vincolo (${m[2]} / ${m[3]})`).toBe(m[3])
      return `${m[1]}.${m[4]} → ${m[5]} (${m[2]})`
    })
    const attesi = FRENI.map(([t, c, p]) => `${t}.${c} → ${p} (${nomeVincolo(t, c)})`)
    expect(trovati.sort()).toEqual([...attesi].sort())
    // Nessun'altra istruzione eseguibile oltre alle 22 ALTER.
    expect(ESEGUIBILE.match(/;/g)?.length).toBe(22)
  })

  it('non tocca i tre vincoli che restano CASCADE di proposito', () => {
    for (const [t, c] of RESTANO_CASCADE) expect(ESEGUIBILE).not.toContain(nomeVincolo(t, c))
  })

  it('il rollback della testata copre tutti e 22 i vincoli', () => {
    expect(rollback()).toHaveLength(22)
  })
})

describe('la migrazione dei freni, applicata', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await schemaComeProduzione(db)
    await db.exec(MIGRAZIONE)
  }, 60_000)
  afterAll(async () => {
    await db?.close()
  })

  it('i 22 vincoli sono RESTRICT con lo stesso nome; i 3 esclusi restano CASCADE', async () => {
    const regole = await regoleDiCancellazione(db)
    for (const [t, c] of FRENI) expect(regole.get(nomeVincolo(t, c)), nomeVincolo(t, c)).toBe('r')
    for (const [t, c] of RESTANO_CASCADE) expect(regole.get(nomeVincolo(t, c)), nomeVincolo(t, c)).toBe('c')
  })

  for (const [figlia, colonna, padre] of FRENI) {
    it(`🔴 DELETE di ${padre} con una riga in ${figlia}.${colonna} → rifiutato, la figlia resta`, async () => {
      const { idPadre, idFiglia } = await padreConFiglia(db, figlia, colonna, padre)
      const err = await db.query(`delete from public.${padre} where id = $1`, [idPadre]).then(
        () => null,
        (e: PgErr) => e,
      )
      expect(err?.code, `il freno ${nomeVincolo(figlia, colonna)} non ha frenato`).toMatch(/^(23503|23001)$/)
      expect(await conta(db, padre, idPadre)).toBe(1)
      expect(await conta(db, figlia, idFiglia)).toBe(1)

      // In ordine si cancella: prima la figlia, poi il padre.
      await db.query(`delete from public.${figlia} where id = $1`, [idFiglia])
      await db.query(`delete from public.${padre} where id = $1`, [idPadre])
      expect(await conta(db, padre, idPadre)).toBe(0)
    })
  }

  it('i tre esclusi continuano a cancellare in cascata', async () => {
    for (const [figlia, colonna, padre] of RESTANO_CASCADE) {
      const { idPadre, idFiglia } = await padreConFiglia(db, figlia, colonna, padre)
      await db.query(`delete from public.${padre} where id = $1`, [idPadre])
      expect(await conta(db, figlia, idFiglia), `${figlia}.${colonna}`).toBe(0)
    }
  })

  it('la verifica n. 3 della testata risponde «rifiutato» e non cambia niente', async () => {
    const { idPadre, idFiglia } = await padreConFiglia(db, 'incassi', 'pagamento_id', 'pagamenti')
    await db.exec(verificaDelFreno())
    expect(await conta(db, 'pagamenti', idPadre)).toBe(1)
    expect(await conta(db, 'incassi', idFiglia)).toBe(1)
    await db.query(`delete from public.incassi where id = $1`, [idFiglia])
    await db.query(`delete from public.pagamenti where id = $1`, [idPadre])
  })
})

describe('senza i freni (prima della migrazione, o dopo il rollback)', () => {
  it('la verifica n. 3 FALLISCE ad alta voce, e la cascata tentata torna indietro', async () => {
    const db = new PGlite()
    try {
      await schemaComeProduzione(db)
      const { idPadre, idFiglia } = await padreConFiglia(db, 'incassi', 'pagamento_id', 'pagamenti')
      const err = await db.exec(verificaDelFreno()).then(
        () => null,
        (e: PgErr) => e,
      )
      expect(err?.message).toMatch(/il freno NON ha frenato/)
      expect(await conta(db, 'pagamenti', idPadre)).toBe(1)
      expect(await conta(db, 'incassi', idFiglia)).toBe(1)
    } finally {
      await db.close()
    }
  }, 60_000)

  it('il rollback della testata riporta i 22 vincoli in CASCADE, e la cascata torna', async () => {
    const db = new PGlite()
    try {
      await schemaComeProduzione(db)
      await db.exec(MIGRAZIONE)
      for (const istruzione of rollback()) await db.exec(istruzione)
      const regole = await regoleDiCancellazione(db)
      for (const [t, c] of FRENI) expect(regole.get(nomeVincolo(t, c)), nomeVincolo(t, c)).toBe('c')
      const { idPadre, idFiglia } = await padreConFiglia(db, 'pagelle', 'alunno_id', 'alunni')
      await db.query(`delete from public.alunni where id = $1`, [idPadre])
      expect(await conta(db, 'pagelle', idFiglia)).toBe(0)
    } finally {
      await db.close()
    }
  }, 60_000)
})
