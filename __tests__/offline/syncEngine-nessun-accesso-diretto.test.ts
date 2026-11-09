// @vitest-environment node

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileSorgente, mascheraSorgente, riga } from '../fixtures/sorgente'

/**
 * IL BROWSER NON LEGGE DIRETTAMENTE LE TABELLE DI VISIBILITÀ DEL GENITORE (compito 4.4.8, R-44-6).
 *
 * La PR 4.4 decide che cosa vede una famiglia con funzioni SQL, policy e route. Non scrive nessuna
 * policy per `syncEngine` perché i chiamanti vivi passano dalle route: ma una `from('pagamenti')`
 * scritta domani in un componente leggerebbe con la RLS di quel momento, senza passare da
 * `figliAttivi`, e senza un errore. Questo lock lo fa notare.
 *
 * COME SI DECIDE CHE COS'È «BROWSER». Il piano nominava `syncEngine.ts` e `ImportExportClient.tsx`.
 * Una lettura però si nasconde bene in un modulo condiviso, che non costruisce nessun client e riceve
 * `supabase` come parametro. Quindi si parte da ogni file con `'use client'` (più i nominati) e si
 * seguono gli import: è quello che il bundler manda nel browser.
 *
 * CHE COSA CONTA COME LETTURA DIRETTA: `.from('tabella')` (non `.storage.from`, non `Array.from`),
 * `.from(variabile)` perché può essere qualunque tabella, un abbonamento `postgres_changes` e un
 * `fetch` a mano su `/rest/v1/tabella`.
 *
 * CHE COSA NON VEDE, detto qui perché non si creda altro:
 *  · `.rpc('…')`: i wrapper `*_miei()` nascono proprio per `authenticated`, e li sorveglia la PR 4.4;
 *  · un nome di tabella costruito a pezzi e passato per una variabile: lo segnala come `dinamica`,
 *    non sa quale sia;
 *  · il canale `chat:<uid>`: è una broadcast che il trigger filtra (4.4.4), non una lettura di
 *    tabella. Il suo nome lo tiene `__tests__/lib/chat-broadcast-privato-sql.test.ts`.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')

/** `chat_*` e non le due di oggi: una terza tabella della chat avrebbe lo stesso problema. */
const VIETATA = /^(galleria_media_v2|news_posts|pagamenti|chat_\w+)$/

/** Nominati dal piano: si guardano anche se un giorno nessuno li importasse più da un `'use client'`. */
const RADICI_NOMINATE = [
  'src/lib/offline/syncEngine.ts',
  'src/components/features/admin/ImportExportClient.tsx',
  'src/lib/supabase/browser-client.ts',
]

/** Chi espone un `from` statico che non è PostgREST. */
const RICEVENTI_ESTRANEI = new Set(['Array', 'Buffer', 'Uint8Array', 'Uint16Array', 'Float32Array', 'Object', 'Observable'])

/**
 * Che cosa tocca oggi il browser, e perché va bene. Un file nuovo o una tabella nuova fanno rosso:
 * R-44-6 chiede che una lettura diretta si noti, anche quando non è una delle tabelle vietate.
 * Nessuna di queste gira davvero nel browser: se una lo facesse, non sarebbe una voce da aggiungere.
 */
const DICHIARATE = new Map<string, { tabelle: string[]; perche: string }>([
  ['src/lib/offline/syncEngine.ts', {
    tabelle: ['daily_routines', 'presenze', 'utenti'],
    perche: 'Codice morto: `syncPendingLogs`, `syncPendingDiaryEntries` e `syncAdults` non hanno chiamanti. '
      + 'I chiamanti vivi del file (appello, registro, galleria) passano dalle route.',
  }],
  ['src/lib/crm/settimane.ts', {
    tabelle: ['crm_fasce', 'crm_settimane'],
    perche: 'Il componente importa solo le funzioni di calendario. `leggiSettimaneEFasce` riceve il client '
      + 'come parametro e la chiamano soltanto le route `admin/crm/*`.',
  }],
  ['src/lib/forms/enrollment-default-schema.ts', {
    tabelle: ['form_models'],
    perche: 'I componenti importano solo costanti e schema. `ensureStandardEnrollmentModel` riceve il client '
      + 'come parametro e la chiamano soltanto le route `iscrizione` e `admin/form-models/reset`.',
  }],
])

const relativo = (assoluto: string) => path.relative(RADICE, assoluto).split(path.sep).join('/')

const SORGENTI = new Map<string, string>(
  fileSorgente(SRC).map((f) => [relativo(f), fs.readFileSync(f, 'utf8')]),
)

/** La maschera costa, e di ogni file serve più volte. */
const MASCHERATI = new Map<string, string>()
function senzaCommenti(sorgente: string): string {
  let testo = MASCHERATI.get(sorgente)
  if (testo === undefined) {
    testo = mascheraSorgente(sorgente).senzaCommenti
    MASCHERATI.set(sorgente, testo)
  }
  return testo
}

/**
 * Le specifiche importate come VALORE. `import type` sparisce alla compilazione, e con lui il file
 * da cui prende il tipo: seguirlo farebbe entrare nel browser mezzo server.
 */
function importDiValore(sorgente: string): string[] {
  const testo = senzaCommenti(sorgente)
  const trovate: string[] = []
  const statici = /\b(import|export)\s+(type\s+)?([^'"`;]*?)\s*from\s*['"]([^'"]+)['"]/g
  for (const m of testo.matchAll(statici)) {
    if (m[2]) continue
    const graffe = /^\{([\s\S]*)\}$/.exec(m[3].trim())
    if (graffe) {
      const voci = graffe[1].split(',').map((v) => v.trim()).filter(Boolean)
      if (voci.length > 0 && voci.every((v) => /^type\s/.test(v))) continue
    }
    trovate.push(m[4])
  }
  for (const m of testo.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) trovate.push(m[1])
  for (const m of testo.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) trovate.push(m[1])
  return trovate
}

/** Il file di `src/` a cui punta una specifica; `null` per i pacchetti esterni. */
function risolvi(da: string, specifica: string): string | null {
  let base: string
  if (specifica.startsWith('@/')) base = path.posix.join('src', specifica.slice(2))
  else if (specifica.startsWith('.')) base = path.posix.join(path.posix.dirname(da), specifica)
  else return null
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (SORGENTI.has(c)) return c
  }
  return null
}

const haUseClient = (sorgente: string) =>
  sorgente.includes('use client') && /^\s*['"]use client['"]/.test(senzaCommenti(sorgente))

/** I file che finiscono nel browser, con le radici da cui si parte. */
function grafoDelBrowser(): { radici: string[]; file: Set<string> } {
  const radici = [...SORGENTI.entries()].filter(([, s]) => haUseClient(s)).map(([f]) => f)
  const file = new Set<string>()
  const daVisitare = [...radici, ...RADICI_NOMINATE]
  while (daVisitare.length > 0) {
    const corrente = daVisitare.pop() as string
    if (file.has(corrente)) continue
    const sorgente = SORGENTI.get(corrente)
    if (sorgente === undefined) continue
    file.add(corrente)
    for (const specifica of importDiValore(sorgente)) {
      const destinazione = risolvi(corrente, specifica)
      if (destinazione && !file.has(destinazione)) daVisitare.push(destinazione)
    }
  }
  return { radici, file }
}

interface Lettura {
  tabella: string
  forma: 'from' | 'dinamica' | 'postgres_changes' | 'rest'
  riga: number
}

/** Tutte le letture dirette di un sorgente. Commenti spenti: una nota che spiega non è una lettura. */
function lettureDirette(sorgente: string): Lettura[] {
  const testo = senzaCommenti(sorgente)
  const trovate: Lettura[] = []
  const reFrom = /([A-Za-z_$][\w$]*)?(\s*\?)?\s*\.\s*from\s*(?:<[^>()]*>)?\s*\(\s*(?:(['"`])([^'"`$]*)\3\s*[,)])?/g
  for (const m of testo.matchAll(reFrom)) {
    const ricevente = m[1] ?? ''
    if (RICEVENTI_ESTRANEI.has(ricevente) || ricevente === 'storage') continue
    const n = riga(testo, m.index)
    trovate.push(m[4] !== undefined ? { tabella: m[4], forma: 'from', riga: n } : { tabella: '?', forma: 'dinamica', riga: n })
  }
  // Senza una `table` scritta per esteso l'abbonamento può prendere qualunque tabella, o tutto lo schema.
  for (const m of testo.matchAll(/['"]postgres_changes['"][^)]*/g)) {
    const tabella = /\btable\s*:\s*['"]([^'"]+)['"]/.exec(m[0])?.[1]
    trovate.push({ tabella: tabella ?? '?', forma: tabella ? 'postgres_changes' : 'dinamica', riga: riga(testo, m.index) })
  }
  for (const m of testo.matchAll(/\/rest\/v1\/(\w+)/g)) {
    trovate.push({ tabella: m[1], forma: 'rest', riga: riga(testo, m.index) })
  }
  return trovate
}

const { radici: RADICI, file: FILE_DEL_BROWSER } = grafoDelBrowser()

const LETTURE = [...FILE_DEL_BROWSER].sort().flatMap((file) =>
  lettureDirette(SORGENTI.get(file) as string).map((l) => ({ file, ...l })),
)

const vietate = (letture: readonly Lettura[]) => letture.filter((l) => l.forma === 'dinamica' || VIETATA.test(l.tabella))

describe(`lock — il browser non legge le tabelle della famiglia (${FILE_DEL_BROWSER.size} file guardati, ${RADICI.length} con 'use client')`, () => {
  it('la misura vede davvero il codice: «zero file» e «zero violazioni» non hanno lo stesso colore', () => {
    expect(RADICI.length).toBeGreaterThan(200)
    expect(FILE_DEL_BROWSER.size).toBeGreaterThan(RADICI.length)
    for (const nominato of RADICI_NOMINATE) expect(FILE_DEL_BROWSER.has(nominato), nominato).toBe(true)
    // Un file che ci si arriva SOLO seguendo gli import: il grafo funziona.
    expect(FILE_DEL_BROWSER.has('src/lib/supabase/attesa-ritentativi.ts')).toBe(true)
    // E un file del server non ci deve entrare: il grafo non è «tutto `src/`».
    expect(FILE_DEL_BROWSER.has('src/lib/supabase/server-client.ts')).toBe(false)
  })

  it('nessun file del browser legge `galleria_media_v2`, `chat_*`, `pagamenti`, `news_posts`', () => {
    expect(
      vietate(LETTURE),
      'Il browser legge direttamente una tabella di cui la PR 4.4 decide la visibilità. Così la '
      + 'lettura vale con la RLS di quel momento e non passa da `figliAttivi`: si passa da una route.',
    ).toEqual([])
  })

  it('`ImportExportClient` non legge più nessuna tabella: l’export passa dalla route', () => {
    // Con la RLS di `alunni` per lo staff usciva vuoto: la prova è in `__tests__/db/alunni-rls-export-staff.test.ts`.
    expect(lettureDirette(SORGENTI.get('src/components/features/admin/ImportExportClient.tsx') as string)).toEqual([])
  })

  it('l’elenco di ciò che il browser tocca direttamente è esatto: una voce nuova si dichiara, una morta si toglie', () => {
    const misurato = new Map<string, Set<string>>()
    for (const l of LETTURE) misurato.set(l.file, (misurato.get(l.file) ?? new Set()).add(l.tabella))
    const elenco = (voci: [string, Iterable<string>][]) =>
      voci.flatMap(([file, tabelle]) => [...tabelle].map((t) => `${file}: ${t}`)).sort()

    expect(elenco([...misurato.entries()])).toEqual(
      elenco([...DICHIARATE.entries()].map(([file, v]) => [file, v.tabelle])),
    )
    for (const [file, voce] of DICHIARATE) expect(voce.perche.length, `${file} non è motivato`).toBeGreaterThan(60)
  })

  it('le funzioni dichiarate non si chiamano dal browser: la deroga dice il vero', () => {
    const riservate = /\b(leggiSettimaneEFasce|caricaFasceEffettive|ensureStandardEnrollmentModel|syncPendingLogs|syncPendingDiaryEntries|syncAdults|saveLocalAttendanceLog|saveLocalDiaryEntry)\s*\(/
    const chiamate = [...FILE_DEL_BROWSER]
      .filter((f) => !DICHIARATE.has(f))
      .filter((f) => riservate.test(senzaCommenti(SORGENTI.get(f) as string)))
    expect(chiamate).toEqual([])
  })
})

describe('il lettore, provato su copie: il rosso deve poter arrivare', () => {
  const syncEngine = SORGENTI.get('src/lib/offline/syncEngine.ts') as string

  it('LA COPIA DI PROVA: `from(\'pagamenti\')` aggiunta a `syncEngine` è una violazione', () => {
    const copia = `${syncEngine}\nexport const prova = () => getSupabaseClient().from('pagamenti').select('*');\n`
    expect(vietate(lettureDirette(syncEngine))).toEqual([])
    expect(vietate(lettureDirette(copia)).map((l) => l.tabella)).toEqual(['pagamenti'])
  })

  it.each(['galleria_media_v2', 'chat_messages', 'chat_threads', 'news_posts', 'pagamenti'])('vede %s', (tabella) => {
    expect(vietate(lettureDirette(`client.from('${tabella}').select('id')`)).map((l) => l.tabella)).toEqual([tabella])
  })

  it('vede le forme spezzate, con le virgolette doppie e col generico', () => {
    expect(vietate(lettureDirette(`client\n  .from(\n    'chat_messages'\n  )\n  .select('*')`))).toHaveLength(1)
    expect(vietate(lettureDirette(`client.from("pagamenti").select('*')`))).toHaveLength(1)
    expect(vietate(lettureDirette(`client.from<'x'>('news_posts').select('*')`))).toHaveLength(1)
    expect(vietate(lettureDirette(`client?.from('pagamenti')`))).toHaveLength(1)
  })

  it('una tabella in una variabile può essere qualunque tabella: non passa', () => {
    expect(vietate(lettureDirette('client.from(tabella).select("*")')).map((l) => l.forma)).toEqual(['dinamica'])
    expect(vietate(lettureDirette('client.from(`pag${x}`).select("*")')).map((l) => l.forma)).toEqual(['dinamica'])
  })

  it('vede l’abbonamento realtime e il `fetch` a mano', () => {
    const realtime = `channel.on('postgres_changes', { event: '*', schema: 'public', table: 'pagamenti' }, cb)`
    expect(vietate(lettureDirette(realtime)).map((l) => l.forma)).toEqual(['postgres_changes'])
    const suTuttoLoSchema = `channel.on('postgres_changes', { event: '*', schema: 'public' }, cb)`
    expect(vietate(lettureDirette(suTuttoLoSchema)).map((l) => l.forma)).toEqual(['dinamica'])
    expect(vietate(lettureDirette('fetch(`${url}/rest/v1/chat_threads?select=*`)')).map((l) => l.forma)).toEqual(['rest'])
  })

  it('non si immunizza coi commenti, e non scambia altri `from` per tabelle', () => {
    expect(lettureDirette(`// client.from('pagamenti')\n/* client.from('chat_messages') */\nconst a = 1`)).toEqual([])
    expect(lettureDirette(`Array.from(righe); Buffer.from('x'); Uint8Array.from(y)`)).toEqual([])
    expect(lettureDirette(`client.storage.from('pagamenti').download(p)`)).toEqual([])
  })

  it('segue gli import di valore e salta quelli di tipo', () => {
    const sorgente = [
      `import { a } from '@/lib/a'`,
      `import type { T } from '@/lib/solo-tipo'`,
      `import { type U, type V } from '@/lib/solo-tipi'`,
      `import { type W, b } from '@/lib/misto'`,
      `import Pred, { c } from '@/lib/con-predefinito'`,
      `export * from './ri-esporta'`,
      `export { d } from './ri-esporta-nominato'`,
      `export type { X } from './ri-esporta-tipo'`,
      `import './per-effetto'`,
      `const e = await import('@/lib/dinamico')`,
      `// import { f } from '@/lib/in-un-commento'`,
    ].join('\n')
    expect(importDiValore(sorgente).sort()).toEqual([
      './per-effetto', './ri-esporta', './ri-esporta-nominato',
      '@/lib/a', '@/lib/con-predefinito', '@/lib/dinamico', '@/lib/misto',
    ])
  })
})
