import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/pagamenti/fattura/anteprima — il blocco `intestatario`.
 *
 * ─── PERCHÉ NON UNA ROUTE NUOVA ──────────────────────────────────────────────
 * Il dialogo «Emetti» deve fare UN SOLO giro, e causale e intestatario devono
 * nascere dalla stessa lettura dello stesso pagamento: due letture possono
 * contraddirsi, e su un documento fiscale la contraddizione si corregge solo con
 * una nota di variazione. Una route separata sarebbe anche un secondo gate di
 * sede sullo stesso oggetto.
 *
 * ─── LE DUE REGOLE CHE QUESTI TEST DIFENDONO ─────────────────────────────────
 *  1. I CANDIDATI SONO SOLO I GENITORI DI QUEL BAMBINO. `parents` non ha
 *     `scuola_id`: l'isolamento di sede passa dai figli. Una ricerca globale
 *     farebbe affiorare adulti di un'altra sede dentro il pagamento di una
 *     famiglia, e un omonimo produrrebbe una fattura intestata a un estraneo
 *     trasmessa all'Agenzia delle Entrate.
 *  2. L'AIUTO È FAIL-OPEN, IL DOCUMENTO NO. Se la lettura dei movimenti bancari
 *     fallisce non si propone niente, si logga e la causale esce lo stesso: chi
 *     deve emettere non resta bloccato da un suggerimento che non è arrivato.
 *     Ma mai in silenzio (AGENTS.md, regola 6).
 *
 * ⚠️ Misurato in produzione il 2026-09-04: `riconciliazione_movimenti` è VUOTA
 * (0 righe). Il caso «nessun ordinante» non è un caso limite, è l'unico che
 * esiste oggi: deve restare muto e senza errori.
 *
 * Nomi e codici fiscali SINTETICI: il repository è pubblico.
 */

const { PAG, SCUOLA, ALUNNO, ALTRO_ALUNNO, UTENTE, P_FABBRI, P_PERLINI, P_BIANCHI, ACC_PERLINI } = vi.hoisted(
  () => ({
    PAG: '85320395-0000-4000-8000-000000000001',
    SCUOLA: '429da920-0000-4000-8000-000000000002',
    ALUNNO: 'aaaaaaaa-0000-4000-8000-000000000003',
    ALTRO_ALUNNO: 'aaaaaaaa-0000-4000-8000-000000000099',
    UTENTE: 'bbbbbbbb-0000-4000-8000-000000000004',
    P_FABBRI: 'cccccccc-0000-4000-8000-000000000005',
    P_PERLINI: 'dddddddd-0000-4000-8000-000000000006',
    P_BIANCHI: 'eeeeeeee-0000-4000-8000-000000000007',
    ACC_PERLINI: 'ffffffff-0000-4000-8000-000000000008',
  }),
)

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  fuoriScope: null as unknown,
  pagamento: null as Record<string, unknown> | null,
  alunno: null as Record<string, unknown> | null,
  erroreAlunno: null as unknown,
  /** Righe `student_parents`, per QUALSIASI bambino: il filtro lo fa il mock. */
  studentParents: [] as Record<string, unknown>[],
  /** Righe `legame_genitori_alunni` (il ponte runtime). */
  legami: [] as Record<string, unknown>[],
  parents: [] as Record<string, unknown>[],
  movimenti: [] as Record<string, unknown>[],
  erroreMovimenti: null as unknown,
  quoteEsplicite: [] as Record<string, unknown>[],
  /** Fa LANCIARE la lettura dei candidati: un'eccezione vera, non un `{ error }`. */
  rompiCandidati: false,
  log: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: h.requireStaff,
  requireDocente: h.requireStaff,
}))
vi.mock('@/lib/auth/scope', () => ({ assertPagamentoInScope: async () => h.fuoriScope }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const actual = await originale<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.log }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const f: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (c: string, v: unknown) => {
        f[c] = v
        return b
      }
      b.in = (c: string, v: unknown) => {
        f[c] = v
        return b
      }
      b.limit = () => b
      b.single = async () => ({ data: table === 'pagamenti' ? h.pagamento : null, error: null })
      b.maybeSingle = async () => {
        if (table === 'admin_settings') return { data: { fattura_causali_config: {} }, error: null }
        if (table === 'scuole') return { data: { nome: 'Kidville Aversa' }, error: null }
        if (table === 'alunni') return { data: h.erroreAlunno ? null : h.alunno, error: h.erroreAlunno ?? null }
        if (table === 'divise_ordini') return { data: null, error: null }
        if (table === 'parents') {
          // Due usi con `maybeSingle`: il default di famiglia (con
          // `intestatario_default`) e `resolveParentRegistry` (per id / ponte).
          if (f.intestatario_default === true) {
            const ids = (f.id as string[]) ?? []
            const def = h.parents.find((p) => ids.includes(p.id as string) && p.intestatario_default === true)
            return { data: def ? { id: def.id } : null, error: null }
          }
          const per =
            h.parents.find((p) => p.id === f.id) ?? h.parents.find((p) => p.auth_user_id === f.auth_user_id) ?? null
          return { data: per, error: null }
        }
        return { data: null, error: null }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'student_parents') {
          if (h.rompiCandidati) throw new TypeError('forma inattesa di student_parents')
          const uno = f.student_id as string | undefined
          const molti = (f.student_id as string[] | undefined) ?? []
          const righe = h.studentParents.filter((r) =>
            Array.isArray(f.student_id) ? molti.includes(r.student_id as string) : r.student_id === uno,
          )
          return resolve({ data: righe, error: null })
        }
        if (table === 'legame_genitori_alunni') {
          const molti = (f.alunno_id as string[] | undefined) ?? []
          return resolve({ data: h.legami.filter((r) => molti.includes(r.alunno_id as string)), error: null })
        }
        if (table === 'parents') {
          const ids = (f.id as string[] | undefined) ?? null
          const auth = (f.auth_user_id as string[] | undefined) ?? null
          const righe = h.parents.filter(
            (p) => (ids && ids.includes(p.id as string)) || (auth && auth.includes(p.auth_user_id as string)),
          )
          return resolve({ data: righe, error: null })
        }
        if (table === 'riconciliazione_movimenti') {
          return resolve({ data: h.erroreMovimenti ? null : h.movimenti, error: h.erroreMovimenti ?? null })
        }
        if (table === 'pagamenti_quote') return resolve({ data: h.quoteEsplicite, error: null })
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/fattura/anteprima/route'
import { adultoEGenitoreDi } from '@/lib/pagamenti/intestatari'
import { createAdminClient } from '@/lib/supabase/server-client'

function req(pagamentoId = PAG) {
  return new Request(`http://x/api/pagamenti/fattura/anteprima?pagamento_id=${pagamentoId}`, {
    headers: { 'x-user-id': UTENTE },
  })
}

/** Anagrafiche SINTETICHE: Fabbri è fatturabile, Perlini no (le manca la residenza). */
const fabbri = {
  id: P_FABBRI,
  auth_user_id: null,
  first_name: 'Giulia',
  last_name: 'Fabbri',
  fiscal_code: 'FBBGLI80A41H501Z',
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
  intestatario_default: false,
}
const perlini = {
  id: P_PERLINI,
  auth_user_id: ACC_PERLINI,
  first_name: 'Carlo',
  last_name: 'Perlini',
  fiscal_code: 'PRLCRL80A01H501Z',
  residence_address: '',
  residence_city: '',
  zip_code: '',
  intestatario_default: false,
}
/** Il genitore di UN ALTRO bambino: non deve comparire da nessuna parte. */
const bianchi = {
  id: P_BIANCHI,
  auth_user_id: null,
  first_name: 'Luca',
  last_name: 'Bianchi',
  fiscal_code: 'BNCLCU80A01H501Z',
  residence_address: 'Via delle Verifiche 3',
  residence_city: 'Aversa',
  zip_code: '81031',
  intestatario_default: true,
}

async function anteprima() {
  const res = await GET(req())
  return { res, j: await res.json() }
}

beforeEach(() => {
  h.requireStaff.mockResolvedValue({ user: { id: UTENTE, ruolo: 'segreteria', scuola_id: SCUOLA } })
  h.fuoriScope = null
  h.erroreAlunno = null
  h.erroreMovimenti = null
  h.rompiCandidati = false
  h.movimenti = []
  h.quoteEsplicite = []
  h.log.mockClear()
  h.pagamento = {
    id: PAG,
    descrizione: 'Retta 09/2026',
    importo: 300,
    stato: 'pagato',
    scadenza: '2026-09-05',
    periodo_competenza: '2026-09-01',
    scuola_id: SCUOLA,
    fattura_causale: null,
    categoria_id: 'cat-1',
    alunno_id: ALUNNO,
    payment_categories: { slug: 'retta' },
    alunni: { id: ALUNNO, nome: 'Mario', cognome: 'Fabbri', codice_fiscale: 'FBBMRA20A01Z999X' },
  }
  h.alunno = {
    id: ALUNNO,
    cognome: 'Fabbri',
    genitori_separati: false,
    retta_split_config: null,
    intestatario_fatture: null,
  }
  h.studentParents = [
    { student_id: ALUNNO, parent_id: P_FABBRI, relation_type: 'madre' },
    // Il genitore di un ALTRO bambino: se comparisse, il filtro non filtra.
    { student_id: ALTRO_ALUNNO, parent_id: P_BIANCHI, relation_type: 'padre' },
  ]
  h.legami = [{ alunno_id: ALUNNO, genitore_id: ACC_PERLINI }]
  h.parents = [fabbri, perlini, bianchi]
})

describe('anteprima → blocco `intestatario`', () => {
  it('elenca i candidati col VERDETTO di fatturabilità, dalla stessa `validaCessionario` dell’emissione', async () => {
    const { res, j } = await anteprima()
    expect(res.status).toBe(200)
    const c = j.data.intestatario.candidati as {
      adult_id: string
      nome: string
      relazione: string | null
      fatturabile: boolean
      errori: Record<string, string>
    }[]

    const g = c.find((x) => x.adult_id === P_FABBRI)!
    expect(g.fatturabile).toBe(true)
    expect(g.errori).toEqual({})
    expect(g.relazione).toBe('madre')

    // Perlini arriva dal PONTE runtime, non da `student_parents`: la cascata usa
    // l'unione delle due sorgenti, e qui deve valere la stessa.
    const p = c.find((x) => x.adult_id === P_PERLINI)!
    expect(p.fatturabile).toBe(false)
    expect(p.errori).toMatchObject({ indirizzo: 'mancante', cap: 'mancante', comune: 'mancante' })
  })

  it('il BAMBINO sta dentro il blocco `intestatario`, non accanto', async () => {
    // «Su quale bambino si ricorda la scelta» è parte della decisione
    // sull'intestatario, non un dato a sé: se vivesse accanto al blocco, domani
    // due posti direbbero chi è l'alunno e il dialogo dovrebbe metterli
    // d'accordo. `componiIntestatarioPagamento` resta l'unica sorgente da cui
    // quel dialogo prende i suoi dati.
    const { j } = await anteprima()
    expect(j.data.intestatario.alunno).toEqual({ id: ALUNNO, nome: 'Mario Fabbri' })
    expect(j.data.alunno, 'un secondo posto da cui leggere lo stesso fatto').toBeUndefined()
  })

  it('senza il bambino annidato → `alunno: null`, non un oggetto a metà', async () => {
    h.pagamento = { ...h.pagamento, alunni: null }
    const { j } = await anteprima()
    expect(j.data.intestatario.alunno).toBeNull()
  })

  it('⛔ OGNI candidato che l’anteprima espone è ACCETTATO dal gate dell’emissione', async () => {
    // Il contratto fra le due strade, provato sullo STESSO fixture invece che
    // ragionandoci sopra. `perlini` è noto al solo ponte runtime: l'anteprima lo
    // espone col suo `parents.id`, e per un giro l'emissione ha rifiutato con
    // 422 proprio quell'id, perché confrontava due spazi d'identità diversi.
    // Un'app che offre una scelta e poi la respinge dà la colpa a chi ha premuto.
    const { j } = await anteprima()
    const candidati = j.data.intestatario.candidati as { adult_id: string }[]
    expect(candidati.length, 'senza candidati questa prova non proverebbe niente').toBeGreaterThan(1)
    expect(candidati.map((c) => c.adult_id)).toContain(P_PERLINI)

    const sb = await createAdminClient()
    for (const c of candidati) {
      expect(
        await adultoEGenitoreDi(sb as never, ALUNNO, c.adult_id),
        `l’anteprima propone ${c.adult_id} e l’emissione lo rifiuta`,
      ).toBe(true)
    }
  })

  it('un adulto ESTRANEO resta rifiutato: il gate non è diventato un passa-tutto', async () => {
    // Il controllo che tiene onesto quello qui sopra: se `adultoEGenitoreDi`
    // rispondesse sempre `true`, il test precedente sarebbe verde e la rete
    // contro il bug del client non esisterebbe più.
    const sb = await createAdminClient()
    expect(await adultoEGenitoreDi(sb as never, ALUNNO, P_BIANCHI)).toBe(false)
  })

  it('la risposta NON contiene genitori di altri bambini', async () => {
    const { j } = await anteprima()
    const testo = JSON.stringify(j)
    expect(testo).not.toContain(P_BIANCHI)
    expect(testo).not.toContain('Bianchi')
  })

  it('`controparte` assente (lo stato di produzione, 0 movimenti) → nessuna proposta e nessun errore', async () => {
    h.movimenti = []
    const { res, j } = await anteprima()
    expect(res.status).toBe(200)
    expect(j.data.intestatario.proposta).toBeNull()
    expect(j.data.intestatario.ordinante).toBeNull()
    // E la causale esce comunque: è il motivo per cui la route esiste.
    expect(j.data.causale).toContain('Mario Fabbri')
  })

  it('una riga con `controparte` NULL non produce una proposta muta', async () => {
    h.movimenti = [{ controparte: null, importo: 300, confermato_il: '2026-09-05T10:00:00Z' }]
    const { j } = await anteprima()
    expect(j.data.intestatario.proposta).toBeNull()
    expect(j.data.intestatario.ordinante).toBeNull()
  })

  it('bonifico con l’ordinante che corrisponde → proposta preselezionata, col MOTIVO', async () => {
    h.movimenti = [{ controparte: 'FABBRI GIULIA', importo: 300, confermato_il: '2026-09-05T10:00:00Z' }]
    const { j } = await anteprima()
    expect(j.data.intestatario.ordinante).toBe('FABBRI GIULIA')
    expect(j.data.intestatario.proposta).toEqual({ adult_id: P_FABBRI, motivo: 'bonifico_esatto' })
  })

  it('ogni proposta lascia un `info` che dice COL QUALE MECCANISMO è nata', async () => {
    // Senza, al primo import dell'estratto conto non si potrà contare quanti
    // `bonifico_esatto` contro quanti `sottoinsieme_*` — cioè quanto vale
    // davvero l'aiuto — se non leggendo i nomi, che nei log non entrano mai.
    // Il motivo viaggia dentro `esito` perché `motivo` NON è nella lista bianca
    // di `redact` e non ce lo si aggiunge «perché sarebbe comodo vederlo»:
    // `esito` è già in chiaro in tabella e si interroga con un `like`.
    h.movimenti = [{ controparte: 'FABBRI GIULIA', importo: 300, confermato_il: '2026-09-05T10:00:00Z' }]
    await anteprima()

    const info = h.log.mock.calls.find(
      (c) => c[1] === 'info' && String((c[2] as { esito?: string })?.esito) === 'proposta-bonifico_esatto',
    )
    expect(info, 'un aiuto che nessuno può contare non si può nemmeno migliorare').toBeTruthy()
    // E nessun nome: nel contesto entrano solo uuid, numeri e `esito`.
    expect(JSON.stringify(info?.[2])).not.toContain('Fabbri')
    expect(JSON.stringify(info?.[2])).not.toContain('FABBRI')
  })

  it('nessuna proposta → nessun `info`: il canale conta le proposte, non le chiamate', async () => {
    h.movimenti = []
    await anteprima()
    const info = h.log.mock.calls.find(
      (c) => c[1] === 'info' && String((c[2] as { esito?: string })?.esito ?? '').startsWith('proposta-'),
    )
    expect(info).toBeFalsy()
  })

  it('conto cointestato, due genitori nel nome, nessuno marcato → NESSUNA proposta (mai «il primo»)', async () => {
    h.movimenti = [{ controparte: 'PERLINI CARLO  FABBRI GIULIA', importo: 300, confermato_il: '2026-09-05T10:00:00Z' }]
    const { j } = await anteprima()
    expect(j.data.intestatario.ordinante).toBe('PERLINI CARLO  FABBRI GIULIA')
    expect(j.data.intestatario.proposta).toBeNull()
  })

  it('cointestato + intestatario sulla SCHEDA → vince quello, motivo `sottoinsieme_scheda`', async () => {
    h.alunno = { ...h.alunno, intestatario_fatture: { tipo: 'adult', adult_id: P_PERLINI } }
    h.movimenti = [{ controparte: 'PERLINI CARLO  FABBRI GIULIA', importo: 300, confermato_il: '2026-09-05T10:00:00Z' }]
    const { j } = await anteprima()
    expect(j.data.intestatario.proposta).toEqual({ adult_id: P_PERLINI, motivo: 'sottoinsieme_scheda' })
  })

  it('più movimenti → decide quello di importo maggiore', async () => {
    h.movimenti = [
      { controparte: 'PERLINI CARLO', importo: 50, confermato_il: '2026-09-06T10:00:00Z' },
      { controparte: 'FABBRI GIULIA', importo: 300, confermato_il: '2026-09-05T10:00:00Z' },
    ]
    const { j } = await anteprima()
    expect(j.data.intestatario.ordinante).toBe('FABBRI GIULIA')
    expect(j.data.intestatario.proposta).toEqual({ adult_id: P_FABBRI, motivo: 'bonifico_esatto' })
  })

  it('due movimenti che PAREGGIANO con ordinanti diversi → nessuna proposta: un’ambiguità non è un suggerimento', async () => {
    h.movimenti = [
      { controparte: 'PERLINI CARLO', importo: 300, confermato_il: '2026-09-05T10:00:00Z' },
      { controparte: 'FABBRI GIULIA', importo: 300, confermato_il: '2026-09-05T10:00:00Z' },
    ]
    const { j } = await anteprima()
    expect(j.data.intestatario.proposta).toBeNull()
    expect(j.data.intestatario.ordinante).toBeNull()
  })

  it('lettura dei movimenti FALLITA → nessuna proposta, un log `warn`, e la causale esce lo stesso', async () => {
    h.erroreMovimenti = { message: 'column riconciliazione_movimenti.controparte does not exist', code: '42703' }
    const { res, j } = await anteprima()

    expect(res.status).toBe(200)
    expect(j.data.causale).toContain('Mario Fabbri')
    expect(j.data.intestatario.proposta).toBeNull()
    const warn = h.log.mock.calls.find(
      (c) => c[1] === 'warn' && String((c[2] as { esito?: string })?.esito) === 'ordinante-non-letto',
    )
    expect(warn, 'un aiuto che non arriva deve lasciare una riga, o «nessuna proposta» non si distingue da «nessun bonifico»').toBeTruthy()
  })

  it('pagamento RIPARTITO → `ripartito: true` e le due quote, ciascuna col suo verdetto', async () => {
    h.alunno = { ...h.alunno, genitori_separati: true }
    h.quoteEsplicite = [
      { adult_id: P_FABBRI, importo: 180, etichetta: 'Mamma' },
      { adult_id: P_PERLINI, importo: 120, etichetta: 'Papà' },
    ]
    const { j } = await anteprima()
    expect(j.data.intestatario.ripartito).toBe(true)
    const quote = j.data.intestatario.quote as { adult_id: string; importo: number; fatturabile: boolean }[]
    expect(quote).toHaveLength(2)
    expect(quote.find((q) => q.adult_id === P_FABBRI)!.fatturabile).toBe(true)
    expect(quote.find((q) => q.adult_id === P_PERLINI)!.fatturabile).toBe(false)
  })

  it('pagamento non ripartito e senza intestatario → `ripartito: false` e nessuna quota (gli 88 su 93)', async () => {
    const { j } = await anteprima()
    expect(j.data.intestatario.ripartito).toBe(false)
    expect(j.data.intestatario.quote).toEqual([])
  })

  it('`tipo: \'altro\'` sulla scheda → una quota SENZA adult_id, col nome digitato e il suo verdetto', async () => {
    h.alunno = {
      ...h.alunno,
      intestatario_fatture: {
        tipo: 'altro',
        dati: { nome: 'Carlo', cognome: 'Perlini', cf: 'PRLCRL80A01H501Z', indirizzo: 'Via delle Prove', cap: '81030', comune: 'Cesa' },
      },
    }
    const { j } = await anteprima()
    const quote = j.data.intestatario.quote as { adult_id: string | null; nome: string; fatturabile: boolean }[]
    expect(quote).toHaveLength(1)
    expect(quote[0].adult_id).toBeNull()
    expect(quote[0].nome).toBe('Carlo Perlini')
    expect(quote[0].fatturabile).toBe(true)
  })

  it('un guasto IMPREVISTO nel blocco intestatario non abbatte la causale, e lascia un log `error`', async () => {
    // Non è un errore di PostgREST (quelli si ritornano, non si lanciano): è
    // un'eccezione vera — una forma di dato che non avevamo previsto. Senza il
    // fail-open, il `catch` della route risponderebbe 500 e chi sta per emettere
    // non vedrebbe nemmeno il testo che partirà: un guasto nell'accessorio
    // spegnerebbe la cosa principale.
    h.rompiCandidati = true
    const { res, j } = await anteprima()

    expect(res.status).toBe(200)
    expect(j.data.causale).toContain('Mario Fabbri')
    expect(j.data.intestatario).toEqual({
      // `alunno: null` anche qui, e non «il nome che avevamo comunque in mano»:
      // il dialogo non può proporre di ricordare la scelta su un bambino di cui
      // non ha potuto comporre nemmeno un candidato.
      alunno: null,
      quote: [],
      ripartito: false,
      candidati: [],
      proposta: null,
      ordinante: null,
    })
    const err = h.log.mock.calls.find(
      (c) => c[1] === 'error' && String((c[2] as { esito?: string })?.esito) === 'intestatario-non-composto',
    )
    expect(err, '`withRoute` non vede le eccezioni catturate: senza questa riga il guasto è muto').toBeTruthy()
  })

  it('l’anagrafica del bambino non letta → il blocco esce lo stesso, con un log', async () => {
    h.erroreAlunno = { message: 'permission denied', code: '42501' }
    const { res, j } = await anteprima()
    expect(res.status).toBe(200)
    expect(j.data.causale).toContain('Mario Fabbri')
    expect(j.data.intestatario.quote).toEqual([])
    const warn = h.log.mock.calls.find(
      (c) => c[1] === 'warn' && String((c[2] as { esito?: string })?.esito) === 'alunno-economico-non-letto',
    )
    expect(warn).toBeTruthy()
  })
})
