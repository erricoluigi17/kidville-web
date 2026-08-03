import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// LA QUARTA STRADA: APPROVARE UNA PROPOSTA PUBBLICA, e non passava dal gate.
//
// IL DIFETTO (collaudo del 2026-08-03, T18-F1). Il consenso fotografico sul
// canale «sito» era verificato su tre rotte — `news:POST` (il contenuto nasce),
// `news/[id]:PATCH` (cambia), `news/[id]/pubblica:POST` (diventa visibile) — e su
// una quarta no: `POST /api/news/[id]/approva`, con cui la segreteria approva la
// PROPOSTA di un docente e, nel ramo normale (`pubblica_subito !== false`), la
// rende visibile nello stesso istante. `grep gateConsensoFoto src/` dava tre
// chiamanti; questa rotta non era fra loro.
//
// La conseguenza era esatta e misurabile: un docente propone un articolo con la
// foto di un bambino, la famiglia revoca il consenso al sito, la segreteria
// approva — e la foto finisce sul bucket `news`, che è PUBBLICO e servito senza
// login, con il gate formale verde.
//
// È la stessa forma di difetto che questo ciclo ha già chiuso tre volte: la
// regola valida per due strade, scritta su una sola. Perciò le asserzioni qui
// sotto sono sulla MUTAZIONE (che cosa è stato scritto sulla riga) e ognuna
// negativa ha il suo CONTROLLO POSITIVO: senza, «non pubblica» sarebbe verde
// anche con una route che non fa più niente.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  notificaNewsPubblicata: vi.fn(),
  // `news_posts` — la proposta che la route ricarica per lo scope
  post: null as Record<string, unknown> | null,
  // `alunni` — l'esito della verifica del consenso
  alunni: [] as Array<Record<string, unknown>>,
  errAlunni: null as { code?: string; message: string } | null,
  // mutazioni osservate
  update: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (...a: unknown[]) => h.requireStaff(...a),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
}))
vi.mock('@/lib/news/notifiche', () => ({
  notificaNewsPubblicata: (...a: unknown[]) => h.notificaNewsPubblicata(...a),
}))

function makeClient() {
  return {
    from(table: string) {
      const st = { table, op: 'select', payload: null as Record<string, unknown> | null }
      const b: Record<string, unknown> = {}
      const risolvi = () => {
        if (st.table === 'alunni') return { data: h.errAlunni ? null : h.alunni, error: h.errAlunni }
        if (st.table === 'news_posts' && st.op === 'update') {
          return { data: { ...(h.post ?? {}), ...(st.payload ?? {}) }, error: null }
        }
        if (st.table === 'news_posts') return { data: h.post, error: null }
        return { data: null, error: null }
      }
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.is = () => b
      b.update = (rec: Record<string, unknown>) => {
        st.op = 'update'
        st.payload = rec
        h.update = { ...rec }
        return b
      }
      b.single = async () => risolvi()
      b.maybeSingle = async () => risolvi()
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(risolvi()).then(onF, onR)
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => makeClient(),
}))

import { POST as APPROVA } from '@/app/api/news/[id]/approva/route'

const A1 = '11111111-1111-4111-8111-111111111111'
const POST_ID = '33333333-3333-4333-8333-333333333333'
const FOTO = 'https://xyz.supabase.co/storage/v1/object/public/news/uploads/edu-1/foto.jpg'

const req = (body: unknown) =>
  ({
    url: `http://test/api/news/${POST_ID}/approva`,
    method: 'POST',
    headers: new Headers(),
    json: async () => body,
    cookies: { get: () => undefined },
  }) as never

const params = { params: Promise.resolve({ id: POST_ID }) } as never

/** La proposta di un docente, con la foto già promossa nel bucket PUBBLICO. */
const proposta = (extra: Record<string, unknown> = {}) => ({
  id: POST_ID,
  tipo: 'articolo',
  stato: 'proposta',
  titolo: 'Festa di fine anno',
  contenuto_json: { type: 'doc', content: [{ type: 'paragraph' }] },
  copertina_url: FOTO,
  scuola_id: 'sc-1',
  author_id: 'edu-1',
  target_scope: 'globale',
  invia_notifica: true,
  notifica_inviata_il: null,
  bambini_ritratti: [A1],
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.post = proposta()
  h.alunni = []
  h.errAlunni = null
  h.update = null
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
  h.notificaNewsPubblicata.mockResolvedValue(undefined)
})

describe('POST /api/news/[id]/approva — approvare è pubblicare, quindi passa dal gate', () => {
  it('consenso REVOCATO e approvazione che pubblica subito → rifiuto, nessun update, nessuna notifica', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await APPROVA(req({ esito: 'approva', pubblica_subito: true }), params)
    expect(res.status).toBe(422)
    expect(h.update, 'la proposta è stata pubblicata con la foto di un bambino senza consenso').toBeNull()
    expect(h.notificaNewsPubblicata).not.toHaveBeenCalled()
  })

  it('il ramo PREDEFINITO (senza `pubblica_subito`) pubblica lo stesso: stesso rifiuto', async () => {
    // `pubblica_subito !== false` significa che l'assenza del campo pubblica.
    // Un gate messo solo sul `true` esplicito lascerebbe aperta la strada normale.
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await APPROVA(req({ esito: 'approva' }), params)
    expect(res.status).toBe(422)
    expect(h.update).toBeNull()
  })

  it('CONTROLLO POSITIVO — stesso post con consenso valido → pubblicato e notificato', async () => {
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: true }]
    const res = await APPROVA(req({ esito: 'approva', pubblica_subito: true }), params)
    expect(res.status).toBe(200)
    expect(h.update?.stato).toBe('pubblicata')
    expect(h.update?.approvata_da).toBe('seg-1')
    expect(h.notificaNewsPubblicata).toHaveBeenCalledTimes(1)
  })

  it('consenso NON VERIFICABILE (colonna assente) → BLOCCA, non passa', async () => {
    // Fail-closed: «non lo so» non vale «sì». Vale qui come sulle altre tre rotte.
    h.errAlunni = { code: '42703', message: 'column "consenso_foto_sito" does not exist' }
    const res = await APPROVA(req({ esito: 'approva' }), params)
    expect(res.status).toBe(503)
    expect(h.update).toBeNull()
  })

  it('proposta SENZA foto → nessun gate, si approva e si pubblica', async () => {
    // Il gate scatta sulla FOTO, non sull'approvazione: un articolo di solo testo
    // non ritrae nessuno e non deve chiedere niente a nessuno.
    h.post = proposta({ copertina_url: null, bambini_ritratti: null })
    const res = await APPROVA(req({ esito: 'approva' }), params)
    expect(res.status).toBe(200)
    expect(h.update?.stato).toBe('pubblicata')
  })

  it('post STORICO con foto e senza dichiarazione → si approva (non si blocca l’archivio)', async () => {
    // `dichiarazioneObbligatoria: false`, come sulla pubblicazione: i post
    // anteriori al 2026-08-01 non hanno dichiarazione, e pretenderla qui
    // renderebbe impossibile approvare qualunque proposta vecchia. Dove il
    // contenuto NASCE o CAMBIA la dichiarazione resta obbligatoria.
    h.post = proposta({ bambini_ritratti: null })
    const res = await APPROVA(req({ esito: 'approva' }), params)
    expect(res.status).toBe(200)
    expect(h.update?.stato).toBe('pubblicata')
  })

  it('APPROVARE SENZA PUBBLICARE (`pubblica_subito: false`) non passa dal gate: resta bozza', async () => {
    // Il gate sta sul RENDERE VISIBILE, non sull'approvare. Una proposta tenuta
    // come bozza pronta non mette niente online, e bloccarla toglierebbe alla
    // segreteria l'unica mossa che le resta per gestire un consenso caduto.
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await APPROVA(req({ esito: 'approva', pubblica_subito: false }), params)
    expect(res.status).toBe(200)
    expect(h.update?.stato).toBe('bozza')
    expect(h.notificaNewsPubblicata).not.toHaveBeenCalled()
  })

  it('RIFIUTARE una proposta non passa dal gate: si deve poter sempre dire di no', async () => {
    // Se la revoca bloccasse anche il rifiuto, la proposta resterebbe appesa in
    // eterno: il gate diventerebbe un ostacolo alla revoca stessa.
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await APPROVA(req({ esito: 'rifiuta', motivo: 'Togliere la foto' }), params)
    expect(res.status).toBe(200)
    expect(h.update?.stato).toBe('bozza')
  })

  it('il rifiuto è QUELLO DEL GATE, non una prosa nuova scritta in questa route', async () => {
    // Il codice stabile è ciò che rende la risposta traducibile a schermo. Se
    // questa rotta si scrivesse un messaggio suo, il difetto sarebbe chiuso una
    // quarta volta invece che una: è esattamente ciò che si sta smettendo di fare.
    h.alunni = [{ id: A1, nome: 'Anna', cognome: 'B.', consenso_foto_sito: false }]
    const res = await APPROVA(req({ esito: 'approva' }), params)
    const j = (await res.json()) as { codice?: string }
    expect(j.codice).toBe('CONSENSO_FOTO_SITO_MANCANTE')
  })
})
