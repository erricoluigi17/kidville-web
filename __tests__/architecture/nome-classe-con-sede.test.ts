import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK DI FORMA — il NOME della classe non è un'identità: senza la sede non
 * seleziona niente di preciso.
 *
 * Con una sede sola «2 ANNI» era una chiave: una riga, una classe, un elenco di
 * bambini. Dal 2026-07-29 le sedi sono tre e «2 ANNI» esiste a Giugliano, ad
 * Aversa e a Cesa. Da quel giorno `.eq('classe_sezione', '2 ANNI')` non è più
 * una query: è l'unione di tre classi di tre plessi diversi — e nessuno se ne
 * accorge, perché una query che restituisce troppe righe non fallisce. È la
 * causa radice di metà dell'audit del 2026-07-31: elenchi di alunni, presenze,
 * diario, armadietto, generazione rette e destinatari delle notifiche che
 * scavalcavano il plesso passando per un nome.
 *
 * REGOLA: ogni filtro su `classe_sezione`, e ogni filtro sul `name` di
 * `sections`, deve avere accanto — NELLA STESSA QUERY — un filtro su
 * `scuola_id`. Non «da qualche parte nel file»: nella stessa query, perché è
 * l'unico posto dove l'AND lo rende vero.
 *
 * COS'È «LA STESSA QUERY». La catena di metodi che parte da `.from('…')`, più le
 * sue continuazioni condizionali sulla stessa variabile
 * (`let q = supabase.from('alunni')…` seguito da `if (sezione) q = q.eq(…)`):
 * PostgREST le combina in AND, quindi sono una query sola. Commenti e a capo non
 * contano — il sorgente viene mascherato prima di essere letto, così un
 * `.eq('scuola_id', …)` citato in un commento non vale come filtro.
 *
 * Un filtro che non risulta agganciato a nessuna query riconosciuta è anch'esso
 * un fallimento: una forma nuova va o resa leggibile o messa in allowlist con la
 * sua ragione. Il lock non deve poter essere aggirato scrivendo strano.
 *
 * Modello: `chiave-registro-per-sede.test.ts`, che copre la stessa causa radice
 * dal lato della scrittura (la chiave di conflitto dell'upsert del registro).
 */

const SRC = path.join(process.cwd(), 'src')

/** Filtri sul nome della classe portato come stringa. */
const FILTRO_CLASSE = /\.(?:eq|in|neq|not|filter|is)\s*\(\s*['"`]classe_sezione['"`]/g
/** Filtri sul nome della sezione (solo dentro una query su `sections`). */
const FILTRO_NOME = /\.(?:eq|in|neq|filter|ilike|like)\s*\(\s*['"`]name['"`]/g
/** Un filtro sulla colonna di tenancy, in tutte le forme usate nel repo. */
const FILTRO_SEDE =
  /\.(?:eq|in|neq|not|filter|is)\s*\(\s*['"`]scuola_id['"`]|['"`]scuola_id\.(?:eq|in|is|not)\.|\.match\s*\(\s*\{[^}]*\bscuola_id\b/

/**
 * Query risolte per sede in un ALTRO modo, con la ragione scritta accanto.
 * Chiave: `<file>::<tabella>.<colonna>`. Ogni voce è una decisione da difendere,
 * non un'esenzione di comodo — e una voce che non serve più fa fallire il test.
 */
const AMMESSE: Record<string, string> = {}

interface Unita {
  tabella: string
  variabile: string | null
  tratti: { a: number; b: number }[]
  testo: string
}

/** Le query di un sorgente, ciascuna con tutte le sue continuazioni. */
export function unitaDiQuery(senzaCommenti: string, struttura: string): Unita[] {
  const unita: Unita[] = []
  for (const m of senzaCommenti.matchAll(/\.from\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)) {
    const inizio = m.index
    const fine = fineCatena(struttura, inizio)
    const tratti = [{ a: inizio, b: fine }]

    // A quale variabile è assegnata la query? Serve per riattaccarle le
    // continuazioni condizionali (`if (sezione) q = q.eq(…)`).
    const prima = senzaCommenti.slice(Math.max(0, inizio - 200), inizio)
    const senzaRicevitore = prima.replace(/(?:await\s+)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*$/, '')
    const variabile =
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(senzaRicevitore)?.[1] ??
      /(?:^|[;{}\n])\s*([A-Za-z_$][\w$]*)\s*=\s*$/.exec(senzaRicevitore)?.[1] ??
      null

    if (variabile) {
      const riassegna = new RegExp(`\\b${variabile}\\s*=`, 'g')
      riassegna.lastIndex = fine
      for (let r = riassegna.exec(senzaCommenti); r; r = riassegna.exec(senzaCommenti)) {
        const dopo = senzaCommenti.slice(r.index + r[0].length)
        const cont = new RegExp(`^\\s*(?:await\\s+)?${variabile}\\s*\\.`).exec(dopo)
        // Riassegnazione a QUALCOS'ALTRO: da qui in poi la variabile è un'altra
        // query e questa unità è chiusa.
        if (!cont) break
        const punto = r.index + r[0].length + cont[0].length - 1
        tratti.push({ a: punto, b: fineCatena(struttura, punto) })
      }
    }

    unita.push({
      tabella: m[1],
      variabile,
      tratti,
      testo: tratti.map((t) => senzaCommenti.slice(t.a, t.b)).join('\n'),
    })
  }
  return unita
}

export interface NomeSenzaSede {
  riga: number
  colonna: 'classe_sezione' | 'name'
  tabella: string
  motivo: 'senza-sede' | 'query-non-riconosciuta'
}

/** Quanti filtri per nome il lock ha davvero ESAMINATO in questo sorgente. */
export function filtriEsaminati(src: string): number {
  return nomiSenzaSede(src, true).length
}

export function nomiSenzaSede(src: string, soloConta = false): NomeSenzaSede[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const unita = unitaDiQuery(senzaCommenti, struttura)
  const contiene = (i: number) => unita.find((u) => u.tratti.some((t) => i >= t.a && i < t.b))
  const fuori: NomeSenzaSede[] = []

  const controlla = (idx: number, colonna: 'classe_sezione' | 'name', soloSections: boolean) => {
    const u = contiene(idx)
    // Modalità conteggio: si vuole sapere quanti filtri il lock guarda davvero,
    // a prescindere dal verdetto. Un lock che smette di trovarli resta verde.
    if (soloConta) {
      if (!(soloSections && (!u || u.tabella !== 'sections'))) {
        fuori.push({ riga: riga(src, idx), colonna, tabella: u?.tabella ?? '?', motivo: 'senza-sede' })
      }
      return
    }
    if (!u) {
      if (soloSections) return // un `.eq('name', …)` fuori da una query non riguarda `sections`
      fuori.push({ riga: riga(src, idx), colonna, tabella: '?', motivo: 'query-non-riconosciuta' })
      return
    }
    if (soloSections && u.tabella !== 'sections') return
    if (FILTRO_SEDE.test(u.testo)) return
    fuori.push({ riga: riga(src, idx), colonna, tabella: u.tabella, motivo: 'senza-sede' })
  }

  FILTRO_CLASSE.lastIndex = 0
  for (const m of senzaCommenti.matchAll(FILTRO_CLASSE)) controlla(m.index, 'classe_sezione', false)
  FILTRO_NOME.lastIndex = 0
  for (const m of senzaCommenti.matchAll(FILTRO_NOME)) controlla(m.index, 'name', true)
  return fuori
}

const FILES = fileSorgente(SRC)

describe('lock di forma — il nome della classe non viaggia senza la sede', () => {
  it('ci sono file da controllare (se cade, il test si sta autoingannando)', () => {
    expect(FILES.length).toBeGreaterThan(200)
  })

  it('esiste davvero del codice che filtra per nome-classe (il lock non gira a vuoto)', () => {
    const conFiltro = FILES.filter((f) =>
      /\.(?:eq|in)\s*\(\s*['"]classe_sezione['"]/.test(fs.readFileSync(f, 'utf8')),
    )
    expect(conFiltro.length).toBeGreaterThan(5)
  })

  it('il rilevatore ESAMINA davvero quei filtri (non li perde per strada)', () => {
    // Verde perché non trova violazioni ≠ verde perché non guarda più niente:
    // se un domani il ritaglio delle catene si rompesse, questo conteggio cade
    // prima che il lock diventi una decorazione.
    const totale = FILES.reduce((n, f) => n + filtriEsaminati(fs.readFileSync(f, 'utf8')), 0)
    expect(totale).toBeGreaterThanOrEqual(20)
  })

  it('ogni filtro per nome-classe ha la sede nella stessa query', () => {
    const colpevoli: string[] = []
    for (const f of FILES) {
      const rel = path.relative(process.cwd(), f)
      for (const p of nomiSenzaSede(fs.readFileSync(f, 'utf8'))) {
        if (AMMESSE[`${rel}::${p.tabella}.${p.colonna}`]) continue
        colpevoli.push(`${rel}:${p.riga} — ${p.tabella}.${p.colonna} (${p.motivo})`)
      }
    }
    expect(colpevoli).toEqual([])
  })

  it("l'allowlist non contiene voci morte (una query corretta la lascerebbe indietro)", () => {
    const vive = new Set<string>()
    for (const f of FILES) {
      const rel = path.relative(process.cwd(), f)
      for (const p of nomiSenzaSede(fs.readFileSync(f, 'utf8'))) vive.add(`${rel}::${p.tabella}.${p.colonna}`)
    }
    expect(Object.keys(AMMESSE).filter((k) => !vive.has(k))).toEqual([])
  })

  // ── Prova di validità permanente del rilevatore ────────────────────────────
  describe('il rilevatore riconosce la forma vietata', () => {
    it('nome-classe nudo su `alunni`', () => {
      const src = `
        const { data } = await supabase
          .from('alunni')
          .select('id, nome, cognome')
          .eq('classe_sezione', sezione)
      `
      expect(nomiSenzaSede(src)).toEqual([
        { riga: 5, colonna: 'classe_sezione', tabella: 'alunni', motivo: 'senza-sede' },
      ])
    })

    it('nome-sezione nudo su `sections` (il risolutore che «ne prende una»)', () => {
      const src = "const { data } = await supabase.from('sections').select('id').eq('name', nome).limit(1)"
      expect(nomiSenzaSede(src).map((p) => p.colonna)).toEqual(['name'])
    })

    it('la sede citata in un COMMENTO non conta come filtro', () => {
      const src = `
        // Qui prima mancava \`.in('scuola_id', plessi)\`: il nome bastava.
        const { data } = await supabase.from('alunni').select('id').eq('classe_sezione', sezione)
      `
      expect(nomiSenzaSede(src)).toHaveLength(1)
    })

    it('la sede in un\'ALTRA query non conta', () => {
      const src = `
        const { data: sezioni } = await supabase.from('sections').select('id').in('scuola_id', plessi)
        const { data } = await supabase.from('alunni').select('id').eq('classe_sezione', sezione)
      `
      expect(nomiSenzaSede(src).map((p) => p.tabella)).toEqual(['alunni'])
    })
  })

  describe('il rilevatore NON segnala le forme corrette', () => {
    it('sede e nome nella stessa catena, su più righe e con commenti in mezzo', () => {
      const src = `
        const { data } = await supabase
          .from('alunni')
          // ristretti ai plessi accessibili
          .select('id, nome')
          .eq('classe_sezione', sezione)
          .in('scuola_id', plessi)
      `
      expect(nomiSenzaSede(src)).toEqual([])
    })

    it('continuazione condizionale sulla stessa variabile (PostgREST le mette in AND)', () => {
      const src = `
        let q = supabase.from('alunni').select('id').in('id', ids).eq('scuola_id', scuolaId)
        if (sezione) q = q.eq('classe_sezione', sezione)
        const { data } = await q
      `
      expect(nomiSenzaSede(src)).toEqual([])
    })

    it('il nome arriva prima, la sede dopo, sulla stessa variabile', () => {
      const src = `
        let q = supabase.from('alunni').select('id').in('classe_sezione', classi)
        if (scuolaId) q = q.eq('scuola_id', scuolaId)
        const { data } = await q
      `
      expect(nomiSenzaSede(src)).toEqual([])
    })

    it('una variabile RIASSEGNATA a una query nuova non presta la sua sede', () => {
      const src = `
        let q = supabase.from('alunni').select('id').eq('scuola_id', sede)
        const primo = await q
        q = supabase.from('alunni').select('id').eq('classe_sezione', sezione)
        const secondo = await q
      `
      expect(nomiSenzaSede(src).map((p) => p.motivo)).toEqual(['senza-sede'])
    })

    it('`.eq(\'name\', …)` su una tabella che non è `sections`', () => {
      const src = "const { data } = await supabase.from('merch_fornitori').select('id').eq('name', nome)"
      expect(nomiSenzaSede(src)).toEqual([])
    })
  })
})
