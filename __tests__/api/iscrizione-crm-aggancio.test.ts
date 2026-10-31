// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'

/**
 * `POST /api/iscrizione` · l'aggancio al CRM della segreteria.
 *
 * La porta pubblica da cui arrivano le domande VERE non deve cambiare di una virgola per colpa del CRM
 * (anti-obiettivo 1 del piano): stesso stato, stesso corpo, stesso tempo — qualunque cosa faccia il CRM.
 * Le prime prove usano un `collegaDomandaAlCrm` finto che si comporta male in tutti i modi possibili
 * (esito d'errore, promessa rifiutata, eccezione sincrona, nessuna risposta mai). Le ultime usano la
 * libreria VERA sopra un database finto che applica i filtri: tabelle `crm_*` assenti → non succede
 * niente; scheda già in archivio → il bambino risulta iscritto con la domanda appena inserita.
 *
 * Solo dati finti: «Famiglia Prova», 333 000 0001.
 */

const h = vi.hoisted(() => ({
  /** Il modello del modulo: lo stesso minimo di `iscrizione-errori-con-codice.test.ts`, più un telefono. */
  modello: {
    schema: {
      version: '1',
      pages: [
        {
          id: 'bambino',
          title: 'B',
          fields: [
            { id: 'nome', type: 'text', label: 'Nome', required: true, validation: { min_length: 2 } },
            { id: 'data_nascita', type: 'text', label: 'Nascita', required: false },
            { id: 'residence_province', type: 'text', label: 'Provincia', required: true, validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
          ],
        },
        {
          id: 'adulto',
          title: 'A',
          fields: [
            { id: 'phone', type: 'text', label: 'Telefono', required: false },
            { id: 'residence_province', type: 'text', label: 'Provincia', required: true, validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 } },
          ],
        },
      ],
    },
  } as Record<string, unknown>,
  /** Un esito per inserimento di `enrollment_submissions`, in ordine; poi `{ id: 'sub-1' }`. */
  inserimenti: [] as Array<{ data: unknown; error: unknown }>,
  /** Se valorizzato, `createAdminClient` ritorna QUESTO client invece del finto a mano. */
  clientVero: null as unknown,
  collega: vi.fn(),
  usaLibreriaVera: false,
  log: [] as Array<{ evento: string; livello: string; campi: Record<string, unknown> }>,
}))

vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>, err?: unknown) => {
      h.log.push({ evento, livello, campi })
      return vero.logEvento(evento as never, livello as never, campi as never, err)
    },
  }
})
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/crm/collegamento', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/crm/collegamento')>()
  return {
    ...vero,
    collegaDomandaAlCrm: (...a: Parameters<typeof vero.collegaDomandaAlCrm>) =>
      h.usaLibreriaVera ? vero.collegaDomandaAlCrm(...a) : h.collega(...a),
  }
})
vi.mock('@/lib/supabase/server-client', () => {
  /** Le tabelle che il modulo pubblico legge PRIMA dell'inserimento: sempre un finto a mano, come negli altri test. */
  const stub = (table: string) => {
    const b: Record<string, unknown> = {}
    if (table === 'schools' || table === 'scuole') {
      const risultato =
        table === 'schools'
          ? { data: [{ id: 'scuola-reale', nome: 'Sede di prova' }], error: null }
          : { data: [{ id: 'scuola-reale', attiva: true }], error: null }
      b.select = () => b
      b.order = () => b
      b.in = () => b
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risultato).then(ok, ko)
      return b
    }
    if (table === 'form_models') {
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: h.modello, error: null })
      return b
    }
    b.insert = () => b
    b.select = () => b
    b.single = async () => h.inserimenti.shift() ?? { data: { id: 'sub-1' }, error: null }
    return b
  }
  const LETTURE_PRELIMINARI = ['schools', 'scuole', 'form_models']
  return {
    createAdminClient: async () => ({
      from: (table: string) => {
        // Con `clientVero`, `enrollment_submissions` e `crm_*` stanno nel database finto che filtra davvero.
        if (h.clientVero && !LETTURE_PRELIMINARI.includes(table)) {
          return (h.clientVero as { from: (t: string) => unknown }).from(table)
        }
        return stub(table)
      },
    }),
  }
})

import { POST } from '@/app/api/iscrizione/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/iscrizione', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

const domanda = {
  data: {
    presa_visione_informativa: true,
    children: [{ nome: 'Marco', residence_province: 'MI', data_nascita: '2024-03-05' }],
    adults: [{ residence_province: 'RM', phone: '+39 333 000 0001' }],
  },
}

const logCrm = () => h.log.filter((r) => r.evento === 'crm')

beforeEach(() => {
  vi.clearAllMocks()
  h.inserimenti = []
  h.clientVero = null
  h.usaLibreriaVera = false
  h.collega.mockReset()
  h.collega.mockResolvedValue({ esito: 'nessuna_scheda' })
  h.log.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/iscrizione → collegaDomandaAlCrm', () => {
  it('chiama il collegamento con l’id inserito, e la risposta è quella di sempre', async () => {
    const res = await POST(req(domanda))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'sub-1' })
    expect(h.collega).toHaveBeenCalledTimes(1)
    expect(h.collega.mock.calls[0][1]).toBe('sub-1')
  })

  it('anche sul ramo di ripiego (colonna dei consensi assente): chiamato con l’id del SECONDO inserimento', async () => {
    h.inserimenti = [
      { data: null, error: { code: 'PGRST204', message: "Could not find the 'consents_log' column" } },
      { data: { id: 'sub-ripiego' }, error: null },
    ]
    const res = await POST(req(domanda))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'sub-ripiego' })
    expect(h.collega).toHaveBeenCalledTimes(1)
    expect(h.collega.mock.calls[0][1]).toBe('sub-ripiego')
  })

  it('inserimento rifiutato → il CRM non viene chiamato, e la risposta resta l’errore di sempre', async () => {
    h.inserimenti = [{ data: null, error: { code: '23505', message: 'duplicate key' } }]
    const res = await POST(req(domanda))
    expect(res.status).toBe(500)
    expect(h.collega).not.toHaveBeenCalled()
  })

  describe('il CRM si comporta male: la domanda risponde 201, identica', () => {
    const casi: Array<[string, () => void]> = [
      ['esito «errore»', () => h.collega.mockResolvedValue({ esito: 'errore' })],
      ['esito «non_installato»', () => h.collega.mockResolvedValue({ esito: 'non_installato' })],
      ['esito «collegato»', () => h.collega.mockResolvedValue({ esito: 'collegato', schedaId: 's', bambini: 1 })],
      ['promessa rifiutata', () => h.collega.mockRejectedValue(Object.assign(new Error('giù'), { code: 'XX000' }))],
      [
        'eccezione sincrona',
        () =>
          h.collega.mockImplementation(() => {
            throw new Error('lanciata subito')
          }),
      ],
      ['nessun valore (un mock che non risponde niente)', () => h.collega.mockReturnValue(undefined)],
    ]
    it.each(casi)('%s', async (_nome, prepara) => {
      prepara()
      const res = await POST(req(domanda))
      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ id: 'sub-1' })
      expect(h.collega).toHaveBeenCalledTimes(1)
    })

    it('una promessa rifiutata lascia una riga di log di errore con l’id della domanda e senza dati', async () => {
      h.collega.mockRejectedValue(new Error('giù'))
      await POST(req(domanda))
      const riga = logCrm().find((r) => r.campi.esito === 'aggancio-crm-eccezione')
      expect(riga).toBeDefined()
      expect(riga!.livello).toBe('error')
      expect(riga!.campi.entita_id).toBe('sub-1')
      const testo = JSON.stringify(h.log.filter((r) => r.evento === 'crm'))
      for (const dato of ['Marco', '333', 'Famiglia']) expect(testo).not.toContain(dato)
    })

    it('il CRM che non risponde MAI non tiene sospesa la famiglia oltre il tetto', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      h.collega.mockReturnValue(new Promise(() => undefined))
      let risposta: Response | null = null
      const p = POST(req(domanda)).then((r) => {
        risposta = r
        return r
      })
      // Prima del tetto, la famiglia sta ancora aspettando…
      await vi.advanceTimersByTimeAsync(2000)
      expect(risposta).toBeNull()
      // …allo scadere del tetto (3 s) riceve la sua risposta di sempre.
      await vi.advanceTimersByTimeAsync(1500)
      const res = await p
      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ id: 'sub-1' })
      const riga = logCrm().find((r) => r.campi.esito === 'aggancio-crm-scaduto')
      expect(riga).toMatchObject({ livello: 'warn', campi: expect.objectContaining({ entita_id: 'sub-1' }) })
    })

    it('un CRM che risponde presto non lascia timer pendenti', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const res = await POST(req(domanda))
      expect(res.status).toBe(201)
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La libreria VERA, sopra un database finto che applica i filtri
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/iscrizione con la libreria vera', () => {
  const SEDE = 'scuola-reale'

  function dbBase(): DBFinto {
    return {
      enrollment_submissions: [],
      crm_schede: [
        {
          id: 'scheda-1',
          scuola_id: SEDE,
          telefoni_norm: ['3330000001'],
          email_norm: [],
          creata_il: new Date().toISOString(),
          domanda_da_associare: null,
          anonimizzata_il: null,
        },
      ],
      crm_bambini: [
        {
          id: 'bambino-1',
          scheda_id: 'scheda-1',
          scuola_id: SEDE,
          nome: 'Marco',
          data_nascita: '2024-03-05',
          esito: 'aperto',
          domanda_id: null,
          da_verificare: false,
        },
      ],
      crm_eventi: [],
    }
  }

  function conClient(db: DBFinto, errori?: Parameters<typeof creaFintoSupabase>[2]) {
    const scritture: Scrittura[] = []
    h.clientVero = creaFintoSupabase(db, [], { ...errori, scritture })
    h.usaLibreriaVera = true
    return { scritture }
  }

  it('la scheda della stessa famiglia c’è già: il bambino risulta iscritto con la domanda appena inserita', async () => {
    const db = dbBase()
    conClient(db)
    const res = await POST(req(domanda))
    expect(res.status).toBe(201)
    const { id } = await res.json()
    expect(typeof id).toBe('string')
    const bambino = (db.crm_bambini as Riga[])[0]
    expect(bambino).toMatchObject({ esito: 'iscritto', esito_origine: 'automatico', domanda_id: id, domanda_figlio: 0 })
  })

  it('tabelle crm_* assenti (database non migrato): la domanda risponde 201 e il CRM non scrive niente', async () => {
    const db = dbBase()
    const { scritture } = conClient(db, {
      errori: {
        crm_bambini: { code: 'PGRST205', message: "Could not find the table 'public.crm_bambini'" },
        crm_schede: { code: 'PGRST205', message: "Could not find the table 'public.crm_schede'" },
      },
    })
    const res = await POST(req(domanda))
    expect(res.status).toBe(201)
    expect(typeof (await res.json()).id).toBe('string')
    expect(scritture.filter((s) => s.tabella.startsWith('crm_'))).toEqual([])
    expect(logCrm().some((r) => r.livello === 'warn' && r.campi.esito === 'schema-crm-assente')).toBe(true)
  })

  it('il database del CRM che dà errore (non «assente») → 201 lo stesso, errore nel log', async () => {
    const db = dbBase()
    conClient(db, { errori: { crm_bambini: { code: 'XX000', message: 'boom' } } })
    const res = await POST(req(domanda))
    expect(res.status).toBe(201)
    expect(logCrm().some((r) => r.livello === 'error')).toBe(true)
    expect((db.crm_bambini as Riga[])[0].domanda_id).toBeNull()
  })

  it('una scheda di UN’ALTRA sede con lo stesso telefono non si collega', async () => {
    const db = dbBase()
    ;(db.crm_schede as Riga[])[0].scuola_id = 'altra-sede'
    ;(db.crm_bambini as Riga[])[0].scuola_id = 'altra-sede'
    conClient(db)
    const res = await POST(req(domanda))
    expect(res.status).toBe(201)
    expect((db.crm_bambini as Riga[])[0]).toMatchObject({ esito: 'aperto', domanda_id: null })
  })
})
