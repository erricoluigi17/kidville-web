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
// ⚠️ E LA SECONDA ERA ANCORA SOCCHIUSA (revisione del 2026-10-09, terzo giro).
// Contando solo le dichiarazioni ESPORTATE, tre forme passavano verdi:
//  1. una funzione di aiuto NON esportata scritta dopo un `export const GET` che
//     controlla, e chiamata dalla POST — il suo «gestore» risultava il GET;
//  2. `export default async function` senza controllo;
//  3. la funzione passata per RIFERIMENTO (`figli.map(anonimizzaAlunno)`,
//     `{ anon: anonimizzaAlunno }`): nessuna `anonimizzaAlunno(` da guardare.
// Ora un gestore comincia a OGNI dichiarazione di primo livello, esportata o no,
// e l'uso come VALORE è rosso salvo giustificazione scritta. I tre casi sono
// sorgenti finti qui sotto, e devono risultare rossi.
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
// Ogni dichiarazione di PRIMO LIVELLO (a inizio riga), esportata o no: una
// funzione di aiuto è un gestore a sé, e il controllo di un altro non la copre.
const INIZIO_GESTORE = /^(?:export\s+)?(?:default\s+)?(?:const|let|var|class|async\s+function|function)\b/gm
// La funzione usata come VALORE — argomento, elemento, proprietà — invece che
// chiamata: chi la riceve la chiamerà altrove, dove la scansione non la vede.
const USO_COME_VALORE = /[(,[:]\s*anonimizzaAlunno\b(?!\s*\()/g
// Le dichiarazioni `import … from '…'` si spengono prima di cercare i valori:
// `import { anonimizzaParent, anonimizzaAlunno }` non è un uso.
const IMPORT = /^import\s[\s\S]*?\bfrom\s*(['"])[^'"]*\1/gm
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

/**
 * Gli usi di `anonimizzaAlunno` come VALORE, giustificati. Chiave: `<file>:<riga>`.
 * Oggi è vuota. Una voce scaduta fa rosso come sopra.
 */
const VALORI_GIUSTIFICATI: Record<string, string> = {}

/** Le righe in cui `anonimizzaAlunno` è usata come valore (non chiamata, non importata). */
function usiComeValore(sorgente: string): number[] {
  const { struttura } = mascheraSorgente(sorgente)
  // Stessa lunghezza: gli indici restano quelli veri, e con loro i numeri di riga.
  const senzaImport = struttura.replace(IMPORT, (m) => m.replace(/[^\n]/g, ' '))
  return [...senzaImport.matchAll(USO_COME_VALORE)].map((m) => riga(senzaImport, m.index ?? 0))
}

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
  const valori: string[] = []
  for (const assoluto of fileSorgente(SRC)) {
    const file = relativo(assoluto)
    const sorgente = fs.readFileSync(assoluto, 'utf8')
    const esito = chiamateSenzaControllo(sorgente)
    if (esito.chiamate > 0) chiamanti.push(file)
    for (const s of esito.scoperte) scoperte.push(`${file}:${s.riga} (gestore «${s.gestore}»)`)
    for (const r of usiComeValore(sorgente)) valori.push(`${file}:${r}`)
  }
  return { chiamanti: chiamanti.sort(), scoperte, valori }
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

  it('controllo positivo: una funzione di AIUTO non esportata, dopo un GET che controlla, è ROSSA', () => {
    // Il caso più probabile: il GET controlla per i conteggi, la POST delega a un
    // aiuto scritto più sotto. Con i soli `export` il gestore dell'aiuto era il GET.
    const finto = [
      "export const GET = withRoute('x:GET', async () => {",
      '  const r = await alunniConRegistroPrimaria(db, ids)',
      '})',
      'async function anonimizzaTutti(figli) {',
      '  for (const f of figli) await anonimizzaAlunno(db, f, at, op)',
      '}',
      "export const POST = withRoute('x:POST', async () => {",
      '  await anonimizzaTutti(figli)',
      '})',
    ].join('\n')
    const esito = chiamateSenzaControllo(finto)
    expect(esito.scoperte).toHaveLength(1)
    expect(esito.scoperte[0].riga).toBe(5)
    expect(esito.scoperte[0].gestore).toContain('async function anonimizzaTutti')
  })

  it('controllo positivo: `export default async function` senza controllo è ROSSO', () => {
    const finto = [
      'const PRIMA = 1',
      'export default async function gestore() {',
      '  await anonimizzaAlunno(db, alunno, at, op)',
      '}',
    ].join('\n')
    const esito = chiamateSenzaControllo(finto)
    expect(esito.scoperte).toHaveLength(1)
    expect(esito.scoperte[0].gestore).toContain('export default async function')
  })

  it('controllo positivo: la funzione passata per RIFERIMENTO è un uso da giustificare', () => {
    const casi = [
      'await Promise.all(figli.map(anonimizzaAlunno))',
      'const azioni = { anon: anonimizzaAlunno }',
      'const elenco = [anonimizzaParent, anonimizzaAlunno]',
    ]
    for (const c of casi) expect(usiComeValore(c), c).toHaveLength(1)
    // Né una chiamata né un import sono usi come valore.
    expect(usiComeValore('await f(anonimizzaAlunno(db, a, at, op))')).toEqual([])
    expect(
      usiComeValore("import {\n  anonimizzaParent,\n  anonimizzaAlunno,\n  type AlunnoOblio,\n} from '@/lib/gdpr/esegui'"),
    ).toEqual([])
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

  it('anonimizzaAlunno non si passa per riferimento (chi la riceve la chiamerebbe senza controllo)', () => {
    const { valori } = scansione()
    const ingiustificati = valori.filter((v) => !(v in VALORI_GIUSTIFICATI))
    expect(
      ingiustificati,
      'Qui anonimizzaAlunno è usata come VALORE (argomento, elemento, proprietà): chi la riceve la ' +
        'chiama in un punto che questo lock non vede, e quindi senza la garanzia che il registro della ' +
        'primaria sia stato guardato. Chiamala direttamente, nel gestore che ha appena chiamato ' +
        'leggiRegistroPrimaria/alunniConRegistroPrimaria; se proprio serve, scrivi la ragione in ' +
        'VALORI_GIUSTIFICATI.',
    ).toEqual([])
    const scaduti = Object.keys(VALORI_GIUSTIFICATI).filter((k) => !valori.includes(k))
    expect(scaduti, 'voci di VALORI_GIUSTIFICATI che non corrispondono più a un uso').toEqual([])
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
