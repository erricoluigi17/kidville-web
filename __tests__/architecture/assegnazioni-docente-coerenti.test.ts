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
 * Si leggono i sorgenti SENZA i commenti: un nome di tabella citato in un commento
 * non è una lettura.
 */

const TABELLE = ["'utenti_sezioni'", "'utenti_sezioni_materie'"]

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

const mancanti = (corpo: string) => TABELLE.filter((t) => !corpo.includes(t))

describe('LOCK · le assegnazioni docente↔classe si leggono ovunque dalle stesse due tabelle', () => {
  it.each(FUNZIONI)('$nome legge entrambe le tabelle', ({ file, nome }) => {
    const corpo = corpoDi(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), nome)
    expect(corpo, `${nome} non trovata in ${file}: il lock non sta misurando niente`).not.toBeNull()
    expect(mancanti(corpo ?? ''), `${nome} non legge: ${mancanti(corpo ?? '').join(', ')}`).toEqual([])
  })

  it('CONTROLLO POSITIVO — una funzione che ne legge una sola viene vista', () => {
    const finto =
      "export async function x(s) {\n  // 'utenti_sezioni_materie' citata solo qui\n  return s.from('utenti_sezioni')\n}\n"
    expect(mancanti(corpoDi(finto, 'x') ?? '')).toEqual(["'utenti_sezioni_materie'"])
  })
})
