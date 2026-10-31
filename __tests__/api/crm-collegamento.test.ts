import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Riga, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * CRM della segreteria · Compito 4.2 — le route del collegamento con le domande.
 *
 *  · `PUT    /api/admin/crm/schede/[id]/bambini/[bambinoId]/collegamento`  → collega a mano
 *  · `DELETE /api/admin/crm/schede/[id]/bambini/[bambinoId]/collegamento`  → scollega
 *  · `GET    /api/admin/crm/domande?scuolaId=…&q=…&domandaId=…`            → le domande da scegliere
 *
 * Il gate di ruolo e `resolveScuoleAttive` sono finti; `restringiSedi`, `assertSchedaInScope` e la
 * libreria `collegamento` sono quelli VERI, e il database è il finto che applica i filtri: «una domanda
 * di un'altra sede dà 403» e «l'elenco della sede A non contiene le domande della sede B» sono proprietà
 * provate, non asserite.
 *
 * Solo dati finti: «Famiglia Prova», 333 000 0001, SEDE_A / SEDE_B.
 */

const h = vi.hoisted(() => ({
  ruolo: 'segreteria' as string,
  attive: [] as string[],
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
  letture: [] as string[],
  catene: [] as { tabella: string; metodi: [string, unknown[]][] }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    return Promise.resolve({ user: { id: 'u-1', role: h.ruolo, scuola_id: h.attive[0] ?? null } })
  },
}))
vi.mock('@/lib/auth/scope', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/auth/scope')>()
  return {
    ...vero,
    resolveScuoleAttive: async () => [...h.attive],
    scuoleDiUtente: async () => [...h.attive],
  }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const vero = creaFintoSupabase(h.db as DBFinto, h.letture, { scritture: h.scritture as Scrittura[], errori: h.errori })
    // Registra la catena dei metodi di ogni query, per provare che i filtri di sede stanno nella STESSA istruzione.
    return {
      from: (tabella: string) => {
        const rec = { tabella, metodi: [] as [string, unknown[]][] }
        h.catene.push(rec)
        const q = vero.from(tabella)
        const avvolgi = (oggetto: unknown): unknown =>
          new Proxy(oggetto as object, {
            get(target, prop) {
              const v = Reflect.get(target, prop)
              if (typeof v !== 'function' || typeof prop !== 'string') return v
              return (...args: unknown[]) => {
                rec.metodi.push([prop, args])
                const r = (v as (...a: unknown[]) => unknown).apply(target, args)
                return r && typeof r === 'object' && prop !== 'then' ? avvolgi(r) : r
              }
            },
          })
        return avvolgi(q)
      },
    }
  },
}))

import { PUT, DELETE } from '@/app/api/admin/crm/schede/[id]/bambini/[bambinoId]/collegamento/route'
import { GET } from '@/app/api/admin/crm/domande/route'

const S1 = 'a1a1a1a1-0000-4000-8000-000000000001'
const S_ALTRA = 'a2a2a2a2-0000-4000-8000-000000000002'
const B1 = 'b1b1b1b1-0000-4000-8000-000000000001'
const B_ALTRA = 'b2b2b2b2-0000-4000-8000-000000000002'
const D1 = 'd1d1d1d1-0000-4000-8000-000000000001'
const D2 = 'd2d2d2d2-0000-4000-8000-000000000002'
const D_ALTRA_SEDE = 'd3d3d3d3-0000-4000-8000-000000000003'
const NON_ESISTE = 'f0f0f0f0-0000-4000-8000-000000000009'

const DATI_PERSONALI_DA_NON_RESTITUIRE = ['PRVBMB24C45H501X', 'allergia ai latticini', 'prova@example.com', '333 000 0001']

function ripresaDomanda(id: string, sede: string | null, extra: Riga = {}): Riga {
  return {
    id,
    scuola_id: sede,
    status: 'pending',
    created_at: '2026-10-20T10:00:00.000Z',
    data: {
      children: [
        { nome: 'Bimbo', cognome: 'Prova', data_nascita: '2024-03-05', codice_fiscale: 'PRVBMB24C45H501X', allergies: 'allergia ai latticini' },
        { nome: 'Bimba', cognome: 'Prova', data_nascita: '2022-07-09', codice_fiscale: 'PRVBMB22L49H501Y' },
      ],
      adults: [{ ruolo: 'mother', first_name: 'Famiglia', last_name: 'Prova', phone: '333 000 0001', email: 'prova@example.com' }],
    },
    ...extra,
  }
}

function dbBase(): DBFinto {
  return {
    enrollment_submissions: [
      ripresaDomanda(D1, SEDE_A),
      ripresaDomanda(D2, SEDE_A, { created_at: '2026-10-25T10:00:00.000Z', status: 'approved' }),
      ripresaDomanda(D_ALTRA_SEDE, SEDE_B, { created_at: '2026-10-28T10:00:00.000Z' }),
    ],
    crm_schede: [
      { id: S1, scuola_id: SEDE_A, domanda_da_associare: D1, telefoni_norm: [], email_norm: [], creata_il: '2026-10-01T10:00:00.000Z' },
      { id: S_ALTRA, scuola_id: SEDE_B, domanda_da_associare: null, telefoni_norm: [], email_norm: [], creata_il: '2026-10-01T10:00:00.000Z' },
    ],
    crm_bambini: [
      { id: B1, scheda_id: S1, scuola_id: SEDE_A, nome: 'Bimbo', data_nascita: '2024-03-05', esito: 'aperto', domanda_id: null, domanda_figlio: null, domanda_collegata_il: null, da_verificare: false, nota_collegamento: null },
      { id: B_ALTRA, scheda_id: S_ALTRA, scuola_id: SEDE_B, nome: 'Gemello', data_nascita: '2022-07-09', esito: 'aperto', domanda_id: null, domanda_figlio: null, domanda_collegata_il: null, da_verificare: false, nota_collegamento: null },
    ],
    crm_eventi: [],
  }
}

const params = (id: string, bambinoId: string) => ({ params: Promise.resolve({ id, bambinoId }) })
const put = (id: string, bambinoId: string, body: unknown) =>
  PUT(
    new NextRequest(`http://localhost/api/admin/crm/schede/${id}/bambini/${bambinoId}/collegamento`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id, bambinoId),
  )
const del = (id: string, bambinoId: string) =>
  DELETE(
    new NextRequest(`http://localhost/api/admin/crm/schede/${id}/bambini/${bambinoId}/collegamento`, { method: 'DELETE' }),
    params(id, bambinoId),
  )
const elenco = (query = '') => GET(new NextRequest(`http://localhost/api/admin/crm/domande${query}`))

beforeEach(() => {
  h.ruolo = 'segreteria'
  h.attive = [SEDE_A]
  h.db = dbBase()
  h.scritture = []
  h.errori = {}
  h.letture = []
  h.catene = []
})

// ─────────────────────────────────────────────────────────────────────────────

describe('PUT …/collegamento', () => {
  it('docente → 403, niente scritto', async () => {
    h.ruolo = 'educator'
    const res = await put(S1, B1, { domandaId: D1, figlio: 0 })
    expect(res.status).toBe(403)
    expect(h.scritture).toHaveLength(0)
  })

  it('il coordinatore non è fra i ruoli del CRM → 403', async () => {
    h.ruolo = 'coordinator'
    expect((await put(S1, B1, { domandaId: D1, figlio: 0 })).status).toBe(403)
  })

  it('collega: 200, il bambino risulta iscritto a mano con la domanda e il figlio scelti, e l’avviso si spegne', async () => {
    const res = await put(S1, B1, { domandaId: D1, figlio: 1 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const bambino = (h.db.crm_bambini as Riga[]).find((b) => b.id === B1)
    expect(bambino).toMatchObject({ esito: 'iscritto', esito_origine: 'manuale', esito_da: 'u-1', domanda_id: D1, domanda_figlio: 1 })
    expect((h.db.crm_schede as Riga[]).find((s) => s.id === S1)!.domanda_da_associare).toBeNull()
    expect((h.db.crm_eventi as Riga[]).map((e) => e.tipo)).toEqual(['domanda_collegata_mano'])
  })

  it('PUT collegamento con una domanda di un’altra sede → 403 SEDE_NON_ACCESSIBILE, niente scritto', async () => {
    const res = await put(S1, B1, { domandaId: D_ALTRA_SEDE, figlio: 0 })
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.scritture).toHaveLength(0)
    expect((h.db.crm_bambini as Riga[]).find((b) => b.id === B1)!.domanda_id).toBeNull()
  })

  it('una scheda di un’altra sede → 403 (il gate di sede della scheda), niente scritto', async () => {
    const res = await put(S_ALTRA, B_ALTRA, { domandaId: D1, figlio: 0 })
    expect(res.status).toBe(403)
    expect(h.scritture).toHaveLength(0)
  })

  // Il test sopra usa una domanda della sede A: il 403 potrebbe venire anche dal controllo della domanda.
  // Qui scheda, bambino e domanda sono TUTTI dell'altra sede, così a fermarsi può essere solo il gate della
  // scheda, e prima di leggere il bambino o la domanda.
  it('scheda, bambino e domanda tutti di un’altra sede → 403 dal gate della scheda, senza leggere bambino né domanda', async () => {
    const res = await put(S_ALTRA, B_ALTRA, { domandaId: D_ALTRA_SEDE, figlio: 0 })
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.scritture).toHaveLength(0)
    const tabelle = h.catene.map((c) => c.tabella)
    expect(tabelle).toContain('crm_schede')
    expect(tabelle).not.toContain('crm_bambini')
    expect(tabelle).not.toContain('enrollment_submissions')
  })

  it('una scheda che non esiste → 404 SCHEDA_NON_TROVATA', async () => {
    const res = await put(NON_ESISTE, B1, { domandaId: D1, figlio: 0 })
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('SCHEDA_NON_TROVATA')
  })

  it('un bambino che non è di quella scheda → 404', async () => {
    const res = await put(S1, B_ALTRA, { domandaId: D1, figlio: 0 })
    expect(res.status).toBe(404)
    expect(h.scritture).toHaveLength(0)
  })

  it('una domanda che non esiste → 404 DOMANDA_NON_APRIBILE', async () => {
    const res = await put(S1, B1, { domandaId: NON_ESISTE, figlio: 0 })
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('DOMANDA_NON_APRIBILE')
  })

  it('un figlio che nella domanda non c’è → 400', async () => {
    expect((await put(S1, B1, { domandaId: D1, figlio: 5 })).status).toBe(400)
  })

  it('corpo non valido (uuid sbagliato, figlio negativo o frazionario, campi mancanti) → 400', async () => {
    for (const corpo of [
      { domandaId: 'non-un-uuid', figlio: 0 },
      { domandaId: D1, figlio: -1 },
      { domandaId: D1, figlio: 0.5 },
      { domandaId: D1 },
      { figlio: 0 },
      {},
    ]) {
      expect((await put(S1, B1, corpo)).status, JSON.stringify(corpo)).toBe(400)
    }
    expect(h.scritture).toHaveLength(0)
  })

  it('id nel percorso che non sono uuid → 400', async () => {
    expect((await put('non-un-uuid', B1, { domandaId: D1, figlio: 0 })).status).toBe(400)
    expect((await put(S1, 'non-un-uuid', { domandaId: D1, figlio: 0 })).status).toBe(400)
  })

  it('un bambino già collegato → 409 STATO_NON_AMMESSO', async () => {
    ;(h.db.crm_bambini as Riga[])[0].domanda_id = D2
    const res = await put(S1, B1, { domandaId: D1, figlio: 0 })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('STATO_NON_AMMESSO')
  })

  it('lo stesso figlio della stessa domanda già preso da un altro bambino → 409 GIA_COLLEGATO (la UNIQUE del database)', async () => {
    // Il finto non emula la UNIQUE: la fa "scattare" iniettando l'errore che Postgres darebbe (23505).
    h.errori = { 'crm_bambini:update': { code: '23505', message: 'duplicate key value violates unique constraint' } }
    const res = await put(S1, B1, { domandaId: D1, figlio: 0 })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('GIA_COLLEGATO')
    expect((h.db.crm_bambini as Riga[]).find((b) => b.id === B1)!.domanda_id).toBeNull()
  })

  it('tabelle crm_* assenti → 503 CRM_NON_INSTALLATO', async () => {
    h.errori = { crm_schede: { code: 'PGRST205' } }
    const res = await put(S1, B1, { domandaId: D1, figlio: 0 })
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
  })

  it('senza nessuna sede attiva → 403', async () => {
    h.attive = []
    expect((await put(S1, B1, { domandaId: D1, figlio: 0 })).status).toBe(403)
  })
})

describe('DELETE …/collegamento', () => {
  function collegato() {
    const b = (h.db.crm_bambini as Riga[]).find((x) => x.id === B1)!
    Object.assign(b, {
      esito: 'iscritto',
      esito_origine: 'automatico',
      domanda_id: D1,
      domanda_figlio: 0,
      domanda_collegata_il: '2026-10-21T10:00:00.000Z',
      da_verificare: true,
      nota_collegamento: 'domanda_respinta',
    })
    return b
  }

  it('docente → 403', async () => {
    h.ruolo = 'educator'
    expect((await del(S1, B1)).status).toBe(403)
  })

  it('DELETE collegamento → evento collegamento_tolto, esito invariato', async () => {
    const b = collegato()
    const res = await del(S1, B1)
    expect(res.status).toBe(200)
    expect(b).toMatchObject({
      esito: 'iscritto',
      esito_origine: 'automatico',
      domanda_id: null,
      domanda_figlio: null,
      domanda_collegata_il: null,
      da_verificare: false,
      nota_collegamento: null,
    })
    expect((h.db.crm_eventi as Riga[])).toEqual([
      expect.objectContaining({ scheda_id: S1, scuola_id: SEDE_A, tipo: 'collegamento_tolto', autore: 'u-1', autore_via: 'segreteria' }),
    ])
    // L'avviso che riguardava QUELLA domanda si spegne.
    expect((h.db.crm_schede as Riga[]).find((s) => s.id === S1)!.domanda_da_associare).toBeNull()
  })

  it('un bambino senza collegamento → 409 STATO_NON_AMMESSO', async () => {
    const res = await del(S1, B1)
    expect(res.status).toBe(409)
    expect(h.scritture).toHaveLength(0)
  })

  it('una scheda di un’altra sede → 403, niente scritto', async () => {
    const res = await del(S_ALTRA, B_ALTRA)
    expect(res.status).toBe(403)
    expect(h.scritture).toHaveLength(0)
  })

  it('bambino di un’altra scheda → 404', async () => {
    collegato()
    expect((await del(S1, B_ALTRA)).status).toBe(404)
  })

  it('id non uuid → 400', async () => {
    expect((await del('x', B1)).status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/crm/domande', () => {
  it('docente → 403', async () => {
    h.ruolo = 'educator'
    expect((await elenco(`?scuolaId=${SEDE_A}`)).status).toBe(403)
  })

  it('senza scuolaId → 400: la sede si dichiara, non si indovina', async () => {
    expect((await elenco()).status).toBe(400)
  })

  it('una sede che non è dell’utente → 403 SEDE_NON_ACCESSIBILE, e il database non è nemmeno interrogato', async () => {
    const res = await elenco(`?scuolaId=${SEDE_B}`)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.letture).toEqual([])
  })

  it('GET domande porta .in(scuola_id) nella stessa query, e non restituisce le domande di un’altra sede', async () => {
    const res = await elenco(`?scuolaId=${SEDE_A}`)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.map((r: { domandaId: string }) => r.domandaId)).not.toContain(D_ALTRA_SEDE)

    const sulleDomande = h.catene.filter((c) => c.tabella === 'enrollment_submissions')
    expect(sulleDomande.length).toBeGreaterThan(0)
    for (const c of sulleDomande) expect(c.metodi).toContainEqual(['in', ['scuola_id', [SEDE_A]]])
    for (const c of h.catene.filter((x) => x.tabella === 'crm_bambini')) {
      expect(c.metodi).toContainEqual(['in', ['scuola_id', [SEDE_A]]])
    }
  })

  it('un riga per ogni figlio di ogni domanda, dalla più recente, con il minimo per scegliere', async () => {
    const { data } = await (await elenco(`?scuolaId=${SEDE_A}`)).json()
    expect(data).toHaveLength(4)
    // D2 è più recente di D1.
    expect(data.map((r: { domandaId: string }) => r.domandaId)).toEqual([D2, D2, D1, D1])
    expect(data[0]).toEqual({
      domandaId: D2,
      figlio: 0,
      nome: 'Bimbo',
      cognome: 'Prova',
      dataNascita: '2024-03-05',
      genitore: 'Famiglia Prova',
      ricevutaIl: '2026-10-25T10:00:00.000Z',
      stato: 'approved',
      giaCollegato: false,
    })
  })

  it('niente codice fiscale, allergie, email o telefono nella risposta', async () => {
    const testo = await (await elenco(`?scuolaId=${SEDE_A}`)).text()
    for (const dato of DATI_PERSONALI_DA_NON_RESTITUIRE) expect(testo).not.toContain(dato)
  })

  it('giaCollegato: vero per il figlio già preso da un bambino della sede, falso per gli altri', async () => {
    const b = (h.db.crm_bambini as Riga[]).find((x) => x.id === B1)!
    Object.assign(b, { domanda_id: D1, domanda_figlio: 1 })
    const { data } = await (await elenco(`?scuolaId=${SEDE_A}`)).json()
    const collegati = data.filter((r: { giaCollegato: boolean }) => r.giaCollegato)
    expect(collegati).toEqual([expect.objectContaining({ domandaId: D1, figlio: 1, nome: 'Bimba' })])
  })

  it('q: filtra per nome del figlio, cognome o genitore, senza badare a maiuscole', async () => {
    const perNome = await (await elenco(`?scuolaId=${SEDE_A}&q=BIMBA`)).json()
    expect(perNome.data.map((r: { nome: string }) => r.nome)).toEqual(['Bimba', 'Bimba'])
    const perGenitore = await (await elenco(`?scuolaId=${SEDE_A}&q=famiglia`)).json()
    expect(perGenitore.data).toHaveLength(4)
    const nessuno = await (await elenco(`?scuolaId=${SEDE_A}&q=zzzz`)).json()
    expect(nessuno.data).toEqual([])
  })

  it('q non cerca dentro i campi che non si mostrano (codice fiscale)', async () => {
    const { data } = await (await elenco(`?scuolaId=${SEDE_A}&q=PRVBMB24`)).json()
    expect(data).toEqual([])
  })

  it('domandaId: solo i figli di quella domanda', async () => {
    const { data } = await (await elenco(`?scuolaId=${SEDE_A}&domandaId=${D1}`)).json()
    expect(data.map((r: { domandaId: string }) => r.domandaId)).toEqual([D1, D1])
  })

  it('domandaId di un’altra sede → elenco vuoto (mai la domanda di un’altra sede)', async () => {
    const { data } = await (await elenco(`?scuolaId=${SEDE_A}&domandaId=${D_ALTRA_SEDE}`)).json()
    expect(data).toEqual([])
  })

  it('al massimo 50 domande, le più recenti', async () => {
    h.db.enrollment_submissions = Array.from({ length: 80 }, (_, i) =>
      ripresaDomanda(`e${String(i).padStart(7, '0')}-0000-4000-8000-000000000001`, SEDE_A, {
        created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        data: { children: [{ nome: `Bimbo${i}`, cognome: 'Prova', data_nascita: '2024-01-01' }], adults: [] },
      }),
    )
    const { data } = await (await elenco(`?scuolaId=${SEDE_A}`)).json()
    expect(data).toHaveLength(50)
    expect(data[0].nome).toBe('Bimbo79')
  })

  it('un jsonb malformato non rompe l’elenco', async () => {
    ;(h.db.enrollment_submissions as Riga[]).push(ripresaDomanda('c0c0c0c0-0000-4000-8000-000000000001', SEDE_A, { data: 'rotto' }))
    expect((await elenco(`?scuolaId=${SEDE_A}`)).status).toBe(200)
  })

  it('scuolaId non uuid → 400', async () => {
    expect((await elenco('?scuolaId=boh')).status).toBe(400)
  })

  it('tabelle crm_* assenti → 503 CRM_NON_INSTALLATO (l’associazione senza CRM non ha senso)', async () => {
    h.errori = { crm_bambini: { code: 'PGRST205' } }
    const res = await elenco(`?scuolaId=${SEDE_A}`)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
  })

  it('guasto del database → 500 CRM_OPERAZIONE_NON_RIUSCITA, e il testo di Postgres non esce', async () => {
    h.errori = { enrollment_submissions: { code: 'XX000', message: 'relation "enrollment_submissions" boom' } }
    const res = await elenco(`?scuolaId=${SEDE_A}`)
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(corpo)).not.toContain('boom')
  })
})
