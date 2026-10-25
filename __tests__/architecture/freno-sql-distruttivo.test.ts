// @vitest-environment node
/**
 * IL FRENO SULLE ISTRUZIONI DISTRUTTIVE — `.claude/hooks/supabase_sql_freno.py`.
 *
 * Robustezza, seconda serie, sessione 2 (decisione T3 del titolare, 20/10/2026). Il freno è un
 * hook `PreToolUse` sugli strumenti SQL di Supabase: risponde `deny` a ogni `apply_migration` e,
 * su `execute_sql`, a `DELETE`, `DROP`, `TRUNCATE`, `UPDATE` senza `WHERE`, `ALTER … DROP` e agli
 * interruttori della scatola nera; lascia passare letture, `INSERT`, `UPDATE … WHERE`, `CREATE`.
 *
 * Si prova lo SCRIPT VERO, con l'input che Claude Code gli passa su stdin, un caso per riga. Le
 * due metà contano uguale: un caso fermato che passa è un buco; un caso lasciato passare che viene
 * fermato è il falso positivo che, alla terza lettura bloccata, fa spegnere il freno.
 *
 * Quello che questi test NON provano: che Claude Code carichi davvero l'hook e ne rispetti il
 * `deny` anche in `bypassPermissions`. Quello si prova solo in una sessione nuova, dopo il riavvio
 * (piano della sessione 2, «Rilascio»): una configurazione mai vista passare non è configurata.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RADICE = path.resolve(__dirname, '..', '..')
const FRENO = path.join(RADICE, '.claude', 'hooks', 'supabase_sql_freno.py')

let progetto = ''
beforeAll(() => {
  progetto = fs.mkdtempSync(path.join(os.tmpdir(), 'freno-sql-'))
  fs.mkdirSync(path.join(progetto, '.claude'))
})
afterAll(() => {
  fs.rmSync(progetto, { recursive: true, force: true })
})

type Esito = { uscita: number | null; decisione: string | null; motivo: string; stderr: string }

/**
 * Lancia il freno vero con `ingresso` su stdin. L'ambiente è COSTRUITO, non ereditato: se chi
 * lancia i test avesse esportato `KIDVILLE_FRENO_SQL_SPENTO=1`, ogni caso «fermato» uscirebbe
 * senza decisione. Niente `LANG`: il freno deve reggere anche senza locale.
 */
function freno(ingresso: unknown, ambiente: Record<string, string> = {}): Esito {
  const esito = spawnSync('python3', [FRENO], {
    input: typeof ingresso === 'string' ? ingresso : JSON.stringify(ingresso),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: progetto, ...ambiente },
    timeout: 10_000,
  })
  const testo = (esito.stdout ?? '').trim()
  if (!testo) return { uscita: esito.status, decisione: null, motivo: '', stderr: esito.stderr ?? '' }
  const json = JSON.parse(testo) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string }
  }
  expect(json.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  return {
    uscita: esito.status,
    decisione: json.hookSpecificOutput.permissionDecision,
    motivo: json.hookSpecificOutput.permissionDecisionReason,
    stderr: esito.stderr ?? '',
  }
}

/** L'input che Claude Code passa a un hook `PreToolUse` per uno strumento SQL. */
function sql(query: string, strumento = 'mcp__supabase__execute_sql') {
  return {
    session_id: 'prova-freno',
    hook_event_name: 'PreToolUse',
    tool_name: strumento,
    tool_input: { project_id: 'progetto-finto', query },
    cwd: RADICE,
    permission_mode: 'bypassPermissions',
  }
}

const UUID = '11111111-1111-4111-8111-111111111111'

/** [perché, query, parola che il motivo del rifiuto deve contenere] */
const FERMATE: ReadonlyArray<readonly [string, string, string]> = [
  ['DELETE con WHERE', 'DELETE FROM public.app_log WHERE id = 1', 'DELETE'],
  ['delete minuscolo', 'delete from app_log', 'DELETE'],
  ['maiuscole a caso', 'DeLeTe FrOm public.app_log', 'DELETE'],
  ['DROP TABLE', 'DROP TABLE public.prova_freno', 'DROP'],
  ['DROP FUNCTION minuscolo', 'drop function if exists public.exec_sql(text)', 'DROP'],
  ['TRUNCATE', 'TRUNCATE public.app_log', 'TRUNCATE'],
  ['UPDATE senza WHERE', "UPDATE public.alunni SET stato = 'ritirato'", 'UPDATE senza WHERE'],
  ['UPDATE ONLY con alias, senza WHERE', "UPDATE ONLY public.alunni AS a SET stato = 'ritirato'", 'UPDATE senza WHERE'],
  ['WHERE solo nella sottoquery', 'UPDATE public.alunni SET stato = (SELECT stato FROM public.alunni WHERE id = 1)', 'UPDATE senza WHERE'],
  ['UPDATE senza WHERE dentro una CTE', "WITH u AS (UPDATE public.alunni SET stato = 'x' RETURNING id) SELECT count(*) FROM u WHERE true", 'UPDATE senza WHERE'],
  ['ALTER … DROP COLUMN', 'ALTER TABLE public.alunni DROP COLUMN note', 'ALTER … DROP'],
  ['ALTER … DROP NOT NULL, minuscolo', 'alter table public.alunni alter column note drop not null', 'ALTER … DROP'],
  ['seconda di due istruzioni', 'SELECT 1; DELETE FROM public.app_log', 'DELETE'],
  ['dopo commenti di riga e di blocco', '/* lettura */ SELECT 1;\n-- poi\nDROP TABLE public.prova_freno', 'DROP'],
  ['DELETE in fondo a una CTE', 'WITH vecchi AS (SELECT id FROM public.app_log) DELETE FROM public.app_log WHERE id IN (SELECT id FROM vecchi)', 'DELETE'],
  ['dentro un blocco DO', 'DO $$ BEGIN DELETE FROM public.app_log; END $$', 'DELETE'],
  ['dentro il corpo di una funzione creata a mano', 'CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.app_log $$', 'DELETE'],
  ['EXPLAIN ANALYZE esegue davvero', 'EXPLAIN ANALYZE DELETE FROM public.app_log', 'DELETE'],
  ['EXPLAIN di un DELETE', 'EXPLAIN DELETE FROM public.app_log WHERE false', 'DELETE'],
  ['spegne lo storico prima di un UPDATE … WHERE', `SELECT set_config('scatola_nera.senza_storico', 'on', true); UPDATE public.alunni SET stato = 'x' WHERE id = '${UUID}'`, 'interruttore'],
  ['accende la manutenzione dei registri', "SET LOCAL registri.manutenzione = 'on'", 'interruttore'],
  ['spegne i trigger della sessione', 'SET session_replication_role = replica', 'interruttore'],
  ['spegne i trigger di una tabella', 'ALTER TABLE public.alunni DISABLE TRIGGER ALL', 'interruttore'],
]

/** [perché, query] — il freno non sa dove finisce l'istruzione: in dubbio si ferma. */
const ILLEGGIBILI: ReadonlyArray<readonly [string, string]> = [
  ['stringa non chiusa', "SELECT 'non chiusa"],
  ['un apice dentro $$ che si mangerebbe il resto', "SELECT $$'$$; DELETE FROM public.app_log"],
  ['commento di blocco non chiuso', 'SELECT 1 /* DELETE FROM public.app_log'],
]

/** [perché, query] — nessuna decisione: decide la modalità di permesso, come senza freno. */
const PASSANO: ReadonlyArray<readonly [string, string]> = [
  ['il conteggio delle iscrizioni', 'SELECT count(*) FROM enrollment_submissions'],
  ['select minuscolo con WHERE', "select id from public.alunni where stato = 'iscritto' limit 1"],
  ['INSERT', 'INSERT INTO public.prova_freno (n) VALUES (1)'],
  ['INSERT … ON CONFLICT DO UPDATE', 'INSERT INTO public.prova_freno (id, n) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET n = excluded.n'],
  ['UPDATE con WHERE', `UPDATE public.alunni SET stato = 'ritirato' WHERE id = '${UUID}'`],
  ['UPDATE con alias, FROM e WHERE', 'UPDATE public.prova_freno p SET n = q.n FROM public.prova_freno q WHERE p.id = q.id'],
  ['CREATE TABLE con ON DELETE CASCADE e ON UPDATE SET NULL', 'CREATE TABLE public.prova_freno (id uuid PRIMARY KEY, alunno_id uuid REFERENCES public.alunni(id) ON DELETE CASCADE ON UPDATE SET NULL)'],
  ['CREATE INDEX', 'CREATE INDEX IF NOT EXISTS prova_freno_n ON public.prova_freno (n)'],
  ['CREATE TRIGGER su UPDATE OR DELETE', 'CREATE TRIGGER t AFTER UPDATE OR DELETE ON public.prova_freno FOR EACH ROW EXECUTE FUNCTION public.f()'],
  ['EXPLAIN di una lettura', 'EXPLAIN SELECT * FROM public.app_log WHERE id = 1'],
  ['GRANT con DELETE e TRUNCATE fra i privilegi', 'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.prova_freno TO service_role'],
  ['SELECT … FOR UPDATE', 'SELECT id FROM public.alunni FOR UPDATE SKIP LOCKED'],
  ['parole distruttive dentro una stringa', "SELECT 'DELETE FROM alunni; DROP TABLE x' AS testo"],
  ['parola distruttiva in un commento di riga', '-- DELETE FROM public.app_log\nSELECT 1'],
  ['parola distruttiva in un commento di blocco', '/* DROP TABLE public.app_log */ SELECT 1'],
  ['colonne che cominciano come una parola distruttiva', 'SELECT deleted_at, dropped, truncated FROM public.prova_freno'],
  ['identificatore fra virgolette', 'SELECT "delete" FROM public.prova_freno'],
  ["lettura dell'interruttore, non scrittura", "SELECT current_setting('scatola_nera.manutenzione', true)"],
  ['più letture nella stessa stringa', 'SELECT 1; SELECT 2;'],
]

describe('freno SQL — le istruzioni distruttive si fermano', () => {
  it.each(FERMATE)('ferma: %s', (perche, query, categoria) => {
    const e = freno(sql(query))
    expect(e.decisione, perche).toBe('deny')
    expect(e.motivo, perche).toContain(categoria)
    // Il rifiuto dice cosa fare: mostrare l'istruzione al titolare, non cercare un'altra via.
    expect(e.motivo).toContain('titolare')
    expect(e.motivo).toContain('editor SQL')
    expect(e.uscita).toBe(0)
    expect(e.stderr).toBe('')
  })

  it.each(ILLEGGIBILI)('in dubbio si ferma: %s', (perche, query) => {
    const e = freno(sql(query))
    expect(e.decisione, perche).toBe('deny')
    expect(e.motivo).toContain('In dubbio si ferma')
    expect(e.uscita).toBe(0)
  })

  it('apply_migration è fermato SEMPRE, anche con una lettura dentro', () => {
    for (const strumento of ['mcp__supabase__apply_migration', 'mcp__claude_ai_Supabase__apply_migration']) {
      const e = freno({
        ...sql('SELECT 1', strumento),
        tool_input: { project_id: 'progetto-finto', name: 'prova', query: 'SELECT 1' },
      })
      expect(e.decisione, strumento).toBe('deny')
      expect(e.motivo).toContain('integrazione')
      expect(e.motivo).toContain('titolare')
    }
  })

  it('il connettore claude.ai è frenato come quello del progetto', () => {
    expect(freno(sql('DELETE FROM public.app_log', 'mcp__claude_ai_Supabase__execute_sql')).decisione).toBe('deny')
  })
})

describe('freno SQL — tutto il resto passa, senza decisione', () => {
  it.each(PASSANO)('lascia passare: %s', (perche, query) => {
    const e = freno(sql(query))
    expect(e.decisione, `${perche} → ${e.motivo}`).toBeNull()
    expect(e.uscita).toBe(0)
    expect(e.stderr).toBe('')
  })

  it('uno strumento che non è SQL non lo riguarda', () => {
    const e = freno(sql('DROP TABLE x', 'mcp__supabase__list_tables'))
    expect(e.decisione).toBeNull()
    expect(e.uscita).toBe(0)
  })
})

describe('freno SQL — via di fuga, input rotti, registro', () => {
  it('KIDVILLE_FRENO_SQL_SPENTO=1 lo spegne per la sessione', () => {
    const e = freno(sql('DROP TABLE public.prova_freno'), { KIDVILLE_FRENO_SQL_SPENTO: '1' })
    expect(e.decisione).toBeNull()
    expect(e.uscita).toBe(0)
  })

  it.each(['0', 'true', 'si', ''])('solo «1» lo spegne: con %j resta acceso', (valore) => {
    expect(freno(sql('DROP TABLE public.prova_freno'), { KIDVILLE_FRENO_SQL_SPENTO: valore }).decisione).toBe('deny')
  })

  it.each([
    ['input che non è JSON', 'questo non è json'],
    ['JSON che non è un oggetto', '[1, 2, 3]'],
    ['query assente', { ...sql('x'), tool_input: { project_id: 'progetto-finto' } }],
    ['query vuota', sql('   ')],
    ['query che non è una stringa', { ...sql('x'), tool_input: { project_id: 'progetto-finto', query: 42 } }],
  ] as const)('in dubbio si ferma: %s', (titolo, ingresso) => {
    const e = freno(ingresso)
    expect(e.decisione, titolo).toBe('deny')
    expect(e.motivo, titolo).toContain('In dubbio si ferma')
    expect(e.uscita).toBe(0)
  })

  it('il registro annota la decisione, MAI il testo della query', () => {
    freno(sql("DELETE FROM public.app_log WHERE evento = 'MARCATORE_DEL_TEST'"))
    freno(sql("SELECT 'MARCATORE_DEL_TEST' AS prova"))
    const registro = fs.readFileSync(path.join(progetto, '.claude', '.permessi-auto.log'), 'utf8')
    expect(registro).toMatch(/FRENO SQL\tesito=negato\tstrumento=mcp__supabase__execute_sql\tcategoria=DELETE/)
    expect(registro).toMatch(/FRENO SQL\tesito=passato\tstrumento=mcp__supabase__execute_sql/)
    expect(registro).not.toContain('MARCATORE_DEL_TEST')
  })

  it('il freno non approva e non chiede mai: nega, oppure tace', () => {
    const sorgente = fs.readFileSync(FRENO, 'utf8')
    // `ask` passerebbe da auto_allow_permission.py, che lo approva da solo (§8, divieto 18 della
    // specifica); `allow` scavalcherebbe la modalità di permesso. Il freno ha una sola parola.
    expect(sorgente).not.toMatch(/["']ask["']/)
    expect(sorgente).not.toMatch(/["']allow["']/)
    expect(sorgente).toMatch(/["']deny["']/)
  })
})

type VoceHook = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }
type Impostazioni = { permissions: { allow: string[] }; hooks: { PreToolUse?: VoceHook[] } }

describe('freno SQL — è registrato, e copre ciò che è in allow', () => {
  const impostazioni = JSON.parse(
    fs.readFileSync(path.join(RADICE, '.claude', 'settings.json'), 'utf8'),
  ) as Impostazioni
  const voce = (impostazioni.hooks.PreToolUse ?? []).find((v) =>
    v.hooks.some((h) => h.command.includes('supabase_sql_freno.py')),
  )
  const coperti = (voce?.matcher ?? '').split('|')

  it('un PreToolUse chiama il freno dal progetto, con un tetto di 10 s', () => {
    expect(voce, 'il freno non è registrato in .claude/settings.json → hooks.PreToolUse').toBeDefined()
    const comando = voce?.hooks.find((h) => h.command.includes('supabase_sql_freno.py'))
    expect(comando?.type).toBe('command')
    expect(comando?.command).toBe('"$CLAUDE_PROJECT_DIR/.claude/hooks/supabase_sql_freno.py"')
    expect(comando?.timeout ?? 60).toBeLessThanOrEqual(10)
  })

  it('il matcher è un elenco di nomi esatti: i quattro strumenti SQL di Supabase', () => {
    // Solo lettere, cifre, `_` e `|`: Claude Code lo legge come elenco di nomi, non come regex.
    expect(voce?.matcher ?? '').toMatch(/^[A-Za-z0-9_|]+$/)
    expect([...coperti].sort()).toEqual([
      'mcp__claude_ai_Supabase__apply_migration',
      'mcp__claude_ai_Supabase__execute_sql',
      'mcp__supabase__apply_migration',
      'mcp__supabase__execute_sql',
    ])
  })

  it('ogni strumento SQL o di migrazione in permissions.allow passa dal freno', () => {
    const inAllow = impostazioni.permissions.allow.filter((p) => /__(execute_sql|apply_migration)$/.test(p))
    expect(inAllow.length).toBeGreaterThanOrEqual(3)
    expect(inAllow.filter((p) => !coperti.includes(p))).toEqual([])
  })

  it('il freno è eseguibile, e il gate vecchio in bash non c’è più', () => {
    expect(fs.statSync(FRENO).mode & 0o111).not.toBe(0)
    expect(fs.existsSync(path.join(RADICE, '.claude', 'hooks', 'supabase_sql_gate.sh'))).toBe(false)
  })
})
