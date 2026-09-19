import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// GET/POST /api/avvisi.
// Falle chiuse:
//  - G3: GET ramo genitore era anonimo + spoofabile via ?parentId. Ora requireUser +
//        parentId DALLA SESSIONE, figli e classi derivati server-side, i parametri client ignorati.
//  - m3: ogni avviso porta l'elenco dei FIGLI cui si riferisce (globale=tutti, classe=chi è in classe).
//  - M7: POST autore = sessione (author_id del body ignorato).
//  - M8: POST target_scope='classe' con classi vuote → 400 (per tutti i ruoli).

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

/**
 * Scadenze RELATIVE, mai una data scritta a mano: dal 2026-09-19 il POST rifiuta
 * una scadenza già passata, quindi una costante `'2026-12-31'` renderebbe questi
 * test rossi il 1° gennaio per un motivo che non c'entra niente con ciò che
 * provano. È la lezione del test scaduto col calendario — e la correzione giusta
 * non è congelare l'orologio, è rendere il test indipendente dalla data.
 */
const FRA_TRENTA_GIORNI = new Date(Date.now() + 30 * 86_400_000).toISOString()
/** La stessa, nella forma LOCALE `YYYY-MM-DDTHH:MM` che il corpo deve mandare. */
const SCADENZA_LOCALE = FRA_TRENTA_GIORNI.slice(0, 16)

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  verificaTargetAvvisoDocente: vi.fn(),
  getModuleConfig: vi.fn(),
  notificaEvento: vi.fn(),
  genitoriDiScuola: vi.fn(),
  genitoriDiClassi: vi.fn(),
  logScrittura: vi.fn(),
  // canned data / capture
  alunni: [] as Array<Record<string, unknown>>,
  avvisi: [] as Array<Record<string, unknown>>,
  // `id` c'è perché la lettura degli autori ora è in BLOCCO (`.in('id', …)`):
  // senza, la riga non sarebbe associabile al proprio avviso.
  author: { id: 'aut1', nome: null, cognome: null, ruolo: null, first_name: 'Anna', last_name: 'Bianchi', role: 'educator' } as Record<string, unknown>,
  risposte: [] as Array<Record<string, unknown>>,
  // Sezioni della sede su cui si pubblica: dal 2026-07-31 il POST verifica che
  // ogni classe destinataria esista NELLA SEDE risolta (W2-B). Qui la sede è una
  // sola, quindi il controllo è verde e questi test restano su ciò che provano:
  // autore di sessione e semantica del target. L'isolamento fra sedi ha il suo
  // test dedicato — `avvisi-sede-scrittura.test.ts`, col finto client che filtra.
  sezioni: [] as Array<Record<string, unknown>>,
  lastInsert: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: (...a: unknown[]) => h.getFigliDiGenitore(...a) }))
vi.mock('@/lib/avvisi/target-gate', () => ({ verificaTargetAvvisoDocente: (...a: unknown[]) => h.verificaTargetAvvisoDocente(...a) }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: (...a: unknown[]) => h.getModuleConfig(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notificaEvento(...a) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiScuola: (...a: unknown[]) => h.genitoriDiScuola(...a),
  genitoriDiClassi: (...a: unknown[]) => h.genitoriDiClassi(...a),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: (...a: unknown[]) => h.logScrittura(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const st: { count: boolean; notNull: string | null; filters: Record<string, unknown>; inserted: Record<string, unknown> | null; gte: [string, unknown] | null } =
        { count: false, notNull: null, filters: {}, inserted: null, gte: null }
      const result = () => {
        if (table === 'alunni') return { data: h.alunni, error: null }
        if (table === 'avvisi') {
          // `.gte` si APPLICA DAVVERO: dal 2026-09-19 il feed del genitore toglie
          // gli avvisi scaduti con `.gte('scadenza_avviso', adesso)`, e un finto
          // client che accettasse il filtro ignorandolo renderebbe verde il test
          // con e senza quel filtro — la prima delle cinque forme di verde falso.
          const g = st.gte
          const righe = g
            ? h.avvisi.filter((a) => {
                const v = a[g[0]]
                return typeof v === 'string' && v >= String(g[1])
              })
            : h.avvisi
          return { data: righe, error: null }
        }
        if (table === 'sections') return { data: h.sezioni, error: null }
        if (table === 'utenti') return { data: [h.author], error: null }
        if (table === 'avvisi_risposte') {
          if (st.count) {
            if (st.notNull === 'letto_il') return { count: 0 }
            if (st.filters.risposta === 'si') return { count: 0 }
            if (st.filters.risposta === 'no') return { count: 0 }
            return { count: 0 }
          }
          return { data: h.risposte, error: null }
        }
        return { data: null, error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = (_s: string, opts?: { count?: string; head?: boolean }) => { if (opts?.count) st.count = true; return b }
      b.order = () => b
      b.eq = (c: string, v: unknown) => { st.filters[c] = v; return b }
      b.in = () => b
      b.gte = (c: string, v: unknown) => { st.gte = [c, v]; return b }
      b.not = (c: string) => { st.notNull = c; return b }
      b.limit = () => b
      // Le statistiche degli avvisi si leggono in BLOCCO e paginate (T11-F2):
      // `.range()` è la chiamata che chiude la catena, non più `.then()`.
      b.range = async () => (table === 'avvisi_risposte'
        ? { data: h.risposte, count: h.risposte.length, error: null }
        : { data: [], count: 0, error: null })
      b.insert = (rec: Record<string, unknown>) => { h.lastInsert = rec; st.inserted = rec; return b }
      b.single = async () => (table === 'avvisi' && st.inserted ? { data: { id: 'new-av', ...st.inserted }, error: null } : result())
      // `result()` parla la lingua di PostgREST (elenchi); `maybeSingle` è la
      // stessa lettura ridotta a una riga sola.
      b.maybeSingle = async () => {
        const r = result() as { data: unknown; error?: unknown }
        return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error ?? null } : r
      }
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR)
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/avvisi/route'

const getReq = (qs = '') => ({
  url: `http://test/api/avvisi${qs ? `?${qs}` : ''}`,
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams(qs) },
  cookies: { get: () => undefined },
}) as never

const postReq = (body: unknown) => ({
  url: 'http://test/api/avvisi',
  method: 'POST',
  headers: new Headers(),
  json: async () => body,
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.lastInsert = null
  h.risposte = []
  h.alunni = [
    { id: 's1', nome: 'Bruna', classe_sezione: '1A', scuola_id: 'sc-1' },
    { id: 's2', nome: 'Bruno', classe_sezione: '1B', scuola_id: 'sc-1' },
  ]
  // 🔴 `scuola_id` SU OGNI AVVISO, dal 2026-09-19: il ramo globale del feed offre
  // i figli DI QUELLA SEDE (prima li offriva tutti, e la bacheca proponeva un
  // bottone che `POST …/risposte` rifiuta con 403 `ADESIONE_ALUNNO_FUORI_AVVISO`).
  // Un avviso senza sede in fixture è un avviso che in produzione non arriverebbe
  // mai fin qui — `.in('scuola_id', scuoleFigli)` lo scarta — e lascerebbe `figli`
  // vuoto per una ragione che non c'entra con ciò che questi test provano.
  // L'isolamento vero fra plessi ha il suo file: `avvisi-cerchio-bacheca-adesione`.
  h.avvisi = [
    { id: 'av-glob', author_id: 'aut1', titolo: 'Chiusura', contenuto: 'x', tipo: 'presa_visione', target_scope: 'globale', target_classes: null, scadenza: null, scadenza_avviso: FRA_TRENTA_GIORNI, scadenza_adesione: null, attachment_url: null, created_at: '2026-07-03', scuola_id: 'sc-1' },
    { id: 'av-1a', author_id: 'aut1', titolo: 'Gita 1A', contenuto: 'y', tipo: 'adesione', target_scope: 'classe', target_classes: ['1A'], scadenza: null, scadenza_avviso: FRA_TRENTA_GIORNI, scadenza_adesione: FRA_TRENTA_GIORNI, attachment_url: null, created_at: '2026-07-02', scuola_id: 'sc-1' },
    { id: 'av-3c', author_id: 'aut1', titolo: 'Altra classe', contenuto: 'z', tipo: 'presa_visione', target_scope: 'classe', target_classes: ['3C'], scadenza: null, scadenza_avviso: FRA_TRENTA_GIORNI, scadenza_adesione: null, attachment_url: null, created_at: '2026-07-01', scuola_id: 'sc-1' },
  ]
  h.sezioni = [{ name: '1A' }, { name: '1B' }]
  h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: 'sc-1' } })
  h.getFigliDiGenitore.mockResolvedValue(['s1', 's2'])
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  // Utente con UNA sola sede: è ciò che il resolver vero risponde in quel caso
  // (`accessibili.length === 1`), qui senza dover montare il ponte `utenti_scuole`.
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: 'sc-1' })
  h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.verificaTargetAvvisoDocente.mockResolvedValue(null)
  h.getModuleConfig.mockResolvedValue({ ruoli_pubblicazione: ['admin', 'teacher'] })
  h.genitoriDiScuola.mockResolvedValue([])
  h.genitoriDiClassi.mockResolvedValue([])
})

describe('GET /api/avvisi — ramo genitore (G3 + m3)', () => {
  it('401 quando anonimo', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(getReq('parentId=chiunque'))
    expect(res.status).toBe(401)
  })

  it('deriva il feed dalla sessione e ignora i parametri client', async () => {
    // parentId/classe/studentId del client sono OSTILI: devono essere ignorati.
    const res = await GET(getReq('parentId=VITTIMA&classe=9Z&studentId=X'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<{ id: string }>
    const ids = j.map((a) => a.id).sort()
    // globale + classe del figlio 1A; l'avviso di 3C (nessun figlio) è escluso.
    expect(ids).toEqual(['av-1a', 'av-glob'])
    // parentId è derivato dalla sessione, non dal query param.
    expect(h.getFigliDiGenitore).toHaveBeenCalledWith(expect.anything(), PARENT_ID)
  })

  it('m3: ogni avviso porta i figli cui si riferisce, con lo STATO della riga di ciascuno', async () => {
    // ── PERCHÉ I DUE CAMPI PER FIGLIO NON SONO DECORAZIONE ─────────────────
    //
    // L'aggregato `my_response` è `null` quando i figli non concordano — ed è
    // giusto che lo sia: quella famiglia non HA uno stato. Ma `null`, a valle,
    // vale AMMESSO (le 869 righe storiche hanno lo stato nullo e quelle famiglie
    // sono dentro davvero), quindi senza il dato per figlio un genitore con un
    // bambino in coda legge «Hai aderito ✓» e la modale «modifica» riparte dal
    // minimo invece che dal numero di ciascuno — 2 e 4 che diventano 1 e 1.
    //
    // 🔴 E `stato_adesione`/`numero_partecipanti` NON sono una capienza: sono la
    // PROPRIA riga. Da «Bruna è in coda» non si ricava nessun posto libero.
    h.risposte = [
      {
        avviso_id: 'av-1a', student_id: 's1', parent_id: PARENT_ID,
        letto_il: 'x', risposta: 'si', risposto_il: 'x',
        stato_adesione: 'in_attesa', numero_partecipanti: 4,
      },
    ]
    const res = await GET(getReq())
    const j = (await res.json()) as Array<{ id: string; figli: Array<Record<string, unknown>> }>
    const glob = j.find((a) => a.id === 'av-glob')!
    const uno = j.find((a) => a.id === 'av-1a')!
    expect(glob.figli.map((f) => f.student_id).sort()).toEqual(['s1', 's2'])
    // `toEqual`, cioè uguaglianza ESATTA e non `toMatchObject`: è quello che
    // impedisce a un campo di capienza di rientrare di nascosto nel payload del
    // genitore, come `posti_totali` era già rientrato una volta. I due campi
    // stanno nell'atteso con i VALORI VERI, così questa riga prova anche che il
    // dato per figlio arriva davvero; un terzo campo, domani, fa ancora rosso.
    expect(uno.figli).toEqual([
      { student_id: 's1', nome: 'Bruna', stato_adesione: 'in_attesa', numero_partecipanti: 4 },
    ])
    // Il figlio che non ha risposto porta i due campi a `null`, non assenti:
    // «non ha ancora risposto» è un fatto, e si legge come tale.
    expect(glob.figli.find((f) => f.student_id === 's2')).toEqual({
      student_id: 's2', nome: 'Bruno', stato_adesione: null, numero_partecipanti: null,
    })
  })

  it('genitore senza figli → lista vuota', async () => {
    h.getFigliDiGenitore.mockResolvedValue([])
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('GET /api/avvisi — ramo staff', () => {
  it('lo staff vede gli avvisi del proprio plesso (nessun figli, my_response null)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<Record<string, unknown>>
    expect(j.length).toBe(3)
    expect(j[0].figli).toBeUndefined()
    expect(j[0].my_response).toBeNull()
  })
})

describe('POST /api/avvisi — autore e target', () => {
  it('M7: usa l\'autore di SESSIONE e ignora author_id del body', async () => {
    const res = await POST(postReq({ author_id: 'SPOOF-DOCENTE', titolo: 'T', contenuto: 'C', target_scope: 'globale', scadenza_avviso: SCADENZA_LOCALE }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.author_id).toBe('seg-1')
    expect(h.lastInsert?.author_id).not.toBe('SPOOF-DOCENTE')
  })

  it('M8: target_scope=classe con classi vuote → 400', async () => {
    const res = await POST(postReq({ titolo: 'T', contenuto: 'C', target_scope: 'classe', target_classes: [], scadenza_avviso: SCADENZA_LOCALE }))
    expect(res.status).toBe(400)
    expect(h.lastInsert).toBeNull()
  })

  it('M8: target_scope=classe con classi solo whitespace → 400', async () => {
    const res = await POST(postReq({ titolo: 'T', contenuto: 'C', target_scope: 'classe', target_classes: ['', '  '], scadenza_avviso: SCADENZA_LOCALE }))
    expect(res.status).toBe(400)
  })

  it('classe con classi valide → 201', async () => {
    const res = await POST(postReq({ titolo: 'T', contenuto: 'C', target_scope: 'classe', target_classes: ['1A'], scadenza_avviso: SCADENZA_LOCALE }))
    expect(res.status).toBe(201)
    expect(h.lastInsert?.author_id).toBe('seg-1')
  })
})
