import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineCatena, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * COVERAGE-LOCK (PR 4.3, compito 4.3.6): chi LEGGE `utenti_sezioni` passa da `src/lib/sezioni/docenti.ts`.
 *
 * Perché: da quando le sezioni hanno un anno, «le sezioni di un docente» non sono più tutte le righe di
 * `utenti_sezioni` ma quelle che dice `sezioni_visibili_docente` (anno corrente, in chiusura, chiuso; mai il
 * futuro; sola lettura sul passato). Una lettura diretta della tabella mostrerebbe a una maestra la classe
 * dell'anno prossimo prima del passaggio. Le SCRITTURE delle assegnazioni (`insert`/`upsert`/`update`/`delete`,
 * pannello di segreteria) non contano: quel pannello deve vedere i legami di ogni anno.
 *
 * Una lettura nuova fuori da `docenti.ts` fa fallire il lock, a meno di entrare in `ECCEZIONI` con la ragione.
 */

const SRC = path.resolve(__dirname, '../../src')
const AMMESSO = 'lib/sezioni/docenti.ts'

/** file (relativo a `src/`) → ragione per cui legge `utenti_sezioni` direttamente. */
export const ECCEZIONI: Record<string, string> = {
  'app/api/admin/staff/route.ts':
    'pannello di segreteria: elenca e confronta le assegnazioni di OGNI anno per gestirle (non è la visibilità del docente)',
  'lib/chat/rubrica.ts':
    'rubrica della famiglia: parte dalle sezioni del FIGLIO (anno attivo) e cerca chi vi insegna; non è «le sezioni di un docente»',
  'lib/audit/valutatore.ts':
    'chi è titolare di una materia in una sezione GIÀ nota (la scrive solo chi ha passato assertSezioneScrivibile); distingue guasto da assenza, cosa che sezioniDiUtente non fa',
}

type Lettura = { file: string; riga: number }

/** Le letture (catene con `.select(` e senza scritture) di `.from('utenti_sezioni')` in un sorgente. */
export function lettureUtentiSezioni(file: string, testo: string): Lettura[] {
  const m = mascheraSorgente(testo)
  const out: Lettura[] = []
  const re = /\.from\(\s*['"`]utenti_sezioni['"`]\s*\)/g
  for (const hit of m.senzaCommenti.matchAll(re)) {
    let inizio = hit.index + hit[0].length
    while (/\s/.test(m.struttura[inizio] ?? '')) inizio++
    const fine = fineCatena(m.struttura, inizio)
    const catena = m.struttura.slice(inizio, fine)
    if (/\.(?:insert|upsert|update|delete)\s*\(/.test(catena)) continue
    if (!/\.select\s*\(/.test(catena)) continue
    out.push({ file, riga: riga(testo, hit.index) })
  }
  return out
}

const tutte: Lettura[] = fileSorgente(SRC).flatMap((f) =>
  lettureUtentiSezioni(path.relative(SRC, f), fs.readFileSync(f, 'utf8')),
)

describe('utenti_sezioni si legge da docenti.ts', () => {
  it('lo scanner distingue letture e scritture (provato su sorgenti finti)', () => {
    expect(lettureUtentiSezioni('a.ts', "await s.from('utenti_sezioni').select('section_id').eq('utente_id', u)")).toHaveLength(1)
    expect(lettureUtentiSezioni('a.ts', "await s.from('utenti_sezioni')\n  .select('a')\n  .eq('b', 1)")).toHaveLength(1)
    expect(lettureUtentiSezioni('a.ts', "await s.from('utenti_sezioni').upsert({ a: 1 })")).toHaveLength(0)
    expect(lettureUtentiSezioni('a.ts', "await s.from('utenti_sezioni').delete().eq('a', 1)")).toHaveLength(0)
    expect(lettureUtentiSezioni('a.ts', "await s.from('utenti_sezioni').insert({ a: 1 }).select()")).toHaveLength(0)
    expect(lettureUtentiSezioni('a.ts', "// s.from('utenti_sezioni').select('x')")).toHaveLength(0)
  })

  it('il lock vede letture (minimo: docenti.ts ne ha almeno una)', () => {
    expect(tutte.filter((l) => l.file === AMMESSO).length).toBeGreaterThanOrEqual(1)
  })

  it('nessuna lettura diretta fuori da docenti.ts e dalle eccezioni', () => {
    const fuori = tutte
      .filter((l) => l.file !== AMMESSO && !(l.file in ECCEZIONI))
      .map((l) => `${l.file}:${l.riga}`)
    expect(fuori, 'leggi le sezioni di un docente con sezioniDiUtente / sezioniVisibiliDiUtente').toEqual([])
  })

  it('ogni eccezione ha una ragione e legge davvero (niente voci morte)', () => {
    for (const [file, ragione] of Object.entries(ECCEZIONI)) {
      expect(ragione.length, file).toBeGreaterThan(20)
      expect(tutte.some((l) => l.file === file), `${file} non legge più utenti_sezioni: togliere la voce`).toBe(true)
    }
  })
})
