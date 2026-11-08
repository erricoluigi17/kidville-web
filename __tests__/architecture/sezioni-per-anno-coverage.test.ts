import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import { mascheraSorgente, fineCatena, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * COVERAGE-LOCK · ogni query su `sections` guarda l'anno (PR 4.3, Compito 4.3.7).
 *
 * I nomi di classe si ripetono ogni anno («1A» c'è nel 2026/27 e ci sarà nel 2027/28), e dalla PR 4.2 la segreteria
 * può creare classi nel 2027/28. Una query su `sections` che non dice di quale anno parla ha due difetti, entrambi
 * muti: una lista mostra due «1A» senza dire quale è quale, e una ricerca per nome può agganciare un bambino alla
 * «1A» sbagliata. Questo lock tiene ferme le tre risposte accettate per OGNI `.from('sections')` di `src/`:
 *
 *  1. un filtro `anno_id` (`.eq('anno_id', …)`, `.in('anno_id', …)`), nella catena stessa o nel `if (anno) query =
 *     query.eq('anno_id', …)` che la segue subito (si guarda fino al prossimo `.from(`);
 *  2. un filtro per `id` (`.eq('id', …)`, `.in('id', …)`): un id è già di un anno solo;
 *  3. una voce in `ESENTI`, con la ragione e il NUMERO di query che copre. Una voce che non copre più nulla, o ne
 *     copre di più o di meno, fa fallire il lock: l'elenco delle eccezioni non può invecchiare in silenzio.
 *
 * ─── I limiti, dichiarati ────────────────────────────────────────────────────
 * Il lock legge il TESTO: non sa se il valore passato a `.eq('anno_id', …)` è quello giusto (lo provano i test delle
 * route, `__tests__/api/admin-sections-anno.test.ts`), e il `if (anno) query = query.eq('anno_id', …)` lo riconosce
 * perché sta entro 600 caratteri dalla fine della catena e prima del `.from(` successivo. Un `anno_id` lontano non
 * conta.
 *
 * ─── Il minimo ───────────────────────────────────────────────────────────────
 * Un lock che scansiona zero file è verde. È già successo tre volte in questo repo: per questo il test dichiara quanti
 * file e quante query ha esaminato, e ha un MINIMO per ciascuna delle tre risposte. Se i numeri scendono, qualcuno ha
 * tolto le query dalla vista dello scanner (o ha tolto il filtro) e il lock lo dice.
 */

const RADICE = path.resolve(__dirname, '../..')
const SRC = path.join(RADICE, 'src')

export type Esito = 'anno' | 'id' | 'esente'
export interface Query {
  file: string
  riga: number
  catena: string
  esito: 'anno' | 'id' | 'nessuno'
}

/** Quanti caratteri dopo la catena si cerca il `if (anno) query = query.eq('anno_id', …)`. */
const FINESTRA_DOPO = 600

const RE_FROM = /\.from\(\s*(['"`])sections\1\s*\)/g
const RE_ANNO = /\.(?:eq|in)\(\s*(['"`])anno_id\1/
const RE_ID = /\.(?:eq|in)\(\s*(['"`])id\1/

/** Tutte le query su `sections` di un sorgente, già classificate. */
export function queryDiSezioni(file: string, originale: string): Query[] {
  const m = mascheraSorgente(originale)
  const out: Query[] = []
  RE_FROM.lastIndex = 0
  let t: RegExpExecArray | null
  const inizi: number[] = []
  while ((t = RE_FROM.exec(m.senzaCommenti))) inizi.push(t.index)
  RE_FROM.lastIndex = 0
  for (let k = 0; k < inizi.length; k++) {
    const da = inizi[k]
    const fine = fineCatena(m.struttura, da)
    const catena = m.senzaCommenti.slice(da, fine)
    // `.from('x')` successivo qualunque tabella: la finestra non scavalca la prossima query.
    const prossimo = m.senzaCommenti.indexOf('.from(', fine)
    const limite = Math.min(
      fine + FINESTRA_DOPO,
      prossimo === -1 ? Number.POSITIVE_INFINITY : prossimo,
      m.senzaCommenti.length,
    )
    const dopo = m.senzaCommenti.slice(fine, limite)
    let esito: Query['esito'] = 'nessuno'
    if (RE_ANNO.test(catena) || RE_ANNO.test(dopo)) esito = 'anno'
    else if (RE_ID.test(catena)) esito = 'id'
    out.push({ file, riga: riga(originale, da), catena: catena.replace(/\s+/g, ' '), esito })
  }
  return out
}

/**
 * Le query che NON filtrano per anno né per id, ciascuna col suo motivo. `quante` è il numero di query del file che la
 * voce copre: se il file ne ha di più, il lock fallisce (la nuova query va classificata); se ne ha di meno, fallisce
 * (la voce è vecchia).
 */
export const ESENTI: readonly { file: string; quante: number; motivo: string }[] = [
  {
    file: 'src/app/api/admin/sections/route.ts',
    quante: 1,
    motivo:
      "L'INSERT della segreteria: l'anno lo dichiara con `resolveAnnoScrittura` + `conAnno` (provato in anno-sections-post.test.ts). Le altre tre query del file filtrano per anno (elenco, controllo dell'omonimia) o per id.",
  },
  {
    file: 'src/app/api/admin/presenze/realtime/route.ts',
    quante: 1,
    motivo:
      "Nomi e sedi delle classi per etichettare un conteggio che parte da `alunni.section_id` (la sezione dell'anno attivo): una classe di un altro anno non ha iscritti, quindi non compare mai nel cruscotto.",
  },
  {
    file: 'src/lib/health/controlli.ts',
    quante: 1,
    motivo:
      "Controllo di salute: confronta TUTTE le sezioni con `alunni.section_id`/`classe_sezione` per trovare divergenze. È una diagnosi sul database intero, non una lista per l'utente.",
  },
  {
    file: 'src/lib/news/notifiche.ts',
    quante: 1,
    motivo:
      "Gli id delle sezioni di un grado servono solo a filtrare `alunni.section_id` (`.in('section_id', ids)`), che porta la sezione dell'anno attivo: le sezioni di un altro anno non hanno alunni, quindi non cambiano i destinatari.",
  },
  {
    file: 'src/lib/votazioni/aventi-diritto.ts',
    quante: 1,
    motivo:
      "Gli id delle classi della sede servono a trovare i genitori attraverso `alunni.section_id` (anno attivo): le classi di un altro anno non hanno alunni, quindi non aggiungono nessun avente diritto.",
  },
]

const letti = new Map<string, Query[]>()
function tutte(): Query[] {
  if (letti.size === 0) {
    for (const f of fileSorgente(SRC)) {
      const rel = path.relative(RADICE, f).split(path.sep).join('/')
      const q = queryDiSezioni(rel, fs.readFileSync(f, 'utf8'))
      if (q.length > 0) letti.set(rel, q)
    }
  }
  return [...letti.values()].flat()
}

describe('sezioni-per-anno-coverage · lo scanner', () => {
  it('riconosce un filtro per anno dentro la catena', () => {
    const q = queryDiSezioni('x.ts', "const r = await db.from('sections').select('id').eq('scuola_id', s).eq('anno_id', a)")
    expect(q).toHaveLength(1)
    expect(q[0].esito).toBe('anno')
  })

  it("riconosce il `if (anno) query = query.eq('anno_id', …)` che segue la catena", () => {
    const sorgente = `
      let query = db.from('sections').select('id').eq('scuola_id', s)
      if (anni) query = query.in('anno_id', anni)
      const { data } = await query
    `
    expect(queryDiSezioni('x.ts', sorgente)[0].esito).toBe('anno')
  })

  it('un anno_id che sta dopo un ALTRO .from() non conta per la prima query', () => {
    const sorgente = `
      const a = await db.from('sections').select('id').eq('scuola_id', s)
      const b = await db.from('alunni').select('id').eq('anno_id', x)
    `
    expect(queryDiSezioni('x.ts', sorgente)[0].esito).toBe('nessuno')
  })

  it('un anno_id lontano (oltre la finestra) non conta', () => {
    const sorgente = `
      const a = await db.from('sections').select('id').eq('scuola_id', s)
      ${'// '.padEnd(10, ' ')}
      const riempitivo = '${'x'.repeat(FINESTRA_DOPO + 50)}'
      const dopo = q.eq('anno_id', a)
    `
    expect(queryDiSezioni('x.ts', sorgente)[0].esito).toBe('nessuno')
  })

  it('riconosce il filtro per id', () => {
    expect(queryDiSezioni('x.ts', "db.from('sections').select('name').eq('id', i).maybeSingle()")[0].esito).toBe('id')
    expect(queryDiSezioni('x.ts', "db.from('sections').select('name').in('id', ids)")[0].esito).toBe('id')
  })

  it('una query per scuola_id senza anno è «nessuno»', () => {
    expect(queryDiSezioni('x.ts', "db.from('sections').select('id').eq('scuola_id', s)")[0].esito).toBe('nessuno')
  })

  it('un commento che nomina anno_id non basta', () => {
    const sorgente = `
      // .eq('anno_id', a) lo mette la route
      const r = await db.from('sections').select('id').eq('scuola_id', s)
    `
    expect(queryDiSezioni('x.ts', sorgente)[0].esito).toBe('nessuno')
  })

  it('un nome di colonna che CONTIENE id non è un filtro per id', () => {
    expect(queryDiSezioni('x.ts', "db.from('sections').select('id').eq('scuola_id', s)")[0].esito).toBe('nessuno')
    expect(queryDiSezioni('x.ts', "db.from('sections').select('id').eq('anno_sede_id', s)")[0].esito).toBe('nessuno')
  })
})

describe('sezioni-per-anno-coverage · il codice di src/', () => {
  it('i MINIMI: lo scanner ha visto abbastanza file e abbastanza query', () => {
    const q = tutte()
    const conAnno = q.filter((x) => x.esito === 'anno').length
    const perId = q.filter((x) => x.esito === 'id').length
    const nessuno = q.filter((x) => x.esito === 'nessuno').length
    // Al 08/11/2026: 55 file, 73 query su `sections` = 23 per anno + 45 per id + 5 nelle eccezioni. I minimi sono
    // esatti di proposito: se scendono, scrivi accanto al numero PERCHÉ (una query tolta, un filtro tolto?).
    expect(letti.size, 'file con una query su sections').toBeGreaterThanOrEqual(55)
    expect(q.length, 'query su sections').toBeGreaterThanOrEqual(73)
    expect(conAnno, 'query che filtrano per anno').toBeGreaterThanOrEqual(23)
    expect(perId, 'query che filtrano per id').toBeGreaterThanOrEqual(45)
    // Le eccezioni non crescono senza che qualcuno riscriva la lista qui sopra.
    expect(nessuno).toBe(ESENTI.reduce((n, e) => n + e.quante, 0))
  })

  it('ogni query su `sections` filtra per anno, per id, o è nell\'elenco delle eccezioni', () => {
    const senzaFiltro = tutte().filter((x) => x.esito === 'nessuno')
    const perFile = new Map<string, Query[]>()
    for (const x of senzaFiltro) perFile.set(x.file, [...(perFile.get(x.file) ?? []), x])

    const nonDichiarate = [...perFile.entries()]
      .filter(([f]) => !ESENTI.some((e) => e.file === f))
      .flatMap(([, qs]) => qs.map((x) => `${x.file}:${x.riga}  ${x.catena.slice(0, 120)}`))
    expect(
      nonDichiarate,
      "query su `sections` senza filtro d'anno né d'id: aggiungi `.eq('anno_id', …)` (resolveAnnoLettura / anniAttiviDeiPlessi) o una voce motivata in ESENTI",
    ).toEqual([])

    for (const e of ESENTI) {
      const trovate = perFile.get(e.file)?.length ?? 0
      expect(trovate, `ESENTI ${e.file}: la voce copre ${e.quante} query, il file ne ha ${trovate} senza filtro`).toBe(e.quante)
    }
  })
})
