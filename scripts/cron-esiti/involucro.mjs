/**
 * Involucro dei cron — sessione 6 della seconda serie di robustezza.
 *
 * Le funzioni che i job di pg_cron usano per chiamare il server mandano la richiesta con
 * `net.http_post(…)` e buttano via il numero che pg_net restituisce: la risposta arriva dopo, in
 * `net._http_response`, e nessuno sa più di quale job fosse. Questo modulo riscrive ciascuna di
 * quelle funzioni cambiando UNA cosa sola: `net.http_post(` diventa
 * `public.cron_http_post('<job>', `. L'involucro ha gli stessi argomenti e gli stessi default di
 * `net.http_post` dopo il nome del job, quindi URL, corpo, header e timeout restano quelli di oggi.
 *
 * La fonte è la PRODUZIONE (`pg_get_functiondef`, misura 0.6 del piano), mai il repo: il rischio
 * della sessione è proprio un corpo copiato dal repo che in produzione era diverso.
 *
 * Uso (dalla radice del repo):
 *   node scripts/cron-esiti/involucro.mjs confronta /tmp/kidville-s06-definizioni-*.json
 *   node scripts/cron-esiti/involucro.mjs genera    /tmp/kidville-s06-definizioni-*.json > blocco.sql
 *   node scripts/cron-esiti/involucro.mjs inversa   supabase/migrations/<version>_cron_esiti_osservati.sql
 *   node scripts/cron-esiti/involucro.mjs impronte
 * Ogni caso che non sa trattare lo FERMA con un messaggio (uscita 1): non indovina mai.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const INVOLUCRO = 'cron_http_post'
export const LETTORE = 'cron_esiti'

/** Funzioni del repo che chiamano `net.http_post` nella loro ultima definizione, contate il 2026-10-20. */
export const FUNZIONI_HTTP_AL_20_10 = 20

/** Funzioni che chiamano il server e che di proposito NON si avvolgono, con la ragione. */
export const NON_SI_AVVOLGONO = Object.freeze({
  genera_solleciti:
    'DEPRECATA dal 2026-07-10 (20260710140000_contabilita_solleciti.sql), nessun job la chiama e nessun codice la usa; ' +
    "è SECURITY INVOKER, quindi avvolgerla chiederebbe di dare a service_role l'esecuzione dell'involucro: " +
    'una porta in più verso pg_net per una funzione che non gira mai.',
})

/** Funzioni che nel repo chiamano il server e in produzione no (Compito 3): non si ridefiniscono. */
export const ASSENTI_IN_PRODUZIONE = Object.freeze({})

/** Quante funzioni la migrazione deve ridefinire almeno. */
export function minimoAvvolte() {
  return FUNZIONI_HTTP_AL_20_10 - Object.keys(NON_SI_AVVOLGONO).length - Object.keys(ASSENTI_IN_PRODUZIONE).length
}

const DIRETTA = 'net.http_post('
const AVVOLTA = 'public.cron_http_post('
const ETICHETTA = /^[a-z0-9][a-z0-9-]*$/
const QUALSIASI_DIRETTA = /\bnet\s*\.\s*http_post\s*\(/gi
const QUALSIASI_AVVOLTA = /\bpublic\s*\.\s*cron_http_post\s*\(/gi
const PRIMA_DIRETTA = /\bnet\s*\.\s*http_post\s*\(/i
const PRIMA_AVVOLTA = /\bpublic\s*\.\s*cron_http_post\s*\(/i
const APRE_CORPO = /\bAS\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/i
const TAG_DOLLARO = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y
const CREA = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi
const TOGLIE = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:\(|;|,)/gi
const CREA_IN_TESTA = /\bCREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi
const PERMESSI_DOPO = /^\s*((?:(?:REVOKE|GRANT)\b[^;]*;\s*)*)/i

export const md5 = (testo) => createHash('md5').update(testo, 'utf8').digest('hex')

const ordina = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Lo stesso testo con commenti (`--`, `/* *\/` anche annidati) e — se `stringhe` — stringhe fra
 * apici e corpi `$tag$…$tag$` sostituiti da spazi. Lunghezza e a capo restano: un indice nel testo
 * mascherato vale anche nell'originale.
 */
export function mascheraSql(sql, { stringhe = true } = {}) {
  const out = sql.split('')
  const spegni = (da, a) => {
    for (let k = da; k < a; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const d = sql[i + 1]
    if (c === '-' && d === '-') {
      const fine = sql.indexOf('\n', i)
      const a = fine === -1 ? sql.length : fine
      spegni(i, a)
      i = a
      continue
    }
    if (c === '/' && d === '*') {
      let profondita = 1
      let k = i + 2
      while (k < sql.length && profondita > 0) {
        if (sql[k] === '/' && sql[k + 1] === '*') { profondita++; k += 2 }
        else if (sql[k] === '*' && sql[k + 1] === '/') { profondita--; k += 2 }
        else k++
      }
      spegni(i, k)
      i = k
      continue
    }
    if (c === "'") {
      const conBarra = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]))
      let k = i + 1
      while (k < sql.length) {
        if (conBarra && sql[k] === '\\') { k += 2; continue }
        if (sql[k] === "'") {
          if (sql[k + 1] === "'") { k += 2; continue }
          break
        }
        k++
      }
      const a = Math.min(k + 1, sql.length)
      if (stringhe) spegni(i, a)
      i = a
      continue
    }
    if (c === '$' && (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]))) {
      TAG_DOLLARO.lastIndex = i
      const m = TAG_DOLLARO.exec(sql)
      if (m) {
        const fine = sql.indexOf(m[0], i + m[0].length)
        const a = fine === -1 ? sql.length : fine + m[0].length
        if (stringhe) spegni(i, a)
        i = a
        continue
      }
    }
    i++
  }
  return out.join('')
}

/** Commenti e spazi non contano, le stringhe sì. */
export const normalizza = (corpo) => mascheraSql(corpo, { stringhe: false }).replace(/\s+/g, ' ').trim()

/** Testata fino a `AS $tag$` compreso, corpo, tag di chiusura, coda. */
export function corpoDi(def) {
  const m = APRE_CORPO.exec(mascheraSql(def, { stringhe: false }))
  if (!m) throw new Error('definizione senza corpo «AS $tag$»')
  const tag = m[1]
  const inizio = m.index + m[0].length
  const fine = def.indexOf(tag, inizio)
  if (fine === -1) throw new Error(`corpo aperto da ${tag} e mai chiuso`)
  return { testata: def.slice(0, inizio), tag, corpo: def.slice(inizio, fine), coda: def.slice(fine + tag.length) }
}

/** Il corpo, o '' per una funzione scritta fra apici (non chiama il server: non c'è niente da cercare). */
export function corpoOVuoto(def) {
  return APRE_CORPO.test(mascheraSql(def, { stringhe: false })) ? corpoDi(def).corpo : ''
}

/** Chiamate dirette e avvolte nel CODICE del corpo: commenti e stringhe non contano. */
export function contaChiamate(corpo) {
  const codice = mascheraSql(corpo)
  return {
    dirette: (codice.match(QUALSIASI_DIRETTA) ?? []).length,
    avvolte: (codice.match(QUALSIASI_AVVOLTA) ?? []).length,
  }
}

export function avvolgi(def, job) {
  if (!ETICHETTA.test(job)) throw new Error(`etichetta non valida «${job}»`)
  const { testata, tag, corpo, coda } = corpoDi(def)
  const { dirette, avvolte } = contaChiamate(corpo)
  if (avvolte > 0) throw new Error("il corpo passa già dall'involucro")
  if (dirette !== 1) throw new Error(`attesa UNA chiamata a net.http_post nel codice, trovate ${dirette}`)
  const m = PRIMA_DIRETTA.exec(mascheraSql(corpo))
  const trovata = corpo.slice(m.index, m.index + m[0].length)
  if (trovata !== DIRETTA) throw new Error(`forma non canonica «${trovata}»: si avvolge solo «${DIRETTA}»`)
  return testata + corpo.slice(0, m.index) + `${AVVOLTA}'${job}', ` + corpo.slice(m.index + DIRETTA.length) + tag + coda
}

export function svolgi(def) {
  const { testata, tag, corpo, coda } = corpoDi(def)
  const { dirette, avvolte } = contaChiamate(corpo)
  if (avvolte !== 1 || dirette !== 0) {
    throw new Error(`attese UNA chiamata all'involucro e nessuna diretta, trovate ${avvolte} e ${dirette}`)
  }
  const m = PRIMA_AVVOLTA.exec(mascheraSql(corpo))
  const resto = corpo.slice(m.index)
  const e = /^public\.cron_http_post\('([a-z0-9][a-z0-9-]*)', /.exec(resto)
  if (!e) throw new Error("forma non canonica: si svolge solo «public.cron_http_post('<job>', »")
  return { definizione: testata + corpo.slice(0, m.index) + DIRETTA + resto.slice(e[0].length) + tag + coda, job: e[1] }
}

/** Il nome del job che chiama la funzione; senza job (trigger, route) il nome della funzione. */
export function etichetta({ proname, job }) {
  if (job.length === 1) return job[0]
  if (job.length === 0) return proname.replace(/_/g, '-')
  throw new Error(`${proname}: la chiamano ${job.length} job (${job.join(', ')}), l'etichetta non sarebbe univoca`)
}

const SOSPETTI = [
  ['un token dopo «Bearer»', /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ['un JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['una chiave Supabase', /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/],
  ['una chiave di un fornitore', /\b(?:sk|rk|re)_(?:live_|test_)?[A-Za-z0-9]{16,}/],
  ['un indirizzo email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['un codice fiscale', /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/i],
]

/** Cosa, nel testo, non può finire in un repository pubblico. */
export const sospetti = (testo) => SOSPETTI.filter(([, re]) => re.test(testo)).map(([nome]) => nome)

const CAMPI_TESTO = ['proname', 'definizione', 'impronta', 'tipi', 'proprietario']
const CAMPI_SI_NO = ['security_definer', 'anon', 'authenticated', 'service_role']

/** Le righe della misura 0.6, da uno o più file JSON, controllate campo per campo. */
export function leggiRighe(testi) {
  const righe = []
  const visti = new Set()
  testi.forEach((testo, i) => {
    const dati = JSON.parse(testo)
    if (!Array.isArray(dati)) throw new Error(`il file ${i + 1} non contiene un array JSON (si salva il valore di «righe», misura 0.6)`)
    for (const r of dati) {
      const nome = typeof r?.proname === 'string' ? r.proname : '(senza nome)'
      for (const c of CAMPI_TESTO) if (typeof r[c] !== 'string') throw new Error(`${nome}: «${c}» deve essere un testo`)
      for (const c of CAMPI_SI_NO) if (typeof r[c] !== 'boolean') throw new Error(`${nome}: «${c}» deve essere vero o falso`)
      if (!Array.isArray(r.job) || r.job.some((j) => typeof j !== 'string')) throw new Error(`${nome}: «job» deve essere un array di testi`)
      if (visti.has(nome)) throw new Error(`${nome}: compare due volte (i file della misura 0.6 si sovrappongono?)`)
      if (md5(r.definizione) !== r.impronta) throw new Error(`${nome}: l'impronta non torna — definizione trascritta male, si risalva il JSON`)
      visti.add(nome)
      righe.push(r)
    }
  })
  return righe
}

/** Il blocco SQL che ridefinisce le funzioni, e l'elenco motivato di quelle saltate. */
export function genera(righe) {
  const blocchi = []
  const saltate = []
  for (const r of [...righe].sort((a, b) => ordina(a.proname, b.proname))) {
    const nome = r.proname
    if (nome === INVOLUCRO || nome === LETTORE) throw new Error(`${nome}: esiste già in produzione — STOP (misura 0.11)`)
    const { dirette, avvolte } = contaChiamate(corpoOVuoto(r.definizione))
    if (avvolte > 0) throw new Error(`${nome}: il corpo passa già dall'involucro — STOP`)
    if (dirette === 0) { saltate.push(`${nome}: cita net.http_post solo in commenti o stringhe`); continue }
    if (Object.hasOwn(NON_SI_AVVOLGONO, nome)) { saltate.push(`${nome}: ${NON_SI_AVVOLGONO[nome]}`); continue }
    if (r.proprietario !== 'postgres') throw new Error(`${nome}: proprietario «${r.proprietario}», atteso postgres — STOP`)
    if (!r.security_definer) throw new Error(`${nome}: è SECURITY INVOKER, e l'involucro non è eseguibile da chi la chiama — STOP`)
    if (r.anon || r.authenticated) throw new Error(`${nome}: in produzione è eseguibile da anon o authenticated — STOP`)
    const trovati = sospetti(r.definizione)
    if (trovati.length > 0) throw new Error(`${nome}: possibile ${trovati.join(', ')} nel corpo — il repository è pubblico: STOP`)
    const job = etichetta(r)
    const firma = `public.${nome}(${r.tipi})`
    blocchi.push(
      [
        `-- ${nome} · etichetta «${job}» · pg_get_functiondef, impronta ${r.impronta}`,
        avvolgi(r.definizione.trimEnd(), job) + ';',
        '',
        `REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC, anon, authenticated;`,
        ...(r.service_role ? [`GRANT EXECUTE ON FUNCTION ${firma} TO service_role;`] : []),
      ].join('\n'),
    )
  }
  return { sql: blocchi.join('\n\n') + (blocchi.length > 0 ? '\n' : ''), saltate }
}

/** Ultima definizione di ogni funzione di `public`, file per file e nell'ordine del file. */
export function ultimeDefinizioniDa(file) {
  const mappa = new Map()
  for (const { nome, sql } of file) {
    const codice = mascheraSql(sql)
    const eventi = [
      ...[...codice.matchAll(CREA)].map((m) => ({ crea: true, funzione: m[1].toLowerCase(), da: m.index })),
      ...[...codice.matchAll(TOGLIE)].map((m) => ({ crea: false, funzione: m[1].toLowerCase(), da: m.index })),
    ].sort((a, b) => a.da - b.da)
    for (const e of eventi) {
      if (!e.crea) { mappa.delete(e.funzione); continue }
      const fine = codice.indexOf(';', e.da)
      mappa.set(e.funzione, { file: nome, definizione: sql.slice(e.da, fine === -1 ? sql.length : fine).trim() })
    }
  }
  return mappa
}

export function ultimeDefinizioni(cartella) {
  const file = readdirSync(cartella)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((nome) => ({ nome, sql: readFileSync(join(cartella, nome), 'utf8') }))
  return ultimeDefinizioniDa(file)
}

/** Produzione contro repo, funzione per funzione. */
export function confronta(righe, repo) {
  const esiti = []
  const inProduzione = new Set()
  for (const r of righe) {
    inProduzione.add(r.proname)
    const nelRepo = repo.get(r.proname)
    if (!nelRepo) { esiti.push({ funzione: r.proname, esito: 'solo-in-produzione', file: '' }); continue }
    const a = corpoOVuoto(r.definizione)
    const b = corpoOVuoto(nelRepo.definizione)
    const esito = a === b ? 'identico' : normalizza(a) === normalizza(b) ? 'uguale-a-meno-di-commenti-e-spazi' : 'diverso'
    esiti.push({ funzione: r.proname, esito, file: nelRepo.file })
  }
  for (const [nome, { file, definizione }] of repo) {
    if (inProduzione.has(nome) || nome === INVOLUCRO || nome === LETTORE) continue
    const { dirette, avvolte } = contaChiamate(corpoOVuoto(definizione))
    if (dirette + avvolte > 0) esiti.push({ funzione: nome, esito: 'solo-nel-repo', file })
  }
  return esiti.sort((x, y) => ordina(x.funzione, y.funzione))
}

/** «nome<TAB>md5 del corpo» per le funzioni del repo che nominano il server: si confronta con md5(prosrc). */
export function impronteDelRepo(repo) {
  const righe = []
  for (const [nome, { definizione }] of repo) {
    const corpo = corpoOVuoto(definizione)
    if (/(net\s*\.\s*http_post|cron_http_post)/i.test(corpo)) righe.push(`${nome}\t${md5(corpo)}`)
  }
  return righe.sort(ordina)
}

/** La migrazione inversa: definizioni di prima coi loro permessi, poi job, funzioni e tabelle via. */
export function inversa(migrazione) {
  const codice = mascheraSql(migrazione)
  const pezzi = []
  for (const m of codice.matchAll(CREA_IN_TESTA)) {
    const nome = m[1].toLowerCase()
    if (nome === INVOLUCRO || nome === LETTORE) continue
    const fine = codice.indexOf(';', m.index)
    // Il `\s*` della regex mangia anche i commenti che seguono (mascherati, sono spazi): l'intestazione
    // del blocco dopo, `-- == IL LETTORE ==`. Il pezzo finisce all'ultimo `;` dei suoi permessi.
    const permessi = PERMESSI_DOPO.exec(codice.slice(fine + 1))[0].lastIndexOf(';') + 1
    pezzi.push(
      `${svolgi(migrazione.slice(m.index, fine).trimEnd()).definizione};\n\n` +
        migrazione.slice(fine + 1, fine + 1 + permessi).trim(),
    )
  }
  if (pezzi.length === 0) throw new Error('nessuna funzione avvolta nel file: è la migrazione della sessione 6?')
  return [
    '-- Migrazione inversa della sessione 6 (seconda serie di robustezza), generata con',
    '-- `node scripts/cron-esiti/involucro.mjs inversa`: rimette le funzioni come erano in produzione',
    '-- prima del merge, coi loro permessi; poi spegne il lettore e toglie involucro e registri.',
    '',
    pezzi.join('\n\n'),
    '',
    'DO $$',
    'BEGIN',
    "  IF to_regnamespace('cron') IS NOT NULL THEN",
    "    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-esiti';",
    '  END IF;',
    'END',
    '$$;',
    '',
    'DROP FUNCTION IF EXISTS public.cron_esiti();',
    'DROP FUNCTION IF EXISTS public.cron_http_post(text, text, jsonb, jsonb, jsonb, integer);',
    '',
    '-- distruttiva approvata: si tolgono i due registri degli esiti dei cron creati dalla sessione 6, su richiesta del titolare',
    'DROP TABLE IF EXISTS public.cron_ultimo_esito;',
    'DROP TABLE IF EXISTS public.cron_chiamate;',
    '',
    "NOTIFY pgrst, 'reload schema';",
    '',
  ].join('\n')
}

function principale(argomenti) {
  const [comando, ...resto] = argomenti
  const cartella = join(process.cwd(), 'supabase/migrations')
  if (comando === 'genera' || comando === 'confronta') {
    if (resto.length === 0) throw new Error(`uso: node scripts/cron-esiti/involucro.mjs ${comando} <definizioni-1.json> [altri file]`)
    const righe = leggiRighe(resto.map((f) => readFileSync(f, 'utf8')))
    if (comando === 'confronta') {
      for (const e of confronta(righe, ultimeDefinizioni(cartella))) process.stdout.write(`${e.funzione}\t${e.esito}\t${e.file}\n`)
      return
    }
    const { sql, saltate } = genera(righe)
    for (const s of saltate) process.stderr.write(`saltata — ${s}\n`)
    process.stderr.write(`ridefinite: ${righe.length - saltate.length}\n`)
    process.stdout.write(sql)
    return
  }
  if (comando === 'inversa' && resto.length === 1) {
    process.stdout.write(inversa(readFileSync(resto[0], 'utf8')))
    return
  }
  if (comando === 'impronte') {
    process.stdout.write(impronteDelRepo(ultimeDefinizioni(cartella)).join('\n') + '\n')
    return
  }
  throw new Error('uso: node scripts/cron-esiti/involucro.mjs confronta|genera <json…> · inversa <migrazione.sql> · impronte')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    principale(process.argv.slice(2))
  } catch (errore) {
    process.stderr.write(`involucro: ${errore instanceof Error ? errore.message : String(errore)}\n`)
    process.exitCode = 1
  }
}
