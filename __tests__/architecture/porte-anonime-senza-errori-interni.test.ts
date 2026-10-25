// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { mascheraSorgente, fineParentesi, riga } from '../fixtures/sorgente'

/**
 * LOCK · UNA PORTA ANONIMA NON RACCONTA I SUOI GUASTI A CHI BUSSA.
 * (Sessione 13 della seconda serie di robustezza, «bordo pubblico» — 2026-10-20.)
 *
 * Le porte di `PUBBLICHE` in `gate-coverage.test.ts` rispondono a chiunque, senza login. Il 20/10 nove risposte
 * di quattro di loro mandavano al chiamante il `message` dell'errore: il testo di PostgREST (nomi di tabelle e di
 * vincoli, a volte `Key (…)=(…)`) o quello di un'eccezione interna.
 *
 * LA FORMA VIETATA, dentro il corpo del handler di una porta anonima: una risposta costruita a mano
 * (`NextResponse.json(…)`, `Response.json(…)`, `new Response(…)`, `new NextResponse(…)`) i cui argomenti
 * contengono `.message`, direttamente o attraverso una variabile dello stesso handler che lo contiene nel suo
 * inizializzatore (`const msg = err instanceof Error ? err.message : …`).
 *
 * COME SI RIPARA: `rispostaGuastoDb` / `rispostaGuastoGiaRegistrato` (`src/lib/db/guasto.ts`) per un guasto del
 * database, `rispostaErroreInterno` / `rispostaErroreInternoGiaRegistrato` (`src/lib/api/errore-interno.ts`) per
 * un'eccezione. L'errore intero va nel log, dove passa dalla redazione.
 *
 * L'elenco delle porte NON si copia: si legge da `gate-coverage.test.ts`, così una porta anonima nuova entra qui
 * lo stesso giorno in cui entra là.
 *
 * COSA NON VEDE, detto perché nessuno lo creda più largo: una destrutturazione (`const { message } = err`), un
 * `message` passato da una funzione d'aiuto definita fuori dal handler, un oggetto d'errore intero messo nel
 * corpo. Il 20/10 nessuna delle 23 porte usava una di queste forme (controllato a mano).
 *
 * FUORI: le route autenticate. Il 20/10, con questo stesso lettore, 319 risposte in 210 handler. Lì chi legge il
 * messaggio è il personale; si sistemano quando una sessione tocca il loro file.
 */

const RADICE = process.cwd()
const GATE = path.join(RADICE, '__tests__', 'architecture', 'gate-coverage.test.ts')

/** Una risposta HTTP costruita a mano: è lì che un `message` esce verso il chiamante. */
const RISPOSTA = /\b(?:NextResponse|Response)\s*\.\s*json\s*\(|\bnew\s+(?:Next)?Response\s*\(/g
/** Il testo di un errore: `error.message`, `(err as Error).message`, `retry.error.message`. */
const MESSAGGIO = /\.\s*message\b/
/** `const x =`, `let x: T =` — non `==`, non `=>`. */
const DICHIARAZIONE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=|>)/g
/** Una riga che finisce così continua sotto (`cond ?`, `a ||`, `f(`). */
const CONTINUA_DOPO = /(\?\?|\|\||&&|[?:,(=+])$/
/** Una riga che comincia così continua quella sopra (`? a`, `: b`, `.trim()`). */
const CONTINUA_PRIMA = /^(\?\?|\|\||&&|[?:.])/

type Porta = { chiave: string; file: string; verbo: string }
type Fuga = { riga: number; testo: string }

/** Le porte anonime, lette da `PUBBLICHE` di `gate-coverage.test.ts`. */
function porteAnonime(): Porta[] {
  const testo = fs.readFileSync(GATE, 'utf8')
  const inizio = testo.indexOf('const PUBBLICHE')
  const fine = testo.indexOf('\n}\n', inizio)
  if (inizio < 0 || fine < 0) return []
  const out: Porta[] = []
  for (const m of testo.slice(inizio, fine).matchAll(/^\s*'([^']+):(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)'\s*:/gm)) {
    out.push({ chiave: `${m[1]}:${m[2]}`, file: `src/app/api/${m[1]}/route.ts`, verbo: m[2] })
  }
  return out
}

/** Fine (esclusa) dell'inizializzatore che comincia in `da`, sul testo `struttura`. */
function fineInizializzatore(strut: string, da: number): number {
  let livello = 0
  for (let k = da; k < strut.length; k++) {
    const c = strut[k]
    if (c === '(' || c === '[' || c === '{') livello++
    else if (c === ')' || c === ']' || c === '}') {
      livello--
      if (livello < 0) return k
    } else if (c === ';' && livello === 0) return k
    else if (c === '\n' && livello === 0) {
      const prima = strut.slice(strut.lastIndexOf('\n', k - 1) + 1, k).trim()
      const dopo = (/^\s*(\S.*)?/.exec(strut.slice(k + 1))?.[1] ?? '').trim()
      if (prima !== '' && !CONTINUA_DOPO.test(prima) && !CONTINUA_PRIMA.test(dopo)) return k
    }
  }
  return strut.length
}

/** Le risposte del handler `verbo` che mandano un `message` al chiamante. `null` se il handler non c'è. */
function fughe(sorgente: string, verbo: string): Fuga[] | null {
  const { struttura } = mascheraSorgente(sorgente)
  const testa = new RegExp(`export\\s+const\\s+${verbo}\\s*=\\s*withRoute\\s*\\(`).exec(struttura)
  if (!testa) return null
  const corpo = testa.index + testa[0].length
  const tratto = struttura.slice(corpo, fineParentesi(struttura, corpo - 1))

  // Le variabili che portano un `message` nel loro valore. Si cerca da DOPO `withRoute(`: il nome del
  // handler (`POST`, `GET`) non è una variabile del corpo.
  const contaminate: string[] = []
  for (const d of tratto.matchAll(DICHIARAZIONE)) {
    const da = (d.index ?? 0) + d[0].length
    if (MESSAGGIO.test(tratto.slice(da, fineInizializzatore(tratto, da)))) contaminate.push(d[1])
  }

  const righe = sorgente.split('\n')
  const out: Fuga[] = []
  for (const r of tratto.matchAll(RISPOSTA)) {
    const apertura = (r.index ?? 0) + r[0].length - 1
    const argomenti = tratto.slice(apertura, fineParentesi(tratto, apertura))
    const viaNome = contaminate.some((n) =>
      new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(argomenti),
    )
    if (!MESSAGGIO.test(argomenti) && !viaNome) continue
    const n = riga(struttura, corpo + (r.index ?? 0))
    out.push({ riga: n, testo: (righe[n - 1] ?? '').trim().slice(0, 120) })
  }
  return out
}

/** Controllo positivo: le tre forme che il 20/10 stavano davvero nelle porte anonime. */
const VIETATO = [
  "export const POST = withRoute('x:POST', async (request: Request) => {",
  "  const { error } = await db.from('t').insert({})",
  '  if (error) return NextResponse.json({ error: error.message }, { status: 500 })',
  '  try {',
  '    lavora()',
  '  } catch (err) {',
  '    const msg = err instanceof Error',
  '      ? err.message',
  "      : 'Errore interno'",
  '    return NextResponse.json({ error: msg }, { status: 500 })',
  '  }',
  '  return new Response(JSON.stringify({ error: `guasto: ${error.message}` }), { status: 500 })',
  '})',
].join('\n')

/** Controllo negativo: un commento, una stringa e `messageCount` non sono fughe; il GET sì. */
const CORRETTO = [
  "export const POST = withRoute('x:POST', async (request: Request) => {",
  '  // NextResponse.json({ error: error.message }) — in un commento non conta',
  "  const { data: dati, error } = await db.from('t').select('id')",
  "  if (error) return rispostaGuastoDb('x:POST', 'db:t', error)",
  "  const testo = 'la stringa .message non è codice'",
  '  return NextResponse.json({ ok: true, nota: testo, quanti: dati.messageCount })',
  '})',
  "export const GET = withRoute('x:GET', async () => {",
  '  try { return NextResponse.json({ ok: true }) } catch (err) {',
  '    return NextResponse.json({ error: (err as Error).message }, { status: 500 })',
  '  }',
  '})',
].join('\n')

const PORTE = porteAnonime()
const leggi = (p: Porta): string => fs.readFileSync(path.join(RADICE, p.file), 'utf8')

describe('lock — una porta anonima non manda il `message` di un errore a chi chiama', () => {
  it('legge davvero le porte (non è verde scansionando zero handler)', () => {
    expect(PORTE.length, '`PUBBLICHE` di gate-coverage.test.ts non letto: è cambiata la sua forma?').toBeGreaterThanOrEqual(20)
    const mancanti = PORTE
      .filter((p) => !fs.existsSync(path.join(RADICE, p.file)) || fughe(leggi(p), p.verbo) === null)
      .map((p) => p.chiave)
    expect(mancanti, 'porte senza file o senza `export const VERBO = withRoute(`').toEqual([])
  })

  it('riconosce le forme vietate e lascia passare quelle corrette (controllo positivo)', () => {
    expect(fughe(VIETATO, 'POST')?.map((f) => f.riga)).toEqual([3, 10, 12])
    expect(fughe(CORRETTO, 'POST')).toEqual([])
    expect(fughe(CORRETTO, 'GET')?.map((f) => f.riga)).toEqual([10])
    expect(fughe(CORRETTO, 'PUT')).toBeNull()
  })

  it('nessuna porta anonima manda il `message` di un errore', () => {
    const trovate = PORTE.flatMap((p) =>
      (fughe(leggi(p), p.verbo) ?? []).map((f) => `${p.file}:${f.riga} (${p.chiave}) → ${f.testo}`),
    )
    expect(
      trovate,
      'Una porta anonima risponde con il testo di un errore. Chi la chiama non ha un account: quel testo ' +
        'gli descrive tabelle e vincoli. Usa `rispostaGuastoDb`/`rispostaGuastoGiaRegistrato` ' +
        '(src/lib/db/guasto.ts) o `rispostaErroreInterno` (src/lib/api/errore-interno.ts): al chiamante il ' +
        'codice, al log l’errore intero.',
    ).toEqual([])
  })
})
