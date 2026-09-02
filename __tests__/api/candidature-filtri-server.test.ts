import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// I FILTRI DELLE CANDIDATURE VIVONO SUL SERVER, E NON POSSONO MENTIRE.
//
// 392 candidature in produzione (misurate il 2026-09-01), elenco paginato a 50:
// un filtro applicato nel browser scriverebbe «3 risultati» mentre 342 righe mai
// caricate corrispondono al criterio. Qui il finto PostgREST APPLICA DAVVERO i
// filtri — non li registra e basta — così togliere un filtro dalla route rende
// rosso un test invece di lasciarlo verde con meno righe.
//
// ⚠️ IL TEST CHE CONTA PIÙ DI TUTTI è quello sullo `stato`: dal 2026-08-19 ogni
// plesso valuta la stessa candidatura per conto suo, e la riga d'elenco mostra
// `statoDiRiga()`, cioè lo stato DELLA PROPRIA SEDE. Un filtro sulla colonna
// aggregata `candidature_insegnanti.stato` farebbe sparire righe il cui badge
// dice il contrario — o peggio, ne farebbe comparire con il badge sbagliato.
// =============================================================================

const SEDE = '11111111-1111-4111-8111-111111111111'
const ALTRA_SEDE = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  righe: [] as Record<string, unknown>[],
  /** Ogni `.or(...)` osservato: serve a provare che `q` parte verso il database. */
  ors: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/email/send', () => ({ sendEmailDetailed: async () => ({ ok: true, error: null }) }))
vi.mock('@/lib/email/contesto', () => ({ risolviContestoSede: async () => ({}) }))
vi.mock('@/lib/email/messaggi/esito-candidatura', () => ({
  messaggioEsitoCandidatura: () => ({ subject: 's', html: 'h', text: 't' }),
}))
vi.mock('@/lib/auth/scope', async () => {
  const vero = await vi.importActual<typeof import('@/lib/auth/scope')>('@/lib/auth/scope')
  return {
    ...vero,
    // Le due sedi attive: il filtro `?scuola_id=` deve poter RESTRINGERE a una
    // sola, e una sede altrui deve essere rifiutata da `restringiSedi` (vero).
    resolveScuoleAttive: async () => [SEDE, ALTRA_SEDE],
  }
})

/**
 * Un finto PostgREST che filtra per davvero, embed compreso.
 *
 * Le condizioni sull'embed (`candidature_sedi.<col>`) si applicano in AND sulla
 * STESSA riga di sede — che è ciò che fa `!inner` — e non su righe diverse: senza
 * questo, «stato della mia sede» e «una qualunque delle mie sedi è in quello
 * stato» sarebbero indistinguibili, ed è esattamente la differenza che il badge
 * dell'elenco mostra a schermo.
 */
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    from(tabella: string) {
      const condizioniMadre: ((r: Record<string, unknown>) => boolean)[] = []
      const condizioniSede: ((s: Record<string, unknown>) => boolean)[] = []
      let contaEsatto = false
      let da = 0
      let a = Number.POSITIVE_INFINITY
      /**
       * Le colonne CHIESTE. Il finto proietta come il database: senza, un test
       * su «questo campo non deve uscire dall'elenco» resterebbe verde anche
       * mettendo la colonna dentro `COLONNE_ELENCO` — è la lezione di
       * `__tests__/helpers/embed-sede.ts`.
       */
      let colonne: string[] = []
      const b: Record<string, unknown> = {}

      const testo = (v: unknown) => (typeof v === 'string' ? v : '')
      /** Confronto d'ordine: numerico fra numeri, lessicografico fra stringhe. */
      const almeno = (v: unknown, soglia: unknown) => {
        if (v === null || v === undefined) return false
        if (typeof v === 'number' || typeof soglia === 'number') return Number(v) >= Number(soglia)
        return testo(v) !== '' && testo(v) >= String(soglia)
      }
      const alPiu = (v: unknown, soglia: unknown) => {
        if (v === null || v === undefined) return false
        if (typeof v === 'number' || typeof soglia === 'number') return Number(v) <= Number(soglia)
        return testo(v) !== '' && testo(v) <= String(soglia)
      }
      /** `col` che comincia con `candidature_sedi.` è una condizione sull'embed. */
      const registra = (col: string, predicato: (valore: unknown) => boolean) => {
        if (col.startsWith('candidature_sedi.')) {
          const campo = col.slice('candidature_sedi.'.length)
          condizioniSede.push((s) => predicato(s[campo]))
        } else {
          condizioniMadre.push((r) => predicato(r[col]))
        }
      }

      b.select = (c?: string, opts?: unknown) => {
        if ((opts as { count?: string })?.count === 'exact') contaEsatto = true
        colonne = (c ?? '')
          .split(',')
          .map((x) => x.trim())
          // L'embed (`candidature_sedi!inner(...)`) non è una colonna: si tratta a parte.
          .filter((x) => x !== '' && !x.includes('(') && !x.includes(')'))
        return b
      }
      b.eq = (col: string, val: unknown) => { registra(col, (v) => v === val); return b }
      b.in = (col: string, vals: unknown[]) => { registra(col, (v) => vals.includes(v)); return b }
      b.gte = (col: string, val: unknown) => { registra(col, (v) => almeno(v, val)); return b }
      b.lte = (col: string, val: unknown) => { registra(col, (v) => alPiu(v, val)); return b }
      b.ilike = (col: string, pattern: string) => {
        const nucleo = pattern.replace(/^%|%$/g, '').toLowerCase()
        registra(col, (v) => testo(v).toLowerCase().includes(nucleo))
        return b
      }
      b.contains = (col: string, vals: unknown[]) => {
        registra(col, (v) => Array.isArray(v) && vals.every((x) => (v as unknown[]).includes(x)))
        return b
      }
      b.or = (espressione: string) => {
        h.ors.push(espressione)
        // `col.ilike.%term%` separate da virgola: si ricostruisce l'OR vero.
        const pezzi = espressione.split(',').map((p) => {
          const m = /^(.+?)\.ilike\.%(.*)%$/.exec(p)
          return m ? { col: m[1], nucleo: m[2].toLowerCase() } : null
        })
        condizioniMadre.push((r) =>
          pezzi.some((p) => p !== null && testo(r[p.col]).toLowerCase().includes(p.nucleo)),
        )
        return b
      }
      b.order = () => b
      b.range = (x: number, y: number) => { da = x; a = y; return b }

      const passa = (r: Record<string, unknown>) => {
        if (!condizioniMadre.every((c) => c(r))) return false
        const sedi = (r.candidature_sedi ?? []) as Record<string, unknown>[]
        // `!inner`: la riga esce solo se ESISTE una riga di sede che soddisfa
        // TUTTE le condizioni sull'embed.
        return condizioniSede.length === 0 || sedi.some((s) => condizioniSede.every((c) => c(s)))
      }
      const filtrate = () => (tabella === 'candidature_insegnanti' ? h.righe.filter(passa) : [])
      /** Proietta come PostgREST: escono solo le colonne chieste, più l'embed. */
      const proietta = (r: Record<string, unknown>) => {
        if (colonne.length === 0) return r
        const fuori: Record<string, unknown> = {}
        for (const c of colonne) if (c in r) fuori[c] = r[c]
        if (r.candidature_sedi) fuori.candidature_sedi = r.candidature_sedi
        return fuori
      }
      const lista = () => {
        const righe = filtrate()
        const fine = Number.isFinite(a) ? a + 1 : righe.length
        return {
          data: righe.slice(da, fine).map(proietta),
          error: null,
          count: contaEsatto ? righe.length : null,
        }
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(lista()).then(res)
      b.maybeSingle = async () => ({ data: filtrate()[0] ?? null, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/candidature-insegnanti/route'

const chiedi = (qs = '') =>
  GET(new Request(`http://localhost/api/admin/candidature-insegnanti${qs}`) as never)

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

interface Finta {
  i: number
  sede?: string
  statoSede?: string
  statoMadre?: string
  nome?: string
  cognome?: string
  email?: string
  posizioni?: string[]
  gradi?: string[]
  citta?: string
  provincia?: string
  titolo?: string
  esperienza?: number | null
  creata?: string
}

function candidatura(f: Finta): Record<string, unknown> {
  const sede = f.sede ?? SEDE
  return {
    id: uuid(f.i),
    scuola_id: sede,
    stato: f.statoMadre ?? f.statoSede ?? 'pending',
    nome: f.nome ?? `Nome${f.i}`,
    cognome: f.cognome ?? `Cognome${f.i}`,
    email: f.email ?? `c${f.i}@example.invalid`,
    posizioni: f.posizioni ?? ['insegnante_infanzia'],
    gradi: f.gradi ?? ['infanzia'],
    residence_city: f.citta ?? 'Giugliano in Campania',
    residence_province: f.provincia ?? 'NA',
    titolo_studio: f.titolo ?? 'laurea_magistrale',
    anni_esperienza: f.esperienza === undefined ? 5 : f.esperienza,
    creata_il: f.creata ?? '2026-08-20T10:00:00.000Z',
    candidature_sedi: [{ scuola_id: sede, stato: f.statoSede ?? 'pending' }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.righe = []
  h.ors = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
})

async function elenco(qs: string) {
  const res = await chiedi(qs)
  const json = (await res.json()) as { data?: Record<string, unknown>[]; total?: number; error?: string }
  return { res, json }
}

describe('GET /api/admin/candidature-insegnanti — lo `stato` filtra la RIGA DI SEDE', () => {
  it('`?stato=rifiutata` non porta mai una riga il cui badge di sede dice altro', async () => {
    h.righe = [
      // Rifiutata NELLA MIA sede: deve uscire, anche se l'aggregato dice `pending`.
      candidatura({ i: 1, statoSede: 'rifiutata', statoMadre: 'pending' }),
      // In attesa nella mia sede ma AGGREGATO `rifiutata` (un altro plesso l'ha
      // chiusa): il badge dirà «In attesa», quindi NON deve uscire.
      candidatura({ i: 2, statoSede: 'pending', statoMadre: 'rifiutata' }),
    ]

    const { res, json } = await elenco('?stato=rifiutata')
    expect(res.status).toBe(200)
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
    // «n su totale» deve dire il totale FILTRATO, non quello della linguetta.
    expect(json.total).toBe(1)
  })

  it('«solo da evadere» tiene `pending` e `in_approvazione` della propria sede', async () => {
    h.righe = [
      candidatura({ i: 1, statoSede: 'pending' }),
      candidatura({ i: 2, statoSede: 'in_approvazione' }),
      candidatura({ i: 3, statoSede: 'approvata' }),
      candidatura({ i: 4, statoSede: 'rifiutata', statoMadre: 'pending' }),
    ]
    const { json } = await elenco('?daEvadere=1')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1), uuid(2)])
    expect(json.total).toBe(2)
  })
})

describe('GET /api/admin/candidature-insegnanti — filtrare non vuol dire PROIETTARE', () => {
  it('`?provincia=NA` filtra, ma provincia, città, titolo ed email restano fuori dall\'elenco', async () => {
    h.righe = [
      candidatura({ i: 1, provincia: 'NA' }),
      candidatura({ i: 2, provincia: 'CE' }),
    ]
    const { res, json } = await elenco('?provincia=NA')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])

    // L'elenco viaggia CROSS-SEDE verso ogni browser dello staff: ciò che serve
    // al filtro non deve per questo entrare nel payload.
    const corpo = await (await chiedi('?provincia=NA')).text()
    expect(res.status).toBe(200)
    for (const fuori of ['residence_province', 'residence_city', 'titolo_studio', 'anni_esperienza']) {
      expect(corpo).not.toContain(fuori)
    }
  })

  it('`?citta=` cerca dentro il nome del comune, e il `%` di chi scrive NON è un jolly', async () => {
    h.righe = [
      candidatura({ i: 1, citta: 'Giugliano in Campania' }),
      candidatura({ i: 2, citta: 'Aversa' }),
    ]
    const { json } = await elenco('?citta=giugliano')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])

    // `A%ersa` NON deve trovare «Aversa»: in `ilike` il `%` è il jolly, e
    // lasciarlo passare ALLARGA la ricerca invece di stringerla. `termineOr` lo
    // sostituisce con uno spazio, quindi il pattern cercato è `%A ersa%`.
    const conJolly = await elenco('?citta=A%25ersa')
    expect(conJolly.json.data ?? []).toHaveLength(0)
  })
})

describe('GET /api/admin/candidature-insegnanti — posizione, grado, titolo, esperienza', () => {
  it('`?posizione=cuoca` tiene solo chi si è candidata anche come cuoca', async () => {
    h.righe = [
      candidatura({ i: 1, posizioni: ['insegnante_nido', 'cuoca'] }),
      candidatura({ i: 2, posizioni: ['segreteria'] }),
    ]
    const { json } = await elenco('?posizione=cuoca')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
  })

  it('`?grado=primaria` tiene solo chi ha quella fascia', async () => {
    h.righe = [
      candidatura({ i: 1, gradi: ['infanzia', 'primaria'] }),
      candidatura({ i: 2, gradi: ['nido'] }),
    ]
    const { json } = await elenco('?grado=primaria')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
  })

  it('`?esperienza_min=5` esclude chi ne ha meno E chi non l\'ha dichiarata', async () => {
    h.righe = [
      candidatura({ i: 1, esperienza: 10 }),
      candidatura({ i: 2, esperienza: 2 }),
      // Campo facoltativo: `null` non è «zero anni», è «non lo so». Con `.gte`
      // resta fuori, ed è la risposta giusta — ma va detta, non subìta.
      candidatura({ i: 3, esperienza: null }),
    ]
    const { json } = await elenco('?esperienza_min=5')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
  })

  it('un valore fuori dagli elenchi chiusi è un 400, non un elenco vuoto', async () => {
    h.righe = [candidatura({ i: 1 })]
    for (const qs of ['?posizione=capo', '?grado=liceo', '?stato=archiviata', '?titolo=diplomino']) {
      const res = await chiedi(qs)
      expect([400]).toContain(res.status)
    }
  })
})

describe('GET /api/admin/candidature-insegnanti — la ricerca e il periodo', () => {
  it('`?q=` cerca su nome, cognome, email e CITTÀ della tabella madre', async () => {
    h.righe = [
      candidatura({ i: 1, nome: 'Anna', cognome: 'Verdi', email: 'anna@example.invalid' }),
      candidatura({ i: 2, nome: 'Bruno', cognome: 'Bianchi', email: 'bruno@example.invalid' }),
    ]
    const { json } = await elenco('?q=verdi')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
    // Solo colonne della tabella MADRE dentro `.or()`: un percorso d'embed lì
    // dentro PostgREST non lo accetta.
    expect(h.ors.join('|')).not.toContain('candidature_sedi')
    expect(h.ors[0]).toBe(
      'nome.ilike.%verdi%,cognome.ilike.%verdi%,email.ilike.%verdi%,residence_city.ilike.%verdi%',
    )
  })

  it('una ricerca che dopo la sanificazione resta vuota NON diventa `.or()`', async () => {
    h.righe = [candidatura({ i: 1 }), candidatura({ i: 2 })]
    const { json } = await elenco('?q=%25%2C()')
    // `nome.ilike.%%` non è «nessun filtro»: è un filtro che passa tutto scritto
    // in un modo che sembra una restrizione. Non deve partire affatto.
    expect(h.ors).toHaveLength(0)
    expect(json.data).toHaveLength(2)
  })

  it('il periodo si misura sul GIORNO CIVILE italiano, estremi compresi', async () => {
    h.righe = [
      // 1° settembre all'01:00 in Italia = 31 agosto 23:00Z. Con un confine in
      // UTC questa candidatura finirebbe nel giorno prima e chi filtra «oggi»
      // non la vedrebbe.
      candidatura({ i: 1, creata: '2026-08-31T23:00:00.000Z' }),
      // 31 agosto alle 23:00 in Italia = 21:00Z: è del giorno prima.
      candidatura({ i: 2, creata: '2026-08-31T21:00:00.000Z' }),
      // L'ULTIMO istante del 1° settembre in Italia.
      candidatura({ i: 3, creata: '2026-09-01T21:59:59.000Z' }),
      candidatura({ i: 4, creata: '2026-09-01T22:30:00.000Z' }),
    ]
    const { json } = await elenco('?creataDa=2026-09-01&creataA=2026-09-01')
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1), uuid(3)])
  })

  it('una data inesistente è un 400: `2026-02-30` non è «quasi il 2 marzo»', async () => {
    const res = await chiedi('?creataDa=2026-02-30')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/admin/candidature-insegnanti — la sede chiesta RESTRINGE, mai allarga', () => {
  it('`?scuola_id=` di una sede attiva tiene solo quella', async () => {
    h.righe = [candidatura({ i: 1, sede: SEDE }), candidatura({ i: 2, sede: ALTRA_SEDE })]
    const { json } = await elenco(`?scuola_id=${ALTRA_SEDE}`)
    expect(json.data?.map((r) => r.id)).toEqual([uuid(2)])
  })

  it('`?scuola_id=` di una sede NON accessibile è 403, non un elenco di un\'altra sede', async () => {
    h.righe = [candidatura({ i: 1, sede: SEDE })]
    const res = await chiedi('?scuola_id=33333333-3333-4333-8333-333333333333')
    expect(res.status).toBe(403)
    const json = (await res.json()) as { codice?: string }
    expect(json.codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  it('la stessa sede scritta in MAIUSCOLO resta la propria (uuid è un tipo, non una stringa)', async () => {
    h.righe = [candidatura({ i: 1, sede: SEDE }), candidatura({ i: 2, sede: ALTRA_SEDE })]
    const { res, json } = await elenco(`?scuola_id=${SEDE.toUpperCase()}`)
    expect(res.status).toBe(200)
    expect(json.data?.map((r) => r.id)).toEqual([uuid(1)])
  })
})

describe('GET /api/admin/candidature-insegnanti — filtro e paginazione insieme', () => {
  it('`offset` cammina dentro il risultato FILTRATO, e `total` conta quello', async () => {
    h.righe = [
      ...Array.from({ length: 30 }, (_, i) => candidatura({ i, statoSede: 'rifiutata' })),
      ...Array.from({ length: 70 }, (_, i) => candidatura({ i: 100 + i, statoSede: 'pending' })),
    ]
    const p1 = await elenco('?stato=rifiutata&limit=20&offset=0')
    const p2 = await elenco('?stato=rifiutata&limit=20&offset=20')

    expect(p1.json.data).toHaveLength(20)
    expect(p2.json.data).toHaveLength(10)
    expect(p1.json.total).toBe(30)
    expect(p2.json.total).toBe(30)
    // Nessuna riga in comune fra le due pagine: è la prova che l'offset non
    // punta dentro un risultato diverso da quello che si sta mostrando.
    const primi = new Set(p1.json.data?.map((r) => r.id))
    expect((p2.json.data ?? []).some((r) => primi.has(r.id))).toBe(false)
  })
})
