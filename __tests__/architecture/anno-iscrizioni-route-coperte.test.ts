import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente } from '../fixtures/sorgente'

/**
 * COMPITO 4.5.12 · LE ROUTE NUOVE DELL'ISCRIZIONE ALL'ANNO PROSSIMO SONO TUTTE VISTE DAI LOCK DI ROUTE.
 *
 * Quattro lock guardano TUTTE le route di `src/app/api/` senza elencarle (`logging-coverage`, `zod-coverage` per prefisso,
 * `isolamento-sede-coverage` per conteggio esatto di handler controllati, `errori-con-codice`). Il rischio di un lock che non
 * elenca è doppio: una route nuova in un gruppo che il lock non conosce passa in silenzio, e una route che SPARISCE (rinominata,
 * spostata) fa scendere un conteggio che qualcuno ritocca per rifarlo quadrare. Qui sta l'INVENTARIO scritto, e ciò che ogni
 * route nuova deve avere perché quei quattro lock la vedano per davvero.
 *
 * Misurato il 2026-11-09 sul ramo della PR 4.5: le route nuove sono 10 file con 16 funzioni (18 dal 4.5.15: GET e PATCH di `sezioni`) (il brief parlava di undici e sedici;
 * i file sono dieci, le funzioni sono sedici). Per ciascuna:
 *  - ogni funzione HTTP è esportata come `export const METODO = withRoute('<percorso>:<METODO>', …)`, col nome uguale al percorso
 *    (è la forma che `logging-coverage` riconosce, e la colonna `operazione` di `app_log` dice la verità);
 *  - il file importa `zod` o `@/lib/validation/*` (`zod-coverage`: ogni route sotto `admin/` e `iscrizione/` deve);
 *  - le route con gate (`requireStaff`) lo chiamano almeno una volta per funzione, nel corpo, prima di leggere o scrivere;
 *  - le route di staff verificano la sede dell'anno (`assertAnnoSedeInScope`) o la domanda (`scuoleDiUtente`): sono le
 *    CONTROLLATE di `isolamento-sede-coverage`, il cui conteggio `handlerControllati` sale con loro.
 *
 * ─── PERCHÉ NON È CIECO ───────────────────────────────────────────────────────
 * Dichiara quanti file e quante funzioni ha trovato (11 / 19, esatti: né di più né di meno) e ha il suo controllo positivo
 * su sorgenti finti: una route nuda, senza zod, senza gate o col nome sbagliato fa rosso. Se una route nuova della PR 4.5
 * nasce in un'altra cartella, si aggiunge all'INVENTARIO: il lock non la indovina.
 *
 * ─── CHE COSA NON VEDE ────────────────────────────────────────────────────────
 *  - che il gate sia chiamato PRIMA di ogni lettura (lo dice `gate-coverage`, per handler);
 *  - che la validazione copra tutti i campi (lo dicono i test di route).
 */

const CWD = process.cwd()
const API = 'src/app/api'

interface Voce { file: string; metodi: readonly string[]; gate: boolean; sede: 'anno' | 'domanda' | 'pubblica' }

/** L'inventario scritto delle route nuove della PR 4.5. Si estende SCRIVENDO, non calcolando. */
const INVENTARIO: readonly Voce[] = [
  { file: `${API}/admin/anni/[annoSedeId]/conferme/ritira/route.ts`, metodi: ['POST'], gate: true, sede: 'anno' },
  { file: `${API}/admin/anni/[annoSedeId]/conferme/non-rinnova/route.ts`, metodi: ['POST'], gate: true, sede: 'anno' },
  { file: `${API}/admin/anni/[annoSedeId]/conferme/route.ts`, metodi: ['GET', 'POST'], gate: true, sede: 'anno' },
  { file: `${API}/admin/anni/[annoSedeId]/moduli-mancanti/route.ts`, metodi: ['GET'], gate: true, sede: 'anno' },
  { file: `${API}/admin/anni/[annoSedeId]/moduli/route.ts`, metodi: ['GET', 'PUT', 'DELETE'], gate: true, sede: 'anno' },
  { file: `${API}/admin/anni/[annoSedeId]/posti/route.ts`, metodi: ['GET', 'PUT'], gate: true, sede: 'anno' },
  { file: `${API}/admin/anni/[annoSedeId]/quote/route.ts`, metodi: ['GET', 'PUT'], gate: true, sede: 'anno' },
  { file: `${API}/admin/anni/[annoSedeId]/sezioni/route.ts`, metodi: ['GET', 'PATCH', 'POST'], gate: true, sede: 'anno' },
  { file: `${API}/admin/frequenze/[frequenzaId]/moduli/route.ts`, metodi: ['GET', 'PUT'], gate: true, sede: 'anno' },
  { file: `${API}/admin/iscrizioni/sposta-anno/route.ts`, metodi: ['POST'], gate: true, sede: 'domanda' },
  { file: `${API}/iscrizione/anni/route.ts`, metodi: ['GET'], gate: false, sede: 'pubblica' },
]

const FILE_ATTESI = 11
const FUNZIONI_ATTESE = 19

const METODI = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS'
const NUDO = new RegExp(`export\\s+(?:async\\s+)?function\\s+(${METODI})\\b`, 'g')
const AVVOLTO = new RegExp(`export\\s+const\\s+(${METODI})\\s*=\\s*withRoute\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g')
const QUALSIASI_CONST = new RegExp(`export\\s+const\\s+(${METODI})\\s*=`, 'g')

/** `src/app/api/admin/anni/[annoSedeId]/posti/route.ts` → `admin/anni/[annoSedeId]/posti` */
const nomeAtteso = (file: string) => path.dirname(file).slice(API.length + 1)

function violazioni(file: string, testo: string, voce: Pick<Voce, 'metodi' | 'gate' | 'sede'>): string[] {
  const out: string[] = []
  const m = mascheraSorgente(testo)
  const nudi = [...m.senzaCommenti.matchAll(NUDO)].map((x) => x[1])
  if (nudi.length) out.push(`${file} — export HTTP nudo (${nudi.join(', ')}): vuole withRoute`)
  const avvolti = new Map([...m.senzaCommenti.matchAll(AVVOLTO)].map((x) => [x[1], x[2]] as const))
  const tutti = [...m.senzaCommenti.matchAll(QUALSIASI_CONST)].map((x) => x[1])
  for (const metodo of tutti) if (!avvolti.has(metodo)) out.push(`${file} — ${metodo} non è avvolto in withRoute`)
  const trovati = [...new Set([...avvolti.keys(), ...nudi])].sort()
  const attesi = [...voce.metodi].sort()
  if (JSON.stringify(trovati) !== JSON.stringify(attesi)) out.push(`${file} — metodi esportati [${trovati.join(', ')}], attesi [${attesi.join(', ')}]`)
  for (const [metodo, nome] of avvolti) {
    if (nome !== `${nomeAtteso(file)}:${metodo}`) out.push(`${file} — ${metodo}: withRoute('${nome}'), atteso '${nomeAtteso(file)}:${metodo}'`)
  }
  if (!/from\s+['"]zod['"]|from\s+['"]@\/lib\/validation\//.test(m.senzaCommenti)) out.push(`${file} — non importa zod né @/lib/validation (zod-coverage)`)
  // gate e controllo di sede PER FUNZIONE: un `assertAnnoSedeInScope` in un'altra funzione dello stesso file non copre questa
  const corpi = corpiDelleFunzioni(m.struttura)
  // un helper del FILE che contiene il controllo di sede vale per chi lo chiama (`caricaFrequenza` in frequenze/[id]/moduli)
  const helperAnno = helperDelFileConChiamata(m.struttura, /\bassertAnnoSedeInScope\s*\(/)
  const helperDomanda = helperDelFileConChiamata(m.struttura, /\bscuoleDiUtente\s*\(/)
  const chiama = (corpo: string, diretto: RegExp, helper: string[]) => diretto.test(corpo) || helper.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(corpo))
  for (const [metodo, corpo] of corpi) {
    const gate = /\brequireStaff\s*\(/.test(corpo)
    if (voce.gate && !gate) out.push(`${file} — ${metodo} non chiama requireStaff`)
    if (!voce.gate && gate) out.push(`${file} — ${metodo} è pubblica ma chiama requireStaff: aggiorna l'inventario`)
    if (voce.sede === 'anno' && !chiama(corpo, /\bassertAnnoSedeInScope\s*\(/, helperAnno)) out.push(`${file} — ${metodo} non verifica la sede dell'anno (assertAnnoSedeInScope)`)
    if (voce.sede === 'domanda' && !chiama(corpo, /\bscuoleDiUtente\s*\(/, helperDomanda)) out.push(`${file} — ${metodo} non verifica la sede della domanda (scuoleDiUtente)`)
  }
  if (voce.sede === 'pubblica' && !/\bsediReali\b/.test(m.senzaCommenti)) out.push(`${file} — non valida la sede contro sediReali`)
  return out
}

/** I nomi delle funzioni locali del file (`function nome(`, `async function nome(`) il cui testo contiene `chiamata`. */
function helperDelFileConChiamata(struttura: string, chiamata: RegExp): string[] {
  const inizi = [...struttura.matchAll(/(?:^|\n)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g)]
  const fineDi = (da: number) => {
    const resto = struttura.slice(da + 1)
    const prossimo = /\n(?:async\s+)?function\s|\nexport\s/.exec(resto)
    return prossimo ? da + 1 + prossimo.index : struttura.length
  }
  return inizi.filter((h) => chiamata.test(struttura.slice(h.index, fineDi(h.index)))).map((h) => h[1])
}

/** Il testo di ciascuna funzione esportata: dal suo `export const METODO = withRoute(` al successivo (o alla fine del file). */
function corpiDelleFunzioni(struttura: string): Map<string, string> {
  const inizi = [...struttura.matchAll(new RegExp(`export\\s+const\\s+(${METODI})\\s*=\\s*withRoute\\(`, 'g'))]
  const out = new Map<string, string>()
  inizi.forEach((h, i) => out.set(h[1], struttura.slice(h.index, i + 1 < inizi.length ? inizi[i + 1].index : struttura.length)))
  return out
}

const elenco = (v: string[]) => (v.length ? '\n  - ' + v.join('\n  - ') : '')
const leggi = (f: string) => fs.readFileSync(path.join(CWD, f), 'utf8')

describe('anno-iscrizioni-route-coperte — il controllo positivo, su route finte', () => {
  const buona = `import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
export const GET = withRoute('admin/x/y:GET', async (request) => {
  const auth = await requireStaff(request, ['admin'])
  await assertAnnoSedeInScope(a, b)
})`
  const voce = { metodi: ['GET'] as const, gate: true, sede: 'anno' as const }

  it('una route fatta bene è pulita', () => {
    expect(violazioni(`${API}/admin/x/y/route.ts`, buona, voce)).toEqual([])
  })

  it('una route nuda, senza zod, senza gate, senza controllo di sede o col nome sbagliato fa rosso', () => {
    const f = `${API}/admin/x/y/route.ts`
    expect(violazioni(f, buona.replace(`withRoute('admin/x/y:GET', async (request) =>`, 'async function GET(request)').replace(/\}\)$/, '}'), voce).length).toBeGreaterThanOrEqual(1)
    expect(violazioni(f, buona.replace("import { z } from 'zod'", ''), voce)).toHaveLength(1)
    expect(violazioni(f, buona.replace('requireStaff(request', 'altro(request'), voce)).toHaveLength(1)
    expect(violazioni(f, buona.replace('assertAnnoSedeInScope(a, b)', ''), voce)).toHaveLength(1)
    expect(violazioni(f, buona.replace('admin/x/y:GET', 'admin/altra:GET'), voce)).toHaveLength(1)
  })

  it('un metodo in più o in meno rispetto all’inventario fa rosso; un commento che nomina requireStaff non basta', () => {
    const f = `${API}/admin/x/y/route.ts`
    expect(violazioni(f, buona + "\nexport const POST = withRoute('admin/x/y:POST', async () => {})", voce).length).toBeGreaterThanOrEqual(1)
    expect(violazioni(f, buona.replace('requireStaff(request', '// requireStaff(request\n  other(request'), voce)).toHaveLength(1)
  })

  it('il controllo di sede è PER FUNZIONE: quello della PUT non copre la GET (la rottura provata sul GET di posti)', () => {
    const due = `import { z } from 'zod'
export const GET = withRoute('admin/x/y:GET', async (request) => {
  const auth = await requireStaff(request, ['admin'])
})
export const PUT = withRoute('admin/x/y:PUT', async (request) => {
  const auth = await requireStaff(request, ['admin'])
  await assertAnnoSedeInScope(a, b)
})`
    const v = violazioni(`${API}/admin/x/y/route.ts`, due, { metodi: ['GET', 'PUT'], gate: true, sede: 'anno' })
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('GET non verifica la sede')
  })

  it('il controllo di sede dentro un helper del file vale per chi lo chiama, e solo per lui', () => {
    const conHelper = `import { z } from 'zod'
async function carica(supabase) {
  const fuori = await assertAnnoSedeInScope(supabase, 1, 2)
  return fuori
}
export const GET = withRoute('admin/x/y:GET', async (request) => {
  const auth = await requireStaff(request, ['admin'])
  const r = await carica(supabase)
})
export const PUT = withRoute('admin/x/y:PUT', async (request) => {
  const auth = await requireStaff(request, ['admin'])
})`
    const v = violazioni(`${API}/admin/x/y/route.ts`, conHelper, { metodi: ['GET', 'PUT'], gate: true, sede: 'anno' })
    expect(v).toHaveLength(1)
    expect(v[0]).toContain('PUT non verifica la sede')
  })

  it('una route pubblica deve validare la sede; una che chiama requireStaff non è pubblica', () => {
    const pubblica = { metodi: ['GET'] as const, gate: false, sede: 'pubblica' as const }
    const ok = `import { z } from 'zod'\nexport const GET = withRoute('iscrizione/anni:GET', async () => { sediReali })`
    expect(violazioni(`${API}/iscrizione/anni/route.ts`, ok, pubblica)).toEqual([])
    expect(violazioni(`${API}/iscrizione/anni/route.ts`, ok.replace('sediReali', ''), pubblica)).toHaveLength(1)
    expect(violazioni(`${API}/iscrizione/anni/route.ts`, ok.replace('sediReali', 'requireStaff(r)'), pubblica).length).toBeGreaterThanOrEqual(1)
  })
})

describe('anno-iscrizioni-route-coperte — le route vere', () => {
  it('l’inventario è completo e non ha doppioni: 11 file, 19 funzioni (esatti)', () => {
    expect(INVENTARIO.length).toBe(FILE_ATTESI)
    expect(new Set(INVENTARIO.map((v) => v.file)).size).toBe(FILE_ATTESI)
    expect(INVENTARIO.reduce((n, v) => n + v.metodi.length, 0)).toBe(FUNZIONI_ATTESE)
  })

  it('ogni file dell’inventario esiste', () => {
    const mancanti = INVENTARIO.filter((v) => !fs.existsSync(path.join(CWD, v.file))).map((v) => v.file)
    expect(mancanti, 'route dell’inventario che non esistono più: se sono state spostate, aggiorna l’inventario (e i conteggi dei lock di route)' + elenco(mancanti)).toEqual([])
  })

  it('ogni route nuova è avvolta in withRoute col nome giusto, importa zod, ha il suo gate e il suo controllo di sede', () => {
    const v = INVENTARIO.flatMap((voce) => violazioni(voce.file, leggi(voce.file), voce))
    expect(v, `Le route nuove della 4.5 non hanno tutto ciò che i lock di route pretendono (${v.length}).` + elenco(v)).toEqual([])
  })

  it('le funzioni esportate sono davvero 19 (contate sul sorgente, non sull’inventario)', () => {
    const n = INVENTARIO.reduce((tot, voce) => tot + [...mascheraSorgente(leggi(voce.file)).senzaCommenti.matchAll(AVVOLTO)].length, 0)
    expect(n).toBe(FUNZIONI_ATTESE)
  })
})
