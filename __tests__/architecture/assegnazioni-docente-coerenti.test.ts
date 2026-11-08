import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi } from '../fixtures/sorgente'

/**
 * LA REGOLA «CONTANO SIA LE ASSEGNAZIONI DIRETTE SIA QUELLE PER MATERIA» STA IN UN POSTO SOLO.
 *
 * Sta nelle funzioni SQL `sezioni_visibili_docente` e `sezioni_docente_anno_attivo` (ultima migrazione che le
 * definisce): leggono l'unione di `utenti_sezioni` (diretta) e `utenti_sezioni_materie` (per materia), senza
 * doppioni. Le tre funzioni applicative che dicono «questa classe è tua» — `puoAccedereFascicolo` e
 * `sezioniContitolari` (fascicolo, documenti sanitari) e `sezioniAnagraficaVisibili` (anagrafica docente) — NON
 * rileggono più le tabelle: chiamano `sezioniVisibiliConEsito`/`sezioniVisibiliDiUtente` (docenti.ts). Così un
 * elenco e il gate che lo accompagna non possono più divergere, e la regola per anno (mai le sezioni future) non si
 * duplica in tre punti.
 *
 * Il lock verifica DUE cose, entrambe sul testo con i commenti tolti (un lock che legge un file come testo legge
 * anche i commenti: se non li togliessi, il commento che spiega la regola la soddisferebbe da solo):
 *  · le tre funzioni chiamano la funzione di visibilità;
 *  · il corpo SQL dell'ULTIMA definizione di ciascuna delle due funzioni legge entrambe le tabelle (e il ripiego di
 *    `docenti.ts`, usato quando la funzione manca nel DB, le legge entrambe a sua volta).
 *
 * I LIMITI CHE RESTANO, detti qui perché nessuno ci costruisca sopra una prova che non regge:
 *  · controlla CHE le tabelle siano lette, non COME: filtri, `error` di PostgREST e unione effettiva li provano i
 *    test di comportamento (`__tests__/db/anno-sezioni-docenti.test.ts` su PGlite, `anno-accesso-docenti-letture`);
 *  · il corpo di una funzione TS va dalla graffa che lo apre a quella che lo chiude, contate sul sorgente mascherato
 *    (`mascheraSorgente`). Una chiamata spostata in un helper non viene seguita: il lock diventa rosso (un rosso da
 *    spiegare, non un verde che mente);
 *  · una chiamata scritta DENTRO il corpo conta anche in un ramo mai eseguito: il lock vede il testo, non
 *    l'esecuzione.
 */

const TABELLE = ['utenti_sezioni', 'utenti_sezioni_materie']

/** `.from('<tabella>')` con qualunque apice e spazi dentro le parentesi. */
const letturaDi = (tabella: string) => new RegExp(`\\.from\\(\\s*['"\`]${tabella}['"\`]\\s*\\)`)

const FUNZIONI = [
  { file: 'src/lib/primaria/fascicolo-rbac.ts', nome: 'puoAccedereFascicolo' },
  { file: 'src/lib/primaria/fascicolo-rbac.ts', nome: 'sezioniContitolari' },
  { file: 'src/lib/anagrafiche/docente/visibilita.ts', nome: 'sezioniAnagraficaVisibili' },
]

/**
 * Indice DOPO la graffa che chiude quella aperta in `apertura` — la stessa idea di
 * `fineGraffa` in `isolamento-sede-coverage.test.ts`. Va usato su `struttura`, dove
 * nessuna graffa vive dentro una stringa o un commento.
 */
function fineGraffa(strut: string, apertura: number): number {
  let livello = 0
  for (let k = apertura; k < strut.length; k++) {
    if (strut[k] === '{') livello++
    else if (strut[k] === '}') { livello--; if (livello === 0) return k + 1 }
  }
  return strut.length
}

/**
 * Il CORPO di `export async function <nome>(`, dalla graffa che lo apre a quella che
 * lo chiude, con i commenti spenti e le stringhe leggibili (`senzaCommenti`).
 */
function corpoDi(sorgente: string, nome: string): string | null {
  const { senzaCommenti, struttura } = mascheraSorgente(sorgente)
  const firma = `export async function ${nome}(`
  const inizio = struttura.indexOf(firma)
  if (inizio < 0) return null
  const parametri = fineParentesi(struttura, inizio + firma.length - 1)
  // La graffa del CORPO, non quella di un tipo di ritorno:
  // `): Promise<{ esito: 'tutte' }> {` ne ha due, e la prima è il tipo.
  let graffa = -1
  let angolare = 0
  for (let k = parametri; k < struttura.length; k++) {
    const c = struttura[k]
    if (c === '<') angolare++
    else if (c === '>') angolare = Math.max(0, angolare - 1)
    else if (c === '{' && angolare === 0) { graffa = k; break }
  }
  if (graffa < 0) return null
  return senzaCommenti.slice(graffa, fineGraffa(struttura, graffa))
}

/** Le tre funzioni leggono le assegnazioni SOLO chiamando la funzione di visibilità (dirette + per materia). */
const CHIAMA_VISIBILITA = /\bsezioniVisibili(?:ConEsito|DiUtente)\s*\(/

/** `-- …` e `/* … *​/` tolti da un sorgente SQL (le stringhe di una funzione di visibilità non ne contengono). */
const sqlSenzaCommenti = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')

const DIR_MIGRAZIONI = path.join(process.cwd(), 'supabase/migrations')

/** Il corpo SQL (`AS $$ … $$`) dell'ULTIMA migrazione che definisce `nome`, con i commenti tolti. */
function corpoSqlRecente(nome: string): { file: string; corpo: string } | null {
  const definizione = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${nome}\\s*\\(`, 'i')
  const file = fs.readdirSync(DIR_MIGRAZIONI).filter((f) => f.endsWith('.sql')).sort().reverse()
    .find((f) => definizione.test(sqlSenzaCommenti(fs.readFileSync(path.join(DIR_MIGRAZIONI, f), 'utf8'))))
  if (!file) return null
  const testo = sqlSenzaCommenti(fs.readFileSync(path.join(DIR_MIGRAZIONI, file), 'utf8'))
  const da = testo.search(definizione)
  const apre = testo.indexOf('$$', da)
  const chiude = testo.indexOf('$$', apre + 2)
  if (apre < 0 || chiude < 0) return null
  return { file, corpo: testo.slice(apre + 2, chiude) }
}

/** Una tabella è letta nel corpo SQL come `FROM public.<t>`/`JOIN public.<t>`. */
const sqlLegge = (corpo: string, tabella: string) =>
  new RegExp(`\\b(?:FROM|JOIN)\\s+public\\.${tabella}\\b`, 'i').test(corpo)

describe('LOCK · la regola delle assegnazioni docente↔classe sta nella funzione SQL, e le funzioni TS la chiamano', () => {
  it.each(FUNZIONI)('$nome chiama la funzione di visibilità (non rilegge le tabelle)', ({ file, nome }) => {
    const corpo = corpoDi(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), nome)
    expect(corpo, `${nome} non trovata in ${file}: il lock non sta misurando niente`).not.toBeNull()
    expect(CHIAMA_VISIBILITA.test(corpo ?? ''), `${nome} non chiama sezioniVisibiliConEsito/DiUtente`).toBe(true)
  })

  it.each(['sezioni_visibili_docente', 'sezioni_docente_anno_attivo'])('%s (ultima definizione SQL) legge entrambe le tabelle', (nome) => {
    const def = corpoSqlRecente(nome)
    expect(def, `nessuna migrazione definisce ${nome}: il lock non sta misurando niente`).not.toBeNull()
    const mancano = TABELLE.filter((t) => !sqlLegge(def?.corpo ?? '', t))
    expect(mancano, `${nome} in ${def?.file} non legge: ${mancano.join(', ')}`).toEqual([])
  })

  it('il ripiego di docenti.ts (funzione assente nel DB) legge entrambe le tabelle', () => {
    const corpo = corpoDi(fs.readFileSync(path.join(process.cwd(), 'src/lib/sezioni/docenti.ts'), 'utf8'), 'sezioniVisibiliConEsito')
    expect(corpo).not.toBeNull()
    expect(TABELLE.filter((t) => !letturaDi(t).test(corpo ?? ''))).toEqual([])
  })

  it('CONTROLLO POSITIVO — una funzione TS che non chiama la visibilità viene vista', () => {
    const finto = "export async function x(s) {\n  // sezioniVisibiliConEsito(s) citata solo in un commento\n  return s.from('utenti_sezioni')\n}\n"
    expect(CHIAMA_VISIBILITA.test(corpoDi(finto, 'x') ?? '')).toBe(false)
    const buono = "export async function x(s) {\n  return await sezioniVisibiliConEsito(s, 1)\n}\n"
    expect(CHIAMA_VISIBILITA.test(corpoDi(buono, 'x') ?? '')).toBe(true)
  })

  it('CONTROLLO POSITIVO — un SQL che legge una tabella sola, o la cita solo in un commento, viene visto', () => {
    const sql = `CREATE OR REPLACE FUNCTION public.f(p uuid) RETURNS TABLE (a uuid) LANGUAGE sql AS $$
      -- FROM public.utenti_sezioni_materie (solo in un commento)
      SELECT us.section_id FROM public.utenti_sezioni us WHERE us.utente_id = p
    $$;`
    const corpo = sqlSenzaCommenti(sql)
    expect(sqlLegge(corpo, 'utenti_sezioni')).toBe(true)
    expect(sqlLegge(corpo, 'utenti_sezioni_materie')).toBe(false)
  })

  it('CONTROLLO POSITIVO — `utenti_sezioni_materie` non vale come lettura di `utenti_sezioni`', () => {
    expect(sqlLegge('SELECT 1 FROM public.utenti_sezioni_materie um', 'utenti_sezioni')).toBe(false)
  })

  it('CONTROLLO POSITIVO — una tabella citata fuori da `.from(...)` non conta come lettura TS', () => {
    const finto = "export async function x(s) {\n  await s.rpc('leggi', { nome: 'utenti_sezioni_materie' })\n  return s.from( \"utenti_sezioni\" )\n}\n"
    expect(TABELLE.filter((t) => !letturaDi(t).test(corpoDi(finto, 'x') ?? ''))).toEqual(['utenti_sezioni_materie'])
  })
})
