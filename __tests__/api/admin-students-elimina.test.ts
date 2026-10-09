// __tests__/api/admin-students-elimina.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { redact } from '@/lib/logging/redact'
import { riduciValoreAudit } from '@/lib/audit/riassunto'
import { MOTIVO_CHIAVI_CONDIVISE } from '@/lib/gdpr/chiavi-condivise'

// =============================================================================
// `POST /api/admin/students/elimina` — l'eliminazione definitiva dai «non iscritti».
// Le asserzioni sono sulla MUTAZIONE (che cosa è stato chiamato, scritto,
// tolto dai bucket) e sull'ORDINE: la verifica della funzione SQL, poi le tracce
// di testo senza FK, poi i file, poi il database, la traccia nuova solo a cose
// fatte. Un 200 da solo non dice niente — e un errore da solo nemmeno: dopo il
// primo effetto, ogni risposta deve dire che cosa è GIÀ successo.
// =============================================================================

const AL = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ISCRITTO = 'c3c3c3c3-3333-4333-8333-cccccccccccc'
const OP = 'admin/students/elimina:POST'

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

/** L'esito di `anonimizzaAlunno` senza niente di rimasto indietro. */
const ANONIMIZZA_OK = {
  riconciliazione: 0,
  incassi: 0,
  cassa: 0,
  file: 0,
  fileNonRimossi: 0,
  segnalazioniBonificate: 0,
  sospensioniBonificate: 0,
  iscrizioniScrubbate: 0,
  fotoRimosse: 0,
  fotoSganciate: 0,
  presenzeBonificate: 0,
  diarioBonificate: 0,
  notificheRimosse: 0,
  videoIntentiTrattati: 0,
  videoIntentiRevocati: 0,
  lettureFallite: 0,
  chiaviCondiviseEscluse: { codiceFiscale: 0, documento: 0 },
}

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  anonimizzaAlunno: vi.fn(),
  bonificaAuditScritture: vi.fn(),
  bonificaTracce: vi.fn(),
  rpc: vi.fn(),
  verifica: vi.fn(),
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
  /** Errori del finto, letti a ogni query: si possono accendere a metà richiesta (es. dentro la RPC). */
  errori: {} as Record<string, { code: string; message: string }>,
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
      errori: h.errori,
      rpc: {
        elimina_alunno_definitivo: (args) => {
          if (args.p_solo_verifica === true) { h.ordine.push('verifica'); return h.verifica(args) }
          h.ordine.push('rpc')
          return h.rpc(args)
        },
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

/** I campi di UNA chiamata a `logEvento` con quell'esito. */
function campiDelLog(esito: string): Record<string, unknown> {
  const chiamata = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)
  expect(chiamata, `nessun log con esito «${esito}»`).toBeDefined()
  return chiamata![2] as Record<string, unknown>
}

/** Pagamenti presenti ma non cancellabili (un incasso): resta solo «anonimizza». */
function conPagamentoBloccato() {
  h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
  h.db.incassi = [{ id: 'inc-1', pagamento_id: 'pag-1' }]
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.rpc.mockReturnValue({ data: { ok: true, code: 'eliminato', righe: { legami: 0 } }, error: null })
  // `p_solo_verifica: true`: tutti i controlli della funzione, nessuna cancellazione.
  h.verifica.mockReturnValue({ data: { ok: true, code: 'ammissibile' }, error: null })
  // Come la funzione vera: la scheda risulta anonimizzata dopo la chiamata.
  h.anonimizzaAlunno.mockImplementation(async (_s: unknown, alunno: { id: string }) => {
    const riga = h.db.alunni.find((a) => a.id === alunno.id)
    if (riga) riga.anonimizzato_il = '2026-10-09T00:00:00.000Z'
    return { ...ANONIMIZZA_OK }
  })
  h.bonificaAuditScritture.mockResolvedValue(3)
  h.bonificaTracce.mockResolvedValue({ ...TRACCE_OK })
  h.db = dbDiProva()
  h.scritture = []
  h.rimossi = []
  h.bloccati = []
  h.ordine = []
  h.registroDopoMisura = null
  h.lettureRegistro = 0
  h.errori = {}
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
    expect(h.verifica).not.toHaveBeenCalled()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
  })

  it('fuori sede: 403 e nessun effetto', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-b', role: 'segreteria', scuola_id: SEDE_B } })
    h.db.utenti = [{ id: 'seg-b', ruolo: 'segreteria', scuola_id: SEDE_B }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.verifica).not.toHaveBeenCalled()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
  })

  it('chi FREQUENTA non si elimina: 409 ALUNNO_ELIMINAZIONE_FREQUENTANTE', async () => {
    const res = await POST(req({ alunno_id: ISCRITTO, mode: 'dryrun' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_FREQUENTANTE')
  })

  it('execute su stato NULL con una sezione (frequenta: il default è «iscritto»): 409 e nessun effetto', async () => {
    h.db.alunni[0] = { ...h.db.alunni[0], stato: null, section_id: 'sez-1' }
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_FREQUENTANTE')
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('execute su una scheda già anonimizzata: 404 «non è più in elenco», nessun effetto, e il log dice «anonimizzato»', async () => {
    // Non «questo frequenta ancora», che sarebbe falso: dopo un'anonimizzazione la
    // scheda è uscita da ogni elenco, e la cosa giusta da fare è ricaricare.
    h.db.alunni[0] = { ...h.db.alunni[0], anonimizzato_il: '2026-09-01T00:00:00.000Z' }
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_NON_TROVATO')
    expect(campiDelLog('eliminazione-rifiutata-gia-anonimizzato').tipo).toBe('anonimizzato')
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
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
    expect(h.verifica).not.toHaveBeenCalled()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
  })

  it('con il registro della primaria: nessuna scelta, motivo REGISTRO_PRIMARIA_DA_CONSERVARE', async () => {
    h.db.valutazioni = [{ id: 'v-1', alunno_id: AL }]
    const j = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(j.scelte).toEqual({ elimina: false, elimina_con_pagamenti: false, anonimizza: false })
    expect(j.motivo).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
  })

  it('iscritto SENZA SEZIONE con pagamenti bloccati: nessuna scelta, «prima ritira il bambino»', async () => {
    h.db.alunni[0] = { ...h.db.alunni[0], stato: 'iscritto', section_id: null }
    conPagamentoBloccato()
    const j = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(j.scelte).toEqual({ elimina: false, elimina_con_pagamenti: false, anonimizza: false })
    expect(j.motivo).toBe('ALUNNO_ELIMINAZIONE_ARCHIVIA_PRIMA')
  })

  it('l’avviso doppione guarda SOLO le sedi dell’operatore: niente si rivela fuori sede', async () => {
    const CF = 'CFDIPROVA0000001'
    h.db.alunni[0] = { ...h.db.alunni[0], codice_fiscale: CF }
    // Lo stesso codice su un bambino che frequenta, ma in una sede che la segreteria non vede.
    h.db.alunni[1] = { ...h.db.alunni[1], codice_fiscale: CF, scuola_id: SEDE_B }
    let j = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(j.conteggi.cf_condiviso_con_frequentante).toBe(false)
    // Nella SUA sede, invece, l'avviso c'è: il filtro è la sede, non altro.
    h.db.alunni[1] = { ...h.db.alunni[1], scuola_id: SEDE_A }
    j = await (await POST(req({ alunno_id: AL, mode: 'dryrun' }))).json()
    expect(j.conteggi.cf_condiviso_con_frequentante).toBe(true)
  })
})

describe('execute — la scelta deve essere fra quelle offerte, e il rifiuto dice PERCHÉ', () => {
  it.each<{ caso: string; prepara: () => void; scelta: string; codice: string }>([
    {
      caso: 'nessun motivo (scelta che non esiste per lui)',
      prepara: () => {},
      scelta: 'elimina_con_pagamenti',
      codice: 'ALUNNO_ELIMINAZIONE_SCELTA_NON_DISPONIBILE',
    },
    {
      caso: 'registro della primaria',
      prepara: () => { h.db.valutazioni = [{ id: 'v-1', alunno_id: AL }] },
      scelta: 'elimina',
      codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE',
    },
    {
      caso: 'pagamenti cancellabili, scelta «elimina»',
      prepara: () => { h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }] },
      scelta: 'elimina',
      codice: 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI',
    },
    {
      caso: 'pagamenti bloccati, scelta «elimina_con_pagamenti»',
      prepara: conPagamentoBloccato,
      scelta: 'elimina_con_pagamenti',
      codice: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI',
    },
    {
      caso: 'una foto solo sua con un indirizzo che l’archivio non riconosce',
      prepara: () => {
        h.db.galleria_media_v2 = [
          { id: 'm-1', file_url: 'https://esterno.example.invalid/foto-finta.jpg', file_type: 'foto', tag_students: [AL] },
        ]
      },
      scelta: 'elimina',
      codice: 'ALUNNO_ELIMINAZIONE_FOTO_NON_RIMOVIBILI',
    },
    {
      caso: 'iscritto SENZA SEZIONE con pagamenti bloccati, scelta «anonimizza»',
      prepara: () => {
        h.db.alunni[0] = { ...h.db.alunni[0], stato: 'iscritto', section_id: null }
        conPagamentoBloccato()
      },
      scelta: 'anonimizza',
      codice: 'ALUNNO_ELIMINAZIONE_ARCHIVIA_PRIMA',
    },
    {
      caso: 'iscritto SENZA SEZIONE con pagamenti cancellabili, scelta «anonimizza»',
      prepara: () => {
        h.db.alunni[0] = { ...h.db.alunni[0], stato: 'iscritto', section_id: null }
        h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
      },
      scelta: 'anonimizza',
      codice: 'ALUNNO_ELIMINAZIONE_ARCHIVIA_PRIMA',
    },
  ])('$caso → 409 $codice e nessun effetto', async ({ prepara, scelta, codice }) => {
    prepara()
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe(codice)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.verifica).not.toHaveBeenCalled()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
  })
})

describe('execute — elimina', () => {
  it('ORDINE: verifica senza effetti → tracce di testo → file → funzione SQL → bonifica audit → traccia', async () => {
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(200)
    expect(h.verifica).toHaveBeenCalledWith({ p_alunno: AL, p_con_pagamenti: false, p_solo_verifica: true })
    expect(h.bonificaTracce).toHaveBeenCalledWith(expect.anything(), AL, OP)
    expect(h.rpc).toHaveBeenCalledWith({ p_alunno: AL, p_con_pagamenti: false, p_solo_verifica: false })
    expect(h.bonificaAuditScritture).toHaveBeenCalledWith(expect.anything(), [AL], OP)
    const verifica = h.ordine.indexOf('verifica')
    const tracce = h.ordine.indexOf('tracce')
    const primoStorage = h.ordine.indexOf('storage')
    const primoRpc = h.ordine.indexOf('rpc')
    expect(verifica).toBeGreaterThanOrEqual(0)
    expect(tracce).toBeGreaterThan(verifica)
    expect(primoStorage).toBeGreaterThan(tracce)
    expect(h.ordine.lastIndexOf('storage')).toBeLessThan(primoRpc)
    expect(h.ordine.indexOf('bonifica')).toBeGreaterThan(primoRpc)
    expect(h.ordine.indexOf('audit')).toBeGreaterThan(h.ordine.indexOf('bonifica'))
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunno_eliminato', azione: 'delete', entitaId: AL, scuolaId: SEDE_A }),
    )
  })

  it('funzione assente (DB non migrato): la VERIFICA lo dice PRIMA di ogni effetto → 503, niente toccato', async () => {
    h.verifica.mockReturnValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(503)
    const j = await res.json()
    expect(j.codice).toBe('ALUNNO_ELIMINAZIONE_NON_DISPONIBILE')
    expect(j.effetti).toBeUndefined()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('la verifica fallisce per un altro motivo: 500 e niente toccato', async () => {
    h.verifica.mockReturnValue({ data: null, error: { code: '57014', message: 'canceling statement' } })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('ALUNNO_ELIMINAZIONE_NON_RIUSCITA')
    expect(j.effetti).toBeUndefined()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('la verifica risponde qualcosa che non è «ammissibile» né un rifiuto: 500 e niente toccato', async () => {
    h.verifica.mockReturnValue({ data: { ok: true, code: 'eliminato' }, error: null })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(500)
    expect((await res.json()).effetti).toBeUndefined()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each<{ code: string; status: number; codice: string }>([
    { code: 'non_trovato', status: 404, codice: 'ALUNNO_ELIMINAZIONE_NON_TROVATO' },
    { code: 'frequentante', status: 409, codice: 'ALUNNO_ELIMINAZIONE_FREQUENTANTE' },
    { code: 'gia_anonimizzato', status: 404, codice: 'ALUNNO_ELIMINAZIONE_NON_TROVATO' },
    { code: 'registro_primaria', status: 409, codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE' },
    { code: 'ha_pagamenti', status: 409, codice: 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI' },
    { code: 'pagamenti_non_cancellabili', status: 409, codice: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI' },
    { code: 'codice_mai_visto', status: 500, codice: 'ALUNNO_ELIMINAZIONE_NON_RIUSCITA' },
  ])('la VERIFICA rifiuta con «$code»: $status $codice, e nessun effetto (niente `effetti` da dire)', async ({ code, status, codice }) => {
    h.verifica.mockReturnValue({ data: { ok: false, code }, error: null })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(status)
    const j = await res.json()
    expect(j.codice).toBe(codice)
    expect(j.effetti).toBeUndefined()
    expect(h.bonificaTracce).not.toHaveBeenCalled()
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(campiDelLog('eliminazione-rifiutata-in-verifica')).toMatchObject({ tipo: code, entita_id: AL })
  })

  it('tracce di testo incomplete: 500 PRIMA di file e database, con gli effetti già avvenuti', async () => {
    h.bonificaTracce.mockResolvedValue({ ...TRACCE_OK, completo: false, threadLetti: false })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('ALUNNO_ELIMINAZIONE_NON_RIUSCITA')
    expect(j.effetti).toEqual({ tracce: { notifiche: 2, segnalazioni: 1, sospensioni: 0 }, file: null })
    expect(h.rimossi).toEqual([])
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.bonificaAuditScritture).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(campiDelLog('eliminazione-ferma-tracce-incomplete')).toMatchObject({
      entita_id: AL, n_notifiche: 2, n_segnalazioni: 1,
    })
  })

  it('la traccia non contiene la riga dell’alunno: niente nome, cognome, percorso', async () => {
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    const testo = JSON.stringify(h.logScrittura.mock.calls[0][1])
    expect(testo).not.toContain('DiProva')
    expect(testo).not.toContain('doc-finto')
  })

  it('il numero del documento tolto SOPRAVVIVE alla riduzione dell’audit', async () => {
    // `riduciValoreAudit` riduce la chiave `documento` a qualunque profondità: col
    // nome corto il registro diceva «[non registrato]» al posto di 1.
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    const ridotto = riduciValoreAudit(h.logScrittura.mock.calls[0][1].valoreDopo) as Record<string, unknown>
    expect(ridotto).toMatchObject({ file: { documenti_rimossi: 1 }, tracce: { notifiche: 2, segnalazioni: 1 } })
  })

  it('un file che non esce ferma TUTTO prima del database: 502, gli effetti detti, nessuna traccia', async () => {
    h.bloccati = ['iscrizioni/doc-finto.pdf']
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(502)
    const j = await res.json()
    expect(j.codice).toBe('ALUNNO_ELIMINAZIONE_FILE_RESTANTI')
    expect(j.effetti).toMatchObject({ tracce: { notifiche: 2, segnalazioni: 1 }, file: { restanti: 1 } })
    // Il file c'era ed è stato tentato: il 502 non nasce da una lettura fallita.
    expect(h.rimossi.flatMap((r) => r.percorsi)).toContain('iscrizioni/doc-finto.pdf')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it.each<{ code: string; status: number; codice: string }>([
    { code: 'non_trovato', status: 404, codice: 'ALUNNO_ELIMINAZIONE_NON_TROVATO' },
    { code: 'frequentante', status: 409, codice: 'ALUNNO_ELIMINAZIONE_FREQUENTANTE' },
    { code: 'gia_anonimizzato', status: 404, codice: 'ALUNNO_ELIMINAZIONE_NON_TROVATO' },
    { code: 'registro_primaria', status: 409, codice: 'REGISTRO_PRIMARIA_DA_CONSERVARE' },
    { code: 'ha_pagamenti', status: 409, codice: 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI' },
    { code: 'pagamenti_non_cancellabili', status: 409, codice: 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI' },
    { code: 'codice_mai_visto', status: 500, codice: 'ALUNNO_ELIMINAZIONE_NON_RIUSCITA' },
  ])('il database rifiuta con «$code»: $status $codice, gli effetti detti e registrati, nessuna traccia', async ({ code, status, codice }) => {
    h.rpc.mockReturnValue({ data: { ok: false, code }, error: null })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(status)
    const j = await res.json()
    expect(j.codice).toBe(codice)
    expect(j.effetti).toMatchObject({
      tracce: { notifiche: 2, segnalazioni: 1 },
      file: { documenti_rimossi: 1, restanti: 0 },
    })
    expect(campiDelLog('eliminazione-rifiutata-dal-db')).toMatchObject({
      tipo: code, entita_id: AL, n_notifiche: 2, n_segnalazioni: 1, n_documenti: 1,
    })
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.bonificaAuditScritture).not.toHaveBeenCalled()
  })

  it('errore della RPC e la scheda c’è ancora: 500 con gli effetti già avvenuti', async () => {
    h.rpc.mockReturnValue({ data: null, error: { code: '57014', message: 'canceling statement' } })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('ALUNNO_ELIMINAZIONE_NON_RIUSCITA')
    expect(j.effetti).toMatchObject({ tracce: { notifiche: 2, segnalazioni: 1 }, file: { documenti_rimossi: 1 } })
    expect(campiDelLog('eliminazione-non-riuscita')).toMatchObject({ entita_id: AL, n_notifiche: 2 })
    expect(h.logScrittura).not.toHaveBeenCalled()
    expect(h.bonificaAuditScritture).not.toHaveBeenCalled()
  })

  it('RPC fallita E rilettura della scheda fallita: esito SCONOSCIUTO, non «non riuscita»', async () => {
    // Non si sa se il commit è avvenuto: dire «non riuscita» (e quindi «la scheda
    // è intatta») potrebbe essere falso. Si dice che non si sa, con gli effetti.
    h.rpc.mockImplementation(() => {
      h.errori['alunni:select'] = { code: '08006', message: 'connessione interrotta' }
      return { data: null, error: { code: '08006', message: 'connessione interrotta' } }
    })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.codice).toBe('ALUNNO_ELIMINAZIONE_ESITO_SCONOSCIUTO')
    expect(j.effetti).toMatchObject({ tracce: { notifiche: 2 }, file: { documenti_rimossi: 1 } })
    expect(campiDelLog('eliminazione-esito-sconosciuto')).toMatchObject({ entita_id: AL, n_notifiche: 2 })
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('esito incerto: la RPC risponde errore ma la scheda NON c’è più → completa la traccia, 200 incerto', async () => {
    // Il commit è avvenuto, la risposta si è persa per strada.
    h.rpc.mockImplementation(() => {
      h.db.alunni = h.db.alunni.filter((a) => a.id !== AL)
      return { data: null, error: { code: '08006', message: 'connessione interrotta' } }
    })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, incerto: true, scelta: 'elimina' })
    expect(h.bonificaAuditScritture).toHaveBeenCalledWith(expect.anything(), [AL], OP)
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entitaTipo: 'alunno_eliminato',
        entitaId: AL,
        valoreDopo: expect.objectContaining({ esito_incerto: true }),
      }),
    )
    expect(campiDelLog('alunno-eliminato')).toMatchObject({ esito_incerto: true })
  })

  it('con pagamenti cancellabili: «elimina_con_pagamenti» passa p_con_pagamenti=true, alla verifica e alla chiamata vera', async () => {
    h.db.pagamenti = [{ id: 'pag-1', alunno_id: AL, parent_payment_id: null }]
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina_con_pagamenti' }))
    expect(res.status).toBe(200)
    expect(h.verifica).toHaveBeenCalledWith({ p_alunno: AL, p_con_pagamenti: true, p_solo_verifica: true })
    expect(h.rpc).toHaveBeenCalledWith({ p_alunno: AL, p_con_pagamenti: true, p_solo_verifica: false })
    expect(h.ordine.indexOf('tracce')).toBeLessThan(h.ordine.indexOf('storage'))
  })

  it('il successo lascia un log, con soli identificativi e i numeri che passano la redazione', async () => {
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    expect(h.logEvento).toHaveBeenCalledWith(
      'gdpr',
      'info',
      expect.objectContaining({
        esito: 'alunno-eliminato', entita_id: AL, n_notifiche: 2, n_segnalazioni: 1, n_audit_bonificate: 3,
      }),
    )
    // I numeri devono USCIRE dalla redazione come numeri, non come `[redatto…]`.
    const campi = campiDelLog('alunno-eliminato')
    expect(redact(campi)).toMatchObject({
      n_notifiche: 2, n_segnalazioni: 1, n_audit_bonificate: 3, n_documenti: 1, n_file_restanti: 0,
    })
    // E i numeri stanno anche nella traccia immutabile.
    expect(h.logScrittura.mock.calls[0][1].valoreDopo).toMatchObject({
      tracce: { notifiche: 2, segnalazioni: 1, sospensioni: 0 },
      audit_bonificate: 3,
    })
  })

  it('anche i numeri dei rifiuti passano la redazione', async () => {
    h.rpc.mockReturnValue({ data: { ok: false, code: 'ha_pagamenti' }, error: null })
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'elimina' }))
    const campi = campiDelLog('eliminazione-rifiutata-dal-db')
    expect(redact(campi)).toMatchObject({
      tipo: 'ha_pagamenti', n_notifiche: 2, n_segnalazioni: 1, n_documenti: 1, n_file_restanti: 0,
    })
  })
})

describe('execute — anonimizza', () => {
  it('chiama la funzione dell’oblio sul solo bambino, mai la RPC (nemmeno la verifica)', async () => {
    conPagamentoBloccato()
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, scelta: 'anonimizza', parziale: false })
    expect(h.anonimizzaAlunno).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: AL }),
      expect.any(String),
      OP,
    )
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.verifica).not.toHaveBeenCalled()
    // Il registro si rilegge SUBITO PRIMA dell'anonimizzazione, non solo nella misura.
    expect(h.lettureRegistro).toBe(2)
    expect(h.ordine.lastIndexOf('registro')).toBeLessThan(h.ordine.indexOf('anonimizza'))
    expect(h.logScrittura).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entitaTipo: 'alunno_anonimizzato', valoreDopo: expect.objectContaining({ parziale: false }) }),
    )
    expect(h.logEvento).toHaveBeenCalledWith('gdpr', 'info', expect.objectContaining({ esito: 'alunno-anonimizzato' }))
  })

  it.each<{ caso: string; esito: Partial<typeof ANONIMIZZA_OK>; lasciaLaScheda?: boolean; numeri: Record<string, unknown> }>([
    { caso: 'un file non è uscito', esito: { fileNonRimossi: 1 }, numeri: { file_non_rimossi: 1, letture_fallite: 0, scheda_anonimizzata: true } },
    { caso: 'un archivio non si è potuto leggere', esito: { lettureFallite: 2 }, numeri: { file_non_rimossi: 0, letture_fallite: 2, scheda_anonimizzata: true } },
    { caso: 'la scheda non risulta anonimizzata', esito: {}, lasciaLaScheda: true, numeri: { file_non_rimossi: 0, letture_fallite: 0, scheda_anonimizzata: false } },
  ])('PARZIALE se $caso: 200 con parziale=true, log a livello error, numeri nella traccia', async ({ esito, lasciaLaScheda, numeri }) => {
    conPagamentoBloccato()
    h.anonimizzaAlunno.mockImplementation(async (_s: unknown, alunno: { id: string }) => {
      const riga = h.db.alunni.find((a) => a.id === alunno.id)
      if (riga && !lasciaLaScheda) riga.anonimizzato_il = '2026-10-09T00:00:00.000Z'
      return { ...ANONIMIZZA_OK, ...esito }
    })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, parziale: true, numeri })
    expect(h.logEvento).toHaveBeenCalledWith('gdpr', 'error', expect.objectContaining({ esito: 'anonimizzazione-parziale', entita_id: AL }))
    expect(h.logEvento).not.toHaveBeenCalledWith('gdpr', 'info', expect.objectContaining({ esito: 'alunno-anonimizzato' }))
    expect(h.logScrittura.mock.calls[0][1].valoreDopo).toMatchObject({ parziale: true, ...numeri })
    // I numeri del log escono dalla redazione come sono.
    const campi = campiDelLog('anonimizzazione-parziale')
    expect(redact(campi)).toMatchObject({
      n_file: numeri.file_non_rimossi,
      n_letture_fallite: numeri.letture_fallite,
      scheda_anonimizzata: numeri.scheda_anonimizzata,
    })
  })

  it('le chiavi condivise escluse (CF, documento di un altro bambino) finiscono nella traccia, e sopravvivono alla riduzione', async () => {
    conPagamentoBloccato()
    h.anonimizzaAlunno.mockImplementation(async (_s: unknown, alunno: { id: string }) => {
      const riga = h.db.alunni.find((a) => a.id === alunno.id)
      if (riga) riga.anonimizzato_il = '2026-10-09T00:00:00.000Z'
      // La forma di `anonimizzaAlunno` (src/lib/gdpr/esegui.ts): due conteggi.
      return { ...ANONIMIZZA_OK, chiaviCondiviseEscluse: { codiceFiscale: 1, documento: 0 } }
    })
    await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    const ridotto = riduciValoreAudit(h.logScrittura.mock.calls[0][1].valoreDopo) as Record<string, unknown>
    expect(ridotto).toMatchObject({
      chiavi_condivise_escluse: { codice_fiscale_escluso: 1, documento_escluso: 0 },
    })
  })

  it('una chiave condivisa con un doppione rende l’anonimizzazione PARZIALE: 200 parziale, log error, motivo in risposta', async () => {
    // File tolti, archivi letti, scheda anonimizzata: l'unico motivo è la chiave
    // lasciata fuori — e i dati agganciati a lei sono ancora in chiaro.
    conPagamentoBloccato()
    h.anonimizzaAlunno.mockImplementation(async (_s: unknown, alunno: { id: string }) => {
      const riga = h.db.alunni.find((a) => a.id === alunno.id)
      if (riga) riga.anonimizzato_il = '2026-10-09T00:00:00.000Z'
      return { ...ANONIMIZZA_OK, chiaviCondiviseEscluse: { codiceFiscale: 1, documento: 1 } }
    })
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      parziale: true,
      numeri: { file_non_rimossi: 0, letture_fallite: 0, scheda_anonimizzata: true },
      chiavi_condivise_escluse: 2,
      chiavi_condivise_motivo: MOTIVO_CHIAVI_CONDIVISE,
    })
    expect(h.logEvento).toHaveBeenCalledWith('gdpr', 'error', expect.objectContaining({ esito: 'anonimizzazione-parziale', entita_id: AL }))
    expect(h.logEvento).not.toHaveBeenCalledWith('gdpr', 'info', expect.objectContaining({ esito: 'alunno-anonimizzato' }))
    expect(redact(campiDelLog('anonimizzazione-parziale'))).toMatchObject({ n_chiavi_condivise: 2 })
    expect(h.logScrittura.mock.calls[0][1].valoreDopo).toMatchObject({ parziale: true })
  })

  it('senza chiavi condivise la risposta lo dice: zero e nessun motivo', async () => {
    conPagamentoBloccato()
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(await res.json()).toMatchObject({ parziale: false, chiavi_condivise_escluse: 0, chiavi_condivise_motivo: null })
  })

  it('con un voto arrivato DOPO la misura: 409 e nessuna anonimizzazione', async () => {
    conPagamentoBloccato()
    h.registroDopoMisura = 'voto'
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('REGISTRO_PRIMARIA_DA_CONSERVARE')
    expect(h.lettureRegistro).toBe(2)
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('con il registro illeggibile alla seconda lettura: 500 e nessuna anonimizzazione', async () => {
    conPagamentoBloccato()
    h.registroDopoMisura = 'guasto'
    const res = await POST(req({ alunno_id: AL, mode: 'execute', scelta: 'anonimizza' }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ALUNNO_ELIMINAZIONE_NON_MISURATA')
    expect(h.anonimizzaAlunno).not.toHaveBeenCalled()
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
})
