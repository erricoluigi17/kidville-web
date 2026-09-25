// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * FASCICOLO — modifica, sostituzione del file, cestino, ripristino (spec 2026-09-24, F1).
 *
 * Il finto client REGISTRA ogni catena PostgREST (metodo e argomenti) invece di
 * rispondere sempre la stessa cosa: le prove guardano i FILTRI (`eliminato_il IS
 * NULL`, `IS NOT NULL`, la soglia dei giorni di custodia), i PAYLOAD (quali campi
 * vengono scritti, cosa si copia nella riga nuova) e gli ESITI (403 al docente non
 * autore, 409 alla corsa persa). Un mock piatto qui sarebbe verde anche senza il
 * cestino.
 */

const rbac = vi.hoisted(() => ({
  puoAccedereFascicolo: vi.fn(),
  logAccessoFascicolo: vi.fn(),
}))
vi.mock('@/lib/primaria/fascicolo-rbac', () => rbac)

const audit = vi.hoisted(() => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => audit)

const notifiche = vi.hoisted(() => ({ notificaTitolariScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => notifiche)

const auth = vi.hoisted(() => ({ resolveIdentity: vi.fn(), loadAppUser: vi.fn(), getRequestUserId: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => auth)

type Chiamata = [string, unknown[]]
type Query = { tabella: string; chiamate: Chiamata[] }
type Esito = { data: unknown; error: unknown }

const h = vi.hoisted(() => {
  const state = {
    code: {} as Record<string, Esito[]>,
    usate: {} as Record<string, number>,
    query: [] as Query[],
    storage: [] as Array<{ bucket: string; metodo: string; args: unknown[] }>,
    esitoUpload: { data: { path: 'x' }, error: null } as Esito,
    esitoRemove: { data: [], error: null } as Esito,
  }
  function prendi(tabella: string): Esito {
    const coda = state.code[tabella] ?? []
    const i = state.usate[tabella] ?? 0
    state.usate[tabella] = i + 1
    return coda[i] ?? { data: null, error: null }
  }
  function client() {
    return {
      from(tabella: string) {
        const q: Query = { tabella, chiamate: [] }
        state.query.push(q)
        let esito: Esito | null = null
        const risolvi = () => (esito ??= prendi(tabella))
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in', 'is', 'not', 'gte', 'lt', 'lte', 'order', 'limit', 'update', 'insert', 'delete', 'upsert']) {
          qb[m] = (...args: unknown[]) => { q.chiamate.push([m, args]); return qb }
        }
        qb.single = () => { q.chiamate.push(['single', []]); return Promise.resolve(risolvi()) }
        qb.maybeSingle = () => { q.chiamate.push(['maybeSingle', []]); return Promise.resolve(risolvi()) }
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(res, rej)
        return qb
      },
      storage: {
        from(bucket: string) {
          return {
            upload: (...args: unknown[]) => { state.storage.push({ bucket, metodo: 'upload', args }); return Promise.resolve(state.esitoUpload) },
            remove: (...args: unknown[]) => { state.storage.push({ bucket, metodo: 'remove', args }); return Promise.resolve(state.esitoRemove) },
          }
        },
      },
    }
  }
  return { state, client }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => h.client()),
}))

import { GET as ELENCO, POST as CARICA, PATCH, DELETE } from '@/app/api/primaria/fascicolo/route'
import { POST as SOSTITUISCI } from '@/app/api/primaria/fascicolo/sostituisci/route'
import { GET as CESTINO, POST as RIPRISTINA } from '@/app/api/primaria/fascicolo/cestino/route'
import { GIORNI_CESTINO_REGISTRO } from '@/lib/primaria/cestino-registro'

const UTENTE = '11111111-1111-4111-8111-111111111111'
const ALTRO = '22222222-2222-4222-8222-222222222222'
const ALUNNO = '33333333-3333-4333-8333-333333333333'
const DOC = '44444444-4444-4444-8444-444444444444'
const NUOVO = '55555555-5555-4555-8555-555555555555'
const SEZIONE = '66666666-6666-4666-8666-666666666666'
const GIORNO_MS = 24 * 60 * 60 * 1000

const STAFF = { consentito: true, ruolo: 'segreteria', motivo: 'staff' }
/**
 * Il gate riconosce il plesso (motivo `staff`) ma il ruolo NON è fra quelli che
 * gestiscono i documenti altrui (`RUOLI_GESTIONE_FASCICOLO`): il motivo dice perché
 * si legge, non chi si è.
 */
const STAFF_RUOLO_ESTRANEO = { consentito: true, ruolo: 'kitchen', motivo: 'staff' }
/** Lo slug di un prestampato: una riga di `student_documents` che NON è del fascicolo. */
const TIPO_PRESTAMPATO = 'autorizzazione-uscite-didattiche'
const CONTITOLARE = { consentito: true, ruolo: 'educator', motivo: 'contitolare' }

function documento(extra: Record<string, unknown> = {}) {
  return {
    id: DOC,
    student_id: ALUNNO,
    section_id: SEZIONE,
    document_type: 'pei',
    descrizione: 'Descrizione di prova',
    file_name: 'vecchio.pdf',
    expiry_date: '2027-06-30',
    created_at: '2026-09-01T08:00:00.000Z',
    caricato_da: UTENTE,
    ...extra,
  }
}

function json(url: string, method: string, body: unknown) {
  return new NextRequest(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function multipart(url: string, campi: Record<string, string | File>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(campi)) fd.append(k, v)
  return new NextRequest(url, { method: 'POST', body: fd })
}

const queryDi = (tabella: string) => h.state.query.filter((q) => q.tabella === tabella)
const ha = (q: Query, metodo: string, ...args: unknown[]) =>
  q.chiamate.some(([m, a]) => m === metodo && args.every((x, i) => JSON.stringify(a[i]) === JSON.stringify(x)))
const argomenti = (q: Query, metodo: string) => q.chiamate.find(([m]) => m === metodo)?.[1]

beforeEach(() => {
  vi.clearAllMocks()
  h.state.code = {}
  h.state.usate = {}
  h.state.query = []
  h.state.storage = []
  h.state.esitoUpload = { data: { path: 'x' }, error: null }
  h.state.esitoRemove = { data: [], error: null }
  auth.resolveIdentity.mockResolvedValue({ userId: UTENTE, source: 'session' })
  auth.loadAppUser.mockResolvedValue({ id: UTENTE, role: 'segreteria', scuola_id: null })
  rbac.puoAccedereFascicolo.mockResolvedValue(STAFF)
  rbac.logAccessoFascicolo.mockResolvedValue(undefined)
  audit.logScrittura.mockResolvedValue(undefined)
  notifiche.notificaTitolariScrittura.mockResolvedValue(undefined)
})

describe('GET /api/primaria/fascicolo — l’elenco esclude il cestino', () => {
  it('filtra eliminato_il IS NULL', async () => {
    h.state.code = { student_documents: [{ data: [], error: null }] }
    const res = await ELENCO(new NextRequest(`http://localhost/api/primaria/fascicolo?alunnoId=${ALUNNO}`))
    expect(res.status).toBe(200)
    const [q] = queryDi('student_documents')
    expect(ha(q, 'is', 'eliminato_il', null)).toBe(true)
    expect(ha(q, 'eq', 'student_id', ALUNNO)).toBe(true)
  })
})

describe('PATCH /api/primaria/fascicolo', () => {
  it('scrive SOLO i campi presenti, e solo su un documento vivo', async () => {
    h.state.code = { student_documents: [{ data: documento(), error: null }, { data: documento({ expiry_date: null }), error: null }] }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, expiryDate: null }))
    expect(res.status).toBe(200)
    const [lettura, scrittura] = queryDi('student_documents')
    expect(ha(lettura, 'is', 'eliminato_il', null)).toBe(true)
    expect(argomenti(scrittura, 'update')).toEqual([{ expiry_date: null }])
    expect(ha(scrittura, 'eq', 'id', DOC)).toBe(true)
    expect(ha(scrittura, 'is', 'eliminato_il', null)).toBe(true)
    expect(audit.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'fascicolo', entitaId: DOC, azione: 'update' }),
    )
  })

  it('tipo e descrizione: il payload li porta tutti e due', async () => {
    h.state.code = { student_documents: [{ data: documento(), error: null }, { data: documento({ document_type: 'pdp' }), error: null }] }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, documentType: 'pdp', descrizione: '  Nuova  ' }))
    expect(res.status).toBe(200)
    expect(argomenti(queryDi('student_documents')[1], 'update')).toEqual([{ document_type: 'pdp', descrizione: 'Nuova' }])
  })

  it('senza campi: 400 FASCICOLO_NIENTE_DA_MODIFICARE, e il DB non viene toccato', async () => {
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('FASCICOLO_NIENTE_DA_MODIFICARE')
    expect(queryDi('student_documents')).toHaveLength(0)
  })

  it('docente contitolare NON autore: 403 FASCICOLO_GESTIONE_NEGATA, nessuna scrittura', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue(CONTITOLARE)
    h.state.code = { student_documents: [{ data: documento({ caricato_da: ALTRO }), error: null }] }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, descrizione: 'x' }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('FASCICOLO_GESTIONE_NEGATA')
    expect(queryDi('student_documents')).toHaveLength(1)
    expect(audit.logScrittura).not.toHaveBeenCalled()
  })

  it('docente contitolare AUTORE: può modificare (nessun termine)', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue(CONTITOLARE)
    h.state.code = {
      student_documents: [
        { data: documento({ created_at: '2020-01-01T00:00:00.000Z' }), error: null },
        { data: documento(), error: null },
      ],
    }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, descrizione: 'x' }))
    expect(res.status).toBe(200)
  })

  it('motivo staff ma ruolo fuori da RUOLI_GESTIONE_FASCICOLO, non autore: 403, nessuna scrittura', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue(STAFF_RUOLO_ESTRANEO)
    h.state.code = { student_documents: [{ data: documento({ caricato_da: ALTRO }), error: null }] }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, descrizione: 'x' }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('FASCICOLO_GESTIONE_NEGATA')
    expect(queryDi('student_documents').some((q) => q.chiamate.some(([m]) => m === 'update'))).toBe(false)
  })

  it('prestampato firmato o protocollato: 409 FASCICOLO_DOCUMENTO_NON_MODIFICABILE, nessun UPDATE', async () => {
    // La Segreteria (che gestirebbe qualunque documento del fascicolo) prova a riscrivere
    // la descrizione — dove vive il numero di protocollo — e il tipo di un modulo firmato.
    h.state.code = {
      student_documents: [
        { data: documento({ document_type: TIPO_PRESTAMPATO, caricato_da: ALTRO }), error: null },
        { data: documento({ document_type: 'pei' }), error: null },
      ],
    }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, documentType: 'pei', descrizione: 'x' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('FASCICOLO_DOCUMENTO_NON_MODIFICABILE')
    expect(queryDi('student_documents')).toHaveLength(1)
    expect(queryDi('student_documents').some((q) => q.chiamate.some(([m]) => m === 'update'))).toBe(false)
    expect(audit.logScrittura).not.toHaveBeenCalled()
  })

  it('senza accesso al fascicolo (altra sede): 403 DOCUMENTO_SANITARIO_NEGATO', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue({ consentito: false, ruolo: 'segreteria', motivo: 'cross-tenant' })
    h.state.code = { student_documents: [{ data: documento(), error: null }] }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, descrizione: 'x' }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('DOCUMENTO_SANITARIO_NEGATO')
  })

  it('documento nel cestino (la lettura viva non lo trova): 404', async () => {
    h.state.code = { student_documents: [{ data: null, error: null }] }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, descrizione: 'x' }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('DOCUMENTO_NON_TROVATO')
  })

  it('cestinato fra lettura e scrittura: 409 FASCICOLO_DOCUMENTO_CAMBIATO', async () => {
    h.state.code = { student_documents: [{ data: documento(), error: null }, { data: null, error: null }] }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, descrizione: 'x' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('FASCICOLO_DOCUMENTO_CAMBIATO')
  })

  it('errore di PostgREST sulla scrittura: 500 con codice, mai il messaggio grezzo', async () => {
    h.state.code = { student_documents: [{ data: documento(), error: null }, { data: null, error: { code: '42501', message: 'permission denied for table student_documents' } }] }
    const res = await PATCH(json('http://localhost/api/primaria/fascicolo', 'PATCH', { id: DOC, descrizione: 'x' }))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('FASCICOLO_SCRITTURA_FALLITA')
    expect(JSON.stringify(corpo)).not.toContain('permission denied')
  })
})

describe('DELETE /api/primaria/fascicolo — nel cestino, non cancellato', () => {
  it('scrive eliminato_il ed eliminato_da, solo su un documento vivo, e traccia l’accesso', async () => {
    const quando = '2026-09-25T10:00:00.000Z'
    h.state.code = { student_documents: [{ data: documento(), error: null }, { data: { id: DOC, eliminato_il: quando }, error: null }] }
    const res = await DELETE(new NextRequest(`http://localhost/api/primaria/fascicolo?id=${DOC}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    const [, scrittura] = queryDi('student_documents')
    const [payload] = argomenti(scrittura, 'update') as [Record<string, unknown>]
    expect(payload.eliminato_da).toBe(UTENTE)
    expect(typeof payload.eliminato_il).toBe('string')
    expect(ha(scrittura, 'is', 'eliminato_il', null)).toBe(true)
    // Niente `.delete()`: la riga resta per il ripristino.
    expect(scrittura.chiamate.some(([m]) => m === 'delete')).toBe(false)
    const corpo = await res.json()
    expect(corpo.data.ripristinabileFinoAl).toBe(new Date(Date.parse(quando) + GIORNI_CESTINO_REGISTRO * GIORNO_MS).toISOString())
    expect(rbac.logAccessoFascicolo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ azione: 'delete', documentoId: DOC }))
    expect(audit.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ azione: 'delete', entitaId: DOC }))
  })

  it('non autore contitolare: 403 e nessun UPDATE', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue(CONTITOLARE)
    h.state.code = { student_documents: [{ data: documento({ caricato_da: ALTRO }), error: null }] }
    const res = await DELETE(new NextRequest(`http://localhost/api/primaria/fascicolo?id=${DOC}`, { method: 'DELETE' }))
    expect(res.status).toBe(403)
    expect(queryDi('student_documents').some((q) => q.chiamate.some(([m]) => m === 'update'))).toBe(false)
  })
})

describe('POST /api/primaria/fascicolo/sostituisci', () => {
  const file = () => new File(['%PDF-1.4 nuovo'], 'nuovo.pdf', { type: 'application/pdf' })
  const url = 'http://localhost/api/primaria/fascicolo/sostituisci'

  it('file nuovo in una RIGA NUOVA che copia tipo, descrizione e scadenza; la vecchia va nel cestino', async () => {
    h.state.code = {
      student_documents: [
        { data: documento(), error: null }, // lettura del vecchio
        { data: { id: DOC }, error: null }, // presa
        { data: { id: NUOVO, document_type: 'pei' }, error: null }, // insert
      ],
      alunni: [{ data: { section_id: SEZIONE }, error: null }],
    }
    const res = await SOSTITUISCI(multipart(url, { id: DOC, file: file() }))
    expect(res.status).toBe(201)
    const [lettura, presa, insert] = queryDi('student_documents')
    expect(ha(lettura, 'is', 'eliminato_il', null)).toBe(true)
    // La presa: la vecchia nel cestino, SOLO se ancora viva.
    const [payloadPresa] = argomenti(presa, 'update') as [Record<string, unknown>]
    expect(payloadPresa.eliminato_da).toBe(UTENTE)
    expect(ha(presa, 'is', 'eliminato_il', null)).toBe(true)
    expect(ha(presa, 'eq', 'id', DOC)).toBe(true)
    // La riga nuova copia i metadati e punta al file nuovo.
    const [riga] = argomenti(insert, 'insert') as [Record<string, unknown>]
    expect(riga).toMatchObject({
      student_id: ALUNNO,
      document_type: 'pei',
      descrizione: 'Descrizione di prova',
      expiry_date: '2027-06-30',
      file_name: 'nuovo.pdf',
      caricato_da: UTENTE,
    })
    const upload = h.state.storage.find((s) => s.metodo === 'upload')!
    expect(upload.bucket).toBe('sensitive_documents')
    expect(riga.storage_path).toBe(upload.args[0])
    expect(String(upload.args[0]).startsWith(`${ALUNNO}/`)).toBe(true)
    // Il file vecchio NON si tocca: resta per il cestino.
    expect(h.state.storage.some((s) => s.metodo === 'remove')).toBe(false)
    const corpo = await res.json()
    expect(corpo.sostituito.id).toBe(DOC)
    expect(rbac.logAccessoFascicolo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ azione: 'upload', documentoId: NUOVO }))
    expect(rbac.logAccessoFascicolo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ azione: 'delete', documentoId: DOC }))
  })

  it('corsa persa (la presa non trova la riga viva): 409, file nuovo tolto, nessun insert', async () => {
    h.state.code = {
      student_documents: [{ data: documento(), error: null }, { data: null, error: null }],
      alunni: [{ data: { section_id: SEZIONE }, error: null }],
    }
    const res = await SOSTITUISCI(multipart(url, { id: DOC, file: file() }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('FASCICOLO_DOCUMENTO_CAMBIATO')
    const upload = h.state.storage.find((s) => s.metodo === 'upload')!
    const remove = h.state.storage.find((s) => s.metodo === 'remove')!
    expect(remove.args[0]).toEqual([upload.args[0]])
    expect(queryDi('student_documents').some((q) => q.chiamate.some(([m]) => m === 'insert'))).toBe(false)
  })

  it('insert fallito: si COMPENSA (la vecchia torna viva, il file nuovo esce) e si risponde 500', async () => {
    h.state.code = {
      student_documents: [
        { data: documento(), error: null },
        { data: { id: DOC }, error: null },
        { data: null, error: { code: '23514', message: 'violates check' } },
        { data: { id: DOC }, error: null }, // compensazione
      ],
      alunni: [{ data: { section_id: SEZIONE }, error: null }],
    }
    const res = await SOSTITUISCI(multipart(url, { id: DOC, file: file() }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('FASCICOLO_SCRITTURA_FALLITA')
    const [, presa, , compensa] = queryDi('student_documents')
    expect(argomenti(compensa, 'update')).toEqual([{ eliminato_il: null, eliminato_da: null }])
    expect(ha(compensa, 'not', 'eliminato_il', 'is', null)).toBe(true)
    // Solo la NOSTRA presa torna viva: lo stesso istante scritto dalla presa.
    const [payloadPresa] = argomenti(presa, 'update') as [Record<string, unknown>]
    expect(ha(compensa, 'eq', 'eliminato_il', payloadPresa.eliminato_il)).toBe(true)
    expect(h.state.storage.some((s) => s.metodo === 'remove')).toBe(true)
  })

  it('formato non ammesso: 400 con codice, niente upload', async () => {
    const res = await SOSTITUISCI(multipart(url, { id: DOC, file: new File(['x'], 'a.txt', { type: 'text/plain' }) }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('FASCICOLO_FORMATO_NON_AMMESSO')
    expect(h.state.storage).toHaveLength(0)
  })

  it('prestampato firmato o protocollato: 409 FASCICOLO_DOCUMENTO_NON_MODIFICABILE, niente upload, presa né insert', async () => {
    h.state.code = {
      student_documents: [
        { data: documento({ document_type: TIPO_PRESTAMPATO, caricato_da: ALTRO }), error: null },
        { data: { id: DOC }, error: null },
        { data: { id: NUOVO, document_type: TIPO_PRESTAMPATO }, error: null },
      ],
      alunni: [{ data: { section_id: SEZIONE }, error: null }],
    }
    const res = await SOSTITUISCI(multipart(url, { id: DOC, file: file() }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('FASCICOLO_DOCUMENTO_NON_MODIFICABILE')
    expect(h.state.storage).toHaveLength(0)
    expect(queryDi('student_documents')).toHaveLength(1)
    expect(queryDi('student_documents').some((q) => q.chiamate.some(([m]) => m === 'update' || m === 'insert'))).toBe(false)
    expect(rbac.logAccessoFascicolo).not.toHaveBeenCalled()
  })

  it('non autore contitolare: 403, niente upload', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue(CONTITOLARE)
    h.state.code = { student_documents: [{ data: documento({ caricato_da: ALTRO }), error: null }] }
    const res = await SOSTITUISCI(multipart(url, { id: DOC, file: file() }))
    expect(res.status).toBe(403)
    expect(h.state.storage).toHaveLength(0)
  })

  it('il nome del file non entra nel percorso: «Relazione dott.ssa Rossi» (PDF) → <alunno>/<n>-<caso>.pdf', async () => {
    h.state.code = {
      student_documents: [
        { data: documento(), error: null },
        { data: { id: DOC }, error: null },
        { data: { id: NUOVO, document_type: 'pei' }, error: null },
      ],
      alunni: [{ data: { section_id: SEZIONE }, error: null }],
    }
    const res = await SOSTITUISCI(
      multipart(url, { id: DOC, file: new File(['%PDF-1.4'], 'Relazione dott.ssa Rossi', { type: 'application/pdf' }) }),
    )
    expect(res.status).toBe(201)
    const percorso = String(h.state.storage.find((s) => s.metodo === 'upload')!.args[0])
    expect(percorso).toMatch(new RegExp(`^${ALUNNO}/\\d+-[a-z0-9]+\\.pdf$`))
    expect(percorso).not.toContain('Rossi')
    const [, , insert] = queryDi('student_documents')
    const [riga] = argomenti(insert, 'insert') as [Record<string, unknown>]
    expect(riga.storage_path).toBe(percorso)
  })
})

describe('POST /api/primaria/fascicolo — caricamento, lo stesso percorso della sostituzione', () => {
  // L'estensione viene dal MIME validato, MAI dal nome: il nome è testo libero e il
  // percorso finisce nei log dello Storage.
  const PERCORSO_PDF = new RegExp(`^${ALUNNO}/\\d+-[a-z0-9]+\\.pdf$`)
  const carica = (file: File) =>
    CARICA(multipart('http://localhost/api/primaria/fascicolo', { alunnoId: ALUNNO, documentType: 'pei', file }))

  beforeEach(() => {
    h.state.code = {
      student_documents: [{ data: { id: NUOVO }, error: null }],
      alunni: [{ data: { section_id: SEZIONE }, error: null }],
    }
  })

  it('nome con un punto nel mezzo e senza estensione: nel percorso NON entra nessun pezzo del nome', async () => {
    const res = await carica(new File(['%PDF-1.4'], 'Relazione dott.ssa Rossi', { type: 'application/pdf' }))
    expect(res.status).toBe(201)
    const upload = h.state.storage.find((s) => s.metodo === 'upload')!
    const percorso = String(upload.args[0])
    expect(percorso).toMatch(PERCORSO_PDF)
    expect(percorso).not.toContain('Rossi')
    const [riga] = argomenti(queryDi('student_documents')[0], 'insert') as [Record<string, unknown>]
    expect(riga.storage_path).toBe(percorso)
  })

  it('nome con una barra dopo il punto: nessuna sottocartella nel bucket', async () => {
    const res = await carica(new File(['%PDF-1.4'], 'referto.pdf/x', { type: 'application/pdf' }))
    expect(res.status).toBe(201)
    const percorso = String(h.state.storage.find((s) => s.metodo === 'upload')!.args[0])
    expect(percorso).toMatch(PERCORSO_PDF)
    expect(percorso.split('/')).toHaveLength(2)
  })

  it('decide il MIME, non il nome: «verbale.pdf» dichiarato image/png finisce in .png', async () => {
    const res = await carica(new File(['png'], 'verbale.pdf', { type: 'image/png' }))
    expect(res.status).toBe(201)
    const percorso = String(h.state.storage.find((s) => s.metodo === 'upload')!.args[0])
    expect(percorso).toMatch(new RegExp(`^${ALUNNO}/\\d+-[a-z0-9]+\\.png$`))
  })

  it('upload fallito: 500 FASCICOLO_FILE_NON_CARICATO, senza il messaggio grezzo dello Storage, e nessun insert', async () => {
    h.state.esitoUpload = { data: null, error: { message: 'new row violates row-level security policy for bucket sensitive_documents' } }
    const res = await carica(new File(['%PDF-1.4'], 'referto.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('FASCICOLO_FILE_NON_CARICATO')
    expect(JSON.stringify(corpo)).not.toContain('row-level security')
    expect(JSON.stringify(corpo)).not.toContain('sensitive_documents')
    expect(queryDi('student_documents')).toHaveLength(0)
    expect(audit.logScrittura).not.toHaveBeenCalled()
  })

  it('insert fallito: 500 FASCICOLO_SCRITTURA_FALLITA, il file appena caricato esce dal bucket, niente messaggio di PostgREST', async () => {
    h.state.code = {
      student_documents: [
        { data: null, error: { code: '23514', message: 'new row for relation "student_documents" violates check constraint' } },
      ],
      alunni: [{ data: { section_id: SEZIONE }, error: null }],
    }
    const res = await carica(new File(['%PDF-1.4'], 'referto.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('FASCICOLO_SCRITTURA_FALLITA')
    expect(JSON.stringify(corpo)).not.toContain('student_documents')
    expect(JSON.stringify(corpo)).not.toContain('check constraint')
    // Il file orfano esce: lo stesso bucket e lo STESSO percorso dell'upload.
    const upload = h.state.storage.find((s) => s.metodo === 'upload')!
    const remove = h.state.storage.find((s) => s.metodo === 'remove')
    expect(remove).toBeDefined()
    expect(remove!.bucket).toBe('sensitive_documents')
    expect(remove!.args[0]).toEqual([upload.args[0]])
    expect(rbac.logAccessoFascicolo).not.toHaveBeenCalled()
    expect(audit.logScrittura).not.toHaveBeenCalled()
  })

  it('caricamento riuscito: il file resta (nessun remove) e la riga punta al percorso caricato', async () => {
    const res = await carica(new File(['%PDF-1.4'], 'referto.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(201)
    expect(h.state.storage.some((s) => s.metodo === 'remove')).toBe(false)
  })
})

describe('/api/primaria/fascicolo/cestino', () => {
  it('GET staff: solo righe nel cestino ancora entro la custodia, di QUESTO alunno', async () => {
    // Due giorni e un'ora fa: restano 4 giorni e 23 ore, cioè «4» per difetto.
    const eliminato = new Date(Date.now() - 2 * GIORNO_MS - 60 * 60 * 1000).toISOString()
    h.state.code = { student_documents: [{ data: [{ ...documento(), eliminato_il: eliminato, eliminato_da: UTENTE }], error: null }] }
    const prima = Date.now()
    const res = await CESTINO(new NextRequest(`http://localhost/api/primaria/fascicolo/cestino?alunnoId=${ALUNNO}`))
    expect(res.status).toBe(200)
    const [q] = queryDi('student_documents')
    expect(ha(q, 'not', 'eliminato_il', 'is', null)).toBe(true)
    expect(ha(q, 'eq', 'student_id', ALUNNO)).toBe(true)
    const soglia = Date.parse(String((argomenti(q, 'gte') as unknown[])[1]))
    expect(Math.abs(soglia - (prima - GIORNI_CESTINO_REGISTRO * GIORNO_MS))).toBeLessThan(5000)
    // Lo staff vede tutto il cestino dell'alunno.
    expect(q.chiamate.some(([m, a]) => m === 'eq' && a[0] === 'caricato_da')).toBe(false)
    const corpo = await res.json()
    expect(corpo.data[0].giorniResidui).toBe(GIORNI_CESTINO_REGISTRO - 3)
    expect(rbac.logAccessoFascicolo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ azione: 'list' }))
  })

  it('GET docente contitolare: solo i documenti che ha caricato lui', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue(CONTITOLARE)
    h.state.code = { student_documents: [{ data: [], error: null }] }
    const res = await CESTINO(new NextRequest(`http://localhost/api/primaria/fascicolo/cestino?alunnoId=${ALUNNO}`))
    expect(res.status).toBe(200)
    expect(ha(queryDi('student_documents')[0], 'eq', 'caricato_da', UTENTE)).toBe(true)
  })

  it('GET con motivo staff ma ruolo fuori da RUOLI_GESTIONE_FASCICOLO: solo i documenti che ha caricato (la stessa regola del ripristino)', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue(STAFF_RUOLO_ESTRANEO)
    h.state.code = { student_documents: [{ data: [], error: null }] }
    const res = await CESTINO(new NextRequest(`http://localhost/api/primaria/fascicolo/cestino?alunnoId=${ALUNNO}`))
    expect(res.status).toBe(200)
    expect(ha(queryDi('student_documents')[0], 'eq', 'caricato_da', UTENTE)).toBe(true)
  })

  it('POST ripristina: azzera eliminato_il/eliminato_da, solo se ancora nel cestino ed entro la custodia', async () => {
    const eliminato = new Date(Date.now() - GIORNO_MS).toISOString()
    h.state.code = {
      student_documents: [
        { data: { ...documento(), eliminato_il: eliminato, eliminato_da: UTENTE }, error: null },
        { data: documento(), error: null },
      ],
    }
    const res = await RIPRISTINA(json('http://localhost/api/primaria/fascicolo/cestino', 'POST', { id: DOC }))
    expect(res.status).toBe(200)
    const [lettura, scrittura] = queryDi('student_documents')
    expect(ha(lettura, 'not', 'eliminato_il', 'is', null)).toBe(true)
    expect(argomenti(scrittura, 'update')).toEqual([{ eliminato_il: null, eliminato_da: null }])
    expect(ha(scrittura, 'not', 'eliminato_il', 'is', null)).toBe(true)
    expect(scrittura.chiamate.some(([m, a]) => m === 'gte' && a[0] === 'eliminato_il')).toBe(true)
    expect(audit.logScrittura).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ azione: 'update', entitaId: DOC }))
  })

  it('POST oltre la custodia: 409 FASCICOLO_CESTINO_SCADUTO e nessun UPDATE', async () => {
    const eliminato = new Date(Date.now() - (GIORNI_CESTINO_REGISTRO + 1) * GIORNO_MS).toISOString()
    h.state.code = { student_documents: [{ data: { ...documento(), eliminato_il: eliminato, eliminato_da: UTENTE }, error: null }] }
    const res = await RIPRISTINA(json('http://localhost/api/primaria/fascicolo/cestino', 'POST', { id: DOC }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('FASCICOLO_CESTINO_SCADUTO')
    expect(queryDi('student_documents')).toHaveLength(1)
  })

  it('POST su un documento non nel cestino: 409 FASCICOLO_NON_NEL_CESTINO', async () => {
    h.state.code = { student_documents: [{ data: null, error: null }] }
    const res = await RIPRISTINA(json('http://localhost/api/primaria/fascicolo/cestino', 'POST', { id: DOC }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('FASCICOLO_NON_NEL_CESTINO')
  })

  it('POST di un non autore contitolare: 403 e nessun UPDATE', async () => {
    rbac.puoAccedereFascicolo.mockResolvedValue(CONTITOLARE)
    const eliminato = new Date(Date.now() - GIORNO_MS).toISOString()
    h.state.code = { student_documents: [{ data: { ...documento({ caricato_da: ALTRO }), eliminato_il: eliminato, eliminato_da: ALTRO }, error: null }] }
    const res = await RIPRISTINA(json('http://localhost/api/primaria/fascicolo/cestino', 'POST', { id: DOC }))
    expect(res.status).toBe(403)
    expect(queryDi('student_documents')).toHaveLength(1)
  })
})
