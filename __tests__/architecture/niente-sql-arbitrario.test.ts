// @vitest-environment node
/**
 * Lock — DAL CODICE DEL REPO NESSUNO FA ESEGUIRE SQL QUALSIASI AL DATABASE.
 *
 * Robustezza, seconda serie, sessione 2 (problema D1 del rapporto del 20/10/2026). Fino a questa
 * sessione `public.exec_sql(sql text)` — SECURITY DEFINER, proprietario `postgres`, definita solo
 * nel baseline — eseguiva qualunque stringa per chi aveva la chiave di servizio: sei route
 * sigillate, cinque script e un file nella radice la chiamavano o la ricreavano. Con lei si
 * potevano anche accendere `registri.manutenzione`, `scatola_nera.manutenzione` e
 * `scatola_nera.senza_storico`, cioè spegnere i registri in sola aggiunta e la scatola nera.
 *
 * Il lock vieta che torni: la chiamata (`rpc('exec_sql')`, `/rpc/exec_sql`, `/pg/query`) o la
 * ricreazione (`CREATE FUNCTION exec_sql`) in `src/`, in `scripts/` e nei file della radice; e,
 * nelle migrazioni dopo il baseline, una funzione SECURITY DEFINER che prenda un argomento `sql`,
 * `query` o `istruzione` di tipo `text`.
 *
 * Il confine, detto: non vede SQL lanciato da fuori del repo (`psql`, l'editor del pannello) né
 * uno script che parli a Postgres con `DATABASE_URL`, che non passa da PostgREST.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

const RADICE = path.resolve(__dirname, '..', '..')

/** Le forme in cui il codice del repo chiamava, o ricreava, l'esecutore di SQL arbitrario. */
const CHIAMATE_VIETATE: ReadonlyArray<{ nome: string; re: RegExp }> = [
  { nome: "rpc('exec_sql')", re: /\.rpc\s*\(\s*['"`]exec_sql['"`]/ },
  { nome: '/rpc/exec_sql', re: /\/rpc\/exec_sql\b/ },
  { nome: '/pg/query', re: /\/pg\/query\b/ },
  { nome: 'CREATE FUNCTION exec_sql', re: /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?exec_sql\b/i },
]

function chiamateVietate(sorgente: string): string[] {
  return CHIAMATE_VIETATE.filter(({ re }) => re.test(sorgente)).map(({ nome }) => nome)
}

const ESTENSIONI = /\.(?:ts|tsx|js|jsx|mjs|cjs|sh|py)$/

function sorgentiSotto(cartella: string): string[] {
  const trovati: string[] = []
  for (const voce of fs.readdirSync(cartella, { withFileTypes: true })) {
    if (voce.name === 'node_modules' || voce.name.startsWith('.')) continue
    const percorso = path.join(cartella, voce.name)
    if (voce.isDirectory()) trovati.push(...sorgentiSotto(percorso))
    else if (ESTENSIONI.test(voce.name)) trovati.push(percorso)
  }
  return trovati
}

function colpevoli(file: string[]): string[] {
  return file
    .flatMap((f) => chiamateVietate(fs.readFileSync(f, 'utf8')).map((nome) => `${path.relative(RADICE, f)} → ${nome}`))
    .sort()
}

const PERCHE =
  '`exec_sql` non esiste più (robustezza, seconda serie, sessione 2). Una migrazione va in ' +
  '`supabase/migrations/` e la applica l’integrazione al merge; un dato si cambia con una route ' +
  'che dichiara la sua sede, non con SQL qualsiasi.'

describe('niente SQL arbitrario — il rilevatore', () => {
  it('prende le quattro forme', () => {
    expect(chiamateVietate("const { error } = await supabase.rpc('exec_sql', { sql })")).toEqual(["rpc('exec_sql')"])
    expect(chiamateVietate('await admin.rpc( "exec_sql" , { sql: q })')).toEqual(["rpc('exec_sql')"])
    expect(chiamateVietate('fetch(`${URL}/rest/v1/rpc/exec_sql`, { method: "POST" })')).toEqual(['/rpc/exec_sql'])
    expect(chiamateVietate("await fetch(url + '/pg/query', init)")).toEqual(['/pg/query'])
    expect(chiamateVietate('CREATE OR REPLACE FUNCTION public.exec_sql(sql text)')).toEqual(['CREATE FUNCTION exec_sql'])
  })

  it('non prende ciò che non è una chiamata', () => {
    expect(chiamateVietate("supabase.rpc('exec_sql_log', {})")).toEqual([])
    expect(chiamateVietate('// la funzione exec_sql è stata tolta')).toEqual([])
    expect(chiamateVietate("supabase.rpc('prossimo_numero_fattura')")).toEqual([])
  })
})

describe('niente SQL arbitrario — il codice', () => {
  it('in src/ nessuno chiama né ricrea exec_sql', () => {
    const file = sorgentiSotto(path.join(RADICE, 'src'))
    // Anti-cecità: un percorso sbagliato renderebbe verde un lock che non legge niente.
    expect(file.length, 'il lock non legge più src/').toBeGreaterThan(1000)
    expect(colpevoli(file), PERCHE).toEqual([])
  })

  it('in scripts/ e nei file della radice nessuno chiama né ricrea exec_sql', () => {
    const script = sorgentiSotto(path.join(RADICE, 'scripts'))
    const radice = fs
      .readdirSync(RADICE, { withFileTypes: true })
      .filter((v) => v.isFile() && ESTENSIONI.test(v.name))
      .map((v) => path.join(RADICE, v.name))
    expect(script.length, 'il lock non legge più scripts/').toBeGreaterThan(50)
    expect(radice.length, 'il lock non legge più la radice').toBeGreaterThan(5)
    expect(colpevoli([...script, ...radice]), PERCHE).toEqual([])
  })
})

const MIGRAZIONI = path.join(RADICE, 'supabase', 'migrations')
const BASELINE = '20260704120000_baseline.sql'

/** Un argomento che porta SQL da eseguire: `sql text`, `query text`, `istruzione text`. */
const ARGOMENTO_SQL = /(?:^|,)\s*(?:IN\s+)?"?(?:sql|query|istruzione)"?\s+text\b/i

/** I nomi delle funzioni SECURITY DEFINER che prendono un argomento SQL. Commenti esclusi. */
function funzioniSqlArbitrario(sql: string): string[] {
  const pulito = senzaCommenti(sql)
  const teste = [...pulito.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(([^)]*)\)/gi)]
  return teste.flatMap((m, i) => {
    const inizio = m.index ?? 0
    const fine = i + 1 < teste.length ? (teste[i + 1].index ?? pulito.length) : pulito.length
    const blocco = pulito.slice(inizio, fine)
    return /\bSECURITY\s+DEFINER\b/i.test(blocco) && ARGOMENTO_SQL.test(m[2]) ? [m[1].replace(/"/g, '')] : []
  })
}

const DROP_EXEC_SQL = /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.exec_sql\s*\(\s*text\s*\)\s*;/gi

describe('niente SQL arbitrario — le migrazioni', () => {
  const file = fs.readdirSync(MIGRAZIONI).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort()
  const dopoIlBaseline = file.filter((f) => f !== BASELINE)
  const leggi = (f: string) => fs.readFileSync(path.join(MIGRAZIONI, f), 'utf8')

  it('il rilevatore trova exec_sql nel baseline (controllo positivo su SQL vero)', () => {
    expect(funzioniSqlArbitrario(leggi(BASELINE))).toEqual(['public.exec_sql'])
  })

  it('il rilevatore: opzioni prima o dopo il corpo, commenti, INVOKER, nomi innocenti', () => {
    expect(funzioniSqlArbitrario(
      'CREATE OR REPLACE FUNCTION public.esegui(sql text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN EXECUTE sql; END $$;',
    )).toEqual(['public.esegui'])
    expect(funzioniSqlArbitrario(
      'CREATE FUNCTION public.x(query text) RETURNS void AS $$ BEGIN EXECUTE query; END $$ LANGUAGE plpgsql SECURITY DEFINER;',
    )).toEqual(['public.x'])
    expect(funzioniSqlArbitrario(
      '-- CREATE FUNCTION public.exec_sql(sql text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN EXECUTE sql; END $$;',
    )).toEqual([])
    expect(funzioniSqlArbitrario(
      'CREATE FUNCTION public.y(sql text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN EXECUTE sql; END $$;',
    )).toEqual([])
    expect(funzioniSqlArbitrario(
      'CREATE FUNCTION public.z(p_testo text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END $$;',
    )).toEqual([])
  })

  it('dopo il baseline nessuna funzione SECURITY DEFINER prende SQL da eseguire', () => {
    expect(dopoIlBaseline.length, 'il lock non legge più le migrazioni').toBeGreaterThan(200)
    const trovate = dopoIlBaseline.flatMap((f) => funzioniSqlArbitrario(leggi(f)).map((n) => `${f} → ${n}`))
    expect(trovate, PERCHE).toEqual([])
  })

  it('una migrazione toglie exec_sql, e nessun’altra la nomina fuori dal suo DROP', () => {
    const conDrop = dopoIlBaseline.filter((f) => (senzaCommenti(leggi(f)).match(DROP_EXEC_SQL) ?? []).length > 0)
    expect(conDrop, 'manca la migrazione che toglie public.exec_sql(text)').toHaveLength(1)
    const altriNomi = dopoIlBaseline.filter((f) => /\bexec_sql\b/i.test(senzaCommenti(leggi(f)).replace(DROP_EXEC_SQL, '')))
    expect(altriNomi, 'exec_sql nominata fuori dal suo DROP: la si sta ricreando o ridando a qualcuno').toEqual([])
  })

  it('il ROLLBACK scritto nella migrazione la richiude ad anon e authenticated', () => {
    // Qui si legge il COMMENTO, di proposito. In produzione i privilegi di default di `postgres`
    // su `public` danno EXECUTE ad anon e authenticated a ogni funzione nuova, e le righe del
    // baseline revocano solo FROM PUBLIC: un revert che rieseguisse soltanto quelle ridarebbe
    // `exec_sql` a chi ha la chiave pubblicabile (provato su un Postgres locale il 2026-10-25).
    const [conDrop] = dopoIlBaseline.filter((f) => (senzaCommenti(leggi(f)).match(DROP_EXEC_SQL) ?? []).length > 0)
    expect(conDrop, 'manca la migrazione che toglie public.exec_sql(text)').toBeDefined()
    const testo = leggi(conDrop)
    const rollback = testo.slice(Math.max(0, testo.indexOf('-- ─── ROLLBACK')))
    expect(rollback, 'la migrazione non ha più il suo blocco ROLLBACK').toMatch(/^-- ─── ROLLBACK/)
    expect(rollback, 'il ROLLBACK non revoca più EXECUTE ad anon e authenticated').toMatch(
      /^--\s+REVOKE ALL ON FUNCTION public\.exec_sql\(text\) FROM PUBLIC, anon, authenticated;$/m,
    )
  })
})
