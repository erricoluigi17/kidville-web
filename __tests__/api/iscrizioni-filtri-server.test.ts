import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// I FILTRI DI «MODULI RICEVUTI» VIVONO SUL SERVER — 533 domande in produzione
// (misurate il 2026-09-01), elenco paginato a 50.
//
// ─── LA RICERCA `q` È IL PUNTO DELICATO ─────────────────────────────────────
//
// Il nome del bambino vive dentro `data` jsonb, e l'elenco quel campo non lo
// restituisce più (`riassunto`). Che PostgREST accetti un percorso JSON dentro
// un filtro non è stato dato per buono: è stato MISURATO contro il database di
// produzione il 2026-09-01, via HTTP, con tre controlli.
//
//   A  ?data->children->0->>cognome=ilike.*ross*                 → 200
//   B  ?or=(data->children->0->>cognome.ilike.*ross*, …)         → 200
//   C  la stessa B con una parentesi in meno (controllo negativo) → 400 PGRST100
//      «failed to parse logic tree»
//   D  ?or=(dataXYZ->children->0->>cognome.ilike.*ross*)          → 400 42703
//      «column enrollment_submissions.dataXYZ does not exist»
//
// C e D sono la parte che conta: senza, un 200 direbbe soltanto che PostgREST
// non si è lamentato. C prova che il filtro viene PARSATO davvero, D che il
// percorso viene COMPILATO contro la colonna vera invece di essere ignorato.
//
// ─── PERCHÉ PIÙ DI UN INDICE ────────────────────────────────────────────────
//
// Misurato in SQL sulle 533 domande vere: 464 hanno un figlio, 63 ne hanno due,
// 6 ne hanno tre. Cercando «ia» sul solo `children->0` uscivano 160 domande;
// cercando su TUTTI i figli, 169. Nove famiglie perse — quelle in cui il nome
// cercato è del secondo o del terzo bambino — e nessun modo di accorgersene.
// =============================================================================

const SEDE = '11111111-1111-4111-8111-111111111111'
const ALTRA_SEDE = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  righe: [] as Record<string, unknown>[],
  ors: [] as string[],
  /** Le query di solo conteggio (`head: true`) che la route ha eseguito. */
  conteggi: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/auth/parent-identity', () => ({ ensureParentIdentity: vi.fn() }))
vi.mock('@/lib/anagrafiche/legami', () => ({ sincronizzaLegamiRuntime: async () => ({ creati: 0 }) }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, error: null }),
  credentialsEmailBody: () => 'corpo',
}))
vi.mock('@/lib/scuole/reali', () => ({ nomeSede: async () => 'Kidville Alfa' }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => [SEDE, ALTRA_SEDE],
}))

/**
 * Un finto PostgREST che sa leggere i PERCORSI JSON come li scrive la route
 * (`data->children->0->>cognome`): senza, il test proverebbe che la route
 * compone una stringa, non che quella stringa seleziona le righe giuste.
 */
function valoreAlPercorso(riga: Record<string, unknown>, percorso: string): unknown {
  //  `a->b->0->>c`  →  ['a','b','0','c']
  const pezzi = percorso.split(/->>?/).map((p) => p.trim()).filter((p) => p !== '')
  let corrente: unknown = riga
  for (const pezzo of pezzi) {
    if (corrente === null || corrente === undefined) return undefined
    if (Array.isArray(corrente)) corrente = corrente[Number(pezzo)]
    else if (typeof corrente === 'object') corrente = (corrente as Record<string, unknown>)[pezzo]
    else return undefined
  }
  return corrente
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(tabella: string) {
      const condizioni: ((r: Record<string, unknown>) => boolean)[] = []
      let contaEsatto = false
      let soloConteggio = false
      let colonne: string[] = []
      let da = 0
      let a = Number.POSITIVE_INFINITY
      const b: Record<string, unknown> = {}
      const testo = (v: unknown) => (typeof v === 'string' ? v : '')

      b.select = (c?: string, opts?: unknown) => {
        const o = opts as { count?: string; head?: boolean } | undefined
        if (o?.count === 'exact') contaEsatto = true
        if (o?.head === true) { soloConteggio = true; h.conteggi++ }
        colonne = (c ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '')
        return b
      }
      b.eq = (col: string, val: unknown) => { condizioni.push((r) => r[col] === val); return b }
      b.in = (col: string, vals: unknown[]) => { condizioni.push((r) => vals.includes(r[col])); return b }
      b.gte = (col: string, val: string) => { condizioni.push((r) => testo(r[col]) !== '' && testo(r[col]) >= val); return b }
      b.lte = (col: string, val: string) => { condizioni.push((r) => testo(r[col]) !== '' && testo(r[col]) <= val); return b }
      b.ilike = (col: string, pattern: string) => {
        const nucleo = pattern.replace(/^%|%$/g, '').toLowerCase()
        condizioni.push((r) => testo(r[col]).toLowerCase().includes(nucleo))
        return b
      }
      b.contains = () => b
      b.limit = () => b
      b.or = (espressione: string) => {
        h.ors.push(espressione)
        const pezzi = espressione.split(',').map((p) => {
          const m = /^(.+?)\.ilike\.%(.*)%$/.exec(p)
          return m ? { percorso: m[1], nucleo: m[2].toLowerCase() } : null
        })
        condizioni.push((r) =>
          pezzi.some((p) => {
            if (p === null) return false
            const v = valoreAlPercorso(r, p.percorso)
            return typeof v === 'string' && v.toLowerCase().includes(p.nucleo)
          }),
        )
        return b
      }
      b.order = () => b
      b.range = (x: number, y: number) => { da = x; a = y; return b }

      const filtrate = () =>
        tabella === 'enrollment_submissions' ? h.righe.filter((r) => condizioni.every((c) => c(r))) : []
      const proietta = (r: Record<string, unknown>) => {
        if (colonne.length === 0) return r
        const fuori: Record<string, unknown> = {}
        for (const c of colonne) if (c in r) fuori[c] = r[c]
        return fuori
      }
      const lista = () => {
        const righe = filtrate()
        const fine = Number.isFinite(a) ? a + 1 : righe.length
        return {
          // `head: true` ⇒ nessuna riga, solo il conteggio. Come PostgREST.
          data: soloConteggio ? null : righe.slice(da, fine).map(proietta),
          error: null,
          count: contaEsatto ? righe.length : null,
        }
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(lista()).then(res)
      b.maybeSingle = async () => ({ data: filtrate()[0] ?? null, error: null })
      b.single = async () => ({ data: null, error: null })
      b.insert = () => ({ select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) })
      b.update = () => ({ eq: async () => ({ data: null, error: null }) })
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/iscrizioni/route'

const chiedi = (qs = '') =>
  GET(new Request(`http://localhost/api/admin/iscrizioni${qs}`) as never)

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

interface Finta {
  i: number
  sede?: string
  stato?: string
  creata?: string
  figli?: { nome: string; cognome: string }[]
}

function domanda(f: Finta): Record<string, unknown> {
  return {
    id: uuid(f.i),
    scuola_id: f.sede ?? SEDE,
    status: f.stato ?? 'pending',
    assigned_classes: null,
    created_at: f.creata ?? '2026-08-20T10:00:00.000Z',
    data: {
      children: f.figli ?? [{ nome: `Bimbo${f.i}`, cognome: `Rossi${f.i}` }],
      adults: [{ first_name: 'Anna', last_name: 'Rossi' }],
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.righe = []
  h.ors = []
  h.conteggi = 0
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
})

async function elenco(qs: string) {
  const res = await chiedi(qs)
  const json = (await res.json()) as {
    data?: Record<string, unknown>[]
    total?: number
    totaleLinguetta?: number
    conteggi?: Record<string, number>
  }
  return { res, json }
}

describe('GET /api/admin/iscrizioni — la ricerca entra dentro `data` jsonb', () => {
  it('trova il cognome del PRIMO bambino', async () => {
    h.righe = [
      domanda({ i: 1, figli: [{ nome: 'Sofia', cognome: 'Esposito' }] }),
      domanda({ i: 2, figli: [{ nome: 'Marco', cognome: 'Russo' }] }),
    ]
    const { json } = await elenco('?q=esposito')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
    expect(json.total).toBe(1)
  })

  it('🔴 trova anche il SECONDO e il TERZO figlio: 63 domande su 533 ne hanno più di uno', async () => {
    h.righe = [
      domanda({
        i: 1,
        figli: [
          { nome: 'Sofia', cognome: 'Esposito' },
          { nome: 'Giulia', cognome: 'Esposito' },
        ],
      }),
      domanda({
        i: 2,
        figli: [
          { nome: 'Marco', cognome: 'Russo' },
          { nome: 'Luca', cognome: 'Russo' },
          { nome: 'Chiara', cognome: 'Russo' },
        ],
      }),
    ]
    // Il nome del SECONDO figlio.
    expect((await elenco('?q=giulia')).json.data?.map((r) => r.id)).toEqual([uuid(1)])
    // …e del TERZO.
    expect((await elenco('?q=chiara')).json.data?.map((r) => r.id)).toEqual([uuid(2)])
  })

  it('il filtro parte come percorso JSON su `data`, e cerca sia il nome sia il cognome', async () => {
    h.righe = [domanda({ i: 1 })]
    await elenco('?q=rossi')
    // Quattro `.or()` identici: l'elenco e i tre conteggi cercano la STESSA
    // cosa. Riquadri che descrivono un insieme diverso da quello della lista
    // sarebbero il difetto di partenza con un vestito nuovo.
    expect(h.ors).toHaveLength(4)
    expect(new Set(h.ors).size).toBe(1)
    const espressione = h.ors[0]
    // Il percorso è quello misurato contro il database vero.
    expect(espressione).toContain('data->children->0->>nome.ilike.%rossi%')
    expect(espressione).toContain('data->children->0->>cognome.ilike.%rossi%')
    // Più di un indice: la misura dice che il massimo dei figli è 3.
    expect(espressione).toContain('data->children->2->>cognome.ilike.%rossi%')
  })

  it('una ricerca che si svuota dopo la sanificazione NON diventa un `.or()`', async () => {
    h.righe = [domanda({ i: 1 }), domanda({ i: 2 })]
    const { json } = await elenco('?q=%25%2C()')
    expect(h.ors).toHaveLength(0)
    expect(json.data).toHaveLength(2)
  })

  it('il payload resta fuori: si cerca dentro `data`, non lo si restituisce', async () => {
    h.righe = [domanda({ i: 1, figli: [{ nome: 'Sofia', cognome: 'Esposito' }] })]
    const corpo = await (await chiedi('?q=sofia')).text()
    // Il nome del primo bambino esce nel `riassunto` — è come si riconosce una
    // riga — ma la chiave `data` no: lì dentro ci sono allergie e note mediche.
    expect(corpo).toContain('riassunto')
    expect(corpo).not.toContain('"data":{')
  })
})

describe('GET /api/admin/iscrizioni — stato, sede, periodo', () => {
  it('`?stato=approved` e «solo da lavorare» filtrano lo stato della domanda', async () => {
    h.righe = [
      domanda({ i: 1, stato: 'pending' }),
      domanda({ i: 2, stato: 'approved' }),
      domanda({ i: 3, stato: 'rejected' }),
    ]
    expect((await elenco('?stato=approved')).json.data?.map((r) => r.id)).toEqual([uuid(2)])
    expect((await elenco('?daLavorare=1')).json.data?.map((r) => r.id)).toEqual([uuid(1)])
  })

  it('`?scuola_id=` restringe; una sede non accessibile è 403', async () => {
    h.righe = [domanda({ i: 1, sede: SEDE }), domanda({ i: 2, sede: ALTRA_SEDE })]
    expect((await elenco(`?scuola_id=${ALTRA_SEDE}`)).json.data?.map((r) => r.id)).toEqual([uuid(2)])

    const res = await chiedi('?scuola_id=33333333-3333-4333-8333-333333333333')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { codice?: string }).codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  it('il periodo su `created_at` si misura sul giorno civile italiano', async () => {
    h.righe = [
      domanda({ i: 1, creata: '2026-08-31T23:00:00.000Z' }), // 1/9 all'01:00 a Roma
      domanda({ i: 2, creata: '2026-08-31T21:00:00.000Z' }), // 31/8 alle 23:00 a Roma
      domanda({ i: 3, creata: '2026-09-01T21:59:00.000Z' }), // 1/9 alle 23:59 a Roma
    ]
    const { json } = await elenco('?creatoDa=2026-09-01&creatoA=2026-09-01')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1), uuid(3)])
  })
})

describe('GET /api/admin/iscrizioni — i tre riquadri contano sul DATABASE', () => {
  it('`conteggi` esce dal conteggio esatto, non dalle righe caricate', async () => {
    h.righe = [
      ...Array.from({ length: 40 }, (_, i) => domanda({ i, stato: 'pending' })),
      ...Array.from({ length: 30 }, (_, i) => domanda({ i: 100 + i, stato: 'approved' })),
      ...Array.from({ length: 12 }, (_, i) => domanda({ i: 200 + i, stato: 'rejected' })),
    ]
    // Una pagina sola da 10 righe: i riquadri devono comunque dire la verità
    // sulle 82. Prima contavano le righe CARICATE, cioè 10.
    const { json } = await elenco('?limit=10&offset=0')
    expect(json.data).toHaveLength(10)
    expect(json.total).toBe(82)
    expect(json.conteggi).toEqual({ pending: 40, approved: 30, rejected: 12 })
    // I conteggi si chiedono in sola TESTA: nessuna riga, nessun payload. Sono
    // QUATTRO: i tre stati più il totale della LINGUETTA senza filtri, che è ciò
    // che distingue «non è arrivata nessuna domanda» da «nessun risultato con
    // questi filtri» quando l'elenco esce vuoto.
    expect(h.conteggi).toBe(4)
  })

  it('con un filtro attivo i riquadri descrivono l\'insieme FILTRATO', async () => {
    h.righe = [
      domanda({ i: 1, stato: 'pending', sede: SEDE }),
      domanda({ i: 2, stato: 'approved', sede: SEDE }),
      domanda({ i: 3, stato: 'approved', sede: ALTRA_SEDE }),
    ]
    const { json } = await elenco(`?scuola_id=${SEDE}`)
    expect(json.conteggi).toEqual({ pending: 1, approved: 1, rejected: 0 })
    expect(json.total).toBe(2)
  })

  it('`totaleLinguetta` è il totale SENZA filtri: distingue «vuoto» da «nessun risultato»', async () => {
    h.righe = [
      domanda({ i: 1, stato: 'pending' }),
      domanda({ i: 2, stato: 'approved' }),
      domanda({ i: 3, stato: 'rejected' }),
    ]
    const { json } = await elenco('?stato=approved')
    // Filtrato: una sola. Ma la linguetta ne ha tre, e senza questo numero la
    // schermata non potrebbe distinguere «non è arrivata nessuna domanda» da
    // «nessun risultato con questi filtri» — due frasi con due rimedi opposti.
    expect(json.total).toBe(1)
    expect(json.totaleLinguetta).toBe(3)
  })

  it('il DETTAGLIO non paga i tre conteggi: si chiedono solo per l\'elenco', async () => {
    h.righe = [domanda({ i: 5 })]
    await chiedi(`?id=${uuid(5)}`)
    expect(h.conteggi).toBe(0)
  })
})
