import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/chat/messages LEGGE LA CODA DELLA CONVERSAZIONE, E PAGINA ALL'INDIETRO (C2, 2026-09-14).
 *
 * ─── IL DIFETTO ──────────────────────────────────────────────────────────────
 *
 * La route ordinava dal più VECCHIO e si fermava a 50: di ogni conversazione arrivavano i 50
 * messaggi più vecchi. Misurato in produzione il 2026-09-14: 7 thread oltre i 50 messaggi (il più
 * lungo 68), 48 messaggi mai mostrati a nessuno, 45 dei quali mai letti. Chi apriva la chat vedeva
 * arrivare la notifica e poi, nella conversazione, niente.
 *
 * ─── PERCHÉ UN FAKE CHE APPLICA DAVVERO FILTRI, ORDINI E RANGE ──────────────
 *
 * Un fake che ignora l'ordine «misura sé stesso» (vedi `chat-allegati-firmati.test.ts`): la
 * route rovescia la pagina, e con un ordine ignorato il rovescio sembra un difetto o lo nasconde.
 * Qui il database finto fa ciò che fa Postgres: `eq`, più `order` in sequenza, `range` inclusivo,
 * `count` sulle righe filtrate. E dell'`.or()` del cursore accetta UNA forma sola, quella che
 * PostgREST capisce — `created_at.lt."<istante>",and(created_at.eq."<istante>",id.lt.<uuid>)` —
 * rifiutando tutto il resto: la sintassi vera la prova solo l'E2E in CI
 * (`e2e/chat-precedenti.spec.ts`), ma una forma diversa da quella scelta qui diventa rossa subito.
 *
 * Nessun dato reale: uuid sintetici e testi finti.
 */

const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const OUTSIDER = 'cccccccc-0000-4000-8000-000000000003'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const THREAD_ALTRO = 'dddddddd-0000-4000-8000-000000000005'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  marcaConsegnati: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  /** Le righe delle due tabelle. */
  threads: [] as Array<Record<string, unknown>>,
  messaggi: [] as Array<Record<string, unknown>>,
  /** Le letture della LISTA (i `range` su chat_messages): servono a dire «non si è letto niente». */
  letture: 0,
  /** Le letture di UN messaggio (i `maybeSingle` su chat_messages): la risoluzione del cursore. */
  lettureCursore: 0,
  /** Gli UPDATE di mark-read eseguiti. */
  markRead: [] as Array<Record<string, unknown>>,
  /** Le chiamate a `createSignedUrls`, una per richiesta. */
  firme: [] as string[][],
  /** Le espressioni `.or()` che il fake non ha riconosciuto. */
  orRifiutati: [] as string[],
  /** Un guasto del database sulla lettura del cursore. */
  erroreCursore: null as null | { message: string; code: string },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: h.marcaConsegnati }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(), nomeUtente: vi.fn() }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))

/* ── L'istante come lo ordina Postgres: al microsecondo ─────────────────────── */

function istante(valore: unknown): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(String(valore))
  if (!m) throw new Error(`istante illeggibile nel fake: ${String(valore)}`)
  const secondi = Date.parse(`${m[1]}${m[3]}`)
  const micro = Number((m[2] ?? '').slice(0, 6).padEnd(6, '0'))
  return secondi * 1000 + micro
}

function confronta(colonna: string, a: Riga, b: Riga): number {
  if (colonna === 'created_at') return istante(a[colonna]) - istante(b[colonna])
  const x = String(a[colonna])
  const y = String(b[colonna])
  return x === y ? 0 : x < y ? -1 : 1
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const FORMA_KEYSET = new RegExp(`^created_at\\.lt\\."([^"]+)",and\\(created_at\\.eq\\."([^"]+)",id\\.lt\\.(${UUID})\\)$`)

/** L'unica forma di `.or()` che il fake accetta: il keyset su (created_at, id). */
function filtroKeyset(espressione: string): (r: Riga) => boolean {
  const m = FORMA_KEYSET.exec(espressione)
  if (!m || m[1] !== m[2]) {
    h.orRifiutati.push(espressione)
    throw new Error(`.or() in una forma che il fake non riconosce: ${espressione}`)
  }
  const soglia = istante(m[1])
  const id = m[3]
  return (r) => istante(r.created_at) < soglia || (istante(r.created_at) === soglia && String(r.id) < id)
}

/* ── Il client Supabase finto ───────────────────────────────────────────────── */

function tabella(nome: string): Riga[] {
  if (nome === 'chat_threads') return h.threads
  if (nome === 'chat_messages') return h.messaggi
  return []
}

const adminClient = {
  storage: {
    from: () => ({
      createSignedUrls: async (percorsi: string[]) => {
        h.firme.push([...percorsi])
        return { data: percorsi.map((p) => ({ path: p, signedUrl: `https://storage.example/sign/${p}?token=T`, error: null })), error: null }
      },
    }),
  },
  from(nome: string) {
    const st = {
      filtri: [] as Array<(r: Riga) => boolean>,
      ordini: [] as string[],
      conta: false,
      colonne: '*',
      patch: null as Riga | null,
    }
    const b: Record<string, unknown> = {}
    b.select = (colonne = '*', opz?: { count?: string }) => {
      st.colonne = colonne
      st.conta = opz?.count === 'exact'
      return b
    }
    b.eq = (c: string, v: unknown) => { st.filtri.push((r) => r[c] === v); return b }
    b.neq = (c: string, v: unknown) => { st.filtri.push((r) => r[c] !== v); return b }
    b.is = (c: string, v: unknown) => { st.filtri.push((r) => (r[c] ?? null) === v); return b }
    b.or = (espressione: string) => { st.filtri.push(filtroKeyset(espressione)); return b }
    b.order = (c: string, opz?: { ascending?: boolean }) => {
      // Stesso segno di postgrest-js: senza `ascending` l'ordine è crescente.
      st.ordini.push(`${c}.${opz?.ascending === false ? 'desc' : 'asc'}`)
      return b
    }
    const filtrate = () => tabella(nome).filter((r) => st.filtri.every((f) => f(r)))
    const proietta = (r: Riga): Riga => {
      if (st.colonne === '*') return { ...r }
      return Object.fromEntries(st.colonne.split(',').map((c) => c.trim()).map((c) => [c, r[c]]))
    }
    b.range = async (da: number, a: number) => {
      if (nome === 'chat_messages') h.letture++
      const righe = filtrate()
      // Ordinamento STABILE per chiavi successive, come ORDER BY c1, c2.
      const ordinate = righe
        .map((r, i) => ({ r, i }))
        .sort((x, y) => {
          for (const o of st.ordini) {
            const [colonna, verso] = o.split('.')
            const d = confronta(colonna, x.r, y.r)
            if (d !== 0) return verso === 'desc' ? -d : d
          }
          return x.i - y.i
        })
        .map((x) => x.r)
      return { data: ordinate.slice(da, a + 1).map(proietta), count: st.conta ? righe.length : null, error: null }
    }
    b.maybeSingle = async () => {
      if (nome === 'chat_messages') h.lettureCursore++
      if (nome === 'chat_messages' && h.erroreCursore) return { data: null, error: h.erroreCursore }
      const [prima] = filtrate()
      return { data: prima ? proietta(prima) : null, error: null }
    }
    b.update = (patch: Riga) => { st.patch = patch; return b }
    b.then = (risolvi: (v: unknown) => unknown, rifiuta?: (e: unknown) => unknown) => {
      if (st.patch && nome === 'chat_messages') h.markRead.push({ ...st.patch, n: filtrate().length })
      return Promise.resolve({ data: null, error: null }).then(risolvi, rifiuta)
    }
    return b
  },
}

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => adminClient,
}))

import { GET } from '@/app/api/chat/messages/route'

/* ── Dati ──────────────────────────────────────────────────────────────────── */

const idMsg = (n: number) => `eeeeeeee-0000-4000-8000-00000000${String(n).padStart(4, '0')}`
const numero = (id: string) => Number(id.slice(-4))

/**
 * Sessanta messaggi, un minuto l'uno dall'altro. Il #10 e l'#11 hanno lo STESSO istante: il
 * confine fra la coda (ultimi 50) e la pagina precedente cade proprio sul pareggio, ed è lì che
 * senza lo spareggio sull'id un messaggio si perde o si ripete.
 *
 * Le righe stanno in tabella in ordine d'inserimento: senza `order('id')` l'ordinamento stabile le
 * lascerebbe così, cioè col #10 prima dell'#11 anche in ordine decrescente.
 */
function seminaSessanta(extra: (n: number) => Riga = () => ({})) {
  h.messaggi = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1
    const minuto = n >= 11 ? n - 1 : n
    const hh = String(8 + Math.floor(minuto / 60)).padStart(2, '0')
    const mm = String(minuto % 60).padStart(2, '0')
    return {
      id: idMsg(n),
      thread_id: THREAD,
      sender_id: n % 2 ? TEACHER : PARENT,
      content: `Messaggio finto ${n}`,
      attachment_url: null,
      attachment_type: null,
      read_at: null,
      // La forma di PostgREST: microsecondi senza zeri finali, e il fuso con i due punti.
      created_at: `2026-09-01T${hh}:${mm}:07.12345+00:00`,
      ...extra(n),
    }
  })
  expect(h.messaggi[9].created_at, 'il pareggio sul confine è il cuore della prova').toBe(h.messaggi[10].created_at)
}

const richiesta = (qs: string) => new Request(`http://localhost/api/chat/messages?${qs}`)

async function leggi(qs: string) {
  const res = await GET(richiesta(qs))
  return { stato: res.status, corpo: (await res.json()) as Record<string, unknown> }
}

const ids = (corpo: Record<string, unknown>) => (corpo.messages as Array<{ id: string }>).map((m) => numero(m.id))
const daA = (da: number, a: number) => Array.from({ length: a - da + 1 }, (_, i) => da + i)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore' } })
  h.marcaConsegnati.mockResolvedValue(undefined)
  h.threads = [
    { id: THREAD, teacher_id: TEACHER, parent_id: PARENT },
    { id: THREAD_ALTRO, teacher_id: TEACHER, parent_id: PARENT },
  ]
  h.messaggi = []
  h.letture = 0
  h.lettureCursore = 0
  h.markRead = []
  h.firme = []
  h.orRifiutati = []
  h.erroreCursore = null
})

describe('GET /api/chat/messages — la coda della conversazione (C2)', () => {
  it('senza cursore restituisce gli ULTIMI 50, dal più vecchio al più nuovo, e dice quanti ne restano prima', async () => {
    seminaSessanta()
    const { stato, corpo } = await leggi(`threadId=${THREAD}`)

    expect(stato).toBe(200)
    expect(ids(corpo), 'la conversazione si apre sui messaggi più vecchi: gli ultimi non si vedono').toEqual(daA(11, 60))
    expect(corpo.total).toBe(60)
    expect(corpo.precedenti).toBe(10)
    expect(h.orRifiutati).toEqual([])
  })

  it('con primaDi restituisce la pagina prima di quel messaggio, e le due pagine insieme sono il thread intero', async () => {
    seminaSessanta()
    const coda = await leggi(`threadId=${THREAD}`)
    const pagina = await leggi(`threadId=${THREAD}&primaDi=${idMsg(11)}`)

    expect(pagina.stato).toBe(200)
    expect(ids(pagina.corpo)).toEqual(daA(1, 10))
    expect(pagina.corpo.total).toBe(10)
    expect(pagina.corpo.precedenti).toBe(0)
    const tutti = [...ids(pagina.corpo), ...ids(coda.corpo)]
    expect(tutti, 'fra le due pagine un messaggio manca o si ripete').toEqual(daA(1, 60))
    expect(h.orRifiutati).toEqual([])
  })

  it('lo spareggio sull’id tiene il confine: #10 e #11 hanno lo stesso istante e nessuno dei due si perde', async () => {
    seminaSessanta()
    const coda = await leggi(`threadId=${THREAD}`)
    expect(ids(coda.corpo)).toContain(11)
    expect(ids(coda.corpo)).not.toContain(10)

    // Il cursore DENTRO il pareggio: prima dell'#11 viene il #10, che ha il suo stesso istante.
    const uno = await leggi(`threadId=${THREAD}&primaDi=${idMsg(11)}&limit=1`)
    expect(ids(uno.corpo), 'il messaggio con lo stesso istante del cursore è sparito').toEqual([10])
    expect(uno.corpo.precedenti).toBe(9)

    // Il cursore DOPO il pareggio: la pagina lo contiene per intero, nell'ordine di Postgres.
    const due = await leggi(`threadId=${THREAD}&primaDi=${idMsg(12)}&limit=2`)
    expect(ids(due.corpo)).toEqual([10, 11])
    expect(h.orRifiutati).toEqual([])
  })

  it('un cursore di un ALTRO thread è un 400 su primaDi: niente lista e niente mark-read, nemmeno con markRead', async () => {
    seminaSessanta()
    h.messaggi.push({
      id: 'ffffffff-0000-4000-8000-000000000099',
      thread_id: THREAD_ALTRO,
      sender_id: TEACHER,
      content: 'Messaggio di un altro thread',
      attachment_url: null,
      attachment_type: null,
      read_at: null,
      created_at: '2026-09-02T08:00:07.5+00:00',
    })

    const { stato, corpo } = await leggi(`threadId=${THREAD}&primaDi=ffffffff-0000-4000-8000-000000000099&markRead=${PARENT}`)

    expect(stato, 'un id di un altro thread è stato usato come cursore').toBe(400)
    expect((corpo.details as Array<{ path: string }>)[0].path).toBe('primaDi')
    expect(h.letture, 'con un cursore rifiutato si è letta comunque la lista').toBe(0)
    expect(h.markRead, 'una richiesta respinta ha segnato letti dei messaggi').toEqual([])
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('un cursore che non esiste (o senza istante) è lo stesso 400: nessun oracolo', async () => {
    seminaSessanta((n) => (n === 30 ? { created_at: null } : {}))
    // Il #30 senza istante non si ordina: la pagina «prima di lui» non ha un significato.
    const senzaIstante = await leggi(`threadId=${THREAD}&primaDi=${idMsg(30)}`)
    const inesistente = await leggi(`threadId=${THREAD}&primaDi=ffffffff-0000-4000-8000-0000000000aa`)

    expect(senzaIstante.stato).toBe(400)
    expect(inesistente.stato).toBe(400)
    expect(inesistente.corpo).toEqual(senzaIstante.corpo)
  })

  it('primaDi che non è un uuid, e offset (non più supportato), sono 400 col loro path', async () => {
    seminaSessanta()
    const malformato = await leggi(`threadId=${THREAD}&primaDi=non-un-uuid`)
    const offset = await leggi(`threadId=${THREAD}&offset=0`)

    expect(malformato.stato).toBe(400)
    expect((malformato.corpo.details as Array<{ path: string }>)[0].path).toBe('primaDi')
    expect(offset.stato, '`offset` accettato in silenzio: conterebbe dalla coda invece che dalla testa').toBe(400)
    expect((offset.corpo.details as Array<{ path: string }>)[0].path).toBe('offset')
    expect(h.letture).toBe(0)
  })

  it('un guasto del database leggendo il cursore: 500 con LETTURA_FALLITA, il guasto nel log, niente mark-read', async () => {
    seminaSessanta()
    h.erroreCursore = { message: 'connection reset by peer', code: '08006' }

    const { stato, corpo } = await leggi(`threadId=${THREAD}&primaDi=${idMsg(11)}&markRead=${PARENT}`)

    expect(stato).toBe(500)
    expect(corpo.codice).toBe('LETTURA_FALLITA')
    expect(JSON.stringify(corpo), 'il messaggio di PostgREST è tornato al client').not.toContain('connection reset')
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ operazione: 'chat/messages:GET', stato: 500 }), h.erroreCursore)
    expect(h.markRead).toEqual([])
    expect(h.letture).toBe(0)
  })

  it('la firma degli allegati è per PAGINA: una chiamata allo Storage con i soli percorsi di quella pagina', async () => {
    const percorso = (n: number) => `${TEACHER}/allegato-${n}.png`
    seminaSessanta((n) => (n === 5 || n === 55 ? { attachment_url: percorso(n), attachment_type: 'image' } : {}))

    const coda = await leggi(`threadId=${THREAD}`)
    expect(h.firme).toEqual([[percorso(55)]])
    const conAllegato = (coda.corpo.messages as Array<{ id: string; attachment_url: string | null }>).find((m) => numero(m.id) === 55)
    expect(conAllegato?.attachment_url).toContain('token=')

    await leggi(`threadId=${THREAD}&primaDi=${idMsg(11)}`)
    expect(h.firme).toEqual([[percorso(55)], [percorso(5)]])
  })

  it('il successo di una pagina precedente lascia UNA riga di log; la finestra normale (polling) no', async () => {
    seminaSessanta()
    await leggi(`threadId=${THREAD}`)
    const riga = (c: unknown[]) => c[0] === 'chat' && (c[2] as { esito?: string })?.esito === 'precedenti-caricati'
    expect(h.logEvento.mock.calls.filter(riga), 'ogni polling scriverebbe una riga').toHaveLength(0)

    await leggi(`threadId=${THREAD}&primaDi=${idMsg(11)}`)
    const righe = h.logEvento.mock.calls.filter(riga)
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('info')
    expect(righe[0][2]).toMatchObject({ operazione: 'chat/messages:GET', esito: 'precedenti-caricati' })
    expect(JSON.stringify(righe[0]), 'nel log è finito il testo di un messaggio').not.toContain('Messaggio finto')
  })

  it('presidio: il cursore si legge DOPO il controllo di partecipazione (un estraneo prende 403 senza toccare i messaggi)', async () => {
    seminaSessanta()
    h.requireUser.mockResolvedValue({ user: { id: OUTSIDER, role: 'genitore' } })

    const { stato } = await leggi(`threadId=${THREAD}&primaDi=${idMsg(11)}`)

    expect(stato).toBe(403)
    expect(h.lettureCursore, 'il cursore si è letto prima di sapere se chi chiede partecipa al thread').toBe(0)
    expect(h.letture).toBe(0)
  })
})
