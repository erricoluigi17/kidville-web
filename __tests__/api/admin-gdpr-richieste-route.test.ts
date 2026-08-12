import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'
import { NextResponse, NextRequest } from 'next/server'

// =============================================================================
// LOCK del contratto sullo spazio-id: `richieste_cancellazione.parent_id` è un
// `parents.id`, e la Direzione lo passa TALE E QUALE ad `anonimizzaParent`.
//
// La route è già corretta e NON va cambiata: questo file blocca il consumatore
// mentre i produttori (canale in-app + canale pubblico) vengono corretti, così
// il contratto resta scritto da entrambi i lati. `anonimizzaParent`/
// `anonimizzaAlunno` sono mockate: qui interessa SOLO l'id che ricevono (la loro
// logica è coperta da `__tests__/lib/gdpr-esegui.test.ts`).
//
// Il fixture tiene di proposito un `utenti.id` diverso dal `parents.id`: se un
// domani la route passasse l'id utente, questo test diventerebbe rosso.
// =============================================================================

const UTENTE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-utente000001'
const PARENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-parent000001'
const SCUOLA_ID = SEDE_A

const h = vi.hoisted(() => {
  const state = {
    richiesta: null as Record<string, unknown> | null,
    links: [] as { student_id: string }[],
    alunni: [] as Record<string, unknown>[],
    updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
    errRichiesta: null as { code?: string } | null,
    // ── Ciò che il DRY-RUN deve saper contare, in BLOCCO (2026-08-13) ────────
    // Questo canale evade la richiesta ex art. 17 della famiglia e anonimizza
    // TUTTI i figli non più iscritti con una conferma sola: fino a oggi
    // rispondeva quattro conteggi di persone e nessuno di ciò che distrugge.
    // Le righe sono indicizzate per alunno, così la somma non può passare per
    // caso su una fixture con un figlio solo.
    pagellePerAlunno: {} as Record<string, { id: string }[]>,
    certificatiPerAlunno: {} as Record<string, { id: string }[]>,
    documentoParent: null as string | null,
    /** Errore PostgREST per tabella: dimostra che «non misurato» ≠ «zero». */
    erroriTabella: {} as Record<string, { code: string; message: string }>,
  }
  const requireStaff = vi.fn()
  const logScrittura = vi.fn()
  const anonimizzaParent = vi.fn()
  const anonimizzaAlunno = vi.fn()
  return { state, requireStaff, logScrittura, anonimizzaParent, anonimizzaAlunno }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/gdpr/esegui', () => ({
  anonimizzaParent: h.anonimizzaParent,
  anonimizzaAlunno: h.anonimizzaAlunno,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      let patch: Record<string, unknown> | null = null
      // Il filtro vive nel SINGOLO builder, non nello stato condiviso: il
      // dry-run conta i figli in parallelo, e con una variabile di modulo
      // l'ultimo `eq` vinceva su tutti — il finto avrebbe reso rossa una somma
      // giusta (o, peggio, verde una sbagliata).
      let alunnoDelFiltro = ''
      const dati = () => {
        if (table === 'student_parents') return h.state.links
        if (table === 'alunni') return h.state.alunni
        if (table === 'pagelle') return h.state.pagellePerAlunno[alunnoDelFiltro] ?? []
        if (table === 'certificati_medici') return h.state.certificatiPerAlunno[alunnoDelFiltro] ?? []
        return []
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      // `contaCosaDistrugge` filtra per `alunno_id`: il finto se lo segna, così
      // i conteggi dei figli restano DISTINTI e la somma non può essere verde
      // per caso su una fixture con un bambino solo.
      b.eq = (col?: string, val?: unknown) => {
        if (col === 'alunno_id' && typeof val === 'string') alunnoDelFiltro = val
        return b
      }
      b.in = () => b
      b.order = () => b
      // Dal 2026-08-13 il dry-run misura anche CHE COSA distrugge
      // (`contaCosaDistrugge`): sono altre `SELECT`, con `contains` sui tag
      // jsonb e `not(... is null)` sugli allegati. Senza questi due il builder
      // finto lanciava e la route rispondeva 500 — cioè il test sarebbe stato
      // rosso per il finto, non per il prodotto.
      b.contains = () => b
      b.not = () => b
      b.update = (v: Record<string, unknown>) => { patch = v; return b }
      b.maybeSingle = async () => {
        if (table === 'richieste_cancellazione') {
          return { data: h.state.errRichiesta ? null : h.state.richiesta, error: h.state.errRichiesta }
        }
        const err = h.state.erroriTabella[table] ?? null
        if (table === 'parents') {
          return { data: err ? null : { documento_path: h.state.documentoParent }, error: err }
        }
        return { data: null, error: err }
      }
      b.then = (res: (v: unknown) => unknown) => {
        if (patch) h.state.updates.push({ table, patch })
        const err = h.state.erroriTabella[table] ?? null
        return Promise.resolve({ data: err ? null : dati(), error: err }).then(res)
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/gdpr/richieste/route'

// NextRequest (non Request): da quando la route verifica la sede legge il cookie
// `sedi_attive` tramite `resolveScuoleAttive`, che vuole `request.cookies`.
const req = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/gdpr/richieste', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: SCUOLA_ID } })
  h.state.richiesta = { id: 'req-1', parent_id: PARENT_ID, stato: 'pending', scuola_id: SCUOLA_ID }
  h.state.links = []
  h.state.alunni = []
  h.state.updates = []
  h.state.errRichiesta = null
  h.state.pagellePerAlunno = {}
  h.state.certificatiPerAlunno = {}
  h.state.documentoParent = null
  h.state.erroriTabella = {}
  h.anonimizzaParent.mockResolvedValue({
    newsVisualizzazioniRimosse: 0,
    segnalazioniBonificate: 0,
    sospensioniBonificate: 0,
  })
  h.anonimizzaAlunno.mockResolvedValue({
    riconciliazione: 0, incassi: 0, cassa: 0, file: 0,
    segnalazioniBonificate: 0, sospensioniBonificate: 0,
    // Dal 2026-08-07 l'oblio azzera anche il motivo dell'assenza e le note
    // d'appello del minore: due valori diversi da zero, così l'asserzione sulla
    // SOMMA non può passare per caso su uno zero.
    presenzeBonificate: 3,
  })
})

describe('POST /api/admin/gdpr/richieste — evasione', () => {
  it('execute: anonimizza ESATTAMENTE il parent_id della richiesta (parents.id)', async () => {
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(200)
    expect(h.anonimizzaParent).toHaveBeenCalledTimes(1)
    const parentIdPassato = h.anonimizzaParent.mock.calls[0][1]
    expect(parentIdPassato).toBe(PARENT_ID)
    expect(parentIdPassato).not.toBe(UTENTE_ID)
  })

  it('execute: marca la richiesta come evasa e scrive l’audit', async () => {
    await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    const upd = h.state.updates.find((u) => u.table === 'richieste_cancellazione')
    expect(upd).toBeTruthy()
    expect(upd!.patch).toMatchObject({ stato: 'evasa', evasa_da: 'dir-1' })
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
  })

  it('execute: anonimizza i figli NON iscritti e lascia gli iscritti alla scuola', async () => {
    // `scuola_id` sui figli è ORA parte del fixture: dal 2026-07-31 la route
    // anonimizza solo i minori del proprio plesso (F5), e un figlio senza sede
    // è fuori scope per progetto (fail-closed). Vedi
    // `admin-gdpr-richieste-scope-sede.test.ts` per il caso a due sedi.
    h.state.links = [{ student_id: 'al-1' }, { student_id: 'al-2' }]
    h.state.alunni = [
      { id: 'al-1', stato: 'ritirato', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
      { id: 'al-2', stato: 'iscritto', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    const j = await res.json()
    expect(j.alunni).toBe(1)
    expect(h.anonimizzaAlunno).toHaveBeenCalledTimes(1)
    expect((h.anonimizzaAlunno.mock.calls[0][1] as { id: string }).id).toBe('al-1')
  })

  // ⬇︎ REGRESSIONE — è l'istanza più grave del difetto: qui l'oblio è in BLOCCO.
  // La route sceglieva i figli da anonimizzare con `f.stato !== 'iscritto'`, una
  // negazione. Un fratello soltanto SOSPESO — iscritto a tutti gli effetti —
  // veniva anonimizzato irreversibilmente insieme agli altri, e la Direzione
  // vedeva un solo conteggio, non i nomi.
  it('execute: un figlio SOSPESO non viene anonimizzato con gli altri', async () => {
    h.state.links = [{ student_id: 'al-1' }, { student_id: 'al-2' }]
    h.state.alunni = [
      { id: 'al-1', stato: 'ritirato', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
      { id: 'al-2', stato: 'sospeso', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
    const j = await (await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))).json()
    expect(j.alunni).toBe(1)
    expect(h.anonimizzaAlunno).toHaveBeenCalledTimes(1)
    expect((h.anonimizzaAlunno.mock.calls[0][1] as { id: string }).id).toBe('al-1')
  })

  it('dryrun: il figlio SOSPESO si conta fra gli iscritti mantenuti', async () => {
    // Il dry-run è ciò che la Direzione legge PRIMA di confermare: se contasse
    // il sospeso fra i «non iscritti», starebbe autorizzando ciò che crede di
    // non stare autorizzando.
    h.state.links = [{ student_id: 'al-2' }]
    h.state.alunni = [
      { id: 'al-2', stato: 'sospeso', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
    const j = await (await POST(req({ id: 'req-1', mode: 'dryrun' }))).json()
    expect(j).toMatchObject({ alunni_non_iscritti: 0, alunni_iscritti_mantenuti: 1 })
  })

  it('execute: l’esito riporta le presenze bonificate, sommate su tutti i figli', async () => {
    // L'`esito` di questa route non è solo una risposta HTTP: viene SCRITTO sulla
    // riga `richieste_cancellazione` e nell'audit immutabile. È il posto in cui,
    // fra un anno, si potrà dimostrare che il motivo dell'assenza di quel
    // bambino — testo libero di natura sanitaria — è stato tolto davvero.
    h.state.links = [{ student_id: 'al-1' }, { student_id: 'al-2' }]
    h.state.alunni = [
      { id: 'al-1', stato: 'ritirato', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
      { id: 'al-2', stato: 'ritirato', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    const j = await res.json()
    expect(
      j.presenze_bonificate,
      'l’esito non somma le presenze bonificate dei figli: un oblio che non si conta non si verifica',
    ).toBe(6)
    const upd = h.state.updates.find((u) => u.table === 'richieste_cancellazione')
    expect((upd!.patch.esito as Record<string, unknown>).presenze_bonificate).toBe(6)
  })

  it('dryrun: conta senza anonimizzare nulla', async () => {
    h.state.links = [{ student_id: 'al-1' }]
    h.state.alunni = [
      { id: 'al-1', stato: 'ritirato', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
    const res = await POST(req({ id: 'req-1', mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ dryrun: true, parent: 1, alunni_non_iscritti: 1, alunni_iscritti_mantenuti: 0 })
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.state.updates).toHaveLength(0)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // IL DRY-RUN CHE NON DICEVA CHE COSA DISTRUGGE — sul canale IN BLOCCO.
  //
  // Fino al 2026-08-13 questa risposta portava quattro conteggi di persone e
  // nemmeno una parola su pagelle, certificati medici, foto o allegati, mentre
  // l'operazione ne distrugge di TUTTI i figli non più iscritti in un colpo
  // solo. Il commento della route lo diceva («qui l'oblio è in BLOCCO e la
  // Direzione conferma vedendo dei CONTEGGI»): un commento non è un avviso.
  // ───────────────────────────────────────────────────────────────────────────
  const dueFigliNonIscritti = () => {
    h.state.links = [{ student_id: 'al-1' }, { student_id: 'al-2' }]
    h.state.alunni = [
      { id: 'al-1', stato: 'ritirato', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: 'doc/al-1.pdf', codice_fiscale: null, fiscal_code: null },
      { id: 'al-2', stato: 'ritirato', anonimizzato_il: null, scuola_id: SCUOLA_ID, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ]
  }

  it('dryrun: SOMMA le pagelle e i certificati di TUTTI i figli che verranno anonimizzati', async () => {
    dueFigliNonIscritti()
    h.state.pagellePerAlunno = { 'al-1': [{ id: 'pg-1' }, { id: 'pg-2' }], 'al-2': [{ id: 'pg-3' }] }
    h.state.certificatiPerAlunno = { 'al-1': [{ id: 'cm-1' }] }

    const j = await (await POST(req({ id: 'req-1', mode: 'dryrun' }))).json()
    // Tre pagelle e un certificato: sono i numeri che la Direzione deve leggere
    // PRIMA di digitare ANONIMIZZA. Due figli con numeri diversi, così la somma
    // non può essere verde per caso.
    expect(j.pagelle).toBe(3)
    expect(j.certificati_medici).toBe(1)
    // Resta un dry-run: nessuna anonimizzazione, nessuna scrittura.
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.state.updates).toHaveLength(0)
  })

  it('dryrun: un solo figlio NON misurato annulla il totale, non lo abbassa', async () => {
    // PostgREST non lancia. Se la lettura delle pagelle fallisce su un bambino,
    // sommare gli altri darebbe un numero più basso del vero con l'aria di una
    // misura — la conferma inventata che questo avviso esiste per abolire.
    dueFigliNonIscritti()
    h.state.pagellePerAlunno = { 'al-1': [{ id: 'pg-1' }] }
    h.state.erroriTabella = { pagelle: { code: '42501', message: 'permission denied for table pagelle' } }

    const j = await (await POST(req({ id: 'req-1', mode: 'dryrun' }))).json()
    expect(j.pagelle).toBeNull()
    // Un magazzino illeggibile non spegne l'intero avviso.
    expect(j.certificati_medici).toBe(0)
  })

  it('dryrun: i documenti d’identità contati sono quelli dei figli PIÙ quello del genitore', async () => {
    dueFigliNonIscritti()
    h.state.documentoParent = 'doc/genitore.pdf'
    const j = await (await POST(req({ id: 'req-1', mode: 'dryrun' }))).json()
    // Un figlio con documento + il genitore, che qui è sempre anonimizzato.
    expect(j.file_da_rimuovere).toBe(2)
  })

  it('dryrun: se il documento del genitore non si legge, il numero è «non misurato»', async () => {
    dueFigliNonIscritti()
    h.state.erroriTabella = { parents: { code: '42501', message: 'permission denied for table parents' } }
    const j = await (await POST(req({ id: 'req-1', mode: 'dryrun' }))).json()
    expect(j.file_da_rimuovere).toBeNull()
  })

  it('dryrun: schema ASSENTE (DB E2E della CI non migrato) → zero, non un 500', async () => {
    dueFigliNonIscritti()
    h.state.erroriTabella = {
      pagelle: { code: 'PGRST205', message: 'table not found' },
      certificati_medici: { code: 'PGRST205', message: 'table not found' },
      galleria_media_v2: { code: '42P01', message: 'relation does not exist' },
      news_posts: { code: 'PGRST205', message: 'table not found' },
      chat_threads: { code: 'PGRST205', message: 'table not found' },
      parents: { code: 'PGRST205', message: 'table not found' },
    }
    const res = await POST(req({ id: 'req-1', mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.pagelle).toBe(0)
    expect(j.foto_solo_sue).toBe(0)
  })

  it('conferma testuale sbagliata → 400, nessuna anonimizzazione', async () => {
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'anonimizza tutto' }))
    expect(res.status).toBe(400)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('richiesta già gestita → 409', async () => {
    h.state.richiesta = { id: 'req-1', parent_id: PARENT_ID, stato: 'evasa', scuola_id: SCUOLA_ID }
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(409)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('richiesta inesistente → 404', async () => {
    h.state.richiesta = null
    const res = await POST(req({ id: 'ignota', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(404)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('401 senza identità', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(401)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })

  it('403 se non è Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(req({ id: 'req-1', mode: 'execute', confirm: 'ANONIMIZZA' }))
    expect(res.status).toBe(403)
    expect(h.anonimizzaParent).not.toHaveBeenCalled()
  })
})
