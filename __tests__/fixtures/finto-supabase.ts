import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Finto client Supabase che APPLICA DAVVERO i filtri e ESEGUE DAVVERO le
// scritture.
//
// Perché non basta un mock "piatto" (quelli che rispondono sempre la stessa
// lista): con un mock piatto un test di isolamento per sede è verde anche se il
// filtro `.in('scuola_id', ...)` non c'è. Qui le righe vengono filtrate come le
// filtrerebbe PostgREST, quindi «il docente della sede A non vede gli alunni
// della sede B» è una proprietà VERIFICATA, non asserita.
//
// Regola fondativa, imparata a caro prezzo (audit 2026-07-31): **un operatore
// che il finto client non sa applicare LANCIA**. Fino al 30/07 `.or()`, `.neq()`
// e `.not()` erano `() => b` — accettati e ignorati — e sette route filtrano la
// sede proprio con `.or('scuola_id.is.null,scuola_id.in.(…)')`: il primo test
// d'isolamento su quelle route sarebbe stato verde con e senza il filtro. Un
// mock che tace è peggio di un mock che manca: il secondo rompe il test, il
// primo lo certifica.
//
// Cosa emula:
//  · filtri: eq, neq, gt, gte, lt, lte, like, ilike, is, in, contains (cs),
//    containedBy (cd), overlaps (ov), not(col,op,v), match, filter, or(...)
//    con il sottoinsieme PostgREST realmente usato nel repo — comprese le
//    forme annidate `and(...)`/`or(...)`;
//  · risorse EMBEDDED (`.eq('alunni.classe_sezione', x)`, `.in('alunni.scuola_id', […])`):
//    la riga porta l'oggetto (o l'array) annidato e il confronto si fa sul campo
//    interno, come col join `!inner` — se il nodo annidato manca, la riga NON passa;
//  · scritture: insert / update / upsert / delete, che modificano `db[tabella]`
//    e finiscono in un accumulatore `scritture`, così un test può asserire CHE
//    COSA è finito nel DB e con quale `scuola_id`;
//  · `select('*', { count: 'exact' })` → `count`, e `{ head: true }`;
//  · iniezione di un errore PostgREST per tabella (`{ errori: { alunni: { code: '42703' } } }`),
//    che è il modo per provare il ramo di degradazione su DB non migrato;
//  · `rpc()` e `storage`, che senza configurazione LANCIANO invece di produrre
//    un TypeError catturato dal `catch` della route e travestito da 500.
//
// Semantica SQL rispettata dove conta per l'isolamento:
//  · `neq`/`not.eq` NON restituiscono le righe con valore NULL (in SQL
//    `NULL <> 'B'` vale NULL, non TRUE): è esattamente il caso «riga globale»
//    che altrimenti sfuggirebbe al filtro di sede;
//  · `in` con elenco VUOTO non restituisce niente (scope vuoto ⇒ nega).
//
// Cosa NON emula, e lo dichiara qui perché nessuno ci costruisca sopra una
// prova che non regge:
//  · la proiezione delle colonne di `select()`: le righe tornano INTERE, quindi
//    un test non può provare «quel campo non è stato selezionato»;
//  · la costruzione dei join dalla stringa di select: l'oggetto annidato lo
//    mette il fixture (di `!inner` si emula solo l'esclusione delle righe
//    senza figlio);
//  · `single()` con più righe: restituisce la prima, mentre PostgREST
//    risponderebbe errore. Un fixture con due righe sulla stessa chiave passa;
//  · RLS: il finto client è sempre service-role. Le policy si provano sul DB,
//    non qui.
// =============================================================================

export type Riga = Record<string, unknown>
export type DBFinto = Record<string, Riga[]>

export interface ErrorePostgrest {
  code: string
  message?: string
  details?: string | null
  hint?: string | null
}

export type OperazioneScrittura = 'insert' | 'update' | 'upsert' | 'delete'

export interface Scrittura {
  tabella: string
  operazione: OperazioneScrittura
  /** Righe (o patch) passate alla chiamata, sempre normalizzate ad array. */
  valori: Riga[]
  /** Righe effettivamente scritte/rimosse dopo l'applicazione dei filtri. */
  colpite: Riga[]
}

export interface RispostaRpc {
  data: unknown
  error: unknown
}

export interface OpzioniFinto {
  /** tabella → errore PostgREST restituito da OGNI operazione su quella tabella. */
  errori?: Record<string, ErrorePostgrest>
  /** Accumulatore delle scritture, come `tabelleLette` lo è delle letture. */
  scritture?: Scrittura[]
  /** Implementazioni di `rpc(nome, args)`. Senza, `rpc()` lancia. */
  rpc?: Record<string, (args: Riga) => RispostaRpc | Promise<RispostaRpc>>
}

// -----------------------------------------------------------------------------
// Confronti
// -----------------------------------------------------------------------------

type Predicato = (riga: Riga) => boolean

function primitivo(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof v)
}

/** Uguaglianza tollerante fra il valore del fixture e quello del filtro
 *  (PostgREST viaggia in stringa: `is_broadcast.eq.true` vs `true`). */
function uguale(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a
  const y = b === undefined ? null : b
  if (x === y) return true
  if (x === null || y === null) return false
  if (!primitivo(x) || !primitivo(y)) return false
  return String(x) === String(y)
}

/** −1 / 0 / 1, oppure `null` se il confronto non è definito (NULL in SQL). */
function compara(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  const na = Number(a)
  const nb = Number(b)
  const numerici =
    typeof a !== 'boolean' &&
    typeof b !== 'boolean' &&
    String(a).trim() !== '' &&
    String(b).trim() !== '' &&
    !Number.isNaN(na) &&
    !Number.isNaN(nb)
  if (numerici) return na < nb ? -1 : na > nb ? 1 : 0
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function comeArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (v === null || v === undefined) return []
  return [v]
}

function regexDaPattern(pattern: string, insensibile: boolean): RegExp {
  const corpo = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.')
  return new RegExp(`^${corpo}$`, insensibile ? 'i' : '')
}

/** Valori confrontabili di una colonna, anche annidata (`alunni.scuola_id`).
 *  Nodo annidato assente ⇒ elenco vuoto ⇒ la riga non passa (join `!inner`). */
function valoriDi(riga: Riga, colonna: string): unknown[] {
  if (!colonna.includes('.')) return [riga[colonna]]
  const [radice, ...resto] = colonna.split('.')
  const campo = resto.join('.')
  const nodo = riga[radice]
  if (nodo == null) return []
  const nodi = Array.isArray(nodo) ? (nodo as Riga[]) : [nodo as Riga]
  return nodi.filter((n) => n != null).map((n) => n[campo])
}

const OPERATORI_SCALARI = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'is',
  'in',
  'cs',
  'contains',
  'cd',
  'containedby',
  'ov',
  'overlaps',
])

/** Il predicato su UN valore. `null` come valore è già stato filtrato a monte
 *  per gli operatori a logica a tre valori. */
function valuta(operatore: string, valore: unknown, atteso: unknown): boolean {
  switch (operatore) {
    case 'eq':
      return uguale(valore, atteso)
    case 'neq':
      return !uguale(valore, atteso)
    case 'gt':
      return compara(valore, atteso) === 1
    case 'gte': {
      const c = compara(valore, atteso)
      return c === 0 || c === 1
    }
    case 'lt':
      return compara(valore, atteso) === -1
    case 'lte': {
      const c = compara(valore, atteso)
      return c === 0 || c === -1
    }
    case 'like':
      return valore != null && regexDaPattern(String(atteso), false).test(String(valore))
    case 'ilike':
      return valore != null && regexDaPattern(String(atteso), true).test(String(valore))
    case 'is':
      if (atteso === null) return valore === null || valore === undefined
      return valore === atteso
    case 'in':
      return comeArray(atteso).some((a) => uguale(valore, a))
    case 'cs':
    case 'contains':
      return comeArray(atteso).every((a) => comeArray(valore).some((v) => uguale(v, a)))
    case 'cd':
    case 'containedby':
      return comeArray(valore).every((v) => comeArray(atteso).some((a) => uguale(a, v)))
    case 'ov':
    case 'overlaps':
      return comeArray(atteso).some((a) => comeArray(valore).some((v) => uguale(v, a)))
    default:
      throw new Error(
        `finto-supabase: operatore non emulato dal finto client: "${operatore}". ` +
          'Implementalo in __tests__/fixtures/finto-supabase.ts oppure cambia il test.',
      )
  }
}

function predicatoDa(colonna: string, operatore: string, atteso: unknown, negato = false): Predicato {
  const op = operatore.toLowerCase()
  if (!OPERATORI_SCALARI.has(op)) {
    throw new Error(
      `finto-supabase: operatore non emulato dal finto client: "${op}" su "${colonna}". ` +
        'Implementalo in __tests__/fixtures/finto-supabase.ts oppure cambia il test.',
    )
  }
  // `neq` e `not.<op>` seguono la logica a tre valori di SQL: su un valore NULL
  // il confronto vale NULL, quindi la riga NON passa. È la differenza fra
  // «escludi la sede B» e «escludi la sede B ma tienimi tutte le righe globali».
  const treValori = negato || op === 'neq'
  return (riga: Riga) =>
    valoriDi(riga, colonna).some((v) => {
      if (treValori && op !== 'is' && (v === null || v === undefined)) return false
      const esito = valuta(op === 'neq' ? 'eq' : op, v, atteso)
      return negato || op === 'neq' ? !esito : esito
    })
}

// -----------------------------------------------------------------------------
// Parsing della stringa di filtro PostgREST usata da `.or()`
// -----------------------------------------------------------------------------

/** Divide sulle virgole di primo livello, rispettando `()`, `{}` e le virgolette. */
function dividiLivello(testo: string): string[] {
  const pezzi: string[] = []
  let profondita = 0
  let inVirgolette = false
  let corrente = ''
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i]
    if (inVirgolette) {
      corrente += c
      if (c === '"' && testo[i - 1] !== '\\') inVirgolette = false
      continue
    }
    if (c === '"') {
      inVirgolette = true
      corrente += c
      continue
    }
    if (c === '(' || c === '{') profondita++
    if (c === ')' || c === '}') profondita--
    if (c === ',' && profondita === 0) {
      pezzi.push(corrente)
      corrente = ''
      continue
    }
    corrente += c
  }
  if (corrente.trim() !== '') pezzi.push(corrente)
  return pezzi.map((p) => p.trim()).filter((p) => p !== '')
}

function scartaVirgolette(t: string): string {
  const s = t.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  return s
}

function letterale(t: string): unknown {
  const s = t.trim()
  if (s.startsWith('"')) return scartaVirgolette(s)
  if (s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  return s
}

/** `(a,b)` o `{a,b}` → array; altrimenti scalare. */
function valoreDiFiltro(grezzo: string): unknown {
  const s = grezzo.trim()
  if ((s.startsWith('(') && s.endsWith(')')) || (s.startsWith('{') && s.endsWith('}'))) {
    return dividiLivello(s.slice(1, -1)).map(letterale)
  }
  return letterale(s)
}

function predicatoDaStringa(nodo: string): Predicato {
  const s = nodo.trim()
  // `[\s\S]` e non `.` col flag `s`: il target del progetto è ES2017.
  const gruppo = /^(not\.)?(and|or)\(([\s\S]*)\)$/i.exec(s)
  if (gruppo) {
    const negato = Boolean(gruppo[1])
    const tipo = gruppo[2].toLowerCase()
    const figli = dividiLivello(gruppo[3]).map(predicatoDaStringa)
    const base: Predicato =
      tipo === 'and' ? (r) => figli.every((f) => f(r)) : (r) => figli.some((f) => f(r))
    return negato ? (r) => !base(r) : base
  }
  const primo = s.indexOf('.')
  if (primo <= 0) {
    throw new Error(`finto-supabase: filtro non emulato dal finto client: "${s}"`)
  }
  const colonna = s.slice(0, primo)
  let resto = s.slice(primo + 1)
  let negato = false
  if (resto.toLowerCase().startsWith('not.')) {
    negato = true
    resto = resto.slice(4)
  }
  const secondo = resto.indexOf('.')
  if (secondo <= 0) {
    throw new Error(`finto-supabase: filtro non emulato dal finto client: "${s}"`)
  }
  const operatore = resto.slice(0, secondo)
  const valore = valoreDiFiltro(resto.slice(secondo + 1))
  return predicatoDa(colonna, operatore, valore, negato)
}

// -----------------------------------------------------------------------------
// Il client
// -----------------------------------------------------------------------------

/** Chiavi che il runtime JS sonda da solo (thenable, stampa, matcher): devono
 *  rispondere `undefined` invece di far esplodere il proxy. */
const SONDE_JS = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'inspect',
  '$$typeof',
  'asymmetricMatch',
  'nodeType',
  'tagName',
  '_isMockFunction',
])

function conProxy<T extends object>(bersaglio: T, descrizione: string): T {
  return new Proxy(bersaglio, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (SONDE_JS.has(prop)) return undefined
      throw new Error(
        `finto-supabase: ${descrizione} non emulato dal finto client: ".${prop}". ` +
          'Implementalo in __tests__/fixtures/finto-supabase.ts oppure cambia il test — ' +
          'un mock che accetta in silenzio ciò che non sa fare rende verdi i test che dovrebbero essere rossi.',
      )
    },
  })
}

interface Risultato {
  data: unknown
  error: unknown
  count: number | null
  status: number
  statusText: string
}

/**
 * @param db           tabella → righe (mutabile dal test fra un caso e l'altro,
 *                     e mutata DAVVERO dalle scritture)
 * @param tabelleLette accumulatore dei `from(<tabella>)` eseguiti: serve a
 *                     provare che dopo un 403 la route NON ha letto gli alunni.
 * @param opzioni      errori iniettati per tabella, accumulatore scritture, rpc.
 */
export function creaFintoSupabase(
  db: DBFinto,
  tabelleLette: string[] = [],
  opzioni: OpzioniFinto = {},
): SupabaseClient {
  let contatore = 0
  const nuovoId = () => `finto-${++contatore}`

  const from = (tabella: string) => {
    tabelleLette.push(tabella)

    const predicati: Predicato[] = []
    const ordinamenti: { colonna: string; crescente: boolean }[] = []
    let massimo: number | null = null
    let intervallo: [number, number] | null = null
    let conteggio: string | null = null
    let soloTesta = false
    let selezionato = false
    let operazione: OperazioneScrittura | null = null
    let payload: Riga[] = []
    let chiaviConflitto: string[] = ['id']
    let lanciaSuErrore = false
    let calcolato: Risultato | null = null

    const errore = opzioni.errori?.[tabella] ?? null

    const tabellaScrivibile = (): Riga[] => {
      if (!Array.isArray(db[tabella])) db[tabella] = []
      return db[tabella]
    }
    const filtrate = (righe: Riga[]): Riga[] => righe.filter((r) => predicati.every((p) => p(r)))

    const ordina = (righe: Riga[]): Riga[] => {
      if (ordinamenti.length === 0) return righe
      return [...righe].sort((x, y) => {
        for (const o of ordinamenti) {
          const a = valoriDi(x, o.colonna)[0]
          const b = valoriDi(y, o.colonna)[0]
          const aNullo = a === null || a === undefined
          const bNullo = b === null || b === undefined
          // PostgreSQL: i NULL valgono «più grandi» (ultimi in ASC, primi in DESC).
          if (aNullo || bNullo) {
            if (aNullo && bNullo) continue
            const segno = aNullo ? 1 : -1
            return o.crescente ? segno : -segno
          }
          const c = compara(a, b) ?? 0
          if (c !== 0) return o.crescente ? c : -c
        }
        return 0
      })
    }

    const taglia = (righe: Riga[]): Riga[] => {
      let out = righe
      if (intervallo) out = out.slice(intervallo[0], intervallo[1] + 1)
      if (massimo != null) out = out.slice(0, massimo)
      return out
    }

    /** Copia della riga con una chiave primaria finta se manca: le route fanno
     *  `.insert(…).select('id').single()` e si aspettano l'id generato dal DB. */
    const conId = (r: Riga): Riga => {
      const copia = { ...r }
      if (copia.id === undefined || copia.id === null) copia.id = nuovoId()
      return copia
    }

    const registra = (valori: Riga[], colpite: Riga[]) => {
      opzioni.scritture?.push({
        tabella,
        operazione: operazione as OperazioneScrittura,
        valori: valori.map((r) => ({ ...r })),
        colpite: colpite.map((r) => ({ ...r })),
      })
    }

    const esegui = (): Risultato => {
      if (calcolato) return calcolato
      if (errore) {
        calcolato = {
          data: null,
          error: { details: null, hint: null, message: '', ...errore },
          count: null,
          status: 400,
          statusText: 'Bad Request',
        }
        return calcolato
      }

      let righe: Riga[] = []
      let totale: number | null = null

      if (operazione === null) {
        const base = ordina(filtrate(db[tabella] ?? []))
        totale = conteggio ? base.length : null
        righe = taglia(base).map((r) => ({ ...r }))
      } else if (operazione === 'insert') {
        const tab = tabellaScrivibile()
        const inserite = payload.map(conId)
        tab.push(...inserite)
        registra(payload, inserite)
        righe = inserite.map((r) => ({ ...r }))
        totale = conteggio ? inserite.length : null
      } else if (operazione === 'upsert') {
        const tab = tabellaScrivibile()
        const colpite: Riga[] = []
        for (const nuova of payload) {
          const esistente = tab.find((r) => chiaviConflitto.every((k) => uguale(r[k], nuova[k])))
          if (esistente) {
            Object.assign(esistente, nuova)
            colpite.push(esistente)
          } else {
            const creata = conId(nuova)
            tab.push(creata)
            colpite.push(creata)
          }
        }
        registra(payload, colpite)
        righe = colpite.map((r) => ({ ...r }))
        totale = conteggio ? colpite.length : null
      } else if (operazione === 'update') {
        const colpite = filtrate(tabellaScrivibile())
        for (const r of colpite) Object.assign(r, payload[0] ?? {})
        registra(payload, colpite)
        righe = colpite.map((r) => ({ ...r }))
        totale = conteggio ? colpite.length : null
      } else {
        const tab = tabellaScrivibile()
        const colpite = filtrate(tab)
        for (const r of colpite) {
          const i = tab.indexOf(r)
          if (i >= 0) tab.splice(i, 1)
        }
        registra([], colpite)
        righe = colpite.map((r) => ({ ...r }))
        totale = conteggio ? colpite.length : null
      }

      const restituisce = operazione === null ? !soloTesta : selezionato
      calcolato = {
        data: restituisce ? righe : null,
        error: null,
        count: totale,
        status: 200,
        statusText: 'OK',
      }
      return calcolato
    }

    const conLancio = (r: Risultato): Risultato => {
      if (lanciaSuErrore && r.error) throw r.error
      return r
    }

    const b: Record<string, unknown> = {}

    // `referencedTable`/`foreignTable` cambiano il bersaglio dell'operazione
    // (ordina/limita la risorsa EMBEDDED, non la principale): accettarli senza
    // emularli è la stessa trappola di `.or() => b`.
    const vietaRiferita = (metodo: string, opts?: { referencedTable?: string; foreignTable?: string }) => {
      if (opts?.referencedTable || opts?.foreignTable) {
        throw new Error(
          `finto-supabase: \`.${metodo}()\` su tabella referenziata non emulato dal finto client. ` +
            'Implementalo in __tests__/fixtures/finto-supabase.ts oppure cambia il test.',
        )
      }
    }

    b.select = (colonne?: string, opts?: { count?: string; head?: boolean }) => {
      selezionato = true
      if (opts?.count) conteggio = opts.count
      if (opts?.head) soloTesta = true
      // `!inner`: il join interno ESCLUDE le righe senza figlio. È metà del
      // presidio d'isolamento (`select('*, alunni!inner(scuola_id)')` +
      // `.in('alunni.scuola_id', plessi)`), quindi va emulato anche quando il
      // filtro sul campo annidato non c'è.
      for (const m of String(colonne ?? '').matchAll(/(?:([A-Za-z0-9_]+)\s*:)?([A-Za-z0-9_]+)\s*!\s*inner/g)) {
        const chiave = m[1] ?? m[2]
        predicati.push((r) => {
          const nodo = r[chiave]
          if (nodo === null || nodo === undefined) return false
          return !Array.isArray(nodo) || nodo.length > 0
        })
      }
      return proxy
    }
    b.insert = (righe: Riga | Riga[]) => {
      operazione = 'insert'
      payload = Array.isArray(righe) ? righe : [righe]
      return proxy
    }
    b.update = (patch: Riga) => {
      operazione = 'update'
      payload = [patch]
      return proxy
    }
    b.upsert = (righe: Riga | Riga[], opts?: { onConflict?: string }) => {
      operazione = 'upsert'
      payload = Array.isArray(righe) ? righe : [righe]
      if (opts?.onConflict) chiaviConflitto = opts.onConflict.split(',').map((c) => c.trim())
      return proxy
    }
    b.delete = () => {
      operazione = 'delete'
      return proxy
    }

    const aggiungi = (p: Predicato) => {
      predicati.push(p)
      return proxy
    }
    b.eq = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'eq', v))
    b.neq = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'neq', v))
    b.gt = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'gt', v))
    b.gte = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'gte', v))
    b.lt = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'lt', v))
    b.lte = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'lte', v))
    b.like = (c: string, v: string) => aggiungi(predicatoDa(c, 'like', v))
    b.ilike = (c: string, v: string) => aggiungi(predicatoDa(c, 'ilike', v))
    b.is = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'is', v))
    b.in = (c: string, v: unknown[]) => aggiungi(predicatoDa(c, 'in', v ?? []))
    b.contains = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'cs', v))
    b.containedBy = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'cd', v))
    b.overlaps = (c: string, v: unknown) => aggiungi(predicatoDa(c, 'ov', v))
    b.not = (c: string, op: string, v: unknown) => aggiungi(predicatoDa(c, op, v, true))
    b.filter = (c: string, op: string, v: unknown) => {
      const negato = op.toLowerCase().startsWith('not.')
      const vero = negato ? op.slice(4) : op
      const valore = typeof v === 'string' ? valoreDiFiltro(v) : v
      return aggiungi(predicatoDa(c, vero, valore, negato))
    }
    b.match = (criteri: Riga) => {
      for (const [c, v] of Object.entries(criteri)) predicati.push(predicatoDa(c, 'eq', v))
      return proxy
    }
    b.or = (filtro: string, opts?: { referencedTable?: string; foreignTable?: string }) => {
      vietaRiferita('or', opts)
      const figli = dividiLivello(filtro).map(predicatoDaStringa)
      return aggiungi((r) => figli.some((f) => f(r)))
    }

    b.order = (
      colonna: string,
      opts?: { ascending?: boolean; referencedTable?: string; foreignTable?: string },
    ) => {
      vietaRiferita('order', opts)
      ordinamenti.push({ colonna, crescente: opts?.ascending !== false })
      return proxy
    }
    b.limit = (n: number, opts?: { referencedTable?: string; foreignTable?: string }) => {
      vietaRiferita('limit', opts)
      massimo = n
      return proxy
    }
    b.range = (da: number, a: number, opts?: { referencedTable?: string; foreignTable?: string }) => {
      vietaRiferita('range', opts)
      intervallo = [da, a]
      return proxy
    }
    b.throwOnError = () => {
      lanciaSuErrore = true
      return proxy
    }
    b.abortSignal = () => proxy
    b.returns = () => proxy
    b.overrideTypes = () => proxy

    b.maybeSingle = async () => {
      selezionato = true
      const r = conLancio(esegui())
      if (r.error) return { data: null, error: r.error, count: r.count, status: r.status, statusText: r.statusText }
      const righe = (r.data as Riga[] | null) ?? []
      return { data: righe[0] ?? null, error: null, count: r.count, status: 200, statusText: 'OK' }
    }
    b.single = async () => {
      selezionato = true
      const r = conLancio(esegui())
      if (r.error) return { data: null, error: r.error, count: r.count, status: r.status, statusText: r.statusText }
      const righe = (r.data as Riga[] | null) ?? []
      if (righe.length === 0) {
        const err = {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
          details: 'The result contains 0 rows',
          hint: null,
        }
        if (lanciaSuErrore) throw err
        return { data: null, error: err, count: r.count, status: 406, statusText: 'Not Acceptable' }
      }
      return { data: righe[0], error: null, count: r.count, status: 200, statusText: 'OK' }
    }
    // Thenable: `await query` senza terminatore (liste e scritture «nude»).
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      let r: Risultato
      try {
        r = conLancio(esegui())
      } catch (e) {
        return Promise.reject(e).then(ok, ko)
      }
      return Promise.resolve(r).then(ok, ko)
    }

    const proxy = conProxy(b, `metodo di query su "${tabella}"`) as Record<string, unknown>
    return proxy
  }

  const client: Record<string, unknown> = {
    from,
    rpc: async (nome: string, args: Riga = {}) => {
      const impl = opzioni.rpc?.[nome]
      if (!impl) {
        throw new Error(
          `finto-supabase: rpc("${nome}") non emulata dal finto client. ` +
            'Passala in `opzioni.rpc` oppure cambia il test.',
        )
      }
      return await impl(args)
    },
    storage: {
      from: (bucket: string) => {
        throw new Error(
          `finto-supabase: storage.from("${bucket}") non emulato dal finto client. ` +
            'Sostituisci `client.storage` nel test con un finto storage che registri gli accessi.',
        )
      },
    },
  }

  return conProxy(client, 'membro del client') as unknown as SupabaseClient
}
