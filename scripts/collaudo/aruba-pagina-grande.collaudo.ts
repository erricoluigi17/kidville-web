import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { arubaBaseUrls, arubaSignin, numeroSezionaleDaEtichetta, PAUSA_FRA_PAGINE_MS } from '@/lib/aruba/client'

/**
 * FASE 0 — QUANTO GRANDE PUÒ ESSERE UNA PAGINA, E DOVE VIVE L'INVOLUCRO. Sola lettura.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────────
 * Leggere il progressivo costa 7 pagine e ~30 secondi di sole pause: misurato il
 * 2026-09-07, una riga di `app_log` delle 15:27:56 porta `aruba:findByUsername` con
 * `occorrenze: 7` dentro UNA sola invocazione. Se una pagina più grande funzionasse, la
 * lettura scenderebbe a una richiesta.
 *
 * La documentazione ufficiale dichiara `size` «Range: 1-100». **In produzione ne
 * chiediamo 500 e li otteniamo** (3.311 documenti in 7 pagine, `pagine-troncate` mai
 * comparso): il tetto dichiarato non è applicato. Quindi 5.000 non è una speranza, è una
 * domanda legittima — ma è una domanda che si MISURA, non si deduce.
 *
 * ─── LE TRE COSE CHE MISURA, E PERCHÉ CIASCUNA ──────────────────────────────────────
 *  1. **La `size` che l'involucro ECHEGGIA.** È il rilevatore del cap silenzioso: se
 *     chiediamo 5.000 e l'involucro risponde `size: 500`, il tetto c'è ed è quello. Senza
 *     questo confronto, alzare `PAGINA_SIZE` romperebbe l'uscita del ciclo — che oggi è
 *     `ricevuti < PAGINA_SIZE` e regge per caso, perché `500 < 500` è falso.
 *  2. **`page=0` contro `page=1`.** Nessuno l'ha mai misurato. Il ciclo parte da 1;
 *     l'involucro è una pagina Spring, e Spring è 0-based. Con 7 pagine da 500 l'errore
 *     sarebbe parziale; con UNA pagina da 5.000, `page=1` in semantica 0-based sarebbe la
 *     seconda pagina di un elenco che ne ha una — vuota, e un elenco vuoto oggi esce come
 *     progressivo ZERO, senza eccezione e senza log.
 *  3. **DOVE stanno i campi dell'involucro.** `paginaUltimoNumero` fa
 *     `const env = (json.value) ?? json`: se `last`/`totalElements` stessero a un livello
 *     diverso da quello che una fixture assume, il test sarebbe verde e la produzione
 *     cieca. È letteralmente l'incidente del 2026-09-02, dove `number` non stava dove il
 *     codice lo cercava — 3.311 documenti letti e zero etichette riconosciute.
 *
 * ─── COSA NON FA ────────────────────────────────────────────────────────────────────
 * Non emette, non carica, non scrive: `findByUsername` è una GET. Stampa solo interi,
 * booleani e NOMI di campo. I documenti contengono `receiver.fiscalCode` di genitori
 * reali: non se ne stampa nemmeno uno.
 *
 * ⚠️ Usa `fetch` diretto e non il `chiamaAruba` del client, perché deve leggere
 * l'involucro GREZZO — quello che il client oggi butta via. Il tetto di 30 s è
 * replicato a mano per stare vicino al comportamento vero di `externalFetch`.
 *
 * ─── QUANTO COSTA ───────────────────────────────────────────────────────────────────
 * **1 `signin` + al massimo 5 GET**, distanziate di `PAUSA_FRA_PAGINE_MS` (5 s: SLA §3,
 * 12 ricerche al minuto per IP). Ogni tentativo — anche rifiutato — fa un *touch* che
 * rimette a un'ora il TTL del secchio. Si esegue come PRIMA cosa della sessione, senza
 * altre chiamate ad Aruba prima, e non si rilancia «per riprovare».
 *
 * ESECUZIONE:
 *
 *   COLLAUDO_REALE=1 npx vitest run --config vitest.collaudo.config.ts \
 *     scripts/collaudo/aruba-pagina-grande.collaudo.ts
 *
 * ⚠️ Il file va nominato per esteso: senza argomento, l'`include` tira dentro anche gli
 * altri collaudi, che hanno prerequisiti diversi e spenderebbero altra quota.
 */

function envLocale(nome: string): string {
  const diretta = process.env[nome]
  if (diretta) return diretta
  try {
    const testo = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
    const m = testo.match(new RegExp(`^\\s*${nome}\\s*=\\s*(.*)$`, 'm'))
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

const ATTIVO = process.env.COLLAUDO_REALE === '1'
const USERNAME = envLocale('ARUBA_USERNAME')
const PASSWORD = envLocale('ARUBA_PASSWORD')

/**
 * Le `size` da provare, dalla più ambiziosa alla più prudente. Si smette alla prima che
 * funziona: quella è il tetto utile, e ogni tentativo in più costa un *touch* sul secchio.
 *
 * Il valore predefinito è la scala già percorsa il 2026-09-07 (esito nella testata).
 * Si sovrascrive con `COLLAUDO_SIZES=3500,2000` quando si vuole stringere il tetto.
 */
const SCALA = (process.env.COLLAUDO_SIZES ?? '5000,1000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

/** Le chiavi dell'involucro che decidono il piano. */
const CHIAVI_INVOLUCRO = [
  'number',
  'size',
  'numberOfElements',
  'totalElements',
  'totalPages',
  'last',
  'first',
  'errorCode',
] as const

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const scrivi = (riga: string): void => void process.stdout.write(`${riga}\n`)

interface Esito {
  stato: number
  /** L'oggetto in cima alla risposta. */
  radice: Record<string, unknown>
  /** Quello che il client userebbe: `json.value ?? json`. */
  env: Record<string, unknown>
  documenti: unknown[]
}

/**
 * Una GET a `findByUsername`, con l'involucro conservato intero.
 *
 * `size` e `page` arrivano da fuori proprio perché sono la cosa in esame: qui non c'è
 * nessun valore predefinito da cui farsi ingannare.
 */
async function chiedi(
  ws: string,
  accessToken: string,
  params: { anno: number; page: number; size: number; sort?: string },
): Promise<Esito> {
  const qs = new URLSearchParams({
    username: USERNAME,
    page: String(params.page),
    size: String(params.size),
    startDate: `${params.anno}-01-01`,
    endDate: `${params.anno}-12-31`,
  })
  if (params.sort) qs.set('sort', params.sort)
  const res = await fetch(`${ws}/services/invoice/out/findByUsername?${qs.toString()}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  })
  const testo = await res.text()
  let radice: Record<string, unknown> = {}
  try {
    radice = JSON.parse(testo) as Record<string, unknown>
  } catch {
    // Un corpo illeggibile è un dato, non un incidente: lo si dice e si va avanti.
    scrivi(`  ⚠️ corpo non JSON (${testo.length} byte, primi 120: ${testo.slice(0, 120)})`)
  }
  const env = ((radice.value as Record<string, unknown> | undefined) ?? radice) ?? {}
  const documenti = ((env.content ?? env.invoices ?? []) as unknown[]) ?? []
  return { stato: res.status, radice, env, documenti }
}

/**
 * Stampa i valori dell'involucro E il livello in cui vivono.
 *
 * Il livello non è un dettaglio: `paginaUltimoNumero` legge da `json.value ?? json`, e una
 * fixture che mettesse questi campi dalla parte sbagliata produrrebbe un test verde su una
 * produzione cieca.
 */
function descriviInvolucro(e: Esito): void {
  const dentroValue = e.radice.value != null && typeof e.radice.value === 'object'
  scrivi(`  livello: i campi stanno ${dentroValue ? 'SOTTO «value»' : 'IN CIMA (nessun «value»)'}`)
  for (const chiave of CHIAVI_INVOLUCRO) {
    const inCima = Object.prototype.hasOwnProperty.call(e.radice, chiave)
    const inEnv = Object.prototype.hasOwnProperty.call(e.env, chiave)
    if (!inCima && !inEnv) {
      scrivi(`    ${chiave.padEnd(17)} ASSENTE`)
      continue
    }
    const valore = inEnv ? e.env[chiave] : e.radice[chiave]
    const dove = inEnv && dentroValue ? 'value' : 'radice'
    scrivi(`    ${chiave.padEnd(17)} ${JSON.stringify(valore)}   (in ${dove})`)
  }
  scrivi(`    chiavi dell'involucro: ${Object.keys(e.env).sort().join(', ')}`)
}

/** Il massimo per serie leggibile da QUESTA pagina soltanto. Nessun dato personale esce. */
function massimiDellaPagina(documenti: unknown[], anno: number): { asilo: number; fpr: number; etichette: number } {
  let asilo = 0
  let fpr = 0
  let etichette = 0
  for (const doc of documenti) {
    if (!doc || typeof doc !== 'object') continue
    const invoices = (doc as { invoices?: unknown }).invoices
    const numeri = Array.isArray(invoices)
      ? invoices.map((f) => (f && typeof f === 'object' ? (f as { number?: unknown }).number : undefined))
      : [(doc as { number?: unknown }).number]
    for (const etichetta of numeri) {
      const a = numeroSezionaleDaEtichetta(etichetta, 'Asilo', anno)
      const f = numeroSezionaleDaEtichetta(etichetta, 'FPR', anno)
      if (a !== null || f !== null) etichette++
      if (a !== null && a > asilo) asilo = a
      if (f !== null && f > fpr) fpr = f
    }
  }
  return { asilo, fpr, etichette }
}

describe.skipIf(!ATTIVO || !USERNAME || !PASSWORD)('fase 0 — la pagina grande, e dove vive l\'involucro', () => {
  it('misura la size che Aruba concede davvero, la semantica di page, e i campi dell\'involucro', async () => {
    const anno = new Date().getFullYear()
    const { accessToken } = await arubaSignin('production', { username: USERNAME, password: PASSWORD })
    const { ws } = arubaBaseUrls('production')

    let gettate = 0
    /** Ogni GET dopo la prima paga il ritmo. Il conto è dichiarato, non implicito. */
    const get = async (etichetta: string, p: { page: number; size: number; sort?: string }): Promise<Esito> => {
      if (gettate > 0) await attendi(PAUSA_FRA_PAGINE_MS)
      gettate++
      scrivi(`\n── GET ${gettate}/5 — ${etichetta}  (page=${p.page} size=${p.size}${p.sort ? ` sort=${p.sort}` : ''})`)
      const e = await chiedi(ws, accessToken, { anno, ...p })
      scrivi(`  HTTP ${e.stato} · documenti in «content»: ${e.documenti.length}`)
      descriviInvolucro(e)
      const m = massimiDellaPagina(e.documenti, anno)
      scrivi(`  massimi DA QUESTA PAGINA: Asilo ${m.asilo} · FPR ${m.fpr} · etichette lette ${m.etichette}`)
      return e
    }

    // ── La scala delle `size`, dalla più ambiziosa alla più prudente. ────────────
    // Si smette alla PRIMA che funziona: quella è il tetto utile, e un tentativo in
    // più non è gratis. Il rifiuto NON è un errore HTTP — è un 200 con l'involucro a
    // zero e `errorCode` diverso da «0000», che è precisamente il difetto che il
    // codice di produzione oggi legge come «serie vuota».
    let buona: Esito | null = null
    let sizeBuona = 0
    for (const size of SCALA) {
      const e = await get(`size richiesta ${size}`, { page: 1, size })
      const codice = String(e.env.errorCode ?? '')
      const echeggiata = Number(e.env.size ?? 0)
      if (codice === '0000' && echeggiata === size && e.documenti.length > 0) {
        buona = e
        sizeBuona = size
        break
      }
      scrivi(`  ↳ RIFIUTATA: errorCode ${JSON.stringify(codice)}, size echeggiata ${echeggiata}`)
    }

    // ── L'ordinamento inverso, solo se nemmeno la size più piccola è bastata. ────
    let ordinata: Esito | null = null
    if (!buona && gettate < 5) {
      ordinata = await get('ordinamento inverso', { page: 1, size: 500, sort: 'id,desc' })
    }

    // ── IL VERDETTO, stampato PRIMA di qualunque asserzione ──────────────────────
    // Un valore non stampato è un valore perso: esiste solo durante la chiamata, e
    // rivederlo costa un'altra finestra da un'ora.
    const totale = Number(buona?.env.totalElements ?? -1)
    const m = buona ? massimiDellaPagina(buona.documenti, anno) : { asilo: 0, fpr: 0, etichette: 0 }
    const pagine = buona ? Number(buona.env.totalPages ?? -1) : -1

    scrivi('\n════════════════════ ESITO DELLA FASE 0 ════════════════════')
    scrivi(`  GET spese: ${gettate} (più 1 signin) · scala provata: ${SCALA.join(', ')}`)
    scrivi(`  size più grande ACCETTATA: ${sizeBuona || 'nessuna'}`)
    scrivi(`  totalElements: ${totale} · totalPages a quella size: ${pagine}`)
    if (buona) {
      scrivi(`  semantica di page: number=${JSON.stringify(buona.env.number)} con page=1, ` +
        `first=${JSON.stringify(buona.env.first)} → ${buona.env.first === true ? '1-BASED' : 'DA CHIARIRE'}`)
      scrivi(`  involucro: ${buona.radice.value != null ? 'sotto «value»' : 'IN CIMA (nessun «value»)'}`)
    }
    if (ordinata) scrivi(`  sort=id,desc → Asilo ${massimiDellaPagina(ordinata.documenti, anno).asilo}`)

    const unaPaginaBasta = pagine === 1
    scrivi(`\n  UNA PAGINA BASTA? ${unaPaginaBasta ? 'SÌ' : `NO — ne servono ${pagine}`}`)
    scrivi(`  massimi dalla PRIMA pagina: Asilo ${m.asilo} · FPR ${m.fpr}`)
    scrivi('\n  ⚠️ CRITERIO DI ACCETTAZIONE — da confrontare a mano col testimone esterno:')
    scrivi('     SELECT sezionale, anno, ultimo_numero FROM fatture_numerazione_sezionale;')
    scrivi('     I due massimi qui sopra devono coincidere con quei valori. Se non coincidono,')
    scrivi('     la size nuova NON si adotta: due letture concordi possono sbagliare insieme.')
    scrivi('════════════════════════════════════════════════════════════\n')

    // Le asserzioni sono deliberatamente TENERE: questo file misura, non giudica.
    // L'unica cosa che deve valere è che la misura sia avvenuta.
    expect(gettate, 'senza nemmeno una GET non si è misurato niente').toBeGreaterThan(0)
    expect(gettate, 'il budget dichiarato è di 5 GET').toBeLessThanOrEqual(5)
  })
})
