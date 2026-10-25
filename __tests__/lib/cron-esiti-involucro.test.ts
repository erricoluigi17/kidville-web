// @vitest-environment node
/**
 * Il modulo che riscrive le funzioni dei cron (sessione 6 della seconda serie di robustezza).
 *
 * Le definizioni vengono dalla PRODUZIONE (`pg_get_functiondef`), non dal repo: il modulo
 * sostituisce l'unica chiamata `net.http_post(` con `public.cron_http_post('<job>', ` e non
 * tocca un altro carattere. Questi casi provano che lo fa, che sa tornare indietro, e che si
 * ferma — con un messaggio — su tutto quello che non sa trattare.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ASSENTI_IN_PRODUZIONE, FUNZIONI_HTTP_AL_20_10, INVOLUCRO, LETTORE, NON_SI_AVVOLGONO,
  avvolgi, confronta, contaChiamate, corpoDi, corpoOVuoto, etichetta, genera, impronteDelRepo,
  inversa, leggiRighe, mascheraSql, md5, minimoAvvolte, normalizza, sospetti, svolgi,
  ultimeDefinizioni, ultimeDefinizioniDa,
} from '../../scripts/cron-esiti/involucro.mjs'

const TICK = `CREATE OR REPLACE FUNCTION public.prova_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_url text;
BEGIN
  -- una volta qui c'era net.http_post( con un altro indirizzo
  RAISE LOG 'si chiama net.http_post(';
  v_url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app.news_url');
  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
END;
$function$
`

type Riga = {
  proname: string; definizione: string; impronta: string; tipi: string; proprietario: string
  security_definer: boolean; anon: boolean; authenticated: boolean; service_role: boolean; job: string[]
}
function riga(p: Partial<Riga> & { proname: string; definizione: string }): Riga {
  const r = {
    tipi: '', proprietario: 'postgres', security_definer: true, anon: false,
    authenticated: false, service_role: false, job: [] as string[], ...p,
  }
  return { ...r, impronta: md5(r.definizione) }
}
const rinomina = (def: string, nome: string) => def.replace('public.prova_tick()', `public.${nome}()`)
const una = riga({ proname: 'prova_tick', definizione: TICK, job: ['news-tick'] })

describe('mascheraSql', () => {
  it('spegne commenti (anche annidati) e stringhe, e tiene lunghezza e a capo', () => {
    const sql = "SELECT 'a;b' -- c;d\n/* e /* f; */ g; */ ;"
    const m = mascheraSql(sql)
    expect(m).toHaveLength(sql.length)
    expect(m.split('\n')).toHaveLength(2)
    expect(m.indexOf(';')).toBe(sql.lastIndexOf(';'))
  })
  it('dollar quoting con e senza etichetta; `$1` e `a$b` non aprono niente', () => {
    const m = mascheraSql('SELECT $x$ ; $x$, $$ ; $$, $1, a$b ;')
    expect(m.match(/;/g)).toHaveLength(1)
  })
  it('apici raddoppiati e stringhe E con la barra rovesciata', () => {
    const m = mascheraSql("SELECT E'a\\';b', 'c'';d' ;")
    expect(m.match(/;/g)).toHaveLength(1)
  })
  it('con `stringhe: false` spegne solo i commenti', () => {
    expect(mascheraSql("SELECT 'x' -- y", { stringhe: false })).toBe("SELECT 'x'     ")
    expect(normalizza("a  -- b\n   c")).toBe('a c')
  })
})

describe('corpoDi', () => {
  it.each(['$$', '$function$', '$_$'])('separa testata, corpo e coda con %s', (tag) => {
    const def = `CREATE FUNCTION public.f() RETURNS void AS ${tag}SELECT 1;${tag} LANGUAGE sql\n`
    const p = corpoDi(def)
    expect(p.tag).toBe(tag)
    expect(p.corpo).toBe('SELECT 1;')
    expect(p.testata + p.corpo + p.tag + p.coda).toBe(def)
  })
  it('senza `AS $tag$`, o con il corpo mai chiuso, si ferma', () => {
    expect(() => corpoDi("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'"))
      .toThrow('definizione senza corpo «AS $tag$»')
    expect(() => corpoDi('CREATE FUNCTION f() AS $$ SELECT 1')).toThrow('corpo aperto da $$ e mai chiuso')
    expect(corpoOVuoto("CREATE FUNCTION f() AS 'x'")).toBe('')
  })
})

describe('contaChiamate, avvolgi, svolgi', () => {
  it('conta solo il codice: il commento e la stringa non contano', () => {
    expect(contaChiamate(corpoDi(TICK).corpo)).toEqual({ dirette: 1, avvolte: 0 })
  })
  it('avvolgi cambia una cosa sola: la chiamata, con l’etichetta del job', () => {
    const dopo = avvolgi(TICK, 'news-tick')
    expect(dopo).toBe(TICK.replace('PERFORM net.http_post(', "PERFORM public.cron_http_post('news-tick', "))
    expect(contaChiamate(corpoDi(dopo).corpo)).toEqual({ dirette: 0, avvolte: 1 })
  })
  it('svolgi è l’inversa esatta', () => {
    expect(svolgi(avvolgi(TICK, 'news-tick'))).toEqual({ definizione: TICK, job: 'news-tick' })
  })
  it('si ferma su etichetta non valida, corpo già avvolto, zero o due chiamate, forma non canonica', () => {
    expect(() => avvolgi(TICK, 'News_Tick')).toThrow('etichetta non valida')
    expect(() => avvolgi(avvolgi(TICK, 'a'), 'a')).toThrow("il corpo passa già dall'involucro")
    expect(() => avvolgi(TICK.replace('PERFORM net.http_post(', 'PERFORM net.http_get('), 'a'))
      .toThrow('attesa UNA chiamata a net.http_post nel codice, trovate 0')
    expect(() => avvolgi(TICK.replace('END;', 'PERFORM net.http_post(url := v_url);\nEND;'), 'a'))
      .toThrow('attesa UNA chiamata a net.http_post nel codice, trovate 2')
    expect(() => avvolgi(TICK.replace('PERFORM net.http_post(', 'PERFORM net . http_post ('), 'a'))
      .toThrow('forma non canonica')
    expect(() => svolgi(TICK)).toThrow("attese UNA chiamata all'involucro e nessuna diretta, trovate 0 e 1")
  })
})

describe('etichetta', () => {
  it('il nome del job; senza job il nome della funzione; mai due job', () => {
    expect(etichetta({ proname: 'news_tick', job: ['news-tick'] })).toBe('news-tick')
    expect(etichetta({ proname: 'video_runner_kick', job: [] })).toBe('video-runner-kick')
    expect(() => etichetta({ proname: 'x_tick', job: ['a', 'b'] })).toThrow('la chiamano 2 job (a, b)')
  })
})

describe('sospetti', () => {
  it('trova segreti e dati personali, non i nomi delle chiavi del Vault', () => {
    expect(sospetti(TICK)).toEqual([])
    expect(sospetti(`'Bearer ${'k'.repeat(24)}'`)).toContain('un token dopo «Bearer»')
    expect(sospetti(['eyJ' + 'a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)].join('.'))).toContain('un JWT')
    expect(sospetti('sb_secret_' + 'x'.repeat(12))).toContain('una chiave Supabase')
    expect(sospetti('re_' + 'y'.repeat(20))).toContain('una chiave di un fornitore')
    expect(sospetti('prova@example.invalid')).toContain('un indirizzo email')
    expect(sospetti('AAAAAA00A00A000A')).toContain('un codice fiscale')
  })
})

describe('leggiRighe', () => {
  it('unisce più file, ricontrolla l’impronta e i tipi', () => {
    const due = riga({ proname: 'altra_tick', definizione: rinomina(TICK, 'altra_tick') })
    expect(leggiRighe([JSON.stringify([una]), JSON.stringify([due])]).map((r: Riga) => r.proname))
      .toEqual(['prova_tick', 'altra_tick'])
    expect(() => leggiRighe([JSON.stringify([una]), JSON.stringify([una])])).toThrow('compare due volte')
    expect(() => leggiRighe([JSON.stringify([{ ...una, impronta: md5('altro') }])])).toThrow("l'impronta non torna")
    expect(() => leggiRighe(['{}'])).toThrow('array')
    expect(() => leggiRighe([JSON.stringify([{ ...una, job: 'news-tick' }])])).toThrow('job')
  })
})

describe('genera', () => {
  it('ridefinisce, revoca, e ridà EXECUTE a service_role solo a chi lo aveva', () => {
    const conGrant = riga({ proname: 'altra_tick', definizione: rinomina(TICK, 'altra_tick'), service_role: true })
    const { sql, saltate } = genera([una, conGrant])
    expect(saltate).toEqual([])
    expect(sql.indexOf('-- altra_tick')).toBeLessThan(sql.indexOf('-- prova_tick'))
    expect(sql).toContain("public.cron_http_post('news-tick', ")
    expect(sql).toContain("public.cron_http_post('altra-tick', ")
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.prova_tick() FROM PUBLIC, anon, authenticated;')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.altra_tick() TO service_role;')
    expect(sql).not.toContain('GRANT EXECUTE ON FUNCTION public.prova_tick()')
    expect(sql).toContain(`impronta ${una.impronta}`)
  })
  it('salta chi cita net.http_post solo in commenti o stringhe, e genera_solleciti con la sua ragione', () => {
    const soloCommento = riga({
      proname: 'commento_tick',
      definizione: rinomina(TICK, 'commento_tick').replace('PERFORM net.http_post(', 'PERFORM net.http_get('),
    })
    const vecchia = riga({ proname: 'genera_solleciti', definizione: rinomina(TICK, 'genera_solleciti'), security_definer: false })
    const { sql, saltate } = genera([una, soloCommento, vecchia])
    expect(saltate).toEqual([
      'commento_tick: cita net.http_post solo in commenti o stringhe',
      `genera_solleciti: ${NON_SI_AVVOLGONO.genera_solleciti}`,
    ])
    expect(sql).not.toContain('commento_tick')
    expect(sql).not.toContain('genera_solleciti')
  })
  it.each([
    ['un proprietario diverso da postgres', { proprietario: 'supabase_admin' }, 'proprietario'],
    ['SECURITY INVOKER', { security_definer: false }, 'SECURITY INVOKER'],
    ['EXECUTE ad anon', { anon: true }, 'anon o authenticated'],
    ['EXECUTE ad authenticated', { authenticated: true }, 'anon o authenticated'],
    ['due job sulla stessa funzione', { job: ['a', 'b'] }, 'non sarebbe univoca'],
  ])('si ferma con %s', (_caso, cambio, messaggio) => {
    expect(() => genera([{ ...una, ...cambio }])).toThrow(messaggio)
  })
  it('si ferma su un segreto nel corpo, su un involucro già esistente, su un corpo già avvolto', () => {
    const conToken = TICK.replace("'Content-Type', 'application/json'", `'Authorization', 'Bearer ${'k'.repeat(24)}'`)
    expect(() => genera([riga({ proname: 'prova_tick', definizione: conToken })])).toThrow('il repository è pubblico')
    expect(() => genera([riga({ proname: INVOLUCRO, definizione: rinomina(TICK, INVOLUCRO) })])).toThrow('esiste già in produzione')
    expect(() => genera([riga({ proname: 'prova_tick', definizione: avvolgi(TICK, 'x') })])).toThrow("passa già dall'involucro")
  })
})

describe('inversa', () => {
  it('rimette le definizioni di prima coi loro permessi, poi spegne il job e toglie funzioni e tabelle', () => {
    const migrazione =
      'CREATE TABLE IF NOT EXISTS public.cron_chiamate (id bigint);\n' +
      'CREATE OR REPLACE FUNCTION public.cron_http_post(job text) RETURNS bigint LANGUAGE sql AS $f$ SELECT 1::bigint $f$;\n' +
      genera([una]).sql
    const inv = inversa(migrazione)
    expect(inv).toContain(TICK.trimEnd() + ';')
    expect(inv).toContain('REVOKE ALL ON FUNCTION public.prova_tick() FROM PUBLIC, anon, authenticated;')
    expect(inv).not.toContain('cron_http_post(job text)')
    const pos = (s: string) => inv.indexOf(s)
    expect(pos('public.prova_tick()')).toBeLessThan(pos('cron.unschedule'))
    expect(pos('cron.unschedule')).toBeLessThan(pos('DROP FUNCTION IF EXISTS public.cron_esiti()'))
    expect(pos('DROP FUNCTION IF EXISTS public.cron_http_post(')).toBeLessThan(pos('DROP TABLE IF EXISTS public.cron_ultimo_esito'))
    expect(inv).toMatch(/^-- distruttiva approvata: .{15,}$/m)
    expect(inv.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true)
    expect(() => inversa('SELECT 1;')).toThrow('nessuna funzione avvolta')
  })

  it('un pezzo finisce col suo ultimo permesso: i commenti che seguono (blocco dopo, `-- == IL LETTORE ==`) restano fuori', () => {
    const due = riga({ proname: 'altra_tick', definizione: rinomina(TICK, 'altra_tick') })
    const migrazione =
      genera([una, due]).sql +
      '\n-- == IL LETTORE ==\n\n' +
      'CREATE OR REPLACE FUNCTION public.cron_esiti() RETURNS jsonb LANGUAGE sql AS $f$ SELECT 1::jsonb $f$;\n'
    const inv = inversa(migrazione)
    expect(inv).not.toContain('IL LETTORE')
    expect(inv).not.toContain('· etichetta «')
    // Sulla migrazione vera della sessione 6: gli unici commenti sono le tre righe di testa e la «distruttiva approvata».
    const vera = inversa(readFileSync(join(process.cwd(), 'supabase/migrations/20261025095807_cron_esiti_osservati.sql'), 'utf8'))
    const commenti = vera.split('\n').filter((r) => r.startsWith('--'))
    expect(commenti.length).toBe(4)
    expect(commenti[3]).toMatch(/^-- distruttiva approvata: /)
  })
})

describe('ultimeDefinizioniDa e confronta', () => {
  it('vince l’ultima definizione, un DROP la toglie, un commento non definisce niente', () => {
    const m = ultimeDefinizioniDa([
      { nome: '1.sql', sql: 'CREATE FUNCTION public.a() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;\nCREATE FUNCTION b() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;' },
      { nome: '2.sql', sql: '-- CREATE OR REPLACE FUNCTION public.a() finta\ncreate or replace function public.a() RETURNS int AS $x$ SELECT 2; $x$ LANGUAGE sql;\nDROP FUNCTION IF EXISTS public.b();' },
    ])
    expect([...m.keys()]).toEqual(['a'])
    expect(m.get('a')).toEqual({ file: '2.sql', definizione: 'create or replace function public.a() RETURNS int AS $x$ SELECT 2; $x$ LANGUAGE sql' })
  })
  it('cinque esiti, in ordine di nome', () => {
    const repo = new Map([
      ['uguale', { file: 'r1.sql', definizione: rinomina(TICK, 'uguale') }],
      ['spazi', { file: 'r2.sql', definizione: rinomina(TICK, 'spazi').replace('  RAISE LOG', '      RAISE LOG').replace('altro indirizzo', 'indirizzo vecchio') }],
      ['diversa', { file: 'r3.sql', definizione: rinomina(TICK, 'diversa').replace("'app.news_url'", "'app.altro_url'") }],
      ['nel_repo', { file: 'r4.sql', definizione: rinomina(TICK, 'nel_repo') }],
    ])
    const righe = ['uguale', 'spazi', 'diversa', 'solo_prod'].map((n) => riga({ proname: n, definizione: rinomina(TICK, n) }))
    expect(confronta(righe, repo)).toEqual([
      { funzione: 'diversa', esito: 'diverso', file: 'r3.sql' },
      { funzione: 'nel_repo', esito: 'solo-nel-repo', file: 'r4.sql' },
      { funzione: 'solo_prod', esito: 'solo-in-produzione', file: '' },
      { funzione: 'spazi', esito: 'uguale-a-meno-di-commenti-e-spazi', file: 'r2.sql' },
      { funzione: 'uguale', esito: 'identico', file: 'r1.sql' },
    ])
  })
})

describe('sulle funzioni vere del repo', () => {
  const repo = ultimeDefinizioni(join(process.cwd(), 'supabase/migrations'))

  it('legge i DROP: exec_sql non c’è più (sessione 2)', () => {
    expect(repo.has('exec_sql')).toBe(false)
  })

  it('il minimo da avvolgere è 20 meno le esclusioni dichiarate, e ogni esclusione è vera', () => {
    expect(minimoAvvolte()).toBe(
      FUNZIONI_HTTP_AL_20_10 - Object.keys(NON_SI_AVVOLGONO).length - Object.keys(ASSENTI_IN_PRODUZIONE).length,
    )
    for (const [nome, ragione] of Object.entries({ ...NON_SI_AVVOLGONO, ...ASSENTI_IN_PRODUZIONE })) {
      expect(String(ragione).length, nome).toBeGreaterThan(30)
      const def = repo.get(nome)
      expect(def, `${nome} non è più nel repo: togli la voce`).toBeDefined()
      expect(contaChiamate(corpoOVuoto(def!.definizione)).dirette, nome).toBe(1)
    }
  })

  it('avvolgere e svolgere restituisce ogni definizione carattere per carattere', () => {
    let provate = 0
    for (const [nome, { definizione }] of repo) {
      if (nome === INVOLUCRO || nome === LETTORE || nome in NON_SI_AVVOLGONO) continue
      const { dirette, avvolte } = contaChiamate(corpoOVuoto(definizione))
      if (dirette + avvolte === 0) continue
      const prima = avvolte === 1 && dirette === 0 ? svolgi(definizione).definizione : definizione
      const job = nome.replace(/_/g, '-')
      expect(svolgi(avvolgi(prima, job)), nome).toEqual({ definizione: prima, job })
      provate++
    }
    expect(provate).toBeGreaterThanOrEqual(minimoAvvolte())
  })

  it('impronte: una riga «nome<TAB>md5 del corpo» per funzione, in ordine', () => {
    const righe = impronteDelRepo(repo)
    expect(righe.length).toBeGreaterThanOrEqual(minimoAvvolte())
    for (const r of righe) expect(r).toMatch(/^[a-z_][a-z0-9_]*\t[0-9a-f]{32}$/)
    expect([...righe].sort()).toEqual(righe)
  })
})
