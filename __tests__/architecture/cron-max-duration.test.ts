import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * LOCK · OGNI ROUTE CHIAMATA DAL CRON DICHIARA LA SUA VITA MASSIMA.
 * (Fase 8 della roadmap di robustezza — 2026-10-11.)
 *
 * Una route cron senza `export const maxDuration` vive quanto dice il default del piano, e
 * un giro che lo supera MUORE A METÀ: le email già partite non si sanno, le prese restano
 * appese, e la riga di chiusura non arriva mai. La ricognizione del 10/10 ne contava dieci
 * senza (solleciti: 104 s misurati il 06/10, per 238 invii). I tetti di tempo interni ai
 * giri (240 s per digest e solleciti) e le prese con scadenza (330 s) sono tarati su una
 * vita di 300: senza la dichiarazione quei numeri non hanno un muro a cui riferirsi.
 *
 * Una route è «del cron» se il suo CODICE (commenti esclusi: la prosa nomina l'header)
 * legge `x-cron-secret` o chiama `segretoCronValido`. Il valore dev'essere un LETTERALE
 * numerico: Next lo legge staticamente, e un `maxDuration = COSTANTE` importata non vale.
 */

const RADICE = process.cwd()
const API = join(RADICE, 'src', 'app', 'api')
/** Le route cron contate il 2026-10-11. Il lock non deve poter diventare cieco: se il
 *  conteggio scende sotto, la scansione si è rotta (o qualcuno ha spostato le route). */
const MINIMO_ROUTE_CRON = 16
/** Il tetto delle Function di Vercel sul piano attuale. */
const MASSIMO_S = 800

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) out.push(...routeFiles(p))
    else if (nome === 'route.ts') out.push(p)
  }
  return out
}

/** Sostituisce i commenti con spazi (mantiene gli a capo): la prosa non conta. */
function senzaCommenti(sorgente: string): string {
  return sorgente
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length))
}

const CRON = /x-cron-secret|segretoCronValido\s*\(/
const DICHIARAZIONE = /^export const maxDuration\s*=\s*(\d+)\s*;?\s*$/m

/** `null` = in regola; altrimenti la violazione, in parole. */
function violazione(sorgente: string): string | null {
  const codice = senzaCommenti(sorgente)
  if (!CRON.test(codice)) return null
  const m = DICHIARAZIONE.exec(codice)
  if (!m) return 'manca `export const maxDuration = <secondi>` (letterale numerico)'
  const s = Number(m[1])
  if (s < 60 || s > MASSIMO_S) return `maxDuration = ${s}: fuori da 60…${MASSIMO_S} s`
  return null
}

describe('lock — ogni route del cron dichiara maxDuration (fase 8 robustezza)', () => {
  const tutte = routeFiles(API)
  const cron = tutte.filter((f) => CRON.test(senzaCommenti(readFileSync(f, 'utf8'))))

  it(`la scansione vede almeno ${MINIMO_ROUTE_CRON} route del cron (un lock cieco è verde su zero file)`, () => {
    expect(cron.length).toBeGreaterThanOrEqual(MINIMO_ROUTE_CRON)
  })

  it('nessuna route del cron senza una vita massima dichiarata', () => {
    const fuori = cron
      .map((f) => ({ f: relative(RADICE, f), v: violazione(readFileSync(f, 'utf8')) }))
      .filter((x) => x.v !== null)
      .map((x) => `${x.f}: ${x.v}`)
    expect(fuori, fuori.join('\n')).toEqual([])
  })

  it('il criterio morde: senza dichiarazione, con un valore assurdo, o con il solo commento', () => {
    const base = "const s = request.headers.get('x-cron-secret')\n"
    expect(violazione(base)).toMatch(/manca/)
    expect(violazione(`export const maxDuration = 5\n${base}`)).toMatch(/fuori/)
    expect(violazione(`// export const maxDuration = 300\n${base}`)).toMatch(/manca/)
    expect(violazione(`export const maxDuration = DURATA\n${base}`)).toMatch(/manca/)
    expect(violazione(`export const maxDuration = 300\n${base}`)).toBeNull()
    // una route che NOMINA l'header solo nella prosa non è del cron
    expect(violazione("// chiamata col suo x-cron-secret\nexport const GET = 1\n")).toBeNull()
  })
})
