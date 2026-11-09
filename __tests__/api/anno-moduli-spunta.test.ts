import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * COMPITO 4.5.10 · la spunta dei moduli e «chi manca»:
 *   GET  /api/admin/frequenze/[frequenzaId]/moduli
 *   PUT  /api/admin/frequenze/[frequenzaId]/moduli
 *   GET  /api/admin/anni/[annoSedeId]/moduli-mancanti
 *
 * Il database è finto ma STATEFUL: tabelle in memoria che le query leggono e scrivono davvero (eq, in, lt, order, range, limit, insert/upsert/delete).
 * Il finto riproduce anche il CONTRATTO dei due trigger di `frequenze_moduli` — `frequenze_moduli_verifica` (ANNO_NON_COERENTE,
 * MODULO_NON_RICHIESTO) e il ricalcolo di `frequenze_assegna_e_calcola` — perché la route non scrive mai i flag: li rilegge. Che il
 * trigger vero faccia così lo prova `__tests__/db/anno-moduli-spunta.test.ts` su PGlite; qui si prova che la route si fidi del
 * database e non lo rifaccia (il finto lancia se la route prova a scrivere `frequenze`). Solo uuid finti.
 */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const ANNO_26 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' // l'anno in corso della SEDE_A (finisce il 2027-08-31)
const ANNO_27 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' // l'anno nuovo della SEDE_A
const ANNO_27_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' // l'anno nuovo della SEDE_B
const UTENTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AL1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const AL2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'
const AL3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3'
const F_NUOVA = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'
const F_NUOVA2 = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2'
const F_CONFERMA = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3'
const F_RECUPERO = 'f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4'
const F_RITIRATA = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5'
const F_ALTRA_SEDE = 'f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6'
const M_PRIVACY = '71717171-7171-4717-8717-717171717171' // lista nuova, ordine 1, NON del registro
const M_DELEGA = '72727272-7272-4727-8727-727272727272' // lista nuova, ordine 2, `delega_ritiro` (anno)
const M_SANITARIA = '73737373-7373-4737-8737-737373737373' // lista nuova, ordine 3, `scheda_sanitaria` (fino a revoca)
const M_CONFERMA = '74747474-7474-4747-8747-747474747474' // lista conferma
const M_ALTRA_SEDE = '75757575-7575-4757-8757-757575757575'
const PAG = '44444444-4444-4444-8444-444444444444'

type Riga = Record<string, unknown>
type Esito = { code?: string; message?: string }

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  db: {} as Record<string, Riga[]>,
  scritture: [] as Array<{ tabella: string; op: string; payload?: unknown; filtri?: Record<string, unknown> }>,
  query: [] as Array<{ tabella: string; colonne?: string; filtri: Record<string, unknown> }>,
  errori: {} as Record<string, Esito>,
  gateAmmessi: null as null | readonly string[],
  log: [] as Array<{ fn: 'evento' | 'errore' | 'ok'; args: unknown[] }>,
}))

/** Il contratto di `frequenze_assegna_e_calcola` (punto 4): i flag di una frequenza e le due transizioni di stato. */
function ricalcola(freqId: string): void {
  const f = h.db.frequenze.find((x) => x.id === freqId)
  if (!f) return
  const moduli =
    f.tipo == null
      ? false
      : h.db.moduli_richiesti
          .filter((m) => m.anno_sede_id === f.anno_sede_id && m.lista === f.tipo)
          .every((m) => h.db.frequenze_moduli.some((s) => s.frequenza_id === f.id && s.modulo_id === m.id))
  const quota = h.db.pagamenti.some((p) => p.id === f.quota_pagamento_id && p.stato === 'pagato')
  f.moduli_completi = moduli
  f.quota_saldata = quota
  if (f.stato === 'in_attesa' && moduli && quota) f.stato = 'iscritto'
  else if (f.stato === 'iscritto' && f.origine !== 'recupero' && !(moduli && quota)) f.stato = 'in_attesa'
}

/** Il contratto di `frequenze_moduli_verifica`: lo stesso anno_sede, e la lista del tipo della frequenza. */
function verifica(r: Riga): Esito | null {
  const f = h.db.frequenze.find((x) => x.id === r.frequenza_id)
  const m = h.db.moduli_richiesti.find((x) => x.id === r.modulo_id)
  if (!f || !m) return null
  if (m.anno_sede_id !== f.anno_sede_id) return { code: 'P0001', message: 'ANNO_NON_COERENTE' }
  if (m.lista !== f.tipo) return { code: 'P0001', message: 'MODULO_NON_RICHIESTO' }
  return null
}

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async (_request: Request, allowed: readonly string[] = ['admin', 'coordinator', 'segreteria']) => {
    h.gateAmmessi = allowed
    if (!h.user) return { user: null, response: new Response(JSON.stringify({ error: 'no' }), { status: 401 }) }
    if (!allowed.includes(h.user.role)) return { user: null, response: new Response(JSON.stringify({ error: 'vietato' }), { status: 403 }) }
    return { user: h.user, response: null }
  },
}))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async (_s: unknown, u: { scuola_id?: string | null }) => (u.scuola_id ? [u.scuola_id] : []),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      const q: { tabella: string; colonne?: string; filtri: Record<string, unknown> } = { tabella, filtri: {} }
      h.query.push(q)
      const cond: Array<(r: Riga) => boolean> = []
      let op: 'select' | 'insert' | 'upsert' | 'delete' | 'update' = 'select'
      let payload: unknown
      let ignora = false
      const ordini: Array<[string, boolean]> = []
      let range: [number, number] | undefined
      let limite: number | undefined
      const b: Record<string, unknown> = {}
      b.select = (colonne?: string) => {
        q.colonne = colonne
        return b
      }
      b.eq = (c: string, v: unknown) => {
        q.filtri[c] = v
        cond.push((r) => r[c] === v)
        return b
      }
      b.in = (c: string, v: unknown) => {
        q.filtri[`in:${c}`] = v
        cond.push((r) => (v as unknown[]).includes(r[c]))
        return b
      }
      b.is = (c: string, v: unknown) => {
        q.filtri[`is:${c}`] = v
        cond.push((r) => (r[c] ?? null) === v)
        return b
      }
      b.lt = (c: string, v: unknown) => {
        q.filtri[`lt:${c}`] = v
        cond.push((r) => String(r[c]) < String(v))
        return b
      }
      b.order = (c: string, o?: { ascending?: boolean }) => {
        ordini.push([c, o?.ascending !== false])
        return b
      }
      b.range = (da: number, a: number) => {
        range = [da, a]
        return b
      }
      b.limit = (n: number) => {
        limite = n
        return b
      }
      b.insert = (p: unknown) => {
        op = 'insert'
        payload = p
        return b
      }
      b.upsert = (p: unknown, o?: { ignoreDuplicates?: boolean }) => {
        op = 'upsert'
        payload = p
        ignora = o?.ignoreDuplicates === true
        return b
      }
      b.delete = () => {
        op = 'delete'
        return b
      }
      b.update = (p: unknown) => {
        op = 'update'
        payload = p
        return b
      }
      const esegui = (): { data: unknown; error: Esito | null; count?: number } => {
        const errore = h.errori[`${tabella}:${op}`]
        if (errore) return { data: null, error: errore }
        const righe = (h.db[tabella] ??= [])
        if (op === 'select') {
          let r = righe.filter((x) => cond.every((c) => c(x)))
          for (const [c, asc] of [...ordini].reverse()) r = [...r].sort((x, y) => (asc ? 1 : -1) * String(x[c]).localeCompare(String(y[c])))
          if (range) r = r.slice(range[0], range[1] + 1)
          if (limite !== undefined) r = r.slice(0, limite)
          return { data: r.map((x) => ({ ...x })), error: null, count: r.length }
        }
        h.scritture.push({ tabella, op, payload, filtri: { ...q.filtri } })
        // La route NON scrive mai i flag: se prova a toccare `frequenze` il test deve cadere.
        if (tabella === 'frequenze') throw new Error('la route non deve scrivere frequenze: i flag li ricalcola il trigger')
        if (tabella === 'frequenze_moduli' && (op === 'insert' || op === 'upsert')) {
          const nuova: Riga = { ...(payload as Riga), spuntato_il: '2027-03-01T10:00:00Z' }
          const err = verifica(nuova)
          if (err) return { data: null, error: err }
          const doppia = righe.some((x) => x.frequenza_id === nuova.frequenza_id && x.modulo_id === nuova.modulo_id)
          if (doppia && !ignora) return { data: null, error: { code: '23505', message: 'duplicate key' } }
          if (!doppia) {
            righe.push(nuova)
            ricalcola(String(nuova.frequenza_id))
          }
        } else if (tabella === 'frequenze_moduli' && op === 'delete') {
          const via = righe.filter((x) => cond.every((c) => c(x)))
          h.db[tabella] = righe.filter((x) => !via.includes(x))
          for (const x of via) ricalcola(String(x.frequenza_id))
        } else if (tabella === 'fascicolo_accessi_audit' && op === 'insert') {
          righe.push(payload as Riga)
        }
        return { data: null, error: null }
      }
      b.maybeSingle = async () => {
        const r = esegui()
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }
      }
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(esegui).then(ok, ko)
      return b
    },
  }),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...args: unknown[]) => void h.log.push({ fn: 'evento', args }),
  logErrore: (...args: unknown[]) => void h.log.push({ fn: 'errore', args }),
  logOk: (...args: unknown[]) => void h.log.push({ fn: 'ok', args }),
}))

import { redact } from '@/lib/logging/redact'
import { GET as moduliGET, PUT as moduliPUT } from '@/app/api/admin/frequenze/[frequenzaId]/moduli/route'
import { GET as mancantiGET } from '@/app/api/admin/anni/[annoSedeId]/moduli-mancanti/route'

const ctxFreq = (id: string) => ({ params: Promise.resolve({ frequenzaId: id }) })
const ctxAnno = (id: string) => ({ params: Promise.resolve({ annoSedeId: id }) })
const urlFreq = (id: string) => `http://localhost/api/admin/frequenze/${id}/moduli`
const leggi = (id = F_NUOVA) => moduliGET(new Request(urlFreq(id)) as never, ctxFreq(id) as never)
const spunta = (corpo: unknown, id = F_NUOVA) =>
  moduliPUT(
    new Request(urlFreq(id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) }) as never,
    ctxFreq(id) as never,
  )
const mancanti = (id = ANNO_27) => mancantiGET(new Request(`http://localhost/api/admin/anni/${id}/moduli-mancanti`) as never, ctxAnno(id) as never)

const eventi = (tipo: string) =>
  h.log
    .filter((l) => l.fn === 'evento')
    .map((l) => ({ livello: l.args[1] as string, campi: l.args[2] as Record<string, unknown> }))
    .filter((e) => e.campi?.tipo === tipo)

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

function frequenza(id: string, over: Riga = {}): Riga {
  return {
    id,
    alunno_id: AL1,
    anno_sede_id: ANNO_27,
    tipo: 'nuova',
    origine: 'segreteria',
    stato: 'in_attesa',
    moduli_completi: false,
    quota_saldata: false,
    quota_pagamento_id: null,
    ...over,
  }
}

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.db = {
    anni_sede: [
      // finisce il 31/08/2027 e l'ultimo giorno aperto è il 31/07/2027; il nuovo comincia il 01/09/2027
      { id: ANNO_26, scuola_id: SEDE_A, inizio: '2026-09-01', fine: '2027-08-31', ultimo_giorno_aperto: '2027-07-31', stato: 'corrente' },
      { id: ANNO_27, scuola_id: SEDE_A, inizio: '2027-09-01', fine: '2028-08-31', ultimo_giorno_aperto: '2028-07-31', stato: 'iscrizioni_aperte' },
      { id: ANNO_27_B, scuola_id: SEDE_B, inizio: '2027-09-01', fine: '2028-08-31', ultimo_giorno_aperto: '2028-07-31', stato: 'iscrizioni_aperte' },
    ],
    moduli_richiesti: [
      { id: M_PRIVACY, anno_sede_id: ANNO_27, lista: 'nuova', codice: 'privacy_cartacea', titolo: 'Informativa privacy', ordine: 1 },
      { id: M_DELEGA, anno_sede_id: ANNO_27, lista: 'nuova', codice: 'delega_ritiro', titolo: 'Delega al ritiro', ordine: 2 },
      { id: M_SANITARIA, anno_sede_id: ANNO_27, lista: 'nuova', codice: 'scheda_sanitaria', titolo: 'Scheda sanitaria', ordine: 3 },
      { id: M_CONFERMA, anno_sede_id: ANNO_27, lista: 'conferma', codice: 'patto', titolo: 'Patto di corresponsabilità', ordine: 1 },
      { id: M_ALTRA_SEDE, anno_sede_id: ANNO_27_B, lista: 'nuova', codice: 'privacy_cartacea', titolo: 'Informativa privacy', ordine: 1 },
    ],
    frequenze: [
      frequenza(F_NUOVA),
      frequenza(F_NUOVA2, { alunno_id: AL2 }),
      frequenza(F_CONFERMA, { alunno_id: AL3, tipo: 'conferma' }),
      frequenza(F_RECUPERO, { tipo: null, origine: 'recupero', stato: 'iscritto' }),
      frequenza(F_RITIRATA, { stato: 'ritirato' }),
      frequenza(F_ALTRA_SEDE, { anno_sede_id: ANNO_27_B }),
    ],
    frequenze_moduli: [],
    pagamenti: [{ id: PAG, stato: 'pagato' }],
    student_documents: [],
    fascicolo_accessi_audit: [],
  }
  h.scritture = []
  h.query = []
  h.errori = {}
  h.gateAmmessi = null
  h.log = []
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Gate, uuid, perimetro: uguali per le tre chiamate
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CHIAMATE: Array<[string, (id?: string) => Promise<Response>, string, string]> = [
  ['GET moduli di una frequenza', (id) => leggi(id), F_NUOVA, F_ALTRA_SEDE],
  ['PUT moduli di una frequenza', (id) => spunta({ modulo_id: M_PRIVACY, spuntato: true }, id), F_NUOVA, F_ALTRA_SEDE],
  ['GET moduli-mancanti', (id) => mancanti(id), ANNO_27, ANNO_27_B],
]

describe.each(CHIAMATE)('gate e perimetro — %s', (_nome, chiama, idMio, idAltraSede) => {
  it('401 senza identità, senza toccare il database', async () => {
    h.user = null
    expect((await chiama(idMio)).status).toBe(401)
    expect(h.query).toEqual([])
  })

  it.each(['educator', 'genitore', 'cuoca'])('403 a un utente %s, senza toccare il database', async (ruolo) => {
    h.user = { id: UTENTE, role: ruolo, scuola_id: SEDE_A }
    expect((await chiama(idMio)).status).toBe(403)
    expect(h.query).toEqual([])
  })

  it('il gate è quello dello staff, con la lista dei ruoli della route', async () => {
    await chiama(idMio)
    expect(h.gateAmmessi).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it('400 se l’id non è un uuid', async () => {
    expect((await chiama('non-un-uuid')).status).toBe(400)
    expect(h.query).toEqual([])
  })

  it('404 per un id che non esiste', async () => {
    expect((await chiama('99999999-9999-4999-8999-999999999999')).status).toBe(404)
    expect(h.scritture).toEqual([])
  })

  it('403 per un anno (o una frequenza) di un’altra sede, senza scrivere né leggere moduli', async () => {
    const r = await chiama(idAltraSede)
    expect(r.status).toBe(403)
    expect(h.scritture).toEqual([])
    expect(h.query.filter((x) => ['moduli_richiesti', 'frequenze_moduli', 'student_documents'].includes(x.tabella))).toEqual([])
  })

  it('un amministratore di un’altra sede riceve 403 anche sul proprio idMio', async () => {
    h.user = { id: UTENTE, role: 'admin', scuola_id: SEDE_B }
    expect((await chiama(idMio)).status).toBe(403)
    expect(h.scritture).toEqual([])
  })

  it('schema dell’anno assente (il database della CI) → 503, mai 500', async () => {
    h.errori['anni_sede:select'] = { code: 'PGRST205', message: 'tabella assente' }
    expect((await chiama(idMio)).status).toBe(503)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET dei moduli di una frequenza
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GET moduli di una frequenza', () => {
  it('elenca SOLO i moduli della lista del tipo della frequenza, nell’ordine, con la spunta', async () => {
    h.db.frequenze_moduli.push({ frequenza_id: F_NUOVA, modulo_id: M_DELEGA, spuntato_il: '2027-03-01T10:00:00Z' })
    const r = await leggi()
    expect(r.status).toBe(200)
    const { moduli } = (await r.json()).data
    expect(moduli.map((m: { modulo_id: string }) => m.modulo_id)).toEqual([M_PRIVACY, M_DELEGA, M_SANITARIA])
    expect(moduli.map((m: { spuntato: boolean }) => m.spuntato)).toEqual([false, true, false])
    expect(moduli[1].spuntato_il).toBe('2027-03-01T10:00:00Z')
    expect(moduli[0]).toEqual({
      modulo_id: M_PRIVACY, codice: 'privacy_cartacea', titolo: 'Informativa privacy', ordine: 1,
      spuntato: false, spuntato_il: null, firmato_in_app_il: null,
    })
  })

  it('una frequenza di conferma vede i moduli della lista conferma, non quelli delle nuove', async () => {
    const { moduli } = (await (await leggi(F_CONFERMA)).json()).data
    expect(moduli.map((m: { modulo_id: string }) => m.modulo_id)).toEqual([M_CONFERMA])
  })

  it('una frequenza senza tipo (il recupero) non ha moduli', async () => {
    const { moduli } = (await (await leggi(F_RECUPERO)).json()).data
    expect(moduli).toEqual([])
  })

  it('`firmato_in_app_il` è INFORMATIVO: dice il giorno della firma e NON spunta niente', async () => {
    h.db.student_documents.push({ student_id: AL1, document_type: 'delega_ritiro', created_at: '2027-10-05T09:00:00Z' })
    const { moduli } = (await (await leggi()).json()).data
    const delega = moduli.find((m: { modulo_id: string }) => m.modulo_id === M_DELEGA)
    expect(delega.firmato_in_app_il).toBe('2027-10-05')
    expect(delega.spuntato).toBe(false)
    expect(scrittureSu('frequenze_moduli')).toEqual([])
    expect(h.db.frequenze_moduli).toEqual([])
  })

  it('modulo ANNUALE: la firma dell’anno scorso non vale; la firma dell’anno della frequenza sì', async () => {
    h.db.student_documents.push({ student_id: AL1, document_type: 'delega_ritiro', created_at: '2026-10-05T09:00:00Z' })
    let delega = (await (await leggi()).json()).data.moduli.find((m: { modulo_id: string }) => m.modulo_id === M_DELEGA)
    expect(delega.firmato_in_app_il).toBeNull()
    // firmata fra l'ultimo giorno aperto dell'anno prima e l'inizio del nuovo: è del nuovo anno
    h.db.student_documents.push({ student_id: AL1, document_type: 'delega_ritiro', created_at: '2027-08-20T09:00:00Z' })
    delega = (await (await leggi()).json()).data.moduli.find((m: { modulo_id: string }) => m.modulo_id === M_DELEGA)
    expect(delega.firmato_in_app_il).toBe('2027-08-20')
  })

  it('modulo FINO A REVOCA: vale anche una firma di un anno prima', async () => {
    h.db.student_documents.push({ student_id: AL1, document_type: 'scheda_sanitaria', created_at: '2026-10-05T09:00:00Z' })
    const sanitaria = (await (await leggi()).json()).data.moduli.find((m: { modulo_id: string }) => m.modulo_id === M_SANITARIA)
    expect(sanitaria.firmato_in_app_il).toBe('2026-10-05')
  })

  it('la firma di un ALTRO bambino non è la sua', async () => {
    h.db.student_documents.push({ student_id: AL2, document_type: 'delega_ritiro', created_at: '2027-10-05T09:00:00Z' })
    const delega = (await (await leggi()).json()).data.moduli.find((m: { modulo_id: string }) => m.modulo_id === M_DELEGA)
    expect(delega.firmato_in_app_il).toBeNull()
  })

  it('il fascicolo si apre solo se un modulo è del registro, e la lettura passa dal registro degli accessi', async () => {
    h.db.student_documents.push({ student_id: AL1, document_type: 'delega_ritiro', created_at: '2027-10-05T09:00:00Z' })
    await leggi()
    expect(h.query.some((x) => x.tabella === 'student_documents')).toBe(true)
    expect(scrittureSu('fascicolo_accessi_audit')).toHaveLength(1)
    expect(h.db.fascicolo_accessi_audit[0]).toMatchObject({ alunno_id: AL1, utente_id: UTENTE, azione: 'list' })

    // una lista di soli moduli fuori registro: il fascicolo non si tocca
    h.query = []
    h.scritture = []
    h.db.moduli_richiesti = h.db.moduli_richiesti.filter((m) => m.id === M_PRIVACY || m.lista !== 'nuova')
    await leggi()
    expect(h.query.some((x) => x.tabella === 'student_documents')).toBe(false)
    expect(scrittureSu('fascicolo_accessi_audit')).toEqual([])
  })

  it('il fascicolo non si legge con una colonna sanitaria: solo tipo e data del documento', async () => {
    await leggi()
    const lettura = h.query.find((x) => x.tabella === 'student_documents')
    expect(lettura?.colonne).toBe('document_type, created_at')
  })

  it('un guasto nel leggere il fascicolo è un errore, non «nessuna firma»', async () => {
    h.errori['student_documents:select'] = { code: 'XX000', message: 'boom' }
    expect((await leggi()).status).toBe(500)
  })

  it('nel log solo uuid, numeri e codici: nessun nome', async () => {
    await leggi()
    const e = eventi('moduli-frequenza-letti')
    expect(e).toHaveLength(1)
    expect(e[0].livello).toBe('info')
    expect(JSON.stringify(redact(e[0].campi))).not.toMatch(/Informativa|delega_ritiro|privacy/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PUT: la spunta
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PUT la spunta', () => {
  it('spuntare inserisce la riga con chi l’ha fatto, e il database ricalcola: la route non scrive mai `frequenze`', async () => {
    const r = await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    expect(r.status).toBe(200)
    expect(h.db.frequenze_moduli).toHaveLength(1)
    expect(h.db.frequenze_moduli[0]).toMatchObject({ frequenza_id: F_NUOVA, modulo_id: M_PRIVACY, spuntato_da: UTENTE })
    expect(scrittureSu('frequenze')).toEqual([])
    expect((await r.json()).data).toMatchObject({ frequenza_id: F_NUOVA, modulo_id: M_PRIVACY, spuntato: true, moduli_completi: false, quota_saldata: false, stato: 'in_attesa' })
  })

  it('spuntati TUTTI i moduli e quota pagata → `iscritto` (lo dice il database, la route lo riporta)', async () => {
    h.db.frequenze[0].quota_pagamento_id = PAG
    ricalcola(F_NUOVA)
    await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    await spunta({ modulo_id: M_DELEGA, spuntato: true })
    const r = await spunta({ modulo_id: M_SANITARIA, spuntato: true })
    expect((await r.json()).data).toMatchObject({ moduli_completi: true, quota_saldata: true, stato: 'iscritto' })
  })

  it('spuntati tutti ma quota NON saldata → `in_attesa`: i moduli da soli non iscrivono', async () => {
    await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    await spunta({ modulo_id: M_DELEGA, spuntato: true })
    const r = await spunta({ modulo_id: M_SANITARIA, spuntato: true })
    expect((await r.json()).data).toMatchObject({ moduli_completi: true, quota_saldata: false, stato: 'in_attesa' })
  })

  it('togliere una spunta riporta `in_attesa` chi era `iscritto`', async () => {
    h.db.frequenze[0].quota_pagamento_id = PAG
    for (const m of [M_PRIVACY, M_DELEGA, M_SANITARIA]) await spunta({ modulo_id: m, spuntato: true })
    expect(h.db.frequenze[0].stato).toBe('iscritto')
    const r = await spunta({ modulo_id: M_DELEGA, spuntato: false })
    expect(r.status).toBe(200)
    expect((await r.json()).data).toMatchObject({ spuntato: false, moduli_completi: false, stato: 'in_attesa' })
    expect(h.db.frequenze_moduli).toHaveLength(2)
    expect(scrittureSu('frequenze')).toEqual([])
  })

  it('un modulo di un’ALTRA lista → 422 MODULO_NON_RICHIESTO, e non si scrive niente', async () => {
    const r = await spunta({ modulo_id: M_CONFERMA, spuntato: true })
    expect(r.status).toBe(422)
    const corpo = await r.json()
    expect(corpo.codice).toBe('MODULO_NON_RICHIESTO')
    expect(corpo.error).toBe('Questo modulo non è richiesto per questo tipo di iscrizione.')
    expect(h.db.frequenze_moduli).toEqual([])
  })

  it('un modulo di un altro anno_sede → 422 ANNO_NON_COERENTE', async () => {
    const r = await spunta({ modulo_id: M_ALTRA_SEDE, spuntato: true })
    expect(r.status).toBe(422)
    expect((await r.json()).codice).toBe('ANNO_NON_COERENTE')
    expect(h.db.frequenze_moduli).toEqual([])
  })

  it('spuntare due volte è come spuntare una: 200 e una sola riga, con la data della prima', async () => {
    await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    const r = await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    expect(r.status).toBe(200)
    expect(h.db.frequenze_moduli).toHaveLength(1)
  })

  it('togliere una spunta che non c’è è un 200 che non cambia niente', async () => {
    const r = await spunta({ modulo_id: M_PRIVACY, spuntato: false })
    expect(r.status).toBe(200)
    expect((await r.json()).data).toMatchObject({ spuntato: false, stato: 'in_attesa' })
  })

  it('togliere cancella SOLO la coppia nominata', async () => {
    await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    await spunta({ modulo_id: M_PRIVACY, spuntato: true }, F_NUOVA2)
    await spunta({ modulo_id: M_PRIVACY, spuntato: false })
    expect(h.db.frequenze_moduli.map((x) => x.frequenza_id)).toEqual([F_NUOVA2])
  })

  it('un anno chiuso non si tocca: 409 ANNO_CHIUSO e nessuna scrittura', async () => {
    h.db.anni_sede.find((a) => a.id === ANNO_27)!.stato = 'chiuso'
    const r = await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    expect(r.status).toBe(409)
    expect((await r.json()).codice).toBe('ANNO_CHIUSO')
    expect(h.scritture).toEqual([])
  })

  it.each([
    ['un campo in più', { modulo_id: M_PRIVACY, spuntato: true, moduli_completi: true }],
    ['`spuntato` non booleano', { modulo_id: M_PRIVACY, spuntato: 'si' }],
    ['`spuntato` assente', { modulo_id: M_PRIVACY }],
    ['modulo_id non uuid', { modulo_id: 'privacy', spuntato: true }],
    ['corpo vuoto', {}],
  ])('400 per %s, senza scrivere', async (_n, corpo) => {
    expect((await spunta(corpo)).status).toBe(400)
    expect(h.scritture).toEqual([])
  })

  it('un guasto del database è un 500 loggato, mai un 200', async () => {
    h.errori['frequenze_moduli:upsert'] = { code: 'XX000', message: 'boom' }
    const r = await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    expect(r.status).toBe(500)
    expect(h.log.some((l) => l.fn === 'errore')).toBe(true)
  })

  it('il successo si logga: uuid, booleani e codici, nessun nome', async () => {
    await spunta({ modulo_id: M_PRIVACY, spuntato: true })
    const e = eventi('modulo-spuntato')
    expect(e).toHaveLength(1)
    expect(e[0].livello).toBe('info')
    expect(e[0].campi).toMatchObject({ frequenza_id: F_NUOVA, modulo_id: M_PRIVACY, spuntato: true, moduli_completi: false, quota_saldata: false, stato: 'in_attesa', utente: UTENTE })
    expect(Object.keys(e[0].campi).sort()).toEqual(
      ['anno_sede_id', 'frequenza_id', 'moduli_completi', 'modulo_id', 'operazione', 'quota_saldata', 'spuntato', 'stato', 'tipo', 'utente'],
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GET moduli-mancanti: conta, non nomina
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('GET moduli-mancanti', () => {
  it('per modulo: quante frequenze vive della sua lista non lo hanno spuntato, e quali (uuid)', async () => {
    h.db.frequenze_moduli.push({ frequenza_id: F_NUOVA, modulo_id: M_PRIVACY }, { frequenza_id: F_NUOVA, modulo_id: M_DELEGA })
    const r = await mancanti()
    expect(r.status).toBe(200)
    const { moduli } = (await r.json()).data
    const per = Object.fromEntries(moduli.map((m: { modulo_id: string }) => [m.modulo_id, m]))
    // lista nuova: vive sono F_NUOVA e F_NUOVA2 (la ritirata, il recupero e la frequenza dell'altra sede non contano)
    expect(per[M_PRIVACY]).toEqual({ modulo_id: M_PRIVACY, codice: 'privacy_cartacea', titolo: 'Informativa privacy', firma_in_app: false, lista: 'nuova', mancanti: 1, frequenze: [F_NUOVA2] })
    expect(per[M_DELEGA]).toMatchObject({ mancanti: 1, frequenze: [F_NUOVA2] })
    expect(per[M_SANITARIA]).toMatchObject({ mancanti: 2, frequenze: [F_NUOVA, F_NUOVA2] })
    // lista conferma: la sola frequenza di conferma
    expect(per[M_CONFERMA]).toMatchObject({ lista: 'conferma', mancanti: 1, frequenze: [F_CONFERMA] })
    // il modulo di un altro anno_sede non c'è
    expect(per[M_ALTRA_SEDE]).toBeUndefined()
  })

  it('CONTA e non nomina: nessun nome, nessun alunno_id, e la tabella dei bambini non si legge', async () => {
    const corpo = JSON.stringify(await (await mancanti()).json())
    expect(corpo).not.toContain(AL1)
    expect(corpo).not.toMatch(/nome|cognome|alunno/i)
    expect(h.query.map((x) => x.tabella)).not.toContain('alunni')
    expect(h.query.map((x) => x.tabella)).not.toContain('student_documents')
  })

  it('chi ha spuntato tutto non compare più', async () => {
    for (const m of [M_PRIVACY, M_DELEGA, M_SANITARIA]) h.db.frequenze_moduli.push({ frequenza_id: F_NUOVA, modulo_id: m }, { frequenza_id: F_NUOVA2, modulo_id: m })
    const { moduli } = (await (await mancanti()).json()).data
    for (const m of moduli.filter((x: { lista: string }) => x.lista === 'nuova')) expect(m).toMatchObject({ mancanti: 0, frequenze: [] })
  })

  it('un anno senza moduli risponde con un elenco vuoto, senza leggere le frequenze', async () => {
    h.db.moduli_richiesti = []
    const r = await mancanti()
    expect(r.status).toBe(200)
    expect((await r.json()).data.moduli).toEqual([])
    expect(h.query.map((x) => x.tabella)).not.toContain('frequenze')
  })

  it('una lettura fallita è un errore, non un elenco vuoto', async () => {
    h.errori['frequenze:select'] = { code: 'XX000', message: 'boom' }
    expect((await mancanti()).status).toBe(500)
  })

  it('il successo si logga con il numero di moduli, nessun nome', async () => {
    await mancanti()
    const e = eventi('moduli-mancanti-letti')
    expect(e).toHaveLength(1)
    expect(e[0].campi).toMatchObject({ n: 4, utente: UTENTE, anno_sede_id: ANNO_27 })
  })
})
