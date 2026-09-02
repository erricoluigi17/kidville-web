import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * COVERAGE-LOCK · IL CORPO DELLA RICHIESTA SI LEGGE DOPO IL GATE, E CON LA PRIMITIVA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA STORIA (collaudo del 2026-08-02, terza tornata · F1 e F3)
 *
 * `POST /api/primaria/fascicolo` — la rotta che custodisce diagnosi, PEI, PDP e verbali
 * della 104 — rispondeva a un ANONIMO:
 *
 *   curl -X POST -H 'content-type: application/json' -d '{"x":1}' …/api/primaria/fascicolo
 *   → HTTP 500 {"error":"Content-Type was not one of \"multipart/form-data\" or …"}
 *
 * Non mancava il gate: c'era, a tre righe di distanza. Era nell'ordine sbagliato.
 * `await request.formData()` alla riga 72, `resolveIdentity` alla 75 — e `formData()`
 * LANCIA su un Content-Type non multipart, quindi l'eccezione scavalcava il gate e finiva
 * nel `catch` generico, che risponde 500 col messaggio interno del runtime.
 *
 * Lo stesso ciclo, poche ore prima, aveva già corretto questa identica classe di difetto su
 * sei ALTRE rotte, introducendo `parseMultipart`. Su questa no: nessuna correzione l'aveva
 * sfiorata, e niente se ne accorgeva. È il motivo per cui questo file esiste invece di una
 * settima correzione a mano: la regola ha bisogno di qualcuno che la faccia rispettare sulle
 * rotte che ancora non esistono.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DUE REGOLE, E LA SECONDA È QUELLA CHE HA MORSO
 *
 * R1 — LA PRIMITIVA. Il corpo multipart si legge con `parseMultipart`, mai con
 *      `request.formData()` nudo. Sei rotte su dodici la usavano già; le altre sei avevano
 *      il gate al posto giusto, quindi il difetto NON era raggiungibile — ma era la stessa
 *      forma, e la forma si eredita: la prossima rotta di upload sarà scritta copiando una
 *      di queste.
 *
 * R2 — L'ORDINE. Un handler che ha un gate deve chiamarlo PRIMA di leggere il corpo.
 *      Questa è la regola che ha valore: con `parseMultipart` ma nell'ordine sbagliato,
 *      l'anonimo avrebbe preso un 400 pulito al posto del 500 — meglio, e ancora sbagliato,
 *      perché il server avrebbe comunque letto e bufferizzato fino a 15 MB spediti da
 *      chiunque prima di sapere chi fosse.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERCHÉ R2 NON SI APPLICA AGLI HANDLER SENZA GATE
 *
 * Perché sarebbe una seconda copia dell'allowlist di `gate-coverage.test.ts`, e due elenchi
 * della stessa decisione divergono al primo ritocco — che è, letteralmente, il difetto che
 * questo file sorveglia. Un handler senza gate è già materia di quel lock: o è un bug che
 * lì è rosso, o è una porta pubblica per progetto, motivata lì. Qui si chiede una cosa sola,
 * e verificabile: SE un gate c'è, deve venire prima del corpo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RADICE = process.cwd()
const API_ROOT = path.join(RADICE, 'src', 'app', 'api')
const SRC_ROOT = path.join(RADICE, 'src')
const METODI = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS'

const EXPORT_HANDLER = new RegExp(`export\\s+const\\s+(${METODI})\\s*=\\s*withRoute\\s*\\(`, 'g')

/**
 * I gate PRIMITIVI — gli stessi di `gate-coverage.test.ts` e `upload-pubblico-con-tetto.ts`.
 * Tenuti allineati a mano di proposito: il test «i gate esistono davvero con questo nome»
 * qui sotto diventa rosso se qualcuno ne rinomina uno, invece di lasciare che il lock
 * smetta di riconoscerli e diventi verde su niente.
 */
const GATE_BASE = [
  'requireStaff', 'requireDocente', 'requireUser', 'requireKitchenRead',
  'requireParentOfStudent', 'requireFunzione', 'requireArea',
  'loadAppUser', 'resolveIdentity', 'resolveSessionAppId',
  'sealDangerous', 'genitoreHasFiglio',
]
const GATE_SENZA_NOME = String.raw`CRON_SECRET|\bauth\s*\.\s*getUser\s*\(`
const gateRe = (nomi: string[]) =>
  new RegExp(`\\b(?:${nomi.join('|')})\\s*\\(|${GATE_SENZA_NOME}`, 'g')

/**
 * LA LETTURA DEL CORPO, in tutte le forme in cui questo repo la scrive.
 *
 * `parseBody`/`parseMultipart` sono lì dentro perché la primitiva sposta il problema, non lo
 * toglie: `parseBody` legge il body esattamente come `request.json()`, solo con un 400
 * educato quando è malformato. La domanda «chi sta chiamando?» resta da fare prima.
 *
 * Il ricevente è ancorato a `request`/`req` di proposito: `res.json()` di una risposta di
 * `externalFetch` e `NextResponse.json(...)` non sono letture del corpo della RICHIESTA, e
 * senza l'ancora questo lock segnalerebbe mezzo repo — cioè verrebbe spento entro un giorno.
 */
const LETTURA_CORPO = new RegExp(
  String.raw`\b(?:request|req)\s*\.\s*(?:formData|json|text|arrayBuffer|blob|bytes)\s*\(` +
    String.raw`|\bparse(?:Body|Multipart)\s*\(`,
  'g',
)

/** La forma VIETATA da R1: il multipart letto a mano invece che dalla primitiva. */
const FORMDATA_NUDA = /\b(?:request|req)\s*\.\s*formData\s*\(/g

// ─────────────────────────────────────────────────────────────────────────────
// I file
// ─────────────────────────────────────────────────────────────────────────────

function routeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...routeFiles(full))
    else if (e.name === 'route.ts') out.push(full)
  }
  return out
}

const rel = (f: string) => path.relative(RADICE, f).split(path.sep).join('/')
/** `src/app/api/primaria/fascicolo/route.ts` → `primaria/fascicolo` */
const nomeRoute = (f: string) => path.relative(API_ROOT, path.dirname(f)).split(path.sep).join('/')

const FILES = routeFiles(API_ROOT)

/** Dove vive la primitiva: è l'unico posto del repo che PUÒ chiamare `formData()` nudo. */
const CASA_DELLA_PRIMITIVA = 'src/lib/validation/http.ts'

// ─────────────────────────────────────────────────────────────────────────────
// R1 · la primitiva
// ─────────────────────────────────────────────────────────────────────────────

export interface LetturaNuda { file: string; riga: number }

/**
 * Tutto `src/`, non solo `src/app/api/**`: se la chiamata nuda si sposta in un helper di
 * `src/lib` il difetto non è sparito, si è solo nascosto — e un lock che guarda solo le
 * route insegna esattamente quel trucco a chi lo trova sulla sua strada.
 */
export function letturaNudaDelRepo(): LetturaNuda[] {
  const out: LetturaNuda[] = []
  for (const f of fileSorgente(SRC_ROOT)) {
    if (rel(f) === CASA_DELLA_PRIMITIVA) continue
    const src = fs.readFileSync(f, 'utf8')
    const { senzaCommenti } = mascheraSorgente(src)
    FORMDATA_NUDA.lastIndex = 0
    for (let m = FORMDATA_NUDA.exec(senzaCommenti); m; m = FORMDATA_NUDA.exec(senzaCommenti)) {
      out.push({ file: rel(f), riga: riga(src, m.index) })
    }
  }
  return out
}

/**
 * L'ALLOWLIST di R1 — a MATCH ESATTO sul percorso, con la ragione scritta per esteso.
 *
 * È VUOTA, ed è la cosa migliore che possa dire di sé: dopo la correzione del 2026-08-02
 * non esiste in `src/` un solo punto che legga un multipart fuori dalla primitiva. Il
 * meccanismo resta perché una casella vuota si riempie in silenzio; il tetto qui sotto
 * costringe chiunque voglia riempirla a passare da un test rosso e da una motivazione.
 */
const LETTURA_DIRETTA_AMMESSA: Record<string, string> = {}

// ─────────────────────────────────────────────────────────────────────────────
// R2 · l'ordine
// ─────────────────────────────────────────────────────────────────────────────

export interface FuoriOrdine { handler: string; riga: number }

/**
 * Gli handler di un sorgente in cui il corpo si legge PRIMA del gate.
 *
 * Si confrontano i due PRIMI indici e non tutte le coppie: se la prima lettura del corpo
 * precede il primo gate, quella lettura è avvenuta senza sapere chi chiamava — e basta,
 * qualunque cosa venga dopo. Il contrario (primo gate prima della prima lettura) è la forma
 * corretta: i gate successivi affinano, non riaprono.
 */
export function fuoriOrdine(src: string): FuoriOrdine[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const RE_GATE = gateRe(GATE_BASE)
  const out: FuoriOrdine[] = []

  EXPORT_HANDLER.lastIndex = 0
  for (const m of struttura.matchAll(EXPORT_HANDLER)) {
    const da = m.index
    const a = fineParentesi(struttura, da + m[0].length - 1)

    RE_GATE.lastIndex = da
    const g = RE_GATE.exec(senzaCommenti)
    // Nessun gate in questo handler: è materia di `gate-coverage.test.ts`, non di qui.
    if (!g || g.index >= a) continue

    LETTURA_CORPO.lastIndex = da
    const c = LETTURA_CORPO.exec(senzaCommenti)
    if (!c || c.index >= a) continue

    if (c.index < g.index) out.push({ handler: m[1], riga: riga(src, c.index) })
  }
  return out
}

function fuoriOrdineDelRepo(): { chiave: string; dettaglio: string }[] {
  const out: { chiave: string; dettaglio: string }[] = []
  for (const f of FILES) {
    const src = fs.readFileSync(f, 'utf8')
    for (const s of fuoriOrdine(src)) {
      out.push({ chiave: `${nomeRoute(f)}:${s.handler}`, dettaglio: `${rel(f)}:${s.riga}` })
    }
  }
  return out
}

/**
 * L'ALLOWLIST di R2 — `<route>:<METODO>`, a match esatto, mai per prefisso.
 *
 * Una voce qui dentro dichiara: «questo handler DEVE leggere il corpo per sapere chi
 * chiama». Non è mai la scorciatoia per zittire un rosso: se la risposta è «il gate potrebbe
 * stare sopra», si sposta il gate — è ciò che è stato fatto il 2026-08-02 su
 * `locker/requests:PATCH`, il cui `requireDocente(request)` non guardava il corpo affatto.
 *
 * ⚠️ E `locker/requests:PATCH` È TORNATO, il 2026-09-01, dalla porta principale: non perché
 * qualcuno abbia rimesso il gate al posto sbagliato, ma perché il gate È CAMBIATO. Quel
 * `requireDocente` che non guardava il corpo era un gate solo per due gesti opposti — e la
 * pagina genitore chiamava questa PATCH col bottone «Preso in carico», prendendo 403 ogni
 * volta. Ora `presa_in_carico` passa da `requireParentOfStudent(request, alunno_id)` e
 * `evasa` da `requireDocente`: la sesta voce ha la stessa forma delle altre cinque, ed è la
 * dimostrazione che il criterio di questo file non è «chi c'era prima»: è se il soggetto del
 * permesso stia nella sessione o nella richiesta.
 *
 * Le sei voci qui sotto sono tutte la STESSA forma, ed è una forma vera:
 * `requireParentOfStudent(request, studentId)` prende l'id del bambino come ARGOMENTO —
 * l'identità la stabilisce `requireUser` al suo interno, ma il legame «questo bambino è tuo
 * figlio» non si può verificare prima di sapere di quale bambino si parla, e quel dato viaggia
 * nel corpo. Il residuo è quindi limitato: un anonimo fa deserializzare un JSON prima di
 * prendersi il suo 401, e `parseBody` NON lancia sul corpo malformato (risponde 400) — cioè
 * la via che ha prodotto il 500 di `primaria/fascicolo` qui non è aperta.
 *
 * Chi volesse chiudere anche questo residuo ha una strada, e non è un'esenzione: spezzare in
 * `requireUser(request)` sopra il corpo e la verifica del legame sotto. È un intervento su
 * cinque rotte e su un gate condiviso, quindi merita un piano suo — non la coda di questa
 * correzione, dove passerebbe senza che nessuno lo guardi davvero.
 */
const CORPO_PRIMA_DEL_GATE_AMMESSO: Record<string, string> = {
    'locker/inventory:POST':
        'il gate è `requireParentOfStudent(request, alunno_id)` e `alunno_id` è un campo del corpo: ' +
        "il legame genitore↔alunno non è verificabile prima di sapere di quale alunno si tratti",
    'locker/requests:PATCH':
        'stesso identico motivo del gemello qui sopra, e dal 2026-09-01: il gate SEGUE IL GESTO — ' +
        '`presa_in_carico` è il genitore che dice «la porto» (`requireParentOfStudent(request, ' +
        'alunno_id)`), `evasa` è la scuola (`requireDocente`). Quale dei due applicare, e per quale ' +
        'bambino, si sa solo dal corpo. Dopo il gate la route verifica che la riga sia davvero di ' +
        "quell'alunno e risponde 404 altrimenti: `alunno_id` nel corpo apre la porta di casa " +
        'propria, non quella del vicino',
    'parent/giustifiche-didattiche:POST':
        'idem — `requireParentOfStudent(request, studentId)`, con `studentId` nel corpo',
    'parent/presenze/comunica-assenza:POST':
        'idem — `requireParentOfStudent(request, studentId)`, con `studentId` nel corpo',
    'parent/presenze/giustifica:POST':
        'idem — `requireParentOfStudent(request, studentId)`, con `studentId` nel corpo. ' +
        'Il codice OTP e il ticket firmato viaggiano nello stesso corpo',
    'parent/primaria/pagella/firma:POST':
        'idem — `requireParentOfStudent(request, studentId)`, con `studentId` nel corpo',
}

// ─────────────────────────────────────────────────────────────────────────────

describe('lock architettura · il corpo si legge dopo il gate, e con la primitiva', () => {
  it('la misura vede davvero il repo (se cade, tutto il resto è verde sul vuoto)', () => {
    // Cartella sbagliata, regex che non aggancia più `withRoute`, gate rinominati: ognuna di
    // queste renderebbe verdi per sempre le prove qui sotto, su un elenco vuoto.
    expect(FILES.length).toBeGreaterThan(200)
    const handler = FILES.reduce((n, f) => {
      const { struttura } = mascheraSorgente(fs.readFileSync(f, 'utf8'))
      EXPORT_HANDLER.lastIndex = 0
      return n + [...struttura.matchAll(EXPORT_HANDLER)].length
    }, 0)
    expect(handler).toBeGreaterThan(400)

    // Gli handler che leggono un corpo devono ESSERE TANTI: se questo numero crollasse a
    // zero, R2 girerebbe su un insieme vuoto senza che nessuna prova diventi rossa.
    const conCorpo = FILES.reduce((n, f) => {
      const { senzaCommenti } = mascheraSorgente(fs.readFileSync(f, 'utf8'))
      LETTURA_CORPO.lastIndex = 0
      return n + (LETTURA_CORPO.test(senzaCommenti) ? 1 : 0)
    }, 0)
    expect(conCorpo).toBeGreaterThan(100)

    // E i gate primitivi devono esistere con quel nome.
    const authSrc = fs.readFileSync(path.join(SRC_ROOT, 'lib', 'auth', 'require-staff.ts'), 'utf8')
    for (const nome of ['requireStaff', 'requireDocente', 'requireUser', 'resolveIdentity']) {
      expect(authSrc, `${nome} non esiste più: aggiorna GATE_BASE`).toContain(`export async function ${nome}`)
    }
    // E la primitiva deve esistere dove il lock crede che stia.
    expect(
      fs.readFileSync(path.join(RADICE, CASA_DELLA_PRIMITIVA), 'utf8'),
      'Se `parseMultipart` cambia casa, R1 sta esentando un file a caso.',
    ).toContain('export async function parseMultipart')
  })

  it('R1 · nessuno legge un multipart fuori dalla primitiva `parseMultipart`', () => {
    const fuori = letturaNudaDelRepo().filter((l) => !(l.file in LETTURA_DIRETTA_AMMESSA))
    expect(
      fuori.map((l) => `${l.file}:${l.riga}`),
      '`request.formData()` LANCIA su un Content-Type non multipart, e l\'eccezione finisce ' +
        'nel `catch` generico della rotta: 500 al posto di 400, più il messaggio interno del ' +
        'runtime al chiamante. La regola vive in `parseMultipart` (`@/lib/validation/http`) ' +
        'perché una lezione copiata in dodici `catch` diverge al primo ritocco.',
    ).toEqual([])
  })

  it('R2 · dove un gate c\'è, viene PRIMA della lettura del corpo', () => {
    const fuori = fuoriOrdineDelRepo().filter((s) => !(s.chiave in CORPO_PRIMA_DEL_GATE_AMMESSO))
    expect(
      fuori.map((s) => `${s.chiave}  ←  ${s.dettaglio}`),
      "Il corpo viene letto prima di sapere CHI sta chiamando. È la forma esatta di " +
        '`primaria/fascicolo:POST`, che il 2026-08-02 rispondeva 500 a un anonimo sul ' +
        'fascicolo sanitario di un minore. Sposta il gate sopra la lettura: sono due righe, ' +
        'e sono la differenza fra un 401 e un guasto pilotato da fuori.',
    ).toEqual([])
  })

  it('le allowlist non contengono voci morte', () => {
    const nudeVive = new Set(letturaNudaDelRepo().map((l) => l.file))
    expect(
      Object.keys(LETTURA_DIRETTA_AMMESSA).filter((k) => !nudeVive.has(k)),
      "Un'esenzione che non serve più va tolta: se resta, il prossimo file con quel percorso " +
        'eredita in silenzio un permesso che nessuno ha deciso per lui.',
    ).toEqual([])
    const ordineVivi = new Set(fuoriOrdineDelRepo().map((s) => s.chiave))
    expect(Object.keys(CORPO_PRIMA_DEL_GATE_AMMESSO).filter((k) => !ordineVivi.has(k))).toEqual([])
  })

  it('il TETTO delle due allowlist può solo SCENDERE', () => {
    // Una fotografia, non una soglia. Il giorno in cui qualcuno vorrà la prossima eccezione
    // questo test diventerà rosso e la decisione passerà sotto gli occhi di una persona,
    // invece che dentro una diff di cui nessuno si accorge.
    //
    // R1 nasce a ZERO il 2026-08-02: dopo la correzione non c'è in `src/` un solo multipart
    // letto fuori dalla primitiva. Dodici rotte, nessuna eccezione — il che è la prova che
    // l'eccezione non serviva a nessuno.
    expect(
      Object.keys(LETTURA_DIRETTA_AMMESSA).length,
      'Se è SALITO, hai appena tolto un pezzo di R1.',
    ).toBe(0)
    // R2 nasce a CINQUE, tutte della stessa forma (`requireParentOfStudent` col figlio nel
    // corpo). Le sette che il rilevatore trovava alla nascita erano cinque + due difetti:
    // `primaria/fascicolo:POST`, che è il motivo per cui questo file esiste, e
    // `locker/requests:PATCH`, il cui gate non guardava il corpo affatto. Sono state
    // corrette, non esentate — ed è il verso in cui questo numero deve muoversi.
    //
    // ⚠️ SALITO A SEI il 2026-09-01, e questa riga è il punto in cui la decisione è passata
    // sotto gli occhi di qualcuno — che è esattamente ciò per cui il tetto esiste.
    // `locker/requests:PATCH` rientra, e non per un ripensamento sul 2026-08-02: quel giorno
    // il suo `requireDocente` fu spostato sopra il corpo perché il corpo non gli serviva, ed
    // era giusto. Ma quel gate era anche SBAGLIATO nel merito — uno solo per due gesti
    // opposti — e la pagina genitore ci sbatteva contro con un 403 a ogni «Preso in carico».
    // Correggendo il merito, il corpo è tornato a servire: `presa_in_carico` →
    // `requireParentOfStudent(request, alunno_id)`, `evasa` → `requireDocente`. Sesta voce,
    // stessa forma delle altre cinque. Il residuo resta quello dichiarato lassù: un anonimo
    // fa deserializzare un JSON prima del suo 401, e `parseBody` risponde 400 sul corpo
    // malformato invece di lanciare.
    expect(
      Object.keys(CORPO_PRIMA_DEL_GATE_AMMESSO).length,
      'Se è SALITO, hai appena tolto un pezzo di R2 — la regola che ha morso davvero.',
    ).toBe(6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
//
// Un lock verde perché non trova violazioni e un lock verde perché non guarda più niente,
// da fuori, sono identici. Qui sotto la forma vietata resta scritta e ferma: se il
// rilevatore smette di riconoscerla, questi test cadono PRIMA che qualcuno se ne accorga
// in produzione.
// ─────────────────────────────────────────────────────────────────────────────

describe('il rilevatore riconosce la forma vietata', () => {
  it('R2 · corpo letto sopra il gate (era `primaria/fascicolo:POST`, riga 72 contro 75)', () => {
    const src = `
      export const POST = withRoute('primaria/fascicolo:POST', async (request) => {
        try {
          const formData = await request.formData()
          const { userId } = await resolveIdentity(request)
          if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
        } catch (err) { logErrore({ operazione: 'x', stato: 500 }, err) }
      })
    `
    expect(fuoriOrdine(src)).toEqual([{ handler: 'POST', riga: 4 }])
  })

  it('R2 · vale anche con la primitiva: è l\'ORDINE il presidio, non il nome della funzione', () => {
    const src = `
      export const POST = withRoute('x:POST', async (request) => {
        const form = await parseMultipart(request)
        if ('response' in form) return form.response
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
      })
    `
    expect(fuoriOrdine(src)).toEqual([{ handler: 'POST', riga: 3 }])
  })

  it('R2 · un `parseBody` sopra il gate è la stessa forma (legge il corpo lo stesso)', () => {
    const src = `
      export const PUT = withRoute('x:PUT', async (request) => {
        const b = await parseBody(request, schema)
        const auth = await requireDocente(request)
        if (auth.response) return auth.response
      })
    `
    expect(fuoriOrdine(src).map((s) => s.handler)).toEqual(['PUT'])
  })

  it('R2 · un handler in ordine non copre quello sbagliato accanto', () => {
    const src = `
      export const GET = withRoute('x:GET', async (request) => {
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
        const b = await parseBody(request, schema)
      })

      export const POST = withRoute('x:POST', async (request) => {
        const b = await parseBody(request, schema)
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
      })
    `
    expect(fuoriOrdine(src)).toEqual([{ handler: 'POST', riga: 9 }])
  })

  it('R2 · un gate citato in un COMMENTO non sposta l\'ordine', () => {
    const src = `
      export const POST = withRoute('x:POST', async (request) => {
        // Qui sopra mancava \`requireStaff(request)\`: leggeva il corpo a un anonimo.
        const form = await parseMultipart(request)
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
      })
    `
    expect(fuoriOrdine(src).map((s) => s.handler)).toEqual(['POST'])
  })
})

describe('il rilevatore NON segnala le forme corrette', () => {
  it('gate in testa, corpo dopo', () => {
    const src = `
      export const POST = withRoute('x:POST', async (request) => {
        const auth = await requireDocente(request)
        if (auth.response) return auth.response
        const form = await parseMultipart(request)
        if ('response' in form) return form.response
      })
    `
    expect(fuoriOrdine(src)).toEqual([])
  })

  it('handler senza gate: è materia di `gate-coverage`, non di questo lock', () => {
    // Se questo test diventasse rosso, R2 avrebbe iniziato a duplicare l'allowlist di
    // `gate-coverage.test.ts` — due elenchi della stessa decisione, che è il difetto che
    // questo file sorveglia.
    const src = `
      export const POST = withRoute('public/forms/[token]/submit:POST', async (request) => {
        const b = await parseBody(request, schema)
        if ('response' in b) return b.response
      })
    `
    expect(fuoriOrdine(src)).toEqual([])
  })

  it('`NextResponse.json(...)` e `res.json()` non sono letture del corpo della richiesta', () => {
    const src = `
      export const GET = withRoute('x:GET', async (request) => {
        const res = await externalFetch('https://provider/x')
        const corpo = await res.json()
        const auth = await requireStaff(request)
        if (auth.response) return auth.response
        return NextResponse.json({ corpo })
      })
    `
    expect(fuoriOrdine(src)).toEqual([])
  })

  it('R1 · la chiamata nuda dentro un commento non conta (mezzo repo la cita)', () => {
    // `avvisi/upload`, `chat/upload` e `tasks/upload` spiegano il difetto nei commenti,
    // nominando `request.formData()`. Un rilevatore a grep li segnalerebbe tutti e tre.
    const { senzaCommenti } = mascheraSorgente(`
      // \`request.formData()\` LANCIA, e finiva nel \`catch\` qui sotto.
      const formData = await parseMultipart(request);
    `)
    FORMDATA_NUDA.lastIndex = 0
    expect(FORMDATA_NUDA.test(senzaCommenti)).toBe(false)
  })
})
