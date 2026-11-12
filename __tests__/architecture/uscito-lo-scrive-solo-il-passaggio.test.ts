import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente } from '../fixtures/sorgente'

/**
 * PR 4.8, «Riattiva» giro 7 · LA FREQUENZA `uscito` LA SCRIVE SOLO IL PASSAGGIO.
 *
 * Perché esiste: «Riattiva» riconosce chi è uscito col passaggio d'anno dalla frequenza `uscito` che il passaggio ha chiuso (la funzione SQL
 * `anno_alunno_archiviato_dal_passaggio` la legge). Se una route, un job o un'altra funzione SQL scrivesse `uscito`, il criterio smetterebbe di
 * dire la verità. Nel giro 4 «Archivia» riscriveva `uscito` in `ritirato` e il 409 verso la «Conferma tardiva» spariva in silenzio: da qui il lock.
 *
 * LA REGOLA (giro 6: più semplice e più severa di quella del giro 5, che cercava la FORMA della scrittura e aveva punti ciechi — `CASE`, `format()`,
 * `EXECUTE` con gli apici raddoppiati, `jsonb_populate_record`, una variabile, una sottoquery, una chiave fra apici, una costante, il parametro di una
 * RPC): OGNI letterale `uscito` — fra apici singoli, doppi o raddoppiati, o in una stringa `$tag$…$tag$` — è vietato, salvo
 *
 *  · nel CORPO di una delle funzioni `public.passaggio_*` dell'elenco chiuso `FUNZIONI_PASSAGGIO` (giro 7: non più «qualunque `passaggio_*`», ma solo quelle che
 *    scrivono o leggono davvero `uscito`: conferma e annullo). Il corpo va dal primo `$tag$` dopo il suo `CREATE FUNCTION` al `$tag$` che lo chiude: una riga che sta DOPO
 *    quel corpo non è più della funzione, anche se la funzione è la più vicina sopra;
 *  · nell'elenco chiuso qui sotto, scritto UNA PER UNA: sono tutte LETTURE (un CHECK, un invariante, un test dello specchio), con il perché accanto.
 *
 * Il resto è vietato per costruzione: qualunque forma di scrittura passa da un letterale, anche un array (`'{uscito}'`). Le due costanti ammesse in `src/` (`STATI_CHIUSI`,
 * `STATI_FREQUENZA_CHIUSI`) si possono usare solo come `.includes(…)`: riusarle per scrivere (`STATI_CHIUSI[2]`) è una violazione.
 * LIMITI DICHIARATI, ciechi per costruzione: lo stato COPIATO da un'altra riga (`UPDATE … FROM … SET stato = g.stato`, `INSERT … SELECT *`, in TS `v.stato`),
 * `'usc' || 'ito'`, una stringa letta da una tabella. Il lock ferma gli sbagli, non chi lo vuole aggirare. Perimetro: `src/` (ts/tsx) e `supabase/migrations/`;
 * le migrazioni archiviate non si applicano più e gli script non scrivono frequenze.
 *
 * Dichiara quanto ha letto (un lock che scansiona zero file è verde) e ha il controllo positivo, per ciascuna forma, su testo finto.
 */

const CWD = process.cwd()
const MIN_FILE_SRC = 1000
const MIN_MIGRAZIONI = 200

interface VoceElenco { file: string; funzione: string | null; contiene: string; n: number; perche: string }

/** Le sole occorrenze di `uscito` ammesse in `supabase/migrations/` FUORI da una `passaggio_*`. Tutte letture. */
export const LETTURE_SQL: VoceElenco[] = [
  { file: '20261106200347_anno_scolastico_schema.sql', funzione: null, contiene: 'CONSTRAINT frequenze_stato_check', n: 1, perche: 'il CHECK: dice quali valori esistono, non ne scrive nessuno' },
  { file: '20261108102826_anno_sezioni_docenti_fase_b.sql', funzione: 'anno_invarianti', contiene: 'IS DISTINCT FROM (f.stato IN (', n: 1, perche: 'invariante: legge lo stato chiuso' },
  { file: '20261108170148_anno_visibilita_genitore_funzioni.sql', funzione: 'anno_invarianti', contiene: 'IS DISTINCT FROM (f.stato IN (', n: 1, perche: 'invariante: legge lo stato chiuso' },
  { file: '20261109035213_anno_alunno_in_arrivo.sql', funzione: 'alunni_specchio_frequenza', contiene: "v_n ->> 'stato' IN (", n: 1, perche: 'lo specchio legge lo stato nuovo per decidere se la scheda è archiviata' },
  { file: '20261109035213_anno_alunno_in_arrivo.sql', funzione: 'anno_invarianti', contiene: 'IS DISTINCT FROM (f.stato IN (', n: 1, perche: 'invariante: legge lo stato chiuso' },
  { file: '20261109182422_anno_passaggio_conferma.sql', funzione: 'alunni_specchio_frequenza', contiene: "v_n ->> 'stato' IN (", n: 1, perche: 'lo specchio legge lo stato nuovo per decidere se la scheda è archiviata' },
  { file: '20261109182422_anno_passaggio_conferma.sql', funzione: 'anno_invarianti', contiene: 'THEN \'NOT (al.archiviato_il IS NOT NULL AND al.section_id IS NULL', n: 1, perche: 'invariante: legge lo stato chiuso' },
  { file: '20261109182422_anno_passaggio_conferma.sql', funzione: 'anno_invarianti', contiene: 'IS DISTINCT FROM (f.stato IN (', n: 1, perche: 'invariante: legge lo stato chiuso' },
  { file: '20261109182422_anno_passaggio_conferma.sql', funzione: 'anno_alunno_archiviato_dal_passaggio', contiene: "AND f.stato = 'uscito'", n: 1, perche: 'il criterio di «Riattiva»: LEGGE la frequenza che il passaggio ha chiuso' },
]

/** Le sole occorrenze di `uscito` ammesse in `src/`. Tutte letture: l'elenco degli stati che chiudono una frequenza. */
/** Le sole funzioni `passaggio_*` che hanno `uscito` nel corpo: la conferma lo scrive, l'annullo lo legge e lo rimette. Una nuova (anche la 4.9) va aggiunta QUI, a mano. */
export const FUNZIONI_PASSAGGIO: readonly string[] = ['passaggio_conferma', 'passaggio_annulla']

/** Le costanti di `src/` che contengono `uscito` e si possono solo interrogare (`.includes`). */
export const COSTANTI_AMMESSE: readonly string[] = ['STATI_CHIUSI', 'STATI_FREQUENZA_CHIUSI']

export const LETTURE_TS: VoceElenco[] = [
  { file: 'src/lib/anno/frequenze.ts', funzione: null, contiene: 'const STATI_CHIUSI', n: 1, perche: 'elenco degli stati che chiudono una frequenza (un filtro)' },
  { file: 'src/lib/anno/iscrizione-anno.ts', funzione: null, contiene: 'const STATI_FREQUENZA_CHIUSI', n: 1, perche: 'elenco degli stati che chiudono una frequenza (un filtro)' },
]

/** SQL senza commenti `--` e `/* … *\/` (le stringhe restano: `'uscito'` è una stringa). */
function senzaCommentiSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** Un letterale `uscito`: fra apici (singoli, doppi, raddoppiati) o in una stringa `$tag$uscito$tag$`. */
const LETTERALE_USCITO = /(?:''|'|")uscito(?:''|'|")|\$([A-Za-z_]*)\$uscito\$\1\$|'\{[^'}]*\buscito\b[^'}]*\}'/gi

/** I corpi delle funzioni: dal primo `$tag$` dopo l'intestazione al `$tag$` che lo chiude. Senza corpo trovabile, la funzione non ha corpo (e ciò che c'è dopo è «fuori»). */
function corpiFunzioni(sql: string): Array<{ da: number; a: number; nome: string }> {
  const intestazioni: Array<{ pos: number; fine: number; nome: string }> = []
  const reF = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z0-9_]+)"?/gi
  let f: RegExpExecArray | null
  while ((f = reF.exec(sql)) !== null) intestazioni.push({ pos: f.index, fine: f.index + f[0].length, nome: f[1].toLowerCase() })
  const out: Array<{ da: number; a: number; nome: string }> = []
  intestazioni.forEach((h, i) => {
    const limite = i + 1 < intestazioni.length ? intestazioni[i + 1].pos : sql.length
    const reT = /\$([A-Za-z_]*)\$/g
    reT.lastIndex = h.fine
    const t = reT.exec(sql)
    if (!t || t.index >= limite) return
    const chiusura = sql.indexOf(t[0], t.index + t[0].length)
    out.push({ da: t.index + t[0].length, a: chiusura < 0 ? sql.length : chiusura, nome: h.nome })
  })
  return out
}

/** Le occorrenze di `uscito` in un testo SQL: la funzione nel cui CORPO stanno (`null` = fuori da ogni corpo), la riga e il testo della riga. */
export function occorrenzeUscitoSql(sqlGrezzo: string): Array<{ funzione: string | null; riga: number; testo: string }> {
  const sql = senzaCommentiSql(sqlGrezzo)
  const corpi = corpiFunzioni(sql)
  const righe = sql.split('\n')
  const out: Array<{ funzione: string | null; riga: number; testo: string }> = []
  const re = new RegExp(LETTERALE_USCITO.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    let funzione: string | null = null
    for (const c of corpi) if (c.da <= m.index && m.index < c.a) funzione = c.nome
    const riga = sql.slice(0, m.index).split('\n').length
    out.push({ funzione, riga, testo: righe[riga - 1].trim() })
  }
  return out
}

/** Nei sorgenti TypeScript (commenti già tolti): ogni letterale `uscito` fra apici singoli, doppi o backtick. */
export function occorrenzeUscitoTs(senzaCommenti: string): Array<{ riga: number; testo: string }> {
  const righe = senzaCommenti.split('\n')
  const out: Array<{ riga: number; testo: string }> = []
  const re = /(['"`])uscito\1|(['"`])\{[^'"`}]*\buscito\b[^'"`}]*\}\2/g
  let m: RegExpExecArray | null
  while ((m = re.exec(senzaCommenti)) !== null) {
    const riga = senzaCommenti.slice(0, m.index).split('\n').length
    out.push({ riga, testo: righe[riga - 1].trim() })
  }
  return out
}

/** Gli usi di una costante ammessa che NON sono la dichiarazione né un `.includes(`: sarebbero un modo di scrivere `uscito` senza il letterale. */
export function usiNonAmmessiDelleCostanti(senzaCommenti: string, nomi: readonly string[]): Array<{ riga: number; testo: string }> {
  const righe = senzaCommenti.split('\n')
  const out: Array<{ riga: number; testo: string }> = []
  for (const nome of nomi) {
    const re = new RegExp(`\\b${nome}\\b`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(senzaCommenti)) !== null) {
      const prima = senzaCommenti.slice(Math.max(0, m.index - 7), m.index)
      const dopo = senzaCommenti.slice(m.index + nome.length, m.index + nome.length + 11)
      if (/const\s$/.test(prima) || dopo.startsWith('.includes(')) continue
      const riga = senzaCommenti.slice(0, m.index).split('\n').length
      out.push({ riga, testo: righe[riga - 1].trim() })
    }
  }
  return out
}

/** Confronta le occorrenze trovate con l'elenco chiuso: restituisce le violazioni (occorrenza non elencata, voce stantia o di troppo). */
export function confrontaConElenco(
  trovate: Array<{ file: string; funzione: string | null; riga: number; testo: string }>,
  elenco: VoceElenco[],
  ammessa: (funzione: string | null) => boolean,
): string[] {
  const residuo = elenco.map((v) => v.n)
  const violazioni: string[] = []
  for (const t of trovate) {
    if (ammessa(t.funzione)) continue
    const i = elenco.findIndex((v, k) => residuo[k] > 0 && v.file === t.file && v.funzione === t.funzione && t.testo.includes(v.contiene))
    if (i < 0) { violazioni.push(`${t.file}:${t.riga} — \`uscito\` fuori da passaggio_* e dall'elenco delle letture (${t.funzione ?? 'fuori da ogni funzione'}): ${t.testo.slice(0, 90)}`); continue }
    residuo[i]--
  }
  elenco.forEach((v, k) => { if (residuo[k] > 0) violazioni.push(`voce stantia dell'elenco: ${v.file} (${v.funzione ?? 'fuori da ogni funzione'}) «${v.contiene}» ne aspettava ${v.n}, ne ha trovate ${v.n - residuo[k]}`) })
  return violazioni
}

describe('uscito-lo-scrive-solo-il-passaggio · ogni letterale `uscito` sta nel passaggio o in un elenco chiuso di letture', () => {
  it('in src/ nessun letterale `uscito` fuori dall\'elenco delle letture', () => {
    const files = fileSorgente(path.join(CWD, 'src'))
    expect(files.length, 'file di src/ esaminati').toBeGreaterThanOrEqual(MIN_FILE_SRC)
    const trovate: Array<{ file: string; funzione: string | null; riga: number; testo: string }> = []
    const usiCostanti: string[] = []
    for (const f of files) {
      const m = mascheraSorgente(fs.readFileSync(f, 'utf8'))
      for (const o of occorrenzeUscitoTs(m.senzaCommenti)) trovate.push({ file: path.relative(CWD, f), funzione: null, ...o })
      for (const u of usiNonAmmessiDelleCostanti(m.senzaCommenti, COSTANTI_AMMESSE)) usiCostanti.push(`${path.relative(CWD, f)}:${u.riga} — costante di stati chiusi usata per altro che \`.includes(\`: ${u.testo.slice(0, 90)}`)
    }
    expect(usiCostanti, 'le costanti con `uscito` si interrogano soltanto').toEqual([])
    process.stdout.write(`[uscito-lock] src/: ${files.length} file esaminati, ${trovate.length} letterali \`uscito\`, ${LETTURE_TS.length} voci nell'elenco\n`)
    expect(trovate.length, 'letterali visti (almeno le due liste di stati chiusi)').toBeGreaterThanOrEqual(LETTURE_TS.length)
    expect(confrontaConElenco(trovate, LETTURE_TS, () => false)).toEqual([])
  })

  it('nelle migrazioni un letterale `uscito` sta solo nel corpo di una public.passaggio_* o nell\'elenco delle letture', () => {
    const dir = path.join(CWD, 'supabase', 'migrations')
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()
    expect(files.length, 'migrazioni esaminate').toBeGreaterThanOrEqual(MIN_MIGRAZIONI)
    const trovate: Array<{ file: string; funzione: string | null; riga: number; testo: string }> = []
    for (const n of files) for (const o of occorrenzeUscitoSql(fs.readFileSync(path.join(dir, n), 'utf8'))) trovate.push({ file: n, ...o })
    const nelPassaggio = trovate.filter((t) => FUNZIONI_PASSAGGIO.includes(t.funzione ?? '')).length
    process.stdout.write(`[uscito-lock] migrazioni: ${files.length} file esaminati, ${trovate.length} letterali \`uscito\` (${nelPassaggio} nel corpo di una passaggio_*, ${LETTURE_SQL.length} voci nell'elenco)\n`)
    // La scrittura vera esiste (passaggio_conferma): se il lock non ne vede nemmeno una, non vede più niente.
    expect(nelPassaggio, 'letterali visti dentro una passaggio_* (almeno quello di passaggio_conferma)').toBeGreaterThanOrEqual(1)
    expect(confrontaConElenco(trovate, LETTURE_SQL, (f) => FUNZIONI_PASSAGGIO.includes(f ?? ''))).toEqual([])
  })

  it('controllo positivo SQL: ogni forma di scrittura fuori dal passaggio è vista, e viene attribuita alla funzione giusta', () => {
    const fn = (corpo: string) => `CREATE OR REPLACE FUNCTION public.archivia_finta() RETURNS void AS $$\nDECLARE v_s text;\nBEGIN\n  ${corpo}\nEND $$ LANGUAGE plpgsql;`
    const forme: Array<[string, string]> = [
      ['UPDATE … SET stato = \'uscito\'', fn(`UPDATE public.frequenze f SET stato = 'uscito' WHERE f.id = 1;`)],
      ['CASE', fn(`UPDATE public.frequenze f SET stato = CASE WHEN true THEN 'uscito' ELSE f.stato END WHERE f.id = 1;`)],
      ['format()', fn(`EXECUTE format('UPDATE public.frequenze SET stato = %L WHERE id = $1', 'uscito') USING 1;`)],
      ['EXECUTE con apici raddoppiati', fn(`EXECUTE 'UPDATE public.frequenze SET stato = ''uscito'' WHERE id = 1';`)],
      ['jsonb_populate_record', fn(`UPDATE public.frequenze f SET stato = r.stato FROM jsonb_populate_record(NULL::public.frequenze, jsonb_build_object('stato', 'uscito')) r WHERE f.id = 1;`)],
      ['variabile', fn(`v_s := 'uscito'; UPDATE public.frequenze SET stato = v_s WHERE id = 1;`)],
      ['sottoquery con FROM prima di stato', fn(`UPDATE public.frequenze f SET data_uscita = (SELECT max(a.fine) FROM public.anni_sede a), stato = 'uscito' WHERE f.id = 1;`)],
      ['INSERT … SELECT', fn(`INSERT INTO public.frequenze (alunno_id, stato) SELECT 1, 'uscito';`)],
      ['INSERT … VALUES', `INSERT INTO public.frequenze (alunno_id, stato) VALUES (1, 'uscito');`],
      ['virgolette doppie', fn(`UPDATE public.frequenze SET "stato" = "uscito" WHERE id = 1;`)],
      ['stringa fra dollari', fn(`v_s := $q$uscito$q$; UPDATE public.frequenze SET stato = v_s WHERE id = 1;`)],
      ['letterale d\'array', fn(`UPDATE public.frequenze SET stato = (ARRAY['{uscito}'::text])[1] WHERE id = 1;`)],
      ['array con altri valori', fn(`v_s := ('{ritirato,uscito}'::text[])[2];`)],
    ]
    const ciechi = forme.filter(([, sql]) => occorrenzeUscitoSql(sql).length === 0).map(([nome]) => nome)
    expect(ciechi, 'forme che il lock non vede').toEqual([])
    for (const [nome, sql] of forme.filter(([nome]) => nome !== 'INSERT … VALUES')) {
      expect(occorrenzeUscitoSql(sql).map((x) => x.funzione), nome).toEqual(['archivia_finta'])
    }
    expect(occorrenzeUscitoSql(`INSERT INTO public.frequenze (alunno_id, stato) VALUES (1, 'uscito');`).map((x) => x.funzione), 'fuori da ogni funzione').toEqual([null])
    // Una passaggio_* NON elencata non è ammessa per nome: l'elenco è chiuso.
    const nuova = `CREATE OR REPLACE FUNCTION public.passaggio_nuova() RETURNS void AS $$ BEGIN UPDATE public.frequenze SET stato = 'uscito'; END $$ LANGUAGE plpgsql;`
    const trovata = occorrenzeUscitoSql(nuova).map((x) => ({ file: 'x.sql', funzione: x.funzione, riga: x.riga, testo: x.testo }))
    expect(confrontaConElenco(trovata, [], (f) => FUNZIONI_PASSAGGIO.includes(f ?? '')), 'passaggio_nuova non è nell\'elenco chiuso').toHaveLength(1)
    expect(confrontaConElenco(trovata.map((t) => ({ ...t, funzione: 'passaggio_conferma' })), [], (f) => FUNZIONI_PASSAGGIO.includes(f ?? '')), 'passaggio_conferma sì').toEqual([])
  })

  it('controllo positivo SQL: l\'attribuzione alla passaggio_* vale solo DENTRO il suo corpo', () => {
    const dentro = `CREATE OR REPLACE FUNCTION public.passaggio_conferma() RETURNS void AS $$ BEGIN\n  UPDATE public.frequenze f SET stato = 'uscito' WHERE f.id = 1; END $$ LANGUAGE plpgsql;`
    expect(occorrenzeUscitoSql(dentro).map((x) => x.funzione)).toEqual(['passaggio_conferma'])
    // Dopo la fine del corpo non è più della funzione, anche se la funzione è la più vicina sopra.
    const dopo = `${dentro}\nUPDATE public.frequenze SET stato = 'uscito' WHERE id = 1;`
    expect(occorrenzeUscitoSql(dopo).map((x) => x.funzione)).toEqual(['passaggio_conferma', null])
    // Un corpo con un altro tag `$q$` annidato non ne sposta la fine.
    const annidato = `CREATE OR REPLACE FUNCTION public.passaggio_x() RETURNS void AS $f$ BEGIN\n  EXECUTE $q$ SELECT 1 $q$; END $f$ LANGUAGE plpgsql;\nUPDATE public.frequenze SET stato = 'uscito';`
    expect(occorrenzeUscitoSql(annidato).map((x) => x.funzione)).toEqual([null])
    // Una funzione dopo una passaggio_*: la sua scrittura è sua.
    const poi = `${dentro}\nCREATE OR REPLACE FUNCTION public.archivia_qualcosa() RETURNS void AS $$ BEGIN UPDATE public.frequenze SET stato = 'uscito'; END $$ LANGUAGE plpgsql;`
    expect(occorrenzeUscitoSql(poi).map((x) => x.funzione)).toEqual(['passaggio_conferma', 'archivia_qualcosa'])
    // Commenti e prosa non sono letterali.
    expect(occorrenzeUscitoSql(`-- UPDATE public.frequenze SET stato = 'uscito'\n/* 'uscito' */\nCOMMENT ON TABLE public.t IS 'il file e'' uscito da qui';`)).toEqual([])
    // Una lettura dentro l'elenco chiuso passa; una identica con un altro testo, no; una voce stantia si vede.
    const lettura = [{ file: 'x.sql', funzione: 'anno_invarianti', riga: 1, testo: "f.stato IN (''uscito'')" }]
    const elenco: VoceElenco[] = [{ file: 'x.sql', funzione: 'anno_invarianti', contiene: 'f.stato IN (', n: 1, perche: 'prova' }]
    expect(confrontaConElenco(lettura, elenco, () => false)).toEqual([])
    expect(confrontaConElenco([...lettura, ...lettura], elenco, () => false), 'una seconda occorrenza uguale non è elencata').toHaveLength(1)
    expect(confrontaConElenco([{ ...lettura[0], testo: "SET stato = 'uscito'" }], elenco, () => false).length, 'una scrittura con altro testo + la voce rimasta stantia').toBe(2)
    expect(confrontaConElenco([], elenco, () => false), 'voce stantia').toHaveLength(1)
  })

  it('controllo positivo TypeScript: ogni forma di scrittura è vista (oggetto, chiave fra apici, costante, parametro di RPC, template, virgolette doppie)', () => {
    const forme: Array<[string, string]> = [
      ['oggetto', `await s.from('frequenze').update({ stato: 'uscito' })`],
      ['chiave fra apici', `await s.from('frequenze').update({ 'stato': 'uscito' })`],
      ['costante', `const USCITO = 'uscito'\nawait s.from('frequenze').update({ stato: USCITO })`],
      ['parametro di rpc', `await s.rpc('anno_registra_frequenza', { p_stato: 'uscito' })`],
      ['template', 'await s.from(\'frequenze\').update({ stato: `uscito` })'],
      ['virgolette doppie', `await s.from("frequenze").update({ stato: "uscito" })`],
      ['valore calcolato', `const nuovo = ok ? 'uscito' : 'ritirato'\nawait s.from('frequenze').update({ stato: nuovo })`],
      ['elenco', `await s.from('frequenze').update({ stato: ['uscito'][0] })`],
      ['letterale d\'array', `await s.rpc('x', { p_stati: '{uscito}' })`],
      ['letterale d\'array con altri valori', `const a = "{ritirato,uscito}"`],
    ]
    const ciechi = forme.filter(([, t]) => occorrenzeUscitoTs(t).length === 0).map(([nome]) => nome)
    expect(ciechi, 'forme che il lock non vede').toEqual([])
    // Una costante ammessa riusata per scrivere è vista; l'uso ammesso (`.includes(`) e la dichiarazione no.
    expect(usiNonAmmessiDelleCostanti(`const STATI_CHIUSI = ['ritirato']\nif (STATI_CHIUSI.includes(x)) {}`, COSTANTI_AMMESSE)).toEqual([])
    expect(usiNonAmmessiDelleCostanti(`await s.from('frequenze').update({ stato: STATI_CHIUSI[2] })`, COSTANTI_AMMESSE), 'indice').toHaveLength(1)
    expect(usiNonAmmessiDelleCostanti(`const g = STATI_FREQUENZA_CHIUSI\nawait s.rpc('x', { p_stato: g[2] })`, COSTANTI_AMMESSE), 'alias').toHaveLength(1)
    expect(usiNonAmmessiDelleCostanti(`s.in('stato', STATI_CHIUSI)`, COSTANTI_AMMESSE), 'passata a una query').toHaveLength(1)
    // I commenti li toglie la maschera prima: un commento che spiega non è una scrittura.
    expect(occorrenzeUscitoTs(mascheraSorgente(`// stato: 'uscito'\n/* 'uscito' */\nconst a = 1`).senzaCommenti)).toEqual([])
    // Una lettura (filtro) fuori dall'elenco è comunque segnalata: l'elenco è chiuso.
    expect(occorrenzeUscitoTs(`await s.from('frequenze').select('id').eq('stato', 'uscito')`)).toHaveLength(1)
  })
})
