import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C, SEDE_E2E } from '../fixtures/sedi'
import type { RispostaStatistiche } from '@/lib/crm/statistiche'

/**
 * `GET /api/admin/crm/statistiche?scuolaId&dal&al[&confronto=1]` · le statistiche per persona della sede.
 *
 * Il gate di ruolo e `resolveScuoleAttive` sono finti; `restringiSedi` (il 403 sulla sede chiesta) e
 * `scuoleDiUtente` (le sedi dell'admin per il confronto) sono quelli VERI, e il database è il finto che
 * applica davvero i filtri: «la segreteria vede le colleghe della sua sede e nessuna di un'altra» è una
 * proprietà verificata dal filtro `.in('scuola_id', …)`, non asserita.
 */

const h = vi.hoisted(() => ({
  ruolo: 'segreteria' as string,
  attive: [] as string[],
  db: {} as Record<string, Record<string, unknown>[]>,
  opzioni: {} as OpzioniFinto,
  lette: [] as string[],
  /** i filtri `.in(colonna, valori)` che la route ha messo, tabella per tabella */
  filtriIn: [] as { tabella: string; colonna: string; valori: unknown }[],
}))

type Catena = Record<string, (...a: unknown[]) => unknown>

/**
 * Il finto filtra davvero, ma la route raggruppa anche per sede in memoria: se togliesse
 * `.in('scuola_id', …)` dalla query i numeri resterebbero giusti e leggerebbe comunque le righe di
 * tutte le sedi. Per questo si registrano i filtri `.in` messi su ogni lettura.
 */
function conSpiaDeiFiltri(client: SupabaseClient): SupabaseClient {
  const avvolgi = (catena: Catena, tabella: string): Catena =>
    new Proxy(catena, {
      get(bersaglio, nome: string) {
        const valore = bersaglio[nome]
        if (typeof valore !== 'function') return valore
        return (...argomenti: unknown[]) => {
          if (nome === 'in') h.filtriIn.push({ tabella, colonna: String(argomenti[0]), valori: argomenti[1] })
          const esito = valore.apply(bersaglio, argomenti)
          return esito && typeof esito === 'object' && typeof (esito as Catena).in === 'function'
            ? avvolgi(esito as Catena, tabella)
            : esito
        }
      },
    })
  return new Proxy(client, {
    get(bersaglio, nome: string) {
      const valore = (bersaglio as unknown as Catena)[nome]
      if (nome !== 'from') return valore
      return (tabella: string) => avvolgi((valore as (t: string) => Catena).call(bersaglio, tabella), tabella)
    },
  })
}

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, ammessi: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!ammessi.includes(h.ruolo)) return Promise.resolve({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    return Promise.resolve({ user: { id: 'u-1', role: h.ruolo, scuola_id: h.attive[0] ?? null } })
  },
}))
vi.mock('@/lib/auth/scope', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/auth/scope')>()
  return { ...vero, resolveScuoleAttive: async () => [...h.attive] }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => conSpiaDeiFiltri(creaFintoSupabase(h.db as DBFinto, h.lette, h.opzioni)),
}))

import { GET } from '@/app/api/admin/crm/statistiche/route'

const SEG_A1 = '20000000-0000-4000-8000-0000000000a1'
const SEG_A2 = '20000000-0000-4000-8000-0000000000a2'
const SEG_B1 = '20000000-0000-4000-8000-0000000000b1'
const ARCHIVIATA = '20000000-0000-4000-8000-0000000000a9'

const richiesta = (query = '') => new NextRequest(`http://localhost/api/admin/crm/statistiche${query}`)
const GENNAIO = 'dal=2026-01-01&al=2026-01-31'

type Riga = Record<string, unknown>

function app(sede: string, o: Riga): Riga {
  return {
    scuola_id: sede,
    scheda_id: 'sc-x',
    inizio: '2026-01-10T10:00:00Z',
    stato: 'svolto',
    fissato_da: null,
    fissato_via: 'segreteria',
    svolto_da: null,
    ...o,
  }
}

beforeEach(() => {
  h.ruolo = 'segreteria'
  h.attive = [SEDE_A]
  h.opzioni = {}
  h.lette = []
  h.filtriIn = []
  h.db = {
    utenti: [
      { id: SEG_A1, nome: 'Anna', cognome: 'Prova', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: SEG_A2, nome: 'Bianca', cognome: 'Esempio', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: null },
      { id: ARCHIVIATA, nome: 'Carla', cognome: 'Passata', ruolo: 'segreteria', scuola_id: SEDE_A, archiviato_il: '2026-01-05T00:00:00Z' },
      { id: SEG_B1, nome: 'Elena', cognome: 'Altrove', ruolo: 'segreteria', scuola_id: SEDE_B, archiviato_il: null },
    ],
    utenti_scuole: [],
    schools: [
      { id: SEDE_A, nome: 'Sede A' },
      { id: SEDE_B, nome: 'Sede B' },
      { id: SEDE_C, nome: 'Sede C' },
      { id: SEDE_E2E, nome: 'Sede E2E' },
    ],
    crm_schede: [
      { id: 'sc-a1', scuola_id: SEDE_A, creata_il: '2026-01-02T10:00:00Z', genitore_nome: 'Famiglia Prova', telefono1: '333 000 0001' },
      { id: 'sc-b1', scuola_id: SEDE_B, creata_il: '2026-01-02T10:00:00Z', genitore_nome: 'Famiglia Prova', telefono1: '333 000 0001' },
    ],
    crm_bambini: [
      { scuola_id: SEDE_A, scheda_id: 'sc-a1', esito: 'iscritto', esito_il: '2026-01-20T12:00:00Z', domanda_id: 'dom-1', da_verificare: false, nome: 'Bambino Prova' },
      { scuola_id: SEDE_B, scheda_id: 'sc-b1', esito: 'iscritto', esito_il: '2026-01-20T12:00:00Z', domanda_id: 'dom-2', da_verificare: false, nome: 'Bambino Prova' },
    ],
    crm_appuntamenti: [
      // Sede A: la 1 fissa e la 2 svolge → presentazione alla 1, iscritto alla 2
      app(SEDE_A, { scheda_id: 'sc-a1', fissato_da: SEG_A1, svolto_da: SEG_A2 }),
      // Sede B: stessa storia con una collega di B
      app(SEDE_B, { scheda_id: 'sc-b1', fissato_da: SEG_B1, svolto_da: SEG_B1 }),
    ],
    crm_azioni: [],
  }
})

async function leggi(query: string): Promise<{ stato: number; corpo: { data?: RispostaStatistiche; codice?: string } }> {
  const res = await GET(richiesta(query))
  return { stato: res.status, corpo: await res.json() }
}

describe('GET /api/admin/crm/statistiche · gate e sede', () => {
  it('docente → 403', async () => {
    h.ruolo = 'educator'
    expect((await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)).stato).toBe(403)
  })

  it('il coordinatore non è fra i ruoli del CRM → 403', async () => {
    h.ruolo = 'coordinator'
    expect((await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)).stato).toBe(403)
  })

  it('segreteria su un’altra sede → 403 SEDE_NON_ACCESSIBILE, senza un solo numero dell’altra', async () => {
    const { stato, corpo } = await leggi(`?scuolaId=${SEDE_B}&${GENNAIO}`)
    expect(stato).toBe(403)
    expect(corpo.codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(corpo.data).toBeUndefined()
    // il diniego arriva PRIMA di ogni lettura: nessuna tabella del CRM è stata aperta
    expect(h.lette.filter((t) => t.startsWith('crm_'))).toEqual([])
  })

  it('senza scuolaId → 400: la sede si dichiara, non si indovina', async () => {
    expect((await leggi(`?${GENNAIO}`)).stato).toBe(400)
  })

  it('scuolaId che non è un uuid → 400', async () => {
    expect((await leggi(`?scuolaId=non-un-uuid&${GENNAIO}`)).stato).toBe(400)
  })

  it('la propria sede in maiuscolo non è un diniego', async () => {
    expect((await leggi(`?scuolaId=${SEDE_A.toUpperCase()}&${GENNAIO}`)).stato).toBe(200)
  })
})

describe('GET /api/admin/crm/statistiche · il periodo', () => {
  it('dal dopo al → 400', async () => {
    expect((await leggi(`?scuolaId=${SEDE_A}&dal=2026-02-01&al=2026-01-01`)).stato).toBe(400)
  })

  it('una data inesistente → 400', async () => {
    expect((await leggi(`?scuolaId=${SEDE_A}&dal=2026-02-30&al=2026-03-01`)).stato).toBe(400)
  })

  it('un estremo solo → 400: il periodo è una coppia', async () => {
    expect((await leggi(`?scuolaId=${SEDE_A}&dal=2026-01-01`)).stato).toBe(400)
    expect((await leggi(`?scuolaId=${SEDE_A}&al=2026-01-31`)).stato).toBe(400)
  })

  it('senza periodo è il mese in corso di Roma, dal primo all’ultimo giorno', async () => {
    const { stato, corpo } = await leggi(`?scuolaId=${SEDE_A}`)
    expect(stato).toBe(200)
    const { dal, al } = corpo.data!
    expect(dal).toMatch(/^\d{4}-\d{2}-01$/)
    expect(al.slice(0, 7)).toBe(dal.slice(0, 7))
    // l'ultimo giorno del mese: il giorno dopo è il primo del mese successivo
    const domani = new Date(Date.parse(`${al}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    expect(domani.endsWith('-01')).toBe(true)
  })

  it('il periodo si legge in giorni di Roma: la visita delle 00:30 del 1° febbraio non è di gennaio', async () => {
    h.db.crm_appuntamenti.push(
      app(SEDE_A, { scheda_id: 'sc-a1', inizio: '2026-01-31T23:30:00Z', fissato_da: SEG_A1, svolto_da: SEG_A2 }),
    )
    const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    expect(corpo.data!.totale.svolti).toBe(1)
    const feb = await leggi(`?scuolaId=${SEDE_A}&dal=2026-02-01&al=2026-02-28`)
    expect(feb.corpo.data!.totale.svolti).toBe(1)
  })

  it('l’esito riporta il periodo e la sede letti', async () => {
    const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    expect(corpo.data).toMatchObject({ scuolaId: SEDE_A, dal: '2026-01-01', al: '2026-01-31' })
  })
})

describe('GET /api/admin/crm/statistiche · le persone della sede', () => {
  it('segreteria: vede le colleghe della sua sede, non quelle di un’altra', async () => {
    const { stato, corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    expect(stato).toBe(200)
    const righe = corpo.data!.righe
    const id = (r: (typeof righe)[number]) => (r.persona === 'ai' ? 'ai' : r.persona.id)

    // La 1 (che ha fissato) e la 2 (che ha svolto) compaiono, con nome e cognome…
    expect(righe.map(id).sort()).toEqual([SEG_A1, SEG_A2].sort())
    const uno = righe.find((r) => id(r) === SEG_A1)!
    const due = righe.find((r) => id(r) === SEG_A2)!
    expect(uno.persona).toEqual({ id: SEG_A1, nome: 'Anna', cognome: 'Prova' })
    expect(due.persona).toEqual({ id: SEG_A2, nome: 'Bianca', cognome: 'Esempio' })
    // …con la presentazione alla 1 e l'iscritto alla 2 (caso 1 del §10)
    expect([uno.fissati, uno.svolti, uno.tassoPresentazione]).toEqual([1, 1, 1])
    expect([due.bambiniVisitati, due.iscrittiVerificati, due.closeRate]).toEqual([1, 1, 1])

    // …e di B non c'è NIENTE: né la collega, né la visita, né il bambino.
    expect(JSON.stringify(corpo)).not.toContain(SEG_B1)
    expect(JSON.stringify(corpo)).not.toContain('Altrove')
    expect(corpo.data!.totale.fissati).toBe(1)
    expect(corpo.data!.totale.bambiniVisitati).toBe(1)
  })

  it('ogni lettura del CRM porta la sede nella stessa query: .in(\'scuola_id\', [la sede chiesta])', async () => {
    await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    for (const tabella of ['crm_schede', 'crm_bambini', 'crm_appuntamenti', 'crm_azioni']) {
      const filtri = h.filtriIn.filter((f) => f.tabella === tabella && f.colonna === 'scuola_id')
      // una query per pagina letta: almeno una, e TUTTE con la sola sede chiesta
      expect(filtri.length, tabella).toBeGreaterThan(0)
      for (const f of filtri) expect(f.valori, tabella).toEqual([SEDE_A])
      // e nessuna lettura della tabella è partita senza quel filtro
      expect(h.lette.filter((t) => t === tabella).length, tabella).toBe(filtri.length)
    }
  })

  it('una collega archiviata che ha lavorato nel periodo resta con il suo nome', async () => {
    h.db.crm_appuntamenti.push(
      app(SEDE_A, { scheda_id: 'sc-a1', inizio: '2026-01-12T10:00:00Z', fissato_da: ARCHIVIATA, svolto_da: ARCHIVIATA }),
    )
    const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    const nomi = corpo.data!.righe.map((r) => (r.persona === 'ai' ? 'ai' : r.persona.cognome))
    expect(nomi).toContain('Passata')
  })

  it('una persona che non si trova più compare con il solo id, mai con il nome di qualcun altro', async () => {
    const SPARITA = '20000000-0000-4000-8000-0000000000ff'
    h.db.crm_appuntamenti.push(app(SEDE_A, { scheda_id: 'sc-a1', fissato_da: SPARITA }))
    const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    const sparita = corpo.data!.righe.find((r) => r.persona !== 'ai' && r.persona.id === SPARITA)!
    expect(sparita.persona).toEqual({ id: SPARITA, nome: '', cognome: '' })
  })

  it('le righe sono per cognome e nome, l’assistente AI in fondo, e compare solo se ha numeri', async () => {
    let { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    expect(corpo.data!.righe.some((r) => r.persona === 'ai')).toBe(false)

    h.db.crm_appuntamenti.push(app(SEDE_A, { scheda_id: 'sc-ai', fissato_da: null, fissato_via: 'ai', svolto_da: SEG_A2, inizio: '2026-01-11T10:00:00Z' }))
    ;({ corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`))
    const righe = corpo.data!.righe
    expect(righe[righe.length - 1].persona).toBe('ai')
    // «Esempio» (la 2) viene prima di «Prova» (la 1)
    const cognomi = righe.filter((r) => r.persona !== 'ai').map((r) => (r.persona as { cognome: string }).cognome)
    expect(cognomi).toEqual(['Esempio', 'Prova'])
    expect(righe.find((r) => r.persona === 'ai')!.fissati).toBe(1)
  })

  it('nessun dato di una famiglia esce dalla route: solo i numeri e i nomi di chi lavora', async () => {
    const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    const testo = JSON.stringify(corpo)
    for (const vietato of ['Famiglia Prova', '333 000 0001', 'Bambino Prova']) expect(testo).not.toContain(vietato)
  })

  it('con più di una pagina di righe le legge tutte (il server può tagliare ogni pagina)', async () => {
    for (let k = 0; k < 6; k++) {
      h.db.crm_appuntamenti.push(app(SEDE_A, { scheda_id: 'sc-a1', inizio: `2026-01-${String(11 + k).padStart(2, '0')}T10:00:00Z`, fissato_da: SEG_A1 }))
    }
    // il server taglia ogni risposta a 2 righe: 8 visite in tutto, 4 pagine
    h.opzioni = { maxRighe: 2 }
    const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    expect(corpo.data!.totale.fissati).toBe(7) // 1 della sede A + 6 aggiunte; quella di B no
  })

  it('azioni: il follow-up in tempo va al responsabile, nel periodo', async () => {
    h.db.crm_azioni = [
      { scuola_id: SEDE_A, responsabile: SEG_A1, scadenza: '2026-01-12T09:30:00Z', fatta_il: '2026-01-12T15:00:00Z', cancellata_il: null },
      { scuola_id: SEDE_A, responsabile: SEG_A1, scadenza: '2026-01-13T09:30:00Z', fatta_il: null, cancellata_il: null },
      // fuori periodo, e di un'altra sede
      { scuola_id: SEDE_A, responsabile: SEG_A1, scadenza: '2025-12-12T09:30:00Z', fatta_il: null, cancellata_il: null },
      { scuola_id: SEDE_B, responsabile: SEG_B1, scadenza: '2026-01-12T09:30:00Z', fatta_il: null, cancellata_il: null },
    ]
    const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
    const uno = corpo.data!.righe.find((r) => r.persona !== 'ai' && r.persona.id === SEG_A1)!
    expect([uno.azioniDovute, uno.azioniInTempo, uno.followUpInTempo]).toEqual([2, 1, 0.5])
    expect(corpo.data!.totale.azioniDovute).toBe(2)
  })

  it('senza dati nel periodo → righe vuote e tassi null (mai NaN), 200', async () => {
    const { stato, corpo } = await leggi(`?scuolaId=${SEDE_A}&dal=2030-01-01&al=2030-01-31`)
    expect(stato).toBe(200)
    expect(corpo.data!.righe).toEqual([])
    expect(corpo.data!.totale.tassoPresentazione).toBeNull()
    expect(corpo.data!.totale.closeRate).toBeNull()
    expect(corpo.data!.ritardoMedianoGiorni).toBeNull()
  })
})

describe('GET /api/admin/crm/statistiche · il confronto fra sedi', () => {
  it('segreteria con confronto=1 → 403 SOLO_ADMIN', async () => {
    const { stato, corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}&confronto=1`)
    expect(stato).toBe(403)
    expect(corpo.codice).toBe('SOLO_ADMIN')
    expect(corpo.data).toBeUndefined()
    expect(h.lette).toEqual([])
  })

  it('segreteria con confronto=0 è una richiesta normale', async () => {
    expect((await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}&confronto=0`)).stato).toBe(200)
  })

  it('confronto con un valore qualunque → 400', async () => {
    h.ruolo = 'admin'
    expect((await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}&confronto=forse`)).stato).toBe(400)
  })

  describe('admin con tre sedi', () => {
    beforeEach(() => {
      h.ruolo = 'admin'
      h.attive = [SEDE_A, SEDE_B, SEDE_C]
      h.db.utenti_scuole = [
        { utente_id: 'u-1', scuola_id: SEDE_A },
        { utente_id: 'u-1', scuola_id: SEDE_B },
        { utente_id: 'u-1', scuola_id: SEDE_C },
        { utente_id: 'u-1', scuola_id: SEDE_E2E },
      ]
    })

    it('admin con confronto=1 → un totale per sede', async () => {
      const { stato, corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}&confronto=1`)
      expect(stato).toBe(200)
      const confronto = corpo.data!.confronto!
      expect(confronto.map((c) => c.scuolaId).sort()).toEqual([SEDE_A, SEDE_B, SEDE_C].sort())
      const perSede = new Map(confronto.map((c) => [c.scuolaId, c]))
      expect(perSede.get(SEDE_A)!.nome).toBe('Sede A')
      // A e B hanno una visita svolta e un iscritto verificato ciascuna; C non ha niente ma c'è
      expect([perSede.get(SEDE_A)!.totale.svolti, perSede.get(SEDE_A)!.totale.iscrittiVerificati]).toEqual([1, 1])
      expect([perSede.get(SEDE_B)!.totale.svolti, perSede.get(SEDE_B)!.totale.iscrittiVerificati]).toEqual([1, 1])
      expect(perSede.get(SEDE_C)!.totale.fissati).toBe(0)
      expect(perSede.get(SEDE_C)!.totale.tassoPresentazione).toBeNull()
    })

    it('il confronto non mescola le sedi: ogni totale è della sua', async () => {
      h.db.crm_appuntamenti.push(
        app(SEDE_B, { scheda_id: 'sc-b1', inizio: '2026-01-12T10:00:00Z', fissato_da: SEG_B1, stato: 'non_presentato' }),
      )
      const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}&confronto=1`)
      const perSede = new Map(corpo.data!.confronto!.map((c) => [c.scuolaId, c.totale]))
      expect(perSede.get(SEDE_A)!.nonPresentati).toBe(0)
      expect(perSede.get(SEDE_B)!.nonPresentati).toBe(1)
      // …e le righe per persona restano quelle della sola sede chiesta
      expect(JSON.stringify(corpo.data!.righe)).not.toContain(SEG_B1)
      expect(corpo.data!.totale.nonPresentati).toBe(0)
    })

    it('la sede finta della CI non entra mai nel confronto', async () => {
      const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}&confronto=1`)
      expect(corpo.data!.confronto!.map((c) => c.scuolaId)).not.toContain(SEDE_E2E)
    })

    it('col confronto si leggono le sole sedi dell’admin, mai la finta della CI', async () => {
      await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}&confronto=1`)
      const lette = h.filtriIn.filter((f) => f.tabella === 'crm_appuntamenti' && f.colonna === 'scuola_id')
      expect(lette.length).toBeGreaterThan(0)
      for (const f of lette) expect((f.valori as string[]).slice().sort()).toEqual([SEDE_A, SEDE_B, SEDE_C].sort())
    })

    it('senza confronto=1 la risposta non porta nessun confronto', async () => {
      const { corpo } = await leggi(`?scuolaId=${SEDE_A}&${GENNAIO}`)
      expect(corpo.data!.confronto).toBeUndefined()
    })

    it('l’admin vede le persone della sede che sceglie, e solo di quella', async () => {
      const { corpo } = await leggi(`?scuolaId=${SEDE_B}&${GENNAIO}`)
      expect(corpo.data!.righe.map((r) => (r.persona === 'ai' ? 'ai' : r.persona.id))).toEqual([SEG_B1])
    })

    it('una sede che non è fra le sue → 403, anche con il confronto', async () => {
      h.attive = [SEDE_A]
      const { stato, corpo } = await leggi(`?scuolaId=${SEDE_B}&${GENNAIO}&confronto=1`)
      expect(stato).toBe(403)
      expect(corpo.codice).toBe('SEDE_NON_ACCESSIBILE')
    })
  })
})

describe('GET /api/admin/crm/statistiche · guasti', () => {
  it('guasto del database → 500 CRM_OPERAZIONE_NON_RIUSCITA, senza il testo del database', async () => {
    h.opzioni = { errori: { crm_appuntamenti: { code: '08006', message: 'segreto di tabella' } } }
    const res = await GET(richiesta(`?scuolaId=${SEDE_A}&${GENNAIO}`))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('CRM_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(corpo)).not.toContain('segreto di tabella')
  })

  it('le tabelle assenti → 503 CRM_NON_INSTALLATO', async () => {
    h.opzioni = { errori: { crm_schede: { code: 'PGRST205' } } }
    const res = await GET(richiesta(`?scuolaId=${SEDE_A}&${GENNAIO}`))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CRM_NON_INSTALLATO')
  })

  it('il guasto nella lettura dei nomi non regala numeri senza nome: 500', async () => {
    h.opzioni = { errori: { utenti: { code: '08006' } } }
    const res = await GET(richiesta(`?scuolaId=${SEDE_A}&${GENNAIO}`))
    expect(res.status).toBe(500)
  })
})
