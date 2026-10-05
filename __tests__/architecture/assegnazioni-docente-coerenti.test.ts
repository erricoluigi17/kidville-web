import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi } from '../fixtures/sorgente'

/**
 * LE TRE FUNZIONI CHE DICONO «QUESTA CLASSE È TUA» LEGGONO LE STESSE TABELLE.
 *
 * `puoAccedereFascicolo` e `sezioniContitolari` (fascicolo, documenti sanitari) e
 * `sezioniAnagraficaVisibili` (anagrafica docente) devono contare sia le
 * assegnazioni dirette (`utenti_sezioni`) sia quelle per materia
 * (`utenti_sezioni_materie`). Se una delle tre perdesse una tabella, un docente
 * vedrebbe un bambino nell'elenco e non ne aprirebbe la scheda, o il contrario —
 * senza che niente diventi rosso. Il commento di `fascicolo-rbac.ts` prometteva questo
 * controllo in un file che non è mai esistito: ora esiste, ed è questo.
 *
 * Si cerca la LETTURA — `.from('<tabella>')` — e non il solo nome: una tabella citata
 * in un commento, in una costante o fra gli argomenti di una `rpc` non è una lettura.
 * I commenti si tolgono prima di cercare.
 *
 * I LIMITI CHE RESTANO, detti qui perché nessuno ci costruisca sopra una prova che non
 * regge:
 *  · controlla CHE le due tabelle siano lette, non COME vengono usate: quali filtri, se
 *    il risultato entra davvero nella risposta, se l'`error` di PostgREST viene
 *    controllato. Quello lo provano i test di comportamento
 *    (`__tests__/lib/anagrafica-docente-visibilita.test.ts` per la terza funzione);
 *  · il corpo di una funzione va dalla graffa che lo apre a quella che lo chiude,
 *    contate sul sorgente mascherato (`mascheraSorgente`: le graffe dentro stringhe e
 *    commenti non contano). Un helper scritto DOPO la funzione non le presta una
 *    lettura; una lettura spostata in un helper, chiamato o no, non viene seguita, e
 *    il lock diventa rosso. È l'errore nel verso giusto (un rosso da spiegare, non un
 *    verde che mente);
 *  · al contrario, una lettura scritta DENTRO il corpo conta anche se sta in una
 *    callback o in un ramo che non viene mai eseguito: il lock vede il testo, non
 *    l'esecuzione;
 *  · un nome di tabella costruito a runtime (`from(nomeTabella)`) non viene
 *    riconosciuto: anche qui il lock è rosso, non cieco.
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

const mancanti = (corpo: string) => TABELLE.filter((t) => !letturaDi(t).test(corpo))

describe('LOCK · le assegnazioni docente↔classe si leggono ovunque dalle stesse due tabelle', () => {
  it.each(FUNZIONI)('$nome legge entrambe le tabelle', ({ file, nome }) => {
    const corpo = corpoDi(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), nome)
    expect(corpo, `${nome} non trovata in ${file}: il lock non sta misurando niente`).not.toBeNull()
    expect(mancanti(corpo ?? ''), `${nome} non legge: ${mancanti(corpo ?? '').join(', ')}`).toEqual([])
  })

  it('CONTROLLO POSITIVO — una funzione che ne legge una sola viene vista', () => {
    const finto =
      "export async function x(s) {\n  // s.from('utenti_sezioni_materie') citata solo in un commento\n  return s.from('utenti_sezioni')\n}\n"
    expect(mancanti(corpoDi(finto, 'x') ?? '')).toEqual(['utenti_sezioni_materie'])
  })

  it('CONTROLLO POSITIVO — una tabella citata fuori da `.from(...)` non conta come lettura', () => {
    const finto =
      "export async function x(s) {\n" +
      "  const tabella = 'utenti_sezioni_materie'\n" +
      "  await s.rpc('leggi', { nome: 'utenti_sezioni_materie' })\n" +
      "  return s.from( \"utenti_sezioni\" )\n}\n"
    expect(mancanti(corpoDi(finto, 'x') ?? '')).toEqual(['utenti_sezioni_materie'])
  })

  it('CONTROLLO POSITIVO — un helper privato scritto DOPO la funzione, e mai chiamato, non le presta la lettura', () => {
    const finto =
      "export async function x(s) {\n  return s.from('utenti_sezioni')\n}\n\n" +
      "async function maiChiamata(s) {\n  return s.from('utenti_sezioni_materie')\n}\n"
    expect(mancanti(corpoDi(finto, 'x') ?? '')).toEqual(['utenti_sezioni_materie'])
  })

  it('CONTROLLO POSITIVO — `utenti_sezioni_materie` non vale come lettura di `utenti_sezioni`', () => {
    const finto = "export async function x(s) {\n  return s.from('utenti_sezioni_materie')\n}\n"
    expect(mancanti(corpoDi(finto, 'x') ?? '')).toEqual(['utenti_sezioni'])
  })
})
