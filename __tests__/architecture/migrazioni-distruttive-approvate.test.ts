import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK — UNA MIGRAZIONE CHE DISTRUGGE DATI DEVE DIRLO, CON IL SUO MOTIVO.
 *
 * ─── PERCHÉ (roadmap di robustezza, fase 4, problema D3-D) ──────────────────
 * Una migrazione la applica l'integrazione di Supabase AL MERGE, sul database di
 * produzione, senza nessuno davanti. Un `DROP TABLE`, un `DROP COLUMN`, un
 * `TRUNCATE` o un `DELETE FROM` eseguiti lì cancellano dati di minori, contabilità
 * e scrutini in un colpo solo, e la scatola nera ne vede solo una parte (non vede
 * `TRUNCATE` né le colonne tolte). In 207 migrazioni le istruzioni distruttive vere
 * sono poche (1 `DROP TABLE`, 2 `DROP COLUMN` al 2026-10-09): proprio perché sono
 * rare, devono essere VISTE.
 *
 * ─── LA REGOLA ───────────────────────────────────────────────────────────────
 * Dalla migrazione della scatola nera in poi (`DA_QUI`), un file che ESEGUE una di
 * quelle istruzioni deve contenere una riga di commento
 *
 *     -- distruttiva approvata: <motivo, almeno 15 caratteri>
 *
 * Il motivo lo legge chi revisiona la PR: è lì che ci si ferma a guardare.
 *
 * ─── COSA CONTA COME «ESEGUITA ALLA MIGRAZIONE» ──────────────────────────────
 *  · conta: le istruzioni al livello del file e il corpo dei blocchi `DO $$ … $$`
 *    (girano adesso);
 *  · non conta: il corpo di `CREATE FUNCTION` / `CREATE PROCEDURE` (è codice che
 *    girerà dopo, quando qualcuno lo chiama, con i suoi lock e i suoi test), le
 *    stringhe fra apici e i commenti;
 *  · non sono distruttive: `REVOKE … TRUNCATE`, `BEFORE TRUNCATE` (un trigger),
 *    `DROP TRIGGER`, `DROP FUNCTION`, `DROP POLICY`, `DROP INDEX`, `DROP CONSTRAINT`
 *    (non portano via righe).
 * Un `DELETE` dentro un comando di `cron.schedule` scritto in un `DO` conta: è una
 * pulizia che si INSTALLA, ed è giusto che porti il suo motivo.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
/** La prima migrazione sotto il lucchetto. Le precedenti sono storia: applicate, viste. */
const DA_QUI = '20261009171012'

const MARCATORE = /^\s*--\s*distruttiva approvata:\s*(.+)$/im

/** Lo SQL che gira AL MOMENTO della migrazione, senza commenti, stringhe e corpi di funzione. */
export function eseguitoAllaMigrazione(sql: string): string {
  const s = senzaCommenti(sql)
  let fuori = ''
  let inizioIstruzione = 0
  let i = 0
  while (i < s.length) {
    const dollaro = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y
    dollaro.lastIndex = i
    const d = dollaro.exec(s)
    if (d) {
      const tag = d[0]
      const fine = s.indexOf(tag, i + tag.length)
      const corpo = s.slice(i + tag.length, fine === -1 ? s.length : fine)
      const testa = s.slice(inizioIstruzione, i)
      const corpoDiFunzione = /^\s*create\s+(or\s+replace\s+)?(function|procedure)\b/i.test(testa)
      fuori += corpoDiFunzione ? ' ' : ` ${corpo} `
      i = fine === -1 ? s.length : fine + tag.length
      continue
    }
    if (s[i] === "'") {
      // Una stringa: il contenuto non è un'istruzione. `''` dentro la stringa è un apice.
      let j = i + 1
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") j += 2
        else if (s[j] === "'") break
        else j++
      }
      fuori += "''"
      i = j + 1
      continue
    }
    if (s[i] === ';') inizioIstruzione = i + 1
    fuori += s[i]
    i++
  }
  return fuori
}

const DISTRUTTIVE: { nome: string; re: RegExp }[] = [
  { nome: 'DROP TABLE', re: /\bdrop\s+table\b/i },
  { nome: 'DROP SCHEMA', re: /\bdrop\s+schema\b/i },
  { nome: 'DROP COLUMN', re: /\bdrop\s+column\b/i },
  // `TRUNCATE` come istruzione: non preceduto da REVOKE/GRANT … né da BEFORE/AFTER (trigger).
  { nome: 'TRUNCATE', re: /(^|;|\bthen\b|\bloop\b|\bbegin\b|\$\$)\s*truncate\b/i },
  { nome: 'DELETE FROM', re: /\bdelete\s+from\b/i },
]

/** Le istruzioni distruttive che questo SQL esegue alla migrazione. */
export function distruttiveEseguite(sql: string): string[] {
  const eseguito = eseguitoAllaMigrazione(sql)
  return DISTRUTTIVE.filter((d) => d.re.test(eseguito)).map((d) => d.nome)
}

/** Il file dichiara l'approvazione, con un motivo vero? */
export function approvata(sql: string): boolean {
  const m = MARCATORE.exec(sql)
  return m !== null && m[1].trim().length >= 15
}

const sotto = readdirSync(CARTELLA)
  .filter((f) => /^\d{14}_.+\.sql$/.test(f) && f.slice(0, 14) >= DA_QUI)
  .sort()

describe('lock architettura · migrazioni distruttive approvate (D3-D)', () => {
  it('la cartella si legge, e il punto di partenza esiste (sanity: senza, il lock sarebbe verde sul vuoto)', () => {
    expect(sotto.length).toBeGreaterThan(0)
    expect(sotto[0].startsWith(DA_QUI)).toBe(true)
  })

  for (const f of sotto) {
    it(`${f}: se distrugge dati, lo dichiara con il suo motivo`, () => {
      const sql = readFileSync(join(CARTELLA, f), 'utf8')
      const trovate = distruttiveEseguite(sql)
      if (trovate.length === 0) return
      expect(
        approvata(sql),
        `${f} esegue ${trovate.join(', ')} alla migrazione, sul database di produzione, e non lo ` +
          'dichiara. Aggiungi una riga «-- distruttiva approvata: <motivo>» (almeno 15 caratteri), ' +
          'dopo aver contato le righe che porta via e averlo detto nella PR. Se l’istruzione sta ' +
          'nel corpo di una funzione, il lock non la vede: gira dopo, non adesso.',
      ).toBe(true)
    })
  }
})

describe('lock architettura · migrazioni distruttive — prove gemelle', () => {
  const casi: { sql: string; attese: string[]; perche: string }[] = [
    { sql: 'DROP TABLE public.vecchia;', attese: ['DROP TABLE'], perche: 'al livello del file' },
    { sql: 'ALTER TABLE public.alunni DROP COLUMN note;', attese: ['DROP COLUMN'], perche: 'colonna tolta' },
    { sql: 'TRUNCATE public.presenze;', attese: ['TRUNCATE'], perche: 'istruzione TRUNCATE' },
    { sql: "DELETE FROM public.pagamenti WHERE stato = 'x';", attese: ['DELETE FROM'], perche: 'DELETE al livello del file' },
    { sql: 'DO $$ BEGIN DELETE FROM public.presenze; END $$;', attese: ['DELETE FROM'], perche: 'un DO gira adesso' },
    { sql: 'DO $$ BEGIN IF true THEN TRUNCATE public.x; END IF; END $$;', attese: ['TRUNCATE'], perche: 'TRUNCATE in un DO' },
    {
      sql: "DO $$ BEGIN EXECUTE format('ALTER TABLE public.%I DROP COLUMN vecchia', 'alunni'); END $$;",
      attese: ['DROP COLUMN'],
      perche: 'SQL dinamico in un DO: la stringa di EXECUTE gira adesso',
    },
    {
      sql: 'CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.x $$;',
      attese: [],
      perche: 'corpo di funzione: gira dopo',
    },
    {
      sql: 'CREATE FUNCTION public.g() RETURNS int LANGUAGE plpgsql AS $corpo$ BEGIN TRUNCATE public.x; RETURN 1; END $corpo$;',
      attese: [],
      perche: 'corpo con tag: gira dopo',
    },
    { sql: 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.x FROM anon;', attese: [], perche: 'REVOKE non distrugge' },
    { sql: 'CREATE TRIGGER t BEFORE TRUNCATE ON public.x FOR EACH STATEMENT EXECUTE FUNCTION f();', attese: [], perche: 'trigger' },
    { sql: '-- DROP TABLE public.x;\nSELECT 1;', attese: [], perche: 'commento' },
    { sql: "COMMENT ON TABLE public.x IS 'si fa DROP TABLE a fine anno';", attese: [], perche: 'stringa' },
    { sql: 'DROP TRIGGER IF EXISTS t ON public.x; DROP FUNCTION IF EXISTS f();', attese: [], perche: 'niente righe perse' },
  ]

  for (const c of casi) {
    it(`${c.perche}: ${JSON.stringify(c.attese)}`, () => {
      expect(distruttiveEseguite(c.sql)).toEqual(c.attese)
    })
  }

  it('il marcatore vale solo con un motivo vero, e solo come commento a inizio riga', () => {
    expect(approvata('-- distruttiva approvata: tabella di prova creata per errore il 31/07\nDROP TABLE x;')).toBe(true)
    expect(approvata('-- distruttiva approvata: sì\nDROP TABLE x;')).toBe(false)
    expect(approvata("COMMENT ON TABLE x IS '-- distruttiva approvata: non vale dentro una stringa';")).toBe(false)
    expect(approvata('DROP TABLE x;')).toBe(false)
  })
})
