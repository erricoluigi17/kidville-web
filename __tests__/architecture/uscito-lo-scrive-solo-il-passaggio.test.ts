import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente } from '../fixtures/sorgente'

/**
 * PR 4.8, «Riattiva» giro 5 · LA FREQUENZA `uscito` LA SCRIVE SOLO IL PASSAGGIO.
 *
 * Perché esiste: «Riattiva» riconosce chi è uscito col passaggio d'anno dalla frequenza `uscito` che il passaggio ha chiuso (la funzione SQL
 * `anno_alunno_archiviato_dal_passaggio` la legge). Se una route, un job o un'altra funzione SQL scrivesse `uscito`, il criterio smetterebbe di
 * dire la verità. Nel giro 4 «Archivia» riscriveva `uscito` in `ritirato` e il 409 verso la «Conferma tardiva» spariva in silenzio: da qui il lock.
 *
 *  · in `src/` (ts/tsx) nessun `stato: 'uscito'` (un oggetto di scrittura) e nessun `.update`/`.insert` con quel valore;
 *  · nelle migrazioni (TUTTE: quelle già in produzione non scrivono `uscito`, e se un giorno lo facessero il lock lo direbbe) un `UPDATE … SET … stato =
 *    'uscito'` o un `INSERT INTO public.frequenze … 'uscito'` sta ammesso solo dentro una funzione `public.passaggio_*`. La 4.9 lo erediterà.
 *
 * Dichiara quanto ha letto (un lock che scansiona zero file è verde) e ha il controllo positivo su testo finto.
 */

const CWD = process.cwd()
const MIN_FILE_SRC = 1000
const MIN_MIGRAZIONI = 200

/** SQL senza commenti `--` e `/* … *\/` (le stringhe restano: `'uscito'` è una stringa). */
function senzaCommentiSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

/** Le scritture di `uscito` in un testo SQL: `{ funzione, riga }` per ciascuna, `funzione` = l'ultima `CREATE … FUNCTION public.<nome>` prima. */
export function scrittureUscitoSql(sqlGrezzo: string): Array<{ funzione: string | null; riga: number }> {
  const sql = senzaCommentiSql(sqlGrezzo)
  const out: Array<{ funzione: string | null; riga: number }> = []
  const funzioni: Array<{ pos: number; nome: string }> = []
  const reF = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z0-9_]+)"?/gi
  let f: RegExpExecArray | null
  while ((f = reF.exec(sql)) !== null) funzioni.push({ pos: f.index, nome: f[1].toLowerCase() })
  const dove = (pos: number) => {
    let nome: string | null = null
    for (const x of funzioni) { if (x.pos <= pos) nome = x.nome; else break }
    return nome
  }
  const riga = (pos: number) => sql.slice(0, pos).split('\n').length
  // UPDATE … SET <assegnazioni> [FROM|WHERE|RETURNING|;] : l'assegnazione `stato = 'uscito'` (anche `f.stato`, anche `"stato"`).
  const reU = /\bUPDATE\b[\s\S]*?\bSET\b([\s\S]*?)(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|;|\$\$)/gi
  let u: RegExpExecArray | null
  while ((u = reU.exec(sql)) !== null) {
    if (/(?:^|[\s,(])(?:\w+\.)?"?stato"?\s*=\s*'uscito'/i.test(u[1])) out.push({ funzione: dove(u.index), riga: riga(u.index) })
  }
  // INSERT INTO public.frequenze … 'uscito' (fino al `;`).
  const reI = /\bINSERT\s+INTO\s+(?:public\.)?"?frequenze"?\b[^;]*?'uscito'/gi
  let i: RegExpExecArray | null
  while ((i = reI.exec(sql)) !== null) out.push({ funzione: dove(i.index), riga: riga(i.index) })
  return out
}

/** Nei sorgenti TypeScript: un valore `'uscito'` assegnato a `stato` in un oggetto, o passato a un `.update(`/`.insert(`/`.upsert(`. */
export function scrittureUscitoTs(senzaCommenti: string): number[] {
  const out: number[] = []
  const re = /\bstato\s*:\s*(['"`])uscito\1/g
  let h: RegExpExecArray | null
  while ((h = re.exec(senzaCommenti)) !== null) out.push(senzaCommenti.slice(0, h.index).split('\n').length)
  return out
}

describe('uscito-lo-scrive-solo-il-passaggio · la frequenza `uscito` nasce solo nelle funzioni del passaggio', () => {
  it('in src/ nessun oggetto di scrittura con stato `uscito`', () => {
    const files = fileSorgente(path.join(CWD, 'src'))
    expect(files.length, 'file di src/ esaminati').toBeGreaterThanOrEqual(MIN_FILE_SRC)
    const violazioni: string[] = []
    for (const f of files) {
      const m = mascheraSorgente(fs.readFileSync(f, 'utf8'))
      for (const r of scrittureUscitoTs(m.senzaCommenti)) violazioni.push(`${path.relative(CWD, f)}:${r} — \`uscito\` lo scrive solo il passaggio (funzione SQL passaggio_*)`)
    }
    expect(violazioni).toEqual([])
  })

  it('nelle migrazioni una scrittura di `uscito` sta solo dentro una funzione public.passaggio_*', () => {
    const dir = path.join(CWD, 'supabase', 'migrations')
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()
    expect(files.length, 'migrazioni esaminate').toBeGreaterThanOrEqual(MIN_MIGRAZIONI)
    const violazioni: string[] = []
    let scritture = 0
    for (const n of files) {
      for (const w of scrittureUscitoSql(fs.readFileSync(path.join(dir, n), 'utf8'))) {
        scritture++
        if (!(w.funzione ?? '').startsWith('passaggio_')) violazioni.push(`supabase/migrations/${n}:${w.riga} — \`uscito\` scritto fuori da passaggio_* (in ${w.funzione ?? 'nessuna funzione'})`)
      }
    }
    // La scrittura vera esiste (passaggio_conferma): se il lock non ne vede nemmeno una, non vede più niente.
    expect(scritture, 'scritture di `uscito` viste (almeno quella di passaggio_conferma)').toBeGreaterThanOrEqual(1)
    expect(violazioni).toEqual([])
  })

  it('controllo positivo: il lock vede una scrittura fuori dal passaggio, e lascia passare quella dentro', () => {
    const fuori = `CREATE OR REPLACE FUNCTION public.archivia_qualcosa() RETURNS void AS $$ BEGIN
      UPDATE public.frequenze f SET stato = 'uscito', data_uscita = now() WHERE f.id = 1; END $$ LANGUAGE plpgsql;`
    const dentro = `CREATE OR REPLACE FUNCTION public.passaggio_conferma() RETURNS void AS $$ BEGIN
      UPDATE public.frequenze f SET stato = 'uscito' WHERE f.id = 1; END $$ LANGUAGE plpgsql;`
    expect(scrittureUscitoSql(fuori).map((x) => x.funzione)).toEqual(['archivia_qualcosa'])
    expect(scrittureUscitoSql(dentro).map((x) => x.funzione)).toEqual(['passaggio_conferma'])
    expect(scrittureUscitoSql(`INSERT INTO public.frequenze (alunno_id, stato) VALUES (1, 'uscito');`)).toHaveLength(1)
    // Un filtro o una lettura non sono scritture.
    expect(scrittureUscitoSql(`SELECT 1 FROM public.frequenze f WHERE f.stato = 'uscito'; UPDATE public.alunni SET stato = 'iscritto' WHERE id = 1;`)).toEqual([])
    expect(scrittureUscitoSql(`-- UPDATE public.frequenze SET stato = 'uscito'\nSELECT 1;`)).toEqual([])
    expect(scrittureUscitoTs(`await s.from('frequenze').update({ stato: 'uscito' })`)).toEqual([1])
    expect(scrittureUscitoTs(`await s.from('frequenze').select('id').eq('stato', 'uscito')`)).toEqual([])
  })
})
