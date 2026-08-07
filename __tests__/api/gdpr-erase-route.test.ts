import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  links: [] as { parent_id: string }[],
  parentChildren: {} as Record<string, { stato: string; anonimizzato_il: string | null }[]>,
  updates: [] as Record<string, unknown>[],
  removed: [] as string[],
  // Bonifica riconciliazione/incassi (D1): pagamenti dell'alunno + righe collegate.
  pagamenti: [] as { id: string }[],
  movConfermati: [] as Record<string, unknown>[],
  movCfMatch: [] as { id: string; suggerimenti?: unknown }[],
  incassiBonificati: [] as { id: string }[],
  // P6 — bonifica del testo libero dei movimenti di cassa per CF.
  cassaBonificati: [] as { id: string }[],
  // F1 ciclo 2 — oblio del tracciamento di lettura news (news_visualizzazioni).
  parentsAuth: [] as { auth_user_id: string | null }[],
  newsVisDeleted: [] as { post_id: string }[],
  newsVisError: null as { code: string } | null,
  newsVisDeleteFilter: null as string[] | null,
  deletedTables: [] as string[],
  // W5 — prove di consenso dei genitori orfani (ip/user_agent da azzerare).
  consensi: [] as { id: string }[],
  // Errori PostgREST iniettati sulle due letture che decidono l'oblio.
  alunnoError: null as { code: string; message: string } | null,
  linksError: null as { code: string; message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      // Ogni `from()` è un nuovo builder con stato filtri proprio.
      const state: { stato?: string; neqStato?: string } = {}
      const dataFor = () => {
        if (table === 'student_parents') return h.links
        if (table === 'pagamenti') return h.pagamenti
        if (table === 'incassi') return h.incassiBonificati
        if (table === 'cassa_movimenti') return h.cassaBonificati
        if (table === 'parents') return h.parentsAuth
        if (table === 'news_visualizzazioni') return h.newsVisDeleted
        if (table === 'consensi_accettazioni') return h.consensi
        if (table === 'riconciliazione_movimenti') {
          if (state.stato === 'confermato') return h.movConfermati
          if (state.neqStato === 'confermato') return h.movCfMatch
          return []
        }
        return []
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { if (col === 'stato') state.stato = String(val); return b }
      b.is = () => b
      b.neq = (col: string, val: unknown) => { if (col === 'stato') state.neqStato = String(val); return b }
      b.in = (col: string, vals: unknown) => { if (table === 'news_visualizzazioni' && col === 'utente_id') h.newsVisDeleteFilter = vals as string[]; return b }
      b.or = () => b
      b.ilike = () => b
      // Dal 2026-08-01 l'oblio interroga anche `enrollment_submissions` e
      // `galleria_media_v2` con l'operatore di contenimento (`@>`): senza questo
      // metodo il doppio di test non è più un doppio del client Supabase, e
      // ogni caso qui sotto cadeva con un 500 «contains is not a function».
      // I dati restano quelli di prima (nessuna asserzione cambia).
      b.contains = () => b
      b.delete = () => { h.deletedTables.push(table); return b }
      // `parents` risponde anche in forma singola: da quando la route passa da
      // `anonimizzaParent`, l'`auth_user_id` del genitore orfano si legge con
      // `maybeSingle` prima di essere azzerato. Un doppio che qui risponde
      // `null` renderebbe il genitore irraggiungibile in spazio-id `utenti` —
      // cioè farebbe sembrare corretto un oblio che non tocca news e UGC.
      b.maybeSingle = async () => {
        if (table === 'alunni' && h.alunnoError) return { data: null, error: h.alunnoError }
        return {
          data: table === 'alunni' ? h.alunno : table === 'parents' ? (h.parentsAuth[0] ?? null) : null,
          error: null,
        }
      }
      b.then = (res: (v: unknown) => unknown) => {
        if (table === 'student_parents' && h.linksError) {
          return Promise.resolve({ data: null, error: h.linksError }).then(res)
        }
        if (table === 'news_visualizzazioni' && h.newsVisError) {
          return Promise.resolve({ data: null, error: h.newsVisError }).then(res)
        }
        return Promise.resolve({ data: dataFor(), error: null }).then(res)
      }
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, ...row }); return b }
      return b
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => { h.removed.push(...paths); return { error: null } },
        // Elenca il bucket `credenziali` (nessuna tabella-indice) e verifica che
        // i file non usciti non siano rimasti: elenco vuoto = «non c'è più».
        list: async () => ({ data: [] as { name: string }[], error: null }),
      }),
    },
  }),
}))

// Conta i figli iscritti di un parent (per la regola "orfano").
vi.mock('@/lib/gdpr/orfano', () => ({
  parentHaAltriFigliIscritti: vi.fn(async (_s: unknown, parentId: string) => {
    const kids = h.parentChildren[parentId] ?? []
    return kids.some((k) => k.stato === 'iscritto' && !k.anonimizzato_il)
  }),
}))

import { POST } from '@/app/api/admin/gdpr/erase/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/gdpr/erase', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  // `scuola_id` allineata a quella dell'attore: da quando la route verifica lo
  // scope di sede prima di anonimizzare, un alunno senza sede è (correttamente)
  // un 403. L'oggetto di questo file resta l'anonimizzazione, non il gate: quello
  // sta in `__tests__/api/gdpr-scope-sede.test.ts`.
  h.alunno = { id: 'al-1', nome: 'Marco', cognome: 'Rossi', stato: 'non_iscritto', anonimizzato_il: null, documento_path: null, codice_fiscale: null, fiscal_code: null, scuola_id: 'sc-1', section_id: 'sez-1' }
  h.links = [{ parent_id: 'p-1' }]
  h.parentChildren = { 'p-1': [] } // orfano
  h.updates = []; h.removed = []
  h.pagamenti = []; h.movConfermati = []; h.movCfMatch = []; h.incassiBonificati = []
  h.cassaBonificati = []
  h.parentsAuth = []; h.newsVisDeleted = []; h.newsVisError = null
  h.newsVisDeleteFilter = null; h.deletedTables = []
  h.consensi = []
  h.alunnoError = null; h.linksError = null
})

describe('POST /api/admin/gdpr/erase', () => {
  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))).status).toBe(403)
  })

  it('404 se alunno assente', async () => {
    h.alunno = null
    expect((await POST(req({ alunno_id: 'nope', mode: 'dryrun' }))).status).toBe(404)
  })

  it('rifiuta un alunno ISCRITTO (409)', async () => {
    h.alunno = { ...h.alunno, stato: 'iscritto' }
    expect((await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))).status).toBe(409)
  })

  it('dryrun: ritorna conteggi senza scrivere', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dryrun).toBe(true)
    expect(json.alunno).toBe(1)
    expect(json.parents).toBe(1)
    expect(h.updates).toHaveLength(0)
  })

  it('execute con conferma errata → 400', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'Rossi Luca' }))
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it('execute ok: anonimizza alunno + parent orfano + audit', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const upd = h.updates
    expect(upd.some((u) => u.table === 'alunni' && typeof u.nome === 'string' && (u.nome as string).startsWith('CANCELLATO-'))).toBe(true)
    expect(upd.some((u) => u.table === 'parents' && (u.first_name as string)?.startsWith('CANCELLATO-'))).toBe(true)
    expect(h.logScrittura).toHaveBeenCalled()
  })

  it('parent con altro figlio iscritto → NON anonimizzato', async () => {
    h.parentChildren = { 'p-1': [{ stato: 'iscritto', anonimizzato_il: null }] }
    await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'ROSSI MARCO' }))
    expect(h.updates.some((u) => u.table === 'parents')).toBe(false)
    // l'alunno viene comunque anonimizzato
    expect(h.updates.some((u) => u.table === 'alunni')).toBe(true)
  })

  // D1 — l'oblio deve bonificare anche i dati di riconciliazione/incassi collegati:
  // la causale consigliata porta il CF/nome del minore, persistito nei movimenti
  // confermati (causale/controparte/suggerimenti.label) e nella nota dell'incasso.
  it('execute: bonifica movimenti confermati + nota incasso dei pagamenti dell\'alunno', async () => {
    h.pagamenti = [{ id: 'pag-1' }]
    h.movConfermati = [{ id: 'mov-1', suggerimenti: [{ pagamento_id: 'pag-1', score: 1050, label: 'Marco Rossi' }] }]
    h.incassiBonificati = [{ id: 'inc-1' }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    // movimento confermato: causale/controparte azzerate + label rimosso dai suggerimenti
    const movUpd = h.updates.find((u) => u.table === 'riconciliazione_movimenti')
    expect(movUpd).toBeTruthy()
    expect(movUpd!.causale).toBeNull()
    expect(movUpd!.controparte).toBeNull()
    const sugg = movUpd!.suggerimenti as Record<string, unknown>[]
    expect('label' in sugg[0]).toBe(false)
    expect(sugg[0]).toMatchObject({ pagamento_id: 'pag-1', score: 1050 })
    // incasso da riconciliazione: nota azzerata
    const incUpd = h.updates.find((u) => u.table === 'incassi')
    expect(incUpd).toBeTruthy()
    expect(incUpd!.note).toBeNull()
    // conteggi riportati nella risposta
    const json = await res.json()
    expect(json.riconciliazione_bonificati).toBe(1)
    expect(json.incassi_bonificati).toBe(1)
  })

  // D1 best-effort — movimenti NON confermati la cui causale contiene il CF dell'alunno.
  it('execute: bonifica best-effort dei movimenti non confermati che citano il CF', async () => {
    h.alunno = { ...h.alunno!, codice_fiscale: 'TSTTST00T00T000T' }
    h.movCfMatch = [{ id: 'mov-2' }, { id: 'mov-3' }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    // 2 movimenti non confermati agganciati per CF → azzerati
    expect(json.riconciliazione_bonificati).toBe(2)
    const movUpd = h.updates.filter((u) => u.table === 'riconciliazione_movimenti')
    expect(movUpd.length).toBeGreaterThanOrEqual(1)
    expect(movUpd.every((u) => u.causale === null && u.controparte === null)).toBe(true)
  })

  // D1 (3d) — movimenti NON confermati agganciati all'alunno tramite i suggerimenti
  // (match per CF/nome all'import): il `label` col nome del minore va rimosso dal JSON.
  it('execute: bonifica i movimenti non confermati agganciati per suggerimenti (scrub del label)', async () => {
    h.pagamenti = [{ id: 'pag-1' }]
    // non confermato, senza CF in causale (nessun 3c), ma i suggerimenti citano il pagamento dell'alunno
    h.movCfMatch = [{ id: 'mov-nc', suggerimenti: [{ pagamento_id: 'pag-1', score: 1000, label: 'Marco Rossi' }] }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const movUpd = h.updates.find((u) => u.table === 'riconciliazione_movimenti')
    expect(movUpd).toBeTruthy()
    expect(movUpd!.causale).toBeNull()
    expect(movUpd!.controparte).toBeNull()
    const sugg = movUpd!.suggerimenti as Record<string, unknown>[]
    expect('label' in sugg[0]).toBe(false)
    expect(sugg[0]).toMatchObject({ pagamento_id: 'pag-1' })
    const json = await res.json()
    expect(json.riconciliazione_bonificati).toBe(1)
  })

  it('execute: nessun pagamento e nessun CF → niente bonifica riconciliazione', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    expect(h.updates.some((u) => u.table === 'riconciliazione_movimenti' || u.table === 'incassi')).toBe(false)
    const json = await res.json()
    expect(json.riconciliazione_bonificati).toBe(0)
    expect(json.incassi_bonificati).toBe(0)
  })

  // P6 — cassa_movimenti NON ha alunno_id: l'unico aggancio al minore è il CF
  // eventualmente scritto nel testo libero (descrizione/note/storno_motivo, es.
  // categoria «Rimborsi»). L'oblio deve scrubarlo, o sopravvive a tempo indefinito.
  it('execute: bonifica il testo libero dei movimenti di cassa che citano il CF (P6)', async () => {
    h.alunno = { ...h.alunno!, codice_fiscale: 'TSTTST00T00T000T' }
    h.cassaBonificati = [{ id: 'cm-1' }, { id: 'cm-2' }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const cassaUpd = h.updates.find((u) => u.table === 'cassa_movimenti')
    expect(cassaUpd).toBeTruthy()
    expect(cassaUpd!.descrizione).toBe('[rimosso]')
    expect(cassaUpd!.note).toBe('[rimosso]')
    expect(cassaUpd!.storno_motivo).toBe('[rimosso]')
    const json = await res.json()
    expect(json.cassa_bonificati).toBe(2)
  })

  it('execute: senza CF non tocca cassa_movimenti', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    expect(h.updates.some((u) => u.table === 'cassa_movimenti')).toBe(false)
    const json = await res.json()
    expect(json.cassa_bonificati).toBe(0)
  })

  // F1 ciclo 2 (privacy) — `news_visualizzazioni` (post, utente_id=auth.uid del
  // genitore, data) è un tracciamento comportamentale: dopo l'anonimizzazione di
  // parents/alunni resterebbe joinabile a un'identità a tempo indefinito. L'oblio
  // deve cancellarlo, sugli auth_user_id RACCOLTI PRIMA di patchParent (che li azzera).
  it('execute: cancella news_visualizzazioni per gli auth_user_id dei genitori orfani', async () => {
    h.parentsAuth = [{ auth_user_id: 'auth-p-1' }]
    h.newsVisDeleted = [{ post_id: 'np-1' }, { post_id: 'np-2' }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    expect(h.deletedTables).toContain('news_visualizzazioni')
    expect(h.newsVisDeleteFilter).toEqual(['auth-p-1'])
    const json = await res.json()
    expect(json.news_visualizzazioni_rimosse).toBe(2)
  })

  it('execute: degrada in silenzio se lo schema news è assente (news_visualizzazioni)', async () => {
    h.parentsAuth = [{ auth_user_id: 'auth-p-1' }]
    h.newsVisError = { code: 'PGRST205' } // tabella assente sul DB E2E CI non migrato
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.news_visualizzazioni_rimosse).toBe(0)
  })

  it('execute: nessun genitore orfano → non tocca news_visualizzazioni', async () => {
    h.parentChildren = { 'p-1': [{ stato: 'iscritto', anonimizzato_il: null }] } // non orfano
    h.parentsAuth = [{ auth_user_id: 'auth-p-1' }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    expect(h.deletedTables).not.toContain('news_visualizzazioni')
    const json = await res.json()
    expect(json.news_visualizzazioni_rimosse).toBe(0)
  })

  it('execute: toglie ip e user_agent dalle prove di consenso dei genitori orfani (W5)', async () => {
    h.parentsAuth = [{ auth_user_id: 'auth-1' }]
    h.consensi = [{ id: 'c1' }, { id: 'c2' }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'Rossi Marco' }))
    expect(res.status).toBe(200)
    const cUpd = h.updates.find((u) => u.table === 'consensi_accettazioni')
    expect(cUpd).toBeTruthy()
    expect(cUpd!.ip).toBeNull()
    expect(cUpd!.user_agent).toBeNull()
    expect(Object.keys(cUpd!)).not.toContain('versione')
    expect((await res.json()).consensi_prova_bonificati).toBe(2)
  })

  it('execute: nessun genitore orfano → le prove di consenso non si toccano', async () => {
    h.parentChildren = { 'p-1': [{ stato: 'iscritto', anonimizzato_il: null }] }
    h.consensi = [{ id: 'c1' }]
    await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'Rossi Marco' }))
    expect(h.updates.some((u) => u.table === 'consensi_accettazioni')).toBe(false)
  })

  it('execute: genitore orfano senza auth_user_id → nessuna DELETE', async () => {
    h.parentsAuth = [{ auth_user_id: null }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    expect(h.deletedTables).not.toContain('news_visualizzazioni')
    const json = await res.json()
    expect(json.news_visualizzazioni_rimosse).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LE DUE LETTURE CHE DECIDONO L'OBLIO, E CHE BUTTAVANO VIA `{ error }`.
//
// **PostgREST non lancia** (AGENTS.md, regola 7): l'errore torna nel valore, e
// il `try/catch` di questo handler su quel ramo non scatta mai. Qui le due
// conseguenze sono le peggiori dell'applicazione, perché questa è la rotta che
// risponde alle richieste di cancellazione delle FAMIGLIE:
//
//  (a) `alunni`: una lettura fallita usciva dalla porta del 404 «Alunno non
//      trovato» — cioè a una richiesta ex art. 17 si rispondeva che il bambino
//      non esiste, ed è l'unica risposta che nessuno pensa di riprovare;
//  (b) `student_parents`: una lettura fallita lasciava `parentIds` a `[]`, e
//      **i genitori non venivano anonimizzati affatto**. L'operazione riusciva,
//      rispondeva 200, contava zero adulti e nessuno poteva accorgersene. Un
//      oblio eseguito a metà è peggio di un oblio fallito: il secondo si ripete.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/admin/gdpr/erase — «non c’è» e «non l’ho potuto leggere»', () => {
  it('lettura dell’anagrafica fallita → 500, mai il 404 che dice «non esiste»', async () => {
    h.alunnoError = { code: '42501', message: 'permission denied for table alunni' }
    const res = await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('Alunno non trovato')
  })

  it('lettura dei genitori fallita → 500, e NESSUNA anonimizzazione parziale', async () => {
    h.linksError = { code: '42501', message: 'permission denied for table student_parents' }
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'Rossi Marco' }))
    expect(res.status).toBe(500)
    // Il punto non è lo status: è che il bambino NON è stato anonimizzato da
    // solo, lasciando i suoi genitori in chiaro e la richiesta chiusa.
    expect(h.updates.some((u) => u.table === 'alunni')).toBe(false)
  })

  it('nessun errore: il 404 di sempre resta al suo posto', async () => {
    h.alunno = null
    expect((await POST(req({ alunno_id: 'nope', mode: 'dryrun' }))).status).toBe(404)
  })
})
