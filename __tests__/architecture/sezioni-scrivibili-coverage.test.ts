import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * COVERAGE-LOCK (PR 4.3, compito 4.3.6): una route che SCRIVE e verifica la sezione lo fa con
 * `assertSezioneScrivibile`, non con `assertSezioneInScope`.
 *
 * Perché: un docente vede in sola lettura le sezioni degli anni `in_chiusura` e `chiuso`. `assertSezioneInScope`
 * le lascia passare (va bene per le `GET`); in scrittura il docente riceverebbe un 200 sul registro di un anno
 * passato. La rete vera, per tutti i ruoli, è la guardia DB `ANNO_CHIUSO` della PR 3-B (non prima del 02/12/2026):
 * fino ad allora è questo gate applicativo a impedirlo.
 *
 * Il lock guarda ogni file di `src/` che esporta `POST`/`PUT`/`PATCH`/`DELETE`: una chiamata a
 * `assertSezioneInScope(` dentro un handler di scrittura, o nei suoi helper non esportati fuori da ogni `GET`, è
 * un errore, salvo file in `ECCEZIONI` con la ragione. Una `GET` resta su `assertSezioneInScope`.
 *
 * ── COSA COPRE QUESTO LOCK, e cosa no (detto con precisione) ──
 *  · COPRE (automatico): le route di scrittura che chiamano `assertSezioneInScope(` direttamente.
 *  · NON lo vede (ma è a posto, ognuno col suo test): `assertSezionePrimariaFirmabile` (la firma del registro di
 *    primaria guarda l'anno della classe: `primaria-registro-supplenza.test.ts`), `puoAccedereFascicolo` con
 *    l'azione `upload`/`delete`/`sostituisci` (solo sezioni scrivibili: `anno-accesso-docenti-letture.test.ts`),
 *    `verificaTargetAvvisoDocente` (solo i nomi delle sezioni scrivibili: `avvisi-gate-scrittura-anno.test.ts`).
 *    Quei gate vivono in `src/lib`, e questo lock non li segue: se ne nasce uno nuovo, la sola difesa è la revisione.
 *  · NON coperti per scelta: `GATE_NON_COPERTI` qui sotto.
 *
 * Limite dichiarato: un helper che sta in un ALTRO file (`src/lib`) e serve sia letture sia scritture non si vede
 * da qui; per quelli vale la lista `HELPER_CONDIVISI` (documentata, senza controllo automatico).
 */

const SRC = path.resolve(__dirname, '../../src')
const METODI_SCRITTURA = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** file di route (relativo a `src/`) → ragione per cui una sua scrittura resta su `assertSezioneInScope`. */
export const ECCEZIONI: Record<string, string> = {}

/**
 * Helper di `src/lib` che chiamano `assertSezioneInScope` per letture E scritture: non si convertono, e il
 * chiamante in scrittura aggiunge da sé il controllo (o il rischio è accettato).
 */
export const HELPER_CONDIVISI: Record<string, string> = {
  'lib/sezioni/risoluzione.ts':
    'risolviSezione serve le sole GET (modulistica, certificati, registro, diario, armadietti: lo si legge dai chiamanti, nessuna POST/PATCH/DELETE la usa): una lettura di un anno passato resta lecita, e le scritture passano da assertSezioneScrivibile',
}

/**
 * Gate di scope che restano com'erano anche in scrittura, e perché. Il lock non li controlla: li dichiara, con la
 * ragione, perché sia chiaro che non sono una dimenticanza.
 */
export const GATE_NON_COPERTI: Record<string, string> = {
  assertAlunnoInScope:
    'la chiave è `alunni.section_id`, cioè la sezione dell’anno attivo: un alunno non ha una sezione di un anno passato da cui scrivere; alla chiusura dell’anno le scritture le ferma la guardia DB `ANNO_CHIUSO` (PR 3-B)',
  assertClasseNomeInScope:
    'la chiave è il NOME della classe (`classe_sezione`), che nella tabella degli alunni è quello dell’anno attivo; alla chiusura dell’anno le scritture le ferma la guardia DB `ANNO_CHIUSO` (PR 3-B)',
}

type Chiamata = { file: string; riga: number; metodo: string }

/** Le chiamate a `assertSezioneInScope(` che stanno in un handler di scrittura (o in un helper fuori dalle GET). */
export function chiamateInScritturaConInScope(file: string, testo: string): Chiamata[] {
  const { senzaCommenti } = mascheraSorgente(testo)
  const esportati = [...senzaCommenti.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)]
    .map((m) => ({ i: m.index, metodo: m[1] }))
  if (!esportati.some((e) => METODI_SCRITTURA.has(e.metodo))) return []
  const out: Chiamata[] = []
  for (const c of senzaCommenti.matchAll(/\bassertSezioneInScope\s*\(/g)) {
    let metodo = 'helper'
    for (const e of esportati) if (e.i <= c.index) metodo = e.metodo
    if (metodo === 'GET') continue
    out.push({ file, riga: riga(testo, c.index), metodo })
  }
  return out
}

const analisi = fileSorgente(SRC).map((f) => ({ file: path.relative(SRC, f), testo: fs.readFileSync(f, 'utf8') }))
const violazioni = analisi.flatMap((a) => chiamateInScritturaConInScope(a.file, a.testo))
const conScrivibile = analisi.filter((a) => /\bassertSezioneScrivibile\s*\(/.test(mascheraSorgente(a.testo).senzaCommenti))

describe('le scritture verificano la sezione con assertSezioneScrivibile', () => {
  it('lo scanner (provato su sorgenti finti)', () => {
    const src = (corpo: string) => `export const GET = withRoute('x:GET', async () => { ${corpo} })`
    const scrittura = (corpo: string) =>
      `${src("await assertSezioneInScope(a, b, c)")}\nexport const POST = withRoute('x:POST', async () => { ${corpo} })`
    expect(chiamateInScritturaConInScope('a.ts', scrittura('await assertSezioneInScope(a, b, c)'))).toHaveLength(1)
    expect(chiamateInScritturaConInScope('a.ts', scrittura('await assertSezioneScrivibile(a, b, c)'))).toHaveLength(0)
    // solo GET: nessuna scrittura, nessun problema
    expect(chiamateInScritturaConInScope('a.ts', src('await assertSezioneInScope(a, b, c)'))).toHaveLength(0)
    // un commento non conta
    expect(chiamateInScritturaConInScope('a.ts', scrittura('// assertSezioneInScope(a, b, c)'))).toHaveLength(0)
    // un helper non esportato prima dei metodi, in un file che scrive
    expect(chiamateInScritturaConInScope('a.ts',
      `async function h() { await assertSezioneInScope(a, b, c) }\n${scrittura('')}`)).toHaveLength(1)
  })

  it('il lock vede le route (minimi: un lock che scansiona zero file è verde)', () => {
    expect(analisi.length).toBeGreaterThan(500)
    expect(conScrivibile.length).toBeGreaterThanOrEqual(25)
  })

  it('nessuna scrittura resta su assertSezioneInScope', () => {
    const fuori = violazioni
      .filter((v) => !(v.file in ECCEZIONI))
      .map((v) => `${v.file}:${v.riga} (${v.metodo})`)
    expect(fuori, 'in una scrittura usa assertSezioneScrivibile (stessa firma)').toEqual([])
  })

  it('i gate dichiarati non coperti hanno una ragione e esistono ancora', () => {
    const scope = fs.readFileSync(path.join(SRC, 'lib/auth/scope.ts'), 'utf8')
    for (const [nome, ragione] of Object.entries(GATE_NON_COPERTI)) {
      expect(ragione.length, nome).toBeGreaterThan(40)
      expect(new RegExp(`export\\s+async\\s+function\\s+${nome}\\b`).test(scope), `${nome}: voce morta`).toBe(true)
    }
  })

  it('ogni eccezione ha una ragione e serve ancora', () => {
    for (const [file, ragione] of Object.entries({ ...ECCEZIONI, ...HELPER_CONDIVISI })) {
      expect(ragione.length, file).toBeGreaterThan(20)
    }
    for (const file of Object.keys(ECCEZIONI)) {
      expect(violazioni.some((v) => v.file === file), `${file} non ha più violazioni: togliere la voce`).toBe(true)
    }
    for (const file of Object.keys(HELPER_CONDIVISI)) {
      expect(analisi.some((a) => a.file === file && /assertSezioneInScope\s*\(/.test(a.testo)), `${file}: voce morta`).toBe(true)
    }
  })
})
