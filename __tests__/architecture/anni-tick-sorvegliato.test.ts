import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  JOB_CRON,
  JOB_CRON_NON_SORVEGLIATI,
  ESITI_BATTITO,
  ESITI_BATTITO_PER_OPERAZIONE,
  valeComeBattito,
} from '@/lib/health/controlli'

/**
 * COMPITO 4.5.12 · I DUE LAVORI NOTTURNI DELL'ANNO SONO SORVEGLIATI, E IL LORO BATTITO È UN BATTITO.
 *
 * `anni-tick` (ogni ora) e `anno-invarianti` (ogni notte) sono job `pg_cron` di sola SQL. Un job che non batte è
 * indistinguibile da un job che non è mai partito: per questo ognuno scrive una riga `cron:<nome>` in `app_log` a ogni giro, e
 * `/api/health` (`cron-battito`) la cerca. Quella catena ha quattro anelli, e basta che uno si sposti perché l'allarme tacia:
 *
 *  1. il NOME è in una delle due liste di `controlli.ts` — `JOB_CRON` (sorvegliato dal battito) o `JOB_CRON_NON_SORVEGLIATI`
 *     (con la ragione) — e in UNA sola: in nessuna è «dimenticato», in entrambe è contraddittorio;
 *  2. il nome del `cron.schedule` della migrazione M45a è quello, e lancia la funzione giusta;
 *  3. il battito che la funzione scrive porta `operazione` uguale al nome, `evento` `cron` e livello `info`/`warn`, che sono
 *     le righe che `cron-battito` legge (le `error` non le legge);
 *  4. OGNI `esito` di un battito è accettato da `valeComeBattito`. Se la funzione scrive `parziale` e il controllo conosce
 *     `ok-parziale`, il job gira benissimo e `/api/health` lo dichiara muto per sempre.
 *
 * E in senso contrario: gli esiti che NON sono un battito (`creato`, `errore`, `invarianti-non-zero`, `non-programmato`) non
 * devono essere accettati, altrimenti un anno creato o un errore passerebbe per un giro completato; e `ESITI_BATTITO` è
 * l'insieme esatto `ok`, `ok-parziale`: non è stato allargato per far tornare i conti a questi due lavori.
 *
 * Quando il tick passa da `JOB_CRON_NON_SORVEGLIATI` a `JOB_CRON` (PR-B, dopo la rigenerazione della fotografia) questo lock
 * resta verde: dice «in una delle due», non «in questa».
 *
 * ─── PERCHÉ NON È CIECO ───────────────────────────────────────────────────────
 * Dichiara quante righe `app_log` ha letto nella migrazione (6), quanti battiti (2), quanti `cron.schedule` (2) e quanti esiti
 * ha provato, con un MINIMO ATTESO, e ha il suo controllo positivo su SQL finto. Non vede: un esito costruito a runtime
 * (`'esito', v_variabile`), che qui non c'è e che il lock segnala come illeggibile.
 */

const CWD = process.cwd()
const MIGRAZIONE = path.join(CWD, 'supabase', 'migrations', '20261109035209_anno_tick.sql')

/** Il nome del job → la funzione che il suo `cron.schedule` lancia. */
const JOB: Record<string, string> = {
  'anni-tick': 'anni_tick',
  'anno-invarianti': 'anno_invarianti_notturno',
}

const togliCommentiSql = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

// ───────────────────────── la lettura della migrazione ─────────────────────────

interface Schedule { nome: string; cadenza: string; funzione: string }
interface RigaLog {
  livello: string
  evento: string
  fingerprint: string
  operazione: string | null
  /** Gli esiti che la riga può scrivere (un `CASE` ne ha più d'uno); `null` = illeggibile (non è un letterale). */
  esiti: string[] | null
}

function schedule(sql: string): Schedule[] {
  const out: Schedule[] = []
  const re = /cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*\$cron\$\s*SELECT\s+public\.([a-z_]+)\s*\(/gi
  let h: RegExpExecArray | null
  while ((h = re.exec(sql)) !== null) out.push({ nome: h[1], cadenza: h[2], funzione: h[3] })
  return out
}

function nomiDisprogrammati(sql: string): string[] {
  const h = /cron\.unschedule\([^)]*\)\s+FROM\s+cron\.job\s+WHERE\s+jobname\s+IN\s*\(([^)]*)\)/i.exec(sql)
  return h ? [...h[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
}

/** Gli `INSERT INTO public.app_log … VALUES (…)` della migrazione, con livello, evento, fingerprint, operazione ed esiti. */
function righeLog(sql: string): RigaLog[] {
  const out: RigaLog[] = []
  const parti = sql.split(/insert\s+into\s+public\.app_log/i).slice(1)
  for (const p of parti) {
    const stmt = p.slice(0, (/\bon\s+conflict\b|;/i.exec(p)?.index ?? p.length))
    const v = /values\s*\(\s*'([a-z]+)'\s*,\s*'([a-z_]+)'/i.exec(stmt)
    if (!v) continue
    const fp = /'(cron:[a-z-]+|[a-z-]+(?::[^']*)?)'\s*,\s*jsonb_build_object\(\s*'campi'/i.exec(stmt)
    const op = /'operazione'\s*,\s*'([^']+)'/i.exec(stmt)
    let esiti: string[] | null = null
    const caso = /'esito'\s*,\s*CASE\b([\s\S]*?)\bEND\b/i.exec(stmt)
    if (caso) {
      esiti = [...caso[1].matchAll(/\b(?:THEN|ELSE)\s+'([^']+)'/gi)].map((x) => x[1])
      if (esiti.length === 0) esiti = null
    } else {
      const lett = /'esito'\s*,\s*'([^']+)'/i.exec(stmt)
      if (lett) esiti = [lett[1]]
    }
    out.push({ livello: v[1], evento: v[2], fingerprint: fp ? fp[1] : '', operazione: op ? op[1] : null, esiti })
  }
  return out
}

const eBattito = (r: RigaLog) => r.fingerprint.startsWith('cron:')

// ───────────────────────── le regole ─────────────────────────

const inJobCron = (nome: string) => JOB_CRON.some((j) => j.nome === nome)
const inNonSorvegliati = (nome: string) => JOB_CRON_NON_SORVEGLIATI.some((j) => j.nome === nome)

function violazioniListe(nomi: string[], jobCron = inJobCron, nonSorvegliati = inNonSorvegliati): string[] {
  const out: string[] = []
  for (const n of nomi) {
    const a = jobCron(n)
    const b = nonSorvegliati(n)
    if (!a && !b) out.push(`${n} — non è né in JOB_CRON né in JOB_CRON_NON_SORVEGLIATI (src/lib/health/controlli.ts): «dimenticato» e «lasciato fuori apposta» non si distinguono`)
    if (a && b) out.push(`${n} — è in JOB_CRON e anche in JOB_CRON_NON_SORVEGLIATI: scegline una`)
  }
  return out
}

function violazioniSchedule(sql: string): string[] {
  const out: string[] = []
  const s = schedule(sql)
  const attesi = Object.keys(JOB).sort()
  const trovati = s.map((x) => x.nome).sort()
  if (JSON.stringify(trovati) !== JSON.stringify(attesi)) {
    out.push(`i cron.schedule della migrazione sono [${trovati.join(', ')}], quelli attesi [${attesi.join(', ')}]`)
  }
  for (const x of s) {
    if (JOB[x.nome] && JOB[x.nome] !== x.funzione) out.push(`${x.nome} — lancia public.${x.funzione}(), attesa public.${JOB[x.nome]}()`)
  }
  const disprogrammati = nomiDisprogrammati(sql).sort()
  if (JSON.stringify(disprogrammati) !== JSON.stringify(attesi)) {
    out.push(`il cron.unschedule che precede la programmazione nomina [${disprogrammati.join(', ')}], attesi [${attesi.join(', ')}]: rilanciata, la migrazione duplicherebbe un job`)
  }
  return out
}

function violazioniBattiti(sql: string, vale = valeComeBattito): string[] {
  const out: string[] = []
  const righe = righeLog(sql)
  for (const nome of Object.keys(JOB)) {
    const battiti = righe.filter((r) => r.fingerprint === `cron:${nome}`)
    if (battiti.length !== 1) {
      out.push(`${nome} — la migrazione scrive ${battiti.length} battiti \`cron:${nome}\`, ne serve UNO`)
      continue
    }
    const b = battiti[0]
    if (b.operazione !== nome) out.push(`${nome} — il battito porta operazione \`${b.operazione}\`: cron-battito legge l'operazione, deve essere \`${nome}\``)
    if (b.evento !== 'cron') out.push(`${nome} — il battito ha evento \`${b.evento}\`, cron-battito legge \`cron\``)
    if (b.livello !== 'info' && b.livello !== 'warn') out.push(`${nome} — il battito ha livello \`${b.livello}\`: cron-battito legge solo info e warn`)
    if (b.esiti === null) {
      out.push(`${nome} — l'esito del battito non è un letterale o un CASE di letterali: il lock non lo legge`)
      continue
    }
    for (const e of b.esiti) {
      if (!vale(nome, e)) out.push(`${nome} — scrive l'esito \`${e}\` e valeComeBattito(\`${nome}\`, \`${e}\`) è false: il job girerebbe e /api/health lo direbbe muto`)
    }
  }
  return out
}

function violazioniNonBattiti(sql: string, vale = valeComeBattito): string[] {
  const out: string[] = []
  for (const r of righeLog(sql)) {
    if (eBattito(r) || !r.operazione) continue
    if (r.livello !== 'info' && r.livello !== 'warn') continue // le `error` cron-battito non le legge
    for (const e of r.esiti ?? []) {
      if (vale(r.operazione, e)) out.push(`${r.operazione} — la riga \`${r.fingerprint}\` (esito \`${e}\`, livello ${r.livello}) passerebbe per un battito`)
    }
  }
  return out
}

// ───────────────────────── le misure ─────────────────────────

const SQL = togliCommentiSql(fs.readFileSync(MIGRAZIONE, 'utf8'))
const RIGHE = righeLog(SQL)
const BATTITI = RIGHE.filter(eBattito)
const SCHEDULE = schedule(SQL)
const ESITI_PROVATI = BATTITI.flatMap((b) => b.esiti ?? []).length + RIGHE.filter((r) => !eBattito(r)).flatMap((r) => r.esiti ?? []).length

const elenco = (v: string[]) => (v.length ? '\n  - ' + v.join('\n  - ') : '')

/** Una migrazione finta con i due battiti: `esitoTick` è il testo dell'esito del tick (letterale o CASE). */
const finta = (esitoTick: string, evento = 'cron', livello = 'info') => `
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('anni-tick', 'anno-invarianti');
  PERFORM cron.schedule('anni-tick', '10 * * * *', $cron$ SELECT public.anni_tick(); $cron$);
  PERFORM cron.schedule('anno-invarianti', '17 3 * * *', $cron$ SELECT public.anno_invarianti_notturno(); $cron$);
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('${livello}', '${evento}', 'server', 'm', 'cron:anni-tick', jsonb_build_object('campi', jsonb_build_object('operazione', 'anni-tick', 'esito', ${esitoTick})))
  ON CONFLICT (fingerprint, giorno) DO NOTHING;
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('info', 'cron', 'server', 'm', 'cron:anno-invarianti', jsonb_build_object('campi', jsonb_build_object('operazione', 'anno-invarianti', 'esito', 'ok')))
  ON CONFLICT (fingerprint, giorno) DO NOTHING;
  INSERT INTO public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
  VALUES ('info', 'cron', 'server', 'm', 'anno-creato:x', jsonb_build_object('campi', jsonb_build_object('operazione', 'anni-tick', 'esito', 'creato')))
  ON CONFLICT (fingerprint, giorno) DO NOTHING;`

describe('anni-tick-sorvegliato — il controllo positivo, su SQL e liste finti', () => {
  it('la migrazione finta ben fatta è pulita', () => {
    const sql = togliCommentiSql(finta("CASE WHEN v_errori > 0 THEN 'ok-parziale' ELSE 'ok' END"))
    expect(violazioniSchedule(sql)).toEqual([])
    expect(violazioniBattiti(sql)).toEqual([])
    expect(violazioniNonBattiti(sql)).toEqual([])
  })

  it('un esito del battito che valeComeBattito non conosce fa rosso (il caso `ok-parziale` → `parziale`)', () => {
    const sql = togliCommentiSql(finta("CASE WHEN v_errori > 0 THEN 'parziale' ELSE 'ok' END"))
    const v = violazioniBattiti(sql)
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('parziale')
  })

  it('un battito con livello error, con un altro evento o con un’altra operazione fa rosso', () => {
    expect(violazioniBattiti(togliCommentiSql(finta("'ok'", 'cron', 'error')))).toHaveLength(1)
    expect(violazioniBattiti(togliCommentiSql(finta("'ok'", 'migrazione')))).toHaveLength(1)
    const altraOperazione = togliCommentiSql(finta("'ok'")).replace(`'operazione', 'anni-tick', 'esito', 'ok'`, `'operazione', 'altro', 'esito', 'ok'`)
    expect(violazioniBattiti(altraOperazione)).toHaveLength(1)
  })

  it('un esito che non è un battito ma passerebbe per tale fa rosso', () => {
    const sql = togliCommentiSql(finta("'ok'"))
    expect(violazioniNonBattiti(sql, (op, e) => e === 'creato' || e === 'ok')).toHaveLength(1)
  })

  it('un cron.schedule col nome sbagliato, o la funzione sbagliata, o un unschedule che non li nomina, fa rosso', () => {
    const buono = togliCommentiSql(finta("'ok'"))
    expect(violazioniSchedule(buono.replace(`cron.schedule('anni-tick'`, `cron.schedule('anni-tick-x'`)).length).toBeGreaterThanOrEqual(1)
    expect(violazioniSchedule(buono.replace('public.anni_tick()', 'public.altra()'))).toHaveLength(1)
    expect(violazioniSchedule(buono.replace(`IN ('anni-tick', 'anno-invarianti')`, `IN ('anni-tick')`))).toHaveLength(1)
  })

  it('un nome in nessuna lista, o in tutte e due, fa rosso', () => {
    expect(violazioniListe(['x'], () => false, () => false)).toHaveLength(1)
    expect(violazioniListe(['x'], () => true, () => true)).toHaveLength(1)
    expect(violazioniListe(['x'], () => true, () => false)).toEqual([])
    expect(violazioniListe(['x'], () => false, () => true)).toEqual([])
  })

  it('un esito non letterale (`v_esito`) è segnalato come illeggibile, non ignorato', () => {
    const sql = togliCommentiSql(finta('v_esito'))
    const v = violazioniBattiti(sql)
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('non è un letterale')
  })
})

describe('anni-tick-sorvegliato — la migrazione M45a e controlli.ts', () => {
  it('ha letto abbastanza: 6 righe app_log, 2 battiti, 2 cron.schedule, almeno 6 esiti provati', () => {
    expect(RIGHE.length, `righe app_log lette: ${RIGHE.length}`).toBeGreaterThanOrEqual(6)
    expect(BATTITI.length, `battiti letti: ${BATTITI.length}`).toBeGreaterThanOrEqual(2)
    expect(SCHEDULE.length, `cron.schedule letti: ${SCHEDULE.length}`).toBeGreaterThanOrEqual(2)
    expect(ESITI_PROVATI, `esiti provati: ${ESITI_PROVATI}`).toBeGreaterThanOrEqual(7)
  })

  it('anni-tick e anno-invarianti stanno in UNA delle due liste di controlli.ts', () => {
    const v = violazioniListe(Object.keys(JOB))
    expect(v, 'Un job senza lista è un job dimenticato.' + elenco(v)).toEqual([])
  })

  it('il cron.schedule della M45a coincide con i nomi delle liste e lancia la funzione giusta', () => {
    const v = violazioniSchedule(SQL)
    expect(v, 'cron.schedule e liste di controlli.ts non coincidono.' + elenco(v)).toEqual([])
    for (const x of SCHEDULE) expect(inJobCron(x.nome) || inNonSorvegliati(x.nome), `${x.nome} non è in nessuna lista`).toBe(true)
  })

  it('ogni esito scritto dal battito è accettato da valeComeBattito', () => {
    const v = violazioniBattiti(SQL)
    expect(v, 'Il battito scrive un esito che /api/health non conosce.' + elenco(v)).toEqual([])
  })

  it('le altre righe di app_log (creato, errore, invarianti-non-zero, non-programmato) non passano per battiti', () => {
    const v = violazioniNonBattiti(SQL)
    expect(v, 'Una riga che non è un giro completato passerebbe per un battito.' + elenco(v)).toEqual([])
  })

  it('ESITI_BATTITO non è stato allargato: è esattamente `ok` e `ok-parziale`', () => {
    expect([...ESITI_BATTITO].sort()).toEqual(['ok', 'ok-parziale'])
  })

  it('i due job non hanno una voce in ESITI_BATTITO_PER_OPERAZIONE (non ne hanno bisogno: scrivono ok / ok-parziale)', () => {
    for (const nome of Object.keys(JOB)) expect(ESITI_BATTITO_PER_OPERAZIONE.has(nome), nome).toBe(false)
  })

  it('l’esito `ok-parziale` di anni-tick e `ok` di anno-invarianti valgono davvero come battito', () => {
    expect(valeComeBattito('anni-tick', 'ok')).toBe(true)
    expect(valeComeBattito('anni-tick', 'ok-parziale')).toBe(true)
    expect(valeComeBattito('anno-invarianti', 'ok')).toBe(true)
    expect(valeComeBattito('anni-tick', 'errore')).toBe(false)
    expect(valeComeBattito('anni-tick', 'creato')).toBe(false)
  })
})
