// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * UN TOKEN MALFORMATO NON È UN GUASTO DEL SERVER (collaudo del 2026-08-02, terza tornata · F2).
 *
 * ─── MISURATO, sul server vivo, prima della correzione ───────────────────────
 *   POST /api/public/forms/non-un-uuid/submit          → HTTP 500 {"error":"Errore interno"}
 *   POST /api/public/forms/<uuid-inesistente>/submit   → HTTP 404  (corretto)
 *
 * ─── LA CAUSA, che era scritta in un COMMENTO ────────────────────────────────
 * Sopra lo schema del token c'era: «Il token pubblico è una stringa opaca (usata su
 * form_models.public_token), NON un uuid» — e da lì `z.string().min(1)`, cioè qualunque cosa.
 * Il commento diceva il falso: nella baseline la colonna è `public_token uuid`, e chi la
 * valorizza è `randomUUID()` in `admin/form-models/publish`. Un token non-uuid arrivava
 * quindi intatto fino a `.eq('public_token', …)`, e Postgres rispondeva `22P02`
 * («invalid input syntax for type uuid»). La route trattava quell'errore per quello che
 * sembrava — un guasto di lettura — e rispondeva 500.
 *
 * È il difetto più insidioso da cercare: nessuna riga di codice è sbagliata, lo è
 * un'affermazione scritta in italiano che nessuno ha più verificato.
 *
 * ─── PERCHÉ 404 E NON 400 ────────────────────────────────────────────────────
 * Perché «malformato» e «inesistente» non devono distinguersi. Il token È la credenziale che
 * apre `/m/{token}`: due risposte diverse dicono a chi prova a indovinare quando ha almeno
 * imbroccato la FORMA giusta, che su uno spazio di ricerca è mezza informazione regalata.
 *
 * ─── E IL RUMORE, che è la seconda metà del difetto ─────────────────────────
 * Ogni richiesta con un token storto lasciava tre righe `error` in `app_log` (il `fetch`
 * strumentato del client Supabase, il `logEvento` «modello-non-letto», l'esito 500 di
 * `withRoute`). Su un endpoint PUBBLICO e anonimo, cioè: chiunque poteva riempire a comando
 * il canale in cui si cercano i guasti veri. Un client che sbaglia non è un incidente nostro.
 *
 * ─── DUE STRADE, UNA REGOLA ──────────────────────────────────────────────────
 * `submit` e `upload` leggono lo STESSO token dalla STESSA colonna. `upload` rispondeva già
 * 404 — ma per caso, non per scelta: buttava via l'`error` di PostgREST (`const { data: model }`)
 * e si ritrovava `model` a `null`. Il che è l'altro difetto: un guasto di lettura vero
 * sarebbe diventato un 404 muto. La regola sta ora in un posto solo
 * (`@/lib/forms/token-pubblico`) e vale per tutte e due, perché una regola valida per due
 * strade applicata a una sola è già stata la causa di tre correzioni in questo ciclo.
 */

const h = vi.hoisted(() => ({
  model: null as Record<string, unknown> | null,
  /** Ogni valore passato a `.eq('public_token', …)`: se il token storto arriva qui, è un bug. */
  tokenInterrogati: [] as unknown[],
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

vi.mock('@/lib/scuole/reali', () => ({
  sediReali: async () => ({ tutte: [{ id: 'sc-1' }], reali: [{ id: 'sc-1' }], error: null }),
}))

/**
 * IL DOPPIO FINTO DEVE MENTIRE COME MENTE POSTGRES, non essere gentile.
 *
 * I test già in casa (`public-forms-submit`, `public-forms-upload`) usavano token come
 * `'tok'` e `'nope'` contro un doppio che risponde `{ data: null }` a qualunque valore: da
 * lì il 404, e da lì la sensazione — falsa — che quel caso fosse coperto. In produzione la
 * colonna è di tipo `uuid` e una stringa storta non produce «nessuna riga»: produce
 * l'ERRORE `22P02`, che è tutt'altro ramo di codice. Un doppio più permissivo del vero
 * rende verdi i test proprio sul caso che si voleva provare.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      let stortoInQuery: string | null = null
      b.select = () => b
      b.eq = (colonna: string, valore: unknown) => {
        if (colonna === 'public_token') {
          h.tokenInterrogati.push(valore)
          if (typeof valore !== 'string' || !UUID_RE.test(valore)) stortoInQuery = String(valore)
        }
        return b
      }
      b.maybeSingle = async () =>
        stortoInQuery === null
          ? { data: h.model, error: null }
          : {
              data: null,
              error: {
                code: '22P02',
                message: `invalid input syntax for type uuid: "${stortoInQuery}"`,
                details: null,
                hint: null,
              },
            }
      b.insert = () => b
      b.single = async () => ({ data: { id: 'sub-1' }, error: null })
      return b
    },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}))

import { POST as SUBMIT } from '@/app/api/public/forms/[token]/submit/route'
import { POST as UPLOAD } from '@/app/api/public/forms/[token]/upload/route'

/** Un uuid ben formato che non corrisponde a nessun modello. */
const UUID_INESISTENTE = '00000000-0000-4000-8000-000000000000'
const STORTI = ['non-un-uuid', 'tok', '../../etc/passwd', "' OR 1=1--", '']

const ctx = (token: string) => ({ params: Promise.resolve({ token }) })

const reqSubmit = () =>
  new Request('http://localhost/api/public/forms/x/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { a: 1 } }),
  })

const reqUpload = () => {
  const fd = new FormData()
  fd.append('file', new File([Buffer.from('x')], 'doc.pdf', { type: 'application/pdf' }))
  return new Request('http://localhost/api/public/forms/x/upload', { method: 'POST', body: fd })
}

type Caso = { nome: string; route: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>; req: () => Request }
const ROTTE: Caso[] = [
  { nome: 'public/forms/[token]/submit', route: SUBMIT as unknown as Caso['route'], req: reqSubmit },
  { nome: 'public/forms/[token]/upload', route: UPLOAD as unknown as Caso['route'], req: reqUpload },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.model = null
  h.tokenInterrogati = []
})

describe.each(ROTTE)('POST /api/$nome · token malformato', ({ route, req }) => {
  it.each(STORTI)('token %o → 404, non 500', async (token) => {
    const res = await route(req(), ctx(token))
    expect(
      res.status,
      'Un token che non ha nemmeno la forma di un uuid è un errore del CLIENTE. Il 500 dice ' +
        '«ho un guasto io» su una richiesta che il server ha capito benissimo.',
    ).toBe(404)
  })

  it('la risposta è IDENTICA a quella di un uuid inesistente', async () => {
    const storto = await route(req(), ctx('non-un-uuid'))
    const inesistente = await route(req(), ctx(UUID_INESISTENTE))
    expect(storto.status).toBe(inesistente.status)
    expect(
      await storto.json(),
      'Se «malformato» e «inesistente» si distinguono, chi prova a indovinare il token sa ' +
        "quando ha imbroccato almeno la forma giusta. Il token È la credenziale del link.",
    ).toEqual(await inesistente.json())
  })

  it('il token storto non arriva mai alla query (è lì che Postgres esplodeva)', async () => {
    await route(req(), ctx('non-un-uuid'))
    expect(
      h.tokenInterrogati,
      'La colonna `public_token` è di tipo `uuid`: qualunque stringa non-uuid che la ' +
        'raggiunge fa rispondere a Postgres `22P02`. Il filtro sta PRIMA della query, non ' +
        'nella gestione del suo errore.',
    ).toEqual([])
  })

  it('non lascia righe `error` nei log: un endpoint pubblico non si fa riempire il canale', async () => {
    await route(req(), ctx('non-un-uuid'))
    expect(h.logErrore).not.toHaveBeenCalled()
    const errori = h.logEvento.mock.calls.filter((c) => c[1] === 'error')
    expect(
      errori,
      'Prima della correzione ogni richiesta con un token storto scriveva tre righe `error`. ' +
        'Su una porta anonima significa: chiunque può riempire a comando il canale in cui si ' +
        'cercano i guasti veri.',
    ).toEqual([])
  })

  it('il `codice` del 404 si RISOLVE davvero in una frase tradotta', async () => {
    // NON basta che un `codice` ci sia — ed è una lezione pagata scrivendolo sbagliato qui
    // il 2026-08-02: la prima stesura mandava sul filo `erroreModuloNonTrovato`, cioè la
    // chiave di CATALOGO, mentre `testoDelCodice` fa `CODICI_ERRORE[codice]` e si aspetta
    // la CHIAVE (`MODULO_NON_TROVATO`). Il lock `errori-con-codice` era verde — verifica la
    // presenza del campo, non che porti a qualcosa — e a schermo un utente inglese avrebbe
    // riletto l'italiano, col difetto che sembrava chiuso. Qui si passa dalla funzione vera.
    const { messaggioErrore } = await import('@/lib/ui/esito-fetch')
    const res = await route(req(), ctx('non-un-uuid'))
    const testo = await messaggioErrore(res, 'FALLBACK')
    expect(testo).not.toBe('FALLBACK')
    expect(
      testo,
      'Il codice non si risolve: il client ricade sulla prosa italiana del server, che è ' +
        'esattamente ciò che i codici esistono per evitare.',
    ).not.toBe('Modulo non trovato o non pubblicato')
  })

  it('un token BEN formato continua a passare (controllo positivo)', async () => {
    // Senza questo, «404 sempre» supererebbe ogni prova qui sopra — cioè il modo più
    // silenzioso di rompere per intero la modulistica pubblica.
    h.model = {
      id: 'm-1', published_at: '2026-06-26T00:00:00Z', access_mode: 'public', scuola_id: 'sc-1',
      schema: { version: '1.0', pages: [] },
    }
    const res = await route(req(), ctx(UUID_INESISTENTE))
    expect(res.status).not.toBe(404)
    expect(h.tokenInterrogati).toEqual([UUID_INESISTENTE])
  })
})
