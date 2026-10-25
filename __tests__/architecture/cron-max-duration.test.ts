import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  ASSENTI_IN_PRODUZIONE, INVOLUCRO, NON_SI_AVVOLGONO, contaChiamate, corpoDi, corpoOVuoto, mascheraSql, ultimeDefinizioni,
} from '../../scripts/cron-esiti/involucro.mjs'
import { TIMEOUT_PREDEFINITO_MS, chiamataAllInvolucro, conTimeout } from '../../scripts/cron-esiti/timeout.mjs'

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

// ═════════════════════════════════════════════════════════════════════════════
// IL LATO SQL: IL TIMEOUT DI pg_net È IL maxDuration DELLA ROUTE
// (sessione 8 della seconda serie di robustezza — S1, «timeout finti»).
//
// pg_net chiude il lato client dopo `timeout_milliseconds` (5000 se non lo si passa), ma la route
// su Vercel prosegue e finisce: in `net._http_response` resta «Timeout of 5000 ms reached» al
// posto dell'esito vero. Il 20/10 erano 27 in circa 6 ore. Il timeout giusto è la vita massima
// della route che il giro chiama, in millisecondi: si smette di aspettare quando la piattaforma
// stessa non può più rispondere, non prima (stessa scelta di
// `20260911113000_fattura_sync_timeout_pg_net.sql`).
//
// Dalla sessione 6 ogni funzione chiama `public.cron_http_post('<job>', url := …, …)`: gli
// argomenti di `net.http_post`, per nome, col job davanti. Il timeout è l'argomento
// `timeout_milliseconds` DENTRO quella chiamata (5000 se manca). L'origine dell'URL viene dal
// Vault; il percorso è un letterale del corpo (`origine || '/api/…'`), salvo per le funzioni di
// `URL_INTERO_DAL_VAULT`, che leggono dal Vault l'URL intero. `CHIAMANTI_CRON` dice quale funzione
// SQL chiama quale route, e il criterio lo confronta col corpo (percorso o chiave del Vault), oltre
// a SECURITY DEFINER e SET search_path della definizione. Una voce per riga, in questa forma
// esatta: lo script che genera la migrazione la legge così. Lettura e riscrittura della chiamata
// stanno in `scripts/cron-esiti/timeout.mjs`, lo stesso modulo che usa lo script.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `timeoutDecisoMs`: un timeout scelto dal titolare al posto del `maxDuration` della route. Oggi
 * solo `video_runner_kick`, che non è un job ma un trigger a ogni caricamento video: a 300 s ogni
 * caricamento terrebbe un posto di pg_net finché il runner lavora (specifica, §7, sessione 8).
 */
type Chiamante = { funzione: string; job: string; route: string; timeoutDecisoMs?: number }

const CHIAMANTI_CRON: readonly Chiamante[] = [
  { funzione: 'notifiche_dispatch_tick', job: 'notifiche-dispatch', route: 'src/app/api/push/dispatch/route.ts' },
  { funzione: 'notifiche_promemoria_tick', job: 'notifiche-promemoria', route: 'src/app/api/notifiche/promemoria/route.ts' },
  { funzione: 'mensa_check_allergie_giornaliero', job: 'mensa-check-allergie', route: 'src/app/api/mensa/allergie-check/route.ts' },
  { funzione: 'fatture_sdi_sync_tick', job: 'fatture-sdi-sync', route: 'src/app/api/pagamenti/fattura/sync/route.ts' },
  { funzione: 'fatture_coda_tick_http', job: 'fatture-coda-tick', route: 'src/app/api/pagamenti/fattura/coda/giro/route.ts' },
  { funzione: 'pagamenti_solleciti_tick', job: 'pagamenti-solleciti-run', route: 'src/app/api/pagamenti/solleciti/run/route.ts' },
  { funzione: 'news_tick', job: 'news-tick', route: 'src/app/api/news/cron/run/route.ts' },
  { funzione: 'news_digest_tick', job: 'news-digest', route: 'src/app/api/news/cron/run/route.ts' },
  { funzione: 'iscrizioni_retention_http', job: 'iscrizioni-retention', route: 'src/app/api/gdpr/retention-iscrizioni/route.ts' },
  { funzione: 'iscrizioni_import_invio_http', job: 'iscrizioni-import-invio', route: 'src/app/api/iscrizione/import-massivo/route.ts' },
  { funzione: 'candidature_retention_http', job: 'candidature-retention', route: 'src/app/api/gdpr/retention-candidature/route.ts' },
  { funzione: 'retention_personale_http', job: 'retention-personale', route: 'src/app/api/gdpr/retention-personale/route.ts' },
  { funzione: 'scadenze_documenti_personale_http', job: 'scadenze-documenti-personale', route: 'src/app/api/notifiche/scadenze-documenti/route.ts' },
  { funzione: 'galleria_retention_http', job: 'galleria-retention', route: 'src/app/api/gdpr/retention-galleria/route.ts' },
  { funzione: 'video_retention_http', job: 'video-retention', route: 'src/app/api/gdpr/retention-video/route.ts' },
  { funzione: 'video_runner_tick_http', job: 'video-runner-tick', route: 'src/app/api/video/runner/route.ts' },
  { funzione: 'video_runner_kick', job: 'video-runner-kick', route: 'src/app/api/video/runner/route.ts', timeoutDecisoMs: 5000 },
  { funzione: 'cestino_registro_retention_http', job: 'cestino-registro-retention', route: 'src/app/api/gdpr/retention-cestino-registro/route.ts' },
  { funzione: 'storici_tick', job: 'storici-stampe', route: 'src/app/api/admin/storici/cron/route.ts' },
]

/** Le funzioni contate nel repo il 2026-10-20 (15 a 5000 ms, 4 con il timeout esplicito). */
const MINIMO_CHIAMANTI = 19
const MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
/** Escluse dalla sessione 6, ciascuna con la sua ragione: chiamano ancora `net.http_post` da sole. */
const ESCLUSE_DALLA_S06: Record<string, string> = { ...NON_SI_AVVOLGONO, ...ASSENTI_IN_PRODUZIONE }

function esisteFile(percorso: string): boolean {
  return statSync(join(RADICE, percorso), { throwIfNoEntry: false })?.isFile() ?? false
}

function maxDurationMs(route: string): number | null {
  if (!esisteFile(route)) return null
  const m = DICHIARAZIONE.exec(senzaCommenti(readFileSync(join(RADICE, route), 'utf8')))
  return m ? Number(m[1]) * 1000 : null
}

/** Il percorso che la route serve: `src/app/api/x/route.ts` → `/api/x`. */
function percorsoDi(route: string): string {
  return route.replace(/^src\/app/, '').replace(/\/route\.ts$/, '')
}

/**
 * Le funzioni che leggono dal Vault l'URL INTERO, percorso compreso: nel corpo il percorso non c'è,
 * e il legame con la route è la chiave del Vault. Per tutte le altre il percorso è un letterale del
 * corpo (`origine || '/api/…'`), e deve essere quello della route della tabella.
 */
const URL_INTERO_DAL_VAULT: Readonly<Record<string, string>> = {
  notifiche_dispatch_tick: 'app.push_dispatch_url',
  notifiche_promemoria_tick: 'app.notifiche_promemoria_url',
  mensa_check_allergie_giornaliero: 'app.mensa_allergie_url',
  fatture_sdi_sync_tick: 'app.fattura_sync_url',
  iscrizioni_retention_http: 'app.retention_iscrizioni_url',
}

/** Il percorso chiamato, o la sua assenza, contro la tabella; `corpo` senza commenti, stringhe comprese. */
function violazionePercorso(c: Chiamante, codice: string): string | null {
  const percorsi = [...new Set([...codice.matchAll(/'(\/api\/[^'?]*)/g)].map((m) => m[1]))]
  const chiave = URL_INTERO_DAL_VAULT[c.funzione]
  if (chiave !== undefined) {
    if (percorsi.length > 0) return `percorso ${percorsi.join(', ')} nel corpo, ma per la tabella l'URL intero viene da ${chiave}`
    return codice.includes(`cron_config('${chiave}')`) ? null : `non legge ${chiave} dal Vault`
  }
  const atteso = percorsoDi(c.route)
  if (percorsi.length === 0) return `nessun percorso '/api/…' nel corpo: la route della tabella è ${atteso}`
  const altri = percorsi.filter((p) => p !== atteso)
  return altri.length === 0 ? null : `chiama ${altri.join(', ')}, la route della tabella è ${atteso}`
}

/**
 * `null` = in regola; altrimenti la violazione, in parole. `definizione` è il CREATE OR REPLACE
 * intero. Fuori dal corpo (testata e coda, senza commenti né stringhe): SECURITY DEFINER e SET
 * search_path, perché la funzione legge il Vault e scrive app_log come proprietario. Nel corpo: il
 * percorso chiamato (`violazionePercorso`), poi job e timeout, che legge `chiamataAllInvolucro`;
 * quella si ferma con un messaggio su ogni forma che non conosce, e il messaggio è la violazione.
 */
function violazioneSql(c: Chiamante, definizione: string): string | null {
  let parti: { testata: string; tag: string; corpo: string; coda: string }
  let chiamata: { job: string; timeoutMs: number; nominato: boolean }
  try {
    parti = corpoDi(definizione)
    chiamata = chiamataAllInvolucro(parti.corpo)
  } catch (e) {
    return (e as Error).message
  }
  // La testata finisce col tag che apre il corpo: senza toglierlo, la maschera nasconderebbe la coda.
  const fuori = mascheraSql(`${parti.testata.slice(0, -parti.tag.length)}\n${parti.coda}`)
  if (!/\bSECURITY\s+DEFINER\b/i.test(fuori)) return 'senza SECURITY DEFINER'
  if (!/\bSET\s+search_path\b/i.test(fuori)) return 'senza SET search_path'
  const percorso = violazionePercorso(c, mascheraSql(parti.corpo, { stringhe: false }))
  if (percorso !== null) return percorso
  if (chiamata.job !== c.job) return `job '${chiamata.job}', la tabella dice '${c.job}'`
  if (c.timeoutDecisoMs !== undefined) {
    return chiamata.timeoutMs === c.timeoutDecisoMs
      ? null
      : `timeout ${chiamata.timeoutMs} ms, il titolare ha deciso ${c.timeoutDecisoMs} ms per ${c.funzione}`
  }
  const atteso = maxDurationMs(c.route)
  if (atteso === null) return `${c.route} non esiste o non dichiara maxDuration`
  if (chiamata.timeoutMs !== atteso) {
    const come = chiamata.nominato ? '' : ' (predefinito: manca `timeout_milliseconds`)'
    return `timeout ${chiamata.timeoutMs} ms${come}, il maxDuration di ${c.route} vale ${atteso} ms`
  }
  return null
}

/** Per «il criterio morde»: una definizione intera, come quelle delle migrazioni. */
const TESTATA =
  "CREATE OR REPLACE FUNCTION public.x()\n RETURNS void\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\nAS $function$\n"
const PERCORSO = "v_url := v_origine || '/api/admin/storici/cron';"
function definizione(corpo: string, testata: string = TESTATA): string {
  return `${testata}BEGIN\n  ${corpo}\nEND;\n$function$\n`
}

describe('lock — il timeout di pg_net è il maxDuration della route (sessione 8, seconda serie)', () => {
  const ultime = ultimeDefinizioni(MIGRAZIONI)
  const corpo = (funzione: string): string => corpoOVuoto(ultime.get(funzione)?.definizione ?? '')

  it(`la tabella ha almeno ${MINIMO_CHIAMANTI} voci, e ogni voce ha la sua definizione e la sua route`, () => {
    expect(CHIAMANTI_CRON.length).toBeGreaterThanOrEqual(MINIMO_CHIAMANTI)
    const mancanti = CHIAMANTI_CRON.filter((c) => !ultime.has(c.funzione)).map((c) => c.funzione)
    expect(mancanti, `nessuna migrazione definisce: ${mancanti.join(', ')}`).toEqual([])
    const senzaRoute = CHIAMANTI_CRON.filter((c) => !esisteFile(c.route)).map((c) => c.route)
    expect(senzaRoute, `route che non esistono: ${senzaRoute.join(', ')}`).toEqual([])
  })

  it('ogni funzione che chiama il server è nella tabella (salvo le escluse dalla sessione 6)', () => {
    const note = new Set(CHIAMANTI_CRON.map((c) => c.funzione))
    const fuori = [...ultime.keys()]
      .filter((nome) => nome !== INVOLUCRO && !Object.hasOwn(ESCLUSE_DALLA_S06, nome))
      .filter((nome) => {
        const { dirette, avvolte } = contaChiamate(corpo(nome))
        return dirette + avvolte > 0
      })
      .filter((nome) => !note.has(nome))
    expect(
      fuori,
      `Chiamano il server ma non sono in CHIAMANTI_CRON: ${fuori.join(', ')}. Aggiungi la voce con la ` +
        'route che chiamano: senza, nessuno controlla il loro timeout.',
    ).toEqual([])
  })

  it('ogni chiamante passa a cron_http_post il maxDuration della sua route', () => {
    const fuori = CHIAMANTI_CRON.flatMap((c) => {
      const d = ultime.get(c.funzione)
      if (!d) return []
      const v = violazioneSql(c, d.definizione)
      return v === null ? [] : [`${c.funzione} (${d.file}): ${v}`]
    })
    expect(fuori, fuori.join('\n')).toEqual([])
  })

  it('l’elenco delle funzioni con l’URL intero dal Vault nomina solo chiamanti della tabella', () => {
    const note = new Set(CHIAMANTI_CRON.map((c) => c.funzione))
    expect(Object.keys(URL_INTERO_DAL_VAULT).filter((f) => !note.has(f))).toEqual([])
  })

  it('il criterio morde: default 5000, valore sbagliato, chiamata diretta, job sbagliato, timeout non letterale o per posizione', () => {
    const c: Chiamante = { funzione: 'x', job: 'storici-stampe', route: 'src/app/api/admin/storici/cron/route.ts' }
    const giusta = "PERFORM public.cron_http_post('storici-stampe', url := v_url, headers := v_h, timeout_milliseconds := 300000);"
    const v = (corpo: string): string | null => violazioneSql(c, definizione(`${PERCORSO}\n  ${corpo}`))
    expect(v(giusta)).toBeNull()
    expect(v(giusta.replace(':= 300000', '=> 300000'))).toBeNull()
    expect(v(giusta.replace('300000', '5000'))).toMatch(/^timeout 5000 ms, il maxDuration/)
    expect(v("PERFORM public.cron_http_post('storici-stampe', url := v_url, headers := v_h);"))
      .toMatch(/^timeout 5000 ms \(predefinito/)
    expect(v('PERFORM net.http_post(url := v_url);')).toMatch(/direttamente/)
    expect(v(giusta.replace("'storici-stampe'", "'altro'"))).toMatch(/job 'altro'/)
    expect(v(giusta.replace('300000', 'v_ms'))).toMatch(/non è un numero letterale/)
    expect(v("PERFORM public.cron_http_post('storici-stampe', v_url, '{}'::jsonb, '{}'::jsonb, v_h, 300000);"))
      .toMatch(/per posizione/)
    expect(v(`${giusta}\n${giusta}`)).toMatch(/trovate 2/)
    // Conta solo il timeout DENTRO la chiamata: non quello di un commento né quello di un'altra istruzione.
    expect(v("-- timeout_milliseconds := 300000\nPERFORM public.cron_http_post('storici-stampe', url := v_url);"))
      .toMatch(/^timeout 5000 ms \(predefinito/)
    expect(v("PERFORM public.cron_http_post('storici-stampe', url := v_url);\nPERFORM altra(timeout_milliseconds := 300000);"))
      .toMatch(/^timeout 5000 ms \(predefinito/)
    expect(TIMEOUT_PREDEFINITO_MS).toBe(5000)
  })

  it('il criterio morde: percorso della route, SECURITY DEFINER e SET search_path', () => {
    const c: Chiamante = { funzione: 'x', job: 'storici-stampe', route: 'src/app/api/admin/storici/cron/route.ts' }
    const chiamata = "PERFORM public.cron_http_post('storici-stampe', url := v_url, timeout_milliseconds := 300000);"
    const giusta = `${PERCORSO}\n  ${chiamata}`
    expect(violazioneSql(c, definizione(giusta))).toBeNull()
    // Il percorso: un altro, nessuno, solo in un commento, uno in più; la query string non conta.
    expect(violazioneSql(c, definizione(giusta.replace('/storici/cron', '/storici/run'))))
      .toBe('chiama /api/admin/storici/run, la route della tabella è /api/admin/storici/cron')
    expect(violazioneSql(c, definizione(chiamata))).toMatch(/^nessun percorso '\/api\/…' nel corpo/)
    expect(violazioneSql(c, definizione(`-- ${PERCORSO}\n  ${chiamata}`))).toMatch(/^nessun percorso/)
    expect(violazioneSql(c, definizione(`${giusta}\n  v_altra := v_origine || '/api/news/cron/run';`)))
      .toMatch(/^chiama \/api\/news\/cron\/run,/)
    expect(violazioneSql(c, definizione(giusta.replace("cron';", "cron?giro=1';")))).toBeNull()
    // SECURITY DEFINER e search_path: assenti, in un commento, INVOKER; ammessi anche dopo il corpo.
    expect(violazioneSql(c, definizione(giusta, TESTATA.replace(' SECURITY DEFINER\n', '')))).toBe('senza SECURITY DEFINER')
    expect(violazioneSql(c, definizione(giusta, TESTATA.replace(' SECURITY DEFINER\n', ' -- SECURITY DEFINER\n'))))
      .toBe('senza SECURITY DEFINER')
    expect(violazioneSql(c, definizione(giusta, TESTATA.replace('SECURITY DEFINER', 'SECURITY INVOKER')))).toBe('senza SECURITY DEFINER')
    expect(violazioneSql(c, definizione(giusta, TESTATA.replace(" SET search_path TO 'public', 'pg_temp'\n", ''))))
      .toBe('senza SET search_path')
    expect(violazioneSql(c, definizione(giusta, TESTATA.replace(' SET search_path', ' -- SET search_path'))))
      .toBe('senza SET search_path')
    const inCoda = `CREATE OR REPLACE FUNCTION public.x() RETURNS void AS $$\nBEGIN\n  ${giusta}\nEND;\n$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;`
    expect(violazioneSql(c, inCoda)).toBeNull()
    expect(violazioneSql(c, inCoda.replace(' SECURITY DEFINER', ''))).toBe('senza SECURITY DEFINER')
    // L'URL intero dal Vault: la chiave dell'elenco, e nessun percorso nel corpo.
    const dispatch: Chiamante = { funzione: 'notifiche_dispatch_tick', job: 'notifiche-dispatch', route: 'src/app/api/push/dispatch/route.ts' }
    const ms = maxDurationMs(dispatch.route)
    expect(ms).not.toBeNull()
    const dalVault = `v_url := public.cron_config('app.push_dispatch_url');\n  PERFORM public.cron_http_post('notifiche-dispatch', url := v_url, timeout_milliseconds := ${ms});`
    expect(violazioneSql(dispatch, definizione(dalVault))).toBeNull()
    expect(violazioneSql(dispatch, definizione(dalVault.replace('app.push_dispatch_url', 'app.notifiche_promemoria_url'))))
      .toBe('non legge app.push_dispatch_url dal Vault')
    expect(violazioneSql(dispatch, definizione(dalVault.replace("('app.push_dispatch_url')", "('app.push_dispatch_url') || '/api/altro'"))))
      .toMatch(/^percorso \/api\/altro nel corpo/)
  })

  it('conTimeout cambia una cosa sola: il numero, o l’argomento aggiunto in fondo alla chiamata', () => {
    const def = (chiamata: string): string =>
      `CREATE OR REPLACE FUNCTION public.x()\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  ${chiamata}\nEND;\n$function$\n`
    const conValore = "PERFORM public.cron_http_post('a', url:=v_url, body:='{}'::jsonb, timeout_milliseconds:=120000);"
    expect(conTimeout(def(conValore), 300000)).toBe(def(conValore.replace(':=120000', ':=300000')))
    const senza = "PERFORM public.cron_http_post('a',\n    url := v_url,\n    body := '{}'::jsonb -- corpo vuoto\n  );"
    const dopo = conTimeout(def(senza), 300000)
    expect(dopo).toBe(def(senza.replace("'{}'::jsonb -- corpo", "'{}'::jsonb, timeout_milliseconds := 300000 -- corpo")))
    expect(chiamataAllInvolucro(corpoDi(dopo).corpo)).toMatchObject({ job: 'a', timeoutMs: 300000, nominato: true })
    const freccia = "PERFORM public.cron_http_post('a', url => v_url);"
    expect(conTimeout(def(freccia), 300000)).toBe(def(freccia.replace('v_url)', 'v_url, timeout_milliseconds => 300000)')))
    expect(() => conTimeout(def('PERFORM net.http_post(url := v_url);'), 300000)).toThrow('direttamente')
  })
})
