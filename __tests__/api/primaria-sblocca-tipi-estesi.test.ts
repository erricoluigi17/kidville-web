import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest, type Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// /api/primaria/sblocca — i tipi nuovi della spec 2026-09-24.
//
// Oltre a registro/valutazione/nota, la Direzione sblocca ora anche impreparati,
// allegati e firme (voce per voce), e il GIORNO di una classe (sezione + data,
// senza ora né riga). Le righe che scrive sono quelle che legge
// `src/lib/primaria/permesso-voce.ts`: se la forma divergesse, lo sblocco
// risponderebbe 200 e non sbloccherebbe niente.
//
// Il finto client filtra e scrive davvero: lo scope di sede gira per intero.
// =============================================================================

const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000001'
const MAESTRA = 'd0ce0001-0000-4000-8000-000000000002'
const SEZ_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEZ_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const LEZIONE_A = 'e9157200-0000-4000-8000-00000000000a'
const LEZIONE_B = 'e9157200-0000-4000-8000-00000000000b'
const FIRMA_A = 'e9157200-0000-4000-8000-0000000000f1'
const FIRMA_B = 'e9157200-0000-4000-8000-0000000000f2'
const ALLEGATO = 'e9157200-0000-4000-8000-0000000000a7'
const ALLEGATO_ORFANO = 'e9157200-0000-4000-8000-0000000000a8'
const ALLEGATO_NEL_CESTINO = 'e9157200-0000-4000-8000-0000000000a9'
const IMPREPARATO = 'e9157200-0000-4000-8000-0000000000c1'
const LUNEDI = '2026-09-07'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as Scrittura[],
  errori: {} as Record<string, ErrorePostgrest>,
  /** Ogni metodo di catena chiamato dalla route, per tabella: prova QUALE filtro ha chiesto. */
  chiamate: [] as { tabella: string; metodo: string; args: unknown[] }[],
  /** Il DB E2E non migrato: `allegati_registro.eliminato_il` non esiste (42703). */
  cestinoAssente: false,
}))

vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => {
  // Il finto client filtra e scrive davvero; questo involucro REGISTRA la catena
  // (per provare che il filtro del cestino è chiesto) e, con `cestinoAssente`,
  // risponde come PostgREST su un DB dove la colonna non c'è. Il 42703 arriva
  // SOLO sulla query che nomina `eliminato_il`: la rilettura senza filtro passa.
  const avvolgi = (query: object, tabella: string): object => {
    const wrapper: object = new Proxy(query as Record<string, unknown>, {
      get(bersaglio, prop, ricevitore) {
        const valore = Reflect.get(bersaglio, prop, ricevitore)
        if (typeof prop !== 'string' || prop === 'then' || typeof valore !== 'function') return valore
        return (...args: unknown[]) => {
          h.chiamate.push({ tabella, metodo: prop, args })
          if (h.cestinoAssente && tabella === 'allegati_registro' && prop === 'is' && args[0] === 'eliminato_il') {
            const errore = { code: '42703', message: 'column allegati_registro.eliminato_il does not exist' }
            return { maybeSingle: async () => ({ data: null, error: errore }) }
          }
          const esito = (valore as (...a: unknown[]) => unknown).apply(bersaglio, args)
          return esito === bersaglio ? wrapper : esito
        }
      },
    })
    return wrapper
  }
  return {
    createAdminClient: async () => {
      const vero = creaFintoSupabase(h.db, [], { scritture: h.scritture, errori: h.errori }) as unknown as Record<
        string,
        unknown
      >
      return new Proxy(vero, {
        get(bersaglio, prop, ricevitore) {
          const valore = Reflect.get(bersaglio, prop, ricevitore)
          if (prop !== 'from') return valore
          const from = valore as (t: string) => object
          return (tabella: string) => avvolgi(from(tabella), tabella)
        },
      })
    },
  }
})

import { POST } from '@/app/api/primaria/sblocca/route'
import { MOTIVAZIONE_SBLOCCO_MAX } from '@/lib/primaria/sblocco-motivazione'

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_A, scuola_id: SEDE_A, name: '2A' },
    { id: SEZ_B, scuola_id: SEDE_B, name: '2A' },
  ],
  utenti_scuole: [{ utente_id: DIRIGENTE, scuola_id: SEDE_A }],
  utenti_sezioni: [{ utente_id: MAESTRA, section_id: SEZ_A }],
  registro_orario: [
    { id: LEZIONE_A, section_id: SEZ_A, scuola_id: SEDE_A, data: LUNEDI, ora_lezione: 2 },
    { id: LEZIONE_B, section_id: SEZ_B, scuola_id: SEDE_B, data: LUNEDI, ora_lezione: 2 },
  ],
  firme_docenti: [
    { id: FIRMA_A, registro_id: LEZIONE_A, maestra_id: MAESTRA },
    { id: FIRMA_B, registro_id: LEZIONE_B, maestra_id: MAESTRA },
  ],
  allegati_registro: [
    { id: ALLEGATO, registro_id: LEZIONE_A, eliminato_il: null },
    // La lezione è stata eliminata: la FK ha azzerato `registro_id`.
    { id: ALLEGATO_ORFANO, registro_id: null, eliminato_il: null },
    // Eliminato DA SOLO: è nel cestino, ma la sua lezione esiste ancora e il
    // `registro_id` è intatto. Senza il filtro si risolverebbe fino alla classe.
    { id: ALLEGATO_NEL_CESTINO, registro_id: LEZIONE_A, eliminato_il: '2026-09-08T10:00:00Z' },
  ],
  giustifiche_didattiche: [{ id: IMPREPARATO, section_id: SEZ_A, data: LUNEDI, origine: 'docente' }],
  valutazioni: [],
  note_disciplinari: [],
  sblocchi_audit: [],
})

function richiesta(body: Record<string, unknown>): NextRequest {
  return {
    url: `http://localhost/api/primaria/sblocca?userId=${DIRIGENTE}`,
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest
}

const sbloccati = () => h.db.sblocchi_audit ?? []

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.scritture = []
  h.errori = {}
  h.chiamate = []
  h.cestinoAssente = false
  h.requireStaff.mockResolvedValue({
    user: { id: DIRIGENTE, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A },
  })
})

describe('POST /api/primaria/sblocca — il GIORNO della classe', () => {
  it('scrive sezione + data, senza ora né riga: la forma che `permesso-voce` cerca', async () => {
    const res = await POST(richiesta({ entitaTipo: 'giorno', sectionId: SEZ_A, data: LUNEDI, motivazione: 'uscita didattica' }))

    expect(res.status).toBe(200)
    expect(sbloccati()).toHaveLength(1)
    const riga = sbloccati()[0]
    expect(riga.entita_tipo).toBe('giorno')
    expect(riga.entita_id ?? null).toBeNull()
    expect(riga.section_id).toBe(SEZ_A)
    expect(riga.data).toBe(LUNEDI)
    expect(riga.ora_lezione ?? null).toBeNull()
    expect(riga.dirigente_id).toBe(DIRIGENTE)
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'sblocco-registrato', entita_tipo: 'giorno', per_giorno: true, per_slot: false, data: LUNEDI }),
    )
  })

  it('il gate resta quello della Direzione (admin/coordinator)', async () => {
    await POST(richiesta({ entitaTipo: 'giorno', sectionId: SEZ_A, data: LUNEDI, motivazione: 'x' }))
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator'])
  })

  it('il giorno di una classe di UN’ALTRA sede è respinto, e non scrive niente', async () => {
    const res = await POST(richiesta({ entitaTipo: 'giorno', sectionId: SEZ_B, data: LUNEDI, motivazione: 'x' }))
    expect(res.status).toBe(403)
    expect(sbloccati()).toHaveLength(0)
  })

  it.each([
    ['con un’ora', { oraLezione: 2 }],
    ['con una riga', { entitaId: LEZIONE_A }],
    ['senza data', { data: undefined }],
    ['senza classe', { sectionId: undefined }],
  ])('un giorno %s è 400 e non tocca il database', async (_n, extra) => {
    const res = await POST(
      richiesta({ entitaTipo: 'giorno', sectionId: SEZ_A, data: LUNEDI, motivazione: 'x', ...extra }),
    )
    expect(res.status).toBe(400)
    expect(sbloccati()).toHaveLength(0)
  })

  it('senza la migrazione (vincolo vecchio, 23514) è 503 dichiarato con codice, mai la prosa di Postgres', async () => {
    h.errori = {
      'sblocchi_audit:insert': {
        code: '23514',
        message: 'new row for relation "sblocchi_audit" violates check constraint "sblocchi_audit_entita_tipo_check"',
      },
    }
    const res = await POST(richiesta({ entitaTipo: 'giorno', sectionId: SEZ_A, data: LUNEDI, motivazione: 'x' }))
    expect(res.status).toBe(503)
    const corpo = (await res.json()) as { error?: string; codice?: string }
    expect(corpo.codice).toBe('SBLOCCO_NON_DISPONIBILE')
    expect(JSON.stringify(corpo)).not.toMatch(/check constraint|sblocchi_audit/)
    expect(h.logErrore).toHaveBeenCalled()
  })
})

describe('POST /api/primaria/sblocca — impreparati, firme, allegati', () => {
  it('un impreparato si sblocca per id: la classe viene dalla sua riga', async () => {
    const res = await POST(richiesta({ entitaTipo: 'impreparato', entitaId: IMPREPARATO, motivazione: 'correzione' }))
    expect(res.status).toBe(200)
    expect(sbloccati()[0]).toMatchObject({ entita_tipo: 'impreparato', entita_id: IMPREPARATO })
  })

  it('una FIRMA eredita classe e slot dalla lezione, e li registra', async () => {
    const res = await POST(richiesta({ entitaTipo: 'firma', entitaId: FIRMA_A, motivazione: 'correzione' }))
    expect(res.status).toBe(200)
    const riga = sbloccati()[0]
    expect(riga).toMatchObject({ entita_tipo: 'firma', entita_id: FIRMA_A, section_id: SEZ_A, data: LUNEDI })
    expect(Number(riga.ora_lezione)).toBe(2)
  })

  it('la firma di una lezione di UN’ALTRA sede è respinta (lo scope passa dalla lezione)', async () => {
    const res = await POST(richiesta({ entitaTipo: 'firma', entitaId: FIRMA_B, motivazione: 'x' }))
    expect(res.status).toBe(403)
    expect(sbloccati()).toHaveLength(0)
  })

  it('un allegato si sblocca per id, con la classe della lezione', async () => {
    const res = await POST(richiesta({ entitaTipo: 'allegato', entitaId: ALLEGATO, motivazione: 'x' }))
    expect(res.status).toBe(200)
    expect(sbloccati()[0]).toMatchObject({ entita_tipo: 'allegato', entita_id: ALLEGATO, section_id: SEZ_A })
  })

  it('un allegato SENZA lezione (la lezione è stata eliminata) è 409 VOCE_SENZA_LEZIONE, senza audit', async () => {
    const res = await POST(richiesta({ entitaTipo: 'allegato', entitaId: ALLEGATO_ORFANO, motivazione: 'x' }))
    expect(res.status).toBe(409)
    expect(((await res.json()) as { codice?: string }).codice).toBe('VOCE_SENZA_LEZIONE')
    expect(sbloccati()).toHaveLength(0)
  })

  it('un allegato NEL CESTINO con la lezione ancora viva è 404: per l’app non esiste, e non si autorizza', async () => {
    const res = await POST(richiesta({ entitaTipo: 'allegato', entitaId: ALLEGATO_NEL_CESTINO, motivazione: 'x' }))
    expect(res.status).toBe(404)
    expect(((await res.json()) as { codice?: string }).codice).toBe('SBLOCCO_VOCE_NON_TROVATA')
    expect(sbloccati()).toHaveLength(0)
    expect(h.scritture).toHaveLength(0)
    // Il filtro è chiesto a PostgREST, sulla lettura dell’allegato.
    expect(h.chiamate).toContainEqual({ tabella: 'allegati_registro', metodo: 'is', args: ['eliminato_il', null] })
  })

  it('le altre voci non ricevono il filtro del cestino (solo `allegati_registro` ha la colonna)', async () => {
    await POST(richiesta({ entitaTipo: 'firma', entitaId: FIRMA_A, motivazione: 'x' }))
    expect(h.chiamate.filter((c) => c.metodo === 'is' && c.args[0] === 'eliminato_il')).toHaveLength(0)
  })

  it('sul DB non migrato (42703 su `eliminato_il`) rilegge senza filtro, lo logga a info e sblocca', async () => {
    h.cestinoAssente = true
    const res = await POST(richiesta({ entitaTipo: 'allegato', entitaId: ALLEGATO, motivazione: 'x' }))
    expect(res.status).toBe(200)
    expect(sbloccati()[0]).toMatchObject({ entita_tipo: 'allegato', entita_id: ALLEGATO, section_id: SEZ_A })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'info',
      expect.objectContaining({ esito: 'sblocco-allegato-colonna-cestino-assente-ripiego', entita_tipo: 'allegato' }),
    )
    // Due letture dell’allegato: la prima col filtro (respinta), la seconda senza.
    expect(h.chiamate.filter((c) => c.tabella === 'allegati_registro' && c.metodo === 'select')).toHaveLength(2)
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  it('un altro errore sulla lettura dell’allegato NON è un degrado: 500 con codice, senza rilettura', async () => {
    h.errori = { 'allegati_registro:select': { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await POST(richiesta({ entitaTipo: 'allegato', entitaId: ALLEGATO, motivazione: 'x' }))
    expect(res.status).toBe(500)
    expect(((await res.json()) as { codice?: string }).codice).toBe('SBLOCCO_NON_REGISTRATO')
    expect(h.chiamate.filter((c) => c.tabella === 'allegati_registro' && c.metodo === 'select')).toHaveLength(1)
    expect(sbloccati()).toHaveLength(0)
  })

  it('un id inesistente è 404 con codice', async () => {
    const res = await POST(
      richiesta({ entitaTipo: 'impreparato', entitaId: '00000000-0000-4000-8000-000000000000', motivazione: 'x' }),
    )
    expect(res.status).toBe(404)
    expect(((await res.json()) as { codice?: string }).codice).toBe('SBLOCCO_VOCE_NON_TROVATA')
  })

  it('lo SLOT resta solo del registro: un impreparato per coordinate è 400', async () => {
    const res = await POST(
      richiesta({ entitaTipo: 'impreparato', sectionId: SEZ_A, data: LUNEDI, oraLezione: 2, motivazione: 'x' }),
    )
    expect(res.status).toBe(400)
    expect(sbloccati()).toHaveLength(0)
  })

  it('un guasto nel leggere la lezione di una firma è 500 con codice, non 404', async () => {
    h.errori = { 'registro_orario:select': { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await POST(richiesta({ entitaTipo: 'firma', entitaId: FIRMA_A, motivazione: 'x' }))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo).toMatchObject({ codice: 'SBLOCCO_NON_REGISTRATO' })
    expect(JSON.stringify(corpo)).not.toContain('statement timeout')
    expect(sbloccati()).toHaveLength(0)
  })
})

describe('POST /api/primaria/sblocca — la motivazione è il gate dell’audit', () => {
  // Il bottone ripulisce già il motivo, ma la route si chiama anche senza bottone:
  // la colonna NOT NULL riempita di spazi sarebbe un’autorizzazione senza motivo.
  it.each([
    ['di soli spazi', '   '],
    ['di spazi e a capo', ' \n\t '],
    ['vuota', ''],
  ])('una motivazione %s è 400 e non scrive niente in `sblocchi_audit`', async (_n, motivazione) => {
    const res = await POST(richiesta({ entitaTipo: 'giorno', sectionId: SEZ_A, data: LUNEDI, motivazione }))
    expect(res.status).toBe(400)
    expect(sbloccati()).toHaveLength(0)
    expect(h.scritture.filter((s) => s.tabella === 'sblocchi_audit')).toHaveLength(0)
  })

  it('la motivazione si registra ripulita dagli spazi ai lati', async () => {
    const res = await POST(richiesta({ entitaTipo: 'giorno', sectionId: SEZ_A, data: LUNEDI, motivazione: '  uscita didattica \n' }))
    expect(res.status).toBe(200)
    expect(sbloccati()[0].motivazione).toBe('uscita didattica')
  })

  // Il tetto viene dalla STESSA costante che la textarea del bottone usa come
  // `maxLength`: se i due lati divergessero, uno dei due casi diventerebbe rosso.
  it('una motivazione oltre il tetto è 400 e non scrive niente', async () => {
    const res = await POST(
      richiesta({
        entitaTipo: 'giorno',
        sectionId: SEZ_A,
        data: LUNEDI,
        motivazione: 'x'.repeat(MOTIVAZIONE_SBLOCCO_MAX + 1),
      }),
    )
    expect(res.status).toBe(400)
    expect(sbloccati()).toHaveLength(0)
    expect(h.scritture).toHaveLength(0)
  })

  it('una motivazione lunga esattamente il tetto passa', async () => {
    const res = await POST(
      richiesta({ entitaTipo: 'giorno', sectionId: SEZ_A, data: LUNEDI, motivazione: 'x'.repeat(MOTIVAZIONE_SBLOCCO_MAX) }),
    )
    expect(res.status).toBe(200)
    expect(String(sbloccati()[0].motivazione)).toHaveLength(MOTIVAZIONE_SBLOCCO_MAX)
  })
})

describe('POST /api/primaria/sblocca — l’errore imprevisto', () => {
  it('al client un codice, mai `err.message`', async () => {
    h.requireStaff.mockRejectedValue(new Error('dettaglio-interno-che-non-deve-uscire'))
    const res = await POST(richiesta({ entitaTipo: 'giorno', sectionId: SEZ_A, data: LUNEDI, motivazione: 'x' }))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo).toMatchObject({ codice: 'SBLOCCO_NON_REGISTRATO' })
    expect(JSON.stringify(corpo)).not.toContain('dettaglio-interno')
  })
})
