import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente, riga } from '../fixtures/sorgente'

// =============================================================================
// LOCK · chi chiama `anonimizzaAlunno` guarda prima il registro della primaria.
//
// LA REGOLA (titolare, 2026-10-08): voti, pagelle, scrutini, note disciplinari e
// certificati delle competenze sono il registro della scuola, che la legge
// obbliga a conservare — è l'eccezione dell'art. 17 §3 lett. b del GDPR. Il
// registro della primaria NON si cancella e NON si anonimizza, da NESSUNA porta.
//
// IL DIFETTO CHE QUESTO LOCK IMPEDISCE DI RIPETERE (2026-10-09). La regola era
// stata messa su `admin/gdpr/erase`, e `admin/gdpr/richieste` — la porta che
// evade la richiesta di cancellazione della FAMIGLIA, in blocco su tutti i figli
// non iscritti — chiamava `anonimizzaAlunno` senza nessun controllo. Nessun test
// era rosso: ogni route aveva i suoi, e nessuno guardava le route che non
// conosceva.
//
// ⚠️ E LA PRIMA VERSIONE DI QUESTO LOCK ERA CIECA (revisione del 2026-10-09):
// guardava il FILE, e in `richieste` il controllo c'è sia nel GET (per i
// conteggi dell'elenco) sia nella POST. Togliendolo dalla POST — quella che
// anonimizza — il controllo del GET bastava a tenere verde il lock. Ora il
// confine è il GESTORE: per ogni chiamata ad `anonimizzaAlunno(` si pretende una
// chiamata di controllo fra l'inizio del gestore che la contiene — l'ultimo
// `export const` / `export function` / `export async function` che la precede —
// e la chiamata stessa. La prova che il lock non è più cieco è il sorgente finto
// «il GET controlla, la POST no» qui sotto, che deve risultare rosso.
//
// Il sorgente si legge con commenti e stringhe spenti (`mascheraSorgente`): un
// nome citato in un commento che spiega la regola non conta né come chiamata né
// come controllo. Il lock non prova che l'ESITO del controllo sia rispettato:
// quello lo provano i test di ciascuna route (`gdpr-erase-registro-primaria`,
// `admin-gdpr-richieste-registro-primaria`, `admin-students-elimina`). Prova che
// nessun gestore lo dimentichi.
// =============================================================================

const RADICE = path.resolve(__dirname, '../..')
const SRC = path.join(RADICE, 'src')

const CHIAMATA = /\banonimizzaAlunno\s*\(/g
const DEFINIZIONE = /\bfunction\s+anonimizzaAlunno\s*\($/
const CONTROLLO = /\b(?:leggiRegistroPrimaria|alunniConRegistroPrimaria)\s*\(/
const INIZIO_GESTORE = /\bexport\s+(?:const|async\s+function|function)\b/g
// Tre modi di dare un altro nome alla funzione, che renderebbero il chiamante
// invisibile alla scansione: import rinominato, destrutturazione, assegnazione.
const ALIAS = [
  /\banonimizzaAlunno\s+as\s+\w+/,
  /\banonimizzaAlunno\s*:/,
  /=\s*anonimizzaAlunno\b(?!\s*\()/,
]

/**
 * Le chiamate che NON hanno un controllo del registro nel loro gestore, e perché
 * sono giustificate. Chiave: `<file>:<riga della chiamata>`. Oggi è vuota: nessun
 * chiamante interno a `src/lib/gdpr/esegui.ts` oltre alla definizione. Una voce
 * che non corrisponde più a nessuna chiamata fa rosso (un'esclusione scaduta è
 * una porta aperta).
 */
const GIUSTIFICATE: Record<string, string> = {}

interface ChiamataScoperta {
  riga: number
  gestore: string
}

/** Le chiamate ad `anonimizzaAlunno(` di un sorgente senza controllo del registro nel proprio gestore. */
function chiamateSenzaControllo(sorgente: string): { chiamate: number; scoperte: ChiamataScoperta[] } {
  // `struttura` per cercare (stringhe spente), `senzaCommenti` per l'etichetta (stessi indici).
  const { struttura, senzaCommenti } = mascheraSorgente(sorgente)
  const inizi = [...struttura.matchAll(INIZIO_GESTORE)].map((m) => m.index ?? 0)
  const scoperte: ChiamataScoperta[] = []
  let chiamate = 0
  for (const m of struttura.matchAll(CHIAMATA)) {
    const i = m.index ?? 0
    // La definizione (`export async function anonimizzaAlunno(`) non è una chiamata.
    if (DEFINIZIONE.test(struttura.slice(Math.max(0, i - 40), i + m[0].length))) continue
    chiamate++
    const inizio = inizi.filter((s) => s < i).pop() ?? 0
    if (!CONTROLLO.test(struttura.slice(inizio, i))) {
      scoperte.push({ riga: riga(struttura, i), gestore: senzaCommenti.slice(inizio, inizio + 60).split('\n')[0].trim() })
    }
  }
  return { chiamate, scoperte }
}

function relativo(assoluto: string): string {
  return path.relative(RADICE, assoluto).split(path.sep).join('/')
}

function scansione() {
  const chiamanti: string[] = []
  const scoperte: string[] = []
  for (const assoluto of fileSorgente(SRC)) {
    const file = relativo(assoluto)
    const esito = chiamateSenzaControllo(fs.readFileSync(assoluto, 'utf8'))
    if (esito.chiamate > 0) chiamanti.push(file)
    for (const s of esito.scoperte) scoperte.push(`${file}:${s.riga} (gestore «${s.gestore}»)`)
  }
  return { chiamanti: chiamanti.sort(), scoperte }
}

describe('LOCK · chi anonimizza un alunno guarda prima il registro della primaria', () => {
  // ── Il lock sa vedere: prove su sorgenti finti ──────────────────────────────
  it('controllo positivo: «il GET controlla, la POST no» è ROSSO (la prima versione lo dava verde)', () => {
    const finto = [
      "export const GET = withRoute('x:GET', async () => {",
      '  const r = await alunniConRegistroPrimaria(db, ids)',
      '})',
      "export const POST = withRoute('x:POST', async () => {",
      '  await anonimizzaAlunno(db, alunno, at, op)',
      '})',
    ].join('\n')
    const esito = chiamateSenzaControllo(finto)
    expect(esito.chiamate).toBe(1)
    expect(esito.scoperte).toHaveLength(1)
    expect(esito.scoperte[0].riga).toBe(5)
    expect(esito.scoperte[0].gestore).toContain('export const POST')
  })

  it('controllo positivo: il controllo DOPO la chiamata non vale', () => {
    const finto = [
      'export async function esegui() {',
      '  await anonimizzaAlunno(db, alunno, at, op)',
      '  await leggiRegistroPrimaria(db, id)',
      '}',
    ].join('\n')
    expect(chiamateSenzaControllo(finto).scoperte).toHaveLength(1)
  })

  it('controllo positivo: un controllo citato in un COMMENTO non vale', () => {
    const finto = [
      'export async function esegui() {',
      '  // qui andrebbe leggiRegistroPrimaria(db, id)',
      '  await anonimizzaAlunno(db, alunno, at, op)',
      '}',
    ].join('\n')
    expect(chiamateSenzaControllo(finto).scoperte).toHaveLength(1)
  })

  it('controllo negativo: controllo nello stesso gestore, prima della chiamata → nessuna scoperta', () => {
    const finto = [
      "export const POST = withRoute('x:POST', async () => {",
      '  const r = await leggiRegistroPrimaria(db, id)',
      '  if (!r.ok || r.presente) return',
      '  await anonimizzaAlunno(db, alunno, at, op)',
      '})',
      'export async function anonimizzaAlunno(db, a, at, op) {}',
    ].join('\n')
    expect(chiamateSenzaControllo(finto)).toEqual({ chiamate: 1, scoperte: [] })
  })

  it('gli alias si riconoscono: import rinominato, destrutturazione, assegnazione', () => {
    const casi = [
      "import { anonimizzaAlunno as anon } from '@/lib/gdpr/esegui'",
      'const { anonimizzaAlunno: anon } = mod',
      'const anon = anonimizzaAlunno',
    ]
    for (const c of casi) {
      const { struttura } = mascheraSorgente(c)
      expect(ALIAS.some((r) => r.test(struttura)), c).toBe(true)
    }
    const { struttura } = mascheraSorgente('const r = anonimizzaAlunno(db, a, at, op)')
    expect(ALIAS.some((r) => r.test(struttura)), 'una chiamata non è un alias').toBe(false)
  })

  // ── Il codice vero ─────────────────────────────────────────────────────────
  it('controllo positivo: la scansione trova almeno due chiamanti (oggi gdpr/erase e gdpr/richieste)', () => {
    const { chiamanti } = scansione()
    // Un lock che scandisce zero file è verde per sempre: se questo numero
    // scende, la scansione è diventata cieca (cartella spostata, nome cambiato),
    // non il codice più sicuro.
    expect(chiamanti.length, `chiamanti trovati: ${JSON.stringify(chiamanti)}`).toBeGreaterThanOrEqual(2)
    expect(chiamanti).toContain('src/app/api/admin/gdpr/erase/route.ts')
    expect(chiamanti).toContain('src/app/api/admin/gdpr/richieste/route.ts')
  })

  it('la definizione in esegui.ts esiste ancora e non è contata come chiamata', () => {
    const percorso = path.join(RADICE, 'src/lib/gdpr/esegui.ts')
    const sorgente = fs.readFileSync(percorso, 'utf8')
    expect(mascheraSorgente(sorgente).struttura).toMatch(/function\s+anonimizzaAlunno\s*\(/)
    const scoperte = chiamateSenzaControllo(sorgente).scoperte.map((s) => `src/lib/gdpr/esegui.ts:${s.riga}`)
    expect(scoperte.filter((k) => !(k in GIUSTIFICATE))).toEqual([])
  })

  it('ogni chiamata ad anonimizzaAlunno ha un controllo del registro nel SUO gestore, prima di sé', () => {
    const { scoperte } = scansione()
    const ingiustificate = scoperte.filter((s) => !(s.split(' ')[0] in GIUSTIFICATE))
    expect(
      ingiustificate,
      'Queste chiamate anonimizzano un alunno senza aver guardato il registro della primaria NEL ' +
        'LORO GESTORE. Regola del titolare (2026-10-08): voti, pagelle, scrutini, note e certificati ' +
        'delle competenze sono il registro che la legge obbliga a conservare (GDPR art. 17 §3 lett. b) ' +
        '— NON si cancellano e NON si anonimizzano, da nessuna porta. Nello stesso gestore, PRIMA di ' +
        'anonimizzaAlunno, chiama leggiRegistroPrimaria (un alunno) o alunniConRegistroPrimaria (più ' +
        'alunni) da `@/lib/alunni/registro-primaria`, fermati su una lettura fallita (`ok: false`) e ' +
        'salta o rifiuta chi ha il registro. Un controllo in un ALTRO gestore dello stesso file (per ' +
        'esempio nel GET) non protegge la POST. Esempi: admin/gdpr/erase (409), admin/gdpr/richieste ' +
        '(salta e lo scrive nell’esito).',
    ).toEqual([])
  })

  it('nessuna giustificazione scaduta', () => {
    const { scoperte } = scansione()
    const chiavi = new Set(scoperte.map((s) => s.split(' ')[0]))
    const scadute = Object.keys(GIUSTIFICATE).filter((k) => !chiavi.has(k))
    expect(scadute, 'voci di GIUSTIFICATE che non corrispondono più a una chiamata scoperta').toEqual([])
  })

  it('nessuno dà un altro nome ad anonimizzaAlunno (la scansione non lo vedrebbe)', () => {
    const rinominati: string[] = []
    for (const assoluto of fileSorgente(SRC)) {
      const { struttura } = mascheraSorgente(fs.readFileSync(assoluto, 'utf8'))
      if (ALIAS.some((r) => r.test(struttura))) rinominati.push(relativo(assoluto))
    }
    expect(rinominati, 'chiama anonimizzaAlunno col suo nome: il lock cerca `anonimizzaAlunno(`').toEqual([])
  })
})
