import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
 *
 * SESSIONE 9 DELLA SECONDA SERIE: il lock vale anche per le route LUNGHE che non sono del cron
 * (esportazioni, PDF in blocco, invii in fila, la traduzione). Ognuna sta in `ROUTE_LUNGHE` col
 * suo perché, e una route che importa un lavoro pesante (`IMPORT_PESANTE`) senza starci, e senza
 * essere del cron, fa rosso.
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

/** Il valore dichiarato, o `null` se manca (o non è un letterale numerico). Commenti già tolti. */
function durataDichiarata(codice: string): number | null {
  const m = DICHIARAZIONE.exec(codice)
  return m ? Number(m[1]) : null
}

/** `null` = in regola; altrimenti cosa non va, in parole. */
function fuoriMisura(s: number | null): string | null {
  if (s === null) return 'manca `export const maxDuration = <secondi>` (letterale numerico)'
  if (s < 60 || s > MASSIMO_S) return `maxDuration = ${s}: fuori da 60…${MASSIMO_S} s`
  return null
}

/** `null` = in regola; altrimenti la violazione, in parole. */
function violazione(sorgente: string): string | null {
  const codice = senzaCommenti(sorgente)
  if (!CRON.test(codice)) return null
  return fuoriMisura(durataDichiarata(codice))
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

/**
 * LE ROUTE LUNGHE CHE NON SONO DEL CRON (sessione 9 della seconda serie di robustezza).
 *
 * Senza `maxDuration` una route vive quanto il default del piano, e il giorno in cui il default
 * cambia (o il progetto passa a un altro piano) un'esportazione grande o un invio in fila muore a
 * metà senza che nessun file lo dica. Qui ogni route lunga sta con il suo perché: il numero lo
 * scrive la route, la ragione la scrive questa mappa. Una route nuova che importa un lavoro
 * pesante e non è qui fa rosso (`IMPORT_PESANTE`).
 */
const ROUTE_LUNGHE = new Map<string, string>([
  ['src/app/api/chat/translate/route.ts', 'traduzione con Claude: 20 s per tentativo, un ritentativo, attesa massima 5 s, 45 s nel caso peggiore'],
  ['src/app/api/admin/iscrizioni/rinvia-credenziali/route.ts', 'fino a 100 email in fila, con la pausa fra una e la successiva e il tetto di 10 s di Resend per ciascuna'],
  ['src/app/api/admin/candidature-insegnanti/inoltro-arretrato/route.ts', 'fino a 60 inoltri con il curriculum allegato, in fila, con il tetto di 10 s di Resend per ciascuno'],
  ['src/app/api/admin/registro-presenze/pdf/route.ts', 'PDF mensile delle presenze di una classe intera, composto sul server'],
  ['src/app/api/primaria/pagella/batch/route.ts', 'una pagella PDF per alunno, in sequenza, per tutta la classe'],
  ['src/app/api/admin/competenze/genera/route.ts', 'genera e firma un certificato delle competenze per ogni id ricevuto'],
  ['src/app/api/forms/export/pdf/route.ts', 'jsPDF con le risposte di un modulo, pagina per pagina, per tutta la sede'],
  ['src/app/api/forms/export/xlsx/route.ts', 'foglio xlsx in memoria con tutte le risposte di un modulo'],
  ['src/app/api/forms/export/delibera/route.ts', 'delibera in jsPDF con la lista completa delle adesioni'],
  ['src/app/api/pagamenti/export/route.ts', 'foglio xlsx con lo scadenziario di una sede'],
  ['src/app/api/admin/merch/export/route.ts', 'foglio xlsx con gli ordini di divise e merchandising'],
  ['src/app/api/admin/protocolli/export/route.ts', 'foglio xlsx con il registro di protocollo di un anno intero'],
  ['src/app/api/avvisi/[id]/risposte/esporta/route.ts', 'CSV con tutte le adesioni a un avviso, una riga per risposta'],
  ['src/app/api/prestampati/genera/route.ts', 'modello, Storage, PDF, protocollo e caricamento nel fascicolo, in sequenza'],
  ['src/app/api/admin/sidi/import/route.ts', 'riceve, decomprime e importa lo zip del SIDI'],
  ['src/app/api/admin/import/anagrafiche/route.ts', 'fino a 2.000 righe di anagrafiche, con la deduplica sul codice fiscale'],
  ['src/app/api/pagamenti/genera/route.ts', 'voci e rate per ogni alunno di una classe o di un elenco'],
  ['src/app/api/admin/gdpr/erase/route.ts', 'file nello Storage e molte tabelle, genitore per genitore'],
  ['src/app/api/admin/students/libera-spazio/route.ts', 'rimuove foto, video e messaggi di un alunno dallo Storage'],
  ['src/app/api/admin/iscrizioni/elenco/export/route.ts', 'foglio xlsx con tutte le domande di iscrizione della sede'],
])
/** Contate il 2026-10-20. Se l'elenco scende sotto, qualcuno l'ha accorciato senza dirlo. */
const MINIMO_ROUTE_LUNGHE = 20

/** Un import che vuol dire «questa route lavora a lungo». */
const IMPORT_PESANTE = /from\s+['"](jspdf|jspdf-autotable|xlsx|pdf-lib|jszip|exceljs|@\/lib\/translate\/claude|@\/lib\/email\/ritmo)['"]/
/** Le route con un import pesante contate il 2026-10-20 (cron comprese): il controllo positivo. */
const MINIMO_IMPORT_PESANTI = 10

describe('lock — anche le route lunghe che non sono del cron dichiarano maxDuration (sessione 9)', () => {
  const tutte = routeFiles(API)

  it(`l'elenco ha almeno ${MINIMO_ROUTE_LUNGHE} route, e ogni file esiste`, () => {
    expect(ROUTE_LUNGHE.size).toBeGreaterThanOrEqual(MINIMO_ROUTE_LUNGHE)
    const mancanti = [...ROUTE_LUNGHE.keys()].filter((f) => !existsSync(join(RADICE, f)))
    expect(mancanti, mancanti.join('\n')).toEqual([])
  })

  it('ogni voce dice perché, in almeno 20 caratteri', () => {
    const corte = [...ROUTE_LUNGHE].filter(([, perche]) => perche.trim().length < 20).map(([f]) => f)
    expect(corte).toEqual([])
  })

  it('ogni route lunga dichiara una vita fra 60 e 800 s', () => {
    const fuori = [...ROUTE_LUNGHE.keys()]
      .filter((f) => existsSync(join(RADICE, f)))
      .map((f) => ({ f, v: fuoriMisura(durataDichiarata(senzaCommenti(readFileSync(join(RADICE, f), 'utf8')))) }))
      .filter((x) => x.v !== null)
      .map((x) => `${x.f}: ${x.v}`)
    expect(fuori, fuori.join('\n')).toEqual([])
  })

  it(`ogni route con un import pesante è nell'elenco o è del cron (controllo positivo: almeno ${MINIMO_IMPORT_PESANTI})`, () => {
    const pesanti = tutte
      .map((f) => ({ rel: relative(RADICE, f), codice: senzaCommenti(readFileSync(f, 'utf8')) }))
      .filter((x) => IMPORT_PESANTE.test(x.codice))
    expect(pesanti.length).toBeGreaterThanOrEqual(MINIMO_IMPORT_PESANTI)
    const scoperte = pesanti.filter((x) => !ROUTE_LUNGHE.has(x.rel) && !CRON.test(x.codice)).map((x) => x.rel)
    expect(scoperte, `route con un import pesante, fuori da ROUTE_LUNGHE: aggiungile col perché\n${scoperte.join('\n')}`).toEqual([])
  })

  it('il rilevatore morde', () => {
    expect(IMPORT_PESANTE.test("import { jsPDF } from 'jspdf'")).toBe(true)
    expect(IMPORT_PESANTE.test("import * as XLSX from 'xlsx'")).toBe(true)
    expect(IMPORT_PESANTE.test("import { translateText } from '@/lib/translate/claude'")).toBe(true)
    expect(IMPORT_PESANTE.test("import { z } from 'zod'")).toBe(false)
    expect(IMPORT_PESANTE.test(senzaCommenti("// import { jsPDF } from 'jspdf'\n"))).toBe(false)
    expect(fuoriMisura(durataDichiarata('export const maxDuration = 30\n'))).toMatch(/fuori/)
    expect(fuoriMisura(durataDichiarata('const x = 1\n'))).toMatch(/manca/)
    expect(fuoriMisura(durataDichiarata('export const maxDuration = 300\n'))).toBeNull()
  })
})
