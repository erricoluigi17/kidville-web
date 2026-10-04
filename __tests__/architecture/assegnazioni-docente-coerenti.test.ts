import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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
 *  · il corpo di una funzione arriva fino alla dichiarazione esportata successiva: una
 *    lettura spostata in un helper privato non viene seguita, e il lock diventa rosso.
 *    È l'errore nel verso giusto (un rosso da spiegare, non un verde che mente);
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

function senzaCommenti(codice: string): string {
  return codice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Il corpo di `export async function <nome>(` fino alla dichiarazione esportata successiva. */
function corpoDi(sorgente: string, nome: string): string | null {
  const inizio = sorgente.indexOf(`export async function ${nome}(`)
  if (inizio < 0) return null
  const fine = sorgente.indexOf('\nexport ', inizio + 1)
  return senzaCommenti(sorgente.slice(inizio, fine < 0 ? undefined : fine))
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

  it('CONTROLLO POSITIVO — `utenti_sezioni_materie` non vale come lettura di `utenti_sezioni`', () => {
    const finto = "export async function x(s) {\n  return s.from('utenti_sezioni_materie')\n}\n"
    expect(mancanti(corpoDi(finto, 'x') ?? '')).toEqual(['utenti_sezioni'])
  })
})
