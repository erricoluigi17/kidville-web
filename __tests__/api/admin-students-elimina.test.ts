// __tests__/api/admin-students-elimina.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { redact } from '@/lib/logging/redact'

// =============================================================================
// `POST /api/admin/students/elimina` — l'eliminazione definitiva dai «non iscritti».
// Le asserzioni sono sulla MUTAZIONE (che cosa è stato chiamato, scritto,
// tolto dai bucket) e sull'ORDINE: prima le tracce di testo senza FK, poi i
// file, poi il database, la traccia nuova solo a cose fatte. Un 200 da solo non
// dice niente.
// =============================================================================

const AL = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ISCRITTO = 'c3c3c3c3-3333-4333-8333-cccccccccccc'

/** L'esito di `bonificaTracceTestualiAlunno` quando tutto è andato a buon fine. */
const TRACCE_OK = {
  notificheRimosse: 2,
  segnalazioniBonificate: 1,
  sospensioniBonificate: 0,
  completo: true,
  threadIds: [] as string[],
  threadLetti: true,
  auditDiarioCompleto: true,
}

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  anonimizzaAlunno: vi.fn(),
  bonificaAuditScritture: vi.fn(),
  bonificaTracce: vi.fn(),
  rpc: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  rimossi: [] as { bucket: string; percorsi: string[] }[],
  bloccati: [] as string[],
  ordine: [] as string[],
  /**
   * Che cosa succede al registro della primaria DOPO la prima lettura (la misura):
   *  · 'voto'   → arriva un voto vero nel database finto, e la seconda lettura lo trova;
   *  · 'guasto' → la seconda lettura non riesce.
   * È la corsa fra l'anteprima e il clic: la misura ha detto «niente registro».
   */
  registroDopoMisura: null as null | 'voto' | 'guasto',
  lettureRegistro: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({
  logScrittura: (...a: unknown[]) => { h.ordine.push('audit'); return h.logScrittura(...a) },
}))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/gdpr/esegui', async (originale) => {
  const vero = await originale<typeof import('@/lib/gdpr/esegui')>()
  return {
    ...vero,
    anonimizzaAlunno: (...a: unknown[]) => { h.ordine.push('anonimizza'); return h.anonimizzaAlunno(...a) },
    bonificaAuditScritture: (...a: unknown[]) => { h.ordine.push('bonifica'); return h.bonificaAuditScritture(...a) },
    bonificaTracceTestualiAlunno: (...a: unknown[]) => { h.ordine.push('tracce'); return h.bonificaTracce(...a) },
  }
})
vi.mock('@/lib/alunni/registro-primaria', async (originale) => {
  const vero = await originale<typeof import('@/lib/alunni/registro-primaria')>()
  return {
    ...vero,
    leggiRegistroPrimaria: async (...a: Parameters<typeof vero.leggiRegistroPrimaria>) => {
      h.ordine.push('registro')
      h.lettureRegistro++
      if (h.lettureRegistro > 1 && h.registroDopoMisura === 'guasto') {
        return { ok: false as const, errore: { code: '57014', message: 'lettura annullata' } }
      }
      const esito = await vero.leggiRegistroPrimaria(...a)
      // Il voto arriva SUBITO DOPO la misura: la lettura vera successiva lo trova.
      if (h.lettureRegistro === 1 && h.registroDopoMisura === 'voto') {
        h.db.valutazioni.push({ id: 'v-tardivo', alunno_id: AL })
      }
      return esito
    },
  }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const client = () => {
    const base = creaFintoSupabase(h.db as DBFinto, [], {
      scritture: h.scritture as Scrittura[],
      rpc: {
        elimina_alunno_definitivo: (args) => { h.ordine.push('rpc'); return h.rpc(args) },
        video_intent_oblio_alunno: () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }),
      },
    }) as unknown as Record<string, unknown>
    base.storage = {
      from: (bucket: string) => ({
        remove: async (percorsi: string[]) => {
          h.ordine.push('storage')
          h.rimossi.push({ bucket, percorsi })
          return { data: percorsi.filter((p) => !h.bloccati.includes(p)).map((p) => ({ name: p })), error: null }
        },
        list: async (cartella: string, opzioni?: { search?: string }) => {
          const nome = opzioni?.search ?? ''
          const pieno = cartella ? `${cartella}/${nome}` : nome
          return { data: h.bloccati.includes(pieno) ? [{ name: nome }] : [], error: null }
        },
      }),
    }
    return base
  }
  return { createAdminClient: async () => client(), createClient: async () => client() }
})

import { POST } from '@/app/api/admin/students/elimina/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/students/elimina', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

function dbDiProva(): Record<string, Record<string, unknown>[]> {
  return {
    utenti: [{ id: 'seg-1', ruolo: 'segreteria', scuola_id: SEDE_A }],
    utenti_scuole: [],
    alunni: [
      { id: AL, nome: 'Bambino', cognome: 'DiProva', stato: 'ritirato', scuola_id: SEDE_A, section_id: null,
        anonimizzato_il: null, documento_path: 'iscrizioni/doc-finto.pdf', codice_fiscale: null, fiscal_code: null },
      { id: ISCRITTO, nome: 'Altro', cognome: 'DiProva', stato: 'iscritto', scuola_id: SEDE_A, section_id: 'sez-1',
        anonimizzato_il: null, documento_path: null, codice_fiscale: null, fiscal_code: null },
    ],
    // Il documento d'identità NON è nominato da nessuna domanda né da un genitore:
    // solo così è «suo» e `rimuoviFileAlunno` prova a toglierlo (vedi `documentoCondiviso`).
    parents: [],
    enrollment_submissions: [],
    presenze: [{ id: 'pr-1', alunno_id: AL }],
    eventi_diario: [],
    student_parents: [{ student_id: AL, parent_id: 'p-1' }],
    pagamenti: [], ricevute_emesse: [], fatture_emesse: [], fatture_coda: [], riconciliazione_movimenti: [], incassi: [],
    valutazioni: [], pagelle: [], scrutinio_giudizi: [], scrutinio_comportamento: [], note_disciplinari: [],
    certificati_competenze: [], certificati_medici: [], student_documents: [], galleria_media_v2: [],
    news_posts: [], chat_threads: [], chat_messages: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.rpc.mockReturnValue({ data: { ok: true, code: 'eliminato', righe: { legami: 0 } }, error: null })
  h.anonimizzaAlunno.mockResolvedValue({ riconciliazione: 0, incassi: 0, cassa: 0, file: 0 })
  h.bonificaAuditScritture.mockResolvedValue(0)
  h.bonificaTracce.mockResolvedValue({ ...TRACCE_OK })
  h.db = dbDiProva()
  h.scritture = []
  h.rimossi = []
  h.bloccati = []
  h.ordine = []
  h.registroDopoMisura = null
  h.lettureRegistro = 0
})

describe('POST /api/admin/students/elimina — chi, su chi', () => {
  it('il gate riceve ESATTAMENTE [admin, coordinator, segreteria]', async () => {
    await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(h.requireStaff.mock.calls[0][1]).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it('403 dal gate: nessuna lettura, nessun effetto', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
  })

  it('fuori sede: rifiuto e nessun effetto', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-b', role: 'segreteria', scuola_id: SEDE_B } })
    h.db.utenti = [{ id: 'seg-b', ruolo: 'segreteria', scuola_id: SEDE_B }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBeGreaterThanOrEqual(403)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
  })

  it('chi FREQUENTA non si elimina: 409 ALUNNO_ELIMINAZIONE_FREQUENTANTE', async () => {
    const res = await POST(req({ alunno_id: ISCRITTO, mode: 'dryrun' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_FREQUENTANTE')
  })

  it('execute senza scelta: 400 ALUNNO_ELIMINAZIONE_SCELTA_MANCANTE', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute' }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_SCELTA_MANCANTE')
  })
})

describe('dryrun', () => {
  it('conta e propone le scelte, SENZA scrivere niente', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({
      dryrun: true,
      conteggi: { presenze: 1, legami_genitori: 1, pagamenti: 0, registro_primaria: false },
      scelte: { elimina: true, elimina_con_pagamenti: false, anonimizza: false },
      motivo: null,
    })
    expect(h.scritture).toEqual([])
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
  })

  it('con il registro della primaria: nessuna scelta, motivo REGISTRO_PRIMARIA_DA_CONSERVARE', async () => {
    h.db.valutazioni = [{ id: 'v-1', alunno_id: AL }]
    const j = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(j.scelte).toEqual({ elimina: false, elimina_con_pagamenti: false, anonimizza: false })
    expect(j.motivo).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
  })
})

describe('execute', () => {
  it('ORDINE: tracce di testo → file → funzione SQL → bonifica audit → traccia', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(200)
    expect(h.bonificaTracce).toHaveBeenCalledWith(expect.anything(), AL, 'admin/students/elimina:POST')
    expect(h.rpc).toHaveBeenCalledWith({ p_alunno: AL, p_con_pagamenti: false })
    const tracce = h.ordine.indexOf('tracce')
    const primoStorage = h.ordine.indexOf('storage')
    const primoRpc = h.ordine.indexOf('rpc')
    expect(tracce).toBeGreaterThanOrEqual(0)
    expect(primoStorage).toBeGreaterThan(tracce)
    expect(h.ordine.lastIndexOf('storage')).toBeLessThan(primoRpc)
    expect(h.ordine.indexOf('bonifica')).toBeGreaterThan(primoRpc)
    expect(h.ordine.indexOf('audit')).toBeGreaterThan(h.ordine.indexOf('bonifica'))
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunno_eliminato', azione: 'delete', entitaId: AL, scuolaId: SEDE_A }),
    )
  })

  it('tracce di testo incomplete: 500 PRIMA di file e database, nessuna traccia', async () => {
    h.bonificaTracce.mockResolvedValue({ ...TRACCE_OK, completo: false, threadLetti: false })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_NON_RIUSCITA')
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.bonificaAuditScritture).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith(
      'gdpr',
      'warn',
      expect.objectContaining({ esito: 'eliminazione-ferma-tracce-incomplete', entita_id: AL }),
    )
  })

  it('la traccia non contiene la riga dell’alunno: niente nome, cognome, percorso', async () => {
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    const testo = JSON.stringify(h.logScrittura.mock.calls[0][1])
    expect(testo).not.toContain('DiProva')
    expect(testo).not.toContain('doc-finto')
  })

  it('un file che non esce ferma TUTTO prima del database: 502 e nessuna traccia', async () => {
    h.bloccati = ['iscrizioni/doc-finto.pdf']
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(502)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_FILE_RESTANTI')
    // Il file c'era ed è stato tentato: il 502 non nasce da una lettura fallita.
    expect(h.rimossi.flatMap((r) => r.percorsi)).toContain('iscrizioni/doc-finto.pdf')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('il database rifiuta (corsa: è arrivato un voto): 409 col codice giusto e nessuna traccia', async () => {
    h.rpc.mockReturnValue({ data: { ok: false, code: 'registro_primaria' }, error: null })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.bonificaAuditScritture).not.toHaveBeenCalled()
  })

  it('il database rifiuta con un codice che non conosce: 500, nessuna traccia', async () => {
    h.rpc.mockReturnValue({ data: { ok: false, code: 'codice_mai_visto' }, error: null })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_NON_RIUSCITA')
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('funzione assente (DB non migrato): 503 ALUNNO_ELIMINAZIONE_NON_DISPONIBILE', async () => {
    h.rpc.mockReturnValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_NON_DISPONIBILE')
  })

  it('una scelta non offerta dall’anteprima: 409 e nessun effetto', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina_con_pagamenti' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_SCELTA_NON_DISPONIBILE')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
  })

  it('con pagamenti cancellabili: «elimina_con_pagamenti» passa p_con_pagamenti=true', async () => {
    h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina_con_pagamenti' }))
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith({ p_alunno: AL, p_con_pagamenti: true })
    expect(h.ordine.indexOf('tracce')).toBeLessThan(h.ordine.indexOf('storage'))
  })

  it('«anonimizza» chiama la funzione dell’oblio sul solo bambino, mai la RPC', async () => {
    h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
    h.db.incassi = [{ id: 'inc-1', pagamento_id: 'pag-1' }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(200)
    expect(h.anonimizzaAlunno).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: AL }),
      expect.any(String),
      'admin/students/elimina:POST',
    )
    expect(h.rpc).not.toHaveBeenCalled()
    // Il registro si rilegge SUBITO PRIMA dell'anonimizzazione, non solo nella misura.
    expect(h.lettureRegistro).toBe(2)
    expect(h.ordine.lastIndexOf('registro')).toBeLessThan(h.ordine.indexOf('anonimizza'))
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunno_anonimizzato' }),
    )
  })

  it('«anonimizza» con un voto arrivato DOPO la misura: 409 e nessuna anonimizzazione', async () => {
    h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
    h.db.incassi = [{ id: 'inc-1', pagamento_id: 'pag-1' }]
    h.registroDopoMisura = 'voto'
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
    expect(h.lettureRegistro).toBe(2)
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('«anonimizza» con il registro illeggibile alla seconda lettura: 500 e nessuna anonimizzazione', async () => {
    h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
    h.db.incassi = [{ id: 'inc-1', pagamento_id: 'pag-1' }]
    h.registroDopoMisura = 'guasto'
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_NON_MISURATA')
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('il successo lascia un log, con soli identificativi e i numeri delle tracce', async () => {
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'gdpr',
      'info',
      expect.objectContaining({ esito: 'alunno-eliminato', entita_id: AL, n_notifiche: 2, n_segnalazioni: 1 }),
    )
    // I numeri devono USCIRE dalla redazione come numeri, non come `[redatto…]`.
    const campi = h.logEvento.mock.calls.find((c) => c[2]?.esito === 'alunno-eliminato')![2]
    expect(redact(campi)).toMatchObject({ n_notifiche: 2, n_segnalazioni: 1 })
    // E i numeri stanno anche nella traccia immutabile.
    expect(h.logScrittura.mock.calls[0][1].valoreDopo).toMatchObject({
      tracce: { notifiche: 2, segnalazioni: 1, sospensioni: 0 },
    })
  })
})
