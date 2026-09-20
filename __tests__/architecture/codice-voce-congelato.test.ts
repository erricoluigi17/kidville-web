// @vitest-environment node
/**
 * LOCK · IL CODICE DELLA VOCE È CONGELATO, E L'ALFABETO ESISTE IN UN POSTO SOLO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Il codice della voce (`#K7MXN3P`) viene stampato nella causale che il genitore
 * ricopia nell'home banking, finisce nelle email di sollecito già spedite e resta
 * scritto nei bonifici già partiti. Non vive dentro il database: vive **fuori**,
 * nelle mani delle famiglie. Cambiare alfabeto, lunghezza, seme o mescola non
 * produce un errore da nessuna parte — produce un parco di codici in circolazione
 * che smette di agganciare, in silenzio, tutto insieme.
 *
 * Non c'è un test che possa accorgersene dopo. Può solo esserci un test che lo
 * impedisce prima, ed è questo.
 *
 * ─── PERCHÉ I VETTORI D'ORO SONO RIPETUTI QUI ───────────────────────────────
 * Gli stessi dieci vettori stanno in `__tests__/lib/pagamenti/codice-voce.test.ts`.
 * La ripetizione è VOLUTA, non una svista da centralizzare: quel file è il
 * collaudo del motore e lo riscrive chi lavora sul motore — se i vettori vivessero
 * solo lì, la stessa mano che cambia la mescola aggiornerebbe i vettori nello
 * stesso gesto, e il congelamento sarebbe cerimonia. Un lock lo si rompe in un
 * altro file, e quel rosso obbliga a rispondere a una domanda diversa: «sto
 * invalidando i codici già in circolazione?». Chi centralizzasse questi dieci
 * valori in un modulo condiviso toglierebbe esattamente ciò per cui il lock c'è.
 *
 * Se la risposta a quella domanda è sì, ed è deliberata, la strada è un
 * `SEME_CODICE_VOCE` a `:v2` che tiene vivo il riconoscimento del `:v1` — non un
 * find&replace sui numeri di questo file.
 *
 * ─── COSA SORVEGLIA ─────────────────────────────────────────────────────────
 *  1. i dieci vettori d'oro (uuid sintetici → codice), alla lettera;
 *  2. alfabeto, lunghezza, sigillo e seme sono esattamente quelli dichiarati;
 *  3. la stringa dell'alfabeto non compare in NESSUN altro file di `src/`: una
 *     seconda copia è una copia che un giorno diverge, e divergerebbe in silenzio
 *     perché nessuna delle due sarebbe sbagliata da sola;
 *  4. il modulo non ha NEMMENO UN `import`. È ciò che lo tiene isomorfo fra
 *     server e browser: `causale.ts` lo consumerà, ed è importato da
 *     `CausaliPanel.tsx`, che è `'use client'`. Un `node:crypto` in quella catena
 *     non lo vede `vitest`: salta fuori a `next build`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ALFABETO_CODICE_VOCE,
  LUNGHEZZA_CODICE_VOCE,
  SIGILLO_CODICE_VOCE,
  SEME_CODICE_VOCE,
  codiceVoce,
} from '@/lib/pagamenti/codice-voce'

const RADICE = path.join(process.cwd(), 'src')
const MODULO = path.join('src', 'lib', 'pagamenti', 'codice-voce.ts')

/** I dieci vettori d'oro, ripetuti qui di proposito (vedi la testata). */
const VETTORI_ORO: Record<string, string> = {
  '00000000-0000-4000-8000-000000000000': '#77XKN2T',
  '00000000-0000-4000-8000-000000000001': '#FT7FC33',
  'ffffffff-ffff-4fff-bfff-ffffffffffff': '#YNMC3VF',
  '11111111-2222-4333-8444-555555555555': '#TK2X43V',
  'deadbeef-dead-4eef-bead-deadbeefdead': '#CT2R6HM',
  'abcdef01-2345-4678-9abc-def012345678': '#3R84FP6',
  'c0ffee00-0000-4000-8000-000000000c0f': '#2924KK7',
  '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d': '#V8N3M9N',
  'feedface-cafe-4bad-9dad-facefeedcafe': '#XH28P22',
  '12345678-1234-4123-8123-123456789abc': '#59TC7MK',
}

function fileTs(dir: string, out: string[] = []): string[] {
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name)
    if (voce.isDirectory()) fileTs(p, out)
    else if (/\.tsx?$/.test(voce.name)) out.push(p)
  }
  return out
}

const FILE = fileTs(RADICE).map((assoluto) => ({
  relativo: path.relative(process.cwd(), assoluto),
  sorgente: fs.readFileSync(assoluto, 'utf-8'),
}))

const sorgenteModulo = FILE.find((f) => f.relativo === MODULO)?.sorgente ?? ''

describe('LOCK · il codice della voce è congelato', () => {
  it('la misura vede davvero i sorgenti (controllo positivo)', () => {
    // Senza questo, un percorso sbagliato renderebbe VERDI le regole qui sotto:
    // «zero file letti» e «zero violazioni» hanno lo stesso colore. È il difetto
    // trovato il 2026-09-19 su tre lock di questa cartella, che erano verdi
    // scansionando zero file.
    expect(FILE.length).toBeGreaterThan(500)
    expect(FILE.map((f) => f.relativo)).toContain(MODULO)
    expect(sorgenteModulo.length).toBeGreaterThan(2000)
  })

  it('i dieci VETTORI D’ORO non si muovono', () => {
    for (const [uuid, atteso] of Object.entries(VETTORI_ORO)) {
      expect(
        codiceVoce(uuid),
        `${uuid} → ${codiceVoce(uuid)} invece di ${atteso}. Ogni codice già stampato in una ` +
          'causale, spedito in un sollecito o scritto in un bonifico partito smetterebbe di ' +
          'agganciare, tutto insieme e senza un errore da nessuna parte. Se è deliberato: ' +
          'SEME_CODICE_VOCE a «:v2», tenendo vivo il riconoscimento del «:v1».',
      ).toBe(atteso)
    }
    // Dieci vettori, non nove: cancellarne uno sarebbe un modo silenzioso di
    // allentare il lock.
    expect(Object.keys(VETTORI_ORO).length).toBe(10)
  })

  it('alfabeto, lunghezza, sigillo e seme sono esattamente quelli dichiarati', () => {
    expect(ALFABETO_CODICE_VOCE).toBe('23456789CFHKMNPRTVXY')
    expect(LUNGHEZZA_CODICE_VOCE).toBe(7)
    expect(SIGILLO_CODICE_VOCE).toBe('#')
    expect(SEME_CODICE_VOCE).toBe('kidville:codice-voce:v1')
  })

  it('l’alfabeto non ha una seconda copia in `src/`', () => {
    const altrove = FILE.filter(
      (f) => f.relativo !== MODULO && f.sorgente.includes(ALFABETO_CODICE_VOCE),
    ).map((f) => f.relativo)
    expect(
      altrove,
      'una seconda copia dell’alfabeto diverge al primo ritocco, e divergerebbe in silenzio ' +
        'perché nessuna delle due sarebbe sbagliata da sola. Le regex si costruiscono dalla ' +
        `costante esportata: \`import { ALFABETO_CODICE_VOCE } from '@/lib/pagamenti/codice-voce'\`.\n` +
        altrove.join('\n'),
    ).toEqual([])
  })

  it('il modulo non ha NEMMENO UN import', () => {
    // La forma è quella della specifica: nessuna riga che comincia con `import `.
    expect(
      /^import /m.test(sorgenteModulo),
      'questo modulo finisce nel bundle del browser attraverso `causale.ts` → `CausaliPanel.tsx` ' +
        '(«use client»). Un import qui può trascinarsi dietro `node:crypto`, e quel difetto non ' +
        'lo vede vitest: salta fuori a `next build`.',
    ).toBe(false)
    // Le altre forme con cui una dipendenza entrerebbe lo stesso.
    expect(/\bimport\s*\(/.test(sorgenteModulo), 'import() dinamico').toBe(false)
    // `[^\n;]` e non `[^;]`: una classe negata mangia anche gli a capo, e un
    // modulo senza punti e virgola (lo stile di questa cartella) farebbe attraversare
    // l'intero file a `[^;]*`, con falsi positivi a caso.
    expect(/^export\s+[^\n;]*\bfrom\s+['"]/m.test(sorgenteModulo), 're-export da un altro modulo').toBe(false)
    expect(/\brequire\s*\(/.test(sorgenteModulo), 'require()').toBe(false)
  })

  it('il controllo sugli import può davvero fallire (controllo negativo)', () => {
    // Un test che non si è mai visto fallire non è un test: qui si prova la
    // MISURA su un sorgente finto, invece di fidarsi che la regex sia giusta.
    expect(/^import /m.test("const x = 1\nimport fs from 'node:fs'\n")).toBe(true)
    expect(/^import /m.test('const x = 1\n')).toBe(false)
  })
})
