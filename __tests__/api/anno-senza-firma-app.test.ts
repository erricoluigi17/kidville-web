import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ErroreFinto, Richiesta, Riga } from '../helpers/supabase-tabelle-finto'

/**
 * COMPITO 4.7.2 · la route «chi non ha firmato in app»:
 *   GET /api/admin/anni/[annoSedeId]/senza-firma-app?modulo_id=&pagina=&limite=
 *
 * Sono NOMI DI MINORI. Le prove: gate di ruolo, perimetro di sede, un modulo che non è dell'anno o non è del registro → 422, la
 * pagina e il totale, un accesso al fascicolo registrato per ogni bambino MOSTRATO, nessun nome nei log, e mai un 200 con un elenco
 * incompleto quando una lettura cade. Il client finto applica davvero i filtri. Solo uuid e nomi inventati.
 */

const SEDE_A = '11111111-1111-4111-8111-111111111111'
const SEDE_B = '22222222-2222-4222-8222-222222222222'
const ANNO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ANNO_ALTRO = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0' // un altro anno della SEDE_A
const ANNO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UTENTE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MOD_REG = '71717171-7171-4717-8717-717171717171' // delega_ritiro: del registro
const MOD_FUORI = '72727272-7272-4727-8727-727272727272' // un foglio cartaceo: non del registro
const MOD_ALTRO_ANNO = '73737373-7373-4737-8737-737373737373' // del registro, ma di un altro anno
const SEZ = '51515151-5151-4515-8515-515151515151'
const al = (n: number) => `a1a1a1a1-a1a1-4a1a-8a1a-${String(n).padStart(12, '0')}`
const fr = (n: number) => `f1f1f1f1-f1f1-4f1f-8f1f-${String(n).padStart(12, '0')}`
const NOME = (n: number) => `Nomefinto${n}`
const COGNOME = (n: number) => `Cognomefinto${n}`

const h = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; scuola_id: string },
  tabelle: {} as Record<string, unknown[]>,
  errori: {} as Record<string, { code?: string; message?: string } | undefined>,
  richieste: [] as unknown[],
  accessi: [] as Array<{ alunnoId: string; utenteId: string | null; azione: string; finalita?: string | null }>,
  gateAmmessi: null as null | readonly string[],
  log: [] as Array<{ fn: 'evento' | 'errore' | 'ok'; args: unknown[] }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async (_request: Request, allowed: readonly string[] = ['admin', 'coordinator', 'segreteria']) => {
    h.gateAmmessi = allowed
    if (!h.user) return { user: null, response: new Response(JSON.stringify({ error: 'no' }), { status: 401 }) }
    if (!allowed.includes(h.user.role)) {
      return { user: null, response: new Response(JSON.stringify({ error: 'vietato' }), { status: 403 }) }
    }
    return { user: h.user, response: null }
  },
}))
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async (_s: unknown, u: { scuola_id?: string | null }) => (u.scuola_id ? [u.scuola_id] : []),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { clientTabelle } = await import('../helpers/supabase-tabelle-finto')
  return {
    createAdminClient: async () =>
      clientTabelle(
        () => h.tabelle as Record<string, Riga[]>,
        () => h.errori as Record<string, ErroreFinto | undefined>,
        h.richieste as Richiesta[],
      ),
  }
})
vi.mock('@/lib/primaria/fascicolo-rbac', () => ({
  logAccessoFascicolo: async (_s: unknown, o: { alunnoId: string; utenteId: string | null; azione: string; finalita?: string | null }) => {
    h.accessi.push({ alunnoId: o.alunnoId, utenteId: o.utenteId, azione: o.azione, finalita: o.finalita })
  },
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...args: unknown[]) => void h.log.push({ fn: 'evento', args }),
  logErrore: (...args: unknown[]) => void h.log.push({ fn: 'errore', args }),
  logOk: (...args: unknown[]) => void h.log.push({ fn: 'ok', args }),
}))

import { GET } from '@/app/api/admin/anni/[annoSedeId]/senza-firma-app/route'

const contesto = (id: string) => ({ params: Promise.resolve({ annoSedeId: id }) })
const leggi = (query = `modulo_id=${MOD_REG}`, id = ANNO_A) =>
  GET(new Request(`http://localhost/api/admin/anni/${id}/senza-firma-app?${query}`) as never, contesto(id) as never)
const eventi = (tipo: string) =>
  h.log
    .filter((l) => l.fn === 'evento')
    .map((l) => ({ livello: l.args[1] as string, campi: l.args[2] as Record<string, unknown> }))
    .filter((e) => e.campi?.tipo === tipo)
const guasti = () => h.log.filter((l) => l.fn === 'errore')

/** Sessanta bambini senza firma nella lista «conferma» e uno con la firma dell'anno. */
function seme(quanti = 60) {
  const frequenze = Array.from({ length: quanti + 1 }, (_, i) => ({
    id: fr(i + 1), alunno_id: al(i + 1), anno_sede_id: ANNO_A, tipo: 'conferma', stato: 'in_attesa', section_id: i % 2 === 0 ? SEZ : null,
  }))
  h.tabelle = {
    anni_sede: [
      { id: ANNO_A, scuola_id: SEDE_A, inizio: '2027-09-01', fine: '2028-08-31', ultimo_giorno_aperto: '2028-07-31', stato: 'iscrizioni_aperte' },
      { id: ANNO_ALTRO, scuola_id: SEDE_A, inizio: '2026-09-01', fine: '2027-08-31', ultimo_giorno_aperto: '2027-07-31', stato: 'corrente' },
      { id: ANNO_B, scuola_id: SEDE_B, inizio: '2027-09-01', fine: '2028-08-31', ultimo_giorno_aperto: '2028-07-31', stato: 'iscrizioni_aperte' },
    ],
    moduli_richiesti: [
      { id: MOD_REG, anno_sede_id: ANNO_A, codice: 'delega_ritiro', lista: 'conferma' },
      { id: MOD_FUORI, anno_sede_id: ANNO_A, codice: 'foglio-cartaceo-della-scuola', lista: 'conferma' },
      { id: MOD_ALTRO_ANNO, anno_sede_id: ANNO_ALTRO, codice: 'delega_ritiro', lista: 'conferma' },
    ],
    frequenze,
    // l'ultimo bambino (indice quanti+1) ha firmato nell'anno
    student_documents: [
      { id: 'd0d0d0d0-d0d0-4d0d-8d0d-000000000001', student_id: al(quanti + 1), document_type: 'delega_ritiro', created_at: '2027-10-05T09:00:00Z', eliminato_il: null },
    ],
    alunni: frequenze.map((f, i) => ({ id: f.alunno_id, scuola_id: SEDE_A, nome: NOME(i + 1), cognome: COGNOME(i + 1) })),
    sections: [{ id: SEZ, scuola_id: SEDE_A, name: 'Sezione A' }],
  }
}

beforeEach(() => {
  h.user = { id: UTENTE, role: 'segreteria', scuola_id: SEDE_A }
  h.errori = {}
  h.richieste = []
  h.accessi = []
  h.gateAmmessi = null
  h.log = []
  seme()
})

describe('GET /api/admin/anni/[annoSedeId]/senza-firma-app', () => {
  it('un bambino con la firma nell\'anno non compare; gli altri sì, a pagine da 50 con il totale sul tutto', async () => {
    const r = await leggi()
    expect(r.status).toBe(200)
    const { data } = await r.json()
    expect(data).toMatchObject({ totale: 60, pagina: 1, limite: 50 })
    expect(data.righe).toHaveLength(50)
    expect(data.righe.some((x: { alunno_id: string }) => x.alunno_id === al(61))).toBe(false)
    expect(Object.keys(data.righe[0]).sort()).toEqual(['alunno_id', 'classe', 'cognome', 'frequenza_id', 'nome'])
    expect(data.righe[0]).toMatchObject({ frequenza_id: fr(1), nome: NOME(1), cognome: COGNOME(1), classe: 'Sezione A' })
    expect(data.righe[1]).toMatchObject({ frequenza_id: fr(2), classe: null })
  })

  it('la pagina 2 contiene gli altri e `totale` resta sul tutto', async () => {
    const { data } = await (await leggi(`modulo_id=${MOD_REG}&pagina=2`)).json()
    expect(data).toMatchObject({ totale: 60, pagina: 2 })
    expect(data.righe).toHaveLength(10)
    expect(data.righe[0].frequenza_id).toBe(fr(51))
    expect(data.righe[9].frequenza_id).toBe(fr(60))
  })

  it('un limite sopra 50 è un errore di validazione', async () => {
    expect((await leggi(`modulo_id=${MOD_REG}&limite=51`)).status).toBe(400)
    expect((await leggi(`modulo_id=${MOD_REG}&limite=20`)).status).toBe(200)
  })

  it('un modulo non del registro → 422 `MODULO_NON_RICHIESTO`, e nessuna lettura di bambini', async () => {
    const r = await leggi(`modulo_id=${MOD_FUORI}`)
    expect(r.status).toBe(422)
    expect((await r.json()).codice).toBe('MODULO_NON_RICHIESTO')
    expect(h.accessi).toHaveLength(0)
    expect((h.richieste as Array<{ tabella: string }>).some((x) => x.tabella === 'student_documents')).toBe(false)
  })

  it('un modulo di un altro anno → 422; un modulo che non esiste → 422; un id che non è un uuid → 400; senza modulo → 400', async () => {
    expect((await leggi(`modulo_id=${MOD_ALTRO_ANNO}`)).status).toBe(422)
    expect((await leggi('modulo_id=99999999-9999-4999-8999-999999999999')).status).toBe(422)
    expect((await leggi('modulo_id=non-un-uuid')).status).toBe(400)
    expect((await leggi('')).status).toBe(400)
    expect(h.accessi).toHaveLength(0)
  })

  it('un\'altra sede è rifiutata (403) e non si legge niente di bambini', async () => {
    const r = await leggi(`modulo_id=${MOD_REG}`, ANNO_B)
    expect(r.status).toBe(403)
    expect(h.accessi).toHaveLength(0)
    expect((h.richieste as Array<{ tabella: string }>).some((x) => x.tabella === 'student_documents' || x.tabella === 'alunni')).toBe(false)
  })

  it('un anno che non c\'è → 404', async () => {
    expect((await leggi(`modulo_id=${MOD_REG}`, '99999999-9999-4999-8999-999999999999')).status).toBe(404)
  })

  it('il gate è dello staff: genitore e docente non passano, senza utente 401', async () => {
    h.user = { id: UTENTE, role: 'parent', scuola_id: SEDE_A }
    expect((await leggi()).status).toBe(403)
    h.user = { id: UTENTE, role: 'teacher', scuola_id: SEDE_A }
    expect((await leggi()).status).toBe(403)
    h.user = null
    expect((await leggi()).status).toBe(401)
    expect(h.accessi).toHaveLength(0)
    h.user = { id: UTENTE, role: 'coordinator', scuola_id: SEDE_A }
    expect((await leggi()).status).toBe(200)
    expect([...(h.gateAmmessi ?? [])].sort()).toEqual(['admin', 'coordinator', 'segreteria'])
  })

  it('un accesso al fascicolo per ogni bambino MOSTRATO (non per ogni bambino scansionato), con azione `list` e la finalità', async () => {
    await leggi()
    expect(h.accessi).toHaveLength(50)
    expect(new Set(h.accessi.map((a) => a.alunnoId)).size).toBe(50)
    expect(h.accessi.every((a) => a.azione === 'list' && a.utenteId === UTENTE && /non ha firmato in app/i.test(a.finalita ?? ''))).toBe(true)
    h.accessi = []
    await leggi(`modulo_id=${MOD_REG}&pagina=2`)
    expect(h.accessi).toHaveLength(10)
  })

  it('i log non contengono nessun nome: né quello di un bambino né il cognome', async () => {
    await leggi()
    const testo = JSON.stringify(h.log)
    expect(testo).not.toMatch(/Nomefinto|Cognomefinto/)
    expect(eventi('senza-firma-app-letto')).toEqual([
      { livello: 'info', campi: expect.objectContaining({ entita_id: MOD_REG, anno_sede_id: ANNO_A, utente: UTENTE, n: 50 }) },
    ])
  })

  it('PostgREST in errore → mai 200 con un elenco vuoto: 500 loggato (503 se lo schema è indietro)', async () => {
    for (const tabella of ['student_documents', 'frequenze', 'alunni', 'moduli_richiesti']) {
      h.errori = { [tabella]: { code: 'XX000', message: 'boom' } }
      h.log = []
      h.accessi = []
      const r = await leggi()
      expect(r.status, tabella).toBe(500)
      expect(guasti().length, tabella).toBeGreaterThan(0)
      expect(h.accessi, tabella).toHaveLength(0)
    }
    // Sul database della CI il fascicolo non ha `eliminato_il`: 42703, quindi 503 e nessun 500.
    h.errori = { student_documents: { code: '42703', message: 'column "eliminato_il" does not exist' } }
    h.log = []
    const r = await leggi()
    expect(r.status).toBe(503)
    expect(guasti()).toHaveLength(0)
  })

  it('una lista senza frequenze dà un elenco vuoto e totale zero (non è un errore)', async () => {
    h.tabelle.frequenze = []
    const r = await leggi()
    expect(r.status).toBe(200)
    expect((await r.json()).data).toEqual({ totale: 0, pagina: 1, limite: 50, righe: [] })
    expect(h.accessi).toHaveLength(0)
  })
})
